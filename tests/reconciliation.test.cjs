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
test('nuvem que perdeu os registros nao apaga o computador: o conteudo volta a subir', async () => {
  const { planDesktopSync } = await import('../../src/lib/desktopSyncPlan.js');
  const baseline = {}, locals = [];
  for (let i = 1; i <= 30; i += 1) {
    baseline['f' + i] = { path: `pasta/${i}.txt`, checksum: 'A', version: 1, identity: `${i}:${i}` };
    locals.push({ path: `pasta/${i}.txt`, checksum: 'A', identity: `${i}:${i}`, size: 1 });
  }
  assert.deepEqual(planDesktopSync(locals, [], baseline).map(a => a.type), Array(30).fill('upload'));
});
test('registro perdido sem lapide volta a subir em vez de apagar o computador', async () => {
  const { planDesktopSync } = await import('../../src/lib/desktopSyncPlan.js');
  const baseline = {}, locals = [];
  for (let i = 1; i <= 30; i += 1) {
    baseline['f' + i] = { path: `pasta/${i}.txt`, checksum: 'A', version: 1, identity: `${i}:${i}` };
    locals.push({ path: `pasta/${i}.txt`, checksum: 'A', identity: `${i}:${i}`, size: 1 });
  }
  const cloud = Object.entries(baseline).slice(1)
    .map(([id, b]) => ({ id, path: b.path, checksum: 'A', currentVersion: 1, status: 'SYNCED' }));
  const actions = planDesktopSync(locals, cloud, baseline);
  // O registro que sumiu sem lápide é uma perda da nuvem, não uma exclusão: o
  // arquivo do computador é reenviado (sem apagar nada do PC).
  const lost = actions.find(a => a.recreateId === 'f1');
  assert.ok(lost, 'o arquivo cujo registro sumiu precisa voltar para a nuvem');
  assert.equal(lost.type, 'upload');
  assert.equal(actions.filter(a => a.type === 'trashLocal').length, 0);
  assert.equal(actions.filter(a => a.type === 'adopt').length, 29);
});

test('lapide da exclusao definitiva apaga o arquivo em todos os computadores', async () => {
  const { planDesktopSync } = await import('../../src/lib/desktopSyncPlan.js');
  const baseline = { f1: { path: 'pasta/1.txt', checksum: 'A', version: 1, identity: '1:1' } };
  const locals = [{ path: 'pasta/1.txt', checksum: 'A', identity: '1:1', size: 1 }];
  // A lixeira foi esvaziada: o registro saiu, restou a lápide dele.
  const grave = { id: 'f1', path: '', status: 'DELETED', currentVersion: 0 };
  assert.deepEqual(planDesktopSync(locals, [grave], baseline).map(a => a.type), ['trashLocal']);
});

test('arquivo que já existe no PC e ainda não foi lido não é baixado por cima', async () => {
  const { planDesktopSync } = await import('../../src/lib/desktopSyncPlan.js');
  const actions = planDesktopSync([], [remote], {}, [], { complete: false, unread: new Set([remote.path]) });
  assert.deepEqual(actions, []);
  // Sem o resumo pronto ele continua pendente; assim que o conteúdo é lido, a
  // decisão volta a ser feita normalmente.
  const decided = planDesktopSync([], [remote], {}, [], { complete: true });
  assert.deepEqual(decided.map(action => action.type), ['download']);
});