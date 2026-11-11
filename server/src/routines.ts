// Rotinas (v4): tarefas periódicas que o Chefe cadastra (a HQ não inventa nenhuma). O agendador é código determinístico, sem
// chamar modelo para ver a hora, em America/Sao_Paulo. Regras:
// - cada horário vira no máximo UMA tarefa (clientId `routine:<id>:<horário>`), e uma execução anterior ainda aberta impede a
//   próxima (não empilha);
// - horário perdido (HQ desligada ou computador suspenso) segue a regra da rotina: pular, ou rodar uma vez ao voltar. Nunca
//   dispara várias execuções acumuladas;
// - a tarefa passa pela mesma entrada do compositor (validação, skill, opções), com origem 'routine'. O Modo ausente pode segurá-la.
import type { PermissionModeOption, Routine, RoutineInput, RoutineSchedule, ServerMessage, Task, TaskRunInput, TaskRunResult, WorkClientMessage } from '@milweb-hq/protocol';
import type { Store } from './store.js';
import { recordAudit } from './audit.js';
import { HQ_TZ, formatBrt, wallDay, wallTimeToUtc } from './time.js';

/** Checagem periódica (30 s): barata e robusta a suspensão, ao contrário de um único timer longo. */
export const ROUTINE_TICK_MS = 30_000;
/** Disparo mais atrasado que isso conta como horário perdido (o computador estava suspenso ou o serviço parado). */
export const LATE_TOLERANCE_MS = 5 * 60_000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OPEN: Task['status'][] = ['queued', 'running', 'waiting_permission', 'waiting_answer'];
const MODES: PermissionModeOption[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'];
const STATUS_PT: Partial<Record<Task['status'], string>> = { queued: 'na fila', running: 'em execução', waiting_permission: 'aguardando autorização', waiting_answer: 'aguardando resposta' };

export function scheduleProblem(s: RoutineSchedule | null | undefined): string | null {
  if (!s || typeof s !== 'object') return 'Escolha quando a rotina roda.';
  if (s.kind === 'interval') return Number.isInteger(s.everyMinutes) && s.everyMinutes >= 1 && s.everyMinutes <= 7 * 24 * 60 ? null : 'Intervalo em minutos inteiros, de 1 a 10080 (7 dias).';
  if (s.kind === 'daily' || s.kind === 'weekly') {
    if (!HHMM.test(s.time ?? '')) return 'Horário no formato HH:MM (ex.: 09:00).';
    if (s.times !== undefined && (!Array.isArray(s.times) || !s.times.length || s.times.length > 6 || s.times.some(t => !HHMM.test(t)))) return 'Horários do dia no formato HH:MM (até 6, ex.: 10:00 e 17:00).';
    if (s.kind === 'weekly' && (!Array.isArray(s.days) || !s.days.length || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6))) return 'Escolha pelo menos um dia da semana.';
    return null;
  }
  return 'Tipo de agenda desconhecido.';
}

/** Próximo disparo (ms) estritamente depois de `after`. Intervalo conta a partir de `after` (último disparo ou cadastro). */
export function nextRunAt(s: RoutineSchedule, after: number, tz = HQ_TZ): number {
  if (s.kind === 'interval') return after + s.everyMinutes * 60_000;
  const days = s.kind === 'weekly' ? new Set(s.days) : null;
  // Vários horários no dia: o próximo é o mais cedo entre eles (cada um vira no máximo uma tarefa, como antes).
  let best = Infinity;
  for (const t of scheduleTimes(s)) {
    const [h, m] = t.split(':').map(Number);
    for (let i = 0; i <= 8; i++) {
      const at = wallTimeToUtc(tz, after, i, h, m);
      if (at <= after) continue;
      if (!days || days.has(wallDay(tz, at))) { best = Math.min(best, at); break; }
    }
  }
  if (Number.isFinite(best)) return best;
  throw new Error('agenda sem próximo horário');
}

/** Horários do dia da agenda (ordenados, sem repetição). */
export function scheduleTimes(s: Exclude<RoutineSchedule, { kind: 'interval' }>): string[] {
  return [...new Set([...(s.times?.length ? s.times : []), s.time].filter(t => HHMM.test(t ?? '')))].sort();
}

/** Descrição curta da agenda ("todo dia às 09:00", "todo dia às 10:00 e 17:00", "seg, qua às 08:30", "a cada 30 min"). */
export function scheduleLabel(s: RoutineSchedule): string {
  if (s.kind === 'interval') return s.everyMinutes % 60 === 0 ? `a cada ${s.everyMinutes / 60} h` : `a cada ${s.everyMinutes} min`;
  const ts = scheduleTimes(s);
  const at = ts.length > 1 ? `${ts.slice(0, -1).join(', ')} e ${ts[ts.length - 1]}` : ts[0];
  if (s.kind === 'daily') return `todo dia às ${at}`;
  const names = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  return `${[...s.days].sort().map(d => names[d]).join(', ')} às ${at}`;
}

/** Fluxos que montam o pedido na hora do disparo (sala de conteúdo). `after` registra a rodada com a tarefa criada. */
export interface RoutineWorkflows {
  prepare(workflow: NonNullable<Routine['workflow']>, r: Routine): Promise<{ text: string; skill: string | null; after(taskId: string): void }>;
}

export interface RoutineDeps {
  store: Store;
  workflows?: RoutineWorkflows;
  manager: { runTask(input: TaskRunInput, extra?: { origin?: Task['origin']; routineId?: string | null }): Promise<TaskRunResult> };
  broadcast(m: ServerMessage): void;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
  now?(): number;
}

export class RoutineService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  constructor(private d: RoutineDeps) {}
  private now(): number { return this.d.now?.() ?? Date.now(); }

  /** Ao subir: agenda o que não tem próximo horário e aplica a regra de horário perdido ao que venceu com a HQ desligada. */
  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => { this.tick().catch(err => this.d.log.warn('falha na checagem das rotinas', err)); }, ROUTINE_TICK_MS);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** Uma checagem: dispara o que venceu; o que venceu há mais que a tolerância segue a regra de horário perdido. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const r of this.d.store.listRoutines()) {
        if (!r.enabled) continue;
        const now = this.now();
        if (r.nextRunAt == null) { this.save(r.id, { nextRunAt: nextRunAt(r.schedule, now) }); continue; }
        if (r.nextRunAt > now) continue;
        if (now - r.nextRunAt > LATE_TOLERANCE_MS) await this.missed(r, now);
        else await this.fire(r, 'schedule', r.nextRunAt).catch(() => { /* motivo gravado na rotina */ });
      }
    } finally { this.ticking = false; }
  }

  private async missed(r: Routine, now: number): Promise<void> {
    const slot = r.nextRunAt!;
    if (r.missedPolicy === 'run_once') { await this.fire(r, 'missed', slot).catch(() => { /* motivo gravado */ }); return; }
    const reason = `Horário de ${formatBrt(slot, now)} perdido (HQ desligada ou computador suspenso): pulado, como a rotina manda.`;
    this.d.log.info(`rotina "${r.title}": ${reason}`);
    this.save(r.id, { nextRunAt: nextRunAt(r.schedule, now), lastSkipReason: reason });
  }

  /** Cria a tarefa da rotina. `slot` = horário agendado (identidade da execução); manual não mexe na agenda. */
  async fire(r: Routine, why: 'schedule' | 'missed' | 'manual', slot: number): Promise<TaskRunResult | null> {
    const now = this.now();
    const when = formatBrt(slot, now);
    const next = why === 'manual' ? r.nextRunAt : nextRunAt(r.schedule, Math.max(now, slot));
    const prev = r.lastTaskId ? this.d.store.getTask(r.lastTaskId) : null;
    if (prev && OPEN.includes(prev.status)) {
      const reason = `${why === 'manual' ? 'Execução manual' : `Horário de ${when}`} não disparou: a execução anterior ainda está ${STATUS_PT[prev.status] ?? prev.status}.`;
      this.save(r.id, { nextRunAt: next, lastSkipReason: reason });
      if (why === 'manual') throw new Error(reason);
      return null;
    }
    // A agenda anda ANTES de criar a tarefa: uma checagem concorrente ou um reinício não dispara o mesmo horário de novo.
    if (why !== 'manual') this.save(r.id, { nextRunAt: next });
    try {
      const flow = r.workflow && this.d.workflows ? await this.d.workflows.prepare(r.workflow, r) : null;
      const res = await this.d.manager.runTask({
        reqId: 'routine', clientId: `routine:${r.id}:${why === 'manual' ? `manual-${now}` : slot}`, text: flow?.text ?? r.prompt, projectId: r.projectId, employeeId: r.employeeId,
        skill: flow ? flow.skill : r.skill, plan: false, options: { model: r.model, effort: r.effort, permissionMode: r.permissionMode },
      }, { origin: 'routine', routineId: r.id });
      if (flow && !res.duplicate) flow.after(res.taskId);
      const note = why === 'missed' ? `Horário de ${when} perdido; rodou uma vez ao voltar, como a rotina manda.` : null;
      this.save(r.id, { lastRunAt: now, lastTaskId: res.taskId, lastSkipReason: note });
      this.d.log.info(`rotina "${r.title}" criou a tarefa ${res.taskId} (${why}, horário ${new Date(slot).toISOString()})`);
      return res;
    } catch (err) {
      const reason = `${why === 'manual' ? 'Execução manual' : `Horário de ${when}`}: não foi possível criar a tarefa: ${(err as Error).message ?? err}`;
      this.save(r.id, { lastSkipReason: reason });
      this.d.log.warn(`rotina "${r.title}": ${reason}`);
      throw err;
    }
  }

  async handle(msg: WorkClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'routine.create': {
        const input = this.validate(msg.routine);
        const r = this.d.store.createRoutine({ ...input, nextRunAt: input.enabled ? nextRunAt(input.schedule, this.now()) : null });
        this.d.broadcast({ kind: 'routine', op: 'upsert', routine: r });
        return r;
      }
      case 'routine.update': {
        const cur = this.d.store.getRoutine(msg.id); if (!cur) throw new Error('Rotina não encontrada.');
        const merged = this.validate({ ...pick(cur), ...msg.patch });
        const reschedule = msg.patch.schedule !== undefined || (msg.patch.enabled !== undefined && msg.patch.enabled !== cur.enabled);
        const nextAt = !merged.enabled ? null : reschedule || cur.nextRunAt == null ? nextRunAt(merged.schedule, this.now()) : cur.nextRunAt;
        return this.save(msg.id, { ...merged, nextRunAt: nextAt, ...(reschedule ? { lastSkipReason: null } : {}) });
      }
      case 'routine.delete': {
        // Apagar a rotina não apaga nem cancela as tarefas que ela já criou.
        const r = this.d.store.getRoutine(msg.id);
        this.d.store.deleteRoutine(msg.id);
        recordAudit(this.d.store, { action: 'excluir', entity: 'rotina', entityId: msg.id, title: r?.title ?? null, origin: 'interface', detail: 'tarefas já criadas continuam' });
        this.d.broadcast({ kind: 'routine', op: 'delete', routine: { id: msg.id } });
        return undefined;
      }
      case 'routine.runNow': {
        const r = this.d.store.getRoutine(msg.id); if (!r) throw new Error('Rotina não encontrada.');
        return this.fire(r, 'manual', this.now());
      }
      default: throw new Error(`operação de rotina desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  private validate(i: Partial<RoutineInput>): RoutineInput {
    const prompt = String(i.prompt ?? '').trim();
    if (!prompt) throw new Error('Escreva o pedido que a rotina vai repetir.');
    const title = String(i.title ?? '').trim() || prompt.split('\n')[0].slice(0, 60);
    if (!i.employeeId) throw new Error('Escolha o funcionário responsável.');
    const e = this.d.store.getEmployee(i.employeeId);
    if (!e) throw new Error('Esse funcionário não existe mais.');
    if (e.archivedAt) throw new Error(`${e.name} está arquivado: restaure na Equipe ou escolha outro.`);
    if (!i.projectId || !this.d.store.getProject(i.projectId)) throw new Error('Escolha um projeto cadastrado.');
    const problem = scheduleProblem(i.schedule); if (problem) throw new Error(problem);
    const missedPolicy = i.missedPolicy === 'run_once' ? 'run_once' : 'skip';
    const permissionMode = i.permissionMode ?? null;
    if (permissionMode && !MODES.includes(permissionMode as PermissionModeOption)) throw new Error(`Modo de permissão desconhecido: ${permissionMode}.`);
    const workflow = i.workflow === 'content.radar' || i.workflow === 'content.analise' ? i.workflow : null;
    return { title, prompt, employeeId: i.employeeId, projectId: i.projectId, skill: i.skill?.trim() || null, schedule: i.schedule!, enabled: i.enabled !== false, permissionMode, model: i.model ?? null, effort: i.effort ?? null, missedPolicy, workflow };
  }

  private save(id: string, patch: Parameters<Store['updateRoutine']>[1]): Routine | null {
    const r = this.d.store.updateRoutine(id, patch);
    if (r) this.d.broadcast({ kind: 'routine', op: 'upsert', routine: r });
    return r;
  }
}

function pick(r: Routine): RoutineInput {
  const { title, prompt, employeeId, projectId, skill, schedule, enabled, permissionMode, model, effort, missedPolicy, workflow } = r;
  return { title, prompt, employeeId, projectId, skill, schedule, enabled, permissionMode, model, effort, missedPolicy, workflow: workflow ?? null };
}
