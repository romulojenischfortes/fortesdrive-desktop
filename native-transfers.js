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
const RANGE_PART_MIN_BYTES = 8 * 1024 * 1024;
const RANGE_THRESHOLD_BYTES = 24 * 1024 * 1024;
const MAX_RANGE_PARTS = 6;
const agents = {
  'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 45000, maxSockets: 192, maxFreeSockets: 96, scheduling: 'lifo' }),
  'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 45000, maxSockets: 192, maxFreeSockets: 96, scheduling: 'lifo' }),
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
  const before = await fs.lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.size || (expected.mtimeMs != null && before.mtimeMs !== expected.mtimeMs)) throw new Error('Arquivo alterado antes do envio.');
  const hash = crypto.createHash('sha256');
  const counter = meter(hash, expected.size, progress);
  const req = request(url, 'PUT', { 'Content-Type': 'application/octet-stream', 'Content-Length': expected.size, 'x-fd-sha256': expected.checksum });
  const received = new Promise((resolve, reject) => {
    req.once('error', reject);
    req.once('response', response => responseJson(response).then(resolve, reject));
  });
  const sent = pipeline(createReadStream(absolute, { highWaterMark: STREAM_HIGH_WATER_MARK }), counter, req);
  const [body] = await Promise.all([received, sent]).catch(error => { req.destroy(error); throw error; });
  const after = await fs.lstat(absolute), digest = hash.digest('hex');
  if (counter.bytes() !== expected.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || digest !== expected.checksum || body.ok !== true || body.size !== expected.size || body.checksum !== digest) throw new Error('Integridade ou confirmação divergente; o arquivo não foi concluído.');
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
  const internal = path.join(internalDir, crypto.randomUUID() + '.tmp');
  const total = file.size;
  const parts = total >= RANGE_THRESHOLD_BYTES ? Math.min(MAX_RANGE_PARTS, Math.floor(total / RANGE_PART_MIN_BYTES)) : 1;
  const partSize = parts > 1 ? Math.ceil(total / parts) : total;
  const firstHeaders = parts > 1 ? { Range: `bytes=0-${partSize - 1}` } : {};
  const firstReq = request(url, 'GET', firstHeaders);
  const activeReqs = [firstReq];
  let handle = null;
  try {
    const firstRes = await new Promise((resolve, reject) => { firstReq.once('error', reject); firstReq.once('response', resolve); firstReq.end(); });
    if (parts > 1 && firstRes.statusCode === 206) {
      const firstLen = Math.min(partSize, total);
      if (Number(firstRes.headers['content-length']) !== firstLen) { firstRes.destroy(); throw new Error('Tamanho divergente no segmento inicial.'); }
      handle = await fs.open(internal, 'wx+');
      await handle.truncate(total);
      let loadedTotal = 0, lastProgressAt = 0;
      const reportChunk = delta => {
        loadedTotal += delta;
        const now = Date.now();
        if (now - lastProgressAt >= 200 || loadedTotal === total) { lastProgressAt = now; progress?.(loadedTotal, total); }
      };
      const tasks = [writeResponseAtOffset(firstRes, handle, 0, firstLen, reportChunk)];
      for (let i = 1; i < parts; i++) {
        const start = i * partSize;
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
        })());
      }
      await Promise.all(tasks);
      await handle.close(); handle = null;
      const verifiedDigest = await hashPool.computeFileHash(internal, total);
      if (verifiedDigest !== file.checksum) throw new Error('Download incompleto ou corrompido; o arquivo local foi preservado.');
    } else {
      if (firstRes.statusCode !== 200) { firstRes.resume(); throw Object.assign(new Error('Servidor recusou o download.'), { status: firstRes.statusCode }); }
      if (Number(firstRes.headers['content-length']) !== total) { firstRes.destroy(); throw new Error('Tamanho divergente no download.'); }
      const hash = crypto.createHash('sha256'), counter = meter(hash, total, progress);
      await pipeline(firstRes, counter, createWriteStream(internal, { flags: 'wx', highWaterMark: STREAM_HIGH_WATER_MARK }));
      if (counter.bytes() !== total || hash.digest('hex') !== file.checksum) throw new Error('Download incompleto ou corrompido; o arquivo local foi preservado.');
    }
    await native.assertExpected(absolute, expected);
    await fs.rename(internal, absolute);
    const saved = await fs.stat(absolute);
    const identity = `${saved.dev}:${saved.ino}`;
    native.remember?.(root, relative, { size: saved.size, mtimeMs: saved.mtimeMs, ctimeMs: saved.ctimeMs, identity, checksum: file.checksum });
    return { size: saved.size, mtimeMs: saved.mtimeMs, ctimeMs: saved.ctimeMs, identity };
  } finally {
    if (handle) await handle.close().catch(() => {});
    for (const r of activeReqs) r.destroy();
    await fs.rm(internal, { force: true });
  }
}
module.exports = { upload, download, MAX_TRANSFER_BYTES };