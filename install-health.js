const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// Componentes que o instalador precisa entregar em toda versão. Se algum não
// estiver no disco, a atualização não foi aplicada por inteiro — e o cliente
// mostra o alerta em vez de fingir que deu certo.
const COMPONENTS = [
  { id: "exe", label: "Programa principal", file: null },
  { id: "gateway", label: "Gateway do servidor", file: "server/gateway/server.js" },
  { id: "nextcloud", label: "Integração com o Nextcloud", file: "server/gateway/nextcloud.js" },
  { id: "dockerfile", label: "Imagem do gateway", file: "server/gateway/Dockerfile" },
  { id: "compose", label: "Composição do servidor", file: "server/docker-compose.yml" },
  { id: "setup", label: "Assistente do servidor", file: "server/setup-server.ps1" },
  { id: "overlays", label: "Marcas do Explorador", file: "shell/FortesDriveOverlays.dll" },
];

/**
 * Registro da instalação usado pela verificação pós-atualização.
 *
 * `expectedVersion` é a versão que o atualizador baixou e que precisa estar em
 * execução no próximo início; `lastRunVersion` é a última versão aprovada na
 * verificação. Nenhum segredo passa por aqui: só versões e nomes de arquivo.
 */
function createInstallHealth({ app, resourcesPath }) {
  const directory = app.getPath("userData");
  const stateFile = path.join(directory, "fortesdrive-instalacao.json");
  const root = resourcesPath || process.resourcesPath;
  const state = { lastRunVersion: "", expectedVersion: "" };

  async function load() {
    try {
      const saved = JSON.parse(await fsp.readFile(stateFile, "utf8"));
      state.lastRunVersion = typeof saved.lastRunVersion === "string" ? saved.lastRunVersion : "";
      state.expectedVersion = typeof saved.expectedVersion === "string" ? saved.expectedVersion : "";
    } catch (error) {
      if (error.code !== "ENOENT") console.warn("Registro da instalação ilegível: " + error.message);
    }
    return report();
  }

  async function save(change) {
    Object.assign(state, change);
    try {
      await fsp.mkdir(directory, { recursive: true });
      await fsp.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
    } catch (error) {
      console.warn("Não foi possível gravar o registro da instalação: " + error.message);
    }
  }

  function present(relative) {
    const target = relative ? path.join(root, relative) : process.execPath;
    try {
      const info = fs.statSync(target);
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }

  function report() {
    const version = app.getVersion();
    const components = COMPONENTS.map(item => ({ id: item.id, label: item.label, ok: present(item.file) }));
    const missing = components.filter(item => !item.ok).map(item => item.label);
    // Atualização baixada que não está rodando = instalador não concluído.
    const pendingVersion = state.expectedVersion && state.expectedVersion !== version ? state.expectedVersion : "";
    return {
      version,
      previousVersion: state.lastRunVersion || "",
      justUpdated: Boolean(state.lastRunVersion && state.lastRunVersion !== version),
      expectedVersion: state.expectedVersion || "",
      versionOk: !pendingVersion,
      pendingVersion,
      components,
      missingComponents: missing,
      ok: !pendingVersion && missing.length === 0,
    };
  }

  /** Chamado quando o atualizador baixa uma versão nova. */
  async function expectUpdate(version) {
    if (!version) return report();
    await save({ expectedVersion: version });
    return report();
  }

  /** Fluxo completo aprovado: a versão em execução passa a ser a confirmada. */
  async function confirm(version) {
    const current = app.getVersion();
    if (version && version !== current) return report();
    await save({ lastRunVersion: current, expectedVersion: "" });
    return report();
  }

  return { load, report, expectUpdate, confirm };
}

module.exports = { createInstallHealth, COMPONENTS };