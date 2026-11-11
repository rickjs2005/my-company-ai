// Lixeira da HQ: itens apagados pela interface saem do lugar original para config.trashDir/<id>/<nome> e ficam
// registrados em trash_items (banco). Sobrevive a reinícios; nunca sobrescreve em silêncio ao restaurar.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FsConflictPolicy, FsInUse, FsOpError, TrashItem } from '@milweb-hq/protocol';
import type { Store } from '../store.js';
import { FsError, toFsError } from './errors.js';
import { countTree, moveItem, uniqueName, type FsOps } from './ops.js';
import type { RootInfo, Roots } from './paths.js';

/** Acima disto, tamanho e quantidade ficam null (não contados), para não travar com pastas enormes. */
export const TRASH_COUNT_LIMIT = 5000;

type Row = Record<string, unknown>;

function rowToItem(r: Row): TrashItem {
  return {
    id: String(r.id), name: String(r.name), originPath: String(r.origin_path), rootId: (r.root_id as string | null) ?? null,
    kind: r.kind === 'dir' ? 'dir' : 'file', size: r.size == null ? null : Number(r.size), count: r.count == null ? null : Number(r.count), deletedAt: Number(r.deleted_at),
  };
}

export interface TrashDeps {
  store: Store;
  roots: Roots;
  ops: FsOps;
  trashDir: string;
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

export class Trash {
  constructor(private deps: TrashDeps) {}

  private get db() { return this.deps.store.db; }

  list(): TrashItem[] {
    return (this.db.prepare('SELECT * FROM trash_items ORDER BY deleted_at DESC').all() as Row[]).map(rowToItem);
  }

  private row(id: string): Row | null { return (this.db.prepare('SELECT * FROM trash_items WHERE id = ?').get(id) as Row | undefined) ?? null; }

  /** Ao iniciar: itens cujo conteúdo sumiu da pasta da lixeira são removidos do registro, com aviso no log. */
  sweep(): void {
    for (const r of this.db.prepare('SELECT id, name, stored_path FROM trash_items').all() as Row[]) {
      if (!fs.existsSync(String(r.stored_path))) {
        this.deps.log.warn(`lixeira: o conteúdo de "${r.name}" (${r.id}) sumiu de ${r.stored_path}; registro removido`);
        this.db.prepare('DELETE FROM trash_items WHERE id = ?').run(String(r.id));
      }
    }
    try {
      const known = new Set((this.db.prepare('SELECT id FROM trash_items').all() as Row[]).map(r => String(r.id)));
      for (const d of fs.readdirSync(this.deps.trashDir)) if (!known.has(d)) this.deps.log.warn(`lixeira: pasta sem registro em ${path.join(this.deps.trashDir, d)} (não foi tocada)`);
    } catch { /* lixeira ainda não existe */ }
  }

  /**
   * Envia caminhos de uma raiz para a lixeira. Sem `force`, falha com 'in_use' (data = FsInUse[]) se alguma execução
   * depender deles; a raiz inteira ('') também exige force. Consistência: se o rename falhar, nada é registrado;
   * se o registro falhar, o rename é desfeito.
   */
  trash(info: RootInfo, rels: string[], force = false): { items: TrashItem[]; errors: FsOpError[] } {
    const wantsRoot = rels.some(r => r.replace(/\\/g, '/').replace(/\/+$/, '') === '');
    if (!force) {
      const inUse: FsInUse[] = this.deps.ops.inUse(info, rels);
      if (inUse.length) throw new FsError('in_use', `há execuções da HQ usando ${inUse.length === 1 ? 'este caminho' : 'estes caminhos'}`, inUse[0].path, inUse);
      if (wantsRoot) throw new FsError('in_use', `enviar a raiz inteira "${info.root.name}" para a lixeira exige confirmação explícita`, '', [] as FsInUse[]);
    }
    fs.mkdirSync(this.deps.trashDir, { recursive: true });
    const items: TrashItem[] = []; const errors: FsOpError[] = [];
    for (const rel of rels) {
      try { items.push(this.trashOne(info, rel)); } catch (err) { errors.push(toFsError(err, rel).toOpError()); }
    }
    return { items, errors };
  }

  private trashOne(info: RootInfo, rel: string): TrashItem {
    const r = this.deps.roots.resolve(info, rel, { level: 'write' });
    if (!r.stat) throw new FsError('not_found', `o item não existe mais: ${r.rel}`, r.rel);
    const name = r.rel ? path.basename(r.abs) : path.basename(r.abs) || info.root.name;
    const kind: TrashItem['kind'] = r.stat.isDirectory() ? 'dir' : 'file';
    const counted = kind === 'dir' ? countTree(r.abs, TRASH_COUNT_LIMIT) : { count: 1, size: r.stat.size };
    const id = randomUUID();
    const storedDir = path.join(this.deps.trashDir, id);
    const stored = path.join(storedDir, name);
    try { fs.mkdirSync(storedDir); } catch (err) { throw toFsError(err, r.rel); }
    try { moveItem(r.abs, stored); } catch (err) {
      try { fs.rmSync(storedDir, { recursive: true, force: true }); } catch { /* ignorar */ }
      throw toFsError(err, r.rel);
    }
    const deletedAt = Date.now();
    try {
      this.db.prepare('INSERT INTO trash_items(id, name, origin_path, root_id, kind, size, count, stored_path, deleted_at, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, name, r.abs, info.root.id, kind, counted ? counted.size : null, counted && kind === 'dir' ? counted.count : null, stored, deletedAt, JSON.stringify({ relPath: r.rel, rootName: info.root.name }));
    } catch (err) {
      // Registro falhou: desfaz o movimento para o item não sumir sem rastro.
      try { moveItem(stored, r.abs); fs.rmSync(storedDir, { recursive: true, force: true }); } catch (undoErr) { this.deps.log.error(`lixeira: falha ao registrar e ao desfazer ${r.abs}: ${(undoErr as Error).message}`); }
      throw new FsError('io', `não foi possível registrar o item na lixeira: ${(err as Error).message}`, r.rel);
    }
    return { id, name, originPath: r.abs, rootId: info.root.id, kind, size: counted ? counted.size : null, count: counted && kind === 'dir' ? counted.count : null, deletedAt };
  }

  /** Restaura para o caminho original. Destino existente: 'fail' → 'exists'; 'rename' → "nome (restaurado)". Nunca sobrescreve. */
  restore(id: string, onConflict: FsConflictPolicy = 'fail'): { restoredTo: string } {
    const r = this.row(id);
    if (!r) throw new FsError('not_found', 'este item já não está na lixeira');
    const stored = String(r.stored_path);
    if (!fs.existsSync(stored)) {
      this.db.prepare('DELETE FROM trash_items WHERE id = ?').run(id);
      throw new FsError('not_found', `o conteúdo de "${r.name}" já não está na pasta da lixeira; registro removido`);
    }
    const origin = String(r.origin_path);
    const parent = path.dirname(origin);
    if (this.deps.roots.isProtected(origin, 'write')) throw new FsError('protected', `o destino original é uma pasta protegida da HQ: ${origin}`);
    let dest = origin;
    if (fs.existsSync(dest)) {
      if (onConflict === 'rename') dest = path.join(parent, uniqueName(parent, path.basename(origin), n => (n === 2 ? ' (restaurado)' : ` (restaurado ${n - 1})`)));
      else throw new FsError('exists', `já existe "${path.basename(origin)}" em ${parent}; restaure com outro nome`, origin);
    }
    try { fs.mkdirSync(parent, { recursive: true }); } catch (err) { throw toFsError(err, origin); }
    try { moveItem(stored, dest); } catch (err) { throw toFsError(err, origin); }
    this.db.prepare('DELETE FROM trash_items WHERE id = ?').run(id);
    try { fs.rmSync(path.dirname(stored), { recursive: true, force: true }); } catch { /* pasta do id pode ficar vazia */ }
    return { restoredTo: dest };
  }

  /** Exclusão definitiva de um item que já está na lixeira. */
  delete(id: string): true {
    const r = this.row(id);
    if (!r) throw new FsError('not_found', 'este item já não está na lixeira');
    const stored = String(r.stored_path);
    const storedDir = path.dirname(stored);
    if (!this.insideTrash(stored)) throw new FsError('protected', `registro inconsistente: ${stored} não está na pasta da lixeira`);
    try { fs.rmSync(stored, { recursive: true, force: true }); fs.rmSync(storedDir, { recursive: true, force: true }); } catch (err) { throw toFsError(err, String(r.name)); }
    this.db.prepare('DELETE FROM trash_items WHERE id = ?').run(id);
    return true;
  }

  empty(): true {
    const failures: string[] = [];
    for (const it of this.list()) {
      try { this.delete(it.id); } catch (err) { failures.push(`${it.name}: ${(err as Error).message}`); }
    }
    if (failures.length) throw new FsError('io', `${failures.length} ${failures.length === 1 ? 'item não pôde' : 'itens não puderam'} ser excluído(s): ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '…' : ''}`);
    return true;
  }

  private insideTrash(p: string): boolean {
    const rel = path.relative(path.resolve(this.deps.trashDir), path.resolve(p));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }
}
