const Store = require("electron-store");
const chokidar = require("chokidar");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");
const native = require("./native-files");
const { isKnownBrowserCachePath } = require("./browser-cache");
const {ShellStatus} = require("./shell-status");

const yieldLoop = () => new Promise(resolve => setImmediate(resolve));

async function stringifyManifestAsync(manifest) {
  const parts = ['{"files":{'];
  const fileEntries = Object.entries(manifest.files || {});
  for (let i = 0; i < fileEntries.length; i++) {
    const [k, v] = fileEntries[i];
    parts.push((i ? "," : "") + JSON.stringify(k) + ":" + JSON.stringify(v));
    if ((i + 1) % 4000 === 0) await yieldLoop();
  }
  parts.push('},"folders":' + JSON.stringify(manifest.folders || {}));
  parts.push(',"pending":' + JSON.stringify(manifest.pending || {}));
  if (manifest.uploaded && Object.keys(manifest.uploaded).length) {
    parts.push(',"uploaded":' + JSON.stringify(manifest.uploaded));
  }
  if (manifest.completions && Object.keys(manifest.completions).length) {
    parts.push(',"completions":' + JSON.stringify(manifest.completions));
  }
  parts.push("}");
  return parts.join("");
}

class SyncEngine {
  constructor(notify, userDataDir) {
    this.store = new Store({ name: "fortesdrive-native-v2" });
    this.userDataDir = userDataDir || null;
    this.watchFolder = this.store.get("watchFolder", null);
    native.configureIndex(this.indexPath());
    if (this.store.has("folderConfigured")) this.folderConfigured = !!this.store.get("folderConfigured");
    else { this.folderConfigured = !!this.watchFolder; this.store.set("folderConfigured", this.folderConfigured); }
    this.deviceId = this.store.get("deviceId", crypto.randomUUID());
    this.store.set("deviceId", this.deviceId);
    this.notify = notify;
    this.state = { running: false, syncing: false, queue: 0, error: "", lastSync: null };
    this.badges = new ShellStatus();
    this.selfWrites = new Map();
    this.dirtyPaths = new Set();
    this.dirtyOverflow = false;
    this.manifests = new Map();
    this.manifestSaves = new Map();
    // Identifica a raiz ativa: resultados de um ciclo da pasta anterior são
    // descartados em vez de aparecerem como erro na pasta nova.
    this.rootGeneration = 1;
  }
  resetRootState() {
    this.state = {
      running: false,
      syncing: false,
      scanning: false,
      queue: 0,
      error: "",
      watcherError: "",
      badgeError: "",
      historyError: "",
      lastSync: null,
      conflicts: 0,
      syncedCount: 0,
      skipped: 0,
      retriableSkipped: 0,
      ignored: 0,
      ignoredItems: [],
      retryingItems: [],
      issues: [],
      localBytes: 0,
      localFiles: 0,
      cloudBytes: 0,
      cloudFiles: 0,
      pendingUploadBytes: 0,
      pendingUploadFiles: 0,
      pendingHash: 0,
      progress: -1,
      progressMode: "none",
      progressLabel: "",
      userEmail: this.state.userEmail || "",
      online: this.state.online !== false,
      scan: { phase: "idle", total: 0, hashed: 0, pending: 0, totalBytes: 0, hashedBytes: 0, bytesPerSec: 0, walking: false, at: Date.now() },
    };
  }
  relativeFromWatch(absolute) {
    if (!this.watchFolder || typeof absolute !== "string" || !absolute) return null;
    const rootClean = native.stripExtendedPrefix ? native.stripExtendedPrefix(this.watchFolder) : this.watchFolder;
    const targetClean = native.stripExtendedPrefix ? native.stripExtendedPrefix(absolute) : absolute;
    const rel = path.relative(rootClean, targetClean);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
  }
  noteChangedPath(relative) {
    if (typeof relative !== "string" || !relative) return;
    const clean = relative.split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
    if (!clean || clean === ".fortesdrive" || clean.startsWith(".fortesdrive/") || clean.startsWith(".fortesdrive-transfer-")) return;
    if (this.dirtyPaths.size >= 2500) {
      this.dirtyOverflow = true;
      this.dirtyPaths.clear();
      return;
    }
    this.dirtyPaths.add(clean);
  }
  async setWatchFolder(folder) {
    if (this.state.syncing) throw new Error("Aguarde a sincronização terminar antes de trocar a pasta");
    const canonical = await fs.realpath(folder);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error("Selecione um diretório");
    await this.stop();
    this.rootGeneration++;
    this.watchFolder = canonical;
    this.completedScan = null;
    this.dirtyPaths.clear();
    this.dirtyOverflow = false;
    this.selfWrites.clear();
    this.scanning = null;
    this.bgScanning = null;
    this.resetRootState();
    // Descarta árvore, resumos e diretórios verificados da pasta anterior: sem
    // isso a pasta nova herdava caminhos e erros da antiga.
    native.resetRoot?.();
    this.store.set("watchFolder", canonical);
    native.configureIndex(this.indexPath());
    this.folderConfigured = true;
    this.store.set("folderConfigured", true);
    await this.start();
  }
  async start() {
    if (!this.watchFolder || !this.folderConfigured) return;
    if (!this.timer) this.timer = setInterval(() => {
      this.start().catch(error => { this.state.error = error.message; });
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
        awaitWriteFinish: { stabilityThreshold: 450, pollInterval: 120 },
      });
      this.watcher = watcher;
      this.state.running = true;
      watcher.on("all", (event, absolute) => {
        if (this.watcher !== watcher) return;
        const rel = this.relativeFromWatch(absolute);
        if (rel && isKnownBrowserCachePath(rel)) return;
        this.badges.dirty(absolute);
        if (rel) this.noteChangedPath(rel);
        if (this.isSelfWrite(absolute)) return;
        this.completedScan = null;
        if (!this.debounce) this.debounce = setTimeout(() => {
          this.debounce = null;
          this.notify();
        }, 800);
      }).on("ready", () => {
        if (this.watcher !== watcher) return;
        this.state.watcherError = "";
        this.notify();
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
    await this.bgScanning?.catch(() => {});
    await Promise.allSettled([this.flushManifests(), native.flushIndex?.()]);
    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.close();
    await this.closing;
  }
  getStatus() { return { ...this.state, machineRole: this.store.get("machineRole", "client"), nativeStreaming: true, watchFolder: this.watchFolder, folderConfigured: this.folderConfigured, deviceId: this.deviceId, rootGeneration: this.rootGeneration }; }
  markSelfWrite(relative) {
    if (typeof relative !== "string" || !relative) return;
    this.noteChangedPath(relative);
    const key = this.selfKey(relative);
    this.selfWrites.set(key, Date.now());
    if (this.selfWrites.size > 20000) {
      const limit = Date.now() - 120000;
      for (const [item, at] of this.selfWrites) if (at < limit) this.selfWrites.delete(item);
    }
  }
  selfKey(relative) { return process.platform === "win32" ? relative.toLowerCase() : relative; }
  isSelfWrite(absolute) {
    const relative = this.relativeFromWatch(absolute);
    if (!relative) return false;
    const at = this.selfWrites.get(this.selfKey(relative));
    if (!at) return false;
    if (Date.now() - at > 120000) { this.selfWrites.delete(this.selfKey(relative)); return false; }
    return true;
  }
  indexPath() {
    if (!this.userDataDir || !this.watchFolder) return null;
    const digest = crypto.createHash("sha256").update(this.watchFolder.toLowerCase()).digest("hex").slice(0, 16);
    return path.join(this.userDataDir, "scan-index-" + digest + ".json");
  }
  manifestFilePath(key) {
    if (!this.userDataDir) return null;
    return path.join(this.userDataDir, "manifests", key + ".json");
  }
  manifestKey(userId) {
    if (typeof userId !== "string" || !userId || userId.length > 100 || !this.watchFolder) throw new Error("Conta e pasta são obrigatórias");
    return "manifest_" + crypto.createHash("sha256").update(userId + "\0" + this.watchFolder).digest("hex");
  }
  checkFolderOwner(userId) {
    const rootKey = "owner_" + crypto.createHash("sha256").update(this.watchFolder).digest("hex");
    const owner = this.store.get(rootKey);
    if (owner && owner !== userId) throw new Error("Esta pasta pertence a outra conta FortesDrive. Selecione outra pasta para evitar misturar dados.");
    if (owner !== userId) this.store.set(rootKey, userId);
  }
  async loadManifestObject(userId) {
    const key = this.manifestKey(userId);
    this.checkFolderOwner(userId);
    if (this.manifests.has(key)) return this.manifests.get(key);
    const file = this.manifestFilePath(key);
    if (file) {
      try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        const normalized = { files: parsed?.files || {}, folders: parsed?.folders || {}, pending: parsed?.pending || {}, ...(parsed?.uploaded ? { uploaded: parsed.uploaded } : {}), ...(parsed?.completions ? { completions: parsed.completions } : {}) };
        this.manifests.set(key, normalized);
        return normalized;
      } catch (e) {
        if (e.code !== "ENOENT") console.warn("Manifesto inválido, recuperando backup:", e.message);
      }
    }
    const legacy = this.store.get(key, { files: {}, folders: {}, pending: {} });
    const normalized = { files: legacy?.files || {}, folders: legacy?.folders || {}, pending: legacy?.pending || {}, ...(legacy?.uploaded ? { uploaded: legacy.uploaded } : {}), ...(legacy?.completions ? { completions: legacy.completions } : {}) };
    this.manifests.set(key, normalized);
    if (file) {
      this.scheduleManifestFlush(key, 50);
      // Remove cópia pesada do electron-store síncrono após migrar para arquivo assíncrono dedicado.
      if (this.store.has(key) && typeof this.store.delete === "function") {
        setImmediate(() => { try { this.store.delete(key); } catch {} });
      }
    }
    return normalized;
  }
  getManifest(userId) {
    return this.loadManifestObject(userId);
  }
  cachedBaselineFiles(userId) {
    if (!userId || !this.watchFolder) return {};
    try {
      const key = this.manifestKey(userId);
      return this.manifests.get(key)?.files || {};
    } catch {
      return {};
    }
  }
  scheduleManifestFlush(key, delayMs = 1200) {
    const file = this.manifestFilePath(key);
    if (!file) {
      const current = this.manifests.get(key);
      if (current) this.store.set(key, current);
      return Promise.resolve();
    }
    let slot = this.manifestSaves.get(key);
    if (!slot) {
      slot = { dirty: 0, saved: 0, timer: null, writing: Promise.resolve() };
      this.manifestSaves.set(key, slot);
    }
    slot.dirty++;
    if (!slot.timer) {
      slot.timer = setTimeout(() => {
        slot.timer = null;
        this.flushSingleManifest(key, slot).catch(() => {});
      }, delayMs);
      slot.timer.unref?.();
    }
    return slot.writing;
  }
  flushSingleManifest(key, slot) {
    slot.writing = slot.writing.catch(() => {}).then(async () => {
      const file = this.manifestFilePath(key);
      if (!file) return;
      while (slot.saved < slot.dirty) {
        const target = slot.dirty;
        const manifest = this.manifests.get(key);
        if (!manifest) { slot.saved = target; break; }
        await fs.mkdir(path.dirname(file), { recursive: true });
        const json = await stringifyManifestAsync(manifest);
        const temp = file + ".tmp";
        await fs.writeFile(temp, json, "utf8");
        await fs.rename(temp, file);
        slot.saved = target;
      }
    });
    return slot.writing;
  }
  async flushManifests() {
    const tasks = [];
    for (const [key, slot] of this.manifestSaves) {
      clearTimeout(slot.timer);
      slot.timer = null;
      tasks.push(this.flushSingleManifest(key, slot));
    }
    await Promise.allSettled(tasks);
  }
  async saveManifest(userId, manifest) {
    const key = this.manifestKey(userId);
    this.checkFolderOwner(userId);
    const normalized = {
      files: manifest?.files || {},
      folders: manifest?.folders || {},
      pending: manifest?.pending || {},
      ...(manifest?.uploaded ? { uploaded: manifest.uploaded } : {}),
      ...(manifest?.completions ? { completions: manifest.completions } : {}),
    };
    this.manifests.set(key, normalized);
    this.scheduleManifestFlush(key, 1200);
    return true;
  }
  async saveManifestPatch(userId, patch) {
    if (!patch || typeof patch !== "object") return true;
    const target = await this.loadManifestObject(userId);
    const key = this.manifestKey(userId);
    const applyMap = (section, setObj, delArr) => {
      if ((!setObj || !Object.keys(setObj).length) && (!Array.isArray(delArr) || !delArr.length)) return;
      target[section] ||= {};
      if (Array.isArray(delArr)) for (const id of delArr) delete target[section][id];
      if (setObj) for (const [id, val] of Object.entries(setObj)) target[section][id] = val;
    };
    applyMap("files", patch.filesSet, patch.filesDelete);
    applyMap("pending", patch.pendingSet, patch.pendingDelete);
    applyMap("uploaded", patch.uploadedSet, patch.uploadedDelete);
    applyMap("completions", patch.completionsSet, patch.completionsDelete);
    if (patch.foldersReplace && typeof patch.foldersReplace === "object") {
      target.folders = patch.foldersReplace;
    } else {
      applyMap("folders", patch.foldersSet, patch.foldersDelete);
    }
    this.scheduleManifestFlush(key, 1200);
    return true;
  }
  pumpBackgroundScan(userId) {
    if (this.bgScanning || this.scanning || !this.watchFolder || !this.state.running) return;
    const folder = this.watchFolder;
    this.bgScanning = (async () => {
      try {
        while (this.state.running && this.watchFolder === folder) {
          const startedAt = this.state.scan?.startedAt || Date.now();
          const baselineFiles = userId ? (await this.loadManifestObject(userId)).files : {};
          const result = await native.scan(folder, baselineFiles, {
            hashBudgetMs: 60000,
            onProgress: ({ total, hashed, pending, totalBytes, hashedBytes, bytesPerSec, walking }) => {
              this.state.scan = { phase: "scanning", total, hashed, pending, totalBytes, hashedBytes, bytesPerSec, walking, startedAt, at: Date.now() };
            },
          });
          this.state.scan = {
            phase: result.complete ? "idle" : "scanning",
            total: result.totalFiles,
            hashed: result.files.length,
            pending: result.pendingHash,
            totalBytes: result.totalBytes,
            hashedBytes: result.hashedBytes,
            bytesPerSec: result.bytesPerSec,
            walking: !result.walked,
            walkMs: result.walkMs,
            ms: Date.now() - startedAt,
            startedAt,
            at: Date.now(),
          };
          if (result.complete) {
            this.dirtyPaths.clear();
            this.dirtyOverflow = false;
            this.completedScan = { folder, result, at: Date.now() };
            this.notify();
            break;
          }
        }
      } catch (error) {
        this.state.scan = { phase: "idle", error: error.message || "A pasta não pôde ser lida" };
      }
    })().finally(() => { this.bgScanning = null; });
  }
  async snapshot(userId, { hashBudgetMs, incremental } = {}) {
    if (!this.watchFolder) throw new Error("Escolha a pasta raiz primeiro");
    if (this.bgScanning) {
      const instant = native.peekScan?.(this.watchFolder);
      if (instant) return instant;
      await this.bgScanning;
    }
    if (incremental && this.completedScan && this.completedScan.folder === this.watchFolder && !this.dirtyPaths.size && !this.dirtyOverflow && Date.now() - this.completedScan.at < 15000) {
      const cached = this.completedScan.result;
      this.completedScan = null;
      return cached;
    }
    if (this.scanning) return this.scanning;
    // Via rápida O(k): com o watcher ativo e a árvore base já carregada, inspeciona
    // apenas os caminhos tocados no disco em poucos milissegundos.
    if (incremental && this.state.running && !this.dirtyOverflow && typeof native.hasCompletedTree === "function" && native.hasCompletedTree(this.watchFolder)) {
      const dirtyBatch = [...this.dirtyPaths];
      this.dirtyPaths.clear();
      this.scanning = (async () => {
        const startedAt = Date.now();
        try {
          const baselineFiles = userId ? (await this.loadManifestObject(userId)).files : {};
          const result = await native.scanIncremental(this.watchFolder, dirtyBatch, baselineFiles);
          this.state.scan = {
            phase: "idle",
            total: result.totalFiles,
            hashed: result.files.length,
            pending: 0,
            totalBytes: result.totalBytes,
            hashedBytes: result.hashedBytes,
            bytesPerSec: result.bytesPerSec,
            walking: false,
            walkMs: result.walkMs,
            ms: Date.now() - startedAt,
            startedAt,
            at: Date.now(),
          };
          return result;
        } catch (error) {
          for (const p of dirtyBatch) this.noteChangedPath(p);
          throw error;
        }
      })().finally(() => { this.scanning = null; });
      return this.scanning;
    }
    const startedAt = Date.now();
    const live = { phase: "scanning", total: 0, hashed: 0, pending: 0, totalBytes: 0, hashedBytes: 0, bytesPerSec: 0, walking: true, startedAt };
    this.state.scan = live;
    this.scanning = (async () => {
      try {
        this.dirtyPaths.clear();
        this.dirtyOverflow = false;
        const baselineFiles = userId ? (await this.loadManifestObject(userId)).files : {};
        const result = await native.scan(this.watchFolder, baselineFiles, {
          hashBudgetMs,
          onProgress: ({ total, hashed, pending, totalBytes, hashedBytes, bytesPerSec, walking }) => {
            live.total = total; live.hashed = hashed; live.pending = pending;
            live.totalBytes = totalBytes; live.hashedBytes = hashedBytes; live.bytesPerSec = bytesPerSec;
            live.walking = walking; live.at = Date.now();
          },
        });
        this.state.scan = {
          phase: result.complete ? "idle" : "scanning",
          total: result.totalFiles,
          hashed: result.files.length,
          pending: result.pendingHash,
          totalBytes: result.totalBytes,
          hashedBytes: result.hashedBytes,
          bytesPerSec: result.bytesPerSec,
          walking: !result.walked,
          walkMs: result.walkMs,
          ms: Date.now() - startedAt,
          startedAt,
          at: Date.now(),
        };
        if (!result.complete && this.state.running) {
          setImmediate(() => this.pumpBackgroundScan(userId));
        }
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