import { basename, join } from "node:path";
import { mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import {
  type CliHealth,
  type MessageRecord,
  type PermissionRequestRecord,
  type ProjectRecord,
  type SettingsRecord,
  type ThreadOpenPayload,
  type ThreadRecord,
  type ToolCallHistoryRecord
} from "../shared/contracts";

type JsonFile<T> = {
  path: string;
  fallback: T;
};

function defaultSettings(): SettingsRecord {
  return {
    cliExecutablePath: null,
    requirePermissionApproval: true,
    selectedProjectId: null,
    defaultModelId: null,
    defaultReasoningLevelId: null,
    hiddenProjectIds: []
  };
}

function normalizeSettings(settings: Partial<SettingsRecord> | null | undefined): SettingsRecord {
  return {
    ...defaultSettings(),
    ...settings,
    requirePermissionApproval: settings?.requirePermissionApproval !== false,
    defaultModelId: typeof settings?.defaultModelId === "string" ? settings.defaultModelId : null,
    defaultReasoningLevelId:
      typeof settings?.defaultReasoningLevelId === "string" ? settings.defaultReasoningLevelId : null,
    hiddenProjectIds: Array.isArray(settings?.hiddenProjectIds) ? settings.hiddenProjectIds : []
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sortProjects(projects: ProjectRecord[]): ProjectRecord[] {
  return [...projects].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function readJson<T>(file: JsonFile<T>): Promise<T> {
  try {
    const raw = await readFile(file.path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    await writeJson(file, file.fallback);
    return structuredClone(file.fallback);
  }
}

async function writeJson<T>(file: JsonFile<T>, value: T): Promise<void> {
  await writeFile(file.path, JSON.stringify(value, null, 2), "utf8");
}

function createProjectRecord(rootPath: string): ProjectRecord {
  const timestamp = nowIso();
  return {
    id: crypto.randomUUID(),
    name: basename(rootPath),
    rootPath,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp
  };
}

function normalizeThread(thread: Partial<ThreadRecord>): ThreadRecord {
  return {
    id: thread.id ?? crypto.randomUUID(),
    projectId: thread.projectId ?? "",
    title: typeof thread.title === "string" ? thread.title : "New thread",
    summary: typeof thread.summary === "string" ? thread.summary : "",
    modelId: typeof thread.modelId === "string" ? thread.modelId : "",
    reasoningLevelId: typeof thread.reasoningLevelId === "string" ? thread.reasoningLevelId : "",
    createdAt: typeof thread.createdAt === "string" ? thread.createdAt : nowIso(),
    updatedAt: typeof thread.updatedAt === "string" ? thread.updatedAt : nowIso(),
    lastMessageAt: typeof thread.lastMessageAt === "string" ? thread.lastMessageAt : null,
    status: thread.status === "running" || thread.status === "error" ? thread.status : "idle"
  };
}

function createThreadRecord(projectId: string, modelId: string, reasoningLevelId: string): ThreadRecord {
  const timestamp = nowIso();
  return normalizeThread({
    id: crypto.randomUUID(),
    projectId,
    modelId,
    reasoningLevelId,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastMessageAt: null
  });
}

export class AppStore {
  private rootPath: string;
  private projectsFile: JsonFile<ProjectRecord[]>;
  private threadsFile: JsonFile<ThreadRecord[]>;
  private permissionsFile: JsonFile<PermissionRequestRecord[]>;
  private settingsFile: JsonFile<SettingsRecord>;
  private cliHealthFile: JsonFile<CliHealth>;
  private messagesPath: string;
  private toolCallsPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.projectsFile = {
      path: join(rootPath, "projects.json"),
      fallback: []
    };
    this.threadsFile = {
      path: join(rootPath, "threads.json"),
      fallback: []
    };
    this.permissionsFile = {
      path: join(rootPath, "permissions.json"),
      fallback: []
    };
    this.settingsFile = {
      path: join(rootPath, "settings.json"),
      fallback: defaultSettings()
    };
    this.cliHealthFile = {
      path: join(rootPath, "cli-health.json"),
      fallback: {
        installed: false,
        version: null,
        executablePath: null,
        state: "missing",
        error: null
      }
    };
    this.messagesPath = join(rootPath, "messages");
    this.toolCallsPath = join(rootPath, "tool-calls");
  }

  async init(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    await mkdir(this.messagesPath, { recursive: true });
    await mkdir(this.toolCallsPath, { recursive: true });
    await Promise.all([
      readJson(this.projectsFile),
      readJson(this.threadsFile),
      readJson(this.permissionsFile),
      readJson(this.settingsFile),
      readJson(this.cliHealthFile)
    ]);

    const threads = await this.getThreads();
    const sanitizedThreads = threads.map((thread) => ({
      ...normalizeThread(thread),
      status: thread.status === "running" ? "idle" : thread.status
    }));
    await writeJson(this.threadsFile, sanitizedThreads);

    const permissions = await this.getPermissions();
    const sanitizedPermissions = permissions
      .filter((permission) => permission.status !== "pending")
      .map((permission) => ({
        ...permission,
        updatedAt: nowIso()
      }));
    await writeJson(this.permissionsFile, sanitizedPermissions);
  }

  async getProjects(): Promise<ProjectRecord[]> {
    return sortProjects(await readJson(this.projectsFile));
  }

  async createProject(rootPath: string): Promise<ProjectRecord> {
    const projects = await readJson(this.projectsFile);
    const existing = projects.find((project) => project.rootPath === rootPath);
    if (existing) {
      return existing;
    }

    const record = createProjectRecord(rootPath);
    projects.push(record);
    await writeJson(this.projectsFile, projects);
    await this.updateSettings({
      selectedProjectId: record.id
    });
    return record;
  }

  async removeProject(projectId: string): Promise<void> {
    const projects = (await readJson(this.projectsFile)).filter((project) => project.id !== projectId);
    const existingThreads = await readJson(this.threadsFile);
    const removedThreadIds = existingThreads
      .filter((thread) => thread.projectId === projectId)
      .map((thread) => thread.id);
    const threads = existingThreads.filter((thread) => thread.projectId !== projectId);
    const permissions = (await readJson(this.permissionsFile)).filter((permission) => {
      return threads.some((thread) => thread.id === permission.threadId);
    });
    const settings = normalizeSettings(await readJson(this.settingsFile));

    await writeJson(this.projectsFile, projects);
    await writeJson(this.threadsFile, threads);
    await writeJson(this.permissionsFile, permissions);
    await Promise.all(
      removedThreadIds.flatMap((threadId) => [
        rm(this.messageFile(threadId), { force: true }),
        rm(this.toolCallFile(threadId), { force: true })
      ])
    );

    await writeJson(this.settingsFile, {
      ...settings,
      selectedProjectId: settings.selectedProjectId === projectId ? projects[0]?.id ?? null : settings.selectedProjectId,
      hiddenProjectIds: settings.hiddenProjectIds.filter((id) => id !== projectId)
    });
  }

  async selectProject(projectId: string): Promise<ProjectRecord | null> {
    const projects = await readJson(this.projectsFile);
    const project = projects.find((entry) => entry.id === projectId) ?? null;
    if (!project) {
      return null;
    }
    await this.updateSettings({ selectedProjectId: projectId });
    return project;
  }

  async getThreads(projectId?: string): Promise<ThreadRecord[]> {
    const threads = (await readJson(this.threadsFile)).map((thread) => normalizeThread(thread));
    return threads
      .filter((thread) => (projectId ? thread.projectId === projectId : true))
      .sort((a, b) => {
        const left = a.lastMessageAt ?? a.createdAt;
        const right = b.lastMessageAt ?? b.createdAt;
        return right.localeCompare(left);
      });
  }

  async getThread(threadId: string): Promise<ThreadRecord | null> {
    const threads = (await readJson(this.threadsFile)).map((thread) => normalizeThread(thread));
    return threads.find((thread) => thread.id === threadId) ?? null;
  }

  async createThread(projectId: string, modelId?: string, reasoningLevelId?: string): Promise<ThreadRecord> {
    const threads = await readJson(this.threadsFile);
    const settings = await this.getSettings();
    const thread = createThreadRecord(
      projectId,
      modelId?.trim() || settings.defaultModelId || "",
      reasoningLevelId?.trim() || settings.defaultReasoningLevelId || ""
    );
    threads.push(thread);
    await writeJson(this.threadsFile, threads);
    return thread;
  }

  async updateThread(threadId: string, patch: Partial<ThreadRecord>): Promise<ThreadRecord> {
    const threads = await readJson(this.threadsFile);
    const current = threads.find((thread) => thread.id === threadId);
    if (!current) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const next: ThreadRecord = {
      ...current,
      ...patch,
      updatedAt: nowIso()
    };

    await writeJson(
      this.threadsFile,
      threads.map((thread) => (thread.id === threadId ? next : thread))
    );
    return next;
  }

  async deleteThread(threadId: string): Promise<void> {
    const threads = (await readJson(this.threadsFile)).filter((thread) => thread.id !== threadId);
    const permissions = (await readJson(this.permissionsFile)).filter(
      (permission) => permission.threadId !== threadId
    );
    await writeJson(this.threadsFile, threads);
    await writeJson(this.permissionsFile, permissions);
    await Promise.all([
      rm(this.messageFile(threadId), { force: true }),
      rm(this.toolCallFile(threadId), { force: true })
    ]);
  }

  async listMessages(threadId: string): Promise<MessageRecord[]> {
    try {
      const raw = await readFile(this.messageFile(threadId), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as MessageRecord)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch {
      return [];
    }
  }

  async appendMessage(message: MessageRecord): Promise<void> {
    await appendFile(this.messageFile(message.threadId), `${JSON.stringify(message)}\n`, "utf8");
  }

  async listToolCalls(threadId: string): Promise<ToolCallHistoryRecord[]> {
    return readJson<ToolCallHistoryRecord[]>({
      path: this.toolCallFile(threadId),
      fallback: []
    }).then((toolCalls) => toolCalls.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt)));
  }

  async upsertToolCall(threadId: string, toolCall: ToolCallHistoryRecord): Promise<ToolCallHistoryRecord> {
    const toolCalls = await this.listToolCalls(threadId);
    const existing = toolCalls.findIndex((entry) => entry.toolCallId === toolCall.toolCallId);

    if (existing >= 0) {
      toolCalls[existing] = toolCall;
    } else {
      toolCalls.push(toolCall);
    }

    await writeJson(
      {
        path: this.toolCallFile(threadId),
        fallback: []
      },
      toolCalls.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))
    );
    return toolCall;
  }

  async getPermissions(threadId?: string): Promise<PermissionRequestRecord[]> {
    const permissions = await readJson(this.permissionsFile);
    return permissions
      .filter((permission) => (threadId ? permission.threadId === threadId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async upsertPermission(permission: PermissionRequestRecord): Promise<PermissionRequestRecord> {
    const permissions = await readJson(this.permissionsFile);
    const existing = permissions.findIndex((entry) => entry.id === permission.id);

    if (existing >= 0) {
      permissions[existing] = permission;
    } else {
      permissions.push(permission);
    }

    await writeJson(this.permissionsFile, permissions);
    return permission;
  }

  async getSettings(): Promise<SettingsRecord> {
    return normalizeSettings(await readJson(this.settingsFile));
  }

  async updateSettings(patch: Partial<SettingsRecord>): Promise<SettingsRecord> {
    const settings = await this.getSettings();
    const next = normalizeSettings({
      ...settings,
      ...patch
    });
    await writeJson(this.settingsFile, next);
    return next;
  }

  async getCliHealth(): Promise<CliHealth> {
    return readJson(this.cliHealthFile);
  }

  async setCliHealth(cliHealth: CliHealth): Promise<CliHealth> {
    await writeJson(this.cliHealthFile, cliHealth);
    return cliHealth;
  }

  async openThread(threadId: string): Promise<ThreadOpenPayload> {
    const thread = await this.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    return {
      thread,
      messages: await this.listMessages(threadId),
      permissions: await this.getPermissions(threadId),
      toolCalls: await this.listToolCalls(threadId)
    };
  }

  private messageFile(threadId: string): string {
    return join(this.messagesPath, `${threadId}.jsonl`);
  }

  private toolCallFile(threadId: string): string {
    return join(this.toolCallsPath, `${threadId}.json`);
  }
}
