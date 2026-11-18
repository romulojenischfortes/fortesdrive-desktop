const test = require('node:test');
const assert = require('node:assert/strict');
const base = { f1: { path: 'pasta/a.txt', checksum: 'A', version: 1, identity: '1:1' } };
const local = { path: 'pasta/a.txt', checksum: 'A', identity: '1:1', size: 1 };
const remote = { id: 'f1', path: local.path, checksum: 'A', currentVersion: 1, status: 'SYNCED' };

test('a última edição confirmada prevalece em todos os computadores', async () => {
  const { planDesktopSync } = await import('../../src/lib/desktopSyncPlan.js');
  // PC 2 editou na nuvem às 10h30 e o PC 1 tem a edição local das 10h05: vence a
  // edição mais recente, que desce para todos os computadores.
  const remoteEdited = { ...remote, checksum: 'C', currentVersion: 2, updated_date: '2026-11-18T13:30:00.000Z' };
  const older = { ...local, checksum: 'B', mtimeMs: Date.parse('2026-11-18T13:05:00.000Z') };
  assert.deepEqual(planDesktopSync([older], [remoteEdited], base).map(a => a.type), ['download']);
  // Edição local posterior à da nuvem: sobe e passa a valer para todos.
  const newer = { ...local, checksum: 'D', mtimeMs: Date.parse('2026-11-18T13:45:00.000Z') };
  assert.deepEqual(planDesktopSync([newer], [remoteEdited], base).map(a => a.type), ['upload']);
  // Editados no mesmo instante: sem ordem confiável, as duas versões ficam.
  const simultaneous = { ...local, checksum: 'E', mtimeMs: Date.parse('2026-11-18T13:30:00.600Z') };
  assert.deepEqual(planDesktopSync([simultaneous], [remoteEdited], base).map(a => a.type), ['conflict']);
});