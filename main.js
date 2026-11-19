const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Tray, Notification, nativeImage, net, powerMonitor } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const { SyncEngine } = require("./sync-engine");
const { applySetupConfiguration } = require("./setup-handoff");
const { TransferHistory } = require("./transfer-history");
const native = require("./native-files");
const transfers = require("./native-transfers");
const { DesktopUpdater } = require("./updater");
const { ServerTunnel } = require("./server-tunnel");
const { createInstallHealth } = require("./install-health");
// As marcas no Explorador são um recurso acessório (extensão registrada pelo
// instalador). Se o módulo que cuida delas não estiver disponível, o aplicativo
// inicia normalmente e somente as marcas ficam indisponíveis.
let badgeSetup;
try {
  badgeSetup = require("./badge-setup");
} catch (error) {
  console.warn("Marcas do Explorador indisponíveis: " + error.message);
  const unavailable = async () => ({ supported: false, unavailable: true, reason: error.message });
  badgeSetup = { readBadgeSetup: unavailable, repairBadges: unavailable };
}
const WEB_APP_URL = process.env.NODE_ENV === "development" ? "http://localhost:5173" : "https://fortesdrive.base44.app";
// Aberto pelo inicio automatico do Windows: fica na bandeja, sem janela na
// tela, para o servidor e o tunel subirem em segundo plano.
const START_HIDDEN = process.argv.includes("--background");
let mainWindow, tray, syncEngine, updater, transferHistory, serverTunnel, installHealth;
let onlineTimer, trayTimer;
let lastOnlineState = null;
if (process.platform === "win32") app.setAppUserModelId("com.fortesdrive.desktop");
const notificationQueue = [];
const visibleNotifications = new Set();
let notificationTimer = null;

// --- Notificações nativas do sistema operacional ---
function notify(title, body, urgency, onClick) {
  if (!Notification.isSupported()) return;
  notificationQueue.push({ title, body, urgency, onClick });
  if (notificationTimer) return;
  const showNext = () => {
    const item = notificationQueue.shift();
    if (!item) { notificationTimer = null; return; }
    try {
      const n = new Notification({ title: item.title, body: item.body, silent: false, urgency: item.urgency || "normal", icon: path.join(__dirname, "build", "icon.png") });
      visibleNotifications.add(n);
      n.on("close", () => visibleNotifications.delete(n));
      n.on("click", () => { mainWindow?.show(); mainWindow?.focus(); item.onClick?.(); });
      n.show();
    } catch (error) { console.warn("Notificação indisponível:", error.message); }
    notificationTimer = setTimeout(showNext, 2500);
  };
  showNext();
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
      // createFromBitmap espera BGRA: gravar R primeiro trocava as cores do
      // ícone (o verde da sincronização aparecia oliva na bandeja).
      if (dist < size / 2 - 1) {
        buf[off] = b; buf[off + 1] = g; buf[off + 2] = r; buf[off + 3] = 255;
      } else if (dist < size / 2) {
        buf[off] = b; buf[off + 1] = g; buf[off + 2] = r; buf[off + 3] = 128;
      } else {
        buf[off + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTrayState(state) {
  if (!tray || tray.isDestroyed()) return;
  const icon = makeTrayIcon(state);
  // Um ícone vazio apagaria a bandeja: nesse caso o desenho anterior continua.
  if (!icon.isEmpty()) tray.setImage(icon);
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
app.on("second-instance", async () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show(); mainWindow?.focus();
  if (!syncEngine) return;
  await refreshSetupConfiguration();
  requestSync();
});

async function refreshSetupConfiguration() {
  try {
    const directory = app.getPath("userData");
    await applySetupConfiguration(syncEngine, path.join(directory, "fortesdrive-setup.json"));
    await applySetupConfiguration(syncEngine, path.join(directory, "fortesdrive-setup.ini"));
  } catch (error) {
    syncEngine.state.error = "Não foi possível aplicar a pasta do configurador: " + error.message;
  }
}

// A pasta escolhida no instalador também chega na linha de comando
// (--sync-folder=C:\...): é o que faz o cliente abrir já sincronizando a pasta
// inteira, mesmo quando o arquivo de configuração não foi aplicado antes.
function installFolderArgument() {
  const prefix = "--sync-folder=";
  const argument = process.argv.find(value => value.startsWith(prefix));
  if (!argument) return "";
  return argument.slice(prefix.length).trim().replace(/^"(.*)"$/, "$1").trim();
}

function trusted(event) {
  if (event.sender !== mainWindow?.webContents || event.senderFrame?.parent || new URL(event.senderFrame.url).origin !== new URL(WEB_APP_URL).origin) throw new Error("Solicitação não autorizada");
}
function requestSync() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sync:requested");
}
async function selectFolder() {
  const options = { properties: ["openDirectory", "createDirectory"], title: "Escolha a pasta de download e sincronização do FortesDrive" };
  const result = await (mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options));
  if (result.canceled) return null;
  await syncEngine.setWatchFolder(result.filePaths[0]);
  return syncEngine.watchFolder;
}

// Onde a pasta dos documentos da nuvem vai ser criada. Devolve só o local
// escolhido, sem configurar nada: o aplicativo mostra o caminho completo
// (local + nome da pasta) antes de o usuário confirmar.
async function chooseFolderParent() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "Escolha onde criar a pasta dos documentos da nuvem",
    defaultPath: syncEngine.watchFolder ? path.dirname(syncEngine.watchFolder) : app.getPath("documents"),
  });
  if (result.canceled) return null;
  return result.filePaths[0];
}

// Cria (ou reaproveita) a pasta escolhida — local + nome — e passa a sincronizar
// nela. É o mesmo caminho na primeira configuração e na troca posterior; a pasta
// anterior continua intacta no computador.
async function useFolder(parent, name) {
  const clean = String(name || "").trim();
  if (!clean || clean.length > 120) throw new Error("Informe o nome da pasta.");
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(clean) || /[. ]$/.test(clean) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) {
    throw new Error('Nome de pasta inválido. Não use < > : " / \\ | ? * e não termine com ponto.');
  }
  if (typeof parent !== "string" || !parent.trim()) throw new Error("Escolha onde a pasta será criada.");
  const target = path.join(parent, clean);
  await fs.mkdir(target, { recursive: true });
  await syncEngine.setWatchFolder(target);
  return syncEngine.getStatus();
}
// Abre o assistente de pasta dentro do próprio cliente: mostra a janela na
// tela de configuração e pede ao aplicativo que abra o diálogo (local + nome).
// Vem da bandeja do sistema e também do primeiro passo depois de instalar.
function openFolderSetup() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  const ask = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sync:openFolderSetup");
  };
  if (mainWindow.webContents.getURL().includes("/desktop")) { ask(); return; }
  mainWindow.webContents.once("did-finish-load", ask);
  mainWindow.loadURL(WEB_APP_URL + "/desktop");
}

function registerHandlers() {
  const handlers = {
    selectFolder: selectFolder,
    chooseFolderParent: chooseFolderParent,
    useFolder: useFolder,
    // badgeStates informa ao aplicativo web quais marcas do Explorador este
    // instalador sabe desenhar, para recursos novos (cadeado) não quebrarem
    // clientes antigos que ainda não foram atualizados.
    getStatus: async () => {
      await refreshSetupConfiguration();
      return { ...syncEngine.getStatus(), updating: updater?.state.status === "installing", appVersion: app.getVersion(), badgeStates: ["synced", "pending", "error", "locked"] };
    },
    getServerTunnel: () => serverTunnel.getStatus(),
    setServerTunnelEnabled: enabled => serverTunnel.setEnabled(enabled),
    startServerTunnel: () => serverTunnel.startTunnel(),
    stopServerTunnel: () => serverTunnel.stopTunnel(),
    restartServerTunnel: () => serverTunnel.restartTunnel(),
    diagnoseServerTunnel: () => serverTunnel.diagnose(),
    chooseServerRoot: async () => {
      const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"], title: "Pasta raiz do servidor FortesDrive", defaultPath: serverTunnel.getStatus().serverRoot });
      return result.canceled ? null : serverTunnel.setServerRoot(result.filePaths[0]);
    },
    getUpdateStatus: () => updater.getStatus(),
    // Verificação pós-atualização: versão em execução, componentes que o
    // instalador precisa ter entregado e o registro da última versão aprovada.
    getInstallationHealth: () => installHealth.report(),
    confirmInstallation: version => installHealth.confirm(version),
    getBadgeSetup: () => badgeSetup.readBadgeSetup(),
    repairBadges: () => badgeSetup.repairBadges({ app }),
    checkForUpdates: () => updater.check(),
    downloadUpdate: () => updater.download(),
    installUpdate: () => updater.install(),
    launchInstaller: () => updater.launchInstaller(),
    verifyUpdateSignature: () => updater.verifyUpdateSignature(),
    syncNow: () => { requestSync(); return true; },
    rendererReady: () => { requestSync(); return true; },
    snapshot: (userId, options) => syncEngine.snapshot(userId, options),
    uploadFileStream: (relative, authorization, expected) => transfers.upload(syncEngine.watchFolder, relative, authorization, expected, (loaded, total) => mainWindow?.webContents.send("sync:transferProgress", { path: relative, direction: "upload", loaded, total })),
    downloadFileStream: async (relative, url, file, expected) => {
      const saved = await transfers.download(syncEngine.watchFolder, relative, url, file, expected, (loaded, total) => mainWindow?.webContents.send("sync:transferProgress", { path: relative, direction: "download", loaded, total }));
      // O arquivo que acabou de descer não é uma alteração do usuário.
      syncEngine.markSelfWrite(relative);
      return saved;
    },
    publishSyncStatus: async payload => {
      try { await syncEngine.badges.publish(payload); syncEngine.state.badgeError = ""; }
      catch (error) { syncEngine.state.badgeError = error.message; }
    },
    getManifest: userId => syncEngine.getManifest(userId),
    saveManifest: (userId, manifest) => syncEngine.saveManifest(userId, manifest),
    recordTransferCompletion: async (userId, event) => {
      const result = await transferHistory.add(userId, event);
      if (result.added) {
        const item = result.item;
        let mtimeMs = event.mtimeMs;
        if (mtimeMs == null) {
          const absolute = await native.safePath(syncEngine.watchFolder, item.path);
          mtimeMs = (await fs.stat(absolute)).mtimeMs;
        }
        await syncEngine.badges.confirm(item.path, { size: event.size, mtimeMs }).catch(error => { syncEngine.state.badgeError = error.message; });
        const now = Date.now();
        if (!syncEngine.lastCompletionToastAt || now - syncEngine.lastCompletionToastAt >= 4000) {
          syncEngine.lastCompletionToastAt = now;
          notify(item.direction === "download" ? "FortesDrive — Download concluído" : "FortesDrive — Arquivo sincronizado", item.path, "normal", () => {
            native.safePath(syncEngine.watchFolder, item.path).then(abs => shell.showItemInFolder(abs)).catch(() => {});
          });
        }
        mainWindow?.webContents.send("sync:transferCompleted");
      }
      return true;
    },
    recordTransferCompletions: async (userId, events) => {
      if (!Array.isArray(events) || !events.length) return true;
      const results = await transferHistory.addBatch(userId, events);
      let addedCount = 0;
      let lastItem = null;
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (!res?.added) continue;
        addedCount++;
        lastItem = res.item;
        const ev = events[i];
        let mtimeMs = ev.mtimeMs;
        if (mtimeMs == null) {
          try {
            const abs = await native.safePath(syncEngine.watchFolder, res.item.path);
            mtimeMs = (await fs.stat(abs)).mtimeMs;
          } catch {}
        }
        if (mtimeMs != null) {
          await syncEngine.badges.confirm(res.item.path, { size: ev.size, mtimeMs }).catch(error => { syncEngine.state.badgeError = error.message; });
        }
      }
      if (addedCount > 0) {
        const now = Date.now();
        if (!syncEngine.lastCompletionToastAt || now - syncEngine.lastCompletionToastAt >= 4000) {
          syncEngine.lastCompletionToastAt = now;
          if (addedCount === 1 && lastItem) {
            notify(lastItem.direction === "download" ? "FortesDrive — Download concluído" : "FortesDrive — Arquivo sincronizado", lastItem.path, "normal", () => {
              native.safePath(syncEngine.watchFolder, lastItem.path).then(abs => shell.showItemInFolder(abs)).catch(() => {});
            });
          } else {
            notify("FortesDrive — Arquivos sincronizados", `${addedCount} arquivos concluídos neste lote.`, "normal");
          }
        }
        mainWindow?.webContents.send("sync:transferCompleted");
      }
      return true;
    },
    getTransferHistory: (userId, options) => transferHistory.query(userId, options),
    revealTransferHistoryItem: async (userId, id) => {
      const item = await transferHistory.find(userId, id);
      const absolute = await native.safePath(syncEngine.watchFolder, item.path);
      await fs.access(absolute);
      shell.showItemInFolder(absolute);
    },
    exportTransferHistory: async (userId, options) => {
      const result = await transferHistory.csv(userId, options);
      const choice = await dialog.showSaveDialog(mainWindow, { title: "Salvar histórico de arquivos", defaultPath: "FortesDrive-historico.csv", filters: [{ name: "Planilha CSV", extensions: ["csv"] }] });
      if (choice.canceled) return { saved: false };
      await fs.writeFile(choice.filePath, result.content, "utf8");
      return { saved: true, count: result.count };
    },
    setState: async state => {
      const allowed = ["syncing", "queue", "error", "lastSync", "userEmail", "online", "conflicts", "syncedCount", "skipped", "issues", "progress", "progressMode", "progressLabel", "localBytes", "localFiles", "cloudBytes", "cloudFiles", "pendingUploadBytes", "pendingUploadFiles", "historyError"];
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
    writeFile: async (relative, bytes, hash, expected) => {
      const saved = await native.write(syncEngine.watchFolder, relative, bytes, hash, expected);
      syncEngine.markSelfWrite(relative);
      return saved;
    },
    moveFile: async (from, to, expected) => {
      const saved = await native.move(syncEngine.watchFolder, from, to, expected);
      syncEngine.markSelfWrite(from); syncEngine.markSelfWrite(to);
      return saved;
    },
    trashFile: async (relative, expected) => {
      const file = await native.safePath(syncEngine.watchFolder, relative);
      await native.assertExpected(file, expected);
      await shell.trashItem(file);
      syncEngine.markSelfWrite(relative);
    },
    mkdir: async relative => {
      await fs.mkdir(await native.safePath(syncEngine.watchFolder, relative, true), { recursive: true });
      syncEngine.markSelfWrite(relative);
    },
    rmdir: async relative => {
      await fs.rmdir(await native.safePath(syncEngine.watchFolder, relative));
      syncEngine.markSelfWrite(relative);
    },
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
  mainWindow.once("ready-to-show", () => { if (!START_HIDDEN) mainWindow.show(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://localhost:")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-finish-load", requestSync);
  // O monitor nativo não pode ficar enviando avisos para uma página encerrada.
  let reloadTimer;
  const recoverPage = () => {
    if (app.isQuitting || mainWindow.isDestroyed() || reloadTimer) return;
    syncEngine.state.syncing = false;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (!app.isQuitting && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    }, 5000);
  };
  mainWindow.webContents.on("render-process-gone", recoverPage);
  mainWindow.webContents.on("did-fail-load", (event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) recoverPage();
  });
  mainWindow.on("closed", () => clearTimeout(reloadTimer));
  mainWindow.on("close", event => {
    if (app.isQuitting) return;
    // Sem bandeja, esconder a janela deixaria o aplicativo invisível e sem como
    // ser reaberto: nesse caso ele fecha de verdade.
    if (!tray || tray.isDestroyed()) { app.isQuitting = true; app.quit(); return; }
    event.preventDefault(); mainWindow.hide();
  });
}
// Estado do tunel no topo do menu da bandeja, regenerado a cada mudanca.
const TUNNEL_LABELS = { stopped: "Túnel: parado", starting: "Túnel: iniciando...", online: "Túnel: conectado", reconnecting: "Túnel: reconectando...", error: "Túnel: erro" };

// Abrir a janela a partir da bandeja nunca pode falhar por ela ter sido fechada.
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Início com o Windows: o instalador deixa o atalho na pasta Iniciar (nos dois
// modos) e o túnel também registra o início automático. O menu mostra as duas
// formas juntas e desliga as duas de uma vez, sempre abrindo escondido.
function startupShortcutPath() {
  const base = process.env.APPDATA;
  return base ? path.join(base, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "FortesDrive.lnk") : "";
}
function startsWithWindows() {
  if (app.getLoginItemSettings().openAtLogin) return true;
  const shortcut = startupShortcutPath();
  return !!shortcut && fsSync.existsSync(shortcut);
}
function setStartWithWindows(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ["--background"] : [] });
  const shortcut = startupShortcutPath();
  if (!enabled && shortcut) { try { fsSync.unlinkSync(shortcut); } catch (error) { /* já removido */ } }
}

function trayTemplate() {
  const tunnel = serverTunnel?.getStatus();
  const items = [{ label: TUNNEL_LABELS[tunnel?.status] || TUNNEL_LABELS.stopped, enabled: false }];
  if (tunnel?.url) items.push({ label: tunnel.url, click: () => shell.openExternal(tunnel.url) });
  return [
    ...items,
    { type: "separator" },
    { label: "Abrir FortesDrive", click: showWindow },
    { label: "Histórico de arquivos", click: () => { mainWindow.show(); mainWindow.focus(); mainWindow.loadURL(WEB_APP_URL + "/desktop#desktop-transfer-history"); } },
    { label: "Pasta dos documentos da nuvem", click: openFolderSetup },
    { label: "Sincronizar agora", click: requestSync },
    { label: "Reiniciar túnel do servidor", click: () => serverTunnel.restart().catch(error => dialog.showErrorBox("FortesDrive", error.message)) },
    { label: "Verificar atualizações", click: () => { mainWindow.show(); updater.check().catch(error => dialog.showErrorBox("FortesDrive", error.message)); } },
    { label: "Iniciar com o Windows", type: "checkbox", checked: startsWithWindows(), click: item => setStartWithWindows(item.checked) },
    { type: "separator" },
    { label: "Sair", click: () => { app.isQuitting = true; app.quit(); } },
  ];
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}

// Ícone da bandeja: vem do próprio pacote, sem depender do cache de ícones do
// Windows — quando o getFileIcon voltava vazio, a bandeja ficava sem ícone.
function appTrayIcon() {
  const bundled = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png"));
  return bundled.isEmpty() ? null : bundled.resize({ width: 16, height: 16 });
}

// Monitora conexão de internet no processo principal. Fica fora da criação da
// bandeja porque a bandeja pode ser recriada; um monitor por criação acumularia
// avisos repetidos de conexão.
function startOnlineMonitor() {
  if (onlineTimer) return;
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
  onlineTimer = setInterval(checkOnline, 5000);
  lastOnlineState = net.isOnline();
}

// Ícone garantido para a bandeja: o do pacote, depois o do executável e, por
// último, o desenho de estado. Antes, quando o ícone do pacote não era lido, a
// criação desistia e a bandeja ficava sem nada — nenhum ícone aparecia.
async function trayIcon() {
  const bundled = appTrayIcon();
  if (bundled) return bundled;
  const fromExe = await app.getFileIcon(process.execPath, { size: "small" }).catch(() => null);
  if (fromExe && !fromExe.isEmpty()) return fromExe;
  return makeTrayIcon("synced");
}

async function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  tray = null;
  const icon = await trayIcon();
  try {
    tray = new Tray(icon);
  } catch (error) {
    console.error("Bandeja: não foi possível criar o ícone: " + error.message);
    return null;
  }
  tray.setToolTip("FortesDrive");
  refreshTrayMenu();
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  startOnlineMonitor();
  return tray;
}

// O ícone da bandeja some sem aviso quando o Windows recria a barra de tarefas
// (troca de sessão, bloqueio/desbloqueio, reinício do Explorador). Sem bandeja,
// o aplicativo não tem como ser reaberto: este pulso devolve o ícone sozinho.
function watchTray() {
  if (trayTimer) return;
  trayTimer = setInterval(() => {
    if (tray && !tray.isDestroyed()) return;
    tray = null;
    createTray().catch(error => console.error("Bandeja: " + error.message));
  }, 20000);
  const reinstall = () => {
    if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; }
    createTray().catch(error => console.error("Bandeja: " + error.message));
  };
  powerMonitor.on("unlock-screen", reinstall);
  powerMonitor.on("resume", reinstall);
}
app.whenReady().then(async () => {
  // Primeiro aplica a escolha feita no instalador, sem criar uma pasta padrao.
  syncEngine = new SyncEngine(requestSync, app.getPath("userData"));
  transferHistory = new TransferHistory(app.getPath("userData"), syncEngine);
  serverTunnel = new ServerTunnel({ userDataDir: app.getPath("userData"), app, onState: refreshTrayMenu });
  // A bandeja é o único caminho de volta para o aplicativo: ela nasce antes de
  // qualquer passo que possa esperar o usuário (escolha de pasta) ou falhar.
  await createTray();
  watchTray();
  await serverTunnel.init();
  installHealth = createInstallHealth({ app });
  await installHealth.load();
  await refreshSetupConfiguration();
  // A pasta vinda do instalador é aplicada aqui, antes da janela web, e some
  // quando já é a mesma pasta configurada.
  const folderArgument = installFolderArgument();
  if (folderArgument) {
    const current = syncEngine.watchFolder;
    const same = current && path.resolve(current).toLowerCase() === path.resolve(folderArgument).toLowerCase();
    if (!same) await syncEngine.setWatchFolder(folderArgument).catch(error => { syncEngine.state.error = "Não foi possível usar a pasta escolhida no instalador: " + error.message; });
  }
  // Se outro perfil do Windows abrir o app, exige a propria escolha nativa
  // antes da janela web, do login e de qualquer transferencia.
  if (!syncEngine.folderConfigured) {
    if (!await selectFolder()) { app.quit(); return; }
  }
  const { autoUpdater } = require("electron-updater");
  updater = new DesktopUpdater(autoUpdater, app, syncEngine, notify);
  // A versão baixada é a que precisa estar rodando no próximo início: é com ela
  // que a verificação pós-atualização confirma se a instalação foi aplicada.
  autoUpdater.on("update-downloaded", info => {
    installHealth.expectUpdate(info.version).catch(error => console.warn("Registro da atualização: " + error.message));
  });
  registerHandlers(); createWindow();
  if (syncEngine.watchFolder) await syncEngine.start().catch(error => { syncEngine.state.error = error.message; });
  await createTray();
  refreshTrayMenu();
  updater.start();
  // Modo servidor: na primeira abertura depois da instalação o túnel sobe junto,
  // sem ninguém precisar ligar a subida automática na mão. Uma escolha já salva
  // pelo usuário (ligada ou desligada) é sempre respeitada.
  const serverRole = syncEngine.store.get("machineRole") === "server";
  if (serverRole && !serverTunnel.configured && !serverTunnel.getStatus().enabled) {
    serverTunnel.setEnabled(true).catch(error => console.error("Túnel:", error.message));
  }
  // Servidor e tunel sobem sozinhos quando o inicio automatico esta ligado.
  if (serverTunnel.getStatus().enabled) serverTunnel.start().catch(error => console.error("Túnel:", error.message));
});
app.on("activate", () => mainWindow?.show());
app.on("window-all-closed", () => {});
let installingOnExit = false;
// Encerramento da sessão do Windows: fecha sem tentar instalar a atualização.
app.on("session-end", () => { app.isQuitting = true; installingOnExit = true; serverTunnel?.stop(); });
app.on("before-quit", event => {
  app.isQuitting = true;
  // Fechar o aplicativo com uma atualização já baixada aplica a nova versão
  // sozinho, pelo mesmo caminho com permissão de administrador do botão
  // "Reiniciar e instalar".
  serverTunnel?.stop();
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