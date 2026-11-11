import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeProcess, buildArgs, sanitizedEnv } from '../src/index.js';
import type { PermissionRequest, ResultInfo } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fake-claude.mjs');

function startFake(extra: Partial<ConstructorParameters<typeof ClaudeProcess>[0]> = {}) {
  return new ClaudeProcess({ exePath: process.execPath, commandPrefixArgs: [fake], cwd: here, ...extra }).start();
}
const once = <T>(p: ClaudeProcess, ev: 'result' | 'permission_request' | 'init' | 'exit', ms = 5000) => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout em ${ev}`)), ms);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).once(ev, (v: T) => { clearTimeout(t); resolve(v); });
});

test('buildArgs monta as flags verificadas no CLI 2.1.314', () => {
  const args = buildArgs({ exePath: 'x', cwd: '.', model: 'sonnet', permissionMode: 'acceptEdits', resume: 'abc', sessionName: 'Dev', includeHookEvents: true, appendSystemPrompt: 'Sala: Dev' });
  assert.deepEqual(args.slice(0, 7), ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--permission-prompt-tool=stdio']);
  assert.ok(args.includes('--include-partial-messages'));
  assert.ok(args.includes('--include-hook-events'));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'sonnet']);
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'abc']);
  assert.ok(!args.includes('--session-id'), 'resume e session-id são exclusivos');
  assert.deepEqual(args.slice(args.indexOf('--append-system-prompt'), args.indexOf('--append-system-prompt') + 2), ['--append-system-prompt', 'Sala: Dev']);
});

test('buildArgs: --effort e --tools (lista separada por vírgula) só quando pedidos', () => {
  const args = buildArgs({ exePath: 'x', cwd: '.', effort: 'high', tools: ['Read', 'Glob', 'Grep'] });
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'high']);
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'Read,Glob,Grep']);
  const none = buildArgs({ exePath: 'x', cwd: '.' });
  assert.ok(!none.includes('--effort') && !none.includes('--tools'));
});

test('buildArgs usa --session-id quando não há resume', () => {
  const args = buildArgs({ exePath: 'x', cwd: '.', sessionId: '11111111-1111-1111-1111-111111111111' });
  assert.ok(args.includes('--session-id'));
});

test('sanitizedEnv remove as marcas de sessão aninhada e preserva o resto', () => {
  const env = sanitizedEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', PATH: 'p' });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'C:/git/bash.exe');
  assert.equal(env.PATH, 'p');
});

test('turno simples: init, resposta e estados starting → running → idle', async () => {
  const p = startFake();
  const states: string[] = [];
  p.on('state', (s) => states.push(s));
  p.sendUser('hello');
  const info = await once<{ sessionId: string }>(p, 'init');
  assert.match(info.sessionId, /^fake-session/);
  const r = await once<ResultInfo>(p, 'result');
  assert.equal(r.isError, false);
  assert.equal(r.resultText, 'echo: hello');
  assert.equal(p.state, 'idle');
  assert.deepEqual(states, ['running', 'idle']);
  const exit = await p.close();
  assert.equal(exit.code, 0);
  assert.equal(p.alive, false);
});

test('permissão: pedido chega como evento, allow executa, deny registra negação', async () => {
  const p = startFake();
  p.sendUser('please use bash');
  const req = await once<PermissionRequest>(p, 'permission_request');
  assert.equal(req.toolName, 'Bash');
  assert.equal(p.state, 'requires_action');
  assert.equal(p.pendingPermissions.size, 1);
  assert.ok(req.permissionSuggestions && req.permissionSuggestions.length === 1);
  p.respondPermission(req.requestId, { behavior: 'allow' });
  const r1 = await once<ResultInfo>(p, 'result');
  assert.equal(r1.resultText, 'ok');
  assert.equal(p.pendingPermissions.size, 0);

  p.sendUser('bash again');
  const req2 = await once<PermissionRequest>(p, 'permission_request');
  p.respondPermission(req2.requestId, { behavior: 'deny', message: 'negado no teste' });
  const r2 = await once<ResultInfo>(p, 'result');
  assert.equal(r2.permissionDenials.length, 1);
  assert.equal(r2.permissionDenials[0].tool_name, 'Bash');
  await p.close();
});

test('AskUserQuestion: respondido com answers via updatedInput', async () => {
  const p = startFake();
  p.sendUser('ask me a question');
  const req = await once<PermissionRequest>(p, 'permission_request');
  assert.equal(req.toolName, 'AskUserQuestion');
  assert.equal(req.requiresUserInteraction, true);
  p.answerQuestion(req.requestId, { 'Which color do you prefer?': 'blue' });
  const r = await once<ResultInfo>(p, 'result');
  assert.equal(r.resultText, 'you chose blue');
  await p.close();
});

test('interrupção: control_request interrupt resolve e o turno termina como abortado', async () => {
  const p = startFake();
  let deltas = 0;
  p.on('raw', (e) => { if (e.type === 'stream_event') deltas++; });
  p.sendUser('slow please');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(deltas > 2, 'deveria estar recebendo texto parcial');
  const resp = await p.interrupt();
  assert.deepEqual(resp.still_queued, []);
  const r = await once<ResultInfo>(p, 'result');
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, 'aborted_streaming');
  assert.equal(p.state, 'idle');
  assert.equal(p.turnActive, false);
  await p.close();
});

test('anexo de imagem vai como bloco de conteúdo', async () => {
  const p = startFake();
  p.sendUser([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what is in the image?' }]);
  const r = await once<ResultInfo>(p, 'result');
  assert.equal(r.resultText, 'Red.');
  await p.close();
});

test('controle não suportado devolve erro e set_model funciona', async () => {
  const p = startFake();
  p.sendUser('hello');
  await once(p, 'result');
  await p.setModel('sonnet');
  await assert.rejects(p.request({ subtype: 'get_plan' }), /unsupported/);
  await p.close();
});

test('exit inesperado: pedidos pendentes rejeitam e estado vira exited', async () => {
  const p = startFake();
  p.sendUser('hello');
  await once(p, 'result');
  const exitP = once<{ expected: boolean }>(p, 'exit');
  p.kill();
  const exit = await exitP;
  assert.equal(p.state, 'exited');
  assert.equal(exit.expected, true);
  assert.throws(() => p.sendUser('x'), /não está disponível/);
});
