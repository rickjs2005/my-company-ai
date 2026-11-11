// Criar tarefas reais na fila a partir do quadro: cada linha revisável (título, funcionário, projeto, instruções,
// "criar sem iniciar"). Itens já criados aparecem como "Criada" e não são reenviados (idempotente por item).
import { useEffect, useMemo, useState } from 'react';
import type { MeetingTaskItem } from '@milweb-hq/protocol';
import { Field, Modal } from '../panel/dialogs/Modal';
import type { CreateTasksDialogProps } from './types';
import { errorMessage, proposeTaskItems, type ProposedTask } from './helpers';

interface Row extends ProposedTask { key: string; checked: boolean; hold: boolean }

export function CreateTasksDialog({ open, meeting, history, employees, projects, rooms, dispatch, onClose }: CreateTasksDialogProps) {
  const activeEmployees = useMemo(() => employees.filter(e => !e.archivedAt).sort((a, b) => a.name.localeCompare(b.name)), [employees]);
  const roomById = useMemo(() => new Map(rooms.map(r => [r.id, r])), [rooms]);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null); setDone(null); setBusy(false);
    setRows(proposeTaskItems(history, meeting).map(p => ({
      ...p, key: p.itemId ?? `d:${p.decisionId}`, checked: p.status !== 'created', hold: false,
      projectId: p.projectId ?? meeting.projectId ?? projects[0]?.id ?? null,
    })));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Itens que viraram tarefa com o diálogo aberto (inclusive num lote que falhou no meio) passam a "Criada" e saem da seleção,
  // para o novo "Confirmar" não reenviar o que já está na fila.
  useEffect(() => {
    if (!open) return;
    const created = new Map(history.taskItems.filter(t => t.status === 'created').map(t => [t.id, t]));
    if (created.size === 0) return;
    setRows(rs => {
      let changed = false;
      const next = rs.map(r => {
        const it = r.itemId ? created.get(r.itemId) : undefined;
        if (!it || r.status === 'created') return r;
        changed = true;
        return { ...r, status: 'created' as const, taskId: it.taskId, checked: false };
      });
      return changed ? next : rs;
    });
  }, [open, history.taskItems]);

  const patch = (key: string, p: Partial<Row>) => setRows(rs => rs.map(r => (r.key === key ? { ...r, ...p } : r)));
  const chosen = rows.filter(r => r.checked && r.status !== 'created');
  const invalid = chosen.filter(r => !r.employeeId || !r.projectId || !r.title.trim() || !r.instructions.trim());
  const canConfirm = chosen.length > 0 && invalid.length === 0 && !busy;

  const confirm = async () => {
    if (!canConfirm) return;
    setBusy(true); setError(null);
    try {
      // 1) garante um MeetingTaskItem para cada linha (as vindas do quadro ainda não têm), com as edições feitas aqui.
      const ids: { key: string; id: string }[] = [];
      for (const r of chosen) {
        const roomId = r.employeeId ? activeEmployees.find(e => e.id === r.employeeId)?.roomId ?? null : null;
        const res = await dispatch({
          type: 'meeting.taskItem.upsert', reqId: '', meetingId: meeting.id,
          item: { id: r.itemId ?? undefined, title: r.title.trim(), instructions: r.instructions, employeeId: r.employeeId, roomId, projectId: r.projectId, decisionId: r.decisionId ?? null },
        }) as { item: MeetingTaskItem } | undefined;
        const id = res?.item?.id ?? r.itemId;
        if (!id) throw new Error(`o servidor não devolveu o item de "${r.title}"`);
        ids.push({ key: r.key, id });
        if (r.itemId !== id) patch(r.key, { itemId: id }); // se o passo 2 falhar, o novo "Confirmar" atualiza o mesmo item em vez de criar outro
      }
      // 2) cria as tarefas reais de uma vez; o servidor ignora itens já criados.
      const res = await dispatch({
        type: 'meeting.tasks.create', reqId: '', meetingId: meeting.id,
        items: chosen.map(r => ({ id: ids.find(i => i.key === r.key)!.id, employeeId: r.employeeId!, projectId: r.projectId!, instructions: r.instructions, start: !r.hold })),
      }) as { items: MeetingTaskItem[] } | undefined;
      const created = res?.items ?? [];
      setRows(rs => rs.map(r => {
        const id = ids.find(i => i.key === r.key)?.id;
        const it = id ? created.find(c => c.id === id) : undefined;
        return it ? { ...r, itemId: it.id, status: it.status, taskId: it.taskId, checked: false } : r;
      }));
      const n = created.filter(c => c.status === 'created').length;
      setDone(n === 0 ? 'O servidor não confirmou nenhuma tarefa criada.' : `${n} tarefa${n === 1 ? '' : 's'} criada${n === 1 ? '' : 's'} na fila${chosen.some(r => r.hold) ? ' (as marcadas "sem iniciar" esperam liberação)' : ''}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Criar tarefas a partir da reunião" onCancel={onClose} width={720}>
      <div className="hq-form">
        <p className="hq-dim hq-meet-tasks__intro">Só decisões e ações confirmadas por você viram tarefa. Revise cada linha: a sala vem do funcionário escolhido.</p>
        {rows.length === 0 && <div className="hq-empty"><p>Nada para criar.</p></div>}
        {rows.map(r => {
          const created = r.status === 'created';
          const emp = r.employeeId ? activeEmployees.find(e => e.id === r.employeeId) : null;
          const room = emp ? roomById.get(emp.roomId) : null;
          return (
            <div key={r.key} className={`hq-meet-task${created ? ' hq-meet-task--created' : ''}${r.checked ? ' hq-meet-task--on' : ''}`}>
              <div className="hq-meet-task__head">
                {created ? (
                  <span className="hq-tag hq-tag--ok">Criada{r.taskId ? ` · tarefa ${r.taskId.slice(0, 8)}` : ''}</span>
                ) : (
                  <label className="hq-check"><input type="checkbox" checked={r.checked} onChange={e => patch(r.key, { checked: e.target.checked })} /> <span>Criar</span></label>
                )}
                <input className="hq-input hq-input--sm hq-meet-task__title" value={r.title} disabled={created} onChange={e => patch(r.key, { title: e.target.value })} aria-label="Título da tarefa" />
              </div>
              <div className="hq-form__row">
                <Field label="Funcionário" hint={room ? `Sala: ${room.name}` : 'A sala é derivada do funcionário.'}>
                  <select className="hq-input hq-input--sm" value={r.employeeId ?? ''} disabled={created} onChange={e => patch(r.key, { employeeId: e.target.value || null })}>
                    <option value="">Escolha…</option>
                    {activeEmployees.map(e => <option key={e.id} value={e.id}>{e.name} · {e.role}</option>)}
                  </select>
                </Field>
                <Field label="Projeto">
                  <select className="hq-input hq-input--sm" value={r.projectId ?? ''} disabled={created} onChange={e => patch(r.key, { projectId: e.target.value || null })}>
                    <option value="">Escolha…</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Instruções">
                <textarea className="hq-input hq-textarea" rows={3} value={r.instructions} disabled={created} onChange={e => patch(r.key, { instructions: e.target.value })} />
              </Field>
              {!created && (
                <label className="hq-check"><input type="checkbox" checked={r.hold} onChange={e => patch(r.key, { hold: e.target.checked })} /> <span>Criar sem iniciar <span className="hq-dim">(fica na fila em espera até você liberar)</span></span></label>
              )}
            </div>
          );
        })}
        {invalid.length > 0 && <div className="hq-notice hq-notice--warn">{invalid.length === 1 ? '1 linha marcada está sem funcionário, projeto, título ou instruções.' : `${invalid.length} linhas marcadas estão sem funcionário, projeto, título ou instruções.`}</div>}
        {error && <div className="hq-notice hq-notice--error" role="alert">{error}</div>}
        {done && <div className="hq-notice hq-notice--ok" role="status">{done}</div>}
        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn" onClick={onClose} disabled={busy}>{done ? 'Fechar' : 'Cancelar'}</button>
          <button type="button" className="hq-btn hq-btn--primary" disabled={!canConfirm} onClick={() => void confirm()}>{busy ? 'Criando…' : `Confirmar (${chosen.length})`}</button>
        </div>
      </div>
    </Modal>
  );
}
