// Adaptador do Claude para reuniões com o CLI falso do claude-bridge (protocolo stream-json igual ao real).
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter, MEETING_TOOLS } from '../src/ai/claude/adapter.js';
import { CLAUDE_CATALOG, claudeModelOptions } from '../src/ai/claude/catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.resolve(here, '..', '..', 'packages', 'claude-bridge', 'test', 'fake-claude.mjs');
const seed = { exePath: process.execPath, version: '2.1.314 (Claude Code)', authOk: true, authDetail: 'claude.ai · max', apiKeyInEnv: false };

function make(extra: Partial<ConstructorParameters<typeof ClaudeAdapter>[0]> = {}) {
  return new ClaudeAdapter({ commandPrefixArgs: [fake], seed, ...extra });
}
const req = (text: string, extra: Partial<Parameters<ClaudeAdapter['startTurn']>[0]> = {}) => ({ meetingId: 'm', turnId: 't', participantId: 'p', threadId: null, cwd: os.tmpdir(), systemPrompt: 'Você é Claude', text, title: 'Reunião: teste', model: null, effort: null, ...extra });

test('status e catálogo: origem, data, aliases recomendados primeiro, esforços por modelo', () => {
  const a = make();
  const st = a.status();
  assert.equal(st.provider, 'claude'); assert.equal(st.installed, true); assert.equal(st.authState, 'ok'); assert.equal(st.authMethod, 'claude.ai · max');
  assert.match(st.catalogSource, /2\.1\.314/); assert.ok(st.catalogAt);
  assert.equal(st.models[0].id, 'fable'); assert.equal(st.models[0].alias, true); assert.equal(st.models[0].resolvesTo, 'claude-fable-5-2');
  assert.deepEqual(st.models.find(m => m.id === 'claude-opus-4-6')!.efforts, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(st.models.find(m => m.id === 'claude-3-5-haiku')!.efforts, []);
  assert.equal(claudeModelOptions().length, CLAUDE_CATALOG.length + 4);
  assert.deepEqual(MEETING_TOOLS, ['Read', 'Glob', 'Grep']);
});

test('validate: modelo fora do catálogo, esforço não suportado (com alternativas) e legado sem esforço são recusados com motivo', () => {
  const a = make();
  assert.equal(a.validate(null, null).ok, true);
  assert.equal(a.validate('fable', 'max').ok, true);
  const v1 = a.validate('claude-9', 'high'); assert.equal(v1.ok, false); if (!v1.ok) assert.match(v1.reason, /não está no catálogo/);
  const v2 = a.validate('claude-sonnet-4-6', 'xhigh'); assert.equal(v2.ok, false); if (!v2.ok) { assert.match(v2.reason, /aceita só os níveis/); assert.deepEqual(v2.alternatives, ['low', 'medium', 'high', 'max']); }
  const v3 = a.validate('claude-3-5-sonnet', 'low'); assert.equal(v3.ok, false); if (!v3.ok) assert.match(v3.reason, /não tem controle de esforço/);
  const v4 = a.validate(null, 'max'); assert.equal(v4.ok, false); if (!v4.ok) assert.deepEqual(v4.alternatives, ['low', 'medium', 'high']);
});

test('turno real (CLI falso): texto final, modelo resolvido pelo init, sessão nova com id fixo e usage só quando informado', async () => {
  const a = make();
  const deltas: string[] = [];
  const h = a.startTurn(req('hello', { model: 'sonnet', effort: 'high', onDelta: t => deltas.push(t) }));
  const o = await h.done;
  assert.equal(o.status, 'done');
  assert.equal(o.text, 'echo: hello');
  assert.equal(o.applied.resolvedModel, 'fake-model');
  assert.deepEqual({ model: o.applied.model, effort: o.applied.effort }, { model: 'sonnet', effort: 'high' });
  assert.match(o.threadId!, /^[0-9a-f-]{36}$/);
  assert.equal(o.usage, null, 'o CLI falso não informa tokens: nada é estimado');
  assert.ok(deltas.length >= 1 && deltas[deltas.length - 1] === 'echo: hello');
  await a.shutdown();
});

test('limite de uso de 5 h no turno de reunião: failed com a parada do provedor e o horário do rate_limit_event', async () => {
  const a = make();
  const before = Math.floor(Date.now() / 1000);
  const o = await a.startTurn({ meetingId: 'm', turnId: 't', participantId: 'p', threadId: null, cwd: process.cwd(), systemPrompt: 's', text: 'HIT_LIMIT:3600 oi', title: 'Reunião', model: null, effort: null, timeoutMs: 20_000 }).done;
  assert.equal(o.status, 'failed');
  assert.equal(o.stop?.kind, 'usage_limit');
  assert.match(o.stop?.reason ?? '', /limite de uso de 5 h do Claude esgotado/);
  const secs = Math.round((o.stop!.until! / 1000) - before);
  assert.ok(secs >= 3599 && secs <= 3602, `libera no resetsAt do evento (${secs} s)`);
  // Turno comum: sem parada.
  const ok = await a.startTurn({ meetingId: 'm', turnId: 't2', participantId: 'p', threadId: null, cwd: process.cwd(), systemPrompt: 's', text: 'oi', title: 'Reunião', model: null, effort: null, timeoutMs: 20_000 }).done;
  assert.equal(ok.status, 'done');
  assert.equal(ok.stop ?? null, null);
  await a.shutdown();
});

test('interromper no meio: deltas acumulados, status interrupted e texto parcial', async () => {
  const a = make();
  const deltas: string[] = [];
  const h = a.startTurn(req('slow please', { onDelta: t => deltas.push(t) }));
  const start = Date.now();
  while (deltas.length < 3 && Date.now() - start < 4000) await new Promise(r => setTimeout(r, 20));
  assert.ok(deltas.length >= 3, 'texto parcial chegou');
  assert.ok(deltas[2].startsWith(deltas[1]), 'cada parcial é prefixo do seguinte');
  await h.interrupt();
  const o = await h.done;
  assert.equal(o.status, 'interrupted');
  assert.ok(o.text.includes('bla'));
  await h.interrupt(); // idempotente
  await a.shutdown();
});

test('tempo esgotado: interrompe e devolve failed com o motivo e o parcial', async () => {
  const a = make();
  const h = a.startTurn(req('slow please', { timeoutMs: 300 }));
  const o = await h.done;
  assert.equal(o.status, 'failed');
  assert.match(o.error!, /tempo esgotado/);
  await a.shutdown();
});

test('sem login ou sem instalação: falha na hora, sem processo; configuração inválida idem', async () => {
  const a = make({ seed: { ...seed, authOk: false, authDetail: 'Não está logado' } });
  const o = await a.startTurn(req('hello')).done;
  assert.equal(o.status, 'failed'); assert.match(o.error!, /logado/);
  const b = make({ seed: { ...seed, exePath: null } });
  assert.equal((await b.startTurn(req('hello')).done).status, 'failed');
  assert.equal(b.status().installed, false);
  const c = make();
  const bad = await c.startTurn(req('hello', { model: 'claude-sonnet-4-6', effort: 'xhigh' })).done;
  assert.equal(bad.status, 'failed'); assert.match(bad.error!, /aceita só os níveis/);
});

test('teste de conexão: turno curto real, registra lastTest com o modelo resolvido', async () => {
  const a = make();
  const events: string[] = [];
  a.on('status', s => events.push(`${s.busy}`));
  const dir = tempDir('hq-claude-test-');
  const r = await a.test('fable', 'high', dir);
  assert.equal(r.ok, true); assert.equal(r.resolvedModel, 'fake-model'); assert.match(r.detail, /respondeu/);
  assert.equal(a.status().lastTest?.ok, true);
  assert.ok(events.includes('true') && events[events.length - 1] === 'false');
  const bad = await a.test('claude-3-5-sonnet', 'high', dir);
  assert.equal(bad.ok, false); assert.match(bad.detail, /não tem controle de esforço/);
  await a.shutdown();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('--resume de sessão que não existe mais: failed com threadId zerado e motivo em português; o turno seguinte começa sessão nova', async () => {
  const a = make();
  const o = await a.startTurn(req('oi', { threadId: 'missing-0000-sessao-apagada' })).done;
  assert.equal(o.status, 'failed');
  assert.equal(o.threadId, null, 'sinal para o coordenador zerar a sessão do participante');
  assert.match(o.error ?? '', /sessão anterior do Claude Code .* não existe mais/);
  const again = await a.startTurn(req('oi de novo', { threadId: null })).done;
  assert.equal(again.status, 'done');
  assert.match(again.threadId!, /^[0-9a-f-]{36}$/);
  await a.shutdown();
});

test('sessão nova que falha antes de o CLI subir (executável sumiu) não devolve id inventado: o turno seguinte não tenta --resume', async () => {
  const a = make({ commandPrefixArgs: [], seed: { ...seed, exePath: path.join(os.tmpdir(), 'milweb-hq-nao-existe', 'claude.exe') } });
  const o = await a.startTurn(req('oi')).done;
  assert.equal(o.status, 'failed');
  assert.match(o.error ?? '', /não foi possível iniciar o Claude Code/);
  assert.equal(o.threadId, null, 'sem o init do CLI a sessão nunca existiu');
  await a.shutdown();
});

test('turno de reunião isolado: só Read/Glob/Grep, nenhum servidor MCP (--strict-mcp-config) e modo de permissão padrão fixo', async () => {
  const a = make();
  const o = await a.startTurn(req('ARGS')).done;
  assert.equal(o.status, 'done');
  assert.match(o.text, /--tools Read,Glob,Grep/);
  assert.match(o.text, /--strict-mcp-config/);
  assert.match(o.text, /--permission-mode default/);
  assert.match(o.text, /--permission-prompt-tool=stdio/);
  await a.shutdown();
});
