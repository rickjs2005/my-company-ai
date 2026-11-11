// Limite de uso da assinatura e falta de rede (o que travou o trabalho do Léo em 31/10 e 01/11/2026): a fila do provedor é
// suspensa com explicação até o horário de volta e a mesma tarefa é retomada sozinha, sem repetir às cegas o que já foi feito.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage, Task } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import { classifyProviderStop, parseResetTime } from '../src/provider-stop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.resolve(here, '..', '..', 'packages', 'claude-bridge', 'test', 'fake-claude.mjs');

// Textos reais do Claude Code 2.1.316 gravados no banco da HQ.
const LIMIT_TEXT = "You've hit your 5-hour limit · resets 12:40am (America/Sao_Paulo)";
const NET_TEXT = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
const AT_LIMIT = Date.parse('2026-10-31T23:29:34Z'); // 20:29 em Brasília, quando o limite bateu

test('classificador: limite com e sem resetsAt, rede, erro comum e interrupção', () => {
  const real = classifyProviderStop({ isError: true, terminalReason: 'api_error', resultText: LIMIT_TEXT, errors: [], apiError: 'rate_limit', rateLimit: { status: 'rejected', resetsAt: 1793504400, type: 'five_hour' }, now: AT_LIMIT });
  assert.deepEqual(real && { ...real, text: undefined }, { kind: 'usage_limit', until: 1793504400_000, label: 'limite de uso de 5 h', text: undefined });
  // Sem o evento rate_limit (ou com resetsAt velho): o horário vem do texto, no fuso informado.
  assert.equal(parseResetTime(LIMIT_TEXT, AT_LIMIT), 1793504400_000, '00:40 de 01/11 em Brasília');
  const fromText = classifyProviderStop({ isError: true, resultText: LIMIT_TEXT, errors: [], rateLimit: { status: 'rejected', resetsAt: 1000, type: 'five_hour' }, now: AT_LIMIT });
  assert.equal(fromText?.kind, 'usage_limit'); assert.equal(fromText?.kind === 'usage_limit' && fromText.until, 1793504400_000);
  assert.equal(parseResetTime('resets 7:40pm (America/Sao_Paulo)', Date.parse('2026-10-31T21:54:38Z')), Date.parse('2026-10-31T22:40:00Z'));
  assert.equal(classifyProviderStop({ isError: true, terminalReason: 'api_error', resultText: NET_TEXT, errors: [], apiError: 'server_error', now: AT_LIMIT })?.kind, 'network');
  assert.equal(classifyProviderStop({ isError: true, resultText: 'Tool failed', errors: ['erro qualquer'], now: AT_LIMIT }), null, 'erro comum continua sendo erro da tarefa');
  assert.equal(classifyProviderStop({ isError: false, resultText: LIMIT_TEXT, errors: [], now: AT_LIMIT }), null);
  assert.equal(classifyProviderStop({ isError: true, terminalReason: 'aborted_streaming', resultText: NET_TEXT, errors: [], now: AT_LIMIT }), null, 'interrupção do Chefe não suspende nada');
});

function setup(maxAttempts = 2, maxTaskMinutes = 0) {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.seedDefaultRooms();
  store.saveSettings({ maxAttempts, maxTaskMinutes });
  const projDir = tempDir('hq-proj-');
  const room = store.listRooms()[0];
  const project = store.createProject({ name: 'Projeto teste', path: projDir, roomId: room.id });
  const manager = new SessionManager({ store, exePath: () => process.execPath, attachmentsDir: os.tmpdir(), commandPrefixArgs: [fakeClaude] });
  const msgs: ServerMessage[] = [];
  manager.on('broadcast', m => msgs.push(m));
  const waitTask = (pred: (t: Task) => boolean, ms = 10_000) => new Promise<Task>((resolve, reject) => {
    const found = store.listTasks().find(pred); if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error('timeout esperando tarefa')), ms);
    const h = (m: ServerMessage) => { if (m.kind === 'entity' && m.entity === 'task' && pred(m.item as Task)) { clearTimeout(timer); manager.off('broadcast', h); resolve(m.item as Task); } };
    manager.on('broadcast', h);
  });
  const leo = manager.createEmployee({ roomId: room.id, name: 'Léo' });
  const run = (clientId: string, text: string) => manager.runTask({ reqId: 'r', clientId, text, projectId: project.id, employeeId: leo.id, skill: null, plan: false });
  const notices = (sessionId: string) => store.listChat(sessionId).filter(c => c.kind === 'notice').map(c => (c as { text: string }).text);
  return { store, manager, msgs, waitTask, run, notices, cleanup: async () => { await manager.shutdown(); fs.rmSync(projDir, { recursive: true, force: true }); } };
}

test('limite de 5 h sem progresso: fila do Claude suspensa até o horário, outra tarefa espera com o motivo, o mesmo pedido volta sozinho e conclui', async () => {
  const s = setup();
  try {
    const r1 = await s.run('lim-1', 'faça a landing HIT_LIMIT:3 TURNS:1');
    const failed = await s.waitTask(t => t.id === r1.taskId && t.status === 'error');
    assert.ok(failed.errors.some(e => /Parada pelo limite de uso de 5 h do Claude/.test(e)), failed.errors.join(' | '));
    const hold = s.manager.holdFor('claude');
    assert.ok(hold && hold.kind === 'usage_limit' && hold.until > Date.now(), 'fila do Claude suspensa');
    assert.match(hold!.reason, /Claude em pausa até \d{2}:\d{2} \(horário de Brasília\): limite de uso de 5 h da assinatura atingido/);
    const resume = s.store.findTaskByClientId(`resume:${r1.taskId}:2`)!;
    assert.ok(resume, 'retomada criada');
    assert.equal(resume.status, 'queued'); assert.equal(resume.attempt, 1, 'parada do provedor não gasta tentativa'); assert.equal(resume.retryOf, r1.taskId);
    assert.equal(resume.prompt, 'faça a landing HIT_LIMIT:3 TURNS:1', 'nada tinha sido feito: o mesmo pedido volta');
    assert.equal(resume.heldReason, hold!.reason, 'o cartão da tarefa mostra por que ela espera');
    assert.ok(s.notices(r1.sessionId).some(n => /o mesmo pedido volta sozinho quando o Claude voltar \(retomada 1 de 8; parada do provedor não gasta tentativa\)/.test(n)));
    // Pedido novo durante a suspensão: entra na fila com o motivo (não falha nem queima tentativa).
    const r2 = await s.run('lim-2', 'outra coisa');
    assert.equal(r2.status, 'queued'); assert.equal(r2.queueReason, hold!.reason);
    // No horário de volta (3 s no CLI falso) a fila anda sozinha: retomada e o pedido novo concluem.
    const doneResume = await s.waitTask(t => t.id === resume.id && t.status === 'done');
    assert.equal(doneResume.heldReason, null, 'motivo limpo ao começar');
    await s.waitTask(t => t.id === r2.taskId && t.status === 'done');
    assert.equal(s.manager.holdFor('claude'), null);
  } finally { await s.cleanup(); }
});

test('limite no meio do trabalho: a retomada pede para continuar conferindo o estado, sem repetir o pedido; parada do provedor não gasta tentativa (retoma mesmo com limite de 1)', async () => {
  const s = setup();
  try {
    const r1 = await s.run('mid-1', 'refatore tudo HIT_LIMIT:60 TURNS:205');
    await s.waitTask(t => t.id === r1.taskId && t.status === 'error');
    const resume = s.store.findTaskByClientId(`resume:${r1.taskId}:2`)!;
    assert.match(resume.prompt, /^Continue a tarefa anterior de onde parou\. Ela foi interrompida por o limite de uso de 5 h, não por erro seu\. Antes de repetir qualquer ação, confira o estado atual dos arquivos/);
    assert.match((s.store.getChatItem('user:' + resume.id) as { text: string }).text, /^Continuar de onde parou \(retomada automática/);
    assert.ok(s.notices(r1.sessionId).some(n => /continua sozinha nesta conversa quando o Claude voltar, conferindo o que já foi feito antes de seguir \(retomada 1 de 8/.test(n)));
  } finally { await s.cleanup(); }
  const one = setup(1);
  try {
    const r1 = await one.run('max-1', 'pedido HIT_LIMIT:60 TURNS:1');
    await one.waitTask(t => t.id === r1.taskId && t.status === 'error');
    const resume = one.store.findTaskByClientId(`resume:${r1.taskId}:2`);
    assert.ok(resume, 'com limite de 1 tentativa, a parada do provedor ainda retoma (09/11/2026)');
    assert.equal(resume!.attempt, 1);
  } finally { await one.cleanup(); }
});

test('sem rede (ENOTFOUND): suspende com espera de 1 min em vez de queimar a fila e põe a retomada na fila com o motivo', async () => {
  const s = setup();
  try {
    const r1 = await s.run('net-1', 'continue OFFLINE');
    const failed = await s.waitTask(t => t.id === r1.taskId && t.status === 'error');
    assert.ok(failed.errors.some(e => /Sem resposta da API do Claude: API Error: Can't reach the API server/.test(e)));
    const hold = s.manager.holdFor('claude')!;
    assert.equal(hold.kind, 'network');
    assert.ok(hold.until - Date.now() > 50_000 && hold.until - Date.now() <= 60_000, 'primeira falha: 1 min');
    assert.match(hold.reason, /Claude sem conexão com a API; nova tentativa às \d{2}:\d{2} \(falha 1 seguida\)/);
    const resume = s.store.findTaskByClientId(`resume:${r1.taskId}:2`)!;
    assert.equal(resume.status, 'queued'); assert.equal(resume.heldReason, hold.reason);
    assert.deepEqual(s.manager.providerHolds().map(h => h.provider), ['claude']);
  } finally { await s.cleanup(); }
});

test('sem conexão muitas vezes seguidas: depois de 8 retomadas a tarefa não volta sozinha e avisa por quê', async () => {
  const s = setup(1);
  try {
    const r1 = await s.run('net-cap', 'continue OFFLINE');
    const first = await s.waitTask(t => t.id === r1.taskId && t.status === 'error');
    // Cadeia de 8 paradas anteriores pela rede, ligada por retryOf (como as retomadas automáticas deixam).
    let prev: string | null = null;
    for (let i = 0; i < 8; i++) {
      const t = s.store.createTask({ clientId: `cadeia-${i}`, sessionId: first.sessionId, projectId: first.projectId, roomId: first.roomId, profileId: first.profileId, prompt: 'x', attachments: [], mode: 'queue', retryOf: prev });
      s.store.updateTask(t.id, { status: 'error', errors: [`Sem resposta da API do Claude: ${NET_TEXT}`] });
      prev = t.id;
    }
    const last = s.store.createTask({ clientId: 'cadeia-ultima', sessionId: first.sessionId, projectId: first.projectId, roomId: first.roomId, profileId: first.profileId, prompt: 'x', attachments: [], mode: 'queue', retryOf: prev });
    s.store.updateTask(last.id, { status: 'error', errors: [`Sem resposta da API do Claude: ${NET_TEXT}`] });
    (s.manager as unknown as { onProviderStop: (...a: unknown[]) => void }).onProviderStop(first.sessionId, s.store.getTask(last.id), { numTurns: 1 }, { kind: 'network', text: NET_TEXT }, 'claude');
    assert.equal(s.store.findTaskByClientId(`resume:${last.id}:2`), null, '9ª parada seguida: não retoma');
    assert.ok(s.notices(first.sessionId).some(n => /parou 9 vezes seguidas nesta tarefa: ela não volta sozinha/.test(n)));
  } finally { await s.cleanup(); }
});

test('esperando a resposta do Chefe o relógio da tarefa para: o limite não derruba a pergunta e volta a contar depois', async () => {
  const s = setup(2, 0.03); // limite de 1,8 s
  try {
    const r1 = await s.run('ask-1', 'one question please');
    await s.waitTask(t => t.id === r1.taskId && t.status === 'waiting_answer');
    await new Promise(r => setTimeout(r, 2600));
    assert.equal(s.store.getTask(r1.taskId)!.status, 'waiting_answer', 'a espera pelo Chefe não conta como tempo de trabalho');
    const pending = s.manager.pendingPermissions()[0];
    s.manager.answerQuestion(r1.sessionId, pending.request.requestId, { 'Which color do you prefer?': 'blue' });
    const done = await s.waitTask(t => t.id === r1.taskId && t.status === 'done');
    assert.equal(done.resultText, 'you chose blue');
    assert.ok(!done.errors.some(e => /Tempo máximo/.test(e)));
  } finally { await s.cleanup(); }
});

test('tempo máximo no meio do trabalho: continua UMA vez de onde parou na mesma conversa; na segunda vez para e avisa', async () => {
  const s = setup(2, 0.05); // limite de 3 s; o pedido "slow" escreve por 10 s
  try {
    const r1 = await s.run('slow-1', 'slow answer');
    const cut = await s.waitTask(t => t.id === r1.taskId && t.status === 'interrupted', 15_000);
    assert.ok(cut.errors.some(e => /^Tempo máximo de \d+ min atingido/.test(e)));
    const cont = s.store.findTaskByClientId(`resume:${r1.taskId}:2`)!;
    assert.ok(cont, 'continuação criada');
    assert.equal(cont.attempt, 1, 'não gasta tentativa'); assert.equal(cont.retryOf, r1.taskId); assert.equal(cont.sessionId, r1.sessionId);
    assert.match(cont.prompt, /^Continue a tarefa anterior de onde parou\. Ela foi interrompida pelo tempo máximo da HQ/);
    assert.match((s.store.getChatItem('user:' + cont.id) as { text: string }).text, /^Continuar de onde parou \(o tempo máximo/);
    await s.waitTask(t => t.id === cont.id && t.status === 'done');
    // Se a continuação também estourasse o tempo, não haveria uma terceira: a HQ para e avisa.
    s.store.updateTask(cont.id, { status: 'interrupted', errors: ['Tempo máximo de 25 min atingido; a HQ interrompeu a execução.'] });
    (s.manager as unknown as { onTaskTimeout: (...a: unknown[]) => void }).onTaskTimeout(r1.sessionId, s.store.getTask(cont.id), { numTurns: 3 });
    assert.equal(s.store.findTaskByClientId(`resume:${cont.id}:2`), null);
    assert.ok(s.notices(r1.sessionId).some(n => /passou do tempo máximo pela segunda vez seguida: ela não continua sozinha/.test(n)));
  } finally { await s.cleanup(); }
});
