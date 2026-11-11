// Barra lateral: salas com contagem de funcionários, sessões por sala, projetos e ações.
import { useMemo, useState } from 'react';
import type { Room, Session, Worker } from '@milweb-hq/protocol';
import type { SidebarProps } from './types';
import { basename, phaseColor, phaseLabel, sessionStatusLabel } from './helpers';
import { IconChevron, IconEdit, IconEye, IconFolder, IconPlus, IconSettings } from './icons';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

const STATUS_CLS: Record<Session['status'], string> = {
  new: 'hq-tag--info', active: 'hq-tag--ok', paused: '', observed: 'hq-tag--amber', lost: 'hq-tag--danger', archived: '',
};

const WAITING = new Set(['waiting_permission', 'waiting_answer']);

function counts(workers: Worker[]) {
  let active = 0, waiting = 0;
  for (const w of workers) {
    if (WAITING.has(w.phase)) waiting++;
    else if (w.busy) active++;
  }
  return { active, waiting, total: workers.length };
}

export function Sidebar(props: SidebarProps) {
  const { rooms, projects, sessions, workers, selectedRoomId, selectedSessionId, connected, serverInfo } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const sortedRooms = useMemo(() => [...rooms].sort((a, b) => a.order - b.order), [rooms]);
  const workerBySession = useMemo(() => new Map(workers.map(w => [w.sessionId, w])), [workers]);

  const toggle = (id: string) => setCollapsed(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <nav className="hq-sidebar" aria-label="Salas e sessões">
      <div className="hq-sidebar__brand">
        <span className="pixel hq-sidebar__logo">My Company AI</span>
        <span className={cx('hq-conn', connected ? 'hq-conn--on' : 'hq-conn--off')} title={connected ? 'Conectado ao servidor local' : 'Sem conexão com o servidor'}>
          <span className="hq-conn__dot" />{connected ? 'conectado' : 'desconectado'}
        </span>
      </div>

      <div className="hq-sidebar__rooms">
        {sortedRooms.map(room => {
          const roomWorkers = workers.filter(w => w.roomId === room.id);
          const c = counts(roomWorkers);
          const roomSessions = sessions.filter(s => s.roomId === room.id && s.status !== 'archived');
          const roomProjects = projects.filter(p => p.roomId === room.id);
          const open = !collapsed.has(room.id);
          const selected = room.id === selectedRoomId;
          return (
            <section key={room.id} className={cx('hq-room', selected && 'hq-room--sel')} style={{ ['--room' as string]: room.color }}>
              <div className="hq-room__head">
                <button type="button" className="hq-room__toggle" onClick={() => toggle(room.id)} aria-expanded={open} aria-label={`${open ? 'Recolher' : 'Expandir'} sala ${room.name}`}>
                  <IconChevron size={12} open={open} />
                </button>
                <button type="button" className="hq-room__name" onClick={() => props.onSelectRoom(room.id)} aria-current={selected ? 'true' : undefined}>
                  <span className="hq-room__dot" />
                  <span>{room.name}</span>
                </button>
                <span className="hq-room__counts" title={`${c.active} trabalhando, ${c.waiting} esperando você, ${c.total} no total`}>
                  {c.active > 0 && <span className="hq-count hq-count--active">{c.active}</span>}
                  {c.waiting > 0 && <span className="hq-count hq-count--waiting">{c.waiting}</span>}
                  {c.active === 0 && c.waiting === 0 && <span className="hq-count">{c.total}</span>}
                </span>
                <button type="button" className="hq-iconbtn hq-iconbtn--xs" onClick={() => props.onEditRoom(room.id)} aria-label={`Editar sala ${room.name}`} title="Editar sala"><IconEdit size={13} /></button>
              </div>
              {open && (
                <div className="hq-room__body">
                  {roomSessions.length === 0 && <div className="hq-room__hint">Nenhuma sessão nesta sala.</div>}
                  <ul className="hq-sessions">
                    {roomSessions.map(s => <SessionRow key={s.id} session={s} worker={workerBySession.get(s.id)} project={projects.find(p => p.id === s.projectId)?.name} selected={s.id === selectedSessionId} onSelect={() => props.onSelectSession(s.id)} />)}
                  </ul>
                  {roomProjects.length > 0 && (
                    <ul className="hq-projects" aria-label={`Projetos da sala ${room.name}`}>
                      {roomProjects.map(p => (
                        <li key={p.id} className="hq-project" title={p.path}>
                          <IconFolder size={12} /><span className="hq-project__name">{p.name}</span><span className="hq-dim hq-mono">{basename(p.path)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="hq-room__actions">
                    <button type="button" className="hq-btn hq-btn--sm" onClick={() => props.onNewSession(room.id, roomProjects[0]?.id ?? null)}><IconPlus size={12} /> Nova sessão</button>
                    <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.onAddProject(room.id)}><IconFolder size={12} /> Adicionar projeto</button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="hq-sidebar__foot">
        <div className="hq-sidebar__info">
          <span title={serverInfo?.claudeExePath ?? ''}>Claude Code {serverInfo?.claudeVersion ?? '—'}</span>
          <span className="hq-dim">HQ {serverInfo?.version ?? '—'}</span>
        </div>
        <button type="button" className="hq-iconbtn" onClick={props.onOpenSettings} aria-label="Configurações" title="Configurações"><IconSettings size={16} /></button>
      </div>
    </nav>
  );
}

function SessionRow({ session, worker, project, selected, onSelect }: { session: Session; worker?: Worker; project?: string; selected: boolean; onSelect(): void }) {
  const phase = worker?.phase ?? session.activity.phase;
  return (
    <li>
      <button type="button" className={cx('hq-session', selected && 'hq-session--sel')} onClick={onSelect} aria-current={selected ? 'true' : undefined} title={`${session.name} · ${project ?? ''} · ${phaseLabel(phase)}`}>
        <span className="hq-session__phase" style={{ background: phaseColor(phase) }} />
        <span className="hq-session__body">
          <span className="hq-session__name">{worker?.name ?? session.name}</span>
          <span className="hq-session__detail">{worker?.detail ?? session.activity.detail}</span>
        </span>
        {session.status === 'observed' && <IconEye size={13} className="hq-session__eye" title="Sessão observada (iniciada fora da HQ)" />}
        <span className={cx('hq-tag hq-tag--xs', STATUS_CLS[session.status])}>{sessionStatusLabel(session.status)}</span>
      </button>
    </li>
  );
}
