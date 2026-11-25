const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const native = require('./native-files');
const hashPool = require('./hash-pool');
const MAX_TRANSFER_BYTES = 10 * 1024 * 1024 * 1024;
const STREAM_HIGH_WATER_MARK = 4 * 1024 * 1024;
const DIRECT_UPLOAD_BYTES = 2 * 1024 * 1024;
const RANGE_PART_MIN_BYTES = 4 * 1024 * 1024;
const RANGE_THRESHOLD_BYTES = 8 * 1024 * 1024;
const MAX_RANGE_PARTS = 8;
const fastSha256 = typeof crypto.hash === 'function'
  ? buf => crypto.hash('sha256', buf, 'hex')
  : buf => crypto.createHash('sha256').update(buf).digest('hex');
const agents = {
  'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 256, maxFreeSockets: 128, scheduling: 'lifo' }),
  'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 256, maxFreeSockets: 128, scheduling: 'lifo' }),
};
const verifiedInternalDirs = new Map();

function target(address, op, allowLocal = false) {
  const url = new URL(address);
  if ((url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password) throw new Error('Endereço de transferência inválido.');
  if (!/^\/v1\/objects\/u\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(decodeURIComponent(url.pathname)) || url.searchParams.get('op') !== op || !/^[a-f0-9]{64}$/i.test(url.searchParams.get('sig') || '') || Number(url.searchParams.get('expires')) * 1000 < Date.now()) throw new Error('Autorização de transferência inválida ou expirada.');
  return url;
}
function checkedSize(size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRANSFER_BYTES) throw new Error('Arquivo acima do limite de 10 GiB do servidor.');
}
function meter(hash, size, progress) {
  let loaded = 0, last = 0;
  const stream = new Transform({ transform(chunk, encoding, callback) {
    loaded += chunk.length;
    if (loaded > size) return callback(new Error('O tamanho do arquivo mudou durante a transferência.'));
    hash.update(chunk);
    if (Date.now() - last >= 300 || loaded === size) { last = Date.now(); progress?.(loaded, size); }
    callback(null, chunk);
  } });
  stream.bytes = () => loaded;
  return stream;
}
function request(url, method, headers) {
  const transport = url.protocol === 'https:' ? https : http;
  const req = transport.request(url, { method, headers, agent: agents[url.protocol] });
  req.setNoDelay(true);
  req.setTimeout(120000, () => req.destroy(new Error('A transferência ficou sem resposta; o arquivo permanece pendente.')));
  return req;
}
async function responseJson(response) {
  let text = '';
  for await (const chunk of response) {
    text += chunk.toString();
    if (text.length > 32768) throw new Error('Resposta inválida do servidor.');
  }
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('O endereço não respondeu como servidor FortesDrive.'); }
  if (response.statusCode < 200 || response.statusCode >= 300) throw Object.assign(new Error(body.error || 'Envio recusado pelo servidor.'), { status: response.statusCode });
  return body;
}
async function upload(root, relative, authorization, expected, progress, allowLocal = false) {
  checkedSize(expected.size);
  if (!/^[a-f0-9]{64}$/i.test(expected.checksum || '')) throw new Error('Checksum obrigatório.');
  const url = target(authorization.url, 'put', allowLocal);
  const key = decodeURIComponent(url.pathname.slice('/v1/objects/'.length));
  if (authorization.storageKey !== 'seaweed:' + key || (authorization.maxBytes && expected.size > authorization.maxBytes)) throw new Error('Autorização incompatível com o arquivo.');
  const absolute = await native.safePath(root, relative);
  const targetPath = native.nativePath ? native.nativePath(absolute) : absolute;
  const before = await fs.lstat(targetPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.size || (expected.mtimeMs != null && before.mtimeMs !== expected.mtimeMs)) throw new Error('Arquivo alterado antes do envio.');

  // Via expressa para arquivos pequenos/médios (até 2 MiB): leitura em descritor único,
  // SHA-256 nativo one-shot e quadro HTTP único com TCP_NODELAY (zero overhead de streams).
  if (expected.size <= DIRECT_UPLOAD_BYTES) {
    const buf = expected.size === 0 ? Buffer.alloc(0) : await fs.readFile(targetPath);
    const digest = expected.size === 0
      ? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      : fastSha256(buf);
    if (buf.length !== expected.size || digest !== expected.checksum.toLowerCase()) {
      throw new Error('Arquivo alterado antes do envio.');
    }
    const req = request(url, 'PUT', { 'Content-Type': 'application/octet-stream', 'Content-Length': expected.size, 'x-fd-sha256': expected.checksum });
    const body = await new Promise((resolve, reject) => {
      req.once('error', reject);
      req.once('response', response => responseJson(response).then(resolve, reject));
      if (buf.length) req.end(buf);
      else req.end();
    }).catch(error => { req.destroy(error); throw error; });
    progress?.(expected.size, expected.size);
    const after = await fs.lstat(targetPath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || body.ok !== true || body.size !== expected.size || body.checksum !== digest) {
      throw new Error('Integridade ou confirmação divergente; o arquivo não foi concluído.');
    }
    const identity = `${after.dev}:${after.ino}`;
    native.remember?.(root, relative, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, identity, checksum: digest });
    return { storageKey: authorization.storageKey, checksum: digest, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, identity };
  }

  const hash = crypto.createHash('sha256');
  const counter = meter(hash, expected.size, progress);
  const req = request(url, 'PUT', { 'Content-Type': 'application/octet-stream', 'Content-Length': expected.size, 'x-fd-sha256': expected.checksum });
  const received = new Promise((resolve, reject) => {
    req.once('error', reject);
    req.once('response', response => responseJson(response).then(resolve, reject));
  });
  const sent = pipeline(createReadStream(targetPath, { highWaterMark: STREAM_HIGH_WATER_MARK }), counter, req);
  const [body] = await Promise.all([received, sent]).catch(error => { req.destroy(error); throw error; });
  const after = await fs.lstat(targetPath), digest = hash.digest('hex');
  if (counter.bytes() !== expected.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || digest !== expected.checksum.toLowerCase() || body.ok !== true || body.size !== expected.size || body.checksum !== digest) throw new Error('Integridade ou confirmação divergente; o arquivo não foi concluído.');
  const identity = `${after.dev}:${after.ino}`;
  native.remember?.(root, relative, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, identity, checksum: digest });
  return { storageKey: authorization.storageKey, checksum: digest, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, identity };
}

async function writeResponseAtOffset(response, handle, startOffset, expectedLen, onChunk) {
  let offset = startOffset;
  let received = 0;
  for await (const chunk of response) {
    received += chunk.length;
    if (received > expectedLen) throw new Error('Segmento excedeu o tamanho esperado no download.');
    let written = 0;
    while (written < chunk.length) {
      const res = await handle.write(chunk, written, chunk.length - written, offset);
      written += res.bytesWritten;
      offset += res.bytesWritten;
    }
    onChunk?.(chunk.length);
  }
  if (received !== expectedLen) throw new Error('Segmento incompleto no download paralelo.');
}

async function download(root, relative, address, file, expected, progress, allowLocal = false) {
  checkedSize(file.size);
  if (!/^[a-f0-9]{64}$/i.test(file.checksum || '')) throw new Error('Checksum obrigatório para download nativo.');
  const url = target(address, 'get', allowLocal);
  const absolute = await native.safePath(root, relative, true);
  await native.assertExpected(absolute, expected);
  const internalDir = path.join(root, '.fortesdrive');
  if (Date.now() - (verifiedInternalDirs.get(internalDir) || 0) > 10000) {
    const internalStat = await fs.lstat(internalDir).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (internalStat?.isSymbolicLink() || (internalStat && !internalStat.isDirectory())) throw new Error('Diretorio interno inseguro.');
    await fs.mkdir(internalDir, { recursive: true });
    verifiedInternalDirs.set(internalDir, Date.now());
  }
  const total = file.size;
  const targetChecksum = file.checksum.toLowerCase();
  const parts = total >= RANGE_THRESHOLD_BYTES ? Math.min(MAX_RANGE_PARTS, Math.floor(total / RANGE_PART_MIN_BYTES)) : 1;
  const partSize = parts > 1 ? Math.ceil(total / parts) : total;

  // Retomada inteligente por faixas (estilo Google Drive / OneDrive): se uma queda
  // de rede interromper um arquivo grande no meio, os segmentos já gravados em
  // .fortesdrive/partial-*.part são reaproveitados na próxima tentativa e conferidos
  // integralmente por SHA-256 antes do rename atômico.
  const resumeId = parts > 1
    ? crypto.createHash('sha256').update(`${relative}\0${targetChecksum}\0${total}\0${parts}`).digest('hex').slice(0, 24)
    : null;
  const partialDataPath = resumeId ? path.join(internalDir, `partial-${resumeId}.part`) : null;
  const partialMetaPath = resumeId ? path.join(internalDir, `partial-${resumeId}.json`) : null;
  const tempFallbackPath = path.join(internalDir, crypto.randomUUID() + '.tmp');

  let completedSegments = new Set();
  if (resumeId) {
    try {
      const [metaRaw, partStat] = await Promise.all([
        fs.readFile(partialMetaPath, 'utf8'),
        fs.lstat(partialDataPath),
      ]);
      const meta = JSON.parse(metaRaw);
      if (
        !partStat.isSymbolicLink() &&
        partStat.isFile() &&
        partStat.size === total &&
        meta?.checksum === targetChecksum &&
        meta?.size === total &&
        meta?.parts === parts &&
        Array.isArray(meta?.done)
      ) {
        for (const idx of meta.done) {
          if (Number.isInteger(idx) && idx >= 0 && idx < parts) completedSegments.add(idx);
        }
      }
    } catch {
      completedSegments = new Set();
    }
  }

  const missingIndices = [];
  for (let i = 0; i < parts; i++) {
    if (!completedSegments.has(i)) missingIndices.push(i);
  }

  const activeReqs = [];
  let handle = null;
  let keepPartialForResume = false;
  let stagingPath = tempFallbackPath;

  const persistPartialMeta = async () => {
    if (!partialMetaPath) return;
    const tmpMeta = partialMetaPath + '.tmp';
    try {
      await fs.writeFile(tmpMeta, JSON.stringify({ checksum: targetChecksum, size: total, parts, done: [...completedSegments] }), 'utf8');
      await fs.rename(tmpMeta, partialMetaPath);
    } catch {}
  };

  try {
    if (parts > 1 && missingIndices.length === 0) {
      // Todos os segmentos já estavam gravados de uma tentativa quase concluída.
      const cachedDigest = await hashPool.computeFileHash(partialDataPath, total).catch(() => '');
      if (cachedDigest === targetChecksum) {
        stagingPath = partialDataPath;
        progress?.(total, total);
      } else {
        completedSegments.clear();
        for (let i = 0; i < parts; i++) missingIndices.push(i);
      }
    }

    if (missingIndices.length > 0) {
      const firstIdx = missingIndices[0];
      const firstStart = firstIdx * partSize;
      const firstEnd = Math.min(total - 1, firstStart + partSize - 1);
      const firstHeaders = parts > 1 ? { Range: `bytes=${firstStart}-${firstEnd}` } : {};
      const firstReq = request(url, 'GET', firstHeaders);
      activeReqs.push(firstReq);
      const firstRes = await new Promise((resolve, reject) => { firstReq.once('error', reject); firstReq.once('response', resolve); firstReq.end(); });

      if (parts > 1 && firstRes.statusCode === 206) {
        const firstLen = firstEnd - firstStart + 1;
        if (Number(firstRes.headers['content-length']) !== firstLen) { firstRes.destroy(); throw new Error('Tamanho divergente no segmento inicial.'); }
        stagingPath = partialDataPath;
        if (completedSegments.size > 0) {
          handle = await fs.open(stagingPath, 'r+');
        } else {
          await fs.rm(stagingPath, { force: true });
          handle = await fs.open(stagingPath, 'wx+');
          await handle.truncate(total);
        }
        let loadedTotal = 0;
        for (const doneIdx of completedSegments) {
          const s = doneIdx * partSize;
          const e = Math.min(total - 1, s + partSize - 1);
          loadedTotal += e - s + 1;
        }
        let lastProgressAt = 0;
        const reportChunk = delta => {
          loadedTotal += delta;
          const now = Date.now();
          if (now - lastProgressAt >= 200 || loadedTotal === total) { lastProgressAt = now; progress?.(loadedTotal, total); }
        };
        keepPartialForResume = true;
        const tasks = [(async () => {
          await writeResponseAtOffset(firstRes, handle, firstStart, firstLen, reportChunk);
          completedSegments.add(firstIdx);
          await persistPartialMeta();
        })()];
        for (let k = 1; k < missingIndices.length; k++) {
          const segIdx = missingIndices[k];
          const start = segIdx * partSize;
          const end = Math.min(total - 1, start + partSize - 1);
          const segLen = end - start + 1;
          tasks.push((async () => {
            const segReq = request(url, 'GET', { Range: `bytes=${start}-${end}` });
            activeReqs.push(segReq);
            const segRes = await new Promise((resolve, reject) => { segReq.once('error', reject); segReq.once('response', resolve); segReq.end(); });
            if (segRes.statusCode !== 206 || Number(segRes.headers['content-length']) !== segLen) {
              segRes.destroy();
              throw Object.assign(new Error('Falha ao baixar faixa paralela do arquivo.'), { status: segRes.statusCode });
            }
            await writeResponseAtOffset(segRes, handle, start, segLen, reportChunk);
            completedSegments.add(segIdx);
            await persistPartialMeta();
          })());
        }
        await Promise.all(tasks);
        await handle.close(); handle = null;
        let verifiedDigest = await hashPool.computeFileHash(stagingPath, total);
        if (verifiedDigest !== targetChecksum) {
          keepPartialForResume = false;
          await fs.rm(partialMetaPath, { force: true }).catch(() => {});
          throw new Error('Download incompleto ou corrompido; o arquivo local foi preservado.');
        }
        keepPartialForResume = false;
      } else {
        let streamRes = firstRes;
        // Se tínhamos pedido um segmento do meio na retomada mas o servidor não aceita Range,
        // refazemos o pedido completo do byte 0.
        if (parts > 1 && firstIdx > 0) {
          firstRes.destroy();
          const fullReq = request(url, 'GET', {});
          activeReqs.push(fullReq);
          streamRes = await new Promise((resolve, reject) => { fullReq.once('error', reject); fullReq.once('response', resolve); fullReq.end(); });
        }
        if (streamRes.statusCode !== 200) { streamRes.resume(); throw Object.assign(new Error('Servidor recusou o download.'), { status: streamRes.statusCode }); }
        if (Number(streamRes.headers['content-length']) !== total) { streamRes.destroy(); throw new Error('Tamanho divergente no download.'); }
        stagingPath = tempFallbackPath;
        const hash = crypto.createHash('sha256'), counter = meter(hash, total, progress);
        await pipeline(streamRes, counter, createWriteStream(stagingPath, { flags: 'wx', highWaterMark: STREAM_HIGH_WATER_MARK }));
        if (counter.bytes() !== total || hash.digest('hex') !== targetChecksum) throw new Error('Download incompleto ou corrompido; o arquivo local foi preservado.');
      }
    }

    const destNative = native.nativePath ? native.nativePath(absolute) : absolute;
    await native.assertExpected(destNative, expected);
    await fs.rename(stagingPath, destNative);
    if (partialMetaPath) await fs.rm(partialMetaPath, { force: true }).catch(() => {});
    const saved = await fs.stat(destNative);
    const identity = `${saved.dev}:${saved.ino}`;
    native.remember?.(root, relative, { size: saved.size, mtimeMs: saved.mtimeMs, ctimeMs: saved.ctimeMs, identity, checksum: targetChecksum });
    return { size: saved.size, mtimeMs: saved.mtimeMs, ctimeMs: saved.ctimeMs, identity };
  } finally {
    if (handle) await handle.close().catch(() => {});
    for (const r of activeReqs) r.destroy();
    await fs.rm(tempFallbackPath, { force: true }).catch(() => {});
    if (!keepPartialForResume && partialDataPath) {
      await fs.rm(partialDataPath, { force: true }).catch(() => {});
      await fs.rm(partialMetaPath, { force: true }).catch(() => {});
    }
  }
}
module.exports = { upload, download, MAX_TRANSFER_BYTES };