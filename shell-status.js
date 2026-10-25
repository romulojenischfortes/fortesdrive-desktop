const fs = require('fs/promises');
const path = require('path');
const {execFile} = require('child_process');
const {promisify} = require('util');
const run = promisify(execFile);
// `locked` = item dentro de pasta protegida por senha, aguardando desbloqueio:
// pesa mais que pendente (o item não será baixado sozinho) e menos que erro.
const ranks = {synced: 0, pending: 1, locked: 2, error: 3};

class ShellStatus {
  constructor() { this.entries = new Map(); this.lastWritten = ''; this.writes = Promise.resolve(); }
  async start(root) {
    if (process.platform !== 'win32') return;
    clearTimeout(this.timer);
    await this.writes.catch(() => {});
    this.root = root;
    this.entries.clear(); this.lastWritten = '';
    const internal = path.join(root, '.fortesdrive');
    const existing = await fs.lstat(internal).catch(error => {if (error.code !== 'ENOENT') throw error;});
    if (existing?.isSymbolicLink()) throw new Error('Diretório de status inseguro');
    await fs.mkdir(internal, {recursive: true});
    await run('reg.exe', ['add', 'HKCU\\Software\\FortesDrive', '/v', 'SyncRoot', '/t', 'REG_SZ', '/d', root, '/f'], {windowsHide: true});
    await this.publish({entries: [], state: 'pending'});
  }
  async publish({entries = [], state = 'pending'}) {
    if (!this.root || process.platform !== 'win32') return;
    if (!Array.isArray(entries) || entries.length > 200000 || !(state in ranks)) throw new Error('Estado de sincronização inválido');
    const next = new Map();
    for (const entry of entries) {
      if (!(entry.state in ranks)) throw new Error('Marca de sincronização inválida');
      if (typeof entry.path !== 'string' || /[\\\x00-\x1f]/.test(entry.path) || entry.path.split('/').some(part => part === '..' || part === '.' || part === '.fortesdrive')) throw new Error('Caminho de status inválido');
      next.set(entry.path, {...entry});
    }
    next.set('', {path: '', state});
    for (const entry of [...next.values()]) {
      let parent = entry.path;
      while (parent) {
        const slash = parent.lastIndexOf('/'); parent = slash < 0 ? '' : parent.slice(0, slash);
        const current = next.get(parent);
        if (!current || ranks[entry.state] > ranks[current.state]) next.set(parent, {path: parent, state: entry.state});
      }
    }
    this.entries = next;
    clearTimeout(this.timer);
    await this.flush();
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
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(error => console.error('FortesDrive status:', error.message)), 300);
  }
  flush() {
    const content = [...this.entries.values()].map(entry => `${entry.state}\t${Math.floor(entry.size ?? -1)}\t${Math.floor(entry.mtimeMs ?? -1)}\t${entry.path}`).sort().join('\n');
    this.writes = this.writes.catch(() => {}).then(async () => {
      if (content === this.lastWritten) return;
      const internal = path.join(this.root, '.fortesdrive');
      const temp = path.join(internal, 'shell-status.tmp');
      await fs.writeFile(temp, content, 'utf8');
      await fs.rename(temp, path.join(internal, 'shell-status.tsv'));
      this.lastWritten = content;
      const dll = path.join(process.resourcesPath || __dirname, 'shell', 'FortesDriveOverlays.dll');
      await run('rundll32.exe', [dll + ',Refresh'], {windowsHide: true});
    });
    return this.writes;
  }
}
module.exports = {ShellStatus};