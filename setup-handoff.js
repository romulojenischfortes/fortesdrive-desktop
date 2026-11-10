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
    if (typeof configuration.watchFolder !== "string" || !configuration.watchFolder.trim()) {
      throw new Error("O configurador não informou uma pasta válida.");
    }
    // Não altera a raiz enquanto uma operação está usando o manifesto anterior.
    if (engine.state.syncing) return false;
    await engine.setWatchFolder(configuration.watchFolder);
    // Uma nova configuração que chegou durante a aplicação fica para depois.
    if (await fs.readFile(filename, "utf8") === text) await fs.unlink(filename);
    return true;
  };
  const work = apply();
  pending.set(engine, work);
  try { return await work; } finally { pending.delete(engine); }
}
module.exports = { applySetupConfiguration };