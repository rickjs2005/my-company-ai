// Raízes autorizadas e resolução segura de caminhos relativos.
// Regras: caminho relativo com '/', sem absoluto, sem '..', nomes válidos no Windows; contenção checada com
// path.relative (case-insensitive no Windows), lstat em cada segmento (link simbólico/junction nunca é seguido),
// raiz cujo realpath mude é recusada; pastas da própria HQ (dados e instalação) são protegidas.
import fs from 'node:fs';
import path from 'node:path';
import type { FsRoot } from '@milweb-hq/protocol';
import type { Store } from '../store.js';
import type { Config } from '../config.js';
import { FsError } from './errors.js';

export interface RootInfo { root: FsRoot; abs: string }

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Valida um único nome de arquivo/pasta (sem separadores). Lança 'invalid_name'. */
export function validateName(name: string): string {
  if (!name || name === '.' || name === '..') throw new FsError('invalid_name', `nome inválido: "${name}"`);
  if (INVALID_CHARS.test(name)) throw new FsError('invalid_name', `o nome "${name}" tem caracteres que o Windows não aceita (< > : " / \\ | ? *)`);
  if (RESERVED.test(name)) throw new FsError('invalid_name', `"${name}" é um nome reservado do Windows`);
  if (/[ .]$/.test(name)) throw new FsError('invalid_name', `o nome "${name}" não pode terminar com espaço ou ponto`);
  if (name.length > 255) throw new FsError('invalid_name', 'nome longo demais (máximo 255 caracteres)');
  return name;
}

/** Normaliza um caminho relativo ('' = raiz) e devolve os segmentos validados. Lança 'outside_root' / 'invalid_name'. */
export function splitRelative(rel: string): string[] {
  if (typeof rel !== 'string') throw new FsError('invalid_name', 'caminho inválido');
  const norm = rel.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(norm) || norm.startsWith('/') || path.isAbsolute(norm)) throw new FsError('outside_root', `caminho absoluto não é aceito: ${rel}`, rel);
  const trimmed = norm.replace(/\/+$/, '');
  if (trimmed === '') return [];
  const segs = trimmed.split('/');
  for (const s of segs) {
    if (s === '..') throw new FsError('outside_root', `caminho fora da raiz: ${rel}`, rel);
    if (s === '' || s === '.') throw new FsError('invalid_name', `caminho com segmento vazio: ${rel}`, rel);
    try { validateName(s); } catch (e) { throw new FsError((e as FsError).code, (e as FsError).message, rel); }
  }
  return segs;
}

export function joinRel(...parts: string[]): string { return parts.filter(Boolean).join('/'); }
export function relDirname(rel: string): string { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); }
export function relBasename(rel: string): string { const i = rel.lastIndexOf('/'); return i < 0 ? rel : rel.slice(i + 1); }

/** true quando `child` é igual a `parent` ou está dentro dele (comparação do SO; no Windows ignora caixa). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export class Roots {
  constructor(private store: Store, private config: Config) {}

  list(): FsRoot[] {
    const projects = this.store.listProjects().map<FsRoot>(p => ({ id: `project:${p.id}`, kind: 'project', name: p.name, path: p.path, projectId: p.id }));
    const folders = this.store.listFolders().map<FsRoot>(f => ({ id: `folder:${f.id}`, kind: 'folder', name: f.name, path: f.path, folderId: f.id }));
    return [...projects, ...folders];
  }

  /** Raiz pelo id ('project:<id>' | 'folder:<id>'). Lança 'not_found' se não estiver cadastrada ou 'outside_root' se o realpath mudou. */
  get(rootId: string): RootInfo {
    const root = this.find(rootId);
    if (!root) throw new FsError('not_found', `raiz não cadastrada: ${rootId}`);
    const abs = path.resolve(root.path);
    let real: string;
    try { real = fs.realpathSync.native(abs); } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') throw new FsError('not_found', `a pasta da raiz "${root.name}" não existe mais: ${abs}`);
      throw new FsError('io', `não foi possível abrir a raiz "${root.name}": ${e.message}`);
    }
    if (!samePath(real, abs)) throw new FsError('outside_root', `a raiz "${root.name}" aponta para outro lugar (link ou junction): ${abs} → ${real}`);
    return { root, abs };
  }

  find(rootId: string): FsRoot | null {
    const m = /^(project|folder):(.+)$/.exec(rootId);
    if (!m) return null;
    if (m[1] === 'project') { const p = this.store.getProject(m[2]); return p ? { id: rootId, kind: 'project', name: p.name, path: p.path, projectId: p.id } : null; }
    const f = this.store.getFolder(m[2]); return f ? { id: rootId, kind: 'folder', name: f.name, path: f.path, folderId: f.id } : null;
  }

  protectedDirs(): string[] { return [path.resolve(this.config.dataDir), path.resolve(this.config.installDir)]; }

  /** Está dentro (ou é) a pasta de dados ou a de instalação da HQ (usado para não cadastrar essas pastas como "pasta extra"). */
  isInsideHq(abs: string): boolean { return this.protectedDirs().some(p => isInside(p, abs)); }

  /**
   * 'read': protegido só dentro da pasta de DADOS (token, banco, lixeira). A pasta de instalação pode ser lida: ela costuma ser
   *         também um projeto cadastrado (o próprio milweb-hq) e o explorador precisa mostrá-la.
   * 'write': dentro de qualquer pasta da HQ (instalação incluída: o serviço roda dali) e também quando o caminho CONTÉM uma
   *          pasta da HQ (apagar/mover um ancestral levaria os dados junto).
   */
  isProtected(abs: string, level: 'read' | 'write'): boolean {
    const [data, install] = this.protectedDirs();
    if (isInside(data, abs)) return true;
    if (level === 'read') return false;
    return isInside(install, abs) || isInside(abs, data) || isInside(abs, install);
  }

  assertNotProtected(abs: string, rel: string, level: 'read' | 'write'): void {
    if (!this.isProtected(abs, level)) return;
    const [data] = this.protectedDirs();
    const msg = isInside(data, abs)
      ? `caminho protegido (dados da MilWeb HQ): ${rel || '(raiz)'}`
      : `a pasta da MilWeb HQ é só leitura no explorador (o serviço roda dali); altere esses arquivos pelo editor ou por um funcionário: ${rel || '(raiz)'}`;
    throw new FsError('protected', msg, rel);
  }

  /**
   * Resolve `rel` dentro da raiz com todas as checagens. Devolve o caminho absoluto, os segmentos e o lstat do item
   * (null quando `allowMissing` e o último segmento não existe). Um link/junction em qualquer segmento lança 'symlink'.
   */
  resolve(info: RootInfo, rel: string, opts: { allowMissing?: boolean; level?: 'read' | 'write' } = {}): { abs: string; rel: string; stat: fs.Stats | null } {
    const segs = splitRelative(rel);
    const normRel = segs.join('/');
    const abs = path.resolve(info.abs, ...segs);
    if (!isInside(info.abs, abs)) throw new FsError('outside_root', `caminho fora da raiz: ${rel}`, normRel);
    this.assertNotProtected(abs, normRel, opts.level ?? 'read');
    let cur = info.abs;
    let stat: fs.Stats | null = null;
    for (let i = 0; i < segs.length; i++) {
      cur = path.join(cur, segs[i]);
      try { stat = fs.lstatSync(cur); } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT' && i === segs.length - 1 && opts.allowMissing) return { abs, rel: normRel, stat: null };
        if (e.code === 'ENOENT') throw new FsError('not_found', `o item não existe mais: ${normRel}`, normRel);
        throw new FsError(e.code === 'EACCES' || e.code === 'EPERM' ? 'access_denied' : 'io', `não foi possível acessar ${normRel}: ${e.message}`, normRel);
      }
      if (stat.isSymbolicLink()) throw new FsError('symlink', `"${segs.slice(0, i + 1).join('/')}" é um link simbólico ou junction; a HQ não segue links`, normRel);
      if (i < segs.length - 1 && !stat.isDirectory()) throw new FsError('not_found', `parte do caminho não é uma pasta: ${normRel}`, normRel);
    }
    if (segs.length === 0) { try { stat = fs.lstatSync(info.abs); } catch { stat = null; } }
    return { abs, rel: normRel, stat };
  }
}
