// Registro de exclusões e restaurações (Marco 0). Grava no banco (audit_log, consultável na tela "Dados") e no log do serviço.
// Motivo: em 31/10 uma reunião sumiu e não havia nenhum rastro de quem ou o que a removeu.
import type { AuditEntry } from '@milweb-hq/protocol';
import type { Store } from './store.js';
import { log } from './log.js';

export function recordAudit(store: Store, e: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
  const entry = store.addAudit(e);
  log.info(`registro: ${entry.action} · ${entry.entity}${entry.title ? ` "${entry.title}"` : ''}${entry.entityId ? ` (${entry.entityId.slice(0, 8)})` : ''} · origem: ${entry.origin}${entry.detail ? ` · ${entry.detail}` : ''}`);
  return entry;
}
