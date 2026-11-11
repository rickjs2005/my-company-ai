// Helpers puros do painel: rótulos em português, formatação e renderização segura de markdown.
// Sem React e sem DOM obrigatório, para poderem ser testados em Node (web/test/panel.test.ts).

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { AiProviderStatus, LogEntry, PermissionModeOption, RoomKind, SessionStatus, TaskStatus, WorkerPhase, WorkerStatus } from '@milweb-hq/protocol';
import type { TimelineEntry } from './types';

/** Tipo das entradas do registro (o protocolo exporta LogEntry; o kind é derivado daqui). */
export type LogKind = LogEntry['kind'];

// ---------------- Fases do funcionário ----------------

export const PHASE_LABELS: Record<WorkerPhase, string> = {
  idle: 'Disponível',
  thinking: 'Pensando',
  responding: 'Escrevendo resposta',
  reading: 'Lendo',
  writing: 'Escrevendo',
  executing: 'Executando',
  delegating: 'Delegando',
  waiting_permission: 'Aguardando permissão',
  waiting_answer: 'Aguardando resposta',
  done: 'Concluído',
  error: 'Erro',
  disconnected: 'Desconectado',
};

/** Cor da fase como variável CSS de base.css (resolvida pelo navegador). */
export const PHASE_COLORS: Record<WorkerPhase, string> = {
  idle: 'var(--text-faint)',
  thinking: 'var(--info)',
  responding: 'var(--info)',
  reading: 'var(--info)',
  writing: 'var(--amber)',
  executing: 'var(--amber-dim)',
  delegating: '#b07ae0',
  waiting_permission: 'var(--warn)',
  waiting_answer: 'var(--warn)',
  done: 'var(--ok)',
  error: 'var(--danger)',
  disconnected: 'var(--danger)',
};

export function phaseLabel(phase: WorkerPhase | null | undefined): string {
  return phase ? PHASE_LABELS[phase] ?? phase : 'Sem sessão';
}

export function phaseColor(phase: WorkerPhase | null | undefined): string {
  return phase ? PHASE_COLORS[phase] ?? 'var(--text-dim)' : 'var(--text-faint)';
}

// ---------------- Status de sessão, tarefa, modos ----------------

/** Estado real do funcionário (vem do servidor, derivado da conversa ativa e do processo). */
export const WORKER_STATUS_LABELS: Record<WorkerStatus, string> = {
  idle: 'Disponível',
  queued: 'Na fila',
  running: 'Executando',
  waiting_answer: 'Aguardando resposta',
  waiting_permission: 'Aguardando permissão',
  paused: 'Pausado',
  interrupted: 'Interrompido',
  error: 'Com erro',
  observed: 'Observado',
};

export function workerStatusLabel(status: WorkerStatus | null | undefined): string {
  return status ? WORKER_STATUS_LABELS[status] ?? status : 'Sem conversa';
}

export const WORKER_STATUS_COLORS: Record<WorkerStatus, string> = {
  idle: 'var(--text-faint)', queued: 'var(--info)', running: 'var(--amber)', waiting_answer: 'var(--warn)', waiting_permission: 'var(--warn)',
  paused: 'var(--text-dim)', interrupted: 'var(--warn)', error: 'var(--danger)', observed: 'var(--info)',
};

export function workerStatusColor(status: WorkerStatus | null | undefined): string {
  return status ? WORKER_STATUS_COLORS[status] ?? 'var(--text-dim)' : 'var(--text-faint)';
}

/** Função padrão por tipo de sala (igual ao servidor). */
export const ROOM_KIND_ROLES: Record<RoomKind, string> = {
  dev: 'Desenvolvimento', social: 'Social Media', design: 'Design e Vídeo', research: 'Pesquisa e Prospecção', management: 'Gestão e Revisão', direction: 'Diretoria', meeting: 'Reuniões', custom: 'Equipe',
};

/** Hora local curta (HH:MM) para "último estado conhecido às…". */
export function formatClock(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts) || ts < 1e9) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  new: 'Novo',
  active: 'Ativo',
  paused: 'Pausado',
  observed: 'Observado',
  lost: 'Perdido',
  archived: 'Arquivado',
};

export function sessionStatusLabel(status: SessionStatus): string {
  return SESSION_STATUS_LABELS[status] ?? status;
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'Na fila',
  running: 'Em andamento',
  waiting_permission: 'Aguardando permissão',
  waiting_answer: 'Aguardando resposta',
  done: 'Concluída',
  error: 'Erro',
  interrupted: 'Interrompida',
  lost: 'Perdida',
};

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

/** Rótulo da tarefa levando em conta espera ("Aguardando Chefe"), tentativa e "resultado a conferir" (v4). */
export function taskStateLabel(t: { status: TaskStatus; held?: boolean; heldReason?: string | null; review?: 'to_verify' | 'verified' | null; attempt?: number }): string {
  if (t.status === 'queued' && t.held) return t.heldReason && /ausente/i.test(t.heldReason) ? 'Aguardando Chefe' : 'Em espera';
  if (t.review === 'to_verify' && (t.status === 'lost' || t.status === 'error' || t.status === 'interrupted')) return 'Resultado a conferir';
  const base = taskStatusLabel(t.status);
  return t.attempt && t.attempt > 1 ? `${base} · tentativa ${t.attempt}` : base;
}

/** Quem escreveu a resposta: a HQ grava o provedor real em cada item; sem o campo, é uma conversa antiga do Claude Code. */
export function authorLabel(author: 'claude' | 'openai' | undefined): string {
  return author === 'openai' ? 'OpenAI (Codex)' : 'Claude';
}

export const PERMISSION_MODE_LABELS: Record<PermissionModeOption, string> = {
  default: 'Padrão (perguntar)',
  acceptEdits: 'Aceitar edições',
  plan: 'Plano',
  auto: 'Auto',
  dontAsk: 'Não perguntar',
};

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'];

export const MODEL_OPTIONS: { value: string | null; label: string }[] = [
  { value: null, label: 'Padrão do Claude Code' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
];

export function modelLabel(model: string | null | undefined): string {
  const found = MODEL_OPTIONS.find(o => o.value === (model ?? null));
  return found ? found.label : String(model);
}

/**
 * Opções de modelo a partir do catálogo real de um provedor (recomendados primeiro; alias marcado "alias do CLI → id").
 * Sem status ou com catálogo vazio, cai em MODEL_OPTIONS (lista fixa, não verificada).
 */
export function modelOptionsFromCatalog(status: Pick<AiProviderStatus, 'models'> | null | undefined): { value: string | null; label: string }[] {
  if (!status || status.models.length === 0) return MODEL_OPTIONS;
  const rec = status.models.filter(m => m.recommended);
  const rest = status.models.filter(m => !m.recommended);
  return [
    { value: null, label: 'Padrão do provedor' },
    ...[...rec, ...rest].map(m => {
      const parts = [m.label];
      if (m.alias) parts.push(`alias do CLI${m.resolvesTo ? ` → ${m.resolvesTo}` : ''}`);
      else if (m.label !== m.id) parts.push(m.id);
      if (m.note) parts.push(m.note);
      return { value: m.id, label: parts.join(' · ') };
    }),
  ];
}

export const PROCESS_STATE_LABELS: Record<string, string> = {
  starting: 'Iniciando',
  idle: 'Ocioso',
  running: 'Em execução',
  requires_action: 'Precisa de você',
  exited: 'Encerrado',
};

export function processStateLabel(state: string | null | undefined): string {
  if (!state) return 'Sem processo';
  return PROCESS_STATE_LABELS[state] ?? state;
}

// ---------------- Formatação ----------------

/** Duração legível: "< 1 s", "48 s", "1 min 12 s", "2 h 05 min". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 1) return '< 1 s';
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} min ${rs} s` : `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h} h ${String(rm).padStart(2, '0')} min`;
}

/** Hora local curta (HH:MM:SS). Timestamps de exemplo (< 1e9) viram "—". */
export function formatTime(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts) || ts < 1e9) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Custo que o próprio Claude Code calcula (preço de API). Na assinatura não é cobrança à parte, por isso "estimado". */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '';
  return `custo estimado US$ ${usd.toFixed(2).replace('.', ',')}`;
}

export function stepsLabel(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return `${n} passo${n === 1 ? '' : 's'}`;
}

/** Resumos antigos guardavam o subtipo técnico do CLI ("Terminou com erro (success)"); aqui viram texto legível. */
export function resultSummaryLabel(summary: string): string {
  return summary
    .replace(/^Terminou com erro \(success\)$/, 'Terminou com erro na resposta da API')
    .replace(/^Terminou com erro \(error_max_turns\)$/, 'Terminou com erro: limite de passos atingido')
    .replace(/^Terminou com erro \(error_during_execution\)$/, 'Terminou com erro durante a execução');
}

/** "2.1.316 (Claude Code)" → "2.1.316" (a tela já escreve "Claude Code" antes). */
export function cleanClaudeVersion(v: string | null | undefined): string {
  if (!v) return '—';
  return v.replace(/\s*\(Claude Code\)\s*$/i, '') || v;
}

const LIMIT_WINDOW: Record<string, string> = { five_hour: 'de 5 h', seven_day: 'semanal', seven_day_opus: 'semanal do Opus', seven_day_sonnet: 'semanal do Sonnet' };

/**
 * Aviso de limite de uso para a barra de status, em português e só enquanto vale: um limite cujo horário de liberação já
 * passou (o último evento de uma conversa antiga, por exemplo) não aparece mais. null = nada a avisar.
 */
export function rateLimitNotice(rl: { status?: string; utilization?: number; resetsAt?: number; type?: string } | null | undefined, now = Date.now()): { text: string; title: string } | null {
  if (!rl || !rl.status || rl.status === 'allowed') return null;
  const resetMs = rl.resetsAt ? (rl.resetsAt > 1e12 ? rl.resetsAt : rl.resetsAt * 1000) : null;
  if (resetMs != null && resetMs <= now) return null;
  const window = rl.type ? LIMIT_WINDOW[rl.type] ?? '' : '';
  const state = rl.status === 'rejected' ? 'esgotado' : rl.status === 'allowed_warning' ? 'perto do fim' : rl.status;
  const pct = rl.utilization != null ? ` (${Math.round(rl.utilization * 100)}%)` : '';
  let when = '';
  if (resetMs != null) {
    const d = new Date(resetMs); const n = new Date(now);
    const p = (x: number) => String(x).padStart(2, '0');
    const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    when = ` · libera ${sameDay ? '' : `em ${p(d.getDate())}/${p(d.getMonth() + 1)} `}às ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return {
    text: `Limite ${window ? window + ' ' : ''}do Claude ${state}${pct}${when}`,
    title: rl.status === 'rejected' ? 'O Claude recusou novos pedidos até a liberação. A fila espera e retoma sozinha.' : 'O uso está perto do limite da assinatura.',
  };
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

export function basename(p: string | null | undefined): string {
  if (!p) return '';
  const t = p.replace(/[\\/]+$/, '');
  return t.split(/[\\/]/).pop() ?? t;
}

/** Normaliza separadores e caixa para comparar caminhos do Windows. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---------------- Ferramentas ----------------

export type ToolIconKind = 'read' | 'write' | 'exec' | 'delegate' | 'web' | 'question' | 'other';

const READ = new Set(['Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'NotebookRead']);
const WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const EXEC = new Set(['Bash', 'PowerShell', 'Monitor']);
const DELEGATE = new Set(['Agent', 'Task', 'Workflow']);
const WEB = new Set(['WebFetch', 'WebSearch']);

export function toolIconKind(name: string): ToolIconKind {
  if (READ.has(name)) return 'read';
  if (WRITE.has(name)) return 'write';
  if (EXEC.has(name)) return 'exec';
  if (DELEGATE.has(name)) return 'delegate';
  if (WEB.has(name)) return 'web';
  if (name === 'AskUserQuestion') return 'question';
  return 'other';
}

export const TOOL_KIND_LABELS: Record<ToolIconKind, string> = {
  read: 'Leitura',
  write: 'Escrita',
  exec: 'Execução',
  delegate: 'Delegação',
  web: 'Web',
  question: 'Pergunta',
  other: 'Ferramenta',
};

/** Trecho a destacar num pedido de permissão: comando, caminho, URL ou padrão. */
export function permissionHighlight(toolName: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  if (EXEC.has(toolName)) return pick('command');
  if (WRITE.has(toolName) || toolName === 'Read') return pick('file_path') || pick('notebook_path');
  if (WEB.has(toolName)) return pick('url') || pick('query');
  if (toolName === 'Grep' || toolName === 'Glob') return pick('pattern');
  return pick('command') || pick('file_path') || pick('url') || pick('path') || '';
}

// ---------------- Linha do tempo ----------------

export const LOG_KIND_LABELS: Record<LogKind, string> = {
  prompt: 'Pedido',
  text: 'Texto',
  tool_start: 'Ferramenta',
  tool_end: 'Ferramenta',
  permission: 'Permissão',
  permission_decision: 'Decisão',
  question: 'Pergunta',
  task_start: 'Tarefa',
  task_end: 'Tarefa',
  result: 'Resultado',
  error: 'Erro',
  interrupt: 'Interrupção',
  notice: 'Aviso',
  hook: 'Hook',
  rate_limit: 'Limite de uso',
  compact: 'Compactação',
};

export interface TimelineGroup { taskId: string | null; entries: TimelineEntry[] }

/** Agrupa entradas consecutivas pela tarefa, preservando a ordem de chegada. */
export function groupTimeline(entries: TimelineEntry[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.taskId === e.taskId) last.entries.push(e);
    else groups.push({ taskId: e.taskId, entries: [e] });
  }
  return groups;
}

/** Momento em que o turno atual começou (último pedido), para o tempo decorrido. */
export function currentTurnStart(entries: TimelineEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].entry.kind === 'prompt') return entries[i].entry.ts;
  }
  return null;
}

// ---------------- Markdown seguro ----------------

marked.setOptions({ gfm: true, breaks: true, async: false });

if (DOMPurify.isSupported) {
  // Links do assistente abrem em nova aba sem vazar o opener.
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Limpeza mínima usada só fora do navegador (testes em Node); no app o DOMPurify é sempre usado. */
export function fallbackSanitize(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|form|input|textarea|button|link|meta)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|input|textarea|button|link|meta)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '')
    .replace(/<a\b(?![^>]*\btarget=)/gi, '<a target="_blank" rel="noopener noreferrer"');
}

/** Markdown → HTML sanitizado. Nunca devolve script, handlers inline ou javascript: em links. */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md ?? '') as string;
  if (DOMPurify.isSupported) {
    return DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'rel'],
      FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'textarea', 'button'],
    });
  }
  return fallbackSanitize(raw);
}

/** Texto curto para mostrar em listas: primeira linha, sem marcação. */
export function plainExcerpt(md: string, n = 120): string {
  return truncate(md.replace(/[`*_#>]/g, ''), n);
}
