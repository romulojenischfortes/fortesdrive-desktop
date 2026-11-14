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
 * Rotas:
 *   GET    /health                                    → vivo? (sem assinatura)
 *   GET    /v1/status?expires=&sig=                   → disco, versão, gravação
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

const PORT = Number(process.env.PORT || 8790);
// Pasta onde os arquivos moram (o volume do Docker aponta para a pasta de dados
// escolhida no assistente — pode ser outro disco).
const DATA_DIR = process.env.DATA_DIR || '/data';
const SECRET = process.env.STORAGE_SIGNING_SECRET || '';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 10737418240);
// Envio em lote: o cliente manda até 30 arquivos ao mesmo tempo. O gateway
// aceita esses 30 e, se chegar mais, o arquivo espera a vez (acquireUploadSlot)
// em vez de ser recusado — a fila nunca para no meio.
const MAX_CONCURRENT_UPLOADS = Number(process.env.MAX_CONCURRENT_UPLOADS || 30);
// Sincronização em lote faz muitas chamadas por minuto: o limite existe para
// barrar abuso, não para atrapalhar o uso normal.
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 1800);
// Tempo máximo que um arquivo espera por uma vaga antes de o cliente tentar de novo.
const UPLOAD_SLOT_WAIT_MS = Number(process.env.UPLOAD_SLOT_WAIT_MS || 120000);
const VERSION = '2.0.2';
const STARTED_AT = Date.now();
const MAX_SIGNATURE_LIFETIME_MS = 25 * 3600 * 1000;

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
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-fd-sha256, ngrok-skip-browser-warning');
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

/** A pasta de dados aceita gravação agora? (teste real, arquivo minúsculo) */
async function storageWritable() {
  const probe = path.join(TMP_DIR, 'probe-' + crypto.randomUUID());
  try {
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
    return true;
  } catch (error) {
    console.error('[gateway] pasta de dados não aceita gravação: ' + error.message);
    return false;
  }
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

async function handleUpload(req, res, key) {
  const declared = String(req.headers['x-fd-sha256'] || '').toLowerCase();
  const lengthHeader = req.headers['content-length'];
  const contentLength = lengthHeader == null ? null : Number(lengthHeader);

  if (!/^[a-f0-9]{64}$/.test(declared)) {
    return sendJson(res, 422, { error: 'Informe o checksum SHA-256 em x-fd-sha256.' });
  }
  if (contentLength !== null && (!/^\d+$/.test(String(lengthHeader)) || !Number.isSafeInteger(contentLength))) {
    return sendJson(res, 400, { error: 'Tamanho informado inválido.' });
  }
  if (contentLength !== null && contentLength > MAX_UPLOAD_BYTES) {
    return sendJson(res, 413, { error: 'Arquivo acima do limite configurado no servidor.' });
  }
  req.socket?.setNoDelay?.(true);
  if (!(await acquireUploadSlot())) {
    return sendJson(res, 429, { error: 'O servidor está ocupado com outros envios. Tente novamente em instantes.' });
  }

  const tempPath = path.join(TMP_DIR, crypto.randomUUID() + '.part');
  try {
    const finalPath = typeof uploadToFiler === 'function' ? null : objectPath(key);
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
    else await uploadToFiler(key, tempPath, written, req.headers['content-type']);
    sendJson(res, 200, { ok: true, key, size: written, checksum: digest });
  } catch (error) {
    if (!req.destroyed) req.resume();
    console.error('[gateway] falha no envio de ' + key + ': ' + error.message);
    if (!res.destroyed) sendJson(res, error.status || (typeof uploadToFiler === 'function' ? 502 : 500), { error: error.message });
  } finally {
    releaseUploadSlot();
    await fsp.rm(tempPath, { force: true });
  }
}

function streamFile(filePath, res, options) {
  return new Promise((resolve) => {
    // Blocos maiores por leitura: menos idas ao disco e mais dados em voo por
    // conexão, o que faz diferença em links rápidos e túneis com latência.
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024, ...options });
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
  let disk = { freeBytes: null, totalBytes: null };
  try {
    const stats = await fsp.statfs(DATA_DIR);
    disk = { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch (error) {
    console.error('[gateway] não foi possível ler o disco: ' + error.message);
  }

  const writable = await storageWritable();

  sendJson(res, 200, {
    ok: true,
    version: VERSION,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    // O app consulta "filer.reachable" para saber se há onde gravar. Aqui a
    // gravação acontece na própria pasta de dados: é ela que responde.
    filer: { reachable: writable, backend: 'disk' },
    storage: { writable, backend: 'disk', dataDir: DATA_DIR },
    disk,
    limits: {
      maxUploadBytes: MAX_UPLOAD_BYTES,
      maxConcurrentUploads: MAX_CONCURRENT_UPLOADS,
      rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
    },
  });
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
      return sendJson(res, 200, { ok: true, version: VERSION });
    }

    if (rateLimited(clientIp(req))) {
      return sendJson(res, 429, { error: 'Muitas requisições. Aguarde um instante.' });
    }

    if (url.pathname === '/v1/status') {
      const failure = signatureError(url, 'status', '');
      if (failure) return sendJson(res, 401, { error: failure });
      return await handleStatus(res);
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
      if (failure) return sendJson(res, 401, { error: failure });

      if (op === 'put') {
        if (req.method !== 'PUT') return sendJson(res, 405, { error: 'Use PUT para enviar conteúdo.' });
        return await handleUpload(req, res, key);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log('[gateway] FortesDrive storage gateway ' + VERSION + ' na porta ' + PORT);
  console.log('[gateway] arquivos guardados em ' + DATA_DIR);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log('[gateway] encerrando...');
    server.close(() => process.exit(0));
  });
}