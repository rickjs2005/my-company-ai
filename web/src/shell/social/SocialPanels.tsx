// Painéis da sala Social Media: Mesa do Chefe (o que espera por você), Mural de conteúdo (peças do perfil por estado real, mais
// Radar, Calendário e Resultados do trabalho de conteúdo) e Estúdio de vídeo. Usam as tarefas, conversas e arquivos que já existem; nada é criado aqui. "Pronto para postar" é a sua
// aprovação: a HQ não publica nem agenda, então nenhuma peça aparece como "agendada" ou "publicada".
import { useEffect, useMemo, useState, useRef } from 'react';
import { DeskVideoAsk } from './DeskVideoAsk';
import type { VideoRefComposerApi } from './VideoRefComposer';
import type { ContentItem, ContentState, DeskDelivery, Employee, FsReadResult, Project, Room, SkillInfo, SocialAccount, SocialState, Task } from '@milweb-hq/protocol';
import type { ViewerRequest } from '../FileViewer';
import { CalendarView, DeskContent, RadarView, ResultsView, SetupCard, type ContentApi } from './ContentViews';
import { DeskPiecesV2, PiecesBoard } from './PiecesBoard';
import { AcademyView } from './AcademyView';
import { hiddenState, looseTasks } from './pieceBoard';

export type BoardTab = 'pecas' | 'radar' | 'calendario' | 'resultados' | 'academia';
const BOARD_TABS: { id: BoardTab; label: string }[] = [{ id: 'pecas', label: 'Peças' }, { id: 'radar', label: 'Radar' }, { id: 'calendario', label: 'Calendário' }, { id: 'resultados', label: 'Resultados' }, { id: 'academia', label: 'Academia de Vídeo' }];
import { SOCIAL_NETWORK_LABEL } from '@milweb-hq/protocol';
import { PublishDialog, type SocialHubApi } from './SocialHub';
import { formatTime, truncate } from '../../panel/helpers';
import { IconX } from '../../panel/icons';
import { MdLite, isMarkdown } from './MdLite';
import { BOARD_COLUMNS, VIDEO_SKILL, captionOf, columnOf, destinationLabel, destinationOf, destinationState, destinationsFor, displayPrompt, isVideoTask, pieceFiles, waitingForChefe } from './socialHelpers';

/** O que os cartões de peça precisam do App: ler arquivos do projeto (prévia), abrir no Windows e copiar. */
export interface PieceApi {
  projects: Project[];
  read(projectId: string, rel: string): Promise<FsReadResult>;
  openFile(abs: string): void;
  /** Visualizador da HQ com os arquivos da peça (imagem, vídeo, texto). */
  view(r: ViewerRequest): void;
  /** Peça do calendário a que a tarefa pertence (pela pasta), para abrir a entrega inteira: slides, vídeo e texto do post. */
  pieceOf?(t: Task): ContentItem | null;
  openPiece?(item: ContentItem, index?: number): void;
  copy(text: string): Promise<boolean>;
  /** Contas da central de Redes (destino de cada peça e o que cada conexão permite). */
  accounts: SocialAccount[];
  /** Publicação e links (central de Redes); ausente = serviço sem o módulo social. */
  hub: SocialHubApi | null;
}

const nameOf = (employees: Employee[], id: string | null | undefined) => (id ? employees.find(e => e.id === id)?.name ?? '?' : '?');
/** Conta de destino da tarefa (pelo id gravado); tarefas antigas só citavam a rede no pedido. */
const destAccount = (t: Task, accounts: SocialAccount[]) => (t.destinationId ? accounts.find(a => a.slot === t.destinationId) ?? null : null);
const destText = (t: Task, accounts: SocialAccount[]) => { const a = destAccount(t, accounts); if (a) return destinationLabel(a); const n = destinationOf(t.prompt); return n ? `${SOCIAL_NETWORK_LABEL[n]} (conta não definida)` : null; };
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;


function TaskLine({ t, employees, onOpen, extra, accounts = [] }: { t: Task; employees: Employee[]; onOpen(t: Task): void; extra?: React.ReactNode; accounts?: SocialAccount[] }) {
  const dest = destText(t, accounts);
  return (
    <li className="hq-soc-task">
      <button type="button" className="hq-soc-task__main" onClick={() => onOpen(t)} title="Abrir a conversa desta tarefa">
        <span className="hq-soc-task__text">{truncate(displayPrompt(t.prompt), 110)}</span>
        <span className="hq-dim hq-soc-task__meta">{nameOf(employees, t.employeeId)} · {formatTime(t.finishedAt ?? t.createdAt)}{dest ? ` · ${dest}` : ''}</span>
      </button>
      {extra}
    </li>
  );
}

/** Peça de conteúdo: abre a prévia do arquivo entregue (texto ou imagem), copia a legenda e marca "pronto para postar". */
function PieceCard({ t, employees, api, onOpen, onReady, extraActions }: { t: Task; employees: Employee[]; api: PieceApi; onOpen(t: Task): void; onReady?(id: string): void; extraActions?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const project = api.projects.find(p => p.id === t.projectId) ?? null;
  const files = useMemo(() => pieceFiles(t, project?.path ?? null), [t, project?.path]);
  const [sel, setSel] = useState(0);
  const file = files[Math.min(sel, files.length - 1)] ?? null;
  const [preview, setPreview] = useState<{ key: string; state: 'loading' | 'ok' | 'error'; res?: FsReadResult; error?: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const key = project && file ? `${project.id}:${file.rel}:${t.finishedAt ?? t.status}` : null;
  useEffect(() => {
    if (!open || !key || !project || !file || (file.kind !== 'text' && file.kind !== 'image')) return;
    if (preview?.key === key) return;
    let alive = true;
    setPreview({ key, state: 'loading' });
    api.read(project.id, file.rel)
      .then(res => { if (alive) setPreview({ key, state: 'ok', res }); })
      .catch(err => { if (alive) setPreview({ key, state: 'error', error: String((err as Error).message ?? err) }); });
    return () => { alive = false; };
  }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = preview && preview.key === key ? preview : null;
  const text = cur?.state === 'ok' && cur.res?.encoding === 'utf8' ? cur.res.content : null;
  const fallback = files.length === 0 ? (t.resultText ?? '').trim() : '';
  const caption = captionOf(text ?? fallback);
  const col = columnOf(t);
  const dest = destText(t, api.accounts);
  const account = destAccount(t, api.accounts);
  const canPublish = Boolean(api.hub && account && account.capabilities.publish.hqReady && (account.status === 'connected' || account.status === 'expiring') && col !== 'fila' && col !== 'producao');
  const [publishing, setPublishing] = useState(false);
  const publishText = caption ?? text ?? fallback;
  const copy = async (what: string, value: string) => { if (await api.copy(value)) { setCopied(what); window.setTimeout(() => setCopied(c => (c === what ? null : c)), 1800); } };
  const piece = api.pieceOf?.(t) ?? null;

  return (
    <li className={`hq-soc-piece${open ? ' hq-soc-piece--open' : ''}`}>
      <button type="button" className="hq-soc-piece__head" onClick={() => setOpen(o => !o)} aria-expanded={open} title={open ? 'Fechar a prévia' : 'Ver a peça'}>
        <span className="hq-soc-piece__chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="hq-soc-piece__headtext">
          <span className="hq-soc-task__text">{truncate(displayPrompt(t.prompt), 110)}</span>
          <span className="hq-dim hq-soc-task__meta">
            {dest && <span className="hq-soc-dest">{dest}</span>}
            {nameOf(employees, t.employeeId)} · {formatTime(t.finishedAt ?? t.createdAt)}{files.length ? ` · ${files.length} arquivo${files.length > 1 ? 's' : ''}` : ''}{piece ? ` · peça: ${truncate(piece.title, 50)}` : ''}
            {col === 'revisado' && <span className="hq-tag hq-tag--xs hq-tag--ok">pronto para postar</span>}
          </span>
        </span>
      </button>
      {open && (
        <div className="hq-soc-piece__body">
          {files.length > 1 && (
            <div className="hq-soc-piece__files" role="tablist" aria-label="Arquivos da peça">
              {files.map((f, i) => <button key={f.rel} type="button" role="tab" aria-selected={f === file} className={`hq-chip hq-chip--xs${f === file ? ' hq-soc-chip--on' : ''}`} onClick={() => setSel(i)} title={f.rel}>{baseName(f.rel)}</button>)}
            </div>
          )}
          {file ? (
            file.kind === 'text' ? (
              !cur || cur.state === 'loading' ? <p className="hq-dim">Abrindo {baseName(file.rel)}…</p>
                : cur.state === 'error' ? <p className="hq-composer__bad">Não deu para ler {baseName(file.rel)}: {cur.error}</p>
                  : <>{isMarkdown(file.rel) ? <MdLite text={text ?? ''} /> : <pre className="hq-soc-preview">{text}</pre>}{cur.res?.truncated && <p className="hq-field__hint">Arquivo grande: a prévia mostra só o começo. Abra o arquivo para ver tudo.</p>}</>
            ) : file.kind === 'image' ? (
              !cur || cur.state === 'loading' ? <p className="hq-dim">Abrindo a imagem…</p>
                : cur.state === 'error' ? <p className="hq-composer__bad">Não deu para abrir a imagem: {cur.error}</p>
                  : cur.res?.encoding === 'base64' ? <img className="hq-soc-preview__img" src={`data:${cur.res.mediaType};base64,${cur.res.content}`} alt={`Prévia de ${baseName(file.rel)}`} />
                    : <p className="hq-dim">Imagem grande demais para a prévia. Abra o arquivo.</p>
            ) : file.kind === 'video' ? <p className="hq-dim">Vídeo <strong>{baseName(file.rel)}</strong>. A HQ não toca vídeo aqui dentro: abra no seu player.</p>
              : <p className="hq-dim">Arquivo <strong>{baseName(file.rel)}</strong> sem prévia. Abra no programa padrão.</p>
          ) : fallback ? (
            <><p className="hq-field__hint">Nenhum arquivo entregue: esta é a resposta do funcionário.</p><MdLite text={fallback} /></>
          ) : <p className="hq-dim">{col === 'fila' || col === 'producao' ? 'Ainda em andamento: a prévia aparece quando houver arquivo ou resposta.' : 'Nenhum arquivo ou resposta para mostrar.'}</p>}
          <div className="hq-actions hq-soc-piece__actions">
            {piece && api.openPiece && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => api.openPiece!(piece)} title="Abre a entrega da peça na HQ: slides, vídeo e o texto exato do post">Abrir a peça</button>}
            {caption && <button type="button" className="hq-btn hq-btn--sm" onClick={() => void copy('legenda', caption)} title="Copia só a seção Legenda do texto">Copiar legenda</button>}
            {(text || fallback) && <button type="button" className="hq-btn hq-btn--sm" onClick={() => void copy('texto', text ?? fallback)}>Copiar texto</button>}
            {file && <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.view({ title: truncate(displayPrompt(t.prompt), 80), files: files.map(f => f.abs), index: Math.min(sel, files.length - 1) })}>{file.kind === 'video' ? 'Abrir vídeo' : 'Abrir arquivo'}</button>}
            {onReady && col === 'revisar' && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => onReady(t.id)} title="Você aprovou a peça. Não publica nem agenda nada.">Pronto para postar</button>}
            {canPublish && publishText && <button type="button" className="hq-btn hq-btn--sm" onClick={() => setPublishing(true)} title="Abre o texto e o destino para você conferir; publica só quando você clicar em Publicar agora">Publicar em {account!.label}…</button>}
            <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => onOpen(t)} title="Abre a conversa para pedir ajuste">Pedir ajuste</button>
            {extraActions}
            {copied && <span className="hq-soc-copied" role="status">{copied === 'legenda' ? 'Legenda copiada' : 'Texto copiado'}</span>}
          </div>
          {account ? (
            <p className="hq-soc-piece__dest">{destinationLabel(account)}: {account.status === 'connected' || account.status === 'expiring' ? (account.capabilities.publish.hqReady ? 'a HQ publica texto nesta conta quando você mandar.' : `publicar pela HQ: ${account.capabilities.publish.detail || 'indisponível'}.`) : `${destinationState(account)}; conecte na central de Redes para publicar por aqui.`}</p>
          ) : dest ? <p className="hq-soc-piece__dest">Destino antigo, só pela rede: escolha a conta em pedidos novos.</p> : null}
          {publishing && account && api.hub && <PublishDialog account={account} initialText={publishText} taskId={t.id} api={api.hub} onClose={() => setPublishing(false)} maxChars={account.network === 'threads' ? 500 : 3000} />}
        </div>
      )}
    </li>
  );
}

const SIDE_W_KEY = 'milweb-hq.sidepanel.width';
const sideW = (): number => { try { const v = Number(localStorage.getItem(SIDE_W_KEY)); return v >= 340 && v <= 900 ? v : 460; } catch { return 460; } };
/** Largura dos painéis da sala (Mesa, Mural, Estúdio): ajustável pela alça e guardada neste computador. */
const applySideWidth = (el: HTMLElement | null) => { if (el && !el.dataset.sized) { el.dataset.sized = '1'; el.style.width = `${sideW()}px`; } };
/** Alça na borda esquerda do painel: arrastar (ou setas) muda a largura; o escritório 3D se reenquadra sozinho. */
function SidePanelGrip() {
  const drag = useRef<{ x: number; w: number; el: HTMLElement } | null>(null);
  const set = (el: HTMLElement, w: number) => { const v = Math.round(Math.min(900, Math.max(340, w))); el.style.width = `${v}px`; try { localStorage.setItem(SIDE_W_KEY, String(v)); } catch { /* sem armazenamento */ } };
  return (
    <div className="hq-panel__grip" role="separator" aria-orientation="vertical" aria-label="Ajustar a largura do painel" tabIndex={0}
      onPointerDown={e => { const el = (e.currentTarget.parentElement as HTMLElement); drag.current = { x: e.clientX, w: el.offsetWidth, el }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { const d = drag.current; if (d) set(d.el, d.w + (d.x - e.clientX)); }}
      onPointerUp={() => { drag.current = null; }}
      onKeyDown={e => { const el = e.currentTarget.parentElement as HTMLElement; if (e.key === 'ArrowLeft') set(el, el.offsetWidth + 24); if (e.key === 'ArrowRight') set(el, el.offsetWidth - 24); }}
    />
  );
}

/** Seção da Mesa do Chefe; mostra o aviso de vazio quando nenhum filho renderiza nada. */
function DeskGroup({ title, hint, empty, children }: { title: string; hint: string; empty?: string; children: React.ReactNode }) {
  // o aviso de vazio aparece pelo CSS quando nenhum filho desenhou nada (:empty)
  return (
    <section className="hq-section hq-deskgroup">
      <h3 className="hq-deskgroup__title">{title}<span className="hq-dim"> · {hint}</span></h3>
      <div className="hq-deskgroup__body">{children}</div>
      {empty && <p className="hq-empty hq-deskgroup__empty">{empty}</p>}
    </section>
  );
}

function PanelHead({ title, sub, onClose, children }: { title: string; sub: string; onClose(): void; children?: React.ReactNode }) {
  return (
    <header className="hq-panel__head">
      <div className="hq-panel__who">
        <div className="hq-panel__names"><div className="hq-panel__name">{title}<span className="hq-panel__role">{sub}</span></div></div>
        <button type="button" className="hq-iconbtn" onClick={onClose} aria-label="Fechar painel"><IconX size={16} /></button>
      </div>
      {children}
    </header>
  );
}

/** tasks = todas as tarefas da sala. Pedidos de resposta aparecem em qualquer perfil (são urgentes); entregas, só as do perfil. */
export function ChefeDeskPanel(props: { summary?: React.ReactNode; videoRef?: VideoRefComposerApi | null; tasks: Task[]; allTasks?: Task[]; profileId: string | null; employees: Employee[]; profileName: string | null; api: PieceApi; onClose(): void; onWrite(): void; onOpen(t: Task): void; onReviewed(id: string): void; content?: ContentState | null; social?: SocialState | null; contentApi?: ContentApi | null; onBoard?(tab: BoardTab): void; inbox?: (group: 'decisoes' | 'entregas' | 'bloqueios') => React.ReactNode; deliveries?: DeskDelivery[] }) {
  const { needsAnswer } = waitingForChefe(props.tasks);
  // Peças ficam nas entregas acima (uma por peça); aqui só os pedidos avulsos terminados que você ainda não marcou.
  const loose = props.content ? looseTasks(props.tasks, props.content, props.deliveries ?? [], t => props.api.pieceOf?.(t) ?? null).filter(t => !hiddenState(props.content!.hidden, `task:${t.id}`)) : props.tasks;
  const { toReview } = waitingForChefe(loose.filter(t => !props.profileId || (t.profileId ?? null) === props.profileId));
  return (
    <aside ref={applySideWidth} className="hq-panel hq-panel--room hq-soc-panel hq-soc-panel--wide" aria-label="Mesa do Chefe">
      <SidePanelGrip />
      <PanelHead title="Mesa do Chefe" sub={props.profileName ? `perfil ${props.profileName}` : 'sem perfil'} onClose={props.onClose} />
      <div className="hq-panel__body hq-panel__body--scroll">
        {/* Chegar na Mesa, colar um vídeo e pedir "nesse estilo" (09/11). */}
        {props.videoRef && <DeskVideoAsk api={props.videoRef} />}
        {/* Resumo do trabalho desde a última visita, contado nas tarefas persistidas (10/11). */}
        {props.summary}
        {/* Três grupos (08/11): o que pede uma escolha sua, o que está pronto para você revisar e o que está travado. */}
        <DeskGroup title="Decisões necessárias" hint="perguntas, permissões e escolhas que só você faz" empty="Nenhuma decisão esperando você.">
          {props.content && props.contentApi && <DeskPiecesV2 only="decisoes" content={props.content} tasks={props.allTasks ?? props.tasks} employees={props.employees} api={props.contentApi} />}
          {props.inbox?.('decisoes')}
        </DeskGroup>
        <DeskGroup title="Entregas para revisar" hint="conferidas pela HQ e pelo revisor; aprovar não publica nada">
          {props.content && props.contentApi && <DeskPiecesV2 only="entregas" content={props.content} tasks={props.allTasks ?? props.tasks} employees={props.employees} api={props.contentApi} />}
          {props.inbox?.('entregas')}
          {toReview.length > 0 && <ul className="hq-list hq-soc-pieces">{toReview.map(t => <PieceCard key={t.id} t={t} employees={props.employees} api={props.api} onOpen={props.onOpen} onReady={props.onReviewed} />)}</ul>}
        </DeskGroup>
        <DeskGroup title="Bloqueios" hint="travado até você agir" empty="Nada travado.">
          {props.inbox?.('bloqueios')}
          {needsAnswer.length > 0 && !props.inbox && <ul className="hq-list">{needsAnswer.map(t => <TaskLine key={t.id} t={t} employees={props.employees} accounts={props.api.accounts} onOpen={props.onOpen} extra={<span className="hq-tag hq-tag--xs hq-tag--warn">responder</span>} />)}</ul>}
        </DeskGroup>
        <div className="hq-actions"><button type="button" className="hq-btn hq-btn--primary hq-btn--sm" onClick={props.onWrite}>Escrever um pedido</button></div>
        {props.content && (
          <details className="hq-desk__more">
            <summary>Planejamento, calendário e resultados</summary>
            <DeskContent content={props.content} social={props.social ?? null} api={props.contentApi ?? null} onGo={tab => props.onBoard?.(tab)} />
          </details>
        )}
      </div>
    </aside>
  );
}

export function ContentBoardPanel(props: { tasks: Task[]; employees: Employee[]; room: Room | null; profileId: string | null; api: PieceApi; onProfile(id: string | null): void; onClose(): void; onOpen(t: Task): void; onReady(id: string): void; content?: ContentState | null; contentApi?: ContentApi | null; tab?: BoardTab; onTab?(t: BoardTab): void; deliveries?: DeskDelivery[] }) {
  const profiles = props.room?.profiles ?? [];
  const tasks = props.tasks.filter(t => !props.profileId || (t.profileId ?? null) === props.profileId);
  const tab: BoardTab = props.content && props.contentApi ? props.tab ?? 'pecas' : 'pecas';
  const allTasks = props.tasks;
  const taskOpen = (id: string | null) => { const t = id ? allTasks.find(x => x.id === id) : null; return Boolean(t && ['queued', 'running', 'waiting_permission', 'waiting_answer'].includes(t.status)); };
  return (
    <aside ref={applySideWidth} className="hq-panel hq-panel--room hq-soc-panel hq-soc-panel--wide" aria-label="Mural de conteúdo">
      <SidePanelGrip />
      <PanelHead title="Mural de conteúdo" sub={tab === 'pecas' ? (props.content ? `${props.content.items.filter(i => !i.deletedAt && !i.archivedAt && i.status !== 'descartada' && (!props.profileId || (i.profileId ?? null) === props.profileId)).length} peça(s) ativas` : `${tasks.length} peça(s)`) : BOARD_TABS.find(b => b.id === tab)!.label} onClose={props.onClose}>
        {props.content && props.contentApi && (
          <div className="hq-soc-profiles hq-ct-tabs" role="tablist" aria-label="Visão do mural">
            {BOARD_TABS.map(b => <button key={b.id} type="button" role="tab" aria-selected={tab === b.id} className={`hq-tab${tab === b.id ? ' hq-tab--on' : ''}`} onClick={() => props.onTab?.(b.id)}>{b.label}</button>)}
          </div>
        )}
        {tab === 'pecas' && profiles.length > 0 && (
          <div className="hq-soc-profiles" role="tablist" aria-label="Perfil editorial">
            {profiles.map(p => <button key={p.id} type="button" role="tab" aria-selected={props.profileId === p.id} className={`hq-tab${props.profileId === p.id ? ' hq-tab--on' : ''}`} onClick={() => props.onProfile(p.id)}>{p.name}</button>)}
          </div>
        )}
      </PanelHead>
      <div className="hq-panel__body hq-panel__body--scroll">
        {props.content && props.contentApi && <SetupCard content={props.content} api={props.contentApi} />}
        {tab === 'radar' && props.content && props.contentApi && <RadarView content={props.content} api={props.contentApi} accounts={props.api.accounts} />}
        {tab === 'calendario' && props.content && props.contentApi && <CalendarView content={props.content} api={props.contentApi} employees={props.employees} taskOpen={taskOpen} tasks={allTasks} />}
        {tab === 'pecas' && props.content && props.contentApi && (
          <PiecesBoard content={props.content} tasks={allTasks} employees={props.employees} room={props.room} profileId={props.profileId} api={props.contentApi} deliveries={props.deliveries ?? []}
            loose={looseTasks(allTasks, props.content, props.deliveries ?? [], t => props.api.pieceOf?.(t) ?? null)}
            renderTask={(t, actions) => <PieceCard key={t.id} t={t} employees={props.employees} api={props.api} onOpen={props.onOpen} onReady={props.onReady} extraActions={actions} />} />
        )}
        {tab === 'resultados' && props.content && props.contentApi && <ResultsView content={props.content} api={props.contentApi} />}
        {tab === 'academia' && props.content && props.contentApi && <AcademyView content={props.content} api={props.contentApi} />}
        {tab === 'pecas' && !(props.content && props.contentApi) && <>
        <ul className="hq-soc-dests" aria-label="Contas de destino">
          {destinationsFor(props.api.accounts, props.profileId).map(a => {
            const n = tasks.filter(t => t.destinationId === a.slot).length;
            const on = a.status === 'connected' || a.status === 'expiring';
            return (
              <li key={a.slot} className={on ? 'hq-soc-dest--on' : ''} title={on ? a.capabilities.publish.detail : a.statusDetail}>
                <strong>{a.label}</strong>
                <span className="hq-dim">{a.username ? `@${a.username}` : a.declared?.handle ? `@${a.declared.handle}${a.declared.confirmed ? '' : ' (a confirmar)'}` : a.declared?.toCreate ? 'conta a criar' : a.displayName ?? 'conta não informada'}</span>
                <span className="hq-dim">{n} peça(s) · {destinationState(a)}</span>
              </li>
            );
          })}
        </ul>
        {destinationsFor(props.api.accounts, props.profileId).length === 0 && <p className="hq-field__hint">Nenhuma conta associada a este perfil ainda: conecte e associe na central de Redes (objeto Redes na sala).</p>}
        {tasks.some(t => !t.destinationId && destinationOf(t.prompt)) && <p className="hq-field__hint">{tasks.filter(t => !t.destinationId && destinationOf(t.prompt)).length} peça(s) antiga(s) citam só a rede, sem a conta.</p>}
        <p className="hq-field__hint">Cada conta mostra o que a conexão permite. Nada é publicado sem você abrir a peça e clicar em Publicar; agendar ainda não existe.</p>
        {BOARD_COLUMNS.map(col => {
          const items = tasks.filter(t => columnOf(t) === col.id);
          if (items.length === 0 && (col.id === 'falhou' || col.id === 'revisado')) return null;
          return (
            <section key={col.id} className="hq-section">
              <h3 className="hq-label" title={col.hint}>{col.label} ({items.length})</h3>
              {items.length === 0 ? <p className="hq-empty">{col.id === 'fila' ? 'Nada na fila.' : col.id === 'producao' ? 'Ninguém produzindo agora.' : 'Nada para revisar.'}</p> : (
                <ul className="hq-list hq-soc-pieces">{items.slice(0, 20).map(t => <PieceCard key={t.id} t={t} employees={props.employees} api={props.api} onOpen={props.onOpen} onReady={props.onReady} />)}</ul>
              )}
            </section>
          );
        })}
        </>}
      </div>
    </aside>
  );
}

export type StudioStart = 'roteiro' | 'ideias' | 'legenda';
export const STUDIO_STARTS: { id: StudioStart; label: string; hint: string; text: string }[] = [
  { id: 'roteiro', label: 'Roteiro de Reels ou TikTok', hint: 'vertical, até 60 s, com gancho, cenas e legenda', text: 'Roteiro de vídeo curto (vertical, até 60 s) com gancho, falas, cenas e legenda sobre: ' },
  { id: 'ideias', label: 'Ideias de vídeos curtos', hint: 'cinco ideias com gancho e formato', text: 'Cinco ideias de vídeos curtos para o perfil, cada uma com gancho e formato, sobre: ' },
  { id: 'legenda', label: 'Legenda para um vídeo', hint: 'texto do post e hashtags', text: 'Legenda e texto do post (com hashtags) para este vídeo: ' },
];

/** Estúdio de vídeo: começa pedidos de vídeo com a skill da Aurora e mostra as peças de vídeo da sala. Nada é gravado sozinho. */
export function StudioPanel(props: { tasks: Task[]; employees: Employee[]; api: PieceApi; skill: SkillInfo | null; skillLoading: boolean; onClose(): void; onStart(s: StudioStart): void; onOpen(t: Task): void; onReady(id: string): void; onShareVideo?(): void; onAcademy?(): void }) {
  const videos = props.tasks.filter(isVideoTask);
  return (
    <aside ref={applySideWidth} className="hq-panel hq-panel--room hq-soc-panel hq-soc-panel--wide" aria-label="Estúdio de vídeo">
      <SidePanelGrip />
      <PanelHead title="Estúdio de vídeo" sub={`${videos.length} peça(s) de vídeo`} onClose={props.onClose} />
      <div className="hq-panel__body hq-panel__body--scroll">
        <p className={`hq-soc-skill${props.skill ? '' : ' hq-soc-skill--off'}`}>
          {props.skill ? <><strong>/{VIDEO_SKILL}</strong> instalada · <span className="hq-dim">{truncate(props.skill.description || 'skill de vídeo da Aurora', 120)}</span></>
            : props.skillLoading ? 'Lendo as skills desta máquina…'
              : <>A skill <strong>/{VIDEO_SKILL}</strong> não foi encontrada nesta máquina. Os pedidos funcionam sem ela, com menos método.</>}
        </p>
        {(props.onShareVideo || props.onAcademy) && (
          <section className="hq-section">
            <h3 className="hq-label">Diretor de Vídeo e Academia</h3>
            <p className="hq-dim">Mande um vídeo (Instagram, TikTok, YouTube, Shorts, X ou MP4/MOV) para a equipe estudar a técnica, analisar ou fazer a nossa versão.</p>
            <div className="hq-actions">
              {props.onShareVideo && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={props.onShareVideo}>Compartilhar vídeo</button>}
              {props.onAcademy && <button type="button" className="hq-btn hq-btn--sm" onClick={props.onAcademy}>Academia de Vídeo</button>}
            </div>
          </section>
        )}
        <section className="hq-section">
          <h3 className="hq-label">Começar um pedido de vídeo</h3>
          <div className="hq-soc-starts">
            {STUDIO_STARTS.map(s => (
              <button key={s.id} type="button" className="hq-soc-start" onClick={() => props.onStart(s.id)}>
                <strong>{s.label}</strong><span className="hq-dim">{s.hint}</span>
              </button>
            ))}
          </div>
          <p className="hq-field__hint">O pedido vai para o campo de baixo{props.skill ? ' com a skill de vídeo escolhida' : ''}; você completa o tema e clica em Executar. Se o campo já tiver texto, ele fica como está. Nada é gravado, editado ou publicado sozinho.</p>
        </section>
        <section className="hq-section">
          <h3 className="hq-label">Peças de vídeo ({videos.length})</h3>
          {videos.length === 0 ? <p className="hq-empty">Nenhum pedido de vídeo ainda neste perfil.</p> : (
            <ul className="hq-list hq-soc-pieces">{videos.slice(0, 20).map(t => <PieceCard key={t.id} t={t} employees={props.employees} api={props.api} onOpen={props.onOpen} onReady={props.onReady} />)}</ul>
          )}
        </section>
      </div>
    </aside>
  );
}
