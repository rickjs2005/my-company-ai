// Estados visíveis das tarefas do plano e contagem da caixa de entrada da mesa (mesma regra da insígnia e das abas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, PendingPermission, PlanTaskRecord, Task } from '@milweb-hq/protocol';
import { planTaskState } from '../src/meetings/PlanView';
import { deskItems } from '../src/shell/DeskInbox';

const rec = (p: Partial<PlanTaskRecord> = {}): PlanTaskRecord => ({ id: 'm:t1', meetingId: 'm', planVersion: 1, key: 't1', spec: { key: 't1', title: 'Post', objective: '', employeeId: 'e', employeeName: 'Bia', projectId: 'p', slot: null, context: '', references: [], skill: null, deliverable: '', criteria: [], priority: 'media', dependsOn: [], deadline: null, deadlineProposed: false }, status: 'created', taskId: 't', sessionId: 's', blockedReason: null, createdAt: 1, updatedAt: 1, ...p });
const task = (p: Partial<Task> = {}): Task => ({ id: 't', sessionId: 's', projectId: 'p', roomId: 'r', prompt: 'Post', attachments: [], status: 'queued', createdAt: 1, errors: [], deliverables: [], touchedFiles: [], ...p });

test('estado da tarefa do plano: fila, dependência, trabalhando, aguardando Chefe, entregue (não aprovada), falhou, bloqueada', () => {
  assert.equal(planTaskState(rec(), task()).label, 'Na fila');
  assert.equal(planTaskState(rec(), task({ held: true, heldReason: 'Aguardando dependência: Rascunho' })).label, 'Aguardando dependência');
  assert.equal(planTaskState(rec(), task({ status: 'running' })).label, 'Trabalhando');
  assert.equal(planTaskState(rec(), task({ status: 'waiting_answer' })).label, 'Aguardando Chefe');
  const done = planTaskState(rec(), task({ status: 'done' }));
  assert.equal(done.label, 'Entregue'); assert.doesNotMatch(done.label, /aprovad/i);
  assert.equal(planTaskState(rec(), task({ status: 'error', errors: ['caiu'] })).label, 'Falhou');
  assert.equal(planTaskState(rec({ status: 'blocked', blockedReason: 'ninguém apto' }), null).label, 'Bloqueada');
});

test('caixa de entrada: entregas novas, perguntas e bloqueios (autorização, falta de gente, falha, espera) somam no contador', () => {
  const desk: DeskState = { deliveries: [{ id: 'd1', taskId: 't1', rootTaskId: 't1', version: 1, meetingId: 'm', meetingTitle: 'R', planTaskId: null, employeeId: 'e', title: 'Post', slot: null, profileId: null, summary: '', files: [], links: [], criteria: [], status: 'nova', note: null, adjustTaskId: null, createdAt: 1, seenAt: null, decidedAt: null }, { id: 'd0', taskId: 't0', rootTaskId: 't0', version: 1, meetingId: null, meetingTitle: null, planTaskId: null, employeeId: 'e', title: 'Velha', slot: null, profileId: null, summary: '', files: [], links: [], criteria: [], status: 'aprovada', note: null, adjustTaskId: null, createdAt: 1, seenAt: 1, decidedAt: 1 }], needs: [{ id: 'n1', meetingId: 'm', meetingTitle: 'R', planTaskId: null, text: 'ninguém apto', createdAt: 1, resolvedAt: null }, { id: 'n2', meetingId: 'm', meetingTitle: 'R', planTaskId: null, text: 'resolvida', createdAt: 1, resolvedAt: 2 }] };
  const pending = [{ sessionId: 's', taskId: 't', isQuestion: true, questions: [], request: { requestId: 'q1', toolName: 'AskUserQuestion', input: {} } }, { sessionId: 's', taskId: 't', isQuestion: false, request: { requestId: 'p1', toolName: 'WebFetch', input: { url: 'https://x' } } }] as unknown as PendingPermission[];
  const tasks = [task({ id: 'f1', origin: 'meeting', status: 'error' }), task({ id: 'h1', held: true, heldReason: 'Claude em pausa até 18:05' }), task({ id: 'h2', held: true, heldReason: 'Aguardando dependência: X' })];
  const c = deskItems(desk, pending, tasks).counts;
  assert.deepEqual(c, { entregas: 1, perguntas: 1, bloqueios: 4, total: 6 });
});
