// Foco nos Instagrams + Threads e Radar da gringa (03/11/2026): destinos pausados não recebem tarefa nem publicam (também
// depois de reiniciar e na retomada da fila), pesquisar numa rede não libera produção nela, a mesma publicação não vira dois
// cartões, a referência do Chefe vira peça, a capacidade segura a fila, o vídeo é conferido de verdade e o Radar roda às 10h e
// 17h na rotina que já existia. Funcionários simulados como em content.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Employee, ServerMessage, Task, TaskRunInput, TaskRunResult } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SocialService } from '../src/social/service.js';
import { MemoryVault } from '../src/social/vault.js';
import { ContentService } from '../src/content/service.js';
import { RoutineService, nextRunAt, scheduleLabel } from '../src/routines.js';
import { parseOpportunity, postKey } from '../src/content/focus.js';
import { parseVideoPlan, type VideoRenderer } from '../src/content/video.js';
import { claudeAccessArgs } from '../src/access.js';
import { tempDir } from './tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(here, '..', '..', 'content-kit');
const FOCO = ['instagram-tuco', 'instagram-aurora', 'threads'] as const;

class FakeManager extends EventEmitter {
  runs: TaskRunInput[] = []; cancelled: string[] = []; interrupted: string[] = [];
  constructor(public store: Store) { super(); }
  cancelQueued(taskId: string) { const t = this.store.getTask(taskId); if (!t || t.status !== 'queued') return; this.cancelled.push(taskId); this.store.updateTask(taskId, { status: 'interrupted', finishedAt: Date.now(), errors: ['Cancelada na fila'] }); }
  async interrupt(sessionId: string) { this.interrupted.push(sessionId); for (const t of this.store.listTasksByStatus(['running', 'waiting_permission', 'waiting_answer']).filter(x => x.sessionId === sessionId)) { this.store.updateTask(t.id, { status: 'interrupted', finishedAt: Date.now() }); this.emit('task_finished', t.id); } }
  setTaskLimit() { /* sem teto no teste */ }
  updateEmployee(id: string, patch: Partial<Employee>) { return this.store.updateEmployee(id, patch); }
  createEmployee(input: { roomId: string; name?: string; role?: string; instructions?: string; permissionMode?: Employee['permissionMode']; provider?: Employee['provider']; skills?: string[]; template?: string | null; profileId?: string | null; access?: Employee['access'] }): Employee {
    const n = this.store.listEmployeesByRoom(input.roomId).length;
    return this.store.createEmployee({ name: input.name!, role: input.role ?? '', roomId: input.roomId, appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: n, instructions: input.instructions, permissionMode: input.permissionMode, provider: input.provider, skills: input.skills, template: input.template, profileId: input.profileId ?? null, access: input.access });
  }
  async runTask(input: TaskRunInput): Promise<TaskRunResult> {
    const dup = this.store.findTaskByClientId(input.clientId);
    if (dup) return { taskId: dup.id, sessionId: dup.sessionId, employeeId: input.employeeId, projectId: input.projectId, status: dup.status, queuePosition: null, queueReason: null, newSession: false, applied: { model: null, effort: null, permissionMode: 'default', source: 'teste' }, notes: [], duplicate: true };
    const e = this.store.getEmployee(input.employeeId)!;
    const s = this.store.listSessionsByEmployee(e.id)[0] ?? this.store.createSession({ roomId: e.roomId, projectId: input.projectId, employeeId: e.id, name: e.name, permissionMode: 'acceptEdits', workerName: e.name, appearance: e.appearance, deskIndex: e.deskIndex });
    const t = this.store.createTask({ clientId: input.clientId, sessionId: s.id, projectId: input.projectId, roomId: e.roomId, prompt: input.text, attachments: [], mode: 'send', employeeId: e.id, destinationId: input.destinationId ?? null });
    this.runs.push(input);
    return { taskId: t.id, sessionId: s.id, employeeId: e.id, projectId: input.projectId, status: 'queued', queuePosition: 1, queueReason: null, newSession: false, applied: { model: null, effort: null, permissionMode: 'acceptEdits', source: 'teste' }, notes: [], duplicate: false };
  }
  finish(taskId: string, status: Task['status'] = 'done') { this.store.updateTask(taskId, { status, finishedAt: Date.now() }); this.emit('task_finished', taskId); }
}

function setupHq(dir = tempDir('hq-foco-'), video: VideoRenderer | null = null) {
  const db = openDb(path.join(dir, 'hq.sqlite'), { backupsDir: path.join(dir, 'backups') });
  const store = new Store(db); store.seedDefaultRooms();
  const broadcasts: ServerMessage[] = [];
  const log = { info: () => {}, warn: () => {} };
  const fetchOk = (async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const social = new SocialService({ db, vault: new MemoryVault(), port: 4799, broadcast: m => broadcasts.push(m), log, profileIds: () => store.listRooms().flatMap(r => r.profiles.map(p => p.id)), fetch: fetchOk });
  const manager = new FakeManager(store);
  const routines = new RoutineService({ store, manager: manager as never, broadcast: m => broadcasts.push(m), log });
  const folder = path.join(dir, 'hq-conteudos');
  const content = new ContentService({
    db, store, manager, social, broadcast: m => broadcasts.push(m), log, kitDir: KIT, defaultFolder: folder, origins: [], siteDir: null, mirrors: [], trusted: () => true,
    routines: { handle: m => routines.handle(m), update: (id, patch) => routines.handle({ type: 'routine.update', reqId: 't', id, patch }) },
    fetch: fetchOk, video,
  });
  return { dir, db, store, social, manager, routines, content, folder };
}

const opp = (o: Record<string, unknown>) => ({
  kind: 'achado', platform: 'instagram', sourceUrl: 'https://www.instagram.com/reel/DAbc123/?igsh=xyz', author: '@devmeme', language: 'en', consultedAt: '2026-11-03T20:10:00-03:00',
  metrics: [{ name: 'curtidas', value: 41000, raw: '41K' }], inspected: 'video_sem_audio', observed: 'abre com a pergunta, revela o terminal', subject: 'Meme do deploy na sexta', summaryPt: 'resumo',
  whyInteresting: 'vida dev', popularity: '41K curtidas em 2 dias', popularityLimit: 'acumulado; não mostra ritmo', evidence: 'referencia', window: '24-48h', slot: 'instagram-tuco', format: 'reel',
  adaptation: 'versão própria em português', opening: 'Sexta, 17h59.', material: 'nenhum', effort: 'baixo', priority: 1, reason: 'encaixa no Tuco', ...o,
});

test('chave do post: mesma publicação com parâmetros diferentes vira a mesma chave; plataformas por id', () => {
  assert.equal(postKey('https://www.instagram.com/reel/DAbc123/?igsh=xyz'), 'instagram:DAbc123');
  assert.equal(postKey('https://instagram.com/p/DAbc123'), 'instagram:DAbc123');
  assert.equal(postKey('https://www.tiktok.com/@dev/video/7430000000000000000?is_from_webapp=1'), 'tiktok:7430000000000000000');
  assert.equal(postKey('https://twitter.com/a/status/1980000000000000001'), postKey('https://x.com/b/status/1980000000000000001'));
  assert.equal(postKey('https://old.reddit.com/r/webdev/comments/1abcd/titulo/'), 'reddit:1abcd');
  assert.equal(postKey('https://exemplo.com/post/?utm_source=x#topo'), 'exemplo.com/post');
  assert.equal(postKey('chefe://123'), null);
  // "padrão" com um criador só vira achado; tendência sem padrão vira referência; métrica sem número fica indisponível.
  const p = parseOpportunity(opp({ kind: 'padrao', evidence: 'tendencia', examples: [{ url: 'https://www.instagram.com/reel/DAbc999/', author: '@devmeme', sameVideo: false }], metrics: [{ name: 'views', raw: '—' }] }));
  assert.ok(p.ok); if (!p.ok) return;
  assert.equal(p.value.kind, 'achado'); assert.equal(p.value.evidence, 'referencia'); assert.equal(p.value.metrics[0].value, null);
  const q = parseOpportunity(opp({ kind: 'padrao', evidence: 'tendencia', examples: [{ url: 'https://www.tiktok.com/@outro/video/1', author: '@outro', sameVideo: false }] }));
  assert.ok(q.ok && q.value.kind === 'padrao' && q.value.evidence === 'tendencia');
  assert.equal(parseOpportunity({ subject: 'x' }).ok, false);
});

test('foco: destinos fora pausam com o motivo (fila cancelada, execução interrompida, nada apagado); não recebem tarefa nem publicam; vale depois de reiniciar', async () => {
  const h = setupHq();
  await h.content.setup();
  const mk = async (slot: string, title: string) => { await h.content.handle({ type: 'content.item.create', reqId: 'c', item: { title, slot: slot as never, format: slot === 'tiktok' ? 'vídeo' : 'post' } }); return h.content.state().items.find(i => i.title === title)!; };
  const tk = await mk('tiktok', 'Corte TikTok'); const li = await mk('linkedin', 'Case LinkedIn'); const th = await mk('threads', 'Post Threads');
  await h.content.handle({ type: 'content.item.produce', reqId: 'p', id: tk.id });
  await h.content.handle({ type: 'content.item.produce', reqId: 'p', id: li.id });
  const liTask = h.content.state().items.find(i => i.id === li.id)!.taskId!;
  h.store.updateTask(liTask, { status: 'running' });
  const r = await h.content.saveFocus([...FOCO], null, null);
  assert.equal(r.paused.length, 2); assert.equal(r.cancelled.length, 2);
  const st = h.content.state();
  const tk2 = st.items.find(i => i.id === tk.id)!; const th2 = st.items.find(i => i.id === th.id)!;
  assert.match(tk2.pausedReason!, /Foco atual: Instagrams Tuco Dev e Aurora \+ Threads Aurora/);
  assert.equal(tk2.status, 'planejada'); assert.equal(tk2.deletedAt, null);
  assert.ok(tk2.history.some(x => x.action === 'pausada'));
  assert.equal(th2.pausedReason, null);
  assert.deepEqual(st.focus.activeSlots, [...FOCO]);
  // Nada novo para destino pausado: produzir, criar, pedido do dia.
  await assert.rejects(h.content.handle({ type: 'content.item.produce', reqId: 'p', id: tk.id }), /destino pausado/);
  await assert.rejects(h.content.handle({ type: 'content.item.create', reqId: 'c', item: { title: 'Pin novo', slot: 'pinterest' } }), /destino pausado/);
  const before = h.manager.runs.length;
  const req = await h.content.handle({ type: 'content.request.create', reqId: 'q', date: '2026-11-05', slots: ['tiktok', 'linkedin', 'threads'], autoProduce: true }) as { produced: number; skipped: string[] };
  assert.ok(req.skipped.some(s => /TikTok: destino pausado/.test(s)));
  assert.ok(h.manager.runs.slice(before).every(x => FOCO.includes(x.destinationId as never) || !x.destinationId), 'nenhuma tarefa nova para destino pausado');
  // Retentativa que aparece depois (queda, limite de uso) para a peça pausada é cancelada na passada seguinte.
  const s = h.store.getSession(h.store.getTask(liTask)!.sessionId)!; // a conversa de quem produziu a peça (equipe da conta)
  const retry = h.store.createTask({ clientId: `retry:${liTask}:2`, sessionId: s.id, projectId: h.content.state().setup.projectId!, roomId: s.roomId, prompt: 'x', attachments: [], mode: 'send', attempt: 2 });
  h.store.updateTask(liTask, { status: 'interrupted', attempt: 1 });
  await h.content.sync();
  assert.equal(h.store.getTask(retry.id)!.status, 'interrupted');
  // Reiniciar: outra instância no mesmo banco mantém o foco e a pausa.
  h.content.stop();
  const again = new ContentService({ db: h.db, store: h.store, manager: h.manager, social: h.social, broadcast: () => {}, log: { info: () => {}, warn: () => {} }, kitDir: KIT, defaultFolder: h.folder, origins: [], siteDir: null, mirrors: [], trusted: () => true });
  assert.deepEqual(again.state().focus.activeSlots, [...FOCO]);
  assert.ok(again.state().items.find(i => i.id === tk.id)!.pausedReason);
  await assert.rejects(again.handle({ type: 'content.item.produce', reqId: 'p', id: tk.id }), /destino pausado/);
  // Voltar ao foco tira a pausa, sem produzir nada sozinho.
  const runs = h.manager.runs.length;
  const back = await again.saveFocus([...FOCO, 'tiktok'], null, null);
  assert.ok(back.resumed.includes(tk.id)); assert.equal(h.manager.runs.length, runs);
});

test('pesquisa ≠ destino: o TikTok como fonte não libera produção nem publicação nele; repetir a coleta atualiza a referência sem cartão novo', async () => {
  const h = setupHq();
  await h.content.setup();
  await h.content.saveFocus([...FOCO], [{ source: 'tiktok', enabled: true }], null);
  const write = (round: { outputPath: string }, list: unknown[], sources: unknown[]) => fs.writeFileSync(round.outputPath, JSON.stringify({ coverage: 'teste', summary: 's', sources, opportunities: list }));
  await h.content.handle({ type: 'content.radar.run', reqId: 'r' });
  const r1 = h.content.state().rounds[0];
  write(r1, [opp({}), opp({ platform: 'tiktok', sourceUrl: 'https://www.tiktok.com/@dev/video/7430000000000000001', slot: 'tiktok', priority: 2, subject: 'Trend do TikTok' })],
    [{ source: 'tiktok', state: 'acessada', detail: 'busca por "coding meme" abriu' }, { source: 'instagram', state: 'bloqueada', detail: 'pediu login' }]);
  h.manager.finish(r1.taskId!);
  await h.content.sync();
  let st = h.content.state();
  assert.equal(st.radar.length, 2);
  const tt = st.radar.find(x => x.platform === 'tiktok')!;
  assert.equal(tt.slot, null, 'destino pausado sai da referência'); assert.equal(tt.priority, null);
  assert.equal(st.focus.sources.find(s => s.source === 'instagram')!.access, 'bloqueada');
  assert.equal(st.focus.sources.find(s => s.source === 'tiktok')!.access, 'acessada');
  // X e Reddit não foram pesquisados nesta rodada: não ficam com o aviso de uma rodada antiga
  for (const src of ['x', 'reddit'] as const) { const s = st.focus.sources.find(x => x.source === src)!; assert.equal(s.access, 'nao_verificada'); assert.match(s.detail ?? '', /não pesquisada na rodada de/); }
  assert.ok(!st.items.some(i => i.slot === 'tiktok'), 'nenhuma peça para o TikTok');
  // A prioridade do destino ativo foi para a produção sozinha (capacidade livre).
  const ig = st.items.find(i => i.slot === 'instagram-tuco')!;
  assert.equal(ig.status, 'em_producao'); assert.deepEqual(ig.referenceIds, [st.radar.find(x => x.platform === 'instagram')!.id]);
  await assert.rejects(h.content.handle({ type: 'content.radar.select', reqId: 's', id: tt.id, slot: 'tiktok' }), /destino pausado/);
  assert.equal(h.content.publishGate(ig.id, 'tiktok').ok, false);
  // Segunda coleta do mesmo post (outra URL do mesmo reel): atualiza, conta a coleta, não cria cartão nem peça.
  await h.content.handle({ type: 'content.radar.run', reqId: 'r2' });
  const r2 = h.content.state().rounds[0];
  write(r2, [opp({ sourceUrl: 'https://instagram.com/reel/DAbc123', metrics: [{ name: 'curtidas', value: 52000, raw: '52K' }] })], []);
  h.manager.finish(r2.taskId!);
  await h.content.sync();
  st = h.content.state();
  assert.equal(st.radar.length, 2);
  const again = st.radar.find(x => x.platform === 'instagram')!;
  assert.equal(again.seen, 2); assert.equal(again.metrics[0].value, 52000);
  assert.equal(st.items.filter(i => i.slot === 'instagram-tuco').length, 1);
  assert.match(st.rounds.find(x => x.id === r2.id)!.error!, /atualizadas \(sem cartão novo\)/);
});

test('capacidade: no máximo 3 ideias do Radar na produção; revisão acumulada segura a fila', async () => {
  const h = setupHq();
  await h.content.setup();
  await h.content.saveFocus([...FOCO], null, null);
  await h.content.handle({ type: 'content.radar.run', reqId: 'r' });
  const r1 = h.content.state().rounds[0];
  const list = [1, 2, 3].map(n => opp({ sourceUrl: `https://www.reddit.com/r/webdev/comments/a${n}/x/`, platform: 'reddit', slot: n === 3 ? 'threads' : 'instagram-aurora', priority: n, subject: `Ideia ${n}` }));
  fs.writeFileSync(r1.outputPath, JSON.stringify({ coverage: 'c', summary: 's', opportunities: list }));
  h.manager.finish(r1.taskId!);
  await h.content.sync();
  assert.equal(h.content.state().capacity.load, 3);
  await h.content.handle({ type: 'content.radar.run', reqId: 'r2' });
  const r2 = h.content.state().rounds[0];
  fs.writeFileSync(r2.outputPath, JSON.stringify({ coverage: 'c', summary: 's', opportunities: [opp({ sourceUrl: 'https://x.com/a/status/42', platform: 'x', subject: 'Quarta ideia' })] }));
  h.manager.finish(r2.taskId!);
  await h.content.sync();
  const st = h.content.state();
  assert.match(st.capacity.blocked!, /limite 3/);
  assert.equal(st.radar.find(x => x.subject === 'Quarta ideia')!.status, 'nova', 'fica no Radar');
  assert.equal(st.items.filter(i => i.radarId).length, 3);
});

test('referência do Chefe: imagem sem link vira referência "chefe", o pesquisador analisa e a peça segue para a produção ligada a ela', async () => {
  const h = setupHq();
  await h.content.setup();
  await h.content.saveFocus([...FOCO], null, null);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const r = await h.content.handle({ type: 'content.reference.add', reqId: 'a', reference: { files: [{ name: 'meme.png', mediaType: 'image/png', dataBase64: png.toString('base64') }], text: 'jogos → redes → programação', title: 'Meme da evolução dos apps' } }) as { radarId: string; roundId: string };
  let st = h.content.state();
  const ref = st.radar.find(x => x.id === r.radarId)!;
  assert.equal(ref.kind, 'chefe'); assert.equal(ref.status, 'analisando'); assert.match(ref.sourceUrl, /^chefe:\/\//);
  assert.ok(fs.existsSync(ref.files[0])); assert.match(ref.files[0], /radar[\\/]entrada/);
  const round = st.rounds.find(x => x.id === r.roundId)!;
  assert.equal(round.kind, 'referencia');
  assert.match(h.manager.runs.at(-1)!.text, /NÃO comprova/);
  fs.writeFileSync(round.outputPath, JSON.stringify({ summary: 'captura de um vídeo de 15 s', reference: { subject: 'Os aplicativos mudaram. O vício continuou.', consultedAt: '2026-11-03T20:30:00-03:00', evidence: 'nao_verificado', inspected: 'captura', observed: 'quatro faixas', whyInteresting: 'reconhecimento da evolução', popularity: 'sem métrica (captura)', popularityLimit: 'não mostra áudio nem autoria', slot: 'instagram-tuco', format: 'reel', adaptation: 'Reel próprio com revelação', reason: 'identificação gera compartilhamento' } }));
  h.manager.finish(round.taskId!);
  await h.content.sync();
  st = h.content.state();
  const ref2 = st.radar.find(x => x.id === r.radarId)!;
  assert.equal(ref2.status, 'virou_peca'); assert.equal(ref2.kind, 'chefe'); assert.equal(ref2.note, 'jogos → redes → programação');
  const item = st.items.find(i => i.id === ref2.itemId)!;
  assert.equal(item.slot, 'instagram-tuco'); assert.equal(item.format, 'Reel'); assert.equal(item.status, 'em_producao');
  assert.deepEqual(item.referenceIds, [r.radarId]); assert.match(item.hypothesis!, /compartilhamento/);
  assert.match(h.manager.runs.at(-1)!.text, /video\.json/);
  // Pedido de ajuste volta para a mesma peça (sem cartão novo).
  h.manager.finish(item.taskId!, 'error');
  await h.content.sync();
  await h.content.handle({ type: 'content.item.produce', reqId: 'p', id: item.id, note: 'mais movimento na revelação' });
  assert.equal(h.content.state().items.filter(i => i.referenceIds.includes(r.radarId)).length, 1);
});

test('vídeo: video.json sem ação ou só com zoom é recusado; render falho e áudio provisório viram pendência (entrega parcial)', async () => {
  const cena = (id: string, acao: string) => ({ id, tipo: 'fase', duracao: 3, mostra: 'm', acao, informacao: 'i', transicao: 't' });
  assert.equal(parseVideoPlan({ marca: 'tuco-dev', titulo: 't', cenas: [cena('a', 'ícones entram'), cena('b', 'zoom lento'), cena('c', 'toque')] }).ok, false);
  assert.equal(parseVideoPlan({ marca: 'tuco-dev', titulo: 't', cenas: [cena('a', 'x'), cena('b', 'y')] }).ok, false);
  const ok = parseVideoPlan({ marca: 'tuco-dev', titulo: 't', cenas: [cena('a', 'ícones entram'), cena('b', 'toque desmonta os blocos'), { ...cena('c', 'texto final entra'), tipo: 'encerramento', transicao: undefined }] });
  assert.ok(ok.ok && ok.value.duracao === 9);
  const renders: string[] = [];
  const failing: VideoRenderer = { ffprobe: 'ffprobe-que-nao-existe', ffmpeg: 'ffmpeg-que-nao-existe', async render(o) { renders.push(o.out); return { ok: false, error: 'o render falhou (código 1): erro de teste', ms: 5 }; } };
  const h = setupHq(undefined, failing);
  await h.content.setup();
  await h.content.saveFocus([...FOCO], null, null);
  await h.content.handle({ type: 'content.item.create', reqId: 'c', item: { title: 'Reel teste', slot: 'instagram-tuco', format: 'Reel' } });
  const it = h.content.state().items[0];
  await h.content.handle({ type: 'content.item.produce', reqId: 'p', id: it.id });
  const folder = h.content.state().items[0].folder!;
  fs.writeFileSync(path.join(folder, 'video.json'), JSON.stringify({ marca: 'tuco-dev', titulo: 't', audio: { trilha: 'gerada', sfx: true, provisorio: true }, cenas: [cena('a', 'ícones entram'), cena('b', 'toque'), cena('c', 'revela')] }));
  fs.writeFileSync(path.join(folder, 'peca.md'), '# Reel\n\nLegenda final.');
  fs.writeFileSync(path.join(folder, 'entrega.json'), JSON.stringify({ title: 'Reel teste', network: 'instagram', text: 'Legenda final do Reel.', files: ['video.json', 'peca.md'], sources: [], needs: [], nextStep: null }));
  h.manager.finish(h.content.state().items[0].taskId!);
  await h.content.sync();
  const done = h.content.state().items[0];
  assert.equal(renders.length, 1);
  assert.equal(done.status, 'parcial');
  assert.ok(done.checks.some(c => c.name === 'Render do vídeo' && !c.ok && /erro de teste/.test(c.detail)));
  assert.match(done.nextStep!, /vídeo/);
});

test('vídeo de verdade (ffmpeg): MP4 aberto pelo ffprobe, formato planejado e movimento medido por cena', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 ? 'ffmpeg não instalado' : false }, async () => {
  const dir = tempDir('hq-video-');
  const real: VideoRenderer = {
    ffprobe: 'ffprobe', ffmpeg: 'ffmpeg',
    async render(o) {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '9', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', o.out]);
      spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', '4', '-i', o.out, '-frames:v', '1', o.cover]);
      return { ok: r.status === 0, error: r.status === 0 ? null : String(r.stderr), ms: 1 };
    },
  };
  const h = setupHq(dir, real);
  await h.content.setup();
  const folder = path.join(h.folder, 'teste-video'); fs.mkdirSync(folder, { recursive: true });
  const cena = (id: string) => ({ id, tipo: 'fase', duracao: 3, mostra: 'm', acao: 'ícones entram', informacao: 'i', transicao: 't' });
  fs.writeFileSync(path.join(folder, 'video.json'), JSON.stringify({ marca: 'tuco-dev', titulo: 't', audio: { trilha: 'gerada', sfx: true, provisorio: false }, cenas: [cena('a'), cena('b'), cena('c')] }));
  const checks = await h.content.renderVideo(folder, path.join(folder, 'video.json'));
  const by = (n: string) => checks.find(c => c.name === n)!;
  assert.ok(by('Vídeo abre').ok, by('Vídeo abre').detail); assert.match(by('Vídeo abre').detail, /1080×1920/);
  assert.ok(by('Formato planejado').ok, by('Formato planejado').detail);
  assert.ok(by('Movimento por cena').ok, by('Movimento por cena').detail);
  const rep = JSON.parse(fs.readFileSync(path.join(folder, 'video-conferencia.json'), 'utf8')) as { ok: boolean; motion: { motion: number }[] };
  assert.equal(rep.ok, true); assert.equal(rep.motion.length, 3);
});

test('áudio de outro vídeo (ffmpeg): audio-referencia.json gera video-com-audio.mp4 com o trecho no instante marcado; o video.mp4 fica sem ele', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 ? 'ffmpeg não instalado' : false }, async () => {
  const dir = tempDir('hq-mix-');
  // Render sem faixa de áudio (trilha "nenhuma"): o áudio da referência vira o som do vídeo misturado.
  const real: VideoRenderer = {
    ffprobe: 'ffprobe', ffmpeg: 'ffmpeg',
    async render(o) {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-t', '9', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', o.out]);
      spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', '4', '-i', o.out, '-frames:v', '1', o.cover]);
      return { ok: r.status === 0, error: r.status === 0 ? null : String(r.stderr), ms: 1 };
    },
  };
  const h = setupHq(dir, real);
  await h.content.setup();
  const folder = path.join(h.folder, 'teste-mix'); fs.mkdirSync(folder, { recursive: true });
  const audioDir = path.join(h.folder, 'radar', 'entrada', 'ref', 'extra-2-audio'); fs.mkdirSync(audioDir, { recursive: true });
  const audio = path.join(audioDir, 'audio.m4a');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8', '-c:a', 'aac', audio]);
  const cena = (id: string) => ({ id, tipo: 'fase', duracao: 3, mostra: 'm', acao: 'ícones entram', informacao: 'i', transicao: 't' });
  fs.writeFileSync(path.join(folder, 'video.json'), JSON.stringify({ marca: 'tuco-dev', titulo: 't', audio: { trilha: 'nenhuma', sfx: false, provisorio: false }, cenas: [cena('a'), cena('b'), cena('c')] }));
  fs.writeFileSync(path.join(folder, 'audio-referencia.json'), JSON.stringify({ arquivo: audio, entraEm: 3, inicio: 0, fim: 4, volume: 1 }));
  const checks = await h.content.renderVideo(folder, path.join(folder, 'video.json'));
  const mix = checks.find(c => c.name === 'Áudio da referência')!;
  assert.ok(mix?.ok, mix?.detail); assert.match(mix.detail, /entrando em 3,0 s/); assert.match(mix.detail, /terceiros/);
  const out = path.join(folder, 'video-com-audio.mp4');
  const vol = (ss: number, t: number) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(ss), '-t', String(t), '-i', out, '-af', 'volumedetect', '-vn', '-f', 'null', '-']); return Number(String(r.stderr).match(/max_volume: (-?[\d.]+|-inf) dB/)?.[1] ?? '-999'); };
  assert.ok(vol(0, 2.5) < -50, `silêncio antes de 3 s (${vol(0, 2.5)} dB)`);
  assert.ok(vol(3.5, 3) > -20, `áudio entre 3,5 e 6,5 s (${vol(3.5, 3)} dB)`);
  assert.ok(vol(7.5, 1.4) < -50, `trecho termina em 4 s de áudio, ou seja aos 7 s do vídeo (${vol(7.5, 1.4)} dB)`);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(folder, 'video.mp4')]);
  assert.doesNotMatch(String(probe.stdout), /audio/, 'o video.mp4 continua sem o áudio de terceiros');
  // Lista de arquivos da peça: o vídeo com o áudio aparece com nome legível. Áudio fora da pasta de conteúdo é recusado.
  fs.writeFileSync(path.join(folder, 'audio-referencia.json'), JSON.stringify({ arquivo: path.join(dir, 'fora.m4a'), entraEm: 1 }));
  fs.copyFileSync(audio, path.join(dir, 'fora.m4a'));
  const again = await h.content.renderVideo(folder, path.join(folder, 'video.json'));
  const bad = again.find(c => c.name === 'Áudio da referência')!;
  assert.equal(bad.ok, false); assert.match(bad.detail, /pasta de conteúdo/);
});

test('Radar às 10:00 e 17:00 na rotina que já existia (sem duplicar); pesquisador vira o Radar da gringa com pesquisa na web só leitura', async () => {
  const s = { kind: 'daily' as const, time: '10:00', times: ['10:00', '17:00'] };
  assert.equal(scheduleLabel(s), 'todo dia às 10:00 e 17:00');
  const t0 = Date.parse('2026-11-03T11:00:00-03:00');
  assert.equal(nextRunAt(s, t0), Date.parse('2026-11-03T17:00:00-03:00'));
  assert.equal(nextRunAt(s, Date.parse('2026-11-03T17:30:00-03:00')), Date.parse('2026-11-04T10:00:00-03:00'));
  const h = setupHq();
  await h.content.setup();
  const radar = h.store.listRoutines().find(r => r.workflow === 'content.radar')!;
  assert.deepEqual((radar.schedule as { times?: string[] }).times, ['10:00', '17:00'], 'instalação nova já nasce às 10:00 e 17:00');
  // Instalação antiga (rotina de 08:00 de 02/11): a HQ atualiza a mesma rotina uma vez, sem criar outra.
  h.store.updateRoutine(radar.id, { schedule: { kind: 'daily', time: '08:00' }, title: 'Radar diário (pesquisa)' });
  h.content.start(3_600_000);
  await new Promise(r => setTimeout(r, 50));
  h.content.stop();
  const after = h.store.listRoutines().filter(r => r.workflow === 'content.radar');
  assert.equal(after.length, 1);
  assert.deepEqual((after[0].schedule as { times?: string[] }).times, ['10:00', '17:00']);
  assert.equal(after[0].title, 'Radar da gringa (pesquisa)');
  const sched = h.content.state().radarSchedule;
  assert.equal(sched.label, 'todo dia às 10:00 e 17:00'); assert.match(sched.note, /notebook\) ligado/);
  const caio = h.store.listEmployees().find(e => e.template === 'conteudo-pesquisador')!;
  assert.equal(caio.role, 'Pesquisador de tendências — Radar da gringa'); assert.equal(caio.access?.web, true);
  const args = claudeAccessArgs({ mcp: 'none', web: true });
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  assert.ok(!claudeAccessArgs({ mcp: 'none' }).includes('--allowedTools'));
});

test('renderizar de novo: mesma peça, versão anterior guardada, conferência refeita e revisão de volta na fila (a criação não é acionada)', async () => {
  let n = 0;
  const fake: VideoRenderer = { ffprobe: 'ffprobe-que-nao-existe', ffmpeg: 'ffmpeg-que-nao-existe', async render(o) { n++; fs.writeFileSync(o.out, `mp4 ${n}`); fs.writeFileSync(o.cover, 'png'); return { ok: true, error: null, ms: 1 }; } };
  const h = setupHq(undefined, fake);
  await h.content.setup();
  await h.content.saveFocus([...FOCO], null, null);
  await h.content.handle({ type: 'content.item.create', reqId: 'c', item: { title: 'Reel', slot: 'instagram-tuco', format: 'Reel' } });
  const it = h.content.state().items[0];
  await h.content.handle({ type: 'content.item.produce', reqId: 'p', id: it.id });
  const folder = h.content.state().items[0].folder!;
  const cena = (id: string) => ({ id, tipo: 'fase', duracao: 3, mostra: 'm', acao: 'ícones entram', informacao: 'i', transicao: 't' });
  fs.writeFileSync(path.join(folder, 'video.json'), JSON.stringify({ marca: 'tuco-dev', titulo: 't', audio: { trilha: 'gerada', sfx: true, provisorio: false }, cenas: [cena('a'), cena('b'), cena('c')] }));
  fs.writeFileSync(path.join(folder, 'entrega.json'), JSON.stringify({ title: 'Reel', network: 'instagram', text: 'Legenda.', files: ['video.json'], sources: [] }));
  h.manager.finish(h.content.state().items[0].taskId!);
  await h.content.sync();
  const runsBefore = h.manager.runs.filter(r => /Produzir a peça/.test(r.text)).length;
  await h.content.handle({ type: 'content.item.rerender', reqId: 'r', id: it.id });
  const after = h.content.state().items.find(i => i.id === it.id)!;
  assert.equal(n, 2, 'renderizou de novo');
  assert.equal(fs.readFileSync(path.join(folder, 'video.mp4'), 'utf8'), 'mp4 2');
  const vers = fs.readdirSync(path.join(folder, 'versoes'));
  assert.equal(vers.length, 1); assert.equal(fs.readFileSync(path.join(folder, 'versoes', vers[0], 'video.mp4'), 'utf8'), 'mp4 1');
  assert.ok(after.history.some(x => x.action === 'render refeito pela HQ'));
  assert.equal(h.content.state().items.length, 1, 'mesma peça');
  assert.equal(h.manager.runs.filter(r => /Produzir a peça/.test(r.text)).length, runsBefore, 'a criação não foi acionada');
});

test('resultados: a peça guarda a hipótese e a decisão (repetir, ajustar, testar, abandonar) com o que os números mostraram', async () => {
  const h = setupHq();
  await h.content.setup();
  await h.content.handle({ type: 'content.item.create', reqId: 'c', item: { title: 'Post', slot: 'threads', format: 'post', hypothesis: 'pergunta específica puxa respostas' } });
  const it = h.content.state().items[0];
  assert.equal(it.hypothesis, 'pergunta específica puxa respostas');
  await assert.rejects(h.content.handle({ type: 'content.item.learning', reqId: 'l', id: it.id, decision: 'repetir', note: ' ' }), /Escreva/);
  await h.content.handle({ type: 'content.item.learning', reqId: 'l', id: it.id, decision: 'testar', note: '24 h: 3 respostas, 41 visualizações (Threads); preliminar' });
  const after = h.content.state().items[0];
  assert.equal(after.learning?.decision, 'testar'); assert.match(after.learning!.note, /preliminar/);
  assert.ok(after.history.some(x => x.action === 'decisão pelos resultados'));
});

test('aprovar e desfazer: peça em "ajustar" pode ser aprovada pelo Chefe; desfazer volta para "Para revisar" e revoga o lote vazio', async () => {
  const h = setupHq();
  await h.content.setup();
  await h.content.saveFocus([...FOCO], null, null);
  await h.content.handle({ type: 'content.item.create', reqId: 'c', item: { title: 'Post', slot: 'threads', format: 'post' } });
  const it = h.content.state().items[0];
  h.db.prepare("UPDATE content_items SET status='ajustar' WHERE id=?").run(it.id);
  await h.content.handle({ type: 'content.approve', reqId: 'a', itemIds: [it.id], from: '2026-11-04', to: '2026-11-11', note: null });
  let x = h.content.state().items[0];
  assert.equal(x.status, 'aprovada'); assert.ok(x.history.some(e => e.action === 'aprovada pelo Chefe' && /pedido de ajuste/.test(e.detail ?? '')));
  const approvalId = x.approvalId!;
  await h.content.handle({ type: 'content.items.unapprove', reqId: 'u', ids: [it.id] });
  x = h.content.state().items[0];
  assert.equal(x.status, 'revisar'); assert.equal(x.approvalId, null);
  assert.ok(h.content.state().approvals.find(a => a.id === approvalId)!.revokedAt, 'lote sem peça revogado');
  h.db.prepare("UPDATE content_items SET status='parcial' WHERE id=?").run(it.id);
  await assert.rejects(h.content.handle({ type: 'content.approve', reqId: 'a', itemIds: [it.id], from: '2026-11-04', to: '2026-11-11', note: null }), /Só peças entregues/);
});

test('"Já publiquei": aprova se faltava e marca como publicada; link de outra rede é recusado; sem link fica "informado pelo Chefe" e aceita o link depois; desfazer volta para aprovada', async () => {
  const h = setupHq();
  await h.content.setup();
  await h.content.saveFocus([...FOCO], null, null);
  await h.content.handle({ type: 'content.item.create', reqId: 'c', item: { title: 'Carrossel', slot: 'instagram-aurora', format: 'carrossel' } });
  const it = h.content.state().items[0];
  h.db.prepare("UPDATE content_items SET status='parcial' WHERE id=?").run(it.id);
  await assert.rejects(h.content.handle({ type: 'content.item.markPublished', reqId: 'm', id: it.id }), /entrega completa/);
  h.db.prepare("UPDATE content_items SET status='revisar' WHERE id=?").run(it.id);
  await assert.rejects(h.content.handle({ type: 'content.item.markPublished', reqId: 'm', id: it.id, url: 'https://x.com/a/status/1' }), /Link não aceito/);
  await h.content.handle({ type: 'content.item.markPublished', reqId: 'm', id: it.id });
  let x = h.content.state().items[0];
  assert.equal(x.status, 'publicada'); assert.equal(x.publication?.verifiedBy, 'chefe'); assert.equal(x.publication?.url, null);
  assert.ok(x.approvalId, 'aprovada junto'); assert.ok(x.history.some(e => e.action === 'aprovada pelo Chefe') && x.history.some(e => e.action === 'publicada pelo Chefe'));
  const at = x.publication!.at;
  await h.content.handle({ type: 'content.item.markPublished', reqId: 'm', id: it.id, url: 'https://www.instagram.com/p/DAbc123/' });
  x = h.content.state().items[0];
  assert.equal(x.publication?.url, 'https://www.instagram.com/p/DAbc123/'); assert.equal(x.publication?.verifiedBy, 'link'); assert.equal(x.publication?.at, at, 'mantém a hora da publicação');
  await assert.rejects(h.content.handle({ type: 'content.item.markPublished', reqId: 'm', id: it.id, url: 'https://www.instagram.com/p/OUTRO/' }), /já está registrada/);
  await h.content.handle({ type: 'content.item.unmarkPublished', reqId: 'u', id: it.id });
  x = h.content.state().items[0];
  assert.equal(x.status, 'aprovada'); assert.equal(x.publication, null);
});
