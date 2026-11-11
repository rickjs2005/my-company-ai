// Seletor de arquivos para o contexto: raízes do explorador (fs.roots) e navegação por pasta (fs.list).
// Só lista o que o servidor devolve; erro de listagem aparece como texto, nunca lista vazia fingida.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FsEntry, FsRoot } from '@milweb-hq/protocol';
import { Modal } from '../panel/dialogs/Modal';
import { absolutePath, breadcrumbs, sortEntries } from '../files/helpers';
import { IconFile, IconFolder } from '../panel/icons';
import type { FilePickerDialogProps, PickedFile } from './types';
import { errorMessage } from './helpers';

export function FilePickerDialog({ open, fsRoots, fsList, onPick, onCancel, title }: FilePickerDialogProps) {
  const [roots, setRoots] = useState<FsRoot[] | null>(null);
  const [rootId, setRootId] = useState('');
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Map<string, PickedFile>>(new Map());

  const root = useMemo(() => roots?.find(r => r.id === rootId) ?? null, [roots, rootId]);
  // As funções do host podem mudar de identidade a cada render; o que dispara carregamento é abrir o diálogo ou mudar de pasta.
  const fsRootsRef = useRef(fsRoots); fsRootsRef.current = fsRoots;
  const fsListRef = useRef(fsList); fsListRef.current = fsList;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRoots(null); setError(null); setSelected(new Map()); setCwd(''); setEntries(null);
    fsRootsRef.current().then(rs => { if (!alive) return; setRoots(rs); setRootId(rs[0]?.id ?? ''); }).catch(err => { if (alive) { setRoots([]); setError(errorMessage(err)); } });
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!open || !rootId) return;
    let alive = true;
    setLoading(true); setError(null);
    fsListRef.current(rootId, cwd).then(r => { if (!alive) return; setEntries(sortEntries(r.entries)); setTruncated(r.truncated); })
      .catch(err => { if (alive) { setEntries([]); setError(errorMessage(err)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, rootId, cwd]);

  const toggle = (e: FsEntry) => {
    if (!root) return;
    const key = `${root.id}:${e.path}`;
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, { rootId: root.id, rootName: root.name, relPath: e.path, absPath: absolutePath(root.path, e.path), name: e.name });
      return next;
    });
  };

  const crumbs = root ? breadcrumbs(cwd, root.name) : [];

  return (
    <Modal open={open} title={title ?? "Arquivos para o contexto"} onCancel={onCancel} width={640}>
      <div className="hq-form">
        <label className="hq-field">
          <span className="hq-field__label">Raiz</span>
          <select className="hq-input" value={rootId} disabled={!roots || roots.length === 0} onChange={e => { setRootId(e.target.value); setCwd(''); }}>
            {roots === null && <option value="">Carregando raízes…</option>}
            {roots && roots.length === 0 && <option value="">Nenhuma raiz (cadastre um projeto ou pasta no explorador)</option>}
            {roots?.map(r => <option key={r.id} value={r.id}>{r.kind === 'project' ? 'Projeto: ' : 'Pasta: '}{r.name}</option>)}
          </select>
        </label>
        {root && (
          <nav className="hq-meet-crumbs" aria-label="Caminho">
            {crumbs.map((c, i) => (
              <span key={c.path}>
                {i > 0 && <span className="hq-dim"> / </span>}
                <button type="button" className="hq-linkbtn" onClick={() => setCwd(c.path)} disabled={c.path === cwd}>{c.name}</button>
              </span>
            ))}
          </nav>
        )}
        <div className="hq-meet-picker" role="listbox" aria-multiselectable="true" aria-busy={loading}>
          {loading && entries === null && <div className="hq-dim hq-meet-group__empty">Listando…</div>}
          {error && <div className="hq-notice hq-notice--error">{error}</div>}
          {entries && entries.length === 0 && !error && <div className="hq-dim hq-meet-group__empty">Pasta vazia.</div>}
          {entries?.map(e => {
            const key = root ? `${root.id}:${e.path}` : e.path;
            if (e.type === 'dir') {
              return (
                <button key={key} type="button" className="hq-meet-picker__row hq-meet-picker__dir" onClick={() => setCwd(e.path)}>
                  <IconFolder size={14} /> <span>{e.name}</span>{e.childCount != null && <span className="hq-dim">{e.childCount}</span>}
                </button>
              );
            }
            if (e.type !== 'file') return <div key={key} className="hq-meet-picker__row hq-dim"><span>{e.name}</span><span>{e.type === 'symlink' ? 'link (não seguido)' : 'não suportado'}</span></div>;
            const on = selected.has(key);
            return (
              <label key={key} className={`hq-meet-picker__row${on ? ' hq-meet-picker__row--on' : ''}`} role="option" aria-selected={on}>
                <input type="checkbox" checked={on} onChange={() => toggle(e)} />
                <IconFile size={14} /> <span>{e.name}</span>
              </label>
            );
          })}
          {truncated && <div className="hq-dim hq-meet-group__empty">Lista cortada pelo servidor: há mais itens do que o mostrado.</div>}
        </div>
        {selected.size > 0 && (
          <div className="hq-meet-picker__sel">
            {[...selected.values()].map(f => <span key={f.absPath} className="hq-chip" title={f.absPath}>{f.name}</span>)}
          </div>
        )}
        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn" onClick={onCancel}>Cancelar</button>
          <button type="button" className="hq-btn hq-btn--primary" disabled={selected.size === 0} onClick={() => onPick([...selected.values()])}>
            Adicionar {selected.size === 1 ? '1 arquivo' : `${selected.size} arquivos`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
