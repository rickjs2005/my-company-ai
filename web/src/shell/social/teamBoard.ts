// Dados de cada equipe da Social Media (08/11): funções puras sobre o estado real. A equipe é o perfil gravado na tarefa,
// na peça e na referência (ou, sem perfil, a equipe do canal). Nada de uma equipe aparece no painel da outra.
import type { ContentItem, Employee, PendingPermission, RadarItem, Task } from '@milweb-hq/protocol';
import { TEAMS, teamOfEmployee, teamOfWork, type TeamId } from '@milweb-hq/protocol';

export type ChannelFilter = 'all' | string;

const inChannel = (slot: string | null | undefined, ch: ChannelFilter) => ch === 'all' || slot === ch;

/** Integrantes da equipe (pelo perfil) e especialistas de apoio (atendem as duas). Ordem = assento persistente. */
export function teamMembers(employees: Employee[], team: TeamId, roomId: string | null): { members: Employee[]; support: Employee[]; unassigned: Employee[] } {
  const room = employees.filter(e => !e.archivedAt && (!roomId || e.roomId === roomId));
  const bySeat = (a: Employee, b: Employee) => a.deskIndex - b.deskIndex || a.createdAt - b.createdAt;
  return {
    members: room.filter(e => teamOfEmployee(e) === team).sort(bySeat),
    support: room.filter(e => teamOfEmployee(e) === 'apoio').sort(bySeat),
    unassigned: room.filter(e => teamOfEmployee(e) === null),
  };
}

export function teamTasks(tasks: Task[], team: TeamId, ch: ChannelFilter = 'all'): Task[] {
  return tasks.filter(t => teamOfWork(t) === team && inChannel(t.destinationId, ch)).sort((a, b) => b.createdAt - a.createdAt);
}
export function teamItems(items: ContentItem[], team: TeamId, ch: ChannelFilter = 'all'): ContentItem[] {
  return items.filter(i => !i.deletedAt && !i.archivedAt && teamOfWork(i) === team && inChannel(i.slot, ch));
}
export function teamRefs(radar: RadarItem[], team: TeamId, ch: ChannelFilter = 'all'): RadarItem[] {
  return radar.filter(r => { const slot = r.video?.slot ?? r.slot ?? null; return !!r.video && r.video.stage !== 'lixeira' && teamOfWork({ slot }) === team && inChannel(slot, ch); });
}

export interface TeamSummary { running: number; queued: number; review: number; blocked: number }

/** Resumo só com dados reais: execução e fila (tarefas), revisão (peças esperando o Chefe ou o ajuste) e bloqueios. */
export function teamSummary(team: TeamId, d: { tasks: Task[]; items: ContentItem[]; pending: PendingPermission[] }): TeamSummary {
  const tasks = teamTasks(d.tasks, team);
  const items = teamItems(d.items, team);
  const taskIds = new Set(tasks.map(t => t.id));
  return {
    running: tasks.filter(t => t.status === 'running').length,
    queued: tasks.filter(t => t.status === 'queued').length,
    review: items.filter(i => i.status === 'revisar' || i.status === 'ajustar').length,
    blocked: items.filter(i => i.status === 'parcial' || i.status === 'falhou').length + d.pending.filter(p => p.taskId && taskIds.has(p.taskId)).length,
  };
}
export function summaryText(s: TeamSummary): string {
  return `${s.running} em execução · ${s.queued} na fila · ${s.review} em revisão · ${s.blocked} ${s.blocked === 1 ? 'bloqueio' : 'bloqueios'}`;
}

/** Equipe sugerida para um pedido geral pelo texto (o Chefe confirma na tela): Tuco, Aurora ou as duas. */
export function suggestTeams(text: string): TeamId[] {
  const t = text.toLowerCase();
  const goj = /tuco/.test(t);
  const mil = /aurora|threads/.test(t);
  if (goj && !mil) return ['tuco-dev'];
  if (mil && !goj) return ['aurora'];
  return TEAMS.map(x => x.id);
}
