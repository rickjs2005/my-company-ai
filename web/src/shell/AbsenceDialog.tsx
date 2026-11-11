// Modo ausente: o Chefe diz o que pode continuar sem ele (projetos, funcionários, limites, rotinas) e vê, antes de salvar, o que
// isso significa: a fila que segue, a que espera, o que cada funcionário pode fazer sem perguntar e o próximo trabalho. A
// política é aplicada no servidor (executor). Ausência não é aprovação: nenhuma permissão do provedor muda aqui.
import { useEffect, useMemo, useState } from 'react';
import type { AbsencePolicy, Employee, PermissionModeOption, Project, Routine, Task } from '@milweb-hq/protocol';
import { Field, Modal } from '../panel/dialogs/Modal';
import { PERMISSION_MODE_LABELS } from '../panel/helpers';
import { MACHINE_CONDITIONS, absenceOverview } from './absenceHelpers';
import { formatWhen } from './routinesHelpers';

export interface AbsenceDialogProps {
  open: boolean;
  policy: AbsencePolicy;
  projects: Project[];
  employees: Employee[];
  tasks: Task[];
  routines: Routine[];
  defaultPermissionMode: PermissionModeOption;
  onSave(policy: AbsencePolicy): void;
  onCancel(): void;
}

const firstLine = (t: string) => (t.split('\n').find(l => l.trim() && !l.startsWith('[') && !l.startsWith('/')) ?? t).trim().slice(0, 80);

export function AbsenceDialog(props: AbsenceDialogProps) {
  const [draft, setDraft] = useState<AbsencePolicy>(props.policy);
  // Reabrir o diálogo parte do que está salvo; snapshots durante a edição não apagam o rascunho.
  useEffect(() => { if (props.open) setDraft(props.policy); }, [props.open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof AbsencePolicy>(k: K, v: AbsencePolicy[K]) => setDraft(d => ({ ...d, [k]: v }));
  const toggleIn = (k: 'allowedProjectIds' | 'allowedEmployeeIds', id: string) => setDraft(d => ({ ...d, [k]: d[k].includes(id) ? d[k].filter(x => x !== id) : [...d[k], id] }));
  const projects = props.projects.filter(p => !p.id.startsWith('ext:'));
  const employees = props.employees.filter(e => !e.archivedAt);
  const ov = useMemo(() => absenceOverview(draft, { projects: props.projects, employees: props.employees, tasks: props.tasks, routines: props.routines, defaultPermissionMode: props.defaultPermissionMode }), [draft, props.projects, props.employees, props.tasks, props.routines, props.defaultPermissionMode]);
  const now = Date.now();
  const empName = (id: string | null | undefined) => props.employees.find(e => e.id === id)?.name ?? '?';
  const projName = (id: string) => props.projects.find(p => p.id === id)?.name ?? '?';

  return (
    <Modal open={props.open} title="Modo ausente" onCancel={props.onCancel} width={760}>
      <form className="hq-form hq-absence" onSubmit={e => { e.preventDefault(); props.onSave(draft); }}>
        <p className="hq-dim hq-absence__lead">Diz o que pode continuar enquanto você está fora. Ausência não é aprovação: ninguém ganha permissão nova. O que precisar de você fica "Aguardando Chefe" e a fila segue com o resto.</p>
        <label className="hq-check hq-absence__switch">
          <input type="checkbox" checked={draft.enabled} onChange={e => set('enabled', e.target.checked)} />
          <span><strong>Ligar o modo ausente</strong>{props.policy.enabled && props.policy.since ? <span className="hq-dim"> · ligado desde {formatWhen(props.policy.since, now)}</span> : null}</span>
        </label>

        <div className="hq-absence__grid">
          <fieldset className="hq-absence__box">
            <legend>Projetos que podem continuar</legend>
            {projects.length === 0 && <div className="hq-dim">Nenhum projeto cadastrado.</div>}
            {projects.map(p => (
              <label key={p.id} className="hq-check"><input type="checkbox" checked={draft.allowedProjectIds.includes(p.id)} onChange={() => toggleIn('allowedProjectIds', p.id)} /><span>{p.name}</span></label>
            ))}
          </fieldset>
          <fieldset className="hq-absence__box">
            <legend>Funcionários autorizados</legend>
            <div className="hq-dim">{draft.allowedEmployeeIds.length ? 'Só os marcados.' : 'Nenhum marcado = todos os que tiverem tarefa num projeto autorizado.'}</div>
            {employees.map(e => (
              <label key={e.id} className="hq-check"><input type="checkbox" checked={draft.allowedEmployeeIds.includes(e.id)} onChange={() => toggleIn('allowedEmployeeIds', e.id)} /><span>{e.name}{e.role ? <span className="hq-dim"> · {e.role}</span> : null}</span></label>
            ))}
          </fieldset>
        </div>

        <div className="hq-form__row">
          <Field label="Tarefas na ausência (no máximo)"><input type="number" className="hq-input" min={1} max={100} value={draft.maxTasks} onChange={e => set('maxTasks', Math.max(1, Math.min(100, Number(e.target.value) || 1)))} /></Field>
          <Field label="Minutos por tarefa (no máximo)"><input type="number" className="hq-input" min={5} max={1440} value={draft.maxTaskMinutes} onChange={e => set('maxTaskMinutes', Math.max(5, Math.min(1440, Number(e.target.value) || 5)))} /></Field>
          <Field label="Tentativas por tarefa"><input type="number" className="hq-input" min={1} max={5} value={draft.maxAttempts} onChange={e => set('maxAttempts', Math.max(1, Math.min(5, Number(e.target.value) || 1)))} /></Field>
        </div>
        <label className="hq-check"><input type="checkbox" checked={draft.allowRoutines} onChange={e => set('allowRoutines', e.target.checked)} /><span>Rotinas podem disparar <span className="hq-dim">(só nos projetos e funcionários autorizados)</span></span></label>

        <section className="hq-absence__summary" aria-label="Resumo do que vai acontecer">
          <h3 className="hq-view__sub">O que vai acontecer</h3>
          {ov.warnings.map(w => <div key={w} className="hq-notice hq-notice--warn">{w}</div>)}
          <dl className="hq-absence__facts">
            <dt>Continua</dt>
            <dd>{ov.willRun.length ? ov.willRun.map(t => <div key={t.id}>{firstLine(t.prompt)} <span className="hq-dim">· {empName(t.employeeId)} · {projName(t.projectId)}</span></div>) : <span className="hq-dim">nada na fila agora</span>}</dd>
            <dt>Espera você</dt>
            <dd>{ov.willWait.length ? ov.willWait.map(t => <div key={t.id}>{firstLine(t.prompt)} <span className="hq-dim">· {empName(t.employeeId)} · {projName(t.projectId)}</span></div>) : <span className="hq-dim">nada</span>}</dd>
            <dt>Próxima rotina</dt>
            <dd>{ov.nextRoutine ? <>{ov.nextRoutine.routine.title} <span className="hq-dim">· {formatWhen(ov.nextRoutine.at, now)} · {empName(ov.nextRoutine.routine.employeeId)}</span></> : <span className="hq-dim">{draft.allowRoutines ? 'nenhuma nos projetos autorizados' : 'rotinas desligadas na ausência'}</span>}</dd>
            <dt>Sem perguntar</dt>
            <dd>{ov.actions.length ? ov.actions.map(a => <div key={a.employee.id}><strong>{a.employee.name}</strong> <span className="hq-chip">{PERMISSION_MODE_LABELS[a.mode]}</span> <span className="hq-dim">{a.meaning}</span></div>) : <span className="hq-dim">nenhum funcionário autorizado</span>}</dd>
            <dt>Limites</dt>
            <dd>até {draft.maxTasks} tarefa(s), {draft.maxTaskMinutes} min cada, {draft.maxAttempts} tentativa(s). Ações externas, publicações, gastos e exclusões continuam pedindo autorização pelo provedor.</dd>
          </dl>
        </section>

        <details className="hq-absence__machine">
          <summary>O computador precisa estar ligado, acordado e com internet</summary>
          <table className="hq-absence__table">
            <thead><tr><th>Situação</th><th>O que acontece</th><th>Conferido</th></tr></thead>
            <tbody>{MACHINE_CONDITIONS.map(c => <tr key={c.situation}><td>{c.situation}</td><td>{c.effect}</td><td className={c.verified === 'não testado' ? 'hq-dim' : ''}>{c.verified}</td></tr>)}</tbody>
          </table>
        </details>

        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn" onClick={props.onCancel}>Cancelar</button>
          <button type="submit" className="hq-btn hq-btn--primary">{draft.enabled ? (props.policy.enabled ? 'Salvar' : 'Ligar Modo ausente') : (props.policy.enabled ? 'Desligar Modo ausente' : 'Salvar')}</button>
        </div>
      </form>
    </Modal>
  );
}
