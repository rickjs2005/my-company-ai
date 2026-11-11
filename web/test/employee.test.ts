// Testes dos helpers puros do diálogo de funcionário (rodam em Node, sem DOM): modelo de papel, agente nativo,
// prontidão do provedor e filtro de skills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDefinition, AiProviderStatus, RoleTemplate, Room, SkillInfo } from '@milweb-hq/protocol';
import { DEFAULT_ROLE_TEMPLATES } from '@milweb-hq/protocol';
import { PERMISSION_MODE_OPTIONS } from '../src/panel/helpers';
import {
  AGENT_SOURCE_LABELS, agentToProfile, applyTemplate, filterSkillOptions, firstSentence, matchSkills, missingSkillsText, PROVIDER_OPTIONS,
  providerReadiness, skillAvailability,
} from '../src/shell/employeeHelpers';

// ---------------- Fixtures ----------------

function skill(invocation: string, extra: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: `personal:${invocation}`, invocation, name: invocation, description: '', whenToUse: null, argumentHint: null, arguments: [],
    source: 'personal', path: `C:\\Users\\chefe\\.claude\\skills\\${invocation}\\SKILL.md`, plugin: null, projectId: null, disabled: false, override: 'on',
    modelInvocable: true, userInvocable: true, allowedTools: [], model: null, effort: null, forks: false, hasShellInjection: false, shadowedBy: null,
    providers: { claude: { mode: 'native', detail: 'invocação /nome no início do pedido' }, openai: { mode: 'inject', detail: 'texto do SKILL.md vai no pedido' } },
    verified: null, problems: [], kind: 'skill', ...extra,
  };
}

function room(id: string, kind: Room['kind'], order: number): Room {
  return { id, slug: id, name: id, kind, instructions: '', profiles: [], color: '#000', order };
}

function status(provider: AiProviderStatus['provider'], extra: Partial<AiProviderStatus> = {}): AiProviderStatus {
  return {
    provider, label: provider === 'claude' ? 'Claude' : 'ChatGPT', routeLabel: '', installed: true, exePath: null, version: '1.0.0', latestKnownVersion: null,
    authState: 'ok', authMethod: null, authDetail: null, models: [], catalogSource: '', catalogAt: null, checkedAt: null, busy: false, lastTest: null, login: null,
    prefs: { model: null, effort: null }, ...extra,
  };
}

function agent(extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'user:reviewer', name: 'reviewer', description: 'Revisa código com rigor. Use depois de implementar.', source: 'user',
    path: 'C:\\Users\\chefe\\.claude\\agents\\reviewer.md', plugin: null, projectId: null, prompt: '\nVocê revisa diffs.\n', tools: ['Read', 'Grep'],
    disallowedTools: null, model: 'sonnet', permissionMode: 'plan', skills: ['code-review'], effort: 'high', unsupported: [], problems: [], ...extra,
  };
}

const catalog: SkillInfo[] = [
  skill('sistema-web', { description: 'Processo completo de sistema web com banco e login.' }),
  skill('seo-engineering', { description: 'Arruma metadata, sitemap e indexação.' }),
  skill('code-review', { source: 'bundled', path: null, id: 'bundled:code-review' }),
  skill('superpowers:brainstorming', { name: 'brainstorming', source: 'plugin', plugin: 'superpowers@claude-plugins-official', id: 'plugin:superpowers:brainstorming' }),
  skill('social', { disabled: true, override: 'off' }),
  skill('só-claude', { description: 'Depende de hooks do Claude Code.', providers: { claude: { mode: 'native', detail: 'nativa' }, openai: { mode: 'unavailable', detail: 'usa hooks que o Codex não tem' } } }),
  skill('sistema-web', { id: 'project:sistema-web', source: 'project', shadowedBy: 'personal:sistema-web' }),
];

const rooms: Room[] = [room('dir', 'direction', 0), room('dev-2', 'dev', 5), room('dev-1', 'dev', 2), room('social', 'social', 3)];

// ---------------- Skills ----------------

test('matchSkills resolve invocação/nome (barra e caixa ignoradas), prefere a não sombreada e lista o que falta como foi escrito', () => {
  const r = matchSkills(['/Sistema-Web', 'brainstorming', 'code-review', 'code-review', 'verify', ' humanizar-site '], catalog);
  assert.deepEqual(r.found, ['sistema-web', 'superpowers:brainstorming', 'code-review']);
  assert.deepEqual(r.missing, ['verify', 'humanizar-site']);
  assert.deepEqual(matchSkills(['sistema-web'], []), { found: [], missing: ['sistema-web'] });
  assert.deepEqual(matchSkills(['', '  '], catalog), { found: [], missing: [] });
});

test('skillAvailability segue o provedor e trata desativada como indisponível', () => {
  assert.deepEqual(skillAvailability(catalog[0], 'claude'), { available: true, mode: 'native', detail: 'invocação /nome no início do pedido' });
  assert.equal(skillAvailability(catalog[0], 'openai').mode, 'inject');
  assert.equal(skillAvailability(catalog[0], 'openai').available, true);
  const soClaude = catalog.find(s => s.invocation === 'só-claude')!;
  assert.equal(skillAvailability(soClaude, 'claude').available, true);
  assert.deepEqual(skillAvailability(soClaude, 'openai'), { available: false, mode: 'unavailable', detail: 'usa hooks que o Codex não tem' });
  const off = skillAvailability(catalog.find(s => s.invocation === 'social')!, 'claude');
  assert.equal(off.available, false);
  assert.match(off.detail, /skillOverrides/);
});

test('filterSkillOptions busca sem acento, exclui sombreadas e põe as disponíveis primeiro em ordem alfabética', () => {
  const all = filterSkillOptions(catalog, '', 'claude');
  assert.deepEqual(all.map(o => o.skill.invocation), ['code-review', 'seo-engineering', 'sistema-web', 'só-claude', 'superpowers:brainstorming', 'social']);
  assert.equal(all.filter(o => o.skill.id === 'project:sistema-web').length, 0, 'a sombreada não aparece');
  assert.equal(all.find(o => o.skill.invocation === 'social')?.available, false);
  const openai = filterSkillOptions(catalog, '', 'openai');
  assert.deepEqual(openai.slice(-2).map(o => o.skill.invocation).sort(), ['social', 'só-claude'], 'indisponíveis para o Codex vão para o fim');
  assert.ok(openai.slice(0, -2).every(o => o.available) && openai.slice(-2).every(o => !o.available), 'disponíveis antes, indisponíveis depois');
  assert.deepEqual(filterSkillOptions(catalog, 'SO-claude', 'claude').map(o => o.skill.invocation), ['só-claude'], 'acento e caixa não importam');
  assert.deepEqual(filterSkillOptions(catalog, 'indexacao', 'claude').map(o => o.skill.invocation), ['seo-engineering'], 'busca sem acento acha descrição com acento');
  assert.deepEqual(filterSkillOptions(catalog, 'indexação', 'claude').map(o => o.skill.invocation), ['seo-engineering'], 'descrição conta');
  assert.deepEqual(filterSkillOptions(catalog, 'brainstorm', 'claude').map(o => o.skill.invocation), ['superpowers:brainstorming'], 'nome conta');
  assert.deepEqual(filterSkillOptions(catalog, 'nada-disso', 'claude'), []);
  assert.deepEqual(filterSkillOptions([], 'x', 'claude'), []);
});

test('missingSkillsText lista uma ou várias skills ausentes', () => {
  assert.equal(missingSkillsText([]), '');
  assert.equal(missingSkillsText(['sistema-web']), 'sistema-web não está instalada nesta máquina.');
  assert.equal(missingSkillsText(['a', 'b']), 'a e b não estão instaladas nesta máquina.');
  assert.equal(missingSkillsText(['a', 'b', 'c']), 'a, b e c não estão instaladas nesta máquina.');
});

// ---------------- Modelo de papel ----------------

test('applyTemplate preenche sala (primeira do tipo por ordem), função, instruções, skills existentes e permissão', () => {
  const dev = DEFAULT_ROLE_TEMPLATES.find(t => t.id === 'dev')!;
  const r = applyTemplate(dev, rooms, catalog);
  assert.equal(r.roomId, 'dev-1');
  assert.equal(r.role, 'Desenvolvimento');
  assert.equal(r.instructions, dev.instructions);
  assert.deepEqual(r.skills, ['sistema-web', 'seo-engineering']);
  assert.deepEqual(r.missingSkills, ['site-institucional', 'humanizar-site']);
  assert.equal(r.permissionMode, 'default');
});

test('applyTemplate sem sala do tipo, com modo desconhecido ou catálogo vazio não inventa nada', () => {
  const t: RoleTemplate = { id: 'x', name: 'X', role: '  Pesquisa  ', roomKind: 'research', instructions: ' Pesquise. ', preferredSkills: ['prospeccao-internacional'], permissionMode: 'bypassPermissions' };
  const r = applyTemplate(t, rooms, []);
  assert.equal(r.roomId, null);
  assert.equal(r.role, 'Pesquisa');
  assert.equal(r.instructions, 'Pesquise.');
  assert.deepEqual(r.skills, []);
  assert.deepEqual(r.missingSkills, ['prospeccao-internacional']);
  assert.equal(r.permissionMode, null, 'modo fora de PERMISSION_MODE_OPTIONS vira null (manter o atual)');
  assert.equal(applyTemplate({ ...t, permissionMode: 'plan' }, rooms, [], PERMISSION_MODE_OPTIONS).permissionMode, 'plan');
  assert.equal(applyTemplate({ ...t, permissionMode: 'plan' }, rooms, [], ['default']).permissionMode, null);
});

test('todos os modelos padrão aplicam sem erro e cada um pede um modo que o diálogo oferece', () => {
  for (const t of DEFAULT_ROLE_TEMPLATES) {
    const r = applyTemplate(t, rooms, catalog);
    assert.ok(r.role.length > 0 && r.instructions.length > 0, t.id);
    assert.notEqual(r.permissionMode, null, `${t.id}: ${t.permissionMode}`);
  }
});

// ---------------- Agente nativo ----------------

test('agentToProfile copia nome, primeira frase como função, prompt, modelo, esforço, permissão, skills e monta o vínculo', () => {
  const p = agentToProfile(agent(), catalog, PERMISSION_MODE_OPTIONS, 1_700_000_000_000);
  assert.equal(p.name, 'reviewer');
  assert.equal(p.role, 'Revisa código com rigor');
  assert.equal(p.instructions, 'Você revisa diffs.');
  assert.equal(p.model, 'sonnet');
  assert.equal(p.effort, 'high');
  assert.equal(p.permissionMode, 'plan');
  assert.deepEqual(p.skills, ['code-review']);
  assert.deepEqual(p.missingSkills, []);
  assert.deepEqual(p.ref, { name: 'reviewer', source: 'user', path: 'C:\\Users\\chefe\\.claude\\agents\\reviewer.md', tools: ['Read', 'Grep'], importedAt: 1_700_000_000_000, unsupported: [] });
});

test('agentToProfile: inherit vira modelo null, modo desconhecido vira null, tools null = sem restrição, unsupported é copiado', () => {
  const def = agent({
    model: 'inherit', permissionMode: 'bypassPermissions', tools: null, skills: ['code-review', 'verify'], effort: null,
    unsupported: [{ field: 'mcpServers', reason: 'a HQ não sobe servidores MCP por funcionário' }, { field: 'hooks', reason: 'hooks valem só no processo' }],
  });
  const p = agentToProfile(def, catalog, PERMISSION_MODE_OPTIONS, 1);
  assert.equal(p.model, null);
  assert.equal(p.permissionMode, null);
  assert.equal(p.effort, null);
  assert.deepEqual(p.skills, ['code-review']);
  assert.deepEqual(p.missingSkills, ['verify']);
  assert.equal(p.ref.tools, null);
  assert.deepEqual(p.ref.unsupported.map(u => u.field), ['mcpServers', 'hooks']);
  assert.notEqual(p.ref.unsupported, def.unsupported, 'cópia, não a mesma referência');
  const auto = agentToProfile(agent({ description: '' }), [], PERMISSION_MODE_OPTIONS, 1);
  assert.equal(auto.role, '', 'sem descrição não há função sugerida');
  assert.ok(agentToProfile(agent(), catalog, PERMISSION_MODE_OPTIONS).ref.importedAt > 1_600_000_000_000, 'sem `now`, usa a hora atual');
});

test('firstSentence pega a primeira frase, tira o ponto e encurta a 60 caracteres', () => {
  assert.equal(firstSentence('Revisa código. Use depois.', 60), 'Revisa código');
  assert.equal(firstSentence('Sem ponto final nenhum', 60), 'Sem ponto final nenhum');
  assert.equal(firstSentence('Pergunta? Sim.', 60), 'Pergunta?');
  assert.equal(firstSentence('  linhas\n  quebradas.  ', 60), 'linhas quebradas');
  const long = firstSentence('a'.repeat(80), 60);
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('…'));
  assert.equal(firstSentence('', 60), '');
  assert.equal(firstSentence(null, 60), '');
});

test('AGENT_SOURCE_LABELS e PROVIDER_OPTIONS cobrem todas as origens e provedores', () => {
  assert.deepEqual(Object.keys(AGENT_SOURCE_LABELS).sort(), ['plugin', 'project', 'user']);
  assert.deepEqual(PROVIDER_OPTIONS.map(o => o.value), ['claude', 'openai']);
});

// ---------------- Prontidão do provedor ----------------

test('providerReadiness (OpenAI): conectado, pendente de validação, sem login, sem CLI, erro, não verificado', () => {
  const tested = { at: 1, ok: true, model: null, effort: null, resolvedModel: null, detail: '', durationMs: null };
  assert.deepEqual(providerReadiness('openai', [status('openai', { lastTest: tested })]), { tone: 'ok', text: 'OpenAI — conectado com ChatGPT, via Codex' });
  assert.deepEqual(providerReadiness('openai', [status('openai')]), { tone: 'ok', text: 'OpenAI — conectado com ChatGPT, via Codex · pendente de validação' });
  assert.deepEqual(providerReadiness('openai', [status('openai', { lastTest: { ...tested, ok: false } })]), { tone: 'ok', text: 'OpenAI — conectado com ChatGPT, via Codex · pendente de validação' });
  const missing = providerReadiness('openai', [status('openai', { authState: 'missing' })]);
  assert.equal(missing.tone, 'warn');
  assert.equal(missing.text, 'Codex sem login: conclua o login em Ajustes → Conexões. O funcionário fica cadastrado, mas as tarefas dele esperam na fila.');
  const notInstalled = providerReadiness('openai', [status('openai', { installed: false, authState: 'unknown' })]);
  assert.equal(notInstalled.tone, 'warn');
  assert.match(notInstalled.text, /^Codex CLI não encontrado nesta máquina\./);
  const error = providerReadiness('openai', [status('openai', { authState: 'error', authDetail: 'token expirado para maria.silva@gmail.com' })]);
  assert.equal(error.tone, 'danger');
  assert.match(error.text, /erro ao verificar o login — token expirado para ma…@gmail\.com/);
  assert.deepEqual(providerReadiness('openai', [status('openai', { authState: 'unknown', version: '0.58.0' })]), { tone: 'muted', text: 'Codex instalado (0.58.0); login ainda não verificado.' });
  assert.deepEqual(providerReadiness('openai', [status('claude')]), { tone: 'muted', text: 'Codex: estado ainda não verificado pela HQ.' });
  assert.deepEqual(providerReadiness('openai', undefined), { tone: 'muted', text: 'Codex: estado ainda não verificado pela HQ.' });
});

test('providerReadiness (Claude): mesma lógica com o Claude Code, sem expor e-mail do login', () => {
  const tested = { at: 1, ok: true, model: null, effort: null, resolvedModel: null, detail: '', durationMs: null };
  assert.deepEqual(providerReadiness('claude', [status('claude', { authMethod: 'claude.ai · max', lastTest: tested })]), { tone: 'ok', text: 'Claude — conectado via Claude Code (claude.ai · max)' });
  assert.equal(providerReadiness('claude', [status('claude', { authMethod: 'maria.silva@gmail.com' })]).text, 'Claude — conectado via Claude Code (ma…@gmail.com) · pendente de validação');
  assert.equal(providerReadiness('claude', [status('claude')]).text, 'Claude — conectado via Claude Code · pendente de validação');
  const missing = providerReadiness('claude', [status('claude', { authState: 'missing' })]);
  assert.equal(missing.tone, 'warn');
  assert.match(missing.text, /^Claude Code sem login: conclua o login em Ajustes → Conexões\./);
  assert.match(providerReadiness('claude', [status('claude', { installed: false })]).text, /^Claude Code não encontrado nesta máquina\./);
  assert.deepEqual(providerReadiness('claude', []), { tone: 'muted', text: 'Claude Code: estado ainda não verificado pela HQ.' });
});
