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
    reasoningLevelId: "",
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

type CockpitOverrides = {
  [K in keyof typeof window.cockpit]?: Partial<(typeof window.cockpit)[K]>;
};

function installCockpitApi(overrides: CockpitOverrides = {}): void {
  const cockpit: typeof window.cockpit = {
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
      updateModel: vi.fn(),
      updateReasoning: vi.fn()
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
        defaultReasoningLevelId: null,
        hiddenProjectIds: []
      }),
      update: vi.fn()
    }
  };

  cockpit.system = {
    ...cockpit.system,
    ...overrides.system
  };
  cockpit.projects = {
    ...cockpit.projects,
    ...overrides.projects
  };
  cockpit.threads = {
    ...cockpit.threads,
    ...overrides.threads
  };
  cockpit.chat = {
    ...cockpit.chat,
    ...overrides.chat
  };
  cockpit.git = {
    ...cockpit.git,
    ...overrides.git
  };
  cockpit.settings = {
    ...cockpit.settings,
    ...overrides.settings
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

const tooltipDirectiveStub = {
  mounted() {},
  updated() {},
  unmounted() {}
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
        directives: {
          tooltip: tooltipDirectiveStub
        },
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
    expect(wrapper.find('button[aria-label="Add project"]').exists()).toBe(true);
    expect(buttonLabels).toContain("Settings");

    const sidebar = wrapper.find("aside");
    expect(sidebar.classes()).toContain("app-sidebar");
    expect(sidebar.classes()).not.toContain("hidden");

    const header = wrapper.find("header");
    expect(header.classes()).toContain("main-header");

    const firstProjectGroup = wrapper.find(".project-group");
    const firstProjectPill = firstProjectGroup.find(".project-pill");
    const projectHeaderButtons = firstProjectGroup.findAll(".project-pill-header > button, .project-pill-header > .project-group-actions > button");

    expect(firstProjectPill.find(".project-pill-body").exists()).toBe(true);
    expect(firstProjectPill.find(".project-thread-list").exists()).toBe(true);
    expect(firstProjectPill.findAll(".thread-row")).toHaveLength(1);
    expect(projectHeaderButtons).toHaveLength(3);
    expect(projectHeaderButtons[0]?.attributes("aria-label")).toBe("Hide threads");
    expect(projectHeaderButtons[1]?.text()).toContain(projectA.name);
    expect(projectHeaderButtons[2]?.attributes("aria-label")).toBe("Project actions");
    expect(firstProjectGroup.find(".project-action-menu").exists()).toBe(false);

    await projectHeaderButtons[2]!.trigger("click");
    await flushPromises();

    const projectActionMenu = firstProjectGroup.find(".project-action-menu");
    const projectActionItems = projectActionMenu.findAll("button");

    expect(projectActionMenu.exists()).toBe(true);
    expect(projectActionItems).toHaveLength(2);
    expect(projectActionItems[0]?.text()).toContain("Add new thread");
    expect(projectActionItems[1]?.text()).toContain("Remove project");

    await projectHeaderButtons[0]!.trigger("click");
    await flushPromises();

    expect(firstProjectGroup.find(".project-pill-body").exists()).toBe(false);
  });

  it("creates a thread from the project action menu", async () => {
    const project = makeProject("project-a", "alpha");
    const thread = makeThread("thread-a", project.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:07:00.000Z");
    const createdThread = makeThread("thread-b", project.id, "2026-03-08T10:10:00.000Z");
    const createThread = vi.fn().mockResolvedValue(createdThread);
    const openThread = vi.fn()
      .mockResolvedValueOnce(openPayload(thread))
      .mockResolvedValueOnce(openPayload(createdThread));

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([project]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(project)
      },
      threads: {
        list: vi.fn().mockResolvedValue([thread]),
        create: createThread,
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: openThread,
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

    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
        directives: {
          tooltip: tooltipDirectiveStub
        },
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

    await wrapper.find('button[aria-label="Project actions"]').trigger("click");
    await flushPromises();
    await wrapper.find(".project-action-menu button").trigger("click");
    await flushPromises();

    expect(createThread).toHaveBeenCalledWith(project.id, undefined, undefined);
    expect(openThread).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".project-action-menu").exists()).toBe(false);
  });

  it("does not open a thread when clicking its delete button", async () => {
    const project = makeProject("project-a", "alpha");
    const thread = makeThread("thread-a", project.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:07:00.000Z");
    const openThread = vi.fn().mockResolvedValue(openPayload(thread));

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
        open: openThread,
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

    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
        directives: {
          tooltip: tooltipDirectiveStub
        },
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

    expect(openThread).toHaveBeenCalledTimes(1);

    await wrapper.find('button[aria-label="Delete thread"]').trigger("click");
    await flushPromises();

    expect(openThread).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("This cannot be undone.");
  });

  it("marks only the active thread delete button as visible by default", async () => {
    const project = makeProject("project-a", "alpha");
    const activeThread = makeThread("thread-a", project.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:07:00.000Z");
    const inactiveThread = makeThread("thread-b", project.id, "2026-03-08T10:03:00.000Z", "2026-03-08T10:08:00.000Z");

    installCockpitApi({
      projects: {
        list: vi.fn().mockResolvedValue([project]),
        create: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue(project)
      },
      threads: {
        list: vi.fn().mockResolvedValue([inactiveThread, activeThread]),
        create: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(openPayload(activeThread)),
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

    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
        directives: {
          tooltip: tooltipDirectiveStub
        },
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

    const threadRows = wrapper.findAll(".thread-row");

    expect(threadRows).toHaveLength(2);
    expect(threadRows[0]?.classes()).toContain("thread-row-active");
    expect(threadRows[0]?.find('button[aria-label="Delete thread"]').classes()).toContain(
      "thread-delete-button-visible"
    );
    expect(threadRows[1]?.classes()).not.toContain("thread-row-active");
    expect(threadRows[1]?.find('button[aria-label="Delete thread"]').classes()).not.toContain(
      "thread-delete-button-visible"
    );
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
        directives: {
          tooltip: tooltipDirectiveStub
        },
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

  it("hides an assistant response card until response text exists", async () => {
    vi.useFakeTimers();

    const project = makeProject("project-a", "alpha");
    const thread = makeThread("thread-a", project.id, "2026-03-08T10:02:00.000Z", "2026-03-08T10:08:00.000Z");

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
              id: "response-1",
              threadId: thread.id,
              role: "assistant",
              content: "   ",
              createdAt: "2026-03-08T10:05:00.000Z",
              kind: "message"
            }
          ],
          permissions: []
        }),
        updateModel: vi.fn(),
        updateReasoning: vi.fn()
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
        directives: {
          tooltip: tooltipDirectiveStub
        },
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

    const cards = wrapper.findAll(".message-shell");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text()).toContain("Describe this project.");
    expect(wrapper.find(".message-response").exists()).toBe(false);
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
        directives: {
          tooltip: tooltipDirectiveStub
        },
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
    await wrapper.find('button[aria-label="Project actions"]').trigger("click");
    await flushPromises();
    await wrapper.findAll(".project-action-menu button")[1]!.trigger("click");
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

  it("toggles permission approval from the settings drawer", async () => {
    let currentSettings = {
      cliExecutablePath: null,
      requirePermissionApproval: true,
      selectedProjectId: null,
      defaultModelId: null,
      hiddenProjectIds: []
    };
    const updateSettings = vi.fn().mockImplementation(async (patch: Record<string, unknown>) => {
      currentSettings = {
        ...currentSettings,
        ...patch
      };
      return currentSettings;
    });

    installCockpitApi({
      settings: {
        get: vi.fn().mockResolvedValue(currentSettings),
        update: updateSettings
      }
    });

    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
        directives: {
          tooltip: tooltipDirectiveStub
        },
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

    const toggle = wrapper.find('button[role="switch"]');
    expect(toggle.attributes("aria-checked")).toBe("true");

    await toggle.trigger("click");
    await flushPromises();

    expect(updateSettings).toHaveBeenCalledWith({
      requirePermissionApproval: false
    });
    expect(toggle.attributes("aria-checked")).toBe("false");
  });
});
