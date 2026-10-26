// O instalador do cliente também prepara o servidor de armazenamento.
// Se o pacote do servidor sair do instalador, o cliente instala sem ter com o
// que sincronizar — por isso estes arquivos são verificados aqui, e não apenas
// na máquina de quem instala.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const PAYLOAD = [
  "server/docker-compose.yml",
  "server/gateway/server.js",
  "server/gateway/Dockerfile",
  "server/setup-server.ps1",
];

test("o pacote do servidor acompanha o instalador", () => {
  const resources = pkg.build?.extraResources ?? [];
  const shipsServer = resources.some((entry) => String(entry.to ?? "") === "server");
  assert.ok(shipsServer, "a pasta server precisa ser publicada junto do aplicativo");
  for (const relative of PAYLOAD) {
    assert.ok(fs.existsSync(path.join(root, relative)), `arquivo do servidor ausente: ${relative}`);
  }
});

test("o servidor sobe o gateway na porta local do tunel", () => {
  const compose = read("server/docker-compose.yml");
  assert.match(compose, /gateway:/, "o compose precisa declarar o servico gateway");
  assert.match(compose, /seaweedfs:/, "o compose precisa declarar o SeaweedFS");
  assert.match(compose, /127\.0\.0\.1:8790:8790/, "o gateway deve ser publicado apenas na porta local 8790");
});

test("o assistente usa o proprio pacote e reaproveita o segredo existente", () => {
  const script = read("server/setup-server.ps1");
  assert.match(script, /PSScriptRoot/, "o assistente deve ler os arquivos do proprio pacote");
  assert.match(script, /STORAGE_SIGNING_SECRET/, "o assistente precisa tratar o segredo de assinatura");
  assert.match(script, /docker compose up -d --build/, "o assistente precisa subir os servicos");
});

test("a instalacao do cliente abre o assistente do servidor", () => {
  const include = read("build/overlays.nsh");
  assert.match(
    include,
    /resources\\server\\setup-server\.ps1/,
    "o instalador precisa executar o assistente do servidor"
  );
  assert.match(include, /configurar servidor\.lnk/, "o atalho de reconfiguracao precisa ser criado");
  assert.match(include, /Delete .*configurar servidor\.lnk/, "o atalho precisa ser removido na desinstalacao");
});

test("o servidor e o tunel sobem sozinhos com o Windows, no mesmo endereco", () => {
  const script = read("server/setup-server.ps1");
  assert.match(
    script,
    /uranometrical-nonequatorial-kiley\.ngrok-free\.dev/,
    "o endereco do tunel precisa ir junto do assistente"
  );
  assert.match(script, /ngrok-domain\.txt/, "o endereco usado precisa ficar guardado para a subida automatica");
  assert.match(script, /New-ScheduledTaskTrigger -AtStartup/, "a tarefa precisa subir ao ligar o Windows");
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/, "a tarefa precisa subir tambem na entrada da sessao");
  assert.match(script, /Register-ScheduledTask/, "a tarefa precisa ser registrada pelo instalador");
  assert.match(script, /iniciar-servidor\.ps1/, "a subida automatica precisa ficar num script proprio");
  assert.match(script, /iniciar-servidor\.log/, "a subida automatica precisa deixar registro para diagnostico");
});