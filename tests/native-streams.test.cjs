const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const native = require('../native-files');
const transfers = require('../native-transfers');
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fortes-stream-'));
  const server = http.createServer(async (req, res) => {
    if (req.method === 'PUT') {
      const hash = crypto.createHash('sha256'); let size = 0;
      for await (const chunk of req) { size += chunk.length; hash.update(chunk); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, size, checksum: hash.digest('hex') }));
    } else {
      const stat = await fs.stat(path.join(root, 'large.bin'));
      res.writeHead(200, { 'Content-Length': stat.size });
      createReadStream(path.join(root, 'large.bin')).pipe(res);
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = op => `http://127.0.0.1:${server.address().port}/v1/objects/u/test/file?op=${op}&expires=${Math.floor(Date.now()/1000)+300}&sig=${'a'.repeat(64)}`;
  try { await run(root, url); }
  finally { server.closeAllConnections(); server.close(); await fs.rm(root, { recursive: true, force: true }); }
}
test('arquivos acima de 100 MB entram na varredura e sobem e descem em fluxo', () => fixture(async (root, url) => {
  const handle = await fs.open(path.join(root, 'large.bin'), 'w');
  await handle.truncate(101 * 1024 * 1024); await handle.close();
  const scan = await native.scan(root), local = scan.files[0];
  assert.equal(scan.skipped.length, 0);
  assert.equal(local.size, 101 * 1024 * 1024);
  let progress = 0;
  const sent = await transfers.upload(root, local.path, {url:url('put'),storageKey:'seaweed:u/test/file'}, local, loaded=>{progress=loaded;}, true);
  assert.equal(sent.size, local.size); assert.equal(progress, local.size);
  const saved = await transfers.download(root, 'sub/copy.bin', url('get'), local, null, null, true);
  assert.equal(saved.size, local.size);
  assert.equal(await native.checksum(path.join(root, 'sub/copy.bin')), local.checksum);
}));
test('arquivos vazios sao enviados e a autorizacao nao pode trocar de destino', () => fixture(async (root,url) => {
  await fs.writeFile(path.join(root,'empty.txt'),'');
  const local=(await native.scan(root)).files[0];
  assert.equal((await transfers.upload(root,local.path,{url:url('put'),storageKey:'seaweed:u/test/file'},local,null,true)).size,0);
  await assert.rejects(transfers.upload(root,local.path,{url:url('put'),storageKey:'seaweed:u/test/another'},local,null,true),/incompatível/);
}));