const test = require('node:test');
const assert = require('node:assert/strict');
const base = {f1:{path:'pasta/a.txt',checksum:'A',version:1}};
const remote = {id:'f1',path:'pasta/a.txt',checksum:'A',currentVersion:1,status:'SYNCED'};
test('arquivo ilegível nunca é interpretado como exclusão', async () => {
  const {planDesktopSync} = await import('../../src/lib/desktopSyncPlan.js');
  assert.deepEqual(planDesktopSync([], [remote], base, [{path:'pasta/a.txt'}]), []);
  assert.deepEqual(planDesktopSync([], [remote], base, [{path:'pasta'}]), []);
  assert.deepEqual(planDesktopSync([], [remote], base, [{path:''}]), []);
  assert.deepEqual(planDesktopSync([], [remote], {}, [{path:'pasta'}]), []);
});
test('pastas ignoradas não impedem sincronizar outras pastas', async () => {
  const {planDesktopSync} = await import('../../src/lib/desktopSyncPlan.js');
  const actions = planDesktopSync([{path:'outra/b.txt',checksum:'B'}], [remote], base, [{path:'pasta'}]);
  assert.deepEqual(actions.map(a=>a.type), ['upload']);
});