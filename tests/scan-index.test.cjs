const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const native = require('../native-files');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

test('o índice em disco evita resumir de novo depois de reabrir o cliente', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-'));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-'));
  const indexFile = path.join(root, 'indice.json');
  try {
    await fs.writeFile(path.join(root, 'a.txt'), 'AAAA');
    await fs.writeFile(path.join(root, 'b.txt'), 'BBBB');
    const first = await native.scan(root);
    assert.equal(first.pendingHash, 0);
    const saved = {};
    for (const file of first.files) {
      saved[file.path] = { size: file.size, mtimeMs: file.mtimeMs, identity: file.identity, checksum: file.checksum };
    }
    await fs.writeFile(indexFile, JSON.stringify(saved));
    // Reabrir o cliente: nada em memória, só o índice gravado na execução anterior.
    await native.scan(other);
    native.configureIndex(indexFile);
    const reopened = await native.scan(root, {}, { restart: true });
    assert.equal(reopened.pendingHash, 0);
    assert.equal(reopened.files.find(f => f.path === 'a.txt').checksum, hash('AAAA'));
    // Arquivo alterado continua sendo resumido de novo, mesmo com índice quente.
    await new Promise(resolve => setTimeout(resolve, 20));
    await fs.writeFile(path.join(root, 'a.txt'), 'ZZZZ');
    const changed = await native.scan(root, {}, { restart: true });
    assert.equal(changed.files.find(f => f.path === 'a.txt').checksum, hash('ZZZZ'));
    assert.equal(changed.files.find(f => f.path === 'b.txt').checksum, hash('BBBB'));
  } finally {
    native.configureIndex(null);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
});