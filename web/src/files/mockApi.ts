// FsApi em memória para o playground (files.html). SÓ demonstração: nenhum disco é tocado.
// Imita as respostas e os erros reais do servidor: 'in_use' (pasta "cliente-site"), 'conflict' (mtime), 'exists', 'not_found'.
import type { Folder, FsBatchResult, FsConflictPolicy, FsEntry, FsInUse, FsListResult, FsOpError, FsReadResult, FsRoot, TrashItem } from '@milweb-hq/protocol';
import type { FsApi } from './api';
import { basename, dirname, joinPath, uniqueName } from './helpers';

class MockError extends Error { constructor(message: string, readonly code: string, readonly data?: unknown) { super(message); this.name = 'RequestError'; } }

interface MFile { kind: 'file'; content: string; base64?: string; mediaType: string; mtime: number }
interface MDir { kind: 'dir'; children: Map<string, MNode>; mtime: number }
type MNode = MFile | MDir;

const T0 = Date.now() - 3 * 86_400_000;
const file = (content: string, mediaType = 'text/plain', age = 0): MFile => ({ kind: 'file', content, mediaType, mtime: T0 + age });
const dir = (entries: Record<string, MNode>, age = 0): MDir => ({ kind: 'dir', children: new Map(Object.entries(entries)), mtime: T0 + age });

// PNG 2x2 em base64 (vermelho/azul) só para o preview de imagem do playground.
const PNG_2X2 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwHwyBGET8/5+BAQBc8Qf9z2ZUngAAAABJRU5ErkJggg==';

export interface MockState { roots: FsRoot[]; sessionsAlive: boolean }

export function createMockFsApi(onRootsChange: (roots: FsRoot[]) => void, onTrashChange: () => void): FsApi & { state: MockState; bumpExternal(path: string): void } {
  const trees = new Map<string, MDir>();
  trees.set('project:p1', dir({
    'src': dir({
      'App.tsx': file('export function App() {\n  return <main>Agência de Turismo</main>;\n}\n', 'text/tsx', 3600_000),
      'main.tsx': file("import { createRoot } from 'react-dom/client';\n", 'text/tsx', 3500_000),
      'styles': dir({ 'app.css': file('body { margin: 0; }\n', 'text/css') }),
    }, 3600_000),
    'public': dir({ 'logo.png': { kind: 'file', content: '', base64: PNG_2X2, mediaType: 'image/png', mtime: T0 } }),
    'cliente-site': dir({ 'index.html': file('<!doctype html><title>Site do cliente</title>', 'text/html', 7200_000) }, 7200_000),
    'notas.md': file('# Notas do projeto\n\n- revisar a seção hero\n- trocar a foto da equipe\n', 'text/markdown', 86_400_000),
    'package.json': file('{\n  "name": "exemplo-turismo",\n  "private": true\n}\n', 'application/json', 2 * 86_400_000),
    'README.md': file('# Exemplo turismo\n\nLanding page de demonstração.\n', 'text/markdown', 2 * 86_400_000),
    'relatorio.pdf': { kind: 'file', content: '', mediaType: 'application/pdf', mtime: T0 + 1000 },
    'node_modules': dir({ 'react': dir({ 'index.js': file('module.exports = {}', 'text/javascript') }) }),
  }));
  trees.set('folder:f1', dir({
    'Documentos': dir({ 'proposta.txt': file('Proposta comercial Aurora\n', 'text/plain', 1000) }),
    'fotos': dir({}),
    'lista.csv': file('nome;valor\nsite;1200\n', 'text/csv'),
  }));

  const state: MockState = {
    roots: [
      { id: 'project:p1', kind: 'project', name: 'exemplo-turismo', path: 'C:\\Users\\usuario\\projetos\\exemplo-turismo', projectId: 'p1' },
      { id: 'folder:f1', kind: 'folder', name: 'Documentos do Chefe', path: 'C:\\Users\\usuario\\Documentos', folderId: 'f1' },
    ],
    sessionsAlive: true,
  };
  const trash: (TrashItem & { node: MNode; rel: string })[] = [];
  let seq = 1;

  const rootOf = (rootId: string) => { const t = trees.get(rootId); if (!t) throw new MockError(`raiz não cadastrada: ${rootId}`, 'not_found'); return t; };
  const resolve = (rootId: string, rel: string): { node: MNode; parent: MDir | null; name: string } => {
    if (rel.includes('..') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) throw new MockError(`caminho fora da raiz: ${rel}`, 'outside_root');
    let node: MNode = rootOf(rootId); let parent: MDir | null = null; let name = '';
    for (const seg of rel.split('/').filter(Boolean)) {
      if (node.kind !== 'dir') throw new MockError(`o item não existe mais: ${rel}`, 'not_found');
      const next = node.children.get(seg);
      if (!next) throw new MockError(`o item não existe mais: ${rel}`, 'not_found');
      parent = node; node = next; name = seg;
    }
    return { node, parent, name };
  };
  const entry = (name: string, path: string, n: MNode): FsEntry => n.kind === 'dir'
    ? { name, path, type: 'dir', mtime: n.mtime, childCount: name === 'node_modules' ? null : n.children.size }
    : { name, path, type: 'file', size: n.base64 ? Math.floor(n.base64.length * 0.75) : new TextEncoder().encode(n.content).length, mtime: n.mtime };
  const delay = <T>(v: T) => new Promise<T>(r => setTimeout(() => r(v), 60));
  const inUseFor = (rootId: string, paths: string[]): FsInUse[] => (state.sessionsAlive && rootId === 'project:p1'
    ? paths.filter(p => p === '' || p === 'cliente-site').map(p => ({ path: p, sessions: [{ sessionId: 's-1', employeeId: 'e-1', employeeName: 'Léo', projectName: 'Site do cliente', taskStatus: 'running', processAlive: true }] }))
    : []);

  const api: FsApi = {
    roots: () => delay(state.roots),
    list: (rootId, path) => { const { node } = resolve(rootId, path); if (node.kind !== 'dir') throw new MockError('não é uma pasta', 'not_found'); const root = state.roots.find(r => r.id === rootId)!; return delay<FsListResult>({ root, path, entries: [...node.children].map(([n, c]) => entry(n, joinPath(path, n), c)), truncated: false }); },
    stat: (rootId, path) => { const { node, name } = resolve(rootId, path); return delay(entry(name, path, node)); },
    read: (rootId, path) => {
      const { node } = resolve(rootId, path);
      if (node.kind !== 'file') throw new MockError('não é um arquivo', 'io');
      const base = { path, size: node.base64 ? Math.floor(node.base64.length * 0.75) : node.content.length, mtime: node.mtime, mediaType: node.mediaType };
      if (node.base64) return delay<FsReadResult>({ ...base, encoding: 'base64', content: node.base64, truncated: false, binary: true });
      if (node.mediaType === 'application/pdf') return delay<FsReadResult>({ ...base, size: 184_320, encoding: 'none', content: '', truncated: false, binary: true });
      return delay<FsReadResult>({ ...base, encoding: 'utf8', content: node.content, truncated: false, binary: false });
    },
    write: (rootId, path, content, expectedMtime) => {
      const { node } = resolve(rootId, path);
      if (node.kind !== 'file') throw new MockError('não é um arquivo', 'io');
      if (expectedMtime != null && node.mtime !== expectedMtime) throw new MockError(`o arquivo mudou no disco desde a leitura: ${path}`, 'conflict');
      node.content = content; node.mtime = Date.now();
      return delay({ path, size: content.length, mtime: node.mtime });
    },
    create: (rootId, path, kind) => {
      const { node: parent } = resolve(rootId, dirname(path)); const name = basename(path);
      if (parent.kind !== 'dir') throw new MockError('pasta inválida', 'not_found');
      if (/[<>:"/\\|?*]/.test(name)) throw new MockError(`o nome "${name}" tem caracteres que o Windows não aceita`, 'invalid_name');
      if (parent.children.has(name)) throw new MockError(`já existe um item com esse nome: ${path}`, 'exists');
      const n: MNode = kind === 'dir' ? dir({}) : file('', 'text/plain'); n.mtime = Date.now(); parent.children.set(name, n);
      return delay(entry(name, path, n));
    },
    rename: (rootId, path, newName) => {
      const { node, parent, name } = resolve(rootId, path);
      if (!parent) throw new MockError('a raiz não pode ser renomeada', 'protected');
      if (parent.children.has(newName) && newName.toLowerCase() !== name.toLowerCase()) throw new MockError(`já existe um item chamado "${newName}" nesta pasta`, 'exists');
      parent.children.delete(name); parent.children.set(newName, node);
      return delay(entry(newName, joinPath(dirname(path), newName), node));
    },
    move: (rootId, paths, targetRootId, targetDir, onConflict = 'fail', force) => {
      const inUse = inUseFor(rootId, paths);
      if (inUse.length && !force) throw new MockError('há execuções da HQ usando o que você quer mover', 'in_use', inUse);
      return delay(transfer('move', rootId, paths, targetRootId, targetDir, onConflict));
    },
    copy: (rootId, paths, targetRootId, targetDir, onConflict = 'fail') => delay(transfer('copy', rootId, paths, targetRootId, targetDir, onConflict)),
    trash: (rootId, paths, force) => {
      const inUse = inUseFor(rootId, paths);
      if (inUse.length && !force) throw new MockError(`há execuções da HQ usando ${inUse.length === 1 ? 'este caminho' : 'estes caminhos'}`, 'in_use', inUse);
      const items: TrashItem[] = []; const errors: FsOpError[] = [];
      for (const p of paths) {
        try {
          const { node, parent, name } = resolve(rootId, p);
          if (!parent) throw new MockError('a raiz inteira só com confirmação', 'protected');
          parent.children.delete(name);
          const root = state.roots.find(r => r.id === rootId)!;
          const count = node.kind === 'dir' ? countNodes(node) : null;
          const it: TrashItem & { node: MNode; rel: string } = { id: `t-${seq++}`, name, originPath: `${root.path}\\${p.replace(/\//g, '\\')}`, rootId, kind: node.kind, size: node.kind === 'file' ? node.content.length : count === null ? null : sizeNodes(node), count, deletedAt: Date.now(), node, rel: p };
          trash.unshift(it); items.push(strip(it));
        } catch (err) { errors.push({ path: p, code: (err as MockError).code as FsOpError['code'], message: (err as Error).message }); }
      }
      onTrashChange();
      return delay({ items, errors });
    },
    inUse: (rootId, paths) => delay(inUseFor(rootId, paths)),
    search: (rootId, query, limit = 200) => {
      const out: FsEntry[] = []; const q = query.toLowerCase();
      const walk = (d: MDir, rel: string) => { for (const [n, c] of d.children) { if (out.length >= limit) return; const p = joinPath(rel, n); if (n.toLowerCase().includes(q)) out.push(entry(n, p, c)); if (c.kind === 'dir' && n !== 'node_modules') walk(c, p); } };
      walk(rootOf(rootId), '');
      return delay(out);
    },
    watch: () => {},
    trashList: () => delay(trash.map(strip)),
    trashRestore: (id, onConflict = 'fail') => {
      const i = trash.findIndex(t => t.id === id);
      if (i < 0) throw new MockError('este item já não está na lixeira', 'not_found');
      const it = trash[i];
      const tree = trees.get(it.rootId ?? '') ?? null;
      if (!tree) throw new MockError('raiz original não existe mais', 'not_found');
      let parent: MDir = tree;
      for (const seg of dirname(it.rel).split('/').filter(Boolean)) { let n = parent.children.get(seg); if (!n) { n = dir({}); parent.children.set(seg, n); } if (n.kind !== 'dir') throw new MockError('caminho original agora é um arquivo', 'io'); parent = n; }
      let name = it.name;
      if (parent.children.has(name)) {
        if (onConflict !== 'rename') throw new MockError(`já existe "${name}" em ${dirname(it.originPath.replace(/\\/g, '/'))}; restaure com outro nome`, 'exists');
        name = uniqueName(name.replace(/(\.[^.]+)?$/, ' (restaurado)$1'), n => parent.children.has(n), it.kind === 'dir');
      }
      parent.children.set(name, it.node); trash.splice(i, 1); onTrashChange();
      return delay({ restoredTo: `${dirname(it.originPath.replace(/\\/g, '/')).replace(/\//g, '\\')}\\${name}` });
    },
    trashDelete: id => { const i = trash.findIndex(t => t.id === id); if (i < 0) throw new MockError('este item já não está na lixeira', 'not_found'); trash.splice(i, 1); onTrashChange(); return delay(true as const); },
    trashEmpty: () => { trash.length = 0; onTrashChange(); return delay(true as const); },
    folderAdd: (path, name) => {
      const p = path.trim();
      if (!/^[a-zA-Z]:\\/.test(p)) throw new MockError(`a pasta não existe: ${p}`, 'not_found');
      if (state.roots.some(r => r.path.toLowerCase() === p.toLowerCase())) throw new MockError('esta pasta já está cadastrada', 'exists');
      if (/MilWebHQ/i.test(p)) throw new MockError('esta pasta pertence ao próprio My Company AI (dados ou instalação)', 'protected');
      const id = `f${seq++}`;
      const folder: Folder = { id, name: name ?? p.split('\\').filter(Boolean).pop() ?? p, path: p, addedAt: Date.now() };
      trees.set(`folder:${id}`, dir({ 'exemplo.txt': file('pasta adicionada no playground\n') }));
      state.roots = [...state.roots, { id: `folder:${id}`, kind: 'folder', name: folder.name, path: p, folderId: id }];
      onRootsChange(state.roots);
      return delay(folder);
    },
    folderRemove: id => { state.roots = state.roots.filter(r => r.folderId !== id); trees.delete(`folder:${id}`); onRootsChange(state.roots); },
  };

  function transfer(op: 'move' | 'copy', rootId: string, paths: string[], targetRootId: string, targetDir: string, policy: FsConflictPolicy): FsBatchResult {
    const { node: target } = resolve(targetRootId, targetDir);
    if (target.kind !== 'dir') throw new MockError('a pasta de destino não existe', 'not_found');
    const r: FsBatchResult = { done: [], errors: [] };
    for (const p of paths) {
      try {
        const { node, parent, name } = resolve(rootId, p);
        if (!parent) throw new MockError('a raiz inteira não pode ser movida', 'protected');
        if (node.kind === 'dir' && (targetDir === p || targetDir.startsWith(p + '/')) && rootId === targetRootId) throw new MockError(`não é possível ${op === 'move' ? 'mover' : 'copiar'} a pasta "${name}" para dentro dela mesma`, 'io');
        let destName = name;
        if (target.children.has(name)) {
          if (policy === 'fail') throw new MockError(`já existe "${name}" no destino`, 'exists');
          if (policy === 'rename') destName = uniqueName(name, n => target.children.has(n), node.kind === 'dir');
        }
        const copy = op === 'copy' ? clone(node) : node;
        if (op === 'move') parent.children.delete(name);
        target.children.set(destName, copy);
        r.done.push({ from: p, to: joinPath(targetDir, destName) });
      } catch (err) { r.errors.push({ path: p, code: (err as MockError).code as FsOpError['code'], message: (err as Error).message }); }
    }
    return r;
  }

  return Object.assign(api, {
    state,
    /** Simula outro programa mudando um arquivo (mtime novo): a próxima gravação com expectedMtime antigo dá 'conflict'. */
    bumpExternal(path: string) { const { node } = resolve('project:p1', path); node.mtime = Date.now() + 1; if (node.kind === 'file') node.content += '\n<!-- alterado fora da HQ -->'; },
  });
}

function clone(n: MNode): MNode { return n.kind === 'dir' ? { kind: 'dir', mtime: n.mtime, children: new Map([...n.children].map(([k, v]) => [k, clone(v)])) } : { ...n }; }
function countNodes(d: MDir): number { let c = 0; for (const [, v] of d.children) { c++; if (v.kind === 'dir') c += countNodes(v); } return c; }
function sizeNodes(d: MDir): number { let s = 0; for (const [, v] of d.children) s += v.kind === 'dir' ? sizeNodes(v) : v.content.length; return s; }
function strip(it: TrashItem & { node?: MNode; rel?: string }): TrashItem { const { id, name, originPath, rootId, kind, size, count, deletedAt } = it; return { id, name, originPath, rootId, kind, size, count, deletedAt }; }
