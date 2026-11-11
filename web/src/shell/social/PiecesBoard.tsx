// Mural por peça: um cartão por peça (criação, revisão e refações ficam dentro dela), filtros de marca, conta, data e estado,
// seleção com lote (arquivar, lixeira, restaurar), Desfazer, e a Mesa com o progresso real do pedido do dia. Lixeira e arquivo
// preservam os arquivos e nunca removem nada das redes. Peça em execução: "Cancelar tarefa e mover para a lixeira".
import { teamChannelLabel, teamOfWork } from '@milweb-hq/protocol';
import { useEffect, useMemo, useState } from 'react';
import type { ContentItem, ContentState, DeskDelivery, Employee, RadarItem, Room, SocialSlotId, Task } from '@milweb-hq/protocol';
import { CONTENT_ITEM_STATUS_LABEL, SOCIAL_SLOTS } from '@milweb-hq/protocol';
import type { ContentApi } from './ContentViews';
import { CopyPost } from './ContentViews';
import { addDays, dayLabel, todayBrt } from './contentHelpers';
import { VideoRefList } from './VideoRefCards';
import { PIECE_COLUMNS, PIECE_VIEWS, activeRequests, approvalWindow, canApprove, publishAction, filterPieces, hiddenState, isActive, pieceColumn, requestProgress, runningScope, type PieceFilter, type PieceView, type RequestProgress } from './pieceBoard';

const slotLabel = (s: SocialSlotId | null) => (s ? SOCIAL_SLOTS.find(x => x.slot === s)?.label ?? s : 'sem conta');
const who = (employees: Employee[], id: string | null) => (id ? employees.find(e => e.id === id)?.name ?? '?' : 'sem responsável');
const IMG = /\.(png|jpe?g|webp|gif)$/i;

export interface UndoNote { text: string; undo?: () => Promise<unknown> }

/** Decisão dentro do visualizador ("Abrir"): o Chefe olha a peça e decide ali mesmo (aprovar, já publiquei, pedir ajustes),
 *  sem fechar a janela para procurar o cartão. Usa a peça viva do estado, então o que mudar aparece na hora. */
export function PieceDecision({ item, tasks, employees, api }: { item: ContentItem; tasks: Task[]; employees: Employee[]; api: ContentApi }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<UndoNote | null>(null);
  const [mode, setMode] = useState<'pub' | 'ajuste' | null>(null);
  const [text, setText] = useState('');
  const run = async (k: string, fn: () => Promise<UndoNote | null>) => {
    setBusy(k); setError(null);
    try { const n = await fn(); if (n) setDone(n); setMode(null); setText(''); } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  };
  const pub = publishAction(item, tasks);
  const owner = who(employees, item.ownerId);
  const scope = runningScope(item, tasks);
  const working = scope.running.length + scope.queued.length > 0;
  const status = item.deletedAt ? 'Na lixeira' : item.pausedReason ? 'Pausada pelo foco' : CONTENT_ITEM_STATUS_LABEL[item.status];
  const canAdj = !item.deletedAt && !item.pausedReason && !working && ['revisar', 'ajustar', 'aprovada', 'parcial'].includes(item.status);
  const pubWhen = item.status === 'publicada' && item.publication ? ` em ${new Date(item.publication.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${item.publication.url ? '' : ' (sem link)'}` : '';
  const markPub = () => run('pub', async () => {
    const url = text.trim() || null;
    const r = await api.markPublished(item.id, url);
    if (pub === 'link') return { text: `Link registrado (${r.ok ? 'conferido' : r.detail}).` };
    return { text: `Marcada como publicada${url ? (r.ok ? ' (link conferido)' : ` (${r.detail})`) : ' (sem link)'}.`, undo: () => api.unmarkPublished(item.id) };
  });
  const approve = () => run('ok', async () => {
    const w = approvalWindow(item, todayBrt());
    await api.approve([item.id], w.from, w.to, null);
    return { text: 'Aprovada. Nada foi publicado: postar continua com você.', undo: () => api.unapprove([item.id]) };
  });
  return (
    <div className="hq-viewer__decide" role="group" aria-label="Decidir esta peça">
      <p className="hq-viewer__state"><strong>{status}</strong>{pubWhen}{item.review ? ` · revisor: ${item.review.verdict}` : ''}{working ? ' · a equipe está trabalhando nela agora' : ''}</p>
      {mode === 'pub' && (
        <div className="hq-viewer__form">
          <input className="hq-input" value={text} onChange={e => setText(e.target.value)} placeholder={pub === 'link' ? 'Link do post (obrigatório)' : 'Link do post (recomendado: com ele a HQ mede os resultados)'} aria-label="Link do post" autoFocus />
          <button type="button" className="hq-btn hq-btn--sm hq-btn--ok" disabled={busy !== null || (pub === 'link' && !text.trim())} onClick={() => void markPub()}>{busy === 'pub' ? 'Registrando…' : pub === 'link' ? 'Registrar o link' : 'Marcar como publicada'}</button>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => { setMode(null); setText(''); }}>Cancelar</button>
        </div>
      )}
      {mode === 'ajuste' && (
        <div className="hq-viewer__form">
          <textarea className="hq-input" rows={2} value={text} onChange={e => setText(e.target.value)} placeholder={`O que ${owner} deve ajustar`} aria-label="Observação do ajuste" autoFocus />
          <button type="button" className="hq-btn hq-btn--sm" title="Põe no comentário o tempo em que o vídeo está pausado agora" onClick={() => { const el = document.querySelector('.hq-viewer__video') as HTMLVideoElement | null; if (!el) return; const t = el.currentTime; const stamp = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`; setText(x => `${x}${x && !x.endsWith('\n') ? '\n' : ''}[${stamp}] `); }}>Marcar o tempo do vídeo</button>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null || !text.trim()} onClick={() => void run('adj', async () => { await api.produce(item.id, text.trim()); return { text: `Ajuste enviado para ${owner}: a peça volta para a produção e depois para a revisão.` }; })}>{busy === 'adj' ? 'Enviando…' : `Devolver para ${owner}`}</button>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => { setMode(null); setText(''); }}>Cancelar</button>
        </div>
      )}
      {!mode && (
        <div className="hq-actions">
          {canApprove(item, tasks) && <button type="button" className="hq-btn hq-btn--ok" disabled={busy !== null} onClick={() => void approve()}>{busy === 'ok' ? 'Aprovando…' : item.status === 'ajustar' ? 'Aprovar assim mesmo' : 'Aprovar'}</button>}
          {pub && <button type="button" className="hq-btn hq-btn--ok" disabled={busy !== null} onClick={() => setMode('pub')}>{pub === 'link' ? 'Adicionar link' : 'Já publiquei'}</button>}
          {canAdj && <button type="button" className="hq-btn" disabled={busy !== null} onClick={() => setMode('ajuste')}>Pedir ajustes</button>}
          {item.status === 'aprovada' && !item.deletedAt && <button type="button" className="hq-btn hq-btn--ghost" disabled={busy !== null} onClick={() => void run('un', async () => { await api.unapprove([item.id]); return { text: 'Aprovação desfeita: voltou para "Para revisar".' }; })}>Desfazer aprovação</button>}
        </div>
      )}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      {done && <p className="hq-hub-ok" role="status">{done.text}{done.undo && <> <button type="button" className="hq-linkbtn" onClick={() => { const u = done.undo!; setDone(null); void u().catch(err => setError((err as Error).message)); }}>Desfazer</button></>}</p>}
    </div>
  );
}

/** Miniatura da peça: a primeira imagem entregue; vídeo e texto mostram o tipo. */
export function Thumb({ item, api }: { item: ContentItem; api: ContentApi }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Vídeo e carrossel feitos pela HQ: a capa (capa.png) e o 1º slide (slides/01.png) servem de miniatura.
    const sep = item.folder?.includes('/') && !item.folder.includes('\\') ? '/' : '\\';
    const pic = item.deliverable && IMG.test(item.deliverable) ? item.deliverable
      : item.folder ? (/carross|slides|post de imagens/i.test(item.format) ? `${item.folder}${sep}slides${sep}01.png` : /reel|v[íi]deo|tiktok/i.test(item.format) ? `${item.folder}${sep}capa.png` : null) : null;
    if (pic) void api.image(pic).then(s => { if (alive) setSrc(s); }).catch(() => undefined);
    else setSrc(null);
    return () => { alive = false; };
  }, [item.deliverable, item.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const video = /reel|v[íi]deo|tiktok/i.test(item.format) || item.slot === 'tiktok';
  return (
    <button type="button" className="hq-peca__thumb" onClick={() => api.openPiece(item)} title="Abrir a peça" aria-label={`Abrir "${item.title}"`}>
      {src ? <img src={src} alt="" /> : <span>{video ? '▶' : item.deliverable ? 'Aa' : '…'}</span>}
    </button>
  );
}

/** Cartão de peça (Mural e Mesa): conta, título, data, responsável, prévia, estado real e as ações conforme o formato. */
export function PecaCard({ item, employees, tasks, api, selected, onSelect, onNote, radar }: { item: ContentItem; employees: Employee[]; tasks: Task[]; api: ContentApi; selected?: boolean; onSelect?(on: boolean): void; onNote?(n: UndoNote): void; radar?: RadarItem[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adjust, setAdjust] = useState(false);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [pubForm, setPubForm] = useState(false);
  const [pubUrl, setPubUrl] = useState('');
  const run = async (k: string, fn: () => Promise<unknown>) => { setBusy(k); setError(null); try { await fn(); return true; } catch (err) { setError((err as Error).message); return false; } finally { setBusy(null); } };
  const col = pieceColumn(item, tasks);
  const scope = runningScope(item, tasks);
  const working = scope.running.length + scope.queued.length > 0;
  const owner = who(employees, item.ownerId);
  const active = scope.running[0] ?? scope.queued[0] ?? null;
  const worker = active?.employeeId ? who(employees, active.employeeId) : owner;
  const missing = item.checks.find(c => c.name === 'Entrega exigida' && !c.ok)?.detail ?? null;
  const paused = Boolean(item.pausedReason);
  const canRedo = !paused && !item.deletedAt && !item.archivedAt && ['planejada', 'parcial', 'falhou', 'ajustar'].includes(item.status);
  const canAdjust = !paused && !item.deletedAt && !item.archivedAt && ['revisar', 'ajustar', 'aprovada', 'parcial'].includes(item.status) && !working;
  const pubAct = publishAction(item, tasks);
  const canRender = !paused && !item.deletedAt && !item.archivedAt && !working && /reel|v[íi]deo/i.test(item.format) && ['revisar', 'ajustar', 'parcial'].includes(item.status) && item.checks.some(c => c.name === 'Direção do vídeo');
  const refs = (radar ?? []).filter(r => item.referenceIds.includes(r.id) || r.id === item.radarId);
  const trash = () => run('trash', async () => {
    const r = await api.trash([item.id]);
    setConfirm(false);
    onNote?.({ text: `"${item.title}" foi para a lixeira${r.cancelled.length ? ` (${r.cancelled.length} tarefa(s) cancelada(s))` : ''}. Os arquivos ficam na pasta; nada saiu das redes.`, undo: () => api.restore([item.id]) });
  });
  return (
    <li className={`hq-peca hq-peca--${col}${item.deletedAt ? ' hq-peca--lixeira' : ''}${selected ? ' hq-peca--sel' : ''}`}>
      {onSelect && <input type="checkbox" className="hq-peca__check" checked={Boolean(selected)} onChange={e => onSelect(e.target.checked)} aria-label={`Selecionar "${item.title}"`} />}
      <Thumb item={item} api={api} />
      <div className="hq-peca__body">
        <div className="hq-peca__head">
          <span className={`hq-tag hq-tag--xs hq-ct-st--${item.status}`}>{item.deletedAt ? 'Na lixeira' : item.archivedAt ? 'Arquivada' : col === 'pausada' ? 'Pausada pelo foco' : col === 'producao' ? (item.status === 'em_producao' ? 'Em produção' : 'Em revisão') : col === 'fila' ? 'Na fila' : CONTENT_ITEM_STATUS_LABEL[item.status]}</span>
          <strong className="hq-peca__title">{item.title}</strong>
          {teamChannelLabel(item) && <span className={`hq-teamtag hq-teamtag--${teamOfWork(item) ?? 'none'}`}>{teamChannelLabel(item)}</span>}
        </div>
        <p className="hq-dim hq-peca__meta">{slotLabel(item.slot)}{item.format ? ` · ${item.format}` : ''} · {item.date ? `${dayLabel(item.date)}${item.time ? ` ${item.time}` : ''}` : 'sem data'} · {owner}{item.review ? ` · revisor: ${item.review.verdict}` : ''}</p>
        {paused && <p className="hq-peca__miss">Pausada: {item.pausedReason}. O trabalho e os arquivos ficam; nada é produzido, agendado ou publicado neste destino.</p>}
        {item.hypothesis && <p className="hq-dim hq-peca__hyp">Hipótese: {item.hypothesis}</p>}
        {refs.length > 0 && <p className="hq-dim hq-peca__ref">Referência: {refs.map((r, k) => <span key={r.id}>{k ? ' · ' : ''}{r.sourceUrl.startsWith('chefe://') ? `${r.subject} (enviada por você)` : <button type="button" className="hq-linkbtn" onClick={() => api.openUrl(r.sourceUrl)} title={r.sourceUrl}>{r.author ? `${r.author} · ` : ''}{r.subject}</button>}</span>)}</p>}
        {working && <p className="hq-peca__now">{scope.running.length ? `${worker} está ${item.status === 'em_producao' ? 'produzindo' : 'revisando'} agora${scope.running[0].status === 'waiting_permission' ? ' (esperando a sua autorização)' : scope.running[0].status === 'waiting_answer' ? ' (esperando a sua resposta)' : ''}` : `na fila (${item.status === 'em_producao' ? 'criação' : 'revisão'}, ${worker})`}.</p>}
        {missing && <p className="hq-peca__miss">Falta: {missing}</p>}
        {item.nextStep && !working && !missing && <p className="hq-dim hq-peca__next">{item.nextStep}</p>}
        {item.status === 'publicada' && item.publication && (
          <p className="hq-hub-ok hq-peca__pub">Publicada em {new Date(item.publication.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{item.publication.url ? <> · <button type="button" className="hq-linkbtn" onClick={() => api.openUrl(item.publication!.url!)}>ver o post</button></> : ' · sem link (informado por você)'}{item.publication.verifiedBy === 'link' ? ' · link conferido' : ''}</p>
        )}
        {error && <p className="hq-composer__bad" role="alert">{error}</p>}
        {pubForm && (
          <div className="hq-desk__adjust">
            <p className="hq-dim">{pubAct === 'link' ? 'Cole o link do post: a HQ confere o domínio e passa a medir os resultados.' : `${item.status === 'aprovada' || item.status === 'publicacao_pendente' || item.status === 'agendada' ? 'Marca' : 'Aprova e marca'} como publicada por você agora. Com o link, a HQ confere o domínio e mede os resultados de 24 h e 7 dias; sem link, fica "informado por você".`}</p>
            <input className="hq-input" value={pubUrl} onChange={e => setPubUrl(e.target.value)} placeholder={`Link do post (${pubAct === 'link' ? 'obrigatório' : 'recomendado'})`} aria-label="Link do post" />
            <div className="hq-actions">
              <button type="button" className="hq-btn hq-btn--sm hq-btn--ok" disabled={busy !== null || (pubAct === 'link' && !pubUrl.trim())} onClick={() => void run('pub', async () => { const r = await api.markPublished(item.id, pubUrl.trim() || null); setPubForm(false); setPubUrl(''); onNote?.({ text: pubAct === 'link' ? `Link registrado em "${item.title}" (${r.ok ? 'conferido' : r.detail}).` : `"${item.title}" marcada como publicada${pubUrl.trim() ? (r.ok ? ' (link conferido)' : ` (${r.detail})`) : ' (sem link)'}.`, undo: pubAct === 'link' ? undefined : () => api.unmarkPublished(item.id) }); })}>{busy === 'pub' ? 'Registrando…' : pubAct === 'link' ? 'Registrar o link' : 'Marcar como publicada'}</button>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => { setPubForm(false); setPubUrl(''); }}>Cancelar</button>
            </div>
          </div>
        )}
        {adjust && (
          <div className="hq-desk__adjust">
            <textarea className="hq-input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder={`O que ${owner} deve ajustar (a versão atual fica na pasta)`} aria-label="Observação do ajuste" />
            <div className="hq-actions">
              <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={!note.trim() || busy !== null} onClick={() => void run('adj', () => api.produce(item.id, note.trim())).then(ok => { if (ok) { setAdjust(false); setNote(''); onNote?.({ text: `Ajuste enviado para ${owner}: a peça volta para a produção e depois para a revisão.` }); } })}>{busy === 'adj' ? 'Enviando…' : `Devolver para ${owner}`}</button>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setAdjust(false)}>Cancelar</button>
            </div>
          </div>
        )}
        {confirm && (
          <div className="hq-peca__confirm" role="alertdialog" aria-label="Confirmar">
            <p><strong>Cancelar tarefa e mover para a lixeira?</strong> {scope.running.length ? `Interrompe o que ${worker} está fazendo agora` : ''}{scope.running.length && scope.queued.length ? ' e ' : ''}{scope.queued.length ? `${scope.running.length ? 'cancela' : 'Cancela'} ${scope.queued.length} tarefa(s) na fila` : ''} desta peça. O que já foi gravado fica na pasta; nada é removido das redes. Restaurar não recomeça a produção.</p>
            <div className="hq-actions">
              <button type="button" className="hq-btn hq-btn--sm hq-btn--danger" disabled={busy !== null} onClick={() => void trash()}>{busy === 'trash' ? 'Cancelando…' : 'Cancelar tarefa e mover para a lixeira'}</button>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setConfirm(false)}>Voltar</button>
            </div>
          </div>
        )}
        {!adjust && !confirm && !pubForm && (
          <div className="hq-actions hq-peca__actions">
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => api.openPiece(item)}>Abrir</button>
            {canApprove(item, tasks) && <button type="button" className="hq-btn hq-btn--sm hq-btn--ok" disabled={busy !== null} title={`Aprova para publicar (${approvalWindow(item, todayBrt()).from} a ${approvalWindow(item, todayBrt()).to}). Nada sai agora: sem conta conectada, postar continua com você.`} onClick={() => void run('approve', async () => { const w = approvalWindow(item, todayBrt()); await api.approve([item.id], w.from, w.to, null); onNote?.({ text: `"${item.title}" aprovada. Nada foi publicado: postar continua com você (Abrir ou Copiar texto do post).`, undo: () => api.unapprove([item.id]) }); })}>{busy === 'approve' ? 'Aprovando…' : item.status === 'ajustar' ? 'Aprovar assim mesmo' : 'Aprovar'}</button>}
            {pubAct && <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} title={pubAct === 'link' ? 'Acrescenta o link do post publicado' : 'Você já postou no app: registra a publicação (e aprova, se faltava)'} onClick={() => setPubForm(true)}>{pubAct === 'link' ? 'Adicionar link' : 'Já publiquei'}</button>}
            {item.status === 'aprovada' && !item.deletedAt && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy !== null} onClick={() => void run('unapprove', async () => { await api.unapprove([item.id]); onNote?.({ text: `Aprovação de "${item.title}" desfeita: a peça voltou para "Para revisar".` }); })}>Desfazer aprovação</button>}
            {item.deliverable && <CopyPost item={item} api={api} />}
            {canAdjust && <button type="button" className="hq-btn hq-btn--sm" onClick={() => setAdjust(true)}>Pedir ajustes</button>}
            {canRender && <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} title="A HQ renderiza de novo o mesmo video.json (a versão anterior fica em versoes/) e a revisão confere outra vez" onClick={() => void run('render', () => api.rerender(item.id)).then(ok => { if (ok) onNote?.({ text: `"${item.title}" renderizado de novo; a revisão entrou na fila.` }); })}>{busy === 'render' ? 'Renderizando… (1 a 3 min)' : 'Renderizar de novo'}</button>}
            {canRedo && <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null || !item.slot} onClick={() => void run('redo', () => api.produce(item.id, null))}>{item.status === 'planejada' ? 'Produzir' : 'Produzir de novo'}</button>}
            {item.deletedAt
              ? <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} onClick={() => void run('rest', () => api.restore([item.id]))}>Restaurar</button>
              : <>
                <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy !== null || item.status === 'em_producao'} title={item.status === 'em_producao' ? 'Em produção: espere terminar ou mova para a lixeira (cancela a tarefa)' : 'Tira da visão principal; a peça e os arquivos ficam'} onClick={() => void run('arch', async () => { await api.archive([item.id], !item.archivedAt); onNote?.({ text: item.archivedAt ? `"${item.title}" voltou para o mural.` : `"${item.title}" foi arquivada.`, undo: () => api.archive([item.id], Boolean(item.archivedAt)) }); })}>{item.archivedAt ? 'Desarquivar' : 'Arquivar'}</button>
                {item.status !== 'publicada' && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy !== null} onClick={() => (working ? setConfirm(true) : void trash())}>{working ? 'Cancelar tarefa e excluir…' : 'Excluir'}</button>}
              </>}
          </div>
        )}
      </div>
    </li>
  );
}

/** Barra de Desfazer depois de arquivar ou mover para a lixeira (some sozinha). */
export function UndoBar({ note, onClose }: { note: UndoNote | null; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!note) return; const t = window.setTimeout(onClose, 12_000); return () => window.clearTimeout(t); }, [note]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!note) return null;
  return (
    <div className="hq-undo" role="status">
      <span>{note.text}</span>
      {note.undo && <button type="button" className="hq-btn hq-btn--sm" disabled={busy} onClick={() => { setBusy(true); void note.undo!().finally(() => { setBusy(false); onClose(); }); }}>Desfazer</button>}
      <button type="button" className="hq-iconbtn" onClick={onClose} aria-label="Fechar aviso">×</button>
    </div>
  );
}

/** Mural → Peças. renderTask desenha os cartões de tarefas avulsas (os de antes), que também podem ser arquivados ou excluídos. */
export function PiecesBoard(props: { content: ContentState; tasks: Task[]; employees: Employee[]; room: Room | null; profileId: string | null; api: ContentApi; deliveries: DeskDelivery[]; loose: Task[]; renderTask(t: Task, actions: React.ReactNode): React.ReactNode }) {
  const [f, setF] = useState<PieceFilter>({ profileId: props.profileId, slot: '', from: '', to: '', view: 'ativas' });
  useEffect(() => { setF(x => ({ ...x, profileId: props.profileId })); }, [props.profileId]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<UndoNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const list = useMemo(() => filterPieces(props.content.items, f, props.tasks), [props.content.items, f, props.tasks]);
  const visible = new Set(list.map(i => i.id));
  const chosen = [...sel].filter(id => visible.has(id));
  useEffect(() => { setSel(s => new Set([...s].filter(id => visible.has(id)))); }, [list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string, on: boolean) => setSel(s => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const runningChosen = chosen.map(id => props.content.items.find(i => i.id === id)!).filter(i => { const s = runningScope(i, props.tasks); return s.running.length + s.queued.length > 0; });
  const approvable = chosen.map(id => props.content.items.find(i => i.id === id)!).filter(i => canApprove(i, props.tasks));
  const approveBatch = async () => {
    setBusy(true); setError(null);
    try {
      const today = todayBrt();
      const to = approvable.map(i => approvalWindow(i, today).to).sort().pop()!;
      const ids = approvable.map(i => i.id);
      await props.api.approve(ids, today, to, null);
      setNote({ text: `${ids.length} peça(s) aprovada(s) (${today} a ${to}). Nada foi publicado: postar continua com você.`, undo: () => props.api.unapprove(ids) });
      setSel(new Set());
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const batch = async (what: 'arquivar' | 'desarquivar' | 'lixeira' | 'restaurar') => {
    setBusy(true); setError(null); setConfirmBatch(false);
    const ids = [...chosen];
    try {
      if (what === 'lixeira') { const r = await props.api.trash(ids); setNote({ text: `${r.trashed.length} peça(s) foram para a lixeira${r.cancelled.length ? ` (${r.cancelled.length} tarefa(s) cancelada(s))` : ''}. Os arquivos ficam; nada saiu das redes.`, undo: () => props.api.restore(r.trashed) }); }
      else if (what === 'restaurar') { await props.api.restore(ids); setNote({ text: `${ids.length} peça(s) restaurada(s). Nada recomeçou sozinho.`, undo: () => props.api.trash(ids) }); }
      else { await props.api.archive(ids, what === 'arquivar'); setNote({ text: `${ids.length} peça(s) ${what === 'arquivar' ? 'arquivada(s)' : 'de volta ao mural'}.`, undo: () => props.api.archive(ids, what !== 'arquivar') }); }
      setSel(new Set());
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const profiles = props.room?.profiles ?? [];
  const sections = f.view === 'ativas' ? PIECE_COLUMNS.map(c => ({ ...c, items: list.filter(i => pieceColumn(i, props.tasks) === c.id) })).filter(s => s.items.length) : [{ id: f.view, label: PIECE_VIEWS.find(v => v.id === f.view)!.label, hint: '', items: list }];
  const trashCount = props.content.items.filter(i => i.deletedAt).length;
  const archCount = props.content.items.filter(i => !i.deletedAt && i.archivedAt).length;
  const loose = props.loose.filter(t => { const h = hiddenState(props.content.hidden, `task:${t.id}`); return f.view === 'lixeira' ? h === 'lixeira' : f.view === 'arquivadas' ? h === 'arquivada' : h === null && f.view === 'ativas'; });
  return (
    <div className="hq-pecas">
      <div className="hq-pecas__filters" role="group" aria-label="Filtros do mural">
        <label className="hq-field"><span>Marca</span><select className="hq-select" value={f.profileId ?? ''} onChange={e => setF(x => ({ ...x, profileId: e.target.value || null }))}><option value="">Todas</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="hq-field"><span>Conta</span><select className="hq-select" value={f.slot} onChange={e => setF(x => ({ ...x, slot: e.target.value as SocialSlotId | '' }))}><option value="">Todas</option>{SOCIAL_SLOTS.map(s => <option key={s.slot} value={s.slot}>{s.label}</option>)}</select></label>
        <label className="hq-field"><span>De</span><input className="hq-input" type="date" value={f.from} onChange={e => setF(x => ({ ...x, from: e.target.value }))} /></label>
        <label className="hq-field"><span>Até</span><input className="hq-input" type="date" value={f.to} onChange={e => setF(x => ({ ...x, to: e.target.value }))} /></label>
        <label className="hq-field"><span>Estado</span><select className="hq-select" value={f.view} onChange={e => setF(x => ({ ...x, view: e.target.value as PieceView }))}>{PIECE_VIEWS.map(v => <option key={v.id} value={v.id}>{v.label}{v.id === 'lixeira' ? ` (${trashCount})` : v.id === 'arquivadas' ? ` (${archCount})` : ''}</option>)}</select></label>
        <div className="hq-pecas__quick">
          <button type="button" className="hq-linkbtn" onClick={() => setF(x => ({ ...x, from: todayBrt(), to: todayBrt() }))}>hoje</button>
          <button type="button" className="hq-linkbtn" onClick={() => setF(x => ({ ...x, from: addDays(todayBrt(), 1), to: addDays(todayBrt(), 1) }))}>amanhã</button>
          {(f.from || f.to || f.slot) && <button type="button" className="hq-linkbtn" onClick={() => setF(x => ({ ...x, from: '', to: '', slot: '' }))}>limpar</button>}
        </div>
      </div>
      <div className="hq-pecas__batch">
        <label className="hq-pecas__all"><input type="checkbox" checked={list.length > 0 && chosen.length === list.length} onChange={e => setSel(e.target.checked ? new Set(list.map(i => i.id)) : new Set())} disabled={!list.length} /> {list.length} peça(s) no filtro · <strong>{chosen.length} selecionada(s)</strong></label>
        {chosen.length > 0 && (f.view === 'lixeira'
          ? <button type="button" className="hq-btn hq-btn--sm" disabled={busy} onClick={() => void batch('restaurar')}>Restaurar ({chosen.length})</button>
          : <>
            {approvable.length > 0 && <button type="button" className="hq-btn hq-btn--sm hq-btn--ok" disabled={busy} title="Aprova as peças entregues da seleção; as outras ficam como estão" onClick={() => void approveBatch()}>Aprovar ({approvable.length})</button>}
            <button type="button" className="hq-btn hq-btn--sm" disabled={busy} onClick={() => void batch(f.view === 'arquivadas' ? 'desarquivar' : 'arquivar')}>{f.view === 'arquivadas' ? 'Desarquivar' : 'Arquivar'} ({chosen.length})</button>
            <button type="button" className="hq-btn hq-btn--sm hq-btn--danger" disabled={busy} onClick={() => (runningChosen.length ? setConfirmBatch(true) : void batch('lixeira'))}>Mover para a lixeira ({chosen.length})</button>
          </>)}
      </div>
      {confirmBatch && (
        <div className="hq-peca__confirm" role="alertdialog">
          <p><strong>{runningChosen.length} das {chosen.length} peças estão em execução ou na fila.</strong> Mover para a lixeira cancela essas tarefas ({runningChosen.map(i => `"${i.title}"`).join(', ')}). Os arquivos ficam; nada sai das redes.</p>
          <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm hq-btn--danger" disabled={busy} onClick={() => void batch('lixeira')}>Cancelar as tarefas e mover para a lixeira</button><button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setConfirmBatch(false)}>Voltar</button></div>
        </div>
      )}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      <UndoBar note={note} onClose={() => setNote(null)} />
      {list.length === 0 && <p className="hq-empty">{f.view === 'lixeira' ? 'A lixeira está vazia.' : f.view === 'arquivadas' ? 'Nenhuma peça arquivada.' : 'Nenhuma peça neste filtro.'}</p>}
      {sections.map(s => (
        <section key={s.id} className="hq-section">
          <h3 className="hq-label" title={s.hint}>{s.label} ({s.items.length})</h3>
          <ul className="hq-pecas__list">{s.items.map(i => <PecaCard key={i.id} item={i} employees={props.employees} tasks={props.tasks} api={props.api} radar={props.content.radar} selected={sel.has(i.id)} onSelect={on => toggle(i.id, on)} onNote={setNote} />)}</ul>
        </section>
      ))}
      {loose.length > 0 && (
        <details className="hq-section" open={f.view !== 'ativas'}>
          <summary className="hq-label">Pedidos avulsos da sala ({loose.length})</summary>
          <p className="hq-field__hint">Tarefas que não são peça do calendário (pedido livre pelo compositor ou pelo Estúdio). Arquivar ou excluir o cartão não apaga a conversa nem os arquivos.</p>
          <ul className="hq-list hq-soc-pieces">{loose.map(t => props.renderTask(t, <LooseActions t={t} api={props.api} state={hiddenState(props.content.hidden, `task:${t.id}`)} onNote={setNote} />))}</ul>
        </details>
      )}
    </div>
  );
}

/** Arquivar ou excluir o cartão de uma tarefa avulsa (rodando: cancela a tarefa antes, com o alcance escrito). */
function LooseActions({ t, api, state, onNote }: { t: Task; api: ContentApi; state: 'arquivada' | 'lixeira' | null; onNote(n: UndoNote): void }) {
  const [confirm, setConfirm] = useState(false);
  const key = `task:${t.id}`;
  const open = ['queued', 'running', 'waiting_permission', 'waiting_answer'].includes(t.status);
  const title = t.prompt.replace(/\s+/g, ' ').slice(0, 120);
  if (state) return <button type="button" className="hq-btn hq-btn--sm" onClick={() => void api.hidden(key, 'task', null, title, null)}>Restaurar</button>;
  if (confirm) return (
    <span className="hq-actions"><span className="hq-dim">{t.status === 'queued' ? 'Cancela a tarefa na fila' : 'Interrompe a execução atual'}; conversa e arquivos ficam.</span>
      <button type="button" className="hq-btn hq-btn--sm hq-btn--danger" onClick={() => void api.hidden(key, 'task', 'lixeira', title, t.id).then(() => onNote({ text: 'Tarefa cancelada e cartão na lixeira.', undo: () => api.hidden(key, 'task', null, title, null) }))}>Cancelar tarefa e mover para a lixeira</button>
      <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setConfirm(false)}>Voltar</button></span>
  );
  return (
    <span className="hq-actions">
      <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => void api.hidden(key, 'task', 'arquivada', title, null).then(() => onNote({ text: 'Cartão arquivado.', undo: () => api.hidden(key, 'task', null, title, null) }))}>Arquivar</button>
      <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => (open ? setConfirm(true) : void api.hidden(key, 'task', 'lixeira', title, null).then(() => onNote({ text: 'Cartão na lixeira.', undo: () => api.hidden(key, 'task', null, title, null) })))}>{open ? 'Cancelar tarefa e excluir…' : 'Excluir'}</button>
    </span>
  );
}

/** Progresso do pedido: peças esperadas (uma por conta), prontas, em produção e pendentes, com o motivo de cada conta. */
export function RequestCard({ p, api, employees }: { p: RequestProgress; api: ContentApi; employees: Employee[] }) {
  const r = p.request;
  return (
    <section className="hq-section hq-req">
      <div className="hq-req__head">
        <h3 className="hq-label">Pedido: {r.title}</h3>
        <span className="hq-dim">{dayLabel(r.date)} · {p.expected} esperada(s) · <strong>{p.ready} pronta(s)</strong> · {p.producing} em produção · {p.pending} pendente(s)</span>
      </div>
      <div className="hq-req__bar" aria-hidden="true"><span style={{ width: `${(p.ready / Math.max(1, p.expected)) * 100}%` }} className="hq-req__ok" /><span style={{ width: `${(p.producing / Math.max(1, p.expected)) * 100}%` }} className="hq-req__run" /></div>
      <ul className="hq-req__rows">
        {p.rows.map(row => (
          <li key={row.slot} className={`hq-req__row hq-req__row--${row.state}`}>
            <span className="hq-req__slot">{row.label}</span>
            <span className="hq-req__what">{row.item ? <button type="button" className="hq-linkbtn" onClick={() => api.openPiece(row.item!)}>{row.item.title}</button> : <span className="hq-dim">sem peça</span>}<br /><span className="hq-dim">{row.text}{row.employeeId ? ` · ${who(employees, row.employeeId)}` : ''}</span></span>
          </li>
        ))}
      </ul>
      {r.note && <p className="hq-dim">{r.note}</p>}
    </section>
  );
}

/** Topo da Mesa: pedidos ativos com progresso real e as entregas (completas e parciais) com as ações de cada formato. */
export function DeskPiecesV2({ content, tasks, employees, api, only }: { content: ContentState; tasks: Task[]; employees: Employee[]; api: ContentApi; only?: 'decisoes' | 'entregas' }) {
  const [note, setNote] = useState<UndoNote | null>(null);
  const reqs = activeRequests(content).map(r => requestProgress(r, content.items, tasks, SOCIAL_SLOTS.map(s => s.slot).filter(s => content.focus?.activeSlots ? !content.focus.activeSlots.includes(s) : false)));
  const cols = only === 'decisoes' ? ['parcial'] : only === 'entregas' ? ['revisar'] : ['revisar', 'parcial'];
  const deliveries = content.items.filter(i => isActive(i) && cols.includes(pieceColumn(i, tasks))).sort((a, b) => `${a.date ?? '9999'}${a.time ?? ''}`.localeCompare(`${b.date ?? '9999'}${b.time ?? ''}`));
  const working = content.items.filter(i => isActive(i) && ['producao', 'fila'].includes(pieceColumn(i, tasks)));
  const pausedN = content.items.filter(i => isActive(i) && pieceColumn(i, tasks) === 'pausada').length;
  // Mesa do Chefe em três grupos: aqui as decisões são os planos com perguntas e as peças paradas que pedem escolha.
  if (only === 'decisoes') {
    if (!reqs.length && !deliveries.length) return null;
    return (
      <>
        {reqs.map(p => <RequestCard key={p.request.id} p={p} api={api} employees={employees} />)}
        {deliveries.length > 0 && <ul className="hq-pecas__list">{deliveries.map(i => <PecaCard key={i.id} item={i} employees={employees} tasks={tasks} api={api} radar={content.radar} onNote={setNote} />)}</ul>}
        <UndoBar note={note} onClose={() => setNote(null)} />
      </>
    );
  }
  if (only === 'entregas') {
    return (
      <>
        <UndoBar note={note} onClose={() => setNote(null)} />
        {deliveries.length === 0
          ? <p className="hq-empty">{working.length ? `Nada pronto ainda: ${working.length} peça(s) em produção ou na fila.` : 'Nenhuma entrega esperando você.'}{pausedN ? ` ${pausedN} peça(s) de destinos pausados ficam no Mural.` : ''}</p>
          : <ul className="hq-pecas__list">{deliveries.map(i => <PecaCard key={i.id} item={i} employees={employees} tasks={tasks} api={api} radar={content.radar} onNote={setNote} />)}</ul>}
        <VideoRefList content={content} api={api} onOpenMeeting={api.openMeeting} limit={6} hideTrashed />
      </>
    );
  }
  return (
    <>
      <VideoRefList content={content} api={api} onOpenMeeting={api.openMeeting} limit={6} hideTrashed />
      {reqs.map(p => <RequestCard key={p.request.id} p={p} api={api} employees={employees} />)}
      <section className="hq-section">
        <h3 className="hq-label">Entregas para revisar ({deliveries.length})</h3>
        {content.focus?.activeSlots && <p className="hq-dim">{content.focus.reason}.{pausedN ? ` ${pausedN} peça(s) de destinos pausados ficam fora desta lista (Mural → Peças → Pausadas pelo foco).` : ''}</p>}
        <UndoBar note={note} onClose={() => setNote(null)} />
        {deliveries.length === 0
          ? <p className="hq-empty">{working.length ? `Nenhuma entrega pronta ainda: ${working.length} peça(s) em produção ou na fila (${working.slice(0, 3).map(i => `"${i.title}"`).join(', ')}${working.length > 3 ? '…' : ''}).` : 'Nenhuma entrega esperando você e ninguém produzindo agora.'}</p>
          : <ul className="hq-pecas__list">{deliveries.map(i => <PecaCard key={i.id} item={i} employees={employees} tasks={tasks} api={api} radar={content.radar} onNote={setNote} />)}</ul>}
      </section>
    </>
  );
}

/** Formulário do pedido do dia (Calendário): data, contas e observação; com produção autorizada, a equipe começa sozinha. */
export function NewRequestForm({ api }: { api: ContentApi }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(addDays(todayBrt(), 1));
  const [slots, setSlots] = useState<Set<SocialSlotId>>(new Set(SOCIAL_SLOTS.map(s => s.slot)));
  const [noteText, setNoteText] = useState('');
  const [auto, setAuto] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className="hq-btn hq-btn--sm" onClick={() => setOpen(true)}>Novo pedido do dia</button>;
  return (
    <div className="hq-ct-approve">
      <strong>Pedido do dia: uma publicação principal por conta</strong>
      <div className="hq-ct-row">
        <label className="hq-field"><span>Dia</span><input className="hq-input" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="hq-field"><span>Observação</span><input className="hq-input" value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="opcional" /></label>
      </div>
      <div className="hq-pecas__slots">{SOCIAL_SLOTS.map(s => <label key={s.slot}><input type="checkbox" checked={slots.has(s.slot)} onChange={e => setSlots(x => { const n = new Set(x); if (e.target.checked) n.add(s.slot); else n.delete(s.slot); return n; })} /> {s.label}</label>)}</div>
      <label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Produção autorizada: as peças planejadas do dia vão para a fila, e conta sem pauta recebe uma da pesquisa assim que ela terminar</label>
      {msg && <p className="hq-hub-ok" role="status">{msg}</p>}
      <div className="hq-actions">
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy || !slots.size || !date} onClick={() => { setBusy(true); setMsg(null); void api.requestCreate({ date, slots: [...slots], note: noteText.trim() || null, autoProduce: auto }).then(r => setMsg(`Pedido criado: ${r.produced} peça(s) foram para a produção${r.waiting.length ? `; esperando a pesquisa: ${r.waiting.length} conta(s)` : ''}${r.skipped.length ? `; fora: ${r.skipped.join('; ')}` : ''}.`)).catch(err => setMsg((err as Error).message)).finally(() => setBusy(false)); }}>{busy ? 'Criando…' : 'Criar o pedido'}</button>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setOpen(false)}>Fechar</button>
      </div>
    </div>
  );
}
