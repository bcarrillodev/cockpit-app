import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { app } from "electron";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ModelInfo,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
  type ToolCallContent,
  type ToolCallUpdate
} from "@agentclientprotocol/sdk";
import {
  type ChatEvent,
  type ChatSendInput,
  type CliHealth,
  type MessageKind,
  type MessageRecord,
  type ModelDiscoveryResult,
  type ModelRecord,
  type PermissionOptionRecord,
  type PermissionRequestRecord,
  type PlanEntryRecord,
  type ProjectRecord,
  type ThreadRecord,
  type ToolCallHistoryRecord,
  type ToolCallRecord
} from "../shared/contracts";
import { buildBootstrapPrompt } from "../shared/chat-bootstrap";
import { buildFallbackDiscovery, parseDiscoveredModels } from "../shared/models";
import { deriveThreadTitle, summarizeMessages } from "../shared/threads";
import { resolveCliExecutable } from "./system-service";
import { AppStore } from "./store";

type EmitFn = (event: ChatEvent) => void;

const ACP_START_TIMEOUT_MS = 8000;

type PendingPermission = {
  permission: PermissionRequestRecord;
  resolve: (response: RequestPermissionResponse) => void;
};

type Runtime = {
  threadId: string;
  projectId: string;
  modelId: string;
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  sessionId: string;
  assistantMessageId: string | null;
  assistantContent: string;
  thoughtMessageId: string | null;
  thoughtContent: string;
  toolCalls: Map<string, ToolCallHistoryRecord>;
  pendingPermissions: Map<string, PendingPermission>;
  ready: Promise<void>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function contentToText(content: ToolCallContent[] | undefined | null): string {
  if (!content?.length) {
    return "";
  }

  return content
    .map((item) => {
      if (item.type === "content") {
        return item.content.type === "text" ? item.content.text : `[${item.content.type}]`;
      }

      if (item.type === "terminal") {
        return `terminal:${item.terminalId}`;
      }

      return `diff:${item.path}`;
    })
    .join("\n");
}

function toToolCallRecord(toolCall: ToolCall | ToolCallUpdate, previous?: ToolCallRecord): ToolCallRecord {
  return {
    toolCallId: toolCall.toolCallId,
    title: toolCall.title ?? previous?.title ?? "Tool call",
    kind: toolCall.kind ?? previous?.kind ?? null,
    status: toolCall.status ?? previous?.status ?? null,
    content: contentToText(toolCall.content) || previous?.content || "",
    locations: toolCall.locations?.map((location) => location.path) ?? previous?.locations ?? []
  };
}

function toToolCallHistoryRecord(
  toolCall: ToolCall | ToolCallUpdate,
  timestamp: string,
  previous?: ToolCallHistoryRecord
): ToolCallHistoryRecord {
  const current = toToolCallRecord(toolCall, previous);
  return {
    ...current,
    firstSeenAt: previous?.firstSeenAt ?? timestamp,
    lastUpdatedAt: timestamp
  };
}

function stripToolCallHistory(toolCall: ToolCallHistoryRecord): ToolCallRecord {
  return {
    toolCallId: toolCall.toolCallId,
    title: toolCall.title,
    kind: toolCall.kind,
    status: toolCall.status,
    content: toolCall.content,
    locations: toolCall.locations
  };
}

function toPermissionOptions(options: RequestPermissionRequest["options"]): PermissionOptionRecord[] {
  return options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: option.kind
  }));
}

function isTextUpdate(update: SessionUpdate): update is SessionUpdate & {
  content: { type: "text"; text: string };
  messageId?: string | null;
} {
  return (
    (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") &&
    update.content.type === "text"
  );
}

function normalizeCliError(error: unknown, executablePath: string): CliHealth {
  const message = error instanceof Error ? error.message : "Copilot CLI failed.";

  return {
    installed: true,
    version: null,
    executablePath,
    state: /auth|required|login/i.test(message) ? "auth_required" : "error",
    error: message
  };
}

function mergeModels(...groups: ModelRecord[][]): ModelRecord[] {
  const merged = new Map<string, ModelRecord>();

  for (const group of groups) {
    for (const model of group) {
      if (!merged.has(model.modelId)) {
        merged.set(model.modelId, model);
      }
    }
  }

  return [...merged.values()];
}

function applyCurrentModel(
  discovery: ModelDiscoveryResult,
  currentModelId: string | null
): ModelDiscoveryResult {
  if (!currentModelId) {
    return discovery;
  }

  return {
    ...discovery,
    currentModelId,
    models: mergeModels(discovery.models, [{ modelId: currentModelId, name: currentModelId }])
  };
}

export function modelDiscoveryFromSession(
  session: NewSessionResponse,
  fallbackModelId: string | null
): ModelDiscoveryResult | null {
  const sessionModels = session.models?.availableModels?.map((model: ModelInfo) => ({
    modelId: model.modelId,
    name: model.name
  })) ?? [];

  const modelConfig = session.configOptions?.find((option) => option.type === "select" && option.id === "model");
  const configModels =
    modelConfig?.type === "select"
      ? modelConfig.options.flatMap((option) =>
          "value" in option
            ? [
                {
                  modelId: option.value,
                  name: option.name
                }
              ]
            : option.options.map((groupOption) => ({
                modelId: groupOption.value,
                name: groupOption.name
              }))
        )
      : [];

  const models = mergeModels(sessionModels, configModels);
  const currentModelId =
    session.models?.currentModelId ??
    (modelConfig?.type === "select" && typeof modelConfig.currentValue === "string"
      ? modelConfig.currentValue
      : fallbackModelId);

  if (!models.length && !currentModelId) {
    return null;
  }

  return {
    models,
    currentModelId,
    discoveredAt: nowIso(),
    source: "session",
    error: !models.length ? "Copilot CLI did not return any models." : undefined
  };
}

export class ChatManager {
  private store: AppStore;
  private emit: EmitFn;
  private runtimes = new Map<string, Runtime>();
  private modelCache: ModelDiscoveryResult | null = null;

  constructor(store: AppStore, emit: EmitFn) {
    this.store = store;
    this.emit = emit;
  }

  async send(input: ChatSendInput): Promise<void> {
    const thread = await this.requireThread(input.threadId);
    const project = await this.requireProject(thread.projectId);
    const existingMessages = await this.store.listMessages(thread.id);

    const userMessage: MessageRecord = {
      id: crypto.randomUUID(),
      threadId: thread.id,
      role: "user",
      content: input.content.trim(),
      createdAt: nowIso(),
      kind: "message"
    };

    await this.store.appendMessage(userMessage);
    this.emit({
      type: "message-created",
      threadId: thread.id,
      message: userMessage
    });

    const nextTitle =
      thread.title === "New thread" && !existingMessages.length ? deriveThreadTitle(input.content) : thread.title;
    await this.store.updateThread(thread.id, {
      title: nextTitle,
      status: "running",
      lastMessageAt: userMessage.createdAt
    });
    this.emit({
      type: "status-changed",
      threadId: thread.id,
      status: "running"
    });

    const runtime = await this.ensureRuntime(thread, project);
    runtime.assistantMessageId = null;
    runtime.assistantContent = "";
    runtime.thoughtMessageId = null;
    runtime.thoughtContent = "";

    try {
      const prompt = buildBootstrapPrompt(thread.summary, existingMessages, input.content.trim());
      const result = await runtime.connection.prompt({
        sessionId: runtime.sessionId,
        messageId: userMessage.id,
        prompt: [
          {
            type: "text",
            text: prompt
          }
        ]
      });

      const finalizedMessages: MessageRecord[] = [];

      if (runtime.thoughtContent.trim()) {
        finalizedMessages.push({
          id: runtime.thoughtMessageId ?? crypto.randomUUID(),
          threadId: thread.id,
          role: "assistant",
          content: runtime.thoughtContent.trim(),
          createdAt: nowIso(),
          kind: "thought"
        });
      }

      if (runtime.assistantContent.trim()) {
        finalizedMessages.push({
          id: runtime.assistantMessageId ?? crypto.randomUUID(),
          threadId: thread.id,
          role: "assistant",
          content: runtime.assistantContent.trim(),
          createdAt: nowIso(),
          kind: "message",
          metadata: {
            stopReason: result.stopReason
          }
        });
      }

      for (const message of finalizedMessages) {
        await this.store.appendMessage(message);
        this.emit({
          type: "message-created",
          threadId: thread.id,
          message
        });
      }

      const nextSummary = summarizeMessages([...existingMessages, userMessage, ...finalizedMessages]);
      await this.store.updateThread(thread.id, {
        summary: nextSummary,
        status: "idle",
        lastMessageAt: finalizedMessages.at(-1)?.createdAt ?? userMessage.createdAt
      });

      this.emit({
        type: "status-changed",
        threadId: thread.id,
        status: "idle"
      });
    } catch (error) {
      const errorMessage: MessageRecord = {
        id: crypto.randomUUID(),
        threadId: thread.id,
        role: "system",
        content: error instanceof Error ? error.message : "Copilot CLI request failed.",
        createdAt: nowIso(),
        kind: "error"
      };

      await this.store.appendMessage(errorMessage);
      await this.store.updateThread(thread.id, {
        status: "error",
        lastMessageAt: errorMessage.createdAt
      });

      this.emit({
        type: "message-created",
        threadId: thread.id,
        message: errorMessage
      });
      this.emit({
        type: "status-changed",
        threadId: thread.id,
        status: "error",
        error: errorMessage.content
      });

      const settings = await this.store.getSettings();
      await this.store.setCliHealth(normalizeCliError(error, resolveCliExecutable(settings)));
      throw error;
    }
  }

  async stop(threadId: string): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      return;
    }

    await runtime.connection.cancel({
      sessionId: runtime.sessionId
    });
  }

  async retry(threadId: string): Promise<void> {
    const messages = await this.store.listMessages(threadId);
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUserMessage) {
      throw new Error("Nothing to retry in this thread.");
    }

    await this.send({
      threadId,
      content: lastUserMessage.content
    });
  }

  async resolvePermission(threadId: string, permissionId: string, optionId?: string): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      throw new Error("Permission request is no longer active.");
    }

    const pending = runtime.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new Error("Permission request is no longer active.");
    }

    const nextPermission: PermissionRequestRecord = {
      ...pending.permission,
      status: optionId ? "resolved" : "cancelled",
      selectedOptionId: optionId ?? null,
      updatedAt: nowIso()
    };
    await this.store.upsertPermission(nextPermission);

    pending.resolve({
      outcome: optionId
        ? {
            outcome: "selected",
            optionId
          }
        : {
            outcome: "cancelled"
          }
    });

    runtime.pendingPermissions.delete(permissionId);
    this.emit({
      type: "permission-resolved",
      threadId,
      permission: nextPermission
    });
  }

  async getModels(threadId: string | null): Promise<ModelDiscoveryResult> {
    const thread = threadId ? await this.store.getThread(threadId) : null;
    const settings = await this.store.getSettings();
    const currentModelId = thread?.modelId?.trim() || settings.defaultModelId?.trim() || null;

    if (this.modelCache) {
      return applyCurrentModel(
        {
          ...this.modelCache,
          source: "cache"
        },
        currentModelId ?? this.modelCache.currentModelId
      );
    }

    const discovery = await this.refreshModels(threadId);
    return applyCurrentModel(discovery, currentModelId ?? discovery.currentModelId);
  }

  async refreshModels(threadId: string | null): Promise<ModelDiscoveryResult> {
    const thread = threadId ? await this.store.getThread(threadId) : null;
    const project = thread ? await this.requireProject(thread.projectId) : await this.getSelectedProject();
    const settings = await this.store.getSettings();
    const executable = resolveCliExecutable(settings);
    const currentModelId = thread?.modelId?.trim() || settings.defaultModelId?.trim() || null;

    if (!project) {
      const fallback = buildFallbackDiscovery(currentModelId, "Add a project to discover models.");
      this.modelCache = fallback;
      this.emit({
        type: "models-updated",
        threadId,
        discovery: fallback
      });
      return fallback;
    }

    try {
      const outputChunks: string[] = [];
      const client: Client = {
        async requestPermission() {
          return {
            outcome: { outcome: "cancelled" }
          };
        },
        async sessionUpdate(params: SessionNotification) {
          const update = params.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            outputChunks.push(update.content.text);
          }
        }
      };

      const { child, connection, session } = await this.startCliSession(
        executable,
        project.rootPath,
        [],
        client
      );

      const sessionDiscovery = modelDiscoveryFromSession(session, currentModelId);
      if (sessionDiscovery?.models.length) {
        const discovery = applyCurrentModel(sessionDiscovery, currentModelId ?? sessionDiscovery.currentModelId);
        this.modelCache = discovery;
        this.emit({
          type: "models-updated",
          threadId,
          discovery
        });
        child.kill();
        return discovery;
      }

      await connection.prompt({
        sessionId: session.sessionId,
        prompt: [
          {
            type: "text",
            text: "/models"
          }
        ]
      });

      const parsed = parseDiscoveredModels(outputChunks.join(""));
      const models = parsed.length ? parsed : sessionDiscovery?.models ?? [];
      const discovery = applyCurrentModel(
        {
          models,
          currentModelId: sessionDiscovery?.currentModelId ?? currentModelId,
          discoveredAt: sessionDiscovery?.discoveredAt ?? nowIso(),
          source: parsed.length ? "prompt" : sessionDiscovery?.source ?? "fallback",
          error: !models.length ? "Copilot CLI did not return any models." : undefined
        },
        currentModelId ?? sessionDiscovery?.currentModelId ?? null
      );

      this.modelCache = discovery;
      this.emit({
        type: "models-updated",
        threadId,
        discovery
      });

      child.kill();
      return discovery;
    } catch (error) {
      const fallback = applyCurrentModel(
        buildFallbackDiscovery(currentModelId, error instanceof Error ? error.message : "Model discovery failed."),
        currentModelId
      );
      this.modelCache = fallback;
      this.emit({
        type: "models-updated",
        threadId,
        discovery: fallback
      });
      return fallback;
    }
  }

  async prepareThread(threadId: string): Promise<ThreadRecord> {
    const thread = await this.requireThread(threadId);
    return this.normalizeThreadModel(thread);
  }

  async restartThreadRuntime(threadId: string): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      return;
    }

    runtime.child.kill();
    this.runtimes.delete(threadId);
  }

  private async ensureRuntime(thread: ThreadRecord, project: ProjectRecord): Promise<Runtime> {
    const preparedThread = await this.normalizeThreadModel(thread);
    const existing = this.runtimes.get(preparedThread.id);
    if (existing && existing.modelId === preparedThread.modelId && existing.projectId === preparedThread.projectId) {
      await existing.ready;
      return existing;
    }

    if (existing) {
      existing.child.kill();
      this.runtimes.delete(preparedThread.id);
    }

    const settings = await this.store.getSettings();
    const executable = resolveCliExecutable(settings);

    const runtime: Runtime = {
      threadId: preparedThread.id,
      projectId: project.id,
      modelId: preparedThread.modelId,
      child: null as never,
      connection: null as never,
      sessionId: "",
      assistantMessageId: null,
      assistantContent: "",
      thoughtMessageId: null,
      thoughtContent: "",
      toolCalls: new Map((await this.store.listToolCalls(preparedThread.id)).map((toolCall) => [toolCall.toolCallId, toolCall])),
      pendingPermissions: new Map(),
      ready: Promise.resolve()
    };

    const client: Client = {
      requestPermission: (params) => this.handlePermissionRequest(preparedThread.id, runtime, params),
      sessionUpdate: (params) => this.handleSessionUpdate(preparedThread.id, runtime, params)
    };

    runtime.ready = (async () => {
      const { child, connection, session } = await this.startCliSession(
        executable,
        project.rootPath,
        preparedThread.modelId ? ["--model", preparedThread.modelId] : [],
        client
      );
      runtime.child = child;
      runtime.connection = connection;
      runtime.sessionId = session.sessionId;

      const sessionDiscovery = modelDiscoveryFromSession(session, preparedThread.modelId);
      if (sessionDiscovery?.models.length) {
        this.modelCache = sessionDiscovery;
      }
      child.on("exit", () => {
        this.runtimes.delete(preparedThread.id);
      });
    })();

    this.runtimes.set(preparedThread.id, runtime);
    await runtime.ready;
    return runtime;
  }

  private async normalizeThreadModel(thread: ThreadRecord): Promise<ThreadRecord> {
    const requestedModelId = thread.modelId.trim();
    const discovery = await this.getModels(thread.id);
    const availableModelIds = new Set(discovery.models.map((model) => model.modelId));
    const fallbackModelId = discovery.currentModelId ?? discovery.models[0]?.modelId ?? "";
    const requiresUpdate =
      (!requestedModelId && Boolean(fallbackModelId)) ||
      (requestedModelId && availableModelIds.size > 0 && !availableModelIds.has(requestedModelId));

    if (!requiresUpdate) {
      return thread;
    }

    const updatedThread = await this.store.updateThread(thread.id, {
      modelId: fallbackModelId
    });

    this.emit({
      type: "models-updated",
      threadId: thread.id,
      discovery: {
        ...discovery,
        currentModelId: fallbackModelId
      }
    });

    return updatedThread;
  }

  private async startCliSession(
    executable: string,
    cwd: string,
    args: string[],
    client: Client
  ): Promise<{
    child: ChildProcessWithoutNullStreams;
    connection: ClientSideConnection;
    session: NewSessionResponse;
  }> {
    const child = spawn(executable, ["--acp", "--stdio", ...args], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const connection = new ClientSideConnection(
      () => client,
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      )
    );

    try {
      await this.awaitAcpStartup(
        child,
        () => stderr,
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: {
            name: "Cockpit",
            version: app.getVersion()
          }
        }),
        "initialization"
      );

      const session = await this.awaitAcpStartup(
        child,
        () => stderr,
        connection.newSession({
          cwd,
          mcpServers: []
        }),
        "session startup"
      );

      return {
        child,
        connection,
        session
      };
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private async awaitAcpStartup<T>(
    child: ChildProcessWithoutNullStreams,
    getStderr: () => string,
    operation: Promise<T>,
    phase: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(this.formatCliStartupError(`Timed out during ACP ${phase}.`, getStderr())));
      }, ACP_START_TIMEOUT_MS);

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            this.formatCliStartupError(
              `Copilot CLI exited during ACP ${phase}${code !== null ? ` with code ${code}` : signal ? ` (${signal})` : ""}.`,
              getStderr()
            )
          )
        );
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new Error(this.formatCliStartupError(error.message, getStderr())));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        child.off("exit", onExit);
        child.off("error", onError);
      };

      child.on("exit", onExit);
      child.on("error", onError);

      operation
        .then((result) => {
          cleanup();
          resolve(result);
        })
        .catch((error) => {
          cleanup();
          reject(
            new Error(
              this.formatCliStartupError(error instanceof Error ? error.message : String(error), getStderr())
            )
          );
        });
    });
  }

  private formatCliStartupError(message: string, stderr: string): string {
    const normalizedStderr = stderr.trim();
    return normalizedStderr ? `${message}\n${normalizedStderr}` : message;
  }

  private async handlePermissionRequest(
    threadId: string,
    runtime: Runtime,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const permission: PermissionRequestRecord = {
      id: crypto.randomUUID(),
      threadId,
      kind: params.toolCall.kind ?? "tool",
      prompt: params.toolCall.title ?? "Approve tool request",
      options: toPermissionOptions(params.options),
      toolCallId: params.toolCall.toolCallId,
      status: "pending",
      selectedOptionId: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    await this.store.upsertPermission(permission);
    this.emit({
      type: "permission-requested",
      threadId,
      permission
    });

    return await new Promise<RequestPermissionResponse>((resolve) => {
      runtime.pendingPermissions.set(permission.id, {
        permission,
        resolve
      });
    });
  }

  private async handleSessionUpdate(
    threadId: string,
    runtime: Runtime,
    params: SessionNotification
  ): Promise<void> {
    const update = params.update;

    if (isTextUpdate(update)) {
      if (update.sessionUpdate === "agent_message_chunk") {
        runtime.assistantMessageId = update.messageId ?? runtime.assistantMessageId ?? crypto.randomUUID();
        runtime.assistantContent += update.content.text;
        this.emit({
          type: "assistant-delta",
          threadId,
          messageId: runtime.assistantMessageId,
          content: runtime.assistantContent,
          kind: "message"
        });
        return;
      }

      runtime.thoughtMessageId = update.messageId ?? runtime.thoughtMessageId ?? crypto.randomUUID();
      runtime.thoughtContent += update.content.text;
      this.emit({
        type: "assistant-delta",
        threadId,
        messageId: runtime.thoughtMessageId,
        content: runtime.thoughtContent,
        kind: "thought"
      });
      return;
    }

    switch (update.sessionUpdate) {
      case "tool_call": {
        const toolCall = toToolCallHistoryRecord(update, nowIso(), runtime.toolCalls.get(update.toolCallId));
        runtime.toolCalls.set(toolCall.toolCallId, toolCall);
        await this.store.upsertToolCall(threadId, toolCall);
        this.emit({
          type: "tool-updated",
          threadId,
          toolCall: stripToolCallHistory(toolCall)
        });
        break;
      }
      case "tool_call_update": {
        const previous = runtime.toolCalls.get(update.toolCallId);
        const toolCall = toToolCallHistoryRecord(update, nowIso(), previous);
        runtime.toolCalls.set(toolCall.toolCallId, toolCall);
        await this.store.upsertToolCall(threadId, toolCall);
        this.emit({
          type: "tool-updated",
          threadId,
          toolCall: stripToolCallHistory(toolCall)
        });
        break;
      }
      case "plan": {
        const plan: PlanEntryRecord[] = update.entries.map((entry) => ({
          content: entry.content,
          priority: entry.priority,
          status: entry.status
        }));
        this.emit({
          type: "plan-updated",
          threadId,
          plan
        });
        break;
      }
      case "session_info_update": {
        if (update.title) {
          await this.store.updateThread(threadId, {
            title: update.title
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private async requireThread(threadId: string): Promise<ThreadRecord> {
    const thread = await this.store.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return thread;
  }

  private async requireProject(projectId: string): Promise<ProjectRecord> {
    const project = (await this.store.getProjects()).find((entry) => entry.id === projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
  }

  private async getSelectedProject(): Promise<ProjectRecord | null> {
    const settings = await this.store.getSettings();
    if (!settings.selectedProjectId) {
      return null;
    }

    return (await this.store.getProjects()).find((entry) => entry.id === settings.selectedProjectId) ?? null;
  }
}
