import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialActivity, reduceActivity, summarizeToolInput } from '../src/activity.js';
import type { ActivityState, LogEntry, RawEvent } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Reaplica um registro real de eventos (fixture gravada do CLI 2.1.314) e devolve a trilha de fases. */
function replay(file: string) {
  const lines = fs.readFileSync(path.join(here, 'fixtures', file), 'utf8').split('\n').filter(Boolean);
  let state: ActivityState = initialActivity();
  const phases: string[] = [];
  const log: LogEntry[] = [];
  for (const line of lines) {
    const ev = JSON.parse(line) as RawEvent;
    const out = reduceActivity(state, ev, 1000);
    state = out.state; log.push(...out.log);
    if (phases[phases.length - 1] !== state.phase) phases.push(state.phase);
  }
  return { state, phases, log };
}

test('summarizeToolInput descreve a ferramenta a partir do input real', () => {
  assert.equal(summarizeToolInput('Read', { file_path: 'C:\\x\\y\\index.html' }), 'Lendo index.html');
  assert.equal(summarizeToolInput('Bash', { command: 'npm test', description: 'Run tests' }), 'Executando: Run tests');
  assert.equal(summarizeToolInput('Bash', { command: 'npm test' }), 'Executando: npm test');
  assert.equal(summarizeToolInput('mcp__playwright__browser_navigate', { url: 'x' }), 'Usando playwright › browser_navigate');
});

test('prova 2 real: permissão → executando → pergunta → tarefa em segundo plano', () => {
  const { phases, log, state } = replay('probe2.jsonl');
  assert.ok(phases.includes('waiting_permission'), 'deve passar por aguardando permissão: ' + phases.join(','));
  assert.ok(phases.includes('executing'), 'deve passar por executando');
  assert.ok(phases.includes('waiting_answer'), 'deve passar por aguardando resposta');
  assert.ok(phases.includes('done'), 'deve terminar turnos com done');
  assert.ok(log.some(l => l.kind === 'permission' && /echo probe2/.test(JSON.stringify(l.data))), 'registro da permissão com o comando real');
  assert.ok(log.some(l => l.kind === 'question'), 'registro da pergunta');
  assert.ok(log.some(l => l.kind === 'task_start' && /segundo plano/.test(l.summary)), 'tarefa em segundo plano registrada');
  assert.ok(log.some(l => l.kind === 'task_end' && l.ok === true), 'tarefa concluída registrada');
  assert.ok(!log.some(l => /subagente/i.test(l.summary)), 'nenhum subagente inventado: a prova não usou Agent');
  assert.equal(state.turnActive, false);
});

test('prova 3 real: interrupção vira idle "Interrompido", negação registrada, sem erro falso', () => {
  const { phases, log } = replay('probe3.jsonl');
  const results = log.filter(l => l.kind === 'result' || l.kind === 'error');
  assert.ok(results.some(l => l.summary === 'Turno interrompido'), 'interrupção identificada pelo terminal_reason');
  assert.equal(log.filter(l => l.summary === 'Turno interrompido').length, 2, 'duas interrupções reais (texto e comando)');
  assert.ok(log.some(l => l.kind === 'permission_decision' && l.ok === false) || log.some(l => l.kind === 'tool_end' && l.ok === false && /negou/.test(String(l.data?.output))), 'negação aparece no registro');
  assert.ok(phases.includes('responding'), 'texto chegando vira responding');
  assert.ok(!phases.includes('error'), 'interrupção não é tratada como erro do Claude');
});

test('eventos sintéticos do bridge: prompt, interrupção e desconexão', () => {
  let s = initialActivity();
  let out = reduceActivity(s, { type: 'hq_prompt', text: 'crie uma landing page' }, 1);
  s = out.state;
  assert.equal(s.phase, 'thinking');
  assert.equal(out.log[0].kind, 'prompt');
  out = reduceActivity(s, { type: 'hq_disconnected', reason: 'processo encerrou com código 1' }, 2);
  assert.equal(out.state.phase, 'disconnected');
  assert.equal(out.state.turnActive, false);
});
