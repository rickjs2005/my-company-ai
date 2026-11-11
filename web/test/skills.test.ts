// Testes dos helpers puros da área "Skills" (rodam em Node, sem DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillInfo, SkillSource } from '@milweb-hq/protocol';
import {
  SOURCE_LABELS, SOURCE_ORDER, dirname, filterSkills, isSkillAvailable, normalizeText, providerSupportLabel, skillAvailabilitySummary,
  skillExampleRequest, skillSummary, skillUseBlockReason, sortSkills,
} from '../src/shell/skillsHelpers';

function skill(name: string, extra: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: `personal:${name}`, invocation: name, name, description: `Skill ${name}`, whenToUse: null, argumentHint: null, arguments: [],
    source: 'personal', path: `C:\\Users\\chefe\\.claude\\skills\\${name}\\SKILL.md`, plugin: null, projectId: null, disabled: false, override: 'on',
    modelInvocable: true, userInvocable: true, allowedTools: [], model: null, effort: null, forks: false, hasShellInjection: false, shadowedBy: null,
    providers: { claude: { mode: 'native', detail: 'invocação /nome' }, openai: { mode: 'inject', detail: 'texto do SKILL.md no pedido' } },
    verified: null, problems: [], kind: 'skill', ...extra,
  };
}

const base = { query: '', source: 'all' as const, provider: 'all' as const, availability: 'all' as const, favoritesOnly: false, favorites: [] as string[], projectId: null };

const catalog: SkillInfo[] = [
  skill('sistema-web', { description: 'Sistema web com banco e autenticação', whenToUse: 'SaaS, painel com login' }),
  skill('site-institucional', { description: 'Site institucional ou landing page', verified: { listed: true, at: 1 } }),
  skill('seo-engineering', { description: 'Arruma o SEO: metadata, canonical, sitemap', source: 'project', projectId: 'p1', verified: { listed: false, at: 1 } }),
  skill('brainstorming', { id: 'plugin:superpowers:brainstorming', invocation: 'superpowers:brainstorming', source: 'plugin', plugin: 'superpowers@claude-plugins-official', description: 'Refina ideias antes de codar' }),
  skill('humanizar-site', { shadowedBy: 'project:humanizar-site', description: 'Versão pessoal sombreada' }),
  skill('legado', { disabled: true, override: 'off', description: 'Desativada' }),
  skill('so-openai', { providers: { claude: { mode: 'unavailable', detail: 'sem arquivo' }, openai: { mode: 'inject', detail: 'texto' } } }),
  skill('nenhum', { providers: { claude: { mode: 'unavailable', detail: 'a' }, openai: { mode: 'unavailable', detail: 'b' } } }),
  skill('outro-projeto', { source: 'project', projectId: 'p2' }),
];

// ---------------- Rótulos ----------------

test('SOURCE_LABELS cobre todas as origens em português', () => {
  const all: SkillSource[] = ['personal', 'project', 'nested', 'plugin', 'synced', 'bundled'];
  for (const s of all) assert.ok(SOURCE_LABELS[s].length > 0, s);
  assert.equal(SOURCE_LABELS.personal, 'Pessoal (~/.claude/skills)');
  assert.equal(SOURCE_LABELS.project, 'Do projeto');
  assert.equal(SOURCE_LABELS.nested, 'Subpasta do projeto');
  assert.equal(SOURCE_LABELS.plugin, 'Plugin');
  assert.equal(SOURCE_LABELS.synced, 'Sincronizada (claude.ai)');
  assert.equal(SOURCE_LABELS.bundled, 'Embutida no Claude Code');
  assert.deepEqual([...SOURCE_ORDER].sort(), [...all].sort(), 'SOURCE_ORDER lista cada origem uma vez');
});

test('providerSupportLabel traduz o modo de entrega', () => {
  assert.equal(providerSupportLabel({ mode: 'native', detail: '' }), 'nativa');
  assert.equal(providerSupportLabel({ mode: 'inject', detail: '' }), 'por texto');
  assert.equal(providerSupportLabel({ mode: 'unavailable', detail: '' }), 'indisponível');
});

// ---------------- Busca ----------------

test('normalizeText tira acento e caixa', () => {
  assert.equal(normalizeText('Autenticação Sítio'), 'autenticacao sitio');
  assert.equal(normalizeText(null), '');
});

test('filterSkills busca em invocação, nome, descrição e when_to_use sem acento nem caixa', () => {
  const names = (q: string) => filterSkills(catalog, { ...base, query: q }).map(s => s.name);
  assert.deepEqual(names('AUTENTICACAO'), ['sistema-web']);
  assert.deepEqual(names('painel com login'), ['sistema-web'], 'when_to_use conta');
  assert.deepEqual(names('superpowers:brain'), ['brainstorming'], 'invocação com prefixo de plugin');
  assert.deepEqual(names('/site-inst'), ['site-institucional'], 'barra inicial é ignorada');
  assert.deepEqual(names('nada-disso'), []);
});

test('filterSkills esconde sombreadas por padrão e mostra com includeShadowed', () => {
  assert.equal(filterSkills(catalog, base).some(s => s.name === 'humanizar-site'), false);
  assert.equal(filterSkills(catalog, { ...base, includeShadowed: true }).some(s => s.name === 'humanizar-site'), true);
});

test('filterSkills filtra por origem, favoritas e projeto', () => {
  assert.deepEqual(filterSkills(catalog, { ...base, source: 'plugin' }).map(s => s.name), ['brainstorming']);
  assert.deepEqual(filterSkills(catalog, { ...base, favoritesOnly: true, favorites: ['personal:legado', 'x'] }).map(s => s.name), ['legado']);
  const p1 = filterSkills(catalog, { ...base, projectId: 'p1' }).map(s => s.name);
  assert.ok(p1.includes('seo-engineering') && p1.includes('sistema-web'), 'skills do projeto e as gerais ficam');
  assert.ok(!p1.includes('outro-projeto'), 'skill de outro projeto sai');
  assert.ok(filterSkills(catalog, base).some(s => s.name === 'outro-projeto'), 'sem projeto (geral) não filtra por projeto');
});

test('isSkillAvailable e filtro de disponibilidade respeitam desativada e o provedor escolhido', () => {
  const byName = (n: string) => catalog.find(s => s.name === n)!;
  assert.equal(isSkillAvailable(byName('sistema-web')), true);
  assert.equal(isSkillAvailable(byName('legado')), false, 'desativada nunca está disponível');
  assert.equal(isSkillAvailable(byName('so-openai'), 'claude'), false);
  assert.equal(isSkillAvailable(byName('so-openai'), 'openai'), true);
  assert.equal(isSkillAvailable(byName('so-openai'), 'all'), true, 'basta um provedor');
  assert.equal(isSkillAvailable(byName('nenhum'), 'all'), false);

  const avail = filterSkills(catalog, { ...base, availability: 'available' }).map(s => s.name);
  assert.ok(!avail.includes('legado') && !avail.includes('nenhum') && avail.includes('so-openai'));
  const unavailClaude = filterSkills(catalog, { ...base, availability: 'unavailable', provider: 'claude' }).map(s => s.name).sort();
  assert.deepEqual(unavailClaude, ['legado', 'nenhum', 'so-openai']);
  const availClaude = filterSkills(catalog, { ...base, availability: 'available', provider: 'claude' }).map(s => s.name);
  assert.ok(availClaude.includes('sistema-web') && !availClaude.includes('so-openai'));
});

// ---------------- Ordenação ----------------

test('sortSkills: favoritas, depois confirmadas na lista, depois nome; não altera a entrada', () => {
  const input = [skill('zeta'), skill('alfa', { verified: { listed: true, at: 1 } }), skill('beta'), skill('Ômega', { verified: { listed: true, at: 1 } })];
  const copy = [...input];
  const out = sortSkills(input, ['personal:zeta']);
  assert.deepEqual(out.map(s => s.name), ['zeta', 'alfa', 'Ômega', 'beta']);
  assert.deepEqual(input, copy, 'entrada intacta');
  assert.deepEqual(sortSkills([], []), []);
});

// ---------------- Textos ----------------

test('skillExampleRequest usa argument-hint quando existe', () => {
  assert.equal(skillExampleRequest({ invocation: 'seo-engineering', argumentHint: '<pasta do projeto> [modo]' }), '/seo-engineering <pasta do projeto> [modo]');
  assert.equal(skillExampleRequest({ invocation: 'sistema-web', argumentHint: null }), '/sistema-web <seu pedido>');
  assert.equal(skillExampleRequest({ invocation: 'x', argumentHint: '   ' }), '/x <seu pedido>', 'dica vazia conta como ausente');
});

test('skillSummary colapsa espaços e corta com reticências', () => {
  assert.equal(skillSummary({ description: '  a\n\n b   c ' }), 'a b c');
  const long = skillSummary({ description: 'x'.repeat(300) });
  assert.equal(long.length, 140);
  assert.ok(long.endsWith('…'));
  assert.equal(skillSummary({ description: 'curta' }, 10), 'curta');
});

test('skillAvailabilitySummary segue a ordem: desativada > sombreada > só o Claude > verificada > não listada > sem init', () => {
  assert.deepEqual(skillAvailabilitySummary(skill('a', { disabled: true, shadowedBy: 'x', userInvocable: false })), { tone: 'danger', text: 'Desativada (skillOverrides: off)' });
  assert.deepEqual(skillAvailabilitySummary(skill('a', { shadowedBy: 'x', userInvocable: false })), { tone: 'warn', text: 'Outra skill com o mesmo nome tem prioridade' });
  assert.deepEqual(skillAvailabilitySummary(skill('a', { userInvocable: false, verified: { listed: true, at: 1 } })), { tone: 'warn', text: 'Só o Claude decide usá-la (user-invocable: false)' });
  assert.deepEqual(skillAvailabilitySummary(skill('a', { verified: { listed: true, at: 1 } })), { tone: 'ok', text: 'Confirmada na lista do Claude Code' });
  assert.deepEqual(skillAvailabilitySummary(skill('a', { verified: { listed: false, at: 1 } })), { tone: 'warn', text: 'Não apareceu na lista do Claude Code neste projeto' });
  assert.deepEqual(skillAvailabilitySummary(skill('a')), { tone: 'muted', text: 'Ainda não confirmada (nenhum init neste projeto)' });
});

test('skillUseBlockReason só bloqueia desativada ou indisponível nos dois provedores', () => {
  assert.equal(skillUseBlockReason(skill('a')), null);
  assert.equal(skillUseBlockReason(catalog.find(s => s.name === 'so-openai')!), null, 'um provedor basta');
  assert.match(skillUseBlockReason(skill('a', { disabled: true }))!, /skillOverrides: off/);
  const none = skillUseBlockReason(catalog.find(s => s.name === 'nenhum')!)!;
  assert.match(none, /^Indisponível nos dois provedores/);
  assert.match(none, /Claude: a/);
  assert.match(none, /OpenAI: b/);
});

test('dirname funciona com caminhos do Windows e POSIX', () => {
  assert.equal(dirname('C:\\Users\\chefe\\.claude\\skills\\x\\SKILL.md'), 'C:\\Users\\chefe\\.claude\\skills\\x');
  assert.equal(dirname('C:\\Users\\chefe\\.claude\\skills\\x\\'), 'C:\\Users\\chefe\\.claude\\skills');
  assert.equal(dirname('/home/chefe/.claude/skills/x/SKILL.md'), '/home/chefe/.claude/skills/x');
  assert.equal(dirname('/SKILL.md'), '/');
  assert.equal(dirname('C:\\SKILL.md'), 'C:\\');
  assert.equal(dirname('SKILL.md'), '');
});
