// Adaptador do Claude para a sala de reunião: cada participante Claude é uma sessão REAL do Claude Code instalado
// (mesma autenticação da assinatura, nenhuma chave de API). Modo análise: o processo nasce com --tools Read,Glob,Grep e
// todo pedido de permissão é negado; a reunião nunca altera arquivos. Entre turnos o processo é encerrado (memória) e o
// próximo turno retoma a mesma sessão com --resume, para o histórico da conversa seguir no provedor.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ClaudeProcess } from '@milweb-hq/claude-bridge';
import type { InitInfo, RawEvent, ResultInfo } from '@milweb-hq/claude-bridge';
import type { AiModelOption, AiProviderStatus, AiTestResult, EffortLevel } from '@milweb-hq/protocol';
import { childEnv, probeClaude, type ClaudeInfo } from '../../claude-info.js';
import { TEST_PROMPT, type AiAdapter, type AiAdapterEvents, type ProviderTurnStop, type TurnHandle, type TurnOutcome, type TurnRequest, type ValidationResult } from '../types.js';
import { classifyProviderStop } from '../../provider-stop.js';
import { CLAUDE_CATALOG_AT, CLAUDE_CATALOG_CLI_VERSION, CLAUDE_CATALOG_SOURCE, CLAUDE_COMMON_EFFORTS, claudeEntry, claudeModelOptions, effortsForCaps, resolveClaudeModel } from './catalog.js';

export interface ClaudeAdapterOptions {
  /** Sobrescrita do executável (MILWEB_HQ_CLAUDE_PATH). */
  exeOverride?: string;
  /** Testes: node + CLI falso. */
  commandPrefixArgs?: string[];
  extraArgs?: string[];
  env?: () => NodeJS.ProcessEnv;
  /** Resultado da inspeção já feita pelo main.ts (evita rodar `claude auth status` duas vezes na partida). */
  seed?: ClaudeInfo;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void; debug(...a: unknown[]): void };
  /** Ferramentas liberadas nos turnos de reunião (modo análise). */
  tools?: string[];
}

export const MEETING_TOOLS = ['Read', 'Glob', 'Grep'];
// Turno de reunião isolado do ambiente do Claude Code do Chefe: nenhum servidor MCP (conectores do claude.ai, MCPs locais) e modo
// de permissão padrão fixo, para todo pedido de permissão cair no adaptador (que nega). Medido em 31/10/2026 com o CLI 2.1.316: sem
// isso, um turno que só respondia "ok" carregava 551 ferramentas MCP de 24 servidores e cerca de 470 mil tokens de entrada (19,8 s);
// isolado, 3 ferramentas e cerca de 8,4 mil tokens (6,2 s). Os funcionários (sessões de trabalho) continuam com o ambiente completo.
export const MEETING_ISOLATION_ARGS = ['--strict-mcp-config'];
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
// Texto do CLI 2.1.316 para `--resume` de sessão inexistente (vem em result.errors e no stderr).
const LOST_SESSION_RE = /No conversation found with session ID/i;

interface Live { proc: ClaudeProcess; threadId: string }

export class ClaudeAdapter extends EventEmitter<AiAdapterEvents> implements AiAdapter {
  readonly provider = 'claude' as const;
  private info: ClaudeInfo | null;
  private checkedAt: number | null;
  private busy = false;
  private lastTest: AiTestResult | null = null;
  /** Fechamentos de processo ainda em curso (o turno já foi resolvido, o CLI ainda está saindo); shutdown espera por eles. */
  private pendingCloses = new Set<Promise<unknown>>();
  private readonly live = new Map<string, Live>();
  private closing = false;

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {
    super();
    this.info = opts.seed ?? null;
    this.checkedAt = opts.seed ? Date.now() : null;
  }

  /** O main.ts chama quando a inspeção inicial termina (mesma informação do serverInfo). */
  seed(info: ClaudeInfo): void { this.info = info; this.checkedAt = Date.now(); this.emitStatus(); }

  models(): AiModelOption[] { return claudeModelOptions(); }

  status(): AiProviderStatus {
    const i = this.info;
    const version = i?.version?.trim() || null;
    const versionNumber = version?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
    const stale = versionNumber && versionNumber !== CLAUDE_CATALOG_CLI_VERSION;
    const authState: AiProviderStatus['authState'] = !i ? 'unknown' : !i.exePath ? 'missing' : i.authOk === true ? 'ok' : i.authOk === false ? 'missing' : 'error';
    return {
      provider: 'claude', label: 'Claude', routeLabel: 'via Claude Code (CLI instalado, login da assinatura claude.ai)',
      installed: Boolean(i?.exePath), exePath: i?.exePath ?? null, version, latestKnownVersion: null,
      authState,
      authMethod: i?.authOk ? (i.authDetail ?? 'logado') : null,
      authDetail: !i ? 'ainda não verificado' : !i.exePath ? (i.authDetail ?? 'Claude Code não encontrado') : i.authOk ? null : (i.authDetail ?? 'Claude Code sem login: rode `claude` no terminal e faça /login'),
      models: this.models(),
      catalogSource: CLAUDE_CATALOG_SOURCE + (stale ? ` · a versão instalada (${versionNumber}) é outra: a lista pode estar desatualizada; o teste de conexão mostra o modelo real` : ''),
      catalogAt: CLAUDE_CATALOG_AT, checkedAt: this.checkedAt, busy: this.busy, lastTest: this.lastTest, login: null,
      prefs: { model: null, effort: null },
    };
  }

  async refresh(): Promise<AiProviderStatus> {
    this.busy = true; this.emitStatus();
    try {
      this.info = await probeClaude(this.opts.exeOverride);
    } catch (err) {
      this.info = { exePath: this.info?.exePath ?? null, version: this.info?.version ?? null, authOk: null, authDetail: `falha ao inspecionar o Claude Code: ${(err as Error).message}`, apiKeyInEnv: false };
    } finally {
      this.checkedAt = Date.now(); this.busy = false; this.emitStatus();
    }
    return this.status();
  }

  validate(model: string | null, effort: EffortLevel | null): ValidationResult {
    if (model) {
      const entry = claudeEntry(model);
      if (!entry) return { ok: false, reason: `o modelo "${model}" não está no catálogo verificado do Claude Code (${CLAUDE_CATALOG_SOURCE}); escolha outro modelo`, model, effort, alternatives: [] };
      const efforts = effortsForCaps(entry.caps);
      if (effort && !efforts.includes(effort)) {
        const reason = efforts.length ? `o modelo ${entry.label} aceita só os níveis: ${efforts.join(', ')} (pedido: ${effort})` : `o modelo ${entry.label} não tem controle de esforço no Claude Code; deixe o esforço em "padrão"`;
        return { ok: false, reason, model, effort, alternatives: efforts };
      }
      const alias = resolveClaudeModel(model) !== model ? `alias do CLI: ${model} → ${resolveClaudeModel(model)}` : null;
      return { ok: true, model, effort, note: alias };
    }
    if (effort && !CLAUDE_COMMON_EFFORTS.includes(effort)) {
      return { ok: false, reason: `sem modelo escolhido o esforço só pode ser ${CLAUDE_COMMON_EFFORTS.join(', ')} (o modelo padrão do CLI não é conhecido aqui); escolha um modelo para usar ${effort}`, model, effort, alternatives: CLAUDE_COMMON_EFFORTS };
    }
    return { ok: true, model, effort, note: null };
  }

  startTurn(req: TurnRequest): TurnHandle {
    const started = Date.now();
    const threadId = req.threadId ?? randomUUID();
    const fail = (error: string): TurnHandle => ({ done: Promise.resolve({ status: 'failed', text: '', threadId: req.threadId, applied: { model: req.model, effort: req.effort, resolvedModel: null }, error, durationMs: Date.now() - started, usage: null }), interrupt: async () => undefined });
    const st = this.status();
    if (!st.installed) return fail('Claude Code não encontrado nesta máquina');
    if (st.authState === 'missing') return fail(st.authDetail ?? 'Claude Code sem login');
    const v = this.validate(req.model, req.effort);
    if (!v.ok) return fail(v.reason);
    if (this.closing) return fail('o serviço está encerrando');

    const exe = this.info!.exePath!;
    const resume = Boolean(req.threadId);
    const lostSessionError = () => `a sessão anterior do Claude Code (${threadId.slice(0, 8)}…) não existe mais: o histórico foi apagado ou a pasta do projeto mudou. O próximo turno começa uma sessão nova, sem a memória das falas anteriores.`;
    const proc = new ClaudeProcess({
      exePath: exe, commandPrefixArgs: this.opts.commandPrefixArgs, cwd: req.cwd,
      model: req.model ?? undefined, effort: req.effort ?? undefined, tools: this.opts.tools ?? MEETING_TOOLS,
      resume: resume ? threadId : undefined, sessionId: resume ? undefined : threadId, sessionName: resume ? undefined : req.title,
      appendSystemPrompt: req.systemPrompt, includePartialMessages: true, permissionMode: 'default', extraArgs: [...MEETING_ISOLATION_ARGS, ...(this.opts.extraArgs ?? [])], env: (this.opts.env ?? childEnv)(),
    });
    const prev = this.live.get(threadId);
    if (prev?.proc.alive) this.closeLater(prev.proc, 2000);
    this.live.set(threadId, { proc, threadId });

    const parts: string[] = [];
    let stream = '';
    let resolvedModel: string | null = null;
    let settled = false;
    let interruptRequested = false;
    let timedOut = false;
    let sessionSeen = false; // o CLI confirmou a sessão (evento init)
    let usage: TurnOutcome['usage'] = null;
    /** Limite de uso visto neste turno (rate_limit_event) e o campo `error` do assistente ('rate_limit', 'server_error'...). */
    let rateLimit: { status?: string; resetsAt?: number; type?: string } | null = null;
    let apiError: string | null = null;
    /**
     * Limite de uso: o turno falhou pelo limite, ou o CLI avisou "rejected" e continuou trocando de modelo. Nos dois casos o Chefe
     * pediu (02/11/2026) que o participante saia da reunião e só volte quando ele chamar.
     */
    const stopFor = (r: ResultInfo | null): ProviderTurnStop | null => {
      const now = Date.now();
      const rejected = rateLimit?.status === 'rejected' && typeof rateLimit.resetsAt === 'number' && rateLimit.resetsAt * 1000 > now;
      const errText = `${r?.resultText ?? ''} ${(r?.errors ?? []).join(' ')}`;
      if (r?.isError && (apiError === 'authentication_failed' || /invalid api key|please run \/login|oauth token (has )?expired|authentication_error|not logged in/i.test(errText))) return { kind: 'auth', until: null, reason: 'login do Claude Code perdido: entre de novo (claude /login) e teste em Ajustes → Inteligência artificial' };
      const c = classifyProviderStop({ isError: r ? r.isError || rejected : rejected, terminalReason: r?.terminalReason ?? null, resultText: r?.resultText ?? '', errors: r?.errors ?? [], apiError, rateLimit, now });
      if (c?.kind !== 'usage_limit') return null;
      const informed = rejected || /resets\s+\d/i.test(errText);
      return { kind: 'usage_limit', until: c.until, untilInformed: informed, reason: r && !r.isError ? `${c.label} do Claude esgotado (o Claude Code trocou de modelo para continuar)` : `${c.label} do Claude esgotado` };
    };
    const text = () => (parts.join('\n\n') + (stream ? (parts.length ? '\n\n' : '') + stream : '')).trim();
    const emitDelta = () => { try { req.onDelta?.(text()); } catch (err) { this.opts.log?.warn('onDelta falhou', err); } };

    let resolveDone!: (o: TurnOutcome) => void;
    const done = new Promise<TurnOutcome>(r => { resolveDone = r; });
    // Sessão devolvida: a retomada mantém o id; uma sessão nova só devolve o id depois que o CLI a confirmou (init), senão um id
    // que nunca existiu viraria --resume no turno seguinte. nextThreadId null = a sessão retomada não existe mais (o coordenador zera).
    const finish = (status: TurnOutcome['status'], error: string | null, final?: string, nextThreadId?: string | null, stop: ProviderTurnStop | null = null) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      this.live.delete(threadId);
      if (proc.alive) this.closeLater(proc, 3000);
      const outThreadId = nextThreadId !== undefined ? nextThreadId : (resume || sessionSeen ? threadId : req.threadId);
      resolveDone({ status, text: (final ?? text()), threadId: outThreadId, applied: { model: req.model, effort: req.effort, resolvedModel }, error, durationMs: Date.now() - started, usage, stop });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      this.opts.log?.warn(`turno do Claude estourou o tempo (${Math.round((req.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) / 1000)} s); interrompendo`);
      proc.interrupt().catch(() => { /* ignorar */ });
      setTimeout(() => finish('failed', `tempo esgotado após ${Math.round((req.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) / 60_000)} min; a resposta parcial foi mantida`), 5000).unref();
    }, req.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    timer.unref?.();

    proc.on('init', (info: InitInfo) => { sessionSeen = true; resolvedModel = info.model || null; });
    proc.on('raw', (ev: RawEvent) => {
      if (ev.type === 'rate_limit_event') {
        const info = ev.rate_limit_info as { status?: string; rateLimitType?: string; resetsAt?: number; unifiedWindows?: Record<string, { resetsAt?: number }> } | undefined;
        if (info) rateLimit = { status: info.status, type: info.rateLimitType, resetsAt: (info.rateLimitType ? info.unifiedWindows?.[info.rateLimitType]?.resetsAt : undefined) ?? info.resetsAt };
        return;
      }
      if (ev.type === 'assistant' && typeof ev.error === 'string') apiError = ev.error;
      if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
        const e = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') { stream += e.delta.text; emitDelta(); }
      } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
        const blocks = ((ev.message as { content?: Record<string, unknown>[] })?.content) ?? [];
        let pushed = false;
        for (const b of blocks) if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) { parts.push(b.text.trim()); pushed = true; }
        if (pushed) { stream = ''; emitDelta(); }
      }
    });
    // Modo análise: nenhuma ferramenta que altere algo é aprovada. (Read/Glob/Grep não pedem permissão.)
    proc.on('permission_request', r => { try { proc.respondPermission(r.requestId, { behavior: 'deny', message: 'Reunião do My Company AI em modo análise: nenhuma ação é executada aqui. Responda só com texto.' }); } catch { /* ignorar */ } });
    proc.on('result', (r: ResultInfo) => {
      // Tokens de entrada = diretos + cache criado + cache lido (o CLI separa os três; só o primeiro seria enganoso: quase tudo vai pelo cache).
      const u = r.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
      const inputTotal = typeof u?.input_tokens === 'number' ? u.input_tokens + (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0) + (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0) : undefined;
      if (u && (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number') || typeof r.totalCostUsd === 'number') {
        usage = { ...(typeof inputTotal === 'number' ? { inputTokens: inputTotal } : {}), ...(typeof u?.output_tokens === 'number' ? { outputTokens: u.output_tokens } : {}), ...(typeof r.totalCostUsd === 'number' ? { costUsd: r.totalCostUsd } : {}) };
      }
      const aborted = r.terminalReason === 'aborted_streaming' || r.terminalReason === 'aborted_tools';
      const finalText = parts.length ? parts.join('\n\n') : (r.resultText || stream).trim();
      if (timedOut) finish('failed', `tempo esgotado; resposta parcial mantida`, finalText);
      else if (aborted || interruptRequested) finish('interrupted', null, finalText);
      else if (resume && r.isError && r.errors.some(e => LOST_SESSION_RE.test(e))) finish('failed', lostSessionError(), finalText, null);
      else if (r.isError) { const stop = stopFor(r); finish('failed', stop ? `${stop.reason}: ${(r.resultText || r.errors.join(' ')).slice(0, 200)}` : (r.errors.join('\n') || `o Claude Code terminou com erro (${r.subtype})`), finalText, undefined, stop); }
      else finish('done', null, finalText, undefined, stopFor(r));
    });
    proc.on('spawn_error', err => finish('failed', `não foi possível iniciar o Claude Code: ${err.message}`));
    proc.on('exit', info => {
      if (settled) return;
      if (resume && LOST_SESSION_RE.test(proc.stderrTail)) return finish('failed', lostSessionError(), undefined, null);
      finish('failed', `o processo do Claude Code encerrou sem resultado (código ${info.code ?? '?'})${proc.stderrTail.trim() ? ': ' + proc.stderrTail.trim().slice(-300) : ''}`);
    });
    proc.on('stderr', t => { if (t.trim()) this.opts.log?.debug(`[claude reunião ${threadId.slice(0, 8)}] ${t.trim().slice(0, 300)}`); });

    proc.start();
    proc.sendUser(req.text);
    this.opts.log?.info(`turno do Claude iniciado (sessão ${threadId.slice(0, 8)}, ${resume ? 'resume' : 'nova'}, modelo ${req.model ?? 'padrão'}, esforço ${req.effort ?? 'padrão'}, ${req.text.length} caracteres)`);

    return {
      done,
      interrupt: async () => {
        if (settled) return;
        interruptRequested = true;
        // O prazo corre desde já: se o CLI não confirmar, o turno encerra com o parcial e finish() fecha o processo.
        setTimeout(() => finish('interrupted', null), 8000).unref();
        try { await proc.request({ subtype: 'interrupt' }, 5000); } catch (err) { this.opts.log?.warn('interrupt sem resposta de controle; o turno encerra com a resposta parcial', err); }
      },
    };
  }

  async test(model: string | null, effort: EffortLevel | null, cwd: string): Promise<AiTestResult> {
    const at = Date.now();
    const st = this.status();
    const v = this.validate(model, effort);
    const record = (r: Omit<AiTestResult, 'at' | 'model' | 'effort'>) => { this.lastTest = { at, model, effort, ...r }; this.emitStatus(); return this.lastTest; };
    if (!v.ok) return record({ ok: false, resolvedModel: null, detail: v.reason, durationMs: null });
    if (!st.installed || st.authState === 'missing') return record({ ok: false, resolvedModel: null, detail: st.authDetail ?? 'Claude Code indisponível', durationMs: null });
    this.busy = true; this.emitStatus();
    try {
      const handle = this.startTurn({
        meetingId: 'test', turnId: 'test', participantId: 'test', threadId: null, cwd, title: 'Teste de conexão (My Company AI)',
        systemPrompt: 'Teste de conexão do My Company AI. Responda somente "ok".', text: TEST_PROMPT, model, effort, timeoutMs: 120_000,
      });
      const o = await handle.done;
      return record({ ok: o.status === 'done', resolvedModel: o.applied.resolvedModel, detail: o.status === 'done' ? `respondeu: ${o.text.slice(0, 80) || '(vazio)'}` : (o.error ?? 'falhou'), durationMs: o.durationMs });
    } finally { this.busy = false; this.emitStatus(); }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const l of this.live.values()) this.closeLater(l.proc, 3000);
    this.live.clear();
    await Promise.all([...this.pendingCloses]);
  }

  /** Fecha o processo sem bloquear quem chamou; o fechamento fica registrado para o shutdown esperar o CLI sair de verdade. */
  private closeLater(proc: ClaudeProcess, graceMs: number): void {
    const p: Promise<unknown> = proc.close(graceMs).catch(() => { /* ignorar */ }).finally(() => { this.pendingCloses.delete(p); });
    this.pendingCloses.add(p);
  }

  private emitStatus() { this.emit('status', this.status()); }
}
