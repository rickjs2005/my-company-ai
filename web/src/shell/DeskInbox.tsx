// Caixa de entrada da Mesa do Chefe: Entregas (persistidas no servidor, com versões), Perguntas e Bloqueios (estado real das
// tarefas: pergunta do funcionário, pedido de autorização, falha, espera, falta de alguém apto no plano). A resposta do Chefe
// volta para o funcionário responsável pela mesma tarefa. Aprovar uma entrega não publica nada.
import { useEffect, useMemo, useState } from 'react';
import type { ContentHidden, DeskDelivery, DeskState, Employee, KnowledgeScope, KnowledgeUse, Meeting, PendingPermission, Session, Task } from '@milweb-hq/protocol';
import { DESK_STATUS_LABEL, KNOWLEDGE_KIND_LABEL, SOCIAL_SLOTS, isTeamId, teamChannelLabel, teamDef, teamOfSlot, teamOfWork } from '@milweb-hq/protocol';
import type { ViewerRequest } from './FileViewer';

export interface DeskApi {
  approve(id: string): Promise<unknown>;
  /** `remember` = "Usar nos próximos trabalhos": a observação também vira preferência no alcance escolhido. */
  adjust(id: string, note: string, remember?: KnowledgeScope | null): Promise<unknown>;
  /** Conhecimento da equipe que a tarefa desta entrega recebeu (para o detalhe). */
  knowledgeOf?(taskId: string): KnowledgeUse[];
  seen(ids: string[]): Promise<unknown>;
  resolveNeed(id: string): Promise<unknown>;
  answer(sessionId: string, requestId: string, answers: Record<string, string>): void;
  permit(sessionId: string, requestId: string, allow: boolean): void;
  openFile(abs: string): void;
  /** Visualizador da HQ (imagem, vídeo, texto) com os arquivos da entrega. */
  view(r: ViewerRequest): void;
  openUrl(url: string): void;
  openTask(taskId: string): void;
  /** Prévia de imagem (data URL) quando o arquivo está numa pasta cadastrada; null = sem prévia. */
  image(abs: string): Promise<string | null>;
  /** Arquivar, lixeira ou mostrar de novo uma entrega (série inteira); a tarefa e os arquivos ficam. */
  hide?(key: string, state: 'arquivada' | 'lixeira' | null, title: string): Promise<unknown>;
}

/** Peça parada que pede você: falhou, ficou parcial sem produção ou é conta do pedido sem peça e sem pesquisa rodando. */
export interface StalledPiece { key: string; title: string; reason: string; next: string; open?(): void }

type Tab = 'entregas' | 'perguntas' | 'bloqueios';
/** Grupos da Mesa do Chefe (08/11): decisões (perguntas e permissões), entregas para revisar e bloqueios. */
export type DeskGroupId = 'decisoes' | 'entregas' | 'bloqueios';
const IMG = /\.(png|jpe?g|webp|gif)$/i;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const when = (t: number) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const firstLine = (s: string) => (s.split('\n').find(l => l.trim() && !l.startsWith('[')) ?? s).trim().slice(0, 140);

/** Equipe e canal da tarefa (Mesa do Chefe, 08/11): de qual equipe é a decisão ou a entrega. */
export function TeamTag({ task }: { task: Task | null | undefined }) {
  const label = task ? teamChannelLabel(task) : null;
  return label ? <span className={`hq-teamtag hq-teamtag--${teamOfWork(task!) ?? 'none'}`}>{label}</span> : null;
}

export interface DeskCounts { entregas: number; perguntas: number; bloqueios: number; total: number }

/** Itens que pedem atenção: entregas novas, perguntas e bloqueios abertos (o mesmo cálculo da insígnia e das abas). */
export function deskItems(desk: DeskState | null, pending: PendingPermission[], tasks: Task[], hidden: ContentHidden[] = [], stalled: StalledPiece[] = []) {
  const hiddenKeys = new Set(hidden.filter(h => h.kind === 'delivery').map(h => h.key));
  const all = desk?.deliveries ?? [];
  const deliveries = all.filter(d => !hiddenKeys.has(`desk:${d.rootTaskId}`));
  const hiddenDeliveries = all.filter(d => hiddenKeys.has(`desk:${d.rootTaskId}`));
  const questions = pending.filter(p => p.isQuestion);
  const permissions = pending.filter(p => !p.isQuestion);
  const needs = (desk?.needs ?? []).filter(n => !n.resolvedAt);
  // Cartões idênticos (mesma pessoa, mesmo pedido, mesmo motivo) aparecem uma vez só.
  const once = <T,>(list: T[], key: (x: T) => string) => { const seen = new Set<string>(); return list.filter(x => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const failed = once(tasks.filter(t => t.origin === 'meeting' && ['error', 'lost', 'interrupted'].includes(t.status) && !tasks.some(r => r.retryOf === t.id)), t => `${t.employeeId}|${firstLine(t.prompt)}|${t.errors[t.errors.length - 1] ?? t.status}`);
  const held = once(tasks.filter(t => t.status === 'queued' && t.held && t.heldReason && !t.heldReason.startsWith('Aguardando dependência')), t => `${t.employeeId}|${firstLine(t.prompt)}|${t.heldReason}`);
  const counts: DeskCounts = { entregas: deliveries.filter(d => d.status === 'nova').length, perguntas: questions.length, bloqueios: permissions.length + needs.length + failed.length + held.length + stalled.length, total: 0 };
  counts.total = counts.entregas + counts.perguntas + counts.bloqueios;
  return { deliveries, hiddenDeliveries, questions, permissions, needs, failed, held, stalled, counts };
}

export function DeskInbox(props: { desk: DeskState | null; pending: PendingPermission[]; tasks: Task[]; sessions: Session[]; employees: Employee[]; meetings: Meeting[]; api: DeskApi; hidden?: ContentHidden[]; stalled?: StalledPiece[]; group?: DeskGroupId }) {
  const items = useMemo(() => deskItems(props.desk, props.pending, props.tasks, props.hidden ?? [], props.stalled ?? []), [props.desk, props.pending, props.tasks, props.hidden, props.stalled]);
  const [tab, setTab] = useState<Tab>(() => (items.counts.perguntas ? 'perguntas' : items.counts.bloqueios && !items.counts.entregas ? 'bloqueios' : 'entregas'));
  const emp = (id: string | null | undefined) => (id ? props.employees.find(e => e.id === id)?.name : null) ?? '—';
  const sessionEmp = (sessionId: string) => emp(props.sessions.find(s => s.id === sessionId)?.employeeId);
  const taskOf = (id: string | null) => (id ? props.tasks.find(t => t.id === id) ?? null : null);
  // Abrir a aba de entregas marca as novas como vistas (o contador zera; a entrega continua lá).
  useEffect(() => {
    if (tab !== 'entregas') return;
    const ids = items.deliveries.filter(d => d.status === 'nova').map(d => d.id);
    if (ids.length) void props.api.seen(ids).catch(() => undefined);
  }, [tab, items.deliveries]); // eslint-disable-line react-hooks/exhaustive-deps
  // Só a versão mais nova de cada série aparece em destaque; as anteriores ficam guardadas embaixo.
  const series = useMemo(() => {
    const byRoot = new Map<string, DeskDelivery[]>();
    for (const d of items.deliveries) byRoot.set(d.rootTaskId, [...(byRoot.get(d.rootTaskId) ?? []), d]);
    return [...byRoot.values()].map(v => v.sort((a, b) => b.version - a.version)).sort((a, b) => b[0].createdAt - a[0].createdAt);
  }, [items.deliveries]);

  // Um grupo só (Mesa do Chefe em três seções): sem abas, cartões curtos com o detalhe técnico recolhido.
  if (props.group) {
    const g = props.group;
    if (g === 'entregas') return series.length === 0 ? null : <ul className="hq-desk__list">{series.map(v => <DeliveryCard key={v[0].id} d={v[0]} older={v.slice(1)} who={emp(v[0].employeeId)} task={taskOf(v[0].adjustTaskId)} api={props.api} origin={taskOf(v[0].taskId)} />)}</ul>;
    if (g === 'decisoes') {
      if (!items.questions.length && !items.permissions.length) return null;
      return (
        <ul className="hq-desk__list">
          {items.questions.map(q => <QuestionCard key={q.request.requestId} q={q} who={sessionEmp(q.sessionId)} task={taskOf(q.taskId)} api={props.api} />)}
          {items.permissions.map(p => (
            <li key={p.request.requestId} className="hq-desk__card hq-desk__card--warn">
              <div className="hq-desk__head"><strong>{sessionEmp(p.sessionId)} precisa da sua permissão</strong><TeamTag task={taskOf(p.taskId)} /><span className="hq-dim">{p.request.toolName}</span></div>
              {taskOf(p.taskId) && <p className="hq-dim">Tarefa: {firstLine(taskOf(p.taskId)!.prompt)}</p>}
              <div className="hq-actions">
                <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => props.api.permit(p.sessionId, p.request.requestId, true)}>Permitir uma vez</button>
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => props.api.permit(p.sessionId, p.request.requestId, false)}>Negar</button>
                {p.taskId && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.api.openTask(p.taskId!)}>Abrir tarefa</button>}
              </div>
              <details className="hq-desk__details"><summary>Detalhe técnico</summary><pre className="hq-desk__pre">{describeInput(p.request.input)}</pre></details>
            </li>
          ))}
        </ul>
      );
    }
    if (items.counts.bloqueios - items.permissions.length <= 0) return null;
    return (
      <ul className="hq-desk__list">
        {items.stalled.map(s => (
          <li key={s.key} className="hq-desk__card hq-desk__card--warn">
            <div className="hq-desk__head"><strong>{s.title}</strong></div>
            <p>{s.reason}</p>
            <p className="hq-dim">Próximo passo: {s.next}</p>
            {s.open && <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm" onClick={s.open}>Abrir a peça</button></div>}
          </li>
        ))}
        {items.needs.map(n => (
          <li key={n.id} className="hq-desk__card hq-desk__card--warn">
            <div className="hq-desk__head"><strong>Falta alguém apto ou a tarefa não entrou na fila</strong>{n.meetingTitle && <span className="hq-dim">reunião "{n.meetingTitle}"</span>}</div>
            <p>{n.text}</p>
            <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => void props.api.resolveNeed(n.id)}>Resolvido</button></div>
          </li>
        ))}
        {items.failed.map(t => (
          <li key={t.id} className="hq-desk__card hq-desk__card--bad">
            <div className="hq-desk__head"><strong>{emp(t.employeeId)}: a tarefa parou</strong><TeamTag task={t} /><span className="hq-dim">{when(t.finishedAt ?? t.createdAt)}</span></div>
            <p>{firstLine(t.prompt)}</p>
            <p className="hq-dim">O que já foi feito ficou salvo na pasta.</p>
            <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm" onClick={() => props.api.openTask(t.id)}>Abrir tarefa</button></div>
            <details className="hq-desk__details"><summary>Detalhe técnico</summary><p className="hq-dim">{t.errors[t.errors.length - 1] ?? t.status}</p></details>
          </li>
        ))}
        {items.held.map(t => (
          <li key={t.id} className="hq-desk__card">
            <div className="hq-desk__head"><strong>{emp(t.employeeId)}: tarefa em espera</strong></div>
            <p>{firstLine(t.prompt)}</p>
            <p className="hq-dim">{t.heldReason}</p>
            <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm" onClick={() => props.api.openTask(t.id)}>Abrir tarefa</button></div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="hq-desk" aria-label="Caixa de entrada">
      <div className="hq-tabs" role="tablist">
        {(['entregas', 'perguntas', 'bloqueios'] as Tab[]).map(t => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`hq-tab${tab === t ? ' hq-tab--on' : ''}`} onClick={() => setTab(t)}>
            {t === 'entregas' ? 'Entregas' : t === 'perguntas' ? 'Perguntas' : 'Bloqueios'}
            {items.counts[t] > 0 && <span className={`hq-desk__count${t !== 'entregas' ? ' hq-desk__count--warn' : ''}`}>{items.counts[t]}</span>}
          </button>
        ))}
      </div>
      {tab === 'entregas' && (series.length === 0
        ? <p className="hq-empty">Nenhuma entrega de tarefa distribuída em reunião. As peças do calendário que esperam você ficam logo abaixo, em "Entregas para revisar", com o botão Abrir.</p>
        : <ul className="hq-desk__list">{series.map(v => <DeliveryCard key={v[0].id} d={v[0]} older={v.slice(1)} who={emp(v[0].employeeId)} task={taskOf(v[0].adjustTaskId)} api={props.api} origin={taskOf(v[0].taskId)} />)}</ul>)}
      {tab === 'entregas' && items.hiddenDeliveries.length > 0 && props.api.hide && (
        <details className="hq-desk__older">
          <summary className="hq-dim">Entregas de reunião arquivadas ou na lixeira ({new Set(items.hiddenDeliveries.map(d => d.rootTaskId)).size})</summary>
          <ul>{[...new Map(items.hiddenDeliveries.map(d => [d.rootTaskId, d])).values()].map(d => <li key={d.rootTaskId}>{d.title} <span className="hq-dim">· {(props.hidden ?? []).find(h => h.key === `desk:${d.rootTaskId}`)?.state}</span> <button type="button" className="hq-linkbtn" onClick={() => void props.api.hide!(`desk:${d.rootTaskId}`, null, d.title)}>Restaurar</button></li>)}</ul>
        </details>
      )}
      {tab === 'perguntas' && (items.questions.length === 0
        ? <p className="hq-empty">Nenhum funcionário esperando resposta sua.</p>
        : <ul className="hq-desk__list">{items.questions.map(q => <QuestionCard key={q.request.requestId} q={q} who={sessionEmp(q.sessionId)} task={taskOf(q.taskId)} api={props.api} />)}</ul>)}
      {tab === 'bloqueios' && (items.counts.bloqueios === 0
        ? <p className="hq-empty">Nada travado: sem pedido de autorização, falha, peça parada ou falta de alguém apto.</p>
        : (
          <ul className="hq-desk__list">
            {items.permissions.map(p => (
              <li key={p.request.requestId} className="hq-desk__card hq-desk__card--warn">
                <div className="hq-desk__head"><strong>{sessionEmp(p.sessionId)} pede autorização</strong><span className="hq-dim">{p.request.toolName}</span></div>
                {taskOf(p.taskId) && <p className="hq-dim">Tarefa: {firstLine(taskOf(p.taskId)!.prompt)}</p>}
                <pre className="hq-desk__pre">{describeInput(p.request.input)}</pre>
                <div className="hq-actions">
                  <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => props.api.permit(p.sessionId, p.request.requestId, true)}>Permitir uma vez</button>
                  <button type="button" className="hq-btn hq-btn--sm" onClick={() => props.api.permit(p.sessionId, p.request.requestId, false)}>Negar</button>
                  {p.taskId && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.api.openTask(p.taskId!)}>Abrir tarefa</button>}
                </div>
              </li>
            ))}
            {items.stalled.map(s => (
              <li key={s.key} className="hq-desk__card hq-desk__card--warn">
                <div className="hq-desk__head"><strong>Peça parada: {s.title}</strong></div>
                <p>{s.reason}</p>
                <p className="hq-dim">Próximo passo: {s.next}</p>
                {s.open && <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm" onClick={s.open}>Abrir a peça</button></div>}
              </li>
            ))}
            {items.needs.map(n => (
              <li key={n.id} className="hq-desk__card hq-desk__card--warn">
                <div className="hq-desk__head"><strong>Falta alguém apto ou a tarefa não entrou na fila</strong>{n.meetingTitle && <span className="hq-dim">reunião "{n.meetingTitle}"</span>}</div>
                <p>{n.text}</p>
                <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => void props.api.resolveNeed(n.id)}>Resolvido</button></div>
              </li>
            ))}
            {items.failed.map(t => (
              <li key={t.id} className="hq-desk__card hq-desk__card--bad">
                <div className="hq-desk__head"><strong>{emp(t.employeeId)}: tarefa falhou</strong><span className="hq-dim">{when(t.finishedAt ?? t.createdAt)}</span></div>
                <p>{firstLine(t.prompt)}</p>
                <p className="hq-dim">{t.errors[t.errors.length - 1] ?? t.status}. O que já foi feito ficou salvo na pasta.</p>
                <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm" onClick={() => props.api.openTask(t.id)}>Abrir tarefa</button></div>
              </li>
            ))}
            {items.held.map(t => (
              <li key={t.id} className="hq-desk__card">
                <div className="hq-desk__head"><strong>{emp(t.employeeId)}: tarefa em espera</strong></div>
                <p>{firstLine(t.prompt)}</p>
                <p className="hq-dim">{t.heldReason}</p>
                <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm" onClick={() => props.api.openTask(t.id)}>Abrir tarefa</button></div>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

export function describeInput(input: Record<string, unknown>): string {
  for (const k of ['command', 'url', 'file_path', 'path', 'query']) if (typeof input[k] === 'string') return String(input[k]).slice(0, 400);
  try { return JSON.stringify(input).slice(0, 400); } catch { return ''; }
}

function DeliveryCard({ d, older, who, task, api, origin }: { d: DeskDelivery; older: DeskDelivery[]; who: string; task: Task | null; api: DeskApi; origin?: Task | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [note, setNote] = useState('');
  const [remember, setRemember] = useState('');
  const [full, setFull] = useState(false);
  const known = api.knowledgeOf?.(d.taskId) ?? [];
  const team = isTeamId(d.profileId) ? d.profileId : teamOfSlot(d.slot);
  const bad = (d.checks ?? []).filter(c => c.ok === false);
  const [thumbs, setThumbs] = useState<{ file: string; src: string }[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: { file: string; src: string }[] = [];
      for (const f of d.files.filter(f => IMG.test(f)).slice(0, 6)) { const src = await api.image(f).catch(() => null); if (src) out.push({ file: f, src }); }
      if (alive) setThumbs(out);
    })();
    return () => { alive = false; };
  }, [d.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); setError(null); try { await fn(); return true; } catch (err) { setError(String((err as Error).message ?? err)); return false; } finally { setBusy(null); } };
  const slot = d.slot ? SOCIAL_SLOTS.find(s => s.slot === d.slot)?.label ?? d.slot : null;
  const summary = d.summary.replace(/^\s*(Arquivo:.*|[-*]\s*\[[ xX✓]\].*)$/gm, '').trim();
  const adjustRunning = d.status === 'ajustes' && task && !['done', 'error', 'lost', 'interrupted'].includes(task.status);
  const show = (files: string[], index = 0, title = d.title) => api.view({ title, files, index, meta: `${who}${slot ? ` · ${slot}` : ''} · v${d.version} · ${when(d.createdAt)}` });
  return (
    <li className={`hq-desk__card hq-desk__card--${d.status}`}>
      <div className="hq-desk__head">
        <strong>{d.title}</strong>
        <TeamTag task={origin} />
        <span className="hq-tag hq-tag--xs">v{d.version}</span>
        <span className={`hq-desk__st hq-desk__st--${d.status}`}>{DESK_STATUS_LABEL[d.status]}</span>
        {bad.length > 0 && <span className="hq-desk__st hq-desk__st--incompleta" title={bad.map(c => `${c.label}: ${c.detail ?? ''}`).join('\n')}>entrega incompleta</span>}
      </div>
      {d.request && d.source === 'pedido' && <p className="hq-dim hq-desk__req" title={d.request}>Pedido: {d.request.replace(/\s+/g, ' ').slice(0, 160)}</p>}
      <p className="hq-dim">{who}{d.meetingTitle ? ` · reunião "${d.meetingTitle}"` : ''}{slot ? ` · ${slot}` : ''} · {when(d.createdAt)}</p>
      {summary && <p className={`hq-desk__sum${full ? ' hq-desk__sum--full' : ''}`} onClick={() => setFull(!full)} title={full ? 'Recolher' : 'Ver tudo'}>{summary}</p>}
      {thumbs.length > 0 && <div className="hq-ct-slides">{thumbs.map(t => <button key={t.file} type="button" className="hq-ct-slide" onClick={() => show(d.files, Math.max(0, d.files.indexOf(t.file)))} title={base(t.file)}><img src={t.src} alt={base(t.file)} /></button>)}</div>}
      {d.files.length > 0 && <ul className="hq-desk__files">{d.files.map((f, k) => <li key={f}><button type="button" className="hq-linkbtn" onClick={() => show(d.files, k)} title={f}>{base(f)}</button></li>)}</ul>}
      {d.links.length > 0 && <ul className="hq-desk__files">{d.links.map(u => <li key={u}><button type="button" className="hq-linkbtn" onClick={() => api.openUrl(u)} title={u}>{u.replace(/^https?:\/\//, '').slice(0, 60)}</button></li>)}</ul>}
      {d.criteria.length > 0 && (
        <ul className="hq-ct-checks" aria-label="Critérios">
          {d.criteria.map((c, i) => <li key={i} className={c.ok === true ? 'hq-ct-check--ok' : c.ok === false ? 'hq-ct-check--bad' : ''}>{c.ok === true ? '✓' : c.ok === false ? '✗' : '?'} {c.text}{c.note ? <span className="hq-dim"> · {c.note}</span> : c.ok === null ? <span className="hq-dim"> · não informado, confira</span> : null}</li>)}
        </ul>
      )}
      {(d.checks ?? []).length > 0 && (
        <ul className="hq-ct-checks" aria-label="O que a HQ conferiu">
          {d.checks!.map((c, i) => <li key={i} className={c.ok === true ? 'hq-ct-check--ok' : c.ok === false ? 'hq-ct-check--bad' : ''}>{c.ok === true ? '✓' : c.ok === false ? '✗' : '?'} {c.label}{c.detail ? <span className="hq-dim"> · {c.detail}</span> : null}</li>)}
        </ul>
      )}
      {known.length > 0 && (
        <details className="hq-desk__older">
          <summary className="hq-dim">Conhecimento da equipe usado ({known.length})</summary>
          <ul>{known.map(k => <li key={k.knowledgeId}>{KNOWLEDGE_KIND_LABEL[k.kind]} · v{k.version} · {k.title}</li>)}</ul>
        </details>
      )}
      {d.status === 'ajustes' && <p className="hq-dim">Ajuste pedido: "{d.note}". {adjustRunning ? `${who} está refazendo; a versão ${d.version + 1} chega aqui quando terminar.` : task && task.status !== 'done' ? `A tarefa de ajuste terminou como ${task.status}.` : ''}</p>}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      {adjusting ? (
        <div className="hq-desk__adjust">
          <textarea className="hq-input" rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder={`O que ${who} deve ajustar (a versão ${d.version} fica guardada)`} aria-label="Observação do ajuste" />
          <div className="hq-actions">
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={!note.trim() || busy !== null} onClick={() => void run('adjust', () => api.adjust(d.id, note.trim(), remember ? (remember === 'empresa' ? { type: 'empresa', id: null } : remember === 'pessoa' ? { type: 'funcionario', id: d.employeeId } : { type: 'equipe', id: remember }) : null)).then(ok => { if (ok) { setAdjusting(false); setRemember(''); } })}>{busy === 'adjust' ? 'Enviando…' : `Devolver para ${who}`}</button>
            <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setAdjusting(false)}>Cancelar</button>
          </div>
          <label className="hq-desk__remember" title="Sem marcar, a correção vale só para esta entrega">
            <span>Usar nos próximos trabalhos:</span>
            <select className="hq-select" value={remember} onChange={e => setRemember(e.target.value)} aria-label="Usar nos próximos trabalhos">
              <option value="">não, só nesta entrega</option>
              {team && <option value={team}>sim, na {teamDef(team).label}</option>}
              {d.employeeId && <option value="pessoa">sim, só para {who}</option>}
              <option value="empresa">sim, na empresa toda</option>
            </select>
          </label>
        </div>
      ) : (
        <div className="hq-actions">
          <button type="button" className="hq-btn hq-btn--sm" onClick={() => (d.files.length ? show(d.files) : api.openTask(d.taskId))}>Abrir</button>
          {d.status !== 'aprovada' && d.status !== 'ajustes' && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null} title="Aprova esta entrega. Não publica nada: publicação tem aprovação própria." onClick={() => void run('approve', () => api.approve(d.id))}>Aprovar</button>}
          {d.status !== 'ajustes' && <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} onClick={() => setAdjusting(true)}>Pedir ajuste</button>}
          <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => api.openTask(d.taskId)}>Abrir tarefa</button>
          {api.hide && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" title="Tira da mesa; a tarefa e os arquivos ficam" onClick={() => void run('hide', () => api.hide!(`desk:${d.rootTaskId}`, 'arquivada', d.title))}>Arquivar</button>}
          {api.hide && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" title="Lixeira restaurável; a tarefa e os arquivos ficam" onClick={() => void run('hide', () => api.hide!(`desk:${d.rootTaskId}`, 'lixeira', d.title))}>Excluir</button>}
        </div>
      )}
      {older.length > 0 && (
        <details className="hq-desk__older">
          <summary className="hq-dim">Ver versões ({older.length} anterior{older.length === 1 ? '' : 'es'})</summary>
          <ul>{older.map(o => <li key={o.id}>v{o.version} · {DESK_STATUS_LABEL[o.status]}{o.note ? ` · ajuste: "${o.note}"` : ''} · {o.files.map((f, k) => <button key={f} type="button" className="hq-linkbtn" onClick={() => show(o.files, k, `${d.title} (v${o.version})`)}>{base(f)}</button>)}</li>)}</ul>
        </details>
      )}
    </li>
  );
}

export function QuestionCard({ q, who, task, api }: { q: PendingPermission; who: string; task: Task | null; api: DeskApi }) {
  const questions = q.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string>>({});
  const complete = questions.length > 0 && questions.every(x => picked[x.question]?.trim());
  return (
    <li className="hq-desk__card hq-desk__card--warn">
      <div className="hq-desk__head"><strong>{who} pergunta</strong><TeamTag task={task} />{task && <span className="hq-dim">{firstLine(task.prompt)}</span>}</div>
      {questions.map(x => (
        <div key={x.question} className="hq-desk__q">
          <p>{x.question}</p>
          <div className="hq-actions">
            {x.options.map(o => <button key={o.label} type="button" className={`hq-btn hq-btn--sm${picked[x.question] === o.label ? ' hq-btn--primary' : ''}`} title={o.description} onClick={() => setPicked(p => ({ ...p, [x.question]: o.label }))}>{o.label}</button>)}
          </div>
          <input className="hq-input hq-input--sm" placeholder="ou responda com suas palavras" value={x.options.some(o => o.label === picked[x.question]) ? '' : picked[x.question] ?? ''} onChange={e => setPicked(p => ({ ...p, [x.question]: e.target.value }))} aria-label="Resposta" />
        </div>
      ))}
      <div className="hq-actions">
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={!complete} onClick={() => api.answer(q.sessionId, q.request.requestId, picked)}>Responder a {who}</button>
        {q.taskId && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => api.openTask(q.taskId!)}>Abrir tarefa</button>}
      </div>
    </li>
  );
}
