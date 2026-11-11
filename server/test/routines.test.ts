// Rotinas (v4): agenda em America/Sao_Paulo, um horário = no máximo uma tarefa, execução anterior aberta não empilha,
// horário perdido pula ou roda uma vez (nunca acumula). Relógio simulado; tarefas reais pelo gerenciador com o CLI falso.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Routine, RoutineInput, ServerMessage } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import { LATE_TOLERANCE_MS, RoutineService, nextRunAt, scheduleLabel, scheduleProblem } from '../src/routines.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.resolve(here, '..', '..', 'packages', 'claude-bridge', 'test', 'fake-claude.mjs');
const brt = (iso: string) => Date.parse(`${iso}-03:00`); // horário de Brasília (sem horário de verão desde 2019)

test('agenda: diário, semanal e intervalo em Brasília; validação e rótulos', () => {
  // 01/11/2026 é domingo.
  assert.equal(nextRunAt({ kind: 'daily', time: '09:00' }, brt('2026-11-01T08:59:00')), brt('2026-11-01T09:00:00'));
  assert.equal(nextRunAt({ kind: 'daily', time: '09:00' }, brt('2026-11-01T09:00:00')), brt('2026-11-02T09:00:00'), 'estritamente depois');
  assert.equal(nextRunAt({ kind: 'daily', time: '00:30' }, brt('2026-11-01T23:50:00')), brt('2026-11-02T00:30:00'), 'virada do dia em Brasília, não em UTC');
  assert.equal(nextRunAt({ kind: 'weekly', time: '08:30', days: [1, 3] }, brt('2026-11-01T10:00:00')), brt('2026-11-02T08:30:00'), 'domingo → segunda');
  assert.equal(nextRunAt({ kind: 'weekly', time: '08:30', days: [1, 3] }, brt('2026-11-02T08:30:00')), brt('2026-11-04T08:30:00'), 'segunda depois do horário → quarta');
  assert.equal(nextRunAt({ kind: 'weekly', time: '07:00', days: [0] }, brt('2026-11-01T07:00:00')), brt('2026-11-08T07:00:00'), 'mesma semana já passou → próxima');
  assert.equal(nextRunAt({ kind: 'interval', everyMinutes: 30 }, 1_000_000), 1_000_000 + 30 * 60_000);
  assert.match(scheduleProblem({ kind: 'daily', time: '9h' }) ?? '', /HH:MM/);
  assert.match(scheduleProblem({ kind: 'weekly', time: '09:00', days: [] }) ?? '', /dia da semana/);
  assert.match(scheduleProblem({ kind: 'interval', everyMinutes: 0 }) ?? '', /Intervalo/);
  assert.equal(scheduleProblem({ kind: 'interval', everyMinutes: 15 }), null);
  assert.equal(scheduleLabel({ kind: 'weekly', time: '08:30', days: [3, 1] }), 'seg, qua às 08:30');
  assert.equal(scheduleLabel({ kind: 'interval', everyMinutes: 120 }), 'a cada 2 h');
});

function setup(start: number) {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.seedDefaultRooms();
  store.saveSettings({ pauseNewTasks: true }); // as tarefas das rotinas ficam na fila: o teste é do agendador, não da execução
  const projDir = tempDir('hq-rot-');
  const room = store.listRooms()[0];
  const project = store.createProject({ name: 'Projeto teste', path: projDir, roomId: room.id });
  const manager = new SessionManager({ store, exePath: () => process.execPath, attachmentsDir: os.tmpdir(), commandPrefixArgs: [fakeClaude] });
  const leo = manager.createEmployee({ roomId: room.id, name: 'Léo' });
  const msgs: ServerMessage[] = [];
  let now = start;
  const routines = new RoutineService({ store, manager, broadcast: m => msgs.push(m), log: { info() {}, warn() {} }, now: () => now });
  const base: RoutineInput = { title: 'Relatório', prompt: 'gere o relatório', employeeId: leo.id, projectId: project.id, skill: null, schedule: { kind: 'daily', time: '09:00' }, enabled: true, permissionMode: null, model: null, effort: null, missedPolicy: 'skip' };
  const create = (over: Partial<RoutineInput> = {}) => routines.handle({ type: 'routine.create', reqId: 'r', routine: { ...base, ...over } }) as Promise<Routine>;
  const tasks = () => store.listTasks().filter(t => t.routineId);
  return { store, manager, routines, msgs, leo, project, create, tasks, setNow: (t: number) => { now = t; }, cleanup: async () => { routines.stop(); await manager.shutdown(); fs.rmSync(projDir, { recursive: true, force: true }); } };
}

test('rotina: cadastro valida; no horário cria UMA tarefa com origem routine; repetir a checagem não duplica; execução aberta não empilha', async () => {
  const s = setup(brt('2026-11-01T08:00:00'));
  try {
    await assert.rejects(s.create({ prompt: '  ' }), /Escreva o pedido/);
    await assert.rejects(s.create({ employeeId: 'x' }), /não existe mais/);
    await assert.rejects(s.create({ schedule: { kind: 'daily', time: '25:00' } }), /HH:MM/);
    const r = await s.create();
    assert.equal(r.nextRunAt, brt('2026-11-01T09:00:00')); assert.equal(r.timezone, 'America/Sao_Paulo');
    assert.ok(s.msgs.some(m => m.kind === 'routine' && m.op === 'upsert'));
    await s.routines.tick();
    assert.equal(s.tasks().length, 0, 'antes do horário, nada');
    s.setNow(brt('2026-11-01T09:00:20'));
    await s.routines.tick(); await s.routines.tick();
    assert.equal(s.tasks().length, 1, 'um horário = uma tarefa, mesmo com duas checagens');
    const t = s.tasks()[0];
    assert.equal(t.origin, 'routine'); assert.equal(t.routineId, r.id); assert.equal(t.employeeId, s.leo.id);
    assert.equal(s.store.findTaskByClientId(`routine:${r.id}:${brt('2026-11-01T09:00:00')}`)?.id, t.id, 'identidade da execução = rotina + horário');
    const after = s.store.getRoutine(r.id)!;
    assert.equal(after.lastTaskId, t.id); assert.equal(after.nextRunAt, brt('2026-11-02T09:00:00'));
    // Próximo horário com a tarefa anterior ainda aberta (na fila): não cria outra, registra o motivo e agenda o seguinte.
    s.setNow(brt('2026-11-02T09:00:05'));
    await s.routines.tick();
    assert.equal(s.tasks().length, 1, 'não empilha');
    const skipped = s.store.getRoutine(r.id)!;
    assert.match(skipped.lastSkipReason ?? '', /não disparou: a execução anterior ainda está na fila/);
    assert.equal(skipped.nextRunAt, brt('2026-11-03T09:00:00'));
    await assert.rejects(s.routines.handle({ type: 'routine.runNow', reqId: 'r', id: r.id }), /execução anterior/);
  } finally { await s.cleanup(); }
});

test('horário perdido: "pular" não roda e agenda o próximo; "rodar uma vez" roda UMA vez mesmo depois de dias desligada', async () => {
  const s = setup(brt('2026-11-01T08:00:00'));
  try {
    const skip = await s.create({ title: 'pula', missedPolicy: 'skip' });
    const once = await s.create({ title: 'uma vez', missedPolicy: 'run_once', schedule: { kind: 'interval', everyMinutes: 60 } });
    // HQ "desligada" por 3 dias: vários horários passaram (3 diários, ~72 do intervalo).
    s.setNow(brt('2026-11-04T10:00:00'));
    await s.routines.tick();
    const rs = s.store.getRoutine(skip.id)!; const ro = s.store.getRoutine(once.id)!;
    assert.equal(s.tasks().filter(t => t.routineId === skip.id).length, 0);
    assert.match(rs.lastSkipReason ?? '', /perdido .*pulado/);
    assert.equal(rs.nextRunAt, brt('2026-11-05T09:00:00'));
    assert.equal(s.tasks().filter(t => t.routineId === once.id).length, 1, 'só uma execução, nada acumulado');
    assert.match(ro.lastSkipReason ?? '', /rodou uma vez ao voltar/);
    assert.equal(ro.nextRunAt, brt('2026-11-04T11:00:00'));
    // Atraso dentro da tolerância (checagem atrasada, não suspensão) dispara normalmente.
    const daily = await s.create({ title: 'tolerância', schedule: { kind: 'daily', time: '10:30' } });
    s.setNow(brt('2026-11-04T10:30:00') + LATE_TOLERANCE_MS - 1000);
    await s.routines.tick();
    assert.equal(s.tasks().filter(t => t.routineId === daily.id).length, 1);
  } finally { await s.cleanup(); }
});

test('rotina: executar agora, desligar, mudar a agenda e apagar (as tarefas já criadas continuam)', async () => {
  const s = setup(brt('2026-11-01T08:00:00'));
  try {
    const r = await s.create({ schedule: { kind: 'interval', everyMinutes: 30 } });
    const res = await s.routines.handle({ type: 'routine.runNow', reqId: 'r', id: r.id }) as { taskId: string };
    assert.equal(s.store.getTask(res.taskId)?.origin, 'routine');
    assert.equal(s.store.getRoutine(r.id)!.nextRunAt, r.nextRunAt, 'manual não mexe na agenda');
    const off = await s.routines.handle({ type: 'routine.update', reqId: 'r', id: r.id, patch: { enabled: false } }) as Routine;
    assert.equal(off.enabled, false); assert.equal(off.nextRunAt, null);
    s.setNow(brt('2026-11-01T12:00:00')); await s.routines.tick();
    assert.equal(s.tasks().length, 1, 'desligada não dispara');
    const on = await s.routines.handle({ type: 'routine.update', reqId: 'r', id: r.id, patch: { enabled: true, schedule: { kind: 'daily', time: '13:15' } } }) as Routine;
    assert.equal(on.nextRunAt, brt('2026-11-01T13:15:00'));
    await s.routines.handle({ type: 'routine.delete', id: r.id });
    assert.equal(s.store.getRoutine(r.id), null);
    assert.ok(s.store.getTask(res.taskId), 'a tarefa criada antes continua existindo');
  } finally { await s.cleanup(); }
});
