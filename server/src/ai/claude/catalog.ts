// Catálogo de modelos do Claude Code, extraído do binário instalado (claude.exe 2.1.322, arquivo de 10/11/2026) em
// 11/11/2026 lendo as entradas `{id:"claude-…",family:…,capabilities:[…],default_effort:…}`. O CLI não tem comando que
// liste modelos; por isso a origem e a data ficam registradas aqui e aparecem na interface. Quando a versão instalada
// não for a do catálogo, a interface avisa que a lista pode estar desatualizada (o teste de conexão é a prova real).
import type { AiModelOption, EffortLevel } from '@milweb-hq/protocol';

export const CLAUDE_CATALOG_CLI_VERSION = '2.1.322';
export const CLAUDE_CATALOG_AT = Date.UTC(2026, 10, 11, 3, 0, 0); // 11/11/2026 00:00 BRT
export const CLAUDE_CATALOG_SOURCE = `binário do Claude Code ${CLAUDE_CATALOG_CLI_VERSION} (claude.exe de 10/11/2026), lido em 11/11/2026`;

/** Aliases aceitos por --model, tal como o binário 2.1.322 os mapeia. */
export const CLAUDE_ALIASES: Record<string, string> = {
  fable: 'claude-fable-5-2',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

interface CatalogEntry {
  id: string;
  label: string;
  /** capabilities do binário que importam para o esforço: effort, xhigh_effort, max_effort. */
  caps: ('effort' | 'xhigh_effort' | 'max_effort')[];
  defaultEffort: EffortLevel | null;
  cutoff: string;
  recommended?: boolean;
}

const E: CatalogEntry['caps'] = ['effort', 'xhigh_effort', 'max_effort'];

export const CLAUDE_CATALOG: CatalogEntry[] = [
  { id: 'claude-fable-5-2', label: 'Fable 5.2', caps: E, defaultEffort: 'medium', cutoff: 'junho de 2026', recommended: true },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', caps: E, defaultEffort: 'high', cutoff: 'junho de 2026' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', caps: E, defaultEffort: 'medium', cutoff: 'junho de 2026', recommended: true },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', caps: E, defaultEffort: 'medium', cutoff: 'junho de 2026', recommended: true },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', caps: E, defaultEffort: 'medium', cutoff: 'junho de 2026', recommended: true },
  { id: 'claude-mythos-5-2', label: 'Mythos 5.2', caps: E, defaultEffort: 'medium', cutoff: 'junho de 2026' },
  { id: 'claude-mythos-5-1', label: 'Mythos 5.1', caps: E, defaultEffort: 'high', cutoff: 'junho de 2026' },
  { id: 'claude-opus-5', label: 'Opus 5', caps: E, defaultEffort: 'high', cutoff: 'maio de 2026' },
  { id: 'claude-fable-5', label: 'Fable 5', caps: E, defaultEffort: 'high', cutoff: 'janeiro de 2026' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', caps: E, defaultEffort: 'high', cutoff: 'janeiro de 2026' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', caps: E, defaultEffort: 'high', cutoff: 'janeiro de 2026' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', caps: E, defaultEffort: 'xhigh', cutoff: 'janeiro de 2026' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', caps: ['effort', 'max_effort'], defaultEffort: 'xhigh', cutoff: 'maio de 2025' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', caps: ['effort', 'max_effort'], defaultEffort: 'high', cutoff: 'agosto de 2025' },
  // Sem controle de esforço no CLI (capability "effort" ausente no binário).
  { id: 'claude-mythos-5', label: 'Mythos 5', caps: [], defaultEffort: null, cutoff: 'janeiro de 2026' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5', caps: [], defaultEffort: null, cutoff: 'maio de 2025' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', caps: [], defaultEffort: null, cutoff: 'janeiro de 2025' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', caps: [], defaultEffort: null, cutoff: 'fevereiro de 2025' },
  { id: 'claude-opus-4-1', label: 'Opus 4.1', caps: [], defaultEffort: null, cutoff: 'janeiro de 2025' },
  { id: 'claude-opus-4-0', label: 'Opus 4', caps: [], defaultEffort: null, cutoff: 'janeiro de 2025' },
  { id: 'claude-sonnet-4-0', label: 'Sonnet 4', caps: [], defaultEffort: null, cutoff: 'janeiro de 2025' },
  { id: 'claude-3-7-sonnet', label: 'Sonnet 3.7', caps: [], defaultEffort: null, cutoff: 'janeiro de 2025' },
  { id: 'claude-3-5-sonnet', label: 'Sonnet 3.5', caps: [], defaultEffort: null, cutoff: 'janeiro de 2025' },
  { id: 'claude-3-5-haiku', label: 'Haiku 3.5', caps: [], defaultEffort: null, cutoff: 'fevereiro de 2025' },
];

/** Níveis que o CLI aceita para um modelo: "effort" libera low/medium/high; "xhigh_effort" e "max_effort" liberam os extras. */
export function effortsForCaps(caps: CatalogEntry['caps']): EffortLevel[] {
  if (!caps.includes('effort')) return [];
  const out: EffortLevel[] = ['low', 'medium', 'high'];
  if (caps.includes('xhigh_effort')) out.push('xhigh');
  if (caps.includes('max_effort')) out.push('max');
  return out;
}

/** Resolve alias → id do catálogo; ids desconhecidos voltam como estão (o CLI é quem decide se existem). */
export function resolveClaudeModel(model: string | null): string | null {
  if (!model) return null;
  return CLAUDE_ALIASES[model] ?? model;
}

export function claudeEntry(model: string | null): CatalogEntry | null {
  const id = resolveClaudeModel(model);
  return id ? CLAUDE_CATALOG.find(e => e.id === id) ?? null : null;
}

/** Interseção dos níveis aceitos por todos os modelos com controle de esforço (vale quando o modelo é o padrão do CLI, desconhecido aqui). */
export const CLAUDE_COMMON_EFFORTS: EffortLevel[] = ['low', 'medium', 'high'];

export function claudeModelOptions(): AiModelOption[] {
  const out: AiModelOption[] = [];
  for (const [alias, id] of Object.entries(CLAUDE_ALIASES)) {
    const e = CLAUDE_CATALOG.find(x => x.id === id);
    out.push({ id: alias, label: `${alias} (alias do CLI → ${e?.label ?? id})`, efforts: e ? effortsForCaps(e.caps) : CLAUDE_COMMON_EFFORTS, defaultEffort: e?.defaultEffort ?? null, alias: true, resolvesTo: id, recommended: alias === 'fable', note: 'o CLI resolve o alias; o modelo real aparece no teste de conexão' });
  }
  for (const e of CLAUDE_CATALOG) {
    const efforts = effortsForCaps(e.caps);
    out.push({ id: e.id, label: e.label, efforts, defaultEffort: e.defaultEffort, recommended: e.recommended, note: efforts.length ? `corte de conhecimento: ${e.cutoff}` : 'sem controle de esforço no CLI (modelo antigo)' });
  }
  return out;
}
