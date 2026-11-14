const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TransferHistory } = require('../transfer-history');

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortesdrive-history-'));
  const engine = { watchFolder: directory, store: new Map(), manifestKey: userId => { if (!userId) throw new Error('Conta obrigatoria'); return userId; } };
  try { await run(new TransferHistory(directory, engine), directory, engine); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('conclusoes concorrentes persistem, nao duplicam e isolam as contas', () => fixture(async (history, directory, engine) => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ fileId: 'id' + i, version: 1, checksum: 'hash' + i, path: `Rômulo/arquivo ${i}.txt`, size: i, direction: i % 2 ? 'upload' : 'download' }));
  await Promise.all(entries.map(event => history.add('conta-a', event)));
  assert.equal((await history.add('conta-a', entries[0])).added, false);
  const page = await history.query('conta-a', { filter: 'download', sort: 'total', dir: 'asc' });
  assert.equal(page.total, 10); assert.equal(page.counts.all, 20); assert.equal(page.counts.upload, 10);
  assert.equal(page.items.length, 8); assert.equal(page.items[0].size, 0);
  const restarted = new TransferHistory(directory, engine);
  assert.equal((await restarted.query('conta-a', { page: 3 })).items.length, 4);
  assert.equal((await restarted.query('conta-b')).total, 0);
  assert.equal((await restarted.add('conta-a', entries[0])).added, false);
  const csv = await restarted.csv('conta-a', { selected: [page.items[0].id] });
  assert.equal(csv.count, 1); assert.match(csv.content, /Rômulo\/arquivo 0.txt/);
}));

test('caminhos inseguros sao recusados e CSV neutraliza formulas', () => fixture(async history => {
  assert.throws(() => history.add('a', { path: '../segredo', size: 1, direction: 'download' }), /inválido/);
  await history.add('a', { fileId: 'f', version: 1, path: '=formula.txt', size: 1, direction: 'download' });
  assert.match((await history.csv('a', {})).content, /'\=formula/);
}));