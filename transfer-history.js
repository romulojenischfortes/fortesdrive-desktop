const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createInterface } = require('node:readline');
const path = require('node:path');
const crypto = require('node:crypto');

const DIRECTIONS = ['download', 'upload', 'move', 'conflict'];
const SORT_FIELDS = { order: 'completedAt', customer: 'name', email: 'path', total: 'size', status: 'direction' };
const csvCell = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';

class TransferHistory {
  constructor(directory, engine) { this.directory = path.join(directory, 'transfer-history'); this.engine = engine; this.writes = Promise.resolve(); this.indexes = new Map(); }
  filename(userId) {
    const key = this.engine.manifestKey(userId);
    const ownerKey = 'owner_' + crypto.createHash('sha256').update(this.engine.watchFolder).digest('hex');
    const owner = this.engine.store.get(ownerKey);
    if (owner && owner !== userId) throw new Error('Esta pasta pertence a outra conta FortesDrive.');
    return path.join(this.directory, key + '.jsonl');
  }
  async *records(filename) {
    const stat = await fs.stat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!stat) return;
    const input = createReadStream(filename, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of lines) if (line.trim()) yield JSON.parse(line); }
    finally { lines.close(); input.destroy(); }
  }
  add(userId, event) {
    const filename = this.filename(userId);
    if (!event || !DIRECTIONS.includes(event.direction) || typeof event.path !== 'string' || !event.path || event.path.length > 32000 || /[\\\x00-\x1f]/.test(event.path) || event.path.split('/').some(p => !p || ['.', '..', '.fortesdrive'].includes(p))) throw new Error('Registro de transferência inválido.');
    if (!Number.isSafeInteger(event.size) || event.size < 0 || event.size > 10 * 1024 ** 3) throw new Error('Tamanho de arquivo inválido.');
    const id = crypto.createHash('sha256').update(JSON.stringify([event.fileId, event.version, event.checksum, event.path, event.direction])).digest('hex');
    const work = this.writes.catch(() => {}).then(async () => {
      let seen = this.indexes.get(filename);
      if (!seen) { seen = new Set(); for await (const entry of this.records(filename)) seen.add(entry.id); this.indexes.set(filename, seen); }
      if (seen.has(id)) return { added: false };
      const item = { id, name: event.path.split('/').pop(), path: event.path, size: event.size, direction: event.direction, completedAt: new Date().toISOString() };
      await fs.mkdir(this.directory, { recursive: true });
      const file = await fs.open(filename, 'a', 0o600);
      try { await file.writeFile(JSON.stringify(item) + '\n', 'utf8'); await file.sync(); } finally { await file.close(); }
      seen.add(id);
      return { added: true, item };
    });
    this.writes = work;
    return work;
  }
  async query(userId, options = {}, all = false) {
    const filename = this.filename(userId);
    await this.writes.catch(() => {});
    const filter = options.filter || 'all';
    if (filter !== 'all' && !DIRECTIONS.includes(filter)) throw new Error('Filtro inválido.');
    const field = SORT_FIELDS[options.sort || 'order'];
    if (!field || (options.dir && !['asc', 'desc'].includes(options.dir))) throw new Error('Ordenação inválida.');
    const chosen = options.selected == null ? null : new Set(options.selected);
    if (chosen && (!Array.isArray(options.selected) || chosen.size > 10000)) throw new Error('Seleção inválida.');
    const counts = { all: 0, download: 0, upload: 0, move: 0, conflict: 0 }, items = [];
    for await (const item of this.records(filename)) {
      counts.all++; counts[item.direction]++;
      if (chosen ? chosen.has(item.id) : filter === 'all' || filter === item.direction) items.push(item);
    }
    const direction = options.dir === 'asc' ? 1 : -1;
    items.sort((a, b) => direction * (field === 'size' ? a.size - b.size : String(a[field]).localeCompare(String(b[field]), 'pt-BR', { numeric: true })) || b.completedAt.localeCompare(a.completedAt) || a.id.localeCompare(b.id));
    const total = items.length, page = Math.max(1, Math.min(Math.ceil(total / 8) || 1, Math.floor(Number(options.page) || 1)));
    return { items: all ? items : items.slice((page - 1) * 8, page * 8), total, counts, page };
  }
  async find(userId, id) {
    for await (const item of this.records(this.filename(userId))) if (item.id === id) return item;
    throw new Error('Arquivo não encontrado no histórico desta conta.');
  }
  async csv(userId, options) {
    const result = await this.query(userId, options, true);
    const lines = [['Conclusão', 'Arquivo', 'Caminho', 'Bytes', 'Resultado'], ...result.items.map(item => [item.completedAt, item.name, item.path, item.size, ({ download: 'Baixado', upload: 'Sincronizado', move: 'Movido', conflict: 'Conflito preservado' })[item.direction]])];
    return { content: '\uFEFF' + lines.map(row => row.map(csvCell).join(';')).join('\r\n'), count: result.total };
  }
}
module.exports = { TransferHistory };