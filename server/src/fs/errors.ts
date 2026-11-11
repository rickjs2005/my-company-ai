// Erros estruturados do explorador de arquivos. Cada erro real do sistema vira um FsErrorCode do contrato,
// com mensagem em português; o ws.ts devolve `code` e `data` ao cliente no reply.
import type { FsErrorCode, FsOpError } from '@milweb-hq/protocol';

export class FsError extends Error {
  constructor(readonly code: FsErrorCode, message: string, readonly path = '', readonly data?: unknown) {
    super(message);
    this.name = 'FsError';
  }
  toOpError(): FsOpError { return { path: this.path, code: this.code, message: this.message }; }
}

export function isFsError(err: unknown): err is FsError { return err instanceof FsError; }

const MESSAGES: Record<string, (p: string) => string> = {
  ENOENT: p => `o item não existe mais: ${p || '(raiz)'}`,
  EEXIST: p => `já existe um item com esse nome: ${p}`,
  EACCES: p => `acesso negado pelo sistema: ${p}`,
  EPERM: p => `operação não permitida pelo sistema (permissão ou arquivo somente leitura): ${p}`,
  EBUSY: p => `o item está em uso por outro programa: ${p}`,
  ENOTEMPTY: p => `a pasta não está vazia: ${p}`,
  ENOTDIR: p => `parte do caminho não é uma pasta: ${p}`,
  EISDIR: p => `é uma pasta, não um arquivo: ${p}`,
  EXDEV: p => `o destino está em outra unidade: ${p}`,
  ENAMETOOLONG: p => `o caminho é longo demais para o Windows: ${p}`,
  ENOSPC: () => 'sem espaço em disco',
};

const CODE_MAP: Partial<Record<string, FsErrorCode>> = {
  ENOENT: 'not_found', EEXIST: 'exists', EACCES: 'access_denied', EPERM: 'access_denied', EBUSY: 'busy',
  ENOTEMPTY: 'not_empty', ENAMETOOLONG: 'invalid_name',
};

/** Converte qualquer erro (Node ou já FsError) num FsError com caminho relativo e mensagem em português. */
export function toFsError(err: unknown, relPath: string): FsError {
  if (isFsError(err)) return err.path ? err : new FsError(err.code, err.message, relPath, err.data);
  const e = err as NodeJS.ErrnoException;
  const sys = typeof e?.code === 'string' ? e.code : '';
  const code = CODE_MAP[sys] ?? 'io';
  const text = MESSAGES[sys]?.(relPath) ?? `falha de disco${sys ? ` (${sys})` : ''}: ${e?.message ?? String(err)}`;
  return new FsError(code, text, relPath);
}
