const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Tray } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { SyncEngine } = require("./sync-engine");
const native = require("./native-files");
const WEB_APP_URL = process.env.NODE_ENV === "development" ? "http://localhost:5173" : "https://fortesdrive.base44.app";
let mainWindow, tray, syncEngine;
app.commandLine.appendSwitch("disable-renderer-backgrounding");
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { mainWindow?.show(); mainWindow?.focus(); });

function trusted(event) {
  if (event.sender !== mainWindow?.webContents || event.senderFrame?.parent || new URL(event.senderFrame.url).origin !== new URL(WEB_APP_URL).origin) throw new Error("Solicitação não autorizada");
}
function requestSync() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sync:requested");
}
async function selectFolder() {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"], title: "Escolha o diretório raiz do FortesDrive" });
  if (result.canceled) return null;
  await syncEngine.setWatchFolder(result.filePaths[0]);
  return syncEngine.watchFolder;
}
function registerHandlers() {
  const handlers = {
    selectFolder: selectFolder,
    getStatus: () => syncEngine.getStatus(),
    syncNow: () => { requestSync(); return true; },
    snapshot: () => syncEngine.snapshot(),
    getManifest: userId => syncEngine.getManifest(userId),
    saveManifest: (userId, manifest) => syncEngine.saveManifest(userId, manifest),
    setState: state => {
      const allowed = ["syncing", "queue", "error", "lastSync", "userEmail"];
      for (const key of allowed) if (Object.hasOwn(state, key)) syncEngine.state[key] = state[key];
    },
    readFile: (relative, hash) => native.read(syncEngine.watchFolder, relative, hash),
    writeFile: (relative, bytes, hash, expected) => native.write(syncEngine.watchFolder, relative, bytes, hash, expected),
    moveFile: (from, to, expected) => native.move(syncEngine.watchFolder, from, to, expected),
    trashFile: async (relative, expected) => {
      const file = await native.safePath(syncEngine.watchFolder, relative);
      await native.assertExpected(file, expected);
      await shell.trashItem(file);
    },
    mkdir: async relative => { await fs.mkdir(await native.safePath(syncEngine.watchFolder, relative, true), { recursive: true }); },
    rmdir: async relative => { await fs.rmdir(await native.safePath(syncEngine.watchFolder, relative)); },
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle("sync:" + channel, (event, ...args) => { trusted(event); return handler(...args); });
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 800, minWidth: 800, minHeight: 600, title: "FortesDrive", show: false,
    backgroundColor: "#020617",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  mainWindow.loadURL(WEB_APP_URL + "/desktop");
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://localhost:")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-finish-load", requestSync);
  mainWindow.on("close", event => { if (!app.isQuitting) { event.preventDefault(); mainWindow.hide(); } });
}
async function createTray() {
  const icon = await app.getFileIcon(process.execPath, { size: "small" });
  tray = new Tray(icon);
  tray.setToolTip("FortesDrive");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir FortesDrive", click: () => mainWindow.show() },
    { label: "Escolher diretório raiz", click: () => selectFolder().catch(error => dialog.showErrorBox("FortesDrive", error.message)) },
    { label: "Sincronizar agora", click: requestSync },
    { label: "Iniciar com o Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: "separator" },
    { label: "Sair", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", () => mainWindow.show());
}
app.whenReady().then(async () => {
  syncEngine = new SyncEngine(requestSync);
  registerHandlers(); createWindow(); await createTray();
  if (syncEngine.watchFolder) await syncEngine.start().catch(error => { syncEngine.state.error = error.message; });
});
app.on("activate", () => mainWindow?.show());
app.on("window-all-closed", () => {});
app.on("before-quit", () => { app.isQuitting = true; syncEngine?.stop(); });