const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Tray, Notification, nativeImage, net } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { SyncEngine } = require("./sync-engine");
const native = require("./native-files");
const { DesktopUpdater } = require("./updater");
const badgeSetup = require("./badge-setup");
const WEB_APP_URL = process.env.NODE_ENV === "development" ? "http://localhost:5173" : "https://fortesdrive.base44.app";
let mainWindow, tray, syncEngine, updater;
let lastOnlineState = null;

// --- Notificações nativas do sistema operacional ---
function notify(title, body, urgency) {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, silent: false, urgency: urgency || "normal" });
      n.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
      n.show();
    }
  } catch (e) { /* notificações podem não estar disponíveis */ }
}

// --- Ícones de estado do tray (gerados em memória, sem arquivos externos) ---
function makeTrayIcon(state) {
  // state: "synced" | "syncing" | "offline" | "conflict"
  const colors = {
    synced: [16, 185, 129],   // emerald
    syncing: [34, 211, 238],  // cyan
    offline: [245, 158, 11], // amber
    conflict: [244, 63, 94],  // rose
  };
  const [r, g, b] = colors[state] || colors.synced;
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x - size / 2, cy = y - size / 2;
      const dist = Math.sqrt(cx * cx + cy * cy);
      const off = (y * size + x) * 4;
      if (dist < size / 2 - 1) {
        buf[off] = r; buf[off + 1] = g; buf[off + 2] = b; buf[off + 3] = 255;
      } else if (dist < size / 2) {
        buf[off] = r; buf[off + 1] = g; buf[off + 2] = b; buf[off + 3] = 128;
      } else {
        buf[off + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTrayState(state) {
  if (!tray) return;
  const icon = makeTrayIcon(state);
  tray.setImage(icon);
  const labels = { synced: "FortesDrive — Sincronizado", syncing: "FortesDrive — Sincronizando...", offline: "FortesDrive — Offline (fila pendente)", conflict: "FortesDrive — Conflito detectado" };
  const detail = syncEngine?.state?.progressLabel;
  tray.setToolTip((labels[state] || "FortesDrive") + (detail ? " — " + detail : ""));
}

// Barra de progresso na barra de tarefas do Windows: acompanha a transferência
// mesmo com a janela minimizada ou atrás de outras. 2 = indeterminado,
// -1 = limpa a barra.
function applyWindowsProgress() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { progress, progressMode } = syncEngine.state;
  if (typeof progress !== "number" || progress < 0) {
    mainWindow.setProgressBar(-1, { mode: "none" });
    return;
  }
  mainWindow.setProgressBar(progress, { mode: progressMode || "normal" });
}
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
    getStatus: () => ({ ...syncEngine.getStatus(), updating: updater?.state.status === "installing", appVersion: app.getVersion() }),
    getUpdateStatus: () => updater.getStatus(),
    getBadgeSetup: () => badgeSetup.readBadgeSetup(),
    repairBadges: () => badgeSetup.repairBadges({ app }),
    checkForUpdates: () => updater.check(),
    downloadUpdate: () => updater.download(),
    installUpdate: () => updater.install(),
    launchInstaller: () => updater.launchInstaller(),
    verifyUpdateSignature: () => updater.verifyUpdateSignature(),
    syncNow: () => { requestSync(); return true; },
    snapshot: () => syncEngine.snapshot(),
    publishSyncStatus: async payload => {
      try { await syncEngine.badges.publish(payload); syncEngine.state.badgeError = ""; }
      catch (error) { syncEngine.state.badgeError = error.message; }
    },
    getManifest: userId => syncEngine.getManifest(userId),
    saveManifest: (userId, manifest) => syncEngine.saveManifest(userId, manifest),
    setState: async state => {
      const allowed = ["syncing", "queue", "error", "lastSync", "userEmail", "online", "conflicts", "syncedCount", "skipped", "issues", "progress", "progressMode", "progressLabel"];
      for (const key of allowed) if (Object.hasOwn(state, key)) syncEngine.state[key] = state[key];
      applyWindowsProgress();
      // Atualiza o ícone do tray com base no estado
      const current = syncEngine.state;
      if (current.conflicts > 0 || current.error) updateTrayState("conflict");
      else if (current.syncing) updateTrayState("syncing");
      else if (current.online === false || current.skipped > 0) updateTrayState("offline");
      else updateTrayState("synced");
      if (state.error) await syncEngine.badges.publish({entries: [...syncEngine.badges.entries.values()], state: state.online === false ? "pending" : "error"}).catch(error => { syncEngine.state.badgeError = error.message; });
    },
    notify: (params) => {
      notify(params.title, params.body, params.urgency);
      return true;
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
    { label: "Verificar atualizações", click: () => { mainWindow.show(); updater.check().catch(error => dialog.showErrorBox("FortesDrive", error.message)); } },
    { label: "Iniciar com o Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: "separator" },
    { label: "Sair", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", () => mainWindow.show());

  // Monitora conexão de internet no processo principal
  const checkOnline = () => {
    const online = net.isOnline();
    if (lastOnlineState === false && online) {
      notify("FortesDrive — Conexão restabelecida", "Sincronizando alterações pendentes...");
      updateTrayState("syncing");
      requestSync();
    } else if (lastOnlineState === true && !online) {
      notify("FortesDrive — Sem conexão", "Você está offline. As edições continuam locais e sincronizam automaticamente quando a internet voltar.");
      updateTrayState("offline");
    }
    lastOnlineState = online;
  };
  setInterval(checkOnline, 5000);
  lastOnlineState = net.isOnline();
}
app.whenReady().then(async () => {
  syncEngine = new SyncEngine(requestSync);
  const { autoUpdater } = require("electron-updater");
  updater = new DesktopUpdater(autoUpdater, app, syncEngine, notify);
  registerHandlers(); createWindow();
  if (syncEngine.watchFolder) await syncEngine.start().catch(error => { syncEngine.state.error = error.message; });
  await createTray();
  updater.start();
});
app.on("activate", () => mainWindow?.show());
app.on("window-all-closed", () => {});
let installingOnExit = false;
// Encerramento da sessão do Windows: fecha sem tentar instalar a atualização.
app.on("session-end", () => { app.isQuitting = true; installingOnExit = true; });
app.on("before-quit", event => {
  app.isQuitting = true;
  // Fechar o aplicativo com uma atualização já baixada aplica a nova versão
  // sozinho, pelo mesmo caminho com permissão de administrador do botão
  // "Reiniciar e instalar".
  if (installingOnExit || !updater?.hasPendingUpdate()) { syncEngine?.stop(); return; }
  event.preventDefault();
  installingOnExit = true;
  notify("FortesDrive — Atualizando", "Aplicando a nova versão. Autorize a permissão do Windows se ela for solicitada.");
  updater.install()
    .catch(error => console.error("Falha ao aplicar a atualização ao sair:", error.message))
    .finally(() => {
      // Se o instalador não assumiu o encerramento, o aplicativo fecha de qualquer forma.
      if (updater.getStatus().status !== "installing") setTimeout(() => app.quit(), 500).unref?.();
    });
});