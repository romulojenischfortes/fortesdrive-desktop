const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const native = require("../native-files");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

test("primeira varredura sem índice verifica todos os arquivos em paralelo, prioriza menores e expõe métricas em bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fd-fast-scan-"));
  native.configureIndex(null);
  try {
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.mkdir(path.join(root, "media"), { recursive: true });

    const emptyBuf = Buffer.alloc(0);
    const smallBuf = Buffer.from("contrato assinado");
    const bigBuf = crypto.randomBytes(3 * 1024 * 1024);

    await fs.writeFile(path.join(root, "docs", "vazio.txt"), emptyBuf);
    await fs.writeFile(path.join(root, "docs", "pequeno.txt"), smallBuf);
    await fs.writeFile(path.join(root, "media", "grande.bin"), bigBuf);

    // Com orçamento de 2 itens na primeira fatia, os 2 menores entram na hora
    // e o grande fica pendente para a continuação sem bloquear o início do envio.
    const partial = await native.scan(root, {}, { hashBudget: 2, restart: true });
    assert.equal(partial.walked, true);
    assert.equal(partial.complete, false);
    assert.equal(partial.totalFiles, 3);
    assert.equal(partial.files.length, 2);
    assert.equal(partial.pendingHash, 1);
    assert.deepEqual(partial.unread, ["media/grande.bin"]);

    // Retrato instantâneo (peekScan) reflete o que já está pronto sem bloquear.
    const peeked = native.peekScan(root);
    assert.ok(peeked);
    assert.equal(peeked.files.length, 2);
    assert.equal(peeked.pendingHash, 1);

    // Continuação verifica o arquivo grande nas worker_threads e conclui 100%.
    const final = await native.scan(root, {});
    assert.equal(final.complete, true);
    assert.equal(final.pendingHash, 0);
    assert.equal(final.files.length, 3);
    assert.equal(final.hashedBytes, emptyBuf.length + smallBuf.length + bigBuf.length);
    assert.ok(final.bytesPerSec > 0);

    const byPath = new Map(final.files.map((f) => [f.path, f]));
    assert.equal(byPath.get("docs/vazio.txt").checksum, sha256(emptyBuf));
    assert.equal(byPath.get("docs/pequeno.txt").checksum, sha256(smallBuf));
    assert.equal(byPath.get("media/grande.bin").checksum, sha256(bigBuf));
  } finally {
    native.shutdownPool?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});