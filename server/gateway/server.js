'use strict';

/**
 * FortesDrive — gateway do armazenamento próprio (fica ao lado do SeaweedFS).
 *
 * O que ele faz:
 *   • recebe o arquivo por HTTP em fluxo contínuo (sem carregar tudo na memória);
 *   • confere o SHA-256 e o tamanho antes de gravar de verdade no SeaweedFS
 *     (se o conteúdo não confere, nada é gravado — não sobra arquivo pela metade);
 *   • entrega o arquivo de volta (com suporte a Range) e permite apagar;
 *   • informa capacidade e disponibilidade do disco;
 *   • só aceita requisições assinadas com o segredo compartilhado (HMAC-SHA256
 *     com validade curta). O FortesDrive assina no servidor dele e entrega ao
 *     navegador apenas um endereço já assinado e temporário.
 *
 * Não existe senha fixa guardada no navegador: sem assinatura válida, o gateway
 * responde 401 e nada é lido nem gravado.
 *
 * Rotas:
 *   GET    /health                                  → vivo? (sem assinatura)
 *   GET    /v1/status?expires=&sig=                 → disco, versão, filer
 *   PUT    /v1/objects/<chave>?op=put&expires=&sig= → envia conteúdo (header x-fd-sha256)
 *   GET    /v1/objects/<chave>?op=get&expires=&sig= → baixa (aceita Range)
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
const FILER_URL = new URL((process.env.FILER_URL || 'http://seaweedfs:8888').replace(/\/+$/, ''));
const FILER_PREFIX = (process.env.FILER_PREFIX || 'fortesdrive').replace(/^\/+|\/+$/g, '');
const SECRET = process.env.STORAGE_SIGNING_SECRET || '';
const TMP_DIR = process.env.TMP_DIR || '/var/lib/fd-gateway/tmp';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 10737418240);
const MAX_CONCURRENT_UPLOADS = Number(process.env.MAX_CONCURRENT_UPLOADS || 4);
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 120);
const VERSION = '1.0.0';
const STARTED_AT = Date.now();
const MAX_SIGNATURE_LIFETIME_MS = 25 * 3600 * 1000;

// Chaves aceitas: u/<dono>/<arquivo>[.ext] — sem barras extras, sem ".."
const KEY_PATTERN = /^u\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(\.[A-Za-z0-9]{1,8})?$/;

if (!SECRET) {
  console.error('[gateway] STORAGE_SIGNING_SECRET não definido — encerrando.');
  process.exit(1);
}
fs.mkdirSync(TMP_DIR, { recursive: true });

let activeUploads = 0;
const rateBuckets = new Map();

// O app publicado e o cliente desktop falam com este servidor de outro
// domínio, então o navegador exige CORS. A segurança não vem daqui e sim da
// assinatura de cada pedido — por isso, sem cookies, qualquer origem é aceita
// por padrão (restrinja em CORS_ALLOWED_ORIGINS se quiser).
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

/** Envia o arquivo temporário ao SeaweedFS em uma requisição multipart, em fluxo. */
function uploadToFiler(key, filePath, size, contentType) {
  return new Promise((resolve, reject) => {
    const boundary = '----fd' + crypto.randomUUID().replace(/-/g, '');
    const filename = path.basename(key);
    const head = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
      'Content-Type: ' + (contentType || 'application/octet-stream') + '\r\n\r\n'
    );
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const targetPath = '/' + FILER_PREFIX + '/' + key;

    const request = http.request(
      {
        hostname: FILER_URL.hostname,
        port: FILER_URL.port || 80,
        path: targetPath,
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': String(head.length + size + tail.length),
        },
      },
      (response) => {
        let detail = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (detail.length < 4096) detail += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) return resolve();
          reject(new Error('SeaweedFS recusou o arquivo (' + response.statusCode + '): ' + (detail.trim() || 'sem detalhe')));
        });
      }
    );

    request.on('error', reject);
    request.setTimeout(30 * 60 * 1000, () => request.destroy(new Error('Tempo esgotado ao enviar para o SeaweedFS.')));
    request.write(head);

    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('error', (error) => request.destroy(error));
    stream.on('end', () => request.end(tail));
    stream.pipe(request, { end: false });
  });
}

async function handleUpload(req, res, key) {
  const declared = String(req.headers['x-fd-sha256'] || '').toLowerCase();
  const contentLength = Number(req.headers['content-length']);

  if (!/^[a-f0-9]{64}$/.test(declared)) {
    return sendJson(res, 422, { error: 'Informe o checksum SHA-256 em x-fd-sha256.' });
  }
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return sendJson(res, 411, { error: 'Content-Length obrigatório.' });
  }
  if (contentLength > MAX_UPLOAD_BYTES) {
    return sendJson(res, 413, { error: 'Arquivo acima do limite configurado no servidor.' });
  }
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return sendJson(res, 429, { error: 'Muitos envios ao mesmo tempo. Tente novamente em instantes.' });
  }

  activeUploads += 1;
  const tempPath = path.join(TMP_DIR, crypto.randomUUID() + '.part');

  try {
    const hash = crypto.createHash('sha256');
    let written = 0;
    const output = fs.createWriteStream(tempPath);

    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        hash.update(chunk);
        written += chunk.length;
      });
      req.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      req.pipe(output);
    });

    const digest = hash.digest('hex');
    if (written !== contentLength) {
      throw new Error('O conteúdo recebido não corresponde ao tamanho informado.');
    }
    if (digest !== declared) {
      throw new Error('Checksum divergente: o arquivo chegou corrompido e não foi gravado.');
    }

    await uploadToFiler(key, tempPath, contentLength, req.headers['content-type']);
    sendJson(res, 200, { ok: true, key, size: written, checksum: digest });
  } catch (error) {
    console.error('[gateway] falha no envio de ' + key + ': ' + error.message);
    sendJson(res, 502, { error: error.message });
  } finally {
    activeUploads -= 1;
    fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function handleDownload(req, res, key) {
  const target = new URL(FILER_URL.origin + '/' + FILER_PREFIX + '/' + key);
  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;

  const upstream = await fetch(target, { headers, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (upstream.status === 404) return sendJson(res, 404, { error: 'Objeto não encontrado.' });
  if (!upstream.ok && upstream.status !== 206) {
    return sendJson(res, 502, { error: 'SeaweedFS respondeu ' + upstream.status + '.' });
  }

  const outHeaders = {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  };
  const length = upstream.headers.get('content-length');
  const range = upstream.headers.get('content-range');
  if (length) outHeaders['Content-Length'] = length;
  if (range) outHeaders['Content-Range'] = range;

  res.writeHead(upstream.status, outHeaders);
  if (req.method === 'HEAD' || !upstream.body) return res.end();

  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function handleDelete(res, key) {
  const target = new URL(FILER_URL.origin + '/' + FILER_PREFIX + '/' + key);
  const upstream = await fetch(target, { method: 'DELETE', signal: AbortSignal.timeout(60000) });
  if (!upstream.ok && upstream.status !== 404) {
    return sendJson(res, 502, { error: 'SeaweedFS respondeu ' + upstream.status + ' ao apagar.' });
  }
  sendJson(res, 200, { ok: true, key, existed: upstream.status !== 404 });
}

async function handleStatus(res) {
  let disk = { freeBytes: null, totalBytes: null };
  try {
    const stats = await fsp.statfs(TMP_DIR);
    disk = { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch (error) {
    console.error('[gateway] não foi possível ler o disco: ' + error.message);
  }

  let filerReachable = false;
  try {
    const probe = await fetch(new URL(FILER_URL.origin + '/'), { signal: AbortSignal.timeout(5000) });
    filerReachable = probe.status < 500;
  } catch {
    filerReachable = false;
  }

  sendJson(res, 200, {
    ok: true,
    version: VERSION,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    filer: { reachable: filerReachable },
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
  console.log('[gateway] SeaweedFS em ' + FILER_URL.origin + ', prefixo /' + FILER_PREFIX);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log('[gateway] encerrando...');
    server.close(() => process.exit(0));
  });
}