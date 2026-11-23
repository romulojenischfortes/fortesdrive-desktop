const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const hashPool = require("./hash-pool");
const MAX_BYTES = 100 * 1024 * 1024; // IPC legado: nunca carrega arquivos grandes na RAM.
const MAX_SCAN_BYTES = 10 * 1024 * 1024 * 1024;

async function checksum(file, size) {
  return hashPool.computeFileHash(file, size);
}
// Resumo (SHA-256) reaproveitado entre varreduras. Sem isso, cada ciclo de
// sincronização relia e resumia a árvore inteira — o maior gasto de tempo do
// envio, porque a árvore é varrida de novo a cada lote. A entrada só vale para
// o mesmo dono do arquivo, tamanho e data de modificação; qualquer mudança
// obriga a resumir outra vez.
let cacheRoot = null;
const checksums = new Map();

/*
  Índice em disco do resumo de cada arquivo: tamanho, data de modificação,
  identidade e SHA-256. Sem ele, cada reinício do cliente relia e resumia a
  pasta inteira — com dezenas de milhares de arquivos isso levava horas e o
  envio não andava. O índice é apenas um acelerador: qualquer divergência de
  tamanho, data ou identidade manda resumir o arquivo de novo, então um arquivo
  alterado nunca é confundido com um arquivo igual.
*/
let indexFile = null;
let indexLoaded = false;
let indexDirty = false;
let indexTimer = null;
const index = new Map();

function configureIndex(file) {
  if (indexFile === file) return;
  indexFile = file || null;
  indexLoaded = false;
  index.clear();
  clearTimeout(indexTimer);
  indexTimer = null;
  indexDirty = false;
}

async function loadIndex() {
  if (indexLoaded) return;
  indexLoaded = true;
  if (!indexFile) return;
  try {
    const data = JSON.parse(await fs.readFile(indexFile, "utf8"));
    for (const [relative, entry] of Object.entries(data || {})) if (entry?.checksum) index.set(relative, entry);
  } catch (e) {
    // Primeira execução ou índice ilegível: a varredura resume os arquivos.
  }
}

const yieldLoop = () => new Promise(resolve => setImmediate(resolve));

function saveIndexSoon(delayMs = 20000) {
  if (!indexFile || indexTimer) return;
  indexTimer = setTimeout(async () => {
    indexTimer = null;
    if (!indexDirty) return;
    indexDirty = false;
    try {
      const snapshot = [...index.entries()];
      const chunks = ["{"];
      for (let i = 0; i < snapshot.length; i++) {
        const [k, v] = snapshot[i];
        chunks.push((i ? "," : "") + JSON.stringify(k) + ":" + JSON.stringify(v));
        if ((i + 1) % 4000 === 0) await yieldLoop();
      }
      chunks.push("}");
      const temp = indexFile + ".tmp";
      await fs.writeFile(temp, chunks.join(""), "utf8");
      await fs.rename(temp, indexFile);
    } catch (e) {
      // O índice é só um acelerador: falhar ao gravá-lo não afeta a sincronização.
    }
  }, delayMs);
  indexTimer.unref?.();
}

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
  if (entry) { checksums.set(relative, entry); index.set(relative, entry); }
  else { checksums.delete(relative); index.delete(relative); }
  indexDirty = true;
  saveIndexSoon();
}

const verifiedDirs = new Map();
const VERIFIED_DIR_TTL_MS = 5000;

async function safePath(root, relative, createParents = false) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes("\0")) throw new Error("Caminho inválido");
  const parts = relative.split("/");
  if (parts.some(p => !validName(p))) throw new Error(`Nome incompatível com o computador: ${relative}`);
  const now = Date.now();
  if (verifiedDirs.size > 20000) verifiedDirs.clear();
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const isParent = i < parts.length - 1;
    if (isParent) {
      const cachedAt = verifiedDirs.get(current);
      if (cachedAt && now - cachedAt < VERIFIED_DIR_TTL_MS) continue;
    }
    let stat;
    try { stat = await fs.lstat(current); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (stat?.isSymbolicLink()) { verifiedDirs.delete(current); throw new Error("Links simbólicos não são sincronizados"); }
    if (isParent && !stat && createParents) { await fs.mkdir(current); verifiedDirs.set(current, now); continue; }
    if (isParent && stat && !stat.isDirectory()) { verifiedDirs.delete(current); throw new Error("Uma pasta foi substituída por um arquivo"); }
    if (isParent && stat?.isDirectory()) verifiedDirs.set(current, now);
  }
  return current;
}
// A varredura precisa terminar depressa mesmo com dezenas de milhares de
// arquivos. Pastas, metadados e resumos SHA-256 saturam SSDs NVMe modernos.
const READDIR_LANES = 160;  // pastas listadas ao mesmo tempo em paralelo
const STAT_LANES = 640;     // informações de itens pedidas ao mesmo tempo
const HASH_LANES = 192;     // arquivos/lotes despachados simultaneamente ao pool multi-thread
const SMALL_HASH_BATCH = 96;
const SMALL_BATCH_ITEM_BYTES = 2 * 1024 * 1024;
const SMALL_BATCH_MAX_BYTES = 16 * 1024 * 1024;
// Uma única pasta ou arquivo que não responde (disco removido, OneDrive que
// nunca baixa) não pode segurar a pasta inteira: cada operação tem o seu limite.
const OP_TIMEOUT_MS = 20 * 1000;
const READ_TIMEOUT_MS = 180 * 1000;
// Um arquivo que não respondeu volta para a fila das próximas passagens; só
// depois de algumas tentativas ele é dado como fora da sincronização.
const READ_TRIES = 3;
// Uma pasta que não responde é tentada de novo antes de ser dada como ilegível.
const READDIR_TRIES = 2;
// A raiz é a única pasta sem a qual nada pode ser concluído: ela tem prazo mais
// longo que as demais.
const ROOT_TIMEOUT_MS = 60 * 1000;
// A primeira passagem percorre toda a árvore e já libera os primeiros milhares de
// arquivos em ~1 segundo para o upload iniciar na hora.
const HASH_BUDGET_MS = 1200;

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
// Árvore completa em memória para reconciliação incremental O(1) via journal de
// eventos do sistema de arquivos (padrão Google Drive / OneDrive).
const completedTrees = new Map();
function newWalk() {
  return { files: [], pending: [], directories: [], skipped: [], seen: new Set(), totalFiles: 0, totalBytes: 0, hashedBytes: 0, startedAt: Date.now(), walked: false, walkMs: 0, complete: false };
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
  if (cacheRoot !== root) { cacheRoot = root; checksums.clear(); walks.clear(); completedTrees.clear(); }
  // O índice gravado na execução anterior volta já carregado: reabrir o cliente
  // não obriga a resumir de novo o que não mudou.
  await loadIndex();
  for (const entry of Object.values(baseline)) {
    if (entry.path && entry.ctimeMs != null && !checksums.has(entry.path)) checksums.set(entry.path, entry);
  }
  for (const [relative, entry] of index) if (!checksums.has(relative)) checksums.set(relative, entry);
  let walk = walks.get(root);
  // Uma varredura concluída recomeça na passagem seguinte — é assim que arquivos
  // novos ou alterados aparecem. O resumo já conhecido volta do cache, sem reler.
  if (!walk || walk.complete || restart) { walk = newWalk(); walks.set(root, walk); }
  let lastReport = 0;
  const report = (force = false) => {
    if (!force && Date.now() - lastReport < 150) return;
    lastReport = Date.now();
    const elapsedSec = Math.max(0.001, (Date.now() - walk.startedAt) / 1000);
    try {
      onProgress?.({
        total: walk.totalFiles,
        hashed: walk.files.length,
        pending: walk.pending.length,
        totalBytes: walk.totalBytes,
        hashedBytes: walk.hashedBytes,
        bytesPerSec: Math.round(walk.hashedBytes / elapsedSec),
        walking: !walk.walked,
      });
    } catch (e) {}
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
    const newPending = [];
    for (let i = 0; i < walk.pending.length; i++) {
      const item = walk.pending[i];
      const known = checksums.get(item.relative);
      const sameIdentity = !known?.identity || !item.identity || known.identity === item.identity;
      if (!known || known.size !== item.stat.size || known.mtimeMs !== item.stat.mtimeMs || !sameIdentity) {
        newPending.push(item);
      } else {
        walk.hashedBytes += item.stat.size;
        walk.files.push(describe(item.relative, item.stat, item.identity, known.checksum));
      }
      if ((i + 1) % 5000 === 0) await yieldLoop();
    }
    
    // Ordena os que precisam de resumo: os pequenos primeiro. Assim a primeira
    // faixa já entrega milhares de arquivos resumidos, que sobem enquanto os 
    // vídeos pesados e imagens ISO, que travam as faixas nas posições de leitura
    // onde calharam de cair, ficam para as faixas finais da verificação.
    walk.pending = newPending.sort((a, b) => a.stat.size - b.stat.size);
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
  const acceptHashed = (item, digest, after) => {
    if (item.stat.size !== after.size || item.stat.mtimeMs !== after.mtimeMs) {
      remember(root, item.relative, null);
      walk.skipped.push({ path: item.relative, reason: "Arquivo em edição ou download" });
      return;
    }
    const identity = `${after.dev}:${after.ino}`;
    remember(root, item.relative, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, identity, checksum: digest });
    walk.hashedBytes += after.size;
    walk.files.push(describe(item.relative, after, identity, digest));
    if (walk.files.length % 50 === 0) report();
  };
  const failHashed = (item, e) => {
    item.tries++;
    if (e.timeout && item.tries < READ_TRIES) walk.pending.push(item);
    else walk.skipped.push({ path: item.relative, reason: "Não foi possível ler: " + e.message });
  };
  await Promise.all(Array.from({ length: Math.min(HASH_LANES, hashing.length) }, async () => {
    while (next < hashing.length) {
      if (Date.now() > deadline) break;
      const first = hashing[next++];
      // Agrupa arquivos pequenos num único despacho para a worker_thread:
      // elimina dezenas de milhares de mensagens IPC individuais.
      if (first.stat.size > 0 && first.stat.size <= SMALL_BATCH_ITEM_BYTES && typeof hashPool.hashBatch === "function") {
        const group = [first];
        let groupBytes = first.stat.size;
        while (group.length < SMALL_HASH_BATCH && next < hashing.length && hashing[next].stat.size > 0 && hashing[next].stat.size <= SMALL_BATCH_ITEM_BYTES && groupBytes + hashing[next].stat.size <= SMALL_BATCH_MAX_BYTES) {
          const candidate = hashing[next++];
          group.push(candidate);
          groupBytes += candidate.stat.size;
        }
        try {
          const results = await hashPool.hashBatch(group.map(it => ({ file: nativePath(it.absolute), size: it.stat.size })), READ_TIMEOUT_MS);
          for (let i = 0; i < group.length; i++) {
            const res = results[i];
            if (res?.ok) acceptHashed(group[i], res.digest, res.after);
            else failHashed(group[i], new Error(res?.error || "Falha ao ler arquivo"));
          }
        } catch (e) {
          for (const it of group) failHashed(it, e);
        }
        continue;
      }
      try {
        let digest, after;
        if (first.stat.size === 0) {
          digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
          after = await withTimeout(fs.stat(nativePath(first.absolute)), OP_TIMEOUT_MS, "O arquivo demorou demais para responder");
        } else {
          const verified = await hashPool.hashAndStat(nativePath(first.absolute), first.stat.size, READ_TIMEOUT_MS);
          digest = verified.digest;
          after = verified.after;
        }
        acceptHashed(first, digest, after);
      } catch (e) {
        failHashed(first, e);
      }
    }
  }));
  // O que não coube no tempo desta passagem volta para a fila, na frente.
  if (next < hashing.length) walk.pending = [...hashing.slice(next), ...walk.pending];
  report(true);
  walk.complete = walk.walked && !walk.pending.length;
  // Arquivos que sumiram saem do cache: ele não cresce sem limite.
  if (walk.complete) {
    for (const key of [...checksums.keys()]) if (!walk.seen.has(key)) checksums.delete(key);
    // O índice acompanha a pasta: o que sumiu do disco sai dele também.
    for (const key of [...index.keys()]) if (!walk.seen.has(key)) { index.delete(key); indexDirty = true; }
    saveIndexSoon();
    completedTrees.set(root, {
      files: new Map(walk.files.map(f => [f.path, f])),
      dirs: new Map(walk.directories.map(d => [d.path, d])),
      skipped: new Map(walk.skipped.map(s => [s.path, s])),
      completedAt: Date.now(),
      walkMs: walk.walkMs,
    });
  }
  const elapsedSec = Math.max(0.001, (Date.now() - walk.startedAt) / 1000);
  return {
    files: walk.files, directories: walk.directories, skipped: walk.skipped,
    totalBytes: walk.totalBytes, totalFiles: walk.totalFiles,
    hashedBytes: walk.hashedBytes,
    bytesPerSec: Math.round(walk.hashedBytes / elapsedSec),
    pendingHash: walk.pending.length, pendingBytes: walk.pending.reduce((sum, item) => sum + item.stat.size, 0),
    // `walked` diz que a árvore inteira já é conhecida (nomes, tamanhos e datas
    // de todos os arquivos). É a partir daí que o plano pode ser montado; o
    // resumo do conteúdo continua em lotes nas passagens seguintes.
    // `unread` são os caminhos que já existem no computador mas ainda não foram
    // resumidos: eles não podem ser tratados como "arquivo ausente".
    walked: walk.walked, complete: walk.complete, walkMs: walk.walkMs,
    // Lista limitada: numa pasta com dezenas de milhares de itens ainda por
    // resumir, devolver todos a cada passagem só atravancava a comunicação com
    // a interface sem acrescentar decisão nenhuma.
    unread: walk.pending.length ? walk.pending.slice(0, 20000).map(item => item.relative) : [],
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
  verifiedDirs.clear();
  const source = await safePath(root, from), destination = await safePath(root, to, true);
  await assertExpected(source, expected);
  await assertExpected(destination, null);
  await fs.rename(source, destination);
  const saved = await fs.stat(destination);
  remember(root, from, null);
  remember(root, to, { size: saved.size, mtimeMs: saved.mtimeMs, identity: `${saved.dev}:${saved.ino}`, checksum: expected });
  return { size: saved.size, mtimeMs: saved.mtimeMs, identity: `${saved.dev}:${saved.ino}` };
}
/**
 * Retorna um retrato instantâneo da varredura em andamento (sem esperar o fim
 * do lote atual de SHA-256), permitindo que a sincronização envie arquivos já
 * verificados enquanto os workers continuam lendo o restante em paralelo.
 */
function peekScan(root) {
  if (cacheRoot !== root) return null;
  const walk = walks.get(root);
  if (!walk || !walk.walked || walk.complete) return null;
  const elapsedSec = Math.max(0.001, (Date.now() - walk.startedAt) / 1000);
  return {
    files: walk.files.slice(),
    directories: walk.directories.slice(),
    skipped: walk.skipped.slice(),
    totalBytes: walk.totalBytes,
    totalFiles: walk.totalFiles,
    hashedBytes: walk.hashedBytes,
    bytesPerSec: Math.round(walk.hashedBytes / elapsedSec),
    pendingHash: walk.pending.length,
    pendingBytes: walk.pending.reduce((sum, item) => sum + item.stat.size, 0),
    walked: true,
    complete: false,
    walkMs: walk.walkMs,
    unread: walk.pending.length ? walk.pending.slice(0, 20000).map(item => item.relative) : [],
  };
}

function hasCompletedTree(root, maxAgeMs = 10 * 60 * 1000) {
  if (cacheRoot !== root) return false;
  const tree = completedTrees.get(root);
  return Boolean(tree && Date.now() - tree.completedAt < maxAgeMs);
}

/**
 * Atualiza em O(k) apenas os caminhos sinalizados pelo monitor de eventos,
 * evitando revarrer dezenas de milhares de arquivos a cada edição ou exclusão.
 */
async function scanIncremental(root, dirtyRelatives = [], baseline = {}) {
  if (!hasCompletedTree(root)) return scan(root, baseline);
  await loadIndex();
  for (const entry of Object.values(baseline)) {
    if (entry.path && entry.ctimeMs != null && !checksums.has(entry.path)) checksums.set(entry.path, entry);
  }
  const tree = completedTrees.get(root);
  const startedAt = Date.now();
  const describe = (relative, stat, identity, digest) => ({
    path: relative, name: relative.slice(relative.lastIndexOf("/") + 1),
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, checksum: digest, identity,
  });

  const targets = [...new Set((dirtyRelatives || []).map(r => String(r || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean))];
  if (!targets.length) {
    const files = [...tree.files.values()];
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    return {
      files, directories: [...tree.dirs.values()], skipped: [...tree.skipped.values()],
      totalBytes, totalFiles: files.length, hashedBytes: totalBytes, bytesPerSec: 0,
      pendingHash: 0, pendingBytes: 0, walked: true, complete: true, walkMs: 0, unread: [],
    };
  }

  const hashFileItem = async (relative, absolute, stat, identity) => {
    if (stat.size > MAX_SCAN_BYTES) {
      tree.skipped.set(relative, { path: relative, size: stat.size, reason: "Acima do limite de 10 GiB por arquivo do servidor" });
      return;
    }
    const known = checksums.get(relative);
    const sameIdentity = !known?.identity || !identity || known.identity === identity;
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && sameIdentity) {
      tree.files.set(relative, describe(relative, stat, identity, known.checksum));
      return;
    }
    try {
      let digest, after;
      if (stat.size === 0) {
        digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        after = await withTimeout(fs.stat(nativePath(absolute)), OP_TIMEOUT_MS, "O arquivo demorou demais para responder");
      } else {
        const verified = await hashPool.hashAndStat(nativePath(absolute), stat.size, READ_TIMEOUT_MS);
        digest = verified.digest;
        after = verified.after;
      }
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
        remember(root, relative, null);
        tree.skipped.set(relative, { path: relative, reason: "Arquivo em edição ou download" });
        return;
      }
      const afterIdentity = `${after.dev}:${after.ino}`;
      remember(root, relative, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, identity: afterIdentity, checksum: digest });
      tree.files.set(relative, describe(relative, after, afterIdentity, digest));
    } catch (e) {
      tree.skipped.set(relative, { path: relative, reason: "Não foi possível ler: " + e.message });
    }
  };

  const visitSubtree = async (folderAbs, prefixRel) => {
    let entries;
    try {
      entries = await withTimeout(fs.readdir(nativePath(folderAbs), { withFileTypes: true }), OP_TIMEOUT_MS, "A pasta demorou demais para responder");
    } catch (e) {
      tree.skipped.set(prefixRel.replace(/\/$/, ""), { path: prefixRel.replace(/\/$/, ""), reason: "Pasta não pôde ser lida: " + e.message });
      return;
    }
    const subdirs = [];
    const fileTasks = [];
    for (const entry of entries) {
      if (entry.name === ".fortesdrive" || entry.name.startsWith(".fortesdrive-transfer-")) continue;
      const rel = prefixRel + entry.name;
      if (entry.isSymbolicLink()) { tree.skipped.set(rel, { path: rel, reason: "Link simbólico não sincronizado" }); continue; }
      if (!validName(entry.name)) { tree.skipped.set(rel, { path: rel, reason: `Nome incompatível com o computador: ${entry.name}` }); continue; }
      const abs = path.join(folderAbs, entry.name);
      let st;
      try { st = await withTimeout(fs.stat(nativePath(abs)), OP_TIMEOUT_MS, "O item demorou demais para responder"); }
      catch (e) { tree.skipped.set(rel, { path: rel, reason: e.message }); continue; }
      if (!st.isFile() && !st.isDirectory()) { tree.skipped.set(rel, { path: rel, reason: "Tipo não suportado" }); continue; }
      const id = `${st.dev}:${st.ino}`;
      if (st.isDirectory()) {
        tree.dirs.set(rel, { path: rel, identity: id });
        subdirs.push({ abs, prefix: rel + "/" });
      } else {
        fileTasks.push(() => hashFileItem(rel, abs, st, id));
      }
    }
    const limiter = createLimiter(64);
    await Promise.all([
      ...fileTasks.map(fn => limiter(fn)),
      ...subdirs.map(d => visitSubtree(d.abs, d.prefix)),
    ]);
  };

  // Remove entradas antigas dos caminhos afetados antes de reinspecionar no disco.
  for (const rel of targets) {
    if (rel === ".fortesdrive" || rel.startsWith(".fortesdrive/") || rel.startsWith(".fortesdrive-transfer-")) continue;
    const prefix = rel + "/";
    if (tree.files.delete(rel)) remember(root, rel, null);
    tree.dirs.delete(rel);
    tree.skipped.delete(rel);
    for (const k of [...tree.files.keys()]) if (k.startsWith(prefix)) { tree.files.delete(k); remember(root, k, null); }
    for (const k of [...tree.dirs.keys()]) if (k.startsWith(prefix)) tree.dirs.delete(k);
    for (const k of [...tree.skipped.keys()]) if (k.startsWith(prefix)) tree.skipped.delete(k);
  }

  const targetLimiter = createLimiter(64);
  await Promise.all(targets.map(rel => targetLimiter(async () => {
    const parts = rel.split("/");
    if (parts.some(p => p === ".fortesdrive" || p.startsWith(".fortesdrive-transfer-"))) return;
    if (parts.some(p => !validName(p))) {
      const absCheck = path.join(root, ...parts);
      const exists = await fs.lstat(nativePath(absCheck)).then(() => true, () => false);
      if (exists) tree.skipped.set(rel, { path: rel, reason: `Nome incompatível com o computador: ${parts.find(p => !validName(p))}` });
      return;
    }
    // Garante ancestrais registrados em tree.dirs quando arquivo nasce em pasta nova.
    let parentAcc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      parentAcc = parentAcc ? parentAcc + "/" + parts[i] : parts[i];
      if (!tree.dirs.has(parentAcc)) {
        const parentAbs = path.join(root, ...parentAcc.split("/"));
        const pStat = await fs.lstat(nativePath(parentAbs)).catch(() => null);
        if (pStat?.isDirectory() && !pStat.isSymbolicLink()) {
          tree.dirs.set(parentAcc, { path: parentAcc, identity: `${pStat.dev}:${pStat.ino}` });
        }
      }
    }
    const absolute = path.join(root, ...parts);
    let lstat;
    try { lstat = await withTimeout(fs.lstat(nativePath(absolute)), OP_TIMEOUT_MS, "O item demorou demais para responder"); }
    catch (e) {
      if (e.code === "ENOENT") return;
      tree.skipped.set(rel, { path: rel, reason: e.message });
      return;
    }
    if (lstat.isSymbolicLink()) {
      tree.skipped.set(rel, { path: rel, reason: "Link simbólico não sincronizado" });
      return;
    }
    let stat = lstat;
    try { stat = await withTimeout(fs.stat(nativePath(absolute)), OP_TIMEOUT_MS, "O item demorou demais para responder"); }
    catch (e) {
      if (e.code === "ENOENT") return;
      tree.skipped.set(rel, { path: rel, reason: e.message });
      return;
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      tree.skipped.set(rel, { path: rel, reason: "Tipo não suportado" });
      return;
    }
    const identity = `${stat.dev}:${stat.ino}`;
    if (stat.isDirectory()) {
      tree.dirs.set(rel, { path: rel, identity });
      await visitSubtree(absolute, rel + "/");
    } else {
      await hashFileItem(rel, absolute, stat, identity);
    }
  })));

  const files = [...tree.files.values()];
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const walkMs = Date.now() - startedAt;
  return {
    files,
    directories: [...tree.dirs.values()],
    skipped: [...tree.skipped.values()],
    totalBytes,
    totalFiles: files.length,
    hashedBytes: totalBytes,
    bytesPerSec: walkMs > 0 ? Math.round(totalBytes / (walkMs / 1000)) : 0,
    pendingHash: 0,
    pendingBytes: 0,
    walked: true,
    complete: true,
    walkMs,
    unread: [],
  };
}

module.exports = { safePath, scan, scanIncremental, hasCompletedTree, remember, peekScan, read, write, move, checksum, assertExpected, configureIndex, shutdownPool: hashPool.shutdownPool, MAX_BYTES, MAX_SCAN_BYTES };