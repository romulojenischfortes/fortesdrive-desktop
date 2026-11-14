const fs = require("node:fs/promises");

const pending = new WeakMap();
async function applySetupConfiguration(engine, filename) {
  if (pending.has(engine)) return pending.get(engine);
  if (engine.state.syncing) return false;
  const apply = async () => {
    const bytes = await fs.readFile(filename).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (bytes === null) return false;
    const text = bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
    let configuration;
    if (filename.endsWith(".ini")) {
      configuration = {};
      let section = "";
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("[")) { section = line; continue; }
        if (section !== "[Sync]") continue;
        const match = /^(watchFolder|machineRole)\s*=(.*)$/.exec(line);
        if (match) configuration[match[1]] = match[2].trim().replace(/^"(.*)"$/, "$1");
      }
    } else configuration = JSON.parse(text);
    if (configuration.watchFolder != null && (typeof configuration.watchFolder !== "string" || !configuration.watchFolder.trim())) throw new Error("O configurador não informou uma pasta válida.");
    if (configuration.machineRole != null && !["client", "server"].includes(configuration.machineRole)) throw new Error("Modo de instalacao invalido.");
    if (!configuration.watchFolder && !configuration.machineRole) throw new Error("Configuracao vazia.");
    // Nunca substitui os manifestos nem reinicia operacoes em andamento.
    if (engine.state.syncing) return false;
    if (configuration.watchFolder && (engine.watchFolder !== configuration.watchFolder || !engine.folderConfigured)) await engine.setWatchFolder(configuration.watchFolder);
    if (configuration.machineRole) engine.store.set("machineRole", configuration.machineRole);
    // Uma nova configuração que chegou durante a aplicação fica para depois.
    if ((await fs.readFile(filename)).equals(bytes)) await fs.unlink(filename);
    return true;
  };
  const work = apply();
  pending.set(engine, work);
  try { return await work; } finally { pending.delete(engine); }
}
module.exports = { applySetupConfiguration };