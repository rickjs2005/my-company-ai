// Helpers puros do diálogo de funcionário (Contratar/Editar): aplicar modelo de papel, importar definição nativa de
// agente, prontidão do provedor e filtro do seletor de skills. Sem React e sem DOM, para rodarem em Node
// (web/test/employee.test.ts). Nada aqui inventa estado: skill fora do catálogo vira "faltando", provedor sem status
// vira "não verificado", e a prontidão só informa (contratar cria um perfil; nunca é bloqueado por login).
import type {
  AgentDefinition, AgentSource, AiProviderId, AiProviderStatus, EffortLevel, EmployeeAgentRef, PermissionModeOption, RoleTemplate, Room, SkillInfo,
  SkillProviderSupport,
} from '@milweb-hq/protocol';
import { PERMISSION_MODE_OPTIONS, truncate } from '../panel/helpers';
import { maskEmail } from '../settings/helpers';

export const PROVIDER_OPTIONS: { value: AiProviderId; label: string }[] = [
  { value: 'claude', label: 'Claude (Claude Code)' },
  { value: 'openai', label: 'OpenAI (Codex)' },
];

export const AGENT_SOURCE_LABELS: Record<AgentSource, string> = { user: 'usuário', project: 'projeto', plugin: 'plugin' };

// ---------------- Skills ----------------

/** Chave de comparação: sem barra inicial, sem caixa. */
const skillKey = (s: string) => s.trim().replace(/^\//, '').toLowerCase();

/** Sem acento e sem caixa, para a busca do seletor. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Resolve nomes pedidos (invocação ou nome, com ou sem barra, qualquer caixa) para invocações reais do catálogo.
 * Prefere a skill que o Claude Code carrega de fato (não sombreada). O que não existe vai para `missing`, como foi escrito.
 */
export function matchSkills(wanted: readonly string[], catalog: readonly SkillInfo[]): { found: string[]; missing: string[] } {
  const found: string[] = [];
  const missing: string[] = [];
  for (const raw of wanted) {
    const key = skillKey(raw);
    if (!key) continue;
    const hit = catalog.find(s => !s.shadowedBy && skillKey(s.invocation) === key)
      ?? catalog.find(s => skillKey(s.invocation) === key)
      ?? catalog.find(s => !s.shadowedBy && skillKey(s.name) === key)
      ?? catalog.find(s => skillKey(s.name) === key);
    if (hit) { if (!found.includes(hit.invocation)) found.push(hit.invocation); }
    else if (!missing.includes(raw.trim())) missing.push(raw.trim());
  }
  return { found, missing };
}

export interface SkillAvailability {
  available: boolean;
  mode: SkillProviderSupport['mode'];
  /** Explicação do catálogo (ou do motivo de estar indisponível), para o title/tooltip. */
  detail: string;
}

/** Como o provedor escolhido recebe a skill. Desativada (skillOverrides off) nunca está disponível. */
export function skillAvailability(skill: SkillInfo, provider: AiProviderId): SkillAvailability {
  if (skill.disabled) return { available: false, mode: 'unavailable', detail: 'desativada em skillOverrides: o Claude Code não a lista nem a invoca' };
  const support = skill.providers?.[provider];
  if (!support) return { available: false, mode: 'unavailable', detail: 'o catálogo não informou como este provedor recebe a skill' };
  return { available: support.mode !== 'unavailable', mode: support.mode, detail: support.detail };
}

export interface SkillOption extends SkillAvailability { skill: SkillInfo }

/**
 * Opções do seletor de skills preferidas: busca por invocação, nome e descrição (sem acento, sem caixa), skills sombreadas
 * fora (não são as que o Claude Code carrega), disponíveis para o provedor primeiro, depois ordem alfabética da invocação.
 */
export function filterSkillOptions(catalog: readonly SkillInfo[], query: string, provider: AiProviderId): SkillOption[] {
  const q = fold(query);
  const out: SkillOption[] = [];
  for (const skill of catalog) {
    if (skill.shadowedBy) continue;
    if (q && !fold(`${skill.invocation} ${skill.name} ${skill.description}`).includes(q)) continue;
    out.push({ skill, ...skillAvailability(skill, provider) });
  }
  return out.sort((a, b) => Number(b.available) - Number(a.available) || a.skill.invocation.localeCompare(b.skill.invocation, 'pt-BR'));
}

/** "sistema-web não está instalada nesta máquina." / "a, b e c não estão instaladas nesta máquina." ('' sem faltantes). */
export function missingSkillsText(missing: readonly string[]): string {
  if (missing.length === 0) return '';
  if (missing.length === 1) return `${missing[0]} não está instalada nesta máquina.`;
  return `${missing.slice(0, -1).join(', ')} e ${missing[missing.length - 1]} não estão instaladas nesta máquina.`;
}

function asPermissionMode(v: string | null | undefined, allowed: readonly string[]): PermissionModeOption | null {
  return v && allowed.includes(v) ? (v as PermissionModeOption) : null;
}

// ---------------- Modelo de papel ----------------

export interface TemplateApplication {
  /** Primeira sala (por ordem) do tipo pedido pelo modelo; null = não há sala desse tipo (manter a atual). */
  roomId: string | null;
  role: string;
  instructions: string;
  /** Invocações que existem no catálogo desta máquina. */
  skills: string[];
  /** Pedidas pelo modelo e ausentes aqui (a interface avisa; nada é inventado). */
  missingSkills: string[];
  /** null = o modelo pede um modo que o diálogo não oferece (manter o atual). */
  permissionMode: PermissionModeOption | null;
}

export function applyTemplate(
  template: RoleTemplate, rooms: readonly Room[], catalog: readonly SkillInfo[], allowedPermissionModes: readonly string[] = PERMISSION_MODE_OPTIONS,
): TemplateApplication {
  const room = [...rooms].sort((a, b) => a.order - b.order).find(r => r.kind === template.roomKind) ?? null;
  const { found, missing } = matchSkills(template.preferredSkills ?? [], catalog);
  return {
    roomId: room?.id ?? null,
    role: (template.role ?? '').trim(),
    instructions: (template.instructions ?? '').trim(),
    skills: found,
    missingSkills: missing,
    permissionMode: asPermissionMode(template.permissionMode, allowedPermissionModes),
  };
}

// ---------------- Agente nativo ----------------

export interface AgentProfile {
  name: string;
  /** Primeira frase da descrição, até 60 caracteres ('' quando a definição não tem descrição). */
  role: string;
  /** Corpo do arquivo do agente (system prompt), sem espaços nas pontas. */
  instructions: string;
  /** 'inherit' (usar o modelo da conversa-mãe) vira null. */
  model: string | null;
  effort: EffortLevel | null;
  /** null = a definição não tem modo ou pede um que o diálogo não oferece. */
  permissionMode: PermissionModeOption | null;
  skills: string[];
  missingSkills: string[];
  /** Vínculo salvo no funcionário (só referência: o arquivo continua sendo a fonte). */
  ref: EmployeeAgentRef;
}

export function agentToProfile(agent: AgentDefinition, catalog: readonly SkillInfo[], allowedPermissionModes: readonly string[], now: number = Date.now()): AgentProfile {
  const { found, missing } = matchSkills(agent.skills ?? [], catalog);
  const model = agent.model && agent.model.trim().toLowerCase() !== 'inherit' ? agent.model.trim() : null;
  return {
    name: agent.name,
    role: firstSentence(agent.description, 60),
    instructions: (agent.prompt ?? '').trim(),
    model,
    effort: agent.effort ?? null,
    permissionMode: asPermissionMode(agent.permissionMode, allowedPermissionModes),
    skills: found,
    missingSkills: missing,
    ref: {
      name: agent.name,
      source: agent.source,
      path: agent.path,
      tools: agent.tools ? [...agent.tools] : null,
      importedAt: now,
      unsupported: (agent.unsupported ?? []).map(u => ({ field: u.field, reason: u.reason })),
    },
  };
}

/** Primeira frase de um texto (até . ! ? seguido de espaço ou fim), sem o ponto final, encurtada com "…" quando passa de `max`. */
export function firstSentence(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.*?[.!?])(?:\s|$)/.exec(t);
  return truncate((m ? m[1] : t).replace(/\.$/, ''), max);
}

// ---------------- Prontidão do provedor ----------------

export type ReadinessTone = 'ok' | 'warn' | 'danger' | 'muted';
export interface ProviderReadiness { tone: ReadinessTone; text: string }

const QUEUE_NOTE = 'O funcionário fica cadastrado, mas as tarefas dele esperam na fila.';

/**
 * Linha honesta sob o seletor de provedor, derivada do estado REAL já apurado pelo servidor. Nunca bloqueia a contratação:
 * o funcionário é só um perfil; quem espera é a tarefa. "pendente de validação" = login ok, mas nenhum turno de teste passou.
 */
export function providerReadiness(provider: AiProviderId, ai: readonly AiProviderStatus[] | null | undefined): ProviderReadiness {
  const status = ai?.find(p => p.provider === provider) ?? null;
  const tool = provider === 'openai' ? 'Codex' : 'Claude Code';
  if (!status) return { tone: 'muted', text: `${tool}: estado ainda não verificado pela HQ.` };
  if (!status.installed) return { tone: 'warn', text: `${provider === 'openai' ? 'Codex CLI' : 'Claude Code'} não encontrado nesta máquina. ${QUEUE_NOTE}` };
  switch (status.authState) {
    case 'ok': {
      const pending = status.lastTest?.ok === true ? '' : ' · pendente de validação';
      const text = provider === 'openai'
        ? `OpenAI — conectado com ChatGPT, via Codex${pending}`
        : `Claude — conectado via Claude Code${status.authMethod ? ` (${maskEmail(status.authMethod)})` : ''}${pending}`;
      return { tone: 'ok', text };
    }
    case 'missing':
      return { tone: 'warn', text: `${tool} sem login: conclua o login em Ajustes → Conexões. ${QUEUE_NOTE}` };
    case 'error':
      return { tone: 'danger', text: `${tool}: erro ao verificar o login${status.authDetail ? ` — ${maskEmail(status.authDetail)}` : ''}. ${QUEUE_NOTE}` };
    default:
      return { tone: 'muted', text: `${tool} instalado${status.version ? ` (${status.version})` : ''}; login ainda não verificado.` };
  }
}
