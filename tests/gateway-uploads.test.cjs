const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const SECRET = 'local-regression-test-only';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const desktopRoot = path.resolve(__dirname, '..');
const standalone = fs.existsSync(path.join(desktopRoot, 'server/gateway/server.js'));
const root = standalone ? desktopRoot : path.resolve(desktopRoot, '..');
const prefix = standalone ? '' : path.basename(desktopRoot) + '/';
const handlerPattern = /^async function handleUpload\(req, res, key\) \{[\s\S]*?^\}(?=\s*(?:function streamFile|async function handleDownload)\()/m;
const readOptional = async file => {
  try { return await fsp.readFile(path.join(root, file), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
};

async function fixture(source, t) {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'fd-411-'));
  const uploads = new Map();
  const filer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(Number(req.headers['content-length']), body.length, 'filer receives measured multipart length');
    const boundary = req.headers['content-type'].split('boundary=')[1];
    const start = body.indexOf('\r\n\r\n') + 4;
    const end = body.lastIndexOf('\r\n--' + boundary);
    uploads.set(req.url.replace('/fortesdrive/', ''), body.subarray(start, end));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => filer.listen(0, '127.0.0.1', resolve));
  let gateway;
  const sandbox = {
    require: name => name !== 'node:http' ? require(name) : {
      ...http,
      createServer: listener => {
        gateway = http.createServer(listener);
        const listen = gateway.listen.bind(gateway);
        gateway.listen = (port, host, callback) => listen(0, '127.0.0.1', callback);
        return gateway;
      },
    },
    process: { env: { STORAGE_SIGNING_SECRET: SECRET, DATA_DIR: folder, TMP_DIR: path.join(folder, 'tmp'), MAX_UPLOAD_BYTES: '1024', MAX_CONCURRENT_UPLOADS: '1', FILER_URL: `http://127.0.0.1:${filer.address().port}` }, on() {}, exit() { throw new Error('Gateway exited unexpectedly'); } },
    console: { log() {}, error() {} }, Buffer, URL, fetch, AbortSignal, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, sandbox, { filename: 'gateway-under-test.js' });
  if (!gateway.listening) await new Promise(resolve => gateway.once('listening', resolve));
  t.after(async () => {
    await Promise.all([gateway, filer].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    await fsp.rm(folder, { recursive: true, force: true });
  });
  async function send(bytes, { chunked = false, checksum = digest(bytes), signature = true, headers = {}, key = `u/test/${crypto.randomUUID()}` } = {}) {
    const expires = Math.floor(Date.now() / 1000) + 300;
    const sig = signature ? crypto.createHmac('sha256', SECRET).update(`put\n${key}\n${expires}`).digest('hex') : '0'.repeat(64);
    const url = `http://127.0.0.1:${gateway.address().port}/v1/objects/${key}?op=put&expires=${expires}&sig=${sig}`;
    const response = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'PUT', headers: { 'x-fd-sha256': checksum, ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': bytes.length }), ...headers } }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Test upload timed out')));
      if (chunked) req.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      req.end(chunked ? bytes.subarray(Math.floor(bytes.length / 2)) : bytes);
    });
    const saved = source.includes('function uploadToFiler(') ? uploads.get(key) : await fsp.readFile(path.join(folder, key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return { ...response, saved };
  }
  return { send };
}

const variants = [
  ['disk gateway', prefix + 'server/gateway/server.js'],
  ['legacy gateway', 'storage-server/gateway/server.js'],
  ['public legacy gateway', 'public/storage-server/gateway/server.js'],
  ['embedded installer gateway', 'public/instalar-servidor.bat'],
];
for (const [name, file] of variants) test(name, async t => {
  const raw = await readOptional(file);
  if (raw == null) { t.skip('App-only source is not part of a standalone desktop checkout'); return; }
  const source = file.endsWith('.bat') ? raw.match(/\$arquivoGateway = @'\r?\n([\s\S]*?)\r?\n'@/)[1] : raw;
  const { send } = await fixture(source, t);
  for (const chunked of [false, true]) {
    for (const bytes of [Buffer.from('upload pelo tunel'), Buffer.alloc(0)]) await t.test(`${chunked ? 'chunked' : 'content-length'}: ${bytes.length} bytes`, async () => {
      const result = await send(bytes, { chunked });
      assert.equal(result.status, 200);
      assert.equal(result.body.size, bytes.length);
      assert.equal(result.body.checksum, digest(bytes));
      assert.deepEqual(result.saved, bytes);
    });
  }
  await t.test('chunked uploads remain bounded without a length header', async () => {
    const result = await send(Buffer.alloc(1025), { chunked: true });
    assert.equal(result.status, 413);
    assert.equal(result.saved, undefined);
  });
  await t.test('checksum mismatch is rejected without publishing content', async () => {
    const result = await send(Buffer.from('corrompido'), { chunked: true, checksum: digest(Buffer.from('original')) });
    assert.equal(result.status, 422);
    assert.equal(result.saved, undefined);
  });
  await t.test('invalid signatures still cannot upload', async () => {
    const result = await send(Buffer.from('privado'), { chunked: true, signature: false });
    assert.equal(result.status, 401);
    assert.equal(result.saved, undefined);
  });
  await t.test('the upload slot is available after rejected content', async () => {
    assert.equal((await send(Buffer.from('proximo'), { chunked: true })).status, 200);
  });
});

test('repair payload matches every distributed gateway upload handler', async () => {
  const repair = await fsp.readFile(path.join(desktopRoot, 'server/repair-uploads.bat'), 'utf8');
  const payload = repair.match(/\$handler = @'\r?\n([\s\S]*?)\r?\n'@/)[1].trim();
  for (const [, file] of variants) {
    const raw = await readOptional(file);
    if (raw == null) continue;
    const source = file.endsWith('.bat') ? raw.match(/\$arquivoGateway = @'\r?\n([\s\S]*?)\r?\n'@/)[1] : raw;
    assert.equal(source.match(handlerPattern)?.[0].trim(), payload, file);
  }
  assert.match(repair, /compose build --no-cache gateway/);
  assert.match(repair, /compose up -d --no-deps --force-recreate gateway/);
  assert.doesNotMatch(repair, /compose down|remove-orphans|STORAGE_SIGNING_SECRET=/);
});