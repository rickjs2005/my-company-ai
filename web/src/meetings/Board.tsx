// Quadro da reunião: decisões (só as confirmadas pelo Chefe contam), propostas, divergências/perguntas e próximas ações.
// Cada item: editar, descartar, excluir. Concordância dos modelos não é aprovação: só o Chefe confirma.
import { useMemo, useState } from 'react';
import type { DecisionKind, MeetingDecision } from '@milweb-hq/protocol';
import { IconCheck, IconEdit, IconPlus, IconX } from '../panel/icons';
import type { BoardProps } from './types';
import { DECISION_KINDS, DECISION_KIND_LABELS, errorMessage, groupDecisions } from './helpers';

export function Board({ meeting, decisions, employees, dispatch, onNotice }: BoardProps) {
  const groups = useMemo(() => groupDecisions(decisions), [decisions]);
  const byParticipant = useMemo(() => new Map(meeting.participants.map(p => [p.id, p])), [meeting.participants]);
  const activeEmployees = useMemo(() => employees.filter(e => !e.archivedAt), [employees]);
  const [addKind, setAddKind] = useState<DecisionKind>('decision');
  const [addText, setAddText] = useState('');
  const [adding, setAdding] = useState(false);
  const ended = meeting.status === 'ended';

  const fail = (err: unknown) => onNotice({ level: 'error', text: errorMessage(err) });
  const update = (id: string, patch: Parameters<typeof groupDecisions>[0][number] extends infer D ? Partial<Pick<D & MeetingDecision, 'kind' | 'text' | 'confirmed' | 'dismissed' | 'assigneeEmployeeId'>> : never) =>
    dispatch({ type: 'meeting.decision.update', meetingId: meeting.id, id, patch }).catch(fail);
  const remove = (id: string) => dispatch({ type: 'meeting.decision.delete', meetingId: meeting.id, id }).catch(fail);

  const add = async () => {
    const text = addText.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      await dispatch({ type: 'meeting.decision.add', reqId: '', meetingId: meeting.id, kind: addKind, text });
      setAddText('');
    } catch (err) { fail(err); } finally { setAdding(false); }
  };

  const proposer = (d: MeetingDecision) => (d.participantId ? byParticipant.get(d.participantId)?.name ?? 'participante removido' : 'Chefe');

  // Função de render (não um componente novo a cada render): o tipo do elemento é sempre BoardItem, então o estado de edição sobrevive aos re-renders.
  const item = (d: MeetingDecision, showAssignee?: boolean) => (
    <BoardItem key={d.id} d={d} proposer={proposer(d)} employees={activeEmployees} showAssignee={showAssignee} ended={ended}
      onUpdate={patch => update(d.id, patch)} onRemove={() => remove(d.id)} />
  );

  return (
    <div className="hq-meet-board">
      <p className="hq-view__note">Concordância dos modelos não é aprovação: só o Chefe confirma.</p>

      <Group title="Decisões" count={groups.decisions.length + groups.pending.length}>
        {groups.decisions.map(d => item(d))}
        {groups.pending.map(d => (
          <div key={d.id} className="hq-meet-pending">
            {item(d)}
            <div className="hq-meet-pending__bar">
              <span className="hq-tag hq-tag--xs hq-tag--warn">aguardando confirmação do Chefe</span>
              {!ended && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => update(d.id, { confirmed: true })}><IconCheck size={12} /> Confirmar</button>}
            </div>
          </div>
        ))}
        {groups.decisions.length + groups.pending.length === 0 && <div className="hq-dim hq-meet-group__empty">Nenhuma decisão registrada.</div>}
      </Group>

      <Group title="Propostas" count={groups.proposals.length}>
        {groups.proposals.map(d => item(d))}
        {groups.proposals.length === 0 && <div className="hq-dim hq-meet-group__empty">Nenhuma proposta.</div>}
      </Group>

      <Group title="Divergências e perguntas" count={groups.open.length}>
        {groups.open.map(d => item(d))}
        {groups.open.length === 0 && <div className="hq-dim hq-meet-group__empty">Nada em aberto.</div>}
      </Group>

      <Group title="Próximas ações" count={groups.actions.length}>
        {groups.actions.map(d => item(d, true))}
        {groups.actions.length === 0 && <div className="hq-dim hq-meet-group__empty">Nenhuma ação.</div>}
      </Group>

      {groups.dismissed.length > 0 && (
        <Group title="Descartados" count={groups.dismissed.length} muted>
          {groups.dismissed.map(d => (
            <div key={d.id} className="hq-meet-bitem hq-meet-bitem--dismissed">
              <span className="hq-tag hq-tag--xs">{DECISION_KIND_LABELS[d.kind]}</span>
              <span className="hq-meet-bitem__text">{d.text}</span>
              {!ended && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => update(d.id, { dismissed: false })}>Restaurar</button>}
              <button type="button" className="hq-iconbtn hq-iconbtn--xs" aria-label="Excluir" title="Excluir de vez" onClick={() => remove(d.id)}><IconX size={12} /></button>
            </div>
          ))}
        </Group>
      )}

      {!ended && (
        <form className="hq-meet-add" onSubmit={e => { e.preventDefault(); void add(); }}>
          <select className="hq-input hq-input--sm" value={addKind} onChange={e => setAddKind(e.target.value as DecisionKind)} aria-label="Tipo do item">
            {DECISION_KINDS.map(k => <option key={k} value={k}>{DECISION_KIND_LABELS[k]}</option>)}
          </select>
          <input className="hq-input hq-input--sm" value={addText} onChange={e => setAddText(e.target.value)} placeholder="Texto do item" aria-label="Texto do item" />
          <button type="submit" className="hq-btn hq-btn--sm" disabled={!addText.trim() || adding}><IconPlus size={12} /> Adicionar</button>
        </form>
      )}
    </div>
  );
}

function Group({ title, count, muted, children }: { title: string; count: number; muted?: boolean; children: React.ReactNode }) {
  return (
    <section className={`hq-meet-group${muted ? ' hq-meet-group--muted' : ''}`}>
      <h4 className="hq-meet-group__title">{title} <span className="hq-dim">{count}</span></h4>
      <div className="hq-meet-group__items">{children}</div>
    </section>
  );
}

function BoardItem({ d, proposer, employees, showAssignee, ended, onUpdate, onRemove }: {
  d: MeetingDecision; proposer: string; employees: BoardProps['employees']; showAssignee?: boolean; ended: boolean;
  onUpdate(patch: Partial<Pick<MeetingDecision, 'kind' | 'text' | 'confirmed' | 'dismissed' | 'assigneeEmployeeId'>>): void; onRemove(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.text);
  const save = () => { const t = draft.trim(); if (t && t !== d.text) onUpdate({ text: t }); setEditing(false); };
  const assignee = d.assigneeEmployeeId ? employees.find(e => e.id === d.assigneeEmployeeId) : null;
  return (
    <div className={`hq-meet-bitem${d.kind === 'decision' && d.confirmed ? ' hq-meet-bitem--confirmed' : ''}`}>
      {editing ? (
        <textarea className="hq-input hq-textarea hq-meet-bitem__edit" value={draft} autoFocus onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { setDraft(d.text); setEditing(false); } }} />
      ) : (
        <span className="hq-meet-bitem__text">{d.text}</span>
      )}
      <span className="hq-meet-bitem__meta hq-dim">
        {d.kind === 'decision' && d.confirmed ? 'confirmada pelo Chefe' : `por ${proposer}`}
        {d.kind === 'divergence' && ' · divergência'}
        {d.kind === 'question' && ' · pergunta'}
        {showAssignee && !ended && (
          <select className="hq-input hq-input--sm hq-meet-bitem__assignee" value={d.assigneeEmployeeId ?? ''} onChange={e => onUpdate({ assigneeEmployeeId: e.target.value || null })} aria-label="Responsável">
            <option value="">Sem responsável</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
        {showAssignee && ended && <span> · {assignee ? `responsável: ${assignee.name}` : 'sem responsável'}</span>}
      </span>
      {!ended && (
        <span className="hq-meet-bitem__actions">
          {editing ? (
            <>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={save}>Salvar</button>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => { setDraft(d.text); setEditing(false); }}>Cancelar</button>
            </>
          ) : (
            <>
              <button type="button" className="hq-iconbtn hq-iconbtn--xs" aria-label="Editar" title="Editar" onClick={() => { setDraft(d.text); setEditing(true); }}><IconEdit size={12} /></button>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" title="Vai para a ata como descartado" onClick={() => onUpdate({ dismissed: true })}>Descartar</button>
              <button type="button" className="hq-iconbtn hq-iconbtn--xs" aria-label="Excluir" title="Excluir" onClick={onRemove}><IconX size={12} /></button>
            </>
          )}
        </span>
      )}
    </div>
  );
}
