// Helpers puros do explorador de arquivos (sem DOM): ordenação, nomes, caminhos, formatação e teclado.
import type { FsEntry } from '@milweb-hq/protocol';

export type SortKey = 'name' | 'mtime' | 'size';
export type SortDir = 'asc' | 'desc';

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

/** Pastas sempre antes; dentro de cada grupo, pela chave escolhida (nome sem caixa, data, tamanho). */
export function sortEntries(entries: FsEntry[], key: SortKey = 'name', dir: SortDir = 'asc'): FsEntry[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const ga = a.type === 'dir' ? 0 : 1; const gb = b.type === 'dir' ? 0 : 1;
    if (ga !== gb) return ga - gb;
    let c = 0;
    if (key === 'mtime') c = (a.mtime ?? 0) - (b.mtime ?? 0);
    else if (key === 'size') c = (a.size ?? -1) - (b.size ?? -1);
    if (key !== 'name' && c !== 0) return c * sign;
    // Desempate (ou ordenação por nome): nome sem caixa e com números naturais; só a ordenação por nome inverte.
    return collator.compare(a.name, b.name) * (key === 'name' ? sign : 1);
  });
}

/** "nome (2).ext", "nome (3).ext"… até achar um que não exista. */
export function uniqueName(name: string, exists: (candidate: string) => boolean, isDir = false): string {
  if (!exists(name)) return name;
  const ext = isDir ? '' : extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; n < 10_000; n++) {
    const cand = `${base} (${n})${ext}`;
    if (!exists(cand)) return cand;
  }
  return `${base} (${Date.now()})${ext}`;
}

export function extname(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i);
}
export function basename(rel: string): string { const i = rel.lastIndexOf('/'); return i < 0 ? rel : rel.slice(i + 1); }
export function dirname(rel: string): string { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); }
export function joinPath(...parts: string[]): string { return parts.filter(Boolean).join('/'); }
/** true se `child` é igual a `parent` ou está dentro dele (caminhos relativos com '/'; '' = raiz). */
export function isWithin(parent: string, child: string): boolean {
  if (parent === '') return true;
  return child === parent || child.startsWith(parent + '/');
}

export interface Crumb { name: string; path: string }
/** Breadcrumbs a partir do caminho relativo: raiz + cada segmento acumulado. */
export function breadcrumbs(rel: string, rootName: string): Crumb[] {
  const out: Crumb[] = [{ name: rootName, path: '' }];
  if (!rel) return out;
  let acc = '';
  for (const seg of rel.split('/').filter(Boolean)) { acc = acc ? `${acc}/${seg}` : seg; out.push({ name: seg, path: acc }); }
  return out;
}

/** Caminho absoluto para exibir/abrir no sistema (segue o separador da raiz). */
export function absolutePath(rootPath: string, rel: string): string {
  if (!rel) return rootPath;
  const sep = rootPath.includes('\\') ? '\\' : '/';
  const base = rootPath.replace(/[\\/]+$/, '');
  return base + sep + rel.split('/').join(sep);
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

export function formatDate(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Texto honesto sobre o conteúdo de uma pasta: só o que o servidor contou. */
export function countLabel(count: number | null | undefined): string {
  if (count == null) return 'quantidade não contada';
  if (count === 0) return 'vazia';
  return count === 1 ? '1 item' : `${count.toLocaleString('pt-BR')} itens`;
}

export type FileKind = 'folder' | 'image' | 'code' | 'text' | 'markdown' | 'data' | 'archive' | 'media' | 'binary' | 'symlink';
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.html', '.htm', '.py', '.sh', '.ps1', '.cmd', '.bat', '.sql', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.php', '.rb', '.vue', '.svelte']);
const DATA_EXT = new Set(['.json', '.yml', '.yaml', '.toml', '.xml', '.csv', '.env', '.ini', '.lock']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz']);
const MEDIA_EXT = new Set(['.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.m4a', '.flac']);
const TEXT_EXT = new Set(['.txt', '.log', '.gitignore', '.editorconfig', '.npmrc', '.license']);
export function fileKind(entry: Pick<FsEntry, 'name' | 'type'>): FileKind {
  if (entry.type === 'dir') return 'folder';
  if (entry.type === 'symlink') return 'symlink';
  const ext = extname(entry.name).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (CODE_EXT.has(ext)) return 'code';
  if (DATA_EXT.has(ext)) return 'data';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (MEDIA_EXT.has(ext)) return 'media';
  if (TEXT_EXT.has(ext) || !ext) return 'text';
  return 'binary';
}

export type KeyAction =
  | 'up' | 'down' | 'home' | 'end' | 'open' | 'parent' | 'rename' | 'trash' | 'new-file' | 'new-folder'
  | 'copy' | 'cut' | 'paste' | 'select-all' | 'escape' | 'menu' | 'refresh' | 'search' | 'save' | null;

export interface KeyLike { key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }

/** Mapeamento de teclado da lista (Alt+N = novo arquivo para não conflitar com Ctrl+N do navegador). */
export function keyAction(e: KeyLike): KeyAction {
  const ctrl = Boolean(e.ctrlKey || e.metaKey);
  const k = e.key;
  if (ctrl && !e.altKey) {
    const lower = k.toLowerCase();
    if (lower === 'c') return 'copy';
    if (lower === 'x') return 'cut';
    if (lower === 'v') return 'paste';
    if (lower === 'a') return 'select-all';
    if (lower === 's') return 'save';
    if (lower === 'f') return 'search';
    return null;
  }
  if (e.altKey && !ctrl) {
    const lower = k.toLowerCase();
    if (lower === 'n') return e.shiftKey ? 'new-folder' : 'new-file';
    return null;
  }
  switch (k) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'Home': return 'home';
    case 'End': return 'end';
    case 'Enter': return 'open';
    case 'Backspace': return 'parent';
    case 'F2': return 'rename';
    case 'Delete': return 'trash';
    case 'F5': return 'refresh';
    case 'Escape': return 'escape';
    case 'ContextMenu': return 'menu';
    case 'F10': return e.shiftKey ? 'menu' : null;
    default: return null;
  }
}

/** Mensagem em português para um código de erro do servidor (a mensagem do servidor tem prioridade quando existe). */
export function errorText(err: unknown): string {
  const e = err as { message?: string; code?: string };
  if (e?.message) return e.message;
  switch (e?.code) {
    case 'not_found': return 'o item já foi removido';
    case 'exists': return 'o destino já existe';
    case 'access_denied': return 'acesso negado';
    case 'busy': return 'o arquivo está em uso por outro programa';
    case 'in_use': return 'há execuções da HQ usando este caminho';
    case 'protected': return 'caminho protegido da HQ';
    case 'conflict': return 'o arquivo mudou no disco desde a leitura';
    default: return 'falha desconhecida';
  }
}

/** Decide se uma mudança no disco (fs.changed) afeta a pasta aberta: [] = tudo; senão a pasta-mãe de cada caminho. */
export function affectsDir(paths: string[], dir: string): boolean {
  if (paths.length === 0) return true;
  return paths.some(p => { const n = p.replace(/\\/g, '/').replace(/\/+$/, ''); return dirname(n) === dir || n === dir || isWithin(n, dir); });
}
