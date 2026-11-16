const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const native = require('../native-files');
const base = { f1: { path: 'pasta/a.txt', checksum: 'A', version: 1, identity: '1:1' } };
const local = { path: 'pasta/a.txt', checksum: 'A', identity: '1:1', size: 1 };
const remote = { id: 'f1', path: local.path, checksum: 'A', currentVersion: 1, status: 'SYNCED' };
async function type(files, cloud, baseline = base) {
  const { planDesktopSync } = await import('../../src/lib/desktopSyncPlan.js');
  return planDesktopSync(files, cloud, baseline).map(a => a.type);
}
test('primeiro encontro preserva os dois conteúdos', async () => assert.deepEqual(await type([{ ...local, checksum: 'B' }], [remote], {}), ['conflict']));
test('novo arquivo local sobe', async () => assert.deepEqual(await type([local], [], {}), ['upload']));
test('novo arquivo remoto desce', async () => assert.deepEqual(await type([], [remote], {}), ['download']));
test('arquivo inalterado não transfere', async () => assert.deepEqual(await type([local], [remote]), ['adopt']));
test('edição local sobe', async () => assert.deepEqual(await type([{ ...local, checksum: 'B' }], [remote]), ['upload']));
test('edição remota desce e não sobrescreve nuvem', async () => assert.deepEqual(await type([local], [{ ...remote, checksum: 'B', currentVersion: 2 }]), ['download']));
test('exclusão local não baixa novamente', async () => assert.deepEqual(await type([], [remote]), ['deleteRemote']));
test('exclusão remota não reenvia arquivo', async () => assert.deepEqual(await type([local], [{ ...remote, status: 'DELETED' }]), ['trashLocal']));
test('exclusão concorrente com edição preserva conteúdo', async () => assert.deepEqual(await type([{ ...local, checksum: 'B' }], [{ ...remote, status: 'DELETED' }]), ['conflict']));
test('edição remota após exclusão local não é apagada', async () => assert.deepEqual(await type([], [{ ...remote, checksum: 'B', currentVersion: 2 }]), ['download']));
test('movimento local mantém o identificador', async () => assert.deepEqual(await type([{ ...local, path: 'nova/a.txt' }], [remote]), ['upload']));
test('movimento remoto é aplicado localmente', async () => assert.deepEqual(await type([local], [{ ...remote, path: 'nova/a.txt' }]), ['download']));
test('mudanças concorrentes preservam ambos', async () => assert.deepEqual(await type([{ ...local, checksum: 'B' }], [{ ...remote, checksum: 'C', currentVersion: 2 }]), ['conflict']));
test('duplicatas remotas bloqueiam substituição', async () => assert.rejects(() => type([], [remote, { ...remote, id: 'f2' }]), /duplicados/));
test('acesso nativo: leitura, edição atômica, movimento, diretórios e proteção', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-test-'));
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  try {
    await native.write(root, 'sub/a.txt', Buffer.from('primeiro'), hash('primeiro'), null);
    assert.equal((await native.scan(root)).files.length, 1);
    assert.equal(Buffer.from(await native.read(root, 'sub/a.txt', hash('primeiro'))).toString(), 'primeiro');
    await native.write(root, 'sub/a.txt', Buffer.from('segundo'), hash('segundo'), hash('primeiro'));
    await native.move(root, 'sub/a.txt', 'outra/b.txt', hash('segundo'));
    assert.equal((await native.scan(root)).files[0].path, 'outra/b.txt');
    await assert.rejects(native.write(root, 'outra/b.txt', Buffer.from('x'), hash('x'), null), /existe/);
    await assert.rejects(native.safePath(root, '../escape'), /incompatível/);
    await assert.rejects(native.safePath(root, 'C:/escape'), /incompatível/);
    await fs.symlink(os.tmpdir(), path.join(root, 'link'));
    await assert.rejects(native.safePath(root, 'link/file.txt'), /simbólicos/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});