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
function setup() {
  const updater = new EventEmitter(), app = {isPackaged:true, getVersion:()=> '1.2.0', getPath:()=>path.join(root,'userData')}, engine = {state:{syncing:false}};
  updater.checkForUpdates = async () => {updater.emit('checking-for-update'); updater.emit('update-available', {version:'1.2.1'});};
  updater.downloadUpdate = async () => {updater.emit('download-progress', {percent:52.2}); updater.emit('update-downloaded', {version:'1.2.1'});};
  updater.quitAndInstall = (...args) => {updater.installArgs = args;};
  return {controller:new DesktopUpdater(updater, app, engine, ()=>{}), updater, app, engine};
}
test('verifica, baixa e reinicia sem instalação manual', async () => {
  const {controller,updater,app} = setup();
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal((await controller.check()).status, 'available');
  assert.equal((await controller.download()).status, 'downloaded');
  assert.equal(controller.getStatus().percent, 100);
  assert.equal((await controller.install()).status, 'installing');
  assert.deepEqual(updater.installArgs,[false,true]); assert.equal(app.isQuitting,true);
});
test('não reinicia durante sincronização; erro permite nova tentativa', async () => {
  const {controller,updater,engine} = setup();
  await controller.check(); await controller.download(); engine.state.syncing = true;
  await assert.rejects(()=>controller.install(), /sincronização/);
  assert.equal(controller.getStatus().status, 'downloaded');
  updater.emit('error', new Error('sem conexão'));
  assert.equal(controller.getStatus().status, 'error');
  assert.equal((await controller.check()).status, 'available');
});