// Helpers puros da sala de Reuniões: rótulos em português, menções, destinos, agrupamento do quadro, chips de
// configuração e propostas de tarefa. Sem React e sem DOM, para rodar em Node (web/test/meetings.test.ts).
import {
  EFFORT_LABELS, MEETING_MAX_ROUNDS,
  type AiProviderId, type AiProviderStatus, type DecisionKind, type EffortLevel, type Employee, type Meeting, type MeetingDecision,
  type MeetingHistory, type MeetingMode, type MeetingParticipant, type MeetingStatus, type MeetingTaskItem, type ParticipantState,
  type Settings, type TurnPhase, type TurnStatus,
} from '@milweb-hq/protocol';

// ---------------- Rótulos ----------------

export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  draft: 'Rascunho', active: 'Ativa', paused: 'Pausada', ended: 'Encerrada',
};
export const MEETING_STATUS_COLORS: Record<MeetingStatus, string> = {
  draft: 'var(--text-faint)', active: 'var(--ok)', paused: 'var(--warn)', ended: 'var(--text-dim)',
};
export function meetingStatusLabel(status: MeetingStatus): string { return MEETING_STATUS_LABELS[status] ?? status; }
export function meetingStatusColor(status: MeetingStatus): string { return MEETING_STATUS_COLORS[status] ?? 'var(--text-dim)'; }

export const MEETING_MODE_LABELS: Record<MeetingMode, string> = { guided: 'Conversa guiada', debate: 'Discutir a pauta' };
export const MEETING_MODE_HINTS: Record<MeetingMode, string> = {
  guided: 'Você fala, cada destinatário responde uma vez. Você conduz o ritmo.',
  debate: 'Cada IA dá a opinião inicial, revisa a do outro em rodadas e uma delas fecha com a síntese.',
};
export function meetingModeLabel(mode: MeetingMode): string { return MEETING_MODE_LABELS[mode] ?? mode; }

export const PARTICIPANT_STATE_LABELS: Record<ParticipantState, string> = {
  available: 'Disponível',
  waiting_turn: 'Aguardando a vez',
  responding: 'Respondendo…',
  waiting_chefe: 'Aguardando o Chefe',
  interrupted: 'Interrompido',
  unavailable: 'Indisponível',
  away: 'Fora da reunião',
};
export const PARTICIPANT_STATE_COLORS: Record<ParticipantState, string> = {
  available: 'var(--ok)', waiting_turn: 'var(--info)', responding: 'var(--amber)', waiting_chefe: 'var(--warn)',
  interrupted: 'var(--warn)', unavailable: 'var(--danger)', away: 'var(--text-faint)',
};

/** Preferência de layout da tela de reuniões guardada só neste navegador (falha silenciosa sem armazenamento). */
export function readMeetPref(key: string, fallback: boolean): boolean {
  try { const v = window.localStorage.getItem(`hq.meet.${key}`); return v === null ? fallback : v === '1'; } catch { return fallback; }
}
export function writeMeetPref(key: string, value: boolean): void {
  try { window.localStorage.setItem(`hq.meet.${key}`, value ? '1' : '0'); } catch { /* sem armazenamento: vale só nesta visita */ }
}
export function participantStateLabel(state: ParticipantState): string { return PARTICIPANT_STATE_LABELS[state] ?? state; }
export function participantStateColor(state: ParticipantState): string { return PARTICIPANT_STATE_COLORS[state] ?? 'var(--text-dim)'; }

export const TURN_PHASE_LABELS: Record<TurnPhase, string> = { reply: 'resposta', opinion: 'opinião inicial', revision: 'revisão', synthesis: 'síntese', plan: 'plano consolidado' };

/** Gerente = Claude ou ChatGPT à mesa sem representar um funcionário. */
export function isManager(p: { kind: string; employeeId: string | null }): boolean { return p.kind === 'ai' && !p.employeeId; }
/** Responsável pela consolidação (mesma regra do servidor): o escolhido, se for gerente e estiver à mesa; senão o outro gerente disponível. */
export function planOwnerOf(m: { participants: { id: string; kind: string; employeeId: string | null; away?: unknown; name: string }[]; synthesisParticipantId: string | null }) {
  const managers = m.participants.filter(isManager);
  return managers.find(p => p.id === m.synthesisParticipantId && !p.away) ?? managers.find(p => !p.away) ?? null;
}
export function turnPhaseLabel(phase: TurnPhase | null | undefined): string { return phase ? TURN_PHASE_LABELS[phase] ?? phase : ''; }

export const TURN_STATUS_LABELS: Record<TurnStatus, string> = {
  queued: 'na fila', running: 'em andamento', done: 'concluído', failed: 'falhou', interrupted: 'interrompido', lost: 'perdido', skipped: 'pulado',
};

export const DECISION_KIND_LABELS: Record<DecisionKind, string> = {
  decision: 'Decisão', proposal: 'Proposta', divergence: 'Divergência', question: 'Pergunta', action: 'Próxima ação',
};
export const DECISION_KINDS: DecisionKind[] = ['decision', 'proposal', 'divergence', 'question', 'action'];

/** Rota real de um participante de IA, como aparece na barra e na conversa. */
export function providerRouteLabel(provider: AiProviderId | null): string {
  if (provider === 'claude') return 'via Claude Code';
  if (provider === 'openai') return 'via Codex';
  return '';
}

export function providerName(provider: AiProviderId): string { return provider === 'claude' ? 'Claude' : 'ChatGPT'; }

/** Letra do avatar: R (Chefe), C (Claude), G (ChatGPT) ou a inicial do nome quando for um funcionário. */
export function participantInitial(p: Pick<MeetingParticipant, 'kind' | 'provider' | 'name'>): string {
  if (p.kind === 'chefe') return 'R';
  const n = p.name.trim();
  if (n && n !== 'Claude' && n !== 'ChatGPT') return n[0].toUpperCase();
  return p.provider === 'openai' ? 'G' : 'C';
}

// ---------------- Estado real dos provedores ----------------

export interface ProviderSummary { provider: AiProviderId; ok: boolean; text: string; detail: string | null }

/** Linha honesta sobre um provedor: "Claude · via Claude Code · logado via claude.ai · max". Nunca inventa estado. */
export function providerSummary(s: AiProviderStatus | undefined, provider: AiProviderId): ProviderSummary {
  const name = providerName(provider);
  if (!s) return { provider, ok: false, text: `${name} · estado desconhecido (o servidor ainda não informou)`, detail: null };
  let auth: string;
  let ok = false;
  if (!s.installed) auth = 'não instalado';
  else if (s.authState === 'ok') { auth = s.authMethod ? `logado via ${s.authMethod}` : 'logado'; ok = true; }
  else if (s.authState === 'missing') auth = 'sem login';
  else if (s.authState === 'error') auth = 'erro ao verificar o login';
  else auth = 'login não verificado';
  const route = s.routeLabel || providerRouteLabel(provider);
  return { provider, ok, text: [s.label || name, route, auth].filter(Boolean).join(' · '), detail: s.authDetail ?? null };
}

export interface AiAvailability { ok: boolean; reason: string | null }

/** Há pelo menos um participante de IA que pode responder? O motivo vem do estado real (participante ou provedor). */
export function aiAvailability(meeting: Pick<Meeting, 'participants'>, ai: AiProviderStatus[]): AiAvailability {
  const ais = meeting.participants.filter(p => p.kind === 'ai');
  if (ais.length === 0) return { ok: false, reason: 'Esta reunião não tem nenhum participante de IA.' };
  const usable = ais.filter(p => p.state !== 'unavailable');
  if (usable.length > 0) return { ok: true, reason: null };
  const reasons = ais.map(p => {
    const st = ai.find(s => s.provider === p.provider);
    const why = p.stateDetail ?? (st ? providerSummary(st, st.provider).text : null) ?? 'indisponível';
    return `${p.name}: ${why}`;
  });
  return { ok: false, reason: reasons.join(' · ') };
}

// ---------------- Menções e destinos ----------------

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Ids dos participantes mencionados como "@Nome" no texto (sem diferenciar caixa; o nome precisa terminar numa fronteira,
 * então "@Claude" não casa com "@Claudete"). Nomes mais longos são testados antes. Ordem = primeira aparição no texto.
 */
export function parseMentions(text: string, participants: Pick<MeetingParticipant, 'id' | 'name'>[]): string[] {
  if (!text || !text.includes('@')) return [];
  const found: { id: string; at: number }[] = [];
  const sorted = [...participants].filter(p => p.name.trim()).sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRe(p.name.trim())}(?![\\p{L}\\p{N}_])`, 'iu');
    const m = re.exec(text);
    if (m && !found.some(f => f.id === p.id)) found.push({ id: p.id, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map(f => f.id);
}

/** Valor do seletor de destino: 'all', um provedor ('claude' | 'openai') ou o id de um participante. */
export type TargetSelectValue = 'all' | AiProviderId | string;

/**
 * Destino final = destino do seletor ∪ menções, só participantes de IA existentes. Lista vazia significa "todos"
 * (contrato de meeting.say), então 'all' devolve [] mesmo com menções, e um conjunto que cobre todas as IAs também.
 */
export function resolveTargets(selectValue: TargetSelectValue, mentions: string[], participants: Pick<MeetingParticipant, 'id' | 'kind' | 'provider'>[]): string[] {
  const ais = participants.filter(p => p.kind === 'ai');
  if (selectValue === 'all' || !selectValue) return [];
  const ids = new Set<string>();
  if (selectValue === 'claude' || selectValue === 'openai') ais.filter(p => p.provider === selectValue).forEach(p => ids.add(p.id));
  else if (ais.some(p => p.id === selectValue)) ids.add(selectValue);
  for (const m of mentions) if (ais.some(p => p.id === m)) ids.add(m);
  if (ids.size > 0 && ais.every(p => ids.has(p.id))) return [];
  return ais.filter(p => ids.has(p.id)).map(p => p.id);
}

/** Sugestões de @menção: participantes de IA cujo nome começa com o trecho digitado (sem caixa); sem trecho, todos. */
export function mentionSuggestions(query: string, participants: MeetingParticipant[]): MeetingParticipant[] {
  const q = query.trim().toLowerCase();
  return participants.filter(p => p.kind === 'ai' && (!q || p.name.toLowerCase().startsWith(q)));
}

/** Acha "@trecho" imediatamente antes do cursor (sem espaço no meio). */
export function mentionAtCursor(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, cursor));
  const m = /(^|\s)@([^\s@]*)$/u.exec(before);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, query: m[2] };
}

// ---------------- Quadro ----------------

export interface DecisionGroups {
  /** Confirmadas pelo Chefe. */
  decisions: MeetingDecision[];
  /** Decisões ainda sem confirmação do Chefe. */
  pending: MeetingDecision[];
  proposals: MeetingDecision[];
  /** Divergências e perguntas abertas. */
  open: MeetingDecision[];
  actions: MeetingDecision[];
  dismissed: MeetingDecision[];
}

/** Agrupa o quadro. Itens descartados saem dos grupos e vão para `dismissed`; cada grupo fica em ordem de criação. */
export function groupDecisions(decisions: MeetingDecision[]): DecisionGroups {
  const g: DecisionGroups = { decisions: [], pending: [], proposals: [], open: [], actions: [], dismissed: [] };
  for (const d of [...decisions].sort((a, b) => a.createdAt - b.createdAt)) {
    if (d.dismissed) { g.dismissed.push(d); continue; }
    switch (d.kind) {
      case 'decision': (d.confirmed ? g.decisions : g.pending).push(d); break;
      case 'proposal': g.proposals.push(d); break;
      case 'divergence': case 'question': g.open.push(d); break;
      case 'action': g.actions.push(d); break;
    }
  }
  return g;
}

// ---------------- Configuração de modelo e esforço ----------------

export type ConfigLike = { model: string | null; effort: EffortLevel | null; resolvedModel?: string | null } | null | undefined;

/** "fable · Alto · claude-fable-5-1" (o modelo resolvido só aparece quando difere do pedido). Config nula = ''. */
export function configChip(config: ConfigLike): string {
  if (!config) return '';
  const parts: string[] = [config.model ?? 'modelo padrão'];
  if (config.effort) parts.push(EFFORT_LABELS[config.effort] ?? config.effort);
  if (config.resolvedModel && config.resolvedModel !== config.model) parts.push(config.resolvedModel);
  return parts.join(' · ');
}

export type ConfigSourceLabel = 'personalizado nesta reunião' | 'do funcionário' | 'padrão global' | 'padrão do provedor';
export interface ParticipantConfigView { model: string | null; effort: EffortLevel | null; source: ConfigSourceLabel; chip: string }

/** Configuração em vigor para o participante seguindo a precedência: reunião > funcionário > padrão global > provedor. */
export function participantConfig(p: MeetingParticipant, employees: Employee[], ai: AiProviderStatus[], settings: Settings | null): ParticipantConfigView {
  const finish = (model: string | null, effort: EffortLevel | null, source: ConfigSourceLabel): ParticipantConfigView => ({ model, effort, source, chip: configChip({ model, effort }) });
  if (!p.useGlobal && (p.model || p.effort)) return finish(p.model, p.effort, 'personalizado nesta reunião');
  const emp = p.employeeId ? employees.find(e => e.id === p.employeeId) : null;
  if (emp && (emp.model || emp.effort)) return finish(emp.model, emp.effort, 'do funcionário');
  const status = p.provider ? ai.find(s => s.provider === p.provider) : null;
  const prefs = status?.prefs ?? (p.provider && settings ? settings.ai[p.provider] : null);
  if (prefs && (prefs.model || prefs.effort)) return finish(prefs.model, prefs.effort, 'padrão global');
  const def = status?.models.find(m => m.isDefault) ?? null;
  return finish(def?.id ?? null, def?.defaultEffort ?? null, 'padrão do provedor');
}

/** Modelos de um provedor para o seletor: recomendados primeiro, depois o padrão, depois os demais (ordem original). */
export function sortedModels(status: AiProviderStatus | undefined): AiProviderStatus['models'] {
  if (!status) return [];
  return [...status.models].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) || Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
}

export function modelOptionLabel(m: AiProviderStatus['models'][number]): string {
  const bits = [m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id];
  if (m.recommended) bits.push('recomendado');
  if (m.isDefault) bits.push('padrão');
  if (m.note) bits.push(m.note);
  return bits.join(' · ');
}

// ---------------- Tempo ----------------

/** Hoje: HH:MM · outro dia do ano: dd/mm HH:MM · outro ano: dd/mm/aaaa HH:MM. Valor inválido: "—". */
export function formatMeetingTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts == null || !Number.isFinite(ts) || ts < 1e9) return '—';
  const d = new Date(ts);
  const n = new Date(now);
  const p = (x: number) => String(x).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hm;
  const dm = `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
  if (d.getFullYear() === n.getFullYear()) return `${dm} ${hm}`;
  return `${dm}/${d.getFullYear()} ${hm}`;
}

// ---------------- Rodadas ----------------

/** "Mais uma rodada" só depois da síntese, sem turno ativo nem fila, e sem passar do teto absoluto. */
export function canAddRound(meeting: Meeting, history: MeetingHistory | null): boolean {
  if (meeting.mode !== 'debate' || meeting.status === 'ended') return false;
  if (meeting.activeTurnId || meeting.queuedTurns > 0) return false;
  if (meeting.currentRound >= MEETING_MAX_ROUNDS) return false;
  if (!history) return false;
  return history.turns.some(t => t.phase === 'synthesis' && t.status === 'done');
}

/** "Discutir a pauta": modo debate, reunião em rascunho ou ativa, nada rodando nem na fila, alguma IA disponível. */
export function canDiscuss(meeting: Meeting): boolean {
  return meeting.mode === 'debate' && (meeting.status === 'draft' || meeting.status === 'active') && !meeting.activeTurnId && meeting.queuedTurns === 0
    && meeting.participants.some(p => p.kind === 'ai' && p.state !== 'unavailable');
}

// ---------------- Tarefas a partir do quadro ----------------

export interface ProposedTask {
  /** null quando ainda não existe MeetingTaskItem (o diálogo cria um antes de enviar meeting.tasks.create). */
  itemId: string | null;
  decisionId: string | null;
  title: string;
  instructions: string;
  employeeId: string | null;
  projectId: string | null;
  status: MeetingTaskItem['status'] | 'new';
  taskId: string | null;
}

function sameTitle(a: string, b: string): boolean { return a.trim().toLowerCase() === b.trim().toLowerCase(); }

/**
 * Propostas de tarefa: os itens já existentes (proposed/created) mais as decisões e ações confirmadas pelo Chefe, não
 * descartadas, que ainda não têm item com o mesmo título. Nada de proposta de modelo sem confirmação.
 */
export function proposeTaskItems(history: Pick<MeetingHistory, 'decisions' | 'taskItems'>, meeting: Pick<Meeting, 'title' | 'agenda' | 'projectId'>): ProposedTask[] {
  const out: ProposedTask[] = [];
  const items = [...history.taskItems].sort((a, b) => a.createdAt - b.createdAt);
  for (const it of items) {
    if (it.status === 'dismissed') continue;
    out.push({ itemId: it.id, decisionId: it.decisionId, title: it.title, instructions: it.instructions, employeeId: it.employeeId, projectId: it.projectId ?? meeting.projectId, status: it.status, taskId: it.taskId });
  }
  const confirmed = history.decisions
    .filter(d => d.confirmed && !d.dismissed && (d.kind === 'decision' || d.kind === 'action'))
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const d of confirmed) {
    // Decisão que já tem item (pelo vínculo; itens antigos ou feitos à mão, pelo título) não volta como proposta, mesmo com o título editado.
    if (history.taskItems.some(it => it.decisionId === d.id || (!it.decisionId && sameTitle(it.title, d.text)))) continue;
    const origin = [`Origem: reunião "${meeting.title}"`, meeting.agenda.trim() ? `Pauta: ${meeting.agenda.trim()}` : null].filter(Boolean).join('\n');
    out.push({ itemId: null, decisionId: d.id, title: d.text.trim(), instructions: `${d.text.trim()}\n\n${origin}`, employeeId: d.assigneeEmployeeId, projectId: meeting.projectId, status: 'new', taskId: null });
  }
  return out;
}

// ---------------- Erros e ids ----------------

/** Mensagem legível de uma rejeição do host (nunca stack trace). */
export function errorMessage(err: unknown): string {
  if (!err) return 'erro desconhecido';
  if (typeof err === 'string') return err;
  const e = err as { message?: unknown };
  if (typeof e.message === 'string' && e.message) return e.message;
  return 'erro desconhecido';
}

/** Ids novos para itens criados no cliente (itens de contexto, clientId do envio). */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
