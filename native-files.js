const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { createReadStream } = require("fs");
const MAX_BYTES = 100 * 1024 * 1024;

async function checksum(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function safePath(root, relative, createParents = false) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes("\0")) throw new Error("Caminho inválido");
  const parts = relative.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p === ".fortesdrive" || /[<>:"|?*\x00-\x1f]/.test(p) || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(`Nome incompatível com o computador: ${relative}`);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (stat?.isSymbolicLink()) throw new Error("Links simbólicos não são sincronizados");
    if (i < parts.length - 1 && !stat && createParents) await fs.mkdir(current);
    if (i < parts.length - 1 && stat && !stat.isDirectory()) throw new Error("Uma pasta foi substituída por um arquivo");
  }
  return current;
}
async function scan(root) {
  const files = [], directories = [], skipped = [];
  async function visit(folder, prefix = "") {
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); }
    catch (e) { skipped.push({ path: prefix, reason: "Pasta não pôde ser lida: " + e.message }); return; }
    for (const entry of entries) {
      if (entry.name === ".fortesdrive") continue;
      if (entry.isSymbolicLink()) { skipped.push({ path: prefix + entry.name, reason: "Link simbólico não sincronizado" }); continue; }
      const relative = prefix + entry.name;
      let absolute;
      try { absolute = await safePath(root, relative); }
      catch (e) { skipped.push({ path: relative, reason: e.message }); continue; }
      try {
        const stat = await fs.stat(absolute);
        // Pula reparse points do OneDrive (Files On-Demand) e outros arquivos não regulares
        if (!stat.isFile() && !stat.isDirectory()) { skipped.push({ path: relative, reason: "Tipo não suportado" }); continue; }
        const identity = `${stat.dev}:${stat.ino}`;
        if (stat.isDirectory()) { directories.push({ path: relative, identity }); await visit(absolute, relative + "/"); }
        else if (stat.isFile()) {
          if (stat.size > MAX_BYTES) { skipped.push({ path: relative, reason: "Acima de 100 MB" }); continue; }
          let hash;
          try {
            hash = await checksum(absolute);
            const after = await fs.stat(absolute);
            if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) { skipped.push({ path: relative, reason: "Arquivo em edição ou download" }); continue; }
          } catch (e) { skipped.push({ path: relative, reason: "Não foi possível ler: " + e.message }); continue; }
          files.push({ path: relative, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs, checksum: hash, identity });
        }
      } catch (e) { skipped.push({ path: relative, reason: e.message }); }
    }
  }
  await visit(root);
  return { files, directories, skipped };
}
async function assertExpected(absolute, expected) {
  let stat;
  try { stat = await fs.lstat(absolute); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (stat?.isSymbolicLink()) throw new Error("Link simbólico bloqueado");
  if (expected === null && stat) throw new Error("Destino já existe; nenhum arquivo foi sobrescrito");
  if (typeof expected === "string" && (!stat?.isFile() || await checksum(absolute) !== expected)) throw new Error("Arquivo mudou durante a sincronização; será reconciliado novamente");
}
async function read(root, relative, expected) {
  const absolute = await safePath(root, relative);
  await assertExpected(absolute, expected);
  const stat = await fs.stat(absolute);
  if (stat.size > MAX_BYTES) throw new Error("Este cliente transfere arquivos de até 100 MB por arquivo");
  const buf = await fs.readFile(absolute);
  if (crypto.createHash("sha256").update(buf).digest("hex") !== expected) throw new Error("Arquivo alterado durante a leitura");
  // Retorna Uint8Array explícito para transferência IPC segura (sandbox mode)
  return new Uint8Array(buf);
}
async function write(root, relative, bytes, hash, expected) {
  if (!bytes || bytes.byteLength > MAX_BYTES) throw new Error("Arquivo excede 100 MB");
  const buffer = Buffer.from(bytes);
  if (crypto.createHash("sha256").update(buffer).digest("hex") !== hash) throw new Error("Conteúdo recebido não passou na verificação SHA-256");
  const absolute = await safePath(root, relative, true);
  await assertExpected(absolute, expected);
  const internal = path.join(root, ".fortesdrive");
  const existing = await fs.lstat(internal).catch(e => { if (e.code !== "ENOENT") throw e; });
  if (existing?.isSymbolicLink()) throw new Error("Diretório interno inseguro");
  await fs.mkdir(internal, { recursive: true });
  const temp = path.join(internal, crypto.randomUUID() + ".tmp");
  try {
    await fs.writeFile(temp, buffer, { flag: "wx" });
    await assertExpected(absolute, expected);
    await fs.rename(temp, absolute);
  } finally { await fs.rm(temp, { force: true }); }
  const saved = await fs.stat(absolute);
  return { size: saved.size, mtimeMs: saved.mtimeMs, identity: `${saved.dev}:${saved.ino}` };
}
async function move(root, from, to, expected) {
  const source = await safePath(root, from), destination = await safePath(root, to, true);
  await assertExpected(source, expected);
  await assertExpected(destination, null);
  await fs.rename(source, destination);
  const saved = await fs.stat(destination);
  return { size: saved.size, mtimeMs: saved.mtimeMs, identity: `${saved.dev}:${saved.ino}` };
}
module.exports = { safePath, scan, read, write, move, checksum, assertExpected, MAX_BYTES };