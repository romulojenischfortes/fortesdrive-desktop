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
      // A pasta de dados é a do serviço do gateway (o redis monta uma pasta que
      // também se chama /data, dentro da mesma raiz): o volume malformado é
      // aplicado só na linha do gateway.
      const gateway = /^([ \t]*-[ \t]+)\$\{FD_DATA_DIR:-\.\/data\}(:\/data[ \t]*)$/m;
      const composeComVolume = kind === 'broken-compose'
        ? compose.replace(gateway, (linha, inicio, fim) => `${inicio}"${data.replaceAll('\\', '/')}"${fim}`)
        : compose;
      fs.writeFileSync(path.join(folder, 'docker-compose.yml'), composeComVolume);
      fs.writeFileSync(path.join(folder, '.env'), `STORAGE_SIGNING_SECRET=${secret}\n${kind === 'external-env' ? `FD_DATA_DIR=${data}\n` : ''}`);
      for (let repeat = 0; repeat < 2; repeat++) runPowerShell(`$ErrorActionPreference='Stop'; $folder=$env:FD_TEST_FOLDER; ${block}`, folder);
      assert.equal(fs.readFileSync(path.join(data, 'preservado.txt'), 'utf8'), 'nao apagar');
      assert.match(fs.readFileSync(path.join(folder, '.env'), 'utf8'), new RegExp(secret));
      assert.equal(path.normalize(fs.readFileSync(path.join(folder, 'data-dir.txt'), 'utf8')).toLowerCase(), path.normalize(data).toLowerCase());
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
    // O trecho testado inclui a conferência do túnel Cloudflare feita antes de os
    // serviços subirem, que chama estas duas funções do topo do assistente: sem
    // elas definidas o teste falhava com "not recognized".
    const tunel = setup.slice(
      setup.indexOf('function Provisionar-Servidor'),
      setup.indexOf("Write-Host ''", setup.indexOf('function Ler-CodigoInstalacao'))
    );
    const helpers = setup.match(/function Gravar\([\s\S]*?\r?\n\}/)[0] + '\n'
      + setup.slice(setup.indexOf('function Ler-TextoUtf8'), setup.indexOf('# Janela do Windows')) + '\n'
      + tunel;
    const block = setup.slice(setup.indexOf('# Preserva a pasta ja escolhida'), setup.indexOf('#  4/6 Sobe os servicos'));
    runPowerShell(`$ErrorActionPreference='Stop'; ${helpers}; $pasta=$env:FD_TEST_FOLDER; $pastaDados=Join-Path $pasta 'data'; $composeAtual=Join-Path $pasta 'docker-compose.yml'; $envFile=Join-Path $pasta '.env'; $linhas=@(); $segredo='${secret}'; $legado=$false; ${block}`, folder);
    assert.match(fs.readFileSync(path.join(folder, '.env'), 'utf8'), new RegExp(`STORAGE_SIGNING_SECRET=${secret}`));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('reparo migra o gateway anterior de tres argumentos e preserva os dados', { skip: process.platform !== 'win32' || !repair }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-old-gateway-'));
  try {
    fs.mkdirSync(path.join(folder, 'gateway')); fs.mkdirSync(path.join(folder, 'data'));
    const old = read('server/gateway/server.js')
      .replace("const VERSION = '2.4.0';", "const VERSION = '2.3.0';")
      .replace('async function handleUpload(req, res, key, url)', 'async function handleUpload(req, res, key)')
      .replace('return await handleUpload(req, res, key, url);', 'return await handleUpload(req, res, key);');
    fs.writeFileSync(path.join(folder, 'gateway/server.js'), old);
    fs.writeFileSync(path.join(folder, 'docker-compose.yml'), compose);
    fs.writeFileSync(path.join(folder, '.env'), `STORAGE_SIGNING_SECRET=${secret}\n`);
    fs.writeFileSync(path.join(folder, 'data/preservado.txt'), 'nao apagar');
    const script = repair.slice(repair.indexOf('#FDREPAIR#') + '#FDREPAIR#'.length);
    runPowerShell(`$env:FD_REPAIR_DIR=$env:FD_TEST_FOLDER; $env:FD_REPAIR_MODE='patch-only'; ${script}`, folder);
    const updated = fs.readFileSync(path.join(folder, 'gateway/server.js'), 'utf8');
    assert.match(updated, /async function handleUpload\(req, res, key, url\)/);
    assert.match(updated, /return await handleUpload\(req, res, key, url\);/);
    assert.match(updated, /const VERSION = '2\.4\.0';/);
    assert.equal(fs.readFileSync(path.join(folder, 'data/preservado.txt'), 'utf8'), 'nao apagar');
    assert.ok(fs.readFileSync(path.join(folder, '.env'), 'utf8').includes(secret));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});