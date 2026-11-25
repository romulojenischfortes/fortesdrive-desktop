const { isMainThread, parentPort } = require("node:worker_threads");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const SMALL_FILE_BYTES = 16 * 1024 * 1024;
const STREAM_CHUNK = 4 * 1024 * 1024;
const BATCH_WORKER_CONCURRENCY = 24;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const fastSha256 = typeof crypto.hash === "function"
  ? (buf) => crypto.hash("sha256", buf, "hex")
  : (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Buffer reutilizável por leitura sequencial grande: evita alocar/coletar
// centenas de buffers de 8 MB na heap V8 durante a verificação de vídeos/ISOs.
let reusableReadBuffer = null;
let reusableBusy = false;

async function readLargeHandleSha256(handle) {
  const ownBuffer = reusableBusy ? Buffer.allocUnsafe(STREAM_CHUNK) : (reusableReadBuffer ||= Buffer.allocUnsafe(STREAM_CHUNK));
  const claimedShared = !reusableBusy && ownBuffer === reusableReadBuffer;
  if (claimedShared) reusableBusy = true;
  try {
    const hash = crypto.createHash("sha256");
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(ownBuffer, 0, ownBuffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      hash.update(bytesRead === ownBuffer.length ? ownBuffer : ownBuffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    if (claimedShared) reusableBusy = false;
  }
}

async function computeFileHash(file, size) {
  if (size === 0) return EMPTY_SHA256;
  if (size != null && size <= SMALL_FILE_BYTES) {
    const buffer = await fs.readFile(file);
    return fastSha256(buffer);
  }
  const handle = await fs.open(file, "r");
  try {
    return await readLargeHandleSha256(handle);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function hashOneFile(file, size) {
  if (size === 0) {
    const after = await fs.stat(file);
    return {
      digest: EMPTY_SHA256,
      after: { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, dev: after.dev, ino: after.ino },
    };
  }
  // Abre o descritor uma única vez para ler os bytes e consultar o metadado pós-leitura
  // sem reabrir o caminho no NTFS.
  const handle = await fs.open(file, "r");
  try {
    let digest;
    if (size != null && size <= SMALL_FILE_BYTES) {
      const buffer = await handle.readFile();
      digest = fastSha256(buffer);
    } else {
      digest = await readLargeHandleSha256(handle);
    }
    const after = await handle.stat();
    return {
      digest,
      after: {
        size: after.size,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
        dev: after.dev,
        ino: after.ino,
      },
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

if (!isMainThread && parentPort) {
  parentPort.on("message", async (msg) => {
    const { id, batch, file, size } = msg;
    if (Array.isArray(batch)) {
      const results = new Array(batch.length);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(BATCH_WORKER_CONCURRENCY, batch.length) }, async () => {
        while (cursor < batch.length) {
          const idx = cursor++;
          const entry = batch[idx];
          try {
            const res = await hashOneFile(entry.file, entry.size);
            results[idx] = { ok: true, digest: res.digest, after: res.after };
          } catch (error) {
            results[idx] = { ok: false, error: error.message || "Falha ao ler arquivo" };
          }
        }
      }));
      parentPort.postMessage({ id, ok: true, results });
      return;
    }
    try {
      const res = await hashOneFile(file, size);
      parentPort.postMessage({ id, ok: true, digest: res.digest, after: res.after });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: error.message || "Falha ao ler arquivo" });
    }
  });
} else {
  const { Worker } = require("node:worker_threads");
  const cpuCount = typeof os.availableParallelism === "function" ? os.availableParallelism() : (os.cpus()?.length || 4);
  const POOL_SIZE = Math.max(6, Math.min(32, cpuCount));
  const MAX_INFLIGHT_PER_WORKER = 32;

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
        if (slot.inflight === 0) worker.unref?.();
        const task = pendingTasks.get(msg.id);
        if (task) {
          clearTimeout(task.timer);
          pendingTasks.delete(msg.id);
          if (msg.ok) task.resolve(msg.results ? msg.results : { digest: msg.digest, after: msg.after });
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
      if (best.inflight === 0) best.worker.ref?.();
      best.inflight++;
      const timer = setTimeout(() => {
        if (!pendingTasks.has(id)) return;
        pendingTasks.delete(id);
        best.inflight = Math.max(0, best.inflight - 1);
        if (best.inflight === 0) best.worker.unref?.();
        const error = new Error("A leitura do arquivo demorou demais");
        error.timeout = true;
        item.reject(error);
        pump();
      }, item.timeoutMs);
      pendingTasks.set(id, { resolve: item.resolve, reject: item.reject, timer, slot: best });
      if (item.batch) best.worker.postMessage({ id, batch: item.batch });
      else best.worker.postMessage({ id, file: item.file, size: item.size });
    }
  }

  async function runFallback({ file, size, batch, timeoutMs, resolve, reject }) {
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
        batch
          ? Promise.all(batch.map(async (entry) => {
              try {
                const res = await hashOneFile(entry.file, entry.size);
                return { ok: true, digest: res.digest, after: res.after };
              } catch (error) {
                return { ok: false, error: error.message || "Falha ao ler arquivo" };
              }
            }))
          : hashOneFile(file, size),
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

  function hashBatch(batch, timeoutMs = 120000) {
    clearTimeout(idleTimer);
    return new Promise((resolve, reject) => {
      taskQueue.push({ batch, timeoutMs, resolve, reject });
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

  module.exports = { computeFileHash, hashAndStat, hashBatch, shutdownPool, POOL_SIZE, SMALL_FILE_BYTES };
}