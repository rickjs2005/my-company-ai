// Conhecimento da equipe: funções puras da tela (rótulos, filtros, alcance e o que cada pessoa já demonstrou).
// Nada aqui inventa nível ou porcentagem: os indicadores contam registros reais (orientações ativas, exercícios, aprovações).
import { TEAMS, isTeamId, teamDef, teamOfEmployee, DEFAULT_ROLE_TEMPLATES } from '@milweb-hq/protocol';
import type { AcademyTechnique, DeskDelivery, Employee, KnowledgeBoard, KnowledgeItem, KnowledgeScope, KnowledgeUse, Project, Task } from '@milweb-hq/protocol';

export type KnowledgeTab = 'vigentes' | 'propostos' | 'historico';

export function scopeKey(s: KnowledgeScope): string { return s.type === 'empresa' ? 'empresa' : `${s.type}:${s.id ?? ''}`; }
export function parseScopeKey(k: string): KnowledgeScope {
  if (k === 'empresa' || !k.includes(':')) return { type: 'empresa', id: null };
  const i = k.indexOf(':');
  return { type: k.slice(0, i) as KnowledgeScope['type'], id: k.slice(i + 1) };
}

export function templateLabel(id: string | null): string {
  return DEFAULT_ROLE_TEMPLATES.find(t => t.id === id)?.name ?? id ?? 'função';
}

export function scopeLabel(s: KnowledgeScope, ctx: { employees: Employee[]; projects: Project[] }): string {
  if (s.type === 'empresa') return 'Empresa (todos)';
  if (s.type === 'equipe') return isTeamId(s.id) ? teamDef(s.id).label : 'Equipe';
  if (s.type === 'projeto') return `Projeto ${ctx.projects.find(p => p.id === s.id)?.name ?? '(removido)'}`;
  if (s.type === 'funcionario') return ctx.employees.find(e => e.id === s.id)?.name ?? 'Funcionário (removido)';
  return `Função: ${templateLabel(s.id)}`;
}

/** Opções do seletor "vale para": empresa, as duas equipes, funções que existem na equipe, funcionários ativos e projetos. */
export function scopeOptions(employees: Employee[], projects: Project[]): { key: string; label: string; group: string }[] {
  const active = employees.filter(e => !e.archivedAt);
  const templates = [...new Set(active.map(e => e.template).filter((t): t is string => Boolean(t)))];
  return [
    { key: 'empresa', label: 'Empresa (todos)', group: 'Geral' },
    ...TEAMS.map(t => ({ key: `equipe:${t.id}`, label: t.label, group: 'Equipe' })),
    ...templates.map(t => ({ key: `funcao:${t}`, label: templateLabel(t), group: 'Função' })),
    ...active.map(e => ({ key: `funcionario:${e.id}`, label: `${e.name} · ${e.role}`, group: 'Funcionário' })),
    ...projects.filter(p => !p.id.startsWith('ext:')).map(p => ({ key: `projeto:${p.id}`, label: p.name, group: 'Projeto' })),
  ];
}

/** Versão que vale de cada ensinamento (ativa, proposta ou desativada); as substituídas ficam no histórico da própria ficha. */
export function currentItems(board: KnowledgeBoard | null): KnowledgeItem[] {
  return (board?.items ?? []).filter(i => i.state !== 'substituido');
}
export function versionsOf(board: KnowledgeBoard | null, item: KnowledgeItem): KnowledgeItem[] {
  return (board?.items ?? []).filter(i => i.chainId === item.chainId && i.id !== item.id).sort((a, b) => b.version - a.version);
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function filterItems(board: KnowledgeBoard | null, f: { tab: KnowledgeTab; scope: string; query: string }): KnowledgeItem[] {
  const q = norm(f.query.trim());
  return currentItems(board)
    .filter(i => (f.tab === 'vigentes' ? i.state === 'ativo' : f.tab === 'propostos' ? i.state === 'proposto' : i.state === 'desativado'))
    .filter(i => !f.scope || scopeKey(i.scope) === f.scope)
    .filter(i => !q || norm(`${i.title} ${i.text} ${i.originNote ?? ''}`).includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function tabCounts(board: KnowledgeBoard | null): Record<KnowledgeTab, number> {
  const cur = currentItems(board);
  return { vigentes: cur.filter(i => i.state === 'ativo').length, propostos: cur.filter(i => i.state === 'proposto').length, historico: cur.filter(i => i.state === 'desativado').length };
}

/** Usos de um ensinamento (todas as versões), do mais recente para o mais antigo. */
export function usesOf(board: KnowledgeBoard | null, item: KnowledgeItem): KnowledgeUse[] {
  return (board?.recentUses ?? []).filter(u => u.chainId === item.chainId).sort((a, b) => b.at - a.at);
}
/** Conhecimento que uma tarefa recebeu (para o detalhe da entrega). */
export function usesOfTask(board: KnowledgeBoard | null, taskId: string | null | undefined): KnowledgeUse[] {
  if (!taskId) return [];
  return (board?.recentUses ?? []).filter(u => u.taskId === taskId);
}

/** O item alcança este funcionário? (empresa, a equipe dele, a função dele ou ele mesmo). Apoio recebe o da equipe só na tarefa dela. */
export function reaches(item: KnowledgeItem, e: Employee): boolean {
  const s = item.scope;
  if (s.type === 'empresa') return true;
  if (s.type === 'equipe') return teamOfEmployee(e) === s.id;
  if (s.type === 'funcao') return e.template === s.id;
  if (s.type === 'funcionario') return e.id === s.id;
  return false;
}

export interface Demonstrated {
  employee: Employee;
  team: string;
  /** Orientações ativas que acompanham os pedidos desta pessoa. */
  guidance: number;
  /** Tarefas em que recebeu algum conhecimento registrado. */
  applied: number;
  /** Exercícios da Academia produzidos por ela / validados pelo Diretor de Vídeo. */
  exercises: number;
  validated: number;
  /** Entregas dela que você aprovou na Minha mesa. */
  approved: number;
  delivered: number;
}

/** O que cada pessoa já demonstrou NA PRÁTICA, só com registros: ter skill instalada não entra aqui. */
export function demonstrated(employees: Employee[], board: KnowledgeBoard | null, deliveries: DeskDelivery[], techniques: AcademyTechnique[], tasks: Task[]): Demonstrated[] {
  const active = currentItems(board).filter(i => i.state === 'ativo');
  const taskEmp = new Map(tasks.map(t => [t.id, t.employeeId ?? null]));
  return employees.filter(e => !e.archivedAt).map(e => {
    const team = teamOfEmployee(e);
    const ex = techniques.flatMap(t => t.examples).filter(x => x.employee === e.name);
    const mine = deliveries.filter(d => d.employeeId === e.id);
    const applied = new Set((board?.recentUses ?? []).filter(u => (u.employeeId ?? taskEmp.get(u.taskId)) === e.id).map(u => u.taskId)).size;
    return {
      employee: e, team: team === 'apoio' ? 'Apoio às duas' : team ? teamDef(team).short : 'Sem equipe',
      guidance: active.filter(i => reaches(i, e)).length, applied,
      exercises: ex.length, validated: ex.filter(x => x.verdict === 'ok').length,
      approved: mine.filter(d => d.status === 'aprovada').length, delivered: new Set(mine.map(d => d.rootTaskId)).size,
    };
  }).sort((a, b) => a.team.localeCompare(b.team) || a.employee.name.localeCompare(b.employee.name));
}

/** Resumo do trabalho desde a última visita, contado nas tarefas persistidas (nenhuma chamada de IA). */
export function sinceLastVisit(tasks: Task[], since: number | null): { since: number | null; done: number; running: number; queued: number; waiting: number; failed: number } {
  const real = tasks.filter(t => !t.id.startsWith('ext:'));
  const after = (ts: number | null | undefined) => since == null || (ts != null && ts >= since);
  return {
    since,
    done: real.filter(t => t.status === 'done' && after(t.finishedAt)).length,
    failed: real.filter(t => ['error', 'lost'].includes(t.status) && after(t.finishedAt)).length,
    running: real.filter(t => t.status === 'running').length,
    queued: real.filter(t => t.status === 'queued' && !t.held).length,
    waiting: real.filter(t => t.status === 'queued' && t.held).length,
  };
}
