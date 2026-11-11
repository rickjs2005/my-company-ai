// Testes do gerenciador com o CLI falso (protocolo igual ao real) e banco SQLite em memória.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import { DM_SESSION_NAME } from '@milweb-hq/protocol';
import type { ServerMessage } from '@milweb-hq/protocol';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.resolve(here, '..', '..', 'packages', 'claude-bridge', 'test', 'fake-claude.mjs');

function setup() {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.seedDefaultRooms();
  const projDir = tempDir('hq-proj-');
  const attachmentsDir = tempDir('hq-att-');
  const room = store.listRooms()[0];
  const project = store.createProject({ name: 'Projeto teste', path: projDir, roomId: room.id });
  const manager = new SessionManager({ store, exePath: () => process.execPath, attachmentsDir, commandPrefixArgs: [fake] });
  const msgs: ServerMessage[] = [];
  manager.on('broadcast', m => msgs.push(m));
  const waitFor = (pred: (m: ServerMessage) => boolean, ms = 5000) => new Promise<ServerMessage>((resolve, reject) => {
    const found = msgs.find(pred); if (found) return resolve(found);
    const t = setTimeout(() => reject(new Error('timeout esperando mensagem')), ms);
    const h = (m: ServerMessage) => { if (pred(m)) { clearTimeout(t); manager.off('broadcast', h); resolve(m); } };
    manager.on('broadcast', h);
  });
  return { db, store, manager, room, project, msgs, waitFor, cleanup: async () => { await manager.shutdown(); fs.rmSync(projDir, { recursive: true, force: true }); fs.rmSync(attachmentsDir, { recursive: true, force: true }); } };
}

test('tarefa completa: prompt → processo real (falso) → chat e result; reenvio com o mesmo clientId não duplica', async () => {
  const s = setup();
  try {
    const session = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id, name: 'Sessão A' });
    assert.equal(session.status, 'new');
    const t1 = await s.manager.sendPrompt({ sessionId: session.id, clientId: 'c1', text: 'hello world', mode: 'send' });
    assert.equal(t1.status, 'running');
    const done = await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { status?: string }).status === 'done');
    assert.ok(done);
    const t1b = await s.manager.sendPrompt({ sessionId: session.id, clientId: 'c1', text: 'hello world', mode: 'send' });
    assert.equal(t1b.id, t1.id, 'mesmo clientId devolve a mesma tarefa');
    const chat = s.store.listChat(session.id);
    assert.deepEqual(chat.map(c => c.kind), ['user', 'assistant', 'result']);
    const sess = s.manager.getSession(session.id)!;
    assert.equal(sess.status, 'active');
    assert.equal(sess.claudeSessionId, 'fake-session-00000000-0000-0000-0000-000000000001');
    assert.equal(s.manager.listWorkers()[0].phase, 'done');
  } finally { await s.cleanup(); }
});

test('permissão: fica pendente, tarefa em waiting_permission, allow conclui; deny registra', async () => {
  const s = setup();
  try {
    const session = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id });
    await s.manager.sendPrompt({ sessionId: session.id, clientId: 'p1', text: 'please use bash', mode: 'send' });
    const req = await s.waitFor(m => m.kind === 'permission.request');
    assert.equal(req.kind, 'permission.request');
    const pending = s.manager.pendingPermissions();
    assert.equal(pending.length, 1);
    assert.equal(s.store.getTask(pending[0].taskId!)!.status, 'waiting_permission');
    assert.equal(s.manager.listWorkers()[0].phase, 'waiting_permission');
    s.manager.respondPermission(session.id, pending[0].request.requestId, 'allow');
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { status?: string }).status === 'done');
    const perm = s.store.listChat(session.id).find(c => c.kind === 'permission');
    assert.equal(perm && perm.kind === 'permission' ? perm.decision : null, 'allow');

    await s.manager.sendPrompt({ sessionId: session.id, clientId: 'p2', text: 'bash again', mode: 'send' });
    await s.waitFor(m => m.kind === 'permission.request' && m.pending.request.requestId !== pending[0].request.requestId);
    const p2 = s.manager.pendingPermissions()[0];
    s.manager.respondPermission(session.id, p2.request.requestId, 'deny', 'não agora');
    const t2 = await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { id: string }).id !== pending[0].taskId && (m.item as { status?: string }).status === 'done');
    assert.ok(t2);
  } finally { await s.cleanup(); }
});

test('pergunta (AskUserQuestion) respondida pelo app', async () => {
  const s = setup();
  try {
    const session = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id });
    await s.manager.sendPrompt({ sessionId: session.id, clientId: 'q1', text: 'ask me a question', mode: 'send' });
    const req = await s.waitFor(m => m.kind === 'permission.request');
    assert.ok(req.kind === 'permission.request' && req.pending.isQuestion);
    assert.equal(s.manager.listWorkers()[0].phase, 'waiting_answer');
    s.manager.answerQuestion(session.id, req.pending.request.requestId, { 'Which color do you prefer?': 'blue' });
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { status?: string }).status === 'done');
    const t = s.store.listTasksBySession(session.id)[0];
    assert.equal(t.resultText, 'you chose blue');
  } finally { await s.cleanup(); }
});

test('fila: segunda mensagem espera a primeira; limite global de 1 execução entre sessões', async () => {
  const s = setup();
  try {
    const a = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id, name: 'A' });
    const b = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id, name: 'B' });
    const t1 = await s.manager.sendPrompt({ sessionId: a.id, clientId: 'f1', text: 'slow please', mode: 'send' });
    const t2 = await s.manager.sendPrompt({ sessionId: a.id, clientId: 'f2', text: 'second', mode: 'queue' });
    const t3 = await s.manager.sendPrompt({ sessionId: b.id, clientId: 'f3', text: 'third', mode: 'send' });
    assert.equal(t1.status, 'running');
    assert.equal(t2.status, 'queued');
    assert.equal(t3.status, 'queued', 'maxParallel=1: a sessão B espera');
    assert.equal(s.manager.activeTurns(), 1);
    await s.manager.interrupt(a.id);
    const t1f = s.store.getTask(t1.id)!;
    assert.equal(t1f.status, 'interrupted');
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { id: string }).id === t2.id && (m.item as { status?: string }).status === 'done', 8000);
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { id: string }).id === t3.id && (m.item as { status?: string }).status === 'done', 8000);
  } finally { await s.cleanup(); }
});

test('processo morto inesperadamente: sessão lost, tarefa lost, funcionário desconectado; reinício reconcilia', async () => {
  const s = setup();
  try {
    const session = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id });
    await s.manager.sendPrompt({ sessionId: session.id, clientId: 'k1', text: 'slow please', mode: 'send' });
    // espera o init real (id da sessão do Claude) em vez de um tempo fixo: o Node no Windows pode levar mais de 300 ms para subir o CLI falso
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'session' && Boolean((m.item as { claudeSessionId?: string | null }).claudeSessionId), 8000);
    // mata o processo por fora
    const procs = (s.manager as unknown as { procs: Map<string, { kill(): void; closing: boolean }> }).procs;
    const p = procs.get(session.id)!;
    (p as unknown as { closing: boolean }).closing = false;
    process.kill((p as unknown as { pid: number }).pid, 'SIGKILL');
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'session' && (m.item as { status?: string }).status === 'lost', 8000);
    const t = s.store.findTaskByClientId('k1')!;
    assert.equal(t.status, 'lost');
    assert.equal(t.review, null, 'só leu: não vira resultado a conferir');
    const retry = s.store.findTaskByClientId('retry:' + t.id + ':2');
    assert.ok(retry, 'sem alteração observada, a tarefa volta para a fila como tentativa 2');
    assert.equal(retry!.attempt, 2); assert.equal(retry!.retryOf, t.id);
    assert.equal(s.manager.listWorkers()[0].phase, 'disconnected');
    // simula reinício do serviço com o mesmo banco
    const again = new SessionManager({ store: s.store, exePath: () => process.execPath, attachmentsDir: os.tmpdir(), commandPrefixArgs: [fake] });
    s.store.updateTask(t.id, { status: 'running', attempt: 2 });
    again.reconcileOnStart();
    assert.equal(s.store.getTask(t.id)!.status, 'lost');
    assert.ok(s.store.getTask(t.id)!.errors.some(e => /Limite de 2 tentativa/.test(e)), 'tentativa 2 não gera uma terceira');
    assert.equal(s.store.getSession(session.id)!.status, 'paused');
  } finally { await s.cleanup(); }
});

test('--resume de conversa inexistente: esquece o id, avisa e volta para a fila como tentativa 2 (que roda sem resume)', async () => {
  const s = setup();
  try {
    const session = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id });
    // simula uma conversa antiga cuja transcrição o Claude Code não encontra mais (o CLI falso responde ao padrão "missing-*")
    s.store.updateSession(session.id, { claudeSessionId: 'missing-0000-apagada', status: 'paused' });
    await s.manager.sendPrompt({ sessionId: session.id, clientId: 'k-lost', text: 'oi', mode: 'send' });
    const first = s.store.findTaskByClientId('k-lost')!;
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { id: string }).id === first.id && (m.item as { status: string }).status === 'lost', 8000);
    assert.equal(s.store.getSession(session.id)!.claudeSessionId, null, 'o id perdido foi esquecido');
    assert.ok(s.store.listChat(session.id).some(c => c.kind === 'notice' && /não existe mais no Claude Code/.test(c.text)), 'aviso no chat');
    const retry = s.store.findTaskByClientId('retry:' + first.id + ':2');
    assert.ok(retry, 'tentativa 2 criada');
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { id: string }).id === retry!.id && (m.item as { status: string }).status === 'done', 10000);
    assert.equal(s.store.getSession(session.id)!.claudeSessionId, 'fake-session-00000000-0000-0000-0000-000000000001', 'a tentativa 2 começou uma conversa nova');
    assert.ok(s.store.listChat(session.id).some(c => c.kind === 'assistant' && /echo: oi/.test(c.text)), 'a resposta da tentativa 2 chegou');
  } finally { await s.cleanup(); }
});

test('sessão observada não aceita prompt', async () => {
  const s = setup();
  try {
    const ext = s.store.createSession({ roomId: s.room.id, projectId: s.project.id, name: 'ext', permissionMode: 'default', controllable: false, status: 'observed', workerName: 'X', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0 });
    await assert.rejects(s.manager.sendPrompt({ sessionId: ext.id, clientId: 'o1', text: 'x', mode: 'send' }), /observada/);
  } finally { await s.cleanup(); }
});

// ---------------- funcionários (identidade persistente ≠ conversa ≠ processo) ----------------

test('funcionários: conversa sem employeeId contrata um funcionário; a 2ª conversa vira a ativa; o personagem continua um só', async () => {
  const s = setup();
  try {
    const s1 = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id, name: 'Conversa 1' });
    assert.ok(s1.employeeId);
    const emps = s.manager.listEmployees();
    assert.equal(emps.length, 1);
    assert.equal(emps[0].id, s1.employeeId);
    assert.equal(emps[0].activeSessionId, s1.id);
    assert.equal(emps[0].roomId, s.room.id);
    let w = s.manager.listWorkers();
    assert.equal(w.length, 1);
    assert.equal(w[0].kind, 'employee');
    assert.equal(w[0].id, emps[0].id);
    assert.equal(w[0].sessionId, s1.id);
    assert.equal(w[0].status, 'idle');
    assert.equal(w[0].name, emps[0].name);

    const s2 = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id, employeeId: emps[0].id, name: 'Conversa 2' });
    assert.equal(s2.employeeId, emps[0].id);
    assert.equal(s.manager.listEmployees().length, 1, 'não contrata outro funcionário');
    assert.equal(s.manager.listEmployees()[0].activeSessionId, s2.id);
    w = s.manager.listWorkers();
    assert.equal(w.length, 1, 'um personagem por funcionário, não por conversa');
    assert.equal(w[0].sessionId, s2.id);
    assert.equal(s.store.listSessionsByEmployee(emps[0].id).length, 2);

    s.manager.setActiveSession(emps[0].id, s1.id);
    assert.equal(s.manager.listWorkers()[0].sessionId, s1.id);

    const s3 = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id, name: 'Outro' });
    assert.notEqual(s3.employeeId, emps[0].id);
    assert.throws(() => s.manager.setActiveSession(emps[0].id, s3.id), /não pertence/);

    s.manager.setActiveSession(emps[0].id, null);
    const w0 = s.manager.listWorkers().find(x => x.id === emps[0].id)!;
    assert.equal(w0.sessionId, null);
    assert.equal(w0.status, 'idle');
    assert.equal(w0.detail, 'Disponível');
    assert.ok(s.msgs.some(m => m.kind === 'entity' && m.entity === 'employee' && m.op === 'upsert'));
  } finally { await s.cleanup(); }
});

test('funcionários: estado real durante a execução (running → idle), transferência de sala e nome único', async () => {
  const s = setup();
  try {
    const session = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id });
    const e = s.manager.listEmployees()[0];
    await s.manager.sendPrompt({ sessionId: session.id, clientId: 'e1', text: 'hello world', mode: 'send' });
    const running = await s.waitFor(m => m.kind === 'session.activity' && m.sessionId === session.id && m.worker.status === 'running');
    assert.equal(running.kind, 'session.activity');
    if (running.kind === 'session.activity') assert.equal(running.worker.id, e.id, 'o estado é emitido pelo funcionário, não por uma cópia da conversa');
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { status?: string }).status === 'done');
    assert.equal(s.manager.listWorkers()[0].status, 'idle');

    const other = s.store.listRooms().find(r => r.id !== s.room.id)!;
    const moved = s.manager.updateEmployee(e.id, { roomId: other.id });
    assert.equal(moved.roomId, other.id);
    assert.equal(s.manager.listWorkers()[0].roomId, other.id);
    assert.equal(s.manager.listWorkers()[0].sessionId, session.id, 'a conversa continua sendo a ativa depois da transferência');

    const e2 = s.manager.createEmployee({ roomId: s.room.id, name: 'Theo' });
    assert.equal(e2.name, 'Theo');
    assert.throws(() => s.manager.updateEmployee(e.id, { name: 'theo' }), /já existe/);
    assert.throws(() => s.manager.createEmployee({ roomId: s.room.id, name: 'THEO' }), /já existe/);
    assert.equal(s.manager.listWorkers().length, 2);
  } finally { await s.cleanup(); }
});

test('funcionários: arquivar encerra o processo e tira o personagem da sala, mas conversa e histórico ficam; restaurar devolve', async () => {
  const s = setup();
  try {
    const session = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id });
    const e = s.manager.listEmployees()[0];
    await s.manager.sendPrompt({ sessionId: session.id, clientId: 'a1', text: 'hello world', mode: 'send' });
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { status?: string }).status === 'done');
    assert.notEqual(s.manager.getSession(session.id)!.processState, null, 'processo vivo antes de arquivar');

    await s.manager.archiveEmployee(e.id);
    assert.equal(s.manager.listWorkers().length, 0);
    assert.ok(s.manager.listEmployees()[0].archivedAt);
    const sess = s.manager.getSession(session.id)!;
    assert.equal(sess.status, 'paused');
    assert.equal(sess.processState, null);
    assert.equal(s.store.listChat(session.id).length, 3, 'histórico preservado');
    assert.ok(s.msgs.some(m => m.kind === 'entity' && m.entity === 'worker' && m.op === 'delete' && m.item.id === e.id));
    assert.throws(() => s.manager.createSession({ roomId: s.room.id, projectId: s.project.id, employeeId: e.id }), /arquivado/);

    const back = s.manager.unarchiveEmployee(e.id);
    assert.equal(back.archivedAt, null);
    const w = s.manager.listWorkers();
    assert.equal(w.length, 1);
    assert.equal(w[0].status, 'paused');
    assert.equal(w[0].sessionId, session.id);

    await s.manager.closeSession(session.id, true);
    assert.equal(s.manager.listEmployees()[0].activeSessionId, null, 'arquivar a conversa tira a conversa ativa, não o funcionário');
    assert.equal(s.manager.listWorkers()[0].status, 'idle');
  } finally { await s.cleanup(); }
});

test('anexos: o campo de pedido guarda até 10; os fluxos da HQ (análise de vídeo) pedem até 30 (antes o 11º sumia sem aviso)', async () => {
  const s = setup();
  try {
    const session = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id, name: 'Anexos' });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `q${i}.png`, mediaType: 'image/png', dataBase64: png }));
    const a = await s.manager.sendPrompt({ sessionId: session.id, clientId: 'a1', text: 'olha', attachments: many, mode: 'queue' });
    assert.equal(a.attachments.length, 10);
    const b = await s.manager.sendPrompt({ sessionId: session.id, clientId: 'a2', text: 'olha tudo', attachments: many, maxAttachments: many.length, mode: 'queue' });
    assert.equal(b.attachments.length, 25);
    const c = await s.manager.sendPrompt({ sessionId: session.id, clientId: 'a3', text: 'demais', attachments: [...many, ...many], maxAttachments: 50, mode: 'queue' });
    assert.equal(c.attachments.length, 30, 'teto de 30');
  } finally { await s.cleanup(); }
});

test('conversa particular (08/11): não espera a vaga das tarefas, não ocupa a vaga e nunca recebe tarefa de trabalho', async () => {
  const s = setup();
  try {
    const work = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id, name: 'Trabalho' });
    const emp = s.store.getSession(work.id)!.employeeId!;
    const t1 = await s.manager.sendPrompt({ sessionId: work.id, clientId: 'w1', text: 'slow please', mode: 'send' });
    assert.equal(t1.status, 'running');
    const dm = s.manager.openDm(emp);
    assert.equal(dm.name, DM_SESSION_NAME);
    assert.equal(s.store.getEmployee(emp)!.activeSessionId, work.id, 'a conversa particular não vira a conversa ativa');
    assert.equal(s.manager.openDm(emp).id, dm.id, 'abrir de novo reaproveita a mesma conversa');
    const d1 = await s.manager.sendPrompt({ sessionId: dm.id, clientId: 'd1', text: 'oi', mode: 'queue' });
    assert.equal(d1.status, 'running', 'a conversa particular roda mesmo com a vaga ocupada pela tarefa');
    await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as { id: string }).id === d1.id && (m.item as { status?: string }).status === 'done', 8000);
    s.store.updateEmployee(emp, { activeSessionId: dm.id }); // mesmo se alguém marcar a conversa particular como ativa...
    const r = await s.manager.runTask({ reqId: 'x', clientId: 'job1', text: 'trabalho', projectId: s.project.id, employeeId: emp, skill: null, plan: false });
    assert.notEqual(r.sessionId, dm.id, '...a tarefa de trabalho vai para a sessão de trabalho');
    await s.manager.interrupt(work.id);
  } finally { await s.cleanup(); }
});
