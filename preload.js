const { contextBridge, ipcRenderer } = require("electron");
const channels = {
  selectFolder: "selectFolder", getStatus: "getStatus", syncNow: "syncNow",
  snapshot: "snapshot", readFile: "readFile", writeFile: "writeFile",
  moveFile: "moveFile", trashFile: "trashFile", mkdir: "mkdir", rmdir: "rmdir",
  getManifest: "getManifest", saveManifest: "saveManifest", setState: "setState",
  notify: "notify",
  getUpdateStatus: "getUpdateStatus", checkForUpdates: "checkForUpdates",
  downloadUpdate: "downloadUpdate", installUpdate: "installUpdate",
};
const api = { isDesktop: true };
for (const [method, channel] of Object.entries(channels)) {
  api[method] = (...args) => ipcRenderer.invoke("sync:" + channel, ...args);
}
api.onSyncRequested = (listener) => {
  const callback = () => listener();
  ipcRenderer.on("sync:requested", callback);
  return () => ipcRenderer.removeListener("sync:requested", callback);
};
if (window.location.origin === "https://fortesdrive.base44.app" || (process.env.NODE_ENV === "development" && window.location.origin === "http://localhost:5173")) {
  contextBridge.exposeInMainWorld("fortesDrive", Object.freeze(api));
}