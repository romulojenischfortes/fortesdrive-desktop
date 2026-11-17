const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHost, tunnelPlan } = require('../server-tunnel');

test('endereço público é reduzido ao nome do host', () => {
  assert.equal(normalizeHost('https://Drive.Exemplo.com/'), 'drive.exemplo.com');
  assert.equal(normalizeHost('  http://drive.exemplo.com/health '), 'drive.exemplo.com');
  assert.equal(normalizeHost('drive.exemplo.com'), 'drive.exemplo.com');
  assert.equal(normalizeHost(''), '');
});

test('token gera túnel nomeado com endereço fixo', () => {
  const plan = tunnelPlan({ token: 'abc', hostname: 'drive.exemplo.com', port: 8790 });
  assert.equal(plan.mode, 'named');
  assert.deepEqual(plan.args, ['tunnel', '--no-autoupdate', 'run', '--token', 'abc']);
  assert.equal(plan.url, 'https://drive.exemplo.com');
  assert.equal(plan.host, 'drive.exemplo.com');
});

test('sem token gera túnel temporário apontando para o gateway', () => {
  const plan = tunnelPlan({ token: '', hostname: '', port: 8790 });
  assert.equal(plan.mode, 'quick');
  assert.deepEqual(plan.args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8790']);
  assert.equal(plan.url, '');
});

test('túnel nomeado sem endereço não inventa URL', () => {
  const plan = tunnelPlan({ token: 'abc', hostname: '' });
  assert.equal(plan.mode, 'named');
  assert.equal(plan.url, '');
  assert.equal(plan.host, '');
});