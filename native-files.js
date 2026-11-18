const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { createReadStream } = require("fs");
const MAX_BYTES = 100 * 1024 * 1024; // IPC legado: nunca carrega arquivos grandes na RAM.
const MAX_SCAN_BYTES = 10 * 1024 * 1024 * 1024;

async function checksum(file, size) {
  // Arquivo pequeno: uma leitura só custa menos que abrir um fluxo, e é nesta
  // faixa que está a maior parte dos documentos.
  if (size != null && size <= SMALL_FILE_BYTES) {
    const buffer = await fs.readFile(file);
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: STREAM_CHUNK })) hash.update(chunk);
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
// A varredura precisa terminar depressa mesmo com dezenas de milhares de
// arquivos. O que pesa não é o tamanho da pasta, e sim a quantidade de idas ao
// disco: uma consulta por vez levava minutos só para listar a árvore. Agora as
// pastas e os itens são consultados em paralelo, como fazem os clientes de
// sincronização de mercado.
const READDIR_LANES = 8;    // pastas listadas ao mesmo tempo
const STAT_LANES = 32;      // informações de itens pedidas ao mesmo tempo
const HASH_LANES = 16;      // arquivos resumidos ao mesmo tempo
// Arquivo pequeno é resumido numa leitura só; os grandes vão em fluxo, com
// blocos maiores para reduzir as chamadas ao disco.
const SMALL_FILE_BYTES = 1024 * 1024;
const STREAM_CHUNK = 1024 * 1024;
// Uma única pasta ou arquivo que não responde (disco removido, OneDrive que
// nunca baixa) não pode segurar a pasta inteira: cada operação tem o seu limite.
const OP_TIMEOUT_MS = 20 * 1000;
const READ_TIMEOUT_MS = 120 * 1000;
// Um arquivo que não respondeu volta para a fila das próximas passagens; só
// depois de algumas tentativas ele é dado como fora da sincronização.
const READ_TRIES = 3;
// Uma pasta que não responde é tentada de novo antes de ser dada como ilegível.
const READDIR_TRIES = 2;
// A raiz é a única pasta sem a qual nada pode ser concluído: ela tem prazo mais
// longo que as demais.
const ROOT_TIMEOUT_MS = 60 * 1000;
// Quanto tempo de resumo (SHA-256) uma passagem faz antes de devolver o
// controle. A árvore da pasta é conhecida em segundos e o que já foi resumido
// começa a subir na hora; o restante continua na passagem seguinte, sem reler
// o que já foi lido.
const HASH_BUDGET_MS = 20 * 1000;

function withTimeout(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => { const error = new Error(message); error.timeout = true; reject(error); }, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Limite simples de trabalho simultâneo: mantém N operações abertas e as demais
// esperando a vez, sem abrir milhares de leituras ao mesmo tempo.
function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; next(); });
  };
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
}

// O que já foi percorrido e o que falta resumir, por pasta raiz. A árvore é
// conhecida numa passagem só; este estado guarda o resultado dela.
const walks = new Map();
function newWalk() {
  return { files: [], pending: [], directories: [], skipped: [], seen: new Set(), totalFiles: 0, totalBytes: 0, walked: false, walkMs: 0, complete: false };
}

/**
 * Percorre a árvore inteira sem ler conteúdo: só nomes e informações dos itens.
 * É a etapa que precisa ser rápida — com as consultas em paralelo, dezenas de
 * milhares de arquivos ficam conhecidos em segundos.
 */
async function walkTree(root, walk, report) {
  const list = createLimiter(READDIR_LANES);
  const info = createLimiter(STAT_LANES);
  const visit = async (folder, prefix) => {
    let entries;
    for (let attempt = 0; ; attempt++) {
      try {
        entries = await list(() => withTimeout(
          fs.readdir(nativePath(folder), { withFileTypes: true }),
          prefix ? OP_TIMEOUT_MS : ROOT_TIMEOUT_MS,
          "A pasta demorou demais para responder"
        ));
        break;
      } catch (e) {
        // Uma pasta que não responde é tentada de novo antes de ser dada como
        // ilegível: uma falha passageira não pode excluir o conteúdo dela.
        if (attempt < READDIR_TRIES) { await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1))); continue; }
        // Sem a raiz não existe varredura nenhuma. Antes, o motivo virava um item
        // "fora da sincronização" com caminho vazio — e caminho vazio protege a
        // pasta inteira, então o envio e o download paravam sem dizer por quê.
        if (!prefix) throw new Error("A pasta de sincronização não pôde ser lida: " + e.message);
        walk.skipped.push({ path: prefix.replace(/\/$/, ""), reason: "Pasta não pôde ser lida: " + e.message });
        return;
      }
    }
    const subfolders = [];
    await Promise.all(entries.map(async entry => {
      if (entry.name === ".fortesdrive" || entry.name.startsWith(".fortesdrive-transfer-")) return;
      if (entry.isSymbolicLink()) { walk.skipped.push({ path: prefix + entry.name, reason: "Link simbólico não sincronizado" }); return; }
      // O nome é conferido aqui, sem reabrir pasta por pasta.
      if (!validName(entry.name)) { walk.skipped.push({ path: prefix + entry.name, reason: `Nome incompatível com o computador: ${entry.name}` }); return; }
      const relative = prefix + entry.name;
      const absolute = path.join(folder, entry.name);
      let stat;
      try { stat = await info(() => withTimeout(fs.stat(nativePath(absolute)), OP_TIMEOUT_MS, "O item demorou demais para responder")); }
      catch (e) { walk.skipped.push({ path: relative, reason: e.message }); return; }
      // Pula reparse points do OneDrive (Files On-Demand) e outros não regulares.
      if (!stat.isFile() && !stat.isDirectory()) { walk.skipped.push({ path: relative, reason: "Tipo não suportado" }); return; }
      const identity = `${stat.dev}:${stat.ino}`;
      if (stat.isDirectory()) { walk.directories.push({ path: relative, identity }); subfolders.push(entry.name); return; }
      walk.totalBytes += stat.size; walk.totalFiles++;
      if (stat.size > MAX_SCAN_BYTES) { walk.skipped.push({ path: relative, size: stat.size, reason: "Acima do limite de 10 GiB por arquivo do servidor" }); return; }
      walk.seen.add(relative);
      walk.pending.push({ relative, absolute, stat, identity, tries: 0 });
    }));
    await Promise.all(subfolders.map(name => visit(path.join(folder, name), prefix + name + "/")));
    report();
  };
  await visit(root, "");
}

async function scan(root, baseline = {}, { hashBudget = Infinity, hashBudgetMs = HASH_BUDGET_MS, onProgress, restart = false } = {}) {
  if (cacheRoot !== root) { cacheRoot = root; checksums.clear(); walks.clear(); }
  for (const entry of Object.values(baseline)) {
    if (entry.path && entry.ctimeMs != null && !checksums.has(entry.path)) checksums.set(entry.path, entry);
  }
  let walk = walks.get(root);
  // Uma varredura concluída recomeça na passagem seguinte — é assim que arquivos
  // novos ou alterados aparecem. O resumo já conhecido volta do cache, sem reler.
  if (!walk || walk.complete || restart) { walk = newWalk(); walks.set(root, walk); }
  let lastReport = 0;
  const report = (force = false) => {
    if (!force && Date.now() - lastReport < 150) return;
    lastReport = Date.now();
    try { onProgress?.({ total: walk.totalFiles, hashed: walk.files.length, pending: walk.pending.length, walking: !walk.walked }); } catch (e) {}
  };
  const describe = (relative, stat, identity, digest) => ({ path: relative, name: relative.slice(relative.lastIndexOf("/") + 1), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, checksum: digest, identity });
  report(true);

  // 1) A árvore inteira, de uma vez. Nada do conteúdo é lido nesta etapa: é o
  //    que permite conhecer uma pasta grande em segundos.
  if (!walk.walked) {
    const startedAt = Date.now();
    try {
      await walkTree(root, walk, () => report());
    } catch (error) {
      // Uma árvore percorrida pela metade não serve de base para nada: o estado
      // parcial é descartado e a próxima passagem recomeça do zero.
      walks.delete(root);
      throw error;
    }
    walk.walked = true;
    walk.walkMs = Date.now() - startedAt;
    // Quem já tem resumo válido (mesmo dono, tamanho e datas) volta sem reler o
    // conteúdo; só o que mudou ou nunca foi lido entra na fila do resumo.
    walk.pending = walk.pending.filter(item => {
      const known = checksums.get(item.relative);
      if (!known || known.size !== item.stat.size || known.mtimeMs !== item.stat.mtimeMs || known.ctimeMs !== item.stat.ctimeMs || known.identity !== item.identity) return true;
      walk.files.push(describe(item.relative, item.stat, item.identity, known.checksum));
      return false;
    });
    report(true);
  }

  // 2) Resumo do conteúdo em faixas paralelas, com limite por arquivo e por
  //    passagem. Uma pasta enorme não pode segurar o envio inteiro até o último
  //    byte ser lido: o que já foi resumido sobe nesta passagem e o restante
  //    continua na seguinte, reaproveitando a árvore já percorrida.
  const slice = hashBudget === Infinity ? walk.pending.length : Math.max(0, hashBudget);
  const hashing = walk.pending.splice(0, slice);
  const deadline = hashBudgetMs === Infinity ? Infinity : Date.now() + hashBudgetMs;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(HASH_LANES, hashing.length) }, async () => {
    while (next < hashing.length) {
      if (Date.now() > deadline) break;
      const item = hashing[next++];
      try {
        const digest = await withTimeout(checksum(nativePath(item.absolute), item.stat.size), READ_TIMEOUT_MS, "A leitura do arquivo demorou demais");
        const after = await withTimeout(fs.stat(nativePath(item.absolute)), OP_TIMEOUT_MS, "O arquivo demorou demais para responder");
        if (item.stat.size !== after.size || item.stat.mtimeMs !== after.mtimeMs) { remember(root, item.relative, null); walk.skipped.push({ path: item.relative, reason: "Arquivo em edição ou download" }); continue; }
        const identity = `${after.dev}:${after.ino}`;
        remember(root, item.relative, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, identity, checksum: digest });
        walk.files.push(describe(item.relative, after, identity, digest));
        if (walk.files.length % 25 === 0) report();
      } catch (e) {
        item.tries++;
        if (e.timeout && item.tries < READ_TRIES) walk.pending.push(item);
        else walk.skipped.push({ path: item.relative, reason: "Não foi possível ler: " + e.message });
      }
    }
  }));
  // O que não coube no tempo desta passagem volta para a fila, na frente.
  if (next < hashing.length) walk.pending = [...hashing.slice(next), ...walk.pending];
  report(true);
  walk.complete = walk.walked && !walk.pending.length;
  // Arquivos que sumiram saem do cache: ele não cresce sem limite.
  if (walk.complete) for (const key of [...checksums.keys()]) if (!walk.seen.has(key)) checksums.delete(key);
  return {
    files: walk.files, directories: walk.directories, skipped: walk.skipped,
    totalBytes: walk.totalBytes, totalFiles: walk.totalFiles,
    pendingHash: walk.pending.length, pendingBytes: walk.pending.reduce((sum, item) => sum + item.stat.size, 0),
    // `walked` diz que a árvore inteira já é conhecida (nomes, tamanhos e datas
    // de todos os arquivos). É a partir daí que o plano pode ser montado; o
    // resumo do conteúdo continua em lotes nas passagens seguintes.
    // `unread` são os caminhos que já existem no computador mas ainda não foram
    // resumidos: eles não podem ser tratados como "arquivo ausente".
    walked: walk.walked, complete: walk.complete, walkMs: walk.walkMs,
    unread: walk.pending.length ? walk.pending.map(item => item.relative) : [],
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