// API do explorador sobre o cliente WebSocket: um método por mensagem do contrato (packages/protocol/src/fs.ts).
import type {
  Folder, FsBatchResult, FsClientMessage, FsConflictPolicy, FsEntry, FsInUse, FsListResult, FsOpError, FsReadResult, FsRoot, FsWriteResult, TrashItem,
} from '@milweb-hq/protocol';

type ReqMessage = Extract<FsClientMessage, { reqId: string }>;
type WithoutReqId<M> = M extends { reqId: string } ? Omit<M, 'reqId'> : never;
type FsReqInput = WithoutReqId<ReqMessage>;
type FsFireInput = Exclude<FsClientMessage, { reqId: string }>;

/** Subconjunto do HqClient (web/src/state/client.ts) que a API usa; o playground passa um mock em memória. */
export interface FsClientLike {
  request<T>(msg: FsReqInput): Promise<T>;
  send(msg: FsFireInput): void;
}

export interface FsApi {
  roots(): Promise<FsRoot[]>;
  list(rootId: string, path: string): Promise<FsListResult>;
  stat(rootId: string, path: string): Promise<FsEntry>;
  read(rootId: string, path: string, maxBytes?: number): Promise<FsReadResult>;
  write(rootId: string, path: string, content: string, expectedMtime?: number | null): Promise<FsWriteResult>;
  create(rootId: string, path: string, kind: 'file' | 'dir'): Promise<FsEntry>;
  rename(rootId: string, path: string, newName: string): Promise<FsEntry>;
  move(rootId: string, paths: string[], targetRootId: string, targetDir: string, onConflict?: FsConflictPolicy, force?: boolean): Promise<FsBatchResult>;
  copy(rootId: string, paths: string[], targetRootId: string, targetDir: string, onConflict?: FsConflictPolicy): Promise<FsBatchResult>;
  trash(rootId: string, paths: string[], force?: boolean): Promise<{ items: TrashItem[]; errors: FsOpError[] }>;
  inUse(rootId: string, paths: string[]): Promise<FsInUse[]>;
  search(rootId: string, query: string, limit?: number): Promise<FsEntry[]>;
  /** Sem resposta: assina/cancela avisos fs.changed da raiz. */
  watch(rootId: string, subscribe: boolean): void;
  trashList(): Promise<TrashItem[]>;
  trashRestore(id: string, onConflict?: FsConflictPolicy): Promise<{ restoredTo: string }>;
  trashDelete(id: string): Promise<true>;
  trashEmpty(): Promise<true>;
  folderAdd(path: string, name?: string): Promise<Folder>;
  /** Sem resposta: só tira do cadastro, nunca mexe no disco. */
  folderRemove(id: string): void;
}

export function createFsApi(client: FsClientLike): FsApi {
  const req = <T>(msg: FsReqInput) => client.request<T>(msg);
  return {
    roots: () => req<FsRoot[]>({ type: 'fs.roots' }),
    list: (rootId, path) => req<FsListResult>({ type: 'fs.list', rootId, path }),
    stat: (rootId, path) => req<FsEntry>({ type: 'fs.stat', rootId, path }),
    read: (rootId, path, maxBytes) => req<FsReadResult>({ type: 'fs.read', rootId, path, maxBytes }),
    write: (rootId, path, content, expectedMtime) => req<FsWriteResult>({ type: 'fs.write', rootId, path, content, expectedMtime }),
    create: (rootId, path, kind) => req<FsEntry>({ type: 'fs.create', rootId, path, kind }),
    rename: (rootId, path, newName) => req<FsEntry>({ type: 'fs.rename', rootId, path, newName }),
    move: (rootId, paths, targetRootId, targetDir, onConflict, force) => req<FsBatchResult>({ type: 'fs.move', rootId, paths, targetRootId, targetDir, onConflict, force }),
    copy: (rootId, paths, targetRootId, targetDir, onConflict) => req<FsBatchResult>({ type: 'fs.copy', rootId, paths, targetRootId, targetDir, onConflict }),
    trash: (rootId, paths, force) => req<{ items: TrashItem[]; errors: FsOpError[] }>({ type: 'fs.trash', rootId, paths, force }),
    inUse: (rootId, paths) => req<FsInUse[]>({ type: 'fs.inUse', rootId, paths }),
    search: (rootId, query, limit) => req<FsEntry[]>({ type: 'fs.search', rootId, query, limit }),
    watch: (rootId, subscribe) => { try { client.send({ type: 'fs.watch', rootId, subscribe }); } catch { /* sem conexão: o App reassina ao reconectar */ } },
    trashList: () => req<TrashItem[]>({ type: 'trash.list' }),
    trashRestore: (id, onConflict) => req<{ restoredTo: string }>({ type: 'trash.restore', id, onConflict }),
    trashDelete: id => req<true>({ type: 'trash.delete', id }),
    trashEmpty: () => req<true>({ type: 'trash.empty' }),
    folderAdd: (path, name) => req<Folder>({ type: 'folder.add', path, name }),
    folderRemove: id => client.send({ type: 'folder.remove', id }),
  };
}
