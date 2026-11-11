// Painel da sala (mural/quadro): funcionários da sala com estado real, projetos e tarefas recentes das conversas da sala.
// A sala de Reuniões é diferente: ninguém trabalha nela, então o painel mostra as reuniões e leva para a tela de Reuniões.
import { useMemo } from 'react';
import type { Employee, Meeting, Project, Room, Session, Task, Worker } from '@milweb-hq/protocol';
import { basename, formatTime, taskStatusLabel, truncate, workerStatusColor, workerStatusLabel } from '../panel/helpers';
import { IconEdit, IconPlus, IconX } from '../panel/icons';
import { meetingStatusLabel } from '../meetings/helpers';

export interface RoomPanelProps {
  room: Room;
  employees: Employee[];
  workers: Worker[];
  sessions: Session[];
  projects: Project[];
  tasks: Task[];
  onClose(): void;
  onOpenEmployee(id: string): void;
  onNewEmployee(roomId: string): void;
  onNewConversation(roomId: string, projectId: string | null): void;
  onAddProject(roomId: string): void;
  onEditRoom(roomId: string): void;
  onOpenFiles(projectId: string): void;
  /** "Dar tarefa": preenche o compositor com o funcionário escolhido. */
  onGiveTask?(employeeId: string): void;
  /** Sala de Reuniões: lista de reuniões e atalho para a tela de Reuniões (id = abrir uma reunião específica). */
  meetings?: Meeting[];
  onOpenMeetings?(meetingId: string | null): void;
  /** Mesa de reunião (sala Social Media): quem pode participar agora, com o estado real de cada provedor. */
  availability?: { name: string; ok: boolean; detail: string }[];
}

const TASK_CLS: Record<string, string> = { done: 'hq-tag--ok', error: 'hq-tag--danger', lost: 'hq-tag--danger', interrupted: 'hq-tag--warn', running: 'hq-tag--amber', waiting_permission: 'hq-tag--warn', waiting_answer: 'hq-tag--warn', queued: 'hq-tag--info' };
const MEETING_CLS: Record<string, string> = { active: 'hq-tag--amber', paused: 'hq-tag--warn', ended: 'hq-tag--ok', draft: '' };

export function RoomPanel(props: RoomPanelProps) {
  const { room, employees, workers, sessions, projects, tasks } = props;
  const isMeeting = room.kind === 'meeting';
  const roomEmployees = useMemo(() => employees.filter(e => !e.archivedAt && e.roomId === room.id), [employees, room.id]);
  const roomProjects = useMemo(() => projects.filter(p => p.roomId === room.id && !p.id.startsWith('ext:')), [projects, room.id]);
  const roomSessionIds = useMemo(() => new Set(sessions.filter(s => s.roomId === room.id).map(s => s.id)), [sessions, room.id]);
  const roomTasks = useMemo(() => tasks.filter(t => roomSessionIds.has(t.sessionId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12), [tasks, roomSessionIds]);
  const employeeBySession = useMemo(() => new Map(sessions.map(s => [s.id, employees.find(e => e.id === s.employeeId)?.name ?? s.name])), [sessions, employees]);
  const meetings = useMemo(() => [...(props.meetings ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10), [props.meetings]);

  const totalMeetings = props.meetings?.length ?? 0;
  const subtitle = isMeeting
    ? (totalMeetings === 0 ? 'nenhuma reunião' : `${totalMeetings} ${totalMeetings === 1 ? 'reunião' : 'reuniões'}`)
    : `${roomEmployees.length} funcionário${roomEmployees.length === 1 ? '' : 's'}`;

  return (
    <aside className="hq-panel hq-panel--room" style={{ width: 420 }} aria-label={`Sala ${room.name}`}>
      <header className="hq-panel__head">
        <div className="hq-panel__who">
          <span className="hq-room__dot" style={{ ['--room' as string]: room.color, marginTop: 6 }} />
          <div className="hq-panel__names">
            <div className="hq-panel__name">{room.name}<span className="hq-panel__role">{subtitle}</span></div>
            <div className="hq-panel__project" title={room.instructions.trim() || undefined}>{room.instructions.trim() ? truncate(room.instructions, 90) : <span className="hq-dim">Sem instruções de sala.</span>}</div>
          </div>
          <button type="button" className="hq-iconbtn hq-iconbtn--xs" onClick={() => props.onEditRoom(room.id)} aria-label="Editar sala" title="Editar sala"><IconEdit size={13} /></button>
          <button type="button" className="hq-iconbtn" onClick={props.onClose} aria-label="Fechar painel"><IconX size={16} /></button>
        </div>
      </header>
      <div className="hq-panel__body hq-panel__body--scroll">
        {isMeeting ? (
          <>
          {props.availability && (
            <section className="hq-section">
              <h3 className="hq-label">Quem pode participar agora</h3>
              <ul className="hq-soc-avail">
                <li><span className="hq-status-dot" style={{ background: 'var(--ok)' }} /> <strong>Chefe</strong> <span className="hq-dim">· você conduz a pauta</span></li>
                {props.availability.map(a => <li key={a.name}><span className="hq-status-dot" style={{ background: a.ok ? 'var(--ok)' : 'var(--text-faint)' }} /> <strong>{a.name}</strong> <span className="hq-dim">· {a.detail}</span></li>)}
              </ul>
            </section>
          )}
          <section className="hq-section">
            <h3 className="hq-label">Reuniões</h3>
            {meetings.length === 0 && <p className="hq-empty">Nenhuma reunião ainda. Aqui você, o Claude e o ChatGPT discutem uma pauta e saem com decisões e tarefas.</p>}
            <ul className="hq-list">
              {meetings.map(m => (
                <li key={m.id} className="hq-list__item">
                  <button type="button" className="hq-list__btn" onClick={() => props.onOpenMeetings?.(m.id)}>
                    <span className={`hq-tag hq-tag--xs ${MEETING_CLS[m.status] ?? ''}`}>{meetingStatusLabel(m.status)}</span>
                    <span className="hq-list__text"><strong>{truncate(m.title || 'Reunião sem título', 60)}</strong><span className="hq-dim hq-list__sub">{m.participants.map(p => p.name).join(', ') || 'sem participantes'} · {formatTime(m.updatedAt)}</span></span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="hq-actions">
              <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => props.onOpenMeetings?.(null)}>Abrir Reuniões</button>
            </div>
          </section>
          </>
        ) : (
          <>
            <section className="hq-section">
              <h3 className="hq-label">Mural · quem está na sala</h3>
              {roomEmployees.length === 0 && <p className="hq-empty">Nenhum funcionário nesta sala.</p>}
              <ul className="hq-list">
                {roomEmployees.map(e => {
                  const w = workers.find(x => x.id === e.id);
                  return (
                    <li key={e.id} className="hq-list__item">
                      <button type="button" className="hq-list__btn" onClick={() => props.onOpenEmployee(e.id)}>
                        <span className="hq-status-dot" style={{ background: workerStatusColor(w?.status) }} />
                        <span className="hq-list__text"><strong>{e.name}</strong> <span className="hq-dim">· {e.role}</span><span className="hq-dim hq-list__sub">{workerStatusLabel(w?.status)}{w?.detail && w.status !== 'idle' ? ` · ${w.detail}` : ''}</span></span>
                      </button>
                      {props.onGiveTask && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.onGiveTask!(e.id)} title="Preenche o pedido na base da tela com este funcionário">Dar tarefa</button>}
                    </li>
                  );
                })}
              </ul>
              <div className="hq-actions">
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => props.onNewEmployee(room.id)}><IconPlus size={12} /> Contratar funcionário</button>
                {roomEmployees.length > 0 && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.onNewConversation(room.id, roomProjects[0]?.id ?? null)}>Nova conversa</button>}
              </div>
            </section>
            <section className="hq-section">
              <h3 className="hq-label">Projetos da sala</h3>
              {roomProjects.length === 0 && <p className="hq-empty">Nenhum projeto nesta sala.</p>}
              <ul className="hq-list">
                {roomProjects.map(p => (
                  <li key={p.id} className="hq-list__item">
                    <span className="hq-list__text"><strong>{p.name}</strong><span className="hq-dim hq-mono hq-list__sub" title={p.path}>{basename(p.path)}</span></span>
                    <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.onOpenFiles(p.id)}>Arquivos</button>
                  </li>
                ))}
              </ul>
              <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm" onClick={() => props.onAddProject(room.id)}><IconPlus size={12} /> Cadastrar pasta de projeto</button></div>
            </section>
            <section className="hq-section">
              <h3 className="hq-label">Tarefas recentes</h3>
              {roomTasks.length === 0 && <p className="hq-empty">Nenhuma tarefa nesta sala ainda. Escreva o pedido em “O que vamos fazer?”, embaixo.</p>}
              <ul className="hq-list">
                {roomTasks.map(t => (
                  <li key={t.id} className="hq-list__item hq-list__item--task">
                    <span className={`hq-tag hq-tag--xs ${TASK_CLS[t.status] ?? ''}`}>{taskStatusLabel(t.status)}</span>
                    <span className="hq-list__text"><span>{truncate(t.prompt, 80)}</span><span className="hq-dim hq-list__sub">{employeeBySession.get(t.sessionId) ?? '?'} · {formatTime(t.createdAt)}</span></span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
