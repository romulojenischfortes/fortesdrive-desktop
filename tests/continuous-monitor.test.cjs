const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

async function loadEngine(root) {
  const watchers = [], tasks = new Map();
  let timerId = 0;
  const filename = path.resolve(__dirname, '../sync-engine.js');
  const mock = new Module(filename, module);
  mock.filename = filename;
  mock.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mock.require.bind(mock);
  class Store {
    constructor() { this.data = new Map([['watchFolder', root], ['folderConfigured', true]]); }
    get(key, fallback) { return this.data.has(key) ? this.data.get(key) : fallback; }
    set(key, value) { this.data.set(key, value); }
    has(key) { return this.data.has(key); }
  }
  mock.require = name => name === 'electron-store' ? Store : name === 'chokidar' ? { watch: (root, options) => {
    const watcher = new EventEmitter();
    watcher.options = options;
    watcher.close = async () => { watcher.closed = true; };
    watchers.push(watcher);
    return watcher;
  } } : name === './shell-status' ? { ShellStatus: class { async start() {} dirty() {} } } : originalRequire(name);
  const source = await fs.readFile(filename, 'utf8');
  const timers = {
    timeout: (fn, ms) => { const id = ++timerId; tasks.set(id, { fn, ms, repeat: false }); return id; },
    interval: (fn, ms) => { const id = ++timerId; tasks.set(id, { fn, ms, repeat: true }); return id; },
    clear: id => tasks.delete(id),
  };
  let notices = 0;
  globalThis.__monitorTimers = timers;
  mock._compile('const setTimeout = globalThis.__monitorTimers.timeout; const setInterval = globalThis.__monitorTimers.interval; const clearTimeout = globalThis.__monitorTimers.clear; const clearInterval = globalThis.__monitorTimers.clear;\n' + source, filename);
  const engine = new mock.exports.SyncEngine(() => notices++);
  return { engine, watchers, tasks, notices: () => notices, fire: async ms => {
    for (const [id, task] of [...tasks]) if (task.ms === ms) {
      if (!task.repeat) tasks.delete(id);
      await task.fn();
    }
    await engine.starting;
  } };
}

// Cria a injeção antes de compilar, sem dependências do Electron no runner.
const originalTimers = globalThis.__monitorTimers;
test('monitor avisa durante cópia contínua e após ficar pronto, mesmo sem janela', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-monitor-'));
  let engine;
  try {
    const monitor = await loadEngine(root); engine = monitor.engine;
    await engine.start();
    const watcher = monitor.watchers[0];
    const before = monitor.notices();
    for (let index = 0; index < 200; index++) watcher.emit('all', 'add', path.join(root, index + '.txt'));
    assert.equal([...monitor.tasks.values()].filter(t => t.ms === 800).length, 1);
    await monitor.fire(800);
    assert.equal(monitor.notices(), before + 1);
    watcher.emit('ready');
    assert.equal(monitor.notices(), before + 2);
    await monitor.fire(30000);
    assert.equal(monitor.notices(), before + 3);
    await engine.stop();
    assert.equal(monitor.tasks.size, 0);
  } finally { await engine?.stop(); globalThis.__monitorTimers = originalTimers; await fs.rm(root, { recursive: true, force: true }); }
});

test('falha do watcher recria o monitor com polling e mantém a reconciliação', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-rearm-'));
  let engine;
  try {
    const monitor = await loadEngine(root); engine = monitor.engine;
    await engine.start();
    const old = monitor.watchers[0];
    old.emit('error', new Error('dispositivo desconectado'));
    assert.equal(engine.state.running, false);
    await monitor.fire(3000);
    assert.equal(old.closed, true);
    assert.equal(engine.state.running, true);
    assert.equal(monitor.watchers[1].options.usePolling, true);
    monitor.watchers[1].emit('ready');
    assert.equal(engine.state.watcherError, '');
    const notices = monitor.notices();
    old.emit('ready');
    old.emit('all', 'add', path.join(root, 'antigo.txt'));
    assert.equal(monitor.notices(), notices);
  } finally { await engine?.stop(); globalThis.__monitorTimers = originalTimers; await fs.rm(root, { recursive: true, force: true }); }
});

test('pasta temporariamente ausente volta a ser monitorada sem abrir a janela', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-unavailable-'));
  let engine;
  try {
    const monitor = await loadEngine(root); engine = monitor.engine;
    await fs.rmdir(root);
    await assert.rejects(engine.start(), { code: 'ENOENT' });
    assert.equal(monitor.watchers.length, 0);
    assert.ok([...monitor.tasks.values()].some(t => t.repeat));
    await fs.mkdir(root);
    await monitor.fire(30000);
    assert.equal(monitor.watchers.length, 1);
    assert.equal(engine.state.running, true);
  } finally { await engine?.stop(); globalThis.__monitorTimers = originalTimers; await fs.rm(root, { recursive: true, force: true }); }
});
