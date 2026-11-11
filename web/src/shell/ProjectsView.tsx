// Projetos: pastas reais cadastradas na HQ. "Remover da HQ" só tira do cadastro (os arquivos ficam onde estão);
// apagar arquivos é sempre pelo explorador, com lixeira e confirmação.
import { useMemo } from 'react';
import type { Employee, Project, Room, Session } from '@milweb-hq/protocol';
import { IconFolder, IconPlus } from '../panel/icons';

export interface ProjectsViewProps {
  projects: Project[];
  rooms: Room[];
  sessions: Session[];
  employees: Employee[];
  onAdd(roomId: string | null): void;
  onOpenFiles(projectId: string): void;
  onOpenExplorer(path: string): void;
  onMoveRoom(projectId: string, roomId: string): void;
  onRemove(projectId: string): void;
  onNewConversation(projectId: string): void;
}

export function ProjectsView(props: ProjectsViewProps) {
  const { projects, rooms, sessions, employees } = props;
  const sortedRooms = useMemo(() => [...rooms].sort((a, b) => a.order - b.order), [rooms]);
  const real = useMemo(() => projects.filter(p => !p.id.startsWith('ext:')).sort((a, b) => b.lastUsedAt - a.lastUsedAt), [projects]);
  const external = useMemo(() => projects.filter(p => p.id.startsWith('ext:')), [projects]);
  const employeeById = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees]);

  return (
    <section className="hq-view" aria-label="Projetos">
      <header className="hq-view__head">
        <h2>Projetos</h2>
        <span className="hq-dim">{real.length} pasta{real.length === 1 ? '' : 's'} cadastrada{real.length === 1 ? '' : 's'}</span>
        <span className="hq-view__spacer" />
        <button type="button" className="hq-btn hq-btn--primary hq-btn--sm" onClick={() => props.onAdd(null)}><IconPlus size={12} /> Adicionar projeto</button>
      </header>
      {real.length === 0 ? (
        <div className="hq-empty hq-empty--tall">
          <p>Nenhum projeto cadastrado.</p>
          <p className="hq-dim">Um projeto é uma pasta real do seu computador. A HQ não copia nada: os funcionários trabalham direto nela.</p>
          <button type="button" className="hq-btn hq-btn--primary" onClick={() => props.onAdd(null)}><IconPlus size={12} /> Adicionar projeto</button>
        </div>
      ) : (
        <table className="hq-table">
          <thead><tr><th>Projeto</th><th>Pasta</th><th>Sala</th><th>Conversas</th><th className="hq-table__actions">Ações</th></tr></thead>
          <tbody>
            {real.map(p => {
              const open = sessions.filter(s => s.projectId === p.id && s.status !== 'archived');
              const names = [...new Set(open.map(s => s.employeeId ? employeeById.get(s.employeeId)?.name ?? '' : '').filter(Boolean))];
              return (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong>{p.previewUrl ? <span className="hq-dim hq-table__sub">{p.previewUrl}</span> : null}</td>
                  <td><button type="button" className="hq-linkbtn hq-mono" onClick={() => props.onOpenExplorer(p.path)} title="Abrir no Explorador do Windows">{p.path}</button></td>
                  <td>
                    <select className="hq-input hq-input--sm" value={p.roomId} onChange={e => props.onMoveRoom(p.id, e.target.value)} aria-label={`Sala do projeto ${p.name}`}>
                      {sortedRooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </td>
                  <td>{open.length === 0 ? <span className="hq-dim">nenhuma</span> : <span>{open.length} <span className="hq-dim">({names.join(', ')})</span></span>}</td>
                  <td className="hq-table__actions">
                    <button type="button" className="hq-btn hq-btn--sm" onClick={() => props.onOpenFiles(p.id)}><IconFolder size={12} /> Arquivos</button>
                    <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.onNewConversation(p.id)}>Nova conversa</button>
                    <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.onRemove(p.id)} title="Só tira do cadastro da HQ. Nenhum arquivo é apagado.">Remover da HQ</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="hq-view__note">Remover da HQ nunca apaga arquivos. Para apagar algo do disco, abra <strong>Arquivos</strong>, selecione e envie para a lixeira (com confirmação e desfazer).</p>
      {external.length > 0 && (
        <>
          <h3 className="hq-view__sub">Pastas de sessões externas <span className="hq-dim">(detectadas em sessões iniciadas fora da HQ; não cadastradas)</span></h3>
          <ul className="hq-list">{external.map(p => <li key={p.id} className="hq-list__item"><span className="hq-mono">{p.path}</span></li>)}</ul>
        </>
      )}
    </section>
  );
}
