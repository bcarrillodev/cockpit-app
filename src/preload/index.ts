import { contextBridge, ipcRenderer } from "electron";
import type { ChatEvent, CockpitApi } from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/ipc";

const api: CockpitApi = {
  system: {
    getCliHealth: () => ipcRenderer.invoke(IPC_CHANNELS.systemGetCliHealth),
    pickProjectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.systemPickProjectDirectory),
    openProjectPath: (projectPath) => ipcRenderer.invoke(IPC_CHANNELS.systemOpenProjectPath, projectPath)
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.projectsList),
    create: (rootPath) => ipcRenderer.invoke(IPC_CHANNELS.projectsCreate, rootPath),
    remove: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.projectsRemove, projectId),
    select: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.projectsSelect, projectId)
  },
  threads: {
    list: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.threadsList, projectId),
    create: (projectId, modelId) => ipcRenderer.invoke(IPC_CHANNELS.threadsCreate, projectId, modelId),
    rename: (threadId, title) => ipcRenderer.invoke(IPC_CHANNELS.threadsRename, threadId, title),
    delete: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.threadsDelete, threadId),
    open: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.threadsOpen, threadId),
    updateModel: (threadId, modelId) =>
      ipcRenderer.invoke(IPC_CHANNELS.threadsUpdateModel, threadId, modelId)
  },
  chat: {
    send: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatSend, input),
    stop: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatStop, input),
    retry: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatRetry, input),
    resolvePermission: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatResolvePermission, input),
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ChatEvent) => listener(payload);
      ipcRenderer.on(IPC_CHANNELS.chatEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.chatEvent, handler);
      };
    },
    getModels: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.chatGetModels, threadId),
    refreshModels: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.chatRefreshModels, threadId)
  },
  git: {
    getStatus: (rootPath) => ipcRenderer.invoke(IPC_CHANNELS.gitGetStatus, rootPath),
    listChangedFiles: (rootPath) => ipcRenderer.invoke(IPC_CHANNELS.gitListChangedFiles, rootPath),
    commitAndPush: (input) => ipcRenderer.invoke(IPC_CHANNELS.gitCommitAndPush, input)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch)
  }
};

contextBridge.exposeInMainWorld("cockpit", api);
