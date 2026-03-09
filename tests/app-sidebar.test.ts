// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import App from "../src/renderer/App.vue";
import type { ChatEvent, ProjectRecord, ThreadOpenPayload, ThreadRecord } from "../src/shared/contracts";

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
  lastMessageAt: string | null = null,
  summary = ""
): ThreadRecord {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    summary,
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
    permissions: [],
    toolCalls: []
  };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    }
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

  Object.defineProperty(window, "cockpit", {
    value: cockpit,
    configurable: true,
    writable: true
  });
}

const pButtonStub = {
  props: ["label"],
  template: "<button><slot />{{ label }}</button>"
};

const pDialogStub = {
  props: ["visible"],
  template: "<div v-if=\"visible\"><slot /></div>"
};

describe("sidebar grouping", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const storage = createMemoryStorage();
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
      writable: true
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      configurable: true,
      writable: true
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders grouped threads without the old top-level actions", async () => {
    const projectA = makeProject("project-a", "alpha");
    const projectB = makeProject("project-b", "beta");
    const threadA = makeThread(
      "thread-a",
      projectA.id,
      "2026-03-08T10:02:00.000Z",
      "2026-03-08T10:07:00.000Z",
      "user: Describe this project. | assistant: Here is the summary."
    );
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

    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
        stubs: {
          PButton: pButtonStub,
          PDialog: pDialogStub,
          PDrawer: { template: "<div><slot /></div>" },
          PInputText: { template: "<input />" },
          PMessage: { template: "<div><slot /></div>" },
          PSelect: { template: "<div />" },
          PTag: { template: "<span><slot /></span>" },
          PTextarea: { template: "<textarea />" }
        }
      }
    });

    await flushPromises();

    const text = wrapper.text();
    const buttonLabels = wrapper
      .findAll("button")
      .map((button) => button.text().trim())
      .filter(Boolean);

    expect(text).toContain("Threads");
    expect(text).not.toContain("Projects");
    expect(text).toContain(projectA.name);
    expect(text).toContain(projectB.name);
    expect(text).toContain(threadA.title);
    expect(text).toContain(threadB.title);
    expect(text).not.toContain("user: Describe this project.");
    expect(text).not.toContain("assistant: Here is the summary.");
    expect(buttonLabels).not.toContain("New thread");
    expect(buttonLabels).toContain("Add project");
    expect(buttonLabels).toContain("Settings");
  });

  it("renders reasoning, tool calls, and the visible response in one transcript", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T10:04:00.000Z"));

    const project = makeProject("project-a", "alpha");
    const thread = makeThread("thread-a", project.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:08:00.000Z");
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
        open: vi.fn().mockResolvedValue({
          thread,
          messages: [
            {
              id: "user-1",
              threadId: thread.id,
              role: "user",
              content: "Describe this project.",
              createdAt: "2026-03-08T10:02:00.000Z",
              kind: "message"
            },
            {
              id: "thought-1",
              threadId: thread.id,
              role: "assistant",
              content: "Checking the repo structure first.",
              createdAt: "2026-03-08T10:03:00.000Z",
              kind: "thought"
            },
            {
              id: "response-1",
              threadId: thread.id,
              role: "assistant",
              content: "This is an Electron app.",
              createdAt: "2026-03-08T10:05:00.000Z",
              kind: "message"
            }
          ],
          permissions: []
        }),
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

    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
        stubs: {
          PButton: pButtonStub,
          PDialog: pDialogStub,
          PDrawer: { template: "<div><slot /></div>" },
          PInputText: { template: "<input />" },
          PMessage: { template: "<div><slot /></div>" },
          PSelect: { template: "<div />" },
          PTag: { template: "<span><slot /></span>" },
          PTextarea: { template: "<textarea />" }
        }
      }
    });

    await flushPromises();

    if (!listener) {
      throw new Error("Chat listener was not registered.");
    }

    const emitChatEvent = listener as (event: ChatEvent) => void;

    emitChatEvent({
      type: "tool-updated",
      threadId: thread.id,
      toolCall: {
        toolCallId: "tool-1",
        title: "Open README.md",
        kind: "tool",
        status: "completed",
        content: "",
        locations: ["/tmp/alpha/README.md"]
      }
    });
    emitChatEvent({
      type: "tool-updated",
      threadId: thread.id,
      toolCall: {
        toolCallId: "tool-2",
        title: "Read package.json",
        kind: "tool",
        status: "completed",
        content: "Found Electron dependencies.",
        locations: []
      }
    });

    await flushPromises();

    const transcript = wrapper.get(".transcript-stack").text();

    expect(wrapper.findAll(".message-shell")).toHaveLength(3);
    expect(wrapper.findAll(".tool-call-group-shell")).toHaveLength(1);
    expect(wrapper.findAll(".tool-call-entry")).toHaveLength(0);
    expect(transcript).toContain("Reasoning");
    expect(transcript).toContain("Tool calls");
    expect(transcript).not.toContain("Open README.md");
    expect(transcript).not.toContain("Read package.json");
    expect(transcript).not.toContain("/tmp/alpha/README.md");
    expect(transcript).not.toContain("Found Electron dependencies.");
    expect(transcript).toContain("Response");
    expect(transcript).not.toContain("assistant");
    expect(transcript.indexOf("Reasoning")).toBeLessThan(transcript.indexOf("Tool calls"));
    expect(transcript.indexOf("Tool calls")).toBeLessThan(transcript.indexOf("Response"));
    expect(wrapper.get(".tool-call-toggle").attributes("aria-expanded")).toBe("false");
    expect(wrapper.get(".tool-call-toggle").text()).toBe("Expand");

    await wrapper.get(".tool-call-toggle").trigger("click");
    await flushPromises();

    const expandedTranscript = wrapper.get(".transcript-stack").text();

    expect(wrapper.get(".tool-call-toggle").attributes("aria-expanded")).toBe("true");
    expect(wrapper.get(".tool-call-toggle").text()).toBe("Collapse");
    expect(wrapper.findAll(".tool-call-entry")).toHaveLength(2);
    expect(expandedTranscript).toContain("Open README.md");
    expect(expandedTranscript).toContain("Read package.json");
    expect(expandedTranscript).not.toContain("/tmp/alpha/README.md");
    expect(expandedTranscript).not.toContain("Found Electron dependencies.");

  });

  it("removes a project from Cockpit and leaves the repo untouched", async () => {
    const projectA = makeProject("project-a", "alpha");
    const projectB = makeProject("project-b", "beta");
    const threadA = makeThread("thread-a", projectA.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:07:00.000Z");
    const threadB = makeThread("thread-b", projectB.id, "2026-03-08T10:03:00.000Z", "2026-03-08T10:08:00.000Z");
    let currentProjects = [projectA, projectB];
    let currentThreads = [threadB, threadA];
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

    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
        stubs: {
          PButton: pButtonStub,
          PDialog: pDialogStub,
          PDrawer: { template: "<div><slot /></div>" },
          PInputText: { template: "<input />" },
          PMessage: { template: "<div><slot /></div>" },
          PSelect: { template: "<div />" },
          PTag: { template: "<span><slot /></span>" },
          PTextarea: { template: "<textarea />" }
        }
      }
    });

    await flushPromises();
    await wrapper.find('button[aria-label="Remove project alpha"]').trigger("click");
    await flushPromises();
    expect(removeProject).not.toHaveBeenCalled();

    const confirmDeleteProject = wrapper.findAll("button").find((button) => button.text() === "Delete project");
    expect(confirmDeleteProject).toBeDefined();
    await confirmDeleteProject!.trigger("click");
    await flushPromises();

    const text = wrapper.text();

    expect(text).not.toContain(projectA.name);
    expect(text).not.toContain(threadA.title);
    expect(text).toContain(projectB.name);
    expect(text).toContain(threadB.title);
    expect(removeProject).toHaveBeenCalledWith(projectA.id);
  });
});
