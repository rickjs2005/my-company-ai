// Sessões iniciadas fora da HQ (terminal do Chefe, sessões em segundo plano): só observadas, nunca controladas.
// Fonte oficial: `claude agents --json` (interactive: pid/status; background: state).
import { initialActivity } from '@milweb-hq/claude-bridge';
import type { Project, Session, Worker } from '@milweb-hq/protocol';
import { listClaudeAgents, type ExternalAgent } from './claude-info.js';
import type { Store } from './store.js';
import { normalizePath } from './store.js';
import { appearanceFor } from './names.js';
import { log } from './log.js';

export interface ExternalView { sessions: Session[]; workers: Worker[]; virtualProjects: Project[] }

export class ExternalObserver {
  private last: ExternalView = { sessions: [], workers: [], virtualProjects: [] };
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(private store: Store, private exePath: () => string | null, private onChange: (view: ExternalView) => void) {}

  current(): ExternalView { return this.last; }

  start(intervalMs = 15_000) { this.stop(); this.refresh().catch(() => { /* ignorar */ }); this.timer = setInterval(() => { this.refresh().catch(() => { /* ignorar */ }); }, intervalMs); this.timer.unref?.(); }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async refresh(): Promise<ExternalView> {
    if (this.inFlight) return this.last;
    this.inFlight = true;
    try {
      const exe = this.exePath(); if (!exe) return this.last;
      const agents = await listClaudeAgents(exe);
      const own = new Set(this.store.listAllSessions().map(s => s.claudeSessionId).filter(Boolean));
      const ownIds = new Set(this.store.listAllSessions().map(s => s.id));
      const view = this.toView(agents.filter(a => a.sessionId && !own.has(a.sessionId) && !ownIds.has(a.sessionId)));
      const changed = JSON.stringify(view.workers.map(w => [w.id, w.phase, w.detail])) !== JSON.stringify(this.last.workers.map(w => [w.id, w.phase, w.detail]));
      this.last = view;
      if (changed) this.onChange(view);
      return view;
    } catch (err) {
      log.debug('observação externa falhou', err);
      return this.last;
    } finally { this.inFlight = false; }
  }

  private toView(agents: ExternalAgent[]): ExternalView {
    const rooms = this.store.listRooms();
    const fallbackRoom = rooms.find(r => r.kind === 'management') ?? rooms[0];
    const projects = this.store.listProjects();
    const sessions: Session[] = []; const workers: Worker[] = []; const virtualProjects: Project[] = [];
    // Mesa livre na sala, contando as dos funcionários da HQ (antes uma sessão observada podia cair na cadeira de um
    // funcionário e os dois personagens ficavam sobrepostos). Sem mesa livre: fica de pé na sala (deskIndex -1).
    const used = new Map<string, number[]>();
    const freeDesk = (roomId: string): number => {
      if (!used.has(roomId)) used.set(roomId, this.store.listEmployeesByRoom(roomId).map(e => e.deskIndex));
      const taken = used.get(roomId)!;
      for (let i = 3; i >= 0; i--) if (!taken.includes(i)) { taken.push(i); return i; }
      return -1;
    };
    for (const a of agents) {
      if (a.kind === 'background' && a.state && a.state !== 'working' && a.state !== 'blocked') continue; // concluídas/falhas não aparecem como funcionários
      const project = projects.find(p => normalizePath(p.path) === normalizePath(a.cwd));
      const roomId = project?.roomId ?? fallbackRoom?.id ?? '';
      let projectId = project?.id ?? '';
      if (!project) {
        projectId = 'ext:' + normalizePath(a.cwd);
        if (!virtualProjects.some(p => p.id === projectId)) virtualProjects.push({ id: projectId, name: a.cwd.split(/[\\/]/).filter(Boolean).pop() ?? a.cwd, path: a.cwd, roomId, createdAt: a.startedAt ?? 0, lastUsedAt: a.startedAt ?? 0 });
      }
      const activity = initialActivity();
      const st = a.kind === 'interactive' ? a.status : a.state;
      if (st === 'busy' || st === 'working') { activity.phase = 'thinking'; activity.detail = 'Ocupado no terminal'; activity.turnActive = true; }
      else if (st === 'waiting' || st === 'blocked') { activity.phase = 'waiting_permission'; activity.detail = 'Aguardando no terminal'; }
      else { activity.phase = 'idle'; activity.detail = 'Ocioso no terminal'; }
      const id = a.sessionId;
      const name = a.name || (a.kind === 'background' ? 'Sessão em segundo plano' : 'Terminal do Chefe');
      sessions.push({ id, claudeSessionId: a.sessionId, employeeId: null, roomId, projectId, name, model: null, permissionMode: 'default', status: 'observed', controllable: false, processState: null, activity, createdAt: a.startedAt ?? 0, lastActiveAt: Date.now() });
      workers.push({ id, kind: 'observed', employeeId: null, sessionId: id, roomId, projectId, name: a.kind === 'background' ? 'Agente (2º plano)' : 'Terminal (observado)', role: a.kind === 'background' ? 'Sessão em segundo plano' : 'Sessão externa', appearance: appearanceFor(id), deskIndex: freeDesk(roomId), phase: activity.phase, detail: activity.detail, status: 'observed', controllable: false, busy: activity.turnActive });
    }
    return { sessions, workers, virtualProjects };
  }
}
