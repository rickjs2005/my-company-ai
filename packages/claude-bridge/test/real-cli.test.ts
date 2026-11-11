// Teste de integração com o Claude Code REAL instalado. Consome uso da assinatura; só roda com MILWEB_HQ_REAL_CLI=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProcess, locateClaude } from '../src/index.js';
import type { PermissionRequest, ResultInfo } from '../src/index.js';

const enabled = process.env.MILWEB_HQ_REAL_CLI === '1';

test('CLI real: cria arquivo, pede permissão, continua e retoma', { skip: !enabled && 'defina MILWEB_HQ_REAL_CLI=1 para rodar' }, async () => {
  const install = locateClaude();
  assert.ok(install, 'claude não encontrado');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milweb-hq-real-'));
  const p = new ClaudeProcess({ exePath: install!.exePath, cwd: dir, model: 'sonnet', permissionMode: 'default', extraArgs: ['--strict-mcp-config'] }).start();
  const waitResult = () => new Promise<ResultInfo>((res) => p.once('result', res));
  const perms: PermissionRequest[] = [];
  p.on('permission_request', (req) => { perms.push(req); p.respondPermission(req.requestId, { behavior: 'allow' }); });

  p.sendUser('Create a file named real.txt in the current directory containing the word real, using the Write tool. Reply with exactly: done');
  const r1 = await waitResult();
  assert.equal(r1.isError, false, JSON.stringify(r1.errors));
  assert.equal(fs.readFileSync(path.join(dir, 'real.txt'), 'utf8').trim(), 'real');
  assert.ok(perms.some(q => q.toolName === 'Write'), 'Write deveria pedir permissão no modo default');
  const sessionId = p.sessionId!;

  p.sendUser('What is the name of the file you created? Answer with the file name only.');
  const r2 = await waitResult();
  assert.match(r2.resultText, /real\.txt/);
  await p.close();

  const p2 = new ClaudeProcess({ exePath: install!.exePath, cwd: dir, model: 'sonnet', resume: sessionId, extraArgs: ['--strict-mcp-config'] }).start();
  p2.on('permission_request', (req) => p2.respondPermission(req.requestId, { behavior: 'allow' }));
  p2.sendUser('Repeat the file name you created earlier in this conversation. File name only.');
  const r3 = await new Promise<ResultInfo>((res) => p2.once('result', res));
  assert.match(r3.resultText, /real\.txt/);
  assert.equal(p2.sessionId, sessionId);
  await p2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
