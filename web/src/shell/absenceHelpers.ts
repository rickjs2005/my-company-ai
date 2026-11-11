// Helpers puros do Modo ausente: resumo do que vai continuar sem o Chefe (a partir do estado real da fila, dos funcionários e
// das rotinas), o que cada modo de permissão significa na prática e o que acontece com o computador em cada situação.
// A política é aplicada no servidor (executor); aqui só se mostra o que ela vai fazer.
import type { AbsencePolicy, Employee, PermissionModeOption, Project, Routine, Task } from '@milweb-hq/protocol';

export function permissionMeaning(mode: PermissionModeOption): string {
  switch (mode) {
    case 'default': return 'pergunta antes de editar arquivos e de rodar comandos; na ausência, cada pedido fica "Aguardando Chefe" e a fila segue com o que não depende dele';
    case 'acceptEdits': return 'edita arquivos do projeto sem perguntar; comandos e o resto pedem autorização e ficam "Aguardando Chefe"';
    case 'plan': return 'só lê e planeja; não altera nada';
    case 'auto': return 'o Claude Code aprova sozinho o que classifica como seguro; o que considerar arriscado ainda pede autorização';
    case 'dontAsk': return 'não pergunta: o que não estiver liberado nas regras do Claude Code é negado';
  }
}

export interface AbsenceOverview {
  allowedProjects: Project[];
  /** Funcionários com tarefa nos projetos permitidos e o que o modo de permissão deles libera. */
  actions: { employee: Employee; mode: PermissionModeOption; meaning: string }[];
  /** Fila que continua (projeto e funcionário autorizados) e a que vai esperar o Chefe. */
  willRun: Task[];
  willWait: Task[];
  nextRoutine: { routine: Routine; at: number } | null;
  /** Avisos honestos sobre a configuração (ex.: nenhum projeto escolhido = nada continua). */
  warnings: string[];
}

export function absenceOverview(p: AbsencePolicy, ctx: { projects: Project[]; employees: Employee[]; tasks: Task[]; routines: Routine[]; defaultPermissionMode: PermissionModeOption }): AbsenceOverview {
  const projects = ctx.projects.filter(x => !x.id.startsWith('ext:'));
  const allowedProjects = projects.filter(x => p.allowedProjectIds.includes(x.id));
  const employeeOk = (id: string | null | undefined) => !p.allowedEmployeeIds.length || (id != null && p.allowedEmployeeIds.includes(id));
  const queued = ctx.tasks.filter(t => t.status === 'queued' && !(t.held && !(t.heldReason ?? '').startsWith('Modo ausente')));
  const willRun = queued.filter(t => p.allowedProjectIds.includes(t.projectId) && employeeOk(t.employeeId)).slice(0, p.maxTasks);
  const willWait = queued.filter(t => !willRun.includes(t));
  const active = ctx.employees.filter(e => !e.archivedAt && employeeOk(e.id));
  const actions = active.map(e => { const mode = (e.permissionMode ?? ctx.defaultPermissionMode) as PermissionModeOption; return { employee: e, mode, meaning: permissionMeaning(mode) }; });
  let nextRoutine: AbsenceOverview['nextRoutine'] = null;
  if (p.allowRoutines) {
    for (const r of ctx.routines) {
      if (!r.enabled || r.nextRunAt == null || !p.allowedProjectIds.includes(r.projectId) || !employeeOk(r.employeeId)) continue;
      if (!nextRoutine || r.nextRunAt < nextRoutine.at) nextRoutine = { routine: r, at: r.nextRunAt };
    }
  }
  const warnings: string[] = [];
  if (!allowedProjects.length) warnings.push('Nenhum projeto autorizado: nada continua; toda tarefa fica "Aguardando Chefe".');
  if (p.allowedEmployeeIds.length && !active.length) warnings.push('Nenhum dos funcionários autorizados está ativo.');
  if (queued.length > willRun.length && willRun.length === p.maxTasks) warnings.push(`O limite de ${p.maxTasks} tarefa(s) na ausência segura o resto da fila.`);
  return { allowedProjects, actions, willRun, willWait, nextRoutine, warnings };
}

/** Patch de ajustes ao salvar: `since` marca quando o modo foi ligado (conta o limite e monta o resumo de ausência). */
export function absencePatch(prev: AbsencePolicy, next: AbsencePolicy, now: number): AbsencePolicy {
  return { ...next, since: next.enabled ? (prev.enabled && prev.since ? prev.since : now) : null };
}

/** Como cada situação foi conferida nesta instalação. */
export type Evidence = 'ao vivo' | 'simulado' | 'não testado';

/** O que acontece com o trabalho em cada situação da máquina. */
export const MACHINE_CONDITIONS: { situation: string; effect: string; verified: Evidence }[] = [
  { situation: 'Fechar o navegador ou a aba', effect: 'Continua. A execução é do serviço, não da página.', verified: 'ao vivo' },
  { situation: 'Fechar a janela do start-hq.cmd', effect: 'Continua. O serviço roda em segundo plano, sem janela.', verified: 'ao vivo' },
  { situation: 'Bloquear a tela (Win+L)', effect: 'Deve continuar: o serviço segue na sua sessão. Ferramentas que precisam da área de trabalho visível (cliques, navegador na tela) não funcionam bloqueadas.', verified: 'não testado' },
  { situation: 'Sair da conta do Windows', effect: 'Para: o serviço roda na sua sessão. Volta no próximo logon se "Iniciar com o Windows" estiver ligado; o que rodava vira "resultado a conferir" ou volta à fila.', verified: 'não testado' },
  { situation: 'Suspender ou hibernar', effect: 'Tudo pausa até o computador acordar. Rotinas com horário perdido seguem a regra de cada uma. Para trabalhar de madrugada, ajuste o plano de energia (Suspender: Nunca, na tomada).', verified: 'não testado' },
  { situation: 'Desligar ou reiniciar', effect: 'Para. Nada roda com o computador desligado.', verified: 'não testado' },
  { situation: 'Sem internet', effect: 'A fila espera e tenta de novo depois de 1, 2, 5, 10 e 15 minutos.', verified: 'simulado' },
  { situation: 'Limite de uso da assinatura', effect: 'A fila do provedor espera até o horário de volta e retoma sozinha.', verified: 'simulado' },
];
