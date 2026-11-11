// Observação do disco por raiz (fs.watch recursivo, que o Windows suporta). Liga quando o primeiro cliente assina,
// desliga quando o último sai; debounce de 300 ms; eventos dentro de node_modules/.git são ignorados.
import fs from 'node:fs';
import type { FsServerMessage } from '@milweb-hq/protocol';

export const WATCH_DEBOUNCE_MS = 300;
const MAX_PATHS = 200;
const IGNORED = new Set(['node_modules', '.git']);

interface Entry { watcher: fs.FSWatcher | null; clients: Set<object>; pending: Set<string>; unknown: boolean; timer: NodeJS.Timeout | null }

export interface WatchDeps {
  rootPath(rootId: string): string | null;
  broadcast(m: FsServerMessage): void;
  log: { warn(...a: unknown[]): void };
}

export class Watcher {
  private entries = new Map<string, Entry>();
  constructor(private deps: WatchDeps) {}

  subscribe(client: object, rootId: string): void {
    let e = this.entries.get(rootId);
    if (!e) {
      e = { watcher: null, clients: new Set(), pending: new Set(), unknown: false, timer: null };
      this.entries.set(rootId, e);
    }
    e.clients.add(client);
    if (!e.watcher) this.start(rootId, e);
  }

  unsubscribe(client: object, rootId: string): void {
    const e = this.entries.get(rootId);
    if (!e) return;
    e.clients.delete(client);
    if (e.clients.size === 0) this.stop(rootId, e);
  }

  onClientClose(client: object): void {
    for (const [rootId, e] of this.entries) { e.clients.delete(client); if (e.clients.size === 0) this.stop(rootId, e); }
  }

  /** Para de observar uma raiz para todos os clientes (ex.: pasta removida do cadastro). */
  closeRoot(rootId: string): void {
    const e = this.entries.get(rootId);
    if (!e) return;
    e.clients.clear();
    this.stop(rootId, e);
  }

  /** Raízes atualmente observadas (para testes e diagnóstico). */
  active(): string[] { return [...this.entries].filter(([, e]) => e.watcher).map(([id]) => id); }

  close(): void { for (const [rootId, e] of this.entries) this.stop(rootId, e); this.entries.clear(); }

  private start(rootId: string, e: Entry) {
    const abs = this.deps.rootPath(rootId);
    if (!abs) return;
    try {
      e.watcher = fs.watch(abs, { recursive: true, persistent: false }, (_ev, filename) => this.onEvent(rootId, e, filename));
      e.watcher.on('error', (err) => { this.deps.log.warn(`observação de ${rootId} parou: ${(err as Error).message}`); this.stop(rootId, e); });
    } catch (err) { this.deps.log.warn(`não foi possível observar ${rootId} (${abs}): ${(err as Error).message}`); e.watcher = null; }
  }

  private stop(rootId: string, e: Entry) {
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    try { e.watcher?.close(); } catch { /* ignorar */ }
    e.watcher = null; e.pending.clear(); e.unknown = false;
    if (e.clients.size === 0) this.entries.delete(rootId);
  }

  private onEvent(rootId: string, e: Entry, filename: string | Buffer | null) {
    if (filename == null) e.unknown = true;
    else {
      const rel = String(filename).replace(/\\/g, '/');
      if (rel.split('/').some(seg => IGNORED.has(seg))) return;
      if (e.pending.size >= MAX_PATHS) e.unknown = true; else e.pending.add(rel);
    }
    if (e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = null;
      const paths = e.unknown ? [] : [...e.pending];
      e.pending.clear(); e.unknown = false;
      if (e.watcher) this.deps.broadcast({ kind: 'fs.changed', rootId, paths });
    }, WATCH_DEBOUNCE_MS);
  }
}
