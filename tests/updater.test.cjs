const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fortesdrive-updater-'));
test.after(() => fs.rmSync(root, {recursive:true, force:true}));
const load = Module._load;
Module._load = function(name, ...args) { return name === 'electron' ? {shell:{openPath:async()=>''}} : load.call(this, name, ...args); };
const { DesktopUpdater } = require('../updater');
Module._load = load;
function setup({ failDownload = false } = {}) {
  const updater = new EventEmitter(), avisos = [];
  const app = {isPackaged:true, getVersion:()=> '1.2.0', getPath:()=>path.join(root,'userData')};
  const engine = {state:{syncing:false}};
  updater.checkForUpdates = async () => {updater.emit('checking-for-update'); updater.emit('update-available', {version:'1.2.1'});};
  updater.downloadUpdate = async () => {
    if (failDownload) { updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED')); return; }
    updater.emit('download-progress', {percent:52.2}); updater.emit('update-downloaded', {version:'1.2.1'});
  };
  updater.quitAndInstall = (...args) => {updater.installArgs = args;};
  const controller = new DesktopUpdater(updater, app, engine, (title, body) => avisos.push({title, body}));
  return {controller, updater, app, engine, avisos};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('verificar novamente preserva a atualização já baixada', async () => {
  const {controller, updater} = setup();
  await controller.check(); await settle();
  updater.checkForUpdates = async () => { throw new Error('não deve consultar durante atualização pendente'); };
  assert.equal((await controller.check()).status, 'downloaded');
  assert.equal(controller.hasPendingUpdate(), true);
});

test('usa o caminho entregue pelo download e nunca o cache de outro aplicativo', async () => {
  const {controller, updater} = setup();
  const foreign = path.join(root, 'outro-app-updater', 'pending');
  fs.mkdirSync(foreign, {recursive:true});
  fs.writeFileSync(path.join(foreign, 'antigo.exe'), 'outro aplicativo');
  assert.equal(controller.findInstaller(), null);
  const installer = path.join(root, 'FortesDrive-Setup-1.2.1.exe');
  fs.writeFileSync(installer, 'meu instalador');
  updater.emit('update-downloaded', {version:'1.2.1', downloadedFile:installer});
  assert.equal(controller.getStatus().installerPath, installer);
  assert.equal(controller.getStatus().installerExists, true);
  assert.equal(controller.findInstaller(), installer);
});

test('baixa a nova versão sozinho e avisa o usuário', async () => {
  const {controller, updater, avisos} = setup();
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  await controller.check();
  await settle();
  assert.equal(controller.getStatus().status, 'downloaded');
  assert.equal(controller.getStatus().percent, 100);
  assert.equal(controller.hasPendingUpdate(), true);
  assert.equal(avisos.some(a => /Nova versão disponível/.test(a.title)), true, 'avisa quando a versão aparece');
  assert.equal(avisos.some(a => /instalada automaticamente/.test(a.body)), true, 'avisa que instala sozinha ao fechar');
});

test('download automático que falha volta para disponível e tenta de novo', async () => {
  const {controller} = setup({failDownload:true});
  await controller.check();
  await settle();
  assert.equal(controller.getStatus().status, 'available');
  assert.equal(controller.getStatus().errorKind, 'network');
  assert.equal(controller.hasPendingUpdate(), false);
});

test('aplica a atualização baixada ao fechar, sem clique', async () => {
  const {controller,updater,app} = setup();
  await controller.check();
  await settle();
  assert.equal((await controller.install()).status, 'installing');
  assert.deepEqual(updater.installArgs,[false,true]); assert.equal(app.isQuitting,true);
});

test('não reinicia durante sincronização; erro permite nova tentativa', async () => {
  const {controller,updater,engine} = setup();
  await controller.check(); await settle(); engine.state.syncing = true;
  await assert.rejects(()=>controller.install(), /sincronização/);
  assert.equal(controller.getStatus().status, 'downloaded');
  updater.emit('error', new Error('sem conexão'));
  assert.equal(controller.getStatus().status, 'error');
});