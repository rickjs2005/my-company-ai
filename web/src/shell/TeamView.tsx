// Equipe: todos os funcionários (identidade persistente), com o estado REAL de cada um e as ações de cadastro.
// Nada aqui inicia processo: abrir conversa, editar e arquivar são pedidos ao servidor que respondem com o que aconteceu.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Employee, Project, Room, Session, Worker } from '@milweb-hq/protocol';
import { basename, sessionStatusLabel, workerStatusColor, workerStatusLabel } from '../panel/helpers';
import { IconEdit, IconPlus } from '../panel/icons';

export interface TeamViewProps {
  employees: Employee[];
  workers: Worker[];
  rooms: Room[];
  sessions: Session[];
  projects: Project[];
  selectedEmployeeId: string | null;
  onOpen(employeeId: string): void;
  onEdit(employeeId: string): void;
  onArchive(employeeId: string): void;
  onUnarchive(employeeId: string): void;
  onNewConversation(employeeId: string): void;
  onNew(roomId: string | null): void;
  /** "Dar tarefa": preenche o compositor "O que vamos fazer?" com este funcionário (não cria nada sozinho). */
  onGiveTask?(employeeId: string): void;
  /** Área "Conhecimento da equipe" (aba ao lado das pessoas). */
  knowledge?: ReactNode;
  /** Quantas propostas esperam o Chefe (selo na aba). */
  knowledgePending?: number;
  /** Muda quando outra tela pede para abrir direto no conhecimento (ex.: "Ensinar" no painel do funcionário). */
  knowledgeNonce?: number;
  /** "Ensinar": abre o conhecimento filtrado nesta pessoa. */
  onTeach?(employeeId: string): void;
}

export function TeamView(props: TeamViewProps) {
  const { employees, workers, rooms, sessions, projects, selectedEmployeeId } = props;
  const roomById = useMemo(() => new Map(rooms.map(r => [r.id, r])), [rooms]);
  const workerById = useMemo(() => new Map(workers.map(w => [w.id, w])), [workers]);
  const sessionById = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);
  const projectById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const active = useMemo(() => employees.filter(e => !e.archivedAt).sort((a, b) => (roomById.get(a.roomId)?.order ?? 0) - (roomById.get(b.roomId)?.order ?? 0) || a.name.localeCompare(b.name)), [employees, roomById]);
  const archived = useMemo(() => employees.filter(e => e.archivedAt).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)), [employees]);
  const observed = useMemo(() => workers.filter(w => w.kind === 'observed'), [workers]);
  const [tab, setTab] = useState<'pessoas' | 'conhecimento'>(props.knowledgeNonce ? 'conhecimento' : 'pessoas');
  useEffect(() => { if (props.knowledgeNonce) setTab('conhecimento'); }, [props.knowledgeNonce]);
  const conversationsOf = (id: string) => sessions.filter(s => s.employeeId === id && s.status !== 'archived').length;

  return (
    <section className="hq-view" aria-label="Equipe">
      <header className="hq-view__head">
        <h2>Equipe</h2>
        {props.knowledge && (
          <div role="tablist" className="hq-know__tabs">
            <button type="button" role="tab" aria-selected={tab === 'pessoas'} className={`hq-home-chip${tab === 'pessoas' ? ' is-on' : ''}`} onClick={() => setTab('pessoas')}>Pessoas</button>
            <button type="button" role="tab" aria-selected={tab === 'conhecimento'} className={`hq-home-chip${tab === 'conhecimento' ? ' is-on' : ''}`} onClick={() => setTab('conhecimento')}>Conhecimento da equipe{props.knowledgePending ? ` (${props.knowledgePending} proposta${props.knowledgePending === 1 ? '' : 's'})` : ''}</button>
          </div>
        )}
        <span className="hq-dim">{active.length} funcionário{active.length === 1 ? '' : 's'} · {workers.filter(w => w.kind === 'employee' && w.busy).length} executando</span>
        <span className="hq-view__spacer" />
        <button type="button" className="hq-btn hq-btn--primary hq-btn--sm" onClick={() => props.onNew(null)}><IconPlus size={12} /> Funcionário</button>
      </header>
      {tab === 'conhecimento' && props.knowledge ? props.knowledge : <>

      {active.length === 0 ? (
        <div className="hq-empty hq-empty--tall">
          <p>Nenhum funcionário ainda.</p>
          <p className="hq-dim">Contrate o primeiro: ele ganha nome, mesa e sala, e só começa a trabalhar quando você abrir uma conversa.</p>
          <button type="button" className="hq-btn hq-btn--primary" onClick={() => props.onNew(null)}><IconPlus size={12} /> Contratar funcionário</button>
        </div>
      ) : (
        <table className="hq-table">
          <thead>
            <tr><th>Funcionário</th><th>Sala</th><th>Estado</th><th>Conversa ativa</th><th>Projeto</th><th className="hq-table__actions">Ações</th></tr>
          </thead>
          <tbody>
            {active.map(e => {
              const w = workerById.get(e.id);
              const s = e.activeSessionId ? sessionById.get(e.activeSessionId) ?? null : null;
              const p = s ? projectById.get(s.projectId) ?? null : null;
              const room = roomById.get(e.roomId);
              const n = conversationsOf(e.id);
              return (
                <tr key={e.id} className={e.id === selectedEmployeeId ? 'hq-table__row--sel' : undefined}>
                  <td>
                    <button type="button" className="hq-table__name" onClick={() => props.onOpen(e.id)} title="Abrir painel">
                      <span className="hq-avatar" style={{ ['--skin' as string]: skinColor(e.appearance.skin), ['--shirt' as string]: shirtColor(e.appearance.shirt) }} aria-hidden="true" />
                      <span><strong>{e.name}</strong><span className="hq-dim hq-table__sub">{e.role}</span></span>
                    </button>
                  </td>
                  <td><span className="hq-chip hq-chip--room" style={{ ['--room' as string]: room?.color ?? 'var(--border)', marginLeft: 0 }}>{room?.name ?? 'sem sala'}</span></td>
                  <td><span className="hq-status-dot" style={{ background: workerStatusColor(w?.status) }} /> {workerStatusLabel(w?.status)}{w && w.detail && w.status !== 'idle' ? <span className="hq-dim hq-table__sub">{w.detail}</span> : null}</td>
                  <td>{s ? <><span>{s.name}</span><span className="hq-dim hq-table__sub">{sessionStatusLabel(s.status)}{n > 1 ? ` · ${n} conversas` : ''}</span></> : <span className="hq-dim">{n > 0 ? `${n} guardada${n === 1 ? '' : 's'}, nenhuma ativa` : 'nenhuma'}</span>}</td>
                  <td>{p ? <span title={p.path}>{p.name} <span className="hq-dim hq-mono">{basename(p.path)}</span></span> : <span className="hq-dim">—</span>}</td>
                  <td className="hq-table__actions">
                    <button type="button" className="hq-btn hq-btn--sm" onClick={() => props.onOpen(e.id)}>Abrir</button>
                    {props.onGiveTask && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => props.onGiveTask!(e.id)} title="Preenche o pedido na base da tela com este funcionário">Dar tarefa</button>}
                    {props.onTeach && <button type="button" className="hq-btn hq-btn--sm" onClick={() => props.onTeach!(e.id)} title="Registrar uma orientação que vale para esta pessoa">Ensinar</button>}
                    <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.onNewConversation(e.id)}>Nova conversa</button>
                    <button type="button" className="hq-iconbtn hq-iconbtn--xs" onClick={() => props.onEdit(e.id)} aria-label={`Editar ${e.name}`} title="Editar ou transferir"><IconEdit size={13} /></button>
                    <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.onArchive(e.id)} title="Sai da sala; conversas e histórico ficam guardados">Arquivar</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {observed.length > 0 && (
        <>
          <h3 className="hq-view__sub">Sessões observadas <span className="hq-dim">(iniciadas fora da HQ; só acompanhamento, sem comandos)</span></h3>
          <ul className="hq-list">
            {observed.map(w => <li key={w.id} className="hq-list__item"><span className="hq-status-dot" style={{ background: workerStatusColor(w.status) }} /> {w.name} <span className="hq-dim">· {w.role} · {w.detail}</span></li>)}
          </ul>
        </>
      )}

      {archived.length > 0 && (
        <>
          <h3 className="hq-view__sub">Arquivados <span className="hq-dim">(histórico e conversas preservados)</span></h3>
          <ul className="hq-list">
            {archived.map(e => (
              <li key={e.id} className="hq-list__item">
                <span><strong>{e.name}</strong> <span className="hq-dim">· {e.role} · {roomById.get(e.roomId)?.name ?? 'sala removida'} · arquivado em {new Date(e.archivedAt ?? 0).toLocaleDateString('pt-BR')}</span></span>
                <span className="hq-view__spacer" />
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => props.onUnarchive(e.id)}>Restaurar</button>
              </li>
            ))}
          </ul>
        </>
      )}
      </>}
    </section>
  );
}

const SKINS = ['#f1c9a5', '#d9a577', '#a9704a', '#6b4327'];
const SHIRTS = ['#f0a830', '#4f8fd6', '#5ca86a', '#a3405a'];
export function skinColor(i: number): string { return SKINS[Math.abs(i) % SKINS.length]; }
export function shirtColor(i: number): string { return SHIRTS[Math.abs(i) % SHIRTS.length]; }
