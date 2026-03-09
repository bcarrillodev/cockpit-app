// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import App from "../src/renderer/App.vue";
import type { ProjectRecord, ThreadOpenPayload, ThreadRecord } from "../src/shared/contracts";

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
    vi.restoreAllMocks();
  });

  it("renders grouped threads without the old top-level actions", async () => {
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
          hiddenProjectIds: []
        }),
        update: vi.fn()
      }
    });

    const wrapper = mount(App, {
      global: {
        plugins: [createPinia()],
        stubs: {
          PButton: { template: "<button><slot /></button>" },
          PDialog: { template: "<div><slot /></div>" },
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
    expect(buttonLabels).not.toContain("New thread");
    expect(buttonLabels).toContain("Add project");
    expect(buttonLabels).toContain("Settings");
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
          PButton: { template: "<button><slot /></button>" },
          PDialog: { template: "<div><slot /></div>" },
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

    const text = wrapper.text();

    expect(text).not.toContain(projectA.name);
    expect(text).not.toContain(threadA.title);
    expect(text).toContain(projectB.name);
    expect(text).toContain(threadB.title);
    expect(removeProject).toHaveBeenCalledWith(projectA.id);
  });
});
