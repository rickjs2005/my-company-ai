// Equipes da Social Media (08/11): o canal decide a equipe da tarefa, quem é da outra equipe não executa, o executor recebe o
// contexto da equipe e cada pessoa tem assento persistente e único dentro da equipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import { tempDir } from './tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.resolve(here, '..', '..', 'packages', 'claude-bridge', 'test', 'fake-claude.mjs');

function setup() {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.seedDefaultRooms();
  const dir = tempDir('hq-equipes-');
  const social = store.listRooms().find(r => r.kind === 'social')!;
  const proj = store.createProject({ name: 'Conteúdo', path: dir, roomId: social.id });
  const manager = new SessionManager({ store, exePath: () => process.execPath, attachmentsDir: tempDir('hq-att-'), commandPrefixArgs: [fakeClaude] });
  const waitTask = (id: string) => new Promise<Task>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const t = store.getTask(id);
      if (t && ['done', 'error', 'lost', 'interrupted'].includes(t.status)) return resolve(t);
      if (Date.now() - t0 > 8000) return reject(new Error('tempo esgotado'));
      setTimeout(tick, 50);
    };
    tick();
  });
  return { store, manager, social, proj, waitTask, cleanup: async () => { await manager.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('Threads Aurora vai para a Equipe Aurora; quem é do Tuco Dev não executa; especialista de apoio executa com o perfil da Aurora', async () => {
  const s = setup();
  try {
    const bia = s.manager.createEmployee({ roomId: s.social.id, name: 'Bia', profileId: 'aurora', template: 'conteudo-criador' });
    const nina = s.manager.createEmployee({ roomId: s.social.id, name: 'Nina', profileId: 'tuco-dev', template: 'conteudo-criador' });
    const otto = s.manager.createEmployee({ roomId: s.social.id, name: 'Otto', template: 'conteudo-revisor' });
    await assert.rejects(s.manager.runTask({ reqId: 'r', clientId: 'x1', text: 'post do Threads', projectId: s.proj.id, employeeId: nina.id, skill: null, plan: false, destinationId: 'threads' }), /Nina é da Equipe Tuco Dev; Threads Aurora é da Equipe Aurora/);
    const r = await s.manager.runTask({ reqId: 'r', clientId: 'x2', text: 'post do Threads', projectId: s.proj.id, employeeId: bia.id, skill: null, plan: false, destinationId: 'threads' });
    assert.equal(s.store.getTask(r.taskId)!.profileId, 'aurora', 'a tarefa grava a equipe do canal');
    assert.equal((await s.waitTask(r.taskId)).status, 'done');
    const r2 = await s.manager.runTask({ reqId: 'r', clientId: 'x3', text: 'revisar o post do Threads', projectId: s.proj.id, employeeId: otto.id, skill: null, plan: false, destinationId: 'threads' });
    assert.equal(s.store.getTask(r2.taskId)!.profileId, 'aurora', 'especialista de apoio trabalha com o perfil da equipe do canal');
    await s.waitTask(r2.taskId);
    // perfil escolhido diferente do canal é recusado (não mistura contexto)
    await assert.rejects(s.manager.runTask({ reqId: 'r', clientId: 'x4', text: 'x', projectId: s.proj.id, employeeId: otto.id, skill: null, plan: false, destinationId: 'instagram-tuco', profileId: 'aurora' }), /não é o da conta de destino/);
  } finally { await s.cleanup(); }
});

test('Instagram Tuco Dev: o executor recebe o contexto da Equipe Tuco Dev nas instruções de sistema', async () => {
  const s = setup();
  try {
    const nina = s.manager.createEmployee({ roomId: s.social.id, name: 'Nina', profileId: 'tuco-dev', template: 'conteudo-criador' });
    const r = await s.manager.runTask({ reqId: 'r', clientId: 'g1', text: 'ARGS', projectId: s.proj.id, employeeId: nina.id, skill: null, plan: false, destinationId: 'instagram-tuco' });
    const t = await s.waitTask(r.taskId);
    assert.equal(t.status, 'done');
    assert.equal(t.profileId, 'tuco-dev');
    // o CLI falso devolve os argumentos com que foi chamado: o sistema anexado leva a equipe e os canais dela
    assert.match(t.resultText ?? '', /Equipe desta tarefa: Equipe Tuco Dev \(Instagram Tuco Dev\)/);
    assert.doesNotMatch(t.resultText ?? '', /Equipe desta tarefa: Equipe Aurora/);
  } finally { await s.cleanup(); }
});

test('assento persistente e único por equipe; trocar de equipe dá assento novo e mantém a identidade', async () => {
  const s = setup();
  try {
    const a = s.manager.createEmployee({ roomId: s.social.id, name: 'Ana', profileId: 'aurora' });
    const b = s.manager.createEmployee({ roomId: s.social.id, name: 'Beto', profileId: 'aurora' });
    const c = s.manager.createEmployee({ roomId: s.social.id, name: 'Caju', profileId: 'tuco-dev' });
    assert.deepEqual([a, b, c].map(e => s.store.getEmployee(e.id)!.deskIndex), [0, 1, 0]);
    const moved = s.manager.updateEmployee(b.id, { profileId: 'tuco-dev' });
    assert.equal(moved.id, b.id); assert.equal(moved.name, 'Beto');
    assert.equal(moved.deskIndex, 1, 'primeiro assento livre da equipe nova');
    // cadastros antigos com assento repetido são consertados ao subir, mantendo quem já estava
    s.store.updateEmployee(a.id, { deskIndex: 1 }); s.store.updateEmployee(b.id, { profileId: 'aurora', deskIndex: 1 });
    const again = new SessionManager({ store: s.store, exePath: () => process.execPath, attachmentsDir: tempDir('hq-att-'), commandPrefixArgs: [fakeClaude] });
    const seats = [a, b].map(e => s.store.getEmployee(e.id)!.deskIndex).sort();
    assert.deepEqual(seats, [0, 1], 'sem assento repetido depois de religar');
    await again.shutdown();
  } finally { await s.cleanup(); }
});
