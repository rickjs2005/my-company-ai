// Servidor MCP do navegador (o que o Claude Code do funcionário lança): fala JSON-RPC por stdio, lista as ferramentas e
// repassa cada chamada à HQ com o token da conversa. A HQ aqui é um servidor HTTP falso que registra o que recebeu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const here = path.dirname(fileURLToPath(import.meta.url));

test('MCP do navegador: initialize, tools/list e tools/call repassada com o token; erro da HQ volta como isError', async () => {
  const got: { auth?: string; body?: unknown }[] = [];
  const hq = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      got.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      const tool = (JSON.parse(b) as { tool: string }).tool;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(tool === 'contas' ? { ok: true, text: '- x (X · inglês): cadastro @exemplox1111' } : { ok: false, text: 'Publicação bloqueada: a peça não está aprovada' }));
    });
  });
  await new Promise<void>(r => hq.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(hq.address() as AddressInfo).port}`;
  const child = spawn(process.execPath, [path.join(here, '..', 'browser-mcp.mjs')], { env: { ...process.env, HQ_BROWSER_URL: url, HQ_BROWSER_TOKEN: 'tok-123' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map<number, Record<string, unknown>>();
  let buf = '';
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); replies.set(m.id, m); } });
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
  const wait = async (id: number) => { const t = Date.now() + 10_000; while (!replies.has(id)) { if (Date.now() > t) throw new Error(`sem resposta ${id}`); await new Promise(r => setTimeout(r, 30)); } return replies.get(id)! as { result: Record<string, unknown> }; };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(((await wait(1)).result.serverInfo as { name: string }).name, 'hq-navegador');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = ((await wait(2)).result.tools as { name: string }[]).map(t => t.name);
    for (const n of ['pesquisar', 'pesquisar_clicar', 'pesquisar_capturar', 'abrir_conta', 'ler_pagina', 'clicar', 'preencher', 'anexar', 'publicar', 'verificar_publicacao', 'registrar_resultado']) assert.ok(names.includes(n), n);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'contas', arguments: {} } });
    const r3 = (await wait(3)).result as { content: { text: string }[]; isError: boolean };
    assert.equal(r3.isError, false); assert.match(r3.content[0].text, /exemplox1111/);
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'publicar', arguments: { itemId: 'p', alvo: { papel: 'button', nome: 'Post' } } } });
    const r4 = (await wait(4)).result as { content: { text: string }[]; isError: boolean };
    assert.equal(r4.isError, true); assert.match(r4.content[0].text, /não está aprovada/);
    assert.equal(got[0].auth, 'Bearer tok-123');
    assert.deepEqual(got[1].body, { tool: 'publicar', args: { itemId: 'p', alvo: { papel: 'button', nome: 'Post' } } });
  } finally { child.kill(); hq.close(); }
});
