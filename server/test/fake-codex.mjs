// `codex app-server` falso para os testes do adaptador: JSON-RPC por linha no stdio, SEM o campo "jsonrpc",
// com as formas observadas no Codex CLI 0.58.0 em 31/10/2026 (initialize, model/list, account/read, thread/start,
// thread/resume, turn/start, turn/interrupt, account/login/start, account/login/cancel) e o método extra fake/stats.
// As notificações de item/turno levam threadId e turnId, como no app-server v2.
// Logado quando FAKE_CODEX_LOGGED_IN='1'; o login falso vira logado 50 ms depois de account/login/start.
// Modos pelo texto do turno: LENTO (deltas com 5 s de intervalo), APROVACAO (pede execCommandApproval) e
// SURDO (o turn/interrupt é aceito, mas o turno continua transmitindo por ~1,2 s, como um Codex que não confirma a interrupção).
import readline from 'node:readline';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, result) => out({ id, result });
const fail = (id, code, message) => out({ id, error: { code, message } });
const notify = (method, params) => out({ method, params });

if (process.argv[2] !== 'app-server') { process.stderr.write('uso: fake-codex.mjs app-server\n'); process.exit(2); }

let loggedIn = process.env.FAKE_CODEX_LOGGED_IN === '1';
const stats = { turnStarts: 0, threadsStarted: 0, threadsResumed: 0, approvalDecisions: [], interrupts: 0, deafInterrupts: 0, loginCancels: 0 };
const threads = new Map();
let seq = 0;
let srvSeq = 0;
let active = null; // turno em andamento: { threadId, turnId, itemId, timers, text, sent, dead, deaf }
const zombies = []; // turnos "surdos": o interrupt foi aceito, mas continuam transmitindo com os ids deles
let loginTimer = null;
const pendingServerRequests = new Map(); // id → callback(result)

const MODELS = [
  { id: 'gpt-5.1-codex', model: 'gpt-5.1-codex', displayName: 'gpt-5.1-codex', description: 'Modelo padrão do Codex para trabalho com código.', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'rápido' }, { reasoningEffort: 'medium', description: 'equilíbrio' }, { reasoningEffort: 'high', description: 'mais raciocínio' }], defaultReasoningEffort: 'medium', isDefault: true },
  { id: 'gpt-5.1-codex-mini', model: 'gpt-5.1-codex-mini', displayName: 'gpt-5.1-codex-mini', description: 'Versão menor e mais barata.', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'equilíbrio' }, { reasoningEffort: 'high', description: 'mais raciocínio' }], defaultReasoningEffort: 'medium', isDefault: false },
  { id: 'gpt-5.1', model: 'gpt-5.1', displayName: 'gpt-5.1', description: 'Modelo geral.', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'rápido' }, { reasoningEffort: 'medium', description: 'equilíbrio' }, { reasoningEffort: 'high', description: 'mais raciocínio' }], defaultReasoningEffort: 'medium', isDefault: false },
];

function account() {
  return loggedIn
    ? { account: { type: 'chatgpt', email: 'chefe@example.invalid', planType: 'plus' }, requiresOpenaiAuth: false }
    : { account: null, requiresOpenaiAuth: true };
}

const ids = (a) => ({ threadId: a.threadId, turnId: a.turnId });

function finishTurn(a, status, usage) {
  if (!a || a.dead) return;
  a.dead = true;
  for (const t of a.timers) clearTimeout(t);
  if (active === a) active = null;
  const zi = zombies.indexOf(a); if (zi >= 0) zombies.splice(zi, 1);
  if (status === 'completed') notify('item/completed', { ...ids(a), item: { type: 'agentMessage', id: a.itemId, text: a.text } });
  notify('turn/completed', { ...ids(a), turn: { id: a.turnId, items: [], status, error: status === 'failed' ? { message: 'falha simulada' } : null }, usage: usage ?? null });
}

function streamTurn(a, text) {
  const slow = /LENTO/.test(text);
  const pieces = a.text.match(/.{1,6}/g) ?? [a.text];
  // Três pedaços: o primeiro logo, os outros com pequeno atraso (ou 5 s no modo LENTO, para testar timeout e interrupção).
  const parts = [pieces.slice(0, 1).join(''), pieces.slice(1, 2).join(''), pieces.slice(2).join('')];
  const delays = slow ? [10, 5000, 5100] : [10, 40, 70];
  parts.forEach((delta, i) => {
    a.timers.push(setTimeout(() => {
      if (a.dead) return;
      a.sent += delta;
      notify('item/agentMessage/delta', { ...ids(a), itemId: a.itemId, delta });
    }, delays[i]));
  });
  a.timers.push(setTimeout(() => finishTurn(a, 'completed', { inputTokens: 12, cachedInputTokens: 0, outputTokens: 5 }), slow ? 5200 : 100));
}

// Turno surdo: sai do lugar de ativo (outro turno pode começar) e segue mandando deltas com os ids dele por ~1,2 s.
function goDeaf(a) {
  stats.deafInterrupts++;
  if (active === a) active = null;
  zombies.push(a);
  let n = 0;
  const iv = setInterval(() => {
    if (a.dead) { clearInterval(iv); return; }
    n++;
    a.sent += 'zumbi ';
    notify('item/agentMessage/delta', { ...ids(a), itemId: a.itemId, delta: 'zumbi ' });
    if (n >= 40) { clearInterval(iv); a.text = a.sent; finishTurn(a, 'completed', null); }
  }, 30);
  a.timers.push(iv);
}

function startTurn(id, params) {
  stats.turnStarts++;
  const text = (params.input ?? []).map(i => i.text ?? '').join('');
  const turnId = `turn-${++seq}`;
  const itemId = `item-${seq}`;
  const a = { threadId: params.threadId, turnId, itemId, timers: [], text: '', sent: '', dead: false, deaf: /SURDO/.test(text) };
  active = a;
  // Turno surdo ainda transmitindo na mesma thread: um pedaço sai ANTES da resposta do turn/start (o cliente ainda não sabe o id novo).
  for (const z of zombies) if (z.threadId === params.threadId && !z.dead) notify('item/agentMessage/delta', { ...ids(z), itemId: z.itemId, delta: 'zumbi-antes ' });
  reply(id, { turn: { id: turnId, items: [], status: 'inProgress', error: null } });
  notify('codex/event/task_started', { id: turnId, msg: { type: 'task_started' } }); // evento legado: o adaptador deve ignorar
  // Como o 0.58.0 real em 02/11/2026: tentativas, um erro definitivo e o task_complete, SEM turn/completed.
  const fatal = /MODELO_RECUSADO/.test(text)
    ? 'unexpected status 400 Bad Request: {"detail":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account.","error":{"type":"invalid_request_error","code":"model_not_found","message":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account."}}'
    : /LIMITE_USO/.test(text) ? "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 hours 5 minutes." : null;
  if (fatal) {
    const legacy = { id: turnId, conversationId: params.threadId };
    notify('codex/event/stream_error', { ...legacy, msg: { type: 'stream_error', message: 'Reconnecting... 1/5' } });
    setTimeout(() => {
      notify('codex/event/error', { ...legacy, msg: { type: 'error', message: fatal } });
      notify('codex/event/task_complete', { ...legacy, msg: { type: 'task_complete', last_agent_message: null } });
      active = null;
    }, 20);
    return;
  }
  notify('turn/started', { ...ids(a), turn: { id: turnId, items: [], status: 'inProgress', error: null } });
  notify('item/started', { ...ids(a), item: { type: 'agentMessage', id: itemId, text: '' } });
  const go = (decision) => {
    if (a.dead) return;
    a.text = decision ? `Aprovação ${decision}; respondendo sem executar nada. Eco: ${text}` : `Resposta falsa do Codex para: ${text}`;
    streamTurn(a, text);
  };
  if (/APROVACAO/.test(text)) {
    const reqId = `srv-${++srvSeq}`;
    pendingServerRequests.set(reqId, (result) => {
      const decision = result && result.decision ? String(result.decision) : 'sem-decisão';
      stats.approvalDecisions.push(decision);
      go(decision);
    });
    out({ method: 'execCommandApproval', id: reqId, params: { conversationId: params.threadId, callId: 'call-1', command: ['echo', 'x'], cwd: params.cwd ?? '.', reason: null, risk: null, parsedCmd: [] } });
  } else {
    go(null);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m && typeof m.method !== 'string' && m.id !== undefined && pendingServerRequests.has(m.id)) {
    const cb = pendingServerRequests.get(m.id); pendingServerRequests.delete(m.id);
    cb(m.result);
    return;
  }
  if (!m || typeof m.method !== 'string') return;
  const { id, method } = m;
  const params = m.params ?? {};
  if (id === undefined) return; // notificação do cliente (initialized etc.)
  switch (method) {
    case 'initialize': return reply(id, { userAgent: 'codex_cli_rs/0.58.0' });
    case 'model/list': return reply(id, { data: MODELS, nextCursor: null });
    case 'account/read': return reply(id, account());
    case 'account/rateLimits/read': return loggedIn ? reply(id, { rateLimits: {} }) : fail(id, -32600, 'codex account authentication required');
    case 'thread/start': {
      if (params.sandbox && !['readOnly', 'workspaceWrite', 'dangerFullAccess'].includes(params.sandbox)) return fail(id, -32602, `sandbox inválido: ${params.sandbox}`);
      stats.threadsStarted++;
      const tid = `thread-${++seq}`;
      threads.set(tid, { developerInstructions: params.developerInstructions ?? null, model: params.model ?? null });
      return reply(id, { thread: { id: tid, preview: '', modelProvider: 'openai', createdAt: 0, path: '' } });
    }
    case 'thread/resume': {
      stats.threadsResumed++;
      const tid = String(params.threadId ?? '');
      if (!tid) return fail(id, -32602, 'threadId obrigatório');
      if (!threads.has(tid)) threads.set(tid, { developerInstructions: null, model: null });
      return reply(id, { thread: { id: tid, preview: '', modelProvider: 'openai', createdAt: 0, path: '' } });
    }
    case 'turn/start': {
      if (!threads.has(params.threadId)) return fail(id, -32602, 'thread desconhecida');
      if (active) return fail(id, -32600, 'já existe um turno em andamento');
      return startTurn(id, params);
    }
    case 'turn/interrupt': {
      stats.interrupts++;
      reply(id, {});
      const a = active && active.turnId === params.turnId ? active : null;
      if (a && a.deaf) goDeaf(a);
      else if (a) setTimeout(() => finishTurn(a, 'interrupted', null), 20);
      return;
    }
    case 'account/login/start': {
      if (params.type !== 'chatgpt') return fail(id, -32602, 'só login chatgpt no falso');
      const loginId = `login-${++seq}`;
      reply(id, { type: 'chatgpt', loginId, authUrl: 'https://example.invalid/login' });
      loginTimer = setTimeout(() => { loginTimer = null; loggedIn = true; notify('account/login/completed', { loginId, success: true, error: null }); }, 50);
      return;
    }
    case 'account/login/cancel': {
      stats.loginCancels++;
      if (loginTimer) { clearTimeout(loginTimer); loginTimer = null; }
      return reply(id, {});
    }
    case 'fake/stats': return reply(id, { ...stats, loggedIn, threads: [...threads.keys()], zombies: zombies.length });
    default: return fail(id, -32601, `método desconhecido: ${method}`);
  }
});
rl.on('close', () => { for (const a of [active, ...zombies]) if (a) for (const t of a.timers) clearTimeout(t); process.exit(0); });
