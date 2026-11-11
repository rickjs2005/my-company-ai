// Rotinas: tarefas que o Chefe cadastra para repetir num horário (Brasília). A HQ não cria nenhuma sozinha. Cada rotina mostra
// a agenda, o responsável, o próximo disparo e o que aconteceu da última vez (inclusive por que não disparou). A agenda é do
// servidor: aqui só se edita e se pede "Executar agora".
import { useEffect, useState } from 'react';
import type { Employee, PermissionModeOption, Project, Routine, Task } from '@milweb-hq/protocol';
import { Field, Modal } from '../panel/dialogs/Modal';
import { PERMISSION_MODE_LABELS, PERMISSION_MODE_OPTIONS } from '../panel/helpers';
import { IconClock, IconEdit, IconPlus } from '../panel/icons';
import { WEEKDAYS, draftFromRoutine, draftToInput, emptyRoutineDraft, formatWhen, lastRunLabel, routineDraftProblems, scheduleLabel, type RoutineDraft } from './routinesHelpers';

export interface RoutinesViewProps {
  routines: Routine[];
  employees: Employee[];
  projects: Project[];
  tasks: Task[];
  connected: boolean;
  /** Cria (id null) ou atualiza; rejeita com a mensagem do servidor. */
  onSave(input: ReturnType<typeof draftToInput>, id: string | null): Promise<void>;
  onToggle(id: string, enabled: boolean): Promise<void>;
  onRunNow(id: string): Promise<void>;
  onDelete(id: string): void;
  onOpenEmployee(employeeId: string): void;
}

export function RoutinesView(props: RoutinesViewProps) {
  const [editing, setEditing] = useState<{ id: string | null; draft: RoutineDraft } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const employees = props.employees.filter(e => !e.archivedAt);
  const projects = props.projects.filter(p => !p.id.startsWith('ext:'));
  const empName = (id: string) => props.employees.find(e => e.id === id)?.name ?? 'funcionário removido';
  const projName = (id: string) => props.projects.find(p => p.id === id)?.name ?? 'projeto removido';
  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); setError(null); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  const sorted = [...props.routines].sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || ((a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)));

  return (
    <section className="hq-view hq-routines" aria-label="Rotinas">
      <header className="hq-view__head">
        <h2>Rotinas</h2>
        <span className="hq-dim">{props.routines.length ? `${props.routines.filter(r => r.enabled).length} ativa(s) de ${props.routines.length}` : 'nenhuma'} · horário de Brasília</span>
        <span className="hq-view__spacer" />
        <button type="button" className="hq-btn hq-btn--primary" disabled={!props.connected} onClick={() => setEditing({ id: null, draft: emptyRoutineDraft({ employeeId: employees[0]?.id, projectId: projects[0]?.id }) })}><IconPlus size={14} /> Nova rotina</button>
      </header>
      <p className="hq-dim hq-routines__lead">Uma rotina repete um pedido num horário, com o funcionário, o projeto e a skill que você escolher. A HQ não cria rotinas sozinha e não chama nenhum modelo só para olhar o relógio. Se o horário passar com a HQ desligada ou o computador suspenso, vale a regra de cada rotina: pular ou rodar uma vez ao voltar, nunca várias acumuladas.</p>
      {error && <div className="hq-notice hq-notice--warn" role="alert">{error}</div>}

      {sorted.length === 0 ? (
        <div className="hq-empty hq-empty--tall">
          <p>Nenhuma rotina cadastrada.</p>
          <p>Ex.: "toda segunda às 08:30, a Bia revisa os formulários do site e me lista o que quebrou".</p>
          <button type="button" className="hq-btn hq-btn--primary" disabled={!props.connected || !employees.length || !projects.length} onClick={() => setEditing({ id: null, draft: emptyRoutineDraft({ employeeId: employees[0]?.id, projectId: projects[0]?.id }) })}>Nova rotina</button>
          {(!employees.length || !projects.length) && <p className="hq-dim">Antes, {!projects.length ? 'cadastre um projeto' : ''}{!projects.length && !employees.length ? ' e ' : ''}{!employees.length ? 'contrate um funcionário' : ''}.</p>}
        </div>
      ) : (
        <ul className="hq-routines__list">
          {sorted.map(r => {
            const last = lastRunLabel(r, props.tasks, now);
            return (
              <li key={r.id} className={`hq-routine${r.enabled ? '' : ' hq-routine--off'}`}>
                <div className="hq-routine__main">
                  <div className="hq-routine__title"><IconClock size={14} /> <strong>{r.title}</strong> <span className="hq-chip">{scheduleLabel(r.schedule)}</span>{!r.enabled && <span className="hq-chip">desligada</span>}</div>
                  <div className="hq-routine__prompt">{r.prompt}</div>
                  <div className="hq-dim hq-routine__meta">
                    <button type="button" className="hq-linkbtn" onClick={() => props.onOpenEmployee(r.employeeId)}>{empName(r.employeeId)}</button>
                    {' · '}{projName(r.projectId)}{r.skill ? ` · /${r.skill}` : ''}{r.permissionMode ? ` · ${PERMISSION_MODE_LABELS[r.permissionMode as PermissionModeOption] ?? r.permissionMode}` : ''}
                    {' · '}{r.missedPolicy === 'run_once' ? 'horário perdido: roda uma vez ao voltar' : 'horário perdido: pula'}
                  </div>
                  <div className="hq-routine__times">
                    <span><span className="hq-dim">Próxima:</span> {r.enabled && r.nextRunAt ? formatWhen(r.nextRunAt, now) : '—'}</span>
                    <span><span className="hq-dim">Última:</span> {last ?? 'nunca rodou'}</span>
                  </div>
                  {r.lastSkipReason && <div className="hq-routine__skip">{r.lastSkipReason}</div>}
                </div>
                <div className="hq-routine__actions">
                  <label className="hq-check" title={r.enabled ? 'Desligar: a rotina para de disparar (nada é apagado)' : 'Ligar: volta a disparar no próximo horário'}>
                    <input type="checkbox" checked={r.enabled} disabled={!props.connected || busy != null} onChange={e => run(`toggle:${r.id}`, () => props.onToggle(r.id, e.target.checked))} /><span>Ativa</span>
                  </label>
                  <button type="button" className="hq-btn hq-btn--sm" disabled={!props.connected || busy != null} onClick={() => run(`run:${r.id}`, () => props.onRunNow(r.id))} title="Cria a tarefa agora, sem mudar a agenda">{busy === `run:${r.id}` ? 'Enviando…' : 'Executar agora'}</button>
                  <button type="button" className="hq-btn hq-btn--sm" disabled={!props.connected} onClick={() => setEditing({ id: r.id, draft: draftFromRoutine(r) })}><IconEdit size={12} /> Editar</button>
                  <button type="button" className="hq-btn hq-btn--sm hq-btn--danger" disabled={!props.connected} onClick={() => { if (window.confirm(`Apagar a rotina "${r.title}"? As tarefas que ela já criou continuam.`)) props.onDelete(r.id); }}>Apagar</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <RoutineEditor
          id={editing.id} initial={editing.draft} employees={employees} projects={projects}
          onCancel={() => setEditing(null)}
          onSave={async d => { await props.onSave(draftToInput(d), editing.id); setEditing(null); }}
        />
      )}
    </section>
  );
}

function RoutineEditor(props: { id: string | null; initial: RoutineDraft; employees: Employee[]; projects: Project[]; onSave(d: RoutineDraft): Promise<void>; onCancel(): void }) {
  const [d, setD] = useState<RoutineDraft>(props.initial);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof RoutineDraft>(k: K, v: RoutineDraft[K]) => setD(x => ({ ...x, [k]: v }));
  const problems = routineDraftProblems(d);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setTried(true);
    if (problems.length) return;
    setSaving(true); setError(null);
    try { await props.onSave(d); } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  };
  return (
    <Modal open title={props.id ? 'Editar rotina' : 'Nova rotina'} onCancel={props.onCancel} width={620}>
      <form className="hq-form" onSubmit={submit}>
        <Field label="Pedido" hint="O que o funcionário faz a cada vez (como no “O que vamos fazer?”).">
          <textarea className="hq-input" rows={3} value={d.prompt} onChange={e => set('prompt', e.target.value)} placeholder="Ex.: confira os formulários do site e me liste o que quebrou" autoFocus />
        </Field>
        <Field label="Nome (opcional)"><input className="hq-input" value={d.title} onChange={e => set('title', e.target.value)} placeholder="Usa a primeira linha do pedido" /></Field>
        <div className="hq-form__row">
          <Field label="Funcionário">
            <select className="hq-input" value={d.employeeId} onChange={e => set('employeeId', e.target.value)}>
              <option value="">Escolha…</option>
              {props.employees.map(e => <option key={e.id} value={e.id}>{e.name}{e.role ? ` · ${e.role}` : ''}</option>)}
            </select>
          </Field>
          <Field label="Projeto">
            <select className="hq-input" value={d.projectId} onChange={e => set('projectId', e.target.value)}>
              <option value="">Escolha…</option>
              {props.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="hq-form__row">
          <Field label="Quando">
            <select className="hq-input" value={d.kind} onChange={e => set('kind', e.target.value as RoutineDraft['kind'])}>
              <option value="daily">Todo dia</option>
              <option value="weekly">Dias da semana</option>
              <option value="interval">A cada N minutos</option>
            </select>
          </Field>
          {d.kind !== 'interval'
            ? <Field label="Horários (Brasília)"><input type="text" inputMode="numeric" className="hq-input" value={d.time} placeholder="09:00 ou 10:00, 17:00" aria-describedby="hq-routine-times" onChange={e => set('time', e.target.value)} /><span id="hq-routine-times" className="hq-field__hint">Mais de um horário no dia: separe por vírgula. Cada horário vira no máximo uma execução.</span></Field>
            : <Field label="Intervalo (minutos)"><input type="number" className="hq-input" min={1} max={10080} value={d.everyMinutes} onChange={e => set('everyMinutes', Math.round(Number(e.target.value) || 0))} /></Field>}
        </div>
        {d.kind === 'weekly' && (
          <div className="hq-routines__days" role="group" aria-label="Dias da semana">
            {WEEKDAYS.map((w, i) => (
              <label key={w} className="hq-check"><input type="checkbox" checked={d.days.includes(i)} onChange={() => set('days', d.days.includes(i) ? d.days.filter(x => x !== i) : [...d.days, i])} /><span>{w}</span></label>
            ))}
          </div>
        )}
        <div className="hq-form__row">
          <Field label="Se o horário passar com a HQ desligada">
            <select className="hq-input" value={d.missedPolicy} onChange={e => set('missedPolicy', e.target.value as RoutineDraft['missedPolicy'])}>
              <option value="skip">Pular e esperar o próximo</option>
              <option value="run_once">Rodar uma vez ao voltar</option>
            </select>
          </Field>
          <Field label="Permissões nesta rotina">
            <select className="hq-input" value={d.permissionMode} onChange={e => set('permissionMode', e.target.value)}>
              <option value="">As do funcionário</option>
              {PERMISSION_MODE_OPTIONS.map(m => <option key={m} value={m}>{PERMISSION_MODE_LABELS[m]}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Skill (opcional)" hint="Nome da skill, ex.: sistema-web. Vazio = automática."><input className="hq-input" value={d.skill} onChange={e => set('skill', e.target.value)} placeholder="Automática" /></Field>
        <label className="hq-check"><input type="checkbox" checked={d.enabled} onChange={e => set('enabled', e.target.checked)} /><span>Ativa</span></label>
        {tried && problems.length > 0 && <div className="hq-notice hq-notice--warn" role="alert">{problems.join(' ')}</div>}
        {error && <div className="hq-notice hq-notice--warn" role="alert">{error}</div>}
        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn" onClick={props.onCancel}>Cancelar</button>
          <button type="submit" className="hq-btn hq-btn--primary" disabled={saving}>{saving ? 'Salvando…' : props.id ? 'Salvar' : 'Criar rotina'}</button>
        </div>
      </form>
    </Modal>
  );
}
