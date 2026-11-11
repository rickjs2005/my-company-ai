// "Equipe agora" (quem está fazendo o quê, de verdade), a conversa particular com cada funcionário, os pedidos à gerente com o
// plano dela e as etapas de cada peça (08/11/2026).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem, ContentItem, ContentRequest, ContentState, Employee, Session, Task } from '@milweb-hq/protocol';
import { PIECE_STEP_LABEL } from '@milweb-hq/protocol';
import type { ContentApi } from './ContentViews';
import { ago } from './homeBoard';
import { MdLite } from './MdLite';
import { dmMessages, dmStatus, teamNow, type NowState } from './teamNowBoard';

const STATE_LABEL: Record<NowState, string> = { fazendo: 'fazendo', espera: 'espera você', fila: 'na fila', livre: 'livre' };

export function TeamNowStrip({ employees, tasks, sessions, content, onTalk, onSteer }: { employees: Employee[]; tasks: Task[]; sessions: Session[]; content: ContentState | null; onTalk(id: string): void; onSteer?(sessionId: string, text: string): Promise<boolean> }) {
  const rows = useMemo(() => teamNow(employees, tasks, sessions, content), [employees, tasks, sessions, content]);
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return null;
  const busy = rows.filter(r => r.state === 'fazendo').length;
  const queued = rows.reduce((n, r) => n + r.queued, 0);
  return (
    <section className="hq-team-now" aria-label="Equipe agora">
      <h3 className="hq-label">Equipe agora <span className="hq-dim">· {busy ? `${busy} trabalhando` : 'ninguém rodando agora'}{queued ? ` · ${queued} na fila` : ''}</span></h3>
      <ul className="hq-team-now__list">
        {rows.map(r => (
          <li key={r.id} className={`hq-team-now__row hq-team-now__row--${r.state}`}>
            <span className="hq-team-now__dot" aria-hidden="true" />
            <span className="hq-team-now__who"><b>{r.name}</b><span className="hq-dim">{r.role}</span></span>
            <span className="hq-team-now__what">
              <span className={`hq-tag hq-tag--xs hq-team-now__st--${r.state}`}>{STATE_LABEL[r.state]}</span>
              {r.what ? <span title={r.what}>{r.what}{r.since ? <span className="hq-dim"> · {ago(r.since)}</span> : null}</span> : <span className="hq-dim">sem tarefa agora</span>}
              {r.state === 'fazendo' && r.queued > 0 && <span className="hq-dim"> · mais {r.queued} na fila</span>}
              {r.state === 'fazendo' && r.detail && <span className="hq-team-now__detail hq-dim">agora: {r.detail}</span>}
            </span>
            {r.state === 'fazendo' && r.sessionId && onSteer && (
              <button type="button" className="hq-btn hq-btn--sm" aria-expanded={open === r.id} onClick={() => setOpen(o => (o === r.id ? null : r.id))} title={`Fale com ${r.name} no meio da tarefa, sem interromper`}>Ajustar</button>
            )}
            <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => onTalk(r.id)} title={`Conversa particular com ${r.name}: só entre vocês dois`}>Conversar</button>
            {open === r.id && r.sessionId && onSteer && <SteerBox name={r.name} sessionId={r.sessionId} onSteer={onSteer} onDone={() => setOpen(null)} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Campo "Ajustar": a mensagem entra no próximo passo da tarefa em andamento; se ela já acabou, vai para a fila dele. */
function SteerBox({ name, sessionId, onSteer, onDone }: { name: string; sessionId: string; onSteer(sessionId: string, text: string): Promise<boolean>; onDone(): void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const send = async () => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true); setNote(null);
    try {
      const delivered = await onSteer(sessionId, t);
      setText('');
      setNote(delivered ? `${name} recebe no próximo passo, sem parar o que está fazendo.` : `A tarefa já tinha acabado: o recado foi para a fila de ${name}.`);
      window.setTimeout(onDone, 2500);
    } catch (err) { setNote(`Não foi: ${(err as Error).message}`); }
    finally { setBusy(false); }
  };
  return (
    <form className="hq-team-now__steer" onSubmit={e => { e.preventDefault(); void send(); }}>
      <input ref={ref} className="hq-input" value={text} onChange={e => setText(e.target.value)} placeholder={`Fale com ${name} sem interromper (ex.: põe a legenda embaixo)`} aria-label={`Mensagem para ${name} no meio da tarefa`} maxLength={2000} />
      <button type="submit" className="hq-btn hq-btn--sm hq-btn--primary" disabled={!text.trim() || busy}>{busy ? 'Enviando…' : 'Enviar'}</button>
      {note && <span className="hq-dim" role="status">{note}</span>}
    </form>
  );
}

export interface DmState { employeeId: string; sessionId: string | null; error: string | null }

export function DmPanel({ dm, employees, tasks, items, streaming, onSend, onClose }: {
  dm: DmState; employees: Employee[]; tasks: Task[]; items: ChatItem[]; streaming: string; onSend(text: string): Promise<unknown>; onClose(): void;
}) {
  const e = employees.find(x => x.id === dm.employeeId) ?? null;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const msgs = useMemo(() => dmMessages(items), [items]);
  const status = dmStatus(tasks, dm.sessionId, e?.name ?? 'O funcionário');
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, streaming]);
  const send = async () => {
    const t = text.trim(); if (!t || !dm.sessionId || busy) return;
    setBusy(true); setErr(null);
    try { await onSend(t); setText(''); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <aside className="hq-dm" role="dialog" aria-label={`Conversa particular com ${e?.name ?? 'funcionário'}`}>
      <header className="hq-dm__head">
        <div><strong>{e?.name ?? 'Funcionário'}</strong> <span className="hq-dim">{e?.role}</span><p className="hq-dim hq-dm__sub">Conversa particular: fica só entre vocês dois. Se você pedir um trabalho, vira pedido para a gerente planejar.</p></div>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={onClose} aria-label="Fechar a conversa">Fechar</button>
      </header>
      <div className="hq-dm__msgs">
        {dm.error && <p className="hq-composer__bad" role="alert">{dm.error}</p>}
        {!dm.sessionId && !dm.error && <p className="hq-dim">Abrindo a conversa…</p>}
        {dm.sessionId && msgs.length === 0 && !streaming && <p className="hq-dim">Comece a conversa. Ex.: "O que você está fazendo agora?", "Você já sabe editar no estilo de trailer?"</p>}
        {msgs.map(m => (
          <div key={m.id} className={`hq-dm__msg hq-dm__msg--${m.from}`}>
            {m.from === 'func' ? <MdLite text={m.text || '(sem texto)'} /> : <p>{m.text}</p>}
            {m.request && <p className="hq-dm__req">Virou pedido para a gerente planejar: "{m.request.slice(0, 220)}{m.request.length > 220 ? '…' : ''}". Acompanhe em "Pedidos à equipe".</p>}
            <span className="hq-dim hq-dm__when">{new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}{m.tools ? ` · consultou ${m.tools} arquivo(s)` : ''}</span>
          </div>
        ))}
        {streaming && <div className="hq-dm__msg hq-dm__msg--func hq-dm__msg--live"><MdLite text={streaming} /></div>}
        <div ref={endRef} />
      </div>
      {status && <p className="hq-dim hq-dm__status" role="status">{status}</p>}
      <form className="hq-dm__form" onSubmit={ev => { ev.preventDefault(); void send(); }}>
        <textarea className="hq-input" rows={2} value={text} onChange={ev => setText(ev.target.value)} placeholder={`Mensagem para ${e?.name ?? 'o funcionário'} (Enter envia, Shift+Enter quebra a linha)`}
          onKeyDown={ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void send(); } }} disabled={!dm.sessionId} />
        <button type="submit" className="hq-btn hq-btn--primary" disabled={!dm.sessionId || !text.trim() || busy}>{busy ? 'Enviando…' : 'Enviar'}</button>
      </form>
      {err && <p className="hq-composer__bad" role="alert">{err}</p>}
    </aside>
  );
}

/** Pedidos em texto livre: a gerente planejando, o plano pronto (com as peças e as perguntas) ou o motivo da falha. */
export function PlansPanel({ content, employees, api, tasks = [] }: { content: ContentState | null; employees: Employee[]; api: ContentApi; tasks?: Task[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const plans = (content?.requests ?? []).filter((r): r is ContentRequest & { plan: NonNullable<ContentRequest['plan']> } => Boolean(r.plan) && r.status === 'ativo')
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  if (!plans.length) return null;
  const items = content?.items ?? [];
  return (
    <section className="hq-plans" aria-label="Pedidos à equipe">
      <h3 className="hq-label">Pedidos à equipe</h3>
      <ul className="hq-plans__list">
        {plans.map(r => {
          const p = r.plan; const mine = items.filter(i => p.itemIds.includes(i.id));
          const done = mine.filter(i => (['revisar', 'ajustar'].includes(i.status) && i.review) || ['aprovada', 'agendada', 'publicada'].includes(i.status)).length;
          return (
            <li key={r.id} className={`hq-plans__item hq-plans__item--${p.status}`}>
              <p className="hq-plans__ask">"{r.note ?? r.title}"</p>
              {p.status === 'planejando' && (() => {
                const t = tasks.find(x => x.id === content?.rounds.find(rd => rd.id === p.roundId)?.taskId);
                const doing = t?.status === 'running' ? 'está planejando' : t?.status === 'waiting_permission' || t?.status === 'waiting_answer' ? 'espera uma resposta sua para planejar' : 'vai planejar (está na fila)';
                return <p>{p.managerName ?? 'A gerente'} {doing}{r.createdAt ? ` · pedido ${ago(r.createdAt)}` : ''}. As peças aparecem aqui quando o plano sair.</p>;
              })()}
              {p.status === 'falhou' && (
                <div className="hq-vcard__block" role="alert">
                  <p><strong>O plano não saiu:</strong> {p.error ?? 'veja a conversa da gerente'}</p>
                  <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null} onClick={() => { setBusy(r.id); setErr(null); void api.managerAsk(r.note ?? r.title).catch(x => setErr((x as Error).message)).finally(() => setBusy(null)); }}>{busy === r.id ? 'Enviando…' : 'Pedir de novo'}</button>
                </div>
              )}
              {p.status === 'pronto' && (
                <>
                  <p><span className="hq-dim">Plano de {p.managerName ?? 'gerente'}:</span> {p.summary}</p>
                  <p className="hq-dim">{mine.length} peça(s){mine.length ? ` · ${done} esperando você ou já aprovada(s)` : ''}</p>
                  {mine.length > 0 && <ul className="hq-plans__pieces">{mine.map(i => <li key={i.id}><button type="button" className="hq-linkbtn" onClick={() => api.openPiece(i)}>{i.title}</button> <span className="hq-dim">· {i.format} · {stepLine(i, employees)}</span></li>)}</ul>}
                  {p.questions.length > 0 && <div className="hq-plans__q"><b>Perguntas para você</b> (a equipe seguiu com a suposição mais simples):<ul>{p.questions.map((q, k) => <li key={k}>{q}</li>)}</ul></div>}
                  {p.left.length > 0 && <details><summary className="hq-dim">Ficou de fora ({p.left.length})</summary><ul>{p.left.map((q, k) => <li key={k}>{q}</li>)}</ul></details>}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {err && <p className="hq-composer__bad" role="alert">{err}</p>}
    </section>
  );
}

/** Onde a peça está na linha de produção, em uma linha. */
export function stepLine(i: ContentItem, employees: Employee[]): string {
  const steps = i.pipeline?.steps ?? [];
  const doing = steps.find(s => s.status === 'fazendo');
  if (doing) return `${PIECE_STEP_LABEL[doing.key]} com ${doing.employeeName ?? 'a equipe'}`;
  const failed = steps.find(s => s.status === 'falhou');
  if (failed) return `${PIECE_STEP_LABEL[failed.key]} não deu certo`;
  const pending = steps.find(s => s.status === 'pendente');
  if (pending) return `${PIECE_STEP_LABEL[pending.key]} na fila`;
  if (i.status === 'em_producao') return `Produção com ${employees.find(e => e.id === i.ownerId)?.name ?? 'a equipe'}`;
  if (i.status === 'revisar') return i.review ? 'pronta para você' : 'Revisão do Otto';
  if (i.status === 'ajustar') return i.reviewTaskId && !i.review ? 'Revisão do Otto' : 'espera a sua decisão (o revisor pediu ajuste)';
  if (i.status === 'parcial') return 'entrega parcial';
  if (i.status === 'falhou') return 'não deu certo';
  if (i.status === 'aprovada') return 'aprovada';
  if (i.status === 'publicada') return 'publicada';
  return 'planejada';
}

/** Etapas da peça em chips (feito, fazendo, na fila, falhou) com "Tentar a etapa de novo". */
export function PipelineChips({ item, api }: { item: ContentItem; api: ContentApi }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const steps = item.pipeline?.steps ?? [];
  if (!steps.length) return null;
  const failed = steps.find(s => s.status === 'falhou');
  const after = ['producao', 'revisao', 'aprovacao'] as const;
  const prodState = item.status === 'em_producao' ? 'fazendo' : ['revisar', 'aprovada', 'agendada', 'publicada'].includes(item.status) ? 'feito' : 'pendente';
  return (
    <div className="hq-steps">
      <ol className="hq-steps__list" aria-label="Etapas da peça">
        {steps.map(s => <li key={s.key} className={`hq-steps__chip hq-steps__chip--${s.status}`} title={s.error ?? s.summary ?? undefined}>{PIECE_STEP_LABEL[s.key]}{s.employeeName ? ` · ${s.employeeName}` : ''}</li>)}
        {after.map(k => <li key={k} className={`hq-steps__chip hq-steps__chip--${k === 'producao' ? prodState : k === 'revisao' ? (item.status === 'revisar' && !item.review ? 'fazendo' : item.review ? 'feito' : 'pendente') : (['aprovada', 'agendada', 'publicada'].includes(item.status) ? 'feito' : 'pendente')}`}>{PIECE_STEP_LABEL[k]}</li>)}
      </ol>
      {failed && (
        <div className="hq-actions">
          <span className="hq-composer__bad">{PIECE_STEP_LABEL[failed.key]}: {failed.error ?? 'não deu certo'}</span>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy} onClick={() => { setBusy(true); setErr(null); void api.stepRetry(item.id).catch(x => setErr((x as Error).message)).finally(() => setBusy(false)); }}>{busy ? 'Enviando…' : 'Tentar a etapa de novo'}</button>
        </div>
      )}
      {err && <p className="hq-composer__bad" role="alert">{err}</p>}
    </div>
  );
}
