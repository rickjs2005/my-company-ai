// Armário de projetos (Marco 1): abre pelo armário da sala, pelo Ctrl+K ou pelo menu. Encontrar o projeto, escolher arquivos de
// contexto (por referência, sem cópia) e mandar para "O que vamos fazer?". Favorito e cliente são só organização da HQ:
// nada aqui mexe no disco (mover/apagar arquivos continua sendo no explorador, com confirmação).
import { useEffect, useMemo, useState } from 'react';
import type { FsListResult, FsRoot, Project, Room, Task } from '@milweb-hq/protocol';
import { Modal } from '../panel/dialogs/Modal';
import { FilePickerDialog } from '../meetings/FilePickerDialog';
import { IconFile, IconFolder } from '../panel/icons';

export interface ProjectCabinetProps {
  open: boolean;
  projects: Project[];
  rooms: Room[];
  tasks: Task[];
  /** Sala do armário clicado (os projetos dela aparecem primeiro); null = todos. */
  roomId: string | null;
  initialProjectId: string | null;
  fsList(rootId: string, path: string): Promise<FsListResult>;
  onUseInTask(projectId: string, contextFiles: string[]): void;
  onOpenFiles(projectId: string): void;
  onOpenFolder(path: string): void;
  onUpdate(id: string, patch: { favorite?: boolean; client?: string | null }): void;
  onAddProject(roomId: string | null): void;
  onClose(): void;
}

/** Caminho absoluto tocado por uma tarefa → relativo ao projeto (ou null se for fora dele). */
export function relativeToProject(projectPath: string, abs: string): string | null {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  const root = norm(projectPath); const file = norm(abs);
  if (file.toLowerCase().startsWith(root.toLowerCase() + '/')) return file.slice(root.length + 1);
  if (!/^[a-zA-Z]:\//.test(file) && !file.startsWith('/')) return file; // já relativo
  return null;
}

/** Arquivos que os funcionários criaram ou alteraram neste projeto, do mais recente para o mais antigo (sem repetir). */
export function recentProjectFiles(project: Project, tasks: Task[], limit = 10): string[] {
  const out: string[] = [];
  for (const t of [...tasks].filter(x => x.projectId === project.id).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))) {
    for (const f of [...t.touchedFiles].reverse()) {
      const rel = relativeToProject(project.path, f);
      if (rel && !out.includes(rel)) out.push(rel);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function ProjectCabinet(props: ProjectCabinetProps) {
  const { open, projects, rooms, tasks, roomId } = props;
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [context, setContext] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [client, setClient] = useState('');

  const visible = useMemo(() => projects.filter(p => !p.id.startsWith('ext:')), [projects]);
  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visible
      .filter(p => !q || p.name.toLowerCase().includes(q) || (p.client ?? '').toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || Number(b.roomId === roomId) - Number(a.roomId === roomId) || b.lastUsedAt - a.lastUsedAt);
  }, [visible, query, roomId]);

  useEffect(() => {
    if (!open) return;
    setQuery(''); setContext([]); setPicking(false);
    const first = props.initialProjectId ?? visible.find(p => p.roomId === roomId)?.id ?? visible[0]?.id ?? null;
    setSelectedId(first);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const project = visible.find(p => p.id === selectedId) ?? null;
  useEffect(() => { setClient(project?.client ?? ''); setContext([]); }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const recent = useMemo(() => (project ? recentProjectFiles(project, tasks) : []), [project, tasks]);
  const room = (id: string) => rooms.find(r => r.id === id)?.name ?? 'sem sala';
  const toggle = (f: string) => setContext(c => (c.includes(f) ? c.filter(x => x !== f) : [...c, f].slice(0, 20)));
  const root: FsRoot | null = project ? { id: `project:${project.id}`, kind: 'project', name: project.name, path: project.path, projectId: project.id } : null;

  return (
    <Modal open={open} title={`Armário de projetos${roomId ? ` · ${room(roomId)}` : ''}`} onCancel={props.onClose} width={900}>
      <div className="hq-cab">
        <aside className="hq-cab__list">
          <input className="hq-input" autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar projeto ou cliente…" aria-label="Buscar projeto ou cliente" />
          {sorted.length === 0 ? (
            <div className="hq-cab__empty">
              <p className="hq-dim">{visible.length === 0 ? 'Nenhum projeto cadastrado ainda.' : `Nenhum projeto com “${query.trim()}”.`}</p>
              <button type="button" className="hq-btn hq-btn--sm" onClick={() => props.onAddProject(roomId)}>+ Cadastrar pasta de projeto</button>
            </div>
          ) : (
            <ul className="hq-cab__items" role="listbox" aria-label="Projetos">
              {sorted.map(p => (
                <li key={p.id}>
                  <div className={`hq-cab__item${p.id === selectedId ? ' hq-cab__item--on' : ''}`}>
                    <button type="button" className="hq-cab__star" aria-label={p.favorite ? `Tirar ${p.name} dos favoritos` : `Favoritar ${p.name}`} title={p.favorite ? 'Favorito (sai do topo se desmarcar)' : 'Favoritar'} onClick={() => props.onUpdate(p.id, { favorite: !p.favorite })}>{p.favorite ? '★' : '☆'}</button>
                    <button type="button" className="hq-cab__pick" role="option" aria-selected={p.id === selectedId} onClick={() => setSelectedId(p.id)}>
                      <strong>{p.name}</strong>
                      <span className="hq-dim">{[p.client, room(p.roomId)].filter(Boolean).join(' · ')}</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="hq-cab__detail" aria-label="Projeto escolhido">
          {!project ? <p className="hq-dim">Escolha um projeto à esquerda.</p> : (
            <>
              <header className="hq-cab__head">
                <h3>{project.name}</h3>
                <span className="hq-tag hq-tag--xs">{room(project.roomId)}</span>
              </header>
              <div className="hq-mono hq-dim hq-cab__path" title={project.path}>{project.path}</div>
              <label className="hq-field hq-cab__client"><span>Cliente (só organização da HQ)</span>
                <input className="hq-input" value={client} placeholder="ex.: Acme Drones" onChange={e => setClient(e.target.value)}
                  onBlur={() => { const v = client.trim() || null; if (v !== (project.client ?? null)) props.onUpdate(project.id, { client: v }); }} />
              </label>
              <div className="hq-actions">
                <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => props.onUseInTask(project.id, context)}>
                  {context.length ? `Nova tarefa com ${context.length} arquivo(s) de contexto` : 'Nova tarefa neste projeto'}
                </button>
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => props.onOpenFolder(project.path)}><IconFolder size={12} /> Abrir pasta</button>
                <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => props.onOpenFiles(project.id)}>Arquivos na HQ</button>
              </div>

              <h4 className="hq-label">Arquivos de contexto</h4>
              <p className="hq-field__hint">O funcionário lê estes arquivos antes de começar. Vão por referência (caminho no projeto); nada é copiado nem movido.</p>
              {recent.length > 0 && (
                <>
                  <div className="hq-dim hq-cab__sub">Mexidos recentemente pelos funcionários</div>
                  <ul className="hq-cab__files">
                    {recent.map(f => (
                      <li key={f}><label className="hq-check"><input type="checkbox" checked={context.includes(f)} onChange={() => toggle(f)} /> <IconFile size={11} /> <span className="hq-mono">{f}</span></label></li>
                    ))}
                  </ul>
                </>
              )}
              {context.filter(f => !recent.includes(f)).length > 0 && (
                <ul className="hq-cab__files">
                  {context.filter(f => !recent.includes(f)).map(f => (
                    <li key={f}><label className="hq-check"><input type="checkbox" checked onChange={() => toggle(f)} /> <IconFile size={11} /> <span className="hq-mono">{f}</span></label></li>
                  ))}
                </ul>
              )}
              <button type="button" className="hq-linkbtn" onClick={() => setPicking(true)}>Escolher arquivos no projeto…</button>
            </>
          )}
        </section>
      </div>
      {root && (
        <FilePickerDialog open={picking} title={`Arquivos de contexto · ${root.name}`} fsRoots={async () => [root]} fsList={props.fsList}
          onCancel={() => setPicking(false)}
          onPick={files => { setPicking(false); setContext(c => [...new Set([...c, ...files.filter(x => x.rootId === root.id).map(x => x.relPath)])].slice(0, 20)); }} />
      )}
    </Modal>
  );
}
