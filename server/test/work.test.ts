// Testes da v4: entrada única de tarefa (task.run), skill pedida x confirmada, fila durável, recuperação após queda,
// modo ausente, pausa de novas tarefas, funcionário OpenAI pelo Codex (falso) e resumo de ausência.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage, SkillInfo, Task } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager, type SkillResolverLike } from '../src/sessions.js';
import { CodexAdapter } from '../src/ai/codex/adapter.js';
import { ClaudeAdapter } from '../src/ai/claude/adapter.js';
import type { AiAdapter } from '../src/ai/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.resolve(here, '..', '..', 'packages', 'claude-bridge', 'test', 'fake-claude.mjs');
const fakeCodex = path.join(here, 'fake-codex.mjs');

function skillInfo(invocation: string, extra: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: `personal:${invocation}`, invocation, name: invocation, description: 'skill de teste', whenToUse: null, argumentHint: null, arguments: [], source: 'personal', path: `C:/fake/${invocation}/SKILL.md`, plugin: null, projectId: null,
    disabled: false, override: 'on', modelInvocable: true, userInvocable: true, allowedTools: [], model: null, effort: null, forks: false, hasShellInjection: false, shadowedBy: null,
    providers: { claude: { mode: 'native', detail: 'invocação /nome no início da mensagem' }, openai: { mode: 'inject', detail: 'o Codex 0.58.0 não tem mecanismo de skills; o manual vai como texto' } },
    verified: null, problems: [], kind: 'skill', ...extra,
  };
}

const skills: SkillResolverLike = {
  async resolve(invocation) {
    if (invocation === 'hq-fake-skill') return { info: skillInfo('hq-fake-skill'), content: '# hq-fake-skill\nManual de teste.' };
    if (invocation === 'skill-sem-lista') return { info: skillInfo('skill-sem-lista'), content: '# skill-sem-lista' };
    if (invocation === 'skill-off') return { info: skillInfo('skill-off', { disabled: true, override: 'off' }), content: null };
    return null;
  },
};

function setup(opts: { ai?: { get(p: 'claude' | 'openai'): AiAdapter }; roomProject?: (roomId: string) => string | null } = {}) {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.seedDefaultRooms();
  const projDir = tempDir('hq-proj-');
  const attachmentsDir = tempDir('hq-att-');
  const room = store.listRooms()[0];
  const project = store.createProject({ name: 'Projeto teste', path: projDir, roomId: room.id });
  const manager = new SessionManager({ store, exePath: () => process.execPath, attachmentsDir, commandPrefixArgs: [fakeClaude], skills, ai: opts.ai, roomProject: opts.roomProject });
  const msgs: ServerMessage[] = [];
  manager.on('broadcast', m => msgs.push(m));
  const waitFor = (pred: (m: ServerMessage) => boolean, ms = 8000) => new Promise<ServerMessage>((resolve, reject) => {
    const found = msgs.find(pred); if (found) return resolve(found);
    const t = setTimeout(() => reject(new Error('timeout esperando mensagem')), ms);
    const h = (m: ServerMessage) => { if (pred(m)) { clearTimeout(t); manager.off('broadcast', h); resolve(m); } };
    manager.on('broadcast', h);
  });
  const waitTask = (id: string, status: Task['status'], ms = 8000) => waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as Task).id === id && (m.item as Task).status === status, ms);
  const run = (over: Partial<Parameters<SessionManager['runTask']>[0]>) => manager.runTask({ reqId: 'r', clientId: `c-${Math.random().toString(36).slice(2)}`, text: 'hello world', projectId: project.id, employeeId: '', skill: null, plan: false, ...over });
  return { db, store, manager, room, project, msgs, waitFor, waitTask, run, cleanup: async () => { await manager.shutdown(); fs.rmSync(projDir, { recursive: true, force: true }); fs.rmSync(attachmentsDir, { recursive: true, force: true }); } };
}

test('task.run: valida com mensagens específicas; abre a conversa do funcionário no projeto e a reaproveita; mesmo clientId não duplica', async () => {
  const s = setup();
  try {
    const leo = s.manager.createEmployee({ roomId: s.room.id, name: 'Léo' });
    await assert.rejects(s.run({ text: '   ', employeeId: leo.id }), /Escreva o que vamos fazer/);
    await assert.rejects(s.run({ employeeId: leo.id, projectId: '' }), /Escolha um projeto/);
    await assert.rejects(s.run({ employeeId: '' }), /Escolha um funcionário/);
    await assert.rejects(s.run({ employeeId: 'nao-existe' }), /não existe mais/);
    const r1 = await s.run({ clientId: 'run-1', employeeId: leo.id });
    assert.equal(r1.employeeId, leo.id); assert.equal(r1.projectId, s.project.id); assert.equal(r1.newSession, true); assert.equal(r1.duplicate, false);
    assert.equal(r1.status, 'running', 'sem fila: começa na hora');
    assert.equal(r1.queuePosition, null);
    assert.equal(s.manager.listEmployees()[0].activeSessionId, r1.sessionId);
    const dup = await s.run({ clientId: 'run-1', employeeId: leo.id, text: 'outra coisa' });
    assert.equal(dup.taskId, r1.taskId); assert.equal(dup.duplicate, true);
    assert.equal(s.store.listTasks().length, 1, 'duplo clique/reconexão não cria segunda tarefa');
    await s.waitTask(r1.taskId, 'done');
    const t1 = s.store.getTask(r1.taskId)!;
    assert.equal(t1.origin, 'composer'); assert.equal(t1.employeeId, leo.id); assert.equal(t1.provider, 'claude'); assert.equal(t1.skill, null);
    assert.equal(t1.applied?.source, 'padrão global');
    const r2 = await s.run({ clientId: 'run-2', employeeId: leo.id, text: 'segunda' });
    assert.equal(r2.sessionId, r1.sessionId, 'mesmo projeto: reaproveita a conversa');
    assert.equal(r2.newSession, false);
    await s.waitTask(r2.taskId, 'done');
    assert.equal(s.store.getChatItem('user:' + r2.taskId)!.kind, 'user');
    // Outro projeto: conversa nova para o mesmo funcionário; a antiga continua existindo.
    const dir2 = tempDir('hq-proj2-');
    try {
      const p2 = s.store.createProject({ name: 'Projeto 2', path: dir2, roomId: s.room.id });
      const r3 = await s.run({ clientId: 'run-3', employeeId: leo.id, projectId: p2.id });
      assert.notEqual(r3.sessionId, r1.sessionId); assert.equal(r3.newSession, true);
      await s.waitTask(r3.taskId, 'done');
      assert.equal(s.store.listSessionsByEmployee(leo.id).length, 2);
      assert.equal(s.manager.listEmployees().length, 1, 'não contrata ninguém');
      await s.manager.closeSession(r3.sessionId); // Windows: a pasta só pode ser removida depois que o processo que roda nela encerra
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { await s.cleanup(); }
});

test('task.run com skill: invocação /nome vai primeiro; confirmação vem da lista do init (listed / not_listed); skill desligada é recusada', async () => {
  const s = setup();
  try {
    const leo = s.manager.createEmployee({ roomId: s.room.id, name: 'Léo' });
    await assert.rejects(s.run({ employeeId: leo.id, skill: 'inexistente' }), /não foi encontrada/);
    await assert.rejects(s.run({ employeeId: leo.id, skill: 'skill-off' }), /desativada/);
    const r1 = await s.run({ clientId: 'sk-1', employeeId: leo.id, skill: 'hq-fake-skill', text: 'crie a landing' });
    const t1 = s.store.getTask(r1.taskId)!;
    assert.ok(t1.prompt.startsWith('/hq-fake-skill crie a landing'), `prompt enviado: ${t1.prompt}`);
    assert.equal(s.store.getChatItem('user:' + t1.id)!.kind === 'user' && (s.store.getChatItem('user:' + t1.id) as { text: string }).text, 'crie a landing', 'o chat mostra o que o Chefe escreveu');
    assert.equal(t1.skill?.requested, 'hq-fake-skill'); assert.equal(t1.skill?.delivery, 'native');
    await s.waitTask(r1.taskId, 'done');
    const done1 = s.store.getTask(r1.taskId)!;
    assert.equal(done1.skill?.confirmation, 'listed', 'o init do CLI falso lista hq-fake-skill');
    assert.match(done1.skill?.evidence ?? '', /consta na lista de skills do init/);
    assert.deepEqual(s.store.getProviderCaps(s.project.id, 'claude')!.caps.skills, ['hq-fake-skill', 'sistema-web'], 'capacidades do init guardadas por projeto');
    assert.ok(s.msgs.some(m => m.kind === 'skills.changed'));
    // Skill resolvida no catálogo mas que o processo não listou: fica "not_listed" e avisa.
    const r2 = await s.run({ clientId: 'sk-2', employeeId: leo.id, skill: 'skill-sem-lista', text: 'teste' });
    await s.waitTask(r2.taskId, 'done');
    const done2 = s.store.getTask(r2.taskId)!;
    assert.equal(done2.skill?.confirmation, 'not_listed');
    assert.ok(s.store.listChat(r2.sessionId).some(c => c.kind === 'notice' && /não apareceu na lista/.test((c as { text: string }).text)));
  } finally { await s.cleanup(); }
});

test('task.run "planejar antes": a conversa vai para o modo plano e o próximo pedido normal restaura o modo do funcionário', async () => {
  const s = setup();
  try {
    const leo = s.manager.createEmployee({ roomId: s.room.id, name: 'Léo', permissionMode: 'acceptEdits' });
    const r1 = await s.run({ clientId: 'pl-1', employeeId: leo.id, plan: true, text: 'refatorar o menu' });
    assert.equal(s.store.getSession(r1.sessionId)!.permissionMode, 'plan');
    assert.equal(r1.applied.permissionMode, 'plan');
    assert.ok(s.store.getTask(r1.taskId)!.prompt.startsWith('[Planejar antes]'));
    assert.ok(r1.notes.some(n => /modo plano/.test(n)));
    await s.waitTask(r1.taskId, 'done');
    const r2 = await s.run({ clientId: 'pl-2', employeeId: leo.id, text: 'agora executa' });
    assert.equal(s.store.getSession(r2.sessionId)!.permissionMode, 'acceptEdits', 'volta ao modo do funcionário');
    await s.waitTask(r2.taskId, 'done');
    // Opções explícitas: esforço inválido para o modelo é recusado com explicação, nunca trocado em silêncio.
    const claude = new ClaudeAdapter({ log: { info() {}, warn() {}, error() {}, debug() {} } as never });
    const s2 = setup({ ai: { get: () => claude } });
    try {
      const e = s2.manager.createEmployee({ roomId: s2.room.id, name: 'Ana' });
      await assert.rejects(s2.run({ employeeId: e.id, options: { model: 'modelo-inventado' } }), /Configuração não aceita/);
      await assert.rejects(s2.run({ employeeId: e.id, options: { effort: 'max' } }), /Configuração não aceita/);
    } finally { await s2.cleanup(); }
  } finally { await s.cleanup(); }
});

test('fila durável: tarefa na fila sobrevive ao reinício; tarefa que rodava com arquivo tocado vira "resultado a conferir" e não reexecuta sozinha', async () => {
  const s = setup();
  try {
    const leo = s.manager.createEmployee({ roomId: s.room.id, name: 'Léo' });
    const session = s.manager.createSession({ roomId: s.room.id, projectId: s.project.id, employeeId: leo.id });
    // Simula o estado deixado por um serviço que caiu: uma tarefa rodando (com arquivo tocado) e uma na fila.
    const running = s.store.createTask({ clientId: 'q-run', sessionId: session.id, projectId: s.project.id, roomId: s.room.id, prompt: 'escreve o arquivo', attachments: [], mode: 'queue', employeeId: leo.id });
    s.store.updateTask(running.id, { status: 'running', startedAt: Date.now(), touchedFiles: ['C:/x/a.txt'] });
    const queued = s.store.createTask({ clientId: 'q-wait', sessionId: session.id, projectId: s.project.id, roomId: s.room.id, prompt: 'depois', attachments: [], mode: 'queue', employeeId: leo.id });
    s.store.updateSession(session.id, { status: 'active' });
    const again = new SessionManager({ store: s.store, exePath: () => process.execPath, attachmentsDir: os.tmpdir(), commandPrefixArgs: [fakeClaude] });
    again.reconcileOnStart();
    const r = s.store.getTask(running.id)!;
    assert.equal(r.status, 'lost'); assert.equal(r.review, 'to_verify');
    assert.equal(s.store.findTaskByClientId(`retry:${running.id}:2`), null, 'pode ter alterado arquivo: NÃO reexecuta sozinha');
    assert.equal(s.store.getTask(queued.id)!.status, 'queued', 'a fila sobrevive ao reinício');
    assert.equal(s.store.getSession(session.id)!.status, 'new');
    await assert.rejects(again.retryTask(running.id), /confira o resultado/);
    again.markVerified(running.id);
    assert.equal(s.store.getTask(running.id)!.review, 'verified');
    const retry = await again.retryTask(running.id);
    assert.equal(retry.attempt, 2); assert.equal(retry.retryOf, running.id); assert.equal(retry.origin, 'retry');
    await again.shutdown();
  } finally { await s.cleanup(); }
});

test('modo ausente: só projetos autorizados continuam; o resto fica "Aguardando Chefe" e volta quando o modo desliga; pausa de novas tarefas segura a fila', async () => {
  const s = setup();
  try {
    const leo = s.manager.createEmployee({ roomId: s.room.id, name: 'Léo' });
    s.store.saveSettings({ absence: { enabled: true, allowedProjectIds: [], allowedEmployeeIds: [], maxTasks: 10, maxTaskMinutes: 90, maxAttempts: 2, since: Date.now(), allowRoutines: true } });
    const r1 = await s.run({ clientId: 'ab-1', employeeId: leo.id });
    const held = s.store.getTask(r1.taskId)!;
    assert.equal(held.status, 'queued'); assert.equal(held.held, true); assert.match(held.heldReason ?? '', /^Modo ausente:/);
    assert.equal(s.manager.queueInfo(held).reason, held.heldReason);
    assert.ok(s.store.listChat(r1.sessionId).some(c => c.kind === 'notice' && /Aguardando Chefe/.test((c as { text: string }).text)));
    // Autoriza o projeto: a tarefa segurada pela ausência é liberada ao desligar o modo (ou pode ser liberada à mão).
    s.store.saveSettings({ absence: { ...s.store.getSettings().absence, enabled: false } });
    s.manager.dispatch();
    await s.waitTask(r1.taskId, 'done');
    assert.equal(s.store.getTask(r1.taskId)!.held, false);
    // Pausa de novas tarefas.
    s.store.saveSettings({ pauseNewTasks: true });
    const r2 = await s.run({ clientId: 'ab-2', employeeId: leo.id, text: 'pausada' });
    assert.equal(r2.status, 'queued'); assert.match(r2.queueReason ?? '', /pausadas/);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(s.store.getTask(r2.taskId)!.status, 'queued');
    s.store.saveSettings({ pauseNewTasks: false });
    s.manager.dispatch();
    await s.waitTask(r2.taskId, 'done');
    // Resumo de ausência: só fatos registrados.
    const summary = s.manager.awaySummary(0);
    assert.equal(summary.done.length, 2); assert.equal(summary.queued.length, 0); assert.equal(summary.waiting.length, 0);
    assert.equal(summary.done[0].employee, 'Léo'); assert.equal(summary.done[0].project, 'Projeto teste');
  } finally { await s.cleanup(); }
});

test('funcionário OpenAI: a tarefa roda no Codex (falso), a resposta tem autoria openai, a thread fica na conversa e o chat registra o modo análise', async () => {
  const codex = new CodexAdapter({ exePath: process.execPath, commandPrefixArgs: [fakeCodex], env: { FAKE_CODEX_LOGGED_IN: '1' } });
  const s = setup({ ai: { get: () => codex } });
  try {
    await codex.refresh();
    const gpt = s.manager.createEmployee({ roomId: s.room.id, name: 'Gepeto', provider: 'openai' });
    assert.equal(gpt.provider, 'openai');
    const r1 = await s.run({ clientId: 'oa-1', employeeId: gpt.id, text: 'Diga oi', skill: 'hq-fake-skill' });
    assert.ok(r1.notes.some(n => /modo análise/.test(n)));
    assert.ok(r1.notes.some(n => /entregue como texto/.test(n)));
    const t = s.store.getTask(r1.taskId)!;
    assert.equal(t.provider, 'openai'); assert.equal(t.skill?.delivery, 'inject'); assert.equal(t.skill?.confirmation, 'unknown');
    assert.ok(t.prompt.includes('Manual de teste.'), 'o conteúdo da skill vai como texto identificado');
    assert.equal(s.store.getSession(r1.sessionId)!.provider, 'openai');
    await s.waitTask(r1.taskId, 'done');
    const chat = s.store.listChat(r1.sessionId);
    const answer = chat.find(c => c.kind === 'assistant') as { text: string; author?: string } | undefined;
    assert.ok(answer); assert.equal(answer!.author, 'openai'); assert.match(answer!.text, /Resposta falsa do Codex/);
    assert.ok(chat.some(c => c.kind === 'notice' && /modo análise/.test((c as { text: string }).text)));
    assert.match(s.store.getSession(r1.sessionId)!.threadId ?? '', /^thread-/);
    assert.equal(s.store.getTask(r1.taskId)!.applied?.source.includes('modo análise do Codex'), true);
    assert.equal(s.manager.listWorkers()[0].status, 'idle');
    // Segundo turno retoma a thread.
    const r2 = await s.run({ clientId: 'oa-2', employeeId: gpt.id, text: 'De novo' });
    assert.equal(r2.sessionId, r1.sessionId);
    await s.waitTask(r2.taskId, 'done');
    const stats = await codex.rpc<{ threadsStarted: number; threadsResumed: number }>('fake/stats', {});
    assert.equal(stats.threadsStarted, 1); assert.equal(stats.threadsResumed, 1);
    // Sem login: recusa com a orientação certa, sem fila fantasma.
    const codexOff = new CodexAdapter({ exePath: process.execPath, commandPrefixArgs: [fakeCodex], env: { FAKE_CODEX_LOGGED_IN: '0' } });
    const s2 = setup({ ai: { get: () => codexOff } });
    try {
      await codexOff.refresh();
      const e = s2.manager.createEmployee({ roomId: s2.room.id, name: 'Gepeto', provider: 'openai' });
      await assert.rejects(s2.run({ employeeId: e.id }), /sem login no Codex/);
    } finally { await s2.cleanup(); await codexOff.shutdown(); }
  } finally { await s.cleanup(); await codex.shutdown(); }
});

test('esforço trocado pela tarefa numa conversa ociosa: a tarefa sobe processo novo com --effort e a saída do antigo não a atrapalha', async () => {
  const s = setup();
  try {
    const leo = s.manager.createEmployee({ roomId: s.room.id, name: 'Léo' });
    const r1 = await s.run({ clientId: 'ef-1', employeeId: leo.id, text: 'primeira' });
    await s.waitTask(r1.taskId, 'done');
    // Processo ocioso vivo; a tarefa pede outro esforço. Antes: "processo não está disponível para escrita" e a tarefa falhava.
    const r2 = await s.run({ clientId: 'ef-2', employeeId: leo.id, text: 'ARGS', options: { effort: 'high' } });
    assert.equal(r2.sessionId, r1.sessionId);
    const done = await s.waitFor(m => m.kind === 'entity' && m.entity === 'task' && (m.item as Task).id === r2.taskId && ['done', 'error', 'lost'].includes((m.item as Task).status));
    const t2 = done.kind === 'entity' ? done.item as Task : null;
    assert.equal(t2?.status, 'done', `tarefa terminou como ${t2?.status}: ${t2?.errors.join(' | ')}`);
    assert.match(t2?.resultText ?? '', /--effort high/, 'o processo novo nasceu com o esforço pedido');
    assert.match(t2?.resultText ?? '', /--resume/, 'e retomou a mesma conversa');
    // Uma tarefa seguinte na mesma conversa continua funcionando (a saída atrasada do processo antigo não zerou nada).
    const r3 = await s.run({ clientId: 'ef-3', employeeId: leo.id, text: 'terceira' });
    await s.waitTask(r3.taskId, 'done');
  } finally { await s.cleanup(); }
});

test('sala Social Media: o perfil do topo vai com a tarefa; fora da sala vira aviso; entrega concluída pode ser marcada como revisada', async () => {
  const s = setup();
  const dir = tempDir('hq-social-');
  try {
    const social = s.store.listRooms().find(r => r.kind === 'social')!;
    const proj = s.store.createProject({ name: 'Conteúdo', path: dir, roomId: social.id });
    const lia = s.manager.createEmployee({ roomId: social.id, name: 'Lia' });
    const r = await s.run({ clientId: 'soc-1', employeeId: lia.id, projectId: proj.id, profileId: 'tuco-dev', text: '[Destino: Instagram] Roteiro de reels' });
    assert.equal(s.store.getTask(r.taskId)!.profileId, 'tuco-dev');
    assert.equal(s.store.getSession(r.sessionId)!.profileId, 'tuco-dev');
    await s.waitTask(r.taskId, 'done');
    assert.notEqual(s.store.getTask(r.taskId)!.review, 'verified');
    s.manager.markVerified(r.taskId);
    assert.equal(s.store.getTask(r.taskId)!.review, 'verified', 'entrega concluída vira "revisada" (nada é publicado)');
    // Funcionário de outra sala: o perfil não existe lá; o pedido segue sem perfil e com aviso.
    const leo = s.manager.createEmployee({ roomId: s.room.id, name: 'Léo' });
    const r2 = await s.run({ clientId: 'soc-2', employeeId: leo.id, profileId: 'aurora' });
    assert.ok(r2.notes.some(n => /só existe na sala Social Media/.test(n)), r2.notes.join(' | '));
    assert.equal(s.store.getTask(r2.taskId)!.profileId ?? null, null);
    await s.waitTask(r2.taskId, 'done');
    // Tarefa ainda rodando não vira "revisada".
    const r3 = await s.run({ clientId: 'soc-3', employeeId: lia.id, projectId: proj.id, profileId: 'tuco-dev' });
    s.manager.markVerified(r3.taskId);
    assert.notEqual(s.store.getTask(r3.taskId)!.review, 'verified');
    await s.waitTask(r3.taskId, 'done');
  } finally { await s.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sala travada (05/11): funcionário da Social Media com outra pasta escolhida trabalha na pasta de conteúdo; outra sala segue o pedido', async () => {
  let contentId: string | null = null;
  const s = setup({ roomProject: roomId => (s.store.getRoom(roomId)?.kind === 'social' ? contentId : null) });
  const dir = tempDir('hq-conteudo-');
  try {
    const social = s.store.listRooms().find(r => r.kind === 'social')!;
    const conteudo = s.store.createProject({ name: 'Conteúdos Aurora', path: dir, roomId: social.id });
    contentId = conteudo.id;
    const bia = s.manager.createEmployee({ roomId: social.id, name: 'Bia' });
    // O caso de 05/11: o campo lembrava a pasta da HQ (aqui, "Projeto teste") e a entrega caiu no código.
    const r = await s.run({ clientId: 'lock-1', employeeId: bia.id, projectId: s.project.id, contextFiles: ['notas.md'] });
    assert.equal(s.store.getTask(r.taskId)!.projectId, conteudo.id, 'a tarefa vai para a pasta de conteúdo');
    assert.equal(s.store.getSession(r.sessionId)!.projectId, conteudo.id);
    assert.ok(r.notes.some(n => /trabalha sempre na pasta "Conteúdos Aurora".*não para "Projeto teste"/.test(n)), r.notes.join(' | '));
    assert.ok(r.notes.some(n => /referência .*outra pasta/.test(n)), 'arquivos de contexto da outra pasta ficam de fora, com aviso');
    await s.waitTask(r.taskId, 'done');
    // Já na pasta certa: nenhum aviso.
    const ok = await s.run({ clientId: 'lock-2', employeeId: bia.id, projectId: conteudo.id });
    assert.ok(!ok.notes.some(n => /trabalha sempre na pasta/.test(n)), ok.notes.join(' | '));
    await s.waitTask(ok.taskId, 'done');
    // Funcionário de outra sala: o projeto do pedido vale.
    const leo = s.manager.createEmployee({ roomId: s.room.id, name: 'Léo' });
    const r2 = await s.run({ clientId: 'lock-3', employeeId: leo.id, projectId: s.project.id });
    assert.equal(s.store.getTask(r2.taskId)!.projectId, s.project.id);
    await s.waitTask(r2.taskId, 'done');
    // Sala ainda sem pasta de conteúdo preparada: nada é travado.
    contentId = null;
    const r3 = await s.run({ clientId: 'lock-4', employeeId: bia.id, projectId: s.project.id });
    assert.equal(s.store.getTask(r3.taskId)!.projectId, s.project.id);
    await s.waitTask(r3.taskId, 'done');
  } finally { await s.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('perfil por tarefa: com tarefas de marcas diferentes na fila do mesmo funcionário, cada uma recebe o perfil dela', async () => {
  const s = setup();
  const dir = tempDir('hq-social-fila-');
  try {
    const social = s.store.listRooms().find(r => r.kind === 'social')!;
    const proj = s.store.createProject({ name: 'Conteúdo', path: dir, roomId: social.id });
    const otto = s.manager.createEmployee({ roomId: social.id, name: 'Otto' });
    // Fila pausada: as três ficam esperando e o perfil da conversa termina como o da última criada (Tuco).
    s.store.saveSettings({ pauseNewTasks: true });
    const a = await s.run({ clientId: 'pf-a', employeeId: otto.id, projectId: proj.id, profileId: 'tuco-dev', text: 'revisar A' });
    const b = await s.run({ clientId: 'pf-b', employeeId: otto.id, projectId: proj.id, profileId: 'aurora', text: 'revisar B' });
    const c = await s.run({ clientId: 'pf-c', employeeId: otto.id, projectId: proj.id, profileId: 'tuco-dev', text: 'revisar C' });
    s.store.saveSettings({ pauseNewTasks: false });
    s.manager.dispatch();
    await s.waitTask(c.taskId, 'done', 15000);
    const text = (id: string) => s.store.getTask(id)!.resultText ?? '';
    // A primeira sobe o processo com o perfil da conversa (Tuco) nas instruções: sem aviso de troca.
    assert.doesNotMatch(text(a.taskId), /Perfil editorial a partir desta mensagem/);
    assert.match(text(b.taskId), /Perfil editorial a partir desta mensagem: Aurora/, 'a tarefa da Aurora recebe o perfil dela, não o da última criada');
    assert.match(text(c.taskId), /Perfil editorial a partir desta mensagem: Tuco Dev/);
    assert.equal(s.store.getSession(c.sessionId)!.profileId, 'tuco-dev');
  } finally { await s.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});
