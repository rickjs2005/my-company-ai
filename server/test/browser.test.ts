// Abrir o navegador sem perder o "#token=…": o comando vem do registro e o executável é chamado direto. Registro e disco falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowserCommand, parseOpenCommand } from '../src/browser.mjs';

const URL = 'http://127.0.0.1:4777/#token=abc123';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHOICE = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice';

test('comando do registro vira executável + argumentos com a URL inteira, fragmento incluído', () => {
  assert.deepEqual(parseOpenCommand(`"${EDGE}" --single-argument %1`, URL), { file: EDGE, args: ['--single-argument', URL] });
  assert.deepEqual(parseOpenCommand('"C:\\Firefox\\firefox.exe" -osint -url "%1"', URL), { file: 'C:\\Firefox\\firefox.exe', args: ['-osint', '-url', URL] });
  assert.deepEqual(parseOpenCommand('"%ProgramFiles%\\X\\x.exe" %1 %*', URL, { ProgramFiles: 'C:\\PF' }), { file: 'C:\\PF\\X\\x.exe', args: [URL] });
  assert.deepEqual(parseOpenCommand('"C:\\y.exe"', URL), { file: 'C:\\y.exe', args: [URL] }, 'sem %1: a URL vai no fim');
  assert.equal(parseOpenCommand('', URL), null);
});

test('navegador padrão desinstalado (associação aponta para o Brave, que não existe mais): usa o Edge', () => {
  const reg: Record<string, string> = {
    [`${CHOICE}|ProgId`]: 'BraveHTML',
    'HKCR\\MSEdgeHTM\\shell\\open\\command|': `"${EDGE}" --single-argument %1`,
  };
  const cmd = findBrowserCommand(URL, { readRegistry: (k, v) => reg[`${k}|${v ?? ''}`] ?? null, exists: p => p === EDGE, env: {} });
  assert.deepEqual(cmd, { file: EDGE, args: ['--single-argument', URL] });
});

test('navegador padrão instalado: usa ele; nada encontrado: null (quem chama cai no explorer.exe)', () => {
  const chrome = 'C:\\Chrome\\chrome.exe';
  const reg: Record<string, string> = {
    [`${CHOICE}|ProgId`]: 'ChromeHTML',
    'HKCR\\ChromeHTML\\shell\\open\\command|': `"${chrome}" --single-argument %1`,
    'HKCR\\MSEdgeHTM\\shell\\open\\command|': `"${EDGE}" --single-argument %1`,
  };
  const read = (k: string, v: string | null) => reg[`${k}|${v ?? ''}`] ?? null;
  assert.equal(findBrowserCommand(URL, { readRegistry: read, exists: p => p === chrome || p === EDGE, env: {} })?.file, chrome);
  assert.equal(findBrowserCommand(URL, { readRegistry: () => null, exists: () => false, env: {} }), null);
});
