// Conhecimento da equipe (10/11/2026): orientação persistida, recuperada por escopo no pedido da tarefa, com versão e uso
// registrados. Todos os testes usam o CLI falso (ele devolve "echo: <pedido recebido>", então dá para ver o que chegou ao executor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDirective, readRequest, type Task } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { DeskService, deliveryChecks } from '../src/desk/service.js';
import { MeetingStore } from '../src/meetings/store.js';
import { tempDir } from './tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.resolve(here, '..', '..', 'packages', 'claude-bridge', 'test', 'fake-claude.mjs');

function setup(dbFile = ':memory:', dir = tempDir('hq-conhecimento-')) {
  const db = openDb(dbFile);
  const store = new Store(db);
  store.seedDefaultRooms();
  const social = store.listRooms().find(r => r.kind === 'social')!;
  const proj = store.findProjectByPath(dir) ?? store.createProject({ name: 'Conteúdo', path: dir, roomId: social.id });
  const sent: unknown[] = [];
  const knowledge = new KnowledgeService({ db, store, broadcast: m => { sent.push(m); } });
  const manager = new SessionManager({ store, knowledge, exePath: () => process.execPath, attachmentsDir: tempDir('hq-att-'), commandPrefixArgs: [fakeClaude] });
  const desk = new DeskService({ db, store, meetings: new MeetingStore(db), manager, broadcast: () => {} });
  const waitTask = (id: string) => new Promise<Task>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const t = store.getTask(id);
      if (t && ['done', 'error', 'lost', 'interrupted'].includes(t.status)) return resolve(t);
      if (Date.now() - t0 > 8000) return reject(new Error('tempo esgotado'));
      setTimeout(tick, 40);
    };
    tick();
  });
  return { db, store, manager, knowledge, desk, social, proj, dir, sent, waitTask, cleanup: async () => { await manager.shutdown(); db.close(); } };
}
const run = (s: ReturnType<typeof setup>, clientId: string, employeeId: string, text: string, destinationId?: string) =>
  s.manager.runTask({ reqId: 'r', clientId, text, projectId: s.proj.id, employeeId, skill: null, plan: false, ...(destinationId ? { destinationId } : {}) });

test('"lembre disso para o Tuco" vira preferência da Equipe Tuco Dev, sobrevive ao reinício, vai para tarefa do Tuco e não para a da Aurora', async () => {
  const dataDir = tempDir('hq-conhecimento-db-'); const dbFile = path.join(dataDir, 'hq.sqlite'); const dir = tempDir('hq-conhecimento-');
  let s = setup(dbFile, dir);
  let ninaId = ''; let biaId = '';
  try {
    ninaId = s.manager.createEmployee({ roomId: s.social.id, name: 'Nina', profileId: 'tuco-dev', template: 'conteudo-criador' }).id;
    biaId = s.manager.createEmployee({ roomId: s.social.id, name: 'Bia', profileId: 'aurora', template: 'conteudo-criador' }).id;
    const item = s.knowledge.captureFromChefe('Abra com a pergunta do público. Lembre disso para o Tuco.', { where: 'no pedido' });
    assert.ok(item, 'a frase explícita foi registrada');
    assert.deepEqual(item!.scope, { type: 'equipe', id: 'tuco-dev' });
    assert.equal(item!.state, 'ativo'); assert.equal(item!.kind, 'preferencia'); assert.equal(item!.origin, 'chefe');
    assert.match(item!.text, /Abra com a pergunta do público/, 'o conteúdo é a frase do Chefe (a anterior ao "lembre disso")');
    assert.ok(s.sent.some(m => (m as { kind: string }).kind === 'knowledge.captured'), 'a tela recebe o resumo com Desfazer');
    // a mesma frase de novo não duplica
    assert.equal(s.knowledge.captureFromChefe('Abra com a pergunta do público. Lembre disso para o Tuco.', { where: 'no pedido' }), null);
  } finally { await s.cleanup(); }

  // "reinício": outro processo abre o mesmo banco
  s = setup(dbFile, dir);
  try {
    const board = s.knowledge.board();
    assert.equal(board.items.length, 1, 'o conhecimento continua lá depois de reiniciar');
    const g = await s.waitTask((await run(s, 'g1', ninaId, 'post sobre landing page', 'instagram-tuco')).taskId);
    assert.match(g.resultText ?? '', /Conhecimento da equipe registrado/);
    assert.match(g.resultText ?? '', /Abra com a pergunta do público/, 'a tarefa do Tuco recebeu a preferência');
    assert.match(g.resultText ?? '', /Equipe Tuco Dev · v1/, 'com escopo e versão identificados');
    const m = await s.waitTask((await run(s, 'm1', biaId, 'post sobre landing page', 'instagram-aurora')).taskId);
    assert.doesNotMatch(m.resultText ?? '', /Abra com a pergunta do público/, 'a tarefa da Aurora não recebeu a preferência do Tuco');
    const uses = s.knowledge.uses(board.items[0].id);
    assert.deepEqual(uses.map(u => u.taskId), [g.id], 'o uso fica registrado só na tarefa que recebeu');
    assert.equal(uses[0].version, 1);
  } finally { await s.cleanup(); }
});

test('regra substituída deixa de ser recuperada; a nova fica ligada à versão usada; desativada também some; proposta não vale', async () => {
  const s = setup();
  try {
    const nina = s.manager.createEmployee({ roomId: s.social.id, name: 'Nina', profileId: 'tuco-dev', template: 'conteudo-criador' });
    const v1 = s.knowledge.teach({ kind: 'preferencia', scope: { type: 'equipe', id: 'tuco-dev' }, text: 'Feche os vídeos com a frase ALFA.' }).item;
    const a = await s.waitTask((await run(s, 'a', nina.id, 'roteiro curto', 'instagram-tuco')).taskId);
    assert.match(a.resultText ?? '', /frase ALFA/);
    const v2 = s.knowledge.replace(v1.id, { text: 'Feche os vídeos com a frase BETA.' });
    assert.equal(v2.version, 2); assert.equal(v2.supersedesId, v1.id); assert.equal(s.knowledge.get(v1.id)!.state, 'substituido');
    const b = await s.waitTask((await run(s, 'b', nina.id, 'roteiro curto 2', 'instagram-tuco')).taskId);
    assert.match(b.resultText ?? '', /frase BETA/); assert.doesNotMatch(b.resultText ?? '', /frase ALFA/, 'a versão substituída não é mais recuperada');
    assert.match(b.resultText ?? '', /· v2\]/);
    const uses = s.knowledge.uses(v2.id);
    assert.deepEqual(uses.map(u => [u.taskId, u.version]).sort(), [[a.id, 1], [b.id, 2]].sort(), 'cada tarefa guarda a versão que usou');
    assert.throws(() => s.knowledge.replace(v1.id, { text: 'x y z w' }), /já foi substituída/);
    s.knowledge.setState(v2.id, 'desativado');
    s.knowledge.propose('teste:prop', { kind: 'procedimento', scope: { type: 'empresa', id: null }, text: 'Procedimento proposto GAMA para roteiro curto.' });
    const c = await s.waitTask((await run(s, 'c', nina.id, 'roteiro curto 3', 'instagram-tuco')).taskId);
    assert.doesNotMatch(c.resultText ?? '', /Conhecimento da equipe/, 'desativado e proposto não acompanham o pedido');
    assert.equal(s.knowledge.board().items.find(i => /GAMA/.test(i.text))!.state, 'proposto', 'conclusão de referência nasce proposta, não como ordem');
    assert.equal(s.knowledge.propose('teste:prop', { kind: 'procedimento', scope: { type: 'empresa', id: null }, text: 'Procedimento proposto GAMA para roteiro curto.' }), null, 'a mesma proposta não repete');
    // histórico preservado; excluir remove tudo
    assert.equal(s.knowledge.board().items.filter(i => i.chainId === v1.chainId).length, 2);
    s.knowledge.remove(v2.id);
    assert.equal(s.knowledge.board().items.filter(i => i.chainId === v1.chainId).length, 0);
  } finally { await s.cleanup(); }
});

test('recuperação seletiva: alcance por funcionário, função e projeto; fato de empresa só entra quando o assunto bate; limite de tamanho', async () => {
  const s = setup();
  try {
    const nina = s.manager.createEmployee({ roomId: s.social.id, name: 'Nina', profileId: 'tuco-dev', template: 'conteudo-criador' });
    const teo = s.manager.createEmployee({ roomId: s.social.id, name: 'Teo', profileId: 'tuco-dev', template: 'conteudo-video' });
    s.knowledge.teach({ kind: 'preferencia', scope: { type: 'funcionario', id: nina.id }, text: 'SOMENTE-NINA: confira a ortografia duas vezes.' });
    s.knowledge.teach({ kind: 'procedimento', scope: { type: 'funcao', id: 'conteudo-video' }, text: 'SOMENTE-VIDEO: exporte em 1080x1920.' });
    s.knowledge.teach({ kind: 'fato', scope: { type: 'empresa', id: null }, text: 'FATO-OLARIA: o projeto Olaria é uma loja de cerâmica.' });
    for (let i = 0; i < 30; i++) s.knowledge.teach({ kind: 'preferencia', scope: { type: 'empresa', id: null }, text: `Preferência genérica número ${i} ` + 'x'.repeat(300) });
    const ctx = (e: { id: string; template: string | null }, text: string) => s.knowledge.retrieve({ teams: ['tuco-dev'], projectId: s.proj.id, employeeId: e.id, template: e.template, text });
    const forNina = ctx(nina, 'explique landing page');
    assert.ok(forNina.some(i => /SOMENTE-NINA/.test(i.text))); assert.ok(!forNina.some(i => /SOMENTE-VIDEO/.test(i.text)));
    assert.ok(!forNina.some(i => /FATO-OLARIA/.test(i.text)), 'fato sem relação com o pedido fica de fora');
    assert.ok(ctx(nina, 'post sobre o projeto Olaria').some(i => /FATO-OLARIA/.test(i.text)), 'fato entra quando o assunto do pedido bate');
    assert.ok(ctx(teo, 'vídeo curto').some(i => /SOMENTE-VIDEO/.test(i.text)));
    assert.ok(forNina.length <= 12 && forNina.reduce((n, i) => n + Math.min(i.text.length, 700), 0) <= 2600, 'não manda o histórico inteiro');
  } finally { await s.cleanup(); }
});

test('orientação explícita x correção pontual; leitura do pedido (conversar, analisar, ensinar, produzir, corrigir, status)', () => {
  assert.equal(detectDirective('essa introdução está longa'), null, 'correção pontual vale só para a tarefa');
  assert.equal(detectDirective('deixa o título maior'), null);
  const d = detectDirective('Nos vídeos do Tuco, comece direto no assunto.');
  assert.deepEqual(d?.scope, { type: 'equipe', id: 'tuco-dev' });
  assert.equal(d?.text, 'Nos vídeos do Tuco, comece direto no assunto.', 'grava a frase do Chefe, sem inventar duração nem regra a mais');
  assert.deepEqual(detectDirective('Sempre use fundo escuro nas capas.', { team: 'aurora' })?.scope, { type: 'equipe', id: 'aurora' }, 'sem marca citada, vale a equipe do contexto');
  assert.deepEqual(detectDirective('De agora em diante a empresa toda cita a fonte dos números.')?.scope, { type: 'empresa', id: null });
  assert.equal(detectDirective('Produza um vídeo para o Tuco Dev explicando landing page.'), null, 'pedido de produção não é regra');

  const r1 = readRequest('Produza um vídeo para o Tuco Dev explicando landing page.');
  assert.equal(r1.intent, 'produzir'); assert.deepEqual(r1.teams, ['tuco-dev']); assert.deepEqual(r1.missing, []); assert.match(r1.summary.entrega, /vídeo em arquivo reproduzível/);
  const r2 = readRequest('Analise este vídeo e ensine à equipe como fazer essas transições.');
  assert.equal(r2.intent, 'ensinar'); assert.match(r2.missing.join(' '), /link ou o arquivo/, 'pede só o que falta: a referência');
  assert.deepEqual(readRequest('Analise este vídeo https://exemplo.com/v e ensine à equipe como fazer essas transições.').missing, []);
  assert.match(readRequest('Aprendam esta técnica https://exemplo.com/v').summary.entrega, /não produz nem publica/, 'referência para aprender não é pedido de produção');
  const r3 = readRequest('Use este projeto para preparar um post da Aurora.');
  assert.equal(r3.intent, 'produzir'); assert.deepEqual(r3.teams, ['aurora']);
  const r4 = readRequest('Pegue esta entrega, deixe mais dinâmica e lembre desta preferência.');
  assert.equal(r4.intent, 'corrigir'); assert.equal(r4.remember, true);
  assert.equal(readRequest('Me mostre o que depende de mim hoje.').intent, 'status');
  assert.equal(readRequest('Analise o desempenho do último mês da Aurora.').intent, 'analisar');
  assert.equal(readRequest('O que você acha de mudarmos o tom?').intent, 'conversar');
  assert.match(readRequest('Produza um carrossel sobre APIs.').missing.join(' '), /a marca/, 'sem marca no texto nem perfil: pergunta só isso');
  assert.deepEqual(readRequest('Produza um carrossel sobre APIs.', { profileTeam: 'tuco-dev' }).missing, [], 'o perfil selecionado resolve a marca');
});

test('pedido direto vira entrega na Mesa com o que foi conferido; ajuste gera a versão 2 sem apagar a 1; clique repetido não duplica', async () => {
  const s = setup();
  try {
    const nina = s.manager.createEmployee({ roomId: s.social.id, name: 'Nina', profileId: 'tuco-dev', template: 'conteudo-criador' });
    const r = await run(s, 'd1', nina.id, 'escreva o texto do post sobre landing page', 'instagram-tuco');
    s.desk.watch(r.taskId, 'escreva o texto do post sobre landing page');
    await s.waitTask(r.taskId);
    await new Promise(res => setTimeout(res, 30));
    let st = s.desk.state();
    assert.equal(st.deliveries.length, 1);
    const d1 = st.deliveries[0];
    assert.equal(d1.source, 'pedido'); assert.equal(d1.version, 1); assert.equal(d1.profileId, 'tuco-dev');
    assert.ok(d1.checks!.some(c => c.label === 'Qualidade editorial' && c.ok === null), 'o que depende do Chefe fica explícito');
    const first = await s.desk.handle({ type: 'desk.adjust', reqId: 'x', id: d1.id, note: 'essa introdução está longa', clientId: 'adj1' }) as { deliveries: { id: string; adjustTaskId: string | null }[] };
    const adjId = first.deliveries.find(x => x.id === d1.id)!.adjustTaskId!;
    await s.desk.handle({ type: 'desk.adjust', reqId: 'x', id: d1.id, note: 'essa introdução está longa', clientId: 'adj1' });
    assert.equal(s.store.listTasks(50).filter(t => /Ajuste pedido pelo Chefe/.test(t.prompt)).length, 1, 'clique repetido não cria dois ajustes');
    const adj = await s.waitTask(adjId);
    assert.match(adj.resultText ?? '', /versão 1 → 2/); assert.equal(adj.profileId, 'tuco-dev', 'o ajuste continua na equipe da entrega');
    await new Promise(res => setTimeout(res, 30));
    st = s.desk.state();
    assert.deepEqual(st.deliveries.map(x => x.version).sort(), [1, 2], 'a versão anterior continua guardada');
    assert.equal(st.deliveries.find(x => x.version === 2)!.rootTaskId, d1.taskId);
    assert.equal(s.knowledge.board().items.length, 0, 'correção pontual não virou regra');
  } finally { await s.cleanup(); }
});

test('conferência da entrega: vídeo pedido sem arquivo de vídeo é marcado; arquivo real passa; nada entregue falha', () => {
  const dir = tempDir('hq-entrega-');
  const roteiro = path.join(dir, 'roteiro.md'); fs.writeFileSync(roteiro, '# roteiro');
  const video = path.join(dir, 'video.mp4'); fs.writeFileSync(video, Buffer.alloc(2048, 1));
  const vazio = path.join(dir, 'capa.png'); fs.writeFileSync(vazio, '');
  const semVideo = deliveryChecks('Produza um vídeo para o Tuco explicando landing page', [roteiro], 'pronto');
  assert.equal(semVideo.find(c => c.label === 'Vídeo reproduzível')!.ok, false, '"pronto" com roteiro não é vídeo entregue');
  const comVideo = deliveryChecks('Produza um vídeo para o Tuco explicando landing page', [roteiro, video], 'pronto');
  assert.equal(comVideo.find(c => c.label === 'Vídeo reproduzível')!.ok, true);
  assert.match(comVideo.find(c => c.label === 'Vídeo reproduzível')!.detail ?? '', /a HQ não assistiu/, 'arquivo válido não prova que a peça ficou boa');
  assert.equal(deliveryChecks('roteiro do vídeo', [roteiro], 'ok').some(c => c.label === 'Vídeo reproduzível'), false, 'roteiro é entrega de roteiro');
  assert.equal(deliveryChecks('post', [vazio], 'ok').find(c => c.label === 'Arquivos da entrega')!.ok, false);
  assert.equal(deliveryChecks('post', [], '').find(c => c.label === 'Arquivos da entrega')!.ok, false);
});

test('tarefa cancelada na fila não roda depois, mesmo quando a anterior termina', async () => {
  const s = setup();
  try {
    s.store.saveSettings({ maxParallel: 1 });
    const nina = s.manager.createEmployee({ roomId: s.social.id, name: 'Nina', profileId: 'tuco-dev', template: 'conteudo-criador' });
    const a = await run(s, 'c1', nina.id, 'primeira');
    const b = await run(s, 'c2', nina.id, 'segunda');
    s.manager.cancelQueued(b.taskId);
    await s.waitTask(a.taskId);
    await new Promise(res => setTimeout(res, 200));
    const tb = s.store.getTask(b.taskId)!;
    assert.equal(tb.status, 'interrupted'); assert.equal(tb.startedAt ?? null, null, 'nunca começou');
    const again = await run(s, 'c2', nina.id, 'segunda');
    assert.equal(again.duplicate, true, 'reenvio do mesmo pedido (reconexão) não recria a tarefa cancelada');
  } finally { await s.cleanup(); }
});
