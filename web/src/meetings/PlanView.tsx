// Aba "Plano" da reunião: o plano consolidado pelo gerente responsável (versão, autor, decisões, pendências, falta de gente)
// e cada tarefa distribuída com o responsável e o estado REAL da tarefa na fila. "Abrir" leva à conversa do funcionário.
import type { Employee, MeetingHistory, PlanTaskRecord, Task } from '@milweb-hq/protocol';
import { SOCIAL_SLOTS } from '@milweb-hq/protocol';

export interface PlanTaskView { label: string; color: string; detail: string | null }

/** Estado visível de uma tarefa do plano: na fila, trabalhando, aguardando dependência, aguardando Chefe, bloqueada, entregue ou falhou. */
export function planTaskState(rec: PlanTaskRecord, task: Task | null): PlanTaskView {
  if (rec.status === 'blocked') return { label: 'Bloqueada', color: 'var(--danger)', detail: rec.blockedReason };
  if (rec.status === 'pending' || !rec.taskId) return { label: 'Ainda não entrou na fila', color: 'var(--text-dim)', detail: null };
  if (!task) return { label: 'Na fila', color: 'var(--info)', detail: 'a tarefa não está entre as recentes desta tela' };
  switch (task.status) {
    case 'queued':
      if (task.held && task.heldReason?.startsWith('Aguardando dependência')) return { label: 'Aguardando dependência', color: 'var(--info)', detail: task.heldReason.replace(/^Aguardando dependência:\s*/, '') };
      if (task.held) return { label: 'Em espera', color: 'var(--warn)', detail: task.heldReason ?? null };
      return { label: 'Na fila', color: 'var(--info)', detail: task.heldReason ?? null };
    case 'running': return { label: 'Trabalhando', color: 'var(--amber)', detail: null };
    case 'waiting_permission': return { label: 'Aguardando Chefe', color: 'var(--warn)', detail: 'pediu autorização' };
    case 'waiting_answer': return { label: 'Aguardando Chefe', color: 'var(--warn)', detail: 'fez uma pergunta' };
    case 'done': return { label: 'Entregue', color: 'var(--ok)', detail: 'na sua mesa para aprovar ou pedir ajustes' };
    default: return { label: 'Falhou', color: 'var(--danger)', detail: task.errors[task.errors.length - 1] ?? task.status };
  }
}

export function PlanView({ history, tasks, employees, onOpenTask }: { history: MeetingHistory; tasks: Task[]; employees: Employee[]; onOpenTask?(taskId: string): void }) {
  const plans = history.plans ?? [];
  const recs = history.planTasks ?? [];
  if (!plans.length) {
    return (
      <div className="hq-empty">
        <p>Nenhum plano ainda.</p>
        <p className="hq-dim">Use "Encerrar e distribuir tarefas" (ou peça no chat): o gerente responsável consolida o que foi combinado com você e a HQ distribui para a equipe.</p>
      </div>
    );
  }
  const plan = plans[plans.length - 1];
  const byTask = new Map(tasks.map(t => [t.id, t]));
  const empName = (id: string | null, fallback: string | null) => (id ? employees.find(e => e.id === id)?.name : null) ?? fallback ?? '—';
  return (
    <div className="hq-meet-plan">
      <p className="hq-dim">Plano v{plan.version} · consolidado por <strong>{plan.authorName}</strong> · {new Date(plan.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
      {plan.summary && <p className="hq-meet-plan__sum">{plan.summary}</p>}
      <section className="hq-meet-group">
        <h4 className="hq-meet-group__title">Tarefas ({recs.length})</h4>
        <ul className="hq-meet-plan__tasks">
          {recs.map(r => {
            const t = r.taskId ? byTask.get(r.taskId) ?? null : null;
            const st = planTaskState(r, t);
            const slot = r.spec.slot ? SOCIAL_SLOTS.find(x => x.slot === r.spec.slot)?.label ?? r.spec.slot : null;
            return (
              <li key={r.id} className="hq-meet-plan__task">
                <div className="hq-meet-plan__row">
                  <strong className="hq-meet-plan__title">{r.spec.title}</strong>
                  <span className="hq-meet-plan__st" style={{ ['--st' as string]: st.color }}>{st.label}</span>
                </div>
                <div className="hq-dim hq-meet-plan__meta">
                  {empName(r.spec.employeeId, r.spec.employeeName)}{slot ? ` · ${slot}` : ''} · prioridade {r.spec.priority === 'media' ? 'média' : r.spec.priority}
                  {r.spec.dependsOn.length > 0 && ` · depois de ${r.spec.dependsOn.map(k => recs.find(x => x.key === k)?.spec.title ?? k).join(', ')}`}
                  {r.spec.deadline && ` · prazo ${r.spec.deadline}${r.spec.deadlineProposed ? ' (proposto)' : ''}`}
                </div>
                {st.detail && <div className="hq-meet-plan__detail">{st.detail}</div>}
                {r.taskId && onOpenTask && <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenTask(r.taskId!)}>Abrir tarefa</button>}
              </li>
            );
          })}
        </ul>
      </section>
      {plan.decisions.length > 0 && <section className="hq-meet-group"><h4 className="hq-meet-group__title">Decisões suas</h4><ul className="hq-meet-plan__list">{plan.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></section>}
      {plan.pending.length > 0 && <section className="hq-meet-group"><h4 className="hq-meet-group__title">Pendências (sem decisão sua)</h4><ul className="hq-meet-plan__list">{plan.pending.map((d, i) => <li key={i}>{d}</li>)}</ul></section>}
      {plan.needs.length > 0 && <section className="hq-meet-group"><h4 className="hq-meet-group__title">Falta alguém apto</h4><ul className="hq-meet-plan__list">{plan.needs.map((d, i) => <li key={i}>{d}</li>)}</ul></section>}
    </div>
  );
}
