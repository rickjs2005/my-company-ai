// Sala de conteúdo: preparação idempotente (pasta, kit, equipe, rotinas, destinos), importação validada do que os
// funcionários gravam (Radar, semana, peça, revisão, análise), percurso oportunidade → tarefa → produção → revisão →
// aprovação → publicação com evidência → resultado, retomada depois de queda e CSV. O "funcionário" é simulado: o teste
// grava o arquivo que o Claude Code gravaria e marca a tarefa como terminada; nenhuma chamada sai do computador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Employee, ServerMessage, Task, TaskRunInput, TaskRunResult } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SocialService } from '../src/social/service.js';
import { MemoryVault } from '../src/social/vault.js';
import { ContentService, brtDate } from '../src/content/service.js';
import { RoutineService } from '../src/routines.js';
import { csvToResults, parseNumber } from '../src/content/csv.js';
import { xLength, verifyPost } from '../src/content/checks.js';
import { copyKit, writeMirrors } from '../src/content/kit.js';
import { tempDir } from './tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(here, '..', '..', 'content-kit');

class FakeManager extends EventEmitter {
  runs: TaskRunInput[] = [];
  limit: ((id: string) => number | null) | null = null;
  cancelled: string[] = [];
  interrupted: string[] = [];
  constructor(public store: Store) { super(); }
  cancelQueued(taskId: string) { const t = this.store.getTask(taskId); if (!t || t.status !== 'queued') return; this.cancelled.push(taskId); this.store.updateTask(taskId, { status: 'interrupted', finishedAt: Date.now(), errors: ['Cancelada na fila'] }); }
  async interrupt(sessionId: string) { this.interrupted.push(sessionId); for (const t of this.store.listTasksByStatus(['running', 'waiting_permission', 'waiting_answer']).filter(x => x.sessionId === sessionId)) { this.store.updateTask(t.id, { status: 'interrupted', finishedAt: Date.now() }); this.emit('task_finished', t.id); } }
  setTaskLimit(fn: (id: string) => number | null) { this.limit = fn; }
  createEmployee(input: { roomId: string; name?: string; role?: string; instructions?: string; permissionMode?: Employee['permissionMode']; provider?: Employee['provider']; skills?: string[]; template?: string | null; profileId?: string | null; access?: Employee['access'] }): Employee {
    const n = this.store.listEmployeesByRoom(input.roomId).length;
    return this.store.createEmployee({ name: input.name!, role: input.role ?? '', roomId: input.roomId, appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: n, instructions: input.instructions, permissionMode: input.permissionMode, provider: input.provider, skills: input.skills, template: input.template, profileId: input.profileId ?? null, access: input.access });
  }
  async runTask(input: TaskRunInput): Promise<TaskRunResult> {
    const dup = this.store.findTaskByClientId(input.clientId);
    if (dup) return { taskId: dup.id, sessionId: dup.sessionId, employeeId: input.employeeId, projectId: input.projectId, status: dup.status, queuePosition: null, queueReason: null, newSession: false, applied: { model: null, effort: null, permissionMode: 'default', source: 'teste' }, notes: [], duplicate: true };
    const e = this.store.getEmployee(input.employeeId)!;
    const s = this.store.listSessionsByEmployee(e.id)[0] ?? this.store.createSession({ roomId: e.roomId, projectId: input.projectId, employeeId: e.id, name: e.name, permissionMode: 'acceptEdits', workerName: e.name, appearance: e.appearance, deskIndex: e.deskIndex });
    const t = this.store.createTask({ clientId: input.clientId, sessionId: s.id, projectId: input.projectId, roomId: e.roomId, prompt: input.text, attachments: [], mode: 'send', employeeId: e.id });
    this.runs.push(input);
    return { taskId: t.id, sessionId: s.id, employeeId: e.id, projectId: input.projectId, status: 'queued', queuePosition: 1, queueReason: null, newSession: false, applied: { model: null, effort: null, permissionMode: 'acceptEdits', source: 'teste' }, notes: [], duplicate: false };
  }
  finish(taskId: string, status: Task['status'] = 'done') { this.store.updateTask(taskId, { status, finishedAt: Date.now() }); this.emit('task_finished', taskId); }
}

/** PNG mínimo (assinatura + IHDR) com o tamanho pedido: basta para a verificação de dimensões. */
function fakePng(file: string, w: number, h: number) {
  const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  fs.writeFileSync(file, b);
}

const POSTED_X = 'https://x.com/tucoexemplo/status/1980000000000000001';
function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.host === 'publish.twitter.com') {
      const target = u.searchParams.get('url');
      if (target === POSTED_X) return new Response(JSON.stringify({ author_name: 'Tuco Dev', html: '<blockquote><p>Node.js 24.11 fixes a high severity HTTP/2 issue. Update now if you run it in production.</p></blockquote>' }), { headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404 });
    }
    if (u.host === 'quebrado.example') return new Response('no', { status: 404 });
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
}

function setupHq() {
  const dir = tempDir('hq-content-');
  const db = openDb(path.join(dir, 'hq.sqlite'), { backupsDir: path.join(dir, 'backups') });
  const store = new Store(db); store.seedDefaultRooms();
  const broadcasts: ServerMessage[] = [];
  const log = { info: () => {}, warn: () => {} };
  const social = new SocialService({ db, vault: new MemoryVault(), port: 4799, broadcast: m => broadcasts.push(m), log, profileIds: () => store.listRooms().flatMap(r => r.profiles.map(p => p.id)), fetch: fakeFetch() });
  const manager = new FakeManager(store);
  const slideJobs: string[] = [];
  const routines = new RoutineService({ store, manager: manager as never, broadcast: m => broadcasts.push(m), log });
  const folder = path.join(dir, 'hq-conteudos');
  const origins = [{ label: 'Capturas de teste', dir: path.join(dir, 'shots'), exts: /\.(webp|png)$/i, depth: 2 }];
  fs.mkdirSync(path.join(dir, 'shots', 'olaria'), { recursive: true }); fs.writeFileSync(path.join(dir, 'shots', 'olaria', 'sol.webp'), 'x');
  const content = new ContentService({
    db, store, manager, social, routines, broadcast: m => broadcasts.push(m), log, kitDir: KIT, defaultFolder: folder, origins, siteDir: null, mirrors: [], trusted: () => false,
    fetch: fakeFetch(), render: async (_html, png, w, h) => fakePng(png, w, h),
    slideRender: async (jobs, w, h) => { slideJobs.push(...jobs.map(j => fs.readFileSync(j.html, 'utf8'))); for (const j of jobs) fakePng(j.png, w, h); return jobs.map(j => (fs.readFileSync(j.html, 'utf8').includes('NAO-CABE') ? 'NAO_COUBE' : 'OK 1')); },
    carouselFontsDir: dir,
  });
  return { dir, db, store, social, manager, routines, content, folder, broadcasts, slideJobs };
}

test('preparar a sala: pasta com kit, equipe de oito (duas equipes por perfil + Diretor de Vídeo), rotinas com fluxo, sete destinos e contas a confirmar; repetir não duplica nem sobrescreve', async () => {
  const { store, content, folder, social } = setupHq();
  const s1 = await content.setup();
  assert.equal(s1.setup.folder, folder);
  for (const f of ['equipe/base.md', 'equipe/contratos.md', 'equipe/destinos.md', 'referencias/originais.md', '.claude/settings.json', '.claude/skills/rede-x/SKILL.md', 'marcas/aurora/pecas', 'radar/entrada']) assert.ok(fs.existsSync(path.join(folder, f)), f);
  assert.match(fs.readFileSync(path.join(folder, 'referencias', 'originais.md'), 'utf8'), /sol\.webp/);
  assert.deepEqual(s1.setup.team.map(t => Boolean(t.employeeId)), [true, true, true, true, true, true, true, true]);
  const team = store.listEmployees().filter(e => e.template?.startsWith('conteudo-'));
  assert.equal(team.length, 8);
  const dir = team.find(e => e.template === 'conteudo-diretor-video')!;
  assert.equal(dir.role, 'Diretor de Vídeo & Motion Design'); assert.equal(dir.profileId, null, 'o Diretor atende as duas equipes');
  assert.deepEqual(dir.skills, ['video-analyze', 'watch:watch', 'milweb-video-studio', 'rede-instagram']);
  const of = (name: string) => team.find(e => e.name === name)!;
  assert.deepEqual(['Nina', 'Teo', 'Bia', 'Clara'].map(n => [of(n).template, of(n).profileId]), [['conteudo-criador', 'tuco-dev'], ['conteudo-video', 'tuco-dev'], ['conteudo-criador', 'aurora'], ['conteudo-video', 'aurora']]);
  assert.deepEqual(['Marina', 'Caio', 'Otto'].map(n => of(n).profileId), [null, null, null], 'pauta, pesquisa e revisão atendem as duas equipes');
  assert.ok(['Nina', 'Teo', 'Bia', 'Clara'].every(n => of(n).access?.browser), 'as equipes novas já entram com o navegador da HQ');
  assert.ok(team.every(e => e.roomId === store.listRooms().find(r => r.kind === 'social')!.id && e.permissionMode === 'acceptEdits'));
  assert.deepEqual(store.listRoutines().map(r => r.workflow).sort(), ['content.analise', 'content.radar']);
  assert.equal(s1.destinations.length, 7);
  assert.equal(s1.destinations.find(d => d.slot === 'x')!.language, 'en');
  const ig = social.account('instagram-aurora');
  assert.ok(!ig.declared, 'nenhuma conta vem pré-cadastrada');
  assert.equal(social.account('x').status, 'manual');
  assert.deepEqual(social.account('tiktok').profileIds, ['tuco-dev']);
  assert.deepEqual(social.account('threads').profileIds, [], 'Threads fica sem perfil até o Chefe confirmar');
  // O Chefe muda um arquivo do kit e informa outra conta: preparar de novo não sobrescreve nada nem contrata de novo.
  fs.writeFileSync(path.join(folder, 'equipe', 'base.md'), 'minha versão');
  social.declare('instagram-aurora', 'aurora.oficial', null, true, false, 'chefe');
  const s2 = await content.setup();
  assert.equal(fs.readFileSync(path.join(folder, 'equipe', 'base.md'), 'utf8'), 'minha versão');
  assert.equal(store.listEmployees().filter(e => e.template?.startsWith('conteudo-')).length, 8);
  assert.equal(store.listRoutines().length, 2);
  assert.equal(store.listProjects().filter(p => p.path === folder).length, 1);
  assert.equal(social.account('instagram-aurora').declared?.handle, 'aurora.oficial');
  assert.deepEqual(s2.setup.missing.filter(m => !m.startsWith('Especialidade') && !m.startsWith('Pesquisa na web')), []);
});

test('Radar: importa só o que é válido, ignora fonte repetida, separa prioridades; sem arquivo vira "falhou" e nada é inventado', async () => {
  const { content, manager } = setupHq();
  await content.setup();
  await content.handle({ type: 'content.radar.run', reqId: 'r' });
  const round = content.state().rounds[0];
  assert.equal(round.kind, 'radar'); assert.equal(round.status, 'aguardando');
  assert.ok(manager.limit!(round.taskId!) === 30, 'pesquisa tem teto de 30 min');
  assert.match(manager.runs[0].text, /oportunidades\.json/);
  fs.writeFileSync(round.outputPath, JSON.stringify({
    coverage: 'Sites oficiais e Hacker News; Instagram pediu login', summary: 'Uma notícia de segurança e um formato de carrossel',
    opportunities: [
      { sourceUrl: 'https://nodejs.org/en/blog/vulnerability/teste', sourceName: 'Node.js', author: null, publishedAt: '2026-11-01', consultedAt: '2026-11-02T08:10:00-03:00', subject: 'Correção HTTP/2 no Node.js', signals: 'Aviso oficial de severidade alta', evidence: 'referencia', window: '24-48h', slot: 'x', interpretation: 'Interessa a quem roda Node em produção', proposal: 'Nota no X com versão corrigida', priority: 1, reason: 'Fato oficial recente', material: 'nenhum', extraCost: 'zero' },
      { sourceUrl: 'https://exemplo.com/sem-campos', subject: 'incompleto' },
      { sourceUrl: 'https://nodejs.org/en/blog/vulnerability/teste', sourceName: 'Node.js', consultedAt: '2026-11-02T08:10:00-03:00', subject: 'Repetido', signals: 's', evidence: 'referencia', interpretation: 'i', proposal: 'p' },
    ],
  }));
  manager.finish(round.taskId!);
  await content.sync();
  const st = content.state();
  const done = st.rounds.find(r => r.id === round.id)!;
  assert.equal(done.status, 'concluida');
  assert.match(done.coverage!, /pediu login/);
  assert.match(done.error!, /item 2/); assert.match(done.error!, /repetido na mesma rodada/);
  assert.equal(st.radar.length, 1);
  assert.equal(st.radar[0].priority, 1); assert.equal(st.radar[0].slot, 'x');
  // Segunda rodada: o funcionário terminou sem gravar o arquivo.
  await content.handle({ type: 'content.radar.run', reqId: 'r2', focus: 'Pinterest' });
  const r2 = content.state().rounds[0];
  assert.match(manager.runs[1].text, /Foco pedido pelo Chefe nesta rodada: Pinterest/);
  manager.finish(r2.taskId!);
  await content.sync();
  const failed = content.state().rounds.find(r => r.id === r2.id)!;
  assert.equal(failed.status, 'falhou'); assert.match(failed.error!, /sem gravar oportunidades\.json/);
  assert.equal(content.state().radar.length, 1);
});

test('percurso completo: oportunidade → peça → produção → verificação → revisão → aprovação em lote → publicação manual → link conferido → resultado', async () => {
  const { content, manager, folder } = setupHq();
  await content.setup();
  await content.handle({ type: 'content.radar.run', reqId: 'r' });
  const round = content.state().rounds[0];
  fs.writeFileSync(round.outputPath, JSON.stringify({ coverage: 'c', summary: 's', opportunities: [{ sourceUrl: 'https://nodejs.org/en/blog/release/v24.11.0', sourceName: 'Node.js', consultedAt: '2026-11-02T08:10:00-03:00', subject: 'Node.js 24.11 corrige falha HTTP/2', signals: 'release oficial', evidence: 'referencia', window: '24-48h', slot: 'x', interpretation: 'i', proposal: 'Nota curta com a versão corrigida', priority: 1 }] }));
  manager.finish(round.taskId!); await content.sync();
  const opp = content.state().radar[0];
  await content.handle({ type: 'content.radar.toItem', reqId: 'i', id: opp.id });
  let item = content.state().items[0];
  assert.equal(item.slot, 'x'); assert.equal(item.skill, 'rede-x'); assert.equal(item.radarId, opp.id); assert.equal(item.status, 'planejada');
  assert.equal(content.state().radar[0].status, 'virou_peca');
  // Produção (tarefa do criador com a skill da rede, na pasta da marca)
  await content.handle({ type: 'content.item.produce', reqId: 'p', id: item.id });
  item = content.state().items[0];
  assert.equal(item.status, 'em_producao');
  assert.ok(item.folder!.startsWith(path.join(folder, 'marcas', 'tuco-dev', 'pecas')));
  const prodRun = manager.runs.at(-1)!;
  assert.equal(prodRun.skill, 'rede-x'); assert.equal(prodRun.destinationId, 'x');
  const text = 'Node.js 24.11 fixes a high severity HTTP/2 issue. Update now if you run it in production. https://nodejs.org/en/blog/release/v24.11.0';
  fs.writeFileSync(path.join(item.folder!, 'peca.md'), '# nota');
  fs.writeFileSync(path.join(item.folder!, 'entrega.json'), JSON.stringify({ itemId: item.id, network: 'x', files: ['peca.md'], text, translation: 'O Node.js 24.11 corrige uma falha...', sources: [{ url: 'https://nodejs.org/en/blog/release/v24.11.0', what: 'release' }], needs: [], nextStep: 'revisão' }));
  manager.finish(item.taskId!); await content.sync();
  item = content.state().items[0];
  assert.equal(item.status, 'revisar');
  assert.ok(item.checks.find(c => c.name === 'Tamanho do texto')!.ok, 'até 280 na contagem do X');
  assert.ok(item.checks.find(c => c.name === 'Tradução para revisão')!.ok);
  assert.ok(item.reviewTaskId, 'a revisão entra na fila sozinha (um passo)');
  assert.equal(manager.limit!(item.reviewTaskId!), 15);
  // Revisão
  fs.writeFileSync(path.join(item.folder!, 'revisao.json'), JSON.stringify({ verdict: 'aprovar', notes: 'Fato confere com a release.', checks: [{ name: 'fato na origem', ok: true, detail: 'release oficial' }] }));
  manager.finish(item.reviewTaskId!); await content.sync();
  item = content.state().items[0];
  assert.equal(item.review?.verdict, 'aprovar'); assert.equal(item.status, 'revisar');
  const runsBefore = manager.runs.length;
  await content.sync();
  assert.equal(manager.runs.length, runsBefore, 'nenhuma conversa nova entre agentes depois da revisão');
  // Publicar sem aprovação é recusado
  await assert.rejects(content.handle({ type: 'content.item.publish', reqId: 'x', id: item.id, clientId: 'pub-test-0001' }), /Aprove a peça/);
  const today = brtDate(Date.now());
  await content.handle({ type: 'content.approve', reqId: 'a', itemIds: [item.id], from: today, to: today, note: 'lote de teste' });
  item = content.state().items[0];
  assert.equal(item.status, 'aprovada');
  assert.deepEqual(content.state().approvals[0].slots, ['x']);
  // X é manual: pacote + intent pré-preenchido; fica pendente até o link
  const pkg = await content.handle({ type: 'content.item.publish', reqId: 'x', id: item.id, clientId: 'pub-test-0001' }) as { mode: string; openUrl: string; text: string };
  assert.equal(pkg.mode, 'manual');
  assert.ok(pkg.openUrl.startsWith('https://x.com/intent/post?text='));
  assert.equal(content.state().items[0].status, 'publicacao_pendente');
  // Link de outra rede é recusado; post inexistente fica pendente; o certo é conferido pelo oEmbed público
  const wrong = await content.handle({ type: 'content.item.registerPost', reqId: 'g', id: item.id, url: 'https://www.instagram.com/p/abc/' }) as { ok: boolean; detail: string };
  assert.equal(wrong.ok, false); assert.match(wrong.detail, /não é do X/);
  const missing = await content.handle({ type: 'content.item.registerPost', reqId: 'g', id: item.id, url: 'https://x.com/tucoexemplo/status/1' }) as { ok: boolean };
  assert.equal(missing.ok, false);
  assert.equal(content.state().items[0].status, 'publicacao_pendente');
  const ok = await content.handle({ type: 'content.item.registerPost', reqId: 'g', id: item.id, url: POSTED_X }) as { ok: boolean; detail: string };
  assert.equal(ok.ok, true, ok.detail); assert.match(ok.detail, /confere/);
  item = content.state().items[0];
  assert.equal(item.status, 'publicada'); assert.equal(item.publication?.verifiedBy, 'link'); assert.equal(item.publication?.url, POSTED_X);
  // Resultado: CSV com o link do post liga o número à peça; valor vazio fica "não coletado"
  const res = await content.handle({ type: 'content.result.importCsv', reqId: 'c', fileName: 'x.csv', csv: `data_publicacao;conta;url;metrica;valor;periodo_inicio;periodo_fim\n2026-11-02;x;${POSTED_X};Impressions;1.234;2026-11-02;2026-11-03\n2026-11-02;x;${POSTED_X};Link clicks;;2026-11-02;2026-11-03\n` }) as { imported: number };
  assert.equal(res.imported, 2);
  const rows = content.state().results;
  assert.ok(rows.every(r => r.itemId === item.id && r.slot === 'x' && r.source === 'csv'));
  assert.equal(rows.find(r => r.metric === 'Impressions')!.value, 1234);
  assert.equal(rows.find(r => r.metric === 'Link clicks')!.value, null);
});

test('semana: calendário importado com responsável e skill da rede; Pin renderizado e conferido; produção que cai é retomada pela nova tentativa', async () => {
  const { content, manager, store } = setupHq();
  await content.setup();
  await content.handle({ type: 'content.week.prepare', reqId: 'w', note: 'foco em portfólio' });
  const round = content.state().rounds[0];
  assert.equal(round.kind, 'semana');
  assert.match(manager.runs[0].text, /foco em portfólio/);
  fs.writeFileSync(round.outputPath, JSON.stringify({ weekStart: round.weekStart, capacity: '2 peças-base', summary: 'Semana do OLARIA', items: [
    { baseId: 'b1', baseTitle: 'OLARIA', date: round.weekStart, slot: 'pinterest', format: 'pin', objective: 'levar ao projeto', title: 'Pin OLARIA', brief: 'Pin com desktop e mobile', sources: [], files: ['C:\\shots\\olaria\\sol.webp'], material: 'editar', owner: 'criador', skill: 'rede-pinterest', reviewCriteria: 'URL real' },
    { baseId: 'b1', baseTitle: 'OLARIA', date: round.weekStart, slot: 'instagram-aurora', format: 'carrossel', title: 'Carrossel OLARIA', material: 'gravar', owner: 'criador', skill: 'rede-instagram' },
    { title: 'Sem conta válida', slot: 'facebook' },
  ] }));
  manager.finish(round.taskId!); await content.sync();
  const st = content.state();
  assert.equal(st.rounds[0].status, 'concluida');
  assert.match(st.rounds[0].error!, /facebook/);
  const pin = st.items.find(i => i.slot === 'pinterest')!;
  const ig = st.items.find(i => i.slot === 'instagram-aurora')!;
  assert.equal(pin.skill, 'rede-pinterest'); assert.equal(pin.baseId, ig.baseId);
  assert.equal(store.getEmployee(pin.ownerId!)!.template, 'conteudo-criador');
  // material citado fora da pasta é copiado para material/ da peça (o original fica)
  const outside = path.join(path.dirname(content.state().setup.folder!), 'shots', 'olaria', 'sol.webp');
  await content.handle({ type: 'content.item.update', reqId: 'u', id: pin.id, patch: { files: [outside], material: 'pronto' } });
  assert.equal(ig.nextStep, 'gravar o material antes de produzir');
  // Produção do Pin cai no meio; a HQ cria a nova tentativa (como o gerenciador faz) e a importação segue a tentativa nova.
  await content.handle({ type: 'content.item.produce', reqId: 'p', id: pin.id });
  const p1 = content.state().items.find(i => i.id === pin.id)!;
  assert.ok(fs.existsSync(path.join(p1.folder!, 'material', 'sol.webp')));
  assert.match(manager.runs.at(-1)!.text, /material[\\/]sol\.webp \(cópia de /);
  assert.ok(fs.existsSync(outside));
  const first = store.getTask(p1.taskId!)!;
  store.updateTask(first.id, { status: 'lost' });
  const retry = store.createTask({ clientId: `retry:${first.id}:2`, sessionId: first.sessionId, projectId: first.projectId, roomId: first.roomId, prompt: first.prompt, attachments: [], mode: 'send', employeeId: first.employeeId, attempt: 2, retryOf: first.id });
  await content.sync();
  assert.equal(content.state().items.find(i => i.id === pin.id)!.taskId, retry.id);
  fs.writeFileSync(path.join(p1.folder!, 'pin.html'), '<html><body>pin</body></html>');
  fs.writeFileSync(path.join(p1.folder!, 'peca.md'), 'pin');
  fs.writeFileSync(path.join(p1.folder!, 'entrega.json'), JSON.stringify({ network: 'pinterest', files: ['pin.html', 'peca.md'], text: 'Landing editorial do OLARIA (projeto autoral).', title: 'OLARIA: landing editorial de café', description: 'Landing editorial do OLARIA (projeto autoral).', board: 'Landing Pages', destinationUrl: 'https://aurora.example/projetos/olaria', sources: [] }));
  manager.finish(retry.id); await content.sync();
  const done = content.state().items.find(i => i.id === pin.id)!;
  assert.equal(done.status, 'revisar');
  assert.ok(done.checks.find(c => c.name === 'Imagem do Pin')!.ok, done.checks.map(c => `${c.name}: ${c.detail}`).join(' | '));
  assert.match(done.checks.find(c => c.name === 'Imagem do Pin')!.detail, /1000×1500 \(2:3\)/);
  assert.ok(done.checks.find(c => c.name === 'URL de destino')!.ok);
  assert.ok(done.checks.find(c => c.name === 'Título do Pin')!.ok);
});

test('rotina do Radar monta o pedido na hora do disparo e liga a rodada à tarefa da rotina', async () => {
  const { content, store, manager, db } = setupHq();
  await content.setup();
  const routines = new RoutineService({ store, manager: manager as never, broadcast: () => {}, log: { info: () => {}, warn: () => {} }, workflows: { prepare: (wf, r) => content.prepareRoutine(wf, r) } });
  const radar = store.listRoutines().find(r => r.workflow === 'content.radar')!;
  assert.equal(radar.schedule.kind, 'daily');
  await routines.handle({ type: 'routine.runNow', reqId: 'x', id: radar.id });
  const round = content.state().rounds[0];
  assert.equal(round.kind, 'radar');
  assert.ok(round.taskId);
  const task = store.getTask(round.taskId!)!;
  assert.match(task.prompt, /Rodada do Radar da gringa\. Agora:/);
  assert.equal((db.prepare('SELECT routine_id FROM content_rounds WHERE id=?').get(round.id) as { routine_id: string }).routine_id, radar.id);
});

test('kit: arquivo intocado é atualizado para a versão nova, arquivo editado pelo Chefe fica; espelho copia só leitura e só o que mudou', () => {
  const dir = tempDir('hq-kit-');
  const kit = path.join(dir, 'kit'); const folder = path.join(dir, 'pasta');
  fs.mkdirSync(path.join(kit, 'equipe'), { recursive: true });
  fs.writeFileSync(path.join(kit, 'equipe', 'a.md'), 'v1'); fs.writeFileSync(path.join(kit, 'equipe', 'b.md'), 'v1');
  assert.equal(copyKit(kit, folder).length, 2);
  fs.writeFileSync(path.join(folder, 'equipe', 'b.md'), 'editado pelo Chefe');
  fs.writeFileSync(path.join(kit, 'equipe', 'a.md'), 'v2'); fs.writeFileSync(path.join(kit, 'equipe', 'b.md'), 'v2');
  const r = copyKit(kit, folder);
  assert.deepEqual(r.updated?.map(x => path.basename(x)), ['a.md']);
  assert.deepEqual(r.kept?.map(x => path.basename(x)), ['b.md']);
  assert.equal(fs.readFileSync(path.join(folder, 'equipe', 'a.md'), 'utf8'), 'v2');
  assert.equal(fs.readFileSync(path.join(folder, 'equipe', 'b.md'), 'utf8'), 'editado pelo Chefe');
  const src = path.join(dir, 'skill'); fs.mkdirSync(path.join(src, 'formatos'), { recursive: true });
  fs.writeFileSync(path.join(src, 'research.md'), 'pesquisa'); fs.writeFileSync(path.join(src, 'formatos', 'case.md'), 'case'); fs.writeFileSync(path.join(src, 'x.py'), 'nao');
  const m1 = writeMirrors(folder, [{ label: 'Skill', from: src, to: 'skill', exts: /\.md$/i, depth: 2 }]);
  assert.equal(m1.copied, 2);
  assert.equal(fs.readFileSync(path.join(folder, 'referencias', 'espelho', 'skill', 'formatos', 'case.md'), 'utf8'), 'case');
  assert.ok(!fs.existsSync(path.join(folder, 'referencias', 'espelho', 'skill', 'x.py')));
  assert.match(fs.readFileSync(path.join(folder, 'referencias', 'espelho', 'LEIA-ME.md'), 'utf8'), /original/);
  assert.equal(writeMirrors(folder, [{ label: 'Skill', from: src, to: 'skill', exts: /\.md$/i, depth: 2 }]).copied, 0, 'sem mudança, nada é copiado de novo');
});

test('pasta ainda não confiável no Claude Code aparece como pendência de acesso (pesquisa na web)', async () => {
  const { content } = setupHq();
  const s = await content.setup();
  assert.ok(s.setup.missing.some(m => /Pesquisa na web/.test(m)));
});

test('CSV, números e contagem do X', () => {
  assert.equal(parseNumber('1.234,5'), 1234.5);
  assert.equal(parseNumber('1,234.5'), 1234.5);
  assert.equal(parseNumber('12%'), 12);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('não coletado'), null);
  const r = csvToResults('metric,value,account\n"Reach, total",10,linkedin\nSaves,,instagram-tuco\n,5,x\n', null);
  assert.equal(r.rows.length, 2); assert.equal(r.rows[0].metric, 'Reach, total'); assert.equal(r.rows[1].value, null);
  assert.match(r.skipped[0], /sem métrica/);
  assert.match(csvToResults('valor\n1\n', null).skipped[0], /coluna "metrica"/);
  assert.equal(xLength('abc https://example.com/muito/longo/mesmo'), 4 + 23);
});

test('conferência de post: domínio errado é recusado sem rede; link de rede sem oEmbed só "responde"', async () => {
  const f = fakeFetch();
  assert.match((await verifyPost('pinterest', 'https://x.com/a/status/1', null, f)).detail, /não é do pinterest/);
  const li = await verifyPost('linkedin', 'https://www.linkedin.com/feed/update/urn:li:activity:1/', 'texto', f);
  assert.equal(li.ok, true); assert.match(li.detail, /conteúdo não foi conferido/);
  const off = await verifyPost('linkedin', 'https://quebrado.example/x', null, f);
  assert.equal(off.ok, false);
});

test('carrossel: o funcionário escreve carrossel.json e a HQ desenha os slides; a revisão olha as imagens', async () => {
  const { content, manager, slideJobs } = setupHq();
  await content.setup();
  await content.handle({ type: 'content.week.prepare', reqId: 'w', note: null });
  const round = content.state().rounds[0];
  fs.writeFileSync(round.outputPath, JSON.stringify({ weekStart: round.weekStart, summary: 'Série do Tuco', items: [
    { date: round.weekStart, slot: 'threads', format: 'post', title: 'Post curto', material: 'nao_precisa' },
    { date: round.weekStart, slot: 'instagram-tuco', format: 'carrossel', title: 'Ep. 1: o que é uma linguagem de programação', material: 'nao_precisa', skill: 'rede-instagram' },
    { date: round.weekStart, slot: 'instagram-aurora', format: 'carrossel', title: 'Bastidor gravado', material: 'gravar' },
  ] }));
  const before = manager.runs.length;
  manager.finish(round.taskId!); await content.sync();
  // Calendário pronto = a semana vai sozinha para a criação; o que depende de gravação fica de fora com o motivo.
  const st = content.state();
  assert.equal(manager.runs.length - before, 2, 'duas peças produzidas sem clique');
  assert.equal(st.items.filter(i => i.status === 'em_producao').length, 2);
  assert.equal(st.items.find(i => i.title === 'Bastidor gravado')!.status, 'planejada');
  const car = st.items.find(i => i.slot === 'instagram-tuco')!;
  const prodText = manager.runs.find(r => r.text.includes(car.title))!.text;
  assert.match(prodText, /carrossel\.json/);
  assert.match(prodText, /A HQ desenha as imagens 1080×1350/);

  // Entrega com carrossel.json inválido: verificação aponta o slide.
  fs.writeFileSync(path.join(car.folder!, 'carrossel.json'), JSON.stringify({ slides: [{ tipo: 'capa', titulo: 'Só um' }] }));
  fs.writeFileSync(path.join(car.folder!, 'peca.md'), 'roteiro');
  fs.writeFileSync(path.join(car.folder!, 'entrega.json'), JSON.stringify({ itemId: car.id, network: 'instagram', files: ['carrossel.json', 'peca.md'], text: 'Legenda do post.', sources: [] }));
  manager.finish(car.taskId!); await content.sync();
  let item = content.state().items.find(i => i.id === car.id)!;
  const bad = item.checks.find(c => c.name === 'Imagens do carrossel')!;
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /de 2 a 10 slides/);

  // A conferência devolveu sozinha para a criação (rodada automática) com o motivo exato; ela entrega um carrossel válido:
  // 4 slides desenhados, peça principal = primeiro slide, revisão pede para olhar as imagens.
  item = content.state().items.find(i => i.id === car.id)!;
  assert.equal(item.status, 'em_producao');
  assert.match(manager.store.getTask(item.taskId!)!.prompt, /de 2 a 10 slides/);
  fs.writeFileSync(path.join(item.folder!, 'carrossel.json'), JSON.stringify({ marca: 'tuco-dev', slides: [
    { tipo: 'capa', titulo: 'O que é uma linguagem de', destaque: 'programação?' },
    { tipo: 'texto', titulo: 'O computador só entende 0 e 1', texto: 'Tudo vira <0> e <1>.' },
    { tipo: 'codigo', titulo: 'Na prática', codigo: "print('Olá')" },
    { tipo: 'fechamento', titulo: 'Próximo: lógica.' },
  ] }));
  manager.finish(item.taskId!); await content.sync();
  item = content.state().items.find(i => i.id === car.id)!;
  const ok = item.checks.find(c => c.name === 'Imagens do carrossel')!;
  assert.ok(ok.ok, ok.detail);
  assert.match(ok.detail, /4 slides 1080×1350 em slides\/ \(identidade Tuco Dev\)/);
  assert.equal(item.deliverable, path.join(item.folder!, 'slides', '01.png'));
  for (const n of ['01', '02', '03', '04']) assert.ok(fs.existsSync(path.join(item.folder!, 'slides', `${n}.png`)));
  assert.ok(slideJobs.some(h => h.includes('Tudo vira &lt;0&gt; e &lt;1&gt;.')), 'texto do funcionário é escapado no HTML');
  assert.ok(slideJobs.some(h => h.includes('#F2ECDD')), 'Tuco no papel marfim');
  const reviewText = manager.runs.at(-1)!.text;
  assert.match(reviewText, /Revisar a peça/);
  assert.match(reviewText, /abra e olhe cada imagem em `slides\/`/);

  // Revisor pede ajuste: a criação refaz UMA vez sozinha com as observações e a peça volta para revisão.
  const reviewTask = content.state().items.find(i => i.id === car.id)!.reviewTaskId!;
  const ajuste = { verdict: 'ajustar', notes: 'Slide 3: diga que são dois programas separados.', checks: [{ name: 'Código', ok: false, detail: 'mistura duas linguagens' }] };
  fs.writeFileSync(path.join(item.folder!, 'revisao.json'), JSON.stringify(ajuste));
  manager.finish(reviewTask); await content.sync();
  item = content.state().items.find(i => i.id === car.id)!;
  assert.equal(item.status, 'em_producao', 'voltou sozinha para a criação');
  const redo = manager.runs.at(-1)!.text;
  assert.match(redo, /Ajuste pedido pelo revisor \(rodada automática; depois desta, a decisão é do Chefe\): Slide 3: diga que são dois programas separados\./);
  assert.ok(!/Observação do Chefe/.test(redo));
  manager.finish(item.taskId!); await content.sync();
  item = content.state().items.find(i => i.id === car.id)!;
  fs.writeFileSync(path.join(item.folder!, 'revisao.json'), JSON.stringify(ajuste));
  const runsBefore = manager.runs.length;
  manager.finish(item.reviewTaskId!); await content.sync();
  item = content.state().items.find(i => i.id === car.id)!;
  assert.equal(item.status, 'ajustar', 'segunda vez: fica para o Chefe decidir (sem laço)');
  assert.equal(manager.runs.length, runsBefore, 'nenhuma produção nova');
  assert.match(item.nextStep ?? '', /depois da rodada automática: decida/);
});

test('produzir a semana pelo botão: só planejadas com conta e sem material pendente; repetir não duplica', async () => {
  const { content, manager } = setupHq();
  await content.setup();
  await content.handle({ type: 'content.item.create', reqId: 'c1', item: { title: 'Thread A', slot: 'threads', format: 'post', date: '2026-11-03', material: 'nao_precisa' } });
  await content.handle({ type: 'content.item.create', reqId: 'c2', item: { title: 'Sem conta', format: 'post', date: '2026-11-04' } });
  const n0 = manager.runs.length;
  const r = await content.handle({ type: 'content.week.produce', reqId: 'wp', weekStart: '2026-11-02' }) as { produced: number; skipped: string[] };
  assert.equal(r.produced, 1);
  assert.match(r.skipped.join(' '), /"Sem conta": sem conta de destino/);
  assert.equal(manager.runs.length - n0, 1);
  const again = await content.handle({ type: 'content.week.produce', reqId: 'wp2', weekStart: '2026-11-02' }) as { produced: number };
  assert.equal(again.produced, 0, 'peça já em produção não entra de novo');
});

test('carrossel.json: validação por slide e HTML com a identidade de cada marca', async () => {
  const { parseCarousel, carouselSlideHtml } = await import('../src/content/carousel.js');
  assert.match(String((parseCarousel({ slides: [{ tipo: 'capa', titulo: 'a' }, { tipo: 'video', titulo: 'b' }] }) as { error: string }).error), /slide 2: tipo "video" desconhecido/);
  assert.match(String((parseCarousel({ slides: [{ tipo: 'capa', titulo: 'a' }, { tipo: 'lista', titulo: 'b', itens: ['só um'] }] }) as { error: string }).error), /slide 2 \(lista\): use de 2 a 6/);
  assert.match(String((parseCarousel({ slides: [{ tipo: 'capa', titulo: 'a' }, { tipo: 'comparacao', titulo: 'b', colunas: [{ titulo: 'x', itens: [] }] }] }) as { error: string }).error), /2 "colunas"/);
  assert.match(String((parseCarousel({ slides: [{ tipo: 'capa' }, { tipo: 'texto', titulo: 'b' }] }) as { error: string }).error), /slide 1: falta o "titulo"/);
  const c = parseCarousel({ marca: 'aurora', slides: [{ tipo: 'capa', titulo: 'Primeiro a demo.', destaque: 'Depois o cliente.' }, { tipo: 'fechamento', titulo: 'Quer ver o seu?' }] });
  assert.ok(c.ok);
  if (!c.ok) return;
  const html = carouselSlideHtml(c.value, 1, { brand: 'aurora', fontsDir: os.tmpdir(), mascotFile: null });
  assert.match(html, /#E8722C/); assert.match(html, /aurora.example/); assert.match(html, /Fala comigo\./); assert.match(html, /2\/2/);
  const cover = carouselSlideHtml(c.value, 0, { brand: 'tuco-dev', fontsDir: os.tmpdir(), mascotFile: null });
  assert.match(cover, /class="capa-hl">Depois o cliente\.</, 'destaque fora do título vira a segunda linha da capa');
  // Imagem real: só dentro da pasta de conteúdo e existente; entra no slide como arquivo local.
  const { resolveSlideImage } = await import('../src/content/carousel.js');
  const root = tempDir('hq-car-root-'); const piece = path.join(root, 'marcas', 'aurora', 'pecas', 'p1'); fs.mkdirSync(path.join(piece, 'material'), { recursive: true });
  fs.writeFileSync(path.join(piece, 'material', 'home.webp'), 'x');
  const okImg = resolveSlideImage('material/home.webp', piece, root);
  assert.ok(okImg.ok);
  assert.match(String((resolveSlideImage('C:/Windows/win.ini', piece, root) as { error: string }).error ?? ''), /fora da pasta de conteúdo/);
  assert.match(String((resolveSlideImage('material/nao-existe.png', piece, root) as { error: string }).error ?? ''), /não existe/);
  assert.match(String((parseCarousel({ slides: [{ tipo: 'capa', titulo: 'a' }, { tipo: 'imagem', titulo: 'b' }] }) as { error: string }).error), /slide 2 \(imagem\): falta o caminho/);
  const withImg = parseCarousel({ slides: [{ tipo: 'capa', titulo: 'a' }, { tipo: 'imagem', titulo: 'O site no ar', imagem: 'material/home.webp', imagemLegenda: 'celular' }] });
  assert.ok(withImg.ok);
  if (withImg.ok && okImg.ok) {
    const h = carouselSlideHtml(withImg.value, 1, { brand: 'aurora', fontsDir: os.tmpdir(), mascotFile: null, imageFile: okImg.file });
    assert.match(h, /class="shot"/); assert.match(h, /home\.webp/); assert.match(h, /<span>celular<\/span>/);
  }
});

test('arquivos da peça para o visualizador: slides, vídeo citado e texto, na ordem; citado que não existe aparece como faltando', async () => {
  const { content, folder, dir } = setupHq();
  await content.setup();
  await content.handle({ type: 'content.item.create', reqId: 'v1', item: { title: 'Reels do caso', slot: 'instagram-tuco', format: 'reel (vídeo pronto)', date: '2026-11-04', material: 'pronto' } });
  const created = content.state().items.find(i => i.title === 'Reels do caso')!;
  await content.handle({ type: 'content.item.produce', reqId: 'v2', id: created.id, note: null });
  const item = content.state().items.find(i => i.id === created.id)!;
  assert.ok(item.folder && fs.existsSync(item.folder));
  // Vídeo de outra pasta de peça (citado pela pasta de conteúdo), slides, texto e arquivos internos que não entram.
  const videoDir = path.join(folder, 'marcas', 'tuco-dev', 'pecas', 'video-base');
  fs.mkdirSync(videoDir, { recursive: true });
  fs.writeFileSync(path.join(videoDir, 'caso-legendado.mp4'), 'mp4');
  fs.writeFileSync(path.join(videoDir, 'caso.mp4'), 'mp4');
  fs.mkdirSync(path.join(item.folder, 'slides'));
  fakePng(path.join(item.folder, 'slides', '02.png'), 1080, 1350); fakePng(path.join(item.folder, 'slides', '01.png'), 1080, 1350);
  const outside = path.join(dir, 'fora.mp4'); fs.writeFileSync(outside, 'x');
  fs.writeFileSync(path.join(item.folder, 'peca.md'), '# Reels\n- Vídeo: `marcas/tuco-dev/pecas/video-base/caso.mp4`\n- Capa: `capa-que-ninguem-fez.png`\n- Fora: `' + outside + '`\n');
  fs.writeFileSync(path.join(item.folder, 'entrega.json'), JSON.stringify({ itemId: item.id, network: 'instagram', files: ['marcas/tuco-dev/pecas/video-base/caso-legendado.mp4', 'peca.md', 'carrossel.json', 'legenda-final.srt'], text: 'Legenda exata do post.', sources: [] }));
  const r = await content.handle({ type: 'content.item.files', reqId: 'v3', id: item.id }) as import('@milweb-hq/protocol').ContentItemFiles;
  assert.deepEqual(r.files.map(f => path.relative(folder, f.path).split(path.sep).join('/')), [
    path.relative(folder, path.join(item.folder, 'slides', '01.png')).split(path.sep).join('/'),
    path.relative(folder, path.join(item.folder, 'slides', '02.png')).split(path.sep).join('/'),
    'marcas/tuco-dev/pecas/video-base/caso-legendado.mp4',
    'marcas/tuco-dev/pecas/video-base/caso.mp4',
    path.relative(folder, path.join(item.folder, 'peca.md')).split(path.sep).join('/'),
  ], 'slides, vídeo com legenda, vídeo original e texto; nada de .json nem arquivo fora da pasta de conteúdo');
  assert.deepEqual(r.files.map(f => f.kind), ['image', 'image', 'video', 'video', 'text']);
  assert.equal(r.text, 'Legenda exata do post.');
  assert.deepEqual(r.missing.map(m => path.basename(m)), ['legenda-final.srt'], 'listado na entrega e inexistente = faltando; citação no texto que não resolve (capa) e arquivo fora da pasta não são "faltando"');
  await assert.rejects(content.handle({ type: 'content.item.files', reqId: 'v4', id: 'nao-existe' }), /peça não encontrada/);
});

// ------------------------------------------------------------------ v11: entrega de verdade, lixeira, arquivo, pedido

/** Cria e manda produzir uma peça; devolve a peça já com pasta e tarefa. */
async function producing(content: ContentService, title: string, slot: import('@milweb-hq/protocol').SocialSlotId, format: string, date = '2026-11-04') {
  await content.handle({ type: 'content.item.create', reqId: `c-${title}`, item: { title, slot, format, date, material: 'nao_precisa' } });
  const it = content.state().items.find(i => i.title === title)!;
  await content.handle({ type: 'content.item.produce', reqId: `p-${title}`, id: it.id, note: null });
  return content.state().items.find(i => i.id === it.id)!;
}
const entrega = (folder: string, o: Record<string, unknown>) => fs.writeFileSync(path.join(folder, 'entrega.json'), JSON.stringify({ network: null, files: ['peca.md'], sources: [], ...o }));

test('entrega conferida: texto final vai para revisar sem mídia; Reels só com roteiro e carrossel sem imagens ficam parciais; arquivo listado que não existe não vira entrega; falha diz o motivo', async () => {
  const { content, manager, folder } = setupHq();
  await content.setup();
  // Texto (LinkedIn): basta o texto final, sem exigir imagem.
  const li = await producing(content, 'Post do LinkedIn', 'linkedin', 'post de texto');
  fs.writeFileSync(path.join(li.folder!, 'peca.md'), '# Post\n\nLegenda: Confirme por telefone antes de pagar.');
  entrega(li.folder!, { network: 'linkedin', text: 'Confirme por telefone antes de pagar um boleto que mudou por mensagem.' });
  manager.finish(li.taskId!); await content.sync();
  let x = content.state().items.find(i => i.id === li.id)!;
  assert.equal(x.status, 'revisar');
  assert.ok(x.checks.find(c => c.name === 'Entrega exigida')!.ok);
  assert.ok(x.reviewTaskId, 'revisão automática entrou na fila');
  // Reels com roteiro e sem vídeo: parcial, sem revisão automática, com o que falta.
  const reel = await producing(content, 'Reels do caso', 'instagram-tuco', 'reel (roteiro)');
  // O episódio bruto citado no roteiro existe, mas não é a entrega (ainda precisa do corte).
  fs.mkdirSync(path.join(folder, 'brutos'), { recursive: true }); fs.writeFileSync(path.join(folder, 'brutos', 'episodio.mp4'), 'mp4');
  fs.writeFileSync(path.join(reel.folder!, 'peca.md'), '# Roteiro\n\nCorte do episódio `brutos/episodio.mp4`\n0:00 gancho');
  entrega(reel.folder!, { network: 'instagram', text: 'Legenda do Reels' });
  manager.finish(reel.taskId!); await content.sync();
  x = content.state().items.find(i => i.id === reel.id)!;
  // primeira entrega incompleta: volta sozinha para quem produziu, uma vez, com o erro exato (não chega ao Chefe como pronta)
  assert.equal(x.status, 'em_producao');
  assert.notEqual(x.taskId, reel.taskId, 'tarefa nova de correção');
  const fixPrompt = manager.store.getTask(x.taskId!)!.prompt;
  assert.match(fixPrompt, /Correção pedida pela conferência da HQ \(rodada automática/);
  assert.match(fixPrompt, /roteiro ou vídeo bruto citado não substitui/);
  assert.match(fixPrompt, /Citar o nome de um arquivo na resposta não é entrega/);
  assert.ok(x.history.some(h => h.action === 'correção pedida pela conferência'));
  // a correção também veio sem o vídeo: agora a decisão é do Chefe (sem laço, sem segunda rodada)
  manager.finish(x.taskId!); await content.sync();
  x = content.state().items.find(i => i.id === reel.id)!;
  assert.equal(x.status, 'parcial');
  assert.equal(x.reviewTaskId, null);
  assert.match(x.nextStep ?? '', /a correção automática não resolveu: falta .*roteiro ou vídeo bruto citado não substitui/, 'vídeo só citado (bruto) não conta como entrega');
  assert.equal(manager.runs.filter(r => r.text.includes(x.title) && /Correção pedida pela conferência/.test(r.text)).length, 1, 'uma única correção automática');
  // Carrossel descrito no peca.md, sem imagens e com um arquivo listado que não existe: parcial com os dois motivos.
  const car = await producing(content, 'Carrossel só descrito', 'instagram-aurora', 'carrossel');
  fs.writeFileSync(path.join(car.folder!, 'peca.md'), 'Slide 1: título. Slide 2: texto.');
  entrega(car.folder!, { network: 'instagram', text: 'Legenda', files: ['peca.md', 'capa-final.png'] });
  manager.finish(car.taskId!); await content.sync();
  x = content.state().items.find(i => i.id === car.id)!;
  assert.equal(x.status, 'em_producao', 'primeira falta: correção automática');
  manager.finish(x.taskId!); await content.sync();
  x = content.state().items.find(i => i.id === car.id)!;
  assert.equal(x.status, 'parcial');
  const need = x.checks.find(c => c.name === 'Entrega exigida')!;
  assert.equal(need.ok, false);
  assert.match(need.detail, /imagens exportadas/); assert.match(need.detail, /capa-final\.png \(listado na entrega, não existe\)/);
  // Tarefa que termina com erro: "falhou", com o motivo e o próximo passo (não volta escondida para planejada).
  const bad = await producing(content, 'Thread que caiu', 'threads', 'post');
  manager.store.updateTask(bad.taskId!, { errors: ['usage limit reached'] });
  manager.finish(bad.taskId!, 'error'); await content.sync();
  x = content.state().items.find(i => i.id === bad.id)!;
  assert.equal(x.status, 'falhou');
  assert.match(x.nextStep ?? '', /usage limit reached.*espere o limite de uso liberar/);
  assert.deepEqual(x.history.map(h => h.to), ['planejada', 'em_producao', 'falhou'], 'histórico de estados');
  // Depois de completar o vídeo, a conferência dos registros corrige o Reels para "para revisar" (com histórico); o dry-run não grava.
  fs.writeFileSync(path.join(reel.folder!, 'final.mp4'), 'mp4');
  entrega(reel.folder!, { network: 'instagram', text: 'Legenda do Reels', files: ['final.mp4', 'peca.md'] });
  const dry = await content.handle({ type: 'content.items.verify', reqId: 'v0', ids: [reel.id], apply: false }) as { rows: import('@milweb-hq/protocol').ContentVerifyRow[] };
  assert.deepEqual(dry.rows.map(r => [r.from, r.to]), [['parcial', 'revisar']]);
  assert.equal(content.state().items.find(i => i.id === reel.id)!.status, 'parcial', 'dry-run não grava');
  await content.handle({ type: 'content.items.verify', reqId: 'v1', ids: [reel.id], apply: true });
  x = content.state().items.find(i => i.id === reel.id)!;
  assert.equal(x.status, 'revisar');
  assert.equal(x.history.at(-1)!.action, 'conferência da entrega');
});

test('lixeira: uma, lote e restaurar sem recomeçar; durante a execução cancela a fila e interrompe; evento atrasado, retentativa e reinício não ressuscitam', async () => {
  const { content, manager, db, store, social, routines, folder } = setupHq();
  await content.setup();
  const a = await producing(content, 'Descartável A', 'threads', 'post');
  const b = await producing(content, 'Descartável B', 'x', 'nota X');
  const c = await producing(content, 'Descartável C', 'linkedin', 'post de texto');
  // A está rodando (com pedido de autorização pendente, por exemplo); B e C ainda na fila.
  manager.store.updateTask(a.taskId!, { status: 'running' });
  const r = await content.handle({ type: 'content.items.trash', reqId: 't1', ids: [a.id] }) as { trashed: string[]; cancelled: string[] };
  assert.deepEqual(r.trashed, [a.id]);
  assert.deepEqual(r.cancelled, [a.taskId]);
  assert.equal(manager.interrupted.length, 1, 'execução atual interrompida');
  let x = content.state().items.find(i => i.id === a.id)!;
  assert.ok(x.deletedAt); assert.equal(x.status, 'planejada'); assert.match(x.nextStep ?? '', /produção cancelada ao mover para a lixeira/);
  // O fim atrasado da tarefa (e uma retentativa que surgir) não traz a peça de volta nem a importa.
  fs.writeFileSync(path.join(a.folder!, 'entrega.json'), JSON.stringify({ text: 'atrasado', files: [] }));
  manager.finish(a.taskId!, 'done'); await content.sync();
  x = content.state().items.find(i => i.id === a.id)!;
  assert.ok(x.deletedAt); assert.equal(x.status, 'planejada', 'fim atrasado ignorado');
  const retry = store.createTask({ clientId: `retry:${a.taskId}:2`, sessionId: store.getTask(a.taskId!)!.sessionId, projectId: store.getTask(a.taskId!)!.projectId, roomId: store.getTask(a.taskId!)!.roomId, prompt: 'de novo', attachments: [], mode: 'queue', attempt: 2, retryOf: a.taskId });
  store.updateTask(a.taskId!, { status: 'lost' });
  await content.sync();
  assert.ok(manager.cancelled.includes(retry.id), 'retentativa de peça na lixeira é cancelada');
  // Lote: B e C (na fila) vão juntos; contadores do mural ativo zeram para eles.
  const r2 = await content.handle({ type: 'content.items.trash', reqId: 't2', ids: [b.id, c.id] }) as { trashed: string[]; cancelled: string[] };
  assert.deepEqual(r2.trashed.sort(), [b.id, c.id].sort());
  assert.deepEqual(r2.cancelled.sort(), [b.taskId, c.taskId].sort());
  assert.equal(content.state().items.filter(i => !i.deletedAt && i.title.startsWith('Descartável')).length, 0);
  // Reinício: um serviço novo sobre o mesmo banco continua com as três na lixeira.
  const again = new ContentService({ db, store, manager, social, routines, broadcast: () => {}, log: { info: () => {}, warn: () => {} }, kitDir: KIT, defaultFolder: folder, origins: [], siteDir: null, mirrors: [], trusted: () => false });
  await again.sync();
  assert.equal(again.state().items.filter(i => i.deletedAt && i.title.startsWith('Descartável')).length, 3);
  // Restaurar: volta ao mural, sem tarefa nova (não recomeça sozinha).
  const runs = manager.runs.length;
  await again.handle({ type: 'content.items.restore', reqId: 'rs', ids: [a.id, b.id] });
  const st = again.state();
  assert.equal(st.items.find(i => i.id === a.id)!.deletedAt, null);
  assert.equal(st.items.find(i => i.id === b.id)!.status, 'planejada');
  assert.equal(manager.runs.length, runs, 'restaurar não cria tarefa');
  assert.deepEqual(st.items.find(i => i.id === a.id)!.history.slice(-2).map(h => h.action), ['lixeira', 'restaurada']);
  // Peça na lixeira não volta a produzir pelo botão.
  await assert.rejects(again.handle({ type: 'content.item.produce', reqId: 'pp', id: c.id, note: null }), /na lixeira/);
});

test('arquivar: fica fora da semana, do lote e da produção; desarquivar devolve; peça em produção não arquiva sem cancelar', async () => {
  const { content } = setupHq();
  await content.setup();
  await content.handle({ type: 'content.item.create', reqId: 'a1', item: { title: 'Antiga', slot: 'threads', format: 'post', date: '2026-11-04', material: 'nao_precisa' } });
  const it = content.state().items.find(i => i.title === 'Antiga')!;
  await content.handle({ type: 'content.items.archive', reqId: 'a2', ids: [it.id], archived: true });
  assert.ok(content.state().items.find(i => i.id === it.id)!.archivedAt);
  const wk = await content.handle({ type: 'content.week.produce', reqId: 'w', weekStart: '2026-11-02' }) as { produced: number };
  assert.equal(wk.produced, 0, 'arquivada não entra na produção da semana');
  await assert.rejects(content.handle({ type: 'content.item.produce', reqId: 'p', id: it.id, note: null }), /arquivada/);
  await content.handle({ type: 'content.items.archive', reqId: 'a3', ids: [it.id], archived: false });
  assert.equal(content.state().items.find(i => i.id === it.id)!.archivedAt, null);
  const run = await producing(content, 'Rodando', 'x', 'nota X');
  await assert.rejects(content.handle({ type: 'content.items.archive', reqId: 'a4', ids: [run.id], archived: true }), /em produção/);
});

test('pedido do dia: liga as peças da data, cria e produz as descritas; conta sem peça espera a pesquisa, que encaminha a produção quando termina', async () => {
  const { content, manager } = setupHq();
  // Data de hoje (05/11: pedido de dia que já passou é arquivado sozinho; a data fixa de 04/11 virou passado).
  const DIA = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  await content.setup();
  await content.handle({ type: 'content.item.create', reqId: 'e1', item: { title: 'Threads já pronto', slot: 'threads', format: 'post', date: DIA, material: 'nao_precisa' } });
  const before = manager.runs.length;
  const r = await content.handle({ type: 'content.request.create', reqId: 'q1', date: DIA, slots: ['threads', 'linkedin', 'x'], autoProduce: true,
    pieces: [{ title: 'LinkedIn do golpe do boleto', slot: 'linkedin', format: 'post de texto', brief: 'versão LinkedIn da dica' }] }) as { requestId: string; produced: number; waiting: string[] };
  const st = content.state();
  const req = st.requests.find(q => q.id === r.requestId)!;
  assert.equal(req.date, DIA); assert.deepEqual(req.slots, ['threads', 'linkedin', 'x']);
  const mine = st.items.filter(i => i.requestId === req.id);
  assert.deepEqual(mine.map(i => i.slot).sort(), ['linkedin', 'threads']);
  assert.equal(r.produced, 2); assert.ok(mine.every(i => i.status === 'em_producao'));
  assert.deepEqual(r.waiting, ['x'], 'X sem pauta espera a pesquisa');
  const radar = st.rounds.find(x => x.kind === 'radar' && x.status === 'aguardando')!;
  assert.ok(radar, 'pesquisa entrou na fila');
  assert.match(manager.runs.at(-1)!.text, /falta pauta para X/);
  assert.equal(manager.runs.length - before, 3);
  // Pesquisa concluída: a oportunidade do X vira peça do pedido e vai para a produção sem clique.
  fs.writeFileSync(radar.outputPath, JSON.stringify({ coverage: 'c', summary: 's', opportunities: [{ sourceUrl: 'https://nextjs.org/blog/security-update', sourceName: 'Next.js', consultedAt: '2026-11-03T13:10:00-03:00', subject: 'Next.js security release', signals: 'release oficial', evidence: 'referencia', window: '24-48h', slot: 'x', interpretation: 'i', proposal: 'Short English note with the fixed versions', priority: 1 }] }));
  manager.finish(radar.taskId!); await content.sync();
  const xItem = content.state().items.find(i => i.requestId === req.id && i.slot === 'x')!;
  assert.ok(xItem, 'conta preenchida pela pesquisa');
  assert.equal(xItem.date, DIA); assert.equal(xItem.status, 'em_producao');
  assert.equal(manager.runs.length - before, 4);
  // Pedido de novo para a mesma data não duplica peças já ligadas a outro pedido.
  await content.handle({ type: 'content.request.create', reqId: 'q2', date: DIA, slots: ['threads'], autoProduce: false });
  assert.equal(content.state().items.filter(i => i.slot === 'threads' && i.date === DIA).length, 1);
});

test('cartões escondidos: tarefa avulsa e entrega da mesa vão para o arquivo ou a lixeira (cancelando a tarefa) e voltam', async () => {
  const { content, manager, store } = setupHq();
  await content.setup();
  const it = await producing(content, 'Avulsa', 'threads', 'post');
  const tid = it.taskId!;
  await content.handle({ type: 'content.hidden.set', reqId: 'h1', key: `task:${tid}`, kind: 'task', state: 'lixeira', title: 'Avulsa', cancelTaskId: tid });
  assert.deepEqual(content.state().hidden.map(h => [h.key, h.state]), [[`task:${tid}`, 'lixeira']]);
  assert.ok(manager.cancelled.includes(tid), 'tarefa na fila cancelada');
  assert.ok(store.getTask(tid), 'a tarefa e a conversa continuam existindo');
  await content.handle({ type: 'content.hidden.set', reqId: 'h2', key: `task:${tid}`, kind: 'task', state: null });
  assert.equal(content.state().hidden.length, 0);
  await assert.rejects(content.handle({ type: 'content.hidden.set', reqId: 'h3', key: 'qualquer coisa', kind: 'task', state: 'arquivada' }), /cartão inválido/);
});

test('carrossel que reaproveita imagens de outra peça (caminho a partir da pasta de conteúdo) passa na conferência de arquivos e na entrega exigida', async () => {
  const { content, manager, folder } = setupHq();
  await content.setup();
  const base = path.join(folder, 'marcas', 'tuco-dev', 'pecas', 'carrossel-base', 'slides');
  fs.mkdirSync(base, { recursive: true });
  for (const n of ['01', '02', '03']) fakePng(path.join(base, `${n}.png`), 1080, 1350);
  const it = await producing(content, 'TikTok de fotos', 'tiktok', 'carrossel de fotos (TikTok)');
  fs.writeFileSync(path.join(it.folder!, 'peca.md'), 'Legenda: post de fotos');
  entrega(it.folder!, { network: 'tiktok', text: 'Legenda do TikTok', files: ['marcas/tuco-dev/pecas/carrossel-base/slides/01.png', 'marcas/tuco-dev/pecas/carrossel-base/slides/02.png', 'marcas/tuco-dev/pecas/carrossel-base/slides/03.png', 'peca.md'] });
  manager.finish(it.taskId!); await content.sync();
  const x = content.state().items.find(i => i.id === it.id)!;
  assert.equal(x.status, 'revisar');
  assert.ok(x.checks.find(c => c.name === 'Arquivos da entrega')!.ok, x.checks.find(c => c.name === 'Arquivos da entrega')!.detail);
  assert.match(x.checks.find(c => c.name === 'Entrega exigida')!.detail, /3 imagens exportadas \(listadas na entrega\)/);
  assert.ok(x.checks.find(c => c.name === 'Imagens do carrossel')!.ok, 'imagens reaproveitadas dispensam o carrossel.json');
});
