import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { app } from "electron";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ModelInfo,
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
  type PermissionOptionRecord,
  type PermissionRequestRecord,
  type PlanEntryRecord,
  type ProjectRecord,
  type ThreadRecord,
  type ToolCallRecord
} from "../shared/contracts";
import { buildBootstrapPrompt } from "../shared/chat-bootstrap";
import { buildFallbackDiscovery, parseDiscoveredModels } from "../shared/models";
import { deriveThreadTitle, summarizeMessages } from "../shared/threads";
import { resolveCliExecutable } from "./system-service";
import { AppStore } from "./store";

type EmitFn = (event: ChatEvent) => void;

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
  toolCalls: Map<string, ToolCallRecord>;
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
    if (this.modelCache) {
      return {
        ...this.modelCache,
        source: "cache"
      };
    }

    return this.refreshModels(threadId);
  }

  async refreshModels(threadId: string | null): Promise<ModelDiscoveryResult> {
    const thread = threadId ? await this.store.getThread(threadId) : null;
    const project = thread ? await this.requireProject(thread.projectId) : await this.getSelectedProject();
    const settings = await this.store.getSettings();
    const executable = resolveCliExecutable(settings);
    const currentModelId = thread?.modelId ?? null;

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

    let child: ChildProcessWithoutNullStreams | null = null;

    try {
      child = spawn(executable, ["--acp", "--stdio"], {
        cwd: project.rootPath,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });

      const outputChunks: string[] = [];
      const client: Client = {
        async requestPermission() {
          return {
            outcome: { outcome: "cancelled" }
          };
        },
        async sessionUpdate(params: SessionNotification) {
          const update = params.update;
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text"
          ) {
            outputChunks.push(update.content.text);
          }
        }
      };

      const connection = new ClientSideConnection(
        () => client,
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
        )
      );

      const initResponse = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: "Cockpit",
          version: app.getVersion()
        }
      });
      const sessionResponse = await connection.newSession({
        cwd: project.rootPath,
        mcpServers: []
      });

      await connection.prompt({
        sessionId: sessionResponse.sessionId,
        prompt: [
          {
            type: "text",
            text: "/models"
          }
        ]
      });

      const parsed = parseDiscoveredModels(outputChunks.join(""));
      const sessionModels = sessionResponse.models?.availableModels?.map((model: ModelInfo) => ({
        modelId: model.modelId,
        name: model.name
      }));

      const models = parsed.length ? parsed : sessionModels ?? [];
      const discovery: ModelDiscoveryResult = {
        models,
        currentModelId: sessionResponse.models?.currentModelId ?? currentModelId,
        discoveredAt: nowIso(),
        source: parsed.length ? "prompt" : sessionModels?.length ? "session" : "fallback",
        error: !models.length ? "Copilot CLI did not return any models." : undefined
      };

      this.modelCache = discovery;
      this.emit({
        type: "models-updated",
        threadId,
        discovery
      });

      if (initResponse.agentCapabilities?.sessionCapabilities && child) {
        child.kill();
      }

      return discovery;
    } catch (error) {
      const fallback = buildFallbackDiscovery(
        currentModelId,
        error instanceof Error ? error.message : "Model discovery failed."
      );
      this.modelCache = fallback;
      this.emit({
        type: "models-updated",
        threadId,
        discovery: fallback
      });
      return fallback;
    } finally {
      child?.kill();
    }
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
    const existing = this.runtimes.get(thread.id);
    if (existing && existing.modelId === thread.modelId && existing.projectId === thread.projectId) {
      await existing.ready;
      return existing;
    }

    if (existing) {
      existing.child.kill();
      this.runtimes.delete(thread.id);
    }

    const settings = await this.store.getSettings();
    const executable = resolveCliExecutable(settings);

    const child = spawn(
      executable,
      ["--acp", "--stdio", ...(thread.modelId ? ["--model", thread.modelId] : [])],
      {
        cwd: project.rootPath,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    const runtime: Runtime = {
      threadId: thread.id,
      projectId: project.id,
      modelId: thread.modelId,
      child,
      connection: null as never,
      sessionId: "",
      assistantMessageId: null,
      assistantContent: "",
      thoughtMessageId: null,
      thoughtContent: "",
      toolCalls: new Map(),
      pendingPermissions: new Map(),
      ready: Promise.resolve()
    };

    const client: Client = {
      requestPermission: (params) => this.handlePermissionRequest(thread.id, runtime, params),
      sessionUpdate: (params) => this.handleSessionUpdate(thread.id, runtime, params)
    };

    runtime.connection = new ClientSideConnection(
      () => client,
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      )
    );

    runtime.ready = (async () => {
      await runtime.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: "Cockpit",
          version: app.getVersion()
        }
      });

      const session = await runtime.connection.newSession({
        cwd: project.rootPath,
        mcpServers: []
      });
      runtime.sessionId = session.sessionId;

      if (session.models?.availableModels?.length) {
        this.modelCache = {
          models: session.models.availableModels.map((model) => ({
            modelId: model.modelId,
            name: model.name
          })),
          currentModelId: session.models.currentModelId,
          discoveredAt: nowIso(),
          source: "session"
        };
      }
    })();

    child.on("exit", () => {
      this.runtimes.delete(thread.id);
    });

    this.runtimes.set(thread.id, runtime);
    await runtime.ready;
    return runtime;
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
        const toolCall = toToolCallRecord(update);
        runtime.toolCalls.set(toolCall.toolCallId, toolCall);
        this.emit({
          type: "tool-updated",
          threadId,
          toolCall
        });
        break;
      }
      case "tool_call_update": {
        const previous = runtime.toolCalls.get(update.toolCallId);
        const toolCall = toToolCallRecord(update, previous);
        runtime.toolCalls.set(toolCall.toolCallId, toolCall);
        this.emit({
          type: "tool-updated",
          threadId,
          toolCall
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
