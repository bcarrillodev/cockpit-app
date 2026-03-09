import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { ChatEvent, ProjectRecord, ThreadOpenPayload, ThreadRecord } from "../src/shared/contracts";
import { useCockpitStore } from "../src/renderer/stores/cockpit";

function makeProject(id: string, name: string, rootPath = `/tmp/${name}`): ProjectRecord {
  return {
    id,
    name,
    rootPath,
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z",
    lastOpenedAt: "2026-03-08T10:00:00.000Z"
  };
}

function makeThread(
  id: string,
  projectId: string,
  createdAt: string,
  lastMessageAt: string | null = null
): ThreadRecord {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    summary: "",
    modelId: "gpt-5",
    createdAt,
    updatedAt: createdAt,
    lastMessageAt,
    status: "idle"
  };
}

function openPayload(thread: ThreadRecord): ThreadOpenPayload {
  return {
    thread,
    messages: [],
    permissions: []
  };
}

function installCockpitApi(overrides: Partial<typeof window.cockpit> = {}): void {
  const cockpit = {
    system: {
      getCliHealth: vi.fn().mockResolvedValue({
        installed: true,
        version: "1.0.0",
        executablePath: "/usr/local/bin/copilot",
        state: "ready",
        error: null
      }),
      pickProjectDirectory: vi.fn().mockResolvedValue(null),
      openProjectPath: vi.fn().mockResolvedValue(undefined)
    },
    projects: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue(null)
    },
    threads: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      open: vi.fn(),
      updateModel: vi.fn()
    },
    chat: {
      send: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      resolvePermission: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => undefined),
      getModels: vi.fn().mockResolvedValue({
        models: [],
        currentModelId: null,
        discoveredAt: "2026-03-08T00:00:00.000Z",
        source: "fallback"
      }),
      refreshModels: vi.fn().mockResolvedValue({
        models: [],
        currentModelId: null,
        discoveredAt: "2026-03-08T00:00:00.000Z",
        source: "fallback"
      })
    },
    git: {
      getStatus: vi.fn().mockResolvedValue({
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        changedCount: 0,
        untrackedCount: 0,
        isClean: true
      }),
      listChangedFiles: vi.fn().mockResolvedValue([]),
      commitAndPush: vi.fn()
    },
    settings: {
      get: vi.fn().mockResolvedValue({
        cliExecutablePath: null,
        selectedProjectId: null,
        defaultModelId: null,
        hiddenProjectIds: []
      }),
      update: vi.fn()
    },
    ...overrides
  };

  Object.defineProperty(globalThis, "window", {
    value: { cockpit },
    configurable: true,
    writable: true
  });
}

describe("cockpit renderer store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a project first when starting a thread without a selection", async () => {
    const project = makeProject("project-1", "repo");
    const thread = makeThread("thread-1", project.id, "2026-03-08T10:01:00.000Z");

    installCockpitApi({
      system: {
        getCliHealth: vi.fn().mockResolvedValue({
          installed: true,
          version: "1.0.0",
          executablePath: "/usr/local/bin/copilot",
          state: "ready",
          error: null
        }),
        pickProjectDirectory: vi.fn().mockResolvedValue(project.rootPath),
        openProjectPath: vi.fn().mockResolvedValue(undefined)
      },
      projects: {
        list: vi.fn().mockResolvedValue([project]),
        create: vi.fn().mockResolvedValue(project),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(project)
      },
      threads: {
        list: vi.fn().mockResolvedValue([thread]),
        create: vi.fn().mockResolvedValue(thread),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(openPayload(thread)),
        updateModel: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.createThread();

    expect(window.cockpit.system.pickProjectDirectory).toHaveBeenCalledTimes(1);
    expect(window.cockpit.projects.create).toHaveBeenCalledWith(project.rootPath);
    expect(window.cockpit.threads.create).toHaveBeenCalledWith(project.id, undefined);
    expect(store.selectedProjectId).toBe(project.id);
    expect(store.activeThreadId).toBe(thread.id);
    expect(store.errorMessage).toBeNull();
  });

  it("surfaces add project failures in the store error state", async () => {
    installCockpitApi({
      system: {
        getCliHealth: vi.fn().mockResolvedValue({
          installed: true,
          version: "1.0.0",
          executablePath: "/usr/local/bin/copilot",
          state: "ready",
          error: null
        }),
        pickProjectDirectory: vi.fn().mockResolvedValue("/tmp/repo"),
        openProjectPath: vi.fn().mockResolvedValue(undefined)
      },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockRejectedValue(new Error("Permission denied")),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(null)
      }
    });

    const store = useCockpitStore();

    await store.addProject();

    expect(store.errorMessage).toBe("Permission denied");
  });

  it("bootstraps with all threads and opens the newest thread from the selected project", async () => {
    const projectA = makeProject("project-a", "alpha");
    const projectB = makeProject("project-b", "beta");
    const threadA = makeThread("thread-a", projectA.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:07:00.000Z");
    const threadB = makeThread("thread-b", projectB.id, "2026-03-08T10:03:00.000Z", "2026-03-08T10:08:00.000Z");

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([projectA, projectB]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(projectA)
      },
      threads: {
        list: vi.fn().mockResolvedValue([threadB, threadA]),
        create: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(openPayload(threadA)),
        updateModel: vi.fn()
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          cliExecutablePath: null,
          selectedProjectId: projectA.id,
          defaultModelId: null,
          hiddenProjectIds: []
        }),
        update: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.bootstrap();

    expect(window.cockpit.threads.list).toHaveBeenCalledWith(undefined);
    expect(window.cockpit.projects.select).toHaveBeenCalledWith(projectA.id);
    expect(window.cockpit.threads.open).toHaveBeenCalledWith(threadA.id);
    expect(store.selectedProjectId).toBe(projectA.id);
    expect(store.activeThreadId).toBe(threadA.id);
    expect(store.threads.map((thread) => thread.id)).toEqual([threadB.id, threadA.id]);
  });

  it("syncs project context and git state when opening a thread from another project", async () => {
    const projectA = makeProject("project-a", "alpha");
    const projectB = makeProject("project-b", "beta");
    const threadA = makeThread("thread-a", projectA.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:07:00.000Z");
    const threadB = makeThread("thread-b", projectB.id, "2026-03-08T10:03:00.000Z", "2026-03-08T10:08:00.000Z");

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([projectA, projectB]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(projectA)
      },
      threads: {
        list: vi.fn().mockResolvedValue([threadB, threadA]),
        create: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn()
          .mockResolvedValueOnce(openPayload(threadA))
          .mockResolvedValueOnce(openPayload(threadB)),
        updateModel: vi.fn()
      },
      git: {
        getStatus: vi.fn().mockResolvedValue({
          branch: "main",
          upstream: "origin/main",
          ahead: 0,
          behind: 0,
          changedCount: 0,
          untrackedCount: 0,
          isClean: true
        }),
        listChangedFiles: vi.fn().mockResolvedValue([]),
        commitAndPush: vi.fn()
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          cliExecutablePath: null,
          selectedProjectId: projectA.id,
          defaultModelId: null,
          hiddenProjectIds: []
        }),
        update: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.bootstrap();
    await store.openThread(threadB.id);

    expect(window.cockpit.projects.select).toHaveBeenLastCalledWith(projectB.id);
    expect(window.cockpit.git.getStatus).toHaveBeenLastCalledWith(projectB.rootPath);
    expect(store.selectedProjectId).toBe(projectB.id);
    expect(store.activeThreadId).toBe(threadB.id);
  });

  it("creates a thread inside the requested project group", async () => {
    const projectA = makeProject("project-a", "alpha");
    const projectB = makeProject("project-b", "beta");
    const threadA = makeThread("thread-a", projectA.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:07:00.000Z");
    const newThreadB = makeThread("thread-b-new", projectB.id, "2026-03-08T10:09:00.000Z");

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([projectA, projectB]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(projectA)
      },
      threads: {
        list: vi.fn().mockResolvedValue([threadA]),
        create: vi.fn().mockResolvedValue(newThreadB),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn()
          .mockResolvedValueOnce(openPayload(threadA))
          .mockResolvedValueOnce(openPayload(newThreadB)),
        updateModel: vi.fn()
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          cliExecutablePath: null,
          selectedProjectId: projectA.id,
          defaultModelId: null,
          hiddenProjectIds: []
        }),
        update: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.bootstrap();
    await store.createThread(projectB.id);

    expect(window.cockpit.threads.create).toHaveBeenCalledWith(projectB.id, undefined);
    expect(window.cockpit.projects.select).toHaveBeenLastCalledWith(projectB.id);
    expect(store.selectedProjectId).toBe(projectB.id);
    expect(store.activeThreadId).toBe(newThreadB.id);
  });

  it("deletes the active thread and falls back to the next thread in the same project", async () => {
    const projectA = makeProject("project-a", "alpha");
    const projectB = makeProject("project-b", "beta");
    const activeThread = makeThread("thread-a-1", projectA.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:09:00.000Z");
    const fallbackThread = makeThread("thread-a-2", projectA.id, "2026-03-08T10:01:00.000Z", "2026-03-08T10:08:00.000Z");
    const otherProjectThread = makeThread("thread-b-1", projectB.id, "2026-03-08T10:03:00.000Z", "2026-03-08T10:07:00.000Z");

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([projectA, projectB]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(projectA)
      },
      threads: {
        list: vi.fn().mockResolvedValue([activeThread, fallbackThread, otherProjectThread]),
        create: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn()
          .mockResolvedValueOnce(openPayload(activeThread))
          .mockResolvedValueOnce(openPayload(fallbackThread)),
        updateModel: vi.fn()
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          cliExecutablePath: null,
          selectedProjectId: projectA.id,
          defaultModelId: null,
          hiddenProjectIds: []
        }),
        update: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.bootstrap();
    await store.deleteThread(activeThread.id);

    expect(window.cockpit.threads.delete).toHaveBeenCalledWith(activeThread.id);
    expect(store.threads.map((thread) => thread.id)).toEqual([fallbackThread.id, otherProjectThread.id]);
    expect(store.selectedProjectId).toBe(projectA.id);
    expect(store.activeThreadId).toBe(fallbackThread.id);
  });

  it("removes a project from Cockpit and falls back to another project", async () => {
    const projectA = makeProject("project-a", "alpha");
    const projectB = makeProject("project-b", "beta");
    const threadA = makeThread("thread-a", projectA.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:09:00.000Z");
    const threadB = makeThread("thread-b", projectB.id, "2026-03-08T10:03:00.000Z", "2026-03-08T10:08:00.000Z");
    let currentProjects = [projectA, projectB];
    let currentThreads = [threadA, threadB];
    let currentSettings = {
      cliExecutablePath: null,
      selectedProjectId: projectA.id,
      defaultModelId: null,
      hiddenProjectIds: []
    };
    const listProjects = vi.fn().mockImplementation(async () => currentProjects);
    const listThreads = vi.fn().mockImplementation(async () => currentThreads);
    const getSettings = vi.fn().mockImplementation(async () => currentSettings);
    const removeProject = vi.fn().mockImplementation(async (projectId: string) => {
      currentProjects = currentProjects.filter((project) => project.id !== projectId);
      currentThreads = currentThreads.filter((thread) => thread.projectId !== projectId);
      currentSettings = {
        ...currentSettings,
        selectedProjectId: projectB.id
      };
    });

    installCockpitApi({
      projects: {
        list: listProjects,
        create: vi.fn(),
        remove: removeProject,
        select: vi.fn()
          .mockResolvedValueOnce(projectA)
          .mockResolvedValueOnce(projectB)
      },
      threads: {
        list: listThreads,
        create: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn()
          .mockResolvedValueOnce(openPayload(threadA))
          .mockResolvedValueOnce(openPayload(threadB)),
        updateModel: vi.fn()
      },
      settings: {
        get: getSettings,
        update: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.bootstrap();
    await store.removeProject(projectA.id);

    expect(window.cockpit.projects.remove).toHaveBeenCalledWith(projectA.id);
    expect(store.projectThreadGroups.map((group) => group.project.id)).toEqual([projectB.id]);
    expect(store.threads.map((thread) => thread.id)).toEqual([threadB.id]);
    expect(store.selectedProjectId).toBe(projectB.id);
    expect(store.activeThreadId).toBe(threadB.id);
  });

  it("clears the active thread when deleting the last thread in the selected project", async () => {
    const project = makeProject("project-a", "alpha");
    const thread = makeThread("thread-a-1", project.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:09:00.000Z");
    const getModels = vi.fn().mockResolvedValue({
      models: [],
      currentModelId: null,
      discoveredAt: "2026-03-08T00:00:00.000Z",
      source: "fallback"
    });

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([project]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(project)
      },
      threads: {
        list: vi.fn().mockResolvedValue([thread]),
        create: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(openPayload(thread)),
        updateModel: vi.fn()
      },
      chat: {
        send: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        retry: vi.fn().mockResolvedValue(undefined),
        resolvePermission: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => undefined),
        getModels,
        refreshModels: vi.fn().mockResolvedValue({
          models: [],
          currentModelId: null,
          discoveredAt: "2026-03-08T00:00:00.000Z",
          source: "fallback"
        })
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          cliExecutablePath: null,
          selectedProjectId: project.id,
          defaultModelId: null,
          hiddenProjectIds: []
        }),
        update: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.bootstrap();
    await store.deleteThread(thread.id);

    expect(store.selectedProjectId).toBe(project.id);
    expect(store.activeThreadId).toBeNull();
    expect(getModels).toHaveBeenLastCalledWith(null);
  });

  it("creates a thread before applying a model when no thread is active", async () => {
    const project = makeProject("project-a", "alpha");
    const createdThread = makeThread("thread-a-1", project.id, "2026-03-08T10:02:00.000Z");
    const createdThreadWithModel = {
      ...createdThread,
      modelId: "gpt-5.4"
    };
    const getModels = vi.fn()
      .mockResolvedValueOnce({
        models: [
          { modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { modelId: "gpt-5.4", name: "GPT-5.4" }
        ],
        currentModelId: "claude-sonnet-4.6",
        discoveredAt: "2026-03-08T00:00:00.000Z",
        source: "session"
      })
      .mockResolvedValueOnce({
        models: [
          { modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { modelId: "gpt-5.4", name: "GPT-5.4" }
        ],
        currentModelId: "gpt-5.4",
        discoveredAt: "2026-03-08T00:00:00.000Z",
        source: "cache"
      });

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([project]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(project)
      },
      threads: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(createdThreadWithModel),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(openPayload(createdThreadWithModel)),
        updateModel: vi.fn()
      },
      chat: {
        send: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        retry: vi.fn().mockResolvedValue(undefined),
        resolvePermission: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => undefined),
        getModels,
        refreshModels: vi.fn().mockResolvedValue({
          models: [
            { modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
            { modelId: "gpt-5.4", name: "GPT-5.4" }
          ],
          currentModelId: "claude-sonnet-4.6",
          discoveredAt: "2026-03-08T00:00:00.000Z",
          source: "session"
        })
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          cliExecutablePath: null,
          selectedProjectId: project.id,
          defaultModelId: null,
          hiddenProjectIds: []
        }),
        update: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.bootstrap();
    await store.updateThreadModel("gpt-5.4");

    expect(window.cockpit.threads.create).toHaveBeenCalledWith(project.id, "gpt-5.4");
    expect(window.cockpit.threads.updateModel).not.toHaveBeenCalled();
    expect(store.activeThreadId).toBe(createdThread.id);
    expect(store.activeThread?.modelId).toBe("gpt-5.4");
    expect(store.settings.defaultModelId).toBe("gpt-5.4");
  });

  it("creates a thread before sending the first prompt when no thread is active", async () => {
    const project = makeProject("project-a", "alpha");
    const createdThread = makeThread("thread-a-1", project.id, "2026-03-08T10:02:00.000Z");

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([project]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(project)
      },
      threads: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(createdThread),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(openPayload(createdThread)),
        updateModel: vi.fn()
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          cliExecutablePath: null,
          selectedProjectId: project.id,
          defaultModelId: null,
          hiddenProjectIds: []
        }),
        update: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.bootstrap();
    await store.sendPrompt("Write a changelog");

    expect(window.cockpit.threads.create).toHaveBeenCalledWith(project.id, undefined);
    expect(window.cockpit.chat.send).toHaveBeenCalledWith({
      threadId: createdThread.id,
      content: "Write a changelog"
    });
    expect(store.activeThreadId).toBe(createdThread.id);
  });

  it("builds a single transcript timeline with tool calls in first-seen order", async () => {
    vi.useFakeTimers();
    const project = makeProject("project-a", "alpha");
    const thread = makeThread("thread-a", project.id, "2026-03-08T10:00:00.000Z");
    let listener: ((event: ChatEvent) => void) | null = null;

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([project]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(project)
      },
      threads: {
        list: vi.fn().mockResolvedValue([thread]),
        create: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(openPayload(thread)),
        updateModel: vi.fn()
      },
      chat: {
        send: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        retry: vi.fn().mockResolvedValue(undefined),
        resolvePermission: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockImplementation((callback: (event: ChatEvent) => void) => {
          listener = callback;
          return () => undefined;
        }),
        getModels: vi.fn().mockResolvedValue({
          models: [],
          currentModelId: null,
          discoveredAt: "2026-03-08T00:00:00.000Z",
          source: "fallback"
        }),
        refreshModels: vi.fn().mockResolvedValue({
          models: [],
          currentModelId: null,
          discoveredAt: "2026-03-08T00:00:00.000Z",
          source: "fallback"
        })
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          cliExecutablePath: null,
          selectedProjectId: project.id,
          defaultModelId: null,
          hiddenProjectIds: []
        }),
        update: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.bootstrap();

    expect(listener).not.toBeNull();
    const emitChatEvent = (event: ChatEvent): void => {
      if (!listener) {
        throw new Error("Chat listener was not registered.");
      }

      listener(event);
    };

    vi.setSystemTime(new Date("2026-03-08T10:00:00.000Z"));
    emitChatEvent({
      type: "message-created",
      threadId: thread.id,
      message: {
        id: "user-1",
        threadId: thread.id,
        role: "user",
        content: "Describe this project",
        createdAt: "2026-03-08T10:00:00.000Z",
        kind: "message"
      }
    });

    vi.setSystemTime(new Date("2026-03-08T10:00:10.000Z"));
    emitChatEvent({
      type: "tool-updated",
      threadId: thread.id,
      toolCall: {
        toolCallId: "tool-1",
        title: "Viewing README.md",
        kind: "tool",
        status: "running",
        content: "",
        locations: ["/tmp/repo/README.md"]
      }
    });

    vi.setSystemTime(new Date("2026-03-08T10:00:20.000Z"));
    emitChatEvent({
      type: "tool-updated",
      threadId: thread.id,
      toolCall: {
        toolCallId: "tool-1",
        title: "Viewing README.md",
        kind: "tool",
        status: "completed",
        content: "",
        locations: ["/tmp/repo/README.md"]
      }
    });

    emitChatEvent({
      type: "message-created",
      threadId: thread.id,
      message: {
        id: "assistant-1",
        threadId: thread.id,
        role: "assistant",
        content: "It is an Electron app.",
        createdAt: "2026-03-08T10:00:30.000Z",
        kind: "message"
      }
    });

    expect(store.transcriptTimeline.map((item) => `${item.itemType}:${item.id}`)).toEqual([
      "message:user-1",
      "tool-call:tool-1",
      "message:assistant-1"
    ]);
    expect(store.transcriptTimeline[1]).toMatchObject({
      itemType: "tool-call",
      id: "tool-1",
      status: "completed",
      createdAt: "2026-03-08T10:00:10.000Z",
      updatedAt: "2026-03-08T10:00:20.000Z"
    });
  });

  it("orders each prompt turn as reasoning, then tool calls, then response", async () => {
    vi.useFakeTimers();
    const project = makeProject("project-a", "alpha");
    const thread = makeThread("thread-a", project.id, "2026-03-08T10:00:00.000Z");
    let listener: ((event: ChatEvent) => void) | null = null;

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([project]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(project)
      },
      threads: {
        list: vi.fn().mockResolvedValue([thread]),
        create: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(openPayload(thread)),
        updateModel: vi.fn()
      },
      chat: {
        send: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        retry: vi.fn().mockResolvedValue(undefined),
        resolvePermission: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockImplementation((callback: (event: ChatEvent) => void) => {
          listener = callback;
          return () => undefined;
        }),
        getModels: vi.fn().mockResolvedValue({
          models: [],
          currentModelId: null,
          discoveredAt: "2026-03-08T00:00:00.000Z",
          source: "fallback"
        }),
        refreshModels: vi.fn().mockResolvedValue({
          models: [],
          currentModelId: null,
          discoveredAt: "2026-03-08T00:00:00.000Z",
          source: "fallback"
        })
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          cliExecutablePath: null,
          selectedProjectId: project.id,
          defaultModelId: null,
          hiddenProjectIds: []
        }),
        update: vi.fn()
      }
    });

    const store = useCockpitStore();

    await store.bootstrap();

    expect(listener).not.toBeNull();
    const emitChatEvent = (event: ChatEvent): void => {
      if (!listener) {
        throw new Error("Chat listener was not registered.");
      }

      listener(event);
    };

    vi.setSystemTime(new Date("2026-03-08T10:00:00.000Z"));
    emitChatEvent({
      type: "message-created",
      threadId: thread.id,
      message: {
        id: "user-1",
        threadId: thread.id,
        role: "user",
        content: "Describe this project",
        createdAt: "2026-03-08T10:00:00.000Z",
        kind: "message"
      }
    });

    vi.setSystemTime(new Date("2026-03-08T10:00:20.000Z"));
    emitChatEvent({
      type: "tool-updated",
      threadId: thread.id,
      toolCall: {
        toolCallId: "tool-1",
        title: "Viewing README.md",
        kind: "tool",
        status: "completed",
        content: "",
        locations: ["/tmp/repo/README.md"]
      }
    });

    vi.setSystemTime(new Date("2026-03-08T10:00:25.000Z"));
    emitChatEvent({
      type: "assistant-delta",
      threadId: thread.id,
      messageId: "assistant-1",
      content: "It is an Electron app.",
      kind: "message"
    });

    vi.setSystemTime(new Date("2026-03-08T10:00:30.000Z"));
    emitChatEvent({
      type: "assistant-delta",
      threadId: thread.id,
      messageId: "thought-1",
      content: "Checking the repo structure first.",
      kind: "thought"
    });

    expect(store.transcriptTimeline.map((item) => `${item.itemType}:${item.id}`)).toEqual([
      "message:user-1",
      "message:thought-1",
      "tool-call:tool-1",
      "message:assistant-1"
    ]);
  });
});
