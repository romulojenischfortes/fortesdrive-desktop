"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { once } = require("node:events");
const native = require("../native-files");
const transfers = require("../native-transfers");
const { classifyBrowserCachePath } = require("../browser-cache");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

test("ignora diretórios temporários conhecidos de cache do navegador sem ignorar pastas 'Cache' comuns do usuário", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fd-browser-cache-"));
  native.configureIndex(null);
  try {
    // 1. Pasta legítima do usuário chamada "Cache" DEVE sincronizar normalmente!
    await fs.mkdir(path.join(root, "Projetos", "Cache"), { recursive: true });
    await fs.writeFile(path.join(root, "Projetos", "Cache", "contrato.pdf"), "documento real do usuario");

    // 2. Diretórios temporários de cache de navegadores (User Data, scoped_dir, Firefox, portátil com GPUCache)
    //    contendo inclusive entradas voláteis com nomes reservados/incompatíveis ("aux.tmp") que antes geravam erro!
    await fs.mkdir(path.join(root, "Google", "Chrome", "User Data", "Default", "Cache", "Cache_Data"), { recursive: true });
    await fs.writeFile(path.join(root, "Google", "Chrome", "User Data", "Default", "Cache", "Cache_Data", "f_00001a"), "lixo volátil");
    await fs.writeFile(path.join(root, "Google", "Chrome", "User Data", "Default", "Cache", "Cache_Data", "aux.json"), "reservado no windows");
    await fs.writeFile(path.join(root, "Google", "Chrome", "User Data", "Default", "Bookmarks"), '{"roots":{}}');

    await fs.mkdir(path.join(root, "scoped_dir19283_77412", "Default", "Code Cache", "js"), { recursive: true });
    await fs.writeFile(path.join(root, "scoped_dir19283_77412", "Default", "Code Cache", "js", "index"), "temp");

    // Perfil portátil sem "User Data" no caminho, identificado pelos irmãos do perfil (GPUCache + Preferences + Local State)
    await fs.mkdir(path.join(root, "NavegadorPortatil", "Perfil", "GPUCache"), { recursive: true });
    await fs.mkdir(path.join(root, "NavegadorPortatil", "Perfil", "Cache"), { recursive: true });
    await fs.mkdir(path.join(root, "NavegadorPortatil", "Perfil", "Network"), { recursive: true });
    await fs.writeFile(path.join(root, "NavegadorPortatil", "Perfil", "Preferences"), "{}");
    await fs.writeFile(path.join(root, "NavegadorPortatil", "Perfil", "Cache", "data_0"), "cache portatil");
    await fs.writeFile(path.join(root, "NavegadorPortatil", "Perfil", "notas.txt"), "nota preservada");

    const full = await native.scan(root, {}, { restart: true });
    assert.equal(full.complete, true);
    // Nenhum erro de "Nome incompatível com o computador" pode aparecer por causa do cache!
    assert.equal(full.skipped.length, 0);

    const syncedPaths = full.files.map((f) => f.path).sort();
    assert.deepEqual(syncedPaths, [
      "Google/Chrome/User Data/Default/Bookmarks",
      "NavegadorPortatil/Perfil/Preferences",
      "NavegadorPortatil/Perfil/notas.txt",
      "Projetos/Cache/contrato.pdf",
    ]);

    const ignoredPaths = full.ignored.map((i) => i.path).sort();
    assert.ok(ignoredPaths.includes("Google/Chrome/User Data/Default/Cache"));
    assert.ok(ignoredPaths.includes("scoped_dir19283_77412"));
    assert.ok(ignoredPaths.includes("NavegadorPortatil/Perfil/GPUCache"));
    assert.ok(ignoredPaths.includes("NavegadorPortatil/Perfil/Cache"));

    // Varredura incremental sobre caminho temporário incompatível dentro do cache
    // também classifica como ignorado sem nunca gerar "Nome incompatível".
    const inc = await native.scanIncremental(root, [
      "Google/Chrome/User Data/Default/Cache/Cache_Data/con.tmp",
      "scoped_dir19283_77412/Default/Cache/prn.bin",
      "Projetos/Cache/contrato.pdf",
    ]);
    assert.equal(inc.skipped.length, 0);
    assert.ok(inc.files.some((f) => f.path === "Projetos/Cache/contrato.pdf"));
    assert.ok(inc.ignored.some((i) => i.path === "Google/Chrome/User Data/Default/Cache"));
  } finally {
    native.shutdownPool?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("download paralelo em faixas retoma exatamente os segmentos faltantes após queda de conexão", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fd-resume-dl-"));
  native.configureIndex(null);
  const content = crypto.randomBytes(20 * 1024 * 1024);
  const expectedChecksum = sha256(content);
  let failLastSegmentOnce = true;
  let totalBytesServedAttempt1 = 0;
  let totalBytesServedAttempt2 = 0;
  let attempt = 1;

  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
    if (!match) {
      res.writeHead(200, { "Content-Length": content.length });
      res.end(content);
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), content.length - 1);
    if (failLastSegmentOnce && end === content.length - 1) {
      failLastSegmentOnce = false;
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Queda temporária do túnel" }));
      return;
    }
    const slice = content.subarray(start, end + 1);
    if (attempt === 1) totalBytesServedAttempt1 += slice.length;
    else totalBytesServedAttempt2 += slice.length;
    res.writeHead(206, {
      "Content-Length": slice.length,
      "Content-Range": `bytes ${start}-${end}/${content.length}`,
      "Accept-Ranges": "bytes",
    });
    res.end(slice);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/v1/objects/u/test/resumable.bin?op=get&expires=${Math.floor(Date.now() / 1000) + 300}&sig=${"c".repeat(64)}`;

  try {
    // 1ª tentativa: falha no último segmento, preservando os segmentos já gravados em .fortesdrive
    await assert.rejects(
      transfers.download(root, "videos/resumable.bin", url, { size: content.length, checksum: expectedChecksum }, null, null, true),
      /faixa paralela/
    );
    assert.ok(totalBytesServedAttempt1 > 0, "segmentos iniciais já foram baixados na primeira tentativa");

    // 2ª tentativa: baixa SOMENTE o segmento que faltou, valida o SHA-256 completo e publica atomicamente!
    attempt = 2;
    const saved = await transfers.download(
      root,
      "videos/resumable.bin",
      url,
      { size: content.length, checksum: expectedChecksum },
      null,
      null,
      true
    );
    assert.equal(saved.size, content.length);
    assert.ok(
      totalBytesServedAttempt2 < content.length / 2,
      `retomada deve transferir apenas o trecho faltante (transferiu ${totalBytesServedAttempt2} de ${content.length} bytes)`
    );
    const diskBytes = await fs.readFile(path.join(root, "videos", "resumable.bin"));
    assert.equal(sha256(diskBytes), expectedChecksum);
  } finally {
    native.shutdownPool?.();
    server.closeAllConnections();
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("journal em disco do índice SHA-256 preserva verificações imediatamente entre reinícios", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fd-index-journal-"));
  const metaDir = await fs.mkdtemp(path.join(os.tmpdir(), "fd-index-meta-"));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "fd-index-other-"));
  const indexFile = path.join(metaDir, "scan-index.json");
  try {
    native.configureIndex(indexFile);
    const payload = Buffer.from("persistido via journal instantaneo");
    await native.write(root, "doc.txt", payload, sha256(payload), null);
    await native.flushIndex();

    // Limpa memória trocando de raiz e reconfigurando o índice
    await native.scan(other, {}, { restart: true });
    native.configureIndex(indexFile);

    const reopened = await native.scan(root, {}, { restart: true });
    assert.equal(reopened.pendingHash, 0);
    assert.equal(reopened.files.length, 1);
    assert.equal(reopened.files[0].checksum, sha256(payload));
  } finally {
    native.configureIndex(null);
    native.shutdownPool?.();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(metaDir, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
});

test("benchmark real: varredura, reconciliação incremental O(1), upload expresso e download paralelo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fd-bench-"));
  native.configureIndex(null);
  const FILE_COUNT = 400;
  const payloads = Array.from({ length: FILE_COUNT }, (_, i) => Buffer.from(`arquivo-${i}-${"x".repeat(1024)}`));
  let uploadedCount = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method === "PUT") {
      const hash = crypto.createHash("sha256");
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        hash.update(chunk);
      }
      uploadedCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, size, checksum: hash.digest("hex") }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  try {
    await fs.mkdir(path.join(root, "lote"), { recursive: true });
    await Promise.all(payloads.map((buf, i) => fs.writeFile(path.join(root, "lote", `f-${i}.txt`), buf)));

    const tScan0 = performance.now();
    const fullScan = await native.scan(root, {}, { restart: true });
    const coldScanMs = performance.now() - tScan0;
    assert.equal(fullScan.files.length, FILE_COUNT);

    // Edição de 1 arquivo numa árvore de centenas: reconciliação incremental O(1)
    await fs.writeFile(path.join(root, "lote", "f-0.txt"), "editado instantaneamente");
    const tInc0 = performance.now();
    const incScan = await native.scanIncremental(root, ["lote/f-0.txt"]);
    const incScanMs = performance.now() - tInc0;
    assert.equal(incScan.files.length, FILE_COUNT);
    assert.ok(incScanMs < Math.max(coldScanMs, 250), `incremental (${incScanMs.toFixed(1)}ms) deve ser ultrarrápido`);

    // Upload expresso concorrente (32 conexões Keep-Alive)
    let cursor = 0;
    const tUp0 = performance.now();
    await Promise.all(Array.from({ length: 32 }, async () => {
      while (cursor < incScan.files.length) {
        const item = incScan.files[cursor++];
        const key = `u/bench/obj${cursor}`;
        const url = `http://127.0.0.1:${port}/v1/objects/${key}?op=put&expires=${Math.floor(Date.now() / 1000) + 300}&sig=${"d".repeat(64)}`;
        await transfers.upload(root, item.path, { url, storageKey: `seaweed:${key}` }, item, null, true);
      }
    }));
    const uploadBatchMs = performance.now() - tUp0;
    assert.equal(uploadedCount, FILE_COUNT);
    assert.ok(uploadBatchMs < 15000, `lote de 400 uploads expressos concluído em ${uploadBatchMs.toFixed(1)}ms`);

    assert.equal(classifyBrowserCachePath("Projetos/Cache/dados.txt"), null);
    assert.ok(classifyBrowserCachePath("User Data/Default/Cache/Cache_Data/f_0001"));
  } finally {
    native.shutdownPool?.();
    server.closeAllConnections();
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});