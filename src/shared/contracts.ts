export type ThreadStatus = "idle" | "running" | "error";

export type MessageRole = "user" | "assistant" | "system";

export type MessageKind = "message" | "thought" | "tool" | "status" | "error";

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface ThreadRecord {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  status: ThreadStatus;
}

export interface MessageRecord {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  kind: MessageKind;
  metadata?: Record<string, unknown>;
}

export type CliState = "ready" | "missing" | "auth_required" | "error";

export interface CliHealth {
  installed: boolean;
  version: string | null;
  executablePath: string | null;
  state: CliState;
  error: string | null;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changedCount: number;
  untrackedCount: number;
  isClean: boolean;
}

export interface ChangedFileRecord {
  path: string;
  stagedStatus: string | null;
  worktreeStatus: string | null;
  isUntracked: boolean;
}

export interface PermissionOptionRecord {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionRequestRecord {
  id: string;
  threadId: string;
  kind: string;
  prompt: string;
  options: PermissionOptionRecord[];
  toolCallId: string;
  status: "pending" | "resolved" | "cancelled";
  selectedOptionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRecord {
  modelId: string;
  name: string;
}

export interface ModelDiscoveryResult {
  models: ModelRecord[];
  currentModelId: string | null;
  discoveredAt: string;
  source: "prompt" | "session" | "cache" | "fallback";
  error?: string;
}

export interface SettingsRecord {
  cliExecutablePath: string | null;
  selectedProjectId: string | null;
  defaultModelId: string | null;
  hiddenProjectIds: string[];
}

export interface ThreadOpenPayload {
  thread: ThreadRecord;
  messages: MessageRecord[];
  permissions: PermissionRequestRecord[];
  toolCalls: ToolCallHistoryRecord[];
}

export interface CommitAndPushInput {
  rootPath: string;
  message: string;
}

export interface CommitAndPushResult {
  stdout: string;
  stderr: string;
}

export interface ChatSendInput {
  threadId: string;
  content: string;
}

export interface ChatRetryInput {
  threadId: string;
}

export interface ChatStopInput {
  threadId: string;
}

export interface ResolvePermissionInput {
  threadId: string;
  permissionId: string;
  optionId?: string;
}

export type ChatEvent =
  | {
      type: "message-created";
      threadId: string;
      message: MessageRecord;
    }
  | {
      type: "assistant-delta";
      threadId: string;
      messageId: string;
      content: string;
      kind: MessageKind;
    }
  | {
      type: "status-changed";
      threadId: string;
      status: ThreadStatus;
      error?: string;
    }
  | {
      type: "permission-requested";
      threadId: string;
      permission: PermissionRequestRecord;
    }
  | {
      type: "permission-resolved";
      threadId: string;
      permission: PermissionRequestRecord;
    }
  | {
      type: "tool-updated";
      threadId: string;
      toolCall: ToolCallRecord;
    }
  | {
      type: "plan-updated";
      threadId: string;
      plan: PlanEntryRecord[];
    }
  | {
      type: "models-updated";
      threadId: string | null;
      discovery: ModelDiscoveryResult;
    };

export interface ToolCallRecord {
  toolCallId: string;
  title: string;
  kind: string | null;
  status: string | null;
  content: string;
  locations: string[];
}

export interface ToolCallHistoryRecord extends ToolCallRecord {
  firstSeenAt: string;
  lastUpdatedAt: string;
}

export interface PlanEntryRecord {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface CockpitApi {
  system: {
    getCliHealth: () => Promise<CliHealth>;
    pickProjectDirectory: () => Promise<string | null>;
    openProjectPath: (projectPath: string) => Promise<void>;
  };
  projects: {
    list: () => Promise<ProjectRecord[]>;
    create: (rootPath: string) => Promise<ProjectRecord>;
    remove: (projectId: string) => Promise<void>;
    select: (projectId: string) => Promise<ProjectRecord | null>;
  };
  threads: {
    list: (projectId?: string) => Promise<ThreadRecord[]>;
    create: (projectId: string, modelId?: string) => Promise<ThreadRecord>;
    rename: (threadId: string, title: string) => Promise<ThreadRecord>;
    delete: (threadId: string) => Promise<void>;
    open: (threadId: string) => Promise<ThreadOpenPayload>;
    updateModel: (threadId: string, modelId: string) => Promise<ThreadRecord>;
  };
  chat: {
    send: (input: ChatSendInput) => Promise<void>;
    stop: (input: ChatStopInput) => Promise<void>;
    retry: (input: ChatRetryInput) => Promise<void>;
    resolvePermission: (input: ResolvePermissionInput) => Promise<void>;
    subscribe: (listener: (event: ChatEvent) => void) => () => void;
    getModels: (threadId: string | null) => Promise<ModelDiscoveryResult>;
    refreshModels: (threadId: string | null) => Promise<ModelDiscoveryResult>;
  };
  git: {
    getStatus: (rootPath: string) => Promise<GitStatus>;
    listChangedFiles: (rootPath: string) => Promise<ChangedFileRecord[]>;
    commitAndPush: (input: CommitAndPushInput) => Promise<CommitAndPushResult>;
  };
  settings: {
    get: () => Promise<SettingsRecord>;
    update: (patch: Partial<SettingsRecord>) => Promise<SettingsRecord>;
  };
}
