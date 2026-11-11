// Árvore de pastas com expansão sob demanda (só diretórios; os arquivos ficam na lista). Nunca entra em links.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FsEntry } from '@milweb-hq/protocol';
import type { FsApi } from './api';
import { IconChevron, FileIcon } from './icons';
import { affectsDir, errorText } from './helpers';

interface Node { children: FsEntry[] | null; loading: boolean; open: boolean; error: string | null; truncated: boolean }

export interface FolderTreeProps {
  api: FsApi;
  rootId: string;
  rootName: string;
  selectedPath: string;
  onSelect(path: string): void;
  /** Mudança vinda do servidor (fs.changed): recarrega os nós carregados que ela afeta. null = nada. */
  changeKey: { nonce: number; paths: string[] } | null;
  /** Recarregar tudo que está carregado (ex.: botão Atualizar). */
  reloadNonce?: number;
}

export function FolderTree({ api, rootId, rootName, selectedPath, onSelect, changeKey, reloadNonce }: FolderTreeProps) {
  const [nodes, setNodes] = useState<Record<string, Node>>({});
  const nodesRef = useRef(nodes); nodesRef.current = nodes;

  const load = useCallback(async (path: string) => {
    setNodes(n => ({ ...n, [path]: { children: n[path]?.children ?? null, loading: true, open: n[path]?.open ?? true, error: null, truncated: false } }));
    try {
      const r = await api.list(rootId, path);
      setNodes(n => ({ ...n, [path]: { children: r.entries.filter(e => e.type === 'dir'), loading: false, open: n[path]?.open ?? true, error: null, truncated: r.truncated } }));
    } catch (err) {
      setNodes(n => ({ ...n, [path]: { children: n[path]?.children ?? [], loading: false, open: n[path]?.open ?? true, error: errorText(err), truncated: false } }));
    }
  }, [api, rootId]);

  // raiz nova: zera e carrega o primeiro nível
  useEffect(() => { setNodes({}); void load(''); }, [rootId, load]);

  // abre os ancestrais do caminho selecionado (navegação pela lista ou breadcrumbs)
  useEffect(() => {
    if (!selectedPath) return;
    const segs = selectedPath.split('/');
    let acc = '';
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? `${acc}/${segs[i]}` : segs[i];
      const node = nodesRef.current[acc];
      if (!node) void load(acc);
      else if (!node.open) setNodes(n => ({ ...n, [acc]: { ...n[acc], open: true } }));
    }
  }, [selectedPath, load]);

  useEffect(() => {
    if (!changeKey) return;
    for (const p of Object.keys(nodesRef.current)) if (nodesRef.current[p].children && affectsDir(changeKey.paths, p)) void load(p);
  }, [changeKey, load]);

  useEffect(() => {
    if (reloadNonce == null) return;
    for (const p of Object.keys(nodesRef.current)) if (nodesRef.current[p].children) void load(p);
  }, [reloadNonce, load]);

  const toggle = (path: string) => {
    const node = nodes[path];
    if (!node || node.children == null) { void load(path); return; }
    setNodes(n => ({ ...n, [path]: { ...n[path], open: !n[path].open } }));
  };

  const renderNode = (entry: { name: string; path: string }, depth: number): React.ReactNode => {
    const node = nodes[entry.path];
    const open = Boolean(node?.open && node.children);
    const selected = selectedPath === entry.path;
    return (
      <li key={entry.path || '(raiz)'} role="treeitem" aria-expanded={node?.children ? open : undefined} aria-selected={selected}>
        <div className={`hq-fx-tree__row${selected ? ' hq-fx-tree__row--on' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => { onSelect(entry.path); if (!node?.children) void load(entry.path); else if (!node.open) setNodes(n => ({ ...n, [entry.path]: { ...n[entry.path], open: true } })); }}
          onDoubleClick={() => toggle(entry.path)}>
          <button type="button" className={`hq-fx-tree__chev${open ? ' hq-fx-tree__chev--open' : ''}`} aria-label={open ? `Recolher ${entry.name}` : `Expandir ${entry.name}`}
            onClick={e => { e.stopPropagation(); toggle(entry.path); }} tabIndex={-1}><IconChevron size={12} /></button>
          <FileIcon kind="folder" open={open} size={15} />
          <span className="hq-fx-tree__name" title={entry.path || rootName}>{entry.name}</span>
          {node?.loading && <span className="hq-fx-tree__busy" aria-label="carregando" />}
        </div>
        {node?.error && <div className="hq-fx-tree__error" style={{ paddingLeft: 24 + depth * 14 }}>{node.error}</div>}
        {open && node?.children && (
          <ul role="group" className="hq-fx-tree__group">
            {node.children.map(c => renderNode(c, depth + 1))}
            {node.children.length === 0 && <li className="hq-fx-tree__empty" style={{ paddingLeft: 24 + depth * 14 }}>sem subpastas</li>}
            {node.truncated && <li className="hq-fx-tree__empty" style={{ paddingLeft: 24 + depth * 14 }}>lista cortada em 2000 entradas</li>}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul className="hq-fx-tree" role="tree" aria-label={`Pastas de ${rootName}`}>
      {renderNode({ name: rootName, path: '' }, 0)}
    </ul>
  );
}
