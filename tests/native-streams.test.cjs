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
async function fixture(run, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fortes-stream-'));
  const pieces = new Map(), seen = [];
  let dropped = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'PUT') {
      const address = new URL(req.url, 'http://local');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; chunks.push(chunk); }
      if (size > 8 * 1024 * 1024) { res.writeHead(413); return res.end(JSON.stringify({ error: 'Corpo acima do limite do tunel simulado.' })); }
      res.setHeader('Content-Type', 'application/json');
      if (address.searchParams.has('part')) {
        const part = Number(address.searchParams.get('part')), parts = Number(address.searchParams.get('parts'));
        seen.push({ part, size }); pieces.set(part, Buffer.concat(chunks));
        if (options.dropPart === part && !dropped) { dropped = true; req.socket.destroy(); return; }
        if (options.changeOnLast && part === parts - 1) await fs.appendFile(path.join(root, 'large.bin'), 'editado');
        return res.end(JSON.stringify({ ok: true, partial: true, part, parts }));
      }
      const hash = crypto.createHash('sha256');
      if (address.searchParams.has('finalize')) {
        seen.push({ finalize: true, size }); size = 0;
        for (let part = 0; part < Number(address.searchParams.get('parts')); part++) {
          if (!pieces.has(part)) { res.writeHead(409); return res.end(JSON.stringify({ error: 'Faltou bloco.' })); }
          size += pieces.get(part).length; hash.update(pieces.get(part));
        }
      } else { for (const chunk of chunks) hash.update(chunk); }
      res.end(JSON.stringify({ ok: true, size, checksum: options.badChecksum ? '0'.repeat(64) : hash.digest('hex') }));
    } else {
      const stat = await fs.stat(path.join(root, 'large.bin'));
      res.writeHead(200, { 'Content-Length': stat.size });
      createReadStream(path.join(root, 'large.bin')).pipe(res);
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = op => `http://127.0.0.1:${server.address().port}/v1/objects/u/test/file?op=${op}&expires=${Math.floor(Date.now()/1000)+300}&sig=${'a'.repeat(64)}`;
  try { await run(root, url, seen); }
  finally { server.closeAllConnections(); server.close(); native.shutdownPool?.(); await fs.rm(root, { recursive: true, force: true }); }
}
test('arquivos acima de 100 MB entram na varredura e sobem em blocos limitados e descem em fluxo', () => fixture(async (root, url, seen) => {
  const handle = await fs.open(path.join(root, 'large.bin'), 'w');
  await handle.truncate(101 * 1024 * 1024); await handle.close();
  const scan = await native.scan(root), local = scan.files[0];
  assert.equal(scan.skipped.length, 0);
  assert.equal(local.size, 101 * 1024 * 1024);
  let progress = 0;
  const sent = await transfers.upload(root, local.path, {url:url('put'),storageKey:'seaweed:u/test/file'}, local, loaded=>{progress=loaded;}, true);
  assert.equal(sent.size, local.size); assert.equal(progress, local.size);
  assert.equal(seen.filter(item => item.part != null).length, 13);
  assert.ok(seen.every(item => item.size <= 8 * 1024 * 1024));
  assert.equal(seen.filter(item => item.finalize).length, 1);
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

async function largeLocal(root) {
  const handle = await fs.open(path.join(root, 'large.bin'), 'w');
  await handle.truncate(24 * 1024 * 1024); await handle.close();
  return (await native.scan(root)).files[0];
}

test('queda de conexao reenvia so o bloco interrompido', () => fixture(async (root, url, seen) => {
  const local = await largeLocal(root);
  const progress = [];
  const result = await transfers.upload(root, local.path, { url: url('put'), storageKey: 'seaweed:u/test/file' }, local, value => progress.push(value), true);
  assert.equal(result.checksum, local.checksum);
  assert.deepEqual(seen.filter(item => item.part != null).map(item => item.part), [0, 1, 1, 2]);
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
}, { dropPart: 1 }));

test('checksum divergente na montagem nao conclui o upload', () => fixture(async (root, url) => {
  const local = await largeLocal(root);
  await assert.rejects(transfers.upload(root, local.path, { url: url('put'), storageKey: 'seaweed:u/test/file' }, local, null, true), /Integridade/);
}, { badChecksum: true }));

test('edicao local durante os blocos impede a publicacao', () => fixture(async (root, url, seen) => {
  const local = await largeLocal(root);
  await assert.rejects(transfers.upload(root, local.path, { url: url('put'), storageKey: 'seaweed:u/test/file' }, local, null, true), /alterado durante/);
  assert.equal(seen.some(item => item.finalize), false);
}, { changeOnLast: true }));