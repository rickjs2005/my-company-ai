// Controle de um processo real do Claude Code em modo -p com entrada e saída stream-json.
// Mecanismo verificado nas provas 1-3 (30/10/2026) com o CLI 2.1.314 instalado no Windows.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type {
  BridgeOptions, ContentBlock, InitInfo, PermissionRequest, PermissionResult, ProcessState, RawEvent, ResultInfo, UserMessageInput,
} from './types.js';

/** Variáveis que marcam "estou dentro de uma sessão do Claude Code"; removidas para o filho não se achar aninhado. */
const NESTING_ENV_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT',
];

export function buildArgs(opts: BridgeOptions): string[] {
  const args = [
    ...(opts.commandPrefixArgs ?? []),
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    // Pedidos de permissão chegam como control_request (subtype can_use_tool) e são respondidos pelo stdin.
    '--permission-prompt-tool=stdio',
  ];
  if (opts.includePartialMessages !== false) args.push('--include-partial-messages');
  if (opts.includeHookEvents) args.push('--include-hook-events');
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  // Lista separada por vírgula (help do CLI 2.1.314: --tools "Bash,Edit,Read"; "" desliga todas).
  if (opts.tools) args.push('--tools', opts.tools.join(','));
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.resume) args.push('--resume', opts.resume);
  else if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.sessionName) args.push('--name', opts.sessionName);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

export function sanitizedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of NESTING_ENV_VARS) delete env[k];
  return env;
}

interface PendingControl { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export interface ClaudeProcessEvents {
  raw: [RawEvent];
  init: [InitInfo];
  state: [ProcessState, ProcessState];
  turn_started: [{ auto: boolean }];
  permission_request: [PermissionRequest];
  permission_resolved: [{ requestId: string; result: PermissionResult }];
  result: [ResultInfo];
  stderr: [string];
  exit: [{ code: number | null; signal: NodeJS.Signals | null; expected: boolean }];
  spawn_error: [Error];
}

export class ClaudeProcess extends EventEmitter<ClaudeProcessEvents> {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  sessionId: string | null = null;
  state: ProcessState = 'starting';
  turnActive = false;
  init: InitInfo | null = null;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  lastResult: ResultInfo | null = null;
  readonly pendingPermissions = new Map<string, PermissionRequest>();
  private child: ChildProcess | null = null;
  private readonly pendingControl = new Map<string, PendingControl>();
  private closing = false;
  private stderrBuffer = '';

  constructor(readonly opts: BridgeOptions) {
    super();
  }

  get pid(): number | undefined { return this.child?.pid; }
  get alive(): boolean { return this.child !== null && this.exitInfo === null; }

  start(): this {
    if (this.child) throw new Error('processo já iniciado');
    const args = buildArgs(this.opts);
    const child = spawn(this.opts.exePath, args, {
      cwd: this.opts.cwd,
      env: sanitizedEnv(this.opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    // Escrever num CLI que já saiu dá EPIPE de forma assíncrona; sem este ouvinte o erro derrubaria o serviço inteiro.
    child.stdin?.on('error', (err) => { this.stderrBuffer = (this.stderrBuffer + `[stdin] ${err.message}\n`).slice(-4000); });
    child.on('error', (err) => {
      this.emit('spawn_error', err);
      this.finish(null, null);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-4000);
      this.emit('stderr', chunk);
    });
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));
    child.on('exit', (code, signal) => this.finish(code, signal));
    return this;
  }

  get stderrTail(): string { return this.stderrBuffer; }

  private setState(next: ProcessState) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.emit('state', next, prev);
  }

  private writeLine(obj: unknown) {
    if (!this.child || !this.alive || this.closing) throw new Error('processo não está disponível para escrita');
    this.child.stdin!.write(JSON.stringify(obj) + '\n');
  }

  /** Envia uma mensagem do usuário. O prompt vai como dado JSON, nunca concatenado em shell. */
  sendUser(content: string | ContentBlock[], extra: { priority?: 'now' | 'next' | 'later' } = {}): void {
    const msg: UserMessageInput = {
      type: 'user',
      message: { role: 'user', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content },
      parent_tool_use_id: null,
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
      ...(extra.priority ? { priority: extra.priority } : {}),
    };
    this.writeLine(msg);
    if (!this.turnActive) {
      this.turnActive = true;
      this.emit('turn_started', { auto: false });
    }
    this.setState('running');
  }

  respondPermission(requestId: string, result: PermissionResult): void {
    const req = this.pendingPermissions.get(requestId);
    if (!req) throw new Error(`pedido de permissão desconhecido: ${requestId}`);
    const response = result.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: result.updatedInput ?? req.input, ...(result.updatedPermissions ? { updatedPermissions: result.updatedPermissions } : {}) }
      : { behavior: 'deny', message: result.message, ...(result.interrupt ? { interrupt: true } : {}) };
    this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.pendingPermissions.delete(requestId);
    this.emit('permission_resolved', { requestId, result });
    if (this.pendingPermissions.size === 0 && this.turnActive) this.setState('running');
  }

  /** Responde um AskUserQuestion: answers = { [pergunta]: rótulo escolhido } (vários rótulos separados por ", "). */
  answerQuestion(requestId: string, answers: Record<string, string>): void {
    const req = this.pendingPermissions.get(requestId);
    if (!req) throw new Error(`pergunta desconhecida: ${requestId}`);
    this.respondPermission(requestId, { behavior: 'allow', updatedInput: { ...req.input, answers } });
  }

  /** Envia um control_request e espera o control_response correspondente. */
  request<T = unknown>(request: Record<string, unknown> & { subtype: string }, timeoutMs = this.opts.controlTimeoutMs ?? 30_000): Promise<T> {
    const request_id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(request_id);
        reject(new Error(`sem resposta para ${request.subtype} em ${timeoutMs} ms`));
      }, timeoutMs);
      this.pendingControl.set(request_id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.writeLine({ type: 'control_request', request_id, request });
      } catch (err) {
        clearTimeout(timer);
        this.pendingControl.delete(request_id);
        reject(err as Error);
      }
    });
  }

  interrupt(cancelQueued = false): Promise<{ still_queued?: string[]; cancelled?: string[] }> {
    return this.request({ subtype: 'interrupt', ...(cancelQueued ? { cancel_queued: true } : {}) });
  }

  setModel(model: string | null): Promise<unknown> { return this.request({ subtype: 'set_model', model }); }
  setPermissionMode(mode: string): Promise<unknown> { return this.request({ subtype: 'set_permission_mode', mode }); }

  /** Fecha o stdin (o CLI encerra sozinho quando não há turno ativo); mata após o prazo. */
  close(graceMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.child) return Promise.resolve({ code: null, signal: null });
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    this.closing = true;
    return new Promise((resolve) => {
      const done = () => resolve(this.exitInfo ?? { code: null, signal: null });
      this.once('exit', done);
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
    for (const [, p] of this.pendingControl) { clearTimeout(p.timer); p.reject(new Error('processo encerrou')); }
    this.pendingControl.clear();
    this.turnActive = false;
    this.setState('exited');
    this.emit('exit', { code, signal, expected });
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let ev: RawEvent;
    try { ev = JSON.parse(line) as RawEvent; } catch {
      this.emit('stderr', `[linha não-JSON] ${line.slice(0, 300)}\n`);
      return;
    }
    if (typeof ev.session_id === 'string' && !this.sessionId) this.sessionId = ev.session_id;
    switch (ev.type) {
      case 'control_response': {
        const resp = ev.response as { request_id: string; subtype: string; response?: unknown; error?: string };
        const pending = this.pendingControl.get(resp.request_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingControl.delete(resp.request_id);
          if (resp.subtype === 'error') pending.reject(new Error(resp.error ?? 'erro de controle'));
          else pending.resolve(resp.response);
        }
        break;
      }
      case 'control_request': {
        const request = ev.request as Record<string, unknown>;
        const requestId = ev.request_id as string;
        if (request.subtype === 'can_use_tool') {
          const req: PermissionRequest = {
            requestId,
            toolName: String(request.tool_name),
            displayName: request.display_name as string | undefined,
            input: (request.input as Record<string, unknown>) ?? {},
            toolUseId: request.tool_use_id as string | undefined,
            description: request.description as string | undefined,
            title: request.title as string | undefined,
            decisionReason: request.decision_reason as string | undefined,
            decisionReasonType: request.decision_reason_type as string | undefined,
            permissionSuggestions: request.permission_suggestions as PermissionRequest['permissionSuggestions'],
            blockedPath: request.blocked_path as string | undefined,
            requiresUserInteraction: request.requires_user_interaction as boolean | undefined,
            agentId: request.agent_id as string | undefined,
            receivedAt: Date.now(),
          };
          this.pendingPermissions.set(requestId, req);
          this.setState('requires_action');
          this.emit('permission_request', req);
        } else {
          // Diálogos e outros pedidos não suportados: responder erro para o CLI não ficar esperando para sempre.
          try {
            this.writeLine({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `MilWeb HQ não suporta ${String(request.subtype)}` } });
          } catch { /* processo fechando */ }
        }
        break;
      }
      case 'system': {
        if (ev.subtype === 'init') {
          const info: InitInfo = {
            sessionId: String(ev.session_id),
            model: String(ev.model),
            permissionMode: String(ev.permissionMode),
            cwd: String(ev.cwd),
            tools: (ev.tools as string[]) ?? [],
            mcpServers: (ev.mcp_servers as InitInfo['mcpServers']) ?? [],
            claudeCodeVersion: ev.claude_code_version as string | undefined,
            skills: ev.skills as string[] | undefined,
            plugins: ev.plugins as InitInfo['plugins'],
            slashCommands: ev.slash_commands as string[] | undefined,
            apiKeySource: ev.apiKeySource as string | undefined,
          };
          const first = !this.init;
          this.init = info;
          this.sessionId = info.sessionId;
          if (first) this.emit('init', info);
          this.noteTurnActivity();
        } else if (ev.subtype === 'session_state_changed') {
          const s = ev.state as string;
          if (s === 'running') this.noteTurnActivity();
        }
        break;
      }
      case 'assistant':
      case 'stream_event':
        this.noteTurnActivity();
        break;
      case 'result': {
        const r: ResultInfo = {
          subtype: String(ev.subtype),
          isError: Boolean(ev.is_error),
          numTurns: Number(ev.num_turns ?? 0),
          durationMs: Number(ev.duration_ms ?? 0),
          stopReason: (ev.stop_reason as string | null) ?? null,
          terminalReason: ev.terminal_reason as string | undefined,
          resultText: typeof ev.result === 'string' ? ev.result : '',
          errors: (ev.errors as string[]) ?? [],
          permissionDenials: (ev.permission_denials as ResultInfo['permissionDenials']) ?? [],
          totalCostUsd: ev.total_cost_usd as number | undefined,
          usage: ev.usage as Record<string, unknown> | undefined,
          sessionId: String(ev.session_id ?? this.sessionId ?? ''),
        };
        this.lastResult = r;
        this.turnActive = false;
        this.pendingPermissions.clear();
        this.setState('idle');
        this.emit('raw', ev);
        this.emit('result', r);
        return;
      }
      default:
        break;
    }
    this.emit('raw', ev);
  }

  /** O CLI pode começar um turno sozinho (ex.: tarefa em segundo plano concluída). Registrar como turno automático. */
  private noteTurnActivity() {
    if (this.turnActive) return;
    if (this.state === 'idle') {
      this.turnActive = true;
      this.emit('turn_started', { auto: true });
      this.setState('running');
    } else if (this.state === 'starting') {
      // Primeiro init antes de qualquer envio: o processo está pronto e ocioso.
      this.setState('idle');
    }
  }
}
