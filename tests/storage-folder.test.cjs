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

test('a pasta de dados não passa mais pelo .env do Docker', { skip: !setup }, () => {
  // Get-Content no Windows PowerShell decodifica como ANSI: "Rômulo" virava
  // "RÃ´mulo", o daemon não conseguia criar a pasta e recusava com
  // "Access is denied" — o servidor não subia e o túnel respondia 502.
  assert.doesNotMatch(setup, /Get-Content[^\n]*\$envFile/);
  assert.match(setup, /function Ler-TextoUtf8/);
  assert.match(compose, /^\s*-\s*\$\{FD_DATA_DIR:-\.\/data\}:\/data$/m);
});

test('o assistente cria a pasta e conserta um caminho corrompido', { skip: !setup }, () => {
  assert.match(setup, /New-Item -ItemType Directory -Force -LiteralPath \$pastaDados/);
  assert.match(setup, /Desfazer-CaminhoCorrompido/);
  assert.match(repair, /New-Item -ItemType Directory -Force -LiteralPath \$pastaDados/);
  assert.match(repair, /GetEncoding\(28591\)/);
});

test('o reparo limpa o caminho antigo do .env e mantém o resto da configuração', { skip: !repair }, () => {
  assert.match(repair, /-notmatch '\^\\s\*FD_DATA_DIR\\s\*='/);
  assert.match(repair, /WriteAllText\(\$envFile/);
  assert.doesNotMatch(repair, /STORAGE_SIGNING_SECRET=/);
  assert.doesNotMatch(repair, /compose down/);
});