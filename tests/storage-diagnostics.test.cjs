// Regressão do diagnóstico do armazenamento.
//
// O defeito que originou estes testes: o gateway gravava na pasta local porque
// o assistente gravava NEXTCLOUD_ADMIN_USER no .env e o gateway lia
// NEXTCLOUD_USER (nunca configurado, sem aviso); e o teste de gravação do
// instalador devolvia só sim/não, então qualquer falha — credencial recusada,
// cota esgotada, Nextcloud ainda instalando — aparecia como a mesma frase
// "a pasta de dados nao aceitou a gravacao".
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const nextcloud = require(path.join(__dirname, '..', 'server/gateway/nextcloud.js'));

const CONFIGURED = {
  NEXTCLOUD_URL: '',
  NEXTCLOUD_USER: 'fortesdrive',
  NEXTCLOUD_ADMIN_USER: '',
  NEXTCLOUD_APP_PASSWORD: 'senha-de-teste',
  NEXTCLOUD_ROOT: 'FortesDrive',
};

function useEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === '' || value == null) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Servidor WebDAV falso com o comportamento pedido. */
async function davServer(mode, t) {
  const files = new Map();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const pathname = new URL(req.url, 'http://local').pathname;
    calls.push(req.method + ' ' + pathname);

    if (mode === 'auth') { res.writeHead(401); return res.end('Unauthorized'); }
    if (mode === 'starting') { res.writeHead(503); return res.end('Service Unavailable'); }
    if (mode === 'quota') { res.writeHead(507); return res.end('Insufficient Storage'); }
    if (req.method === 'MKCOL') { res.writeHead(201); return res.end(); }
    if (req.method === 'PUT') { files.set(pathname, Buffer.concat(chunks).toString('utf8')); res.writeHead(201); return res.end(); }
    if (req.method === 'GET') {
      if (!files.has(pathname)) { res.writeHead(404); return res.end('Not Found'); }
      res.writeHead(200); return res.end(files.get(pathname));
    }
    if (req.method === 'DELETE') { files.delete(pathname); res.writeHead(204); return res.end(); }
    res.writeHead(405);
    return res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { port: server.address().port, calls, files };
}

for (const [mode, reason] of [
  ['ok', 'ok'],
  ['auth', 'webdav-auth'],
  ['starting', 'nextcloud-starting'],
  ['quota', 'quota'],
]) {
  test('teste de gravação classifica ' + mode + ' como ' + reason, async (t) => {
    const dav = await davServer(mode, t);
    useEnv({ ...CONFIGURED, NEXTCLOUD_URL: 'http://127.0.0.1:' + dav.port });

    const result = await nextcloud.probe();

    assert.equal(result.reason, reason);
    assert.equal(result.writable, mode === 'ok');
    if (mode === 'ok') {
      assert.ok(dav.calls.some((call) => call.startsWith('PUT ')), 'grava um arquivo de teste');
      assert.ok(dav.calls.some((call) => call.startsWith('GET ')), 'lê o arquivo de volta');
      assert.ok(dav.calls.some((call) => call.startsWith('DELETE ')), 'apaga o arquivo de teste');
      assert.equal(dav.files.size, 0, 'nada sobra no armazenamento');
    } else {
      assert.equal(result.detail == null, false, 'a falha sempre traz o detalhe');
    }
  });
}

test('o gateway usa a conta que o assistente grava no .env', async (t) => {
  const dav = await davServer('ok', t);
  // O .env do assistente escreve NEXTCLOUD_ADMIN_USER; sem a equivalência o
  // gateway não se considerava configurado e gravava na pasta local.
  useEnv({ ...CONFIGURED, NEXTCLOUD_URL: 'http://127.0.0.1:' + dav.port, NEXTCLOUD_USER: '', NEXTCLOUD_ADMIN_USER: 'fortesdrive' });

  assert.equal(nextcloud.isConfigured(), true);
  assert.equal((await nextcloud.probe()).writable, true);
  assert.ok(dav.calls.some((call) => call.includes('/remote.php/dav/files/fortesdrive/')), 'usa a conta do .env');
});

test('sem credenciais o motivo é explicito', async () => {
  useEnv({ NEXTCLOUD_URL: 'http://127.0.0.1:9', NEXTCLOUD_USER: '', NEXTCLOUD_ADMIN_USER: '', NEXTCLOUD_APP_PASSWORD: '' });
  const result = await nextcloud.probe();
  assert.equal(result.writable, false);
  assert.equal(result.reason, 'not-configured');
});

test('/health informa se o armazenamento aceita gravação', async (t) => {
  const fsp = require('node:fs/promises');
  const fs = require('node:fs');
  const os = require('node:os');
  const vm = require('node:vm');
  const crypto = require('node:crypto');
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'fd-health-'));
  const secret = 'x'.repeat(32);

  let gateway = null;
  const sandbox = {
    // Sem o módulo do Nextcloud ao lado, o gateway usa a pasta local — o caso em
    // que /health precisa dizer se ela aceita gravação.
    require: (name) => (name !== 'node:http' ? require(name) : {
      ...http,
      createServer: (listener) => {
        gateway = http.createServer(listener);
        const listen = gateway.listen.bind(gateway);
        gateway.listen = (port, host, callback) => listen(0, '127.0.0.1', callback);
        return gateway;
      },
    }),
    process: {
      env: { STORAGE_SIGNING_SECRET: secret, DATA_DIR: folder },
      on() {},
      exit() { throw new Error('o gateway encerrou durante o teste'); },
    },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, fetch, AbortSignal, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'server/gateway/server.js'), 'utf8'), sandbox, { filename: 'gateway.js' });
  if (!gateway.listening) await new Promise((resolve) => gateway.once('listening', resolve));
  t.after(async () => {
    await fsp.rm(folder, { recursive: true, force: true });
    await new Promise((resolve) => { gateway.close(resolve); gateway.closeAllConnections(); });
  });
  const base = 'http://127.0.0.1:' + gateway.address().port;

  const body = await (await fetch(base + '/health')).json();
  assert.equal(body.ok, true, 'o gateway está vivo');
  assert.equal(body.storage.backend, 'disk');
  assert.equal(body.storage.writable, true);
  assert.equal(body.storage.reason, 'ok');

  // Pasta fora do ar: o /v1/status precisa dizer o motivo, não só "false".
  await fsp.rm(folder, { recursive: true, force: true });
  const expires = Math.floor(Date.now() / 1000) + 60;
  const sig = crypto.createHmac('sha256', secret).update('status\n\n' + expires).digest('hex');
  const status = await (await fetch(base + '/v1/status?expires=' + expires + '&sig=' + sig)).json();
  assert.equal(status.filer.reachable, false);
  assert.notEqual(status.storage.reason, 'ok', 'informa o motivo da falha');
  assert.equal(typeof status.storage.detail, 'string', 'informa o detalhe da falha');
});