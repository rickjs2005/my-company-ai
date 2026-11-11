// Cliente JSON-RPC por stdio do `codex app-server` (Codex CLI 0.58.0, verificado em 31/10/2026 com a sonda real).
// Uma mensagem JSON por linha, SEM o campo "jsonrpc". Pedidos do cliente levam id; notificações não. O servidor também
// manda pedidos (aprovações) com id, que precisam de resposta. Nunca passa por shell: spawn direto com args em lista.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export interface CodexClientOptions {
  exePath: string;
  /** Argumentos antes de 'app-server' (ex.: [bin/codex.js] quando exePath é o node; [fake.mjs] nos testes). */
  prefixArgs?: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Prazo padrão de cada pedido (ms). */
  requestTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class CodexRpcError extends Error {
  constructor(readonly code: number | null, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

export interface ServerRequest { id: string | number; method: string; params: unknown }

export interface CodexClientEvents {
  notification: [string, unknown];
  request: [ServerRequest];
  stderr: [string];
  exit: [{ code: number | null; signal: NodeJS.Signals | null; expected: boolean }];
}

interface Pending { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class CodexClient extends EventEmitter<CodexClientEvents> {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closing = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private stderrTailBuf = '';

  constructor(readonly opts: CodexClientOptions) { super(); }

  get pid(): number | undefined { return this.child?.pid; }
  get alive(): boolean { return this.child !== null && this.exitInfo === null; }
  get stderrTail(): string { return this.stderrTailBuf; }

  start(): this {
    if (this.child) throw new Error('app-server já iniciado');
    const args = [...(this.opts.prefixArgs ?? []), 'app-server'];
    const child = spawn(this.opts.exePath, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    // Escrever num app-server que já saiu dá EPIPE de forma assíncrona; sem este ouvinte o erro derrubaria o serviço inteiro.
    child.stdin?.on('error', (err) => { this.opts.log?.(`codex app-server: erro ao escrever no stdin (${err.message})`); });
    child.on('error', (err) => {
      this.opts.log?.(`codex app-server: falha ao iniciar (${err.message})`);
      this.finish(null, null);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTailBuf = (this.stderrTailBuf + chunk).slice(-4000);
      this.emit('stderr', chunk);
    });
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));
    child.on('exit', (code, signal) => this.finish(code, signal));
    return this;
  }

  private writeLine(obj: unknown) {
    if (!this.child || !this.alive || this.closing) throw new Error('app-server não está disponível para escrita');
    this.child.stdin!.write(JSON.stringify(obj) + '\n');
  }

  /** Pedido com id; resolve com `result` ou rejeita com CodexRpcError (`error` do servidor, prazo ou processo encerrado). */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(null, `sem resposta do Codex para ${method} em ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.writeLine(params === undefined ? { method, id } : { method, id, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Notificação (sem id, sem resposta). */
  notify(method: string, params: unknown = {}): void {
    this.writeLine({ method, params });
  }

  /** Resposta a um pedido que o servidor fez ao cliente (ex.: aprovação de comando). */
  respond(id: string | number, result: unknown): void {
    try { this.writeLine({ id, result }); } catch { /* processo fechando */ }
  }

  respondError(id: string | number, code: number, message: string): void {
    try { this.writeLine({ id, error: { code, message } }); } catch { /* processo fechando */ }
  }

  /** Fecha o stdin (o app-server encerra sozinho) e mata após o prazo. Resolve quando o processo sair. */
  close(graceMs = 3000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.child) return Promise.resolve({ code: null, signal: null });
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    this.closing = true;
    return new Promise((resolve) => {
      this.once('exit', () => resolve(this.exitInfo ?? { code: null, signal: null }));
      try { this.child!.stdin!.end(); } catch { /* já fechado */ }
      setTimeout(() => { if (!this.exitInfo) this.kill(); }, graceMs).unref();
    });
  }

  kill(): void {
    if (!this.child || this.exitInfo) return;
    this.closing = true;
    try { this.child.kill('SIGKILL'); } catch { /* ignorar */ }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exitInfo) return;
    this.exitInfo = { code, signal };
    const expected = this.closing;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new CodexRpcError(null, `o Codex app-server encerrou durante ${p.method}`)); }
    this.pending.clear();
    this.emit('exit', { code, signal, expected });
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch {
      this.emit('stderr', `[linha não-JSON] ${line.slice(0, 300)}\n`);
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (hasId) this.emit('request', { id: msg.id as string | number, method: msg.method, params: msg.params });
      else this.emit('notification', msg.method, msg.params);
      return;
    }
    if (hasId && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error !== undefined && msg.error !== null) {
        const e = msg.error as { code?: unknown; message?: unknown; data?: unknown };
        p.reject(new CodexRpcError(typeof e.code === 'number' ? e.code : null, typeof e.message === 'string' ? e.message : 'erro do Codex', e.data));
      } else {
        p.resolve(msg.result);
      }
    }
  }
}
