const Store = require("electron-store");
const chokidar = require("chokidar");
const crypto = require("crypto");
const fs = require("fs/promises");
const native = require("./native-files");

class SyncEngine {
  constructor(notify) {
    this.store = new Store({ name: "fortesdrive-native-v2" });
    this.watchFolder = this.store.get("watchFolder", null);
    this.deviceId = this.store.get("deviceId", crypto.randomUUID());
    this.store.set("deviceId", this.deviceId);
    this.notify = notify;
    this.state = { running: false, syncing: false, queue: 0, error: "", lastSync: null };
  }
  async setWatchFolder(folder) {
    if (this.state.syncing) throw new Error("Aguarde a sincronização terminar antes de trocar a pasta");
    const canonical = await fs.realpath(folder);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error("Selecione um diretório");
    await this.stop();
    this.watchFolder = canonical;
    this.store.set("watchFolder", canonical);
    await this.start();
  }
  async start() {
    if (!this.watchFolder) return;
    await fs.access(this.watchFolder);
    this.state.running = true;
    this.watcher = chokidar.watch(this.watchFolder, {
      ignored: /(^|[/\\])\.fortesdrive([/\\]|$)/,
      ignoreInitial: true, followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
    });
    this.watcher.on("all", () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.notify(), 800);
    }).on("error", error => { this.state.error = error.message; });
    this.timer = setInterval(() => this.notify(), 10000);
    this.notify();
  }
  async stop() {
    this.state.running = false;
    clearInterval(this.timer); clearTimeout(this.debounce);
    await this.watcher?.close();
  }
  getStatus() { return { ...this.state, watchFolder: this.watchFolder, deviceId: this.deviceId }; }
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
  async snapshot() {
    if (!this.watchFolder) throw new Error("Escolha a pasta raiz primeiro");
    return native.scan(this.watchFolder);
  }
}
module.exports = { SyncEngine };