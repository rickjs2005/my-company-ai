// Painel da mesa de uma equipe (08/11): integrantes, resumo real, tarefas, referências, calendário e entregas só desta equipe,
// com filtro por canal (Aurora: Instagram, Threads ou os dois). "Nova tarefa" e "Reunir equipe" já saem com o contexto dela.
import { useMemo, useState } from 'react';
import type { ContentItem, Employee, PendingPermission, RadarItem, Task } from '@milweb-hq/protocol';
import { CHANNEL_LABEL, CONTENT_ITEM_STATUS_LABEL, teamDef, type SocialSlotId, type TeamId } from '@milweb-hq/protocol';
import { IconX } from '../../panel/icons';
import { displayPrompt } from './socialHelpers';
import { summaryText, teamItems, teamMembers, teamRefs, teamSummary, teamTasks, type ChannelFilter } from './teamBoard';

const TASK_STATUS: Record<string, string> = { queued: 'na fila', running: 'em execução', waiting_answer: 'esperando você', waiting_permission: 'esperando permissão', done: 'terminada', error: 'falhou', interrupted: 'interrompida', lost: 'perdida' };
const short = (t: string, n = 90) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const channel = (slot: string | null | undefined) => (slot ? CHANNEL_LABEL[slot as SocialSlotId] ?? slot : 'sem canal');

export interface TeamPanelProps {
  team: TeamId;
  roomId: string | null;
  employees: Employee[];
  tasks: Task[];
  items: ContentItem[];
  radar: RadarItem[];
  pending: PendingPermission[];
  onClose(): void;
  /** Escolhe o perfil da equipe no topo e leva ao campo de pedido (o destino só lista os canais da equipe). */
  onNewTask(): void;
  /** Cria a reunião só com quem foi marcado (integrantes da equipe e especialistas convidados). */
  onMeeting(input: { agenda: string; employeeIds: string[] }): Promise<void>;
  /** Referência colada aqui herda a equipe e o canal escolhido. */
  onAddRef(input: { url: string; slot: SocialSlotId; instruction: string | null }): Promise<void>;
  onOpenEmployee(id: string): void;
  onOpenTask(id: string): void;
  onOpenItem?(id: string): void;
  /** Abre o explorador na pasta da equipe (marcas/aurora ou marcas/tuco-dev). */
  onOpenFolder?(): void;
}

export function TeamPanel(p: TeamPanelProps) {
  const def = teamDef(p.team);
  const [ch, setCh] = useState<ChannelFilter>('all');
  const { members, support } = useMemo(() => teamMembers(p.employees, p.team, p.roomId), [p.employees, p.team, p.roomId]);
  const sum = useMemo(() => teamSummary(p.team, { tasks: p.tasks, items: p.items, pending: p.pending }), [p.team, p.tasks, p.items, p.pending]);
  const tasks = useMemo(() => teamTasks(p.tasks, p.team, ch).slice(0, 10), [p.tasks, p.team, ch]);
  const items = useMemo(() => teamItems(p.items, p.team, ch), [p.items, p.team, ch]);
  const refs = useMemo(() => teamRefs(p.radar, p.team, ch).slice(0, 8), [p.radar, p.team, ch]);
  const calendar = items.filter(i => i.date && ['planejada', 'em_producao', 'parcial', 'revisar', 'ajustar', 'aprovada', 'agendada', 'publicacao_pendente'].includes(i.status)).sort((a, b) => `${a.date}${a.time ?? ''}`.localeCompare(`${b.date}${b.time ?? ''}`)).slice(0, 8);
  const deliveries = items.filter(i => ['revisar', 'ajustar', 'aprovada', 'publicada'].includes(i.status)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  const who = (id: string | null | undefined) => (id ? p.employees.find(e => e.id === id)?.name ?? '—' : '—');
  // reunião da equipe: integrantes marcados; especialistas só se convidados
  const [meet, setMeet] = useState<{ agenda: string; ids: Set<string> } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ref, setRef] = useState<{ url: string; slot: SocialSlotId; note: string } | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <aside className="hq-panel hq-panel--room hq-soc-panel hq-soc-panel--wide hq-team" aria-label={def.label} style={{ ['--team' as string]: def.color }}>
      <header className="hq-panel__head hq-team__head">
        <div className="hq-panel__who">
          <div className="hq-panel__names">
            <div className="hq-panel__name">{def.label}<span className="hq-panel__role">{def.slots.map(s => channel(s)).join(' + ')}</span></div>
            <div className="hq-dim hq-team__focus">{def.focus}</div>
          </div>
          <button type="button" className="hq-iconbtn" onClick={p.onClose} aria-label="Fechar painel"><IconX size={16} /></button>
        </div>
        <div className="hq-team__sum" aria-label="Resumo da equipe">
          <span><strong>{sum.running}</strong> em execução</span><span><strong>{sum.queued}</strong> na fila</span><span><strong>{sum.review}</strong> em revisão</span><span className={sum.blocked ? 'is-warn' : ''}><strong>{sum.blocked}</strong> {sum.blocked === 1 ? 'bloqueio' : 'bloqueios'}</span>
        </div>
        {def.slots.length > 1 && (
          <div className="hq-team__chips" role="radiogroup" aria-label="Canal">
            <button type="button" role="radio" aria-checked={ch === 'all'} className={`hq-home-chip${ch === 'all' ? ' is-on' : ''}`} onClick={() => setCh('all')}>Os dois</button>
            {def.slots.map(s => <button key={s} type="button" role="radio" aria-checked={ch === s} className={`hq-home-chip${ch === s ? ' is-on' : ''}`} onClick={() => setCh(s)}>{channel(s).replace(/ Aurora$/, '')}</button>)}
          </div>
        )}
        <div className="hq-actions">
          <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={p.onNewTask}>Nova tarefa</button>
          <button type="button" className="hq-btn hq-btn--sm" onClick={() => { setMsg(null); setMeet({ agenda: '', ids: new Set(members.map(m => m.id)) }); }}>Reunir equipe</button>
          <button type="button" className="hq-btn hq-btn--sm" onClick={() => { setMsg(null); setRef({ url: '', slot: (ch !== 'all' ? ch : def.slots[0]) as SocialSlotId, note: '' }); }}>Adicionar referência</button>
          {p.onOpenFolder && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={p.onOpenFolder} title={`Peças, referências e material da ${def.label}`}>Pasta da equipe</button>}
        </div>
      </header>
      <div className="hq-panel__body hq-panel__body--scroll">
        {msg && <p className={msg.ok ? 'hq-hub-ok' : 'hq-composer__bad'} role="status">{msg.text}</p>}
        {meet && (
          <form className="hq-team__form" onSubmit={async e => {
            e.preventDefault(); if (busy || !meet.ids.size) return;
            setBusy(true); setMsg(null);
            try { await p.onMeeting({ agenda: meet.agenda.trim() || `Reunião da ${def.label}`, employeeIds: [...meet.ids] }); setMeet(null); setMsg({ ok: true, text: 'Reunião criada só com quem você marcou. Ela abriu em Reuniões: pauta, decisões e tarefas ficam registradas lá.' }); }
            catch (err) { setMsg({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
          }}>
            <strong>Reunir a {def.label}</strong>
            <label className="hq-field"><span>Pauta</span><input className="hq-input" value={meet.agenda} onChange={e => setMeet({ ...meet, agenda: e.target.value })} placeholder="Ex.: o que postar na semana" autoFocus /></label>
            <fieldset className="hq-team__people"><legend>Integrantes</legend>
              {members.map(m => <label key={m.id}><input type="checkbox" checked={meet.ids.has(m.id)} onChange={e => { const ids = new Set(meet.ids); if (e.target.checked) ids.add(m.id); else ids.delete(m.id); setMeet({ ...meet, ids }); }} /> {m.name} <span className="hq-dim">· {m.role}</span></label>)}
              {!members.length && <p className="hq-empty">A equipe ainda não tem integrantes.</p>}
            </fieldset>
            {support.length > 0 && <fieldset className="hq-team__people"><legend>Convidar especialista (atende as duas equipes)</legend>
              {support.map(m => <label key={m.id}><input type="checkbox" checked={meet.ids.has(m.id)} onChange={e => { const ids = new Set(meet.ids); if (e.target.checked) ids.add(m.id); else ids.delete(m.id); setMeet({ ...meet, ids }); }} /> {m.name} <span className="hq-dim">· {m.role}</span></label>)}
            </fieldset>}
            <div className="hq-actions"><button type="submit" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy || !meet.ids.size}>{busy ? 'Criando…' : `Criar reunião (${meet.ids.size})`}</button><button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setMeet(null)}>Cancelar</button></div>
          </form>
        )}
        {ref && (
          <form className="hq-team__form" onSubmit={async e => {
            e.preventDefault(); if (busy || !/^https?:\/\//.test(ref.url.trim())) return;
            setBusy(true); setMsg(null);
            try { await p.onAddRef({ url: ref.url.trim(), slot: ref.slot, instruction: ref.note.trim() || null }); setRef(null); setMsg({ ok: true, text: `Referência recebida para ${channel(ref.slot)}: a ${def.label} assiste e propõe a versão dela.` }); }
            catch (err) { setMsg({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
          }}>
            <strong>Referência para a {def.label}</strong>
            <label className="hq-field"><span>Link do vídeo</span><input className="hq-input" value={ref.url} onChange={e => setRef({ ...ref, url: e.target.value })} placeholder="https://…" autoFocus /></label>
            {def.slots.length > 1 && <div className="hq-team__chips" role="radiogroup" aria-label="Canal de destino">{def.slots.map(s => <button key={s} type="button" role="radio" aria-checked={ref.slot === s} className={`hq-home-chip${ref.slot === s ? ' is-on' : ''}`} onClick={() => setRef({ ...ref, slot: s })}>{channel(s)}</button>)}</div>}
            <label className="hq-field"><span>O que você quer (opcional)</span><input className="hq-input" value={ref.note} onChange={e => setRef({ ...ref, note: e.target.value })} /></label>
            <div className="hq-actions"><button type="submit" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy || !/^https?:\/\//.test(ref.url.trim())}>{busy ? 'Enviando…' : 'Mandar para a equipe'}</button><button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setRef(null)}>Cancelar</button></div>
          </form>
        )}

        <section className="hq-section">
          <h3 className="hq-label">Integrantes ({members.length})</h3>
          {members.length ? <ul className="hq-team__list">{members.map((m, i) => <li key={m.id}><button type="button" className="hq-linkbtn" onClick={() => p.onOpenEmployee(m.id)}>{m.name}</button> <span className="hq-dim">· {m.role} · assento {i + 1}</span></li>)}</ul> : <p className="hq-empty">Ninguém nesta equipe: escolha a equipe no cadastro de um funcionário (Equipe → editar).</p>}
          {support.length > 0 && <p className="hq-dim">Apoio às duas equipes: {support.map(m => `${m.name} (${m.role})`).join(', ')}. A tarefa diz de qual equipe é o trabalho.</p>}
        </section>
        <section className="hq-section">
          <h3 className="hq-label">Tarefas ({tasks.length})</h3>
          {tasks.length ? <ul className="hq-team__list">{tasks.map(t => <li key={t.id}><button type="button" className="hq-linkbtn" onClick={() => p.onOpenTask(t.id)}>{short(displayPrompt(t.prompt))}</button> <span className="hq-dim">· {who(t.employeeId)} · {channel(t.destinationId)} · {TASK_STATUS[t.status] ?? t.status}</span></li>)}</ul> : <p className="hq-empty">Nenhuma tarefa desta equipe{ch !== 'all' ? ' neste canal' : ''}.</p>}
        </section>
        <section className="hq-section">
          <h3 className="hq-label">Referências ({refs.length})</h3>
          {refs.length ? <ul className="hq-team__list">{refs.map(r => <li key={r.id}>{short(r.video?.inspection?.title ?? r.subject, 70)} <span className="hq-dim">· {channel(r.video?.slot ?? r.slot)} · {r.video?.stage}</span></li>)}</ul> : <p className="hq-empty">Nenhuma referência desta equipe.</p>}
        </section>
        <section className="hq-section">
          <h3 className="hq-label">Calendário ({calendar.length})</h3>
          {calendar.length ? <ul className="hq-team__list">{calendar.map(i => <li key={i.id}>{p.onOpenItem ? <button type="button" className="hq-linkbtn" onClick={() => p.onOpenItem!(i.id)}>{short(i.title, 70)}</button> : short(i.title, 70)} <span className="hq-dim">· {i.date}{i.time ? ` ${i.time}` : ''} · {channel(i.slot)} · {CONTENT_ITEM_STATUS_LABEL[i.status]}</span></li>)}</ul> : <p className="hq-empty">Nada no calendário desta equipe.</p>}
        </section>
        <section className="hq-section">
          <h3 className="hq-label">Entregas ({deliveries.length})</h3>
          {deliveries.length ? <ul className="hq-team__list">{deliveries.map(i => <li key={i.id}>{p.onOpenItem ? <button type="button" className="hq-linkbtn" onClick={() => p.onOpenItem!(i.id)}>{short(i.title, 70)}</button> : short(i.title, 70)} <span className="hq-dim">· {who(i.ownerId)} · {channel(i.slot)} · {CONTENT_ITEM_STATUS_LABEL[i.status]}</span></li>)}</ul> : <p className="hq-empty">Nenhuma entrega desta equipe ainda.</p>}
        </section>
        <p className="hq-dim">Resumo: {summaryText(sum)}. A fila é uma só para a empresa (limite de execução de Ajustes → Geral); aqui aparece só a parte desta equipe.</p>
      </div>
    </aside>
  );
}
