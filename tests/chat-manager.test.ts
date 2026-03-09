import { describe, expect, it, vi } from "vitest";
import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import type { ThreadRecord } from "../src/shared/contracts";
import { ChatManager, modelDiscoveryFromSession } from "../src/main/chat-manager";

function makeThread(modelId: string): ThreadRecord {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    summary: "",
    modelId,
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z",
    lastMessageAt: null,
    status: "idle"
  };
}

describe("chat manager model discovery", () => {
  it("merges session and config model lists", () => {
    const session = {
      sessionId: "session-1",
      models: {
        currentModelId: "claude-sonnet-4.6",
        availableModels: [
          {
            modelId: "claude-sonnet-4.6",
            name: "Claude Sonnet 4.6"
          }
        ]
      },
      configOptions: [
        {
          type: "select",
          id: "model",
          currentValue: "claude-sonnet-4.6",
          options: [
            {
              name: "Claude Sonnet 4.6",
              value: "claude-sonnet-4.6"
            },
            {
              name: "GPT-5",
              value: "gpt-5"
            }
          ]
        }
      ]
    } as NewSessionResponse;

    const discovery = modelDiscoveryFromSession(session, null);

    expect(discovery?.currentModelId).toBe("claude-sonnet-4.6");
    expect(discovery?.models).toEqual([
      {
        modelId: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6"
      },
      {
        modelId: "gpt-5",
        name: "GPT-5"
      }
    ]);
  });

  it("overlays the thread model on cached discovery", async () => {
    const store = {
      getThread: vi.fn().mockResolvedValue(makeThread("gpt-5")),
      getSettings: vi.fn().mockResolvedValue({
        cliExecutablePath: null,
        selectedProjectId: null,
        defaultModelId: null,
        hiddenProjectIds: []
      })
    };
    const manager = new ChatManager(store as never, vi.fn());

    (manager as unknown as { modelCache: unknown }).modelCache = {
      models: [
        {
          modelId: "claude-sonnet-4.6",
          name: "Claude Sonnet 4.6"
        }
      ],
      currentModelId: "claude-sonnet-4.6",
      discoveredAt: "2026-03-08T10:00:00.000Z",
      source: "session"
    };

    const discovery = await manager.getModels("thread-1");

    expect(discovery.source).toBe("cache");
    expect(discovery.currentModelId).toBe("gpt-5");
    expect(discovery.models.map((model) => model.modelId)).toEqual(["claude-sonnet-4.6", "gpt-5"]);
  });

  it("overlays the saved default model when no thread is active", async () => {
    const store = {
      getThread: vi.fn().mockResolvedValue(null),
      getSettings: vi.fn().mockResolvedValue({
        cliExecutablePath: null,
        selectedProjectId: null,
        defaultModelId: "gpt-5.4",
        hiddenProjectIds: []
      })
    };
    const manager = new ChatManager(store as never, vi.fn());

    (manager as unknown as { modelCache: unknown }).modelCache = {
      models: [
        {
          modelId: "claude-sonnet-4.6",
          name: "Claude Sonnet 4.6"
        }
      ],
      currentModelId: "claude-sonnet-4.6",
      discoveredAt: "2026-03-08T10:00:00.000Z",
      source: "session"
    };

    const discovery = await manager.getModels(null);

    expect(discovery.currentModelId).toBe("gpt-5.4");
    expect(discovery.models.map((model) => model.modelId)).toEqual(["claude-sonnet-4.6", "gpt-5.4"]);
  });
});
