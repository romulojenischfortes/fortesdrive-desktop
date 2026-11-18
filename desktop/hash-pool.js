const { isMainThread, parentPort } = require("node:worker_threads");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const SMALL_FILE_BYTES = 2 * 1024 * 1024;
const STREAM_CHUNK = 4 * 1024 * 1024;

async function computeFileHash(file, size) {
  if (size === 0) {
    return crypto.createHash("sha256").digest("hex");
  }
  if (size != null && size <= SMALL_FILE_BYTES) {
    const buffer = await fs.readFile(file);
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: STREAM_CHUNK })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

if (!isMainThread && parentPort) {
  parentPort.on("message", async ({ id, file, size }) => {
    try {
      const digest = await computeFileHash(file, size);
      const after = await fs.stat(file);
      parentPort.postMessage({
        id,
        ok: true,
        digest,
        after: {
          size: after.size,
          mtimeMs: after.mtimeMs,
          ctimeMs: after.ctimeMs,
          dev: after.dev,
          ino: after.ino,
        },
      });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: error.message || "Falha ao ler arquivo" });
    }
  });
} else {
  const { Worker } = require("node:worker_threads");
  const cpuCount = typeof os.availableParallelism === "function" ? os.availableParallelism() : (os.cpus()?.length || 4);
  const POOL_SIZE = Math.max(2, Math.min(8, cpuCount - 1));
  const MAX_INFLIGHT_PER_WORKER = 4;

  let workers = null;
  let idleTimer = null;
  let nextTaskId = 1;
  const pendingTasks = new Map();
  const taskQueue = [];

  function touchIdle() {
    clearTimeout(idleTimer);
    if (pendingTasks.size === 0 && taskQueue.length === 0) {
      idleTimer = setTimeout(shutdownPool, 30000);
      idleTimer.unref?.();
    }
  }

  function ensureWorkers() {
    if (workers) return workers;
    workers = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      let worker;
      try {
        worker = new Worker(__filename);
      } catch (e) {
        shutdownPool();
        return null;
      }
      const slot = { worker, inflight: 0 };
      worker.on("message", (msg) => {
        slot.inflight = Math.max(0, slot.inflight - 1);
        const task = pendingTasks.get(msg.id);
        if (task) {
          clearTimeout(task.timer);
          pendingTasks.delete(msg.id);
          if (msg.ok) task.resolve({ digest: msg.digest, after: msg.after });
          else task.reject(new Error(msg.error));
        }
        pump();
        touchIdle();
      });
      worker.on("error", () => {
        // Se uma thread falhar inesperadamente, rejeita apenas as tarefas dela e recria sob demanda.
        const idx = workers ? workers.indexOf(slot) : -1;
        if (idx >= 0) workers.splice(idx, 1);
        for (const [id, task] of pendingTasks) {
          if (task.slot === slot) {
            clearTimeout(task.timer);
            pendingTasks.delete(id);
            task.reject(new Error("Thread de verificação reiniciada"));
          }
        }
        if (workers && workers.length === 0) workers = null;
        pump();
      });
      worker.unref?.();
      workers.push(slot);
    }
    return workers;
  }

  function pump() {
    if (!taskQueue.length) return;
    const pool = ensureWorkers();
    if (!pool || !pool.length) {
      while (taskQueue.length) {
        const item = taskQueue.shift();
        runFallback(item);
      }
      return;
    }
    while (taskQueue.length) {
      let best = null;
      for (const slot of pool) {
        if (slot.inflight < MAX_INFLIGHT_PER_WORKER && (!best || slot.inflight < best.inflight)) {
          best = slot;
        }
      }
      if (!best) break;
      const item = taskQueue.shift();
      const id = nextTaskId++;
      best.inflight++;
      const timer = setTimeout(() => {
        if (!pendingTasks.has(id)) return;
        pendingTasks.delete(id);
        best.inflight = Math.max(0, best.inflight - 1);
        const error = new Error("A leitura do arquivo demorou demais");
        error.timeout = true;
        item.reject(error);
        pump();
      }, item.timeoutMs);
      timer.unref?.();
      pendingTasks.set(id, { resolve: item.resolve, reject: item.reject, timer, slot: best });
      best.worker.postMessage({ id, file: item.file, size: item.size });
    }
  }

  async function runFallback({ file, size, timeoutMs, resolve, reject }) {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => {
        const err = new Error("A leitura do arquivo demorou demais");
        err.timeout = true;
        rej(err);
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([
        (async () => {
          const digest = await computeFileHash(file, size);
          const after = await fs.stat(file);
          return {
            digest,
            after: { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, dev: after.dev, ino: after.ino },
          };
        })(),
        timeout,
      ]);
      resolve(result);
    } catch (e) {
      reject(e);
    } finally {
      clearTimeout(timer);
    }
  }

  function hashAndStat(file, size, timeoutMs = 120000) {
    clearTimeout(idleTimer);
    return new Promise((resolve, reject) => {
      taskQueue.push({ file, size, timeoutMs, resolve, reject });
      pump();
    });
  }

  function shutdownPool() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!workers) return;
    const current = workers;
    workers = null;
    for (const slot of current) {
      try { slot.worker.terminate(); } catch (e) {}
    }
  }

  module.exports = { computeFileHash, hashAndStat, shutdownPool, POOL_SIZE };
}