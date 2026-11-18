const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { createReadStream } = require("fs");
const MAX_BYTES = 100 * 1024 * 1024; // IPC legado: nunca carrega arquivos grandes na RAM.
const MAX_SCAN_BYTES = 10 * 1024 * 1024 * 1024;

async function checksum(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
// Resumo (SHA-256) reaproveitado entre varreduras. Sem isso, cada ciclo de
// sincronização relia e resumia a árvore inteira — o maior gasto de tempo do
// envio, porque a árvore é varrida de novo a cada lote. A entrada só vale para
// o mesmo dono do arquivo, tamanho e data de modificação; qualquer mudança
// obriga a resumir outra vez.
let cacheRoot = null;
const checksums = new Map();

// Nomes que o Windows não aceita: um só arquivo assim não pode derrubar a pasta.
const BAD_CHARS = /[<>:"|?*\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS = process.platform === "win32";
function validName(name) {
  return !!name && name !== "." && name !== ".." && name !== ".fortesdrive"
    && !BAD_CHARS.test(name) && !/[ .]$/.test(name) && !RESERVED.test(name);
}
// Documentos jurídicos passam fácil dos 260 caracteres que o Windows atende por
// padrão. O prefixo nativo libera o caminho longo; antes, essas pastas eram
// puladas inteiras e nunca chegavam à nuvem.
function nativePath(absolute) {
  if (!WINDOWS || absolute.startsWith("\\\\?\\")) return absolute;
  return absolute.length > 230 ? "\\\\?\\" + absolute : absolute;
}

function remember(root, relative, entry) {
  if (root !== cacheRoot) return;
  if (entry) checksums.set(relative, entry);
  else checksums.delete(relative);
}

async function safePath(root, relative, createParents = false) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes("\0")) throw new Error("Caminho inválido");
  const parts = relative.split("/");
  if (parts.some(p => !validName(p))) throw new Error(`Nome incompatível com o computador: ${relative}`);
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
// Quantos arquivos podem ser resumidos numa passagem. A primeira varredura de
// uma pasta grande lia e resumia tudo antes de devolver qualquer coisa: o painel
// ficava em "Sincronizando" com os contadores zerados e nenhum arquivo subia.
// Agora cada passagem resume um lote e devolve o que já está pronto; o restante
// continua nas passagens seguintes.
const HASH_BATCH = 4000;
async function scan(root, baseline = {}, { hashBudget = HASH_BATCH, onProgress } = {}) {
  if (cacheRoot !== root) { cacheRoot = root; checksums.clear(); }
  for (const entry of Object.values(baseline)) {
    if (entry.path && entry.ctimeMs != null && !checksums.has(entry.path)) checksums.set(entry.path, entry);
  }
  const seen = new Set();
  const files = [], directories = [], skipped = [];
  let totalBytes = 0, totalFiles = 0;
  // Arquivos encontrados, à espera do resumo. O resumo roda depois, em paralelo:
  // ler 40 GB de documentos um de cada vez era o maior gasto de tempo do envio.
  const queue = [];
  async function visit(folder, prefix = "") {
    let entries;
    try { entries = await fs.readdir(nativePath(folder), { withFileTypes: true }); }
    catch (e) { skipped.push({ path: prefix.replace(/\/$/, ""), reason: "Pasta não pôde ser lida: " + e.message }); return; }
    for (const entry of entries) {
      if (entry.name === ".fortesdrive" || entry.name.startsWith(".fortesdrive-transfer-")) continue;
      if (entry.isSymbolicLink()) { skipped.push({ path: prefix + entry.name, reason: "Link simbólico não sincronizado" }); continue; }
      const relative = prefix + entry.name;
      // O nome é conferido aqui, sem reabrir pasta por pasta: cada arquivo custava
      // uma consulta a cada pasta acima dele, o que pesava em árvores grandes.
      if (!validName(entry.name)) { skipped.push({ path: relative, reason: `Nome incompatível com o computador: ${entry.name}` }); continue; }
      const absolute = path.join(folder, entry.name);
      try {
        const stat = await fs.stat(nativePath(absolute));
        // Pula reparse points do OneDrive (Files On-Demand) e outros arquivos não regulares
        if (!stat.isFile() && !stat.isDirectory()) { skipped.push({ path: relative, reason: "Tipo não suportado" }); continue; }
        const identity = `${stat.dev}:${stat.ino}`;
        if (stat.isDirectory()) { directories.push({ path: relative, identity }); await visit(absolute, relative + "/"); }
        else if (stat.isFile()) {
          totalBytes += stat.size; totalFiles++;
          if (stat.size > MAX_SCAN_BYTES) { skipped.push({ path: relative, size: stat.size, reason: "Acima do limite de 10 GiB por arquivo do servidor" }); continue; }
          seen.add(relative);
          queue.push({ relative, absolute, stat, identity });
        }
      } catch (e) { skipped.push({ path: relative, reason: e.message }); }
    }
  }
  await visit(root);
  // Quem já tem resumo válido (mesmo dono, tamanho e datas) volta sem reler o
  // conteúdo; só o que mudou ou nunca foi lido entra no lote desta passagem.
  const ready = (item) => {
    const known = checksums.get(item.relative);
    return known && known.size === item.stat.size && known.mtimeMs === item.stat.mtimeMs && known.ctimeMs === item.stat.ctimeMs && known.identity === item.identity ? known.checksum : null;
  };
  const describe = (item, digest) => ({ path: item.relative, name: item.relative.slice(item.relative.lastIndexOf("/") + 1), size: item.stat.size, mtimeMs: item.stat.mtimeMs, ctimeMs: item.stat.ctimeMs, checksum: digest, identity: item.identity });
  const waiting = [];
  for (const item of queue) {
    const digest = ready(item);
    if (digest) files.push(describe(item, digest));
    else waiting.push(item);
  }
  const hashing = waiting.slice(0, Math.max(0, hashBudget));
  const remaining = waiting.slice(hashing.length);
  const pendingHash = remaining.length;
  const pendingBytes = remaining.reduce((sum, item) => sum + item.stat.size, 0);
  let next = 0;
  const report = () => { try { onProgress?.({ total: totalFiles, hashed: files.length, pending: pendingHash }); } catch (e) {} };
  const lanes = Array.from({ length: Math.min(8, hashing.length) }, async () => {
    while (next < hashing.length) {
      const { relative, absolute, stat, identity } = hashing[next++];
      try {
        const hash = await checksum(nativePath(absolute));
        const after = await fs.stat(nativePath(absolute));
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) { remember(root, relative, null); skipped.push({ path: relative, reason: "Arquivo em edição ou download" }); continue; }
        remember(root, relative, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, identity, checksum: hash });
        files.push({ path: relative, name: relative.slice(relative.lastIndexOf("/") + 1), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, checksum: hash, identity });
        if (files.length % 50 === 0) report();
      } catch (e) { skipped.push({ path: relative, reason: "Não foi possível ler: " + e.message }); }
    }
  });
  await Promise.all(lanes);
  report();
  // Arquivos que sumiram saem do cache: ele não cresce sem limite.
  for (const key of [...checksums.keys()]) if (!seen.has(key)) checksums.delete(key);
  return { files, directories, skipped, totalBytes, totalFiles, pendingHash, pendingBytes, complete: pendingHash === 0 };
}
async function assertExpected(absolute, expected) {
  let stat;
  try { stat = await fs.lstat(absolute); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (stat?.isSymbolicLink()) throw new Error("Link simbólico bloqueado");
  if (expected === null && stat) throw new Error("Destino já existe; nenhum arquivo foi sobrescrito");
  if (typeof expected === "string" && (!stat?.isFile() || await checksum(absolute) !== expected)) throw new Error("Arquivo mudou durante a sincronização; será reconciliado novamente");
}
async function read(root, relative, expected) {
  const absolute = nativePath(await safePath(root, relative));
  const stat = await fs.lstat(absolute).catch(e => { if (e.code !== "ENOENT") throw e; });
  if (stat?.isSymbolicLink()) throw new Error("Link simbólico bloqueado");
  if (!stat?.isFile()) throw new Error("Arquivo não encontrado; nenhum conteúdo foi enviado");
  if (stat.size > MAX_BYTES) throw new Error("Este cliente transfere arquivos de até 100 MB por arquivo");
  const buf = await fs.readFile(absolute);
  // Uma única passagem de resumo por arquivo: este mesmo SHA-256 confere o
  // conteúdo — antes o arquivo era resumido duas vezes antes de cada envio.
  if (expected && crypto.createHash("sha256").update(buf).digest("hex") !== expected) throw new Error("Arquivo alterado durante a leitura");
  // Retorna Uint8Array explícito para transferência IPC segura (sandbox mode)
  return new Uint8Array(buf);
}
async function write(root, relative, bytes, hash, expected) {
  if (!bytes || bytes.byteLength > MAX_BYTES) throw new Error("Arquivo excede 100 MB");
  const buffer = Buffer.from(bytes);
  if (crypto.createHash("sha256").update(buffer).digest("hex") !== hash) throw new Error("Conteúdo recebido não passou na verificação SHA-256");
  const absolute = nativePath(await safePath(root, relative, true));
  await assertExpected(absolute, expected);
  const internal = nativePath(path.join(root, ".fortesdrive"));
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
  // Quem acabou de gravar já conhece o resumo: a próxima varredura não relê o arquivo.
  remember(root, relative, { size: saved.size, mtimeMs: saved.mtimeMs, identity: `${saved.dev}:${saved.ino}`, checksum: hash });
  return { size: saved.size, mtimeMs: saved.mtimeMs, identity: `${saved.dev}:${saved.ino}` };
}
async function move(root, from, to, expected) {
  const source = await safePath(root, from), destination = await safePath(root, to, true);
  await assertExpected(source, expected);
  await assertExpected(destination, null);
  await fs.rename(source, destination);
  const saved = await fs.stat(destination);
  remember(root, from, null);
  remember(root, to, { size: saved.size, mtimeMs: saved.mtimeMs, identity: `${saved.dev}:${saved.ino}`, checksum: expected });
  return { size: saved.size, mtimeMs: saved.mtimeMs, identity: `${saved.dev}:${saved.ino}` };
}
module.exports = { safePath, scan, read, write, move, checksum, assertExpected, MAX_BYTES, MAX_SCAN_BYTES };