const fs = require("node:fs/promises");

const pending = new WeakMap();
async function applySetupConfiguration(engine, filename) {
  if (pending.has(engine)) return pending.get(engine);
  if (engine.state.syncing) return false;
  const apply = async () => {
    const text = await fs.readFile(filename, "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (text === null) return false;
    const configuration = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (configuration.watchFolder != null && (typeof configuration.watchFolder !== "string" || !configuration.watchFolder.trim())) throw new Error("O configurador não informou uma pasta válida.");
    if (configuration.machineRole != null && !["client", "server"].includes(configuration.machineRole)) throw new Error("Modo de instalacao invalido.");
    if (!configuration.watchFolder && !configuration.machineRole) throw new Error("Configuracao vazia.");
    // Nunca substitui os manifestos nem reinicia operacoes em andamento.
    if (engine.state.syncing) return false;
    if (configuration.watchFolder) await engine.setWatchFolder(configuration.watchFolder);
    if (configuration.machineRole) engine.store.set("machineRole", configuration.machineRole);
    // Uma nova configuração que chegou durante a aplicação fica para depois.
    if (await fs.readFile(filename, "utf8") === text) await fs.unlink(filename);
    return true;
  };
  const work = apply();
  pending.set(engine, work);
  try { return await work; } finally { pending.delete(engine); }
}
module.exports = { applySetupConfiguration };