import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  ChangedFileRecord,
  ChatEvent,
  CliHealth,
  MessageRecord,
  ModelDiscoveryResult,
  PermissionRequestRecord,
  ProjectRecord,
  SettingsRecord,
  ThreadRecord,
  ToolCallRecord,
  PlanEntryRecord,
  GitStatus
} from "../../shared/contracts";

type ProjectThreadGroup = {
  project: ProjectRecord;
  threads: ThreadRecord[];
};

type DraftAssistantMessage = {
  id: string;
  threadId: string;
  role: "assistant";
  kind: MessageRecord["kind"];
  content: string;
  createdAt: string;
};

type ToolCallTimelineRecord = ToolCallRecord & {
  firstSeenAt: string;
  lastUpdatedAt: string;
};

type TranscriptTimelineItem =
  | (MessageRecord & { itemType: "message"; sortAt: string })
  | {
      itemType: "tool-call";
      id: string;
      threadId: string;
      title: string;
      kind: string | null;
      status: string | null;
      content: string;
      locations: string[];
      createdAt: string;
      updatedAt: string;
      sortAt: string;
    };

type RankedTranscriptTimelineItem = TranscriptTimelineItem & {
  phaseRank: number;
  turnRank: number;
  turnStartedAt: string;
};

function transcriptPhaseRank(item: TranscriptTimelineItem): number {
  if (item.itemType === "tool-call") {
    return 2;
  }

  if (item.role === "user") {
    return 0;
  }

  if (item.kind === "thought") {
    return 1;
  }

  if (item.role === "assistant") {
    return 3;
  }

  return 4;
}

function sortTranscriptTimeline(items: TranscriptTimelineItem[]): TranscriptTimelineItem[] {
  const chronological = [...items].sort((a, b) => {
    const sortComparison = a.sortAt.localeCompare(b.sortAt);
    if (sortComparison !== 0) {
      return sortComparison;
    }

    if (a.itemType === b.itemType) {
      return a.id.localeCompare(b.id);
    }

    return a.itemType === "message" ? -1 : 1;
  });

  let currentTurnRank = -1;
  let currentTurnStartedAt = "";

  const rankedItems: RankedTranscriptTimelineItem[] = chronological.map((item) => {
    if (item.itemType === "message" && item.role === "user") {
      currentTurnRank += 1;
      currentTurnStartedAt = item.createdAt;
    }

    return {
      ...item,
      phaseRank: transcriptPhaseRank(item),
      turnRank: currentTurnRank,
      turnStartedAt: currentTurnRank >= 0 ? currentTurnStartedAt : item.sortAt
    };
  });

  return rankedItems.sort((a, b) => {
    const turnComparison = a.turnStartedAt.localeCompare(b.turnStartedAt);
    if (turnComparison !== 0) {
      return turnComparison;
    }

    const phaseComparison = a.phaseRank - b.phaseRank;
    if (phaseComparison !== 0) {
      return phaseComparison;
    }

    const sortComparison = a.sortAt.localeCompare(b.sortAt);
    if (sortComparison !== 0) {
      return sortComparison;
    }

    if (a.itemType === b.itemType) {
      return a.id.localeCompare(b.id);
    }

    return a.itemType === "message" ? -1 : 1;
  });
}

function emptyGitStatus(): GitStatus {
  return {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changedCount: 0,
    untrackedCount: 0,
    isClean: true
  };
}

function cockpitApi() {
  if (!window.cockpit) {
    throw new Error("Cockpit preload API is unavailable. Restart the app so the Electron preload script can load.");
  }

  return window.cockpit;
}

function clearLegacyHiddenProjectsStorage(): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.removeItem("cockpit.hiddenProjectIds");
  } catch {
    // Ignore storage failures during legacy cleanup.
  }
}

export const useCockpitStore = defineStore("cockpit", () => {
  const projects = ref<ProjectRecord[]>([]);
  const threads = ref<ThreadRecord[]>([]);
  const selectedProjectId = ref<string | null>(null);
  const activeThreadId = ref<string | null>(null);
  const messagesByThread = ref<Record<string, MessageRecord[]>>({});
  const draftsByThread = ref<Record<string, Record<string, DraftAssistantMessage>>>({});
  const permissionsByThread = ref<Record<string, PermissionRequestRecord[]>>({});
  const toolCallsByThread = ref<Record<string, ToolCallTimelineRecord[]>>({});
  const plansByThread = ref<Record<string, PlanEntryRecord[]>>({});
  const cliHealth = ref<CliHealth | null>(null);
  const settings = ref<SettingsRecord>({
    cliExecutablePath: null,
    selectedProjectId: null,
    defaultModelId: null,
    hiddenProjectIds: []
  });
  const gitStatus = ref<GitStatus>(emptyGitStatus());
  const changedFiles = ref<ChangedFileRecord[]>([]);
  const models = ref<ModelDiscoveryResult | null>(null);
  const booting = ref(true);
  const busy = ref(false);
  const settingsOpen = ref(false);
  const commitDialogOpen = ref(false);
  const errorMessage = ref<string | null>(null);
  const commitOutput = ref<string | null>(null);

  let unsubscribe: (() => void) | null = null;

  const selectedProject = computed(() => {
    return projects.value.find((project) => project.id === selectedProjectId.value) ?? null;
  });

  const projectThreadGroups = computed<ProjectThreadGroup[]>(() => {
    return projects.value.map((project) => ({
      project,
      threads: projectThreads(project.id)
    }));
  });

  const activeThread = computed(() => {
    return threads.value.find((thread) => thread.id === activeThreadId.value) ?? null;
  });

  const transcriptMessages = computed(() => {
    if (!activeThreadId.value) {
      return [];
    }

    const stored = messagesByThread.value[activeThreadId.value] ?? [];
    const drafts = Object.values(draftsByThread.value[activeThreadId.value] ?? {}).map((draft) => ({
      id: draft.id,
      threadId: draft.threadId,
      role: draft.role,
      kind: draft.kind,
      content: draft.content,
      createdAt: draft.createdAt
    }));

    return [...stored, ...drafts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });

  const transcriptTimeline = computed<TranscriptTimelineItem[]>(() => {
    if (!activeThreadId.value) {
      return [];
    }

    const messages = transcriptMessages.value.map((message) => ({
      ...message,
      itemType: "message" as const,
      sortAt: message.createdAt
    }));
    const toolCalls = (toolCallsByThread.value[activeThreadId.value] ?? []).map((toolCall) => ({
      itemType: "tool-call" as const,
      id: toolCall.toolCallId,
      threadId: activeThreadId.value as string,
      title: toolCall.title,
      kind: toolCall.kind,
      status: toolCall.status,
      content: toolCall.content,
      locations: toolCall.locations,
      createdAt: toolCall.firstSeenAt,
      updatedAt: toolCall.lastUpdatedAt,
      sortAt: toolCall.firstSeenAt
    }));

    return sortTranscriptTimeline([...messages, ...toolCalls]);
  });

  const pendingPermissions = computed(() => {
    if (!activeThreadId.value) {
      return [];
    }

    return (permissionsByThread.value[activeThreadId.value] ?? []).filter(
      (permission) => permission.status === "pending"
    );
  });

  const activeToolCalls = computed(() => {
    if (!activeThreadId.value) {
      return [];
    }

    return (toolCallsByThread.value[activeThreadId.value] ?? []).map(
      ({ firstSeenAt: _firstSeenAt, lastUpdatedAt: _lastUpdatedAt, ...toolCall }) => toolCall
    );
  });

  const activePlan = computed(() => {
    if (!activeThreadId.value) {
      return [];
    }

    return plansByThread.value[activeThreadId.value] ?? [];
  });

  function sortedThreads(list: ThreadRecord[]): ThreadRecord[] {
    return [...list].sort((a, b) => {
      const left = a.lastMessageAt ?? a.createdAt;
      const right = b.lastMessageAt ?? b.createdAt;
      return right.localeCompare(left);
    });
  }

  function projectThreads(projectId: string): ThreadRecord[] {
    return sortedThreads(threads.value.filter((thread) => thread.projectId === projectId));
  }

  async function clearActiveThreadContext(): Promise<void> {
    activeThreadId.value = null;
    models.value = await cockpitApi().chat.getModels(null);
  }

  async function selectProjectContext(projectId: string): Promise<void> {
    await cockpitApi().projects.select(projectId);
    selectedProjectId.value = projectId;
    settings.value = {
      ...settings.value,
      selectedProjectId: projectId
    };
    await refreshProjects();
    await refreshGit();
  }

  function upsertThread(thread: ThreadRecord): void {
    const index = threads.value.findIndex((entry) => entry.id === thread.id);
    if (index >= 0) {
      threads.value[index] = thread;
    } else {
      threads.value.unshift(thread);
    }

    threads.value = sortedThreads(threads.value);
  }

  function handleChatEvent(event: ChatEvent): void {
    switch (event.type) {
      case "message-created": {
        const list = messagesByThread.value[event.threadId] ?? [];
        messagesByThread.value[event.threadId] = [...list, event.message].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt)
        );

        if (draftsByThread.value[event.threadId]?.[event.message.id]) {
          delete draftsByThread.value[event.threadId][event.message.id];
        }

        const thread = threads.value.find((entry) => entry.id === event.threadId);
        if (thread) {
          upsertThread({
            ...thread,
            lastMessageAt: event.message.createdAt
          });
        }
        break;
      }
      case "assistant-delta": {
        const threadDrafts = draftsByThread.value[event.threadId] ?? {};
        threadDrafts[event.messageId] = {
          id: event.messageId,
          threadId: event.threadId,
          role: "assistant",
          kind: event.kind,
          content: event.content,
          createdAt: threadDrafts[event.messageId]?.createdAt ?? new Date().toISOString()
        };
        draftsByThread.value[event.threadId] = { ...threadDrafts };
        break;
      }
      case "status-changed": {
        const thread = threads.value.find((entry) => entry.id === event.threadId);
        if (thread) {
          upsertThread({
            ...thread,
            status: event.status
          });
        }
        if (event.error) {
          errorMessage.value = event.error;
        }
        break;
      }
      case "permission-requested": {
        const list = permissionsByThread.value[event.threadId] ?? [];
        permissionsByThread.value[event.threadId] = [event.permission, ...list.filter((item) => item.id !== event.permission.id)];
        break;
      }
      case "permission-resolved": {
        const list = permissionsByThread.value[event.threadId] ?? [];
        permissionsByThread.value[event.threadId] = [event.permission, ...list.filter((item) => item.id !== event.permission.id)];
        break;
      }
      case "tool-updated": {
        const list = toolCallsByThread.value[event.threadId] ?? [];
        const index = list.findIndex((item) => item.toolCallId === event.toolCall.toolCallId);
        const now = new Date().toISOString();
        if (index >= 0) {
          const existing = list[index];
          list[index] = {
            ...event.toolCall,
            firstSeenAt: existing.firstSeenAt,
            lastUpdatedAt: now
          };
          toolCallsByThread.value[event.threadId] = [...list].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
        } else {
          toolCallsByThread.value[event.threadId] = [
            ...list,
            {
              ...event.toolCall,
              firstSeenAt: now,
              lastUpdatedAt: now
            }
          ].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
        }
        break;
      }
      case "plan-updated": {
        plansByThread.value[event.threadId] = event.plan;
        break;
      }
      case "models-updated": {
        models.value = event.discovery;
        break;
      }
    }
  }

  function toErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }

  async function refreshCliHealth(): Promise<void> {
    cliHealth.value = await cockpitApi().system.getCliHealth();
  }

  async function refreshProjects(): Promise<void> {
    projects.value = await cockpitApi().projects.list();
  }

  async function refreshThreads(projectId?: string): Promise<void> {
    threads.value = await cockpitApi().threads.list(projectId);
  }

  async function refreshGit(): Promise<void> {
    if (!selectedProject.value) {
      gitStatus.value = emptyGitStatus();
      changedFiles.value = [];
      return;
    }

    gitStatus.value = await cockpitApi().git.getStatus(selectedProject.value.rootPath);
    changedFiles.value = await cockpitApi().git.listChangedFiles(selectedProject.value.rootPath);
  }

  async function bootstrap(): Promise<void> {
    if (!unsubscribe) {
      unsubscribe = cockpitApi().chat.subscribe(handleChatEvent);
    }

    booting.value = true;
    errorMessage.value = null;

    try {
      settings.value = await cockpitApi().settings.get();
      clearLegacyHiddenProjectsStorage();
      if (settings.value.hiddenProjectIds.length) {
        settings.value = await cockpitApi().settings.update({
          hiddenProjectIds: []
        });
      }
      await Promise.all([refreshCliHealth(), refreshProjects(), refreshThreads()]);
      const preferredProjectId = settings.value.selectedProjectId;
      const defaultProjectId = projects.value.some((project) => project.id === preferredProjectId)
        ? preferredProjectId
        : projects.value[0]?.id ?? null;

      selectedProjectId.value = defaultProjectId;

      if (!selectedProjectId.value) {
        await clearActiveThreadContext();
        return;
      }

      await selectProjectContext(selectedProjectId.value);
      const initialThreadId = projectThreads(selectedProjectId.value)[0]?.id ?? null;
      if (initialThreadId) {
        await openThread(initialThreadId);
      } else {
        await clearActiveThreadContext();
      }
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Failed to boot Cockpit.";
    } finally {
      booting.value = false;
    }
  }

  async function addProject(): Promise<void> {
    errorMessage.value = null;
    try {
      const rootPath = await cockpitApi().system.pickProjectDirectory();
      if (!rootPath) {
        return;
      }

      busy.value = true;
      const project = await cockpitApi().projects.create(rootPath);
      await refreshProjects();
      await refreshThreads();
      if (project) {
        selectedProjectId.value = project.id;
        settings.value = {
          ...settings.value,
          selectedProjectId: project.id
        };
        await refreshGit();
        await clearActiveThreadContext();
      }
    } catch (error) {
      errorMessage.value = toErrorMessage(error, "Failed to add project.");
    } finally {
      busy.value = false;
    }
  }

  async function selectProject(projectId: string): Promise<void> {
    errorMessage.value = null;
    busy.value = true;
    try {
      await selectProjectContext(projectId);
      const nextThreadId = projectThreads(projectId)[0]?.id ?? null;
      if (nextThreadId) {
        await openThread(nextThreadId);
      } else {
        await clearActiveThreadContext();
      }
    } catch (error) {
      errorMessage.value = toErrorMessage(error, "Failed to select project.");
    } finally {
      busy.value = false;
    }
  }

  async function removeProject(projectId: string): Promise<void> {
    errorMessage.value = null;
    busy.value = true;
    try {
      const removedThreadIds = threads.value
        .filter((thread) => thread.projectId === projectId)
        .map((thread) => thread.id);
      const removedActiveProject = selectedProjectId.value === projectId;
      const removedActiveThread = activeThreadId.value
        ? removedThreadIds.includes(activeThreadId.value)
        : false;

      await cockpitApi().projects.remove(projectId);

      for (const threadId of removedThreadIds) {
        delete messagesByThread.value[threadId];
        delete draftsByThread.value[threadId];
        delete permissionsByThread.value[threadId];
        delete toolCallsByThread.value[threadId];
        delete plansByThread.value[threadId];
      }

      await refreshProjects();
      await refreshThreads();
      settings.value = await cockpitApi().settings.get();

      const nextProjectId = projects.value.some((project) => project.id === settings.value.selectedProjectId)
        ? settings.value.selectedProjectId
        : projects.value[0]?.id ?? null;

      if (!nextProjectId) {
        selectedProjectId.value = null;
        await refreshGit();
        await clearActiveThreadContext();
        return;
      }

      if (removedActiveProject || selectedProjectId.value !== nextProjectId) {
        await selectProjectContext(nextProjectId);
      }

      if (removedActiveProject || removedActiveThread || !threads.value.some((thread) => thread.id === activeThreadId.value)) {
        const nextThreadId = projectThreads(nextProjectId)[0]?.id ?? null;
        if (nextThreadId) {
          await openThread(nextThreadId);
        } else {
          await clearActiveThreadContext();
        }
        return;
      }

      await refreshGit();
    } catch (error) {
      errorMessage.value = toErrorMessage(error, "Failed to remove project.");
    } finally {
      busy.value = false;
    }
  }

  async function createThread(projectId = selectedProjectId.value, modelId?: string): Promise<void> {
    errorMessage.value = null;
    try {
      if (!projectId) {
        await addProject();
        projectId = selectedProjectId.value;
      }

      if (!projectId) {
        errorMessage.value = "Add a project before creating a thread.";
        return;
      }

      busy.value = true;
      if (selectedProjectId.value !== projectId) {
        await selectProjectContext(projectId);
      }

      const thread = await cockpitApi().threads.create(projectId, modelId?.trim() || undefined);
      upsertThread(thread);
      await openThread(thread.id);
    } catch (error) {
      errorMessage.value = toErrorMessage(error, "Failed to create thread.");
    } finally {
      busy.value = false;
    }
  }

  async function openThread(threadId: string): Promise<void> {
    errorMessage.value = null;
    try {
      const cachedThread = threads.value.find((thread) => thread.id === threadId) ?? null;
      if (cachedThread && cachedThread.projectId !== selectedProjectId.value) {
        await selectProjectContext(cachedThread.projectId);
      }

      const payload = await cockpitApi().threads.open(threadId);
      if (payload.thread.projectId !== selectedProjectId.value) {
        await selectProjectContext(payload.thread.projectId);
      }

      activeThreadId.value = threadId;
      upsertThread(payload.thread);
      messagesByThread.value[threadId] = payload.messages;
      permissionsByThread.value[threadId] = payload.permissions;
      models.value = await cockpitApi().chat.getModels(threadId);
    } catch (error) {
      errorMessage.value = toErrorMessage(error, "Failed to open thread.");
    }
  }

  async function deleteThread(threadId: string): Promise<void> {
    errorMessage.value = null;
    busy.value = true;
    try {
      const deletedThread = threads.value.find((thread) => thread.id === threadId) ?? null;

      await cockpitApi().threads.delete(threadId);
      threads.value = threads.value.filter((thread) => thread.id !== threadId);
      delete messagesByThread.value[threadId];
      delete draftsByThread.value[threadId];
      delete permissionsByThread.value[threadId];
      delete toolCallsByThread.value[threadId];
      delete plansByThread.value[threadId];

      if (activeThreadId.value !== threadId) {
        return;
      }

      const sameProjectThreadId = deletedThread ? projectThreads(deletedThread.projectId)[0]?.id ?? null : null;
      const fallbackThreadId = sameProjectThreadId ?? threads.value[0]?.id ?? null;
      if (fallbackThreadId) {
        await openThread(fallbackThreadId);
        return;
      }

      if (deletedThread) {
        await selectProjectContext(deletedThread.projectId);
      }
      await clearActiveThreadContext();
    } catch (error) {
      errorMessage.value = toErrorMessage(error, "Failed to delete thread.");
    } finally {
      busy.value = false;
    }
  }

  async function sendPrompt(content: string): Promise<void> {
    if (!content.trim()) {
      return;
    }

    if (!activeThreadId.value) {
      if (!selectedProjectId.value) {
        return;
      }

      await createThread(selectedProjectId.value, settings.value.defaultModelId ?? undefined);
    }

    if (!activeThreadId.value) {
      return;
    }

    errorMessage.value = null;
    await cockpitApi().chat.send({
      threadId: activeThreadId.value,
      content
    });
    await refreshThreads();
    await refreshGit();
  }

  async function stopRun(): Promise<void> {
    if (!activeThreadId.value) {
      return;
    }

    await cockpitApi().chat.stop({
      threadId: activeThreadId.value
    });
  }

  async function retryRun(): Promise<void> {
    if (!activeThreadId.value) {
      return;
    }

    await cockpitApi().chat.retry({
      threadId: activeThreadId.value
    });
  }

  async function resolvePermission(permissionId: string, optionId?: string): Promise<void> {
    if (!activeThreadId.value) {
      return;
    }

    await cockpitApi().chat.resolvePermission({
      threadId: activeThreadId.value,
      permissionId,
      optionId
    });
  }

  async function updateThreadModel(modelId: string): Promise<void> {
    settings.value = {
      ...settings.value,
      defaultModelId: modelId
    };

    if (!activeThreadId.value) {
      if (!selectedProjectId.value) {
        return;
      }

      await createThread(selectedProjectId.value, modelId);
    }

    if (!activeThreadId.value) {
      return;
    }

    if (activeThread.value?.modelId === modelId) {
      models.value = await cockpitApi().chat.getModels(activeThreadId.value);
      return;
    }

    const updated = await cockpitApi().threads.updateModel(activeThreadId.value, modelId);
    upsertThread(updated);
    models.value = await cockpitApi().chat.getModels(activeThreadId.value);
  }

  async function refreshModels(): Promise<void> {
    models.value = await cockpitApi().chat.refreshModels(activeThreadId.value);
  }

  async function saveSettings(patch: Partial<SettingsRecord>): Promise<void> {
    settings.value = await cockpitApi().settings.update(patch);
    await refreshCliHealth();
  }

  async function openProjectPath(): Promise<void> {
    if (!selectedProject.value) {
      return;
    }

    await cockpitApi().system.openProjectPath(selectedProject.value.rootPath);
  }

  async function runCommitAndPush(message: string): Promise<void> {
    if (!selectedProject.value) {
      return;
    }

    const result = await cockpitApi().git.commitAndPush({
      rootPath: selectedProject.value.rootPath,
      message
    });

    commitOutput.value = [result.stdout, result.stderr].filter(Boolean).join("\n");
    await refreshGit();
  }

  return {
    projects,
    threads,
    selectedProjectId,
    activeThreadId,
    cliHealth,
    settings,
    gitStatus,
    changedFiles,
    models,
    booting,
    busy,
    settingsOpen,
    commitDialogOpen,
    errorMessage,
    commitOutput,
    selectedProject,
    projectThreadGroups,
    activeThread,
    transcriptMessages,
    transcriptTimeline,
    pendingPermissions,
    activeToolCalls,
    activePlan,
    bootstrap,
    addProject,
    selectProject,
    removeProject,
    createThread,
    openThread,
    deleteThread,
    sendPrompt,
    stopRun,
    retryRun,
    resolvePermission,
    updateThreadModel,
    refreshModels,
    refreshCliHealth,
    refreshGit,
    saveSettings,
    openProjectPath,
    runCommitAndPush
  };
});
