// Contas derivadas do estado real da sala de conteúdo (sem estado próprio): prioridades do Radar, semana em dias, resumo da
// mesa do Chefe. Funções puras, testadas em web/test/content.test.ts.
import type { ContentItem, ContentRound, ContentState, RadarItem, SocialAccount, SocialState } from '@milweb-hq/protocol';

const WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "qua 04/11" a partir de YYYY-MM-DD (sem fuso: a data já é de Brasília). */
export function dayLabel(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay();
  return `${WEEKDAY[wd]} ${String(day).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}
export function addDays(d: string, n: number): string { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
export function todayBrt(now = Date.now()): string { return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
export function weekDays(start: string): string[] { return Array.from({ length: 7 }, (_, i) => addDays(start, i)); }

/** Rodada mais recente de um tipo (qualquer estado). */
export function latestRound(c: ContentState | null, kind: ContentRound['kind']): ContentRound | null {
  return c?.rounds.filter(r => r.kind === kind).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/** As até três prioridades da rodada do Radar mais recente que produziu oportunidades (descartadas saem). */
export function priorities(c: ContentState | null): RadarItem[] {
  if (!c) return [];
  const round = c.rounds.filter(r => r.kind === 'radar' && r.status === 'concluida').sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!round) return [];
  return c.radar.filter(r => r.roundId === round.id && r.priority != null && r.status !== 'descartada').sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)).slice(0, 3);
}

/** Semana em foco: a do calendário mais recente concluído; sem calendário, os próximos sete dias a partir de hoje. */
export function focusWeek(c: ContentState | null, now = Date.now()): string {
  const r = c?.rounds.filter(x => x.kind === 'semana' && x.status === 'concluida' && x.weekStart).sort((a, b) => b.startedAt - a.startedAt)[0];
  return r?.weekStart ?? todayBrt(now);
}

/** Peças da semana agrupadas por dia (descartadas fora). Itens sem data vão para "sem data". */
export function itemsByDay(items: ContentItem[], start: string): { day: string | null; items: ContentItem[] }[] {
  const days = weekDays(start);
  const live = items.filter(i => i.status !== 'descartada');
  const inWeek = (i: ContentItem) => (i.date ? days.includes(i.date) : i.weekStart === start);
  const out: { day: string | null; items: ContentItem[] }[] = days.map(d => ({ day: d, items: live.filter(i => i.date === d) }));
  const undated = live.filter(i => !i.date && inWeek(i));
  const loose = live.filter(i => !i.date && !i.weekStart && i.status !== 'publicada');
  const rest = [...undated, ...loose.filter(l => !undated.includes(l))];
  if (rest.length) out.push({ day: null, items: rest });
  return out;
}

export interface DeskSummary {
  priorities: RadarItem[];
  toReview: ContentItem[];
  access: { text: string; kind: 'conta' | 'sala' | 'publicacao' }[];
  produced: { at: number; text: string }[];
}

const ready = (a: SocialAccount) => (a.browser?.mode === 'navegador' ? a.browser.state === 'verificada' : a.status === 'connected' || a.status === 'expiring');

/** Mesa do Chefe: três prioridades, entregas para revisar, pendências de acesso e o que a equipe produziu (7 dias). */
export function deskSummary(c: ContentState | null, s: SocialState | null, now = Date.now()): DeskSummary {
  const access: DeskSummary['access'] = [];
  for (const m of c?.setup.missing ?? []) access.push({ text: m, kind: 'sala' });
  // Destino pausado pelo foco não cobra login (volta a cobrar quando o Chefe incluir de novo).
  const inFocus = (slot: string) => !c?.focus?.activeSlots || (c.focus.activeSlots as string[]).includes(slot);
  for (const a of s?.accounts ?? []) if (!ready(a) && inFocus(a.slot)) access.push({ text: a.browser?.mode === 'navegador' ? `${a.label}: ${a.browser.state === 'cadastrada' || a.browser.state === 'aguardando_login' ? 'falta o seu login pelo navegador da HQ (Central de Redes → Conectar pelo navegador)' : a.browser.detail || a.browser.state}` : `${a.label}: ${a.nextStep ?? a.statusDetail}`, kind: 'conta' });
  const open = s?.browser?.open;
  if (open?.manual) access.push({ text: `Você está com o controle da janela de ${s!.accounts.find(x => x.slot === open.slot)?.label}: devolva ao funcionário quando terminar.`, kind: 'conta' });
  for (const i of c?.items ?? []) if (i.status === 'publicacao_pendente') access.push({ text: `"${i.title}": ${i.publication?.detail ?? 'cole o link do post para a HQ conferir'}`, kind: 'publicacao' });
  const since = now - 7 * 86_400_000;
  const produced: DeskSummary['produced'] = [];
  for (const r of c?.rounds ?? []) if (r.finishedAt && r.finishedAt >= since && (r.status === 'concluida' || r.status === 'vazia')) {
    produced.push({ at: r.finishedAt, text: r.kind === 'radar' ? `Radar: ${c!.radar.filter(x => x.roundId === r.id).length} oportunidade(s)${r.status === 'vazia' ? ' (nada pertinente)' : ''}` : r.kind === 'semana' ? `Calendário da semana de ${dayLabel(r.weekStart ?? '')}` : r.kind === 'analise' ? 'Análise semanal de resultados' : 'Transcrição de captura' });
  }
  for (const i of c?.items ?? []) if (i.updatedAt >= since && ['revisar', 'ajustar', 'aprovada', 'publicacao_pendente', 'publicada'].includes(i.status) && i.deliverable) {
    produced.push({ at: i.updatedAt, text: `Peça "${i.title}"${i.status === 'publicada' ? ' (publicada)' : i.review ? ` (revisão: ${i.review.verdict})` : ''}` });
  }
  produced.sort((a, b) => b.at - a.at);
  return {
    priorities: priorities(c),
    toReview: (c?.items ?? []).filter(i => i.status === 'revisar' || i.status === 'ajustar'),
    access,
    produced: produced.slice(0, 12),
  };
}

/** Rótulo curto do estado de uma rodada. */
export function roundState(r: ContentRound): string {
  return r.status === 'aguardando' ? (r.taskId ? 'na fila ou em execução' : 'criando a tarefa') : r.status === 'concluida' ? 'concluída' : r.status === 'vazia' ? 'nada pertinente encontrado' : `falhou: ${r.error ?? 'sem motivo'}`;
}
