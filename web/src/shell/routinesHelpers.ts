// Helpers puros da tela de Rotinas: rascunho do formulário, validação (a mesma regra do servidor), rótulos de agenda e horários
// em Brasília. O servidor continua sendo quem valida e agenda; aqui só se evita mandar algo que ele recusaria.
import type { Routine, RoutineInput, RoutineSchedule, Task } from '@milweb-hq/protocol';

export const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface RoutineDraft {
  title: string;
  prompt: string;
  employeeId: string;
  projectId: string;
  skill: string;
  kind: RoutineSchedule['kind'];
  time: string;
  days: number[];
  everyMinutes: number;
  missedPolicy: Routine['missedPolicy'];
  /** '' = o modo do funcionário. */
  permissionMode: string;
  enabled: boolean;
}

export function emptyRoutineDraft(defaults: { employeeId?: string | null; projectId?: string | null } = {}): RoutineDraft {
  return { title: '', prompt: '', employeeId: defaults.employeeId ?? '', projectId: defaults.projectId ?? '', skill: '', kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5], everyMinutes: 60, missedPolicy: 'skip', permissionMode: '', enabled: true };
}

export function draftFromRoutine(r: Routine): RoutineDraft {
  const s = r.schedule;
  return {
    title: r.title, prompt: r.prompt, employeeId: r.employeeId, projectId: r.projectId, skill: r.skill ?? '', kind: s.kind,
    time: s.kind === 'interval' ? '09:00' : (s.times?.length ? [...new Set([s.time, ...s.times])].sort().join(', ') : s.time), days: s.kind === 'weekly' ? [...s.days] : [1, 2, 3, 4, 5], everyMinutes: s.kind === 'interval' ? s.everyMinutes : 60,
    missedPolicy: r.missedPolicy, permissionMode: r.permissionMode ?? '', enabled: r.enabled,
  };
}

/** "10:00, 17:00" → horários do dia (ordenados, sem repetição). */
export function draftTimes(time: string): string[] { return [...new Set(time.split(/[,;\s]+/).map(t => t.trim()).filter(Boolean))].sort(); }

export function draftSchedule(d: RoutineDraft): RoutineSchedule {
  if (d.kind === 'interval') return { kind: 'interval', everyMinutes: Math.round(d.everyMinutes) };
  const ts = draftTimes(d.time);
  const extra = ts.length > 1 ? { times: ts } : {};
  if (d.kind === 'weekly') return { kind: 'weekly', time: ts[0] ?? d.time, days: [...new Set(d.days)].sort(), ...extra };
  return { kind: 'daily', time: ts[0] ?? d.time, ...extra };
}

/** O que falta ou está errado, na ordem do formulário (lista vazia = pode salvar). */
export function routineDraftProblems(d: RoutineDraft): string[] {
  const out: string[] = [];
  if (!d.prompt.trim()) out.push('Escreva o pedido que a rotina vai repetir.');
  if (!d.employeeId) out.push('Escolha o funcionário responsável.');
  if (!d.projectId) out.push('Escolha o projeto.');
  if (d.kind !== 'interval' && (!draftTimes(d.time).length || draftTimes(d.time).length > 6 || draftTimes(d.time).some(t => !HHMM.test(t)))) out.push('Horário no formato HH:MM; para mais de um no dia, separe por vírgula (ex.: 10:00, 17:00).');
  if (d.kind === 'weekly' && !d.days.length) out.push('Escolha pelo menos um dia da semana.');
  if (d.kind === 'interval' && (!Number.isInteger(d.everyMinutes) || d.everyMinutes < 1 || d.everyMinutes > 10080)) out.push('Intervalo em minutos inteiros, de 1 a 10080 (7 dias).');
  return out;
}

export function draftToInput(d: RoutineDraft): RoutineInput {
  return {
    title: d.title.trim(), prompt: d.prompt.trim(), employeeId: d.employeeId, projectId: d.projectId, skill: d.skill.trim().replace(/^\//, '') || null,
    schedule: draftSchedule(d), enabled: d.enabled, permissionMode: d.permissionMode || null, model: null, effort: null, missedPolicy: d.missedPolicy,
  };
}

export function scheduleLabel(s: RoutineSchedule): string {
  if (s.kind === 'interval') return s.everyMinutes % 60 === 0 ? `a cada ${s.everyMinutes / 60} h` : `a cada ${s.everyMinutes} min`;
  const ts = [...new Set([s.time, ...(s.times ?? [])])].sort();
  const at = ts.length > 1 ? `${ts.slice(0, -1).join(', ')} e ${ts[ts.length - 1]}` : ts[0];
  if (s.kind === 'daily') return `todo dia às ${at}`;
  return `${[...s.days].sort().map(d => WEEKDAYS[d]).join(', ')} às ${at}`;
}

const dayKey = (t: number) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(t));

/** "hoje 09:00", "amanhã 09:00", "ontem 18:30" ou "03/11 09:00", sempre no horário de Brasília. */
export function formatWhen(ts: number, now: number): string {
  const hm = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
  const k = dayKey(ts);
  if (k === dayKey(now)) return `hoje ${hm}`;
  if (k === dayKey(now + 86_400_000)) return `amanhã ${hm}`;
  if (k === dayKey(now - 86_400_000)) return `ontem ${hm}`;
  return `${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(new Date(ts))} ${hm}`;
}

const TASK_PT: Record<Task['status'], string> = { queued: 'na fila', running: 'em execução', waiting_permission: 'aguardando autorização', waiting_answer: 'aguardando resposta', done: 'concluída', error: 'com falha', interrupted: 'interrompida', lost: 'perdida' };

/** Estado da última execução, a partir da tarefa real (null = nunca rodou ou a tarefa não está mais na lista). */
export function lastRunLabel(r: Routine, tasks: Task[], now: number): string | null {
  if (!r.lastRunAt) return null;
  const t = r.lastTaskId ? tasks.find(x => x.id === r.lastTaskId) : null;
  return `${formatWhen(r.lastRunAt, now)}${t ? ` · ${t.review === 'to_verify' ? 'resultado a conferir' : TASK_PT[t.status]}` : ''}`;
}
