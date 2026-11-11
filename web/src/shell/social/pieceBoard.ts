// Regras puras do mural por peça (uma peça = um cartão, com as rodadas de criação e revisão dentro dela), dos filtros, do
// lote, do progresso do pedido do dia e do que está parado. Tudo calculado das peças, das contas e das tarefas reais.
import type { ContentHidden, ContentItem, ContentRequest, ContentState, DeskDelivery, SocialSlotId, Task } from '@milweb-hq/protocol';
import { SOCIAL_SLOTS } from '@milweb-hq/protocol';

const OPEN: Task['status'][] = ['queued', 'running', 'waiting_permission', 'waiting_answer'];
const taskOf = (tasks: Task[], id: string | null) => (id ? tasks.find(t => t.id === id) ?? null : null);

export type PieceColumn = 'fila' | 'producao' | 'revisar' | 'parcial' | 'pronto' | 'publicada' | 'planejada' | 'pausada';
export const PIECE_COLUMNS: { id: PieceColumn; label: string; hint: string }[] = [
  { id: 'producao', label: 'Em produção', hint: 'um funcionário está criando ou revisando agora (ou esperando você)' },
  { id: 'fila', label: 'Na fila', hint: 'esperando a vez na fila da equipe' },
  { id: 'revisar', label: 'Para revisar', hint: 'entrega completa conferida pela HQ: falta a sua revisão' },
  { id: 'parcial', label: 'Parcial ou falhou', hint: 'a produção terminou sem tudo o que o formato exige, ou falhou: veja o que falta e o próximo passo' },
  { id: 'planejada', label: 'Planejadas', hint: 'ainda não foram para a produção' },
  { id: 'pronto', label: 'Aprovadas', hint: 'você aprovou; postar é com você (nada é publicado sem o seu clique)' },
  { id: 'publicada', label: 'Publicadas', hint: 'publicação conferida' },
  { id: 'pausada', label: 'Pausadas pelo foco', hint: 'destino fora do foco atual: nada produz, agenda ou publica; o trabalho e os arquivos ficam' },
];

/** Coluna da peça pelo estado dela e pela tarefa ligada (fila ou rodando). */
export function pieceColumn(i: ContentItem, tasks: Task[]): PieceColumn {
  if (i.pausedReason && i.status !== 'publicada' && i.status !== 'agendada') return 'pausada';
  if (i.status === 'em_producao') return taskOf(tasks, i.taskId)?.status === 'queued' ? 'fila' : 'producao';
  if ((i.status === 'revisar' || i.status === 'ajustar') && i.reviewTaskId && !i.review) { const t = taskOf(tasks, i.reviewTaskId); if (t && OPEN.includes(t.status)) return t.status === 'queued' ? 'fila' : 'producao'; }
  if (i.status === 'revisar' || i.status === 'ajustar') return 'revisar';
  if (i.status === 'parcial' || i.status === 'falhou') return 'parcial';
  if (i.status === 'aprovada' || i.status === 'publicacao_pendente' || i.status === 'agendada') return 'pronto';
  if (i.status === 'publicada') return 'publicada';
  // Peça de um plano na linha de produção (08/11): etapa rodando = a equipe está fazendo; etapa que falhou espera o Chefe.
  const steps = i.pipeline?.steps ?? [];
  if (steps.some(s => s.status === 'falhou')) return 'parcial';
  if (steps.some(s => s.status === 'fazendo')) return 'producao';
  if (steps.some(s => s.status === 'pendente')) return 'fila';
  return 'planejada';
}

/** Ativa = no mural principal (fora da lixeira, do arquivo e das descartadas). */
export const isActive = (i: ContentItem) => !i.deletedAt && !i.archivedAt && i.status !== 'descartada';

export type PieceView = 'ativas' | 'revisar' | 'producao' | 'parcial' | 'planejada' | 'pronto' | 'pausadas' | 'arquivadas' | 'lixeira';
export const PIECE_VIEWS: { id: PieceView; label: string }[] = [
  { id: 'ativas', label: 'Todas as ativas' }, { id: 'revisar', label: 'Para revisar' }, { id: 'producao', label: 'Em produção ou na fila' }, { id: 'parcial', label: 'Parcial ou falhou' },
  { id: 'planejada', label: 'Planejadas' }, { id: 'pronto', label: 'Aprovadas e publicadas' }, { id: 'pausadas', label: 'Pausadas pelo foco' }, { id: 'arquivadas', label: 'Arquivadas' }, { id: 'lixeira', label: 'Lixeira' },
];
export interface PieceFilter { profileId: string | null; slot: SocialSlotId | ''; from: string; to: string; view: PieceView }

/** Filtro do mural: marca (perfil), conta, período (data da peça) e estado. Lote e "selecionar todas" respeitam este filtro. */
export function filterPieces(items: ContentItem[], f: PieceFilter, tasks: Task[]): ContentItem[] {
  return items.filter(i => {
    if (f.view === 'lixeira') { if (!i.deletedAt) return false; }
    else if (f.view === 'arquivadas') { if (i.deletedAt || !i.archivedAt) return false; }
    else {
      if (!isActive(i)) return false;
      const c = pieceColumn(i, tasks);
      if (f.view === 'revisar' && c !== 'revisar') return false;
      if (f.view === 'producao' && c !== 'producao' && c !== 'fila') return false;
      if (f.view === 'parcial' && c !== 'parcial') return false;
      if (f.view === 'planejada' && c !== 'planejada') return false;
      if (f.view === 'pronto' && c !== 'pronto' && c !== 'publicada') return false;
      if (f.view === 'pausadas' && c !== 'pausada') return false;
    }
    if (f.profileId && (i.profileId ?? null) !== f.profileId) return false;
    if (f.slot && i.slot !== f.slot) return false;
    if (f.from && (!i.date || i.date < f.from)) return false;
    if (f.to && (!i.date || i.date > f.to)) return false;
    return true;
  }).sort((a, b) => `${a.date ?? '9999'}${a.time ?? ''}`.localeCompare(`${b.date ?? '9999'}${b.time ?? ''}`) || a.createdAt - b.createdAt);
}

/** Contadores do mural (objeto na sala e cabeçalho): só peças ativas; tarefa de pesquisa nunca conta como peça. */
export function pieceCounts(items: ContentItem[], tasks: Task[], profileId: string | null = null): { queued: number; producing: number; review: number; ready: number; partial: number } {
  const out = { queued: 0, producing: 0, review: 0, ready: 0, partial: 0 };
  for (const i of items) {
    if (!isActive(i) || (profileId && (i.profileId ?? null) !== profileId)) continue;
    const c = pieceColumn(i, tasks);
    if (c === 'fila') out.queued++; else if (c === 'producao') out.producing++; else if (c === 'revisar') out.review++; else if (c === 'pronto') out.ready++; else if (c === 'parcial') out.partial++;
  }
  return out;
}

/** O que "Cancelar tarefa e mover para a lixeira" vai parar: a tarefa rodando e as que estão na fila (criação e revisão). */
export function runningScope(i: ContentItem, tasks: Task[]): { running: Task[]; queued: Task[] } {
  const linked = [taskOf(tasks, i.taskId), i.review ? null : taskOf(tasks, i.reviewTaskId)].filter((t): t is Task => Boolean(t));
  return { running: linked.filter(t => t.status !== 'queued' && OPEN.includes(t.status)), queued: linked.filter(t => t.status === 'queued') };
}

export type SlotState = 'pronta' | 'producao' | 'parcial' | 'pendente' | 'falta' | 'pausado' | 'removida';
export interface RequestRow { slot: SocialSlotId; label: string; item: ContentItem | null; state: SlotState; text: string; /** Funcionário da tarefa ativa (criação ou revisão). */ employeeId: string | null }
export interface RequestProgress { request: ContentRequest; rows: RequestRow[]; expected: number; ready: number; producing: number; pending: number }

/** Progresso real do pedido: uma linha por conta pedida, com a peça principal daquela conta e o estado dela. */
export function requestProgress(req: ContentRequest, items: ContentItem[], tasks: Task[], paused?: SocialSlotId[]): RequestProgress {
  const mine = items.filter(i => i.requestId === req.id && !i.deletedAt);
  const rows: RequestRow[] = req.slots.map(slot => {
    const label = SOCIAL_SLOTS.find(s => s.slot === slot)?.label ?? slot;
    const cands = mine.filter(i => i.slot === slot && !i.archivedAt && i.status !== 'descartada');
    const rank = (i: ContentItem) => ({ publicada: 0, aprovada: 1, publicacao_pendente: 1, agendada: 1, revisar: 2, ajustar: 3, em_producao: 4, parcial: 5, falhou: 6, planejada: 7, descartada: 9 } as Record<string, number>)[i.status] ?? 8;
    const item = cands.sort((a, b) => rank(a) - rank(b))[0] ?? null;
    if (!item && paused?.includes(slot)) return { slot, label, item, state: 'pausado', text: 'destino pausado pelo foco atual: não recebe tarefa', employeeId: null };
    // O Chefe mandou a peça desta conta para a lixeira: não é "peça faltando" (05/11, bloqueios presos em pedidos antigos).
    if (!item && items.some(i => i.requestId === req.id && i.slot === slot && i.deletedAt)) return { slot, label, item, state: 'removida', text: 'você mandou a peça para a lixeira', employeeId: null };
    if (!item) return { slot, label, item, state: 'falta', text: paused?.includes(slot) ? 'destino pausado pelo foco atual: não recebe tarefa' : req.autoProduce ? 'sem peça: esperando a pesquisa (Radar) encaminhar a pauta' : 'sem peça neste pedido', employeeId: null };
    if (item.pausedReason) return { slot, label, item, state: 'pausado', text: `pausada pelo foco: ${item.pausedReason}`, employeeId: null };
    const c = pieceColumn(item, tasks);
    const state: SlotState = c === 'revisar' || c === 'pronto' || c === 'publicada' ? 'pronta' : c === 'producao' || c === 'fila' ? 'producao' : c === 'parcial' ? 'parcial' : 'pendente';
    const t = taskOf(tasks, item.status === 'em_producao' ? item.taskId : item.reviewTaskId);
    const stage = item.status === 'em_producao' ? 'criação' : 'revisão';
    const text = state === 'producao' ? (t?.status === 'queued' ? `na fila da ${stage}` : t?.status === 'waiting_permission' ? 'esperando a sua autorização (Mesa → Bloqueios)' : t?.status === 'waiting_answer' ? 'esperando a sua resposta (Mesa → Perguntas)' : `em ${stage}`)
      : state === 'pronta' ? (item.status === 'ajustar' ? 'revisor pediu ajuste: decida' : c === 'pronto' ? 'aprovada' : c === 'publicada' ? 'publicada' : 'pronta para você revisar')
        : item.nextStep ?? (state === 'pendente' ? 'planejada, ainda não foi para a produção' : '');
    return { slot, label, item, state, text, employeeId: state === 'producao' ? t?.employeeId ?? null : null };
  });
  // Destino pausado pelo foco fica visível na linha, mas não conta como esperado nem como pendente.
  const live = rows.filter(r => r.state !== 'pausado' && r.state !== 'removida');
  return { request: req, rows, expected: live.length, ready: live.filter(r => r.state === 'pronta').length, producing: live.filter(r => r.state === 'producao').length, pending: live.filter(r => r.state !== 'pronta' && r.state !== 'producao').length };
}

/** Pedidos em andamento (ativos), do mais próximo para o mais distante. */
export function activeRequests(c: ContentState | null): ContentRequest[] {
  return (c?.requests ?? []).filter(r => r.status === 'ativo').sort((a, b) => a.date.localeCompare(b.date) || b.createdAt - a.createdAt);
}

/** Cartão escondido (arquivo ou lixeira) de uma tarefa avulsa ou entrega de reunião. */
export const hiddenState = (hidden: ContentHidden[], key: string) => hidden.find(h => h.key === key)?.state ?? null;

/** Tarefas da sala que não são peça (nem criação nem revisão de uma), nem pesquisa, calendário ou análise, nem entrega de
 *  reunião (essas ficam na Mesa): pedidos avulsos. */
export function looseTasks(tasks: Task[], c: ContentState | null, deliveries: DeskDelivery[], pieceOf: (t: Task) => ContentItem | null): Task[] {
  const rounds = new Set((c?.rounds ?? []).map(r => r.taskId).filter(Boolean));
  const desk = new Set(deliveries.map(d => d.taskId));
  return tasks.filter(t => !rounds.has(t.id) && !desk.has(t.id) && !pieceOf(t) && !/^Rodada do Radar|^Preparar a semana|^Análise semanal/.test(t.prompt));
}

/** Pode aprovar: peça entregue (para revisar ou com o ajuste do revisor), fora da pausa, da lixeira e do arquivo, sem tarefa rodando. */
export function canApprove(i: ContentItem, tasks: Task[]): boolean {
  if (i.deletedAt || i.archivedAt || i.pausedReason) return false;
  if (i.status !== 'revisar' && i.status !== 'ajustar') return false;
  const s = runningScope(i, tasks);
  return s.running.length + s.queued.length === 0;
}

/** Período da aprovação de um clique: de hoje até a data da peça (ou sete dias, quando não tem data ou a data já passou). */
export function approvalWindow(i: ContentItem, today: string): { from: string; to: string } {
  const plus7 = (() => { const t = new Date(`${today}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 7); return t.toISOString().slice(0, 10); })();
  return { from: today, to: i.date && i.date > today ? i.date : plus7 };
}

/** "Já publiquei": peça entregue (para revisar, ajustar, aprovada ou com publicação a conferir), fora da lixeira e sem tarefa
 *  rodando; ou publicada sem link (só para acrescentar o link). */
export function publishAction(i: ContentItem, tasks: Task[]): 'marcar' | 'link' | null {
  if (i.deletedAt) return null;
  if (i.status === 'publicada') return i.publication?.verifiedBy === 'chefe' && !i.publication.url ? 'link' : null;
  if (!['revisar', 'ajustar', 'aprovada', 'publicacao_pendente', 'agendada'].includes(i.status)) return null;
  const s = runningScope(i, tasks);
  return s.running.length + s.queued.length === 0 ? 'marcar' : null;
}
