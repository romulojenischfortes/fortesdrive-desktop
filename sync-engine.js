const Store = require("electron-store");
const chokidar = require("chokidar");
const crypto = require("crypto");
const fs = require("fs/promises");
const native = require("./native-files");
const {ShellStatus} = require("./shell-status");

class SyncEngine {
  constructor(notify) {
    this.store = new Store({ name: "fortesdrive-native-v2" });
    this.watchFolder = this.store.get("watchFolder", null);
    // A pasta padrão da primeira execução já existe, mas ninguém escolheu onde
    // ela fica nem como se chama: enquanto isso não é confirmado, o aplicativo
    // abre o assistente de pasta. Uma instalação antiga já sincronizando conta
    // como confirmada e não é interrompida.
    if (this.store.has("folderConfigured")) this.folderConfigured = !!this.store.get("folderConfigured");
    else { this.folderConfigured = !!this.watchFolder; this.store.set("folderConfigured", this.folderConfigured); }
    this.deviceId = this.store.get("deviceId", crypto.randomUUID());
    this.store.set("deviceId", this.deviceId);
    this.notify = notify;
    this.state = { running: false, syncing: false, queue: 0, error: "", lastSync: null };
    this.badges = new ShellStatus();
  }
  async setWatchFolder(folder) {
    if (this.state.syncing) throw new Error("Aguarde a sincronização terminar antes de trocar a pasta");
    const canonical = await fs.realpath(folder);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error("Selecione um diretório");
    await this.stop();
    this.watchFolder = canonical;
    this.store.set("watchFolder", canonical);
    // Pasta escolhida explicitamente (local + nome) não precisa mais do assistente.
    this.folderConfigured = true;
    this.store.set("folderConfigured", true);
    await this.start();
  }
  async start() {
    if (!this.watchFolder || !this.folderConfigured) return;
    // O pulso continua mesmo se o disco ou o monitor falhar. Não depende da janela.
    if (!this.timer) this.timer = setInterval(() => {
      this.start().catch(error => { this.state.error = error.message; });
      this.notify();
    }, 30000);
    if (this.state.running || this.starting) return this.starting;
    this.starting = (async () => {
      await this.closing;
      await fs.access(this.watchFolder);
      await this.badges.start(this.watchFolder).catch(error => { this.state.badgeError = error.message; });
      const watcher = chokidar.watch(this.watchFolder, {
        ignored: /(^|[/\\])(?:\.fortesdrive([/\\]|$)|\.fortesdrive-transfer-)/,
        ignoreInitial: true, followSymlinks: false,
        usePolling: !!this.pollingFallback, interval: 1000, binaryInterval: 1000,
        awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
      });
      this.watcher = watcher;
      this.state.running = true;
      watcher.on("all", (event, absolute) => {
        if (this.watcher !== watcher) return;
        this.badges.dirty(absolute);
        // Janela limitada: uma cópia contínua não adia o aviso indefinidamente.
        if (!this.debounce) this.debounce = setTimeout(() => {
          this.debounce = null;
          this.notify();
        }, 800);
      }).on("ready", () => {
        if (this.watcher !== watcher) return;
        this.state.watcherError = "";
        this.notify(); // Inclui arquivos criados durante a leitura inicial.
      }).on("error", error => {
        if (this.watcher !== watcher) return;
        this.state.watcherError = "Monitoramento da pasta: " + error.message;
        this.state.running = false;
        this.watcher = null;
        this.pollingFallback = true;
        this.closing = watcher.close().catch(closeError => { this.state.watcherError = closeError.message; });
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.start().catch(startError => { this.state.error = startError.message; });
        }, 3000);
        this.notify();
      });
      this.notify();
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
  async stop() {
    clearInterval(this.timer); clearTimeout(this.debounce); clearTimeout(this.restartTimer);
    this.timer = this.debounce = this.restartTimer = null;
    await this.starting?.catch(() => {});
    this.state.running = false;
    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.close();
    await this.closing;
  }
  getStatus() { return { ...this.state, machineRole: this.store.get("machineRole", "client"), nativeStreaming: true, watchFolder: this.watchFolder, folderConfigured: this.folderConfigured, deviceId: this.deviceId }; }
  manifestKey(userId) {
    if (typeof userId !== "string" || !userId || userId.length > 100 || !this.watchFolder) throw new Error("Conta e pasta são obrigatórias");
    return "manifest_" + crypto.createHash("sha256").update(userId + "\0" + this.watchFolder).digest("hex");
  }
  getManifest(userId) {
    const key = this.manifestKey(userId);
    const rootKey = "owner_" + crypto.createHash("sha256").update(this.watchFolder).digest("hex");
    const owner = this.store.get(rootKey);
    if (owner && owner !== userId) throw new Error("Esta pasta pertence a outra conta FortesDrive. Selecione outra pasta para evitar misturar dados.");
    this.store.set(rootKey, userId);
    return this.store.get(key, { files: {}, folders: {}, pending: {} });
  }
  saveManifest(userId, manifest) { this.store.set(this.manifestKey(userId), manifest); }
  async snapshot(userId) {
    if (!this.watchFolder) throw new Error("Escolha a pasta raiz primeiro");
    return native.scan(this.watchFolder, userId ? this.getManifest(userId).files : {});
  }
}
module.exports = { SyncEngine };