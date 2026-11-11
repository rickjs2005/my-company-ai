import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileTree, readProjectFile, resolveInside } from '../src/files.js';
import { originAllowed } from '../src/ws.js';
import { loadConfig } from '../src/config.js';

test('resolveInside bloqueia caminhos fora do projeto', () => {
  const dir = tempDir('hq-files-');
  assert.throws(() => resolveInside(dir, '..'), /fora da pasta/);
  assert.throws(() => resolveInside(dir, 'C:\\Windows'), /fora da pasta/);
  assert.equal(resolveInside(dir, 'a/b.txt'), path.join(dir, 'a', 'b.txt'));
});

test('fileTree ignora node_modules e readProjectFile detecta binário e truncamento', () => {
  const dir = tempDir('hq-files-');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  const tree = fileTree(dir, undefined, 2);
  assert.ok(!tree.children!.some(c => c.name === 'node_modules'));
  assert.ok(tree.children!.find(c => c.name === 'src')!.children!.some(c => c.name === 'a.ts'));
  assert.equal(readProjectFile(dir, 'src/a.ts').content, 'export const a = 1;');
  assert.equal(readProjectFile(dir, 'bin.dat').binary, true);
});

test('origem do WebSocket: só loopback na porta do serviço (e Vite em dev)', () => {
  const tmp = tempDir('hq-cfg-');
  const cfg = loadConfig({ dataDir: tmp, port: 4777, webDist: null });
  assert.equal(originAllowed('http://127.0.0.1:4777', cfg), true);
  assert.equal(originAllowed('http://localhost:4777', cfg), true);
  assert.equal(originAllowed('http://evil.example', cfg), false);
  assert.equal(originAllowed('http://127.0.0.1:5173', cfg), cfg.devOrigins.length > 0);
  assert.match(cfg.token, /^[a-f0-9]{64}$/);
});
