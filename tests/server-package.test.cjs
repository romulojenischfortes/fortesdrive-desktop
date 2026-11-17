// O instalador do cliente instala APENAS o aplicativo. Docker, gateway e túnel
// pertencem ao servidor de armazenamento, que roda em um único computador e tem
// instalador próprio (public/instalar-servidor.bat). Estes testes garantem que o
// cliente continue simples — e que o pacote do servidor continue pronto para o
// instalador dele.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const SERVER_PAYLOAD = [
  "server/docker-compose.yml",
  "server/gateway/server.js",
  "server/gateway/nextcloud.js",
  "server/gateway/Dockerfile",
  "server/repair-uploads.bat",
  "server/setup-server.ps1",
];

test("o instalador unificado inclui servidor mas so configura no modo servidor", () => {
  assert.ok(pkg.build.extraResources.some(entry => entry.to === 'server'));
  const include = read('build/overlays.nsh');
  assert.match(include, /FortesRolePageCreate/);
  assert.match(include, /\$FortesMachineRole.*==.*"server"[\s\S]*setup-server\.ps1/);
  assert.match(include, /IfNot.*Silent/);
});

test("o cliente instala o aplicativo e as marcas do Explorador", () => {
  const include = read("build/overlays.nsh");
  assert.match(include, /RegisterFortesOverlay 1 Synced/, "as marcas de sincronizacao continuam sendo registradas");
  assert.match(include, /FortesDriveOverlays\.dll/, "a DLL das marcas precisa ser registrada");
  assert.equal(pkg.build?.nsis?.runAfterFinish, true, "o aplicativo abre ao final da instalacao");
});

test("o pacote do servidor segue pronto para o instalador proprio do servidor", () => {
  for (const relative of SERVER_PAYLOAD) {
    assert.ok(fs.existsSync(path.join(root, relative)), `arquivo do servidor ausente: ${relative}`);
  }
});

test("o servidor sobe o gateway na porta local do tunel", () => {
  const compose = read("server/docker-compose.yml");
  assert.match(compose, /gateway:/, "o compose precisa declarar o servico gateway");
  assert.match(compose, /127\.0\.0\.1:8790:8790/, "o gateway deve ser publicado apenas na porta local 8790");
  assert.match(compose, /FD_DATA_DIR/, "a pasta de dados precisa vir do arquivo .env");
  assert.match(compose, /nextcloud:/, "o Nextcloud e o servico que guarda os arquivos");
  assert.match(compose, /NEXTCLOUD_URL/, "o gateway precisa falar com o Nextcloud pela rede interna");
});

test("o gateway grava no Nextcloud e continua conferindo cada envio", () => {
  const gateway = read("server/gateway/server.js");
  assert.match(gateway, /DATA_DIR/, "o gateway precisa da pasta de dados (origem da migracao)");
  assert.match(gateway, /x-fd-sha256/, "o gateway precisa conferir o checksum de cada envio");
  assert.match(gateway, /\/v1\/status/, "o gateway precisa informar o estado da gravacao");
  assert.match(gateway, /\/v1\/migrate/, "o gateway precisa migrar os arquivos antigos para o Nextcloud");
  assert.doesNotMatch(gateway, /seaweedfs/i, "o gateway nao pode depender de outro servico para gravar");
});

test("o gateway so se considera pronto com o armazenamento gravavel", () => {
  const gateway = read("server/gateway/server.js");
  assert.match(gateway, /'\/health'[\s\S]{0,600}storage:/, "o /health informa o estado do armazenamento");
  assert.match(gateway, /storageSnapshotNow/, "o estado do armazenamento e testado de verdade");

  const nextcloud = read("server/gateway/nextcloud.js");
  assert.match(nextcloud, /NEXTCLOUD_USER \|\| process\.env\.NEXTCLOUD_ADMIN_USER/, "o gateway aceita a conta que o assistente grava no .env");
  assert.match(nextcloud, /webdav-auth/, "a falha de gravacao informa o motivo");
  assert.match(nextcloud, /async function probe/, "o teste de gravacao grava, le de volta e apaga");

  const assistant = read("server/setup-server.ps1");
  assert.match(assistant, /NEXTCLOUD_USER=/, "o assistente grava NEXTCLOUD_USER no .env");
  assert.match(assistant, /Classificar-Falha/, "o assistente informa o motivo da falha de gravacao");
  assert.match(assistant, /Testar-GatewayPublico/, "o assistente valida o endereco publico");
});

test("o instalador publicado nao distribui mais o pacote antigo", () => {
  const published = path.join(root, "..", "public/instalar-servidor.bat");
  if (!fs.existsSync(published)) return;
  const source = fs.readFileSync(published, "utf8");
  assert.doesNotMatch(source, /seaweedfs/i, "o armazenamento antigo nao e mais distribuido");
  assert.doesNotMatch(source, /ngrok/i, "o tunel ngrok nao e mais distribuido");
  assert.match(source, /desktopInstaller/, "entrega o instalador unico do FortesDrive Desktop");
});