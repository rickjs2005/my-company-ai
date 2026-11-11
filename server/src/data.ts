// Dados da HQ (Marco 0): identidade do banco em uso, backup diário automático (mantém os 7 mais recentes), backup na hora
// e o cartão "Dados" em Ajustes. Restaurar é feito com a HQ desligada pelo `server/restore.mjs` (confere o backup antes).
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DataInfo } from '@milweb-hq/protocol';
import { backupDb, SCHEMA_VERSION } from './db.js';
import type { Store } from './store.js';

export const AUTO_BACKUPS_KEPT = 7;
const DAY = 86_400_000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

export interface BackupFile { file: string; at: number; kind: 'auto' | 'manual' | 'migração' }

/** "hq-auto-2026-11-01T18-12-41-327Z.sqlite" → { kind 'auto', at } (data do nome; se não der, a do arquivo). */
export function parseBackupName(file: string, mtime = 0): BackupFile | null {
  const m = /^hq-(.+?)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite$/.exec(path.basename(file));
  if (!m) return null;
  const at = Date.parse(`${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`);
  const label = m[1];
  const kind: BackupFile['kind'] = label === 'auto' ? 'auto' : label === 'manual' ? 'manual' : 'migração';
  return { file, at: Number.isFinite(at) ? at : mtime, kind };
}

export interface DataGuardDeps {
  db: DatabaseSync;
  dbFile: string;
  dataDir: string;
  backupsDir: string;
  store: Store;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
}

export class DataGuard {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly d: DataGuardDeps) {}

  listBackups(): BackupFile[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.d.backupsDir); } catch { return []; }
    const out: BackupFile[] = [];
    for (const n of names) {
      const full = path.join(this.d.backupsDir, n);
      let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
      const b = parseBackupName(full, mtime); if (b) out.push(b);
    }
    return out.sort((a, b) => b.at - a.at);
  }

  private hasData(): boolean {
    for (const t of ['sessions', 'employees', 'projects', 'tasks', 'meetings', 'routines']) {
      try { if ((this.d.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n > 0) return true; } catch { /* tabela ausente */ }
    }
    return false;
  }

  /** Backup consistente agora (VACUUM INTO). Mantém só os 7 automáticos mais recentes; manuais e de migração ficam. */
  backupNow(kind: 'auto' | 'manual'): string {
    const file = backupDb(this.d.db, this.d.dbFile, this.d.backupsDir, kind);
    if (!file) throw new Error('banco em memória: não há o que copiar');
    this.d.log.info(`backup ${kind === 'auto' ? 'automático' : 'manual'} em ${file}`);
    this.prune();
    return file;
  }

  /** Um backup automático por dia, só quando há dados do Chefe. */
  autoBackupIfDue(now = Date.now()): string | null {
    if (this.d.dbFile === ':memory:' || !this.hasData()) return null;
    const last = this.listBackups().find(b => b.kind === 'auto');
    if (last && now - last.at < DAY) return null;
    try { return this.backupNow('auto'); } catch (err) { this.d.log.warn('backup automático falhou', err); return null; }
  }

  prune(): number {
    const autos = this.listBackups().filter(b => b.kind === 'auto');
    let n = 0;
    for (const b of autos.slice(AUTO_BACKUPS_KEPT)) { try { fs.rmSync(b.file, { force: true }); n++; } catch (err) { this.d.log.warn(`não removeu backup antigo ${b.file}`, err); } }
    return n;
  }

  start(): void {
    this.autoBackupIfDue();
    this.timer = setInterval(() => this.autoBackupIfDue(), CHECK_EVERY);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  info(): DataInfo {
    const count = (sql: string) => { try { return Number((this.d.db.prepare(sql).get() as { n: number }).n); } catch { return 0; } };
    let sizeBytes = 0;
    for (const f of [this.d.dbFile, `${this.d.dbFile}-wal`]) { try { sizeBytes += fs.statSync(f).size; } catch { /* sem arquivo */ } }
    const version = Number((this.d.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    const backups = this.listBackups();
    return {
      dataDir: this.d.dataDir, dbFile: this.d.dbFile, schemaVersion: version || SCHEMA_VERSION, sizeBytes,
      counts: {
        reuniões: count('SELECT COUNT(*) AS n FROM meetings WHERE deleted_at IS NULL'),
        'reuniões na lixeira': count('SELECT COUNT(*) AS n FROM meetings WHERE deleted_at IS NOT NULL'),
        'falas de reunião': count('SELECT COUNT(*) AS n FROM meeting_messages'),
        conversas: count('SELECT COUNT(*) AS n FROM sessions'),
        tarefas: count('SELECT COUNT(*) AS n FROM tasks'),
        'mensagens de conversa': count('SELECT COUNT(*) AS n FROM chat_items'),
        funcionários: count('SELECT COUNT(*) AS n FROM employees WHERE archived_at IS NULL'),
        projetos: count('SELECT COUNT(*) AS n FROM projects'),
        rotinas: count('SELECT COUNT(*) AS n FROM routines'),
      },
      lastBackup: backups[0] ?? null,
      backupsKept: backups.length,
      recentAudit: this.d.store.listAudit(20),
    };
  }
}
