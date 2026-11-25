'use strict';

/**
 * FortesDrive — gateway do servidor de armazenamento próprio.
 *
 * Guarda os arquivos direto na pasta de dados deste computador, sem nenhum
 * serviço intermediário para cair: recebe o envio em fluxo contínuo, confere o
 * SHA-256 e o tamanho e só então publica o arquivo (se o conteúdo não confere,
 * nada é gravado — não sobra arquivo pela metade). Também entrega o arquivo de
 * volta (com suporte a Range), apaga e informa capacidade e disponibilidade da
 * pasta de dados.
 *
 * Só aceita requisições assinadas com o segredo compartilhado (HMAC-SHA256 com
 * validade curta). O FortesDrive assina no servidor dele e entrega ao navegador
 * apenas um endereço já assinado e temporário.
 *
 * Com NEXTCLOUD_URL/NEXTCLOUD_USER/NEXTCLOUD_APP_PASSWORD definidos, os bytes
 * são gravados e lidos no Nextcloud por WebDAV, com o próprio Nextcloud
 * conferindo o checksum. Sem essas variáveis, tudo continua na pasta local.
 *
 * Rotas:
 *   GET    /health                                    → vivo? (sem assinatura)
 *   GET    /v1/status?expires=&sig=                   → disco, versão, gravação
 *   GET    /v1/migrate?expires=&sig=                  → estado da migração
 *   POST   /v1/migrate?expires=&sig=                  → inicia/retoma a migração
 *   PUT    /v1/objects/<chave>?op=put&expires=&sig=   → envia conteúdo (header x-fd-sha256)
 *   GET    /v1/objects/<chave>?op=get&expires=&sig=   → baixa (aceita Range)
 *   DELETE /v1/objects/<chave>?op=delete&expires=&sig= → apaga
 *
 * A assinatura cobre exatamente "op\nchave\nexpires" (mesmo cálculo usado no
 * FortesDrive, em base44/shared/storageSigning.ts).
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Armazenamento no Nextcloud (WebDAV). Ausente, o gateway segue gravando na
// pasta local — nenhuma instalação antiga deixa de funcionar por causa disso.
let nextcloud = null;
try {
  nextcloud = require('./nextcloud.js');
} catch (error) {
  console.error('[gateway] Nextcloud indisponivel: ' + error.message);
}
const useNextcloud = Boolean(nextcloud && nextcloud.isConfigured());

const PORT = Number(process.env.PORT || 8790);
// Pasta onde os arquivos moram (o volume do Docker aponta para a pasta de dados
// escolhida no assistente — pode ser outro disco).
const DATA_DIR = process.env.DATA_DIR || '/data';
const SECRET = process.env.STORAGE_SIGNING_SECRET || '';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 10737418240);
// Envio em lote: o cliente manda até 30 arquivos ao mesmo tempo. O gateway
// aceita esses 30 e, se chegar mais, o arquivo espera a vez (acquireUploadSlot)
// em vez de ser recusado — a fila nunca para no meio.
const MAX_CONCURRENT_UPLOADS = Number(process.env.MAX_CONCURRENT_UPLOADS || 96);
// Sincronização em lote faz dezenas de milhares de chamadas por minuto através do
// mesmo túnel Cloudflare: o limite barra abuso sem frear transferências assinadas.
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 120000);
// Tempo máximo que um arquivo espera por uma vaga antes de o cliente tentar de novo.
const UPLOAD_SLOT_WAIT_MS = Number(process.env.UPLOAD_SLOT_WAIT_MS || 120000);
const VERSION = '2.4.0';
const STARTED_AT = Date.now();
const MAX_SIGNATURE_LIFETIME_MS = 25 * 3600 * 1000;
// Pasta onde estão os arquivos gravados antes da migração (o volume da pasta
// de dados do computador). É só a origem: nada é alterado nem apagado aqui.
const LEGACY_DIR = process.env.LEGACY_DIR || DATA_DIR;

// Área de preparo dentro da própria pasta de dados: o arquivo só é publicado
// quando o checksum confere, e o rename fica no mesmo disco (nunca falha).
const TMP_DIR = path.join(DATA_DIR, '.tmp');

// Chaves aceitas: u/<dono>/<arquivo>[.ext] — sem barras extras, sem ".."
const KEY_PATTERN = /^u\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(\.[A-Za-z0-9]{1,8})?$/;

const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/x-rar-compressed',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

if (!SECRET) {
  console.error('[gateway] STORAGE_SIGNING_SECRET não definido — encerrando.');
  process.exit(1);
}

fs.mkdirSync(TMP_DIR, { recursive: true });

let activeUploads = 0;
const rateBuckets = new Map();

// O app publicado e o cliente desktop falam com este servidor de outro domínio,
// então o navegador exige CORS. A segurança não vem daqui e sim da assinatura
// de cada pedido — por isso, sem cookies, qualquer origem é aceita por padrão
// (restrinja em CORS_ALLOWED_ORIGINS se quiser).
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const allow = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : (origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] || '*');
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-fd-sha256, x-fd-size, ngrok-skip-browser-warning');
  res.setHeader('Access-Control-Expose-Headers', 'content-length, content-range, accept-ranges');
  res.setHeader('Vary', 'Origin');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function canonical(op, key, expires) {
  return op + '\n' + key + '\n' + expires;
}

function sign(op, key, expires) {
  return crypto.createHmac('sha256', SECRET).update(canonical(op, key, expires)).digest('hex');
}

function sameSignature(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Devolve a chave do objeto a partir do caminho, já decodificada. */
function keyFromPath(pathname) {
  const prefix = '/v1/objects/';
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split('/');
  if (segments.length !== 3 || segments.some((segment) => !segment)) return null;
  let decoded;
  try {
    decoded = segments.map((segment) => decodeURIComponent(segment)).join('/');
  } catch {
    return null;
  }
  return decoded;
}

/** Onde o objeto mora no disco. A chave já foi validada contra KEY_PATTERN. */
function objectPath(key) {
  return path.join(DATA_DIR, ...key.split('/'));
}

function contentTypeFor(key) {
  const extension = String(key.split('.').pop() || '').toLowerCase();
  return CONTENT_TYPES[extension] || 'application/octet-stream';
}

/**
 * A pasta de dados aceita gravação agora? (teste real, arquivo minúsculo)
 * Devolve o motivo junto: "não gravou" sem causa não diz o que corrigir.
 */
async function diskStorageProbe() {
  const probe = path.join(TMP_DIR, 'probe-' + crypto.randomUUID());
  try {
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
    return { writable: true, reason: 'ok', detail: null };
  } catch (error) {
    console.error('[gateway] pasta de dados não aceita gravação: ' + error.message);
    const permissao = ['EACCES', 'EPERM', 'EROFS', 'ENOTDIR'].includes(error.code);
    return {
      writable: false,
      reason: error.code === 'ENOSPC' ? 'disk-full' : permissao ? 'disk-permission' : 'disk-error',
      detail: DATA_DIR + ': ' + error.message,
    };
  }
}

// Último resultado conhecido do armazenamento. O /health responde na hora com
// ele (atualizado no máximo a cada minuto); o /v1/status faz o teste real, que
// é o que confirma a gravação para o app e para o instalador.
let storageCache = {
  checkedAt: 0,
  backend: useNextcloud ? 'nextcloud' : 'disk',
  writable: null,
  reason: 'unknown',
  code: null,
  detail: null,
};
let storageCheck = null;

function storageSnapshotNow() {
  if (storageCheck) return storageCheck;
  storageCheck = (async () => {
    try {
      const result = useNextcloud ? await nextcloud.probe() : await diskStorageProbe();
      storageCache = {
        checkedAt: Date.now(),
        backend: useNextcloud ? 'nextcloud' : 'disk',
        writable: result.writable,
        reason: result.reason,
        // Código HTTP do armazenamento: distingue "Nextcloud ainda instalando"
        // de conta recusada sem precisar abrir o log do servidor.
        code: result.code ?? null,
        detail: result.detail ?? null,
      };
    } catch (error) {
      storageCache = {
        checkedAt: Date.now(),
        backend: useNextcloud ? 'nextcloud' : 'disk',
        writable: false,
        reason: 'disk-error',
        code: null,
        detail: error.message,
      };
    } finally {
      storageCheck = null;
    }
    return storageCache;
  })();
  return storageCheck;
}

function cachedStorage(maxAgeMs) {
  if (Date.now() - storageCache.checkedAt < maxAgeMs) return Promise.resolve(storageCache);
  return storageSnapshotNow();
}

// O /v1/status é o que libera a sincronização do app: ele precisa responder
// rápido e sempre. O teste de gravação no Nextcloud (MKCOL, PUT, GET e DELETE)
// levava de 1 a 9 segundos aqui; quando passava do prazo do app, o app concluía
// "armazenamento offline" e recusava todos os arquivos da pasta. Agora o
// resultado recente é reaproveitado e a resposta nunca espera mais que alguns
// segundos pelo teste.
const STATUS_CACHE_MS = 45000;
const STATUS_PROBE_MAX_MS = 4000;

async function statusProbe() {
  if (storageCache.checkedAt && Date.now() - storageCache.checkedAt < STATUS_CACHE_MS) return storageCache;
  const running = storageSnapshotNow();
  const deadline = new Promise((resolve) => setTimeout(() => resolve(null), STATUS_PROBE_MAX_MS));
  const fresh = await Promise.race([running, deadline]);
  if (fresh) return fresh;
  // O teste segue em segundo plano para valer na próxima consulta. Até ele
  // terminar, vale o último resultado conhecido — nunca um sucesso inventado.
  running.catch(() => {});
  if (storageCache.checkedAt) return storageCache;
  return {
    backend: useNextcloud ? 'nextcloud' : 'disk',
    writable: false,
    reason: 'storage-probe-timeout',
    code: null,
    detail: 'O teste de gravação não terminou em ' + STATUS_PROBE_MAX_MS + ' ms.',
  };
}

/** Confere a assinatura da requisição. Devolve a mensagem de erro ou null. */
function signatureError(url, op, key) {
  const expires = Number(url.searchParams.get('expires'));
  const signature = url.searchParams.get('sig') || '';
  if (!Number.isFinite(expires)) return 'Assinatura ausente.';
  if (expires * 1000 < Date.now()) return 'Assinatura expirada.';
  if (expires * 1000 > Date.now() + MAX_SIGNATURE_LIFETIME_MS) return 'Validade da assinatura acima do permitido.';
  if (!sameSignature(signature, sign(op, key, expires))) return 'Assinatura inválida.';
  return null;
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'desconhecido';
}

function rateLimited(ip) {
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) || []).filter((stamp) => stamp > now - 60000);
  if (bucket.length >= RATE_LIMIT_PER_MINUTE) {
    rateBuckets.set(ip, bucket);
    return true;
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 2000) rateBuckets.clear();
  return false;
}

// Vaga para gravar: quem chega depois do limite espera na fila em vez de
// receber erro. Só os bytes que estão sendo gravados de fato ocupam memória,
// então o servidor não engasga com muitos arquivos ao mesmo tempo.
const slotQueue = [];

function acquireUploadSlot() {
  if (activeUploads < MAX_CONCURRENT_UPLOADS) {
    activeUploads += 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const waiting = { resolve: null, timer: null };
    waiting.resolve = (granted) => {
      clearTimeout(waiting.timer);
      resolve(granted);
    };
    waiting.timer = setTimeout(() => {
      const index = slotQueue.indexOf(waiting);
      if (index >= 0) slotQueue.splice(index, 1);
      resolve(false);
    }, UPLOAD_SLOT_WAIT_MS);
    slotQueue.push(waiting);
  });
}

function releaseUploadSlot() {
  activeUploads = Math.max(0, activeUploads - 1);
  const next = slotQueue.shift();
  if (!next) return;
  activeUploads += 1;
  next.resolve(true);
}

/** Blocos de envios abandonados não ficam ocupando a pasta de dados. */
async function cleanupChunkSessions() {
  const dir = path.join(TMP_DIR, '.chunks');
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const stats = await fsp.stat(full).catch(() => null);
      if (stats && now - stats.mtimeMs > 6 * 60 * 60 * 1000) await fsp.rm(full, { recursive: true, force: true });
    }
  } catch {
    /* área de preparo ainda vazia */
  }
}

// ── Envio em blocos (mesma técnica do Google Drive) ────────────────────
// O túnel que expõe este servidor corta qualquer corpo acima de 100 MB: um
// arquivo grande numa única requisição derrubava a conexão no meio e o app
// repetia o erro sem parar. O cliente manda blocos pequenos e pede a montagem
// no fim — cada requisição fica muito abaixo do corte, uma queda de rede custa
// só um bloco e o arquivo nunca é publicado pela metade.
async function handleUpload(req, res, key, url) {
  const declared = String(req.headers['x-fd-sha256'] || '').toLowerCase();
  const lengthHeader = req.headers['content-length'];
  const contentLength = lengthHeader == null ? null : Number(lengthHeader);
  const sizeHeader = req.headers['x-fd-size'];
  const declaredSize = sizeHeader == null ? null : Number(sizeHeader);
  const parts = Number(url?.searchParams.get('parts') || 0);
  const partIndex = Number(url?.searchParams.get('part') ?? -1);
  const finalize = url?.searchParams.get('finalize') === '1';
  const chunked = Number.isInteger(parts) && parts > 1;
  // Em um gateway antigo (sem o módulo do Nextcloud) `nextcloud` não existe: o
  // teste abaixo é seguro ali também — é esta a rotina que o reparo distribui.
  const backend = typeof nextcloud !== 'undefined' && nextcloud ? nextcloud : null;

  const chunkDir = path.join(TMP_DIR, '.chunks');
  const chunkPathFor = (session, index) => path.join(session, String(index).padStart(5, '0') + '.part');

  async function storeChunk(session, index) {
    await fsp.mkdir(session, { recursive: true });
    const { pipeline } = require('node:stream/promises');
    const output = fs.createWriteStream(chunkPathFor(session, index), { flags: 'w', highWaterMark: 1024 * 1024 });
    await pipeline(req, output);
  }

  async function assembleChunks(session, count, target) {
    const { pipeline } = require('node:stream/promises');
    const hash = crypto.createHash('sha256');
    let total = 0;
    const source = (async function* () {
      for (let index = 0; index < count; index += 1) {
        const chunkFile = chunkPathFor(session, index);
        const exists = await fsp.stat(chunkFile).catch(() => null);
        if (!exists) {
          throw Object.assign(new Error('Faltou o bloco ' + (index + 1) + ' de ' + count + '; envie novamente.'), { status: 409 });
        }
        const stream = fs.createReadStream(chunkFile, { highWaterMark: 4 * 1024 * 1024 });
        for await (const chunk of stream) {
          hash.update(chunk);
          total += chunk.length;
          yield chunk;
        }
      }
    })();
    await pipeline(source, fs.createWriteStream(target, { flags: 'wx', highWaterMark: 4 * 1024 * 1024 }));
    return { digest: hash.digest('hex'), written: total };
  }

  async function publishObject(target, digest) {
    if (!backend) {
      const finalPath = objectPath(key);
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      await fsp.rename(target, finalPath);
      return 'disk';
    }
    await backend.putFile(key, target, digest);
    return 'nextcloud';
  }

  if (!/^[a-f0-9]{64}$/.test(declared)) {
    req.resume();
    return sendJson(res, 422, { error: 'Informe o checksum SHA-256 em x-fd-sha256.' });
  }
  if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
    req.resume();
    return sendJson(res, 400, { error: 'Tamanho informado inválido.' });
  }
  if (declaredSize !== null && declaredSize > MAX_UPLOAD_BYTES) {
    req.resume();
    return sendJson(res, 413, { error: 'Arquivo acima do limite configurado no servidor.' });
  }
  if (!chunked && contentLength !== null && (!/^\d+$/.test(String(lengthHeader)) || !Number.isSafeInteger(contentLength))) {
    return sendJson(res, 400, { error: 'Tamanho informado inválido.' });
  }
  if (!chunked && contentLength !== null && contentLength > MAX_UPLOAD_BYTES) {
    return sendJson(res, 413, { error: 'Arquivo acima do limite configurado no servidor.' });
  }
  req.socket?.setNoDelay?.(true);

  // ── Um bloco do arquivo: guarda e responde rápido. ──
  if (chunked && !finalize) {
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= parts) {
      req.resume();
      return sendJson(res, 400, { error: 'Bloco inválido.' });
    }
    if (!(await acquireUploadSlot())) {
      req.resume();
      return sendJson(res, 429, { error: 'O servidor está ocupado com outros envios. Tente novamente em instantes.' });
    }
    const session = path.join(chunkDir, crypto.createHash('sha256').update(key).digest('hex').slice(0, 32));
    try {
      await storeChunk(session, partIndex);
      return sendJson(res, 200, { ok: true, key, partial: true, part: partIndex, parts });
    } catch (error) {
      console.error('[gateway] falha no bloco ' + partIndex + ' de ' + key + ': ' + error.message);
      if (!res.destroyed) sendJson(res, 500, { error: 'Não foi possível guardar este bloco: ' + error.message });
      return;
    } finally {
      releaseUploadSlot();
    }
  }

  if (!(await acquireUploadSlot())) {
    req.resume();
    return sendJson(res, 429, { error: 'O servidor está ocupado com outros envios. Tente novamente em instantes.' });
  }

  const tempPath = path.join(TMP_DIR, crypto.randomUUID() + '.part');
  const sessionDir = chunked ? path.join(chunkDir, crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)) : null;
  try {
    // ── Montagem: junta os blocos, confere o conteúdo e publica. ──
    if (chunked) {
      req.resume();
      const { digest, written } = await assembleChunks(sessionDir, parts, tempPath);
      if (declaredSize !== null && written !== declaredSize) {
        throw Object.assign(new Error('O conteúdo recebido não corresponde ao tamanho informado.'), { status: 422 });
      }
      if (digest !== declared) {
        throw Object.assign(new Error('Checksum divergente: o arquivo chegou corrompido e não foi gravado.'), { status: 422 });
      }
      const published = await publishObject(tempPath, digest);
      await fsp.rm(sessionDir, { recursive: true, force: true });
      return sendJson(res, 200, { ok: true, key, size: written, checksum: digest, backend: published, chunks: parts });
    }

    const finalPath = backend ? null : objectPath(key);
    if (finalPath) await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    const hash = crypto.createHash('sha256');
    let written = 0;
    const output = fs.createWriteStream(tempPath, { flags: 'wx', highWaterMark: 1024 * 1024 });
    const { pipeline } = require('node:stream/promises');
    // Túneis podem entregar o corpo em chunks, sem Content-Length. Contamos
    // os bytes em fluxo e mantemos o limite e o SHA-256, inclusive para vazios.
    const input = (async function* () {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        written += chunk.length;
        if (written > MAX_UPLOAD_BYTES) {
          throw Object.assign(new Error('Arquivo acima do limite configurado no servidor.'), { status: 413 });
        }
        if (contentLength !== null && written > contentLength) {
          throw Object.assign(new Error('O conteúdo recebido não corresponde ao tamanho informado.'), { status: 422 });
        }
        hash.update(chunk);
        yield chunk;
      }
    })();
    await pipeline(input, output);
    const digest = hash.digest('hex');
    if (contentLength !== null && written !== contentLength) {
      throw Object.assign(new Error('O conteúdo recebido não corresponde ao tamanho informado.'), { status: 422 });
    }
    if (digest !== declared) {
      throw Object.assign(new Error('Checksum divergente: o arquivo chegou corrompido e não foi gravado.'), { status: 422 });
    }
    if (finalPath) await fsp.rename(tempPath, finalPath);
    else await backend.putFile(key, tempPath, digest);
    sendJson(res, 200, { ok: true, key, size: written, checksum: digest, backend: backend ? 'nextcloud' : 'disk' });
  } catch (error) {
    if (!req.destroyed) req.resume();
    if (sessionDir) await fsp.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    console.error('[gateway] falha no envio de ' + key + ': ' + error.message);
    if (!res.destroyed) sendJson(res, error.status || (backend ? 502 : 500), { error: error.message });
  } finally {
    releaseUploadSlot();
    await fsp.rm(tempPath, { force: true });
  }
}

function streamFile(filePath, res, options) {
  return new Promise((resolve) => {
    // Blocos maiores por leitura: menos idas ao disco e mais dados em voo por
    // conexão, o que faz diferença em links rápidos e túneis com latência.
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024, ...options });
    stream.on('error', () => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Falha ao ler o arquivo no disco.' });
      else res.destroy();
      resolve();
    });
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

async function handleDownload(req, res, key) {
  // No Nextcloud o próprio servidor entrega o fluxo (com Range).
  if (useNextcloud) return nextcloud.streamToClient(key, req, res);

  const finalPath = objectPath(key);
  // Cada byte sai assim que chega: sem esperar juntar pacotes, o download mantém
  // o ritmo do link em vez de andar em degraus.
  req.socket?.setNoDelay?.(true);

  let stats;
  try {
    stats = await fsp.stat(finalPath);
  } catch {
    return sendJson(res, 404, { error: 'Objeto não encontrado.' });
  }
  if (!stats.isFile()) return sendJson(res, 404, { error: 'Objeto não encontrado.' });

  const total = stats.size;
  const type = contentTypeFor(key);
  const header = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  };

  const range = req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim()) : null;
  if (range) {
    const startText = range[1];
    const endText = range[2];
    let start = startText === '' ? total - Number(endText) : Number(startText);
    let end = startText === '' || endText === '' ? total - 1 : Number(endText);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      return res.end();
    }
    end = Math.min(end, total - 1);
    res.writeHead(206, {
      ...header,
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
    });
    if (req.method === 'HEAD') return res.end();
    return streamFile(finalPath, res, { start, end });
  }

  res.writeHead(200, { ...header, 'Content-Length': total });
  if (req.method === 'HEAD') return res.end();
  return streamFile(finalPath, res, {});
}

async function handleDelete(res, key) {
  if (useNextcloud) {
    try {
      const result = await nextcloud.deleteFile(key);
      return sendJson(res, 200, { ok: true, key, existed: result.existed, backend: 'nextcloud' });
    } catch (error) {
      console.error('[gateway] falha ao apagar ' + key + ': ' + error.message);
      return sendJson(res, 500, { error: error.message });
    }
  }

  const finalPath = objectPath(key);
  let existed = true;
  try {
    await fsp.unlink(finalPath);
  } catch (error) {
    if (error.code === 'ENOENT') existed = false;
    else {
      console.error('[gateway] falha ao apagar ' + key + ': ' + error.message);
      return sendJson(res, 500, { error: 'Não foi possível apagar o arquivo: ' + error.message });
    }
  }
  sendJson(res, 200, { ok: true, key, existed });
}

async function handleStatus(res) {
  let disk = { freeBytes: null, totalBytes: null, usedBytes: null };

  if (useNextcloud) {
    // Quem manda no espaço agora é o Nextcloud: a cota informada é a dele.
    // A leitura da cota é só informativa e não pode atrasar a resposta que
    // libera os envios do app.
    const quota = await Promise.race([
      nextcloud.quota(),
      new Promise((resolve) => setTimeout(() => resolve({ freeBytes: null, totalBytes: null, usedBytes: null }), 3000)),
    ]);
    const probe = await statusProbe();
    disk = { freeBytes: quota.freeBytes, totalBytes: quota.totalBytes, usedBytes: quota.usedBytes };
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      // reachable=false com o motivo ao lado: cota, credencial, Nextcloud ainda
      // iniciando ou fora do ar. É isto que o app mostra em vez de "falhou".
      filer: { reachable: probe.writable, backend: 'nextcloud', reason: probe.reason },
      storage: {
        writable: probe.writable,
        reason: probe.reason,
        code: probe.code ?? null,
        detail: probe.detail,
        backend: 'nextcloud',
        root: process.env.NEXTCLOUD_ROOT || 'FortesDrive',
        url: process.env.NEXTCLOUD_URL || null,
      },
      migration: migrationView(),
      disk,
      limits: {
        maxUploadBytes: MAX_UPLOAD_BYTES,
        maxConcurrentUploads: MAX_CONCURRENT_UPLOADS,
        rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
      },
    });
  }

  try {
    const stats = await fsp.statfs(DATA_DIR);
    disk = { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize, usedBytes: null };
  } catch (error) {
    console.error('[gateway] não foi possível ler o disco: ' + error.message);
  }

  const probe = await storageSnapshotNow();

  sendJson(res, 200, {
    ok: true,
    version: VERSION,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    // O app consulta "filer.reachable" para saber se há onde gravar. Aqui a
    // gravação acontece na própria pasta de dados: é ela que responde.
    filer: { reachable: probe.writable, backend: 'disk', reason: probe.reason },
    storage: { writable: probe.writable, reason: probe.reason, detail: probe.detail, backend: 'disk', dataDir: DATA_DIR },
    disk,
    limits: {
      maxUploadBytes: MAX_UPLOAD_BYTES,
      maxConcurrentUploads: MAX_CONCURRENT_UPLOADS,
      rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
    },
  });
}

// ── Migração dos arquivos antigos para o Nextcloud ─────────────────────
// Roda no próprio servidor: lê cada arquivo da pasta antiga, confere o
// SHA-256 e envia ao Nextcloud. Arquivo que já está lá com o mesmo tamanho é
// contado como ignorado, então repetir a operação nunca duplica nada e uma
// interrupção pode ser retomada de onde parou. Nada é apagado da origem.
const MIGRATION_FILE = path.join(DATA_DIR, '.migration.json');
const MAX_MIGRATION_ERRORS = 40;
let migration = {
  running: false,
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  current: null,
  startedAt: null,
  finishedAt: null,
  errors: [],
};

async function loadMigration() {
  try {
    const saved = JSON.parse(await fsp.readFile(MIGRATION_FILE, 'utf8'));
    migration = { ...migration, ...saved, running: false, current: null };
  } catch { /* primeira execução */ }
}

function saveMigration() {
  return fsp.writeFile(MIGRATION_FILE, JSON.stringify(migration)).catch(() => {});
}

function migrationView() {
  return {
    ...migration,
    pending: Math.max(0, migration.total - migration.done - migration.skipped - migration.failed),
  };
}

async function sha256Of(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function runMigration() {
  if (!useNextcloud || migration.running) return;
  Object.assign(migration, {
    running: true,
    total: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    current: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errors: [],
  });
  try {
    const files = await nextcloud.legacyFiles(LEGACY_DIR);
    migration.total = files.length;
    await saveMigration();
    console.log('[gateway] migração iniciada: ' + files.length + ' arquivo(s) em ' + LEGACY_DIR);
    for (const key of files) {
      migration.current = key;
      try {
        const sourcePath = path.join(LEGACY_DIR, ...key.split('/'));
        const stats = await fsp.stat(sourcePath);
        const remoteSize = await nextcloud.objectSize(key);
        if (remoteSize === stats.size) {
          migration.skipped += 1;
        } else {
          await nextcloud.putFile(key, sourcePath, await sha256Of(sourcePath));
          migration.done += 1;
        }
      } catch (error) {
        migration.failed += 1;
        if (migration.errors.length < MAX_MIGRATION_ERRORS) {
          migration.errors.push({ key, error: error.message });
        }
      }
      if ((migration.done + migration.skipped + migration.failed) % 10 === 0) await saveMigration();
    }
  } catch (error) {
    migration.errors.push({ key: '', error: error.message });
    console.error('[gateway] migração interrompida: ' + error.message);
  } finally {
    migration.running = false;
    migration.current = null;
    migration.finishedAt = new Date().toISOString();
    await saveMigration();
    console.log('[gateway] migração encerrada: ' + migration.done + ' enviados, ' +
      migration.skipped + ' já estavam, ' + migration.failed + ' falharam.');
  }
}

/** Estado (GET) e início (POST) da migração. Só aceita pedido assinado. */
async function handleMigration(req, res, url) {
  const failure = signatureError(url, 'migrate', '');
  if (failure) return sendJson(res, 401, { error: failure });

  if (!useNextcloud) {
    return sendJson(res, 200, {
      ok: true,
      backend: 'disk',
      available: false,
      state: migrationView(),
    });
  }

  if (req.method === 'POST') {
    if (!migration.running) runMigration();
    return sendJson(res, 200, { ok: true, backend: 'nextcloud', available: true, state: migrationView() });
  }

  return sendJson(res, 200, { ok: true, backend: 'nextcloud', available: true, state: migrationView() });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  try {
    setCorsHeaders(req, res);

    // O navegador pergunta antes de enviar (preflight): responde sem exigir
    // assinatura, porque essa requisição não carrega conteúdo nenhum.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Max-Age': '600' });
      return res.end();
    }

    if (url.pathname === '/health') {
      // O gateway está de pé (ok) e, junto, como está o armazenamento: o app e
      // o instalador precisam das duas respostas sem esperar a assinatura.
      const storage = await cachedStorage(60000);
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        storage: { backend: storage.backend, writable: storage.writable, reason: storage.reason, code: storage.code ?? null },
      });
    }

    // Transferências com assinatura HMAC válida não sofrem bloqueio por IP do túnel;
    // apenas requisições inválidas ou fora de /v1/objects passam pelo freio de taxa.
    if (!url.pathname.startsWith('/v1/objects/') && rateLimited(clientIp(req))) {
      return sendJson(res, 429, { error: 'Muitas requisições. Aguarde um instante.' });
    }

    if (url.pathname === '/v1/status') {
      const failure = signatureError(url, 'status', '');
      if (failure) return sendJson(res, 401, { error: failure });
      return await handleStatus(res);
    }

    if (url.pathname === '/v1/migrate') {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return sendJson(res, 405, { error: 'Use GET para consultar ou POST para migrar.' });
      }
      return await handleMigration(req, res, url);
    }

    if (url.pathname.startsWith('/v1/objects/')) {
      const key = keyFromPath(url.pathname);
      if (!key || !KEY_PATTERN.test(key)) {
        return sendJson(res, 400, { error: 'Chave de objeto inválida.' });
      }

      const op = url.searchParams.get('op');
      if (!['put', 'get', 'delete'].includes(op)) {
        return sendJson(res, 400, { error: 'Operação inválida.' });
      }

      const failure = signatureError(url, op, key);
      if (failure) {
        if (rateLimited(clientIp(req))) return sendJson(res, 429, { error: 'Muitas requisições. Aguarde um instante.' });
        return sendJson(res, 401, { error: failure });
      }

      if (op === 'put') {
        if (req.method !== 'PUT') return sendJson(res, 405, { error: 'Use PUT para enviar conteúdo.' });
        return await handleUpload(req, res, key, url);
      }
      if (op === 'get') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Use GET para baixar.' });
        return await handleDownload(req, res, key);
      }
      if (req.method !== 'DELETE') return sendJson(res, 405, { error: 'Use DELETE para apagar.' });
      return await handleDelete(res, key);
    }

    sendJson(res, 404, { error: 'Rota não encontrada.' });
  } catch (error) {
    console.error('[gateway] erro inesperado: ' + error.message);
    if (!res.headersSent) sendJson(res, 500, { error: error.message });
    else res.end();
  }
});

// Envios grandes podem levar horas: só o handshake tem prazo.
server.requestTimeout = 12 * 60 * 60 * 1000;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

// Estado da migração anterior (se houve) fica disponível já na primeira consulta.
loadMigration().catch(() => {});
// Blocos de envios interrompidos no passado não ficam ocupando a pasta de dados.
cleanupChunkSessions().catch(() => {});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[gateway] FortesDrive storage gateway ' + VERSION + ' na porta ' + PORT);
  console.log('[gateway] armazenamento: ' + (useNextcloud ? 'Nextcloud ' + (process.env.NEXTCLOUD_URL || '') : 'pasta local ' + DATA_DIR));
  if (useNextcloud) console.log('[gateway] arquivos antigos para migrar em ' + LEGACY_DIR);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log('[gateway] encerrando...');
    server.close(() => process.exit(0));
  });
}