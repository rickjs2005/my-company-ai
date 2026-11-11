// "Equipe agora" e conversa particular (08/11/2026, Chefe: "porque parece está tudo parado e ninguém trabalhando?" e "tem que
// ter como eu conversar individualmente com os funcionários"). Lógica pura, testada em web/test/teamnow.test.ts.
import type { ChatItem, ContentState, Employee, Session, Task } from '@milweb-hq/protocol';
import { PIECE_STEP_LABEL, isDmSession } from '@milweb-hq/protocol';
import { taskLabel } from './homeBoard';

export type NowState = 'fazendo' | 'espera' | 'fila' | 'livre';
export interface EmployeeNow {
  id: string;
  name: string;
  role: string;
  state: NowState;
  /** O que está fazendo (ou o próximo da fila), em palavras simples. */
  what: string | null;
  since: number | null;
  /** Tarefas na fila deste funcionário (sem contar a que está rodando). */
  queued: number;
  /** Conversa da tarefa em andamento (para falar com ele no meio dela); null sem tarefa rodando. */
  sessionId: string | null;
  /** O passo de agora, como a atividade do Claude Code descreve ("Escrevendo video.json"); null sem tarefa rodando. */
  detail: string | null;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** O que uma tarefa é, pelo que a HQ sabe dela (peça, etapa, plano, rodada) ou pela primeira linha do pedido. */
export function whatOf(t: Task, c: ContentState | null): string {
  const item = c?.items.find(i => i.taskId === t.id);
  if (item) return `produzindo "${cut(item.title, 60)}"`;
  const rev = c?.items.find(i => i.reviewTaskId === t.id);
  if (rev) return `revisando "${cut(rev.title, 60)}"`;
  const round = c?.rounds.find(r => r.taskId === t.id) ?? null;
  if (round?.kind === 'etapa') {
    const it = c?.items.find(i => i.pipeline?.steps.some(s => s.roundId === round.id));
    const st = it?.pipeline?.steps.find(s => s.roundId === round.id);
    if (it && st) return `${PIECE_STEP_LABEL[st.key].toLowerCase()} de "${cut(it.title, 50)}"`;
  }
  if (round?.kind === 'plano') return 'planejando o seu pedido';
  return cut(taskLabel(t, round?.kind ?? null), 80);
}

const ORDER: Record<NowState, number> = { fazendo: 0, espera: 1, fila: 2, livre: 3 };

/** Estado real de cada funcionário da sala, a partir das tarefas (conversa particular não conta como trabalho). */
export function teamNow(employees: Employee[], tasks: Task[], sessions: Session[], c: ContentState | null): EmployeeNow[] {
  const dm = new Set(sessions.filter(s => isDmSession(s)).map(s => s.id));
  return employees.filter(e => !e.archivedAt).map(e => {
    const mine = tasks.filter(t => t.employeeId === e.id && !dm.has(t.sessionId));
    const running = mine.find(t => t.status === 'running');
    const waiting = mine.find(t => t.status === 'waiting_permission' || t.status === 'waiting_answer');
    const queue = mine.filter(t => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    const base = { id: e.id, name: e.name, role: e.role, queued: queue.length, sessionId: null, detail: null };
    if (running) {
      const act = sessions.find(s => s.id === running.sessionId)?.activity;
      const detail = act && act.phase !== 'idle' && act.detail && act.detail !== 'Disponível' ? cut(act.detail, 90) : null;
      return { ...base, state: 'fazendo' as const, what: whatOf(running, c), since: running.startedAt ?? running.createdAt, queued: queue.length, sessionId: running.sessionId, detail };
    }
    if (waiting) return { ...base, state: 'espera' as const, what: whatOf(waiting, c), since: waiting.startedAt ?? waiting.createdAt };
    if (queue.length) return { ...base, state: 'fila' as const, what: whatOf(queue[0], c), since: queue[0].createdAt };
    return { ...base, state: 'livre' as const, what: null, since: null };
  }).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}

export interface DmMessage { id: string; from: 'chefe' | 'func' | 'aviso'; text: string; ts: number; request: string | null; tools: number }

/** Separa o bloco ```pedido-hq (o pedido que vai para a gerente) do texto da resposta. */
export function splitRequest(text: string): { text: string; request: string | null } {
  const m = /```pedido-hq\s*([\s\S]*?)```/.exec(text);
  if (!m) return { text, request: null };
  let request: string | null = null;
  try { const j = JSON.parse(m[1].trim()) as { pedido?: unknown }; request = typeof j.pedido === 'string' ? j.pedido.trim() : null; } catch { request = m[1].trim() || null; }
  return { text: text.replace(m[0], '').trim(), request };
}

/** Itens do chat da conversa particular em mensagens simples: o Chefe, o funcionário e avisos (ferramentas viram contagem). */
export function dmMessages(items: ChatItem[]): DmMessage[] {
  const out: DmMessage[] = [];
  let tools = 0;
  for (const it of items) {
    if (it.kind === 'user') { out.push({ id: it.id, from: 'chefe', text: it.text, ts: it.ts, request: null, tools: 0 }); tools = 0; }
    else if (it.kind === 'assistant') {
      const { text, request } = splitRequest(it.text);
      if (text || request) out.push({ id: it.id, from: 'func', text, ts: it.ts, request, tools });
      tools = 0;
    } else if (it.kind === 'tool') tools++;
    else if (it.kind === 'notice' && it.level !== 'info') out.push({ id: it.id, from: 'aviso', text: it.text, ts: it.ts, request: null, tools: 0 });
    else if (it.kind === 'result' && it.status !== 'done' && it.status !== 'interrupted') out.push({ id: it.id, from: 'aviso', text: `A resposta não terminou (${it.status})${it.summary ? `: ${cut(it.summary, 160)}` : ''}`, ts: it.ts, request: null, tools: 0 });
  }
  return out;
}

/** Linha de estado da conversa: escrevendo, na fila (com o motivo) ou nada. */
export function dmStatus(tasks: Task[], sessionId: string | null, name: string): string | null {
  if (!sessionId) return null;
  const mine = tasks.filter(t => t.sessionId === sessionId);
  if (mine.some(t => t.status === 'running')) return `${name} está escrevendo…`;
  if (mine.some(t => t.status === 'waiting_permission' || t.status === 'waiting_answer')) return `${name} espera uma autorização sua (veja em "Esperando você")`;
  if (mine.some(t => t.status === 'queued')) return `Mensagem enviada: ${name} responde em instantes`;
  return null;
}
