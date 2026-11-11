// Testes do explorador de arquivos e da lixeira, em disco real (pasta temporária) e banco em memória.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FsInUse, ServerMessage, Session, TrashItem, FsListResult, FsBatchResult, FsEntry, FsReadResult, FsWriteResult, Folder } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { createFsService, type FsService } from '../src/fs/index.js';
import { isFsError } from '../src/fs/errors.js';
import type { Config } from '../src/config.js';

const noop = { info: () => {}, warn: () => {}, error: () => {} };

interface Env { svc: FsService; store: Store; rootId: string; root: string; dataDir: string; sent: ServerMessage[]; sessions: Session[]; config: Config; dbFile: string; base: string }

function makeEnv(opts: { dbFile?: string } = {}): Env {
  const base = tempDir('hq-fs-');
  const root = path.join(base, 'raiz'); fs.mkdirSync(root);
  const dataDir = path.join(base, 'dados'); fs.mkdirSync(dataDir);
  const installDir = path.join(base, 'hq-install'); fs.mkdirSync(installDir);
  const dbFile = opts.dbFile ?? ':memory:';
  const db = openDb(dbFile);
  const store = new Store(db);
  const folder = store.addFolder({ name: 'raiz', path: root });
  const config = { dataDir, trashDir: path.join(dataDir, 'trash'), backupsDir: path.join(dataDir, 'backups'), installDir, attachmentsDir: path.join(dataDir, 'attachments'), logsDir: path.join(dataDir, 'logs'), dbFile, host: '127.0.0.1', port: 0, token: 'x', webDist: null, devOrigins: [], version: 't' } as Config;
  const sent: ServerMessage[] = [];
  const sessions: Session[] = [];
  const svc = createFsService({ store, config, manager: { listSessions: () => sessions }, broadcast: m => sent.push(m), log: noop });
  return { svc, store, rootId: `folder:${folder.id}`, root, dataDir, sent, sessions, config, dbFile, base };
}

const client = {};
const call = <T>(env: Env, msg: Record<string, unknown>) => env.svc.handle({ reqId: 'r', ...msg } as never, client) as Promise<T>;
async function expectCode(p: Promise<unknown>, code: string): Promise<unknown> {
  try { await p; } catch (err) { assert.ok(isFsError(err), `esperava FsError, veio ${String(err)}`); assert.equal(err.code, code, `código ${err.code} (${err.message})`); return err.data; }
  assert.fail(`esperava erro ${code}`);
}
const write = (env: Env, rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(env.root, rel)), { recursive: true }); fs.writeFileSync(path.join(env.root, rel), content); };

test('fs.roots e fs.list: pastas antes, ordem sem caixa, childCount quando barato', async () => {
  const env = makeEnv();
  write(env, 'b.txt', 'b'); write(env, 'A.txt', 'a'); fs.mkdirSync(path.join(env.root, 'zeta')); fs.mkdirSync(path.join(env.root, 'alpha')); write(env, 'alpha/x.txt', 'x');
  const roots = await call<{ id: string }[]>(env, { type: 'fs.roots' });
  assert.deepEqual(roots.map(r => r.id), [env.rootId]);
  const list = await call<FsListResult>(env, { type: 'fs.list', rootId: env.rootId, path: '' });
  assert.deepEqual(list.entries.map(e => e.name), ['alpha', 'zeta', 'A.txt', 'b.txt']);
  assert.equal(list.entries[0].childCount, 1);
  assert.equal(list.entries[1].childCount, 0);
  assert.equal(list.entries[3].size, 1);
  assert.equal(list.truncated, false);
  const sub = await call<FsListResult>(env, { type: 'fs.list', rootId: env.rootId, path: 'alpha/' });
  assert.equal(sub.path, 'alpha'); assert.equal(sub.entries[0].path, 'alpha/x.txt');
  await expectCode(call(env, { type: 'fs.list', rootId: 'folder:nao-existe', path: '' }), 'not_found');
});

test('fs.create cria arquivo e pasta; repetir dá exists; fs.read lê texto, imagem e binário', async () => {
  const env = makeEnv();
  const f = await call<FsEntry>(env, { type: 'fs.create', rootId: env.rootId, path: 'novo.txt', kind: 'file' });
  assert.equal(f.type, 'file'); assert.equal(fs.readFileSync(path.join(env.root, 'novo.txt'), 'utf8'), '');
  const d = await call<FsEntry>(env, { type: 'fs.create', rootId: env.rootId, path: 'pasta', kind: 'dir' });
  assert.equal(d.type, 'dir'); assert.ok(fs.statSync(path.join(env.root, 'pasta')).isDirectory());
  await expectCode(call(env, { type: 'fs.create', rootId: env.rootId, path: 'novo.txt', kind: 'file' }), 'exists');
  await expectCode(call(env, { type: 'fs.create', rootId: env.rootId, path: 'pasta', kind: 'dir' }), 'exists');
  await expectCode(call(env, { type: 'fs.create', rootId: env.rootId, path: 'con.txt', kind: 'file' }), 'invalid_name');
  write(env, 'texto.md', 'olá # título');
  write(env, 'img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]).toString('latin1'));
  fs.writeFileSync(path.join(env.root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  fs.writeFileSync(path.join(env.root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  const t = await call<FsReadResult>(env, { type: 'fs.read', rootId: env.rootId, path: 'texto.md' });
  assert.equal(t.encoding, 'utf8'); assert.equal(t.content, 'olá # título'); assert.equal(t.mediaType, 'text/markdown'); assert.equal(t.binary, false);
  const i = await call<FsReadResult>(env, { type: 'fs.read', rootId: env.rootId, path: 'img.png' });
  assert.equal(i.encoding, 'base64'); assert.equal(i.mediaType, 'image/png'); assert.equal(Buffer.from(i.content, 'base64')[0], 0x89);
  const b = await call<FsReadResult>(env, { type: 'fs.read', rootId: env.rootId, path: 'bin.dat' });
  assert.equal(b.encoding, 'none'); assert.equal(b.binary, true);
  await expectCode(call(env, { type: 'fs.read', rootId: env.rootId, path: 'nada.txt' }), 'not_found');
});

test('fs.rename: mesma pasta, conflito exists, mudança só de caixa permitida', async () => {
  const env = makeEnv();
  write(env, 'a.txt', 'a'); write(env, 'b.txt', 'b');
  const r = await call<FsEntry>(env, { type: 'fs.rename', rootId: env.rootId, path: 'a.txt', newName: 'c.txt' });
  assert.equal(r.path, 'c.txt'); assert.ok(fs.existsSync(path.join(env.root, 'c.txt')));
  await expectCode(call(env, { type: 'fs.rename', rootId: env.rootId, path: 'c.txt', newName: 'b.txt' }), 'exists');
  const up = await call<FsEntry>(env, { type: 'fs.rename', rootId: env.rootId, path: 'c.txt', newName: 'C.txt' });
  assert.equal(up.name, 'C.txt'); assert.ok(fs.readdirSync(env.root).includes('C.txt'));
  await expectCode(call(env, { type: 'fs.rename', rootId: env.rootId, path: 'C.txt', newName: 'x/y' }), 'invalid_name');
  await expectCode(call(env, { type: 'fs.rename', rootId: env.rootId, path: 'sumiu.txt', newName: 'z' }), 'not_found');
});

test('fs.move e fs.copy com as políticas fail, rename e overwrite', async () => {
  const env = makeEnv();
  write(env, 'src/a.txt', 'A'); write(env, 'src/b.txt', 'B'); write(env, 'dest/a.txt', 'velho'); fs.mkdirSync(path.join(env.root, 'src/sub')); write(env, 'src/sub/deep.txt', 'D');
  const fail = await call<FsBatchResult>(env, { type: 'fs.copy', rootId: env.rootId, paths: ['src/a.txt', 'src/b.txt'], targetRootId: env.rootId, targetDir: 'dest' });
  assert.deepEqual(fail.done, [{ from: 'src/b.txt', to: 'dest/b.txt' }]);
  assert.equal(fail.errors[0].code, 'exists'); assert.equal(fail.errors[0].path, 'dest/a.txt');
  assert.equal(fs.readFileSync(path.join(env.root, 'dest/a.txt'), 'utf8'), 'velho');
  const ren = await call<FsBatchResult>(env, { type: 'fs.copy', rootId: env.rootId, paths: ['src/a.txt'], targetRootId: env.rootId, targetDir: 'dest', onConflict: 'rename' });
  assert.deepEqual(ren.done, [{ from: 'src/a.txt', to: 'dest/a (2).txt' }]); assert.equal(ren.errors.length, 0);
  assert.equal(fs.readFileSync(path.join(env.root, 'dest/a (2).txt'), 'utf8'), 'A');
  const over = await call<FsBatchResult>(env, { type: 'fs.move', rootId: env.rootId, paths: ['src/a.txt'], targetRootId: env.rootId, targetDir: 'dest', onConflict: 'overwrite' });
  assert.equal(over.errors.length, 0); assert.equal(fs.readFileSync(path.join(env.root, 'dest/a.txt'), 'utf8'), 'A'); assert.ok(!fs.existsSync(path.join(env.root, 'src/a.txt')));
  // pasta inteira copiada e depois movida
  const cp = await call<FsBatchResult>(env, { type: 'fs.copy', rootId: env.rootId, paths: ['src'], targetRootId: env.rootId, targetDir: 'dest' });
  assert.equal(cp.errors.length, 0); assert.equal(fs.readFileSync(path.join(env.root, 'dest/src/sub/deep.txt'), 'utf8'), 'D');
  const mv = await call<FsBatchResult>(env, { type: 'fs.move', rootId: env.rootId, paths: ['src'], targetRootId: env.rootId, targetDir: 'dest', onConflict: 'rename' });
  assert.deepEqual(mv.done, [{ from: 'src', to: 'dest/src (2)' }]); assert.ok(!fs.existsSync(path.join(env.root, 'src')));
  // destino inexistente
  await expectCode(call(env, { type: 'fs.move', rootId: env.rootId, paths: ['dest/b.txt'], targetRootId: env.rootId, targetDir: 'nao-existe' }), 'not_found');
});

test('mover uma pasta para dentro dela mesma falha', async () => {
  const env = makeEnv();
  fs.mkdirSync(path.join(env.root, 'p/filha'), { recursive: true });
  const r = await call<FsBatchResult>(env, { type: 'fs.move', rootId: env.rootId, paths: ['p'], targetRootId: env.rootId, targetDir: 'p/filha' });
  assert.equal(r.done.length, 0); assert.equal(r.errors[0].code, 'io'); assert.match(r.errors[0].message, /dentro dela mesma/);
  const same = await call<FsBatchResult>(env, { type: 'fs.move', rootId: env.rootId, paths: ['p'], targetRootId: env.rootId, targetDir: 'p' });
  assert.equal(same.errors[0].code, 'io');
});

test('fs.write grava por arquivo temporário e detecta conflito de mtime', async () => {
  const env = makeEnv();
  write(env, 'doc.txt', 'v1');
  const r1 = await call<FsReadResult>(env, { type: 'fs.read', rootId: env.rootId, path: 'doc.txt' });
  const w = await call<FsWriteResult>(env, { type: 'fs.write', rootId: env.rootId, path: 'doc.txt', content: 'v2', expectedMtime: r1.mtime });
  assert.equal(fs.readFileSync(path.join(env.root, 'doc.txt'), 'utf8'), 'v2'); assert.equal(w.size, 2);
  // mtime desatualizado (o da primeira leitura) → conflict
  const old = new Date(Date.now() - 60_000); fs.utimesSync(path.join(env.root, 'doc.txt'), old, old);
  await expectCode(call(env, { type: 'fs.write', rootId: env.rootId, path: 'doc.txt', content: 'v3', expectedMtime: w.mtime }), 'conflict');
  assert.equal(fs.readFileSync(path.join(env.root, 'doc.txt'), 'utf8'), 'v2');
  // sem expectedMtime grava; arquivo novo também
  await call(env, { type: 'fs.write', rootId: env.rootId, path: 'doc.txt', content: 'v3', expectedMtime: null });
  await call(env, { type: 'fs.write', rootId: env.rootId, path: 'novo.txt', content: 'x' });
  assert.equal(fs.readFileSync(path.join(env.root, 'doc.txt'), 'utf8'), 'v3');
  assert.ok(!fs.readdirSync(env.root).some(n => n.includes('.hq-')), 'nenhum temporário ficou para trás');
});

test('lixeira: arquivo vai e volta com conteúdo idêntico; broadcast trash.changed', async () => {
  const env = makeEnv();
  write(env, 'docs/relatorio.txt', 'conteúdo importante');
  const r = await call<{ items: TrashItem[]; errors: unknown[] }>(env, { type: 'fs.trash', rootId: env.rootId, paths: ['docs/relatorio.txt'] });
  assert.equal(r.errors.length, 0); assert.equal(r.items[0].kind, 'file'); assert.equal(r.items[0].size, Buffer.byteLength('conteúdo importante'));
  assert.ok(!fs.existsSync(path.join(env.root, 'docs/relatorio.txt')));
  assert.ok(env.sent.some(m => m.kind === 'trash.changed'));
  const list = await call<TrashItem[]>(env, { type: 'trash.list' });
  assert.equal(list.length, 1); assert.equal(list[0].originPath, path.join(env.root, 'docs', 'relatorio.txt')); assert.equal(list[0].rootId, env.rootId);
  fs.rmSync(path.join(env.root, 'docs'), { recursive: true }); // pasta-mãe sumiu: restore recria
  const res = await call<{ restoredTo: string }>(env, { type: 'trash.restore', id: list[0].id });
  assert.equal(res.restoredTo, list[0].originPath);
  assert.equal(fs.readFileSync(res.restoredTo, 'utf8'), 'conteúdo importante');
  assert.equal((await call<TrashItem[]>(env, { type: 'trash.list' })).length, 0);
  assert.equal(fs.readdirSync(env.config.trashDir).length, 0, 'pasta do id removida');
});

test('lixeira: pasta com subpastas vai e volta inteira; restore com destino existente (fail/rename); delete definitivo', async () => {
  const env = makeEnv();
  write(env, 'proj/a.txt', 'a'); write(env, 'proj/sub/b.txt', 'bb'); write(env, 'proj/sub/deep/c.txt', 'ccc');
  const r = await call<{ items: TrashItem[]; errors: unknown[] }>(env, { type: 'fs.trash', rootId: env.rootId, paths: ['proj'] });
  assert.equal(r.items[0].kind, 'dir'); assert.equal(r.items[0].count, 5); assert.equal(r.items[0].size, 6);
  assert.ok(!fs.existsSync(path.join(env.root, 'proj')));
  // alguém criou outra 'proj' no lugar
  fs.mkdirSync(path.join(env.root, 'proj')); write(env, 'proj/outro.txt', 'o');
  await expectCode(call(env, { type: 'trash.restore', id: r.items[0].id }), 'exists');
  const res = await call<{ restoredTo: string }>(env, { type: 'trash.restore', id: r.items[0].id, onConflict: 'rename' });
  assert.equal(path.basename(res.restoredTo), 'proj (restaurado)');
  assert.equal(fs.readFileSync(path.join(res.restoredTo, 'sub/deep/c.txt'), 'utf8'), 'ccc');
  assert.equal(fs.readFileSync(path.join(env.root, 'proj/outro.txt'), 'utf8'), 'o');
  // delete definitivo
  const r2 = await call<{ items: TrashItem[] }>(env, { type: 'fs.trash', rootId: env.rootId, paths: ['proj'] });
  assert.equal(await call(env, { type: 'trash.delete', id: r2.items[0].id }), true);
  assert.equal((await call<TrashItem[]>(env, { type: 'trash.list' })).length, 0);
  assert.equal(fs.readdirSync(env.config.trashDir).length, 0);
  await expectCode(call(env, { type: 'trash.delete', id: r2.items[0].id }), 'not_found');
  await expectCode(call(env, { type: 'trash.restore', id: 'inexistente' }), 'not_found');
  // esvaziar
  write(env, 'x1.txt', '1'); write(env, 'x2.txt', '2');
  await call(env, { type: 'fs.trash', rootId: env.rootId, paths: ['x1.txt', 'x2.txt'] });
  assert.equal(await call(env, { type: 'trash.empty' }), true);
  assert.equal((await call<TrashItem[]>(env, { type: 'trash.list' })).length, 0);
});

test('escapar da raiz: "..", absoluto, nome com ":" e junction para fora → outside_root/invalid_name/symlink', async () => {
  const env = makeEnv();
  await expectCode(call(env, { type: 'fs.list', rootId: env.rootId, path: '../' }), 'outside_root');
  await expectCode(call(env, { type: 'fs.list', rootId: env.rootId, path: 'a/../../b' }), 'outside_root');
  await expectCode(call(env, { type: 'fs.list', rootId: env.rootId, path: 'C:\\Windows' }), 'outside_root');
  await expectCode(call(env, { type: 'fs.list', rootId: env.rootId, path: '/etc' }), 'outside_root');
  await expectCode(call(env, { type: 'fs.create', rootId: env.rootId, path: 'C:x.txt', kind: 'file' }), 'outside_root');
  await expectCode(call(env, { type: 'fs.create', rootId: env.rootId, path: 'a:b.txt', kind: 'file' }), 'outside_root');
  await expectCode(call(env, { type: 'fs.create', rootId: env.rootId, path: 'ab:c.txt', kind: 'file' }), 'invalid_name');
  await expectCode(call(env, { type: 'fs.create', rootId: env.rootId, path: 'fim. ', kind: 'file' }), 'invalid_name');
  // junction apontando para fora da raiz
  const outside = path.join(env.base, 'fora'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'segredo.txt'), 's');
  fs.symlinkSync(outside, path.join(env.root, 'atalho'), 'junction');
  await expectCode(call(env, { type: 'fs.list', rootId: env.rootId, path: 'atalho' }), 'symlink');
  await expectCode(call(env, { type: 'fs.read', rootId: env.rootId, path: 'atalho/segredo.txt' }), 'symlink');
  const batch = await call<{ items: unknown[]; errors: { code: string }[] }>(env, { type: 'fs.trash', rootId: env.rootId, paths: ['atalho/segredo.txt'] });
  assert.equal(batch.items.length, 0); assert.equal(batch.errors[0].code, 'symlink');
  assert.ok(fs.existsSync(path.join(outside, 'segredo.txt')), 'o arquivo fora da raiz não foi tocado');
  // o link em si aparece na listagem como symlink, sem ser seguido
  const list = await call<FsListResult>(env, { type: 'fs.list', rootId: env.rootId, path: '' });
  assert.equal(list.entries.find(e => e.name === 'atalho')?.type, 'symlink');
});

test('caminho protegido (dataDir dentro da raiz) → protected; raiz que é junction → outside_root', async () => {
  const env = makeEnv();
  // raiz extra que engloba o dataDir
  const wide = env.store.addFolder({ name: 'base', path: env.base });
  const wideId = `folder:${wide.id}`;
  await expectCode(call(env, { type: 'fs.list', rootId: wideId, path: 'dados' }), 'protected');
  await expectCode(call(env, { type: 'fs.create', rootId: wideId, path: 'dados/x.txt', kind: 'file' }), 'protected');
  // pasta de instalação: dá para ver (costuma ser também um projeto), mas não para alterar
  const inst = await call<FsListResult>(env, { type: 'fs.list', rootId: wideId, path: 'hq-install' });
  assert.ok(Array.isArray(inst.entries));
  await expectCode(call(env, { type: 'fs.create', rootId: wideId, path: 'hq-install/x.txt', kind: 'file' }), 'protected');
  await expectCode(call(env, { type: 'fs.rename', rootId: wideId, path: 'hq-install', newName: 'outro' }), 'protected');
  const t = await call<{ errors: { code: string }[] }>(env, { type: 'fs.trash', rootId: wideId, paths: ['dados'], force: true });
  assert.equal(t.errors[0].code, 'protected');
  // listar a raiz larga (que contém pastas protegidas) continua permitido para leitura
  const l = await call<FsListResult>(env, { type: 'fs.list', rootId: wideId, path: '' });
  assert.ok(l.entries.some(e => e.name === 'dados'));
  // raiz cadastrada como junction
  const link = path.join(env.base, 'link-raiz'); fs.symlinkSync(env.root, link, 'junction');
  const lf = env.store.addFolder({ name: 'link', path: link });
  await expectCode(call(env, { type: 'fs.list', rootId: `folder:${lf.id}`, path: '' }), 'outside_root');
});

test('inUse detecta sessão com processo vivo; fs.trash sem force falha com in_use e com force passa', async () => {
  const env = makeEnv();
  const projDir = path.join(env.root, 'cliente-site'); fs.mkdirSync(projDir); fs.writeFileSync(path.join(projDir, 'index.html'), '<p>x</p>');
  const room = env.store.listRooms()[0] ?? env.store.createRoom({ slug: 'dev', name: 'Dev', kind: 'dev', color: '#fff', instructions: '', profiles: [] });
  const project = env.store.createProject({ name: 'Site do cliente', path: projDir, roomId: room.id });
  const emp = env.store.createEmployee({ name: 'Léo', role: 'Dev', roomId: room.id, appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0 });
  const s = env.store.createSession({ roomId: room.id, projectId: project.id, employeeId: emp.id, name: 'sessão', permissionMode: 'default', workerName: 'Léo', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0 });
  env.sessions.push({ ...s, processState: { alive: true } as never });
  const inUse = await call<FsInUse[]>(env, { type: 'fs.inUse', rootId: env.rootId, paths: ['cliente-site', 'outra'] });
  assert.equal(inUse.length, 1); assert.equal(inUse[0].path, 'cliente-site');
  assert.deepEqual(inUse[0].sessions[0], { sessionId: s.id, employeeId: emp.id, employeeName: 'Léo', projectName: 'Site do cliente', taskStatus: null, processAlive: true });
  // a raiz inteira também cobre o projeto
  assert.equal((await call<FsInUse[]>(env, { type: 'fs.inUse', rootId: env.rootId, paths: [''] })).length, 1);
  // arquivo dentro do projeto não conta (regra: projeto dentro/igual ao caminho)
  assert.equal((await call<FsInUse[]>(env, { type: 'fs.inUse', rootId: env.rootId, paths: ['cliente-site/index.html'] })).length, 0);
  const data = await expectCode(call(env, { type: 'fs.trash', rootId: env.rootId, paths: ['cliente-site'] }), 'in_use') as FsInUse[];
  assert.equal(data[0].sessions[0].sessionId, s.id);
  assert.ok(fs.existsSync(projDir));
  await expectCode(call(env, { type: 'fs.move', rootId: env.rootId, paths: ['cliente-site'], targetRootId: env.rootId, targetDir: '' }), 'in_use');
  const r = await call<{ items: TrashItem[]; errors: unknown[] }>(env, { type: 'fs.trash', rootId: env.rootId, paths: ['cliente-site'], force: true });
  assert.equal(r.errors.length, 0); assert.ok(!fs.existsSync(projDir));
  // sem processo mas com tarefa em andamento também conta
  env.sessions[0] = { ...s, processState: null };
  env.store.createTask({ clientId: null, sessionId: s.id, projectId: project.id, roomId: room.id, prompt: 'x', attachments: [], mode: 'send' });
  await call(env, { type: 'trash.restore', id: r.items[0].id });
  const again = await call<FsInUse[]>(env, { type: 'fs.inUse', rootId: env.rootId, paths: ['cliente-site'] });
  assert.equal(again[0].sessions[0].taskStatus, 'queued'); assert.equal(again[0].sessions[0].processAlive, false);
  // raiz inteira sem force exige confirmação mesmo sem dependentes
  env.sessions.length = 0; env.store.updateTask(env.store.listTasks()[0].id, { status: 'done' });
  await expectCode(call(env, { type: 'fs.trash', rootId: env.rootId, paths: [''] }), 'in_use');
});

test('a lixeira persiste: reabrir o Store sobre o mesmo SQLite lista o item e restaura', async () => {
  const base = tempDir('hq-fs-db-');
  const dbFile = path.join(base, 'hq.sqlite');
  const env = makeEnv({ dbFile });
  write(env, 'persistente.txt', 'fica');
  const r = await call<{ items: TrashItem[] }>(env, { type: 'fs.trash', rootId: env.rootId, paths: ['persistente.txt'] });
  env.store.db.close();
  const db2 = openDb(dbFile); const store2 = new Store(db2);
  const svc2 = createFsService({ store: store2, config: env.config, manager: { listSessions: () => [] }, broadcast: () => {}, log: noop });
  const list = await svc2.handle({ type: 'trash.list', reqId: '1' }, client) as TrashItem[];
  assert.equal(list.length, 1); assert.equal(list[0].id, r.items[0].id);
  const res = await svc2.handle({ type: 'trash.restore', reqId: '2', id: list[0].id }, client) as { restoredTo: string };
  assert.equal(fs.readFileSync(res.restoredTo, 'utf8'), 'fica');
  // registro cujo conteúdo sumiu do disco é limpo na varredura inicial
  write(env, 'some.txt', 's');
  const r2 = await svc2.handle({ type: 'fs.trash', reqId: '3', rootId: env.rootId, paths: ['some.txt'] }, client) as { items: TrashItem[] };
  fs.rmSync(path.join(env.config.trashDir, r2.items[0].id), { recursive: true, force: true });
  db2.close();
  const warns: string[] = [];
  const db3 = openDb(dbFile);
  const svc3 = createFsService({ store: new Store(db3), config: env.config, manager: { listSessions: () => [] }, broadcast: () => {}, log: { ...noop, warn: (...a) => warns.push(String(a[0])) } });
  assert.equal((await svc3.handle({ type: 'trash.list', reqId: '4' }, client) as TrashItem[]).length, 0);
  assert.ok(warns.some(w => w.includes('sumiu')));
  db3.close();
});

test('folder.add: duplicada, inexistente, arquivo, protegida e dentro de raiz existente falham; folder.remove só tira do cadastro', async () => {
  const env = makeEnv();
  const extra = path.join(env.base, 'extra'); fs.mkdirSync(extra); fs.writeFileSync(path.join(extra, 'f.txt'), 'f');
  const f = await call<Folder>(env, { type: 'folder.add', path: extra });
  assert.equal(f.name, 'extra'); assert.equal(f.path, extra);
  assert.ok(env.sent.some(m => m.kind === 'entity' && m.entity === 'folder' && m.op === 'upsert'));
  await expectCode(call(env, { type: 'folder.add', path: extra.toUpperCase() }), 'exists');
  await expectCode(call(env, { type: 'folder.add', path: path.join(env.base, 'nao-existe') }), 'not_found');
  await expectCode(call(env, { type: 'folder.add', path: path.join(extra, 'f.txt') }), 'invalid_name');
  await expectCode(call(env, { type: 'folder.add', path: env.dataDir }), 'protected');
  await expectCode(call(env, { type: 'folder.add', path: path.join(env.config.installDir) }), 'protected');
  fs.mkdirSync(path.join(env.root, 'interna'));
  await expectCode(call(env, { type: 'folder.add', path: path.join(env.root, 'interna') }), 'exists');
  await env.svc.handle({ type: 'folder.remove', id: f.id }, client);
  assert.equal(env.store.getFolder(f.id), null);
  assert.ok(fs.existsSync(path.join(extra, 'f.txt')), 'o disco não foi tocado');
  // o aviso 'entity folder delete' é responsabilidade do ws.ts (evita broadcast duplicado)
  assert.ok(!env.sent.some(m => m.kind === 'entity' && m.entity === 'folder' && m.op === 'delete'));
});

test('fs.search ignora node_modules e respeita o limite; fs.watch avisa mudanças e desliga no onClientClose', async () => {
  const env = makeEnv();
  write(env, 'src/Alpha.ts', ''); write(env, 'src/beta/alpha-two.ts', ''); write(env, 'node_modules/alpha/index.js', ''); write(env, 'gamma.ts', '');
  const r = await call<FsEntry[]>(env, { type: 'fs.search', rootId: env.rootId, query: 'ALPHA' });
  assert.deepEqual(r.map(e => e.path).sort(), ['src/Alpha.ts', 'src/beta/alpha-two.ts']);
  assert.equal((await call<FsEntry[]>(env, { type: 'fs.search', rootId: env.rootId, query: 'a', limit: 1 })).length, 1);
  const c1 = {};
  await env.svc.handle({ type: 'fs.watch', rootId: env.rootId, subscribe: true }, c1);
  assert.deepEqual(env.svc.watcher.active(), [env.rootId]);
  env.sent.length = 0;
  write(env, 'src/novo.txt', 'n');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !env.sent.some(m => m.kind === 'fs.changed')) await new Promise(r => setTimeout(r, 50));
  const ev = env.sent.find(m => m.kind === 'fs.changed') as { rootId: string; paths: string[] } | undefined;
  assert.ok(ev, 'fs.changed chegou'); assert.equal(ev.rootId, env.rootId);
  assert.ok(ev.paths.length === 0 || ev.paths.some(p => p.startsWith('src')), JSON.stringify(ev.paths));
  env.svc.onClientClose(c1);
  assert.deepEqual(env.svc.watcher.active(), []);
  env.svc.close();
});
