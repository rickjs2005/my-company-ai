// Helpers puros da área "Skills" (catálogo de skills do Claude Code descobertas pelo servidor).
// Sem React e sem DOM, para rodarem em Node (web/test/skills.test.ts). Nada aqui inventa estado: cada rótulo
// descreve exatamente o que o SkillInfo diz (desativada, sombreada, verificada ou ainda não confirmada).

import type { AiProviderId, SkillInfo, SkillProviderSupport, SkillSource } from '@milweb-hq/protocol';

// ---------------- Rótulos ----------------

export const SOURCE_LABELS: Record<SkillSource, string> = {
  personal: 'Pessoal (~/.claude/skills)',
  project: 'Do projeto',
  nested: 'Subpasta do projeto',
  plugin: 'Plugin',
  synced: 'Sincronizada (claude.ai)',
  bundled: 'Embutida no Claude Code',
};

/** Ordem fixa das origens nos filtros (da mais "sua" para a mais distante). */
export const SOURCE_ORDER: SkillSource[] = ['personal', 'project', 'nested', 'plugin', 'synced', 'bundled'];

/** Nome curto do provedor nas etiquetas ("Claude: nativa", "OpenAI: por texto"). */
export const SKILL_PROVIDER_LABELS: Record<AiProviderId, string> = { claude: 'Claude', openai: 'OpenAI' };
export const SKILL_PROVIDER_ORDER: AiProviderId[] = ['claude', 'openai'];

export function providerSupportLabel(support: SkillProviderSupport): string {
  switch (support.mode) {
    case 'native': return 'nativa';
    case 'inject': return 'por texto';
    case 'unavailable': return 'indisponível';
  }
}

// ---------------- Disponibilidade ----------------

export type SkillProviderFilter = AiProviderId | 'all';
export type SkillAvailabilityFilter = 'all' | 'available' | 'unavailable';

/**
 * Disponível = não desativada e o provedor consegue recebê-la (nativa ou por texto).
 * Com provider 'all', basta um provedor que não seja 'unavailable'.
 */
export function isSkillAvailable(skill: SkillInfo, provider: SkillProviderFilter = 'all'): boolean {
  if (skill.disabled) return false;
  if (provider === 'all') return SKILL_PROVIDER_ORDER.some(p => skill.providers[p]?.mode !== 'unavailable');
  const support = skill.providers[provider];
  return support != null && support.mode !== 'unavailable';
}

export type SkillTone = 'ok' | 'warn' | 'danger' | 'muted';

/** Uma linha honesta sobre o estado da skill, na ordem do que mais impede o uso. */
export function skillAvailabilitySummary(skill: SkillInfo): { tone: SkillTone; text: string } {
  if (skill.disabled) return { tone: 'danger', text: 'Desativada (skillOverrides: off)' };
  if (skill.shadowedBy != null) return { tone: 'warn', text: 'Outra skill com o mesmo nome tem prioridade' };
  if (!skill.userInvocable) return { tone: 'warn', text: 'Só o Claude decide usá-la (user-invocable: false)' };
  if (skill.verified?.listed === true) return { tone: 'ok', text: 'Confirmada na lista do Claude Code' };
  if (skill.verified?.listed === false) return { tone: 'warn', text: 'Não apareceu na lista do Claude Code neste projeto' };
  return { tone: 'muted', text: 'Ainda não confirmada (nenhum init neste projeto)' };
}

/** Motivo pelo qual "Usar esta skill" fica desabilitado; null = pode usar. */
export function skillUseBlockReason(skill: SkillInfo): string | null {
  if (skill.disabled) return 'Desativada por skillOverrides: off. Reative no settings.json do Claude Code para usar.';
  if (!isSkillAvailable(skill, 'all')) {
    const details = SKILL_PROVIDER_ORDER.map(p => `${SKILL_PROVIDER_LABELS[p]}: ${skill.providers[p]?.detail ?? 'sem informação'}`);
    return `Indisponível nos dois provedores. ${details.join(' · ')}`;
  }
  return null;
}

// ---------------- Busca e filtros ----------------

export interface SkillFilters {
  query: string;
  source: SkillSource | 'all';
  provider: SkillProviderFilter;
  availability: SkillAvailabilityFilter;
  favoritesOnly: boolean;
  /** Ids de skills favoritas. */
  favorites: string[];
  /** Projeto selecionado; skills de outro projeto saem. null = geral (não filtra por projeto). */
  projectId: string | null;
  /** Mostrar também as sombreadas (outra skill com o mesmo nome tem prioridade). Padrão: escondidas. */
  includeShadowed?: boolean;
}

/** Minúsculas e sem acento (NFD + remoção dos diacríticos), para busca tolerante. */
export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matchesQuery(skill: SkillInfo, query: string): boolean {
  const q = normalizeText(query).trim().replace(/^\//, '');
  if (!q) return true;
  const hay = [skill.invocation, skill.name, skill.description, skill.whenToUse].map(normalizeText);
  return hay.some(h => h.includes(q));
}

export function filterSkills(skills: readonly SkillInfo[], filters: SkillFilters): SkillInfo[] {
  const fav = new Set(filters.favorites);
  return skills.filter(s => {
    if (s.shadowedBy != null && !filters.includeShadowed) return false;
    if (filters.projectId != null && s.projectId != null && s.projectId !== filters.projectId) return false;
    if (filters.source !== 'all' && s.source !== filters.source) return false;
    if (filters.favoritesOnly && !fav.has(s.id)) return false;
    if (filters.availability !== 'all') {
      const available = isSkillAvailable(s, filters.provider);
      if (filters.availability === 'available' && !available) return false;
      if (filters.availability === 'unavailable' && available) return false;
    }
    return matchesQuery(s, filters.query);
  });
}

/** Favoritas primeiro, depois as confirmadas na lista do Claude Code, depois por nome. Não altera a lista original. */
export function sortSkills(skills: readonly SkillInfo[], favorites: readonly string[]): SkillInfo[] {
  const fav = new Set(favorites);
  const rank = (s: SkillInfo) => (fav.has(s.id) ? 0 : 1) * 2 + (s.verified?.listed === true ? 0 : 1);
  return [...skills].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) || a.invocation.localeCompare(b.invocation));
}

// ---------------- Textos derivados ----------------

/** Exemplo de pedido que ativa a skill: `/nome <dica de argumento>` ou `/nome <seu pedido>`. */
export function skillExampleRequest(skill: Pick<SkillInfo, 'invocation' | 'argumentHint'>): string {
  const hint = skill.argumentHint?.trim();
  return `/${skill.invocation} ${hint ? hint : '<seu pedido>'}`;
}

/** Descrição curta para a lista: espaços colapsados e corte com reticências em `max` caracteres. */
export function skillSummary(skill: Pick<SkillInfo, 'description'>, max = 140): string {
  const t = skill.description.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** Pasta de um caminho (Windows ou POSIX). Sem separador, devolve '' . */
export function dirname(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  if (i < 0) return '';
  if (i === 0) return t.slice(0, 1);
  if (/^[a-zA-Z]:$/.test(t.slice(0, i))) return t.slice(0, i + 1);
  return t.slice(0, i);
}
