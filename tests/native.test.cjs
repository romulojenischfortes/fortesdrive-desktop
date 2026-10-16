const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const native = require('../native-files');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
test('arquivos vazios e bytes IPC preservam o conteúdo nos dois sentidos', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-'));
  try {
    await native.write(root, 'pasta/vazio.txt', new Uint8Array(), hash(''), null);
    await native.write(root, 'pasta/á.txt', new Uint8Array(Buffer.from('conteúdo')), hash('conteúdo'), null);
    const scan = await native.scan(root);
    assert.equal(scan.skipped.length, 0); assert.equal(scan.files.length, 2);
    assert.equal(Buffer.from(await native.read(root, 'pasta/á.txt', hash('conteúdo'))).toString(), 'conteúdo');
    assert.equal(Buffer.from(await native.read(root, 'pasta/vazio.txt', hash(''))).length, 0);
    await native.write(root, 'pasta/á.txt', new Uint8Array(Buffer.from('editado')), hash('editado'), hash('conteúdo'));
    await assert.rejects(native.write(root, 'pasta/á.txt', Buffer.from('x'), hash('x'), hash('conteúdo')));
    await native.move(root, 'pasta/á.txt', 'outra/movido.txt', hash('editado'));
    assert.equal(Buffer.from(await native.read(root, 'outra/movido.txt', hash('editado'))).toString(), 'editado');
  } finally { await fs.rm(root, {recursive:true, force:true}); }
});
test('arquivo acima do limite não interrompe os demais arquivos', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-'));
  try {
    const large = await fs.open(path.join(root, 'grande.bin'), 'w');
    await large.truncate(native.MAX_BYTES + 1); await large.close();
    await fs.writeFile(path.join(root, 'ok.txt'), 'ok');
    const scan = await native.scan(root);
    assert.equal(scan.files[0].path, 'ok.txt'); assert.equal(scan.skipped[0].path, 'grande.bin');
  } finally { await fs.rm(root, {recursive:true, force:true}); }
});