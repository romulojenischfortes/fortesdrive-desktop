const Store = require("electron-store");
const chokidar = require("chokidar");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");
const native = require("./native-files");
const {ShellStatus} = require("./shell-status");

class SyncEngine {
  constructor(notify, userDataDir) {
    this.store = new Store({ name: "fortesdrive-native-v2" });
    this.userDataDir = userDataDir || null;
    this.watchFolder = this.store.get("watchFolder", null);
    native.configureIndex(this.indexPath());
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
    this.selfWrites = new Map();
  }
  async setWatchFolder(folder) {
    if (this.state.syncing) throw new Error("Aguarde a sincronização terminar antes de trocar a pasta");
    const canonical = await fs.realpath(folder);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error("Selecione um diretório");
    await this.stop();
    this.watchFolder = canonical;
    this.store.set("watchFolder", canonical);
    // Cada pasta tem o seu índice de resumos: trocar de pasta não reaproveita
    // resumo de outro conteúdo.
    native.configureIndex(this.indexPath());
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
      // Uma passagem em andamento já enxerga o que mudou: avisar de novo a cada
      // 30 segundos fazia a passagem ser interrompida antes de os arquivos já
      // lidos começarem a subir, e a pasta nunca saía da leitura.
      if (!this.state.syncing) this.notify();
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
        // Arquivo que o próprio aplicativo acabou de gravar (download, edição ou
        // exclusão feita pela sincronização) não é alteração do usuário: avisar a
        // fila por causa dele reiniciava a passagem a cada arquivo baixado, e uma
        // pasta com milhares de arquivos nunca terminava de sincronizar.
        if (this.isSelfWrite(absolute)) return;
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
  /** Marca um arquivo gravado pela própria sincronização (caminho relativo). */
  markSelfWrite(relative) {
    if (typeof relative !== "string" || !relative) return;
    const key = this.selfKey(relative);
    this.selfWrites.set(key, Date.now());
    if (this.selfWrites.size > 20000) {
      const limit = Date.now() - 120000;
      for (const [item, at] of this.selfWrites) if (at < limit) this.selfWrites.delete(item);
    }
  }
  selfKey(relative) { return process.platform === "win32" ? relative.toLowerCase() : relative; }
  /** O evento do monitor veio de uma gravação nossa? Vale por 2 minutos. */
  isSelfWrite(absolute) {
    if (!this.watchFolder) return false;
    const relative = path.relative(this.watchFolder, absolute).split(path.sep).join("/");
    const at = this.selfWrites.get(this.selfKey(relative));
    if (!at) return false;
    if (Date.now() - at > 120000) { this.selfWrites.delete(this.selfKey(relative)); return false; }
    return true;
  }
  /**
   * Arquivo do índice de resumos da pasta atual, ao lado dos dados do
   * aplicativo. É o que permite reabrir o cliente e saber em segundos o que
   * mudou, sem resumir de novo dezenas de milhares de arquivos.
   */
  indexPath() {
    if (!this.userDataDir || !this.watchFolder) return null;
    const digest = crypto.createHash("sha256").update(this.watchFolder.toLowerCase()).digest("hex").slice(0, 16);
    return path.join(this.userDataDir, "scan-index-" + digest + ".json");
  }
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
  async snapshot(userId, { hashBudgetMs } = {}) {
    if (!this.watchFolder) throw new Error("Escolha a pasta raiz primeiro");
    // Uma varredura em andamento é reaproveitada: com a pasta grande, uma nova
    // passagem pedida enquanto a anterior ainda lê abriria duas leituras do mesmo
    // disco e nenhuma terminaria antes do próximo pedido.
    if (this.scanning) return this.scanning;
    // O andamento da leitura vai para o estado do programa: o painel mostra
    // quantos arquivos já foram lidos e quantos faltam resumir, em vez de deixar
    // "Sincronizando" sem nenhum número enquanto a pasta é percorrida.
    const startedAt = Date.now();
    const live = { phase: "scanning", total: 0, hashed: 0, pending: 0, walking: true, startedAt };
    this.state.scan = live;
    this.scanning = (async () => {
      try {
        const result = await native.scan(this.watchFolder, userId ? this.getManifest(userId).files : {}, {
          // A árvore da pasta é percorrida de uma vez (segundos) e o resumo do
          // conteúdo avança em lotes por passagem: o que já está pronto começa a
          // subir imediatamente, em vez de a pasta inteira esperar o último byte.
          hashBudgetMs,
          onProgress: ({ total, hashed, pending, walking }) => { live.total = total; live.hashed = hashed; live.pending = pending; live.walking = walking; live.at = Date.now(); },
        });
        this.state.scan = { phase: result.complete ? "idle" : "scanning", total: result.totalFiles, hashed: result.files.length, pending: result.pendingHash, walking: !result.walked, walkMs: result.walkMs, ms: Date.now() - startedAt, at: Date.now() };
        return result;
      } catch (error) {
        this.state.scan = { phase: "idle", error: error.message || "A pasta não pôde ser lida", ms: Date.now() - startedAt };
        throw error;
      }
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }
}
module.exports = { SyncEngine };