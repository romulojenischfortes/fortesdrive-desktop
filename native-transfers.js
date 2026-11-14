const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const native = require('./native-files');
const MAX_TRANSFER_BYTES = 10 * 1024 * 1024 * 1024;
const agents = { 'https:': new https.Agent({ keepAlive: true, maxSockets: 30 }), 'http:': new http.Agent({ keepAlive: true, maxSockets: 30 }) };

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
    if (Date.now() - last >= 250 || loaded === size) { last = Date.now(); progress?.(loaded, size); }
    callback(null, chunk);
  } });
  stream.bytes = () => loaded;
  return stream;
}
function request(url, method, headers) {
  const transport = url.protocol === 'https:' ? https : http;
  const req = transport.request(url, { method, headers, agent: agents[url.protocol] });
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
  const req = request(url, 'PUT', { 'Content-Type': 'application/octet-stream', 'Content-Length': expected.size, 'x-fd-sha256': expected.checksum, 'ngrok-skip-browser-warning': 'true' });
  const received = new Promise((resolve, reject) => {
    req.once('error', reject);
    req.once('response', response => responseJson(response).then(resolve, reject));
  });
  const sent = pipeline(createReadStream(absolute, { highWaterMark: 256 * 1024 }), counter, req);
  const [body] = await Promise.all([received, sent]).catch(error => { req.destroy(error); throw error; });
  const after = await fs.lstat(absolute), digest = hash.digest('hex');
  if (counter.bytes() !== expected.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || digest !== expected.checksum || body.ok !== true || body.size !== expected.size || body.checksum !== digest) throw new Error('Integridade ou confirmação divergente; o arquivo não foi concluído.');
  return { storageKey: authorization.storageKey, checksum: digest, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, identity: `${after.dev}:${after.ino}` };
}
async function download(root, relative, address, file, expected, progress, allowLocal = false) {
  checkedSize(file.size);
  if (!/^[a-f0-9]{64}$/i.test(file.checksum || '')) throw new Error('Checksum obrigatório para download nativo.');
  const url = target(address, 'get', allowLocal);
  const absolute = await native.safePath(root, relative, true);
  await native.assertExpected(absolute, expected);
  const internalDir = path.join(root, '.fortesdrive');
  const internalStat = await fs.lstat(internalDir).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (internalStat?.isSymbolicLink() || (internalStat && !internalStat.isDirectory())) throw new Error('Diretorio interno inseguro.');
  await fs.mkdir(internalDir, { recursive: true });
  const internal = path.join(internalDir, crypto.randomUUID() + '.tmp');
  const req = request(url, 'GET', { 'ngrok-skip-browser-warning': 'true' });
  try {
    const response = await new Promise((resolve, reject) => { req.once('error', reject); req.once('response', resolve); req.end(); });
    if (response.statusCode !== 200) { response.resume(); throw Object.assign(new Error('Servidor recusou o download.'), { status: response.statusCode }); }
    if (Number(response.headers['content-length']) !== file.size) { response.destroy(); throw new Error('Tamanho divergente no download.'); }
    const hash = crypto.createHash('sha256'), counter = meter(hash, file.size, progress);
    await pipeline(response, counter, createWriteStream(internal, { flags: 'wx', highWaterMark: 256 * 1024 }));
    if (counter.bytes() !== file.size || hash.digest('hex') !== file.checksum) throw new Error('Download incompleto ou corrompido; o arquivo local foi preservado.');
    await native.assertExpected(absolute, expected);
    await fs.rename(internal, absolute);
    const saved = await fs.stat(absolute);
    return { size: saved.size, mtimeMs: saved.mtimeMs, ctimeMs: saved.ctimeMs, identity: `${saved.dev}:${saved.ino}` };
  } finally { req.destroy(); await fs.rm(internal, { force: true }); }
}
module.exports = { upload, download, MAX_TRANSFER_BYTES };