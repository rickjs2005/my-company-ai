// Helpers puros da aba "Conexões" (Configurações: serviço da HQ, Claude Code, OpenAI/Codex) e do campo de esforço do funcionário.
// Sem React e sem DOM, para rodarem em Node (web/test/settings.test.ts). Nada aqui inventa estado: quando o catálogo
// não traz a informação, as funções devolvem vazio/null e a interface diz que não sabe.

import type { AiAuthState, AiModelOption, AiProviderId, AiProviderStatus, AiSettings, EffortLevel, ServiceStatus } from '@milweb-hq/protocol';
import { EFFORT_LABELS, EFFORT_ORDER } from '@milweb-hq/protocol';

/** Ordem fixa de exibição dos provedores. */
export const PROVIDER_ORDER: AiProviderId[] = ['claude', 'openai'];

/** Rótulo de exibição por provedor (o status traz `label`; este é o fallback quando o status ainda não chegou). */
export const PROVIDER_LABELS: Record<AiProviderId, string> = { claude: 'Claude', openai: 'ChatGPT' };

type StatusLike = Pick<AiProviderStatus, 'models'> | null | undefined;

/** Ordena níveis pela escala oficial (none → max), sem duplicatas. */
export function sortEfforts(efforts: readonly EffortLevel[]): EffortLevel[] {
  const set = new Set(efforts);
  return EFFORT_ORDER.filter(e => set.has(e));
}

/** Modelo do catálogo pelo id real ou pelo alias. null = não está no catálogo (ou não há catálogo). */
export function findModel(status: StatusLike, modelId: string | null | undefined): AiModelOption | null {
  if (!status || !modelId) return null;
  return status.models.find(m => m.id === modelId) ?? null;
}

/**
 * Níveis comuns do provedor: interseção dos efforts de todos os modelos que aceitam esforço.
 * Vazio quando nenhum modelo aceita esforço ou quando não há catálogo.
 */
export function commonEfforts(status: StatusLike): EffortLevel[] {
  if (!status) return [];
  const withEffort = status.models.filter(m => m.efforts.length > 0);
  if (withEffort.length === 0) return [];
  let acc = new Set<EffortLevel>(withEffort[0].efforts);
  for (const m of withEffort.slice(1)) acc = new Set(m.efforts.filter(e => acc.has(e)));
  return sortEfforts([...acc]);
}

/**
 * Níveis aceitos pelo modelo escolhido. Sem modelo (null) = níveis comuns do provedor.
 * Modelo fora do catálogo = vazio (não sabemos; use `findModel` para distinguir de "modelo sem esforço").
 */
export function effortsForModel(status: StatusLike, modelId: string | null | undefined): EffortLevel[] {
  if (!modelId) return commonEfforts(status);
  const model = findModel(status, modelId);
  return model ? sortEfforts(model.efforts) : [];
}

/**
 * true quando o esforço salvo não existe para o modelo escolhido (ou o modelo não aceita esforço).
 * Esforço null nunca é indisponível ("usar padrão"). Modelo fora do catálogo ou sem catálogo = não dá para afirmar → false.
 */
export function isEffortUnavailable(status: StatusLike, modelId: string | null | undefined, effort: EffortLevel | null | undefined): boolean {
  if (!effort || !status) return false;
  if (modelId && !findModel(status, modelId)) return false;
  if (!modelId && status.models.length === 0) return false;
  return !effortsForModel(status, modelId).includes(effort);
}

export function effortLabel(effort: EffortLevel | null | undefined): string {
  return effort ? EFFORT_LABELS[effort] ?? effort : 'Padrão';
}

/** Opções do catálogo para o seletor: recomendados primeiro (ordem estável dentro de cada grupo). */
export function sortedModelOptions(status: StatusLike): AiModelOption[] {
  if (!status) return [];
  const rec = status.models.filter(m => m.recommended);
  const rest = status.models.filter(m => !m.recommended);
  return [...rec, ...rest];
}

/** Texto da opção no <select>: "Rótulo · id" (alias: "Rótulo · alias do CLI → id"), com a nota quando houver. */
export function modelOptionText(m: AiModelOption): string {
  const idPart = m.alias ? `alias do CLI${m.resolvesTo ? ` → ${m.resolvesTo}` : ''}` : m.id;
  const parts = [m.label];
  if (m.label !== m.id) parts.push(idPart);
  else if (m.alias) parts.push(idPart);
  if (m.isDefault) parts.push('padrão do provedor');
  if (m.recommended) parts.push('recomendado');
  if (m.note) parts.push(m.note);
  return parts.join(' · ');
}

/** Comparação semver simples (x.y.z, prefixo "v" ignorado, sufixo de pré-release ignorado). true só quando latest > installed. */
export function isNewerVersion(installed: string | null | undefined, latest: string | null | undefined): boolean {
  const a = parseVersion(installed);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

function parseVersion(v: string | null | undefined): number[] | null {
  if (!v) return null;
  const m = v.trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)/);
  if (!m) return null;
  return m[1].split('.').map(Number);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Data e hora locais do catálogo: "31/10/2026 às 03:12". Sem data válida = "sem data". */
export function formatCatalogAt(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts) || ts < 1e9) return 'sem data';
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} às ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Hora local curta (HH:MM) para "verificado às…". */
export function formatTimeOfDay(ts: number | null | undefined): string | null {
  if (ts == null || !Number.isFinite(ts) || ts < 1e9) return null;
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "verificado às 03:12" ou "ainda não verificado". */
export function checkedAtText(ts: number | null | undefined): string {
  const t = formatTimeOfDay(ts);
  return t ? `verificado às ${t}` : 'ainda não verificado';
}

/** Mascara todo e-mail dentro de um texto: "maria.silva@gmail.com" → "ma…@gmail.com". Nunca mostramos o e-mail inteiro. */
export function maskEmail(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (_all, local: string, domain: string) => {
    const keep = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
    return `${keep}…@${domain}`;
  });
}

export type AuthTone = 'ok' | 'danger' | 'muted' | 'warn';

export const AUTH_TONES: Record<AiAuthState, AuthTone> = { ok: 'ok', missing: 'danger', unknown: 'muted', error: 'warn' };

/** Rótulo curto do login, sem credenciais (authMethod passa por maskEmail). */
export function authStateLabel(status: Pick<AiProviderStatus, 'authState' | 'authMethod'>): string {
  switch (status.authState) {
    case 'ok': return status.authMethod ? `login ok · ${maskEmail(status.authMethod)}` : 'login ok';
    case 'missing': return 'sem login';
    case 'error': return 'erro ao verificar o login';
    default: return 'não verificado';
  }
}

/** Problemas que impedem salvar a aba de IA (esforço salvo indisponível para o modelo escolhido). */
export function aiSettingsProblems(providers: readonly AiProviderStatus[] | null | undefined, draft: AiSettings): string[] {
  const out: string[] = [];
  for (const id of PROVIDER_ORDER) {
    const status = providers?.find(p => p.provider === id) ?? null;
    const prefs = draft[id];
    if (isEffortUnavailable(status, prefs.model, prefs.effort)) {
      out.push(`${status?.label ?? PROVIDER_LABELS[id]}: o esforço "${effortLabel(prefs.effort)}" não existe para o modelo escolhido.`);
    }
  }
  return out;
}

export function sameAiSettings(a: AiSettings, b: AiSettings): boolean {
  return PROVIDER_ORDER.every(id => a[id].model === b[id].model && a[id].effort === b[id].effort);
}

// ---------------- Cartões da aba "Conexões": título, passos e serviço ----------------

/** Tom visual compartilhado por selos e notas (mesmas cores de AUTH_TONES). */
export type Tone = 'ok' | 'warn' | 'danger' | 'muted';

/**
 * Título do cartão do provedor. Para o OpenAI, "conectado com ChatGPT" só aparece quando o servidor confirmou o login;
 * antes disso o título diz apenas por onde a conexão passa.
 */
export function providerTitle(status: Pick<AiProviderStatus, 'provider' | 'authState'>): string {
  if (status.provider === 'claude') return 'Claude — via Claude Code';
  return status.authState === 'ok' ? 'OpenAI — conectado com ChatGPT, via Codex' : 'OpenAI — via Codex (ChatGPT)';
}

/** Passos da conexão, na ordem mostrada no cartão (índices usados por connectionSteps). */
export const CONNECTION_STEPS: readonly string[] = ['Conectar', 'Concluir login oficial', 'Confirmar conta', 'Testar resposta', 'Pronto'];

/** Instrução de login em linguagem simples, por provedor (sem token, sem cookie: só o fluxo oficial de cada CLI). */
export function loginInstruction(provider: AiProviderId): string {
  return provider === 'claude'
    ? 'rode `claude` no terminal e faça /login'
    : 'clique em "Entrar no ChatGPT (Codex)" e conclua o login oficial no navegador';
}

/**
 * Problema no fluxo de login que merece aviso e novo botão "Entrar": erro ao verificar (authState 'error') ou
 * detalhe do fluxo mencionando erro/expiração/cancelamento. null = nada a avisar.
 */
export function loginIssue(status: Pick<AiProviderStatus, 'authState' | 'authDetail' | 'login'>): string | null {
  if (status.authState === 'error') return status.authDetail ? maskEmail(status.authDetail) : 'erro ao verificar o login; tente entrar de novo';
  const detail = status.login?.detail;
  if (detail && /erro|expir|cancel|falh|inv[aá]lid/i.test(detail)) return maskEmail(detail);
  return null;
}

export interface ConnectionSteps { steps: string[]; current: number; note: string; tone: Tone }

/**
 * Em que passo da conexão o provedor está, só a partir do estado verificado pelo servidor:
 * 0 sem CLI · 1 sem login · 2 login em andamento / conta não confirmada · 3 login ok mas sem resposta real · 4 pronto.
 * O último passo exige um teste com resposta (lastTest.ok): login ok não é prova de que o provedor responde.
 */
export function connectionSteps(status: Pick<AiProviderStatus, 'provider' | 'installed' | 'authState' | 'authDetail' | 'login' | 'lastTest'>): ConnectionSteps {
  const steps = [...CONNECTION_STEPS];
  const cli = status.provider === 'claude' ? 'Claude Code' : 'Codex CLI';
  if (!status.installed) return { steps, current: 0, note: `${cli} não encontrado`, tone: 'danger' };
  if (status.login?.inProgress) return { steps, current: 2, note: 'aguardando você concluir o login no navegador', tone: 'warn' };
  const issue = loginIssue(status);
  if (status.authState === 'error') return { steps, current: 1, note: `${issue ?? 'erro ao verificar o login'} · ${loginInstruction(status.provider)}`, tone: 'warn' };
  if (status.authState === 'missing') {
    return issue
      ? { steps, current: 1, note: `${issue} · ${loginInstruction(status.provider)}`, tone: 'warn' }
      : { steps, current: 1, note: `sem login: ${loginInstruction(status.provider)}`, tone: 'danger' };
  }
  if (status.authState === 'unknown') return { steps, current: 2, note: 'login ainda não verificado: clique em Atualizar opções', tone: 'muted' };
  // authState 'ok'
  const last = status.lastTest;
  if (last?.ok) {
    const t = formatTimeOfDay(last.at);
    return { steps, current: 4, note: t ? `pronto · última resposta real às ${t}` : 'pronto · já respondeu de verdade nesta conexão', tone: 'ok' };
  }
  if (last) {
    const t = formatTimeOfDay(last.at);
    return { steps, current: 3, note: `o último teste${t ? ` (${t})` : ''} falhou: ${maskEmail(last.detail) || 'sem detalhe'} · clique em Testar conexão de novo`, tone: 'danger' };
  }
  return { steps, current: 3, note: 'ainda sem resposta real nesta conexão: clique em Testar conexão', tone: 'warn' };
}

/** Login confirmado, mas nenhum teste com resposta ainda: o selo "pendente de validação" fica até o primeiro lastTest.ok. */
export function pendingValidation(status: Pick<AiProviderStatus, 'authState' | 'lastTest'>): boolean {
  return status.authState === 'ok' && !status.lastTest?.ok;
}

/** Estado da conexão desta aba com o serviço da HQ (espelha ConnectionState de src/state/client.ts sem importar o estado). */
export type ServiceConnection = 'connecting' | 'open' | 'closed' | 'unauthorized';

export const CONNECTION_TONES: Record<ServiceConnection, Tone> = { open: 'ok', connecting: 'warn', closed: 'danger', unauthorized: 'danger' };

/** Selo da conexão: "Conectado" / "Conectando…" / "Desconectado" / "Token recusado", com "último estado às HH:MM" quando houver snapshot. */
export function serviceConnectionLabel(connection: ServiceConnection, lastSnapshotAt: number | null | undefined): string {
  const base = connection === 'open' ? 'Conectado' : connection === 'connecting' ? 'Conectando…' : connection === 'unauthorized' ? 'Token recusado' : 'Desconectado';
  const t = formatTimeOfDay(lastSnapshotAt);
  return t ? `${base} · último estado às ${t}` : base;
}

export function launchModeLabel(mode: ServiceStatus['launchMode'] | null | undefined): string {
  switch (mode) {
    case 'terminal': return 'janela do terminal (fechar a janela encerra a HQ)';
    case 'background': return 'segundo plano pelo start-hq.cmd (sem janela)';
    case 'scheduled-task': return 'tarefa agendada no logon (sem janela)';
    default: return 'desconhecido';
  }
}

/** Tempo ligado em linguagem curta: "< 1 min", "42 min", "3 h 05 min", "2 d 3 h". Valor inválido = "—". */
export function formatUptime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.floor(sec);
  if (s < 60) return '< 1 min';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h} h ${pad2(rm)} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

export function batteryLabel(onBattery: boolean | null | undefined): string {
  return onBattery == null ? 'desconhecido' : onBattery ? 'na bateria' : 'na tomada';
}

export function networkLabel(online: boolean | null | undefined): string {
  return online == null ? 'rede desconhecida' : online ? 'rede online' : 'rede offline';
}
