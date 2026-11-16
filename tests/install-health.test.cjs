// A verificação pós-atualização precisa acusar componente ausente e versão
// baixada que não entrou em execução: sem isso o alerta nunca apareceria.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createInstallHealth, COMPONENTS } = require("../install-health");

async function montar() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "fd-verificacao-"));
  const resources = path.join(base, "resources");
  for (const item of COMPONENTS) {
    if (!item.file) continue;
    const target = path.join(resources, item.file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "conteudo");
  }
  const app = { getVersion: () => "1.8.0", getPath: () => path.join(base, "userData") };
  return { resources, app };
}

test("aprova a instalação quando todos os componentes estão presentes", async () => {
  const { resources, app } = await montar();
  const health = createInstallHealth({ app, resourcesPath: resources });
  await health.load();
  const report = health.report();
  assert.equal(report.ok, true);
  assert.deepEqual(report.missingComponents, []);
  assert.equal(report.versionOk, true);
});

test("acusa o componente que a atualização não entregou", async () => {
  const { resources, app } = await montar();
  await fs.rm(path.join(resources, "server/gateway/nextcloud.js"));
  const health = createInstallHealth({ app, resourcesPath: resources });
  await health.load();
  const report = health.report();
  assert.equal(report.ok, false);
  assert.deepEqual(report.missingComponents, ["Integração com o Nextcloud"]);
});

test("acusa versão baixada que não está em execução", async () => {
  const { resources, app } = await montar();
  const health = createInstallHealth({ app, resourcesPath: resources });
  await health.load();
  await health.expectUpdate("1.9.0");
  const report = health.report();
  assert.equal(report.versionOk, false);
  assert.equal(report.pendingVersion, "1.9.0");
  assert.equal(report.ok, false);
});

test("confirmar guarda a versão verificada e encerra o alerta", async () => {
  const { resources, app } = await montar();
  const health = createInstallHealth({ app, resourcesPath: resources });
  await health.load();
  await health.expectUpdate("1.8.0");
  const confirmed = await health.confirm("1.8.0");
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.previousVersion, "1.8.0");
  const reloaded = createInstallHealth({ app, resourcesPath: resources });
  await reloaded.load();
  assert.equal(reloaded.report().previousVersion, "1.8.0");
  assert.equal(reloaded.report().justUpdated, false);
});