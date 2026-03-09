import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { ChatEvent } from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/ipc";
import { commitAndPush, getGitStatus, listChangedFiles } from "./git-service";
import { ChatManager } from "./chat-manager";
import { AppStore } from "./store";
import { getCliHealth } from "./system-service";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;

const store = new AppStore(join(app.getPath("userData"), "store"));
const chatManager = new ChatManager(store, (event: ChatEvent) => {
  mainWindow?.webContents.send(IPC_CHANNELS.chatEvent, event);
});

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#09090b",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.systemGetCliHealth, async () => getCliHealth(store));
  ipcMain.handle(IPC_CHANNELS.systemPickProjectDirectory, async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          properties: ["openDirectory", "createDirectory"]
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"]
        });

    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC_CHANNELS.systemOpenProjectPath, async (_event, projectPath: string) => {
    await shell.openPath(projectPath);
  });

  ipcMain.handle(IPC_CHANNELS.projectsList, async () => store.getProjects());
  ipcMain.handle(IPC_CHANNELS.projectsCreate, async (_event, rootPath: string) => {
    const project = await store.createProject(rootPath);
    return store.selectProject(project.id);
  });
  ipcMain.handle(IPC_CHANNELS.projectsRemove, async (_event, projectId: string) => {
    await store.removeProject(projectId);
  });
  ipcMain.handle(IPC_CHANNELS.projectsSelect, async (_event, projectId: string) => {
    return store.selectProject(projectId);
  });

  ipcMain.handle(IPC_CHANNELS.threadsList, async (_event, projectId?: string) => store.getThreads(projectId));
  ipcMain.handle(IPC_CHANNELS.threadsCreate, async (_event, projectId: string) => store.createThread(projectId));
  ipcMain.handle(
    IPC_CHANNELS.threadsRename,
    async (_event, threadId: string, title: string) => store.updateThread(threadId, { title })
  );
  ipcMain.handle(IPC_CHANNELS.threadsDelete, async (_event, threadId: string) => {
    await chatManager.restartThreadRuntime(threadId);
    await store.deleteThread(threadId);
  });
  ipcMain.handle(IPC_CHANNELS.threadsOpen, async (_event, threadId: string) => store.openThread(threadId));
  ipcMain.handle(
    IPC_CHANNELS.threadsUpdateModel,
    async (_event, threadId: string, modelId: string) => {
      const thread = await store.updateThread(threadId, { modelId });
      await chatManager.restartThreadRuntime(threadId);
      return thread;
    }
  );

  ipcMain.handle(IPC_CHANNELS.chatSend, async (_event, input) => chatManager.send(input));
  ipcMain.handle(IPC_CHANNELS.chatStop, async (_event, input) => chatManager.stop(input.threadId));
  ipcMain.handle(IPC_CHANNELS.chatRetry, async (_event, input) => chatManager.retry(input.threadId));
  ipcMain.handle(
    IPC_CHANNELS.chatResolvePermission,
    async (_event, input) => chatManager.resolvePermission(input.threadId, input.permissionId, input.optionId)
  );
  ipcMain.handle(IPC_CHANNELS.chatGetModels, async (_event, threadId: string | null) => {
    return chatManager.getModels(threadId);
  });
  ipcMain.handle(IPC_CHANNELS.chatRefreshModels, async (_event, threadId: string | null) => {
    return chatManager.refreshModels(threadId);
  });

  ipcMain.handle(IPC_CHANNELS.gitGetStatus, async (_event, rootPath: string) => getGitStatus(rootPath));
  ipcMain.handle(IPC_CHANNELS.gitListChangedFiles, async (_event, rootPath: string) =>
    listChangedFiles(rootPath)
  );
  ipcMain.handle(IPC_CHANNELS.gitCommitAndPush, async (_event, input) => commitAndPush(input));

  ipcMain.handle(IPC_CHANNELS.settingsGet, async () => store.getSettings());
  ipcMain.handle(IPC_CHANNELS.settingsUpdate, async (_event, patch) => store.updateSettings(patch));
}

app.whenReady().then(async () => {
  await store.init();
  registerIpc();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
