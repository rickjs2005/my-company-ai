// Mesa do Chefe: entrega persistida quando a tarefa distribuída termina, critérios lidos da resposta, aprovar sem publicar,
// pedir ajustes devolvendo ao mesmo responsável (versão nova sem apagar a anterior), idempotência e recuperação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerMessage, Task, TaskRunInput, TaskRunResult } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { MeetingStore } from '../src/meetings/store.js';
import { DeskService, readCriteria } from '../src/desk/service.js';
import { tempDir } from './tmp.js';

class FakeManager extends EventEmitter {
  runs: { input: TaskRunInput; extra?: unknown }[] = [];
  constructor(private store: Store) { super(); }
  async runTask(input: TaskRunInput, extra?: { origin?: Task['origin']; meetingId?: string | null }): Promise<TaskRunResult> {
    const dup = this.store.findTaskByClientId(input.clientId);
    const e = this.store.getEmployee(input.employeeId)!;
    const sess = this.store.listSessionsByEmployee(e.id)[0];
    const t = dup ?? this.store.createTask({ clientId: input.clientId, sessionId: sess.id, projectId: input.projectId, roomId: e.roomId, prompt: input.text, attachments: [], mode: 'queue', employeeId: e.id, meetingId: extra?.meetingId ?? null, origin: extra?.origin });
    if (!dup) this.runs.push({ input, extra });
    return { taskId: t.id, sessionId: sess.id, employeeId: e.id, projectId: input.projectId, status: 'queued', queuePosition: 1, queueReason: null, newSession: false } as unknown as TaskRunResult;
  }
  finish(store: Store, id: string, resultText: string, touched: string[] = []) { store.updateTask(id, { status: 'done', finishedAt: Date.now(), resultText, touchedFiles: touched } as never); this.emit('task_finished', id); }
}

function setup() {
  const dir = tempDir('hq-desk-');
  const db = openDb(path.join(dir, 'hq.sqlite'), { backupsDir: path.join(dir, 'b') });
  const store = new Store(db); store.seedDefaultRooms();
  const room = store.listRooms().find(r => r.kind === 'social')!;
  const proj = store.createProject({ name: 'Conteúdos', path: dir, roomId: room.id });
  const bia = store.createEmployee({ name: 'Bia', role: 'Criação', roomId: room.id, appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0 });
  store.createSession({ roomId: room.id, projectId: proj.id, employeeId: bia.id, name: 'Bia', permissionMode: 'acceptEdits', workerName: 'Bia', appearance: bia.appearance, deskIndex: 0 } as never);
  const meetings = new MeetingStore(db);
  const m = meetings.createMeeting({ title: 'Bancada de social media', agenda: 'semana', projectId: proj.id, mode: 'guided', roundLimit: 2 });
  meetings.addPlan({ meetingId: m.id, authorParticipantId: null, authorName: 'Claude', summary: '', decisions: [], pending: [], needs: [], tasks: [] });
  const spec = { key: 't1', title: 'Post do Threads', objective: 'post', employeeId: bia.id, employeeName: 'Bia', projectId: proj.id, slot: 'threads' as const, context: '', references: [], skill: null, deliverable: 'post.md', criteria: ['até 500 caracteres', 'sem travessão'], priority: 'alta' as const, dependsOn: [], deadline: null, deadlineProposed: false };
  const rec = meetings.upsertPlanTask(m.id, 1, spec);
  const manager = new FakeManager(store);
  const sent: ServerMessage[] = [];
  const desk = new DeskService({ db, store, meetings, manager, broadcast: x => sent.push(x) });
  const sess = store.listSessionsByEmployee(bia.id)[0];
  const task = store.createTask({ clientId: `meeting:${m.id}:plan:t1`, sessionId: sess.id, projectId: proj.id, roomId: room.id, prompt: 'post', attachments: [], mode: 'queue', employeeId: bia.id, meetingId: m.id, origin: 'meeting' });
  meetings.updatePlanTask(rec.id, { status: 'created', taskId: task.id, sessionId: sess.id });
  return { dir, db, store, meetings, manager, desk, sent, m, bia, task, proj };
}

test('critérios: marcados pelo funcionário casam com os do plano; não informado fica para conferir', () => {
  const c = readCriteria('Pronto.\n- [x] até 500 caracteres (412)\n- [ ] sem travessão: sobrou um no fim\n- [x] link conferido', ['até 500 caracteres', 'sem travessão', 'tom direto']);
  assert.deepEqual(c.map(x => [x.text, x.ok]), [['até 500 caracteres', true], ['sem travessão', false], ['tom direto', null], ['link conferido', true]]);
  assert.match(c[1].note ?? '', /sobrou um no fim/);
});

test('entrega na mesa: tarefa do plano concluída vira entrega v1; aprovar não publica; pedir ajustes devolve à Bia e gera a v2', async () => {
  const s = setup();
  const file = path.join(s.dir, 'post.md'); fs.writeFileSync(file, 'post');
  // Tarefa que falhou não vira entrega.
  s.store.updateTask(s.task.id, { status: 'error', finishedAt: Date.now() } as never); s.manager.emit('task_finished', s.task.id);
  assert.equal(s.desk.state().deliveries.length, 0);
  s.manager.finish(s.store, s.task.id, `Post pronto.\nArquivo: ${file}\nArquivo: ${path.join(s.dir, 'nao-existe.md')}\nhttps://aurora.example/x.\n- [x] até 500 caracteres\n- [x] sem travessão`);
  let d = s.desk.state().deliveries;
  assert.equal(d.length, 1);
  assert.equal(d[0].version, 1); assert.equal(d[0].status, 'nova'); assert.equal(d[0].title, 'Post do Threads'); assert.equal(d[0].slot, 'threads');
  assert.equal(d[0].meetingTitle, 'Bancada de social media'); assert.equal(d[0].employeeId, s.bia.id);
  assert.deepEqual(d[0].files, [file], 'só arquivo que existe');
  assert.deepEqual(d[0].links, ['https://aurora.example/x']);
  assert.deepEqual(d[0].criteria.map(c => c.ok), [true, true]);
  assert.ok(s.sent.some(x => x.kind === 'desk.state'));
  // Evento repetido (reinício) não duplica.
  s.manager.emit('task_finished', s.task.id); s.desk.recover();
  assert.equal(s.desk.state().deliveries.length, 1);
  await s.desk.handle({ type: 'desk.seen', reqId: 'r', ids: [d[0].id] });
  assert.equal(s.desk.state().deliveries[0].status, 'vista');
  // Pedir ajustes: mesma funcionária, mesmo projeto, observação do Chefe; clique repetido não cria outro ajuste.
  await assert.rejects(s.desk.handle({ type: 'desk.adjust', reqId: 'r', id: d[0].id, note: '  ', clientId: 'a' }), /escreva o que ajustar/);
  await s.desk.handle({ type: 'desk.adjust', reqId: 'r', id: d[0].id, note: 'Troque o gancho por uma pergunta.', clientId: 'a1' });
  await s.desk.handle({ type: 'desk.adjust', reqId: 'r', id: d[0].id, note: 'Troque o gancho por uma pergunta.', clientId: 'a2' });
  assert.equal(s.manager.runs.length, 1);
  const run = s.manager.runs[0];
  assert.equal(run.input.employeeId, s.bia.id); assert.equal(run.input.projectId, s.proj.id);
  assert.match(run.input.text, /Observação do Chefe: Troque o gancho por uma pergunta\./);
  assert.match(run.input.text, /NÃO apague a versão anterior: salve a nova ao lado \(ex\.: sufixo -v2\)/);
  d = s.desk.state().deliveries;
  assert.equal(d[0].status, 'ajustes'); assert.ok(d[0].adjustTaskId);
  await assert.rejects(s.desk.handle({ type: 'desk.approve', reqId: 'r', id: d[0].id }), /voltou para ajustes/);
  // A versão 2 nasce quando o ajuste termina; a v1 continua guardada.
  const file2 = path.join(s.dir, 'post-v2.md'); fs.writeFileSync(file2, 'post 2');
  s.manager.finish(s.store, d[0].adjustTaskId!, `Novo gancho.\nArquivo: ${file2}\n- [x] até 500 caracteres\n- [x] sem travessão`);
  d = s.desk.state().deliveries;
  assert.equal(d.length, 2);
  const v2 = d.find(x => x.version === 2)!; const v1 = d.find(x => x.version === 1)!;
  assert.equal(v2.rootTaskId, v1.rootTaskId); assert.equal(v2.title, 'Post do Threads'); assert.equal(v2.meetingId, s.m.id);
  assert.deepEqual(v2.files, [file2]); assert.ok(fs.existsSync(file), 'a v1 continua no disco');
  // Aprovar a v2: só muda o estado da entrega.
  const tasksBefore = s.store.listTasks(50).length;
  await s.desk.handle({ type: 'desk.approve', reqId: 'r', id: v2.id });
  assert.equal(s.desk.state().deliveries.find(x => x.id === v2.id)!.status, 'aprovada');
  assert.equal(s.store.listTasks(50).length, tasksBefore, 'aprovar não cria tarefa nem publica nada');
});

test('bloqueio do plano: mesmo texto da mesma reunião não repete; resolver tira da lista ativa', async () => {
  const s = setup();
  s.desk.addNeed({ meetingId: s.m.id, planTaskId: null, text: '"Editar vídeo": ninguém apto na equipe' });
  s.desk.addNeed({ meetingId: s.m.id, planTaskId: null, text: '"Editar vídeo": ninguém apto na equipe' });
  let n = s.desk.state().needs;
  assert.equal(n.length, 1); assert.equal(n[0].meetingTitle, 'Bancada de social media');
  await s.desk.handle({ type: 'desk.need.resolve', reqId: 'r', id: n[0].id });
  n = s.desk.state().needs;
  assert.ok(n[0].resolvedAt);
});
