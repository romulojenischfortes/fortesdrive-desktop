const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { applySetupConfiguration } = require('../setup-handoff');

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-installer-'));
  const filename = path.join(directory, 'fortesdrive-setup.ini');
  try { await run(filename); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('o INI nativo aplica a pasta exata com acentos, espacos e sinal de igual antes de sincronizar', () => fixture(async filename => {
  const folder = 'D:\\Documentos\\Rômulo\\Contratos = 2026';
  await fs.writeFile(filename, Buffer.from('\uFEFF[Sync]\r\nwatchFolder=' + folder + '\r\nmachineRole=client\r\n', 'utf16le'));
  const manifest = { files: { existing: 'preservado' } };
  const store = new Map();
  const engine = { state: {}, manifest, store, folderConfigured: false,
    async setWatchFolder(value) { this.watchFolder = value; this.folderConfigured = true; } };
  assert.equal(await applySetupConfiguration(engine, filename), true);
  assert.equal(engine.watchFolder, folder);
  assert.equal(engine.folderConfigured, true);
  assert.equal(store.get('machineRole'), 'client');
  assert.equal(engine.manifest, manifest);
  await assert.rejects(fs.access(filename), { code: 'ENOENT' });
}));

test('a pagina do cliente nao e ocultada por uma configuracao antiga nem preenche uma pasta padrao', async () => {
  const source = await fs.readFile(path.join(__dirname, '../build/overlays.nsh'), 'utf8');
  const page = source.slice(source.indexOf('Function FortesSyncPageCreate'), source.indexOf('Function FortesSyncBrowse'));
  assert.match(source, /Page custom FortesSyncPageCreate FortesSyncPageLeave/);
  assert.match(source, /!macro FortesInstallerPageFunctions[\s\S]*Function FortesRolePageCreate[\s\S]*!macroend/);
  assert.match(source, /!insertmacro FortesInstallerPageFunctions/);
  assert.match(source, /!macro customInit[\s\S]*SetErrorLevel 2/);
  assert.doesNotMatch(page, /fortesdrive-native-v2\.json|StrCpy \$FortesSyncDir/);
  assert.match(page, /isUpdated/);
  assert.match(page, /\$FortesMachineRole.*==.*"server"/);
  assert.match(source, /GetTempFileName \$R1 "\$FortesSyncDir"/);
  const writer = source.slice(source.indexOf('!macro FortesWriteSyncFolder'), source.indexOf('WriteRegStr HKLM "Software\\FortesDrive"'));
  assert.match(writer, /WriteINIStr/);
  assert.doesNotMatch(writer, /powershell|SetEnvironmentVariable/i);
});

test('o cliente exige selecao nativa antes da janela web e nao cria Documentos por conta propria', async () => {
  const main = await fs.readFile(path.join(__dirname, '../main.js'), 'utf8');
  const startup = main.slice(main.indexOf('app.whenReady()'));
  assert.match(startup, /if \(!syncEngine.folderConfigured\)/);
  assert.ok(startup.indexOf('selectFolder()') < startup.indexOf('createWindow()'));
  assert.doesNotMatch(startup, /settings\.set\("watchFolder"|mkdirSync/);
});