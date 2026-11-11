// Coordenador da sala de reunião com adaptadores falsos (mesmo contrato dos reais) e banco em memória.
// Cobre: criação, falas com destino/menção, decisão do Chefe, debate com rodadas e síntese, interrupção/pausa/retomada,
// provedor indisponível, configuração inválida sem substituição silenciosa, recuperação após queda, encerramento com ata,
// criação idempotente de tarefas em espera, contexto com arquivo e limite de execuções simultâneas.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiModelOption, AiProviderId, AiProviderStatus, AiTestResult, EffortLevel, Meeting, MeetingContextItem, MeetingTaskItem, ServerMessage, Session, Task, TaskRunResult } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { MeetingStore } from '../src/meetings/store.js';
import { MeetingController, type MeetingManagerLike } from '../src/meetings/controller.js';
import { AiRegistry } from '../src/ai/registry.js';
import type { AiAdapter, AiAdapterEvents, TurnHandle, TurnOutcome, TurnRequest, ValidationResult } from '../src/ai/types.js';
import { parseSynthesis, chefeDecisionText, parseMentions, renderMinutes } from '../src/meetings/prompts.js';

class FakeAdapter extends EventEmitter<AiAdapterEvents> implements AiAdapter {
  calls: TurnRequest[] = [];
  auth: 'ok' | 'missing' = 'ok';
  installed = true;
  delayMs = 4;
  /** Próximo turno com threadId falha como "sessão perdida" (threadId null no resultado), uma vez. */
  loseSessionOnce = false;
  /** Próximos turnos param pelo provedor (limite de uso, modelo recusado) com esta parada. */
  stopNext: TurnOutcome['stop'] = null;
  lastTestOk: AiTestResult | null = null;
  reply: (req: TurnRequest) => string;
  /** Plano em JSON devolvido quando o turno é a consolidação (null = responde texto comum, sem JSON). */
  planFor: ((req: TurnRequest) => unknown) | null = null;
  private interruptors = new Map<string, () => void>();
  constructor(readonly provider: AiProviderId, readonly label: string, readonly catalog: AiModelOption[]) {
    super();
    this.reply = req => `${label} responde (${req.model ?? 'padrão'}/${req.effort ?? 'padrão'}) sobre: ${req.text.slice(-40).replace(/\s+/g, ' ')}`;
  }
  status(): AiProviderStatus {
    return { provider: this.provider, label: this.label, routeLabel: 'falso', installed: this.installed, exePath: this.installed ? 'fake' : null, version: '0', latestKnownVersion: null, authState: this.installed ? this.auth : 'missing', authMethod: this.auth === 'ok' ? 'teste' : null, authDetail: this.auth === 'ok' ? null : `${this.label} sem login`, models: this.catalog, catalogSource: 'falso', catalogAt: 1, checkedAt: 1, busy: false, lastTest: this.lastTestOk, login: null, prefs: { model: null, effort: null } };
  }
  async refresh() { return this.status(); }
  models() { return this.catalog; }
  validate(model: string | null, effort: EffortLevel | null): ValidationResult {
    const entry = model ? this.catalog.find(m => m.id === model) : null;
    if (model && !entry) return { ok: false, reason: `modelo desconhecido: ${model}`, model, effort, alternatives: [] };
    const efforts: EffortLevel[] = entry ? entry.efforts : ['low', 'medium', 'high'];
    if (effort && !efforts.includes(effort)) return { ok: false, reason: `aceita: ${efforts.join(', ')}`, model, effort, alternatives: efforts };
    return { ok: true, model, effort, note: null };
  }
  startTurn(req: TurnRequest): TurnHandle {
    this.calls.push(req);
    let interrupted = false; let timer: NodeJS.Timeout | null = null;
    const isPlan = req.text.includes('ENCERRAR A REUNIÃO E DISTRIBUIR AS TAREFAS');
    const words = (isPlan && this.planFor ? `Plano consolidado por ${this.label}.\n\n\`\`\`json\n${JSON.stringify(this.planFor(req))}\n\`\`\`` : this.reply(req)).split(' ');
    const threadId = req.threadId ?? `${this.provider}-thread-${this.calls.length}`;
    const applied = { model: req.model, effort: req.effort, resolvedModel: req.model ? `${req.model}-resolvido` : null };
    if (this.stopNext) {
      const stop = this.stopNext;
      return { done: Promise.resolve({ status: 'failed' as const, text: '', threadId: req.threadId, applied, error: stop.reason, durationMs: 1, usage: null, stop }), interrupt: async () => undefined };
    }
    if (this.loseSessionOnce && req.threadId) {
      this.loseSessionOnce = false;
      return { done: Promise.resolve({ status: 'failed' as const, text: '', threadId: null, applied, error: 'sessão sumiu (falso)', durationMs: 1, usage: null }), interrupt: async () => undefined };
    }
    const done = new Promise<TurnOutcome>(resolve => {
      let i = 0; let acc = '';
      const tick = () => {
        if (interrupted) { resolve({ status: 'interrupted', text: acc, threadId, applied, error: null, durationMs: 1, usage: null }); return; }
        if (i < words.length) { acc += (acc ? ' ' : '') + words[i++]; req.onDelta?.(acc); timer = setTimeout(tick, this.delayMs); }
        else resolve({ status: 'done', text: acc, threadId, applied, error: null, durationMs: 3, usage: { inputTokens: 10, outputTokens: 5 } });
      };
      timer = setTimeout(tick, this.delayMs);
      this.interruptors.set(req.turnId, () => { if (interrupted) return; interrupted = true; if (timer) clearTimeout(timer); tick(); });
    });
    return { done, interrupt: async () => { this.interruptors.get(req.turnId)?.(); } };
  }
  async test(model: string | null, effort: EffortLevel | null): Promise<AiTestResult> { return { at: 1, ok: true, model, effort, resolvedModel: model, detail: 'ok', durationMs: 1 }; }
  async shutdown() { /* nada */ }
}

const CLAUDE_MODELS: AiModelOption[] = [
  { id: 'fable', label: 'fable (alias)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', alias: true, resolvesTo: 'claude-fable-5-1' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' },
];
const GPT_MODELS: AiModelOption[] = [
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: true },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex mini', efforts: ['medium', 'high'], defaultEffort: 'medium' },
];

function setup(opts: { activeTurns?: () => number } = {}) {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.seedDefaultRooms();
  const dataDir = tempDir('hq-meet-');
  const projDir = tempDir('hq-meet-proj-');
  const devRoom = store.listRooms().find(r => r.kind === 'dev')!;
  const project = store.createProject({ name: 'Projeto X', path: projDir, roomId: devRoom.id });
  const employee = store.createEmployee({ name: 'Léo', role: 'Desenvolvimento', roomId: devRoom.id, appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0 });
  const msgs: ServerMessage[] = [];
  const broadcast = (m: ServerMessage) => { msgs.push(m); };
  const claude = new FakeAdapter('claude', 'Claude', CLAUDE_MODELS);
  const openai = new FakeAdapter('openai', 'ChatGPT', GPT_MODELS);
  const registry = new AiRegistry({ store, adapters: [claude, openai], broadcast, testCwd: dataDir });
  const prompts: { sessionId: string; clientId: string; text: string; held?: boolean; meetingId?: string | null }[] = [];
  const released: string[] = [];
  let finishedHandler: (() => void) | null = null;
  let taskFinishedHandler: ((taskId: string) => void) | null = null;
  const runs: { clientId: string; employeeId: string; held?: boolean; heldReason?: string | null; skill: string | null; text: string; destinationId?: string | null }[] = [];
  const manager: MeetingManagerLike = {
    activeTurns: opts.activeTurns ?? (() => 0),
    on: ((ev: string, fn: (...a: never[]) => void) => { if (ev === 'turn_finished') finishedHandler = fn as () => void; else taskFinishedHandler = fn as (id: string) => void; }) as MeetingManagerLike['on'],
    runTask: async (input, extra) => {
      const dup = store.findTaskByClientId(input.clientId);
      const e = store.getEmployee(input.employeeId)!;
      if (dup) return { taskId: dup.id, sessionId: dup.sessionId, employeeId: e.id, projectId: input.projectId, status: dup.status, queuePosition: null, queueReason: null, newSession: false, applied: { model: null, effort: null, permissionMode: 'default', source: 'teste' }, notes: [] } as unknown as TaskRunResult;
      if (input.skill === 'skill-inexistente') throw new Error('A skill "skill-inexistente" não foi encontrada nesta máquina.');
      const sess = store.listSessionsByEmployee(e.id)[0] ?? store.createSession({ roomId: e.roomId, projectId: input.projectId, employeeId: e.id, name: e.name, permissionMode: 'default', workerName: e.name, appearance: e.appearance, deskIndex: 0 } as never);
      const t = store.createTask({ clientId: input.clientId, sessionId: sess.id, projectId: input.projectId, roomId: e.roomId, prompt: input.text, attachments: [], mode: 'queue', employeeId: e.id, held: extra?.held, heldReason: extra?.heldReason ?? null, meetingId: extra?.meetingId ?? null, origin: extra?.origin, destinationId: input.destinationId ?? null });
      runs.push({ clientId: input.clientId, employeeId: e.id, held: extra?.held, heldReason: extra?.heldReason, skill: input.skill, text: input.text, destinationId: input.destinationId });
      return { taskId: t.id, sessionId: sess.id, employeeId: e.id, projectId: input.projectId, status: 'queued', queuePosition: 1, queueReason: null, newSession: false, applied: { model: null, effort: null, permissionMode: 'default', source: 'teste' }, notes: [] } as unknown as TaskRunResult;
    },
    createSession: (input) => store.createSession({ roomId: input.roomId, projectId: input.projectId, employeeId: input.employeeId ?? null, name: input.name ?? 'S', permissionMode: 'default', workerName: 'Léo', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0 }) as Session,
    sendPrompt: async (input) => {
      const existing = store.findTaskByClientId(input.clientId); if (existing) return existing;
      prompts.push(input);
      const s = store.getSession(input.sessionId)!;
      return store.createTask({ clientId: input.clientId, sessionId: s.id, projectId: s.projectId, roomId: s.roomId, prompt: input.text, attachments: [], mode: 'queue', held: input.held, meetingId: input.meetingId }) as Task;
    },
    releaseTask: (id) => { released.push(id); store.updateTask(id, { held: false, heldReason: null }); },
  };
  const meetings = new MeetingStore(db);
  const controller = new MeetingController({ store, meetings, registry, manager, dataDir, broadcast, turnTimeoutMs: 5000 });
  const waitIdle = async (meetingId: string, ms = 8000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const m = meetings.getMeeting(meetingId)!;
      if (!m.activeTurnId && meetings.countQueued(m.id) === 0) return m;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('timeout esperando a reunião ficar ociosa');
  };
  const waitUntil = async (pred: () => boolean, ms = 5000) => {
    const start = Date.now();
    while (Date.now() - start < ms) { if (pred()) return; await new Promise(r => setTimeout(r, 5)); }
    throw new Error('timeout esperando condição');
  };
  const create = async (extra: Partial<{ mode: 'guided' | 'debate'; roundLimit: number; agenda: string; participants: { provider: AiProviderId; employeeId?: string | null; model?: string | null; effort?: EffortLevel | null }[] }> = {}) => {
    const r = await controller.handle({ type: 'meeting.create', reqId: 'r', title: 'Pauta de teste', agenda: extra.agenda ?? 'Decidir o stack do site novo', projectId: project.id, mode: extra.mode ?? 'guided', roundLimit: extra.roundLimit, participants: extra.participants ?? [{ provider: 'claude' }, { provider: 'openai' }] }) as { meeting: Meeting };
    return r.meeting;
  };
  return {
    db, store, meetings, controller, registry, claude, openai, project, projDir, dataDir, employee, msgs, prompts, released, waitIdle, waitUntil, create, runs,
    fireTurnFinished: () => finishedHandler?.(),
    finishTask: (id: string, status: Task['status'] = 'done', resultText = 'feito') => { store.updateTask(id, { status, finishedAt: Date.now(), resultText }); taskFinishedHandler?.(id); },
    cleanup: async () => { await controller.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(projDir, { recursive: true, force: true }); },
  };
}

test('criar reunião: Chefe + Claude + ChatGPT com estados reais e transmissão da entidade', async () => {
  const s = setup();
  try {
    const m = await s.create();
    assert.equal(m.status, 'draft');
    assert.deepEqual(m.participants.map(p => p.name), ['Chefe', 'Claude', 'ChatGPT']);
    assert.deepEqual(m.participants.map(p => p.seat), [0, 1, 2]);
    assert.ok(m.participants.every(p => p.state === 'available'));
    assert.ok(s.msgs.some(x => x.kind === 'entity' && x.entity === 'meeting' && (x.item as Meeting).id === m.id));
    await assert.rejects(s.controller.handle({ type: 'meeting.participant.add', reqId: 'x', meetingId: m.id, participant: { provider: 'claude' } }), /já participa/);
    assert.equal(s.controller.list().length, 1);
  } finally { await s.cleanup(); }
});

test('fala do Chefe para todos: um turno por participante, sequenciais, com config aplicada, deltas e dedup por clientId', async () => {
  const s = setup();
  try {
    const m = await s.create();
    const r = await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: 'O que vocês acham de usar Next.js?', targets: [] }) as { turns: { id: string }[] };
    assert.equal(r.turns.length, 2);
    const again = await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: 'O que vocês acham de usar Next.js?', targets: [] }) as { turns: unknown[] };
    const done = await s.waitIdle(m.id);
    assert.equal(done.status, 'active');
    assert.equal(s.claude.calls.length, 1); assert.equal(s.openai.calls.length, 1);
    assert.ok(s.claude.calls[0].text.includes('O que vocês acham de usar Next.js?'), 'a fala do Chefe vai no pacote de contexto');
    assert.ok(s.claude.calls[0].systemPrompt.includes('Você é Claude'));
    assert.ok(s.openai.calls[0].text.includes('Claude responde'), 'o segundo turno viu a fala real do primeiro (sequencial)');
    const h = s.controller.history(m.id);
    assert.deepEqual(h.messages.filter(x => x.kind !== 'notice').map(x => x.authorName), ['Chefe', 'Claude', 'ChatGPT']);
    const speech = h.messages.find(x => x.authorName === 'Claude')!;
    assert.equal(speech.kind, 'speech'); assert.equal(speech.provider, 'claude'); assert.equal(speech.partial, false);
    assert.deepEqual(speech.config, { model: null, effort: null, resolvedModel: null });
    assert.equal(h.turns.length, 2);
    assert.ok(h.turns.every(t => t.status === 'done' && t.usage?.inputTokens === 10 && t.promptChars > 0));
    assert.equal(again.turns.length, 0, 'reenvio com o mesmo clientId não cria turnos');
    assert.equal(h.messages.filter(x => x.kind === 'chefe').length, 1);
    const deltas = s.msgs.filter(x => x.kind === 'meeting.delta');
    assert.ok(deltas.length >= 3, 'texto parcial transmitido');
    assert.ok(deltas.some(d => d.kind === 'meeting.delta' && d.text === ''), 'delta vazio ao terminar');
    const fresh = s.meetings.getMeeting(m.id)!;
    assert.ok(fresh.participants.filter(p => p.kind === 'ai').every(p => p.state === 'waiting_chefe' && p.threadId));
  } finally { await s.cleanup(); }
});

test('menção @ChatGPT responde só o ChatGPT; "Decisão:" do Chefe vira decisão confirmada sem turno', async () => {
  const s = setup();
  try {
    const m = await s.create();
    const r = await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: '@ChatGPT você concorda?', targets: [] }) as { turns: { participantId: string }[] };
    assert.equal(r.turns.length, 1);
    assert.equal(m.participants.find(p => p.id === r.turns[0].participantId)?.name, 'ChatGPT');
    await s.waitIdle(m.id);
    assert.equal(s.claude.calls.length, 0);
    const d = await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c2', text: 'Decisão: vamos de Next.js com Tailwind', targets: [] }) as { turns: unknown[] };
    assert.equal(d.turns.length, 0);
    const h = s.controller.history(m.id);
    const dec = h.decisions.find(x => x.kind === 'decision')!;
    assert.equal(dec.text, 'vamos de Next.js com Tailwind'); assert.equal(dec.confirmed, true); assert.equal(dec.participantId, null);
  } finally { await s.cleanup(); }
});

test('discutir a pauta: opiniões, revisão e síntese na ordem; síntese vira quadro não confirmado; mais uma rodada respeita o teto', async () => {
  const s = setup();
  try {
    s.claude.reply = req => req.text.includes('Faça a síntese') ? '## Propostas\n- Usar Next.js\n- Hospedar na Vercel\n## Divergências\n- ChatGPT prefere Astro\n## Perguntas abertas\n- Qual o prazo?\n## Próximas ações\n- [Léo] montar o esqueleto\n- medir o Lighthouse' : `Claude: ${req.text.includes('Revise sua posição') ? 'revisão' : 'opinião'}`;
    s.openai.reply = req => (req.text.includes('Revise sua posição') ? 'ChatGPT: revisão.\nProposta:  usar   Astro' : 'ChatGPT: opinião.\nProposta: usar Astro'); // espaços a mais na 2ª: mesmo item
    const m = await s.create({ mode: 'debate', roundLimit: 2 });
    const r = await s.controller.handle({ type: 'meeting.discuss', reqId: 'r', meetingId: m.id, clientId: 'd1' }) as { turns: { phase: string; round: number }[] };
    assert.deepEqual(r.turns.map(t => `${t.phase}${t.round}`), ['opinion1', 'opinion1', 'revision2', 'revision2', 'synthesis2']);
    await assert.rejects(s.controller.handle({ type: 'meeting.discuss', reqId: 'r', meetingId: m.id, clientId: 'd2' }), /já existe turno/);
    const done = await s.waitIdle(m.id, 10_000);
    assert.equal(done.currentRound, 2);
    const h = s.controller.history(m.id);
    assert.ok(h.turns.every(t => t.status === 'done'), JSON.stringify(h.turns.map(t => [t.phase, t.status, t.error])));
    assert.equal(s.claude.calls.length, 3); assert.equal(s.openai.calls.length, 2);
    assert.ok(s.claude.calls[1].text.includes('ChatGPT: opinião'), 'a revisão viu a opinião real do outro');
    const kinds = h.decisions.map(d => d.kind).sort();
    assert.deepEqual(kinds, ['action', 'action', 'divergence', 'proposal', 'proposal', 'proposal', 'question'], 'a mesma "Proposta: usar Astro" nas duas rodadas entra uma vez só no quadro');
    assert.ok(h.decisions.every(d => !d.confirmed), 'concordância dos modelos não confirma nada');
    const action = h.decisions.find(d => d.kind === 'action' && d.text === 'montar o esqueleto')!;
    assert.equal(action.assigneeEmployeeId, s.employee.id, 'responsável casado pelo nome do funcionário');
    assert.ok(h.decisions.some(d => d.kind === 'proposal' && d.text === 'usar Astro'), 'linha "Proposta:" numa fala comum entra no quadro');
    await s.controller.handle({ type: 'meeting.anotherRound', meetingId: m.id });
    const m2 = s.meetings.getMeeting(m.id)!;
    assert.equal(m2.roundLimit, 3);
    const queued = s.meetings.listTurnsByStatus(['queued', 'running'], m.id).map(t => `${t.phase}${t.round}`);
    assert.deepEqual(queued.length, 3);
    await s.waitIdle(m.id, 10_000);
    const m3 = s.meetings.getMeeting(m.id)!;
    assert.equal(m3.currentRound, 3);
    s.meetings.updateMeeting(m.id, { roundLimit: 6 });
    await assert.rejects(s.controller.handle({ type: 'meeting.anotherRound', meetingId: m.id }), /limite absoluto/);
  } finally { await s.cleanup(); }
});

test('interromper: fala parcial registrada, reunião pausa, retomar continua a fila', async () => {
  const s = setup();
  try {
    s.claude.delayMs = 40; s.claude.reply = () => 'um dois três quatro cinco seis sete oito nove dez onze doze';
    const m = await s.create();
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: 'Opinem', targets: [] });
    await s.waitUntil(() => s.msgs.some(x => x.kind === 'meeting.delta' && x.text.length > 0));
    await s.controller.handle({ type: 'meeting.interrupt', meetingId: m.id });
    const paused = s.meetings.getMeeting(m.id)!;
    assert.equal(paused.status, 'paused');
    const h = s.controller.history(m.id);
    const t = h.turns.find(x => x.participantId === m.participants[1].id)!;
    assert.equal(t.status, 'interrupted');
    const partial = h.messages.find(x => x.turnId === t.id)!;
    assert.equal(partial.partial, true);
    assert.ok(partial.text.length > 0 && partial.text.length < 'um dois três quatro cinco seis sete oito nove dez onze doze'.length);
    assert.equal(paused.participants[1].state, 'interrupted');
    assert.equal(paused.participants[2].state, 'waiting_turn');
    assert.equal(s.openai.calls.length, 0, 'pausada: o próximo turno não começa');
    await s.controller.handle({ type: 'meeting.resume', meetingId: m.id });
    const done = await s.waitIdle(m.id);
    assert.equal(done.status, 'active');
    assert.equal(s.openai.calls.length, 1);
    await assert.rejects(s.controller.handle({ type: 'meeting.interrupt', meetingId: m.id }), /nenhum turno/);
  } finally { await s.cleanup(); }
});

test('provedor sem login: turno falha com motivo, participante indisponível, a reunião segue com o outro; tentar de novo depois do login', async () => {
  const s = setup();
  try {
    s.openai.auth = 'missing';
    const m = await s.create();
    assert.equal(m.participants[2].state, 'unavailable');
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: 'Opinem', targets: [] });
    await s.waitIdle(m.id);
    const h = s.controller.history(m.id);
    const gpt = h.turns.find(t => t.participantId === m.participants[2].id)!;
    assert.equal(gpt.status, 'failed'); assert.match(gpt.error!, /sem login/);
    assert.equal(s.openai.calls.length, 0, 'nenhuma chamada ao provedor sem login');
    assert.ok(h.turns.find(t => t.participantId === m.participants[1].id)!.status === 'done');
    assert.ok(h.messages.some(x => x.kind === 'notice' && /ChatGPT não pôde responder/.test(x.text)));
    assert.equal(h.messages.filter(x => x.kind === 'speech').length, 1, 'nenhuma resposta falsa');
    s.openai.auth = 'ok';
    await s.controller.handle({ type: 'meeting.retryTurn', meetingId: m.id, turnId: gpt.id });
    await s.waitIdle(m.id);
    assert.equal(s.meetings.getTurn(gpt.id)!.status, 'done');
    assert.equal(s.openai.calls.length, 1);
  } finally { await s.cleanup(); }
});

test('configuração inválida (esforço fora do modelo) falha com motivo e alternativas, sem substituição silenciosa; precedência participante > funcionário > global', async () => {
  const s = setup();
  try {
    s.store.saveSettings({ ai: { claude: { model: 'claude-sonnet-4-6', effort: 'medium' }, openai: { model: 'gpt-5.1-codex-mini', effort: 'high' } } });
    s.store.updateEmployee(s.employee.id, { model: 'fable', effort: 'max' });
    const m = await s.create({ participants: [{ provider: 'claude', employeeId: s.employee.id }, { provider: 'openai', model: 'gpt-5.1-codex-mini', effort: 'low' }] });
    assert.equal(m.participants[2].useGlobal, false);
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: 'Opinem', targets: [] });
    await s.waitIdle(m.id);
    const h = s.controller.history(m.id);
    const c = h.turns.find(t => t.participantId === m.participants[1].id)!;
    assert.equal(c.status, 'done');
    assert.deepEqual(c.requested, { model: 'fable', effort: 'max' }, 'funcionário vence o padrão global');
    assert.deepEqual(c.applied, { model: 'fable', effort: 'max', resolvedModel: 'fable-resolvido' });
    const g = h.turns.find(t => t.participantId === m.participants[2].id)!;
    assert.equal(g.status, 'failed');
    assert.match(g.error!, /aceita: medium, high/);
    assert.match(g.error!, /modelo definido por: meeting/);
    assert.equal(s.openai.calls.length, 0, 'não chamou o provedor com configuração inválida');
    await s.controller.handle({ type: 'meeting.participant.update', meetingId: m.id, participantId: m.participants[2].id, patch: { useGlobal: true } });
    await s.controller.handle({ type: 'meeting.retryTurn', meetingId: m.id, turnId: g.id });
    await s.waitIdle(m.id);
    const g2 = s.meetings.getTurn(g.id)!;
    assert.equal(g2.status, 'done');
    assert.deepEqual(g2.requested, { model: 'gpt-5.1-codex-mini', effort: 'high' }, 'padrão global depois de "usar padrão global"');
  } finally { await s.cleanup(); }
});

test('recuperação após queda: turno em execução vira perdido, reunião pausa, nada é reenviado', async () => {
  const s = setup();
  try {
    const m = await s.create();
    s.meetings.updateMeeting(m.id, { status: 'active', startedAt: Date.now() });
    const t = s.meetings.createTurn({ meetingId: m.id, participantId: m.participants[1].id, round: 0, phase: 'reply', requested: { model: null, effort: null }, contextVersion: 1 });
    s.meetings.updateTurn(t.id, { status: 'running', startedAt: Date.now() });
    s.meetings.updateMeeting(m.id, { activeTurnId: t.id });
    const t2 = s.meetings.createTurn({ meetingId: m.id, participantId: m.participants[2].id, round: 0, phase: 'reply', requested: { model: null, effort: null }, contextVersion: 1 });
    s.controller.recoverOnStart();
    assert.equal(s.meetings.getTurn(t.id)!.status, 'lost');
    assert.match(s.meetings.getTurn(t.id)!.error!, /reiniciou/);
    assert.equal(s.meetings.getTurn(t2.id)!.status, 'queued');
    const after = s.meetings.getMeeting(m.id)!;
    assert.equal(after.status, 'paused'); assert.equal(after.activeTurnId, null);
    assert.equal(s.claude.calls.length + s.openai.calls.length, 0);
    assert.ok(s.controller.history(m.id).messages.some(x => x.kind === 'notice' && /perdido/.test(x.text)));
    assert.equal(after.participants[1].state, 'available');
    assert.equal(after.participants[2].state, 'waiting_turn');
  } finally { await s.cleanup(); }
});

test('encerrar gera a ata (editável), pula a fila; reabrir volta pausada; tarefas criadas em espera sem duplicar; liberar', async () => {
  const s = setup();
  try {
    const m = await s.create();
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: 'Decisão: usar Next.js', targets: [] });
    await s.controller.handle({ type: 'meeting.decision.add', reqId: 'r', meetingId: m.id, kind: 'action', text: 'Criar o repositório', assigneeEmployeeId: s.employee.id });
    const r = await s.controller.handle({ type: 'meeting.end', reqId: 'r', meetingId: m.id }) as { meeting: Meeting };
    assert.equal(r.meeting.status, 'ended');
    assert.ok(r.meeting.minutes?.text.includes('# Ata: Pauta de teste'));
    assert.ok(r.meeting.minutes?.text.includes('- usar Next.js'));
    assert.ok(r.meeting.minutes?.text.includes('Criar o repositório (responsável: Léo)'));
    await assert.rejects(s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c9', text: 'oi', targets: [] }), /encerrada/);
    await s.controller.handle({ type: 'meeting.minutes.save', reqId: 'r', meetingId: m.id, text: '# Ata editada' });
    assert.equal(s.meetings.getMeeting(m.id)!.minutes!.text, '# Ata editada');
    assert.ok(s.meetings.getMeeting(m.id)!.minutes!.editedAt);
    // Tarefas a partir da ata: item proposto → criar sem iniciar → não duplica → liberar.
    const it = await s.controller.handle({ type: 'meeting.taskItem.upsert', reqId: 'r', meetingId: m.id, item: { title: 'Criar o repositório', instructions: 'git init e esqueleto Next.js', employeeId: s.employee.id } }) as { item: { id: string } };
    const created = await s.controller.handle({ type: 'meeting.tasks.create', reqId: 'r', meetingId: m.id, items: [{ id: it.item.id, employeeId: s.employee.id, projectId: s.project.id, instructions: 'git init e esqueleto Next.js', start: false }] }) as { items: { status: string; taskId: string | null; sessionId: string | null }[] };
    assert.equal(created.items[0].status, 'created');
    assert.ok(created.items[0].taskId && created.items[0].sessionId);
    assert.equal(s.prompts.length, 1);
    assert.equal(s.prompts[0].held, true);
    assert.equal(s.prompts[0].clientId, `meeting:${m.id}:task:${it.item.id}`);
    assert.ok(s.prompts[0].text.includes('git init e esqueleto Next.js'));
    const task = s.store.getTask(created.items[0].taskId!)!;
    assert.equal(task.held, true); assert.equal(task.meetingId, m.id); assert.equal(task.status, 'queued');
    const again = await s.controller.handle({ type: 'meeting.tasks.create', reqId: 'r', meetingId: m.id, items: [{ id: it.item.id, employeeId: s.employee.id, projectId: s.project.id, instructions: 'outra', start: true }] }) as { items: { taskId: string | null }[] };
    assert.equal(again.items[0].taskId, task.id); assert.equal(s.prompts.length, 1, 'recarregar/reenviar não duplica');
    await assert.rejects(s.controller.handle({ type: 'meeting.taskItem.delete', meetingId: m.id, id: it.item.id }), /já existe na fila/);
    await s.controller.handle({ type: 'task.release', taskId: task.id });
    assert.deepEqual(s.released, [task.id]);
    await s.controller.handle({ type: 'meeting.reopen', meetingId: m.id });
    assert.equal(s.meetings.getMeeting(m.id)!.status, 'paused');
  } finally { await s.cleanup(); }
});

test('contexto: arquivo do projeto entra no pacote do turno, fora das pastas da HQ é recusado, versão do contexto registrada', async () => {
  const s = setup();
  try {
    const m = await s.create({ participants: [{ provider: 'claude' }] });
    const file = path.join(s.projDir, 'NOTAS.md');
    fs.writeFileSync(file, 'Conteúdo secreto do projeto: usar fonte Inter');
    await assert.rejects(s.controller.handle({ type: 'meeting.context.set', reqId: 'r', meetingId: m.id, items: [{ id: '', kind: 'file', label: 'x', path: path.join(os.tmpdir(), 'fora.txt'), text: null, enabled: true }] }), /não está em nenhum projeto/);
    await s.controller.handle({ type: 'meeting.context.set', reqId: 'r', meetingId: m.id, items: [{ id: '', kind: 'file', label: 'Notas', path: file, text: null, enabled: true }, { id: '', kind: 'note', label: 'Regra', path: null, text: 'Nunca usar jQuery', enabled: true }, { id: '', kind: 'note', label: 'Desligada', path: null, text: 'NÃO DEVE APARECER', enabled: false }] });
    assert.equal(s.meetings.getMeeting(m.id)!.contextVersion, 2);
    await s.controller.handle({ type: 'meeting.update', id: m.id, patch: { agenda: 'Pauta nova' } });
    assert.equal(s.meetings.getMeeting(m.id)!.contextVersion, 3);
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: 'E então?', targets: [] });
    await s.waitIdle(m.id);
    const sent = s.claude.calls[0].text;
    assert.ok(sent.includes('usar fonte Inter')); assert.ok(sent.includes('Nunca usar jQuery')); assert.ok(!sent.includes('NÃO DEVE APARECER'));
    assert.ok(sent.includes('Pauta nova')); assert.ok(sent.includes('Contexto da empresa'));
    const h = s.controller.history(m.id);
    assert.equal(h.turns[0].contextVersion, 3);
    assert.equal(h.messages.find(x => x.kind === 'speech')!.contextVersion, 3);
  } finally { await s.cleanup(); }
});

test('limite de execuções simultâneas: com um funcionário ativo e maxParallel 1 o turno espera e começa quando liberar', async () => {
  let active = 1;
  const s = setup({ activeTurns: () => active });
  try {
    const m = await s.create({ participants: [{ provider: 'claude' }] });
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: 'Opinem', targets: [] });
    await new Promise(r => setTimeout(r, 60));
    assert.equal(s.claude.calls.length, 0);
    assert.ok(s.controller.history(m.id).messages.some(x => x.kind === 'notice' && /Aguardando capacidade/.test(x.text)));
    assert.equal(s.controller.activeCount(), 0);
    active = 0; s.fireTurnFinished();
    await s.waitIdle(m.id);
    assert.equal(s.claude.calls.length, 1);
  } finally { await s.cleanup(); }
});

test('utilidades: síntese, decisão do Chefe, menções e ata', () => {
  const p = parseSynthesis('Texto solto\n## Propostas\n- A\n* B\n## Divergências\n1. C\n## Perguntas abertas\n- D?\n## Próximas ações\n- [Léo] E\n- F');
  assert.deepEqual(p, { proposals: ['A', 'B'], divergences: ['C'], questions: ['D?'], actions: [{ text: 'E', assignee: 'Léo' }, { text: 'F', assignee: null }] });
  assert.equal(chefeDecisionText('Decisão: X'), 'X'); assert.equal(chefeDecisionText('fica decidido que Y'), 'que Y'); assert.equal(chefeDecisionText('Decidido, vamos'), 'vamos'); assert.equal(chefeDecisionText('decisões são difíceis'), null);
  const parts = [{ id: 'a', kind: 'ai', name: 'Claude' }, { id: 'b', kind: 'ai', name: 'ChatGPT' }, { id: 'r', kind: 'chefe', name: 'Chefe' }] as never;
  assert.deepEqual(parseMentions('oi @chatgpt e @Claude, e @Chefe', parts), ['a', 'b']);
  assert.deepEqual(parseMentions('email@claude.com', parts), []);
  const txt = renderMinutes({ meeting: { id: '1', title: 'T', agenda: 'A', projectId: null, mode: 'guided', status: 'ended', roundLimit: 2, currentRound: 0, contextVersion: 1, synthesisParticipantId: null, companyContext: true, createdAt: 1, updatedAt: 1, startedAt: 1, endedAt: 2, participants: [], minutes: null, activeTurnId: null, queuedTurns: 0 }, project: null, messages: [], decisions: [], employees: [] });
  assert.ok(txt.includes('nenhuma decisão confirmada'));
});

test('contexto: junction dentro do projeto apontando para fora é recusada; a pasta de dados da HQ nunca entra', async () => {
  const s = setup();
  try {
    const m = await s.create({ participants: [{ provider: 'claude' }] });
    const outside = tempDir('hq-meet-outside-');
    fs.writeFileSync(path.join(outside, 'segredo.txt'), 'não pode vazar');
    const link = path.join(s.projDir, 'atalho');
    let linked = false;
    try { fs.symlinkSync(outside, link, 'junction'); linked = true; } catch { /* sem permissão para criar links nesta máquina */ }
    if (linked) {
      await assert.rejects(s.controller.handle({ type: 'meeting.context.set', reqId: 'r', meetingId: m.id, items: [{ id: '', kind: 'file', label: 'x', path: path.join(link, 'segredo.txt'), text: null, enabled: true }] }), /link simbólico ou junction/);
    }
    // Chefe cadastrou a pasta que contém os dados da HQ: token e banco continuam fora do contexto.
    const devRoom = s.store.listRooms().find(r => r.kind === 'dev')!;
    s.store.createProject({ name: 'Pasta grande', path: path.dirname(s.dataDir), roomId: devRoom.id });
    fs.writeFileSync(path.join(s.dataDir, 'token'), 'abc');
    await assert.rejects(s.controller.handle({ type: 'meeting.context.set', reqId: 'r', meetingId: m.id, items: [{ id: '', kind: 'file', label: 'x', path: path.join(s.dataDir, 'token'), text: null, enabled: true }] }), /protegido/);
    await assert.rejects(s.controller.handle({ type: 'meeting.context.set', reqId: 'r', meetingId: m.id, items: [{ id: '', kind: 'file', label: 'x', path: path.join(s.projDir, 'nao-existe.md'), text: null, enabled: true }] }), /não existe/);
    const ok = await s.controller.handle({ type: 'meeting.context.set', reqId: 'r', meetingId: m.id, items: [{ id: '', kind: 'note', label: 'n', path: null, text: 'ok', enabled: true }] }) as { items: unknown[]; contextVersion: number };
    assert.equal(ok.items.length, 1); assert.equal(ok.contextVersion, 2);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally { await s.cleanup(); }
});

test('encerrar de novo depois de editar a ata mantém o texto editado; "mais uma rodada" sem IA é recusada antes de mexer no estado', async () => {
  const s = setup();
  try {
    const m = await s.create({ mode: 'debate' });
    await s.controller.handle({ type: 'meeting.end', reqId: 'r', meetingId: m.id });
    const saved = await s.controller.handle({ type: 'meeting.minutes.save', reqId: 'r', meetingId: m.id, text: '# Minha ata' }) as { minutes: { text: string; editedAt: number | null } };
    assert.equal(saved.minutes.text, '# Minha ata'); assert.ok(saved.minutes.editedAt);
    await s.controller.handle({ type: 'meeting.reopen', meetingId: m.id });
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: 'Decisão: mais uma coisa', targets: [] });
    const again = await s.controller.handle({ type: 'meeting.end', reqId: 'r', meetingId: m.id }) as { meeting: Meeting };
    assert.equal(again.meeting.minutes!.text, '# Minha ata', 'a edição do Chefe não é sobrescrita');
    assert.ok(again.meeting.minutes!.editedAt);
    assert.ok(s.controller.history(m.id).messages.some(x => x.kind === 'notice' && /foi mantida/.test(x.text)));
    await s.controller.handle({ type: 'meeting.reopen', meetingId: m.id });
    for (const p of m.participants.filter(p => p.kind === 'ai')) await s.controller.handle({ type: 'meeting.participant.remove', meetingId: m.id, participantId: p.id });
    const before = s.meetings.getMeeting(m.id)!;
    await assert.rejects(s.controller.handle({ type: 'meeting.anotherRound', meetingId: m.id }), /participante de IA/);
    const after = s.meetings.getMeeting(m.id)!;
    assert.equal(after.roundLimit, before.roundLimit); assert.equal(after.status, before.status);
    assert.equal(s.meetings.countQueued(m.id), 0);
  } finally { await s.cleanup(); }
});

test('sessão perdida: o adaptador devolve threadId null, o coordenador zera a sessão do participante e o turno seguinte começa do zero', async () => {
  const s = setup();
  try {
    const m = await s.create({ participants: [{ provider: 'claude' }] });
    const say = (text: string, clientId: string) => s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId, text, targets: [] });
    const ai = () => s.meetings.getMeeting(m.id)!.participants.find(p => p.kind === 'ai')!;
    await say('Primeira pergunta', 'c1'); await s.waitIdle(m.id);
    assert.equal(ai().threadId, 'claude-thread-1');
    s.claude.loseSessionOnce = true;
    await say('Segunda pergunta', 'c2'); await s.waitIdle(m.id);
    assert.equal(s.claude.calls[1].threadId, 'claude-thread-1', 'tentou retomar a sessão');
    assert.equal(ai().threadId, null, 'sessão zerada');
    assert.ok(s.controller.history(m.id).messages.some(x => x.kind === 'notice' && /próximo turno começa uma sessão nova, sem a memória/.test(x.text)), 'aviso do coordenador (o erro do falso não contém esse texto)');
    await say('Terceira pergunta', 'c3'); await s.waitIdle(m.id);
    assert.equal(s.claude.calls[2].threadId, null, 'sessão nova, sem retomar');
    assert.equal(ai().threadId, 'claude-thread-3');
    assert.deepEqual(s.controller.history(m.id).turns.map(t => t.status), ['done', 'failed', 'done']);
  } finally { await s.cleanup(); }
});

test('resolve: esforço herdado de nível mais amplo que o modelo só vale se o modelo aceitar; escolha explícita inválida continua inválida', async () => {
  const s = setup();
  try {
    s.store.saveSettings({ ai: { ...s.store.getSettings().ai, openai: { model: null, effort: 'low' } } });
    // participante escolheu o modelo mini (aceita medium/high) e deixou o esforço em padrão: o 'low' global não se aplica
    const a = s.registry.resolve('openai', { model: 'gpt-5.1-codex-mini', effort: null, useGlobal: false }, null);
    assert.deepEqual(a, { model: 'gpt-5.1-codex-mini', effort: null, modelSource: 'meeting', effortSource: 'provider' });
    assert.equal(s.registry.validate('openai', a.model, a.effort).ok, true);
    // modelo que aceita o esforço global: herda normalmente
    const b = s.registry.resolve('openai', { model: 'gpt-5.1-codex', effort: null, useGlobal: false }, null);
    assert.deepEqual(b, { model: 'gpt-5.1-codex', effort: 'low', modelSource: 'meeting', effortSource: 'global' });
    // escolha explícita inválida no mesmo nível: não é corrigida em silêncio
    const c = s.registry.resolve('openai', { model: 'gpt-5.1-codex-mini', effort: 'low', useGlobal: false }, null);
    assert.equal(c.effort, 'low'); assert.equal(s.registry.validate('openai', c.model, c.effort).ok, false);
    // sem modelo escolhido, o esforço global vale (não há modelo conhecido para contradizer)
    const d = s.registry.resolve('openai', { model: null, effort: null, useGlobal: true }, null);
    assert.deepEqual(d, { model: null, effort: 'low', modelSource: 'provider', effortSource: 'global' });
  } finally { await s.cleanup(); }
});

test('contexto: arquivo já salvo que sumiu não trava a edição da lista; arquivo novo inexistente e caminho vazio continuam recusados', async () => {
  const s = setup();
  try {
    const m = await s.create({ participants: [{ provider: 'claude' }] });
    const set = (items: MeetingContextItem[]) => s.controller.handle({ type: 'meeting.context.set', reqId: 'r', meetingId: m.id, items }) as Promise<{ items: MeetingContextItem[]; contextVersion: number }>;
    const file = path.join(s.projDir, 'VAI-SUMIR.md');
    fs.writeFileSync(file, 'conteúdo');
    const first = await set([{ id: '', kind: 'file', label: 'Vai sumir', path: file, text: null, enabled: true }]);
    fs.rmSync(file);
    const second = await set([{ ...first.items[0], enabled: false }, { id: '', kind: 'note', label: 'Nota', path: null, text: 'nova nota', enabled: true }]);
    assert.deepEqual(second.items.map(i => [i.kind, i.enabled]), [['file', false], ['note', true]]);
    await assert.rejects(set([...second.items, { id: '', kind: 'file', label: 'x', path: path.join(s.projDir, 'nunca-existiu.md'), text: null, enabled: true }]), /não existe/);
    await assert.rejects(set([{ id: '', kind: 'file', label: 'x', path: '   ', text: null, enabled: true }]), /sem caminho/);
  } finally { await s.cleanup(); }
});

test('tarefas: lote com item inválido não cria nenhuma; item de decisão guarda o vínculo e pedido repetido sem id reaproveita o item', async () => {
  const s = setup();
  try {
    const m = await s.create({ participants: [{ provider: 'claude' }] });
    const up = (item: { id?: string; title: string; instructions?: string; employeeId?: string | null; decisionId?: string | null }) =>
      s.controller.handle({ type: 'meeting.taskItem.upsert', reqId: 'r', meetingId: m.id, item }) as Promise<{ item: MeetingTaskItem }>;
    const a = (await up({ title: 'A', instructions: 'faça A', employeeId: s.employee.id })).item;
    const b = (await up({ title: 'B', instructions: '', employeeId: s.employee.id })).item;
    await assert.rejects(s.controller.handle({ type: 'meeting.tasks.create', reqId: 'r', meetingId: m.id, items: [
      { id: a.id, employeeId: s.employee.id, projectId: s.project.id, instructions: 'faça A', start: true },
      { id: b.id, employeeId: s.employee.id, projectId: s.project.id, instructions: '   ', start: true },
    ] }), /instruções/);
    assert.equal(s.prompts.length, 0, 'o lote é validado inteiro antes de criar qualquer tarefa');
    assert.equal(s.meetings.getTaskItem(a.id)!.status, 'proposed');
    const d = s.meetings.addDecision({ meetingId: m.id, kind: 'decision', text: 'Migrar para Postgres', confirmed: true });
    const linked = (await up({ title: 'Migrar o banco para Postgres', instructions: 'x', employeeId: s.employee.id, decisionId: d.id })).item;
    assert.equal(linked.decisionId, d.id);
    const again = (await up({ title: 'Outro título', instructions: 'y', decisionId: d.id })).item;
    assert.equal(again.id, linked.id, 'mesma decisão, mesmo item');
    assert.equal(s.meetings.listTaskItems(m.id).filter(it => it.decisionId === d.id).length, 1);
    const other = await s.create({ participants: [{ provider: 'claude' }] });
    const foreign = s.meetings.addDecision({ meetingId: other.id, kind: 'decision', text: 'De outra reunião', confirmed: true });
    await assert.rejects(up({ title: 'x', decisionId: foreign.id }), /não pertence/);
  } finally { await s.cleanup(); }
});

test('lixeira de reuniões (Marco 0): excluir guarda tudo, registra, bloqueia ações; restaurar devolve falas; 30 dias apaga de vez', async () => {
  const s = setup();
  try {
    const m = await s.create();
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c-lix', text: 'Fala antes de excluir', targets: [] });
    await s.waitIdle(m.id);
    const falasAntes = s.meetings.listMessages(m.id).length;
    assert.ok(falasAntes >= 1);
    await s.controller.handle({ type: 'meeting.delete', id: m.id });
    assert.equal(s.controller.list().length, 0, 'sai da lista');
    const trash = await s.controller.handle({ type: 'meeting.trash', reqId: 't' }) as { meetings: Meeting[]; keepDays: number };
    assert.equal(trash.meetings.length, 1); assert.equal(trash.keepDays, 30); assert.ok(trash.meetings[0].deletedAt);
    assert.equal(s.meetings.listMessages(m.id).length, falasAntes, 'nada é apagado ao excluir');
    await assert.rejects(s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c2', text: 'x', targets: [] }), /lixeira/);
    const audit1 = s.store.listAudit(5);
    assert.equal(audit1[0].entity, 'reunião'); assert.match(audit1[0].action, /excluir/); assert.equal(audit1[0].entityId, m.id); assert.equal(audit1[0].origin, 'interface');
    const r = await s.controller.handle({ type: 'meeting.restore', reqId: 'r', id: m.id }) as { meeting: Meeting };
    assert.equal(r.meeting.deletedAt, null);
    assert.equal(s.controller.list().length, 1);
    assert.equal(s.meetings.listMessages(m.id).length, falasAntes, 'falas voltam junto');
    assert.equal(s.store.listAudit(1)[0].action, 'restaurar');
    // Prazo: 31 dias depois de excluída, some de vez (e fica registrado como "sistema").
    await s.controller.handle({ type: 'meeting.delete', id: m.id });
    assert.equal(s.controller.purgeTrash(Date.now() + 29 * 86_400_000), 0);
    assert.equal(s.controller.purgeTrash(Date.now() + 31 * 86_400_000), 1);
    assert.equal(s.meetings.getMeeting(m.id), null);
    assert.equal(s.meetings.listMessages(m.id).length, 0);
    const purge = s.store.listAudit(1)[0];
    assert.equal(purge.action, 'apagar de vez'); assert.equal(purge.origin, 'sistema');
  } finally { await s.cleanup(); }
});

test('reunião com a equipe: cada funcionário senta com o próprio nome, função e motor; ninguém entra duas vezes; a mesa tem teto', async () => {
  const s = setup();
  try {
    const bia = s.store.createEmployee({ name: 'Bia', role: 'Criação', roomId: s.employee.roomId, appearance: { skin: 1, hair: 1, shirt: 1 }, deskIndex: 1, provider: 'openai', instructions: 'Escreve roteiros curtos.' });
    // provider enviado pelo cliente é ignorado para funcionário: vale o motor do cadastro
    const m = await s.create({ participants: [{ provider: 'claude' }, { provider: 'claude', employeeId: s.employee.id }, { provider: 'claude', employeeId: bia.id }] });
    assert.deepEqual(m.participants.map(p => [p.name, p.provider, p.employeeId]), [['Chefe', null, null], ['Claude', 'claude', null], ['Léo', 'claude', s.employee.id], ['Bia', 'openai', bia.id]]);
    await assert.rejects(s.controller.handle({ type: 'meeting.participant.add', reqId: 'x', meetingId: m.id, participant: { provider: 'openai', employeeId: s.employee.id } }), /Léo já participa/);
    await assert.rejects(s.controller.handle({ type: 'meeting.participant.add', reqId: 'x', meetingId: m.id, participant: { provider: 'claude' } }), /Claude já participa/);
    // o gerente ChatGPT ainda cabe: ele não é a Bia, mesmo com o mesmo motor
    await s.controller.handle({ type: 'meeting.participant.add', reqId: 'x', meetingId: m.id, participant: { provider: 'openai' } });

    // @Bia chama só a Bia; ela recebe o próprio papel e as instruções; a mesa lista as funções
    const biaP = s.meetings.getMeeting(m.id)!.participants.find(p => p.name === 'Bia')!;
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c1', text: '@Bia como fica o roteiro do Reels?', targets: [] });
    await s.waitIdle(m.id);
    const turns = s.controller.history(m.id).turns;
    assert.deepEqual(turns.map(t => t.participantId), [biaP.id]);
    const call = s.openai.calls.at(-1)!;
    assert.match(call.systemPrompt, /Você é Bia/);
    assert.match(call.systemPrompt, /à mesa como Bia \(Criação\)/);
    assert.match(call.systemPrompt, /Escreve roteiros curtos/);
    assert.match(call.systemPrompt, /vários participantes/);
    assert.match(call.text, /- Léo, Desenvolvimento \(via Claude Code\)/);
    assert.equal(s.claude.calls.length, 0);

    // teto: 8 participantes de IA além do Chefe
    for (let i = 0; i < 4; i++) {
      const e = s.store.createEmployee({ name: `Extra ${i}`, role: 'Apoio', roomId: s.employee.roomId, appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 2 });
      await s.controller.handle({ type: 'meeting.participant.add', reqId: 'x', meetingId: m.id, participant: { provider: 'claude', employeeId: e.id } });
    }
    const extra = s.store.createEmployee({ name: 'Sobra', role: 'Apoio', roomId: s.employee.roomId, appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 3 });
    await assert.rejects(s.controller.handle({ type: 'meeting.participant.add', reqId: 'x', meetingId: m.id, participant: { provider: 'claude', employeeId: extra.id } }), /no máximo 8/);
    assert.deepEqual(s.meetings.getMeeting(m.id)!.participants.map(p => p.seat), [0, 1, 2, 3, 4, 5, 6, 7, 8]);

    // trocar o funcionário de um lugar troca o nome; repetir alguém da mesa é recusado
    const claudeP = s.meetings.getMeeting(m.id)!.participants.find(p => p.name === 'Claude')!;
    await assert.rejects(s.controller.handle({ type: 'meeting.participant.update', meetingId: m.id, participantId: claudeP.id, patch: { employeeId: bia.id } }), /Bia já participa/);
    await s.controller.handle({ type: 'meeting.participant.update', meetingId: m.id, participantId: claudeP.id, patch: { employeeId: extra.id } });
    assert.equal(s.meetings.getMeeting(m.id)!.participants.find(p => p.id === claudeP.id)!.name, 'Sobra');
  } finally { await s.cleanup(); }
});

test('tentar de novo: na discussão a opinião refeita entra antes das revisões e da síntese na fila; na conversa guiada vai para o fim', async () => {
  const s = setup();
  try {
    const m = await s.create({ mode: 'debate', roundLimit: 2 });
    const [c, g] = m.participants.filter(p => p.kind === 'ai');
    const mk = (p: { id: string }, round: number, phase: 'opinion' | 'revision' | 'synthesis' | 'reply') => s.meetings.createTurn({ meetingId: m.id, participantId: p.id, round, phase, requested: { model: null, effort: null }, contextVersion: 1 });
    const op1 = mk(c, 1, 'opinion'); const op2 = mk(g, 1, 'opinion'); const r1 = mk(c, 2, 'revision'); const r2 = mk(g, 2, 'revision'); const sy = mk(c, 2, 'synthesis');
    s.meetings.updateTurn(op1.id, { status: 'done' }); s.meetings.updateTurn(op2.id, { status: 'interrupted' });
    s.meetings.requeueTurn(op2.id);
    assert.deepEqual(s.meetings.listTurnsByStatus(['queued'], m.id).map(t => t.id), [op2.id, r1.id, r2.id, sy.id]);
    for (const t of [op2, r1, r2, sy]) s.meetings.updateTurn(t.id, { status: 'done' });
    const a = mk(c, 0, 'reply'); const b = mk(g, 0, 'reply');
    s.meetings.updateTurn(a.id, { status: 'failed' });
    s.meetings.requeueTurn(a.id);
    assert.deepEqual(s.meetings.listTurnsByStatus(['queued'], m.id).map(t => t.id), [b.id, a.id]);
  } finally { await s.cleanup(); }
});

test('limite de uso: quem usa o provedor sai da reunião, a fila dele é pulada, a síntese passa adiante e a volta só acontece quando o Chefe chama', async () => {
  const s = setup();
  try {
    const m = await s.create({ mode: 'debate', roundLimit: 2, participants: [{ provider: 'openai' }, { provider: 'claude' }] });
    const gpt = m.participants.find(p => p.provider === 'openai')!;
    const claude = m.participants.find(p => p.provider === 'claude')!;
    await s.controller.handle({ type: 'meeting.update', id: m.id, patch: { synthesisParticipantId: gpt.id } });
    const until = Date.now() + 60 * 60_000;
    s.openai.stopNext = { kind: 'usage_limit', reason: 'limite de uso do ChatGPT esgotado', until };
    await s.controller.handle({ type: 'meeting.discuss', reqId: 'r', meetingId: m.id, clientId: 'c-away-1' });
    const idle = await s.waitIdle(m.id);
    const g = idle.participants.find(p => p.id === gpt.id)!;
    assert.equal(g.state, 'away');
    assert.equal(g.away?.kind, 'usage_limit');
    assert.equal(g.away?.until, until);
    assert.equal(g.away?.asking, false);
    const h = s.controller.history(m.id);
    assert.equal(s.openai.calls.length, 1, 'depois da parada nenhum outro turno do ChatGPT roda');
    assert.ok(h.turns.filter(t => t.participantId === gpt.id && t.status === 'skipped').length >= 1, 'turnos dele na fila foram pulados');
    const synth = h.turns.filter(t => t.phase === 'synthesis' && t.status === 'done');
    assert.equal(synth.length, 1);
    assert.equal(synth[0].participantId, claude.id, 'a síntese passou para quem ficou');
    assert.ok(h.messages.some(x => x.kind === 'notice' && /ChatGPT saiu da reunião: limite de uso do ChatGPT esgotado\. A conversa segue com você e Claude\./.test(x.text)), h.messages.map(x => x.text).join(' | '));
    assert.ok(!h.messages.some(x => x.kind === 'notice' && /ChatGPT não respondeu/.test(x.text)), 'sem o aviso genérico de "Tentar de novo"');

    // Fala do Chefe para todos: só quem está à mesa responde. Menção a quem está fora: aviso, sem turno.
    s.openai.stopNext = null;
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c-away-2', text: 'E agora?', targets: [] });
    await s.waitIdle(m.id);
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c-away-3', text: '@ChatGPT você está aí?', targets: [] });
    await s.waitIdle(m.id);
    assert.equal(s.openai.calls.length, 1, 'quem está fora não recebe turno');
    assert.ok(s.controller.history(m.id).messages.some(x => x.kind === 'notice' && /ChatGPT está fora da reunião/.test(x.text)));

    // Antes do horário: a HQ não pergunta. Depois: pergunta uma vez.
    s.controller.checkReturns(until - 1000);
    assert.equal(s.meetings.getMeeting(m.id)!.participants.find(p => p.id === gpt.id)!.away?.asking, false);
    s.controller.checkReturns(until + 1000);
    s.controller.checkReturns(until + 2000);
    const asked = s.controller.history(m.id).messages.filter(x => x.kind === 'notice' && /ChatGPT pode voltar: o limite de uso liberou/.test(x.text));
    assert.equal(asked.length, 1, 'pergunta uma vez só');
    assert.equal(s.meetings.getMeeting(m.id)!.participants.find(p => p.id === gpt.id)!.state, 'away', 'continua fora até o Chefe chamar');

    await s.controller.handle({ type: 'meeting.participant.rejoin', meetingId: m.id, participantId: gpt.id });
    const back = s.meetings.getMeeting(m.id)!.participants.find(p => p.id === gpt.id)!;
    assert.equal(back.away ?? null, null);
    assert.notEqual(back.state, 'away');
    assert.equal(back.threadId, g.threadId, 'a sessão anterior é mantida na volta');
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c-away-4', text: 'Bem-vindo de volta', targets: [] });
    await s.waitIdle(m.id);
    assert.equal(s.openai.calls.length, 2, 'de volta à mesa, responde de novo');
  } finally { await s.cleanup(); }
});

test('provedor parado sem horário (modelo recusado): sai de todas as reuniões abertas e a HQ só pergunta depois de um teste que passou', async () => {
  const s = setup();
  try {
    const a = await s.create({ participants: [{ provider: 'openai' }, { provider: 'claude' }] });
    const b = await s.create({ participants: [{ provider: 'openai' }] });
    s.openai.stopNext = { kind: 'unavailable', reason: 'a OpenAI recusou o modelo gpt-5 nesta conta ChatGPT', until: null };
    await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: a.id, clientId: 'c-un-1', text: 'Oi', targets: [] });
    await s.waitIdle(a.id);
    for (const id of [a.id, b.id]) assert.equal(s.meetings.getMeeting(id)!.participants.find(p => p.provider === 'openai')!.state, 'away', `fora em ${id}`);
    assert.ok(s.controller.history(b.id).messages.some(x => x.kind === 'notice' && /ChatGPT saiu da reunião/.test(x.text) && /Não ficou nenhuma IA à mesa/.test(x.text)));
    s.controller.checkReturns(Date.now() + 86_400_000);
    assert.equal(s.meetings.getMeeting(a.id)!.participants.find(p => p.provider === 'openai')!.away?.asking, false, 'sem horário e sem teste: não pergunta');
    s.openai.lastTestOk = { at: Date.now() + 10, ok: true, model: null, effort: null, resolvedModel: 'gpt-5.1-codex', detail: 'ok', durationMs: 1 };
    s.controller.checkReturns();
    assert.equal(s.meetings.getMeeting(a.id)!.participants.find(p => p.provider === 'openai')!.away?.asking, true, 'teste passou: pergunta');
    await assert.rejects(s.controller.handle({ type: 'meeting.discuss', reqId: 'r', meetingId: b.id, clientId: 'c-un-2' }), /só existe no modo|todos os participantes de IA estão fora/);
  } finally { await s.cleanup(); }
});

// ---------------- gerentes, plano consolidado e distribuição ----------------
function teamPlan(empName: string) {
  return {
    summary: 'Post do Threads sobre landing e revisão.', decisions: ['Fazer um post de Threads esta semana'], pending: ['Usar vídeo no Reels (sem decisão)'], needs: [],
    tasks: [
      { key: 't1', title: 'Rascunho do post', objective: 'post curto', assignee: empName, project: 'Projeto X', slot: 'threads', context: 'tom direto', references: [], skill: null, deliverable: 'post.md na pasta', criteria: ['até 500 caracteres', 'sem travessão'], priority: 'alta', dependsOn: [], deadline: null },
      { key: 't2', title: 'Conferir o post', objective: 'revisão', assignee: empName, project: 'Projeto X', slot: null, context: '', references: [], skill: 'skill-inexistente', deliverable: 'revisao.md', criteria: ['fatos conferidos'], priority: 'media', dependsOn: ['t1'], deadline: '2026-11-05', deadlineProposed: true },
      { key: 't3', title: 'Editar vídeo', objective: 'corte', assignee: 'Fulano Inexistente', project: 'Projeto X', slot: null, context: '', references: [], skill: null, deliverable: 'video.mp4', criteria: [], priority: 'baixa', dependsOn: [], deadline: null },
    ],
  };
}

test('encerrar e distribuir: o gerente consolida, a HQ grava ata, plano e tarefas na fila com dependência; repetir não duplica', async () => {
  const s = setup();
  try {
    const m = await s.create({ participants: [{ provider: 'claude' }, { provider: 'openai' }] });
    const claudeP = m.participants.find(p => p.provider === 'claude')!;
    s.claude.planFor = () => teamPlan('Léo');
    s.openai.planFor = () => teamPlan('Léo');
    await s.controller.handle({ type: 'meeting.decision.add', reqId: 'r', meetingId: m.id, kind: 'decision', text: 'Fazer um post de Threads esta semana' });
    const r1 = await s.controller.handle({ type: 'meeting.endAndDistribute', reqId: 'r', meetingId: m.id, clientId: 'd1' }) as { distribution: { state: string } };
    assert.equal(r1.distribution.state, 'planning');
    const r2 = await s.controller.handle({ type: 'meeting.endAndDistribute', reqId: 'r', meetingId: m.id, clientId: 'd2' }) as { turn: unknown };
    assert.equal(r2.turn, null, 'clique repetido enquanto consolida não cria outro turno');
    await s.waitUntil(() => s.meetings.getMeeting(m.id)!.distribution?.state === 'distributed', 5000);
    const done = s.meetings.getMeeting(m.id)!;
    assert.equal(done.status, 'ended');
    assert.equal(done.synthesisParticipantId, claudeP.id, 'o primeiro gerente disponível fica responsável pela consolidação');
    assert.match(done.minutes!.text, /## Plano consolidado \(v1, por Claude\)/);
    assert.match(done.minutes!.text, /Pendências \(sem decisão do Chefe\)[\s\S]*Usar vídeo no Reels/);
    const turns = s.controller.history(m.id).turns.filter(t => t.phase === 'plan');
    assert.equal(turns.length, 1); assert.equal(turns[0].participantId, claudeP.id);
    const recs = s.meetings.listPlanTasks(m.id);
    assert.deepEqual(recs.map(r => [r.key, r.status]), [['t1', 'created'], ['t2', 'created'], ['t3', 'blocked']]);
    assert.match(recs[2].blockedReason!, /Fulano Inexistente não está na equipe/);
    assert.equal(s.runs.length, 2);
    const t1 = s.runs.find(r => r.clientId.endsWith(':plan:t1'))!; const t2 = s.runs.find(r => r.clientId.endsWith(':plan:t2'))!;
    assert.equal(t1.held, false); assert.equal(t1.destinationId, 'threads');
    assert.match(t1.text, /Objetivo: post curto[\s\S]*Conta social: Threads[\s\S]*Critérios de conclusão:\n- até 500 caracteres/);
    assert.equal(t2.held, true); assert.match(t2.heldReason!, /Aguardando dependência: Rascunho do post/);
    assert.equal(t2.skill, null, 'skill que não existe na máquina não trava: vai sem ela'); assert.match(t2.text, /Skill sugerida no plano, não encontrada nesta máquina: skill-inexistente/);
    assert.match(t2.text, /Prazo: 2026-11-05 \(proposto pelo gerente, não decidido pelo Chefe\)/);
    // Repetir depois de distribuído e reiniciar a recuperação: nada duplica.
    await s.controller.handle({ type: 'meeting.endAndDistribute', reqId: 'r', meetingId: m.id, clientId: 'd3' });
    s.controller.recoverPlans(); await new Promise(r => setTimeout(r, 30));
    assert.equal(s.runs.length, 2, 'sem tarefa nova');
    assert.equal(s.store.listTasks(50).filter(t => t.meetingId === m.id).length, 2);
    // t1 concluída libera t2.
    s.finishTask(recs[0].taskId!, 'done');
    assert.deepEqual(s.released, [recs[1].taskId]);
    assert.equal(s.store.getTask(recs[1].taskId!)!.held, false);
  } finally { await s.cleanup(); }
});

test('instrução do Chefe no chat ("pode encerrar e distribuir as tarefas") tem o mesmo efeito do botão', async () => {
  const s = setup();
  try {
    const m = await s.create({ participants: [{ provider: 'claude' }] });
    s.claude.planFor = () => teamPlan('Léo');
    const r = await s.controller.handle({ type: 'meeting.say', reqId: 'r', meetingId: m.id, clientId: 'c-dist', text: 'Fechado. Pode encerrar a reunião e distribuir as tarefas para a equipe.', targets: [] }) as { turns: { phase: string }[] };
    assert.equal(r.turns.length, 1); assert.equal(r.turns[0].phase, 'plan');
    await s.waitUntil(() => s.meetings.getMeeting(m.id)!.distribution?.state === 'distributed', 5000);
    assert.equal(s.runs.length, 2);
    assert.equal(s.claude.calls.filter(c => !c.text.includes('ENCERRAR A REUNIÃO')).length, 0, 'nenhum turno de resposta comum');
  } finally { await s.cleanup(); }
});

test('gerente sai por limite no meio da consolidação: o outro assume com o próprio modelo e esforço, com a passagem registrada', async () => {
  const s = setup();
  try {
    const m = await s.create({ participants: [{ provider: 'claude' }, { provider: 'openai', model: 'gpt-5.1-codex-mini', effort: 'high' }] });
    const gpt = m.participants.find(p => p.provider === 'openai')!;
    s.openai.planFor = () => teamPlan('Léo');
    s.claude.stopNext = { kind: 'usage_limit', reason: 'limite de uso de 5 h do Claude esgotado', until: Date.now() + 3600_000 };
    await s.controller.handle({ type: 'meeting.endAndDistribute', reqId: 'r', meetingId: m.id, clientId: 'd1' });
    await s.waitUntil(() => s.meetings.getMeeting(m.id)!.distribution?.state === 'distributed', 5000);
    const fin = s.meetings.getMeeting(m.id)!;
    assert.equal(fin.synthesisParticipantId, gpt.id);
    const plan = s.meetings.listPlans(m.id)[0];
    assert.equal(plan.authorName, 'ChatGPT');
    const last = s.openai.calls.at(-1)!;
    assert.deepEqual({ model: last.model, effort: last.effort }, { model: 'gpt-5.1-codex-mini', effort: 'high' }, 'modelo e esforço do gerente que ficou, sem troca silenciosa');
    assert.match(last.text, /Você assumiu a consolidação no lugar de Claude, que saiu da reunião \(limite de uso de 5 h do Claude esgotado\)/);
    const notes = s.controller.history(m.id).messages.filter(x => x.kind === 'notice').map(x => x.text).join(' | ');
    assert.match(notes, /Responsabilidade pela consolidação passou de Claude para ChatGPT/);
    assert.equal(fin.participants.find(p => p.provider === 'claude')!.state, 'away');
    assert.equal(s.runs.length, 2);
  } finally { await s.cleanup(); }
});

test('os dois gerentes fora: a reunião pausa com a consolidação guardada; um volta e ela segue sem refazer rodadas', async () => {
  const s = setup();
  try {
    const m = await s.create({ participants: [{ provider: 'claude' }, { provider: 'openai' }] });
    const until = Date.now() + 3600_000;
    s.claude.stopNext = { kind: 'usage_limit', reason: 'limite de uso de 5 h do Claude esgotado', until };
    s.openai.stopNext = { kind: 'auth', reason: 'login do ChatGPT perdido no Codex', until: null };
    await s.controller.handle({ type: 'meeting.endAndDistribute', reqId: 'r', meetingId: m.id, clientId: 'd1' });
    await s.waitUntil(() => s.meetings.getMeeting(m.id)!.distribution?.state === 'waiting_manager', 5000);
    const paused = s.meetings.getMeeting(m.id)!;
    assert.equal(paused.status, 'paused');
    assert.equal(s.controller.history(m.id).turns.filter(t => t.phase === 'plan' && t.status === 'queued').length, 1, 'a consolidação fica guardada');
    assert.equal(s.runs.length, 0);
    // O Claude volta (o Chefe chama de volta depois do aviso).
    s.claude.stopNext = null; s.claude.planFor = () => teamPlan('Léo');
    s.controller.checkReturns(until + 1000);
    await s.controller.handle({ type: 'meeting.participant.rejoin', meetingId: m.id, participantId: paused.participants.find(p => p.provider === 'claude')!.id });
    s.controller.checkReturns(until + 2000);
    await s.waitUntil(() => s.meetings.getMeeting(m.id)!.distribution?.state === 'distributed', 5000);
    assert.equal(s.controller.history(m.id).turns.filter(t => t.phase !== 'plan').length, 0, 'nenhuma rodada refeita');
    assert.equal(s.runs.length, 2);
  } finally { await s.cleanup(); }
});
