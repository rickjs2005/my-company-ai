// Prévia local (Marco 1): outra origem (porta própria), chave por projeto, só leitura e nada fora da pasta do projeto.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '@milweb-hq/protocol';
import { PreviewServer, previewKey } from '../src/preview.js';
import { viewFile } from '../src/file-view.js';
import { explorerArgs } from '../src/open-external.js';

test('prévia: serve o site do projeto em porta própria; chave errada, "..", junction para fora e pasta de dados ficam de fora', async () => {
  const base = tempDir('hq-preview-');
  const site = path.join(base, 'site'); fs.mkdirSync(path.join(site, 'css'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>Oi</title>');
  fs.writeFileSync(path.join(site, 'css', 'a.css'), 'body{}');
  const secret = path.join(base, 'segredo.txt'); fs.writeFileSync(secret, 'não pode sair');
  const data = path.join(site, 'dados-hq'); fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'token'), 'x');
  fs.symlinkSync(base, path.join(site, 'atalho'), 'junction');
  const empty = path.join(base, 'vazio'); fs.mkdirSync(empty);
  const projects: Project[] = [
    { id: 'p1', name: 'Site', path: site, roomId: 'r', createdAt: 0, lastUsedAt: 0 },
    { id: 'p2', name: 'Vazio', path: empty, roomId: 'r', createdAt: 0, lastUsedAt: 0 },
  ];
  const srv = new PreviewServer({ secret: 'tok', listProjects: () => projects, blockedDirs: [data] });
  try {
    const r = await srv.urlFor(projects[0]);
    assert.ok('url' in r);
    const u = new URL(r.url);
    assert.equal(u.hostname, '127.0.0.1'); assert.notEqual(u.port, '4777');
    assert.equal(u.pathname, `/${previewKey('tok', 'p1')}/index.html`);
    const get = (p: string) => fetch(`${u.origin}${p}`);
    const ok = await get(u.pathname); assert.equal(ok.status, 200); assert.match(ok.headers.get('content-type') ?? '', /text\/html/); assert.match(await ok.text(), /<title>Oi/);
    assert.equal((await get(`/${previewKey('tok', 'p1')}/css/a.css`)).status, 200);
    assert.equal((await get(`/${'0'.repeat(24)}/index.html`)).status, 404, 'chave errada');
    const trav = await get(`/${previewKey('tok', 'p1')}/%2e%2e/segredo.txt`);
    assert.notEqual(trav.status, 200, '".." para fora'); assert.ok(!(await trav.text()).includes('não pode sair'));
    assert.equal((await get(`/${previewKey('tok', 'p1')}/atalho/segredo.txt`)).status, 403, 'junction para fora');
    assert.equal((await get(`/${previewKey('tok', 'p1')}/dados-hq/token`)).status, 403, 'dados da HQ');
    assert.equal((await fetch(`${u.origin}${u.pathname}`, { method: 'POST' })).status, 405, 'só leitura');
    const none = await srv.urlFor(projects[1]);
    assert.ok('error' in none && /index\.html/.test(none.error));
  } finally { await srv.stop(); }
});

test('visualizador: URL de qualquer arquivo de projeto cadastrado, pedido parcial para vídeo, e nada de arquivo inexistente, pasta ou fora', async () => {
  const base = tempDir('hq-viewer-');
  const proj = path.join(base, 'conteudo'); fs.mkdirSync(path.join(proj, 'pecas', 'a b'), { recursive: true });
  const video = path.join(proj, 'pecas', 'a b', 'vídeo final.mp4'); fs.writeFileSync(video, Buffer.from('0123456789'));
  fs.writeFileSync(path.join(proj, 'pecas', 'peca.md'), '# Peça\nLegenda: oi');
  const data = path.join(base, 'dados'); fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'token'), 'x');
  const fora = path.join(base, 'fora.png'); fs.writeFileSync(fora, 'x');
  const projects: Project[] = [{ id: 'c1', name: 'Conteúdo', path: proj, roomId: 'r', createdAt: 0, lastUsedAt: 0 }];
  const srv = new PreviewServer({ secret: 'tok', listProjects: () => projects, blockedDirs: [data] });
  try {
    const { url } = await srv.fileUrl(video);
    const full = await fetch(url); assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'video/mp4'); assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.equal(await full.text(), '0123456789');
    const part = await fetch(url, { headers: { Range: 'bytes=2-5' } }); assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await part.text(), '2345');
    const tail = await fetch(url, { headers: { Range: 'bytes=-3' } }); assert.equal(tail.status, 206); assert.equal(await tail.text(), '789');
    const open = await fetch(url, { headers: { Range: 'bytes=7-' } }); assert.equal(open.status, 206); assert.equal(await open.text(), '789');
    assert.equal((await fetch(url, { headers: { Range: 'bytes=50-60' } })).status, 416);
    await assert.rejects(srv.fileUrl(path.join(proj, 'pecas', 'nao-existe.mp4')), /não existe/);
    await assert.rejects(srv.fileUrl(path.join(proj, 'pecas')), /pasta/);
    await assert.rejects(srv.fileUrl(fora), /fora das pastas/);
    await assert.rejects(srv.fileUrl(path.join(data, 'token')), /dados da HQ/);
    const md = await viewFile(path.join(proj, 'pecas', 'peca.md').replace(/\\/g, '/'), srv);
    assert.equal(md.kind, 'text'); assert.equal(md.text, '# Peça\nLegenda: oi'); assert.equal(md.url, null);
    const v = await viewFile(video, srv);
    assert.equal(v.kind, 'video'); assert.ok(v.url && v.url.startsWith('http://127.0.0.1:')); assert.equal(v.size, 10);
    await assert.rejects(viewFile(path.join(proj, 'citado-mas-nao-gravado.png'), srv), /não existe/);
    await assert.rejects(viewFile('relativo/peca.md', srv), /caminho inválido/);
  } finally { await srv.stop(); }
});

test('abrir fora da HQ: "reveal" seleciona o arquivo na pasta; "file" abre o próprio arquivo; barras normais viram invertidas', () => {
  assert.deepEqual(explorerArgs('reveal', 'C:/Users/chefe/peca.md'), ['/select,C:\\Users\\chefe\\peca.md']);
  assert.deepEqual(explorerArgs('file', 'C:/Users/chefe/video.mp4'), ['C:\\Users\\chefe\\video.mp4']);
  assert.deepEqual(explorerArgs('folder', 'C:\\Users\\chefe\\pecas'), ['C:\\Users\\chefe\\pecas']);
});
