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

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

test("varredura incremental por journal atualiza edições, criações e exclusões em O(k) sem revarrer toda a árvore", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fd-journal-"));
  native.configureIndex(null);
  try {
    await fs.mkdir(path.join(root, "intocada"), { recursive: true });
    await fs.mkdir(path.join(root, "ativa"), { recursive: true });
    await fs.writeFile(path.join(root, "intocada", "fixo.txt"), "nao mexer");
    await fs.writeFile(path.join(root, "ativa", "doc.txt"), "versao 1");
    await fs.writeFile(path.join(root, "ativa", "apagar.txt"), "sair");

    const full = await native.scan(root, {}, { restart: true });
    assert.equal(full.complete, true);
    assert.equal(full.files.length, 3);
    assert.equal(native.hasCompletedTree(root), true);

    // Edita doc.txt, apaga apagar.txt e cria subpasta nova com novo arquivo.
    await fs.writeFile(path.join(root, "ativa", "doc.txt"), "versao 2 muito mais longa");
    await fs.unlink(path.join(root, "ativa", "apagar.txt"));
    await fs.mkdir(path.join(root, "ativa", "sub"), { recursive: true });
    await fs.writeFile(path.join(root, "ativa", "sub", "novo.txt"), "chegou agora");

    const inc = await native.scanIncremental(root, ["ativa/doc.txt", "ativa/apagar.txt", "ativa/sub"]);
    assert.equal(inc.complete, true);
    assert.equal(inc.files.length, 3);

    const byPath = new Map(inc.files.map((f) => [f.path, f]));
    assert.equal(byPath.has("ativa/apagar.txt"), false);
    assert.equal(byPath.get("intocada/fixo.txt").checksum, sha256(Buffer.from("nao mexer")));
    assert.equal(byPath.get("ativa/doc.txt").checksum, sha256(Buffer.from("versao 2 muito mais longa")));
    assert.equal(byPath.get("ativa/sub/novo.txt").checksum, sha256(Buffer.from("chegou agora")));
    assert.ok(inc.directories.some((d) => d.path === "ativa/sub"));
  } finally {
    native.shutdownPool?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("download nativo usa múltiplas conexões Range em paralelo para arquivos grandes e aquece o índice", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fd-range-dl-"));
  native.configureIndex(null);
  const content = crypto.randomBytes(28 * 1024 * 1024);
  const expectedChecksum = sha256(content);
  const seenRanges = [];

  const server = http.createServer((req, res) => {
    const rangeHeader = req.headers.range;
    const match = rangeHeader && /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
    if (match) {
      seenRanges.push(rangeHeader);
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), content.length - 1);
      const slice = content.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Length": slice.length,
        "Content-Range": `bytes ${start}-${end}/${content.length}`,
        "Accept-Ranges": "bytes",
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { "Content-Length": content.length });
    res.end(content);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/v1/objects/u/test/big.bin?op=get&expires=${Math.floor(Date.now() / 1000) + 300}&sig=${"b".repeat(64)}`;

  try {
    await native.scan(root, {}, { restart: true });
    let lastLoaded = 0;
    const saved = await transfers.download(
      root,
      "downloads/big.bin",
      url,
      { size: content.length, checksum: expectedChecksum },
      null,
      (loaded) => { lastLoaded = loaded; },
      true
    );
    assert.equal(saved.size, content.length);
    assert.equal(lastLoaded, content.length);
    assert.ok(seenRanges.length >= 3, "deve dividir o download grande em múltiplas faixas Range paralelas");
    const diskBytes = await fs.readFile(path.join(root, "downloads", "big.bin"));
    assert.equal(sha256(diskBytes), expectedChecksum);
  } finally {
    native.shutdownPool?.();
    server.closeAllConnections();
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});