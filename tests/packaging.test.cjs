// Garante que o instalador leve tudo o que o aplicativo exige ao iniciar.
// Um módulo fora da lista `build.files` derruba o aplicativo inteiro com
// "Cannot find module" antes de qualquer tela aparecer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const patterns = Array.isArray(pkg.build?.files) ? pkg.build.files : [];

// Padrões usados em package.json: nome exato do arquivo ou "pasta/**/*".
const isPackaged = (relative) =>
  patterns.some((pattern) =>
    pattern.endsWith("/**/*") ? relative.startsWith(pattern.slice(0, -5)) : pattern === relative
  );

const localRequires = (relative) => {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const names = new Set();
  const pattern = /require\(\s*["']\.\/([^"']+)["']\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    names.add(path.extname(match[1]) ? match[1] : match[1] + ".js");
  }
  return [...names];
};

// Segue os requires locais a partir do arquivo principal do aplicativo.
const reachableModules = (entry) => {
  const seen = new Set();
  const walk = (relative) => {
    if (seen.has(relative)) return;
    seen.add(relative);
    for (const name of localRequires(relative)) walk(name);
  };
  walk(entry);
  return [...seen];
};

test("o instalador leva todos os módulos exigidos pelo aplicativo", () => {
  assert.ok(pkg.main, "package.json precisa declarar o arquivo principal");
  const missing = reachableModules(pkg.main).filter((relative) => !isPackaged(relative));
  assert.deepEqual(missing, [], "módulos fora da lista de arquivos do instalador");
  assert.ok(isPackaged("preload.js"), "o preload.js precisa acompanhar o aplicativo");
});

test("todo arquivo listado no instalador existe no projeto", () => {
  const absent = patterns
    .filter((pattern) => !pattern.includes("*"))
    .filter((pattern) => !fs.existsSync(path.join(root, pattern)));
  assert.deepEqual(absent, [], "arquivos listados que não existem mais");
});

test("a extensão de marcas do Explorador acompanha o instalador", () => {
  const resources = pkg.build?.extraResources ?? [];
  const shipsOverlays = resources.some((entry) => String(entry.to ?? "").endsWith("shell/FortesDriveOverlays.dll"));
  assert.ok(shipsOverlays, "a DLL das marcas do Explorador precisa ser publicada junto do aplicativo");
});