import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Employee, Session, Snapshot, Worker } from '@milweb-hq/protocol';
import { DEFAULT_SETTINGS } from '@milweb-hq/protocol';
import { initialActivity } from '@milweb-hq/claude-bridge/activity';
import { applyMessage, emptyState, mergeMeetingHistory } from '../src/state/store';
import type { Meeting, MeetingMessage, MeetingTurn } from '@milweb-hq/protocol';

const act = initialActivity();
const employee: Employee = { id: 'e1', name: 'Léo', role: 'Dev', roomId: 'r1', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0, instructions: '', profileId: null, model: null, effort: null, permissionMode: 'default', activeSessionId: 's1', archivedAt: null, createdAt: 1, updatedAt: 1, provider: 'claude', skills: [], agent: null, template: null, access: { mcp: 'none' } };
const session: Session = { id: 's1', claudeSessionId: null, employeeId: 'e1', roomId: 'r1', projectId: 'p1', name: 'A', permissionMode: 'default', status: 'new', controllable: true, processState: null, activity: act, createdAt: 1, lastActiveAt: 1 };
const worker: Worker = { id: 'e1', kind: 'employee', employeeId: 'e1', sessionId: 's1', roomId: 'r1', projectId: 'p1', name: 'Léo', role: 'Dev', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0, phase: 'idle', detail: 'Disponível', status: 'idle', controllable: true, busy: false };
const snapshot: Snapshot = {
  serverInfo: { version: '0', claudeExePath: null, claudeVersion: null, authOk: null, apiKeyInEnv: false, dataDir: '', maxParallel: 1, startedAt: 0 }, settings: DEFAULT_SETTINGS,
  rooms: [{ id: 'r2', slug: 'b', name: 'B', kind: 'custom', instructions: '', profiles: [], color: '#fff', order: 1 }, { id: 'r1', slug: 'a', name: 'A', kind: 'dev', instructions: '', profiles: [], color: '#fff', order: 0 }],
  projects: [], folders: [{ id: 'f1', name: 'Downloads', path: 'C:\\Users\\x\\Downloads', addedAt: 1 }], employees: [employee], sessions: [session], workers: [worker], tasks: [], pendingPermissions: [], snapshotAt: 1700000000000, seq: 0, meetings: [], ai: [], routines: [],
};

test('snapshot ordena salas, zera histórico carregado e guarda o momento do retrato', () => {
  let s = emptyState();
  s = { ...s, chatLoaded: { s1: true } };
  s = applyMessage(s, { kind: 'snapshot', snapshot });
  assert.deepEqual(s.rooms.map(r => r.id), ['r1', 'r2']);
  assert.deepEqual(s.chatLoaded, {});
  assert.equal(s.sessions.length, 1);
  assert.equal(s.employees.length, 1);
  assert.equal(s.folders.length, 1);
  assert.equal(s.lastSnapshotAt, 1700000000000);
});

test('entidades: upsert e delete; atividade atualiza sessão e funcionário; funcionário e pasta extra', () => {
  let s = applyMessage(emptyState(), { kind: 'snapshot', snapshot });
  s = applyMessage(s, { kind: 'entity', entity: 'session', op: 'upsert', item: { ...session, status: 'active' } });
  assert.equal(s.sessions[0].status, 'active');
  s = applyMessage(s, { kind: 'session.activity', sessionId: 's1', activity: { ...act, phase: 'writing', detail: 'Escrevendo x' }, processState: 'running', worker: { ...worker, phase: 'writing', status: 'running', busy: true } });
  assert.equal(s.sessions[0].activity.phase, 'writing');
  assert.equal(s.workers[0].busy, true);
  assert.equal(s.workers[0].status, 'running');
  s = applyMessage(s, { kind: 'entity', entity: 'worker', op: 'delete', item: { id: 'e1' } });
  assert.equal(s.workers.length, 0);
  s = applyMessage(s, { kind: 'entity', entity: 'employee', op: 'upsert', item: { ...employee, archivedAt: 5 } });
  assert.equal(s.employees[0].archivedAt, 5);
  s = applyMessage(s, { kind: 'entity', entity: 'folder', op: 'delete', item: { id: 'f1' } });
  assert.equal(s.folders.length, 0);
});

test('chat: itens por id (atualização substitui), delta de streaming, eventos sem duplicar seq', () => {
  let s = emptyState();
  s = applyMessage(s, { kind: 'chat.item', sessionId: 's1', item: { id: 'tool:1', ts: 1, taskId: 't1', kind: 'tool', toolUseId: '1', name: 'Bash', summary: 'x', input: {}, done: false } });
  s = applyMessage(s, { kind: 'chat.item', sessionId: 's1', item: { id: 'tool:1', ts: 1, taskId: 't1', kind: 'tool', toolUseId: '1', name: 'Bash', summary: 'x', input: {}, done: true, output: 'hi' } });
  assert.equal(s.chat.s1.length, 1);
  assert.equal((s.chat.s1[0] as { done: boolean }).done, true);
  s = applyMessage(s, { kind: 'chat.delta', sessionId: 's1', taskId: 't1', text: 'par' });
  assert.equal(s.streaming.s1, 'par');
  s = applyMessage(s, { kind: 'event', seq: 5, sessionId: 's1', taskId: 't1', entry: { ts: 1, kind: 'prompt', summary: 'oi' } });
  s = applyMessage(s, { kind: 'event', seq: 5, sessionId: 's1', taskId: 't1', entry: { ts: 1, kind: 'prompt', summary: 'oi' } });
  assert.equal(s.events.s1.length, 1);
});

test('permissões pendentes entram e saem', () => {
  let s = emptyState();
  const pending = { sessionId: 's1', taskId: 't1', isQuestion: false, request: { requestId: 'req1', toolName: 'Bash', input: {}, receivedAt: 1 } };
  s = applyMessage(s, { kind: 'permission.request', pending });
  s = applyMessage(s, { kind: 'permission.request', pending });
  assert.equal(s.pending.length, 1);
  s = applyMessage(s, { kind: 'permission.resolved', sessionId: 's1', requestId: 'req1', behavior: 'allow' });
  assert.equal(s.pending.length, 0);
});

test('observadas substituem o conjunto anterior sem tocar nos funcionários', () => {
  let s = applyMessage(emptyState(), { kind: 'snapshot', snapshot });
  const obs: Worker = { ...worker, id: 'x1', kind: 'observed', employeeId: null, sessionId: 'x1', status: 'observed', controllable: false, name: 'Terminal (observado)' };
  s = applyMessage(s, { kind: 'external', sessions: [{ ...session, id: 'x1', employeeId: null, status: 'observed', controllable: false }], workers: [obs], projects: [] });
  assert.deepEqual(s.workers.map(w => w.id), ['e1', 'x1']);
  s = applyMessage(s, { kind: 'external', sessions: [], workers: [], projects: [] });
  assert.deepEqual(s.workers.map(w => w.id), ['e1']);
  assert.equal(s.sessions.length, 1);
});

test('mudanças no disco e na lixeira viram contadores; reconectar invalida tudo', () => {
  let s = applyMessage(emptyState(), { kind: 'snapshot', snapshot });
  s = applyMessage(s, { kind: 'fs.changed', rootId: 'project:p1', paths: ['src/a.ts'] });
  s = applyMessage(s, { kind: 'fs.changed', rootId: 'project:p1', paths: ['src/b.ts'] });
  assert.equal(s.fsChanges['project:p1'].nonce, 2);
  assert.deepEqual(s.fsChanges['project:p1'].paths, ['src/b.ts']);
  s = applyMessage(s, { kind: 'trash.changed' });
  const trashBefore = s.trashNonce;
  s = applyMessage(s, { kind: 'snapshot', snapshot });
  assert.equal(s.fsChanges['project:p1'].nonce, 3);
  assert.deepEqual(s.fsChanges['project:p1'].paths, []);
  assert.equal(s.trashNonce, trashBefore + 1);
});

const meeting: Meeting = { id: 'm1', title: 'Pauta', agenda: 'Decidir o stack', projectId: null, mode: 'guided', status: 'active', roundLimit: 2, currentRound: 0, contextVersion: 1, synthesisParticipantId: null, companyContext: true, createdAt: 10, updatedAt: 10, startedAt: 10, endedAt: null, participants: [], minutes: null, activeTurnId: null, queuedTurns: 0 };
const turn = (id: string, status: MeetingTurn['status']): MeetingTurn => ({ id, meetingId: 'm1', participantId: 'p1', round: 0, phase: 'reply', status, requested: { model: null, effort: null }, applied: null, contextVersion: 1, createdAt: 1, startedAt: null, finishedAt: null, error: null, messageId: null, promptChars: 10, usage: null, durationMs: null, order: 0 });
const msg = (id: string): MeetingMessage => ({ id, meetingId: 'm1', turnId: null, participantId: 'chefe', authorName: 'Chefe', provider: null, kind: 'chefe', text: id, ts: 1, round: null, phase: null, targets: [], config: null, contextVersion: 1, partial: false });

test('reuniões: entidade ordenada por criação, falas/turnos/quadro entram no histórico mesmo antes da carga, delta por turno some ao terminar, apagar limpa tudo', () => {
  let s = applyMessage(emptyState(), { kind: 'entity', entity: 'meeting', op: 'upsert', item: meeting });
  s = applyMessage(s, { kind: 'entity', entity: 'meeting', op: 'upsert', item: { ...meeting, id: 'm2', createdAt: 20 } });
  assert.deepEqual(s.meetings.map(m => m.id), ['m2', 'm1'], 'mais recente primeiro');
  s = applyMessage(s, { kind: 'meeting.message', meetingId: 'm1', message: msg('a') });
  s = applyMessage(s, { kind: 'meeting.message', meetingId: 'm1', message: { ...msg('a'), text: 'a2' } });
  assert.equal(s.meetingHistory.m1.messages.length, 1);
  assert.equal(s.meetingHistory.m1.messages[0].text, 'a2', 'mesma fala por id substitui');
  assert.equal(s.meetingHistoryLoaded.m1, undefined, 'ainda não carregado');
  s = applyMessage(s, { kind: 'meeting.turn', meetingId: 'm1', turn: turn('t1', 'running') });
  s = applyMessage(s, { kind: 'meeting.delta', meetingId: 'm1', turnId: 't1', participantId: 'p1', text: 'par' });
  assert.equal(s.meetingStreaming.t1, 'par');
  s = applyMessage(s, { kind: 'meeting.turn', meetingId: 'm1', turn: turn('t1', 'done') });
  assert.equal(s.meetingStreaming.t1, undefined, 'turno terminado apaga o parcial');
  assert.equal(s.meetingHistory.m1.turns[0].status, 'done');
  s = applyMessage(s, { kind: 'meeting.delta', meetingId: 'm1', turnId: 't2', participantId: 'p1', text: 'x' });
  s = applyMessage(s, { kind: 'meeting.delta', meetingId: 'm1', turnId: 't2', participantId: 'p1', text: '' });
  assert.deepEqual(s.meetingStreaming, {});
  s = applyMessage(s, { kind: 'meeting.decision', meetingId: 'm1', op: 'upsert', decision: { id: 'd1', meetingId: 'm1', kind: 'proposal', text: 'Next', participantId: 'p1', confirmed: false, dismissed: false, messageId: null, assigneeEmployeeId: null, createdAt: 1, updatedAt: 1 } });
  s = applyMessage(s, { kind: 'meeting.decision', meetingId: 'm1', op: 'delete', decision: { id: 'd1' } });
  assert.equal(s.meetingHistory.m1.decisions.length, 0);
  s = applyMessage(s, { kind: 'meeting.context', meetingId: 'm1', items: [{ id: 'c1', kind: 'note', label: 'Regra', path: null, text: 'x', enabled: true }], contextVersion: 4 });
  assert.equal(s.meetingHistory.m1.context.length, 1);
  assert.equal(s.meetings.find(m => m.id === 'm1')!.contextVersion, 4, 'a versão do contexto acompanha a reunião');
  s = applyMessage(s, { kind: 'ai.status', providers: [{ provider: 'claude', label: 'Claude', routeLabel: 'x', installed: true, exePath: null, version: null, latestKnownVersion: null, authState: 'ok', authMethod: null, authDetail: null, models: [], catalogSource: '', catalogAt: null, checkedAt: null, busy: false, lastTest: null, login: null, prefs: { model: null, effort: null } }] });
  assert.equal(s.ai[0].provider, 'claude');
  s = applyMessage(s, { kind: 'entity', entity: 'meeting', op: 'delete', item: { id: 'm1' } });
  assert.deepEqual(s.meetings.map(m => m.id), ['m2']);
  assert.equal(s.meetingHistory.m1, undefined);
});

test('reuniões: snapshot traz a lista e zera carregados/parciais; a união do histórico carregado com o ao vivo não duplica', () => {
  let s = applyMessage(emptyState(), { kind: 'meeting.delta', meetingId: 'm1', turnId: 't1', participantId: 'p1', text: 'par' });
  s = applyMessage(s, { kind: 'meeting.decision', meetingId: 'm1', op: 'upsert', decision: { id: 'd-velha', meetingId: 'm1', kind: 'proposal', text: 'apagada no servidor enquanto estávamos fora', participantId: 'p1', confirmed: false, dismissed: false, messageId: null, assigneeEmployeeId: null, createdAt: 1, updatedAt: 1 } });
  s = { ...s, meetingHistoryLoaded: { m1: true } };
  s = applyMessage(s, { kind: 'snapshot', snapshot: { ...snapshot, meetings: [meeting] } });
  assert.equal(s.meetings.length, 1);
  assert.deepEqual(s.meetingHistoryLoaded, {});
  assert.deepEqual(s.meetingHistory, {}, 'o histórico guardado cai no snapshot: nada apagado no servidor volta pela união');
  assert.deepEqual(s.meetingStreaming, {});
  const merged = mergeMeetingHistory({ messages: [msg('a'), msg('b')], turns: [], decisions: [], context: [], taskItems: [] }, { messages: [msg('b'), msg('c')], turns: [turn('t1', 'running')], decisions: [], context: [], taskItems: [] });
  assert.deepEqual(merged.messages.map(m => m.id), ['a', 'b', 'c']);
  assert.equal(merged.turns.length, 1);
});
