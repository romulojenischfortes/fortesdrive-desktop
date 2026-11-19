const { contextBridge, ipcRenderer } = require("electron");
const channels = {
  selectFolder: "selectFolder", chooseFolderParent: "chooseFolderParent", useFolder: "useFolder",
  getStatus: "getStatus", syncNow: "syncNow", rendererReady: "rendererReady",
  snapshot: "snapshot", readFile: "readFile", writeFile: "writeFile",
  uploadFileStream: "uploadFileStream", downloadFileStream: "downloadFileStream",
  moveFile: "moveFile", trashFile: "trashFile", mkdir: "mkdir", rmdir: "rmdir",
  getManifest: "getManifest", saveManifest: "saveManifest", saveManifestPatch: "saveManifestPatch", setState: "setState",
  notify: "notify", publishSyncStatus: "publishSyncStatus",
  recordTransferCompletion: "recordTransferCompletion", recordTransferCompletions: "recordTransferCompletions", getTransferHistory: "getTransferHistory",
  exportTransferHistory: "exportTransferHistory", revealTransferHistoryItem: "revealTransferHistoryItem",
  getBadgeSetup: "getBadgeSetup", repairBadges: "repairBadges",
  getUpdateStatus: "getUpdateStatus", checkForUpdates: "checkForUpdates",
  getInstallationHealth: "getInstallationHealth", confirmInstallation: "confirmInstallation",
  downloadUpdate: "downloadUpdate", installUpdate: "installUpdate",
  launchInstaller: "launchInstaller", verifyUpdateSignature: "verifyUpdateSignature",
  getServerTunnel: "getServerTunnel", setServerTunnelEnabled: "setServerTunnelEnabled",
  startServerTunnel: "startServerTunnel", stopServerTunnel: "stopServerTunnel",
  restartServerTunnel: "restartServerTunnel", diagnoseServerTunnel: "diagnoseServerTunnel",
  chooseServerRoot: "chooseServerRoot",
};
const api = { isDesktop: true };
for (const [method, channel] of Object.entries(channels)) {
  api[method] = (...args) => ipcRenderer.invoke("sync:" + channel, ...args);
}

// Um único ouvinte IPC compartilhado para todo o progresso de transferências:
// elimina dezenas de inscrições simultâneas no ipcRenderer e roteia em O(1).
const progressWildcards = new Set();
const progressByKey = new Map();
let progressBound = false;

function dispatchProgressItem(progress) {
  if (!progress) return;
  const key = `${progress.direction}:${progress.path}`;
  const keyed = progressByKey.get(key);
  if (keyed) for (const fn of keyed) fn(progress);
  if (progressWildcards.size) for (const fn of progressWildcards) fn(progress);
}

function ensureProgressBound() {
  if (progressBound) return;
  progressBound = true;
  ipcRenderer.on("sync:transferProgress", (_event, progress) => dispatchProgressItem(progress));
  ipcRenderer.on("sync:transferProgressBatch", (_event, items) => {
    if (Array.isArray(items)) for (const item of items) dispatchProgressItem(item);
  });
}

api.onTransferCompleted = listener => {
  const callback = () => listener();
  ipcRenderer.on("sync:transferCompleted", callback);
  return () => ipcRenderer.removeListener("sync:transferCompleted", callback);
};
api.onTransferProgress = (listener, direction, filePath) => {
  ensureProgressBound();
  if (direction && filePath) {
    const key = `${direction}:${filePath}`;
    let set = progressByKey.get(key);
    if (!set) { set = new Set(); progressByKey.set(key, set); }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) progressByKey.delete(key);
    };
  }
  progressWildcards.add(listener);
  return () => progressWildcards.delete(listener);
};
api.onOpenFolderSetup = (listener) => {
  const callback = () => listener();
  ipcRenderer.on("sync:openFolderSetup", callback);
  return () => ipcRenderer.removeListener("sync:openFolderSetup", callback);
};
api.onSyncRequested = (listener) => {
  const callback = () => listener();
  ipcRenderer.on("sync:requested", callback);
  ipcRenderer.invoke("sync:rendererReady").catch(() => {});
  return () => ipcRenderer.removeListener("sync:requested", callback);
};
if (window.location.origin === "https://fortesdrive.base44.app" || (process.env.NODE_ENV === "development" && window.location.origin === "http://localhost:5173")) {
  contextBridge.exposeInMainWorld("fortesDrive", Object.freeze(api));
}