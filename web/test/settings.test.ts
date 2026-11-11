// Testes dos helpers puros da aba "Conexões" (serviço, Claude Code, OpenAI/Codex) e do esforço do funcionário (rodam em Node, sem DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiModelOption, AiProviderStatus, AiSettings, AiTestResult } from '@milweb-hq/protocol';
import { DEFAULT_AI_SETTINGS } from '@milweb-hq/protocol';
import {
  CONNECTION_STEPS, aiSettingsProblems, authStateLabel, batteryLabel, checkedAtText, commonEfforts, connectionSteps, effortLabel,
  effortsForModel, findModel, formatCatalogAt, formatUptime, isEffortUnavailable, isNewerVersion, launchModeLabel, loginIssue, maskEmail,
  modelOptionText, networkLabel, pendingValidation, providerTitle, sameAiSettings, serviceConnectionLabel, sortEfforts, sortedModelOptions,
} from '../src/settings/helpers';
import { modelOptionsFromCatalog, MODEL_OPTIONS } from '../src/panel/helpers';

function model(id: string, efforts: AiModelOption['efforts'], extra: Partial<AiModelOption> = {}): AiModelOption {
  return { id, label: id, efforts, defaultEffort: efforts[0] ?? null, ...extra };
}

function status(models: AiModelOption[], extra: Partial<AiProviderStatus> = {}): AiProviderStatus {
  return {
    provider: 'claude', label: 'Claude', routeLabel: 'via Claude Code (CLI instalado)', installed: true, exePath: 'C:\\x\\claude.exe',
    version: '2.1.314', latestKnownVersion: null, authState: 'ok', authMethod: 'claude.ai · max', authDetail: null, models,
    catalogSource: 'binário do Claude Code 2.1.314', catalogAt: null, checkedAt: null, busy: false, lastTest: null, login: null,
    prefs: { model: null, effort: null }, ...extra,
  };
}

const catalog = status([
  model('claude-opus-5-5', ['low', 'medium', 'high', 'max'], { label: 'Opus 5.5', recommended: true, defaultEffort: 'high' }),
  model('claude-sonnet-5', ['low', 'medium', 'high'], { label: 'Sonnet 5' }),
  model('claude-legacy', [], { label: 'Legado', note: 'legado, sem controle de esforço' }),
  model('fable', ['medium', 'high', 'xhigh'], { label: 'Fable', alias: true, resolvesTo: 'claude-fable-5-1', recommended: true }),
]);

// ---------------- Esforço ----------------

test('effortsForModel devolve os níveis do modelo na ordem oficial', () => {
  assert.deepEqual(effortsForModel(status([model('m', ['max', 'low', 'high'])]), 'm'), ['low', 'high', 'max']);
  assert.deepEqual(effortsForModel(catalog, 'claude-legacy'), []);
  assert.deepEqual(effortsForModel(catalog, 'fable'), ['medium', 'high', 'xhigh']);
});

test('effortsForModel sem modelo cai nos níveis comuns; modelo fora do catálogo e sem catálogo dão vazio', () => {
  assert.deepEqual(effortsForModel(catalog, null), ['medium', 'high']);
  assert.deepEqual(effortsForModel(catalog, 'nao-existe'), []);
  assert.deepEqual(effortsForModel(null, 'claude-opus-5-5'), []);
  assert.deepEqual(effortsForModel(undefined, null), []);
});

test('commonEfforts é a interseção dos modelos com esforço (modelos sem esforço não zeram a lista)', () => {
  assert.deepEqual(commonEfforts(catalog), ['medium', 'high']);
  assert.deepEqual(commonEfforts(status([model('a', []), model('b', [])])), []);
  assert.deepEqual(commonEfforts(status([])), []);
  assert.deepEqual(commonEfforts(status([model('a', ['low']), model('b', ['high'])])), []);
  assert.deepEqual(commonEfforts(null), []);
});

test('sortEfforts ordena e remove duplicatas', () => {
  assert.deepEqual(sortEfforts(['max', 'none', 'high', 'none']), ['none', 'high', 'max']);
});

test('isEffortUnavailable só acusa quando o catálogo prova que o nível não existe para o modelo', () => {
  assert.equal(isEffortUnavailable(catalog, 'claude-sonnet-5', 'max'), true);
  assert.equal(isEffortUnavailable(catalog, 'claude-sonnet-5', 'high'), false);
  assert.equal(isEffortUnavailable(catalog, 'claude-legacy', 'high'), true, 'modelo sem esforço com esforço salvo');
  assert.equal(isEffortUnavailable(catalog, null, 'max'), true, 'sem modelo: só os níveis comuns valem');
  assert.equal(isEffortUnavailable(catalog, null, 'high'), false);
  assert.equal(isEffortUnavailable(catalog, 'claude-sonnet-5', null), false, 'padrão nunca é indisponível');
  assert.equal(isEffortUnavailable(catalog, 'desconhecido', 'max'), false, 'modelo fora do catálogo: não dá para afirmar');
  assert.equal(isEffortUnavailable(null, 'claude-sonnet-5', 'max'), false, 'sem catálogo: não dá para afirmar');
  assert.equal(isEffortUnavailable(status([]), null, 'max'), false, 'catálogo vazio: não dá para afirmar');
});

test('effortLabel usa EFFORT_LABELS e "Padrão" para null', () => {
  assert.equal(effortLabel('xhigh'), 'Muito alto');
  assert.equal(effortLabel(null), 'Padrão');
});

// ---------------- Modelos ----------------

test('findModel acha por id e devolve null fora do catálogo', () => {
  assert.equal(findModel(catalog, 'fable')?.label, 'Fable');
  assert.equal(findModel(catalog, 'x'), null);
  assert.equal(findModel(catalog, null), null);
  assert.equal(findModel(null, 'fable'), null);
});

test('sortedModelOptions põe os recomendados primeiro mantendo a ordem do catálogo', () => {
  assert.deepEqual(sortedModelOptions(catalog).map(m => m.id), ['claude-opus-5-5', 'fable', 'claude-sonnet-5', 'claude-legacy']);
  assert.deepEqual(sortedModelOptions(null), []);
});

test('modelOptionText mostra rótulo, id real, alias do CLI e nota', () => {
  assert.equal(modelOptionText(findModel(catalog, 'claude-opus-5-5')!), 'Opus 5.5 · claude-opus-5-5 · recomendado');
  assert.equal(modelOptionText(findModel(catalog, 'fable')!), 'Fable · alias do CLI → claude-fable-5-1 · recomendado');
  assert.equal(modelOptionText(findModel(catalog, 'claude-legacy')!), 'Legado · claude-legacy · legado, sem controle de esforço');
  assert.equal(modelOptionText(model('gpt-5.1-codex', ['low'], { isDefault: true })), 'gpt-5.1-codex · padrão do provedor');
});

test('modelOptionsFromCatalog deriva as opções do catálogo e cai em MODEL_OPTIONS sem catálogo', () => {
  const opts = modelOptionsFromCatalog(catalog);
  assert.equal(opts[0].value, null);
  assert.deepEqual(opts.slice(1).map(o => o.value), ['claude-opus-5-5', 'fable', 'claude-sonnet-5', 'claude-legacy']);
  assert.equal(opts.find(o => o.value === 'fable')?.label, 'Fable · alias do CLI → claude-fable-5-1');
  assert.equal(modelOptionsFromCatalog(null), MODEL_OPTIONS);
  assert.equal(modelOptionsFromCatalog(status([])), MODEL_OPTIONS);
  assert.equal(MODEL_OPTIONS[0].value, null, 'MODEL_OPTIONS continua exportado e começa pelo padrão');
});

// ---------------- Versão, datas, e-mail, login ----------------

test('isNewerVersion compara semver simples', () => {
  assert.equal(isNewerVersion('2.1.314', '2.1.320'), true);
  assert.equal(isNewerVersion('2.1.314', '2.1.314'), false);
  assert.equal(isNewerVersion('2.1.320', '2.1.314'), false);
  assert.equal(isNewerVersion('2.1', '2.1.1'), true);
  assert.equal(isNewerVersion('v0.58.0', '0.60.0'), true);
  assert.equal(isNewerVersion('2.0.0-beta.1', '2.0.0'), false, 'pré-release é ignorado');
  assert.equal(isNewerVersion('2.9.9', '10.0.0'), true, 'compara número a número, não texto');
  assert.equal(isNewerVersion(null, '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', null), false);
  assert.equal(isNewerVersion('abc', '1.0.0'), false);
});

test('formatCatalogAt formata data e hora locais e diz "sem data" quando não há', () => {
  const ts = new Date(2026, 9, 31, 3, 7).getTime();
  assert.equal(formatCatalogAt(ts), '31/10/2026 às 03:07');
  assert.equal(formatCatalogAt(null), 'sem data');
  assert.equal(formatCatalogAt(0), 'sem data');
  assert.equal(formatCatalogAt(Number.NaN), 'sem data');
});

test('checkedAtText diz a hora ou "ainda não verificado"', () => {
  assert.equal(checkedAtText(new Date(2026, 9, 31, 14, 5).getTime()), 'verificado às 14:05');
  assert.equal(checkedAtText(null), 'ainda não verificado');
});

test('maskEmail esconde o usuário do e-mail em qualquer texto', () => {
  assert.equal(maskEmail('maria.silva@gmail.com'), 'ma…@gmail.com');
  assert.equal(maskEmail('ChatGPT · plus · ab@x.io'), 'ChatGPT · plus · a…@x.io');
  assert.equal(maskEmail('sem e-mail aqui'), 'sem e-mail aqui');
  assert.equal(maskEmail(null), '');
});

test('authStateLabel descreve o login sem credenciais', () => {
  assert.equal(authStateLabel({ authState: 'ok', authMethod: 'claude.ai · max' }), 'login ok · claude.ai · max');
  assert.equal(authStateLabel({ authState: 'ok', authMethod: 'ChatGPT · plus · chefe@x.com' }), 'login ok · ChatGPT · plus · ch…@x.com');
  assert.equal(authStateLabel({ authState: 'ok', authMethod: null }), 'login ok');
  assert.equal(authStateLabel({ authState: 'missing', authMethod: null }), 'sem login');
  assert.equal(authStateLabel({ authState: 'unknown', authMethod: null }), 'não verificado');
  assert.equal(authStateLabel({ authState: 'error', authMethod: null }), 'erro ao verificar o login');
});

// ---------------- Rascunho da aba ----------------

test('aiSettingsProblems bloqueia só quando o esforço salvo não existe no modelo', () => {
  const openai = status([model('gpt-5.1-codex', ['low', 'medium', 'high', 'xhigh'])], { provider: 'openai', label: 'ChatGPT' });
  const ok: AiSettings = { claude: { model: 'claude-opus-5-5', effort: 'max' }, openai: { model: null, effort: 'xhigh' } };
  assert.deepEqual(aiSettingsProblems([catalog, openai], ok), []);
  const bad: AiSettings = { claude: { model: 'claude-sonnet-5', effort: 'max' }, openai: { model: 'gpt-5.1-codex', effort: 'none' } };
  const problems = aiSettingsProblems([catalog, openai], bad);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^Claude: o esforço "Máximo"/);
  assert.match(problems[1], /^ChatGPT: o esforço "Nenhum"/);
  assert.deepEqual(aiSettingsProblems(undefined, bad), [], 'sem estado dos provedores não dá para acusar nada');
});

test('sameAiSettings compara modelo e esforço dos dois provedores', () => {
  assert.equal(sameAiSettings(DEFAULT_AI_SETTINGS, { claude: { model: null, effort: null }, openai: { model: null, effort: null } }), true);
  assert.equal(sameAiSettings(DEFAULT_AI_SETTINGS, { claude: { model: null, effort: 'high' }, openai: { model: null, effort: null } }), false);
});

// ---------------- Aba "Conexões": título, passos, serviço ----------------

const openaiStatus = (extra: Partial<AiProviderStatus> = {}) => status([], { provider: 'openai', label: 'ChatGPT', routeLabel: 'via Codex (app-server local, conta ChatGPT)', ...extra });
const testAt = new Date(2026, 9, 31, 9, 41).getTime();
const okTest: AiTestResult = { at: testAt, ok: true, model: null, effort: null, resolvedModel: 'gpt-5.1-codex', detail: 'respondeu', durationMs: 1800 };
const failTest: AiTestResult = { at: testAt, ok: false, model: null, effort: null, resolvedModel: null, detail: 'sem resposta do Codex', durationMs: null };

test('providerTitle só diz "conectado com ChatGPT" quando o login do OpenAI foi confirmado', () => {
  assert.equal(providerTitle({ provider: 'claude', authState: 'ok' }), 'Claude — via Claude Code');
  assert.equal(providerTitle({ provider: 'claude', authState: 'missing' }), 'Claude — via Claude Code');
  assert.equal(providerTitle({ provider: 'openai', authState: 'ok' }), 'OpenAI — conectado com ChatGPT, via Codex');
  assert.equal(providerTitle({ provider: 'openai', authState: 'missing' }), 'OpenAI — via Codex (ChatGPT)');
  assert.equal(providerTitle({ provider: 'openai', authState: 'unknown' }), 'OpenAI — via Codex (ChatGPT)');
  assert.equal(providerTitle({ provider: 'openai', authState: 'error' }), 'OpenAI — via Codex (ChatGPT)');
});

test('connectionSteps: sem CLI é o passo 0 e diz qual binário falta', () => {
  const r = connectionSteps(openaiStatus({ installed: false, authState: 'unknown' }));
  assert.deepEqual(r.steps, [...CONNECTION_STEPS]);
  assert.deepEqual(r.steps, ['Conectar', 'Concluir login oficial', 'Confirmar conta', 'Testar resposta', 'Pronto']);
  assert.equal(r.current, 0);
  assert.equal(r.note, 'Codex CLI não encontrado');
  assert.equal(r.tone, 'danger');
  assert.equal(connectionSteps(status([], { installed: false })).note, 'Claude Code não encontrado');
});

test('connectionSteps: sem login é o passo 1 com a instrução do provedor (sem pedir token nem cookie)', () => {
  const openai = connectionSteps(openaiStatus({ authState: 'missing' }));
  assert.equal(openai.current, 1);
  assert.equal(openai.tone, 'danger');
  assert.match(openai.note, /Entrar no ChatGPT \(Codex\)/);
  assert.doesNotMatch(openai.note, /token|cookie/i);
  const claude = connectionSteps(status([], { authState: 'missing' }));
  assert.equal(claude.current, 1);
  assert.match(claude.note, /rode `claude` no terminal e faça \/login/);
});

test('connectionSteps: login em andamento é o passo 2, aguardando o navegador', () => {
  const r = connectionSteps(openaiStatus({ authState: 'missing', login: { inProgress: true, url: 'https://auth.openai.com/x', detail: 'Abra a página…' } }));
  assert.equal(r.current, 2);
  assert.equal(r.note, 'aguardando você concluir o login no navegador');
  assert.equal(r.tone, 'warn');
});

test('connectionSteps: login ok sem resposta real fica no passo 3 (pendente de validação); teste falho avisa', () => {
  const pending = connectionSteps(openaiStatus({ authState: 'ok', lastTest: null }));
  assert.equal(pending.current, 3);
  assert.equal(pending.note, 'ainda sem resposta real nesta conexão: clique em Testar conexão');
  assert.equal(pending.tone, 'warn');
  assert.equal(pendingValidation(openaiStatus({ authState: 'ok', lastTest: null })), true);
  const failed = connectionSteps(openaiStatus({ authState: 'ok', lastTest: failTest }));
  assert.equal(failed.current, 3);
  assert.equal(failed.tone, 'danger');
  assert.match(failed.note, /\(09:41\) falhou: sem resposta do Codex/);
  assert.equal(pendingValidation(openaiStatus({ authState: 'ok', lastTest: failTest })), true, 'teste falho não valida');
});

test('connectionSteps: login ok com teste respondido é "Pronto" com a hora do teste', () => {
  const r = connectionSteps(openaiStatus({ authState: 'ok', lastTest: okTest }));
  assert.equal(r.current, 4);
  assert.equal(r.note, 'pronto · última resposta real às 09:41');
  assert.equal(r.tone, 'ok');
  assert.equal(pendingValidation(openaiStatus({ authState: 'ok', lastTest: okTest })), false);
  assert.equal(pendingValidation(openaiStatus({ authState: 'missing', lastTest: okTest })), false, 'sem login não é "pendente", é "sem login"');
});

test('connectionSteps e loginIssue: erro ao verificar ou fluxo expirado/cancelado voltam ao passo 1 com aviso para tentar de novo', () => {
  const err = connectionSteps(openaiStatus({ authState: 'error', authDetail: 'Não foi possível iniciar o login no Codex: timeout' }));
  assert.equal(err.current, 1);
  assert.equal(err.tone, 'warn');
  assert.match(err.note, /^Não foi possível iniciar o login no Codex: timeout · clique em/);
  assert.equal(loginIssue(openaiStatus({ authState: 'error', authDetail: null })), 'erro ao verificar o login; tente entrar de novo');
  const expired = openaiStatus({ authState: 'missing', login: { inProgress: false, url: null, detail: 'O link de login expirou.' } });
  assert.equal(loginIssue(expired), 'O link de login expirou.');
  const r = connectionSteps(expired);
  assert.equal(r.current, 1);
  assert.equal(r.tone, 'warn');
  assert.match(r.note, /^O link de login expirou\. · clique em "Entrar no ChatGPT \(Codex\)"/);
  assert.equal(loginIssue(openaiStatus({ authState: 'missing', login: { inProgress: false, url: null, detail: 'Abra a página de login.' } })), null);
  assert.equal(loginIssue(openaiStatus({ authState: 'ok', login: null })), null);
  assert.equal(loginIssue(openaiStatus({ authState: 'error', authDetail: 'conta chefe@x.com recusada' })), 'conta ch…@x.com recusada', 'e-mail mascarado');
});

test('connectionSteps: login não verificado fica no passo 2 em tom neutro', () => {
  const r = connectionSteps(status([], { authState: 'unknown' }));
  assert.equal(r.current, 2);
  assert.equal(r.tone, 'muted');
  assert.match(r.note, /Atualizar opções/);
});

test('serviceConnectionLabel descreve a conexão e acrescenta a hora do último estado quando há snapshot', () => {
  const at = new Date(2026, 9, 31, 14, 5).getTime();
  assert.equal(serviceConnectionLabel('open', null), 'Conectado');
  assert.equal(serviceConnectionLabel('open', at), 'Conectado · último estado às 14:05');
  assert.equal(serviceConnectionLabel('connecting', null), 'Conectando…');
  assert.equal(serviceConnectionLabel('closed', at), 'Desconectado · último estado às 14:05');
  assert.equal(serviceConnectionLabel('closed', 0), 'Desconectado');
  assert.equal(serviceConnectionLabel('unauthorized', null), 'Token recusado');
});

test('launchModeLabel traduz o modo de início do serviço', () => {
  assert.equal(launchModeLabel('terminal'), 'janela do terminal (fechar a janela encerra a HQ)');
  assert.equal(launchModeLabel('background'), 'segundo plano pelo start-hq.cmd (sem janela)');
  assert.equal(launchModeLabel('scheduled-task'), 'tarefa agendada no logon (sem janela)');
  assert.equal(launchModeLabel('unknown'), 'desconhecido');
  assert.equal(launchModeLabel(null), 'desconhecido');
});

test('formatUptime resume o tempo ligado', () => {
  assert.equal(formatUptime(0), '< 1 min');
  assert.equal(formatUptime(59), '< 1 min');
  assert.equal(formatUptime(60), '1 min');
  assert.equal(formatUptime(42 * 60 + 30), '42 min');
  assert.equal(formatUptime(3 * 3600 + 5 * 60), '3 h 05 min');
  assert.equal(formatUptime(2 * 86400 + 3 * 3600 + 59 * 60), '2 d 3 h');
  assert.equal(formatUptime(-1), '—');
  assert.equal(formatUptime(null), '—');
  assert.equal(formatUptime(Number.NaN), '—');
});

test('batteryLabel e networkLabel não inventam quando o serviço não sabe', () => {
  assert.equal(batteryLabel(true), 'na bateria');
  assert.equal(batteryLabel(false), 'na tomada');
  assert.equal(batteryLabel(null), 'desconhecido');
  assert.equal(networkLabel(true), 'rede online');
  assert.equal(networkLabel(false), 'rede offline');
  assert.equal(networkLabel(null), 'rede desconhecida');
});
