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
  "server/gateway/Dockerfile",
  "server/setup-server.ps1",
];

test("o instalador do cliente nao leva Docker, ngrok nem servidor", () => {
  const resources = pkg.build?.extraResources ?? [];
  assert.equal(
    resources.some((entry) => String(entry.to ?? "") === "server"),
    false,
    "a pasta server nao deve ser publicada junto do cliente"
  );
  const include = read("build/overlays.nsh");
  assert.doesNotMatch(include, /setup-server\.ps1/, "o cliente nao abre o assistente do servidor");
  assert.doesNotMatch(include, /schtasks/i, "o cliente nao registra tarefas do servidor");
  assert.doesNotMatch(include, /docker/i, "Docker nao e instalado com o cliente");
  assert.doesNotMatch(include, /ngrok/i, "o tunel pertence ao servidor, nao ao cliente");
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
  const servidor = fs.readFileSync(path.join(root, "..", "public", "instalar-servidor.bat"), "utf8");
  assert.match(servidor, /docker/i, "o instalador do servidor e quem instala o Docker");
  assert.match(servidor, /ngrok/i, "o instalador do servidor e quem configura o tunel");
});

test("o servidor sobe o gateway na porta local do tunel", () => {
  const compose = read("server/docker-compose.yml");
  assert.match(compose, /gateway:/, "o compose precisa declarar o servico gateway");
  assert.match(compose, /127\.0\.0\.1:8790:8790/, "o gateway deve ser publicado apenas na porta local 8790");
  assert.match(compose, /FD_DATA_DIR/, "a pasta de dados precisa vir do arquivo .env");
});

test("o gateway grava direto na pasta de dados, sem servico intermediario", () => {
  const gateway = read("server/gateway/server.js");
  assert.match(gateway, /DATA_DIR/, "o gateway precisa gravar na pasta de dados (DATA_DIR)");
  assert.match(gateway, /x-fd-sha256/, "o gateway precisa conferir o checksum de cada envio");
  assert.match(gateway, /\/v1\/status/, "o gateway precisa informar o estado da gravacao");
  assert.doesNotMatch(gateway, /seaweedfs/i, "o gateway nao pode depender de outro servico para gravar");
});