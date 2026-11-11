// Helpers da v4 na interface: rascunho e validação das rotinas (mesma regra do servidor), horários em Brasília e o resumo do
// Modo ausente (o que continua, o que espera, o que cada funcionário pode fazer sem perguntar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AbsencePolicy, Employee, Project, Routine, Task } from '@milweb-hq/protocol';
import { DEFAULT_ABSENCE } from '@milweb-hq/protocol';
import { draftFromRoutine, draftToInput, emptyRoutineDraft, formatWhen, lastRunLabel, routineDraftProblems, scheduleLabel } from '../src/shell/routinesHelpers';
import { MACHINE_CONDITIONS, absenceOverview, absencePatch, permissionMeaning } from '../src/shell/absenceHelpers';

const brt = (iso: string) => Date.parse(`${iso}-03:00`);

test('rotina: rascunho vazio pede pedido, funcionário e projeto; agenda inválida é barrada antes do servidor', () => {
  const d = emptyRoutineDraft();
  assert.deepEqual(routineDraftProblems(d), ['Escreva o pedido que a rotina vai repetir.', 'Escolha o funcionário responsável.', 'Escolha o projeto.']);
  const ok = { ...d, prompt: 'revise o site', employeeId: 'e1', projectId: 'p1' };
  assert.deepEqual(routineDraftProblems(ok), []);
  assert.match(routineDraftProblems({ ...ok, time: '9:00' })[0], /HH:MM/);
  assert.match(routineDraftProblems({ ...ok, kind: 'weekly', days: [] })[0], /dia da semana/);
  assert.match(routineDraftProblems({ ...ok, kind: 'interval', everyMinutes: 0 })[0], /Intervalo/);
  const input = draftToInput({ ...ok, kind: 'weekly', days: [3, 1, 3], skill: ' /sistema-web ', permissionMode: '' });
  assert.deepEqual(input.schedule, { kind: 'weekly', time: '09:00', days: [1, 3] });
  assert.equal(input.skill, 'sistema-web', 'barra e espaços tirados');
  assert.equal(input.permissionMode, null, 'vazio = as do funcionário');
});

test('rotina: editar parte da rotina salva; rótulos de agenda e horários em Brasília', () => {
  const r = { id: 'r1', title: 'Relatório', prompt: 'gere', employeeId: 'e1', projectId: 'p1', skill: 'hq-prova', schedule: { kind: 'weekly', time: '08:30', days: [1, 3] }, timezone: 'America/Sao_Paulo', enabled: true, permissionMode: 'acceptEdits', model: null, effort: null, missedPolicy: 'run_once', lastRunAt: brt('2026-11-01T08:30:00'), lastTaskId: 't1', nextRunAt: brt('2026-11-02T08:30:00'), lastSkipReason: null, createdAt: 0, updatedAt: 0 } as Routine;
  const d = draftFromRoutine(r);
  assert.equal(d.kind, 'weekly'); assert.deepEqual(d.days, [1, 3]); assert.equal(d.skill, 'hq-prova'); assert.equal(d.missedPolicy, 'run_once');
  assert.equal(scheduleLabel(r.schedule), 'seg, qua às 08:30');
  assert.equal(scheduleLabel({ kind: 'interval', everyMinutes: 45 }), 'a cada 45 min');
  const now = brt('2026-11-01T20:00:00');
  assert.equal(formatWhen(brt('2026-11-01T21:15:00'), now), 'hoje 21:15');
  assert.equal(formatWhen(brt('2026-11-02T00:40:00'), now), 'amanhã 00:40', 'virada do dia em Brasília');
  assert.equal(formatWhen(brt('2026-11-05T09:00:00'), now), '05/11 09:00');
  assert.equal(lastRunLabel(r, [{ id: 't1', status: 'done' } as Task], now), 'hoje 08:30 · concluída');
  assert.equal(lastRunLabel({ ...r, lastRunAt: null }, [], now), null);
});

test('modo ausente: o que continua, o que espera, permissões e próxima rotina vêm do estado real', () => {
  const projects = [{ id: 'pA', name: 'A' }, { id: 'pB', name: 'B' }, { id: 'ext:x', name: 'externo' }] as Project[];
  const employees = [{ id: 'bia', name: 'Bia', permissionMode: 'acceptEdits', archivedAt: null }, { id: 'caio', name: 'Caio', permissionMode: null, archivedAt: null }, { id: 'velho', name: 'Velho', archivedAt: 1 }] as unknown as Employee[];
  const tasks = [
    { id: 't1', status: 'queued', projectId: 'pA', employeeId: 'bia', prompt: 'na A' },
    { id: 't2', status: 'queued', projectId: 'pB', employeeId: 'caio', prompt: 'na B' },
    { id: 't3', status: 'queued', projectId: 'pA', employeeId: 'caio', prompt: 'segurada pelo Chefe', held: true, heldReason: 'Em espera até você liberar.' },
    { id: 't4', status: 'done', projectId: 'pA', employeeId: 'bia', prompt: 'feita' },
  ] as Task[];
  const routines = [
    { id: 'r1', title: 'cedo', enabled: true, nextRunAt: 100, projectId: 'pB', employeeId: 'caio' },
    { id: 'r2', title: 'na A', enabled: true, nextRunAt: 200, projectId: 'pA', employeeId: 'bia' },
  ] as Routine[];
  const policy: AbsencePolicy = { ...DEFAULT_ABSENCE, enabled: true, allowedProjectIds: ['pA'] };
  const ov = absenceOverview(policy, { projects, employees, tasks, routines, defaultPermissionMode: 'default' });
  assert.deepEqual(ov.allowedProjects.map(p => p.id), ['pA']);
  assert.deepEqual(ov.willRun.map(t => t.id), ['t1']);
  assert.deepEqual(ov.willWait.map(t => t.id), ['t2'], 'a segurada pelo Chefe não entra em nenhuma das duas');
  assert.equal(ov.nextRoutine?.routine.id, 'r2', 'só rotinas de projeto autorizado');
  assert.deepEqual(ov.actions.map(a => [a.employee.name, a.mode]), [['Bia', 'acceptEdits'], ['Caio', 'default']], 'arquivado fica de fora; sem modo próprio = padrão global');
  assert.match(ov.actions[1].meaning, /Aguardando Chefe/);
  const onlyBia = absenceOverview({ ...policy, allowedEmployeeIds: ['bia'], allowRoutines: false }, { projects, employees, tasks, routines, defaultPermissionMode: 'default' });
  assert.deepEqual(onlyBia.actions.map(a => a.employee.name), ['Bia']);
  assert.equal(onlyBia.nextRoutine, null);
  assert.match(absenceOverview({ ...policy, allowedProjectIds: [] }, { projects, employees, tasks, routines, defaultPermissionMode: 'default' }).warnings[0], /Nenhum projeto autorizado/);
  assert.match(permissionMeaning('plan'), /não altera nada/);
});

test('modo ausente: "desde" marca quando ligou e não muda ao salvar de novo; desligar zera; situações da máquina com evidência', () => {
  const off = { ...DEFAULT_ABSENCE };
  const on = absencePatch(off, { ...off, enabled: true, allowedProjectIds: ['pA'] }, 5000);
  assert.equal(on.since, 5000);
  assert.equal(absencePatch(on, { ...on, maxTasks: 3 }, 9000).since, 5000);
  assert.equal(absencePatch(on, { ...on, enabled: false }, 9000).since, null);
  assert.ok(MACHINE_CONDITIONS.every(c => ['ao vivo', 'simulado', 'não testado'].includes(c.verified)));
  assert.equal(MACHINE_CONDITIONS.find(c => /Desligar/.test(c.situation))?.effect, 'Para. Nada roda com o computador desligado.');
});

test('rotina com vários horários no dia: "10:00, 17:00" vira uma agenda só (sem duplicar a rotina) e volta igual para o formulário', async () => {
  const h = await import('../src/shell/routinesHelpers');
  const d = { ...h.emptyRoutineDraft({ employeeId: 'e', projectId: 'p' }), prompt: 'x', time: '17:00, 10:00' };
  assert.deepEqual(h.routineDraftProblems(d), []);
  assert.deepEqual(h.draftSchedule(d), { kind: 'daily', time: '10:00', times: ['10:00', '17:00'] });
  assert.equal(h.scheduleLabel(h.draftSchedule(d)), 'todo dia às 10:00 e 17:00');
  assert.equal(h.draftFromRoutine({ id: 'r', timezone: 'America/Sao_Paulo', lastRunAt: null, lastTaskId: null, nextRunAt: null, lastSkipReason: null, model: null, effort: null, createdAt: 1, updatedAt: 1, title: 't', prompt: 'x', employeeId: 'e', projectId: 'p', skill: null, schedule: { kind: 'daily', time: '10:00', times: ['10:00', '17:00'] }, missedPolicy: 'run_once', permissionMode: null, enabled: true }).time, '10:00, 17:00');
  assert.deepEqual(h.draftSchedule({ ...d, time: '09:00' }), { kind: 'daily', time: '09:00' });
  assert.ok(h.routineDraftProblems({ ...d, time: '10:00, 25:00' }).length > 0);
});
