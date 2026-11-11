// Regras puras da tela Conteúdo (05/11; 06/11: Instagram do Tuco e Instagram + Threads da Aurora, "Esperando você" com
// as perguntas da equipe e "A equipe está fazendo" com todo o trabalho da sala, não só as peças). Tudo calculado das peças,
// das referências e das tarefas reais (nada inventado).
import type { ContentItem, ContentRoundKind, ContentState, QuickFormat, RadarItem, SocialSlotId, Task } from '@milweb-hq/protocol';
import { CONTENT_ROUND_LABEL, QUICK_SLOTS } from '@milweb-hq/protocol';
import { VIDEO_LINK } from './VideoRefComposer';
import { isActive, pieceColumn } from './pieceBoard';

export type HomeColumn = 'fazendo' | 'ver' | 'pronto' | 'postado';
export const HOME_COLUMNS: { id: HomeColumn; label: string; hint: string; empty: string }[] = [
  { id: 'ver', label: 'Esperando você', hint: 'peças para olhar e perguntas da equipe', empty: 'Nada esperando você.' },
  { id: 'fazendo', label: 'A equipe está fazendo', hint: 'quem está com o quê: não precisa de você', empty: 'Ninguém trabalhando agora.' },
  { id: 'pronto', label: 'Pronto para postar', hint: 'aprovado: poste no app e clique em "Já publiquei"', empty: 'Nada aprovado ainda.' },
  { id: 'postado', label: 'Postado', hint: 'últimos 14 dias', empty: 'Nada postado nos últimos 14 dias.' },
];

/** Vídeo de referência vira Reel: só as contas do Instagram. */
export const VIDEO_SLOTS = ['instagram-tuco', 'instagram-aurora'] as const;
export const SLOT_LABEL: Record<string, string> = { 'instagram-tuco': 'Tuco · Instagram', 'instagram-aurora': 'Aurora · Instagram', threads: 'Aurora · Threads', tiktok: 'TikTok' };
export const FORMAT_LABEL: Record<QuickFormat, string> = { video: 'Reel', carrossel: 'Carrossel', texto: 'Texto' };

const DAY = 86_400_000;
export const isQuickSlot = (s: SocialSlotId | null | undefined): s is (typeof QUICK_SLOTS)[number] => Boolean(s && (QUICK_SLOTS as readonly string[]).includes(s));

/** Coluna da peça na tela Conteúdo; null = fica fora (outra rede, pausada, lixeira, arquivada ou postada há mais de 14 dias). */
export function homeColumn(i: ContentItem, tasks: Task[], now = Date.now()): HomeColumn | null {
  if (!isQuickSlot(i.slot) || !isActive(i)) return null;
  const c = pieceColumn(i, tasks);
  if (c === 'pausada') return null;
  if (c === 'fila' || c === 'producao') return 'fazendo';
  if (c === 'revisar' || c === 'parcial' || c === 'planejada') return 'ver';
  if (c === 'pronto') return 'pronto';
  return i.publication && now - i.publication.at <= 14 * DAY ? 'postado' : null;
}

/** Referência de vídeo que ainda não tem peça viva: aparece como cartão próprio (depois disso, a peça fala por ela). */
export function homeRefColumn(r: RadarItem, items: ContentItem[], now = Date.now()): HomeColumn | null {
  const v = r.video; if (!v || r.status === 'descartada') return null;
  if (v.slot && !(VIDEO_SLOTS as readonly string[]).includes(v.slot)) return null;
  if (v.itemIds.some(id => items.some(i => i.id === id && !i.deletedAt))) return null;
  if (['recebida', 'inspecionando', 'analisando', 'discussao', 'producao', 'renderizando', 'aula', 'exercicios'].includes(v.stage)) return 'fazendo';
  if (v.stage === 'bloqueada' || v.stage === 'proposta') return 'ver';
  // Estudo da Academia concluído: fica em "Esperando você" por 7 dias (ou até "Descartar") para o Chefe ver a correção.
  if (v.mode === 'estudo' && v.stage === 'concluida' && now - (v.updatedAt ?? 0) <= 7 * DAY) return 'ver';
  return null;
}

export interface HomeBoard { cols: Record<HomeColumn, { items: ContentItem[]; refs: RadarItem[] }>; otherNetworks: number }

export function homeBoard(c: ContentState | null, tasks: Task[], now = Date.now()): HomeBoard {
  const cols: HomeBoard['cols'] = { fazendo: { items: [], refs: [] }, ver: { items: [], refs: [] }, pronto: { items: [], refs: [] }, postado: { items: [], refs: [] } };
  if (!c) return { cols, otherNetworks: 0 };
  let otherNetworks = 0;
  for (const i of c.items) {
    const col = homeColumn(i, tasks, now);
    if (col) cols[col].items.push(i);
    else if (isActive(i) && !isQuickSlot(i.slot) && i.status !== 'publicada') otherNetworks++;
  }
  for (const r of c.radar) { const col = homeRefColumn(r, c.items); if (col) cols[col].refs.push(r); }
  const upd = (a: ContentItem, b: ContentItem) => b.updatedAt - a.updatedAt;
  // "Para você ver": primeiro o que está pronto para olhar, depois as pendências (parcial, falhou) e por fim as planejadas.
  const seeRank = (i: ContentItem) => (i.status === 'revisar' || i.status === 'ajustar' ? 0 : i.status === 'planejada' ? 2 : 1);
  cols.fazendo.items.sort(upd); cols.ver.items.sort((a, b) => seeRank(a) - seeRank(b) || upd(a, b));
  cols.pronto.items.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || upd(a, b));
  cols.postado.items.sort((a, b) => (b.publication?.at ?? 0) - (a.publication?.at ?? 0));
  for (const k of Object.keys(cols) as HomeColumn[]) cols[k].refs.sort((a, b) => (b.video?.updatedAt ?? 0) - (a.video?.updatedAt ?? 0));
  return { cols, otherNetworks };
}

/** Trabalho da sala que não é peça nem vídeo de referência (pedido direto a um funcionário, Radar, análise). */
export interface LooseWork { task: Task; label: string; state: 'fila' | 'fazendo' | 'parou' | 'entregue'; since: number; reason: string | null; files?: string[] }

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '')}…`);
const OPEN = new Set(['queued', 'running']);
const STOPPED = new Set(['error', 'lost', 'interrupted']);

/** Nome curto do trabalho: a rodada (Radar, análise...) ou a primeira linha do pedido, sem o comando da skill. */
export function taskLabel(t: Task, roundKind: ContentRoundKind | null = null): string {
  if (roundKind) return CONTENT_ROUND_LABEL[roundKind];
  const line = t.prompt.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '';
  const text = line.replace(/^\/[\w:.-]+\s*/, '').replace(/https?:\/\/\S+/g, ' ').replace(/^[\s.,;:!-]+/, '').replace(/\s+/g, ' ').trim();
  if (/^rodada do radar/i.test(text)) return CONTENT_ROUND_LABEL.radar;
  if (!text) return /https?:\/\//.test(line) ? 'Análise de um link' : 'Tarefa sem texto';
  return cut(text.charAt(0).toUpperCase() + text.slice(1), 110);
}

/**
 * Tarefas da sala fora das peças e das referências de vídeo (que têm cartão próprio): na fila ou rodando vão para "A equipe
 * está fazendo"; as que pararam nas últimas 24 h (erro, queda, reinício) vão para "Esperando você", até o Chefe pedir de novo
 * ou dispensar. Pergunta pendente aparece pela própria pergunta, não aqui.
 */
export function looseWork(roomTasks: Task[], c: ContentState | null, now = Date.now()): { doing: LooseWork[]; stopped: LooseWork[]; delivered: LooseWork[] } {
  const items = c?.items ?? [];
  const rounds = c?.rounds ?? [];
  const hidden = new Set((c?.hidden ?? []).filter(h => h.kind === 'task').map(h => h.key));
  const retried = new Set(roomTasks.map(t => t.retryOf).filter(Boolean));
  const doing: LooseWork[] = []; const stopped: LooseWork[] = []; const delivered: LooseWork[] = [];
  for (const t of roomTasks) {
    if (items.some(i => i.taskId === t.id || i.reviewTaskId === t.id)) continue;
    // Produção e revisão de peça (inclusive tentativas antigas): a peça fala por elas no quadro.
    // O pedido guardado pode começar com a skill ("/milweb-video-studio Produzir a peça..."): sem tirar o prefixo, a produção
    // antiga de uma peça refeita aparecia em "Esperando você" como entrega solta (08/11).
    if (/^(Produzir|Revisar|Publicar pelo navegador) a peça\b/.test(t.prompt.trimStart().replace(/^\/[\w:.-]+\s+/, ''))) continue;
    // O que o próprio Chefe cancelou não é "parou".
    if (t.errors.some(e => /cancelad[ao] .*pelo Chefe/i.test(e))) continue;
    const round = rounds.find(r => r.taskId === t.id) ?? null;
    // Análise de vídeo e Academia (estudo, exercício, correção): o cartão do vídeo e a Academia mostram o andamento.
    if (round && ['video', 'estudo', 'exercicio', 'correcao', 'plano', 'etapa'].includes(round.kind)) continue;
    if (hidden.has(`task:${t.id}`)) continue;
    const label = taskLabel(t, round?.kind ?? null);
    if (OPEN.has(t.status)) doing.push({ task: t, label, state: t.status === 'running' ? 'fazendo' : 'fila', since: (t.status === 'running' ? t.startedAt : null) ?? t.createdAt, reason: null });
    else if (STOPPED.has(t.status) && !retried.has(t.id) && now - (t.finishedAt ?? t.createdAt) <= 86_400_000) {
      stopped.push({ task: t, label, state: 'parou', since: t.finishedAt ?? t.createdAt, reason: stopReason(t) });
    } else if (t.status === 'done' && !round && t.origin !== 'routine' && !t.meetingId && now - (t.finishedAt ?? t.createdAt) <= 86_400_000) {
      // Pedido direto a um funcionário que terminou: a entrega espera o Chefe olhar (até ele marcar "Visto", por 24 h).
      const files = (t.deliverables ?? []).filter(d => d.kind === 'file' && d.path && d.changeType !== 'deleted').map(d => d.path!);
      delivered.push({ task: t, label, state: 'entregue', since: t.finishedAt ?? t.createdAt, reason: null, files });
    }
  }
  doing.sort((a, b) => (a.state === b.state ? a.since - b.since : a.state === 'fazendo' ? -1 : 1));
  stopped.sort((a, b) => b.since - a.since);
  delivered.sort((a, b) => b.since - a.since);
  return { doing, stopped, delivered };
}

/** Arquivos que valem abrir primeiro numa entrega: vídeo, imagem e texto final antes de script e configuração. */
export function mainFiles(files: string[], max = 3): string[] {
  const rank = (f: string) => (/\.(mp4|mov|webm)$/i.test(f) ? 0 : /\.(png|jpe?g|webp|gif)$/i.test(f) ? 1 : /(peca|entrega|roteiro|legenda)\.(md|txt|json)$/i.test(f) ? 2 : /\.(md|txt|html)$/i.test(f) ? 3 : 9);
  return [...new Set(files)].filter(f => rank(f) < 9).sort((a, b) => rank(a) - rank(b)).slice(0, max);
}

/** Motivo em palavras simples: a última mensagem legível da HQ; diagnóstico técnico ("[x] chave=valor") fica de fora. */
export function stopReason(t: Task): string {
  const human = [...t.errors].reverse().find(e => e.trim() && !/^\s*\[/.test(e) && !/\w+=\S+\s+\w+=\S+/.test(e));
  if (human) return cut(human.replace(/\s+/g, ' ').trim(), 160);
  if (t.status === 'interrupted') return 'Parou no meio (a HQ reiniciou ou a tarefa foi interrompida).';
  if (t.status === 'lost') return 'O processo do funcionário caiu no meio da tarefa.';
  return 'Deu erro no meio da tarefa.';
}

/** "há 6 min", "há 2 h": tempo desde que começou ou parou. */
export function ago(t: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'há 1 dia' : `há ${d} dias`;
}

/** Foco que a tela precisa: as três contas da tela ativas. */
export function focusMissing(c: ContentState | null): SocialSlotId[] {
  const active = c?.focus?.activeSlots;
  if (!c || active === null || active === undefined) return []; // foco nunca definido = tudo liberado
  return QUICK_SLOTS.filter(s => !active.includes(s));
}

/** O pedido tem link de vídeo? Então vira referência (analisar e produzir a versão própria), não peça do zero. */
export const hasVideoLink = (text: string) => (text.match(/https?:\/\/[^\s<>"']+/gi) ?? []).some(u => VIDEO_LINK.test(u));

/** Conta sugerida pelo perfil do topo e pelo texto ("threads" no pedido vence). */
export function suggestSlot(text: string, profileId: string | null): (typeof QUICK_SLOTS)[number] {
  const t = text.replace(/https?:\/\/\S+/gi, ' ').toLowerCase();
  if (/\bthreads?\b/.test(t)) return 'threads';
  if (/\baurora\b/.test(t)) return 'instagram-aurora';
  if (/\btuco\b/.test(t)) return 'instagram-tuco';
  return profileId === 'aurora' ? 'instagram-aurora' : 'instagram-tuco';
}

/** Formato sugerido pela conta (Threads é texto) e pelo texto ("carrossel"/"slides" no pedido). */
export const suggestFormat = (text: string, slot: SocialSlotId = 'instagram-tuco'): QuickFormat =>
  (slot === 'threads' ? 'texto' : /carross|slides?\b|post de imagens/i.test(text) ? 'carrossel' : 'video');

/**
 * Onde está de verdade a análise de um vídeo compartilhado (07/11: o cartão dizia "a equipe está assistindo" enquanto a
 * tarefa esperava na fila atrás de uma reunião). null = nenhuma análise aberta para este vídeo.
 */
export function refTaskState(r: RadarItem, c: ContentState | null, tasks: Task[]): { status: 'fila' | 'rodando' | 'espera'; employeeId: string | null } | null {
  const v = r.video; if (!v || !c) return null;
  const dir = v.dir.toLowerCase().replace(/[\\/]+$/, '');
  const round = c.rounds
    .filter(x => (x.kind === 'video' || x.kind === 'estudo') && x.status === 'aguardando' && x.taskId && x.outputPath.toLowerCase().startsWith(dir))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const t = round ? tasks.find(x => x.id === round.taskId) : null;
  if (!round || !t) return null;
  const employeeId = t.employeeId ?? round.employeeId;
  if (t.status === 'running') return { status: 'rodando', employeeId };
  if (t.status === 'queued') return { status: 'fila', employeeId };
  if (t.status === 'waiting_permission' || t.status === 'waiting_answer') return { status: 'espera', employeeId };
  return null;
}
