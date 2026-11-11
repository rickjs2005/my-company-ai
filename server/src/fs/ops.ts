// Operações no disco real dentro das raízes autorizadas. Nada aqui segue links, sai da raiz nem toca pastas protegidas.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FsBatchResult, FsConflictPolicy, FsEntry, FsInUse, FsListResult, FsReadResult, FsWriteResult, Session } from '@milweb-hq/protocol';
import type { Store } from '../store.js';
import { FsError, toFsError } from './errors.js';
import { isInside, joinRel, relBasename, relDirname, validateName, type RootInfo, type Roots } from './paths.js';

export const LIST_LIMIT = 2000;
/** Até este total de entradas na pasta, contar os filhos de cada subpasta é barato; acima disso childCount = null. */
const CHILD_COUNT_MAX_ENTRIES = 200;
export const TEXT_MAX = 512 * 1024;
export const IMAGE_MAX = 4 * 1024 * 1024;
export const SEARCH_MAX_VISITED = 20_000;
export const SEARCH_DEFAULT_LIMIT = 200;
export const SEARCH_MAX_LIMIT = 1000;
export const SEARCH_IGNORED = new Set(['node_modules', '.git', 'dist', '.next', '.venv']);

const MEDIA: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.ts': 'text/typescript', '.tsx': 'text/tsx', '.jsx': 'text/jsx', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.scss': 'text/x-scss', '.xml': 'application/xml', '.yml': 'text/yaml', '.yaml': 'text/yaml',
  '.toml': 'text/toml', '.csv': 'text/csv', '.py': 'text/x-python', '.sh': 'text/x-sh', '.ps1': 'text/x-powershell', '.cmd': 'text/x-bat', '.bat': 'text/x-bat', '.env': 'text/plain', '.sql': 'text/x-sql',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.exe': 'application/vnd.microsoft.portable-executable', '.dll': 'application/octet-stream', '.sqlite': 'application/vnd.sqlite3', '.db': 'application/octet-stream',
};
const IMAGE_PREVIEW = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

export function mediaTypeFor(name: string): string { return MEDIA[path.extname(name).toLowerCase()] ?? 'application/octet-stream'; }

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
export function compareEntries(a: FsEntry, b: FsEntry): number {
  const da = a.type === 'dir' ? 0 : 1; const db = b.type === 'dir' ? 0 : 1;
  return da - db || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function entryFromStat(name: string, rel: string, st: fs.Stats): FsEntry {
  const type: FsEntry['type'] = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  const e: FsEntry = { name, path: rel, type, mtime: st.mtimeMs };
  if (type === 'file') e.size = st.size;
  return e;
}

/** Conta filhos diretos de uma pasta (null se falhar ou for pasta pesada conhecida). */
function cheapChildCount(abs: string, name: string): number | null {
  if (SEARCH_IGNORED.has(name)) return null;
  try { return fs.readdirSync(abs).length; } catch { return null; }
}

/** Conta itens e bytes de uma árvore sem seguir links. Devolve null ao passar de `limit` itens. */
export function countTree(abs: string, limit: number): { count: number; size: number } | null {
  const st = fs.lstatSync(abs);
  if (!st.isDirectory()) return { count: 1, size: st.size };
  let count = 0; let size = 0;
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of ents) {
      count++;
      if (count > limit) return null;
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) stack.push(p);
      else if (d.isFile()) { try { size += fs.lstatSync(p).size; } catch { /* some */ } }
    }
  }
  return { count, size };
}

/** Nome livre no estilo "nome (2).ext". */
export function uniqueName(dir: string, name: string, suffix: (n: number) => string = n => ` (${n})`): string {
  const ext = fs.lstatSync(path.join(dir, name)).isDirectory() ? '' : path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; n < 10_000; n++) {
    const cand = `${base}${suffix(n)}${ext}`;
    if (!fs.existsSync(path.join(dir, cand))) return cand;
  }
  throw new FsError('exists', `não há nome livre para ${name}`);
}

function existsLstat(p: string): fs.Stats | null { try { return fs.lstatSync(p); } catch { return null; } }

/** Cópia entre volumes com verificação: só apaga a origem quando contagem e tamanhos conferem. */
export function transferAcrossVolumes(src: string, dest: string): void {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, dereference: false, verbatimSymlinks: true });
  else fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  const a = countTree(src, Number.MAX_SAFE_INTEGER); const b = countTree(dest, Number.MAX_SAFE_INTEGER);
  if (!a || !b || a.count !== b.count || a.size !== b.size) {
    throw new FsError('io', `cópia incompleta para outra unidade (origem ${a?.count ?? '?'} itens / ${a?.size ?? '?'} bytes, destino ${b?.count ?? '?'} / ${b?.size ?? '?'}); a origem foi mantida em ${src}`);
  }
  fs.rmSync(src, { recursive: true, force: false });
}

/** rename com tratamento de EXDEV (outra unidade → copiar, verificar, apagar origem). */
export function moveItem(src: string, dest: string): void {
  try { fs.renameSync(src, dest); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    transferAcrossVolumes(src, dest);
  }
}

export interface OpsDeps {
  roots: Roots;
  store: Store;
  manager: { listSessions(): Session[] };
}

export class FsOps {
  constructor(private deps: OpsDeps) {}

  list(info: RootInfo, rel: string): FsListResult {
    const { abs, rel: nrel, stat } = this.deps.roots.resolve(info, rel);
    if (!stat?.isDirectory()) throw new FsError('not_found', `não é uma pasta: ${nrel || '(raiz)'}`, nrel);
    let dirents: fs.Dirent[];
    try { dirents = fs.readdirSync(abs, { withFileTypes: true }); } catch (err) { throw toFsError(err, nrel); }
    const truncated = dirents.length > LIST_LIMIT;
    const countChildren = dirents.length <= CHILD_COUNT_MAX_ENTRIES;
    const entries: FsEntry[] = [];
    for (const d of dirents) {
      const p = path.join(abs, d.name);
      const st = existsLstat(p);
      const e: FsEntry = st ? entryFromStat(d.name, joinRel(nrel, d.name), st) : { name: d.name, path: joinRel(nrel, d.name), type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : d.isFile() ? 'file' : 'other' };
      if (e.type === 'dir') e.childCount = countChildren ? cheapChildCount(p, d.name) : null;
      entries.push(e);
    }
    entries.sort(compareEntries);
    return { root: info.root, path: nrel, entries: truncated ? entries.slice(0, LIST_LIMIT) : entries, truncated };
  }

  stat(info: RootInfo, rel: string): FsEntry {
    const { abs, rel: nrel, stat } = this.deps.roots.resolve(info, rel);
    if (!stat) throw new FsError('not_found', `o item não existe mais: ${nrel}`, nrel);
    const e = entryFromStat(nrel ? relBasename(nrel) : info.root.name, nrel, stat);
    if (e.type === 'dir') e.childCount = cheapChildCount(abs, e.name);
    return e;
  }

  read(info: RootInfo, rel: string, maxBytes?: number): FsReadResult {
    const { abs, rel: nrel, stat } = this.deps.roots.resolve(info, rel);
    if (!stat) throw new FsError('not_found', `o item não existe mais: ${nrel}`, nrel);
    if (!stat.isFile()) throw new FsError('io', `não é um arquivo: ${nrel}`, nrel);
    const mediaType = mediaTypeFor(nrel);
    const base = { path: nrel, size: stat.size, mtime: stat.mtimeMs, mediaType };
    if (IMAGE_PREVIEW.has(mediaType)) {
      if (stat.size > IMAGE_MAX) return { ...base, encoding: 'none', content: '', truncated: true, binary: true };
      try { return { ...base, encoding: 'base64', content: fs.readFileSync(abs).toString('base64'), truncated: false, binary: true }; } catch (err) { throw toFsError(err, nrel); }
    }
    const cap = Math.max(1, Math.min(TEXT_MAX, maxBytes ?? TEXT_MAX));
    let fd: number;
    try { fd = fs.openSync(abs, 'r'); } catch (err) { throw toFsError(err, nrel); }
    try {
      const len = Math.min(stat.size, cap);
      const buf = Buffer.alloc(len);
      let off = 0;
      while (off < len) { const n = fs.readSync(fd, buf, off, len - off, off); if (n <= 0) break; off += n; }
      const probe = buf.subarray(0, Math.min(off, 8192));
      if (probe.includes(0)) return { ...base, encoding: 'none', content: '', truncated: stat.size > off, binary: true };
      // Não cortar um caractere UTF-8 no meio quando o arquivo foi truncado.
      let end = off;
      if (stat.size > off) { while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--; if (end > 0 && (buf[end - 1] & 0x80) !== 0) { /* byte inicial de sequência incompleta */ } }
      return { ...base, encoding: 'utf8', content: buf.subarray(0, end).toString('utf8'), truncated: stat.size > off, binary: false };
    } finally { fs.closeSync(fd); }
  }

  write(info: RootInfo, rel: string, content: string, expectedMtime?: number | null): FsWriteResult {
    const { abs, rel: nrel, stat } = this.deps.roots.resolve(info, rel, { allowMissing: true, level: 'write' });
    if (!nrel) throw new FsError('invalid_name', 'informe o arquivo a gravar', nrel);
    if (stat && !stat.isFile()) throw new FsError('io', `não é um arquivo: ${nrel}`, nrel);
    if (expectedMtime != null) {
      if (!stat) throw new FsError('conflict', `o arquivo foi removido do disco desde a leitura: ${nrel}`, nrel);
      if (stat.mtimeMs !== expectedMtime) throw new FsError('conflict', `o arquivo mudou no disco desde a leitura: ${nrel}`, nrel, { mtime: stat.mtimeMs });
    }
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.hq-${randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, abs);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignorar */ }
      throw toFsError(err, nrel);
    }
    const st = fs.statSync(abs);
    return { path: nrel, size: st.size, mtime: st.mtimeMs };
  }

  create(info: RootInfo, rel: string, kind: 'file' | 'dir'): FsEntry {
    const { abs, rel: nrel, stat } = this.deps.roots.resolve(info, rel, { allowMissing: true, level: 'write' });
    if (!nrel) throw new FsError('invalid_name', 'informe o nome do novo item', nrel);
    if (stat) throw new FsError('exists', `já existe um item com esse nome: ${nrel}`, nrel);
    try {
      if (kind === 'dir') fs.mkdirSync(abs);
      else fs.closeSync(fs.openSync(abs, 'wx'));
    } catch (err) { throw toFsError(err, nrel); }
    return entryFromStat(relBasename(nrel), nrel, fs.lstatSync(abs));
  }

  rename(info: RootInfo, rel: string, newName: string): FsEntry {
    const { abs, rel: nrel, stat } = this.deps.roots.resolve(info, rel, { level: 'write' });
    if (!nrel) throw new FsError('protected', 'a raiz não pode ser renomeada pela HQ', nrel);
    if (!stat) throw new FsError('not_found', `o item não existe mais: ${nrel}`, nrel);
    validateName(newName);
    const dir = path.dirname(abs);
    const dest = path.join(dir, newName);
    const destRel = joinRel(relDirname(nrel), newName);
    const caseOnly = newName.toLowerCase() === path.basename(abs).toLowerCase() && newName !== path.basename(abs);
    if (newName === path.basename(abs)) return entryFromStat(newName, nrel, stat);
    if (!caseOnly && existsLstat(dest)) throw new FsError('exists', `já existe um item chamado "${newName}" nesta pasta`, destRel);
    this.deps.roots.assertNotProtected(dest, destRel, 'write');
    try { fs.renameSync(abs, dest); } catch (err) { throw toFsError(err, nrel); }
    return entryFromStat(newName, destRel, fs.lstatSync(dest));
  }

  /** Move ou copia um lote. Erros por item vão em `errors`; nada é "sucesso fingido". */
  transfer(op: 'move' | 'copy', info: RootInfo, rels: string[], target: RootInfo, targetDir: string, policy: FsConflictPolicy = 'fail'): FsBatchResult {
    const t = this.deps.roots.resolve(target, targetDir, { level: 'write' });
    if (!t.stat?.isDirectory()) throw new FsError('not_found', `a pasta de destino não existe: ${t.rel || target.root.name}`, t.rel);
    const result: FsBatchResult = { done: [], errors: [] };
    for (const rel of rels) {
      try {
        const s = this.deps.roots.resolve(info, rel, { level: op === 'move' ? 'write' : 'read' });
        if (!s.rel) throw new FsError('protected', 'a raiz inteira não pode ser movida ou copiada pela HQ', s.rel);
        if (!s.stat) throw new FsError('not_found', `o item não existe mais: ${s.rel}`, s.rel);
        const name = path.basename(s.abs);
        if (s.stat.isDirectory() && isInside(s.abs, t.abs)) throw new FsError('io', `não é possível ${op === 'move' ? 'mover' : 'copiar'} a pasta "${name}" para dentro dela mesma`, s.rel);
        let destName = name;
        let dest = path.join(t.abs, name);
        if (path.resolve(dest) === path.resolve(s.abs) || (process.platform === 'win32' && dest.toLowerCase() === s.abs.toLowerCase())) throw new FsError('exists', `"${name}" já está nesta pasta`, s.rel);
        if (existsLstat(dest)) {
          if (policy === 'fail') throw new FsError('exists', `já existe "${name}" no destino`, joinRel(t.rel, name));
          if (policy === 'rename') { destName = uniqueName(t.abs, name); dest = path.join(t.abs, destName); }
          else if (policy === 'overwrite') {
            this.deps.roots.assertNotProtected(dest, joinRel(t.rel, name), 'write');
            fs.rmSync(dest, { recursive: true, force: false });
          }
        }
        const destRel = joinRel(t.rel, destName);
        this.deps.roots.assertNotProtected(dest, destRel, 'write');
        try {
          if (op === 'move') moveItem(s.abs, dest);
          else if (s.stat.isDirectory()) fs.cpSync(s.abs, dest, { recursive: true, errorOnExist: true, force: false, dereference: false, verbatimSymlinks: true });
          else fs.copyFileSync(s.abs, dest, fs.constants.COPYFILE_EXCL);
        } catch (err) { throw toFsError(err, s.rel); }
        result.done.push({ from: s.rel, to: destRel });
      } catch (err) { result.errors.push(toFsError(err, rel).toOpError()); }
    }
    return result;
  }

  search(info: RootInfo, query: string, limit = SEARCH_DEFAULT_LIMIT): FsEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const max = Math.max(1, Math.min(SEARCH_MAX_LIMIT, limit));
    const out: FsEntry[] = [];
    const queue: string[] = [''];
    let visited = 0;
    while (queue.length && out.length < max && visited < SEARCH_MAX_VISITED) {
      const rel = queue.shift()!;
      const abs = path.join(info.abs, ...rel.split('/').filter(Boolean));
      if (this.deps.roots.isProtected(abs, 'read')) continue;
      let ents: fs.Dirent[];
      try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
      for (const d of ents) {
        if (++visited > SEARCH_MAX_VISITED || out.length >= max) break;
        const childRel = joinRel(rel, d.name);
        if (d.isSymbolicLink()) { if (d.name.toLowerCase().includes(q)) out.push({ name: d.name, path: childRel, type: 'symlink' }); continue; }
        if (d.name.toLowerCase().includes(q)) {
          const st = existsLstat(path.join(abs, d.name));
          out.push(st ? entryFromStat(d.name, childRel, st) : { name: d.name, path: childRel, type: d.isDirectory() ? 'dir' : 'file' });
        }
        if (d.isDirectory() && !SEARCH_IGNORED.has(d.name)) queue.push(childRel);
      }
    }
    return out;
  }

  /** Sessões cujo projeto está dentro (ou é igual) de cada caminho, com processo vivo ou tarefa em andamento. */
  inUse(info: RootInfo, rels: string[]): FsInUse[] {
    const sessions = this.deps.manager.listSessions();
    const running = new Map<string, string>();
    for (const t of this.deps.store.listTasksByStatus(['queued', 'running', 'waiting_permission', 'waiting_answer'])) running.set(t.sessionId, t.status);
    const out: FsInUse[] = [];
    for (const rel of rels) {
      // Caminho que não resolve (fora da raiz, link, protegido) não tem dependentes: a operação em si reporta o erro real.
      let r: { abs: string; rel: string };
      try { r = this.deps.roots.resolve(info, rel, { allowMissing: true }); } catch { continue; }
      const hits: FsInUse['sessions'] = [];
      for (const s of sessions) {
        const alive = s.processState != null;
        const task = running.get(s.id) ?? null;
        if (!alive && !task) continue;
        const project = this.deps.store.getProject(s.projectId);
        if (!project || !isInside(r.abs, path.resolve(project.path))) continue;
        const emp = s.employeeId ? this.deps.store.getEmployee(s.employeeId) : null;
        hits.push({ sessionId: s.id, employeeId: s.employeeId, employeeName: emp?.name ?? s.name, projectName: project.name, taskStatus: task, processAlive: alive });
      }
      if (hits.length) out.push({ path: r.rel, sessions: hits });
    }
    return out;
  }
}
