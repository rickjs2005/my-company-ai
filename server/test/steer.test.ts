// Conversar durante a tarefa (09/11/2026): a mensagem do Chefe entra no próximo passo do turno em andamento, sem interromper
// nem abrir tarefa nova; sem turno rodando, vira pedido normal na fila.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage, Task } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.resolve(here, '..', '..', 'packages', 'claude-bridge', 'test', 'fake-claude.mjs');

function setup() {
  const store = new Store(openDb(':memory:'));
  store.seedDefaultRooms();
  const projDir = tempDir('hq-proj-');
  const room = store.listRooms()[0];
  const project = store.createProject({ name: 'Projeto teste', path: projDir, roomId: room.id });
  const manager = new SessionManager({ store, exePath: () => process.execPath, attachmentsDir: os.tmpdir(), commandPrefixArgs: [fakeClaude] });
  const waitTask = (pred: (t: Task) => boolean, ms = 15_000) => new Promise<Task>((resolve, reject) => {
    const found = store.listTasks().find(pred); if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error('timeout esperando tarefa')), ms);
    const h = (m: ServerMessage) => { if (m.kind === 'entity' && m.entity === 'task' && pred(m.item as Task)) { clearTimeout(timer); manager.off('broadcast', h); resolve(m.item as Task); } };
    manager.on('broadcast', h);
  });
  const nina = manager.createEmployee({ roomId: room.id, name: 'Nina' });
  const run = (clientId: string, text: string) => manager.runTask({ reqId: 'r', clientId, text, projectId: project.id, employeeId: nina.id, skill: null, plan: false });
  return { store, manager, waitTask, run, cleanup: async () => { await manager.shutdown(); fs.rmSync(projDir, { recursive: true, force: true }); } };
}

test('mensagem no meio da tarefa: entra no turno em andamento (priority next), sem tarefa nova, e aparece na conversa como ajuste', async () => {
  const s = setup();
  try {
    const r1 = await s.run('st-1', 'slow answer');
    await s.waitTask(t => t.id === r1.taskId && t.status === 'running');
    await new Promise(r => setTimeout(r, 400));
    const before = s.store.listTasks().length;
    const res = await s.manager.steer({ sessionId: r1.sessionId, clientId: 'aj-1', text: 'põe legenda embaixo' });
    assert.equal(res.delivered, true);
    assert.equal(res.task?.id, r1.taskId);
    assert.equal(s.store.listTasks().length, before, 'nenhuma tarefa nova');
    const item = s.store.getChatItem('steer:aj-1');
    assert.ok(item && item.kind === 'user' && item.steer === true && item.taskId === r1.taskId && item.text === 'põe legenda embaixo');
    // Reenvio do mesmo clientId (duplo clique, reconexão) não manda duas vezes.
    const again = await s.manager.steer({ sessionId: r1.sessionId, clientId: 'aj-1', text: 'põe legenda embaixo' });
    assert.equal(again.delivered, true);
    const done = await s.waitTask(t => t.id === r1.taskId && t.status === 'done');
    assert.match(done.resultText ?? '', /\| ajuste: Mensagem do Chefe agora, no meio desta tarefa: "põe legenda embaixo"/);
    assert.equal((done.resultText ?? '').split('ajuste:').length, 2, 'entregue uma vez só');
  } finally { await s.cleanup(); }
});

test('sem tarefa rodando, a mensagem vira pedido normal na fila da mesma conversa', async () => {
  const s = setup();
  try {
    const r1 = await s.run('st-2', 'oi');
    await s.waitTask(t => t.id === r1.taskId && t.status === 'done');
    const res = await s.manager.steer({ sessionId: r1.sessionId, clientId: 'aj-2', text: 'e agora isto' });
    assert.equal(res.delivered, false);
    assert.ok(res.task && res.task.id !== r1.taskId && res.task.sessionId === r1.sessionId);
    const done = await s.waitTask(t => t.id === res.task!.id && t.status === 'done');
    assert.equal(done.resultText, 'echo: e agora isto');
    await assert.rejects(s.manager.steer({ sessionId: r1.sessionId, clientId: 'aj-3', text: '   ' }), /mensagem vazia/);
  } finally { await s.cleanup(); }
});
