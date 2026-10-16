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
  const files = [], directories = [];
  async function visit(folder, prefix = "") {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.name === ".fortesdrive" || entry.isSymbolicLink()) continue;
      const relative = prefix + entry.name;
      const absolute = await safePath(root, relative);
      const stat = await fs.stat(absolute);
      const identity = `${stat.dev}:${stat.ino}`;
      if (entry.isDirectory()) { directories.push({ path: relative, identity }); await visit(absolute, relative + "/"); }
      else if (entry.isFile()) {
        const hash = await checksum(absolute), after = await fs.stat(absolute);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error(`Arquivo em edição, tentando no próximo ciclo: ${relative}`);
        files.push({ path: relative, name: entry.name, size: stat.size, checksum: hash, identity });
      }
    }
  }
  await visit(root);
  return { files, directories };
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
  const bytes = await fs.readFile(absolute);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Arquivo alterado durante a leitura");
  return bytes;
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
}
async function move(root, from, to, expected) {
  const source = await safePath(root, from), destination = await safePath(root, to, true);
  await assertExpected(source, expected);
  await assertExpected(destination, null);
  await fs.rename(source, destination);
}
module.exports = { safePath, scan, read, write, move, checksum, assertExpected, MAX_BYTES };