// Provedores de IA da sala de reunião (v3): Claude via Claude Code instalado e ChatGPT via Codex app-server local.
// Tudo aqui é estado REAL verificado pelo servidor (instalação, login sem credenciais, catálogo de modelos com origem e data).

export type AiProviderId = 'claude' | 'openai';

/** União dos níveis de esforço dos dois provedores; cada modelo lista só os que realmente aceita. */
export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_ORDER: EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo',
};
export function isEffortLevel(v: unknown): v is EffortLevel { return typeof v === 'string' && (EFFORT_ORDER as string[]).includes(v); }

export interface AiModelOption {
  /** Id real enviado ao provedor (ex.: 'claude-opus-5-5', 'gpt-5.1-codex') ou alias que o CLI resolve ('fable'). */
  id: string;
  label: string;
  /** Níveis realmente suportados por este modelo (vazio = o provedor não aceita controle de esforço para ele). */
  efforts: EffortLevel[];
  defaultEffort: EffortLevel | null;
  /** Padrão do provedor quando nenhum modelo é escolhido. */
  isDefault?: boolean;
  /** Alias do CLI: quem resolve é o próprio CLI; `resolvesTo` é o id que o binário instalado mapeia. */
  alias?: boolean;
  resolvesTo?: string | null;
  recommended?: boolean;
  /** Observação curta mostrada na interface (ex.: 'legado, sem controle de esforço'). */
  note?: string | null;
}

export type AiAuthState = 'ok' | 'missing' | 'unknown' | 'error';

export interface AiTestResult {
  at: number;
  ok: boolean;
  model: string | null;
  effort: EffortLevel | null;
  /** Modelo que o provedor informou ter usado de fato (ex.: system/init do Claude Code). */
  resolvedModel: string | null;
  detail: string;
  durationMs: number | null;
}

export interface AiProviderPrefs { model: string | null; effort: EffortLevel | null }

export interface AiProviderStatus {
  provider: AiProviderId;
  /** Nome mostrado ao Chefe: 'Claude' | 'ChatGPT'. */
  label: string;
  /** Rota efetiva em uso, sem rodeios (ex.: 'via Codex (app-server local, conta ChatGPT)'). */
  routeLabel: string;
  installed: boolean;
  exePath: string | null;
  version: string | null;
  /** Versão mais nova conhecida na data do catálogo (só informativo; a HQ nunca atualiza nada sozinha). */
  latestKnownVersion: string | null;
  authState: AiAuthState;
  /** Método de autenticação sem nenhuma credencial (ex.: 'claude.ai · max', 'ChatGPT · plus', 'chave de API'). */
  authMethod: string | null;
  /** Orientação quando falta login ou houve erro. */
  authDetail: string | null;
  models: AiModelOption[];
  /** De onde a lista veio e quando (ex.: 'model/list do Codex 0.58.0', 'binário do Claude Code 2.1.314'). */
  catalogSource: string;
  catalogAt: number | null;
  checkedAt: number | null;
  /** true enquanto atualiza opções ou testa a conexão. */
  busy: boolean;
  lastTest: AiTestResult | null;
  /** Fluxo de login oficial em andamento (só o Codex expõe isto). */
  login: { inProgress: boolean; url: string | null; detail: string | null } | null;
  /** Padrão global em vigor (Configurações → Inteligência artificial). */
  prefs: AiProviderPrefs;
}

export interface AiSettings { claude: AiProviderPrefs; openai: AiProviderPrefs }
export const DEFAULT_AI_SETTINGS: AiSettings = { claude: { model: null, effort: null }, openai: { model: null, effort: null } };

/** Precedência de modelo/esforço: participante na reunião > funcionário > padrão global > padrão do provedor. */
export type AiConfigSource = 'meeting' | 'employee' | 'global' | 'provider';
export interface ResolvedAiConfig {
  model: string | null;
  effort: EffortLevel | null;
  modelSource: AiConfigSource;
  effortSource: AiConfigSource;
}

export type AiClientMessage =
  | { type: 'ai.status'; reqId: string }
  /** Redescobre instalação, login e modelos com chamadas reais ao provedor (nunca a cada clique de seletor). */
  | { type: 'ai.refresh'; reqId: string; provider: AiProviderId }
  /** Turno real de teste (o provedor é avisado de que é um teste). */
  | { type: 'ai.test'; reqId: string; provider: AiProviderId; model: string | null; effort: EffortLevel | null }
  /** Fluxo de login oficial do provedor (Codex: abre a URL de login no navegador). */
  | { type: 'ai.login.start'; reqId: string; provider: AiProviderId }
  | { type: 'ai.login.cancel'; provider: AiProviderId };

export type AiServerMessage = { kind: 'ai.status'; providers: AiProviderStatus[] };
