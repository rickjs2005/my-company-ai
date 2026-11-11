// Testes dos helpers puros do explorador (rodam em Node, sem DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FsEntry } from '@milweb-hq/protocol';
import {
  absolutePath, affectsDir, basename, breadcrumbs, countLabel, dirname, errorText, extname, fileKind, formatSize, isWithin, joinPath, keyAction, sortEntries, uniqueName,
} from '../src/files/helpers';

const e = (name: string, type: FsEntry['type'] = 'file', extra: Partial<FsEntry> = {}): FsEntry => ({ name, path: name, type, ...extra });

test('sortEntries: pastas antes, nome sem caixa e numérico; data e tamanho invertem só dentro do grupo', () => {
  const list = [e('b.txt', 'file', { size: 10, mtime: 2 }), e('zeta', 'dir'), e('A.txt', 'file', { size: 5, mtime: 3 }), e('alpha', 'dir'), e('arquivo10.txt', 'file', { size: 1, mtime: 1 }), e('arquivo2.txt', 'file', { size: 50, mtime: 9 })];
  assert.deepEqual(sortEntries(list).map(x => x.name), ['alpha', 'zeta', 'A.txt', 'arquivo2.txt', 'arquivo10.txt', 'b.txt']);
  assert.deepEqual(sortEntries(list, 'name', 'desc').map(x => x.name), ['zeta', 'alpha', 'b.txt', 'arquivo10.txt', 'arquivo2.txt', 'A.txt']);
  assert.deepEqual(sortEntries(list, 'size', 'desc').map(x => x.name), ['alpha', 'zeta', 'arquivo2.txt', 'b.txt', 'A.txt', 'arquivo10.txt']);
  assert.deepEqual(sortEntries(list, 'mtime', 'asc').map(x => x.name), ['alpha', 'zeta', 'arquivo10.txt', 'b.txt', 'A.txt', 'arquivo2.txt']);
  assert.equal(list[0].name, 'b.txt', 'não muda a lista original');
});

test('uniqueName gera "nome (2).ext" e pula os que existem', () => {
  const have = new Set(['foto.png', 'foto (2).png', 'pasta', 'pasta (2)', '.env']);
  assert.equal(uniqueName('novo.txt', n => have.has(n)), 'novo.txt');
  assert.equal(uniqueName('foto.png', n => have.has(n)), 'foto (3).png');
  assert.equal(uniqueName('pasta', n => have.has(n), true), 'pasta (3)');
  assert.equal(uniqueName('.env', n => have.has(n)), '.env (2)');
  assert.equal(uniqueName('arquivo.tar.gz', n => n === 'arquivo.tar.gz'), 'arquivo.tar (2).gz');
});

test('breadcrumbs a partir do caminho relativo', () => {
  assert.deepEqual(breadcrumbs('', 'projeto'), [{ name: 'projeto', path: '' }]);
  assert.deepEqual(breadcrumbs('src/panel/dialogs', 'projeto'), [
    { name: 'projeto', path: '' }, { name: 'src', path: 'src' }, { name: 'panel', path: 'src/panel' }, { name: 'dialogs', path: 'src/panel/dialogs' },
  ]);
});

test('caminhos: basename, dirname, joinPath, extname, isWithin, absolutePath', () => {
  assert.equal(basename('a/b/c.txt'), 'c.txt'); assert.equal(basename('c.txt'), 'c.txt');
  assert.equal(dirname('a/b/c.txt'), 'a/b'); assert.equal(dirname('c.txt'), '');
  assert.equal(joinPath('', 'x'), 'x'); assert.equal(joinPath('a', 'b'), 'a/b');
  assert.equal(extname('arquivo.tar.gz'), '.gz'); assert.equal(extname('.gitignore'), ''); assert.equal(extname('sem'), '');
  assert.equal(isWithin('', 'x/y'), true); assert.equal(isWithin('x', 'x/y'), true); assert.equal(isWithin('x', 'x'), true); assert.equal(isWithin('x', 'xy/z'), false);
  assert.equal(absolutePath('C:\\Users\\usuario\\proj', 'src/App.tsx'), 'C:\\Users\\usuario\\proj\\src\\App.tsx');
  assert.equal(absolutePath('C:\\Users\\usuario\\proj\\', ''), 'C:\\Users\\usuario\\proj\\');
  assert.equal(absolutePath('/home/chefe/proj', 'a/b'), '/home/chefe/proj/a/b');
});

test('formatSize em pt-BR e countLabel honesto', () => {
  assert.equal(formatSize(0), '0 B'); assert.equal(formatSize(999), '999 B');
  assert.equal(formatSize(1536), '1,5 KB'); assert.equal(formatSize(10 * 1024), '10 KB');
  assert.equal(formatSize(3.2 * 1024 * 1024), '3,2 MB'); assert.equal(formatSize(null), ''); assert.equal(formatSize(undefined), '');
  assert.equal(countLabel(null), 'quantidade não contada'); assert.equal(countLabel(0), 'vazia'); assert.equal(countLabel(1), '1 item'); assert.equal(countLabel(1200), '1.200 itens');
});

test('fileKind por extensão', () => {
  assert.equal(fileKind({ name: 'x', type: 'dir' }), 'folder');
  assert.equal(fileKind({ name: 'a.png', type: 'file' }), 'image');
  assert.equal(fileKind({ name: 'a.svg', type: 'file' }), 'image');
  assert.equal(fileKind({ name: 'App.TSX', type: 'file' }), 'code');
  assert.equal(fileKind({ name: 'README.md', type: 'file' }), 'markdown');
  assert.equal(fileKind({ name: 'package.json', type: 'file' }), 'data');
  assert.equal(fileKind({ name: 'a.zip', type: 'file' }), 'archive');
  assert.equal(fileKind({ name: 'a.mp4', type: 'file' }), 'media');
  assert.equal(fileKind({ name: 'LICENSE', type: 'file' }), 'text');
  assert.equal(fileKind({ name: 'a.exe', type: 'file' }), 'binary');
  assert.equal(fileKind({ name: 'atalho', type: 'symlink' }), 'symlink');
});

test('mapeamento de teclado', () => {
  assert.equal(keyAction({ key: 'ArrowDown' }), 'down');
  assert.equal(keyAction({ key: 'ArrowUp' }), 'up');
  assert.equal(keyAction({ key: 'Enter' }), 'open');
  assert.equal(keyAction({ key: 'Backspace' }), 'parent');
  assert.equal(keyAction({ key: 'F2' }), 'rename');
  assert.equal(keyAction({ key: 'Delete' }), 'trash');
  assert.equal(keyAction({ key: 'Escape' }), 'escape');
  assert.equal(keyAction({ key: 'n', altKey: true }), 'new-file');
  assert.equal(keyAction({ key: 'N', altKey: true, shiftKey: true }), 'new-folder');
  assert.equal(keyAction({ key: 'n', ctrlKey: true }), null, 'Ctrl+N fica com o navegador');
  assert.equal(keyAction({ key: 'c', ctrlKey: true }), 'copy');
  assert.equal(keyAction({ key: 'x', ctrlKey: true }), 'cut');
  assert.equal(keyAction({ key: 'v', ctrlKey: true }), 'paste');
  assert.equal(keyAction({ key: 'a', ctrlKey: true }), 'select-all');
  assert.equal(keyAction({ key: 'ContextMenu' }), 'menu');
  assert.equal(keyAction({ key: 'F10', shiftKey: true }), 'menu');
  assert.equal(keyAction({ key: 'F10' }), null);
  assert.equal(keyAction({ key: 'F5' }), 'refresh');
  assert.equal(keyAction({ key: 'x' }), null);
});

test('errorText usa a mensagem do servidor e cai no código', () => {
  assert.equal(errorText({ message: 'já existe "a" no destino', code: 'exists' }), 'já existe "a" no destino');
  assert.equal(errorText({ code: 'in_use' }), 'há execuções da HQ usando este caminho');
  assert.equal(errorText(undefined), 'falha desconhecida');
});

test('affectsDir decide se um fs.changed toca a pasta aberta', () => {
  assert.equal(affectsDir([], 'src'), true, 'lista vazia = recarregar tudo');
  assert.equal(affectsDir(['src/App.tsx'], 'src'), true);
  assert.equal(affectsDir(['src\\App.tsx'], 'src'), true);
  assert.equal(affectsDir(['src'], ''), true, 'a própria pasta foi criada/renomeada na raiz');
  assert.equal(affectsDir(['src'], 'src'), true);
  assert.equal(affectsDir(['src'], 'src/panel'), true, 'ancestral mudou (pode ter sido renomeado)');
  assert.equal(affectsDir(['docs/a.md'], 'src'), false);
});
