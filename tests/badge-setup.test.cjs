const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const load = Module._load;
Module._load = function(name, ...args) { return name === 'electron' ? {} : load.call(this, name, ...args); };
const badge = require('../badge-setup');
Module._load = load;

test('lê as marcas na ordem em que o Windows as carrega', () => {
  const output = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers\\ EnhancedStorageData',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers\\ FortesDrive Synced',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers\\ FortesDrive Pending',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers\\ Offline Files',
  ].join('\r\n');
  assert.deepEqual(badge.parseOverlayNames(output), [
    ' EnhancedStorageData', ' FortesDrive Synced', ' FortesDrive Pending', ' Offline Files',
  ]);
});

test('lê o valor REG_SZ da consulta do registro', () => {
  const output = 'HKEY_CURRENT_USER\\Software\\FortesDrive\r\n    SyncRoot    REG_SZ    C:\\FortesDrive\r\n';
  assert.equal(badge.parseRegValue(output), 'C:\\FortesDrive');
});

test('monta o registro das quatro marcas apontando para o DLL instalado', () => {
  const dll = 'C:\\Program Files\\FortesDrive\\resources\\shell\\FortesDriveOverlays.dll';
  const lines = badge.registerCommands(dll);
  assert.equal(lines.length, 20);
  assert.equal(lines.every(line => line.startsWith('reg add ')), true);
  for (const label of ['Synced', 'Pending', 'Error', 'Locked']) {
    assert.equal(lines.some(line => line.includes(`ShellIconOverlayIdentifiers\\ FortesDrive ${label}`)), true);
  }
  assert.equal(lines.filter(line => line.includes(dll)).length, 4);
});

test('o registro real é lido no Windows', { skip: process.platform !== 'win32' }, async () => {
  const setup = await badge.readBadgeSetup();
  assert.equal(setup.supported, true);
  assert.equal(typeof setup.complete, 'boolean');
  assert.equal(typeof setup.loaded, 'boolean');
});