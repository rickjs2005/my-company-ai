// Testes dos helpers puros da sala de Reuniões (rodam em Node, sem DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AiModelOption, AiProviderStatus, Employee, Meeting, MeetingDecision, MeetingHistory, MeetingParticipant, MeetingTaskItem, MeetingTurn, Settings,
} from '@milweb-hq/protocol';
import { MEETING_MAX_ROUNDS } from '@milweb-hq/protocol';
import {
  aiAvailability, canAddRound, canDiscuss, configChip, errorMessage, formatMeetingTime, groupDecisions, mentionAtCursor, mentionSuggestions,
  modelOptionLabel, newId, parseMentions, participantConfig, participantInitial, participantStateLabel, proposeTaskItems, providerSummary,
  resolveTargets, sortedModels,
} from '../src/meetings/helpers';

// ---------------- Fixtures ----------------

function participant(p: Partial<MeetingParticipant> & Pick<MeetingParticipant, 'id' | 'kind' | 'name'>): MeetingParticipant {
  return {
    meetingId: 'm1', provider: p.kind === 'ai' ? 'claude' : null, employeeId: null, model: null, effort: null, useGlobal: true,
    state: 'available', stateDetail: null, threadId: null, seat: 0, order: 0, ...p,
  };
}

const chefe = participant({ id: 'p-chefe', kind: 'chefe', name: 'Chefe', order: 0 });
const claude = participant({ id: 'p-claude', kind: 'ai', name: 'Claude', provider: 'claude', order: 1 });
const gpt = participant({ id: 'p-gpt', kind: 'ai', name: 'ChatGPT', provider: 'openai', order: 2 });
const parts = [chefe, claude, gpt];

function meeting(m: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1', title: 'Arquitetura', agenda: 'Decidir o banco', projectId: 'proj-1', mode: 'guided', status: 'active', roundLimit: 2, currentRound: 0,
    contextVersion: 1, synthesisParticipantId: null, companyContext: false, createdAt: 1, updatedAt: 1, startedAt: null, endedAt: null,
    participants: parts, minutes: null, activeTurnId: null, queuedTurns: 0, ...m,
  };
}

function decision(d: Partial<MeetingDecision> & Pick<MeetingDecision, 'id' | 'kind'>): MeetingDecision {
  return { meetingId: 'm1', text: d.id, participantId: null, confirmed: false, dismissed: false, assigneeEmployeeId: null, messageId: null, createdAt: 1, updatedAt: 1, ...d };
}

function turn(t: Partial<MeetingTurn> & Pick<MeetingTurn, 'id' | 'phase' | 'status'>): MeetingTurn {
  return { meetingId: 'm1', participantId: 'p-claude', round: 1, requested: { model: null, effort: null }, applied: null, contextVersion: 1, createdAt: 1, startedAt: null, finishedAt: null, error: null, messageId: null, promptChars: 0, usage: null, durationMs: null, order: 0, ...t };
}

function taskItem(i: Partial<MeetingTaskItem> & Pick<MeetingTaskItem, 'id' | 'title'>): MeetingTaskItem {
  return { meetingId: 'm1', instructions: '', employeeId: null, roomId: null, projectId: null, status: 'proposed', taskId: null, sessionId: null, createdAt: 1, decisionId: null, ...i };
}

function history(h: Partial<MeetingHistory> = {}): MeetingHistory {
  return { messages: [], turns: [], decisions: [], context: [], taskItems: [], ...h };
}

function model(id: string, efforts: AiModelOption['efforts'], extra: Partial<AiModelOption> = {}): AiModelOption {
  return { id, label: id, efforts, defaultEffort: efforts[0] ?? null, ...extra };
}

function status(extra: Partial<AiProviderStatus> = {}): AiProviderStatus {
  return {
    provider: 'claude', label: 'Claude', routeLabel: 'via Claude Code', installed: true, exePath: null, version: '2.1.0', latestKnownVersion: null,
    authState: 'ok', authMethod: 'claude.ai · max', authDetail: null, models: [], catalogSource: 'binário', catalogAt: null, checkedAt: null,
    busy: false, lastTest: null, login: null, prefs: { model: null, effort: null }, ...extra,
  };
}

function employee(e: Partial<Employee> & Pick<Employee, 'id' | 'name'>): Employee {
  return { access: { mcp: 'none' }, role: 'Dev', roomId: 'r1', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0, instructions: '', profileId: null, model: null, effort: null, permissionMode: 'default' as Employee['permissionMode'], activeSessionId: null, archivedAt: null, createdAt: 1, updatedAt: 1, provider: 'claude', skills: [], agent: null, template: null, ...e };
}

const settings = { ai: { claude: { model: null, effort: null }, openai: { model: null, effort: null } } } as unknown as Settings;

// ---------------- Menções ----------------

test('parseMentions acha @Nome sem diferenciar caixa e na ordem do texto', () => {
  assert.deepEqual(parseMentions('@chatgpt e depois @Claude, o que acham?', parts), ['p-gpt', 'p-claude']);
  assert.deepEqual(parseMentions('sem menção nenhuma', parts), []);
  assert.deepEqual(parseMentions('', parts), []);
});

test('parseMentions respeita fronteira de palavra e não repete ids', () => {
  const claudete = participant({ id: 'p-claudete', kind: 'ai', name: 'Claudete' });
  assert.deepEqual(parseMentions('@Claudete responde', [claude, claudete]), ['p-claudete']);
  assert.deepEqual(parseMentions('@Claude @Claude', parts), ['p-claude']);
  assert.deepEqual(parseMentions('email@Claude.com', parts), [], 'um @ colado em texto não é menção');
});

test('mentionAtCursor e mentionSuggestions', () => {
  assert.deepEqual(mentionAtCursor('oi @Cl', 6), { start: 3, query: 'Cl' });
  assert.deepEqual(mentionAtCursor('@', 1), { start: 0, query: '' });
  assert.equal(mentionAtCursor('oi @Cl ', 7), null, 'espaço depois fecha a menção');
  assert.equal(mentionAtCursor('sem arroba', 10), null);
  assert.deepEqual(mentionSuggestions('cha', parts).map(p => p.id), ['p-gpt']);
  assert.deepEqual(mentionSuggestions('', parts).map(p => p.id), ['p-claude', 'p-gpt'], 'o Chefe nunca é sugerido');
});

// ---------------- Destinos ----------------

test('resolveTargets: "all" devolve lista vazia (contrato de meeting.say) mesmo com menções', () => {
  assert.deepEqual(resolveTargets('all', ['p-claude'], parts), []);
});

test('resolveTargets une seletor e menções, só IAs existentes', () => {
  assert.deepEqual(resolveTargets('claude', [], parts), ['p-claude']);
  assert.deepEqual(resolveTargets('p-gpt', ['p-chefe', 'x'], parts), ['p-gpt']);
  assert.deepEqual(resolveTargets('openai', ['p-claude'], parts), [], 'cobrir todas as IAs vira "todos"');
  assert.deepEqual(resolveTargets('nao-existe', [], parts), []);
});

// ---------------- Quadro ----------------

test('groupDecisions separa confirmadas, pendentes, propostas, abertas, ações e descartadas em ordem de criação', () => {
  const g = groupDecisions([
    decision({ id: 'd2', kind: 'decision', confirmed: true, createdAt: 2 }),
    decision({ id: 'd1', kind: 'decision', createdAt: 1 }),
    decision({ id: 'p1', kind: 'proposal' }),
    decision({ id: 'q1', kind: 'question' }),
    decision({ id: 'v1', kind: 'divergence' }),
    decision({ id: 'a1', kind: 'action' }),
    decision({ id: 'x1', kind: 'proposal', dismissed: true }),
  ]);
  assert.deepEqual(g.decisions.map(d => d.id), ['d2']);
  assert.deepEqual(g.pending.map(d => d.id), ['d1']);
  assert.deepEqual(g.proposals.map(d => d.id), ['p1']);
  assert.deepEqual(g.open.map(d => d.id), ['q1', 'v1']);
  assert.deepEqual(g.actions.map(d => d.id), ['a1']);
  assert.deepEqual(g.dismissed.map(d => d.id), ['x1']);
});

// ---------------- Rótulos e chips ----------------

test('participantStateLabel traduz todos os estados e devolve o próprio valor quando desconhecido', () => {
  assert.equal(participantStateLabel('available'), 'Disponível');
  assert.equal(participantStateLabel('waiting_turn'), 'Aguardando a vez');
  assert.equal(participantStateLabel('responding'), 'Respondendo…');
  assert.equal(participantStateLabel('waiting_chefe'), 'Aguardando o Chefe');
  assert.equal(participantStateLabel('interrupted'), 'Interrompido');
  assert.equal(participantStateLabel('unavailable'), 'Indisponível');
  assert.equal(participantStateLabel('zzz' as never), 'zzz');
});

test('configChip: modelo, esforço e resolvido só quando difere', () => {
  assert.equal(configChip(null), '');
  assert.equal(configChip({ model: 'fable', effort: 'high', resolvedModel: 'claude-fable-5-1' }), 'fable · Alto · claude-fable-5-1');
  assert.equal(configChip({ model: 'gpt-5.1', effort: null, resolvedModel: 'gpt-5.1' }), 'gpt-5.1');
  assert.equal(configChip({ model: null, effort: 'medium' }), 'modelo padrão · Médio');
});

test('participantInitial: R, C, G ou inicial do funcionário', () => {
  assert.equal(participantInitial(chefe), 'R');
  assert.equal(participantInitial(claude), 'C');
  assert.equal(participantInitial(gpt), 'G');
  assert.equal(participantInitial({ kind: 'ai', provider: 'openai', name: 'ana' }), 'A');
});

// ---------------- Tempo ----------------

test('formatMeetingTime: hoje só hora, mesmo ano com dia, outro ano completo, inválido com travessão', () => {
  const now = new Date(2026, 9, 31, 15, 0).getTime();
  assert.equal(formatMeetingTime(new Date(2026, 9, 31, 9, 5).getTime(), now), '09:05');
  assert.equal(formatMeetingTime(new Date(2026, 2, 3, 22, 40).getTime(), now), '03/03 22:40');
  assert.equal(formatMeetingTime(new Date(2025, 11, 25, 8, 0).getTime(), now), '25/12/2025 08:00');
  assert.equal(formatMeetingTime(null, now), '—');
  assert.equal(formatMeetingTime(0, now), '—');
  assert.equal(formatMeetingTime(Number.NaN, now), '—');
});

// ---------------- Rodadas ----------------

test('canDiscuss só no modo debate, sem turno ativo nem fila, com alguma IA disponível', () => {
  assert.equal(canDiscuss(meeting({ mode: 'debate', status: 'draft' })), true);
  assert.equal(canDiscuss(meeting({ mode: 'guided' })), false);
  assert.equal(canDiscuss(meeting({ mode: 'debate', status: 'paused' })), false);
  assert.equal(canDiscuss(meeting({ mode: 'debate', activeTurnId: 't1' })), false);
  assert.equal(canDiscuss(meeting({ mode: 'debate', queuedTurns: 1 })), false);
  const offline = parts.map(p => (p.kind === 'ai' ? { ...p, state: 'unavailable' as const } : p));
  assert.equal(canDiscuss(meeting({ mode: 'debate', participants: offline })), false);
});

test('canAddRound exige síntese concluída, nada rodando e respeita o teto', () => {
  const done = history({ turns: [turn({ id: 't1', phase: 'synthesis', status: 'done' })] });
  assert.equal(canAddRound(meeting({ mode: 'debate', currentRound: 2 }), done), true);
  assert.equal(canAddRound(meeting({ mode: 'debate', currentRound: 2 }), history({ turns: [turn({ id: 't1', phase: 'synthesis', status: 'running' })] })), false);
  assert.equal(canAddRound(meeting({ mode: 'debate', currentRound: 2 }), null), false);
  assert.equal(canAddRound(meeting({ mode: 'guided' }), done), false);
  assert.equal(canAddRound(meeting({ mode: 'debate', status: 'ended' }), done), false);
  assert.equal(canAddRound(meeting({ mode: 'debate', activeTurnId: 'x' }), done), false);
  assert.equal(canAddRound(meeting({ mode: 'debate', currentRound: MEETING_MAX_ROUNDS }), done), false);
});

// ---------------- Tarefas ----------------

test('proposeTaskItems: itens existentes mais decisões/ações confirmadas sem item; nada de proposta sem confirmação', () => {
  const h = history({
    decisions: [
      decision({ id: 'd1', kind: 'decision', text: 'Migrar para SQLite', confirmed: true, createdAt: 2, assigneeEmployeeId: 'e1' }),
      decision({ id: 'd2', kind: 'decision', text: 'Trocar a fonte', confirmed: false, createdAt: 3 }),
      decision({ id: 'a1', kind: 'action', text: 'Escrever o teste', confirmed: true, createdAt: 1 }),
      decision({ id: 'a2', kind: 'action', text: 'Descartada', confirmed: true, dismissed: true, createdAt: 4 }),
      decision({ id: 'p1', kind: 'proposal', text: 'Proposta dos modelos', confirmed: true, createdAt: 5 }),
    ],
    taskItems: [
      taskItem({ id: 'i1', title: 'escrever o teste', status: 'created', taskId: 'task-9', employeeId: 'e2', createdAt: 1 }),
      taskItem({ id: 'i2', title: 'Item descartado', status: 'dismissed' }),
    ],
  });
  const out = proposeTaskItems(h, meeting({ title: 'Arquitetura', agenda: 'Decidir o banco', projectId: 'proj-1' }));
  assert.deepEqual(out.map(o => [o.itemId, o.decisionId, o.status]), [['i1', null, 'created'], [null, 'd1', 'new']]);
  assert.equal(out[0].taskId, 'task-9');
  assert.equal(out[1].title, 'Migrar para SQLite');
  assert.equal(out[1].employeeId, 'e1');
  assert.equal(out[1].projectId, 'proj-1');
  assert.match(out[1].instructions, /Origem: reunião "Arquitetura"/);
  assert.match(out[1].instructions, /Pauta: Decidir o banco/);
});

test('proposeTaskItems: item sem projeto herda o da reunião; sem nada confirmado devolve vazio', () => {
  const h = history({ taskItems: [taskItem({ id: 'i1', title: 'x', projectId: null })] });
  assert.equal(proposeTaskItems(h, meeting({ projectId: 'proj-2' }))[0].projectId, 'proj-2');
  assert.deepEqual(proposeTaskItems(history(), meeting()), []);
});

// ---------------- Estado real dos provedores ----------------

test('providerSummary é honesto sobre instalação e login', () => {
  assert.equal(providerSummary(undefined, 'openai').text, 'ChatGPT · estado desconhecido (o servidor ainda não informou)');
  assert.equal(providerSummary(status(), 'claude').text, 'Claude · via Claude Code · logado via claude.ai · max');
  assert.equal(providerSummary(status({ installed: false }), 'claude').ok, false);
  const nologin = providerSummary(status({ provider: 'openai', label: 'ChatGPT', routeLabel: 'via Codex', authState: 'missing', authDetail: 'rode o login' }), 'openai');
  assert.equal(nologin.text, 'ChatGPT · via Codex · sem login');
  assert.equal(nologin.detail, 'rode o login');
  assert.equal(providerSummary(status({ authState: 'error' }), 'claude').text, 'Claude · via Claude Code · erro ao verificar o login');
});

test('aiAvailability: ok com uma IA utilizável; motivo real quando nenhuma', () => {
  assert.deepEqual(aiAvailability(meeting(), []), { ok: true, reason: null });
  assert.equal(aiAvailability(meeting({ participants: [chefe] }), []).ok, false);
  const off = meeting({ participants: [chefe, { ...claude, state: 'unavailable', stateDetail: 'sem login' }, { ...gpt, state: 'unavailable', stateDetail: null }] });
  const r = aiAvailability(off, [status({ provider: 'openai', label: 'ChatGPT', routeLabel: 'via Codex', installed: false })]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Claude: sem login · ChatGPT: ChatGPT · via Codex · não instalado');
});

test('participantConfig segue a precedência reunião > funcionário > global > provedor', () => {
  const cat = status({ models: [model('claude-opus-5-5', ['low', 'high'], { isDefault: true, defaultEffort: 'high' }), model('fable', ['high', 'max'], { recommended: true })] });
  const emp = employee({ id: 'e1', name: 'Ana', model: 'fable', effort: 'max' });
  assert.equal(participantConfig(claude, [], [cat], settings).source, 'padrão do provedor');
  assert.equal(participantConfig(claude, [], [cat], settings).chip, 'claude-opus-5-5 · Alto');
  assert.equal(participantConfig(claude, [], [status({ ...cat, prefs: { model: 'fable', effort: 'high' } })], settings).source, 'padrão global');
  assert.equal(participantConfig({ ...claude, employeeId: 'e1' }, [emp], [cat], settings).source, 'do funcionário');
  const custom = participantConfig({ ...claude, employeeId: 'e1', useGlobal: false, model: 'fable', effort: 'high' }, [emp], [cat], settings);
  assert.equal(custom.source, 'personalizado nesta reunião');
  assert.equal(custom.chip, 'fable · Alto');
  assert.equal(participantConfig(claude, [], [], null).source, 'padrão do provedor', 'sem catálogo nem settings não inventa nada');
});

test('sortedModels põe recomendados e padrão na frente; modelOptionLabel junta rótulo, id e notas', () => {
  const cat = status({ models: [model('a', []), model('b', ['low'], { isDefault: true }), model('c', ['low'], { recommended: true, label: 'Modelo C', note: 'rápido' })] });
  assert.deepEqual(sortedModels(cat).map(m => m.id), ['c', 'b', 'a']);
  assert.deepEqual(sortedModels(undefined), []);
  assert.equal(modelOptionLabel(cat.models[2]), 'Modelo C (c) · recomendado · rápido');
  assert.equal(modelOptionLabel(cat.models[1]), 'b · padrão');
});

// ---------------- Erros e ids ----------------

test('errorMessage e newId', () => {
  assert.equal(errorMessage(new Error('sem login')), 'sem login');
  assert.equal(errorMessage('texto'), 'texto');
  assert.equal(errorMessage(null), 'erro desconhecido');
  assert.equal(errorMessage({}), 'erro desconhecido');
  assert.notEqual(newId(), newId());
  assert.ok(newId().length >= 8);
});

test('proposeTaskItems: decisão com item vinculado (título editado no diálogo) não volta como proposta', () => {
  const h = history({
    decisions: [decision({ id: 'd1', kind: 'decision', text: 'Migrar para Postgres', confirmed: true })],
    taskItems: [taskItem({ id: 'i1', title: 'Migrar o banco para Postgres', decisionId: 'd1' })],
  });
  assert.deepEqual(proposeTaskItems(h, meeting()).map(o => [o.itemId, o.decisionId]), [['i1', 'd1']]);
});
