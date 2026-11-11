// Explorador de arquivos da HQ: raízes (projetos e pastas extras), árvore, lista, preview/editor, menu contextual,
// seleção múltipla, copiar/mover, lixeira com Desfazer e diálogo de execuções dependentes (in_use).
// Toda ação só é dada como feita depois da resposta do servidor; erros aparecem em texto real.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FsConflictPolicy, FsEntry, FsInUse, FsRoot } from '@milweb-hq/protocol';
import type { FsApi } from './api';
import { FolderTree } from './FolderTree';
import { Preview } from './Preview';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { AddFolderDialog, ConfirmDialog, ConfirmTrashDialog, InUseDialog, NameDialog, PickDestinationDialog } from './dialogs';
import { FileIcon, IconChevron, IconPlus, IconRefresh, IconSearch, IconX } from './icons';
import { absolutePath, affectsDir, breadcrumbs, dirname, errorText, fileKind, formatDate, formatSize, isWithin, joinPath, keyAction, sortEntries, type SortDir, type SortKey } from './helpers';

export interface ChangeSignal { rootId: string; paths: string[]; nonce: number }

export interface FileExplorerProps {
  api: FsApi;
  /** Raízes (projetos + pastas extras), vindas do estado do App (entity folder/project) ou de api.roots(). */
  roots: FsRoot[];
  initialRootId?: string;
  /** Pasta inicial dentro da raiz inicial (última visitada; ignorada se a raiz não existir mais). */
  initialCwd?: string;
  connected: boolean;
  /** Último fs.changed recebido do servidor (nonce muda a cada aviso). */
  changeSignal: ChangeSignal | null;
  onOpenExternal(target: 'folder' | 'file', absPath: string): void;
  onNotice(level: 'info' | 'warn' | 'error', text: string): void;
  /** Interrompe as sessões listadas num erro 'in_use' antes de refazer a operação com force. */
  onInterruptSessions?(sessionIds: string[]): Promise<void> | void;
  /** Raiz/pasta em exibição mudou (o App guarda para reabrir a vista no mesmo lugar). */
  onLocationChange?(rootId: string | null, cwd: string): void;
}

type Dialog =
  | { kind: 'confirm-trash'; items: FsEntry[] }
  | { kind: 'in-use'; inUse: FsInUse[]; message: string; retry(): Promise<void> }
  | { kind: 'pick-dest'; op: 'copy' | 'move'; paths: string[] }
  | { kind: 'add-folder' }
  | { kind: 'new'; itemKind: 'file' | 'dir' }
  | { kind: 'unsaved'; proceed(): void }
  | { kind: 'remove-folder'; root: FsRoot }
  | null;

interface Clipboard { op: 'copy' | 'cut'; rootId: string; paths: string[] }

const TOAST_MS = 8000;

export function FileExplorer({ api, roots, initialRootId, initialCwd, connected, changeSignal, onOpenExternal, onNotice, onInterruptSessions, onLocationChange }: FileExplorerProps) {
  const initialRootOk = Boolean(initialRootId && roots.some(r => r.id === initialRootId));
  const [rootId, setRootId] = useState<string | null>(() => (initialRootOk ? initialRootId! : roots[0]?.id ?? null));
  const [cwd, setCwd] = useState(() => (initialRootOk ? initialCwd ?? '' : ''));
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FsEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const [dirtyPath, setDirtyPath] = useState<string | null>(null);
  const [treeChange, setTreeChange] = useState<{ nonce: number; paths: string[] } | null>(null);
  const [treeReload, setTreeReload] = useState(0);
  const [previewReload, setPreviewReload] = useState(0);
  const [pendingRootId, setPendingRootId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | null>(null);

  const root = useMemo(() => roots.find(r => r.id === rootId) ?? null, [roots, rootId]);

  // raiz some do cadastro → cai na primeira; raiz nova pedida (pasta adicionada) → troca quando aparecer
  useEffect(() => {
    if (pendingRootId && roots.some(r => r.id === pendingRootId)) { setRootId(pendingRootId); setPendingRootId(null); setCwd(''); return; }
    if (rootId && !roots.some(r => r.id === rootId)) { setRootId(roots[0]?.id ?? null); setCwd(''); }
    if (!rootId && roots[0]) setRootId(roots[0].id);
  }, [roots, rootId, pendingRootId]);

  // ---------- carregar lista ----------
  const loadDir = useCallback(async (keep = true) => {
    if (!rootId) { setEntries([]); return; }
    setLoading(true);
    try {
      const r = await api.list(rootId, cwd);
      setEntries(r.entries); setTruncated(r.truncated); setListError(null);
      const names = new Set(r.entries.map(e => e.path));
      if (keep) setSelected(s => new Set([...s].filter(p => names.has(p)))); else setSelected(new Set());
      setFocused(f => (f && names.has(f) ? f : null));
    } catch (err) {
      setEntries([]); setTruncated(false); setListError(errorText(err));
      // pasta lembrada já não existe → volta para a raiz
      if ((err as { code?: string }).code === 'not_found' && cwd) setCwd('');
    }
    finally { setLoading(false); }
  }, [api, rootId, cwd]);

  useEffect(() => { onLocationChange?.(rootId, cwd); }, [rootId, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setSelected(new Set()); setFocused(null); setRenaming(null); setResults(null); setQuery(''); void loadDir(false); }, [rootId, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- observação do disco ----------
  useEffect(() => {
    if (!rootId || !connected) return;
    api.watch(rootId, true);
    return () => api.watch(rootId, false);
  }, [api, rootId, connected]);

  useEffect(() => {
    if (!changeSignal || changeSignal.rootId !== rootId) return;
    if (affectsDir(changeSignal.paths, cwd)) void loadDir(true);
    setTreeChange({ nonce: changeSignal.nonce, paths: changeSignal.paths });
    if (focused && (changeSignal.paths.length === 0 || changeSignal.paths.includes(focused))) setPreviewReload(n => n + 1);
  }, [changeSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- busca ----------
  useEffect(() => {
    if (!rootId) return;
    const q = query.trim();
    if (!q) { setResults(null); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const t = window.setTimeout(async () => {
      try { const r = await api.search(rootId, q, 300); if (alive) setResults(r); }
      catch (err) { if (alive) { setResults([]); onNotice('error', `Busca falhou: ${errorText(err)}`); } }
      finally { if (alive) setSearching(false); }
    }, 250);
    return () => { alive = false; window.clearTimeout(t); };
  }, [query, rootId, api, onNotice]);

  const visible = useMemo(() => (results ? sortEntries(results, sortKey, sortDir) : sortEntries(entries, sortKey, sortDir)), [results, entries, sortKey, sortDir]);
  const selectedEntries = useMemo(() => visible.filter(e => selected.has(e.path)), [visible, selected]);
  const focusedEntry = useMemo(() => visible.find(e => e.path === focused) ?? null, [visible, focused]);
  const previewEntry = selectedEntries.length === 1 ? selectedEntries[0] : focusedEntry && selected.size === 0 ? focusedEntry : null;

  // ---------- toast ----------
  const showToast = useCallback((text: string, undo?: () => void) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  // ---------- seleção ----------
  const selectOne = (path: string) => { setSelected(new Set([path])); setAnchor(path); setFocused(path); };
  const clickEntry = (e: React.MouseEvent, entry: FsEntry) => {
    if (e.ctrlKey || e.metaKey) {
      setSelected(s => { const n = new Set(s); if (n.has(entry.path)) n.delete(entry.path); else n.add(entry.path); return n; });
      setAnchor(entry.path); setFocused(entry.path);
    } else if (e.shiftKey && anchor) {
      const a = visible.findIndex(x => x.path === anchor); const b = visible.findIndex(x => x.path === entry.path);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSelected(new Set(visible.slice(lo, hi + 1).map(x => x.path))); }
      setFocused(entry.path);
    } else selectOne(entry.path);
  };
  const openEntry = (entry: FsEntry) => {
    if (entry.type === 'dir') { setCwd(entry.path); return; }
    if (entry.type === 'symlink') { onNotice('warn', 'Links não são seguidos pela HQ.'); return; }
    selectOne(entry.path);
  };

  // ---------- ações ----------
  const guardUnsaved = (items: FsEntry[], proceed: () => void) => {
    if (dirtyPath && items.some(i => i.path === dirtyPath || (i.type === 'dir' && isWithin(i.path, dirtyPath)))) setDialog({ kind: 'unsaved', proceed });
    else proceed();
  };

  const doTrash = useCallback(async (items: FsEntry[], force: boolean) => {
    if (!rootId) return;
    try {
      const r = await api.trash(rootId, items.map(i => i.path), force);
      for (const e of r.errors) onNotice('error', `${e.path || '(raiz)'}: ${e.message}`);
      if (r.items.length === 1 && items.length === 1) {
        const it = r.items[0];
        showToast(`Movido para a lixeira: ${it.name}`, async () => {
          try { const res = await api.trashRestore(it.id); onNotice('info', `Restaurado: ${res.restoredTo}`); void loadDir(true); setTreeReload(n => n + 1); }
          catch (err) { onNotice('error', `Não foi possível restaurar: ${errorText(err)}`); }
        });
      } else if (r.items.length) onNotice('info', `${r.items.length} itens enviados para a lixeira`);
      setSelected(new Set()); setDialog(null);
      void loadDir(true); setTreeReload(n => n + 1);
    } catch (err) {
      const e = err as { code?: string; data?: unknown };
      if (e.code === 'in_use') {
        const inUse = (Array.isArray(e.data) ? e.data : []) as FsInUse[];
        setDialog({ kind: 'in-use', inUse, message: errorText(err), retry: async () => {
          const ids = [...new Set(inUse.flatMap(u => u.sessions.map(s => s.sessionId)))];
          if (onInterruptSessions && ids.length) await onInterruptSessions(ids);
          await doTrash(items, true);
        } });
      } else { setDialog(null); onNotice('error', `Não foi possível enviar para a lixeira: ${errorText(err)}`); }
    }
  }, [api, rootId, onNotice, showToast, loadDir, onInterruptSessions]);

  const trashItems = (items: FsEntry[]) => {
    if (!items.length) return;
    guardUnsaved(items, () => {
      const needsConfirm = items.length > 1 || items.some(i => i.type === 'dir' && (i.childCount == null || i.childCount > 0));
      if (needsConfirm) setDialog({ kind: 'confirm-trash', items });
      else void doTrash(items, false);
    });
  };

  const startRename = (entry: FsEntry | null) => { if (entry) setRenaming({ path: entry.path, value: entry.name }); };
  const commitRename = async () => {
    if (!renaming || !rootId) return;
    const entry = visible.find(e => e.path === renaming.path);
    const value = renaming.value.trim();
    setRenaming(null);
    if (!entry || !value || value === entry.name) return;
    try { const r = await api.rename(rootId, entry.path, value); onNotice('info', `Renomeado para ${r.name}`); selectOne(r.path); void loadDir(true); if (entry.type === 'dir') setTreeReload(n => n + 1); }
    catch (err) { onNotice('error', `Não foi possível renomear: ${errorText(err)}`); }
  };

  const createItem = async (name: string) => {
    if (!dialog || dialog.kind !== 'new' || !rootId) return;
    setDialogBusy(true); setDialogError(null);
    try { const e = await api.create(rootId, joinPath(cwd, name), dialog.itemKind); setDialog(null); await loadDir(true); selectOne(e.path); if (dialog.itemKind === 'dir') setTreeReload(n => n + 1); }
    catch (err) { setDialogError(errorText(err)); }
    finally { setDialogBusy(false); }
  };

  const copyToClipboard = (op: 'copy' | 'cut') => {
    const paths = selectedEntries.length ? selectedEntries.map(e => e.path) : focusedEntry ? [focusedEntry.path] : [];
    if (!paths.length || !rootId) return;
    setClipboard({ op, rootId, paths });
    onNotice('info', `${paths.length} ${paths.length === 1 ? 'item' : 'itens'} ${op === 'copy' ? 'copiado(s)' : 'recortado(s)'}; Ctrl+V cola na pasta aberta`);
  };

  const reportBatch = (verb: string, r: { done: { from: string; to: string }[]; errors: { path: string; code: string; message: string }[] }) => {
    if (r.done.length) onNotice('info', `${r.done.length} ${r.done.length === 1 ? 'item' : 'itens'} ${verb}`);
    for (const e of r.errors) onNotice('error', `${e.path}: ${e.message}`);
  };

  const transfer = useCallback(async (op: 'copy' | 'move', srcRootId: string, paths: string[], destRootId: string, destDir: string, policy: FsConflictPolicy, force = false) => {
    setDialogBusy(true);
    try {
      const r = op === 'copy' ? await api.copy(srcRootId, paths, destRootId, destDir, policy) : await api.move(srcRootId, paths, destRootId, destDir, policy, force);
      reportBatch(op === 'copy' ? 'copiado(s)' : 'movido(s)', r);
      setDialog(null);
      if (op === 'move' && clipboard?.op === 'cut') setClipboard(null);
      void loadDir(true); setTreeReload(n => n + 1);
    } catch (err) {
      const e = err as { code?: string; data?: unknown };
      if (e.code === 'in_use') {
        const inUse = (Array.isArray(e.data) ? e.data : []) as FsInUse[];
        setDialog({ kind: 'in-use', inUse, message: errorText(err), retry: async () => {
          const ids = [...new Set(inUse.flatMap(u => u.sessions.map(s => s.sessionId)))];
          if (onInterruptSessions && ids.length) await onInterruptSessions(ids);
          await transfer(op, srcRootId, paths, destRootId, destDir, policy, true);
        } });
      } else { setDialog(null); onNotice('error', `Não foi possível ${op === 'copy' ? 'copiar' : 'mover'}: ${errorText(err)}`); }
    } finally { setDialogBusy(false); }
  }, [api, clipboard, loadDir, onNotice, onInterruptSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const paste = () => {
    if (!clipboard || !rootId) return;
    guardUnsavedPaths(clipboard.paths, () => void transfer(clipboard.op === 'copy' ? 'copy' : 'move', clipboard.rootId, clipboard.paths, rootId, cwd, 'fail'));
  };
  const guardUnsavedPaths = (paths: string[], proceed: () => void) => {
    if (dirtyPath && paths.some(p => p === dirtyPath || isWithin(p, dirtyPath))) setDialog({ kind: 'unsaved', proceed }); else proceed();
  };

  const addFolder = async (path: string, name: string) => {
    setDialogBusy(true); setDialogError(null);
    try { const f = await api.folderAdd(path, name || undefined); setDialog(null); onNotice('info', `Pasta adicionada: ${f.name}`); setPendingRootId(`folder:${f.id}`); }
    catch (err) { setDialogError(errorText(err)); }
    finally { setDialogBusy(false); }
  };

  const refresh = () => { void loadDir(true); setTreeReload(n => n + 1); setPreviewReload(n => n + 1); };

  // ---------- teclado ----------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming) return;
    const action = keyAction(e);
    if (!action) return;
    const idx = focused ? visible.findIndex(x => x.path === focused) : -1;
    const moveTo = (i: number) => {
      const t = visible[Math.max(0, Math.min(visible.length - 1, i))];
      if (!t) return;
      if (e.shiftKey && anchor) { const a = visible.findIndex(x => x.path === anchor); const b = visible.indexOf(t); const [lo, hi] = a < b ? [a, b] : [b, a]; setSelected(new Set(visible.slice(lo, hi + 1).map(x => x.path))); setFocused(t.path); }
      else selectOne(t.path);
      listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(t.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    switch (action) {
      case 'up': e.preventDefault(); moveTo(idx < 0 ? 0 : idx - 1); break;
      case 'down': e.preventDefault(); moveTo(idx < 0 ? 0 : idx + 1); break;
      case 'home': e.preventDefault(); moveTo(0); break;
      case 'end': e.preventDefault(); moveTo(visible.length - 1); break;
      case 'open': e.preventDefault(); if (focusedEntry) openEntry(focusedEntry); break;
      case 'parent': e.preventDefault(); if (results) { setQuery(''); } else if (cwd) setCwd(dirname(cwd)); break;
      case 'rename': e.preventDefault(); startRename(focusedEntry); break;
      case 'trash': e.preventDefault(); trashItems(selectedEntries.length ? selectedEntries : focusedEntry ? [focusedEntry] : []); break;
      case 'new-file': e.preventDefault(); setDialogError(null); setDialog({ kind: 'new', itemKind: 'file' }); break;
      case 'new-folder': e.preventDefault(); setDialogError(null); setDialog({ kind: 'new', itemKind: 'dir' }); break;
      case 'copy': e.preventDefault(); copyToClipboard('copy'); break;
      case 'cut': e.preventDefault(); copyToClipboard('cut'); break;
      case 'paste': e.preventDefault(); paste(); break;
      case 'select-all': e.preventDefault(); setSelected(new Set(visible.map(x => x.path))); break;
      case 'escape': if (menu) setMenu(null); else if (query) setQuery(''); else setSelected(new Set()); break;
      case 'refresh': e.preventDefault(); refresh(); break;
      case 'menu': {
        e.preventDefault();
        const el = focused ? listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(focused)}"]`) : listRef.current;
        const r = el?.getBoundingClientRect();
        setMenu({ x: (r?.left ?? 0) + 24, y: (r?.bottom ?? 0) });
        break;
      }
      default: break;
    }
  };

  // ---------- menu contextual ----------
  const menuItems = (): MenuItem[] => {
    const target = selectedEntries.length ? selectedEntries : focusedEntry ? [focusedEntry] : [];
    const one = target.length === 1 ? target[0] : null;
    const abs = (p: string) => (root ? absolutePath(root.path, p) : p);
    return [
      { label: 'Abrir', shortcut: 'Enter', disabled: !one, onSelect: () => one && openEntry(one) },
      { label: one?.type === 'dir' ? 'Abrir pasta no Explorer' : 'Abrir no programa padrão', disabled: !one, onSelect: () => one && onOpenExternal(one.type === 'dir' ? 'folder' : 'file', abs(one.path)) },
      { label: 'Abrir esta pasta no Explorer', onSelect: () => onOpenExternal('folder', abs(cwd)) },
      { separator: true, label: '' },
      { label: 'Novo arquivo', shortcut: 'Alt+N', onSelect: () => { setDialogError(null); setDialog({ kind: 'new', itemKind: 'file' }); } },
      { label: 'Nova pasta', shortcut: 'Alt+Shift+N', onSelect: () => { setDialogError(null); setDialog({ kind: 'new', itemKind: 'dir' }); } },
      { separator: true, label: '' },
      { label: 'Renomear', shortcut: 'F2', disabled: !one, onSelect: () => startRename(one) },
      { label: 'Copiar', shortcut: 'Ctrl+C', disabled: !target.length, onSelect: () => copyToClipboard('copy') },
      { label: 'Recortar', shortcut: 'Ctrl+X', disabled: !target.length, onSelect: () => copyToClipboard('cut') },
      { label: clipboard ? `Colar (${clipboard.paths.length})` : 'Colar', shortcut: 'Ctrl+V', disabled: !clipboard, onSelect: paste },
      { label: 'Copiar para…', disabled: !target.length, onSelect: () => setDialog({ kind: 'pick-dest', op: 'copy', paths: target.map(t => t.path) }) },
      { label: 'Mover para…', disabled: !target.length, onSelect: () => guardUnsavedPaths(target.map(t => t.path), () => setDialog({ kind: 'pick-dest', op: 'move', paths: target.map(t => t.path) })) },
      { separator: true, label: '' },
      { label: target.length > 1 ? `Enviar ${target.length} itens para a lixeira` : 'Enviar para a lixeira', shortcut: 'Delete', danger: true, disabled: !target.length, onSelect: () => trashItems(target) },
    ];
  };

  const crumbs = root ? breadcrumbs(cwd, root.name) : [];
  const onDirtyChange = useCallback((p: string | null, d: boolean) => setDirtyPath(d ? p : null), []);

  // ---------- render ----------
  if (!roots.length) {
    return (
      <div className="hq-fx hq-fx--empty">
        <div className="hq-fx-emptystate">
          <p>Nenhuma pasta cadastrada: adicione um projeto ou uma pasta.</p>
          <button type="button" className="hq-fx-btn hq-fx-btn--primary" onClick={() => { setDialogError(null); setDialog({ kind: 'add-folder' }); }} disabled={!connected}><IconPlus size={14} /> Adicionar pasta</button>
        </div>
        <AddFolderDialog open={dialog?.kind === 'add-folder'} busy={dialogBusy} error={dialogError} onSubmit={addFolder} onCancel={() => setDialog(null)} />
      </div>
    );
  }

  return (
    <div className="hq-fx" onContextMenu={e => e.preventDefault()}>
      {!connected && <div className="hq-fx-offline" role="status">Sem conexão com o serviço da HQ: mostrando o último estado conhecido. As ações ficam desligadas até reconectar.</div>}
      <div className="hq-fx-toolbar">
        <select className="hq-fx-input hq-fx-rootsel" value={rootId ?? ''} onChange={e => { setRootId(e.target.value); setCwd(''); }} aria-label="Raiz">
          {roots.map(r => <option key={r.id} value={r.id}>{r.kind === 'project' ? 'Projeto: ' : 'Pasta: '}{r.name}</option>)}
        </select>
        <button type="button" className="hq-fx-btn hq-fx-btn--sm" onClick={() => { setDialogError(null); setDialog({ kind: 'add-folder' }); }} disabled={!connected} title="Cadastrar outra pasta local"><IconPlus size={13} /> Adicionar pasta</button>
        {root?.kind === 'folder' && <button type="button" className="hq-fx-btn hq-fx-btn--sm hq-fx-btn--ghost" onClick={() => setDialog({ kind: 'remove-folder', root })} disabled={!connected} title="Tira do cadastro; não mexe no disco">Remover do cadastro</button>}
        <nav className="hq-fx-crumbs" aria-label="Caminho">
          {crumbs.map((c, i) => (
            <span key={c.path || '(raiz)'} className="hq-fx-crumbs__item">
              {i > 0 && <IconChevron size={11} className="hq-fx-crumbs__sep" />}
              <button type="button" className={`hq-fx-crumbs__btn${i === crumbs.length - 1 ? ' hq-fx-crumbs__btn--on' : ''}`} onClick={() => setCwd(c.path)} title={root ? absolutePath(root.path, c.path) : c.path}>{c.name}</button>
            </span>
          ))}
        </nav>
        <label className="hq-fx-search">
          <IconSearch size={14} />
          <input className="hq-fx-search__input" value={query} onChange={e => setQuery(e.target.value)} placeholder={`Buscar por nome em ${root?.name ?? 'raiz'}`} aria-label="Buscar por nome" onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); } e.stopPropagation(); }} />
          {query && <button type="button" className="hq-fx-iconbtn hq-fx-iconbtn--xs" onClick={() => setQuery('')} aria-label="Limpar busca"><IconX size={12} /></button>}
        </label>
        <select className="hq-fx-input hq-fx-sortsel" value={`${sortKey}:${sortDir}`} onChange={e => { const [k, d] = e.target.value.split(':'); setSortKey(k as SortKey); setSortDir(d as SortDir); }} aria-label="Ordenação">
          <option value="name:asc">Nome A→Z</option><option value="name:desc">Nome Z→A</option>
          <option value="mtime:desc">Mais recentes</option><option value="mtime:asc">Mais antigos</option>
          <option value="size:desc">Maiores</option><option value="size:asc">Menores</option>
        </select>
        <button type="button" className="hq-fx-iconbtn" onClick={refresh} title="Atualizar (F5)" aria-label="Atualizar"><IconRefresh size={15} /></button>
      </div>

      <div className="hq-fx-body">
        <aside className="hq-fx-treepane">
          {root && <FolderTree api={api} rootId={root.id} rootName={root.name} selectedPath={cwd} onSelect={setCwd} changeKey={treeChange} reloadNonce={treeReload} />}
        </aside>

        <div ref={listRef} className="hq-fx-list" role="listbox" aria-multiselectable tabIndex={0} aria-label="Itens da pasta" onKeyDown={onKeyDown}
          onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
          onClick={e => { if (e.target === e.currentTarget) setSelected(new Set()); }}>
          <div className="hq-fx-list__head" aria-hidden>
            <span className="hq-fx-col--name">{results ? `Resultados para “${query.trim()}”${results.length >= 300 ? ' (primeiros 300)' : ''}` : 'Nome'}</span>
            <span className="hq-fx-col--size">Tamanho</span>
            <span className="hq-fx-col--date">Modificado</span>
          </div>
          {listError && <div className="hq-fx-error hq-fx-list__msg" role="alert">{listError}</div>}
          {!listError && !loading && !searching && visible.length === 0 && (
            <div className="hq-fx-list__msg hq-fx-dim">{results ? 'Nada encontrado.' : 'Pasta vazia. Alt+N cria um arquivo; botão direito abre o menu.'}</div>
          )}
          {(loading && !entries.length) || searching ? <div className="hq-fx-list__msg hq-fx-dim">{searching ? 'Buscando…' : 'Carregando…'}</div> : null}
          {visible.map(entry => {
            const isSel = selected.has(entry.path); const isFoc = focused === entry.path;
            const cut = clipboard?.op === 'cut' && clipboard.rootId === rootId && clipboard.paths.includes(entry.path);
            return (
              <div key={entry.path} data-path={entry.path} role="option" aria-selected={isSel}
                className={`hq-fx-row${isSel ? ' hq-fx-row--sel' : ''}${isFoc ? ' hq-fx-row--focus' : ''}${cut ? ' hq-fx-row--cut' : ''}`}
                onClick={e => clickEntry(e, entry)} onDoubleClick={() => openEntry(entry)}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (!selected.has(entry.path)) selectOne(entry.path); else setFocused(entry.path); setMenu({ x: e.clientX, y: e.clientY }); }}>
                <span className="hq-fx-col--name">
                  <FileIcon kind={fileKind(entry)} size={16} />
                  {renaming?.path === entry.path ? (
                    <input className="hq-fx-rename" value={renaming.value} autoFocus spellCheck={false} aria-label="Novo nome"
                      onChange={e => setRenaming({ path: entry.path, value: e.target.value })}
                      onFocus={e => { const dot = entry.type === 'file' ? e.target.value.lastIndexOf('.') : -1; e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length); }}
                      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); void commitRename(); } else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); } }}
                      onBlur={() => void commitRename()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} />
                  ) : (
                    <span className="hq-fx-row__name" title={entry.path}>{entry.name}{results && <span className="hq-fx-row__path">{dirname(entry.path) || '/'}</span>}</span>
                  )}
                  {entry.type === 'dir' && entry.childCount != null && <span className="hq-fx-row__count">{entry.childCount}</span>}
                </span>
                <span className="hq-fx-col--size">{entry.type === 'file' ? formatSize(entry.size) : entry.type === 'symlink' ? 'link' : ''}</span>
                <span className="hq-fx-col--date">{formatDate(entry.mtime)}</span>
              </div>
            );
          })}
        </div>

        <section className="hq-fx-previewpane" aria-label="Conteúdo">
          {root && <Preview api={api} rootId={root.id} rootPath={root.path} entry={previewEntry} connected={connected} reloadNonce={previewReload} onOpenExternal={onOpenExternal} onNotice={onNotice} onDirtyChange={onDirtyChange} />}
        </section>
      </div>

      <footer className="hq-fx-status">
        <span>{results ? `${visible.length} resultado(s)` : `${entries.length} ${entries.length === 1 ? 'item' : 'itens'}`}</span>
        {selected.size > 0 && <span>· {selected.size} selecionado(s)</span>}
        {truncated && <span className="hq-fx-status__warn">· lista cortada em 2000 entradas; use a busca</span>}
        {clipboard && <span>· área de transferência: {clipboard.paths.length} ({clipboard.op === 'copy' ? 'copiar' : 'mover'})</span>}
        <span className="hq-fx-grow" />
        {root && <span className="hq-fx-mono hq-fx-dim" title={root.path}>{absolutePath(root.path, cwd)}</span>}
      </footer>

      {toast && (
        <div className="hq-fx-toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button type="button" className="hq-fx-toast__undo" onClick={() => { const u = toast.undo; setToast(null); u?.(); }}>Desfazer</button>}
          <button type="button" className="hq-fx-iconbtn hq-fx-iconbtn--xs" onClick={() => setToast(null)} aria-label="Fechar aviso"><IconX size={12} /></button>
        </div>
      )}

      <ContextMenu open={Boolean(menu)} x={menu?.x ?? 0} y={menu?.y ?? 0} items={menuItems()} onClose={() => { setMenu(null); listRef.current?.focus(); }} />

      <ConfirmTrashDialog open={dialog?.kind === 'confirm-trash'} items={dialog?.kind === 'confirm-trash' ? dialog.items : []} rootPath={root?.path ?? ''} busy={dialogBusy}
        onConfirm={async () => { if (dialog?.kind === 'confirm-trash') { setDialogBusy(true); try { await doTrash(dialog.items, false); } finally { setDialogBusy(false); } } }} onCancel={() => setDialog(null)} />
      <InUseDialog open={dialog?.kind === 'in-use'} inUse={dialog?.kind === 'in-use' ? dialog.inUse : []} message={dialog?.kind === 'in-use' ? dialog.message : ''} canInterrupt={Boolean(onInterruptSessions)} busy={dialogBusy}
        onProceed={async () => { if (dialog?.kind === 'in-use') { setDialogBusy(true); try { await dialog.retry(); } catch (err) { onNotice('error', errorText(err)); } finally { setDialogBusy(false); } } }} onCancel={() => setDialog(null)} />
      <PickDestinationDialog open={dialog?.kind === 'pick-dest'} api={api} roots={roots} initialRootId={rootId ?? roots[0].id} busy={dialogBusy}
        title={dialog?.kind === 'pick-dest' ? `${dialog.op === 'copy' ? 'Copiar' : 'Mover'} ${dialog.paths.length} ${dialog.paths.length === 1 ? 'item' : 'itens'} para…` : ''}
        confirmLabel={dialog?.kind === 'pick-dest' && dialog.op === 'copy' ? 'Copiar aqui' : 'Mover para cá'}
        onPick={(destRoot, destDir, policy) => { if (dialog?.kind === 'pick-dest' && rootId) void transfer(dialog.op, rootId, dialog.paths, destRoot, destDir, policy); }} onCancel={() => setDialog(null)} />
      <AddFolderDialog open={dialog?.kind === 'add-folder'} busy={dialogBusy} error={dialogError} onSubmit={addFolder} onCancel={() => setDialog(null)} />
      <NameDialog open={dialog?.kind === 'new'} title={dialog?.kind === 'new' && dialog.itemKind === 'dir' ? 'Nova pasta' : 'Novo arquivo'} label={`Nome (em ${root ? absolutePath(root.path, cwd) : ''})`}
        confirmLabel="Criar" busy={dialogBusy} error={dialogError} onSubmit={createItem} onCancel={() => setDialog(null)} />
      <ConfirmDialog open={dialog?.kind === 'unsaved'} title="Alterações não salvas" confirmLabel="Descartar e continuar" danger
        text={`O arquivo aberto no editor (${dirtyPath ?? ''}) tem alterações que ainda não foram gravadas. Continuar descarta essas alterações.`}
        onConfirm={() => { if (dialog?.kind === 'unsaved') { const p = dialog.proceed; setDialog(null); p(); } }} onCancel={() => setDialog(null)} />
      <ConfirmDialog open={dialog?.kind === 'remove-folder'} title="Remover pasta do cadastro" confirmLabel="Remover do cadastro"
        text={dialog?.kind === 'remove-folder' ? `"${dialog.root.name}" deixa de aparecer na HQ. Nada é apagado do disco (${dialog.root.path}).` : ''}
        onConfirm={() => { if (dialog?.kind === 'remove-folder' && dialog.root.folderId) { api.folderRemove(dialog.root.folderId); onNotice('info', `Pasta removida do cadastro: ${dialog.root.name}`); } setDialog(null); }} onCancel={() => setDialog(null)} />
    </div>
  );
}
