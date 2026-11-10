const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { applySetupConfiguration } = require('../setup-handoff');

async function fixture(run) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-setup-'));
  const filename = path.join(temp, 'fortesdrive-setup.json');
  try { await run(filename); } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

test('aplica UTF-8 no cliente ja aberto sem substituir manifestos da conta', () => fixture(async filename => {
  const chosen = 'C:\\Users\\Rômulo\\Desktop\\ADVOCACIA JENISCH';
  await fs.writeFile(filename, JSON.stringify({ watchFolder: chosen }), 'utf8');
  const manifest = { files: { keep: { checksum: 'preservado' } } };
  const engine = { state: { syncing: false }, watchFolder: 'pasta anterior', manifest,
    async setWatchFolder(folder) { this.watchFolder = folder; this.restarted = true; } };
  assert.equal(await applySetupConfiguration(engine, filename), true);
  assert.equal(engine.watchFolder, chosen);
  assert.equal(engine.restarted, true);
  assert.equal(engine.manifest, manifest);
  await assert.rejects(fs.access(filename), { code: 'ENOENT' });
  assert.equal(await applySetupConfiguration(engine, filename), false);
}));

test('aguarda a transferencia atual e aplica a pasta na proxima consulta', () => fixture(async filename => {
  await fs.writeFile(filename, JSON.stringify({ watchFolder: 'nova raiz' }));
  let changed = 0;
  const engine = { state: { syncing: true }, async setWatchFolder() { changed++; } };
  assert.equal(await applySetupConfiguration(engine, filename), false);
  assert.equal(changed, 0);
  await fs.access(filename);
  engine.state.syncing = false;
  assert.equal(await applySetupConfiguration(engine, filename), true);
  assert.equal(changed, 1);
}));

test('pedidos simultaneos reiniciam o monitoramento apenas uma vez', () => fixture(async filename => {
  await fs.writeFile(filename, JSON.stringify({ watchFolder: 'raiz' }));
  let changes = 0;
  const engine = { state: {}, async setWatchFolder() { changes++; } };
  assert.deepEqual(await Promise.all([applySetupConfiguration(engine, filename), applySetupConfiguration(engine, filename)]), [true, true]);
  assert.equal(changes, 1);
}));

test('falha de acesso preserva o pedido para nova tentativa', () => fixture(async filename => {
  await fs.writeFile(filename, JSON.stringify({ watchFolder: 'disco indisponivel' }));
  const engine = { state: {}, async setWatchFolder() { throw new Error('acesso negado'); } };
  await assert.rejects(applySetupConfiguration(engine, filename), /acesso negado/);
  await fs.access(filename);
}));

test('o configurador abre o cliente e oferece um arquivo pela sincronizacao real', async () => {
  const setup = await fs.readFile(path.join(__dirname, '../server/setup-server.ps1'), 'utf8');
  assert.match(setup, /fortesdrive-setup\.json/);
  assert.match(setup, /Start-Process -FilePath \$exeCliente -ArgumentList '--configuration-complete'/);
  assert.match(setup, /Join-Path \$raiz \$nomeVerificacao/);
  assert.doesNotMatch(setup, /Gravar \$configClienteRaiz/);
});