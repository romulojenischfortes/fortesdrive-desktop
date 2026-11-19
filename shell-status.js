const fs = require('fs/promises');
const path = require('path');
const {execFile} = require('child_process');
const {promisify} = require('util');
const run = promisify(execFile);
// `locked` = item dentro de pasta protegida por senha, aguardando desbloqueio:
// pesa mais que pendente (o item não será baixado sozinho) e menos que erro.
const ranks = {synced: 0, pending: 1, locked: 2, error: 3};
const yieldLoop = () => new Promise(resolve => setImmediate(resolve));

class ShellStatus {
  constructor() {
    this.entries = new Map();
    this.lastWritten = '';
    this.writes = Promise.resolve();
    this.dirtyGeneration = 0;
    this.writtenGeneration = 0;
  }
  async start(root) {
    if (process.platform !== 'win32') return;
    clearTimeout(this.timer); clearTimeout(this.confirmTimer); this.confirmTimer = null;
    await this.writes.catch(() => {});
    this.root = root;
    this.entries.clear(); this.lastWritten = '';
    this.dirtyGeneration = 0; this.writtenGeneration = 0;
    const internal = path.join(root, '.fortesdrive');
    const existing = await fs.lstat(internal).catch(error => {if (error.code !== 'ENOENT') throw error;});
    if (existing?.isSymbolicLink()) throw new Error('Diretório de status inseguro');
    await fs.mkdir(internal, {recursive: true});
    await run('reg.exe', ['add', 'HKCU\\Software\\FortesDrive', '/v', 'SyncRoot', '/t', 'REG_SZ', '/d', root, '/f'], {windowsHide: true, timeout: 5000});
    await this.publish({entries: [], state: 'pending'});
  }
  async publish({entries = [], state = 'pending'}) {
    if (!this.root || process.platform !== 'win32') return;
    if (!Array.isArray(entries) || entries.length > 200000 || !(state in ranks)) throw new Error('Estado de sincronização inválido');
    const next = new Map();
    let processed = 0;
    for (const entry of entries) {
      if (!(entry.state in ranks)) throw new Error('Marca de sincronização inválida');
      if (typeof entry.path !== 'string' || /[\\\x00-\x1f]/.test(entry.path) || entry.path.split('/').some(part => part === '..' || part === '.' || part === '.fortesdrive')) throw new Error('Caminho de status inválido');
      next.set(entry.path, {path: entry.path, state: entry.state, size: entry.size, mtimeMs: entry.mtimeMs});
      if (++processed % 5000 === 0) await yieldLoop();
    }
    next.set('', {path: '', state});
    const snapshot = [...next.values()];
    for (let i = 0; i < snapshot.length; i++) {
      const entry = snapshot[i];
      let parent = entry.path;
      while (parent) {
        const slash = parent.lastIndexOf('/'); parent = slash < 0 ? '' : parent.slice(0, slash);
        const current = next.get(parent);
        if (!current || ranks[entry.state] > ranks[current.state]) next.set(parent, {path: parent, state: entry.state});
      }
      if ((i + 1) % 5000 === 0) await yieldLoop();
    }
    this.entries = next;
    this.dirtyGeneration++;
    clearTimeout(this.timer); clearTimeout(this.confirmTimer); this.confirmTimer = null;
    this.scheduleFlush(400);
  }
  setRootState(state) {
    if (!this.root || process.platform !== 'win32' || !(state in ranks)) return;
    const prev = this.entries.get('');
    if (prev?.state === state) return;
    this.entries.set('', {path: '', state});
    this.dirtyGeneration++;
    this.scheduleFlush(800);
  }
  async confirm(relative, signature) {
    if (!this.root || process.platform !== 'win32') return;
    this.entries.set(relative, { path: relative, state: 'synced', size: signature.size, mtimeMs: signature.mtimeMs });
    this.dirtyGeneration++;
    this.scheduleFlush(2000);
  }
  dirty(absolute) {
    if (!this.root || process.platform !== 'win32') return;
    const relative = path.relative(this.root, absolute).split(path.sep).join('/');
    if (relative.startsWith('../') || relative === '..' || relative.split('/').includes('.fortesdrive')) return;
    let item = relative;
    for (;;) {
      this.entries.set(item, {path: item, state: 'pending'});
      if (!item) break;
      const slash = item.lastIndexOf('/'); item = slash < 0 ? '' : item.slice(0, slash);
    }
    this.dirtyGeneration++;
    this.scheduleFlush(600);
  }
  scheduleFlush(delayMs = 1000) {
    if (this.confirmTimer) return;
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      this.flush().catch(error => console.error('FortesDrive status:', error.message));
    }, delayMs);
    this.confirmTimer.unref?.();
  }
  flush() {
    const targetGen = this.dirtyGeneration;
    this.writes = this.writes.catch(() => {}).then(async () => {
      if (!this.root || this.writtenGeneration >= targetGen) return;
      const values = [...this.entries.values()];
      const chunks = [];
      let batch = [];
      for (let i = 0; i < values.length; i++) {
        const entry = values[i];
        batch.push(`${entry.state}\t${Math.floor(entry.size ?? -1)}\t${Math.floor(entry.mtimeMs ?? -1)}\t${entry.path}`);
        if (batch.length >= 4000) {
          chunks.push(batch.join('\n'));
          batch = [];
          await yieldLoop();
        }
      }
      if (batch.length) chunks.push(batch.join('\n'));
      const content = chunks.join('\n');
      this.writtenGeneration = targetGen;
      if (content === this.lastWritten) return;
      const internal = path.join(this.root, '.fortesdrive');
      const temp = path.join(internal, 'shell-status.tmp');
      await fs.writeFile(temp, content, 'utf8');
      await fs.rename(temp, path.join(internal, 'shell-status.tsv'));
      this.lastWritten = content;
      const since = Date.now() - (this.lastRefresh || 0);
      if (since < 2500) await new Promise(resolve => setTimeout(resolve, 2500 - since));
      this.lastRefresh = Date.now();
      const dll = path.join(process.resourcesPath || __dirname, 'shell', 'FortesDriveOverlays.dll');
      await run('rundll32.exe', [dll + ',Refresh'], {windowsHide: true, timeout: 6000}).catch(() => {});
    });
    return this.writes;
  }
}
module.exports = {ShellStatus};