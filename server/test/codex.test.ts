// Testes do adaptador do ChatGPT via Codex app-server, com o app-server falso (protocolo igual ao 0.58.0 observado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiProviderStatus } from '@milweb-hq/protocol';
import { CodexAdapter, classifyCodexError, parseCodexRetry } from '../src/ai/codex/adapter.js';
import { codexVendorTarget, locateCodex } from '../src/ai/codex/locate.js';
import type { TurnRequest } from '../src/ai/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fake-codex.mjs');

interface FakeStats { turnStarts: number; threadsStarted: number; threadsResumed: number; approvalDecisions: string[]; interrupts: number; deafInterrupts: number; loginCancels: number; loggedIn: boolean; zombies: number }

function make(loggedIn: boolean, extra: Partial<ConstructorParameters<typeof CodexAdapter>[0]> = {}) {
  const logs: string[] = [];
  const adapter = new CodexAdapter({ exePath: process.execPath, commandPrefixArgs: [fake], env: { FAKE_CODEX_LOGGED_IN: loggedIn ? '1' : '0' }, log: m => logs.push(m), ...extra });
  const statuses: AiProviderStatus[] = [];
  adapter.on('status', s => statuses.push(s));
  const stats = () => adapter.rpc<FakeStats>('fake/stats', {});
  const waitStatus = (pred: (s: AiProviderStatus) => boolean, ms = 5000) => new Promise<AiProviderStatus>((resolve, reject) => {
    const found = statuses.find(pred); if (found) return resolve(found);
    const t = setTimeout(() => reject(new Error('timeout esperando status')), ms);
    const h = (s: AiProviderStatus) => { if (pred(s)) { clearTimeout(t); adapter.off('status', h); resolve(s); } };
    adapter.on('status', h);
  });
  return { adapter, logs, statuses, stats, waitStatus };
}

function req(text: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return { meetingId: 'm1', turnId: 't1', participantId: 'p-chatgpt', threadId: null, cwd: here, systemPrompt: 'Você é o ChatGPT numa reunião.', text, title: 'Reunião: teste', model: null, effort: null, ...extra };
}

test('erro definitivo sem turn/completed (0.58.0 real): modelo recusado e limite de uso encerram o turno na hora, com a parada do provedor', async () => {
  const s = make(true);
  try {
    await s.adapter.refresh();
    const t0 = Date.now();
    const o = await s.adapter.startTurn(req('MODELO_RECUSADO por favor', { timeoutMs: 30_000 })).done;
    assert.ok(Date.now() - t0 < 5000, `não espera o prazo do turno (${Date.now() - t0} ms)`);
    assert.equal(o.status, 'failed');
    assert.equal(o.stop?.kind, 'config');
    assert.equal(o.stop?.until, null);
    assert.match(o.error ?? '', /recusou o modelo gpt-5.*Atualize o Codex/);
    const o2 = await s.adapter.startTurn(req('LIMITE_USO agora', { timeoutMs: 30_000 })).done;
    assert.equal(o2.status, 'failed');
    assert.equal(o2.stop?.kind, 'usage_limit');
    const left = (o2.stop!.until! - Date.now()) / 60_000;
    assert.ok(left > 120 && left < 130, `libera em ~2 h 5 min (veio ${left.toFixed(1)} min)`);
    // O adaptador continua usável depois do erro.
    const o3 = await s.adapter.startTurn(req('Diga oi')).done;
    assert.equal(o3.status, 'done');
    assert.equal(o3.stop ?? null, null);
  } finally { await s.adapter.shutdown(); }
});

test('classificador do Codex: horários de liberação e erros comuns', () => {
  const now = new Date(2026, 10, 2, 14, 0, 0).getTime();
  assert.equal(parseCodexRetry('try again in 3 days 1 hour.', now), now + 3 * 86_400_000 + 3_600_000);
  assert.equal(parseCodexRetry('Try again in 45 minutes', now), now + 45 * 60_000);
  assert.equal(parseCodexRetry('or try again at 3:15 PM.', now), new Date(2026, 10, 2, 15, 15, 0).getTime());
  assert.equal(parseCodexRetry('or try again at 9:05 AM.', now), new Date(2026, 10, 3, 9, 5, 0).getTime(), 'horário que já passou hoje = amanhã');
  assert.equal(parseCodexRetry('stream disconnected', now), null);
  assert.equal(classifyCodexError('stream disconnected before completion', now, null), null, 'erro comum não tira ninguém da reunião');
  assert.equal(classifyCodexError('429 Too Many Requests', now, null)?.kind, 'usage_limit');
  assert.equal(classifyCodexError('429 Too Many Requests', now, null)?.until, now + 30 * 60_000, 'sem horário: tenta de novo em 30 min');
});

test('locate: alvo por plataforma e localização sem shell não lança', () => {
  assert.equal(codexVendorTarget('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.equal(codexVendorTarget('linux', 'x64'), 'x86_64-unknown-linux-musl');
  assert.equal(codexVendorTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(codexVendorTarget('darwin', 'x64'), 'x86_64-apple-darwin');
  const found = locateCodex({});
  if (found) { assert.ok(found.exePath); assert.ok(['env', 'npm-vendor', 'npm-bin'].includes(found.source)); }
});

test('refresh sem login: instalado, versão, catálogo com esforços e authState missing; turno e teste falham SEM turn/start', async () => {
  const s = make(false);
  try {
    const st = await s.adapter.refresh();
    assert.equal(st.provider, 'openai');
    assert.equal(st.label, 'ChatGPT');
    assert.equal(st.routeLabel, 'via Codex (app-server local, conta ChatGPT)');
    assert.equal(st.installed, true);
    assert.equal(st.exePath, process.execPath);
    assert.equal(st.version, '0.58.0');
    assert.equal(st.latestKnownVersion, '0.166.0');
    assert.equal(st.authState, 'missing');
    assert.equal(st.authMethod, null);
    assert.match(st.authDetail ?? '', /sem login/i);
    assert.equal(st.catalogSource, 'model/list do Codex 0.58.0');
    assert.ok(st.catalogAt && st.checkedAt);
    assert.equal(st.busy, false);
    assert.deepEqual(st.models.map(m => m.id), ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1']);
    assert.deepEqual(st.models[0].efforts, ['low', 'medium', 'high']);
    assert.equal(st.models[0].defaultEffort, 'medium');
    assert.equal(st.models[0].isDefault, true);
    assert.deepEqual(st.models[1].efforts, ['medium', 'high']);
    assert.equal(st.models[1].isDefault, false);
    assert.deepEqual(st.prefs, { model: null, effort: null });
    assert.ok(s.statuses.some(x => x.busy === true), 'emitiu status busy durante o refresh');

    const outcome = await s.adapter.startTurn(req('olá')).done;
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /sem login/i);
    assert.equal(outcome.usage, null);

    const t = await s.adapter.test(null, null, here);
    assert.equal(t.ok, false);
    assert.match(t.detail, /sem login/i);
    assert.equal(s.adapter.status().lastTest?.ok, false);

    const stats = await s.stats();
    assert.equal(stats.turnStarts, 0, 'sem login não pode haver turn/start');
    assert.equal(stats.threadsStarted, 0);
  } finally { await s.adapter.shutdown(); }
});

test('validate: padrão ok, modelo fora do catálogo recusa, esforço não suportado recusa com alternativas', async () => {
  const s = make(false);
  try {
    const before = s.adapter.validate('gpt-5.1', 'high');
    assert.equal(before.ok, false, 'sem catálogo carregado não aprova em silêncio');
    await s.adapter.refresh();
    assert.deepEqual(s.adapter.validate(null, null), { ok: true, model: null, effort: null, note: null });
    assert.equal(s.adapter.validate('gpt-5.1', 'high').ok, true);
    assert.equal(s.adapter.validate(null, 'low').ok, true, 'esforço válido para o modelo padrão');
    const unknown = s.adapter.validate('gpt-9', 'low');
    assert.equal(unknown.ok, false);
    if (!unknown.ok) { assert.match(unknown.reason, /gpt-9/); assert.deepEqual(unknown.alternatives, []); }
    const effort = s.adapter.validate('gpt-5.1-codex-mini', 'low');
    assert.equal(effort.ok, false);
    if (!effort.ok) { assert.match(effort.reason, /aceita: medium, high/); assert.deepEqual(effort.alternatives, ['medium', 'high']); }
    const max = s.adapter.validate('gpt-5.1', 'max');
    assert.equal(max.ok, false);
    if (!max.ok) assert.match(max.reason, /aceita: low, medium, high/);
  } finally { await s.adapter.shutdown(); }
});

test('logado: refresh ok com authMethod sem credenciais; turno completo acumula deltas, usage e threadId; retomada usa thread/resume', async () => {
  const s = make(true);
  try {
    const st = await s.adapter.refresh();
    assert.equal(st.authState, 'ok');
    assert.equal(st.authMethod, 'ChatGPT · plus');
    assert.match(st.authDetail ?? '', /c\*\*\*@example\.invalid/);
    assert.ok(!(st.authDetail ?? '').includes('chefe@'), 'e-mail nunca aparece inteiro');

    const deltas: string[] = [];
    const h = s.adapter.startTurn(req('Diga oi', { model: 'gpt-5.1', effort: 'low', onDelta: t => deltas.push(t) }));
    const o = await h.done;
    assert.equal(o.status, 'done');
    assert.equal(o.error, null);
    assert.equal(o.text, 'Resposta falsa do Codex para: Diga oi');
    assert.ok(deltas.length >= 3, `esperava ao menos 3 deltas, veio ${deltas.length}`);
    for (let i = 1; i < deltas.length; i++) assert.ok(deltas[i].startsWith(deltas[i - 1]), 'texto parcial é acumulado');
    assert.equal(deltas[deltas.length - 1], o.text);
    assert.deepEqual(o.usage, { inputTokens: 12, outputTokens: 5 });
    assert.deepEqual(o.applied, { model: 'gpt-5.1', effort: 'low', resolvedModel: 'gpt-5.1' });
    assert.match(o.threadId ?? '', /^thread-/);
    assert.ok(o.durationMs >= 0);

    const o2 = await s.adapter.startTurn(req('De novo', { threadId: o.threadId })).done;
    assert.equal(o2.status, 'done');
    assert.equal(o2.threadId, o.threadId);
    assert.equal(o2.applied.resolvedModel, 'gpt-5.1-codex', 'sem modelo pedido, resolvedModel é o padrão do catálogo');
    const stats = await s.stats();
    assert.equal(stats.turnStarts, 2);
    assert.equal(stats.threadsStarted, 1);
    assert.equal(stats.threadsResumed, 1);
    assert.ok(!s.logs.some(l => l.includes('chefe@')), 'log nunca tem o e-mail');
  } finally { await s.adapter.shutdown(); }
});

test('interrupt: devolve interrupted com o texto parcial; chamada repetida é inofensiva', async () => {
  const s = make(true);
  try {
    let firstDelta: (() => void) | null = null;
    const gotDelta = new Promise<void>(r => { firstDelta = r; });
    const h = s.adapter.startTurn(req('LENTO por favor', { onDelta: () => firstDelta?.() }));
    await gotDelta;
    const t0 = Date.now();
    await h.interrupt();
    await h.interrupt();
    const o = await h.done;
    assert.equal(o.status, 'interrupted');
    assert.ok(o.text.length > 0 && o.text.length < 'Resposta falsa do Codex para: LENTO por favor'.length, `texto parcial: ${JSON.stringify(o.text)}`);
    assert.ok(Date.now() - t0 < 3000, 'não esperou os 5 s do modo LENTO');
    assert.equal(o.error, null);
    assert.equal((await s.stats()).interrupts, 1);
  } finally { await s.adapter.shutdown(); }
});

test('timeout curto: interrompe e devolve failed com motivo claro', async () => {
  const s = make(true);
  try {
    const o = await s.adapter.startTurn(req('LENTO de novo', { timeoutMs: 300 })).done;
    assert.equal(o.status, 'failed');
    assert.match(o.error ?? '', /Tempo máximo/);
    assert.ok(o.durationMs < 3000);
    assert.equal((await s.stats()).interrupts, 1, 'mandou turn/interrupt ao estourar');
  } finally { await s.adapter.shutdown(); }
});

test('pedido de aprovação do servidor é negado e o turno segue', async () => {
  const s = make(true);
  try {
    const o = await s.adapter.startTurn(req('APROVACAO necessária')).done;
    assert.equal(o.status, 'done');
    assert.match(o.text, /^Aprovação denied/);
    assert.deepEqual((await s.stats()).approvalDecisions, ['denied']);
    assert.ok(s.logs.some(l => /aprovação/.test(l) && /negada/.test(l)));
  } finally { await s.adapter.shutdown(); }
});

test('login oficial: startLogin devolve a URL, status login.inProgress, e após account/login/completed vira authState ok', async () => {
  const s = make(false);
  try {
    await s.adapter.refresh();
    assert.equal(s.adapter.status().authState, 'missing');
    const r = await s.adapter.startLogin();
    assert.equal(r.url, 'https://example.invalid/login');
    assert.deepEqual(s.adapter.status().login, { inProgress: true, url: 'https://example.invalid/login', detail: r.detail });
    const ok = await s.waitStatus(st => st.authState === 'ok');
    assert.equal(ok.authMethod, 'ChatGPT · plus');
    assert.equal(ok.login, null);
    assert.ok(!s.logs.some(l => l.includes('https://example.invalid/login')), 'authUrl completa não vai para o log');
    const t = await s.adapter.test('gpt-5.1-codex', 'high', here);
    assert.equal(t.ok, true, t.detail);
    assert.equal(t.resolvedModel, 'gpt-5.1-codex');
    assert.equal(t.effort, 'high');
    assert.ok(typeof t.durationMs === 'number');
    assert.deepEqual(s.adapter.status().lastTest, t);
  } finally { await s.adapter.shutdown(); }
});

test('cancelLogin limpa o estado e avisa o Codex', async () => {
  const s = make(false);
  try {
    await s.adapter.startLogin();
    await s.adapter.cancelLogin();
    assert.equal(s.adapter.status().login, null);
    assert.equal((await s.stats()).loginCancels, 1);
  } finally { await s.adapter.shutdown(); }
});

test('shutdown mata o processo do app-server', async () => {
  const s = make(true);
  await s.adapter.refresh();
  const pid = s.adapter.pid;
  assert.ok(pid && pid > 0);
  assert.equal(s.adapter.alive, true);
  await s.adapter.shutdown();
  assert.equal(s.adapter.alive, false);
  assert.equal(s.adapter.pid, undefined);
  assert.throws(() => process.kill(pid!, 0), 'o processo não existe mais');
  const o = await s.adapter.startTurn(req('depois do shutdown')).done;
  assert.equal(o.status, 'failed');
});

test('turno "surdo" (o Codex aceita o interrupt mas continua transmitindo): encerra por conta própria e o turno seguinte não recebe nada dele', async () => {
  const s = make(true, { interruptGraceMs: 150 });
  try {
    const o1 = await s.adapter.startTurn(req('SURDO LENTO primeiro', { timeoutMs: 200 })).done;
    assert.equal(o1.status, 'failed');
    assert.match(o1.error ?? '', /não confirmou a interrupção/);
    assert.equal((await s.stats()).zombies, 1, 'o turno 1 continua vivo no app-server falso');
    const deltas: string[] = [];
    const o2 = await s.adapter.startTurn(req('segundo', { turnId: 't2', threadId: o1.threadId, onDelta: t => deltas.push(t) })).done;
    assert.equal(o2.status, 'done');
    assert.equal(o2.threadId, o1.threadId, 'mesma thread: o filtro por thread não basta, quem segura é o filtro de turno órfão');
    assert.equal((await s.stats()).threadsResumed, 1);
    assert.equal(o2.text, 'Resposta falsa do Codex para: segundo');
    assert.ok(deltas.length > 0 && deltas.every(t => !t.includes('zumbi')), 'nenhum delta do turno 1 vazou para o turno 2');
    assert.ok(s.logs.some(l => /turno .* estourou/.test(l)));
    // O turn/completed atrasado do turno 1 chega depois: o órfão é reconhecido e sai da lista.
    const t0 = Date.now();
    while (!s.logs.some(l => /turno órfão .* concluiu tarde/.test(l)) && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 20));
    assert.ok(s.logs.some(l => /turno órfão .* concluiu tarde/.test(l)), 'o turn/completed tardio do órfão foi reconhecido');
  } finally { await s.adapter.shutdown(); }
});
