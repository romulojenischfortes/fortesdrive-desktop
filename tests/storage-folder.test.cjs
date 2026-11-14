const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const standalone = fs.existsSync(path.join(desktopRoot, 'server/gateway/server.js'));
const root = standalone ? desktopRoot : path.resolve(desktopRoot, '..');
const prefix = standalone ? '' : path.basename(desktopRoot) + '/';
const read = (file) => {
  const full = path.join(root, prefix + file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
};

const setup = read('server/setup-server.ps1');
const repair = read('server/repair-uploads.bat');
const compose = read('server/docker-compose.yml');

test('os scripts usam criação literal de pastas sem o parâmetro inválido do PowerShell', { skip: !setup }, () => {
  for (const source of [setup, repair]) {
    assert.doesNotMatch(source, /^[ \t]*New-Item[^\n]*-LiteralPath/m);
    assert.match(source, /\[IO\.Directory\]::CreateDirectory\(\$pastaDados\)/);
  }
  assert.match(setup, /'STORAGE_SIGNING_SECRET=' \+ \$segredo/);
  assert.match(repair, /compose config --quiet/);
  assert.doesNotMatch(repair, /compose up[^\n]*--no-deps|compose down/);
});

test('o reparo mantém o segredo e usa aspas no volume inteiro', { skip: !repair }, () => {
  assert.match(repair, /-notmatch '\^\\s\*FD_DATA_DIR\\s\*='/);
  assert.match(repair, /WriteAllText\(\$envFile/);
  assert.doesNotMatch(repair, /STORAGE_SIGNING_SECRET=/);
  assert.match(repair, /:\/data'/);
});

const os = require('node:os');
const { spawnSync } = require('node:child_process');
const secret = 'regression-test-secret-32-characters';
const runPowerShell = (script, folder) => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', env: { ...process.env, FD_TEST_FOLDER: folder }, timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
};

test('os scripts completos são sintaticamente válidos no Windows PowerShell 5.1', { skip: process.platform !== 'win32' || !setup }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-parse-'));
  try {
    for (const source of [setup, repair.slice(repair.indexOf('#FDREPAIR#') + '#FDREPAIR#'.length)]) {
      fs.writeFileSync(path.join(folder, 'source.txt'), source);
      runPowerShell(`$s=[IO.File]::ReadAllText((Join-Path $env:FD_TEST_FOLDER 'source.txt'),[Text.Encoding]::UTF8); $tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseInput($s,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`, folder);
    }
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('o reparo executa de verdade com pasta padrão, acentos, colchetes e volume malformado', { skip: process.platform !== 'win32' || !repair }, () => {
  const block = repair.slice(repair.indexOf('  # --- Pasta de dados do Docker'), repair.indexOf("  $handler = @'"));
  for (const kind of ['default', 'external-env', 'broken-compose']) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-startup-'));
    try {
      const data = kind === 'default' ? path.join(folder, 'data') : path.join(folder, 'dados Rômulo [1]');
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, 'preservado.txt'), 'nao apagar');
      const mount = kind === 'broken-compose' ? `"${data.replaceAll('\\', '/')}"` : '${FD_DATA_DIR:-./data}';
      fs.writeFileSync(path.join(folder, 'docker-compose.yml'), compose.replace('${FD_DATA_DIR:-./data}', mount));
      fs.writeFileSync(path.join(folder, '.env'), `STORAGE_SIGNING_SECRET=${secret}\n${kind === 'external-env' ? `FD_DATA_DIR=${data}\n` : ''}`);
      for (let repeat = 0; repeat < 2; repeat++) runPowerShell(`$ErrorActionPreference='Stop'; $folder=$env:FD_TEST_FOLDER; ${block}`, folder);
      assert.equal(fs.readFileSync(path.join(data, 'preservado.txt'), 'utf8'), 'nao apagar');
      assert.match(fs.readFileSync(path.join(folder, '.env'), 'utf8'), new RegExp(secret));
      assert.equal(fs.readFileSync(path.join(folder, 'data-dir.txt'), 'utf8').toLowerCase(), data.toLowerCase());
      const mounted = fs.readFileSync(path.join(folder, 'docker-compose.yml'), 'utf8');
      assert.ok(mounted.includes(`- '${data.replaceAll('\\', '/')}:/data'`));
      assert.doesNotMatch(mounted, /":\/data/);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  }
});

test('a primeira instalação não apaga o segredo recém-criado ao gravar a pasta de dados', { skip: process.platform !== 'win32' || !setup }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-first-install-'));
  try {
    fs.writeFileSync(path.join(folder, 'docker-compose.yml'), compose);
    const helpers = setup.match(/function Gravar\([\s\S]*?\r?\n\}/)[0] + '\n' + setup.slice(setup.indexOf('function Ler-TextoUtf8'), setup.indexOf('# Janela do Windows'));
    const block = setup.slice(setup.indexOf('# Preserva a pasta ja escolhida'), setup.indexOf('#  4/6 Sobe os servicos'));
    runPowerShell(`$ErrorActionPreference='Stop'; ${helpers}; $pasta=$env:FD_TEST_FOLDER; $pastaDados=Join-Path $pasta 'data'; $composeAtual=Join-Path $pasta 'docker-compose.yml'; $envFile=Join-Path $pasta '.env'; $linhas=@(); $segredo='${secret}'; $legado=$false; ${block}`, folder);
    assert.match(fs.readFileSync(path.join(folder, '.env'), 'utf8'), new RegExp(`STORAGE_SIGNING_SECRET=${secret}`));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});