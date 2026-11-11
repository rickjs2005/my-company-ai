// Linha de produção (08/11/2026): pedido em texto livre → plano da gerente → peças com etapas (pesquisa, roteiro, direção) →
// produção → revisão. Cada etapa é uma tarefa real e só passa adiante com o arquivo no disco. Também: plano inválido, etapa que
// falha e "Tentar a etapa de novo", e o pedido que nasce na conversa particular (bloco ```pedido-hq).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DM_SESSION_NAME, type Employee, type ServerMessage, type Task, type TaskRunInput, type TaskRunResult } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SocialService } from '../src/social/service.js';
import { MemoryVault } from '../src/social/vault.js';
import { ContentService } from '../src/content/service.js';
import { RoutineService } from '../src/routines.js';
import { parsePlan, stepsFor } from '../src/content/pipeline.js';
import { tempDir } from './tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(here, '..', '..', 'content-kit');

class FakeManager extends EventEmitter {
  runs: (TaskRunInput & { taskId: string })[] = [];
  constructor(public store: Store) { super(); }
  cancelQueued() { /* sem fila */ }
  setTaskLimit() { /* sem teto */ }
  updateEmployee(id: string, patch: Partial<Employee>) { return this.store.updateEmployee(id, patch); }
  createEmployee(input: { roomId: string; name?: string; role?: string; instructions?: string; permissionMode?: Employee['permissionMode']; provider?: Employee['provider']; skills?: string[]; template?: string | null; profileId?: string | null; access?: Employee['access'] }): Employee {
    const n = this.store.listEmployeesByRoom(input.roomId).length;
    return this.store.createEmployee({ name: input.name!, role: input.role ?? '', roomId: input.roomId, appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: n, instructions: input.instructions, permissionMode: input.permissionMode, provider: input.provider, skills: input.skills, template: input.template, profileId: input.profileId ?? null, access: input.access });
  }
  async runTask(input: TaskRunInput): Promise<TaskRunResult> {
    const e = this.store.getEmployee(input.employeeId)!;
    const s = this.store.listSessionsByEmployee(e.id).find(x => x.name !== DM_SESSION_NAME) ?? this.store.createSession({ roomId: e.roomId, projectId: input.projectId, employeeId: e.id, name: e.name, permissionMode: 'acceptEdits', workerName: e.name, appearance: e.appearance, deskIndex: e.deskIndex });
    const t = this.store.createTask({ clientId: input.clientId, sessionId: s.id, projectId: input.projectId, roomId: e.roomId, prompt: input.text, attachments: [], mode: 'send', employeeId: e.id, destinationId: input.destinationId ?? null });
    this.runs.push({ ...input, taskId: t.id });
    return { taskId: t.id, sessionId: s.id, employeeId: e.id, projectId: input.projectId, status: 'queued', queuePosition: 1, queueReason: null, newSession: false, applied: { model: null, effort: null, permissionMode: 'acceptEdits', source: 'teste' }, notes: [], duplicate: false };
  }
  finish(taskId: string, status: Task['status'] = 'done', resultText: string | null = null) { this.store.updateTask(taskId, { status, finishedAt: Date.now(), ...(resultText ? { resultText } : {}) }); this.emit('task_finished', taskId); }
}

function setup() {
  const dir = tempDir('hq-linha-');
  const db = openDb(path.join(dir, 'hq.sqlite'), { backupsDir: path.join(dir, 'backups') });
  const store = new Store(db); store.seedDefaultRooms();
  const log = { info: () => {}, warn: () => {} };
  const ok = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
  const social = new SocialService({ db, vault: new MemoryVault(), port: 4799, broadcast: () => {}, log, profileIds: () => store.listRooms().flatMap(r => r.profiles.map(p => p.id)), fetch: ok });
  const manager = new FakeManager(store);
  const routines = new RoutineService({ store, manager: manager as never, broadcast: () => {}, log });
  const content = new ContentService({
    db, store, manager, social, broadcast: (_m: ServerMessage) => {}, log, kitDir: KIT, defaultFolder: path.join(dir, 'hq-conteudos'), origins: [], siteDir: null, mirrors: [], trusted: () => true,
    routines: { handle: m => routines.handle(m), update: (id, patch) => routines.handle({ type: 'routine.update', reqId: 't', id, patch }) }, fetch: ok,
  });
  return { dir, store, manager, content };
}

async function until<T>(fn: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando a condição'); await new Promise(r => setTimeout(r, 50)); }
}

const ACTIVE = ['instagram-tuco', 'instagram-aurora', 'threads'] as const;
const CTX = { activeSlots: [...ACTIVE], today: '2026-11-08', tomorrow: '2026-11-09', formatsFor: (s: string) => (s === 'threads' ? ['texto' as const] : ['video' as const, 'carrossel' as const]) };

test('plano.json: só conta ativa e formato possível; data no passado vira amanhã; sem resumo é recusado', () => {
  const r = parsePlan({
    resumo: 'Um Reel e um post.',
    pecas: [
      { titulo: 'O que é uma API', conta: 'instagram-tuco', formato: 'Reel', data: '2026-11-01', pesquisa: true, gancho: 'Você usa API todo dia' },
      { titulo: 'Bastidor', conta: 'threads', formato: 'post', data: '2026-11-09' },
      { titulo: 'TikTok', conta: 'tiktok', formato: 'video' },
      { titulo: 'Pin', conta: 'instagram-aurora', formato: 'pin' },
    ],
    perguntas: ['Qual voz?'],
  }, CTX);
  assert.ok(r.ok);
  assert.equal(r.value.pieces.length, 2);
  assert.equal(r.value.pieces[0].format, 'video'); assert.equal(r.value.pieces[0].date, '2026-11-09'); assert.equal(r.value.pieces[0].research, true);
  assert.equal(r.value.pieces[1].format, 'texto');
  assert.equal(r.value.left.length, 2); assert.match(r.value.left.join(' '), /tiktok/); assert.match(r.value.warnings.join(' '), /no passado/);
  assert.deepEqual(r.value.questions, ['Qual voz?']);
  assert.equal(parsePlan({ pecas: [] }, CTX).ok, false);
  assert.deepEqual(stepsFor('video', true), ['pesquisa', 'roteiro', 'direcao']);
  assert.deepEqual(stepsFor('carrossel', false), []);
});

test('pedido à gerente → plano → pesquisa → roteiro → direção → produção, cada etapa com o arquivo no disco', async () => {
  const { manager, content, store } = setup();
  await content.setup();
  await content.handle({ type: 'content.focus.save', reqId: 'f', activeSlots: [...ACTIVE], sources: null } as never);
  const r = await content.handle({ type: 'content.manager.ask', reqId: 'r', text: 'Equipe, preparem um Reel educativo para o Tuco Dev explicando o que é uma API, com animação, narração e CTA para seguir.' }) as { requestId: string };
  const planRun = manager.runs[manager.runs.length - 1];
  const marina = store.getEmployee(planRun.employeeId)!;
  assert.match(marina.role, /Coordena/);
  assert.match(planRun.text, /plano\.json/); assert.match(planRun.text, /Reel educativo/); assert.match(planRun.text, /manual-da-agencia/);
  const req0 = content.state().requests.find(x => x.id === r.requestId)!;
  assert.equal(req0.plan?.status, 'planejando');
  fs.writeFileSync(req0.plan!.file!, JSON.stringify({ resumo: 'Um Reel com garçom levando o pedido: pesquisa curta, roteiro, direção e edição.', pecas: [{ titulo: 'O que é uma API (garçom)', conta: 'instagram-tuco', formato: 'video', data: '2026-11-09', objetivo: 'crescer', publico: 'iniciantes', gancho: 'Você usa API todo dia', cta: 'Siga o Tuco', metrica: 'envios por alcance', briefing: 'Explicar API com garçom', pesquisa: true }], perguntas: [] }));
  manager.finish(planRun.taskId);
  const item = await until(() => content.state().items.find(i => i.requestId === r.requestId && i.pipeline));
  assert.deepEqual(item.pipeline!.steps.map(s => s.key), ['pesquisa', 'roteiro', 'direcao']);
  const req1 = await until(() => { const x = content.state().requests.find(y => y.id === r.requestId); return x?.plan?.status === 'pronto' ? x : null; });
  assert.deepEqual(req1.plan!.itemIds, [item.id]);

  const doStep = async (key: 'pesquisa' | 'roteiro' | 'direcao', file: string, who: RegExp) => {
    const it = await until(() => { const x = content.state().items.find(i => i.id === item.id)!; const st = x.pipeline!.steps.find(s => s.key === key)!; return st.status === 'fazendo' ? x : null; });
    const run = manager.runs[manager.runs.length - 1];
    assert.match(store.getEmployee(run.employeeId)!.role, who);
    assert.match(run.text, new RegExp(file.replace('.', '\\.')));
    fs.writeFileSync(path.join(it.folder!, file), `# ${key}\n\n${'conteúdo de verdade da etapa. '.repeat(20)}`);
    fs.writeFileSync(path.join(it.folder!, 'etapas', `${key}.json`), JSON.stringify({ resumo: `${key} feita`, arquivos: [file], pendencias: [] }));
    manager.finish(run.taskId);
    await until(() => content.state().items.find(i => i.id === item.id)!.pipeline!.steps.find(s => s.key === key)!.status === 'feito');
  };
  await doStep('pesquisa', 'pesquisa.md', /Pesquisador/);
  await doStep('roteiro', 'roteiro.md', /Criação/);
  await doStep('direcao', 'direcao.md', /Diretor/);
  // Todas feitas: a produção final entra na fila com o roteiro e a direção no pedido.
  const prod = await until(() => { const x = content.state().items.find(i => i.id === item.id)!; return x.status === 'em_producao' ? x : null; });
  const run = manager.runs.find(x => x.taskId === prod.taskId)!;
  assert.match(store.getEmployee(run.employeeId)!.role, /Edição de vídeo/);
  assert.match(run.text, /Etapas já feitas pela equipe/); assert.match(run.text, /roteiro\.md/); assert.match(run.text, /direcao\.md/);
});

test('etapa sem o arquivo falha com o motivo; "Tentar a etapa de novo" pede outra vez e a linha segue', async () => {
  const { manager, content } = setup();
  await content.setup();
  await content.handle({ type: 'content.focus.save', reqId: 'f', activeSlots: [...ACTIVE], sources: null } as never);
  const r = await content.handle({ type: 'content.manager.ask', reqId: 'r', text: 'Um Reel do Tuco sobre JSON.' }) as { requestId: string };
  const req = content.state().requests.find(x => x.id === r.requestId)!;
  fs.writeFileSync(req.plan!.file!, JSON.stringify({ resumo: 'Um Reel.', pecas: [{ titulo: 'JSON em 20 s', conta: 'instagram-tuco', formato: 'video' }] }));
  manager.finish(manager.runs[manager.runs.length - 1].taskId);
  const item = await until(() => content.state().items.find(i => i.requestId === r.requestId && i.pipeline?.steps[0].status === 'fazendo'));
  assert.equal(item.pipeline!.steps[0].key, 'roteiro');
  manager.finish(manager.runs[manager.runs.length - 1].taskId); // terminou sem gravar nada
  const failed = await until(() => { const x = content.state().items.find(i => i.id === item.id)!; return x.pipeline!.steps[0].status === 'falhou' ? x : null; });
  assert.match(failed.pipeline!.steps[0].error!, /roteiro|etapas/); assert.match(failed.nextStep!, /Tentar a etapa de novo/);
  const before = manager.runs.length;
  await content.handle({ type: 'content.item.step.retry', reqId: 'x', id: item.id });
  assert.equal(manager.runs.length, before + 1);
  assert.equal(content.state().items.find(i => i.id === item.id)!.pipeline!.steps[0].status, 'fazendo');
});

test('conversa particular: o bloco ```pedido-hq vira pedido para a gerente; resposta sem o bloco não cria nada', async () => {
  const { manager, content, store } = setup();
  await content.setup();
  await content.handle({ type: 'content.focus.save', reqId: 'f', activeSlots: [...ACTIVE], sources: null } as never);
  const vitor = store.listEmployees().find(e => /Diretor/.test(e.role)) ?? store.listEmployees()[0];
  const proj = store.listProjects()[0];
  const dm = store.createSession({ roomId: vitor.roomId, projectId: proj.id, employeeId: vitor.id, name: DM_SESSION_NAME, permissionMode: 'acceptEdits', workerName: vitor.name, appearance: vitor.appearance, deskIndex: vitor.deskIndex });
  const chat = store.createTask({ clientId: 'dm1', sessionId: dm.id, projectId: proj.id, roomId: vitor.roomId, prompt: 'oi, tudo bem?', attachments: [], mode: 'send', employeeId: vitor.id, destinationId: null });
  const n0 = content.state().requests.length;
  manager.finish(chat.id, 'done', 'Tudo certo por aqui.');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(content.state().requests.length, n0);
  const ask = store.createTask({ clientId: 'dm2', sessionId: dm.id, projectId: proj.id, roomId: vitor.roomId, prompt: 'faz um Reel estilo trailer do projeto Olaria', attachments: [], mode: 'send', employeeId: vitor.id, destinationId: null });
  manager.finish(ask.id, 'done', 'Fechado, vou passar para a Marina.\n\n```pedido-hq\n{"pedido": "Reel estilo trailer do projeto Olaria para o Instagram da Aurora"}\n```');
  const req = await until(() => content.state().requests.find(x => x.plan && /Olaria/.test(x.note ?? '')));
  assert.match(req.note!, /conversa particular do Chefe com/);
  assert.equal(req.plan!.status, 'planejando');
});

test('pedido geral por equipe (08/11): só Tuco Dev → só a conta dele; as duas → peças separadas por equipe no plano', async () => {
  const { manager, content } = setup();
  await content.setup();
  await content.handle({ type: 'content.focus.save', reqId: 'f', activeSlots: [...ACTIVE], sources: null } as never);
  const one = await content.handle({ type: 'content.manager.ask', reqId: 'r1', text: 'Um carrossel sobre Git', teams: ['tuco-dev'] }) as { requestId: string };
  const run1 = manager.runs[manager.runs.length - 1].text;
  assert.deepEqual(content.state().requests.find(x => x.id === one.requestId)!.slots, ['instagram-tuco'], 'só a conta da equipe escolhida entra no plano');
  assert.match(run1, /Equipe Tuco Dev: Instagram Tuco Dev/);
  assert.doesNotMatch(run1, /Equipe Aurora:/);
  const both = await content.handle({ type: 'content.manager.ask', reqId: 'r2', text: 'Conteúdos de amanhã', teams: ['aurora', 'tuco-dev'] }) as { requestId: string };
  const run2 = manager.runs[manager.runs.length - 1].text;
  assert.deepEqual([...content.state().requests.find(x => x.id === both.requestId)!.slots].sort(), ['instagram-aurora', 'instagram-tuco', 'threads']);
  assert.match(run2, /Equipe Aurora: Instagram Aurora \+ Threads Aurora/);
  assert.match(run2, /cada peça é de UMA equipe, com briefing e entrega próprios/);
});
