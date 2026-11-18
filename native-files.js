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
// Quantos arquivos podem ser resumidos numa passagem.
const HASH_BATCH = 4000;
// Uma passagem nunca fica aberta por tempo indefinido. Antes, cada passagem
// percorria a árvore inteira e resumia tudo antes de devolver qualquer arquivo:
// numa pasta com dezenas de milhares de documentos isso passava do tempo limite
// do ciclo, a sincronização era liberada no meio e a leitura recomeçava do
// início — os contadores paravam e nada subia.
const WALK_PASS_MS = 30 * 1000;
const HASH_PASS_MS = 60 * 1000;
// Uma única pasta ou arquivo que não responde (disco removido, OneDrive que
// nunca baixa) não pode segurar a pasta inteira: cada operação tem o seu limite.
const OP_TIMEOUT_MS = 20 * 1000;
const READ_TIMEOUT_MS = 120 * 1000;
// Um arquivo que não respondeu volta para a fila das próximas passagens; só
// depois de algumas tentativas ele é dado como fora da sincronização.
const READ_TRIES = 3;

function withTimeout(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => { const error = new Error(message); error.timeout = true; reject(error); }, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Onde a varredura parou, por pasta raiz. Sem isso, cada passagem relia a árvore
// inteira do zero e o trabalho nunca chegava ao fim numa pasta grande.
const walks = new Map();
function newWalk(root) {
  return { stack: [{ folder: root, prefix: "" }], current: null, files: [], pending: [], directories: [], skipped: [], seen: new Set(), totalFiles: 0, totalBytes: 0, complete: false };
}

async function scan(root, baseline = {}, { hashBudget = HASH_BATCH, onProgress, restart = false } = {}) {
  if (cacheRoot !== root) { cacheRoot = root; checksums.clear(); walks.clear(); }
  for (const entry of Object.values(baseline)) {
    if (entry.path && entry.ctimeMs != null && !checksums.has(entry.path)) checksums.set(entry.path, entry);
  }
  let walk = walks.get(root);
  // Uma varredura concluída recomeça na passagem seguinte — é assim que arquivos
  // novos ou alterados aparecem. O resumo já conhecido volta do cache, sem reler.
  if (!walk || walk.complete || restart) { walk = newWalk(root); walks.set(root, walk); }
  const passStart = Date.now();
  const report = () => { try { onProgress?.({ total: walk.totalFiles, hashed: walk.files.length, pending: walk.pending.length }); } catch (e) {} };
  // Quem já tem resumo válido (mesmo dono, tamanho e datas) volta sem reler o
  // conteúdo; só o que mudou ou nunca foi lido entra na fila do resumo.
  const ready = (relative, stat, identity) => {
    const known = checksums.get(relative);
    return known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.ctimeMs === stat.ctimeMs && known.identity === identity ? known.checksum : null;
  };
  const describe = (relative, stat, identity, digest) => ({ path: relative, name: relative.slice(relative.lastIndexOf("/") + 1), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, checksum: digest, identity });
  report();

  // 1) Percorre só até ter arquivos suficientes para a próxima leva. O ponto de
  //    parada fica guardado e a passagem seguinte continua exatamente dele.
  while (Date.now() - passStart < WALK_PASS_MS && walk.pending.length < hashBudget) {
    if (!walk.current) {
      if (!walk.stack.length) break;
      const next = walk.stack.pop();
      let entries;
      try { entries = await withTimeout(fs.readdir(nativePath(next.folder), { withFileTypes: true }), OP_TIMEOUT_MS, "A pasta demorou demais para responder"); }
      catch (e) { walk.skipped.push({ path: next.prefix.replace(/\/$/, ""), reason: "Pasta não pôde ser lida: " + e.message }); continue; }
      walk.current = { folder: next.folder, prefix: next.prefix, entries, index: 0 };
    }
    const current = walk.current;
    while (current.index < current.entries.length) {
      if (walk.pending.length >= hashBudget || Date.now() - passStart >= WALK_PASS_MS) break;
      const entry = current.entries[current.index++];
      if (entry.name === ".fortesdrive" || entry.name.startsWith(".fortesdrive-transfer-")) continue;
      if (entry.isSymbolicLink()) { walk.skipped.push({ path: current.prefix + entry.name, reason: "Link simbólico não sincronizado" }); continue; }
      const relative = current.prefix + entry.name;
      // O nome é conferido aqui, sem reabrir pasta por pasta: cada arquivo custava
      // uma consulta a cada pasta acima dele, o que pesava em árvores grandes.
      if (!validName(entry.name)) { walk.skipped.push({ path: relative, reason: `Nome incompatível com o computador: ${entry.name}` }); continue; }
      const absolute = path.join(current.folder, entry.name);
      try {
        const stat = await withTimeout(fs.stat(nativePath(absolute)), OP_TIMEOUT_MS, "O item demorou demais para responder");
        // Pula reparse points do OneDrive (Files On-Demand) e outros arquivos não regulares
        if (!stat.isFile() && !stat.isDirectory()) { walk.skipped.push({ path: relative, reason: "Tipo não suportado" }); continue; }
        const identity = `${stat.dev}:${stat.ino}`;
        if (stat.isDirectory()) { walk.directories.push({ path: relative, identity }); walk.stack.push({ folder: absolute, prefix: relative + "/" }); }
        else if (stat.isFile()) {
          walk.totalBytes += stat.size; walk.totalFiles++;
          if (stat.size > MAX_SCAN_BYTES) { walk.skipped.push({ path: relative, size: stat.size, reason: "Acima do limite de 10 GiB por arquivo do servidor" }); continue; }
          walk.seen.add(relative);
          const digest = ready(relative, stat, identity);
          if (digest) walk.files.push(describe(relative, stat, identity, digest));
          else walk.pending.push({ relative, absolute, stat, identity, tries: 0 });
        }
      } catch (e) { walk.skipped.push({ path: relative, reason: e.message }); }
    }
    if (current.index >= current.entries.length) walk.current = null;
  }
  report();

  // 2) Resume a leva desta passagem em paralelo, com limite por arquivo e limite
  //    total da passagem.
  const hashing = walk.pending.splice(0, Math.max(0, hashBudget));
  let next = 0;
  const lanes = Array.from({ length: Math.min(8, hashing.length) }, async () => {
    while (next < hashing.length && Date.now() - passStart < HASH_PASS_MS) {
      const item = hashing[next++];
      try {
        const hash = await withTimeout(checksum(nativePath(item.absolute)), READ_TIMEOUT_MS, "A leitura do arquivo demorou demais");
        const after = await withTimeout(fs.stat(nativePath(item.absolute)), OP_TIMEOUT_MS, "O arquivo demorou demais para responder");
        if (item.stat.size !== after.size || item.stat.mtimeMs !== after.mtimeMs) { remember(root, item.relative, null); walk.skipped.push({ path: item.relative, reason: "Arquivo em edição ou download" }); continue; }
        remember(root, item.relative, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, identity: item.identity, checksum: hash });
        walk.files.push(describe(item.relative, item.stat, item.identity, hash));
        if (walk.files.length % 50 === 0) report();
      } catch (e) {
        item.tries++;
        if (e.timeout && item.tries < READ_TRIES) walk.pending.push(item);
        else walk.skipped.push({ path: item.relative, reason: "Não foi possível ler: " + e.message });
      }
    }
  });
  await Promise.all(lanes);
  // O que não entrou nesta leva continua na fila da próxima passagem.
  if (next < hashing.length) walk.pending.unshift(...hashing.slice(next));
  report();
  walk.complete = !walk.stack.length && !walk.current && !walk.pending.length;
  // Arquivos que sumiram saem do cache: ele não cresce sem limite.
  if (walk.complete) for (const key of [...checksums.keys()]) if (!walk.seen.has(key)) checksums.delete(key);
  return {
    files: walk.files, directories: walk.directories, skipped: walk.skipped,
    totalBytes: walk.totalBytes, totalFiles: walk.totalFiles,
    pendingHash: walk.pending.length, pendingBytes: walk.pending.reduce((sum, item) => sum + item.stat.size, 0),
    complete: walk.complete,
  };
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