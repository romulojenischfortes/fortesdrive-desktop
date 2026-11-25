const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// O túnel do Cloudflare saiu do Windows e virou um serviço do Docker Compose.
// Esta suíte protege três coisas que já quebraram de verdade:
//   1. o instalador parava logo depois do teste de armazenamento, porque gravava
//      em $host — variável automática e somente leitura do PowerShell;
//   2. o destino do túnel apontava para localhost, que dentro do contêiner é o
//      próprio contêiner do túnel (endereço público respondendo 502);
//   3. o token do túnel não chegava ao serviço do Docker.

// Os testes rodam no repositório e no pacote publicado (desktop/…); o arquivo
// compartilhado do app só existe no repositório.
const desktopRoot = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(desktopRoot, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(desktopRoot, file));

const sharedPath = path.resolve(desktopRoot, '..', 'base44/shared/cloudflareTunnel.ts');
const shared = fs.existsSync(sharedPath) ? fs.readFileSync(sharedPath, 'utf8') : null;

const compose = read('server/docker-compose.yml');
const setup = read('server/setup-server.ps1');
const desktopTunnel = read('server-tunnel.js');

const GATEWAY_SERVICE = 'http://gateway:8790';

test('o túnel roda como serviço do Docker, na rede do gateway', () => {
  const servico = compose.slice(compose.indexOf('\n  cloudflared:'));
  assert.ok(servico.length > 0, 'o serviço cloudflared precisa existir no Compose');
  assert.match(servico, /image: cloudflare\/cloudflared/);
  assert.match(servico, /TUNNEL_TOKEN:\s*\$\{CLOUDFLARE_TUNNEL_TOKEN/);
  assert.match(servico, /profiles:\s*\n\s*-\s*tunnel/);
  assert.match(servico, /depends_on:\s*\n\s*-\s*gateway/);
  assert.match(servico, /networks:\s*\n\s*-\s*fd-storage/);
});

test('o gateway continua publicado só no próprio computador', () => {
  assert.match(compose, /127\.0\.0\.1:8790:8790/);
});

test('o instalador não grava mais na variável reservada $host', () => {
  // $host é automático e somente leitura: atribuir encerrava a instalação com
  // VariableNotWritable logo depois do teste de armazenamento.
  assert.doesNotMatch(setup, /^\s*\$host\s*=/m);
  assert.doesNotMatch(setup, /function\s+[A-Za-z-]+\s*\(\s*\$host\s*\)/);
  assert.match(setup, /function Limpar-HostPublico\(\$valor\)/);
  assert.match(setup, /function Problema-HostPublico\(\$nomeHost\)/);
});

test('o destino do túnel é o serviço do gateway, nunca localhost', { skip: !shared }, () => {
  assert.ok(setup.includes("$destinoTunel = '" + GATEWAY_SERVICE + "'"));
  // O gateway em si continua conferido no próprio computador (porta publicada),
  // mas o túnel nunca é apontado para localhost.
  assert.doesNotMatch(setup, /aponta para http:\/\/localhost:8790/);
  assert.doesNotMatch(setup, /--url http:\/\/127\.0\.0\.1:8790/);
  assert.doesNotMatch(shared, /const TUNNEL_SERVICE = 'http:\/\/localhost:8790'/);
  assert.ok(shared.includes("const TUNNEL_SERVICE = '" + GATEWAY_SERVICE + "';"));
});

test('o instalador guarda o token no .env e sobe o túnel pelo Docker', () => {
  assert.match(setup, /Definir-VariavelEnv 'CLOUDFLARE_TUNNEL_TOKEN' \$tokenTunel/);
  assert.match(setup, /compose --profile tunnel up -d --no-deps \$servicoTunel/);
  // O binário do Windows não é mais baixado nem executado.
  assert.doesNotMatch(setup, /cloudflared-windows-amd64\.exe/);
  assert.doesNotMatch(setup, /Start-Process -FilePath \$cloudflared/);
});

test('a conferência da Cloudflare acontece antes de subir os serviços', () => {
  const conferencia = setup.indexOf("Provisionar-Servidor $codigoInstalacao 'validate'");
  const subida = setup.indexOf('$subida = Invoke-DockerComSaida compose up -d --build');
  assert.ok(conferencia > 0, 'o instalador precisa conferir a Cloudflare');
  assert.ok(subida > 0, 'o instalador precisa subir os serviços');
  assert.ok(conferencia < subida, 'a conferência vem antes de reiniciar qualquer serviço');
  assert.match(setup, /Provisionar-Servidor \$codigoInstalacao 'provision'/);
});

test('a subida automática com o Windows usa o túnel do Docker', () => {
  const inicio = setup.slice(setup.indexOf("$scriptInicio = Join-Path $pasta 'iniciar-servidor.ps1'"));
  assert.ok(inicio.includes('docker compose --profile tunnel up -d --no-deps cloudflared'));
  assert.doesNotMatch(inicio, /Start-Process -FilePath \$exeCloudflared/);
});

test('o instalador continua preservando dados e segredo de assinatura', () => {
  assert.match(setup, /'STORAGE_SIGNING_SECRET=' \+ \$segredo/);
  assert.match(setup, /Resolver-CaminhoPasta \$dadosExistentes/);
});

test('o aplicativo desktop gerencia o túnel pelo Docker', () => {
  assert.match(desktopTunnel, /"--profile", "tunnel", "up", "-d", "--no-deps", "cloudflared"/);
  assert.match(desktopTunnel, /"--profile", "tunnel", "stop", "cloudflared"/);
  assert.ok(desktopTunnel.includes(GATEWAY_SERVICE));
});

test('o pacote do servidor leva o Compose e o assistente', () => {
  assert.ok(exists('server/docker-compose.yml'));
  assert.ok(exists('server/setup-server.ps1'));
});

test('atualizacao silenciosa aplica o reparo ao gateway instalado sem pedir confirmacao', () => {
  const repair = read('server/repair-uploads.bat');
  assert.match(desktopTunnel, /await this\.updateGatewayIfNeeded\(local\.version\)/);
  assert.match(desktopTunnel, /process\.resourcesPath, 'server', 'repair-uploads\.bat'/);
  assert.match(desktopTunnel, /automatic/);
  assert.match(repair, /\$automatic = \$env:FD_REPAIR_MODE -eq 'automatic'/);
  assert.match(repair, /if \(-not \$patchOnly -and -not \$automatic\)/);
  assert.match(repair, /"automatic" exit \/b %FD_REPAIR_CODE%/);
});