// Aba Arquivos/Alterações: árvore sob demanda, arquivos tocados na tarefa, status git, visualizador e diff.
import { useEffect, useMemo, useState } from 'react';
import type { FileNode, GitStatusEntry } from '@milweb-hq/protocol';
import type { FilesPanelProps } from './types';
import { basename, normalizePath } from './helpers';
import { IconChevron, IconExternal, IconFile, IconFolder, IconRefresh } from './icons';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

const GIT_LABELS: Record<string, { label: string; cls: string }> = {
  M: { label: 'Modificado', cls: 'hq-tag--amber' },
  A: { label: 'Adicionado', cls: 'hq-tag--ok' },
  D: { label: 'Removido', cls: 'hq-tag--danger' },
  R: { label: 'Renomeado', cls: 'hq-tag--info' },
  C: { label: 'Copiado', cls: 'hq-tag--info' },
  U: { label: 'Conflito', cls: 'hq-tag--danger' },
  '?': { label: 'Novo', cls: 'hq-tag--info' },
  '!': { label: 'Ignorado', cls: '' },
};

/** Rótulo em português para o código curto do `git status --porcelain` (ex.: "M", "??", " M", "AM"). */
export function gitStatusLabel(status: string): { label: string; cls: string } {
  const code = status.trim().charAt(0) || status.charAt(1) || '';
  return GIT_LABELS[code] ?? { label: status.trim() || 'Alterado', cls: '' };
}

type FileView = { content: string; truncated: boolean; binary: boolean };

interface TreeProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  selected: string | null;
  touched: Set<string>;
  gitMap: Map<string, GitStatusEntry>;
  onToggle(node: FileNode): void;
  onSelect(node: FileNode): void;
}

function TreeNode(p: TreeProps) {
  const { node, depth } = p;
  const key = normalizePath(node.path);
  const isDir = node.type === 'dir';
  const open = p.expanded.has(key);
  const isTouched = p.touched.has(key);
  const git = p.gitMap.get(key);
  const children = node.children ?? [];
  const sorted = useMemo(() => [...children].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)), [children]);
  return (
    <li>
      <button
        type="button"
        className={cx('hq-tree__row', p.selected === key && 'hq-tree__row--sel', isTouched && 'hq-tree__row--touched')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (isDir ? p.onToggle(node) : p.onSelect(node))}
        aria-expanded={isDir ? open : undefined}
        aria-label={`${isDir ? 'Pasta' : 'Arquivo'} ${node.name}${isTouched ? ' (tocado nesta tarefa)' : ''}`}
        title={node.path}
      >
        {isDir ? <IconChevron size={12} open={open} /> : <span className="hq-tree__spacer" />}
        {isDir ? <IconFolder size={13} /> : <IconFile size={13} />}
        <span className="hq-tree__name">{node.name}</span>
        {isTouched && <span className="hq-tree__touched" title="Tocado nesta tarefa" />}
        {git && <span className={cx('hq-tag hq-tag--xs', gitStatusLabel(git.status).cls)}>{gitStatusLabel(git.status).label}</span>}
      </button>
      {isDir && open && (
        <ul className="hq-tree__list">
          {node.children === undefined
            ? <li className="hq-tree__hint" style={{ paddingLeft: 22 + depth * 14 }}>carregando…</li>
            : sorted.length === 0
              ? <li className="hq-tree__hint" style={{ paddingLeft: 22 + depth * 14 }}>(vazia)</li>
              : sorted.map(c => <TreeNode key={c.path} {...p} node={c} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <div className="hq-empty">Sem diferenças.</div>;
  const lines = diff.split(/\r?\n/);
  return (
    <pre className="hq-mono hq-diff" aria-label="Diff unificado">
      {lines.map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') ? 'hq-diff__file'
          : l.startsWith('@@') ? 'hq-diff__hunk'
            : l.startsWith('+') ? 'hq-diff__add'
              : l.startsWith('-') ? 'hq-diff__del'
                : l.startsWith('diff ') || l.startsWith('index ') ? 'hq-diff__meta' : '';
        // Cada linha é um bloco (não inline): dentro de white-space: pre, inline-blocks ficariam lado a lado.
        return <span key={i} className={cx('hq-diff__line', cls)}>{l || ' '}</span>;
      })}
    </pre>
  );
}

export function FilesPanel(props: FilesPanelProps) {
  const { project, tree, gitStatus, touchedFiles, loading, onLoadTree, onReadFile, onDiff, onOpenExternal } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<FileView | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [mode, setMode] = useState<'file' | 'diff'>('file');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const touched = useMemo(() => new Set(touchedFiles.map(normalizePath)), [touchedFiles]);
  const gitMap = useMemo(() => {
    const m = new Map<string, GitStatusEntry>();
    const root = project ? normalizePath(project.path) : '';
    for (const g of gitStatus ?? []) {
      const p = normalizePath(g.path);
      m.set(p, g);
      if (root && !p.startsWith(root)) m.set(`${root}/${p}`, g); // caminhos relativos ao projeto
    }
    return m;
  }, [gitStatus, project]);

  // Primeira carga da árvore quando ainda não há nada e existe projeto.
  useEffect(() => {
    if (project && !tree && !loading) onLoadTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    if (tree) setExpanded(prev => new Set(prev).add(normalizePath(tree.path)));
  }, [tree]);

  const toggle = (node: FileNode) => {
    const key = normalizePath(node.path);
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    if (node.children === undefined) onLoadTree(node.path);
  };

  const select = async (node: FileNode) => {
    const key = normalizePath(node.path);
    setSelected(key);
    setMode('file');
    setBusy(true); setError(null);
    try { setView(await onReadFile(node.path)); } catch (e) { setView(null); setError(`Não consegui ler: ${String(e instanceof Error ? e.message : e)}`); }
    finally { setBusy(false); }
  };

  const showDiff = async (path?: string) => {
    setMode('diff');
    setBusy(true); setError(null);
    try { setDiff(await onDiff(path)); } catch (e) { setDiff(null); setError(`Não consegui obter o diff: ${String(e instanceof Error ? e.message : e)}`); }
    finally { setBusy(false); }
  };

  const selectedPath = selected ? (findPath(tree, selected) ?? selected) : null;

  return (
    <div className="hq-files">
      <div className="hq-files__tree">
        <div className="hq-files__toolbar">
          <span className="hq-files__title" title={project?.path}>{project ? basename(project.path) : 'Sem projeto'}</span>
          <button type="button" className="hq-iconbtn" onClick={() => onLoadTree()} disabled={!project || loading} aria-label="Atualizar árvore" title="Atualizar"><IconRefresh size={14} /></button>
          <button type="button" className="hq-btn hq-btn--sm" disabled={!project} onClick={() => project && onOpenExternal('folder', project.path)}><IconExternal size={12} /> Abrir pasta</button>
        </div>
        {(gitStatus?.length ?? 0) > 0 && (
          <button type="button" className="hq-btn hq-btn--sm hq-files__diffall" onClick={() => showDiff()}>Ver diff de tudo ({gitStatus!.length})</button>
        )}
        {touchedFiles.length > 0 && (
          <div className="hq-files__touched">
            <div className="hq-label">Tocados nesta tarefa</div>
            {touchedFiles.map(f => (
              <button key={f} type="button" className={cx('hq-files__touchedrow', selected === normalizePath(f) && 'hq-files__touchedrow--sel')} title={f} onClick={() => select({ name: basename(f), path: f, type: 'file' })}>
                <span className="hq-tree__touched" /> {basename(f)}
              </button>
            ))}
          </div>
        )}
        {loading && !tree && <div className="hq-empty">Carregando árvore…</div>}
        {!project && <div className="hq-empty">Selecione uma sessão com projeto.</div>}
        {tree && (
          <ul className="hq-tree" role="tree">
            <TreeNode node={tree} depth={0} expanded={expanded} selected={selected} touched={touched} gitMap={gitMap} onToggle={toggle} onSelect={select} />
          </ul>
        )}
      </div>

      <div className="hq-files__view">
        <div className="hq-files__toolbar">
          <span className="hq-files__title hq-mono" title={selectedPath ?? ''}>{selectedPath ? basename(selectedPath) : mode === 'diff' ? 'Diff' : 'Nenhum arquivo'}</span>
          {selectedPath && (
            <>
              <button type="button" className={cx('hq-btn hq-btn--sm', mode === 'file' && 'hq-btn--on')} onClick={() => setMode('file')}>Conteúdo</button>
              <button type="button" className={cx('hq-btn hq-btn--sm', mode === 'diff' && 'hq-btn--on')} onClick={() => showDiff(selectedPath)}>Diff</button>
              <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenExternal('file', selectedPath)}><IconExternal size={12} /> Abrir arquivo</button>
            </>
          )}
        </div>
        {busy && <div className="hq-empty">Carregando…</div>}
        {error && <div className="hq-notice hq-notice--error" role="alert">{error}</div>}
        {!busy && mode === 'file' && view && (
          <>
            {view.binary && <div className="hq-notice hq-notice--warn">Arquivo binário: conteúdo não exibido.</div>}
            {view.truncated && <div className="hq-notice hq-notice--warn">Conteúdo truncado: o arquivo é maior do que o limite de exibição.</div>}
            {!view.binary && <pre className="hq-mono hq-code">{view.content}</pre>}
          </>
        )}
        {!busy && mode === 'diff' && diff !== null && <DiffView diff={diff} />}
        {!busy && !view && mode === 'file' && !error && <div className="hq-empty">Escolha um arquivo na árvore ou na lista de tocados.</div>}
      </div>
    </div>
  );
}

function findPath(tree: FileNode | null, key: string): string | null {
  if (!tree) return null;
  if (normalizePath(tree.path) === key) return tree.path;
  for (const c of tree.children ?? []) { const r = findPath(c, key); if (r) return r; }
  return null;
}
