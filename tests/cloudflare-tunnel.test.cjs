const test = require('node:test');
const assert = require('node:assert/strict');
const { ServerTunnel, normalizeHost, tunnelPlan, hostnameProblem, FIXED_HOSTNAME } = require('../server-tunnel');

// O servidor publica num hostname fixo (Cloudflare Tunnel, porta 8790).
const FIXED = 'nuvem.fortesdrive.dpdns.org';

test('o servidor usa o hostname fixo do Cloudflare Tunnel', () => {
  assert.equal(FIXED_HOSTNAME, FIXED);
  assert.equal(hostnameProblem(FIXED), '');
  const plan = tunnelPlan({ token: 'abc', hostname: FIXED, port: 8790 });
  assert.equal(plan.mode, 'named');
  assert.equal(plan.url, 'https://' + FIXED);
  assert.equal(plan.host, FIXED);
});

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

test('hostname nomeado válido é aceito, com ou sem esquema e caminho', () => {
  assert.equal(hostnameProblem('drive.exemplo.com'), '');
  assert.equal(hostnameProblem('https://drive.exemplo.com/health'), '');
  assert.equal(hostnameProblem('  http://drive.exemplo.com/  '), '');
});

test('endereço de túnel antigo é recusado apontando o hostname fixo', () => {
  const oldFree = 'uranometrical-nonequatorial-kiley.' + 'ngrok-free.dev';
  const oldIo = 'https://abc123.' + 'ngrok.io/drive';
  assert.match(hostnameProblem(oldFree), /túnel antigo/i);
  assert.match(hostnameProblem(oldFree), new RegExp(FIXED));
  assert.match(hostnameProblem(oldIo), /túnel antigo/i);
});

test('endereço do próprio app é recusado como hostname do servidor', () => {
  assert.match(hostnameProblem('fortesdrive.base44.app'), /próprio app/i);
  assert.match(hostnameProblem('https://fortesdrive.base44.app/drive'), /próprio app/i);
});

test('valor que não é nome DNS é recusado', () => {
  assert.notEqual(hostnameProblem(''), '');
  assert.notEqual(hostnameProblem('meu servidor'), '');
  assert.notEqual(hostnameProblem('drive'), '');
  assert.notEqual(hostnameProblem('-drive.exemplo.com'), '');
});

test('tunel Docker desconectado e recuperado sem reinicializacoes simultaneas', async () => {
  const tunnel = new ServerTunnel({ userDataDir: '/tmp/fd-test' });
  tunnel.state.enabled = true; tunnel.state.mode = 'named'; tunnel.state.hostname = FIXED;
  tunnel.probePublic = async () => ({ ok: false, message: 'Sem conector ativo.' });
  let starts = 0;
  tunnel.start = async () => { starts++; return { ok: true }; };
  await tunnel.checkConnection(); assert.equal(starts, 0);
  await tunnel.checkConnection(); assert.equal(starts, 1);
  await Promise.all([tunnel.checkConnection(), tunnel.checkConnection()]);
  assert.equal(starts, 1);
  tunnel.state.enabled = false; tunnel.manual = false;
  await tunnel.checkConnection(); assert.equal(starts, 1);
});

test('inicializacao automatica compartilha uma unica execucao', async () => {
  const tunnel = new ServerTunnel({ userDataDir: '/tmp/fd-test' });
  let starts = 0, finish;
  tunnel.startOnce = async () => { starts++; await new Promise(resolve => { finish = resolve; }); return { ok: true }; };
  const first = tunnel.start(), second = tunnel.start();
  assert.equal(starts, 1); assert.equal(first, second);
  finish(); await Promise.all([first, second]);
  assert.equal(tunnel.starting, null);
});

test('monitoramento do Docker termina quando o usuario para o tunel', async () => {
  const tunnel = new ServerTunnel({ userDataDir: '/tmp/fd-test' });
  tunnel.state.mode = 'named'; tunnel.state.serverRoot = '/nao-existe-fd-test';
  tunnel.watchConnection(); assert.ok(tunnel.monitor);
  await tunnel.stop(); assert.equal(tunnel.monitor, null);
});

test('diagnostico atrasado nao religa um tunel parado pelo usuario', async () => {
  const tunnel = new ServerTunnel({ userDataDir: '/tmp/fd-test' });
  tunnel.state.enabled = true; tunnel.state.serverRoot = '/nao-existe-fd-test';
  tunnel.connectionFailures = 2;
  let reply, starts = 0;
  tunnel.probePublic = () => new Promise(resolve => { reply = resolve; });
  tunnel.start = async () => { starts++; };
  const checking = tunnel.checkConnection();
  await tunnel.stop(); reply({ ok: false, message: 'offline' }); await checking;
  assert.equal(starts, 0); assert.equal(tunnel.state.status, 'stopped');
});

test('parar durante a inicializacao cancela o inicio pendente', async () => {
  const tunnel = new ServerTunnel({ userDataDir: '/tmp/fd-test' });
  tunnel.state.enabled = true; tunnel.state.serverRoot = '/nao-existe-fd-test';
  let ready;
  tunnel.readTunnelFiles = () => new Promise(resolve => { ready = resolve; });
  const starting = tunnel.start();
  await tunnel.stop(); ready();
  assert.equal((await starting).ok, false); assert.equal(tunnel.monitor, null);
});