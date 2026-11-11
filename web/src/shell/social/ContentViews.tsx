// Visões do trabalho de conteúdo dentro dos painéis existentes da sala: Radar, Calendário e Resultados no Mural, e o resumo
// da Mesa do Chefe. Tudo vem do estado real do serviço (rodadas, peças, verificações, publicações e resultados).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContentDecision, ContentDestination, ContentItem, ContentItemPatch, ContentResult, ContentState, Employee, QuickFormat, RadarItem, ResearchSource, SocialAccount, SocialSlotId, SocialState, Task } from '@milweb-hq/protocol';
import { CONTENT_DECISION_LABEL, CONTENT_ITEM_STATUS_LABEL, CONTENT_MATERIAL_LABEL, CONTENT_ROLE_LABEL, RADAR_EVIDENCE_LABEL, RADAR_INSPECTED_LABEL, RADAR_KIND_LABEL, RESEARCH_SOURCES, SOCIAL_SLOTS } from '@milweb-hq/protocol';
import { Modal } from '../../panel/dialogs/Modal';
import { addDays, dayLabel, deskSummary, focusWeek, itemsByDay, latestRound, priorities, roundState, todayBrt } from './contentHelpers';
import { NewRequestForm, RequestCard } from './PiecesBoard';
import { VideoRefList } from './VideoRefCards';
import { activeRequests, requestProgress } from './pieceBoard';

export type PublishOutcome =
  | { mode: 'manual'; why: string; openUrl: string; text: string; title: string | null; description: string | null; board: string | null; destinationUrl: string | null; files: string[]; steps: string[] }
  | { mode: 'api'; url: string | null; duplicate: boolean }
  | { mode: 'done' };

export interface ContentApi {
  setup(): Promise<unknown>;
  radarRun(focus: string | null): Promise<unknown>;
  radarDiscard(id: string): Promise<unknown>;
  radarToItem(id: string, slot: SocialSlotId | null): Promise<unknown>;
  weekPrepare(note: string | null): Promise<unknown>;
  /** Manda de uma vez as peças planejadas da semana para a criação (cada uma segue para uma revisão). */
  weekProduce(weekStart: string): Promise<{ produced: number; skipped: string[] }>;
  /** Imagem da pasta de conteúdo como data URL (prévia dos slides); null quando não existe. */
  image(abs: string): Promise<string | null>;
  itemUpdate(id: string, patch: ContentItemPatch): Promise<unknown>;
  produce(id: string, note: string | null): Promise<unknown>;
  /** Tela Conteúdo: o pedido do Chefe vira a peça e já vai para a produção. */
  quickCreate(text: string, slot: SocialSlotId, format: QuickFormat): Promise<{ itemId: string }>;
  review(id: string): Promise<unknown>;
  approve(ids: string[], from: string, to: string, note: string | null): Promise<unknown>;
  publish(id: string, clientId: string): Promise<PublishOutcome>;
  registerPost(id: string, url: string): Promise<{ ok: boolean; detail: string }>;
  resultAdd(r: { itemId: string | null; slot: SocialSlotId | null; postUrl: string | null; metric: string; value: number | null; unit: string | null; periodStart: string | null; periodEnd: string | null; ageHours: number | null; denominator: string | null; hypothesis: string | null; note: string | null }): Promise<unknown>;
  importCsv(csv: string, fileName: string): Promise<{ imported: number; skipped: string[] }>;
  capture(file: File, itemId: string | null, slot: SocialSlotId | null): Promise<unknown>;
  confirmResult(id: string, value?: number | null): Promise<unknown>;
  deleteResult(id: string): Promise<unknown>;
  analysisRun(): Promise<unknown>;
  /** Navegador: leva a peça até a prévia (sem publicar). */
  prepare(id: string): Promise<unknown>;
  /** Navegador: lê as métricas disponíveis nas contas verificadas. */
  collect(): Promise<unknown>;
  destinationSave(d: Omit<ContentDestination, 'updatedAt' | 'state'>, confirm: boolean): Promise<unknown>;
  openUrl(url: string): void;
  /** Arquivo no visualizador da HQ (imagem, vídeo, texto); pasta no Explorador. */
  openFile(abs: string): void;
  openFolder(abs: string): void;
  /** Abre a entrega da peça na HQ: slides, Pin, vídeo e texto, conferidos no disco (index = arquivo inicial). */
  openPiece(item: ContentItem, index?: number): void;
  /** Texto exato a publicar (entrega.json); null quando a peça não tem. */
  pieceText(item: ContentItem): Promise<string | null>;
  /** Lixeira (cancela o que estiver na fila ou rodando), restaurar e arquivar. Nada sai das redes; os arquivos ficam. */
  trash(ids: string[]): Promise<{ trashed: string[]; cancelled: string[] }>;
  restore(ids: string[]): Promise<unknown>;
  archive(ids: string[], archived: boolean): Promise<unknown>;
  /** Cartão de tarefa avulsa ou entrega de reunião: arquivar, lixeira ou mostrar de novo. */
  hidden(key: string, kind: 'task' | 'delivery', state: 'arquivada' | 'lixeira' | null, title: string | null, cancelTaskId: string | null): Promise<unknown>;
  requestCreate(r: { date: string; slots: SocialSlotId[]; note: string | null; autoProduce: boolean; title?: string | null }): Promise<{ requestId: string; produced: number; waiting: SocialSlotId[]; skipped: string[] }>;
  copy(text: string): Promise<boolean>;
  /** Foco: destinos ativos (o resto pausa, sem apagar) e fontes de pesquisa (controle separado). */
  focusSave(activeSlots: SocialSlotId[], sources: { source: ResearchSource; enabled: boolean }[]): Promise<{ paused: string[]; resumed: string[]; cancelled: string[] }>;
  /** "Usar como referência": imagem, vídeo, link ou texto do Chefe; o pesquisador analisa e a peça segue para a produção. */
  referenceAdd(r: { url: string | null; text: string | null; slot: SocialSlotId | null; title: string | null; files: File[] }): Promise<{ radarId: string; roundId: string | null }>;
  /** Radar → peça → produção (só destinos no foco). */
  radarSelect(id: string, slot: SocialSlotId | null): Promise<unknown>;
  learning(id: string, decision: ContentDecision, note: string): Promise<unknown>;
  /** Vídeo feito pela HQ: renderiza de novo o mesmo video.json e pede a revisão (a criação não é acionada). */
  rerender(id: string): Promise<unknown>;
  /** Desfaz a aprovação: a peça volta para "Para revisar". */
  unapprove(ids: string[]): Promise<unknown>;
  /** "Já publiquei": aprova se faltava e marca como publicada (link opcional, conferido pela HQ). Na publicada sem link, acrescenta o link. */
  markPublished(id: string, url: string | null): Promise<{ ok: boolean; detail: string }>;
  unmarkPublished(id: string): Promise<unknown>;
  /** Referência de vídeo (link ou arquivo): análise com a equipe, ou análise e produção. */
  videoAdd(r: { url: string | null; file: File | null; liked: string | null; mode: 'analise' | 'produzir' | 'estudo'; instruction: string | null; slot: SocialSlotId | null; sessionId?: string | null; profileId?: string | null; extras?: { url: string; role: 'audio' | 'estilo' | 'referencia'; note: string | null }[] | null }): Promise<{ radarId: string; reused: boolean; mode: string }>;
  /** Tentar de novo a inspeção, ou com o vídeo anexado agora. */
  videoRetry(id: string, file: File | null): Promise<unknown>;
  /** "Produzir esta versão" a partir da proposta. */
  videoProduce(id: string, slot: SocialSlotId | null): Promise<unknown>;
  /** Abre a reunião vinculada (tela de Reuniões). */
  openMeeting?(id: string): void;
  /** Academia de Vídeo: pede de novo o exercício (ou a etapa parada do estudo). */
  academyRetry(studyId: string, exerciseId: string | null): Promise<unknown>;
  /** Abre a Academia de Vídeo (aba do Mural). */
  openAcademy?(): void;
  /** Pedido em texto livre para a gerente da sala planejar e distribuir (linha de produção). */
  /** Pedido geral à gerente; `teams` = equipes escolhidas (Aurora, Tuco Dev ou as duas). */
  managerAsk(text: string, teams?: ('aurora' | 'tuco-dev')[]): Promise<{ requestId: string }>;
  /** Etapa da peça que falhou (pesquisa, roteiro, direção): pedir de novo. */
  stepRetry(id: string): Promise<unknown>;
}

const slotLabel = (s: SocialSlotId | null) => (s ? SOCIAL_SLOTS.find(x => x.slot === s)?.label ?? s : 'sem conta');
const empName = (employees: Employee[], id: string | null) => (id ? employees.find(e => e.id === id)?.name ?? '?' : 'sem responsável');
const when = (t: number | null | undefined) => (t ? new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const noEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') e.preventDefault(); };

/** Executa uma ação do serviço mostrando "ocupado" e o erro real (nada some em silêncio). */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(what); setError(null);
    try { return await fn(); } catch (err) { setError((err as Error).message); return null; } finally { setBusy(null); }
  };
  return { busy, error, run, setError };
}

// ------------------------------------------------------------------ preparar a sala

export function SetupCard({ content, api }: { content: ContentState; api: ContentApi }) {
  const { busy, error, run } = useAction();
  const s = content.setup;
  if (s.projectId && s.missing.length === 0) return null;
  return (
    <section className="hq-section hq-ct-setup">
      <h3 className="hq-label">Preparar a sala</h3>
      <ul className="hq-ct-list">{s.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>
      <p className="hq-field__hint">Cria (ou completa) a pasta de conteúdo, as quatro funções da equipe, as seis especialidades, a pesquisa diária e a revisão semanal. Nunca apaga nem move arquivos.</p>
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null} onClick={() => void run('setup', () => api.setup())}>{busy ? 'Preparando…' : s.projectId ? 'Completar a preparação' : 'Preparar a sala'}</button>
    </section>
  );
}

// ------------------------------------------------------------------ Radar

/** Destinos no foco (os únicos que recebem produção); sem foco definido, todos. */
export const activeSlots = (c: ContentState | null): SocialSlotId[] => c?.focus?.activeSlots ?? SOCIAL_SLOTS.map(s => s.slot);
const handleOf = (accounts: SocialAccount[], slot: SocialSlotId) => { const a = accounts.find(x => x.slot === slot); return a?.username ?? a?.declared?.handle ?? null; };
const ACCESS_LABEL = { acessada: 'acessada', parcial: 'acesso parcial', bloqueada: 'bloqueada', nao_verificada: 'ainda não verificada' } as const;

/** Foco da sala: destinos ativos × pausados (com o motivo) e as fontes de pesquisa, em controles separados. */
export function FocusCard({ content, api, accounts }: { content: ContentState; api: ContentApi; accounts: SocialAccount[] }) {
  const { busy, error, run } = useAction();
  const f = content.focus;
  const [edit, setEdit] = useState(false);
  const [sel, setSel] = useState<SocialSlotId[]>(activeSlots(content));
  const [src, setSrc] = useState<Record<string, boolean>>(Object.fromEntries(f.sources.map(s => [s.source, s.enabled])));
  const [note, setNote] = useState<string | null>(null);
  const active = activeSlots(content);
  const save = () => run('focus', async () => {
    const r = await api.focusSave(sel, RESEARCH_SOURCES.map(s => ({ source: s.source, enabled: src[s.source] !== false })));
    setEdit(false);
    setNote(`Foco gravado: ${r.paused.length} peça(s) pausada(s)${r.cancelled.length ? `, ${r.cancelled.length} tarefa(s) parada(s)` : ''}${r.resumed.length ? `, ${r.resumed.length} retomada(s) (nada recomeçou sozinho)` : ''}. Contas, históricos e arquivos ficam como estavam.`);
  });
  return (
    <section className="hq-section hq-ct-focus" aria-label="Foco da sala">
      <h3 className="hq-label">Foco da sala</h3>
      <p className="hq-ct-focus__reason"><strong>{f.activeSlots ? f.reason : 'Sem foco definido: todos os destinos recebem produção.'}</strong></p>
      <div className="hq-ct-focus__grid">
        <div>
          <p className="hq-dim">Destinos (produção, agendamento e publicação)</p>
          <ul className="hq-ct-list">
            {SOCIAL_SLOTS.map(s => {
              const on = edit ? sel.includes(s.slot) : active.includes(s.slot);
              const h = handleOf(accounts, s.slot);
              return (
                <li key={s.slot} className={on ? 'hq-ct-focus__on' : 'hq-ct-focus__off'}>
                  {edit ? <label><input type="checkbox" checked={on} onChange={e => setSel(v => e.target.checked ? [...v, s.slot] : v.filter(x => x !== s.slot))} /> {s.label}{h ? ` @${h}` : ''}</label>
                    : <>{on ? 'Ativo' : 'Pausado'} · {s.label}{h ? ` @${h}` : ''}</>}
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <p className="hq-dim">Fontes de pesquisa (não liberam produção na rede)</p>
          <ul className="hq-ct-list">
            {f.sources.map(s => {
              const d = RESEARCH_SOURCES.find(x => x.source === s.source)!;
              return (
                <li key={s.source}>
                  {edit ? <label><input type="checkbox" checked={src[s.source] !== false} onChange={e => setSrc(v => ({ ...v, [s.source]: e.target.checked }))} /> {d.label}</label> : <>{s.enabled ? '' : '(desligada) '}{d.label}</>}
                  {' · '}<span className={`hq-ct-access hq-ct-access--${s.access}`}>{ACCESS_LABEL[s.access]}</span>{s.at ? ` em ${when(s.at)}` : ''}
                  {s.detail && <><br /><span className="hq-dim">{s.detail}</span></>}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <p className="hq-field__hint">{f.expansion}</p>
      {note && <p className="hq-hub-ok" role="status">{note}</p>}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      <div className="hq-actions">
        {edit ? <>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null || !sel.length} onClick={() => void save()}>{busy ? 'Gravando…' : 'Gravar foco'}</button>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => { setEdit(false); setSel(active); }}>Cancelar</button>
        </> : <button type="button" className="hq-btn hq-btn--sm" onClick={() => { setSel(active); setEdit(true); }}>Mudar o foco</button>}
      </div>
    </section>
  );
}

/** "Usar como referência": imagem, vídeo, link ou texto. A referência fica no Radar (mesmo sem link) e segue para a análise. */
export function ReferenceForm({ content, api, accounts }: { content: ContentState; api: ContentApi; accounts: SocialAccount[] }) {
  const { busy, error, run } = useAction();
  const [url, setUrl] = useState(''); const [text, setText] = useState(''); const [title, setTitle] = useState('');
  const [slot, setSlot] = useState<SocialSlotId | ''>(''); const [files, setFiles] = useState<File[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const can = Boolean(url.trim() || text.trim() || files.length) && Boolean(content.setup.projectId);
  const send = () => run('ref', async () => {
    await api.referenceAdd({ url: url.trim() || null, text: text.trim() || null, slot: slot || null, title: title.trim() || null, files });
    setDone('Referência registrada no Radar. O pesquisador analisa agora (fila da equipe); com um destino no foco, a peça segue para a produção e chega na sua Mesa.');
    setUrl(''); setText(''); setTitle(''); setFiles([]); setSlot(''); if (inputRef.current) inputRef.current.value = '';
  });
  return (
    <section className="hq-section hq-ct-ref" aria-label="Enviar referência">
      <h3 className="hq-label">Enviar referência</h3>
      <div className="hq-ct-ref__grid">
        <input className="hq-input hq-input--sm" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={noEnter} placeholder="Nome curto (opcional)" aria-label="Nome da referência" />
        <input className="hq-input hq-input--sm" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={noEnter} placeholder="Link do post (opcional)" aria-label="Link da referência" />
        <textarea className="hq-input" rows={2} value={text} onChange={e => setText(e.target.value)} placeholder="O que chamou a sua atenção (opcional)" aria-label="Texto da referência" />
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm" multiple onChange={e => setFiles([...(e.target.files ?? [])].slice(0, 6))} aria-label="Imagem ou vídeo da referência" />
        <select className="hq-select hq-select--sm" value={slot} onChange={e => setSlot(e.target.value as SocialSlotId | '')} aria-label="Destino sugerido">
          <option value="">destino: o pesquisador sugere</option>
          {activeSlots(content).map(s => <option key={s} value={s}>{slotLabel(s)}{handleOf(accounts, s) ? ` @${handleOf(accounts, s)}` : ''}</option>)}
        </select>
      </div>
      {done && <p className="hq-hub-ok" role="status">{done}</p>}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={!can || busy !== null} onClick={() => void send()}>{busy ? 'Enviando…' : 'Usar como referência'}</button>
    </section>
  );
}

const metricText = (r: RadarItem) => r.metrics.map(m => `${m.name}: ${m.raw ?? (m.value == null ? 'indisponível' : m.value.toLocaleString('pt-BR'))}`).join(' · ');

function RadarCard({ r, api, content, accounts }: { r: RadarItem; api: ContentApi; content: ContentState; accounts: SocialAccount[] }) {
  const { busy, error, run } = useAction();
  const act = activeSlots(content);
  const [slot, setSlot] = useState<SocialSlotId | ''>(r.slot && act.includes(r.slot) ? r.slot : '');
  const isChefe = r.sourceUrl.startsWith('chefe://');
  const item = r.itemId ? content.items.find(i => i.id === r.itemId) ?? null : null;
  let host = r.sourceName ?? ''; if (!host && !isChefe) { try { host = new URL(r.sourceUrl).hostname; } catch { host = r.sourceUrl; } }
  return (
    <li className={`hq-ct-card hq-ct-radar hq-ct-radar--${r.evidence}${r.status === 'descartada' ? ' hq-ct-card--off' : ''}`}>
      <div className="hq-ct-card__head">
        {r.priority && <span className="hq-tag hq-tag--xs hq-tag--warn">prioridade {r.priority}</span>}
        <span className={`hq-tag hq-tag--xs hq-ct-kind--${r.kind}`}>{RADAR_KIND_LABEL[r.kind]}</span>
        <span className={`hq-tag hq-tag--xs hq-ct-ev--${r.evidence}`}>{RADAR_EVIDENCE_LABEL[r.evidence]}</span>
        {r.window && <span className="hq-tag hq-tag--xs">{r.window === 'duravel' ? 'antiga ou durável' : `janela ${r.window}`}</span>}
        {r.platform && <span className="hq-tag hq-tag--xs">{r.platform}</span>}
        <span className="hq-dim">{r.slot ? slotLabel(r.slot) : 'sem destino'}{r.seen > 1 ? ` · vista em ${r.seen} coletas` : ''}</span>
      </div>
      <strong className="hq-ct-card__title">{r.subject}</strong>
      <p className="hq-ct-meta">
        {isChefe ? <span>enviada pelo Chefe (sem link original)</span> : <button type="button" className="hq-linkbtn" onClick={() => api.openUrl(r.sourceUrl)} title={r.sourceUrl}>{host}</button>}
        {r.author ? ` · ${r.author}` : ''}{r.language ? ` · ${r.language}` : ''}{r.region ? ` · ${r.region}` : ''} · publicado: {r.publishedAt ?? 'indisponível'} · coletado: {r.consultedAt.replace('T', ' ').slice(0, 16)}
      </p>
      {r.status === 'analisando' && <p className="hq-peca__now">O pesquisador está analisando esta referência (fila da equipe).</p>}
      {r.metrics.length > 0 && <p><span className="hq-dim">Métricas públicas: </span>{metricText(r)}</p>}
      <p><span className="hq-dim">Sinal: </span>{r.signals}{r.popularityLimit && <><br /><span className="hq-dim">Limitação: </span>{r.popularityLimit}</>}</p>
      {r.inspected && <p><span className="hq-dim">Inspecionado: </span>{RADAR_INSPECTED_LABEL[r.inspected]}{r.observed ? ` · ${r.observed}` : ''}</p>}
      {r.summaryPt && <p><span className="hq-dim">Resumo: </span>{r.summaryPt}</p>}
      <p><span className="hq-dim">Por que interessa: </span>{r.interpretation}</p>
      <p><span className="hq-dim">Adaptação: </span>{r.proposal}{r.format ? ` (${r.format})` : ''}</p>
      {r.opening && <p><span className="hq-dim">Abertura proposta: </span>{r.opening}</p>}
      {(r.material || r.effort) && <p className="hq-dim">{r.material ? `Material: ${r.material}` : ''}{r.material && r.effort ? ' · ' : ''}{r.effort ? `Esforço: ${r.effort}` : ''}</p>}
      {r.audio && <p className="hq-dim">Áudio: {r.audio}</p>}
      {r.examples.length > 0 && <p className="hq-dim">Exemplos: {r.examples.map((e, i) => <span key={i}>{i ? ' · ' : ''}<button type="button" className="hq-linkbtn" onClick={() => api.openUrl(e.url)}>{e.author ?? e.platform ?? 'link'}</button>{e.sameVideo ? ' (mesmo vídeo)' : ''}</span>)}</p>}
      {r.files.length > 0 && <p className="hq-dim">Arquivos: {r.files.map((f, i) => <span key={f}>{i ? ' · ' : ''}<button type="button" className="hq-linkbtn" onClick={() => api.openFile(f)}>{f.split(/[\\/]/).pop()}</button></span>)}</p>}
      {r.note && <p><span className="hq-dim">Nota do Chefe: </span>{r.note}</p>}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      {r.status === 'nova' && (
        <div className="hq-actions">
          <select className="hq-select hq-select--sm" value={slot} onChange={e => setSlot(e.target.value as SocialSlotId | '')} aria-label="Destino da peça">
            <option value="">escolha o destino</option>
            {act.map(s => <option key={s} value={s}>{slotLabel(s)}</option>)}
          </select>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null || !slot} title={content.capacity.blocked ?? undefined} onClick={() => void run('sel', () => api.radarSelect(r.id, slot || null))}>Produzir</button>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy !== null} onClick={() => void run('discard', () => api.radarDiscard(r.id))}>Descartar</button>
        </div>
      )}
      {r.status === 'virou_peca' && <p className="hq-hub-ok">Virou peça{item ? `: "${item.title}" (${CONTENT_ITEM_STATUS_LABEL[item.status]})` : ''}.{item && <> <button type="button" className="hq-linkbtn" onClick={() => api.openPiece(item)}>Abrir a peça</button></>}</p>}
    </li>
  );
}

function RadarScheduleBox({ content }: { content: ContentState }) {
  const s = content.radarSchedule;
  if (!s.routineId) return <p className="hq-dim">Sem rotina do Radar cadastrada: prepare a sala para criar.</p>;
  return (
    <div className="hq-ct-sched" aria-label="Agenda do Radar">
      <p><strong>{s.title}</strong> · {s.enabled ? s.label : 'desligada'} <span className="hq-dim">(ajuste em Rotinas)</span></p>
      <p className="hq-dim">Última execução: {when(s.lastRunAt)}{s.lastResult ? ` · ${s.lastResult}` : ''} · Próxima: {s.enabled ? when(s.nextRunAt) : '—'}</p>
      {s.lastError && <p className="hq-composer__bad">Erro real: {s.lastError}</p>}
      <p className="hq-field__hint">{s.note}</p>
    </div>
  );
}

export function RadarView({ content, api, accounts }: { content: ContentState; api: ContentApi; accounts: SocialAccount[] }) {
  const { busy, error, run } = useAction();
  const [focus, setFocus] = useState('');
  const last = latestRound(content, 'radar');
  const prio = priorities(content).filter(r => !r.video);
  const chefe = content.radar.filter(r => r.kind === 'chefe' && !r.video && r.status !== 'descartada' && !prio.includes(r));
  const recent = content.radar.filter(r => r.status !== 'descartada' && r.kind !== 'chefe' && !prio.includes(r)).slice(0, 30);
  const cap = content.capacity;
  return (
    <div className="hq-ct">
      <p className="hq-field__hint">Referências de fora (Instagram, TikTok, X e Reddit) que podem virar conteúdo nos destinos do foco. Cada uma traz link, autor, datas, métricas com o nome da plataforma, o que foi inspecionado e a limitação do sinal; um post popular sozinho não é tendência.</p>
      <FocusCard content={content} api={api} accounts={accounts} />
      <RadarScheduleBox content={content} />
      <div className="hq-ct-bar">
        <input className="hq-input hq-input--sm" value={focus} onChange={e => setFocus(e.target.value)} onKeyDown={noEnter} placeholder="Foco opcional da rodada (ex.: memes de IA, web design)" aria-label="Foco da rodada" />
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null || last?.status === 'aguardando' || !content.setup.projectId} onClick={() => void run('radar', () => api.radarRun(focus.trim() || null))}>{busy ? 'Pedindo…' : 'Rodar o Radar agora'}</button>
      </div>
      <p className={cap.blocked ? 'hq-peca__miss' : 'hq-dim'}>Fila de produção: {cap.load} de {cap.limit} ideias do Radar · {cap.reviewBacklog} peça(s) esperando a sua revisão{cap.blocked ? ` · ${cap.blocked}` : ' · há vaga: as prioridades da próxima rodada vão para a produção'}</p>
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      {last && (
        <p className={`hq-ct-round hq-ct-round--${last.status}`}>
          Última rodada ({when(last.startedAt)}{last.origin === 'sessao' ? ', feita pela sessão do Claude Code' : last.origin === 'rotina' ? ', rotina' : ''}): {roundState(last)}
          {last.sources?.length ? <><br /><span className="hq-dim">Por fonte: {last.sources.map(s => `${RESEARCH_SOURCES.find(x => x.source === s.source)?.label ?? s.source} ${ACCESS_LABEL[s.access]}`).join(' · ')}</span></> : null}
          {last.coverage && <><br /><span className="hq-dim">Cobertura real: {last.coverage}</span></>}
          {last.summary && <><br /><span className="hq-dim">{last.summary}</span></>}
          {last.status !== 'falhou' && last.error && <><br /><span className="hq-dim">{last.error}</span></>}
        </p>
      )}
      <VideoRefList content={content} api={api} onOpenMeeting={api.openMeeting} />
      <ReferenceForm content={content} api={api} accounts={accounts} />
      {chefe.length > 0 && (
        <section className="hq-section">
          <h3 className="hq-label">Referências enviadas por você ({chefe.length})</h3>
          <ul className="hq-ct-cards">{chefe.map(r => <RadarCard key={r.id} r={r} api={api} content={content} accounts={accounts} />)}</ul>
        </section>
      )}
      <section className="hq-section">
        <h3 className="hq-label">Prioridades ({prio.length})</h3>
        {prio.length === 0 ? <p className="hq-empty">{last?.status === 'vazia' ? 'A última rodada não achou nada pertinente: siga com as pautas já planejadas.' : 'Nenhuma prioridade ainda. Rode o Radar.'}</p>
          : <ul className="hq-ct-cards">{prio.map(r => <RadarCard key={r.id} r={r} api={api} content={content} accounts={accounts} />)}</ul>}
      </section>
      {recent.length > 0 && (
        <section className="hq-section">
          <h3 className="hq-label">Outras referências no Radar ({recent.length})</h3>
          <ul className="hq-ct-cards">{recent.map(r => <RadarCard key={r.id} r={r} api={api} content={content} accounts={accounts} />)}</ul>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Calendário

function PackageDialog({ item, pkg, api, onClose }: { item: ContentItem; pkg: Extract<PublishOutcome, { mode: 'manual' }>; api: ContentApi; onClose(): void }) {
  const [url, setUrl] = useState('');
  const { busy, error, run } = useAction();
  const [res, setRes] = useState<{ ok: boolean; detail: string } | null>(null);
  const copy = (t: string | null) => { if (t) void api.copy(t); };
  return (
    <Modal open title={`Publicar à mão: ${slotLabel(item.slot)}`} onCancel={onClose} width={560}>
      <div className="hq-ct-pkg">
        <p className="hq-dim">{pkg.why}. A HQ preparou o pacote; você publica no site oficial e cola o link para a HQ conferir. Sem o link conferido, a peça fica como "publicação a conferir" (nada é marcado como publicado por suposição).</p>
        <label className="hq-field"><span>Texto</span><textarea className="hq-input" rows={5} readOnly value={pkg.text} /></label>
        <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm" onClick={() => copy(pkg.text)}>Copiar texto</button>
          {pkg.title && <button type="button" className="hq-btn hq-btn--sm" onClick={() => copy(pkg.title)}>Copiar título</button>}
          {pkg.destinationUrl && <button type="button" className="hq-btn hq-btn--sm" onClick={() => copy(pkg.destinationUrl)}>Copiar link de destino</button>}
        </div>
        {pkg.board && <p><span className="hq-dim">Pasta: </span>{pkg.board}</p>}
        <p className="hq-label">Arquivos</p>
        <ul className="hq-ct-list">{pkg.files.map(f => <li key={f}><button type="button" className="hq-linkbtn" onClick={() => api.openFile(f)}>{f.split(/[\\/]/).pop()}</button></li>)}</ul>
        <ol className="hq-hub-steps">{pkg.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => api.openUrl(pkg.openUrl)}>Abrir o site</button>
        <label className="hq-field"><span>Link do post publicado</span><input className="hq-input" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={noEnter} placeholder="https://..." /></label>
        {res && <p className={res.ok ? 'hq-hub-ok' : 'hq-composer__bad'} role="status">{res.ok ? 'Registrada como publicada: ' : 'Ainda pendente: '}{res.detail}</p>}
        {error && <p className="hq-composer__bad" role="alert">{error}</p>}
        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn hq-btn--ghost" onClick={onClose}>Fechar</button>
          <button type="button" className="hq-btn hq-btn--primary" disabled={!url.trim() || busy !== null} onClick={() => void run('reg', async () => setRes(await api.registerPost(item.id, url.trim())))}>{busy ? 'Conferindo…' : 'Conferir e registrar'}</button>
        </div>
      </div>
    </Modal>
  );
}

function ItemCard({ item, employees, api, selected, onSelect, tasksOpen }: { item: ContentItem; employees: Employee[]; api: ContentApi; selected: boolean; onSelect(on: boolean): void; tasksOpen(id: string | null): boolean }) {
  const { busy, error, run } = useAction();
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<ContentItemPatch>({});
  const [note, setNote] = useState('');
  const [pkg, setPkg] = useState<Extract<PublishOutcome, { mode: 'manual' }> | null>(null);
  const [clientId] = useState(() => `pub-${item.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`);
  const reviewing = item.reviewTaskId && !item.review && tasksOpen(item.reviewTaskId);
  const publish = async () => { const r = await run('pub', () => api.publish(item.id, clientId)); if (r && r.mode === 'manual') setPkg(r); };
  const f = { ...item, ...draft };
  return (
    <li className={`hq-ct-card hq-ct-item hq-ct-item--${item.status}`}>
      <div className="hq-ct-card__head">
        {(item.status === 'revisar') && <input type="checkbox" checked={selected} onChange={e => onSelect(e.target.checked)} aria-label={`Incluir "${item.title}" no lote de aprovação`} />}
        <span className={`hq-tag hq-tag--xs hq-ct-st--${item.status}`}>{CONTENT_ITEM_STATUS_LABEL[item.status]}</span>
        <span className="hq-dim">{slotLabel(item.slot)}{item.format ? ` · ${item.format}` : ''}</span>
        {item.baseTitle && <span className="hq-tag hq-tag--xs" title="Peça-base comum">{item.baseTitle}</span>}
      </div>
      <strong className="hq-ct-card__title">{item.title}</strong>
      {item.folder && /[\\/]slides[\\/]\d{2}\.png$/i.test(item.deliverable ?? '') && <SlideStrip folder={item.folder} stamp={item.updatedAt} api={api} onOpen={i => api.openPiece(item, i)} />}
      <p className="hq-ct-meta">Responsável: {empName(employees, item.ownerId)} · skill {item.skill ?? 'nenhuma'} · {CONTENT_MATERIAL_LABEL[item.material]}{item.date ? ` · ${dayLabel(item.date)}${item.time ? ` ${item.time}` : ''}` : ''}</p>
      {item.objective && <p><span className="hq-dim">Objetivo: </span>{item.objective}</p>}
      {edit ? (
        <div className="hq-ct-edit">
          <label className="hq-field"><span>Título</span><input className="hq-input" value={f.title ?? ''} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} onKeyDown={noEnter} /></label>
          <div className="hq-ct-row">
            <label className="hq-field"><span>Data</span><input className="hq-input" type="date" value={f.date ?? ''} onChange={e => setDraft(d => ({ ...d, date: e.target.value || null }))} /></label>
            <label className="hq-field"><span>Horário (Brasília)</span><input className="hq-input" type="time" value={f.time ?? ''} onChange={e => setDraft(d => ({ ...d, time: e.target.value || null }))} /></label>
            <label className="hq-field"><span>Conta</span>
              <select className="hq-select" value={f.slot ?? ''} onChange={e => setDraft(d => ({ ...d, slot: (e.target.value || null) as SocialSlotId | null }))}>
                <option value="">sem conta</option>{SOCIAL_SLOTS.map(s => <option key={s.slot} value={s.slot}>{s.label}</option>)}
              </select>
            </label>
            <label className="hq-field"><span>Material</span>
              <select className="hq-select" value={f.material} onChange={e => setDraft(d => ({ ...d, material: e.target.value as ContentItem['material'] }))}>
                {Object.entries(CONTENT_MATERIAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </div>
          <label className="hq-field"><span>Briefing</span><textarea className="hq-input" rows={4} value={f.brief ?? ''} onChange={e => setDraft(d => ({ ...d, brief: e.target.value }))} /></label>
          <label className="hq-field"><span>Critério de revisão</span><input className="hq-input" value={f.reviewCriteria ?? ''} onChange={e => setDraft(d => ({ ...d, reviewCriteria: e.target.value }))} onKeyDown={noEnter} /></label>
          <div className="hq-actions">
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null} onClick={() => void run('save', async () => { await api.itemUpdate(item.id, draft); setEdit(false); setDraft({}); })}>Salvar</button>
            <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => { setEdit(false); setDraft({}); }}>Cancelar</button>
          </div>
        </div>
      ) : item.brief ? <details><summary className="hq-dim">Briefing</summary><p className="hq-ct-pre">{item.brief}</p></details> : null}
      {item.sources.length > 0 && <p className="hq-ct-meta">Fontes: {item.sources.map((s, i) => <button key={i} type="button" className="hq-linkbtn" onClick={() => api.openUrl(s)} title={s}>{(() => { try { return new URL(s).hostname; } catch { return s.slice(0, 30); } })()}</button>)}</p>}
      {item.checks.length > 0 && (
        <ul className="hq-ct-checks" aria-label="Verificações automáticas">{item.checks.map((c, i) => <li key={i} className={c.ok ? 'hq-ct-check--ok' : 'hq-ct-check--bad'}>{c.ok ? '✓' : '✗'} {c.name}: <span className="hq-dim">{c.detail}</span></li>)}</ul>
      )}
      {item.review && (
        <div className={`hq-ct-review hq-ct-review--${item.review.verdict}`}>
          <strong>Revisão: {item.review.verdict === 'aprovar' ? 'aprovar' : 'ajustar'}</strong> <span className="hq-dim">{when(item.review.at)}</span>
          <p className="hq-ct-pre">{item.review.notes}</p>
          {item.review.checks.length > 0 && <ul className="hq-ct-checks">{item.review.checks.map((c, i) => <li key={i} className={c.ok ? 'hq-ct-check--ok' : 'hq-ct-check--bad'}>{c.ok ? '✓' : '✗'} {c.name}{c.detail ? `: ${c.detail}` : ''}</li>)}</ul>}
        </div>
      )}
      {reviewing && <p className="hq-dim">O revisor está com esta peça (na fila ou trabalhando).</p>}
      {item.publication && <p className={`hq-ct-pub hq-ct-pub--${item.publication.verifiedBy}`}>{item.publication.verifiedBy === 'pendente' ? 'Publicação a conferir: ' : 'Publicada: '}{item.publication.detail}{item.publication.url && <> · <button type="button" className="hq-linkbtn" onClick={() => api.openUrl(item.publication!.url!)}>abrir</button></>}</p>}
      {item.nextStep && <p className="hq-hub-acct__next"><strong>Próximo passo:</strong> {item.nextStep}</p>}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      <div className="hq-actions">
        {(item.deliverable || item.folder) && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => api.openPiece(item)} title="Abre na HQ o que a peça entregou: slides, vídeo e o texto do post">Abrir a peça</button>}
        {item.deliverable && <CopyPost item={item} api={api} />}
        {item.folder && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => api.openFolder(item.folder!)} title="Abre a pasta da peça no Explorador do Windows">Pasta</button>}
        {(item.status === 'planejada' || item.status === 'ajustar' || item.status === 'parcial' || item.status === 'falhou') && (
          <>
            {item.status !== 'planejada' && <input className="hq-input hq-input--sm" value={note} onChange={e => setNote(e.target.value)} onKeyDown={noEnter} placeholder="O que ajustar (opcional)" aria-label="Observação para a nova produção" />}
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null || !item.slot} title={item.slot ? 'Cria a tarefa de produção na fila (uma por vez)' : 'Escolha a conta antes'} onClick={() => void run('produce', () => api.produce(item.id, note.trim() || null))}>{item.status === 'planejada' ? 'Produzir' : 'Produzir de novo'}</button>
          </>
        )}
        {item.status === 'planejada' && !edit && <button type="button" className="hq-btn hq-btn--sm" onClick={() => setEdit(true)}>Editar</button>}
        {item.deliverable && ['revisar', 'ajustar', 'aprovada', 'publicacao_pendente'].includes(item.status) && <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} title="Abre o editor da rede no navegador da HQ, preenche e anexa, e para na prévia (sem publicar)" onClick={() => void run('prep', () => api.prepare(item.id))}>Preparar no navegador</button>}
        {(item.status === 'revisar' || item.status === 'ajustar') && item.deliverable && !reviewing && <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} onClick={() => void run('review', () => api.review(item.id))}>Revisar de novo</button>}
        {(item.status === 'aprovada' || item.status === 'publicacao_pendente') && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null} onClick={() => void publish()}>{item.status === 'publicacao_pendente' ? 'Pacote e link' : 'Publicar'}</button>}
        {item.status === 'planejada' && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy !== null} onClick={() => void run('discard', () => api.itemUpdate(item.id, { status: 'descartada' }))}>Descartar</button>}
        {item.status !== 'em_producao' && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy !== null} title="Tira da visão principal; a peça e os arquivos ficam" onClick={() => void run('arch', () => api.archive([item.id], true))}>Arquivar</button>}
        {item.status !== 'publicada' && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy !== null} title={item.status === 'em_producao' ? 'Cancela a tarefa em andamento e move para a lixeira (arquivos ficam)' : 'Move para a lixeira (restaurável; arquivos ficam; nada sai das redes)'} onClick={() => { if (item.status !== 'em_producao' || window.confirm(`Cancelar a tarefa de "${item.title}" e mover para a lixeira? O que já foi gravado fica na pasta e restaurar não recomeça a produção.`)) void run('trash', () => api.trash([item.id])); }}>{item.status === 'em_producao' ? 'Cancelar tarefa e mover para a lixeira' : 'Excluir'}</button>}
      </div>
      {pkg && <PackageDialog item={item} pkg={pkg} api={api} onClose={() => setPkg(null)} />}
    </li>
  );
}

function DestinationsEditor({ content, api }: { content: ContentState; api: ContentApi }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<SocialSlotId>('instagram-aurora');
  const cur = content.destinations.find(d => d.slot === sel);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const val = (k: keyof ContentDestination) => draft[k] ?? (k === 'pillars' ? (cur?.pillars ?? []).join('; ') : String(cur?.[k] ?? ''));
  const save = (confirm: boolean) => run('save', async () => {
    await api.destinationSave({ slot: sel, objective: val('objective'), audience: val('audience'), language: val('language'), pillars: val('pillars').split(';').map(s => s.trim()).filter(Boolean), content: val('content'), indicator: val('indicator') }, confirm);
    setDraft({});
  });
  const proposals = content.destinations.filter(d => d.state === 'proposta').length;
  return (
    <section className="hq-section">
      <button type="button" className="hq-linkbtn" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? '▾' : '▸'} Objetivos dos 7 destinos {proposals ? `(${proposals} ainda em proposta)` : '(revisados)'}</button>
      {open && (
        <div className="hq-ct-dest">
          <select className="hq-select" value={sel} onChange={e => { setSel(e.target.value as SocialSlotId); setDraft({}); }} aria-label="Destino">
            {SOCIAL_SLOTS.map(s => <option key={s.slot} value={s.slot}>{s.label}{content.destinations.find(d => d.slot === s.slot)?.state === 'confirmado' ? ' ✓' : ''}</option>)}
          </select>
          {([['objective', 'Objetivo'], ['audience', 'Público'], ['language', 'Idioma'], ['pillars', 'Pilares (separe com ;)'], ['content', 'Conteúdo'], ['indicator', 'Indicador principal']] as const).map(([k, label]) => (
            <label key={k} className="hq-field"><span>{label}</span><input className="hq-input" value={val(k)} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} onKeyDown={noEnter} /></label>
          ))}
          <p className="hq-field__hint">Estado: {cur?.state === 'confirmado' ? 'revisado por você' : 'proposta inicial (matriz do seu pedido; público e pilares são sugestão da HQ)'}.</p>
          {error && <p className="hq-composer__bad" role="alert">{error}</p>}
          <div className="hq-actions">
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null} onClick={() => void save(true)}>Salvar e confirmar</button>
            <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null || !Object.keys(draft).length} onClick={() => void save(false)}>Salvar como proposta</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Copia o texto exato do post (entrega.json) direto do cartão. */
export function CopyPost({ item, api }: { item: ContentItem; api: ContentApi }) {
  const [state, setState] = useState<'idle' | 'ok' | 'none' | 'error'>('idle');
  const go = async () => {
    try { const t = await api.pieceText(item); if (!t) { setState('none'); return; } setState((await api.copy(t)) ? 'ok' : 'error'); }
    catch { setState('error'); }
    window.setTimeout(() => setState('idle'), 2200);
  };
  return <button type="button" className="hq-btn hq-btn--sm" onClick={() => void go()} title="Copia o texto exato a publicar (legenda ou post)">{state === 'ok' ? 'Texto copiado' : state === 'none' ? 'Sem texto do post' : state === 'error' ? 'Não copiou' : 'Copiar texto do post'}</button>;
}

/** Slides desenhados pela HQ (slides/01.png…): miniaturas na ordem; clique abre a peça no visualizador naquele slide. */
function SlideStrip({ folder, stamp, api, onOpen }: { folder: string; stamp: number; api: ContentApi; onOpen(index: number): void }) {
  const [imgs, setImgs] = useState<{ file: string; src: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: { file: string; src: string }[] = [];
      for (let i = 1; i <= 10; i++) {
        const file = `${folder}${folder.includes('/') ? '/' : '\\'}slides${folder.includes('/') ? '/' : '\\'}${String(i).padStart(2, '0')}.png`;
        const src = await api.image(file).catch(() => null);
        if (!src) break;
        out.push({ file, src });
        if (alive) setImgs([...out]);
      }
      if (alive) setImgs(out);
    })();
    return () => { alive = false; };
  }, [folder, stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!imgs) return <p className="hq-dim">Carregando os slides…</p>;
  if (!imgs.length) return null;
  return (
    <div className="hq-ct-slides" aria-label={`${imgs.length} slides prontos`}>
      {imgs.map((im, i) => (
        <button key={im.file} type="button" className="hq-ct-slide" onClick={() => onOpen(i)} title={`Abrir o slide ${i + 1}`}>
          <img src={im.src} alt={`Slide ${i + 1}`} loading="lazy" />
        </button>
      ))}
    </div>
  );
}

export function CalendarView({ content, api, employees, taskOpen, tasks }: { content: ContentState; api: ContentApi; employees: Employee[]; taskOpen(id: string | null): boolean; tasks?: Task[] }) {
  const { busy, error, run } = useAction();
  const [note, setNote] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const start = focusWeek(content);
  const [from, setFrom] = useState(todayBrt());
  const [to, setTo] = useState(addDays(todayBrt(), 6));
  const active = useMemo(() => content.items.filter(i => !i.deletedAt && !i.archivedAt), [content.items]);
  const groups = useMemo(() => itemsByDay(active, start), [active, start]);
  const last = latestRound(content, 'semana');
  const toggle = (id: string, on: boolean) => setSel(s => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const ready = active.filter(i => i.status === 'revisar');
  const pending = { gravar: content.items.filter(i => i.status === 'planejada' && i.material === 'gravar').length, editar: content.items.filter(i => i.status === 'planejada' && i.material === 'editar').length };
  const weekEnd = addDays(start, 6);
  const planned = content.items.filter(i => i.status === 'planejada' && (i.weekStart === start || (!i.weekStart && i.date != null && i.date >= start && i.date <= weekEnd)) && i.slot && i.material !== 'gravar' && i.material !== 'editar');
  const [produced, setProduced] = useState<string | null>(null);
  return (
    <div className="hq-ct">
      <div className="hq-ct-bar">
        <input className="hq-input hq-input--sm" value={note} onChange={e => setNote(e.target.value)} onKeyDown={noEnter} placeholder="Pedido para a semana (opcional)" aria-label="Pedido para a semana" />
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null || last?.status === 'aguardando' || !content.setup.projectId} onClick={() => void run('week', () => api.weekPrepare(note.trim() || null))}>{busy === 'week' ? 'Pedindo…' : 'Preparar minha semana'}</button>
        {planned.length > 0 && (
          <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null}
            title="Cada peça planejada vai para a criação e depois para uma revisão; você só aprova no fim"
            onClick={() => void run('produce-week', async () => { const r = await api.weekProduce(start); setProduced(`${r.produced} peça(s) foram para a produção${r.skipped.length ? `; ficaram fora: ${r.skipped.join('; ')}` : ''}.`); })}>
            {busy === 'produce-week' ? 'Enviando…' : `Produzir a semana (${planned.length})`}
          </button>
        )}
      </div>
      {produced && <p className="hq-ct-round hq-ct-round--concluida">{produced} A equipe trabalha uma peça por vez na fila; cada entrega segue sozinha para a revisão.</p>}
      <p className="hq-field__hint">O coordenador junta o Radar, os objetivos das contas, os materiais existentes e os resultados num calendário editável de sete dias. Começa com duas ou três peças-base; é uma hipótese de capacidade, não regra de algoritmo.</p>
      {last && <p className={`hq-ct-round hq-ct-round--${last.status}`}>Último calendário ({when(last.startedAt)}): {roundState(last)}{last.summary ? <><br /><span className="hq-dim">{last.summary}</span></> : null}{last.status !== 'falhou' && last.error ? <><br /><span className="hq-dim">{last.error}</span></> : null}</p>}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      {(pending.gravar > 0 || pending.editar > 0) && <p className="hq-hub-warn">Depende de você: {pending.gravar ? `${pending.gravar} peça(s) com material a gravar` : ''}{pending.gravar && pending.editar ? ' · ' : ''}{pending.editar ? `${pending.editar} com material a editar` : ''}.</p>}
      {ready.length > 0 && (
        <div className="hq-ct-approve">
          <strong>Aprovar em lote ({sel.size} de {ready.length} para revisar)</strong>
          <div className="hq-ct-row">
            <label className="hq-field"><span>De</span><input className="hq-input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label className="hq-field"><span>Até</span><input className="hq-input" type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={!sel.size || busy !== null} onClick={() => void run('approve', async () => { await api.approve([...sel], from, to, null); setSel(new Set()); })}>Aprovar o lote</button>
          </div>
          <p className="hq-field__hint">Dentro do lote (peças, contas e período), a HQ não pergunta de novo: contas conectadas com publicação de texto publicam na data; as outras recebem o pacote manual.</p>
        </div>
      )}
      <div className="hq-actions"><NewRequestForm api={api} /></div>
      {activeRequests(content).map(r => <RequestCard key={r.id} p={requestProgress(r, content.items, tasks ?? [], SOCIAL_SLOTS.map(s => s.slot).filter(s => !activeSlots(content).includes(s)))} api={api} employees={employees} />)}
      <DestinationsEditor content={content} api={api} />
      {groups.map(g => (
        <section key={g.day ?? 'sem-data'} className="hq-section">
          <h3 className="hq-label">{g.day ? dayLabel(g.day) : 'Sem data'} ({g.items.length})</h3>
          {g.items.length === 0 ? <p className="hq-empty">Nada neste dia.</p> : (
            <ul className="hq-ct-cards">{g.items.map(i => <ItemCard key={i.id} item={i} employees={employees} api={api} selected={sel.has(i.id)} onSelect={on => toggle(i.id, on)} tasksOpen={taskOpen} />)}</ul>
          )}
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Resultados

function ResultRow({ r, items, api }: { r: ContentResult; items: ContentItem[]; api: ContentApi }) {
  const { busy, run } = useAction();
  const item = r.itemId ? items.find(i => i.id === r.itemId) : null;
  return (
    <tr className={r.uncertain ? 'hq-ct-res--uncertain' : ''}>
      <td>{slotLabel(r.slot)}{item ? <><br /><span className="hq-dim">{item.title}</span></> : null}</td>
      <td>{r.metric}{r.denominator ? <><br /><span className="hq-dim">sobre {r.denominator}</span></> : null}</td>
      <td>{r.value == null ? <span className="hq-dim">não coletado</span> : `${r.value.toLocaleString('pt-BR')}${r.unit ? ` ${r.unit}` : ''}`}</td>
      <td className="hq-dim">{r.periodStart ?? '—'}{r.periodEnd ? ` a ${r.periodEnd}` : ''}{r.ageHours != null ? <><br />{r.ageHours} h após publicar</> : null}</td>
      <td className="hq-dim">{r.source}{r.uncertain ? ' · a conferir' : ''}{r.evidencePath && <> · <button type="button" className="hq-linkbtn" onClick={() => api.openFile(r.evidencePath!)}>evidência</button></>}</td>
      <td>
        {r.uncertain && <button type="button" className="hq-btn hq-btn--xs" disabled={busy !== null} onClick={() => void run('ok', () => api.confirmResult(r.id))}>Confere</button>}
        <button type="button" className="hq-btn hq-btn--xs hq-btn--ghost" disabled={busy !== null} onClick={() => { if (window.confirm(`Apagar o registro "${r.metric}"?`)) void run('del', () => api.deleteResult(r.id)); }}>Apagar</button>
      </td>
    </tr>
  );
}

/** Uma peça publicada: hipótese, janelas de 24 h e 7 dias (com o que já foi coletado), linha de base e a decisão. */
function FollowUp({ item, content, api }: { item: ContentItem; content: ContentState; api: ContentApi }) {
  const { busy, error, run } = useAction();
  const [decision, setDecision] = useState<ContentDecision>(item.learning?.decision ?? 'repetir');
  const [note, setNote] = useState(item.learning?.note ?? '');
  const at = item.publication?.at ?? null;
  const now = Date.now();
  const rows = content.results.filter(r => r.itemId === item.id);
  const win = (h: number) => { const due = at ? at + h * 3_600_000 : null; const got = rows.filter(r => r.ageHours != null ? Math.abs(r.ageHours - h) <= h * 0.25 : due != null && Math.abs(r.collectedAt - due) <= h * 900_000); return { due, got, open: due != null && now >= due }; };
  const w24 = win(24); const w7 = win(168);
  const peers = content.items.filter(i => i.id !== item.id && i.status === 'publicada' && i.slot === item.slot && i.format === item.format).length;
  const fmt = (w: ReturnType<typeof win>) => (w.got.length ? w.got.map(r => `${r.metric}: ${r.value ?? 'não coletado'}`).join(' · ') : w.open ? 'janela aberta: falta coletar (navegador, CSV, captura ou à mão)' : `a partir de ${when(w.due)}`);
  return (
    <li className="hq-ct-card">
      <strong className="hq-ct-card__title">{item.title}</strong>
      <p className="hq-dim">{slotLabel(item.slot)} · {item.format || 'formato?'} · publicada {when(at)}{item.publication?.url ? <> · <button type="button" className="hq-linkbtn" onClick={() => api.openUrl(item.publication!.url!)}>post</button></> : null}</p>
      <p><span className="hq-dim">Hipótese: </span>{item.hypothesis ?? 'não registrada'}</p>
      <p><span className="hq-dim">24 h: </span>{fmt(w24)}<br /><span className="hq-dim">7 dias: </span>{fmt(w7)}</p>
      <p className="hq-dim">{peers >= 3 ? `Comparação com ${peers} peça(s) da mesma conta e formato.` : `Preliminar: só ${peers} peça(s) da mesma conta e formato para comparar (linha de base em construção).`}</p>
      {item.learning && <p className="hq-hub-ok">Decisão ({when(item.learning.at)}): {CONTENT_DECISION_LABEL[item.learning.decision]} · {item.learning.note}</p>}
      <div className="hq-actions">
        <select className="hq-select hq-select--sm" value={decision} onChange={e => setDecision(e.target.value as ContentDecision)} aria-label="Decisão">
          {(Object.keys(CONTENT_DECISION_LABEL) as ContentDecision[]).map(k => <option key={k} value={k}>{CONTENT_DECISION_LABEL[k]}</option>)}
        </select>
        <input className="hq-input hq-input--sm" value={note} onChange={e => setNote(e.target.value)} onKeyDown={noEnter} placeholder="O que os números mostraram (métrica e período)" aria-label="Motivo da decisão" />
        <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null || !note.trim()} onClick={() => void run('dec', () => api.learning(item.id, decision, note.trim()))}>Registrar decisão</button>
      </div>
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
    </li>
  );
}

export function ResultsView({ content, api }: { content: ContentState; api: ContentApi }) {
  const { busy, error, run, setError } = useAction();
  const csvRef = useRef<HTMLInputElement | null>(null);
  const imgRef = useRef<HTMLInputElement | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ slot: '' as SocialSlotId | '', itemId: '', metric: '', value: '', periodStart: '', periodEnd: '', denominator: '', postUrl: '', hypothesis: '' });
  const published = content.items.filter(i => i.status === 'publicada');
  const analysis = content.analyses[0] ?? null;
  const lastAn = latestRound(content, 'analise');
  const onCsv = async (f: File | undefined) => {
    if (!f) return; setMsg(null);
    const r = await run('csv', async () => api.importCsv(await f.text(), f.name));
    if (r) setMsg(`${r.imported} linha(s) importada(s)${r.skipped.length ? `; ignoradas: ${r.skipped.join('; ')}` : ''}.`);
  };
  const onImg = async (f: File | undefined) => {
    if (!f) return; setMsg(null);
    const ok = await run('img', () => api.capture(f, form.itemId || null, form.slot || null));
    if (ok !== null) setMsg('Captura guardada como evidência; o analista vai transcrever os valores, que entram como "a conferir".');
  };
  const add = () => run('add', async () => {
    const v = form.value.trim() ? Number(form.value.replace(',', '.')) : null;
    if (v != null && !Number.isFinite(v)) throw new Error('Valor inválido: deixe vazio se não foi coletado.');
    await api.resultAdd({ itemId: form.itemId || null, slot: (form.slot || null) as SocialSlotId | null, postUrl: form.postUrl.trim() || null, metric: form.metric.trim(), value: v, unit: null, periodStart: form.periodStart || null, periodEnd: form.periodEnd || null, ageHours: null, denominator: form.denominator.trim() || null, hypothesis: form.hypothesis.trim() || null, note: null });
    setForm(f => ({ ...f, metric: '', value: '' }));
  });
  return (
    <div className="hq-ct">
      <p className="hq-field__hint">Métricas com o nome que a rede usa, período e denominador. Valor vazio é "não coletado", nunca zero. Fontes: lido pelo navegador da HQ nas contas verificadas, CSV, captura (transcrição fica "a conferir") ou digitado.</p>
      <div className="hq-actions">
        <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} onClick={() => csvRef.current?.click()}>Importar CSV</button>
        <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null || !content.setup.projectId} onClick={() => imgRef.current?.click()}>Enviar captura</button>
        <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null || !content.setup.projectId} title="O revisor abre as contas verificadas no navegador da HQ e registra os números com data e definição" onClick={() => void run('col', async () => { await api.collect(); setMsg('Leitura de métricas na fila: o revisor abre as contas verificadas no navegador da HQ.'); })}>Ler resultados nas contas</button>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null || lastAn?.status === 'aguardando' || !content.setup.projectId} onClick={() => void run('an', () => api.analysisRun())}>Rodar a análise agora</button>
        <input ref={csvRef} type="file" accept=".csv,text/csv" hidden onChange={e => { void onCsv(e.target.files?.[0]); e.target.value = ''; }} />
        <input ref={imgRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { void onImg(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {content.setup.folder && <p className="hq-dim">Modelo do CSV: <button type="button" className="hq-linkbtn" onClick={() => api.openFile(`${content.setup.folder}\\resultados\\modelo.csv`)}>resultados\modelo.csv</button></p>}
      {msg && <p className="hq-hub-ok" role="status">{msg}</p>}
      {error && <p className="hq-composer__bad" role="alert" onClick={() => setError(null)}>{error}</p>}
      <details className="hq-section">
        <summary className="hq-label">Registrar um número à mão</summary>
        <div className="hq-ct-row">
          <label className="hq-field"><span>Conta</span><select className="hq-select" value={form.slot} onChange={e => setForm(f => ({ ...f, slot: e.target.value as SocialSlotId | '' }))}><option value="">—</option>{SOCIAL_SLOTS.map(s => <option key={s.slot} value={s.slot}>{s.label}</option>)}</select></label>
          <label className="hq-field"><span>Peça</span><select className="hq-select" value={form.itemId} onChange={e => setForm(f => ({ ...f, itemId: e.target.value }))}><option value="">—</option>{published.map(i => <option key={i.id} value={i.id}>{i.title}</option>)}</select></label>
        </div>
        <div className="hq-ct-row">
          <label className="hq-field"><span>Métrica (nome exato)</span><input className="hq-input" value={form.metric} onChange={e => setForm(f => ({ ...f, metric: e.target.value }))} onKeyDown={noEnter} /></label>
          <label className="hq-field"><span>Valor</span><input className="hq-input" value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} onKeyDown={noEnter} placeholder="vazio = não coletado" /></label>
          <label className="hq-field"><span>Denominador</span><input className="hq-input" value={form.denominator} onChange={e => setForm(f => ({ ...f, denominator: e.target.value }))} onKeyDown={noEnter} /></label>
        </div>
        <div className="hq-ct-row">
          <label className="hq-field"><span>Início</span><input className="hq-input" type="date" value={form.periodStart} onChange={e => setForm(f => ({ ...f, periodStart: e.target.value }))} /></label>
          <label className="hq-field"><span>Fim</span><input className="hq-input" type="date" value={form.periodEnd} onChange={e => setForm(f => ({ ...f, periodEnd: e.target.value }))} /></label>
          <label className="hq-field"><span>Hipótese testada</span><input className="hq-input" value={form.hypothesis} onChange={e => setForm(f => ({ ...f, hypothesis: e.target.value }))} onKeyDown={noEnter} /></label>
        </div>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={!form.metric.trim() || busy !== null} onClick={() => void add()}>Registrar</button>
      </details>
      <section className="hq-section">
        <h3 className="hq-label">Acompanhamento por peça ({published.length})</h3>
        <p className="hq-field__hint">Janelas de 24 horas e 7 dias depois da publicação. Compare peças da mesma conta, formato e idade; com pouco histórico o resultado é preliminar (linha de base em construção). Visualizações não são alcance; tempo médio não é conclusão.</p>
        {published.length === 0 ? <p className="hq-empty">Nenhuma peça publicada ainda: a medição começa depois da sua aprovação e da publicação conferida.</p>
          : <ul className="hq-ct-cards">{published.map(i => <FollowUp key={i.id} item={i} content={content} api={api} />)}</ul>}
      </section>
      {lastAn && <p className={`hq-ct-round hq-ct-round--${lastAn.status}`}>Última análise ({when(lastAn.startedAt)}): {roundState(lastAn)}</p>}
      {analysis && (
        <section className="hq-section hq-ct-analysis">
          <h3 className="hq-label">Análise semanal ({analysis.weekStart ? `desde ${dayLabel(analysis.weekStart)}` : when(analysis.at)})</h3>
          {([['Observado', analysis.observed], ['Promissor', analysis.promising], ['Ajustar', analysis.adjust], ['Limites dos dados', analysis.limits]] as const).map(([t, list]) => list.length ? <div key={t}><strong>{t}</strong><ul className="hq-ct-list">{list.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null)}
          {analysis.nextTest && <p><strong>Próximo teste:</strong> {analysis.nextTest.hypothesis} · muda: {analysis.nextTest.change} · mede: {analysis.nextTest.metric} · critério: {analysis.nextTest.criterion}</p>}
        </section>
      )}
      <section className="hq-section">
        <h3 className="hq-label">Registros ({content.results.length})</h3>
        {content.results.length === 0 ? <p className="hq-empty">Nenhum resultado registrado ainda.</p> : (
          <div className="hq-ct-tablewrap">
            <table className="hq-ct-table">
              <thead><tr><th>Conta</th><th>Métrica</th><th>Valor</th><th>Período</th><th>Fonte</th><th /></tr></thead>
              <tbody>{content.results.slice(0, 120).map(r => <ResultRow key={r.id} r={r} items={content.items} api={api} />)}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ Mesa do Chefe (resumo)

/** Topo da Mesa: as peças do calendário que esperam o Chefe, cada uma com Abrir (visualizador) e Copiar texto do post. */
export function DeskPieces({ content, social, api, onGo }: { content: ContentState | null; social: SocialState | null; api: ContentApi | null; onGo(tab: 'radar' | 'calendario' | 'resultados'): void }) {
  const d = deskSummary(content, social);
  const entregas = (
      <section className="hq-section">
        <h3 className="hq-label">Entregas para revisar ({d.toReview.length})</h3>
        {d.toReview.length === 0 ? <p className="hq-empty">Nenhuma peça do calendário esperando você.</p> : (
          <ul className="hq-ct-list hq-desk-pieces">{d.toReview.map(i => (
            <li key={i.id} className="hq-desk-piece">
              <span><strong>{i.title}</strong><br /><span className="hq-dim">{slotLabel(i.slot)}{i.date ? ` · ${dayLabel(i.date)}${i.time ? ` ${i.time}` : ''}` : ''} · {i.review ? `revisor: ${i.review.verdict}` : 'sem revisão ainda'} · {i.checks.filter(c => !c.ok).length ? `${i.checks.filter(c => !c.ok).length} verificação(ões) falhando` : 'verificações ok'}</span></span>
              {api && <span className="hq-actions"><button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => api.openPiece(i)}>Abrir</button>{i.deliverable && <CopyPost item={i} api={api} />}</span>}
            </li>
          ))}</ul>
        )}
        {d.toReview.length > 0 && <button type="button" className="hq-linkbtn" onClick={() => onGo('calendario')}>Aprovar no Calendário</button>}
      </section>
  );
  return entregas;
}

export function DeskContent({ content, social, api, onGo }: { content: ContentState | null; social: SocialState | null; api: ContentApi | null; onGo(tab: 'radar' | 'calendario' | 'resultados'): void }) {
  const d = deskSummary(content, social);
  const team = content?.setup.team ?? [];
  return (
    <>
      {d.priorities.length > 0 && <p className="hq-dim">A pesquisa tem {d.priorities.length} prioridade(s) no <button type="button" className="hq-linkbtn" onClick={() => onGo('radar')}>Radar</button> (pautas, não bloqueios).</p>}
      <section className="hq-section">
        <h3 className="hq-label">Pendências de acesso ({d.access.length})</h3>
        {d.access.length === 0 ? <p className="hq-empty">Nada pendente.</p> : <ul className="hq-ct-list">{d.access.slice(0, 12).map((a, i) => <li key={i} className={`hq-ct-access--${a.kind}`}>{a.text}</li>)}</ul>}
      </section>
      <section className="hq-section">
        <h3 className="hq-label">O que a equipe produziu (7 dias)</h3>
        {team.some(t => t.employeeId) && <p className="hq-dim">Equipe: {team.filter(t => t.employeeId).map(t => `${t.name} (${CONTENT_ROLE_LABEL[t.role]})`).join(' · ')}</p>}
        {d.produced.length === 0 ? <p className="hq-empty">Nada concluído nos últimos sete dias.</p> : <ul className="hq-ct-list">{d.produced.map((p, i) => <li key={i}>{p.text} <span className="hq-dim">{when(p.at)}</span></li>)}</ul>}
      </section>
    </>
  );
}
