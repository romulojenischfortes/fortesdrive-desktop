'use strict';

/**
 * FortesDrive — armazenamento no Nextcloud (WebDAV).
 *
 * O gateway continua sendo o único ponto autenticado: ele recebe o envio
 * assinado, confere o SHA-256 e só então grava no Nextcloud, pelo WebDAV. É o
 * mesmo contrato de antes (`u/<dono>/<arquivo>`), então o app e o cliente
 * desktop não precisam de nenhuma mudança — só os bytes passam a morar no
 * Nextcloud, que também cuida de versões, lixeira e interface web.
 *
 * Configuração (arquivo .env do servidor):
 *   NEXTCLOUD_URL           endereço interno do Nextcloud (ex.: http://nextcloud)
 *   NEXTCLOUD_USER          conta que guarda os arquivos
 *   NEXTCLOUD_APP_PASSWORD  senha de aplicativo dessa conta (gerada no instalador)
 *   NEXTCLOUD_ROOT          pasta dentro da conta (padrão: FortesDrive)
 */

const http = require('node:http');
const https = require('node:https');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');

const davAgents = {
  'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 45000, maxSockets: 128, maxFreeSockets: 64, scheduling: 'lifo' }),
  'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 45000, maxSockets: 128, maxFreeSockets: 64, scheduling: 'lifo' }),
};
const ensuredParents = new Set();
const ensuringParents = new Map();

const CONTENT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic',
  svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4',
  webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg',
  ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac',
  zip: 'application/zip', '7z': 'application/x-7z-compressed',
  rar: 'application/x-rar-compressed', json: 'application/json',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function config() {
  const url = String(process.env.NEXTCLOUD_URL || '').trim().replace(/\/+$/, '');
  // NEXTCLOUD_USER e o nome documentado; NEXTCLOUD_ADMIN_USER e o que o
  // assistente grava no .env. Sem esta equivalencia o gateway nao se
  // considerava configurado e gravava na pasta local em vez do Nextcloud,
  // sem avisar ninguem.
  const user = String(process.env.NEXTCLOUD_USER || process.env.NEXTCLOUD_ADMIN_USER || '').trim();
  const password = String(process.env.NEXTCLOUD_APP_PASSWORD || '').trim();
  const root = String(process.env.NEXTCLOUD_ROOT || 'FortesDrive').trim().replace(/^\/+|\/+$/g, '') || 'FortesDrive';
  return { url, user, password, root, enabled: Boolean(url && user && password) };
}

function isConfigured() {
  return config().enabled;
}

function contentTypeFor(key) {
  const extension = String(key.split('.').pop() || '').toLowerCase();
  return CONTENT_TYPES[extension] || 'application/octet-stream';
}

/** Caminho WebDAV do objeto: /<pasta raiz u/<dono>/<arquivo>, segmento a segmento. */
function davTarget(cfg, key) {
  const segments = [cfg.root, ...String(key || '').split('/').filter(Boolean)];
  return '/' + segments.map((segment) => encodeURIComponent(segment)).join('/');
}

/** Abre uma requisição WebDAV. Devolve a requisição já com autenticação. */
function open(method, target, headers = {}) {
  const cfg = config();
  if (!cfg.enabled) throw new Error('Nextcloud não configurado no servidor.');
  const base = new URL(cfg.url);
  const lib = base.protocol === 'https:' ? https : http;
  const auth = 'Basic ' + Buffer.from(cfg.user + ':' + cfg.password).toString('base64');
  const basePath = base.pathname.replace(/\/+$/, '');
  const requestPath = basePath + '/remote.php/dav/files/' + encodeURIComponent(cfg.user) + target;
  const request = lib.request({
    method,
    hostname: base.hostname,
    port: base.port || (base.protocol === 'https:' ? 443 : 80),
    path: requestPath,
    agent: davAgents[base.protocol],
    headers: {
      Authorization: auth,
      'User-Agent': 'FortesDrive-Gateway',
      ...headers,
    },
  });
  request.setNoDelay(true);
  return { cfg, request };
}

/** Requisição simples cujo corpo é lido inteiro (respostas pequenas). */
function send(method, target, { headers = {}, body = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let opened;
    try {
      opened = open(method, target, headers);
    } catch (error) {
      return reject(error);
    }
    const req = opened.request;
    req.setTimeout(timeoutMs, () => req.destroy(new Error('O Nextcloud não respondeu a tempo.')));
    req.on('error', reject);
    req.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
        response,
      }));
      response.on('error', reject);
    });
    if (body) req.end(body);
    else req.end();
  });
}

/** Cria as pastas pai do objeto uma única vez por diretório (405 = já existe). */
async function ensureParents(key, force = false) {
  const cfg = config();
  const segments = [cfg.root, ...String(key).split('/').slice(0, -1).filter(Boolean)];
  const fullTarget = '/' + segments.map(s => encodeURIComponent(s)).join('/');
  const cacheKey = cfg.url + '|' + cfg.user + '|' + fullTarget;
  if (!force && ensuredParents.has(cacheKey)) return;
  if (!force && ensuringParents.has(cacheKey)) return ensuringParents.get(cacheKey);

  const job = (async () => {
    let target = '';
    for (const segment of segments) {
      target += '/' + encodeURIComponent(segment);
      const stepKey = cfg.url + '|' + cfg.user + '|' + target;
      if (!force && ensuredParents.has(stepKey)) continue;
      const result = await send('MKCOL', target, { timeoutMs: 30000 });
      if (result.status >= 400 && result.status !== 405) {
        if (result.status !== 409 && result.status !== 423) {
          const error = new Error('Não foi possível preparar a pasta no Nextcloud (' + result.status + ').');
          error.status = result.status;
          throw error;
        }
      } else {
        ensuredParents.add(stepKey);
      }
    }
    ensuredParents.add(cacheKey);
  })().finally(() => {
    ensuringParents.delete(cacheKey);
  });

  ensuringParents.set(cacheKey, job);
  return job;
}

/**
 * Traduz uma resposta do Nextcloud no motivo, em vez de um "falhou" genérico.
 *   webdav-auth          credenciais recusadas (conta ou senha de aplicativo)
 *   quota                cota da conta esgotada
 *   nextcloud-busy       o Nextcloud limitou as tentativas (429, proteção contra força bruta)
 *   nextcloud-starting   o Nextcloud respondeu, mas ainda não está pronto
 *   nextcloud-unreachable não respondeu (rede, container parado, DNS)
 *   webdav-error         qualquer outro erro do WebDAV
 */
function reasonFor(status, detail) {
  if (status === 401 || status === 403) return 'webdav-auth';
  if (status === 507) return 'quota';
  if (status === 429) return 'nextcloud-busy';
  // 409/423 e os 5xx são o que um Nextcloud recém-instalado devolve enquanto
  // cria o banco e as pastas da conta: é inicialização, não falha de configuração.
  if (!status || status >= 500 || status === 404 || status === 405 || status === 409 || status === 423) {
    return 'nextcloud-starting';
  }
  return 'webdav-error';
}

/**
 * O Nextcloud está aceitando gravação agora?
 * Envia um arquivo real, confere o conteúdo lido de volta e apaga — assim
 * "gravável" significa que o arquivo entra, sai inteiro e o objeto de teste
 * não fica para trás. Devolve sempre { writable, reason, detail }.
 */
async function probe() {
  const cfg = config();
  const falha = (status, detail) => ({
    writable: false,
    reason: reasonFor(status, detail),
    // O código HTTP viaja junto: é ele que diz se o Nextcloud ainda está
    // instalando (409/423/5xx), se recusou a conta (401/403) ou se limitou as
    // tentativas (429) — sem ele, tudo isso aparecia como "erro desconhecido".
    code: status || null,
    detail: (status ? 'HTTP ' + status + ' — ' : '') + (detail || 'O Nextcloud não confirmou a gravação.'),
  });

  if (!cfg.enabled) {
    return {
      writable: false,
      reason: 'not-configured',
      code: null,
      detail: 'Faltam NEXTCLOUD_URL, NEXTCLOUD_USER e NEXTCLOUD_APP_PASSWORD no .env do servidor.',
    };
  }

  const probeKey = '.fd-probe-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.txt';
  const body = 'ok';
  let passo = 'criar a pasta';
  try {
    await ensureParents(probeKey);
    passo = 'gravar';
    const put = await send('PUT', davTarget(cfg, probeKey), {
      headers: { 'Content-Type': 'text/plain', 'Content-Length': body.length },
      body,
      timeoutMs: 30000,
    });
    if (put.status >= 400) return falha(put.status, 'O Nextcloud recusou a gravação (' + put.status + '). ' + put.text.slice(0, 200));
    passo = 'ler de volta';
    const read = await send('GET', davTarget(cfg, probeKey), { timeoutMs: 30000 });
    if (read.status >= 400) return falha(read.status, 'O Nextcloud não devolveu o arquivo gravado (' + read.status + ').');
    if (read.text !== body) {
      return { writable: false, reason: 'webdav-error', detail: 'O Nextcloud devolveu conteúdo diferente do que foi gravado.' };
    }
    return { writable: true, reason: 'ok', detail: null };
  } catch (error) {
    const status = Number(error.status) || 0;
    const detail = passo + ': ' + error.message;
    if (status) return falha(status, detail);
    return { writable: false, reason: 'nextcloud-unreachable', detail };
  } finally {
    // O objeto de teste nunca fica no armazenamento.
    try {
      await send('DELETE', davTarget(cfg, probeKey), { timeoutMs: 20000 });
    } catch { /* melhor sobrar um .fd-probe do que perder o diagnóstico */ }
  }
}

/** Atalho usado por quem só precisa saber sim ou não. */
async function writable() {
  const result = await probe();
  return result.writable;
}

/** Espaço do Nextcloud: usado e disponível (null quando não há limite). */
async function quota() {
  const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>' +
    '<d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>';
  try {
    // A cota é informada na raiz da conta, não na pasta do FortesDrive.
    const result = await send('PROPFIND', '/', {
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
      body,
      timeoutMs: 20000,
    });
    if (result.status >= 400) return { usedBytes: null, freeBytes: null, totalBytes: null };
    const used = Number((result.text.match(/<d:quota-used-bytes>(-?\d+)<\/d:quota-used-bytes>/i) || [])[1]);
    const available = Number((result.text.match(/<d:quota-available-bytes>(-?\d+)<\/d:quota-available-bytes>/i) || [])[1]);
    const usedBytes = Number.isFinite(used) && used >= 0 ? used : null;
    const freeBytes = Number.isFinite(available) && available >= 0 ? available : null;
    return {
      usedBytes,
      freeBytes,
      totalBytes: usedBytes != null && freeBytes != null ? usedBytes + freeBytes : null,
    };
  } catch (error) {
    console.error('[nextcloud] não foi possível ler a cota: ' + error.message);
    return { usedBytes: null, freeBytes: null, totalBytes: null };
  }
}

/** Tamanho do objeto no Nextcloud (null quando não existe). */
async function objectSize(key) {
  try {
    const result = await send('HEAD', davTarget(config(), key), { timeoutMs: 20000 });
    if (result.status >= 400) return null;
    const size = Number(result.headers['content-length']);
    return Number.isFinite(size) ? size : 0;
  } catch {
    return null;
  }
}

/**
 * Envia um arquivo já conferido (SHA-256) para o Nextcloud.
 * O cabeçalho OC-Checksum faz o próprio Nextcloud recusar conteúdo corrompido.
 */
async function putFileOnce(cfg, key, filePath, size, sha256Hex) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': contentTypeFor(key),
      'Content-Length': size,
      'OC-Checksum': 'SHA256:' + Buffer.from(sha256Hex, 'hex').toString('base64'),
    };
    let opened;
    try {
      opened = open('PUT', davTarget(cfg, key), headers);
    } catch (error) {
      return reject(error);
    }
    const req = opened.request;
    req.setTimeout(3600000, () => req.destroy(new Error('O Nextcloud não respondeu durante o envio.')));
    req.on('error', reject);
    req.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const status = response.statusCode || 0;
        if (status >= 400) {
          const corpo = Buffer.concat(chunks).toString('utf8').slice(0, 200);
          const motivo = status === 401 || status === 403
            ? 'O Nextcloud recusou as credenciais do gateway (' + status + '): confira NEXTCLOUD_USER e NEXTCLOUD_APP_PASSWORD no .env do servidor.'
            : 'O Nextcloud recusou o arquivo (' + status + '). ' + corpo;
          return reject(Object.assign(new Error(motivo), { status: 502, upstreamStatus: status }));
        }
        resolve({ size });
      });
      response.on('error', reject);
    });
    const source = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    source.on('error', reject);
    source.pipe(req);
  });
}

async function putFile(key, filePath, sha256Hex) {
  const cfg = config();
  const size = (await fsp.stat(filePath)).size;
  await ensureParents(key);
  try {
    return await putFileOnce(cfg, key, filePath, size, sha256Hex);
  } catch (error) {
    if (error.upstreamStatus === 404 || error.upstreamStatus === 409) {
      ensuredParents.clear();
      await ensureParents(key, true);
      return await putFileOnce(cfg, key, filePath, size, sha256Hex);
    }
    throw error;
  }
}

/** Entrega o objeto ao cliente, respeitando Range (vídeo, retomada de download). */
function streamToClient(key, req, res) {
  return new Promise((resolve) => {
    const headers = { Accept: 'application/octet-stream' };
    if (req.headers.range) headers.Range = String(req.headers.range);
    let opened;
    try {
      opened = open(req.method === 'HEAD' ? 'HEAD' : 'GET', davTarget(config(), key), headers);
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
      return resolve();
    }
    const upstream = opened.request;
    upstream.setTimeout(3600000, () => upstream.destroy(new Error('O Nextcloud não respondeu durante o download.')));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'O Nextcloud não entregou o arquivo.' }));
      resolve();
    });
    upstream.on('response', (response) => {
      const status = response.statusCode || 0;
      if (status === 404 || status === 401 || status === 403) {
        response.resume();
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Objeto não encontrado.' }));
        return resolve();
      }
      const pass = {};
      for (const name of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        if (response.headers[name]) pass[name] = response.headers[name];
      }
      res.writeHead(status, {
        ...pass,
        'Content-Type': contentTypeFor(key),
        'Cache-Control': 'private, max-age=300',
      });
      if (req.method === 'HEAD') {
        response.resume();
        res.end();
        return resolve();
      }
      response.pipe(res);
      response.on('end', resolve);
      response.on('error', () => resolve());
    });
    upstream.end();
  });
}

/** Apaga o objeto. `existed` diz se ele realmente estava lá. */
async function deleteFile(key) {
  const result = await send('DELETE', davTarget(config(), key), { timeoutMs: 60000 });
  if (result.status === 404) return { existed: false };
  if (result.status >= 400) {
    throw new Error('O Nextcloud não apagou o arquivo (' + result.status + ').');
  }
  return { existed: true };
}

/** Lista recursiva da pasta antiga, uma entrada por arquivo. */
async function legacyFiles(legacyDir) {
  const found = [];
  async function walk(directory, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.tmp' || entry.name === 'tmp' || entry.name === 'nextcloud' || entry.name === 'db') continue;
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  }
  await walk(path.join(legacyDir, 'u'), 'u');
  return found;
}

module.exports = {
  isConfigured,
  contentTypeFor,
  probe,
  writable,
  quota,
  objectSize,
  putFile,
  streamToClient,
  deleteFile,
  legacyFiles,
};