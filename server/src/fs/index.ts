// Serviço do explorador de arquivos, pastas extras e lixeira. O ws.ts chama `handle` para toda mensagem cujo type
// comece com 'fs.', 'trash.' ou 'folder.'; o valor devolvido é o `data` do reply (undefined para mensagens sem reqId).
// Erros lançados são FsError (com .code e .data) ou Error comum; o ws.ts os transforma em reply { ok:false, error, code, data }.
import fs from 'node:fs';
import path from 'node:path';
import type { Folder, FsClientMessage, ServerMessage, Session } from '@milweb-hq/protocol';
import type { Store } from '../store.js';
import type { Config } from '../config.js';
import { FsError } from './errors.js';
import { Roots, isInside } from './paths.js';
import { FsOps } from './ops.js';
import { Trash } from './trash.js';
import { Watcher } from './watch.js';
import { recordAudit } from '../audit.js';

export { FsError, isFsError, toFsError } from './errors.js';
export { Roots, splitRelative, validateName, isInside } from './paths.js';
export { FsOps, compareEntries, mediaTypeFor, uniqueName, countTree } from './ops.js';
export { Trash, TRASH_COUNT_LIMIT } from './trash.js';
export { Watcher, WATCH_DEBOUNCE_MS } from './watch.js';

export interface FsServiceDeps {
  store: Store;
  config: Config;
  manager: { listSessions(): Session[] };
  broadcast(m: ServerMessage): void;
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

export interface FsService {
  /** Executa uma mensagem e devolve o dado do reply (undefined para mensagens sem reqId: fs.watch, folder.remove). */
  handle(msg: FsClientMessage, client: object): Promise<unknown>;
  /** Chamar no 'close' de cada WebSocket: cancela as assinaturas de observação desse cliente. */
  onClientClose(client: object): void;
  /** Desliga os observadores do disco (encerramento do serviço). */
  close(): void;
  /** Acesso direto (testes e diagnóstico). */
  readonly roots: Roots;
  readonly ops: FsOps;
  readonly trash: Trash;
  readonly watcher: Watcher;
}

export function createFsService(deps: FsServiceDeps): FsService {
  const roots = new Roots(deps.store, deps.config);
  const ops = new FsOps({ roots, store: deps.store, manager: deps.manager });
  const trash = new Trash({ store: deps.store, roots, ops, trashDir: deps.config.trashDir, log: deps.log });
  const watcher = new Watcher({
    rootPath: id => { try { return roots.get(id).abs; } catch { return null; } },
    broadcast: m => deps.broadcast(m),
    log: deps.log,
  });
  try { trash.sweep(); } catch (err) { deps.log.warn(`lixeira: varredura inicial falhou: ${(err as Error).message}`); }

  const trashChanged = () => deps.broadcast({ kind: 'trash.changed' });

  function addFolder(rawPath: string, name?: string): Folder {
    const p = path.resolve(String(rawPath ?? '').trim());
    if (!rawPath || !String(rawPath).trim()) throw new FsError('invalid_name', 'informe o caminho da pasta');
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') throw new FsError('not_found', `a pasta não existe: ${p}`);
      throw new FsError('access_denied', `não foi possível abrir ${p}: ${e.message}`);
    }
    if (!st.isDirectory()) throw new FsError('invalid_name', `não é uma pasta: ${p}`);
    if (roots.isInsideHq(p)) throw new FsError('protected', `esta pasta pertence ao próprio My Company AI (dados ou instalação): ${p}`);
    for (const r of roots.list()) {
      const rp = path.resolve(r.path);
      if (isInside(rp, p) && isInside(p, rp)) throw new FsError('exists', `esta pasta já está cadastrada como "${r.name}"`);
      if (isInside(rp, p)) throw new FsError('exists', `esta pasta já está dentro de "${r.name}" (${r.path}); abra-a por lá`);
      if (isInside(p, rp)) deps.log.warn(`pasta extra ${p} contém a raiz já cadastrada "${r.name}" (${r.path})`);
    }
    const folder = deps.store.addFolder({ name: (name ?? '').trim() || path.basename(p) || p, path: p });
    deps.broadcast({ kind: 'entity', entity: 'folder', op: 'upsert', item: folder });
    return folder;
  }

  async function handle(msg: FsClientMessage, client: object): Promise<unknown> {
    switch (msg.type) {
      case 'fs.roots': return roots.list();
      case 'fs.list': return ops.list(roots.get(msg.rootId), msg.path ?? '');
      case 'fs.stat': return ops.stat(roots.get(msg.rootId), msg.path ?? '');
      case 'fs.read': return ops.read(roots.get(msg.rootId), msg.path, msg.maxBytes);
      case 'fs.write': return ops.write(roots.get(msg.rootId), msg.path, String(msg.content ?? ''), msg.expectedMtime);
      case 'fs.create': return ops.create(roots.get(msg.rootId), msg.path, msg.kind === 'dir' ? 'dir' : 'file');
      case 'fs.rename': return ops.rename(roots.get(msg.rootId), msg.path, String(msg.newName ?? '').trim());
      case 'fs.move': {
        const info = roots.get(msg.rootId);
        if (!msg.force) {
          const inUse = ops.inUse(info, msg.paths);
          if (inUse.length) throw new FsError('in_use', 'há execuções da HQ usando o que você quer mover', inUse[0].path, inUse);
        }
        return ops.transfer('move', info, msg.paths ?? [], roots.get(msg.targetRootId), msg.targetDir ?? '', msg.onConflict ?? 'fail');
      }
      case 'fs.copy': return ops.transfer('copy', roots.get(msg.rootId), msg.paths ?? [], roots.get(msg.targetRootId), msg.targetDir ?? '', msg.onConflict ?? 'fail');
      case 'fs.trash': {
        const r = trash.trash(roots.get(msg.rootId), msg.paths ?? [], Boolean(msg.force));
        if (r.items.length) trashChanged();
        for (const it of r.items) recordAudit(deps.store, { action: 'enviar para a lixeira', entity: it.kind === 'dir' ? 'pasta' : 'arquivo', entityId: it.id, title: it.name, origin: 'interface', detail: it.originPath });
        return r;
      }
      case 'fs.inUse': return ops.inUse(roots.get(msg.rootId), msg.paths ?? []);
      case 'fs.search': return ops.search(roots.get(msg.rootId), String(msg.query ?? ''), msg.limit);
      case 'fs.watch': {
        if (msg.subscribe) { roots.get(msg.rootId); watcher.subscribe(client, msg.rootId); }
        else watcher.unsubscribe(client, msg.rootId);
        return undefined;
      }
      case 'trash.list': return trash.list();
      case 'trash.restore': {
        const it = trash.list().find(x => x.id === msg.id);
        const r = trash.restore(msg.id, msg.onConflict ?? 'fail'); trashChanged();
        recordAudit(deps.store, { action: 'restaurar da lixeira', entity: it?.kind === 'dir' ? 'pasta' : 'arquivo', entityId: msg.id, title: it?.name ?? null, origin: 'interface', detail: it?.originPath ?? null });
        return r;
      }
      case 'trash.delete': {
        const it = trash.list().find(x => x.id === msg.id);
        trash.delete(msg.id); trashChanged();
        recordAudit(deps.store, { action: 'apagar de vez', entity: it?.kind === 'dir' ? 'pasta' : 'arquivo', entityId: msg.id, title: it?.name ?? null, origin: 'interface', detail: it?.originPath ?? null });
        return true;
      }
      case 'trash.empty': {
        const items = trash.list();
        try { return trash.empty(); } finally {
          trashChanged();
          recordAudit(deps.store, { action: 'esvaziar a lixeira', entity: 'arquivos', entityId: null, title: `${items.length} itens`, origin: 'interface', detail: items.slice(0, 20).map(i => i.originPath).join('; ') || null });
        }
      }
      case 'folder.add': return addFolder(msg.path, msg.name);
      case 'folder.remove': {
        const f = deps.store.getFolder(msg.id);
        if (!f) return undefined;
        deps.store.removeFolder(msg.id);
        watcher.closeRoot(`folder:${msg.id}`);
        recordAudit(deps.store, { action: 'remover da HQ', entity: 'pasta extra', entityId: msg.id, title: f.name, origin: 'interface', detail: `pasta mantida no disco: ${f.path}` });
        // O aviso 'entity folder delete' é emitido pelo ws.ts (que já faz isso); aqui só o cadastro e o observador.
        return undefined;
      }
      default: throw new FsError('io', `operação desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  return {
    handle, roots, ops, trash, watcher,
    onClientClose: client => watcher.onClientClose(client),
    close: () => watcher.close(),
  };
}
