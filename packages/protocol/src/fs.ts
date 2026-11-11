// Contrato do explorador de arquivos, das pastas extras e da lixeira da MilWeb HQ.
// Tudo é executado pelo serviço local, no disco real, só dentro das raízes autorizadas (pastas de projeto e pastas
// que o Chefe adicionou). Caminhos de entrada e saída são RELATIVOS à raiz, com separador '/', nunca absolutos.
// Uma ação só é dada como concluída na interface depois da resposta (reply) do servidor.

export interface FsRoot {
  /** 'project:<projectId>' ou 'folder:<folderId>'. */
  id: string;
  kind: 'project' | 'folder';
  name: string;
  /** Caminho absoluto real (só para exibir e para "abrir no Explorer"). */
  path: string;
  projectId?: string;
  folderId?: string;
}

export type FsEntryType = 'file' | 'dir' | 'symlink' | 'other';

export interface FsEntry {
  name: string;
  /** Relativo à raiz ('' = a própria raiz), separador '/'. */
  path: string;
  type: FsEntryType;
  size?: number;
  mtime?: number;
  /** Diretório: quantidade de filhos quando contar for barato; null = não contado (a interface não inventa total). */
  childCount?: number | null;
}

export interface FsListResult { root: FsRoot; path: string; entries: FsEntry[]; truncated: boolean }

export interface FsReadResult {
  path: string;
  size: number;
  mtime: number;
  mediaType: string;
  /** 'utf8' = texto; 'base64' = imagem/binário pequeno para preview; 'none' = grande ou binário sem preview. */
  encoding: 'utf8' | 'base64' | 'none';
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface FsWriteResult { path: string; size: number; mtime: number }

/** O que fazer quando o destino já existe. */
export type FsConflictPolicy = 'fail' | 'rename' | 'overwrite';

/** Códigos de erro reais, mapeados dos erros do sistema de arquivos (nunca "sucesso fingido"). */
export type FsErrorCode =
  | 'not_found'      // ENOENT: o item já não existe
  | 'exists'         // EEXIST / destino existente
  | 'access_denied'  // EACCES / EPERM
  | 'busy'           // EBUSY: arquivo em uso por outro programa
  | 'in_use'         // pasta usada por uma execução ativa da HQ (ver FsInUse)
  | 'outside_root'   // caminho fora da raiz autorizada
  | 'protected'      // diretórios da própria HQ (dados, banco, lixeira, instalação)
  | 'symlink'        // link simbólico/junction: não é seguido
  | 'not_empty'
  | 'conflict'       // gravação: o arquivo mudou no disco desde a leitura (expectedMtime)
  | 'too_large'
  | 'invalid_name'
  | 'io';

export interface FsOpError { path: string; code: FsErrorCode; message: string }

export interface FsBatchResult { done: { from: string; to: string }[]; errors: FsOpError[] }

/** Execuções que dependem de um caminho: sessões cujo projeto está dentro dele, com processo vivo ou tarefa em andamento. */
export interface FsInUse {
  path: string;
  sessions: { sessionId: string; employeeId: string | null; employeeName: string; projectName: string; taskStatus: string | null; processAlive: boolean }[];
}

export interface TrashItem {
  id: string;
  name: string;
  /** Caminho absoluto original. */
  originPath: string;
  /** Raiz de onde saiu (pode não existir mais). */
  rootId: string | null;
  kind: 'file' | 'dir';
  /** Bytes (arquivo) ou soma (pasta) quando contado; null = não contado. */
  size: number | null;
  /** Itens dentro da pasta quando contado; null = não contado. */
  count: number | null;
  deletedAt: number;
}

/** Pasta local adicionada à HQ além das pastas de projeto (só cadastro; nada é copiado). */
export interface Folder { id: string; name: string; path: string; addedAt: number }

// ---------------- Mensagens cliente → servidor (todas respondidas com reply) ----------------
// Respostas: fs.roots → FsRoot[] · fs.list → FsListResult · fs.stat → FsEntry · fs.read → FsReadResult ·
// fs.write → FsWriteResult (erro 'conflict' se expectedMtime não bater) · fs.create → FsEntry · fs.rename → FsEntry ·
// fs.move / fs.copy → FsBatchResult · fs.trash → { items: TrashItem[]; errors: FsOpError[] } · fs.inUse → FsInUse[] ·
// fs.search → FsEntry[] · trash.list → TrashItem[] · trash.restore → { restoredTo: string } · trash.delete / trash.empty → true ·
// folder.add → Folder. Erro estruturado: reply { ok:false, error, code: FsErrorCode, data? } (data = FsInUse[] em 'in_use').
export type FsClientMessage =
  | { type: 'fs.roots'; reqId: string }
  | { type: 'fs.list'; reqId: string; rootId: string; path: string }
  | { type: 'fs.stat'; reqId: string; rootId: string; path: string }
  | { type: 'fs.read'; reqId: string; rootId: string; path: string; maxBytes?: number }
  | { type: 'fs.write'; reqId: string; rootId: string; path: string; content: string; expectedMtime?: number | null }
  | { type: 'fs.create'; reqId: string; rootId: string; path: string; kind: 'file' | 'dir' }
  | { type: 'fs.rename'; reqId: string; rootId: string; path: string; newName: string }
  | { type: 'fs.move'; reqId: string; rootId: string; paths: string[]; targetRootId: string; targetDir: string; onConflict?: FsConflictPolicy; force?: boolean }
  | { type: 'fs.copy'; reqId: string; rootId: string; paths: string[]; targetRootId: string; targetDir: string; onConflict?: FsConflictPolicy }
  /** Envia para a lixeira da HQ (sai do lugar original no disco). Sem `force`, falha com 'in_use' se houver execução dependente. */
  | { type: 'fs.trash'; reqId: string; rootId: string; paths: string[]; force?: boolean }
  | { type: 'fs.inUse'; reqId: string; rootId: string; paths: string[] }
  | { type: 'fs.search'; reqId: string; rootId: string; query: string; limit?: number }
  /** Assina/cancela avisos fs.changed da raiz (o servidor observa o disco). */
  | { type: 'fs.watch'; rootId: string; subscribe: boolean }
  | { type: 'trash.list'; reqId: string }
  | { type: 'trash.restore'; reqId: string; id: string; onConflict?: FsConflictPolicy }
  /** Exclusão definitiva: só de itens que já estão na lixeira, com confirmação na interface. */
  | { type: 'trash.delete'; reqId: string; id: string }
  | { type: 'trash.empty'; reqId: string }
  | { type: 'folder.add'; reqId: string; path: string; name?: string }
  /** Só tira do cadastro da HQ; nunca mexe no disco. */
  | { type: 'folder.remove'; id: string };

// ---------------- Mensagens servidor → cliente ----------------
export type FsServerMessage =
  /** Algo mudou no disco dentro da raiz (Claude Code, outro programa ou a própria HQ). Caminhos relativos; [] = recarregar tudo. */
  | { kind: 'fs.changed'; rootId: string; paths: string[] }
  | { kind: 'trash.changed' };
