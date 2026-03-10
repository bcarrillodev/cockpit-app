import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppStore } from "../src/main/store";

describe("AppStore", () => {
  it("persists projects, threads, and messages across reloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "cockpit-store-"));

    try {
      const store = new AppStore(root);
      await store.init();

      const project = await store.createProject("/tmp/example-repo");
      const thread = await store.createThread(project.id, "gpt-5");

      await store.appendMessage({
        id: "message-1",
        threadId: thread.id,
        role: "user",
        content: "Describe this repo.",
        createdAt: "2026-03-08T10:00:00.000Z",
        kind: "message"
      });

      await store.updateThread(thread.id, {
        title: "Describe this repo",
        summary: "user: Describe this repo."
      });
      await store.upsertToolCall(thread.id, {
        toolCallId: "tool-1",
        title: "Open README.md",
        kind: "tool",
        status: "completed",
        content: "",
        locations: ["/tmp/example-repo/README.md"],
        firstSeenAt: "2026-03-08T10:00:01.000Z",
        lastUpdatedAt: "2026-03-08T10:00:02.000Z"
      });

      const reopened = new AppStore(root);
      await reopened.init();

      const openedThread = await reopened.openThread(thread.id);

      expect((await reopened.getProjects())[0]?.rootPath).toBe("/tmp/example-repo");
      expect(openedThread.thread.title).toBe("Describe this repo");
      expect(openedThread.messages).toHaveLength(1);
      expect(openedThread.messages[0]?.content).toBe("Describe this repo.");
      expect(openedThread.toolCalls).toEqual([
        expect.objectContaining({
          toolCallId: "tool-1",
          title: "Open README.md",
          firstSeenAt: "2026-03-08T10:00:01.000Z",
          lastUpdatedAt: "2026-03-08T10:00:02.000Z"
        })
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a project's Cockpit data without touching other projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "cockpit-store-"));

    try {
      const store = new AppStore(root);
      await store.init();

      const projectA = await store.createProject("/tmp/example-repo-a");
      const projectB = await store.createProject("/tmp/example-repo-b");
      const threadA = await store.createThread(projectA.id, "gpt-5");
      const threadB = await store.createThread(projectB.id, "gpt-5");

      await store.appendMessage({
        id: "message-a",
        threadId: threadA.id,
        role: "user",
        content: "Remove me.",
        createdAt: "2026-03-08T10:00:00.000Z",
        kind: "message"
      });

      await store.updateSettings({
        selectedProjectId: projectA.id,
        defaultModelId: null,
        defaultReasoningLevelId: null,
        hiddenProjectIds: [projectA.id]
      });
      await store.removeProject(projectA.id);

      const reopened = new AppStore(root);
      await reopened.init();

      await expect(reopened.openThread(threadA.id)).rejects.toThrow(`Thread not found: ${threadA.id}`);
      expect(await reopened.openThread(threadB.id)).toMatchObject({
        thread: expect.objectContaining({ id: threadB.id })
      });
      expect((await reopened.getProjects()).map((project) => project.id)).toEqual([projectB.id]);
      expect(await reopened.getSettings()).toEqual({
        cliExecutablePath: null,
        requirePermissionApproval: true,
        selectedProjectId: projectB.id,
        defaultModelId: null,
        defaultReasoningLevelId: null,
        hiddenProjectIds: []
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the saved default model for newly created threads", async () => {
    const root = await mkdtemp(join(tmpdir(), "cockpit-store-"));

    try {
      const store = new AppStore(root);
      await store.init();

      const project = await store.createProject("/tmp/example-repo");
      await store.updateSettings({
        defaultModelId: "gpt-5.4",
        defaultReasoningLevelId: "high"
      });

      const thread = await store.createThread(project.id);

      expect(thread.modelId).toBe("gpt-5.4");
      expect(thread.reasoningLevelId).toBe("high");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists permission approval settings across reloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "cockpit-store-"));

    try {
      const store = new AppStore(root);
      await store.init();

      await store.updateSettings({
        requirePermissionApproval: false
      });

      expect((await store.getSettings()).requirePermissionApproval).toBe(false);

      const reopened = new AppStore(root);
      await reopened.init();

      expect((await reopened.getSettings()).requirePermissionApproval).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps project ordering stable when selecting a project", async () => {
    const root = await mkdtemp(join(tmpdir(), "cockpit-store-"));

    try {
      const store = new AppStore(root);
      await store.init();

      const projectA = await store.createProject("/tmp/example-repo-a");
      const projectB = await store.createProject("/tmp/example-repo-b");

      expect((await store.getProjects()).map((project) => project.id)).toEqual([projectA.id, projectB.id]);

      await store.selectProject(projectA.id);

      expect((await store.getProjects()).map((project) => project.id)).toEqual([projectA.id, projectB.id]);
      expect((await store.getSettings()).selectedProjectId).toBe(projectA.id);

      const reopened = new AppStore(root);
      await reopened.init();

      expect((await reopened.getProjects()).map((project) => project.id)).toEqual([projectA.id, projectB.id]);
      expect((await reopened.getSettings()).selectedProjectId).toBe(projectA.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns projects in creation order even if persisted records are shuffled", async () => {
    const root = await mkdtemp(join(tmpdir(), "cockpit-store-"));

    try {
      const store = new AppStore(root);
      await store.init();

      const projectA = await store.createProject("/tmp/example-repo-a");
      const projectB = await store.createProject("/tmp/example-repo-b");
      const projectsPath = join(root, "projects.json");
      const persistedProjects = JSON.parse(await readFile(projectsPath, "utf8")) as Array<Record<string, unknown>>;

      await writeFile(
        projectsPath,
        JSON.stringify(
          [
            {
              ...persistedProjects[1],
              createdAt: "2026-03-08T10:01:00.000Z"
            },
            {
              ...persistedProjects[0],
              createdAt: "2026-03-08T10:00:00.000Z"
            }
          ],
          null,
          2
        ),
        "utf8"
      );

      const reopened = new AppStore(root);
      await reopened.init();

      expect((await reopened.getProjects()).map((project) => project.id)).toEqual([projectA.id, projectB.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
