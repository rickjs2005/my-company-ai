// Registro dos provedores de IA: estado real de cada um, preferências globais (Configurações → Inteligência artificial),
// precedência participante > funcionário > padrão global > padrão do provedor, validação no servidor e as mensagens ai.*.
import type { AiClientMessage, AiConfigSource, AiProviderId, AiProviderPrefs, AiProviderStatus, AiTestResult, EffortLevel, ResolvedAiConfig, ServerMessage } from '@milweb-hq/protocol';
import { isEffortLevel } from '@milweb-hq/protocol';
import type { Store } from '../store.js';
import type { AiAdapter, ValidationResult } from './types.js';

/** Do mais específico ao mais amplo. */
const SOURCE_RANK: Record<AiConfigSource, number> = { meeting: 0, employee: 1, global: 2, provider: 3 };

export interface AiRegistryDeps {
  store: Store;
  adapters: AiAdapter[];
  broadcast(m: ServerMessage): void;
  /** Pasta usada como cwd nos testes de conexão. */
  testCwd: string;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}

export class AiRegistry {
  private readonly adapters = new Map<AiProviderId, AiAdapter>();
  private timer: NodeJS.Timeout | null = null;
  private readonly statusListeners: (() => void)[] = [];

  /** Avisa quando o estado de algum provedor muda (login, instalação, teste). A reunião usa para corrigir o estado dos participantes. */
  onStatus(fn: () => void): void { this.statusListeners.push(fn); }

  constructor(private readonly deps: AiRegistryDeps) {
    for (const a of deps.adapters) {
      this.adapters.set(a.provider, a);
      a.on('status', () => this.scheduleBroadcast());
    }
  }

  get(provider: AiProviderId): AiAdapter {
    const a = this.adapters.get(provider);
    if (!a) throw new Error(`provedor desconhecido: ${provider}`);
    return a;
  }
  has(provider: string): provider is AiProviderId { return this.adapters.has(provider as AiProviderId); }

  /** Padrão global do provedor. Para o Claude, o modelo padrão antigo (Configurações → Geral) continua valendo como fallback. */
  globalPrefs(provider: AiProviderId): AiProviderPrefs {
    const s = this.deps.store.getSettings();
    const p = s.ai?.[provider] ?? { model: null, effort: null };
    const model = p.model ?? (provider === 'claude' ? s.defaultModel ?? null : null);
    return { model, effort: isEffortLevel(p.effort) ? p.effort : null };
  }

  statusOf(provider: AiProviderId): AiProviderStatus {
    return { ...this.get(provider).status(), prefs: this.globalPrefs(provider) };
  }
  statuses(): AiProviderStatus[] { return [...this.adapters.keys()].map(p => this.statusOf(p)); }

  /** Precedência: participante (quando personalizado) > funcionário > padrão global > padrão do provedor (null). */
  resolve(provider: AiProviderId, participant: { model: string | null; effort: EffortLevel | null; useGlobal: boolean } | null, employee: { model: string | null; effort: EffortLevel | null } | null): ResolvedAiConfig {
    const g = this.globalPrefs(provider);
    const pick = (key: 'model' | 'effort'): { value: string | null; source: ResolvedAiConfig['modelSource'] } => {
      if (participant && !participant.useGlobal && participant[key] != null) return { value: participant[key], source: 'meeting' };
      if (employee && employee[key] != null && provider === 'claude') return { value: employee[key], source: 'employee' };
      if (g[key] != null) return { value: g[key], source: 'global' };
      return { value: null, source: 'provider' };
    };
    const m = pick('model');
    const e = pick('effort');
    let effort = e.value as EffortLevel | null;
    let effortSource = e.source;
    // Esforço herdado de um nível mais amplo que o do modelo (ex.: modelo do participante, esforço global): só vale se o modelo
    // escolhido o aceitar; senão fica o padrão do provedor. Quem escolheu o modelo deixou o esforço em "padrão", e é isso que vale.
    // Escolha explícita no mesmo nível nunca é corrigida em silêncio: a validação recusa e diz o motivo.
    if (effort && m.value && SOURCE_RANK[e.source] > SOURCE_RANK[m.source]) {
      const entry = this.get(provider).status().models.find(x => x.id === m.value);
      if (entry && !entry.efforts.includes(effort)) { effort = null; effortSource = 'provider'; }
    }
    return { model: m.value, effort, modelSource: m.source, effortSource };
  }

  validate(provider: AiProviderId, model: string | null, effort: EffortLevel | null): ValidationResult {
    return this.get(provider).validate(model, effort);
  }

  async refresh(provider: AiProviderId): Promise<AiProviderStatus> { await this.get(provider).refresh(); return this.statusOf(provider); }
  async refreshAll(): Promise<void> { await Promise.all([...this.adapters.values()].map(a => a.refresh().catch(err => this.deps.log?.warn(`refresh de ${a.provider} falhou`, err)))); }

  async test(provider: AiProviderId, model: string | null, effort: EffortLevel | null): Promise<AiTestResult> {
    return this.get(provider).test(model, effort, this.deps.testCwd);
  }

  async startLogin(provider: AiProviderId): Promise<{ url: string | null; detail: string }> {
    const a = this.get(provider);
    if (!a.startLogin) return { url: null, detail: provider === 'claude' ? 'O login do Claude Code é feito no terminal: rode `claude` e use /login.' : 'este provedor não tem fluxo de login pela HQ' };
    return a.startLogin();
  }
  async cancelLogin(provider: AiProviderId): Promise<void> { await this.get(provider).cancelLogin?.(); }

  /** Chamado pelo ws.ts depois de settings.update: as preferências globais mudaram. */
  onSettingsChanged(): void { this.scheduleBroadcast(); }

  async handle(msg: AiClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'ai.status': return this.statuses();
      case 'ai.refresh': { if (!this.has(msg.provider)) throw new Error('provedor desconhecido'); return this.refresh(msg.provider); }
      case 'ai.test': {
        if (!this.has(msg.provider)) throw new Error('provedor desconhecido');
        if (msg.effort !== null && !isEffortLevel(msg.effort)) throw new Error('nível de esforço inválido');
        return this.test(msg.provider, msg.model, msg.effort);
      }
      case 'ai.login.start': { if (!this.has(msg.provider)) throw new Error('provedor desconhecido'); return this.startLogin(msg.provider); }
      case 'ai.login.cancel': { if (!this.has(msg.provider)) throw new Error('provedor desconhecido'); await this.cancelLogin(msg.provider); return undefined; }
      default: throw new Error(`operação desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  private closed = false;
  async shutdown(): Promise<void> {
    this.closed = true; // o encerramento dos adaptadores muda o estado deles: nenhum aviso novo depois disso (o banco fecha em seguida)
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await Promise.all([...this.adapters.values()].map(a => a.shutdown().catch(() => { /* ignorar */ })));
  }

  private scheduleBroadcast() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deps.broadcast({ kind: 'ai.status', providers: this.statuses() });
      for (const fn of this.statusListeners) { try { fn(); } catch { /* um ouvinte não derruba os outros */ } }
    }, 50);
    this.timer.unref?.();
  }
}
