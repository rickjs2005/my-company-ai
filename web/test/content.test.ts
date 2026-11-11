// Sala de conteúdo na interface: prioridades do Radar, semana em dias, resumo da Mesa do Chefe e contagem de destinos prontos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentItem, ContentRound, ContentState, RadarItem, SocialAccount, SocialState } from '@milweb-hq/protocol';
import { dayLabel, deskSummary, focusWeek, itemsByDay, priorities, weekDays } from '../src/shell/social/contentHelpers';
import { isReady, readyCount, registeredCount, socialSummary } from '../src/shell/social/SocialHub';

const round = (o: Partial<ContentRound> & Pick<ContentRound, 'id' | 'kind' | 'status'>): ContentRound => ({ taskId: 't', routineId: null, employeeId: null, startedAt: 1, finishedAt: 2, coverage: null, summary: null, outputPath: 'x', error: null, weekStart: null, origin: null, sources: null, ...o });
const radar = (o: Partial<RadarItem> & Pick<RadarItem, 'id' | 'roundId'>): RadarItem => ({ sourceUrl: 'https://a.example', sourceName: null, author: null, publishedAt: null, consultedAt: '2026-11-02T08:00:00-03:00', subject: o.id, signals: 's', evidence: 'referencia', window: '7d', slot: 'x', interpretation: 'i', proposal: 'p', priority: null, reason: null, material: null, extraCost: null, status: 'nova', itemId: null, createdAt: 1, kind: 'achado', platform: null, postKey: null, language: null, region: null, metrics: [], inspected: null, observed: null, summaryPt: null, context: null, popularityLimit: null, examples: [], format: null, fit: null, opening: null, effort: null, audio: null, files: [], note: null, seen: 1, updatedAt: 1, video: null, ...o });
const item = (o: Partial<ContentItem> & Pick<ContentItem, 'id'>): ContentItem => ({ weekStart: null, baseId: null, baseTitle: null, date: null, time: null, slot: 'x', profileId: null, format: '', objective: '', title: o.id, brief: '', sources: [], files: [], material: 'nao_precisa', ownerId: null, skill: null, reviewCriteria: '', status: 'planejada', taskId: null, reviewTaskId: null, radarId: null, folder: null, deliverable: null, checks: [], review: null, nextStep: null, approvalId: null, publication: null, deletedAt: null, archivedAt: null, requestId: null, history: [], pausedReason: null, hypothesis: null, referenceIds: [], learning: null, pipeline: null, createdAt: 1, updatedAt: 1, ...o });
const state = (o: Partial<ContentState>): ContentState => ({ setup: { projectId: 'p', folder: 'C:\\c', folderExists: true, team: [], specialties: [], routines: [], missing: [] }, destinations: [], rounds: [], radar: [], items: [], approvals: [], results: [], analyses: [], requests: [], hidden: [], focus: { activeSlots: null, reason: 'f', sources: [], expansion: 'e', updatedAt: null }, capacity: { limit: 3, load: 0, reviewBacklog: 0, reviewMax: 6, blocked: null }, radarSchedule: { routineId: null, title: null, label: null, enabled: false, lastRunAt: null, nextRunAt: null, lastResult: null, lastError: null, note: '' }, ...o });

test('dias da semana e rótulos em Brasília', () => {
  assert.equal(dayLabel('2026-11-02'), 'seg 02/11');
  assert.deepEqual(weekDays('2026-11-02'), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  assert.equal(dayLabel('2026-11-08'), 'dom 08/11');
});

test('prioridades: só da rodada concluída mais recente, sem descartadas, em ordem', () => {
  const c = state({
    rounds: [round({ id: 'old', kind: 'radar', status: 'concluida', startedAt: 1 }), round({ id: 'new', kind: 'radar', status: 'concluida', startedAt: 5 }), round({ id: 'fail', kind: 'radar', status: 'falhou', startedAt: 9 })],
    radar: [radar({ id: 'a', roundId: 'old', priority: 1 }), radar({ id: 'b', roundId: 'new', priority: 2 }), radar({ id: 'c', roundId: 'new', priority: 1 }), radar({ id: 'd', roundId: 'new', priority: 3, status: 'descartada' }), radar({ id: 'e', roundId: 'new' })],
  });
  assert.deepEqual(priorities(c).map(r => r.id), ['c', 'b']);
});

test('semana: itens por dia, sem data no fim, descartadas fora; foco na semana do último calendário', () => {
  const c = state({
    rounds: [round({ id: 's', kind: 'semana', status: 'concluida', weekStart: '2026-11-02' })],
    items: [item({ id: 'seg', date: '2026-11-02', weekStart: '2026-11-02' }), item({ id: 'qua', date: '2026-11-04' }), item({ id: 'sem', weekStart: '2026-11-02' }), item({ id: 'fora', date: '2026-11-20' }), item({ id: 'lixo', date: '2026-11-02', status: 'descartada' })],
  });
  const start = focusWeek(c);
  assert.equal(start, '2026-11-02');
  const g = itemsByDay(c.items, start);
  assert.equal(g.length, 8);
  assert.deepEqual(g[0].items.map(i => i.id), ['seg']);
  assert.deepEqual(g[2].items.map(i => i.id), ['qua']);
  assert.deepEqual(g[7].items.map(i => i.id), ['sem']);
  assert.ok(!g.some(x => x.items.some(i => i.id === 'fora' || i.id === 'lixo')));
});

const acct = (o: Partial<SocialAccount> & Pick<SocialAccount, 'slot' | 'network' | 'label'>): SocialAccount => ({
  mode: 'api', siteUrl: 'https://example.com', declared: null, remoteId: null, username: null, displayName: null, avatar: null, accountKind: null, profileIds: [], status: 'not_connected', statusDetail: 'conta ainda não autorizada', scopes: [],
  capabilities: { authenticated: { state: 'unknown', detail: '' }, read: { state: 'unknown', detail: '' }, publish: { state: 'unknown', detail: '' }, schedule: { state: 'unknown', detail: '' } },
  connectedAt: null, lastCheckAt: null, lastCheckOk: null, lastError: null, tokenExpiresAt: null, nextStep: 'Clique em Conectar', lastPublish: null, ...o,
});

test('cadastradas × verificadas: cadastro confirmado não é acesso; verificada = login do navegador com identidade conferida ou API conectada', () => {
  const s: SocialState = { accounts: [
    acct({ slot: 'instagram-aurora', network: 'instagram', label: 'IG Aurora', declared: { handle: 'auroraexemplo', profileUrl: null, source: 'site', confirmed: false, toCreate: false, at: 1 } }),
    acct({ slot: 'threads', network: 'threads', label: 'Threads', status: 'connected', remoteId: '1' }),
    acct({ slot: 'x', network: 'x', label: 'X', mode: 'manual', status: 'manual', declared: { handle: 'tucoexemplo', profileUrl: null, source: 'chefe', confirmed: true, toCreate: false, at: 1 } }),
  ], apps: [], redirectUri: '', redirectCheck: { ok: true, detail: '', at: 1 }, vault: { kind: 'memory', ok: true, detail: '' }, checkedAt: null };
  assert.deepEqual(s.accounts.map(isReady), [false, true, false]);
  assert.equal(readyCount(s), 1);
  assert.equal(registeredCount(s), 2);
  assert.equal(socialSummary(s), '2 cadastradas · 1 verificadas');
  const nav = { ...s, accounts: [...s.accounts, acct({ slot: 'pinterest', network: 'pinterest', label: 'Pinterest', mode: 'manual', status: 'manual', declared: { handle: 'tuco.example', profileUrl: null, source: 'chefe', confirmed: true, toCreate: false, at: 1 }, browser: { mode: 'navegador', state: 'verificada', detail: '', detectedHandle: 'tuco.example', detectedName: null, detectedAt: 1, verifiedAt: 1, lastCheckAt: 1, lastError: null, open: false, owner: null, manual: false, caps: { pesquisar: { state: 'nao_testada', detail: '', at: null }, ler_metricas: { state: 'nao_testada', detail: '', at: null }, preparar: { state: 'nao_testada', detail: '', at: null }, publicar: { state: 'nao_testada', detail: '', at: null }, agendar: { state: 'nao_testada', detail: '', at: null } } } })] };
  assert.equal(socialSummary(nav), '3 cadastradas · 2 verificadas');
  const d = deskSummary(state({ setup: { projectId: null, folder: null, folderExists: false, team: [], specialties: [], routines: [], missing: ['Preparar a sala'] }, items: [item({ id: 'p', status: 'publicacao_pendente', title: 'Nota X', publication: { url: null, at: 1, verifiedBy: 'pendente', detail: 'cole o link' } }), item({ id: 'r', status: 'revisar' })] }), s);
  assert.deepEqual(d.access.map(a => a.kind), ['sala', 'conta', 'conta', 'publicacao']);
  assert.match(d.access[1].text, /IG Aurora/);
  assert.deepEqual(d.toReview.map(i => i.id), ['r']);
});

test('Mesa: destino pausado pelo foco não cobra login nas pendências de acesso', () => {
  const acc = (slot: string) => ({ slot, label: slot, status: 'not_connected', nextStep: 'conectar', statusDetail: '', browser: { mode: 'navegador', state: 'cadastrada', detail: '' } }) as never;
  const c = state({ focus: { activeSlots: ['instagram-tuco', 'threads'], reason: 'Foco', sources: [], expansion: '', updatedAt: 1 } });
  const s = { accounts: [acc('instagram-tuco'), acc('tiktok'), acc('threads')] } as never;
  const texts = deskSummary(c, s).access.map(a => a.text);
  assert.equal(texts.length, 2); assert.ok(texts.every(t => !t.startsWith('tiktok')));
});
