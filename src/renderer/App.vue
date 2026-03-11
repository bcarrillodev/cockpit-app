<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useCockpitStore } from "./stores/cockpit";
import type { MessageRecord, ProjectRecord, ThreadRecord } from "../shared/contracts";

type TranscriptMessageItem = MessageRecord & {
  itemType: "message";
  sortAt: string;
};

type TranscriptToolCallItem = {
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

type TranscriptDisplayItem =
  | TranscriptMessageItem
  | {
      itemType: "tool-call-group";
      id: string;
      count: number;
      createdAt: string;
      updatedAt: string;
      calls: TranscriptToolCallItem[];
    };

const store = useCockpitStore();
const {
  projectThreadGroups,
  selectedProjectId,
  activeThreadId,
  selectedProject,
  activeThread,
  transcriptTimeline,
  pendingPermissions,
  activePlan,
  cliHealth,
  gitStatus,
  changedFiles,
  models,
  booting,
  busy,
  settingsOpen,
  commitDialogOpen,
  errorMessage,
  commitOutput
} = storeToRefs(store);

const composer = ref("");
const commitMessage = ref("");
const cliExecutableDraft = ref("");

const emptyCards = [
  "Build a classic Snake game in this repo.",
  "Create a one-page summary of this app.",
  "Review this project for the highest-risk bugs."
];

const hasProjects = computed(() => projectThreadGroups.value.length > 0);
const deleteProjectTarget = ref<ProjectRecord | null>(null);
const deleteThreadTarget = ref<ThreadRecord | null>(null);
const collapsedProjects = ref<Record<string, boolean>>({});
const openProjectActionMenuId = ref<string | null>(null);
const expandedToolCallGroups = ref<Record<string, boolean>>({});
const transcriptTail = ref<HTMLElement | null>(null);
const deleteProjectThreadCount = computed(() => {
  if (!deleteProjectTarget.value) {
    return 0;
  }

  return projectThreadGroups.value.find((group) => group.project.id === deleteProjectTarget.value?.id)?.threads.length ?? 0;
});

const canSend = computed(() => {
  return Boolean(selectedProject.value) && Boolean(composer.value.trim()) && activeThread.value?.status !== "running";
});
const isThreadRunning = computed(() => activeThread.value?.status === "running");
const canUseComposerPrimaryAction = computed(() => isThreadRunning.value || canSend.value);
const composerPrimaryActionLabel = computed(() => (isThreadRunning.value ? "Stop request" : "Send message"));

const modelOptions = computed(() => models.value?.models ?? []);
const reasoningOptions = computed(() => models.value?.reasoningLevels ?? []);
const permissionApprovalEnabled = computed(() => store.settings.requirePermissionApproval !== false);

function showThreadIndicator(thread: ThreadRecord): boolean {
  return thread.status === "running" || thread.id === activeThreadId.value;
}

function threadIndicatorClass(thread: ThreadRecord): string {
  if (thread.status === "running") {
    return "bg-cyan-400";
  }

  if (thread.status === "error") {
    return "bg-rose-400";
  }

  return "bg-emerald-400/80";
}

function isAvailableModel(modelId: string | null | undefined): modelId is string {
  return Boolean(modelId) && modelOptions.value.some((model) => model.modelId === modelId);
}

function isAvailableReasoningLevel(reasoningLevelId: string | null | undefined): reasoningLevelId is string {
  return Boolean(reasoningLevelId) && reasoningOptions.value.some((level) => level.value === reasoningLevelId);
}

const modelSelection = computed({
  get: () => {
    const threadModelId = activeThread.value?.modelId;
    if (isAvailableModel(threadModelId)) {
      return threadModelId;
    }

    return models.value?.currentModelId ?? threadModelId ?? "";
  },
  set: async (value: string) => {
    if (!value || value === activeThread.value?.modelId) {
      return;
    }
    await store.updateThreadModel(value);
  }
});

const reasoningSelection = computed({
  get: () => {
    const threadReasoningLevelId = activeThread.value?.reasoningLevelId;
    if (isAvailableReasoningLevel(threadReasoningLevelId)) {
      return threadReasoningLevelId;
    }

    return models.value?.currentReasoningLevelId ?? threadReasoningLevelId ?? "";
  },
  set: async (value: string) => {
    if (!value || value === activeThread.value?.reasoningLevelId) {
      return;
    }
    await store.updateThreadReasoning(value);
  }
});

const cliNeedsAttention = computed(() => {
  return cliHealth.value && cliHealth.value.state !== "ready";
});

const gitLabel = computed(() => {
  if (!gitStatus.value.branch) {
    return "No git repo";
  }

  const parts = [gitStatus.value.branch];
  if (gitStatus.value.ahead) {
    parts.push(`↑${gitStatus.value.ahead}`);
  }
  if (gitStatus.value.behind) {
    parts.push(`↓${gitStatus.value.behind}`);
  }
  if (gitStatus.value.changedCount) {
    parts.push(`${gitStatus.value.changedCount} changed`);
  }
  return parts.join("  ");
});

const projectSubtitle = computed(() => {
  if (!selectedProject.value) {
    return "Add a local repo to get started.";
  }

  return selectedProject.value.rootPath;
});

const transcriptDisplayItems = computed<TranscriptDisplayItem[]>(() => {
  const items: TranscriptDisplayItem[] = [];
  let pendingToolCalls: TranscriptToolCallItem[] = [];

  const shouldRenderMessage = (item: TranscriptMessageItem): boolean => {
    if (item.role !== "assistant" || item.kind === "thought") {
      return true;
    }

    return Boolean(item.content.trim());
  };

  const flushToolCalls = () => {
    if (!pendingToolCalls.length) {
      return;
    }

    items.push({
      itemType: "tool-call-group",
      id: `tool-call-group:${pendingToolCalls[0].id}`,
      count: pendingToolCalls.length,
      createdAt: pendingToolCalls[0].createdAt,
      updatedAt: pendingToolCalls[pendingToolCalls.length - 1].updatedAt,
      calls: pendingToolCalls
    });
    pendingToolCalls = [];
  };

  for (const item of transcriptTimeline.value) {
    if (item.itemType === "tool-call") {
      pendingToolCalls.push(item);
      continue;
    }

    flushToolCalls();
    if (shouldRenderMessage(item)) {
      items.push(item);
    }
  }

  flushToolCalls();

  return items;
});

async function submitPrompt(nextPrompt?: string): Promise<void> {
  const value = nextPrompt ?? composer.value;
  if (!value.trim() || activeThread.value?.status === "running") {
    return;
  }

  composer.value = "";
  await store.sendPrompt(value);
}

async function handleComposerPrimaryAction(): Promise<void> {
  if (isThreadRunning.value) {
    await store.stopRun();
    return;
  }

  await submitPrompt();
}

async function togglePermissionApproval(): Promise<void> {
  await store.saveSettings({
    requirePermissionApproval: !permissionApprovalEnabled.value
  });
}

function messageLabel(item: Pick<MessageRecord, "kind" | "role">): string {
  if (item.kind === "thought") {
    return "Reasoning";
  }

  if (item.role === "assistant") {
    return "Response";
  }

  return item.role;
}

function messageShellClass(item: Pick<MessageRecord, "kind" | "role">): string {
  if (item.kind === "thought") {
    return "message-reasoning";
  }

  if (item.role === "assistant") {
    return "message-response";
  }

  if (item.role === "system") {
    return "message-system";
  }

  return "message-user";
}

function requestThreadDelete(thread: ThreadRecord): void {
  deleteThreadTarget.value = thread;
}

function requestProjectDelete(project: ProjectRecord): void {
  deleteProjectTarget.value = project;
}

function projectActionMenuVisible(projectId: string): boolean {
  return openProjectActionMenuId.value === projectId;
}

function closeProjectActionMenu(): void {
  openProjectActionMenuId.value = null;
}

function toggleProjectActionMenu(projectId: string): void {
  openProjectActionMenuId.value = openProjectActionMenuId.value === projectId ? null : projectId;
}

async function createThreadFromProjectMenu(projectId: string): Promise<void> {
  closeProjectActionMenu();
  await store.createThread(projectId);
}

function requestProjectDeleteFromMenu(project: ProjectRecord): void {
  closeProjectActionMenu();
  requestProjectDelete(project);
}

function projectThreadsVisible(projectId: string): boolean {
  return !collapsedProjects.value[projectId];
}

function toggleProjectThreads(projectId: string): void {
  const isCollapsed = Boolean(collapsedProjects.value[projectId]);
  collapsedProjects.value = {
    ...collapsedProjects.value,
    [projectId]: !isCollapsed
  };
  if (!isCollapsed) {
    closeProjectActionMenu();
  }
}

function toolCallGroupExpanded(groupId: string): boolean {
  return Boolean(expandedToolCallGroups.value[groupId]);
}

function toggleToolCallGroup(groupId: string): void {
  const isExpanded = Boolean(expandedToolCallGroups.value[groupId]);
  expandedToolCallGroups.value = {
    ...expandedToolCallGroups.value,
    [groupId]: !isExpanded
  };
}

function closeDeleteThreadDialog(): void {
  deleteThreadTarget.value = null;
}

function closeDeleteProjectDialog(): void {
  deleteProjectTarget.value = null;
}

function handleDeleteDialogVisibility(value: boolean): void {
  if (!value) {
    closeDeleteThreadDialog();
  }
}

function handleDeleteProjectDialogVisibility(value: boolean): void {
  if (!value) {
    closeDeleteProjectDialog();
  }
}

function openCommitDialog(): void {
  commitMessage.value = "";
  commitOutput.value = null;
  commitDialogOpen.value = true;
}

async function confirmThreadDelete(): Promise<void> {
  if (!deleteThreadTarget.value) {
    return;
  }

  const threadId = deleteThreadTarget.value.id;
  deleteThreadTarget.value = null;
  await store.deleteThread(threadId);
}

async function confirmProjectDelete(): Promise<void> {
  if (!deleteProjectTarget.value) {
    return;
  }

  const projectId = deleteProjectTarget.value.id;
  deleteProjectTarget.value = null;
  await store.removeProject(projectId);
}

watch(
  () =>
    transcriptTimeline.value.map((item) =>
      item.itemType === "message"
        ? `${item.id}:${item.content.length}:${item.createdAt}`
        : `${item.id}:${item.status ?? ""}:${item.content.length}:${item.updatedAt}`
    ),
  async () => {
    await nextTick();
    if (typeof transcriptTail.value?.scrollIntoView === "function") {
      transcriptTail.value.scrollIntoView({ block: "end" });
    }
  },
  {
    flush: "post"
  }
);

watch(commitDialogOpen, (isOpen) => {
  if (isOpen) {
    return;
  }

  commitMessage.value = "";
  commitOutput.value = null;
});

onMounted(async () => {
  window.addEventListener("click", closeProjectActionMenu);
  await store.bootstrap();
  cliExecutableDraft.value = store.settings.cliExecutablePath ?? "";
});

onBeforeUnmount(() => {
  window.removeEventListener("click", closeProjectActionMenu);
});
</script>

<template>
  <div class="cockpit-theme-dark h-screen overflow-hidden bg-[radial-gradient(circle_at_top,#19151f,transparent_38%),linear-gradient(180deg,#09090b_0%,#050507_100%)] text-zinc-100">
    <div class="flex h-full">
      <aside class="sidebar-shell app-sidebar flex shrink-0 overflow-hidden border-r border-white/8">
        <div class="flex h-full w-full min-w-0 flex-col">
          <div class="window-drag-region px-8 pt-14">
            <div class="window-badge">Cockpit</div>
          </div>

          <div class="min-h-0 min-w-0 flex-1 px-2 pb-3 pt-12">
            <div class="mb-4 flex items-center justify-between px-0.5">
              <span class="section-label">Threads</span>
              <button
                class="sidebar-inline-action"
                type="button"
                aria-label="Add project"
                v-tooltip.top="'Add project'"
                @click="store.addProject()"
              >
                <i class="pi pi-folder-open text-sm" />
              </button>
            </div>

            <div class="thread-list">
              <div v-if="!hasProjects" class="sidebar-empty-state">
                Add a project to start organizing threads.
              </div>

              <section
                v-for="group in projectThreadGroups"
                :key="group.project.id"
                class="project-group"
              >
                <div
                  class="project-pill"
                  :class="{ 'project-pill-active': group.project.id === selectedProjectId }"
                >
                  <div class="project-pill-header">
                    <button
                      class="icon-button project-toggle-button"
                      type="button"
                      :aria-expanded="projectThreadsVisible(group.project.id)"
                      :aria-label="projectThreadsVisible(group.project.id) ? 'Hide threads' : 'Show threads'"
                      @click.stop="toggleProjectThreads(group.project.id)"
                    >
                      <i :class="projectThreadsVisible(group.project.id) ? 'pi pi-angle-down' : 'pi pi-angle-right'" />
                    </button>
                    <button
                      class="project-pill-main"
                      type="button"
                      @click="store.selectProject(group.project.id)"
                    >
                      <span class="project-pill-name">{{ group.project.name }}</span>
                    </button>
                    <div class="project-group-actions">
                      <button
                        class="icon-button project-actions-button"
                        type="button"
                        aria-label="Project actions"
                        aria-haspopup="menu"
                        :aria-expanded="projectActionMenuVisible(group.project.id)"
                        v-tooltip.top="'Project actions'"
                        @click.stop="toggleProjectActionMenu(group.project.id)"
                      >
                        <i class="pi pi-ellipsis-h" />
                      </button>

                      <div
                        v-if="projectActionMenuVisible(group.project.id)"
                        class="project-action-menu"
                        role="menu"
                        :aria-label="`Actions for ${group.project.name}`"
                        @click.stop
                      >
                        <button
                          class="project-action-menu-item"
                          type="button"
                          role="menuitem"
                          @click.stop="createThreadFromProjectMenu(group.project.id)"
                        >
                          <i class="pi pi-plus text-xs" />
                          <span>Add new thread</span>
                        </button>
                        <button
                          class="project-action-menu-item project-action-menu-item-danger"
                          type="button"
                          role="menuitem"
                          @click.stop="requestProjectDeleteFromMenu(group.project)"
                        >
                          <i class="pi pi-times text-xs" />
                          <span>Remove project</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  <div v-if="projectThreadsVisible(group.project.id)" class="project-pill-body">
                    <div v-if="group.threads.length" class="project-thread-list">
                      <div
                        v-for="thread in group.threads"
                        :key="thread.id"
                        class="thread-row"
                        :class="{ 'thread-row-active': thread.id === activeThreadId }"
                      >
                        <button
                          class="thread-item thread-item-grouped"
                          @click="store.openThread(thread.id)"
                        >
                          <div class="flex items-start gap-3">
                            <span
                              v-if="showThreadIndicator(thread)"
                              class="mt-1 h-2.5 w-2.5 rounded-full"
                              :class="threadIndicatorClass(thread)"
                            />
                            <div class="min-w-0 flex-1">
                              <div class="truncate font-medium text-white">{{ thread.title }}</div>
                            </div>
                          </div>
                        </button>
                        <button
                          class="icon-button thread-delete-button"
                          :class="{ 'thread-delete-button-visible': thread.id === activeThreadId }"
                          type="button"
                          aria-label="Delete thread"
                          v-tooltip.top="'Delete thread'"
                          @click.stop="requestThreadDelete(thread)"
                        >
                          <i class="pi pi-trash" />
                        </button>
                      </div>
                    </div>

                    <div v-else class="thread-empty-state">
                      No threads yet.
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <div class="px-2 pb-0 pt-2">
            <button class="sidebar-action" type="button" @click="settingsOpen = true">
              <i class="pi pi-cog text-sm" />
              <span>Settings</span>
            </button>
          </div>
        </div>
      </aside>

      <main class="flex min-w-0 flex-1 flex-col">
        <header class="window-drag-region main-header flex items-center gap-3 border-b border-white/8 px-6 py-3 backdrop-blur">
          <div class="min-w-0 flex-1">
            <div class="truncate text-xl font-semibold tracking-tight text-white">
              {{ activeThread?.title ?? "New thread" }}
            </div>
            <div class="mt-0.5 truncate text-xs text-zinc-500">
              {{ projectSubtitle }}
            </div>
          </div>

          <div class="hidden items-center gap-2 rounded-full border border-white/10 bg-white/4 px-4 py-1.5 text-sm text-zinc-300 md:flex">
            <i class="pi pi-code-branch text-xs" />
            <span>{{ gitLabel }}</span>
          </div>

          <PButton
            class="window-no-drag"
            size="small"
            label="Commit"
            :disabled="!selectedProject || activeThread?.status === 'running'"
            @click="openCommitDialog()"
          />
        </header>

        <section class="relative flex min-h-0 flex-1 flex-col px-6 pb-6 pt-6">
          <div class="absolute inset-x-12 top-5 h-40 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.06),transparent_65%)] blur-3xl" />

          <PMessage
            v-if="errorMessage"
            severity="error"
            :closable="false"
            class="mb-4"
          >
            {{ errorMessage }}
          </PMessage>

          <PMessage
            v-if="cliNeedsAttention"
            severity="warn"
            :closable="false"
            class="mb-4"
          >
            <div class="flex flex-col gap-2">
              <div class="font-medium text-zinc-100">
                Copilot CLI {{ cliHealth?.state === "missing" ? "is missing" : "needs login" }}
              </div>
              <div class="text-sm text-zinc-300">
                Install with <code>brew install github/copilot-cli/copilot</code> or <code>npm install -g @github/copilot</code>, then run <code>copilot auth login</code>.
              </div>
            </div>
          </PMessage>

          <div v-if="pendingPermissions.length || activePlan.length" class="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div class="space-y-3">
              <section
                v-for="permission in pendingPermissions"
                :key="permission.id"
                class="glass-panel rounded-3xl p-4"
              >
                <div class="text-xs uppercase tracking-[0.24em] text-zinc-500">Permission</div>
                <div class="mt-2 text-base font-medium text-white">{{ permission.prompt }}</div>
                <div class="mt-4 flex flex-wrap gap-2">
                  <PButton
                    v-for="option in permission.options"
                    :key="option.optionId"
                    size="small"
                    :label="option.name"
                    @click="store.resolvePermission(permission.id, option.optionId)"
                  />
                  <PButton size="small" severity="secondary" outlined label="Cancel" @click="store.resolvePermission(permission.id)" />
                </div>
              </section>
            </div>

            <aside class="space-y-4">
              <section v-if="activePlan.length" class="glass-panel rounded-3xl p-4">
                <div class="section-label">Plan</div>
                <div class="mt-4 space-y-3">
                  <div v-for="entry in activePlan" :key="entry.content" class="flex items-start gap-3">
                    <span
                      class="mt-1 h-2.5 w-2.5 rounded-full"
                      :class="entry.status === 'completed' ? 'bg-emerald-400' : entry.status === 'in_progress' ? 'bg-cyan-400' : 'bg-zinc-500'"
                    />
                    <div class="min-w-0">
                      <div class="text-sm text-zinc-100">{{ entry.content }}</div>
                      <div class="text-xs uppercase tracking-[0.2em] text-zinc-500">{{ entry.status }}</div>
                    </div>
                  </div>
                </div>
              </section>

            </aside>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto pr-1">
            <div
              v-if="!transcriptTimeline.length && !booting"
              class="hero-shell mx-auto flex min-h-full max-w-4xl flex-col items-center justify-center gap-10 pb-10 pt-12 text-center"
            >
              <div class="hero-mark">
                <i class="pi pi-sparkles text-4xl" />
              </div>
              <div>
                <div class="text-6xl font-semibold tracking-tight text-white">Let's fly</div>
                <div class="mt-3 text-5xl font-medium text-zinc-500">
                  {{ selectedProject?.name ?? "cockpit-app" }}
                </div>
              </div>

              <div class="grid w-full gap-4 md:grid-cols-3">
                <button
                  v-for="card in emptyCards"
                  :key="card"
                  class="prompt-card text-left"
                  @click="submitPrompt(card)"
                >
                  {{ card }}
                </button>
              </div>
            </div>

            <div v-else class="transcript-stack mx-auto flex max-w-4xl flex-col gap-5 pb-10 pt-6">
              <template v-for="item in transcriptDisplayItems" :key="item.id">
                <article
                  v-if="item.itemType === 'message'"
                  class="message-shell"
                  :class="messageShellClass(item)"
                >
                  <div class="mb-2 flex items-center justify-between gap-4">
                    <div class="text-xs uppercase tracking-[0.26em] text-zinc-500">
                      {{ messageLabel(item) }}
                    </div>
                  </div>
                  <div class="whitespace-pre-wrap text-[15px] leading-7 text-zinc-100">{{ item.content }}</div>
                </article>

                <article
                  v-else
                  class="tool-call-group-shell"
                  :class="{ 'tool-call-group-collapsed': !toolCallGroupExpanded(item.id) }"
                >
                  <div class="mb-4 flex items-center justify-between gap-4">
                    <div class="flex items-center gap-3">
                      <div>
                        <div class="text-xs uppercase tracking-[0.26em] text-zinc-500">
                          {{ item.count === 1 ? 'Tool call' : 'Tool calls' }}
                        </div>
                        <div class="mt-2 text-sm text-zinc-400">
                          {{ item.count }} {{ item.count === 1 ? 'call' : 'calls' }}
                        </div>
                      </div>
                    </div>
                    <button
                      class="tool-call-toggle"
                      type="button"
                      :aria-expanded="toolCallGroupExpanded(item.id)"
                      :aria-label="toolCallGroupExpanded(item.id) ? 'Collapse tool calls' : 'Expand tool calls'"
                      @click="toggleToolCallGroup(item.id)"
                    >
                      {{ toolCallGroupExpanded(item.id) ? 'Collapse' : 'Expand' }}
                    </button>
                  </div>

                  <div
                    v-if="toolCallGroupExpanded(item.id)"
                    class="tool-call-group-list"
                  >
                    <section
                      v-for="call in item.calls"
                      :key="call.id"
                      class="tool-call-entry"
                    >
                      <div class="flex items-start justify-between gap-4">
                        <div class="min-w-0">
                          <div class="text-sm font-medium text-white">{{ call.title }}</div>
                          <div v-if="call.kind" class="mt-1 text-xs uppercase tracking-[0.2em] text-zinc-500">
                            {{ call.kind }}
                          </div>
                        </div>
                        <PTag :value="call.status ?? 'pending'" severity="contrast" />
                      </div>
                    </section>
                  </div>
                </article>
              </template>
              <div ref="transcriptTail" class="h-px w-full" aria-hidden="true" />
            </div>
          </div>

          <div class="mt-5">
            <div class="composer-shell">
              <PTextarea
                v-model="composer"
                autoResize
                rows="3"
                class="w-full"
                placeholder="Ask Copilot anything"
                @keydown.meta.enter.prevent="submitPrompt()"
                @keydown.ctrl.enter.prevent="submitPrompt()"
              />
              <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div class="flex w-full flex-col gap-3 sm:max-w-[29rem] sm:flex-row sm:items-start">
                  <div class="w-full sm:w-[14.25rem] sm:flex-none">
                    <PSelect
                      v-model="modelSelection"
                      :options="modelOptions"
                      optionLabel="name"
                      optionValue="modelId"
                      :disabled="!selectedProject || activeThread?.status === 'running' || !modelOptions.length"
                      class="composer-select w-full"
                      placeholder="Model"
                    />
                  </div>
                  <div class="w-full sm:w-[9rem] sm:flex-none">
                    <PSelect
                      v-model="reasoningSelection"
                      :options="reasoningOptions"
                      optionLabel="name"
                      optionValue="value"
                      :disabled="!selectedProject || activeThread?.status === 'running' || !reasoningOptions.length"
                      class="composer-select w-full"
                      placeholder="Reasoning"
                    />
                  </div>
                </div>
                <div class="composer-action-row">
                  <PButton
                    v-if="activeThread?.status === 'error'"
                    label="Retry"
                    severity="secondary"
                    outlined
                    @click="store.retryRun"
                  />
                  <button
                    v-tooltip.top="{ value: 'Send', disabled: !canSend || isThreadRunning }"
                    class="composer-primary-action"
                    :class="{ 'composer-primary-action-stop': isThreadRunning }"
                    type="button"
                    :aria-label="composerPrimaryActionLabel"
                    :disabled="!canUseComposerPrimaryAction"
                    @click="handleComposerPrimaryAction"
                  >
                    <svg
                      v-if="!isThreadRunning"
                      class="composer-primary-action-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden="true"
                    >
                      <path
                        d="M12 17V7"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                      />
                      <path
                        d="M7.5 11.5L12 7L16.5 11.5"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                    <span v-else class="composer-stop-glyph" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>

    <PDialog
      v-model:visible="commitDialogOpen"
      modal
      header="Commit & Push"
      :style="{ width: 'min(860px, 92vw)' }"
    >
      <div class="space-y-5">
        <div class="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
          <div class="rounded-3xl border border-white/8 bg-zinc-950/80 p-4">
            <div class="section-label">Changed Files</div>
            <div class="mt-4 max-h-[360px] space-y-2 overflow-y-auto pr-2">
              <div v-if="!changedFiles.length" class="rounded-2xl border border-white/6 bg-white/[0.03] p-4 text-sm text-zinc-400">
                Working tree is clean.
              </div>
              <div v-for="file in changedFiles" :key="file.path" class="rounded-2xl border border-white/6 bg-white/[0.03] p-3">
                <div class="font-medium text-zinc-100">{{ file.path }}</div>
                <div class="mt-1 text-xs uppercase tracking-[0.2em] text-zinc-500">
                  {{ file.stagedStatus ?? "·" }} {{ file.worktreeStatus ?? "·" }}
                </div>
              </div>
            </div>
          </div>

          <div class="rounded-3xl border border-white/8 bg-zinc-950/80 p-4">
            <div class="section-label">Commit Message</div>
            <PInputText v-model="commitMessage" fluid class="mt-4" placeholder="Summarize this change" />
            <PButton
              class="mt-4 w-full"
              label="Commit & Push"
              :disabled="!commitMessage.trim() || !selectedProject"
              @click="store.runCommitAndPush(commitMessage)"
            />
            <div v-if="commitOutput" class="mt-4 whitespace-pre-wrap rounded-2xl border border-white/6 bg-black/30 p-3 text-xs text-zinc-400">
              {{ commitOutput }}
            </div>
          </div>
        </div>
      </div>
    </PDialog>

    <PDialog
      :visible="Boolean(deleteProjectTarget)"
      modal
      header="Delete Project"
      :style="{ width: 'min(420px, 92vw)' }"
      @update:visible="handleDeleteProjectDialogVisibility"
    >
      <div class="space-y-5">
        <div class="text-sm text-zinc-300">
          Delete <span class="font-medium text-white">{{ deleteProjectTarget?.name }}</span><span v-if="deleteProjectThreadCount"> and {{ deleteProjectThreadCount }} thread{{ deleteProjectThreadCount === 1 ? '' : 's' }}</span>? This cannot be undone.
        </div>
        <div class="flex justify-end gap-3">
          <PButton label="Cancel" severity="secondary" text @click="closeDeleteProjectDialog" />
          <PButton label="Delete project" severity="danger" :loading="busy" @click="confirmProjectDelete" />
        </div>
      </div>
    </PDialog>

    <PDialog
      :visible="Boolean(deleteThreadTarget)"
      modal
      header="Delete Thread"
      :style="{ width: 'min(420px, 92vw)' }"
      @update:visible="handleDeleteDialogVisibility"
    >
      <div class="space-y-5">
        <div class="text-sm text-zinc-300">
          Delete <span class="font-medium text-white">{{ deleteThreadTarget?.title }}</span>? This cannot be undone.
        </div>
        <div class="flex justify-end gap-3">
          <PButton label="Cancel" severity="secondary" text @click="closeDeleteThreadDialog" />
          <PButton label="Delete thread" severity="danger" :loading="busy" @click="confirmThreadDelete" />
        </div>
      </div>
    </PDialog>

    <PDrawer v-model:visible="settingsOpen" position="right" header="Settings" :style="{ width: '420px' }">
      <div class="space-y-6">
        <div>
          <div class="section-label">Copilot CLI</div>
          <div class="mt-3 text-sm text-zinc-400">
            Override the executable path when the CLI is installed somewhere non-standard.
          </div>
          <PInputText v-model="cliExecutableDraft" fluid class="mt-4" placeholder="/usr/local/bin/copilot" />
          <PButton class="mt-3" label="Save path" @click="store.saveSettings({ cliExecutablePath: cliExecutableDraft || null })" />
        </div>

        <div class="rounded-3xl border border-white/8 bg-zinc-950/70 p-4">
          <div class="section-label">Install</div>
          <div class="mt-3 space-y-2 text-sm text-zinc-300">
            <div><code>brew install github/copilot-cli/copilot</code></div>
            <div><code>npm install -g @github/copilot</code></div>
            <div><code>copilot auth login</code></div>
            <div><code>copilot auth status</code></div>
          </div>
        </div>

        <div class="rounded-3xl border border-white/8 bg-zinc-950/70 p-4">
          <div class="section-label">Permissions</div>
          <div class="mt-3 text-sm text-zinc-400">
            Control whether tool requests pause for approval before they run.
          </div>
          <button
            class="mt-4 flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:border-white/20 hover:bg-white/[0.06]"
            type="button"
            role="switch"
            :aria-checked="permissionApprovalEnabled"
            @click="togglePermissionApproval"
          >
            <div class="pr-4">
              <div class="text-sm font-medium text-white">Require approval for tool permissions</div>
              <div class="mt-1 text-xs text-zinc-500">
                Turn this off to auto-approve tool requests instead of showing permission prompts.
              </div>
            </div>
            <span
              class="relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition"
              :class="permissionApprovalEnabled ? 'bg-emerald-400/90' : 'bg-zinc-700'"
            >
              <span
                class="inline-block h-5 w-5 rounded-full bg-white shadow-sm transition"
                :class="permissionApprovalEnabled ? 'translate-x-6' : 'translate-x-1'"
              />
            </span>
          </button>
        </div>
      </div>
    </PDrawer>
  </div>
</template>
