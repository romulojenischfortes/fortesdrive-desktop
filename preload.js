const { contextBridge, ipcRenderer } = require("electron");
const channels = {
  selectFolder: "selectFolder", chooseFolderParent: "chooseFolderParent", useFolder: "useFolder",
  getStatus: "getStatus", syncNow: "syncNow",
  snapshot: "snapshot", readFile: "readFile", writeFile: "writeFile",
  uploadFileStream: "uploadFileStream", downloadFileStream: "downloadFileStream",
  moveFile: "moveFile", trashFile: "trashFile", mkdir: "mkdir", rmdir: "rmdir",
  getManifest: "getManifest", saveManifest: "saveManifest", setState: "setState",
  notify: "notify", publishSyncStatus: "publishSyncStatus",
  recordTransferCompletion: "recordTransferCompletion", getTransferHistory: "getTransferHistory",
  exportTransferHistory: "exportTransferHistory", revealTransferHistoryItem: "revealTransferHistoryItem",
  getBadgeSetup: "getBadgeSetup", repairBadges: "repairBadges",
  getUpdateStatus: "getUpdateStatus", checkForUpdates: "checkForUpdates",
  downloadUpdate: "downloadUpdate", installUpdate: "installUpdate",
  launchInstaller: "launchInstaller", verifyUpdateSignature: "verifyUpdateSignature",
};
const api = { isDesktop: true };
for (const [method, channel] of Object.entries(channels)) {
  api[method] = (...args) => ipcRenderer.invoke("sync:" + channel, ...args);
}
api.onTransferCompleted = listener => {
  const callback = () => listener();
  ipcRenderer.on("sync:transferCompleted", callback);
  return () => ipcRenderer.removeListener("sync:transferCompleted", callback);
};
api.onTransferProgress = listener => {
  const callback = (event, progress) => listener(progress);
  ipcRenderer.on("sync:transferProgress", callback);
  return () => ipcRenderer.removeListener("sync:transferProgress", callback);
};
// A bandeja do sistema pede ao aplicativo que abra o assistente de pasta.
api.onOpenFolderSetup = (listener) => {
  const callback = () => listener();
  ipcRenderer.on("sync:openFolderSetup", callback);
  return () => ipcRenderer.removeListener("sync:openFolderSetup", callback);
};
api.onSyncRequested = (listener) => {
  const callback = () => listener();
  ipcRenderer.on("sync:requested", callback);
  return () => ipcRenderer.removeListener("sync:requested", callback);
};
if (window.location.origin === "https://fortesdrive.base44.app" || (process.env.NODE_ENV === "development" && window.location.origin === "http://localhost:5173")) {
  contextBridge.exposeInMainWorld("fortesDrive", Object.freeze(api));
}