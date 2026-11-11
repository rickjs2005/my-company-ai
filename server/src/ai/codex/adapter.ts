// Adaptador do ChatGPT para a sala de reunião, via Codex CLI instalado rodando como `codex app-server` (JSON-RPC por stdio).
// Fatos verificados em 31/10/2026 com o @openai/codex 0.58.0: initialize → userAgent 'codex_cli_rs/<versão>'; model/list;
// account/read {refreshToken:false}; thread/start + turn/start com sandbox readOnly e approvalPolicy never; notificações
// item/agentMessage/delta, item/completed, turn/completed {turn, usage}; login oficial account/login/start → authUrl.
// SEM login o turn/start é aceito e fica "reconectando" em vez de falhar: por isso account/read vem antes de cada turno.
import { EventEmitter } from 'node:events';
import { isEffortLevel, type AiModelOption, type AiProviderStatus, type AiTestResult, type EffortLevel, type MeetingTurn } from '@milweb-hq/protocol';
import { childEnv } from '../../claude-info.js';
import { TEST_PROMPT, type AiAdapter, type AiAdapterEvents, type ProviderTurnStop, type TurnHandle, type TurnOutcome, type TurnRequest, type ValidationResult } from '../types.js';
import { CodexClient, type ServerRequest } from './client.js';
import { locateCodex, type CodexInstall } from './locate.js';

export const CODEX_LATEST_KNOWN_VERSION = '0.166.0'; // npm em 31/10/2026; só informativo, a HQ nunca atualiza nada.
const CLIENT_INFO = { name: 'milweb-hq', title: 'My Company AI', version: '0.3.0' };
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_INTERRUPT_GRACE_MS = 5000;
const NO_LOGIN_DETAIL = 'ChatGPT sem login no Codex. Use o botão "Entrar com ChatGPT" (abre o login oficial no navegador) ou rode `codex login` no terminal.';

export interface CodexAdapterOptions {
  /** Caminho do executável; null/ausente = localizar (MILWEB_HQ_CODEX_EXE, npm global). Para testes: process.execPath + commandPrefixArgs. */
  exePath?: string | null;
  /** Argumentos antes de 'app-server' (ex.: [fake-codex.mjs] nos testes). */
  commandPrefixArgs?: string[];
  /** Variáveis extras; a base é sempre childEnv() de claude-info.ts. */
  env?: NodeJS.ProcessEnv;
  /** Marco 0: ajuste final do ambiente (a HQ tira as credenciais de integração). */
  wrapEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  /** Prazo dos pedidos de controle (initialize, model/list, account/read...). */
  requestTimeoutMs?: number;
  /** Quanto esperar pelo turn/completed depois de um turn/interrupt antes de encerrar o turno por conta própria. */
  interruptGraceMs?: number;
}

// Formas das respostas do app-server 0.58.0 (bindings v2 geradas pelo próprio Codex).
interface CodexModel { id: string; model: string; displayName: string; description: string; supportedReasoningEfforts: { reasoningEffort: string; description: string }[]; defaultReasoningEffort: string; isDefault: boolean }
interface CodexAccount { type: 'chatgpt'; email?: string; planType?: string }
interface CodexAccountApiKey { type: 'apiKey' }
interface GetAccountResponse { account: CodexAccount | CodexAccountApiKey | null; requiresOpenaiAuth: boolean }
interface TurnInfo { id: string; status: 'completed' | 'interrupted' | 'failed' | 'inProgress'; error?: { message: string } | null; model?: string }
interface TurnCompleted { turn: TurnInfo; usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | null }

interface TurnControl {
  interrupted: boolean;
  timedOut: boolean;
  /** Preenchido assim que turn/start responde; interrupt() usa para mandar turn/interrupt. */
  live: { threadId: string; turnId: string } | null;
  /** Avisa o turno em andamento de que a interrupção foi pedida (para encerrar sozinho se o Codex não confirmar). */
  onInterruptRequested: (() => void) | null;
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }

// Erros do Codex que não são deste turno (observados em 02/11/2026 com o 0.58.0 e conta ChatGPT Plus):
// - modelo recusado: `codex/event/error` "unexpected status 400 Bad Request: {...\"code\":\"model_not_found\"... The 'gpt-5' model is not supported
//   when using Codex with a ChatGPT account.}" depois de 5 "Reconnecting... n/5", seguido de `codex/event/task_complete` SEM turn/completed
//   (por isso a HQ esperava os 600 s inteiros);
// - limite de uso: "You've hit your usage limit. ... try again in 2 hours 5 minutes" / "try again at 3:15 PM" (texto do Codex CLI).
const CODEX_USAGE_RE = /usage limit|hit your .{0,30}limit|rate limit|too many requests|\b429\b|quota/i;
const CODEX_MODEL_RE = /model_not_found|model is not supported|not supported when using Codex/i;
const CODEX_USAGE_FALLBACK_MIN = 30;

/** "try again in 2 hours 5 minutes" / "in 3 days 1 hour" / "at 3:15 PM" → instante (ms) ou null. */
export function parseCodexRetry(text: string, now: number): number | null {
  const rel = /try again in\s+([^.]+)/i.exec(text);
  if (rel) {
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+)\s*(day|hour|minute|min|second|sec)s?/gi)) {
      const n = Number(m[1]); const u = m[2].toLowerCase();
      ms += n * (u.startsWith('day') ? 86_400_000 : u.startsWith('hour') ? 3_600_000 : u.startsWith('min') ? 60_000 : 1000);
    }
    if (ms > 0) return now + ms;
  }
  const abs = /try again at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
  if (abs) {
    let h = Number(abs[1]); const min = Number(abs[2]); const ap = abs[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const d = new Date(now); d.setHours(h, min, 0, 0); // o Codex escreve no horário local da máquina
    let t = d.getTime(); if (t <= now) t += 86_400_000;
    return t;
  }
  return null;
}

/** Classifica o erro do Codex: limite de uso ou modelo recusado viram parada do provedor; o resto é falha comum do turno. */
export function classifyCodexError(message: string, now: number, version: string | null): ProviderTurnStop | null {
  if (CODEX_MODEL_RE.test(message)) {
    const model = /The '([^']+)' model/i.exec(message)?.[1];
    return { kind: 'config', until: null, reason: `erro de configuração: a OpenAI recusou o modelo${model ? ` ${model}` : ''} nesta conta ChatGPT: o Codex instalado${version ? ` (${version})` : ''} está desatualizado e só conhece modelos que não são mais aceitos. Atualize o Codex (npm i -g @openai/codex@latest) e teste em Ajustes → Inteligência artificial` };
  }
  if (CODEX_USAGE_RE.test(message)) {
    const until = parseCodexRetry(message, now);
    return { kind: 'usage_limit', until: until ?? now + CODEX_USAGE_FALLBACK_MIN * 60_000, untilInformed: until !== null, reason: 'limite de uso do ChatGPT esgotado' };
  }
  if (/unauthorized|\b401\b|not logged in|login (expired|required)|refresh token|sign in again/i.test(message)) return { kind: 'auth', until: null, reason: 'login do ChatGPT perdido no Codex: entre de novo em Ajustes → Inteligência artificial' };
  return null;
}

/** Mensagem legível do erro do Codex (tira o JSON cru do 400). */
function codexErrorText(message: string): string {
  const inner = /"message"\s*:\s*"([^"]+)"/.exec(message)?.[1] ?? /"detail"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  return truncate(inner ?? message, 300);
}

export class CodexAdapter extends EventEmitter<AiAdapterEvents> implements AiAdapter {
  readonly provider = 'openai' as const;
  private st: AiProviderStatus;
  private client: CodexClient | null = null;
  private starting: Promise<CodexClient> | null = null;
  private install: CodexInstall | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (msg: string) => void;
  private chain: Promise<unknown> = Promise.resolve();
  private loginId: string | null = null;
  private closed = false;
  /** Turnos encerrados por aqui sem turn/completed do Codex: tudo o que o app-server ainda mandar deles é ignorado. */
  private readonly orphanTurns = new Set<string>();

  constructor(private readonly opts: CodexAdapterOptions = {}) {
    super();
    this.env = (opts.wrapEnv ?? (e => e))({ ...childEnv(), ...(opts.env ?? {}) });
    this.log = opts.log ?? (() => {});
    this.st = {
      provider: 'openai',
      label: 'ChatGPT',
      routeLabel: 'via Codex (app-server local, conta ChatGPT)',
      installed: false,
      exePath: null,
      version: null,
      latestKnownVersion: CODEX_LATEST_KNOWN_VERSION,
      authState: 'unknown',
      authMethod: null,
      authDetail: 'Ainda não verificado. Clique em "Atualizar opções" para consultar o Codex.',
      models: [],
      catalogSource: 'model/list do Codex (ainda não consultado)',
      catalogAt: null,
      checkedAt: null,
      busy: false,
      lastTest: null,
      login: null,
      prefs: { model: null, effort: null },
    };
  }

  /** PID do app-server em execução (diagnóstico e testes). */
  get pid(): number | undefined { return this.client?.pid; }
  get alive(): boolean { return this.client?.alive ?? false; }

  status(): AiProviderStatus { return { ...this.st, models: this.st.models.map(m => ({ ...m })), prefs: { ...this.st.prefs } }; }
  models(): AiModelOption[] { return this.st.models.map(m => ({ ...m })); }

  private patch(p: Partial<AiProviderStatus>) {
    this.st = { ...this.st, ...p };
    this.emit('status', this.status());
  }

  /** Pedido cru ao app-server (diagnóstico e testes). Inicia o processo se preciso. */
  async rpc<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const c = await this.ensureClient();
    return c.request<T>(method, params, timeoutMs);
  }

  // ---------- processo ----------

  private resolveInstall(): CodexInstall | null {
    if (this.install) return this.install;
    if (this.opts.exePath) this.install = { exePath: this.opts.exePath, prefixArgs: this.opts.commandPrefixArgs ?? [], source: 'env' };
    else this.install = locateCodex(this.env);
    return this.install;
  }

  /** Garante um app-server vivo e inicializado. Lança (com mensagem em português) quando não dá. */
  private ensureClient(): Promise<CodexClient> {
    if (this.closed) return Promise.reject(new Error('adaptador do Codex já encerrado'));
    if (this.client?.alive) return Promise.resolve(this.client);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const install = this.resolveInstall();
      if (!install) {
        this.patch({ installed: false, exePath: null, version: null });
        throw new Error('Codex CLI não encontrado (esperado em %APPDATA%/npm/node_modules/@openai/codex ou em MILWEB_HQ_CODEX_EXE). Instale com `npm i -g @openai/codex`.');
      }
      const client = new CodexClient({ exePath: install.exePath, prefixArgs: install.prefixArgs, env: this.env, requestTimeoutMs: this.opts.requestTimeoutMs, log: this.log }).start();
      client.on('notification', (method, params) => this.onNotification(method, params));
      client.on('request', (req) => this.onServerRequest(client, req));
      client.on('exit', ({ code, signal, expected }) => {
        if (this.client === client) this.client = null;
        if (!expected && !this.closed) {
          this.log(`codex app-server encerrou sozinho (code=${code} signal=${signal}) ${truncate(client.stderrTail.trim(), 200)}`);
          this.loginId = null;
          this.patch({ authState: 'error', authDetail: `O Codex app-server encerrou sozinho (code ${code ?? '?'}). Será reiniciado no próximo uso.`, login: null });
        }
      });
      try {
        const init = await client.request<{ userAgent?: string }>('initialize', { clientInfo: CLIENT_INFO });
        client.notify('initialized', {});
        const ua = typeof init?.userAgent === 'string' ? init.userAgent : '';
        const version = /codex_cli_rs\/([^\s]+)/.exec(ua)?.[1] ?? null;
        this.client = client;
        this.patch({ installed: true, exePath: install.exePath, version });
        this.log(`codex app-server pronto (pid ${client.pid}, versão ${version ?? 'desconhecida'}, origem ${install.source})`);
        return client;
      } catch (err) {
        const tail = truncate(client.stderrTail.trim(), 200);
        client.kill();
        this.patch({ installed: true, exePath: install.exePath });
        throw new Error(`Não foi possível iniciar o Codex app-server: ${(err as Error).message}${tail ? ` (${tail})` : ''}`);
      }
    })();
    return this.starting.finally(() => { this.starting = null; });
  }

  private onNotification(method: string, params: unknown) {
    if (method === 'turn/completed') {
      const id = (params as TurnCompleted | undefined)?.turn?.id;
      if (id && this.orphanTurns.delete(id)) this.log(`codex turno órfão ${id} concluiu tarde; o que ele transmitiu depois do encerramento foi ignorado`);
    }
    if (method.startsWith('codex/event/')) { if (process.env.MILWEB_HQ_DEBUG) this.log(`codex evento legado ${method}`); return; }
    if (method === 'account/login/completed') {
      const p = (params ?? {}) as { loginId?: string | null; success?: boolean; error?: string | null };
      this.log(`codex login concluído: success=${p.success === true}`);
      this.loginId = null;
      if (p.success) {
        this.patch({ login: null });
        void this.readAccount().catch(() => { /* já virou authState error */ });
      } else {
        this.patch({ login: null, authState: 'missing', authDetail: `Login não concluído${p.error ? `: ${truncate(String(p.error), 200)}` : ''}. ${NO_LOGIN_DETAIL}` });
      }
      return;
    }
    if (method === 'account/updated') { void this.readAccount().catch(() => { /* idem */ }); }
  }

  /** Pedidos do servidor ao cliente: aprovações são sempre negadas (reunião é análise, nada é executado nem alterado). */
  private onServerRequest(client: CodexClient, req: ServerRequest) {
    if (req.method === 'execCommandApproval' || req.method === 'applyPatchApproval') {
      // Bindings 0.58.0: ReviewDecision = approved | approved_for_session | denied | abort.
      this.log(`codex pediu aprovação (${req.method}); negada`);
      client.respond(req.id, { decision: 'denied' });
    } else if (/requestApproval$/i.test(req.method)) {
      // Forma v2 de versões mais novas (item/commandExecution/requestApproval): decision accept | acceptForSession | decline | cancel.
      this.log(`codex pediu aprovação (${req.method}); negada`);
      client.respond(req.id, { decision: 'decline' });
    } else {
      client.respondError(req.id, -32601, `My Company AI não atende ${req.method}`);
    }
  }

  // ---------- descoberta ----------

  async refresh(): Promise<AiProviderStatus> {
    this.patch({ busy: true });
    try {
      const client = await this.ensureClient();
      await this.loadCatalog(client);
      await this.readAccount(client);
    } catch (err) {
      const msg = (err as Error).message;
      this.log(`codex refresh falhou: ${truncate(msg, 300)}`);
      this.patch({ authState: 'error', authMethod: null, authDetail: msg });
    } finally {
      this.patch({ busy: false, checkedAt: Date.now() });
    }
    return this.status();
  }

  private async loadCatalog(client: CodexClient) {
    const res = await client.request<{ data?: CodexModel[] }>('model/list', {});
    const data = Array.isArray(res?.data) ? res.data : [];
    const models: AiModelOption[] = data.map(m => {
      const efforts = (m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort).filter(isEffortLevel);
      const def = isEffortLevel(m.defaultReasoningEffort) ? m.defaultReasoningEffort : null;
      return {
        id: m.model || m.id,
        label: m.displayName || m.model || m.id,
        efforts,
        defaultEffort: def,
        isDefault: Boolean(m.isDefault),
        note: m.description ? truncate(m.description.trim(), 140) : null,
      };
    });
    this.patch({ models, catalogSource: `model/list do Codex ${this.st.version ?? '(versão desconhecida)'}`, catalogAt: Date.now() });
  }

  /** account/read sem refresh de token. Devolve true quando há conta. Erro de transporte lança (vira authState error em quem chama). */
  private async readAccount(client?: CodexClient): Promise<boolean> {
    const c = client ?? await this.ensureClient();
    try {
      const res = await c.request<GetAccountResponse>('account/read', { refreshToken: false });
      const acct = res?.account ?? null;
      if (!acct) {
        this.patch({ authState: 'missing', authMethod: null, authDetail: NO_LOGIN_DETAIL });
        return false;
      }
      if (acct.type === 'chatgpt') {
        const plan = acct.planType ? String(acct.planType) : 'plano desconhecido';
        const email = typeof acct.email === 'string' && acct.email ? maskEmail(acct.email) : null;
        this.patch({ authState: 'ok', authMethod: `ChatGPT · ${plan}`, authDetail: email ? `Conta ChatGPT ${email} (${plan}) logada no Codex.` : `Conta ChatGPT (${plan}) logada no Codex.` });
      } else {
        this.patch({ authState: 'ok', authMethod: 'chave de API', authDetail: 'Codex autenticado por chave de API da OpenAI (cobra na API, não na assinatura do ChatGPT).' });
      }
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      this.patch({ authState: 'error', authMethod: null, authDetail: `Não foi possível ler a conta no Codex: ${truncate(msg, 200)}` });
      throw err;
    }
  }

  // ---------- validação ----------

  validate(model: string | null, effort: EffortLevel | null): ValidationResult {
    const catalog = this.st.models;
    if (model === null && effort === null) return { ok: true, model: null, effort: null, note: null };
    const target = model === null ? (catalog.find(m => m.isDefault) ?? null) : (catalog.find(m => m.id === model) ?? null);
    if (model !== null && !target) {
      const reason = catalog.length
        ? `Modelo "${model}" não está no catálogo do Codex ${this.st.version ?? ''} (disponíveis: ${catalog.map(m => m.id).join(', ')}).`
        : `Modelo "${model}" não pôde ser conferido: o catálogo do Codex ainda não foi carregado (clique em "Atualizar opções").`;
      return { ok: false, reason: reason.replace('  ', ' '), model, effort, alternatives: [] };
    }
    if (effort === null) return { ok: true, model, effort: null, note: null };
    if (!target) {
      return { ok: false, reason: 'Não dá para conferir o esforço sem o catálogo do Codex carregado (clique em "Atualizar opções").', model, effort, alternatives: [] };
    }
    if (!target.efforts.includes(effort)) {
      const accepted = target.efforts.length ? `aceita: ${target.efforts.join(', ')}` : 'não aceita controle de esforço';
      return { ok: false, reason: `O modelo ${target.id} não aceita esforço "${effort}" (${accepted}).`, model, effort, alternatives: [...target.efforts] };
    }
    return { ok: true, model, effort, note: null };
  }

  // ---------- turnos ----------

  startTurn(req: TurnRequest): TurnHandle {
    const ctl: TurnControl = { interrupted: false, timedOut: false, live: null, onInterruptRequested: null };
    const run = this.chain.then(() => this.runTurn(req, ctl));
    this.chain = run.catch(() => { /* a falha volta pelo done */ });
    const interrupt = async () => {
      if (ctl.interrupted) return;
      ctl.interrupted = true;
      if (ctl.live && this.client?.alive) {
        try { await this.client.request('turn/interrupt', { threadId: ctl.live.threadId, turnId: ctl.live.turnId }, 10_000); }
        catch (err) { this.log(`codex turn/interrupt falhou: ${truncate((err as Error).message, 200)}`); }
      }
      ctl.onInterruptRequested?.();
    };
    return { done: run, interrupt };
  }

  private async runTurn(req: TurnRequest, ctl: TurnControl): Promise<TurnOutcome> {
    const startedAt = Date.now();
    const applied = { model: req.model, effort: req.effort, resolvedModel: req.model ?? (this.st.models.find(m => m.isDefault)?.id ?? null) };
    const fail = (error: string, text = '', threadId: string | null = req.threadId): TurnOutcome =>
      ({ status: 'failed', text, threadId, applied, error, durationMs: Date.now() - startedAt, usage: null });
    const interruptedEarly = (): TurnOutcome => ({ status: 'interrupted', text: '', threadId: req.threadId, applied, error: null, durationMs: Date.now() - startedAt, usage: null });
    if (ctl.interrupted) return interruptedEarly();

    let client: CodexClient;
    try { client = await this.ensureClient(); } catch (err) {
      this.patch({ authState: 'error', authDetail: (err as Error).message });
      return fail((err as Error).message);
    }
    if (!this.st.models.length) { try { await this.loadCatalog(client); } catch { /* o turno segue; o Codex valida o modelo */ } }
    if (applied.resolvedModel === null) applied.resolvedModel = this.st.models.find(m => m.isDefault)?.id ?? null;

    let logged = false;
    try { logged = await this.readAccount(client); } catch (err) { return fail(`Não foi possível confirmar o login no Codex: ${(err as Error).message}`); }
    if (!logged) return { ...fail(NO_LOGIN_DETAIL), stop: { kind: 'auth', until: null, reason: 'login do ChatGPT perdido no Codex: entre de novo em Ajustes → Inteligência artificial' } };
    if (ctl.interrupted) return interruptedEarly();

    // Thread: retomar quando houver id; se a retomada falhar (rollout sumiu), começa outra e avisa pelo log.
    const threadParams = { cwd: req.cwd, approvalPolicy: 'never', sandbox: 'readOnly', developerInstructions: req.systemPrompt, model: req.model };
    let threadId: string | null = null;
    try {
      if (req.threadId) {
        try {
          const r = await client.request<{ thread?: { id?: string } }>('thread/resume', { threadId: req.threadId, ...threadParams });
          threadId = r?.thread?.id ?? req.threadId;
        } catch (err) {
          this.log(`codex thread/resume ${req.threadId} falhou (${truncate((err as Error).message, 160)}); iniciando thread nova`);
        }
      }
      if (!threadId) {
        const r = await client.request<{ thread?: { id?: string } }>('thread/start', threadParams);
        threadId = r?.thread?.id ?? null;
        if (!threadId) return fail('O Codex não devolveu o id da thread em thread/start.');
      }
    } catch (err) {
      return fail(`Falha ao abrir a thread no Codex: ${(err as Error).message}`);
    }
    const tid: string = threadId;

    // Acúmulo do texto: um registro por item agentMessage, na ordem de chegada.
    const items = new Map<string, string>();
    const order: string[] = [];
    const fullText = () => order.map(id => items.get(id) ?? '').filter(Boolean).join('\n\n');
    let turnId: string | null = null;
    let completed: TurnCompleted | null = null;
    /** Último erro definitivo do Codex neste turno (`codex/event/error` ou `error` sem nova tentativa). */
    let lastError: string | null = null;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

    const result = await new Promise<TurnOutcome>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        client.off('notification', onNotif);
        client.off('exit', onExit);
        ctl.onInterruptRequested = null;
      };
      const settle = (o: TurnOutcome) => { if (settled) return; settled = true; cleanup(); resolve(o); };
      const outcome = (status: TurnOutcome['status'], error: string | null, usage: MeetingTurn['usage'] = null, resolvedModel = applied.resolvedModel, stop: ProviderTurnStop | null = null): TurnOutcome =>
        ({ status, text: fullText(), threadId: tid, applied: { ...applied, resolvedModel }, error, durationMs: Date.now() - startedAt, usage, stop });
      /** Turno encerrado pelo erro do Codex (sem turn/completed): falha na hora, com a parada do provedor quando for o caso. */
      const failFromError = (message: string) => {
        const stop = classifyCodexError(message, Date.now(), this.st.version ?? null);
        settleOrphan(outcome('failed', `Codex: ${stop?.reason ?? codexErrorText(message)}`, null, applied.resolvedModel, stop));
      };
      const timeoutError = `Tempo máximo do turno (${Math.round(timeoutMs / 1000)} s) estourado; o turno foi interrompido.`;
      const finishFromTurn = (turn: TurnInfo, usageRaw: TurnCompleted['usage']) => {
        const usage: MeetingTurn['usage'] = usageRaw && (typeof usageRaw.inputTokens === 'number' || typeof usageRaw.outputTokens === 'number')
          ? { ...(typeof usageRaw.inputTokens === 'number' ? { inputTokens: usageRaw.inputTokens } : {}), ...(typeof usageRaw.outputTokens === 'number' ? { outputTokens: usageRaw.outputTokens } : {}) }
          : null;
        const resolvedModel = typeof turn.model === 'string' && turn.model ? turn.model : applied.resolvedModel;
        if (ctl.timedOut) return settle(outcome('failed', timeoutError, usage, resolvedModel));
        if (turn.status === 'completed') return settle(outcome('done', null, usage, resolvedModel));
        if (turn.status === 'interrupted' || ctl.interrupted) return settle(outcome('interrupted', null, usage, resolvedModel));
        const message = turn.error?.message ?? lastError;
        const stop = message ? classifyCodexError(message, Date.now(), this.st.version ?? null) : null;
        return settle(outcome('failed', message ? `Codex: ${stop?.reason ?? codexErrorText(message)}` : `Codex encerrou o turno com status "${turn.status}".`, usage, resolvedModel, stop));
      };
      const onNotif = (method: string, params: unknown) => {
        const p = (params ?? {}) as Record<string, unknown>;
        // Só o que é deste turno: o app-server é compartilhado, e um turno anterior encerrado por aqui pode continuar transmitindo.
        const nt = typeof p.threadId === 'string' ? p.threadId : typeof p.conversationId === 'string' ? p.conversationId : null;
        const ntu = typeof p.turnId === 'string' ? p.turnId : null;
        if (nt && nt !== tid) return;
        if (ntu && (this.orphanTurns.has(ntu) || (turnId && ntu !== turnId))) return;
        if (method === 'codex/event/error' || method === 'error') {
          // 0.58.0: {msg: {type: 'error', message}}; versões novas: {error: {message}, willRetry}.
          const msg = (p.msg as { message?: unknown } | undefined)?.message ?? (p.error as { message?: unknown } | undefined)?.message;
          if (typeof msg === 'string' && msg && p.willRetry !== true) {
            lastError = msg;
            this.log(`codex erro no turno ${turnId ?? '?'}: ${truncate(msg, 240)}`);
            // Limite de uso ou modelo recusado: nada mais virá deste turno; não espera o task_complete nem os 600 s.
            if (classifyCodexError(msg, Date.now(), null)) failFromError(msg);
          }
          return;
        }
        if (method === 'codex/event/task_complete') {
          // O 0.58.0 não manda turn/completed depois de um erro: o task_complete encerra o turno.
          if (!turnId) return;
          const tid0 = turnId;
          setTimeout(() => {
            if (settled || completed) return;
            if (lastError) failFromError(lastError);
            else if (fullText().trim()) settleOrphan(outcome('done', null));
            else settleOrphan(outcome('failed', 'O Codex terminou o turno sem resposta.'));
            this.log(`codex turno ${tid0} encerrado pelo task_complete (sem turn/completed)`);
          }, 1500).unref();
          return;
        }
        if (method === 'item/agentMessage/delta') {
          const itemId = String(p.itemId ?? 'msg');
          if (!items.has(itemId)) { items.set(itemId, ''); order.push(itemId); }
          items.set(itemId, (items.get(itemId) ?? '') + String(p.delta ?? ''));
          try { req.onDelta?.(fullText()); } catch { /* o ouvinte não pode derrubar o turno */ }
        } else if (method === 'item/completed') {
          const item = p.item as { type?: string; id?: string; text?: string } | undefined;
          if (item?.type === 'agentMessage' && typeof item.text === 'string') {
            const itemId = String(item.id ?? 'msg');
            if (!items.has(itemId)) order.push(itemId);
            // O texto final do item é a verdade; os deltas só serviram para mostrar o parcial.
            if (item.text.length >= (items.get(itemId) ?? '').length) items.set(itemId, item.text);
            try { req.onDelta?.(fullText()); } catch { /* idem */ }
          }
        } else if (method === 'turn/completed') {
          const tc = params as TurnCompleted;
          if (!tc?.turn?.id || (turnId && tc.turn.id !== turnId)) return;
          completed = tc;
          if (turnId) finishFromTurn(tc.turn, tc.usage ?? null);
        }
      };
      const onExit = () => settle(outcome('failed', 'O Codex app-server encerrou no meio do turno.'));
      client.on('notification', onNotif);
      client.on('exit', onExit);
      const grace = this.opts.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
      // Encerramento por conta própria (sem turn/completed): o turno vira órfão e o que o Codex ainda mandar dele é ignorado.
      const settleOrphan = (o: TurnOutcome) => { if (settled) return; if (turnId) this.orphanTurns.add(turnId); settle(o); };
      ctl.onInterruptRequested = () => {
        // Se o Codex não responder ao turn/interrupt com turn/completed, encerra por conta própria.
        setTimeout(() => settleOrphan(outcome('interrupted', null)), grace).unref();
      };

      const turnParams = {
        threadId: tid,
        input: [{ type: 'text', text: req.text }],
        cwd: req.cwd,
        model: req.model,
        effort: req.effort,
        approvalPolicy: 'never',
        sandboxPolicy: { mode: 'readOnly' },
      };
      client.request<{ turn?: TurnInfo }>('turn/start', turnParams).then((r) => {
        const id = r?.turn?.id;
        if (!id) return settle(outcome('failed', 'O Codex não devolveu o id do turno em turn/start.'));
        if (settled) {
          // O turno já foi encerrado por aqui (interrupção sem resposta a tempo): vira órfão e é interrompido no Codex, sem armar timer.
          this.orphanTurns.add(id);
          client.request('turn/interrupt', { threadId: tid, turnId: id }, 10_000).catch(() => { /* ignorar */ });
          return;
        }
        turnId = id;
        ctl.live = { threadId: tid, turnId: id };
        this.log(`codex turno ${id} iniciado (reunião ${req.meetingId}, thread ${tid}, modelo ${req.model ?? 'padrão'}, esforço ${req.effort ?? 'padrão'})`);
        timer = setTimeout(() => {
          ctl.timedOut = true;
          this.log(`codex turno ${id} estourou ${timeoutMs} ms; interrompendo`);
          client.request('turn/interrupt', { threadId: tid, turnId: id }, 10_000).catch(() => { /* reportado abaixo */ });
          setTimeout(() => settleOrphan(outcome('failed', `${timeoutError} O Codex não confirmou a interrupção.`)), grace).unref();
        }, timeoutMs);
        const done = completed as TurnCompleted | null;
        if (done && done.turn.id === id) finishFromTurn(done.turn, done.usage ?? null);
        else if (ctl.interrupted) {
          // Interrupção pedida entre o envio e a resposta do turn/start.
          client.request('turn/interrupt', { threadId: tid, turnId: id }, 10_000).catch(() => { /* ignorar */ });
          ctl.onInterruptRequested?.();
        }
      }).catch((err: Error) => settle(outcome('failed', `Falha ao iniciar o turno no Codex: ${err.message}`)));
    });
    ctl.live = null;
    this.log(`codex turno ${turnId ?? '?'} terminou: ${result.status}${result.error ? ` (${truncate(result.error, 160)})` : ''} em ${result.durationMs} ms`);
    return result;
  }

  // ---------- teste de conexão ----------

  async test(model: string | null, effort: EffortLevel | null, cwd: string): Promise<AiTestResult> {
    const at = Date.now();
    const finish = (r: Omit<AiTestResult, 'at'>): AiTestResult => {
      const lastTest = { at, ...r };
      this.patch({ busy: false, lastTest });
      return lastTest;
    };
    this.patch({ busy: true });
    if (!this.st.models.length) {
      try { const c = await this.ensureClient(); await this.loadCatalog(c); } catch (err) { return finish({ ok: false, model, effort, resolvedModel: null, detail: (err as Error).message, durationMs: null }); }
    }
    const v = this.validate(model, effort);
    if (!v.ok) return finish({ ok: false, model, effort, resolvedModel: null, detail: v.reason, durationMs: null });
    let logged = false;
    try { logged = await this.readAccount(); } catch (err) { return finish({ ok: false, model, effort, resolvedModel: null, detail: `Não foi possível confirmar o login no Codex: ${(err as Error).message}`, durationMs: null }); }
    if (!logged) return finish({ ok: false, model, effort, resolvedModel: null, detail: NO_LOGIN_DETAIL, durationMs: null });
    const handle = this.startTurn({
      meetingId: 'teste', turnId: `teste-${at}`, participantId: 'teste', threadId: null, cwd,
      systemPrompt: 'Você está respondendo a um teste de conexão do My Company AI. Responda só com a palavra pedida.',
      text: TEST_PROMPT, title: 'Teste de conexão', model, effort, timeoutMs: 2 * 60_000,
    });
    const o = await handle.done;
    const ok = o.status === 'done';
    const detail = ok
      ? `Respondeu "${truncate(o.text.trim(), 60) || '(vazio)'}" em ${Math.round(o.durationMs / 100) / 10} s${o.usage?.outputTokens !== undefined ? ` (${o.usage.inputTokens ?? '?'} tokens de entrada, ${o.usage.outputTokens} de saída)` : ''}.`
      : (o.error ?? `Turno terminou com status "${o.status}".`);
    return finish({ ok, model, effort, resolvedModel: o.applied.resolvedModel, detail, durationMs: o.durationMs });
  }

  // ---------- login oficial ----------

  async startLogin(): Promise<{ url: string | null; detail: string }> {
    if (this.st.login?.inProgress && this.st.login.url) return { url: this.st.login.url, detail: this.st.login.detail ?? 'Login já em andamento.' };
    try {
      const client = await this.ensureClient();
      const r = await client.request<{ type?: string; loginId?: string; authUrl?: string }>('account/login/start', { type: 'chatgpt' });
      const url = typeof r?.authUrl === 'string' ? r.authUrl : null;
      this.loginId = typeof r?.loginId === 'string' ? r.loginId : null;
      const detail = url ? 'Abra a página de login do ChatGPT no navegador e conclua a autorização. A HQ atualiza sozinha quando o Codex confirmar.' : 'O Codex não devolveu a URL de login.';
      // Só a origem da URL vai para o log: o resto carrega o estado do fluxo OAuth.
      let origin = 'ausente';
      if (url) { try { origin = new URL(url).origin + '/…'; } catch { origin = truncate(url, 24); } }
      this.log(`codex login iniciado (url ${origin})`);
      this.patch({ login: { inProgress: Boolean(url), url, detail } });
      return { url, detail };
    } catch (err) {
      const detail = `Não foi possível iniciar o login no Codex: ${(err as Error).message}`;
      this.patch({ login: null, authState: 'error', authDetail: detail });
      return { url: null, detail };
    }
  }

  async cancelLogin(): Promise<void> {
    const loginId = this.loginId;
    this.loginId = null;
    this.patch({ login: null });
    if (!loginId || !this.client?.alive) return;
    try { await this.client.request('account/login/cancel', { loginId }, 10_000); }
    catch (err) { this.log(`codex login cancel falhou: ${truncate((err as Error).message, 160)}`); }
  }

  // ---------- encerramento ----------

  async shutdown(): Promise<void> {
    this.closed = true;
    const client = this.client ?? (this.starting ? await this.starting.catch(() => null) : null);
    this.client = null;
    if (client) await client.close();
    this.patch({ busy: false, login: null });
  }
}
