// Referência de vídeo (link ou arquivo → inspeção → análise → produção; reunião só no modo análise): o vídeo é gerado aqui com o FFmpeg (sem
// rede), a reunião é simulada (o gerente "fala" gravando a síntese como a reunião real grava) e os funcionários são o
// FakeManager. Confere: quadros anexados ao pedido do pesquisador, reunião com os papéis, modo análise sem produção, modo
// produzir com tarefa real, mesmo link sem cartão duplicado, bloqueio com ação útil e retomada depois de reiniciar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Employee, MeetingClientMessage, MeetingMessage, ServerMessage, Task, TaskRunInput, TaskRunResult } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SocialService } from '../src/social/service.js';
import { MemoryVault } from '../src/social/vault.js';
import { ContentService } from '../src/content/service.js';
import { RoutineService } from '../src/routines.js';
import { classifyFetchError, type VideoTools } from '../src/content/videoref.js';
import { tempDir } from './tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(here, '..', '..', 'content-kit');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

class FakeManager extends EventEmitter {
  runs: TaskRunInput[] = [];
  constructor(public store: Store) { super(); }
  cancelQueued() { /* sem fila no teste */ }
  setTaskLimit() { /* sem teto */ }
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

/** Reunião simulada: guarda o que a sala pediu e deixa o teste gravar a síntese do gerente. */
class FakeMeetings {
  calls: MeetingClientMessage[] = [];
  msgs: MeetingMessage[] = [];
  n = 0;
  /** Simula o banco real: id de contexto é chave primária global (05/11: "briefing" fixo quebrou na 2ª referência). */
  ctxIds = new Set<string>();
  failCreate: string | null = null;
  async handle(msg: MeetingClientMessage): Promise<unknown> {
    this.calls.push(msg);
    if (msg.type === 'meeting.create') {
      if (this.failCreate) throw new Error(this.failCreate);
      this.n++;
      return { meeting: { id: this.n === 1 ? 'm1' : `m${this.n}`, participants: msg.participants.map((p, i) => ({ id: `p${i}`, provider: p.provider, employeeId: p.employeeId ?? null })) } };
    }
    if (msg.type === 'meeting.context.set') {
      for (const it of msg.items) { if (this.ctxIds.has(String(it.id))) throw new Error('UNIQUE constraint failed: meeting_context_items.id'); this.ctxIds.add(String(it.id)); }
    }
    return {};
  }
  messages(id: string) { return this.msgs.filter(m => m.meetingId === id); }
  synthesis(text: string) { this.msgs.push({ id: 'syn1', meetingId: 'm1', turnId: 't9', participantId: 'p3', authorName: 'Claude', provider: 'claude', kind: 'speech', text, round: 2, phase: 'synthesis', targets: [], config: null, contextVersion: 1, partial: false, ts: Date.now() } as unknown as MeetingMessage); }
}

function setup(o: { ytdlp?: string | null } = {}) {
  const dir = tempDir('hq-video-');
  const db = openDb(path.join(dir, 'hq.sqlite'), { backupsDir: path.join(dir, 'backups') });
  const store = new Store(db); store.seedDefaultRooms();
  const log = { info: () => {}, warn: () => {} };
  const ok = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
  const social = new SocialService({ db, vault: new MemoryVault(), port: 4799, broadcast: () => {}, log, profileIds: () => store.listRooms().flatMap(r => r.profiles.map(p => p.id)), fetch: ok });
  const manager = new FakeManager(store);
  const routines = new RoutineService({ store, manager: manager as never, broadcast: () => {}, log });
  const meetings = new FakeMeetings();
  const tools: VideoTools = { ytdlp: o.ytdlp ?? null, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', whisper: null, font: ['C:\\Windows\\Fonts\\arial.ttf'].find(f => fs.existsSync(f)) ?? null, page: null };
  const mk = () => new ContentService({
    db, store, manager, social, broadcast: (_m: ServerMessage) => {}, log, kitDir: KIT, defaultFolder: path.join(dir, 'hq-conteudos'), origins: [], siteDir: null, mirrors: [], trusted: () => true,
    routines: { handle: m => routines.handle(m), update: (id, patch) => routines.handle({ type: 'routine.update', reqId: 't', id, patch }) }, fetch: ok, videoTools: tools, meetings,
  });
  return { dir, db, store, manager, meetings, mk, content: mk() };
}

async function until<T>(fn: () => T | null | undefined | false, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando a condição'); await new Promise(r => setTimeout(r, 100)); }
}

function sampleVideo(dir: string): string {
  const f = path.join(dir, 'ref.mp4');
  // Dois planos (corte em 3 s), com áudio: vira "vídeo inteiro em quadros" e mede o corte.
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=3', '-f', 'lavfi', '-i', 'color=c=red:size=360x640:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  return f;
}

test('erro do yt-dlp vira motivo legível e a ação útil', () => {
  assert.deepEqual(classifyFetchError('ERROR: [instagram] x: Requested content is not available, rate-limit reached or login required').actions, ['login', 'anexar']);
  assert.match(classifyFetchError('HTTP Error 404: Not Found').reason, /não foi encontrado/);
  assert.deepEqual(classifyFetchError('Unsupported URL: https://exemplo.com').actions, ['anexar']);
});

test('arquivo + "quero um vídeo inspirado neste para o Tuco Dev": inspeção real, quadros anexados ao pesquisador e, da análise, a produção direta (sem reunião)', { skip: HAS_FFMPEG ? false : 'ffmpeg não instalado' }, async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'threads'], null, null);
  const mp4 = fs.readFileSync(sampleVideo(h.dir)).toString('base64');
  const r = await h.content.handle({ type: 'content.video.add', reqId: 'v', ref: { file: { name: 'meu-video.mp4', mediaType: 'video/mp4', dataBase64: mp4 }, instruction: 'quero um vídeo inspirado neste para o Tuco Dev', liked: 'a virada em 00:03' } }) as { radarId: string; mode: string };
  assert.equal(r.mode, 'produzir');
  const ref = await until(() => { const x = h.content.state().radar.find(y => y.id === r.radarId); return x?.video?.stage === 'analisando' || x?.video?.stage === 'bloqueada' ? x : null; });
  assert.equal(ref.video!.stage, 'analisando', ref.video!.error ?? '');
  assert.equal(ref.kind, 'chefe'); assert.equal(ref.video!.slot, 'instagram-tuco');
  assert.equal(ref.video!.inspection!.level, 'video_sem_audio');
  assert.ok(ref.video!.inspection!.cuts.some(c => Math.abs(c - 3) < 0.3), `corte medido em 3 s: ${ref.video!.inspection!.cuts}`);
  assert.ok(ref.video!.inspection!.limits.some(l => /música, efeitos sonoros e mixagem não foram ouvidos/.test(l)));
  const ask = h.manager.runs.at(-1)!;
  assert.ok((ask.attachments ?? []).some(a => /^folha-\d+\.png$/.test(a.name) && a.mediaType === 'image/png'), 'folhas de quadros anexadas como imagem');
  assert.match(ask.text, /anexadas como imagem/); assert.match(ask.text, /a virada em 00:03/);
  assert.ok(fs.existsSync(path.join(ref.video!.dir, 'evidencias.md')));
  // pasta da equipe (08/11): referência do Tuco Dev fica em marcas/tuco-dev/referencias, não na entrada geral
  assert.match(ref.video!.dir.split(path.sep).join('/'), /\/marcas\/tuco-dev\/referencias\/[^/]+-video-/);
  // O pesquisador grava a análise; no modo produzir a HQ vai direto para a produção (sem reunião no meio, decisão de 05/11).
  const round = h.content.state().rounds.find(x => x.kind === 'video')!;
  fs.writeFileSync(round.outputPath, JSON.stringify({ ideiaCentral: 'um corte seco troca o padrão pelo vermelho', promessa: 'surpresa', recomendada: { titulo: 'Corte que revela', resumo: 'Reel do Tuco com a virada no meio', motivo: 'mecanismo simples', esforco: 'baixo' } }));
  fs.writeFileSync(path.join(path.dirname(round.outputPath), 'analise.md'), '# Análise');
  h.manager.finish(round.taskId!);
  await h.content.sync();
  assert.ok(!h.meetings.calls.some(c => c.type === 'meeting.create'), 'nenhuma reunião no modo produzir');
  const after = h.content.state().radar.find(y => y.id === r.radarId)!;
  assert.equal(after.video!.itemIds.length, 1);
  const item = h.content.state().items.find(i => i.id === after.video!.itemIds[0])!;
  assert.equal(item.slot, 'instagram-tuco'); assert.equal(item.format, 'Reel'); assert.equal(item.status, 'em_producao'); assert.equal(item.skill, 'milweb-video-studio');
  assert.deepEqual(item.referenceIds, [r.radarId]); assert.match(item.brief, /virada no meio/);
  assert.equal(after.video!.stage, 'producao');
  // Reenviar o mesmo arquivo não é o mesmo link: mas pedir de novo a mesma conta pela referência não duplica a peça.
  await h.content.handle({ type: 'content.video.produce', reqId: 'p', id: r.radarId, slot: 'instagram-tuco' });
  assert.equal(h.content.state().items.filter(i => i.referenceIds.includes(r.radarId)).length, 1);
});

test('só o link (sem instrução): modo análise, sem produção; mesmo link não cria outro cartão; bloqueio com ações; "Produzir esta versão" produz', async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'threads'], null, null);
  const url = 'https://www.tiktok.com/@alguem/video/7700000000000000001';
  const r = await h.content.handle({ type: 'content.video.add', reqId: 'v', ref: { url } }) as { radarId: string; mode: string };
  assert.equal(r.mode, 'analise');
  const blocked = await until(() => { const x = h.content.state().radar.find(y => y.id === r.radarId); return x?.video?.stage === 'bloqueada' ? x : null; });
  assert.ok(blocked.video!.inspection!.blocked!.actions.length > 0, 'ação útil'); assert.match(blocked.video!.error!, /yt-dlp|acesso|ferramenta/);
  const again = await h.content.handle({ type: 'content.video.add', reqId: 'v2', ref: { url: `${url}?is_from_webapp=1`, liked: 'o humor' } }) as { radarId: string; reused: boolean };
  assert.equal(again.reused, true); assert.equal(again.radarId, r.radarId);
  assert.equal(h.content.state().radar.filter(x => x.video).length, 1, 'um cartão só');
  assert.equal(h.content.state().radar.find(y => y.id === r.radarId)!.video!.liked, 'o humor');
  assert.equal(h.manager.runs.length, 0, 'modo análise bloqueado não cria tarefa nenhuma');
  // Simula a proposta pronta (análise e síntese) e o Chefe clica "Produzir esta versão".
  const v = h.content.state().radar.find(y => y.id === r.radarId)!.video!;
  h.db.prepare('UPDATE content_radar SET data_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse((h.db.prepare('SELECT data_json FROM content_radar WHERE id=?').get(r.radarId) as { data_json: string }).data_json), video: { ...v, stage: 'proposta', synthesis: { messageId: 's', text: 'Recomendada: X', author: 'Claude', at: 1 } } }), r.radarId);
  assert.equal(h.content.state().items.length, 0, 'proposta não produz sozinha');
  await assert.rejects(h.content.handle({ type: 'content.video.produce', reqId: 'p', id: r.radarId, slot: 'tiktok' }), /destino pausado/);
  await h.content.handle({ type: 'content.video.produce', reqId: 'p', id: r.radarId, slot: 'instagram-aurora' });
  const item = h.content.state().items[0];
  assert.equal(item.slot, 'instagram-aurora'); assert.equal(item.status, 'em_producao');
});

test('reiniciar no meio da inspeção: a outra instância retoma a mesma referência, sem cartão novo', { skip: HAS_FFMPEG ? false : 'ffmpeg não instalado' }, async () => {
  const h = setup();
  await h.content.setup();
  const mp4 = fs.readFileSync(sampleVideo(h.dir)).toString('base64');
  const r = await h.content.handle({ type: 'content.video.add', reqId: 'v', ref: { file: { name: 'x.mp4', mediaType: 'video/mp4', dataBase64: mp4 }, slot: 'instagram-tuco' } }) as { radarId: string };
  await until(() => h.content.state().radar.find(y => y.id === r.radarId)?.video?.stage === 'analisando');
  // Força o estado "inspecionando" como se a HQ tivesse caído no meio; a nova instância retoma na passada.
  const row = h.db.prepare('SELECT data_json FROM content_radar WHERE id=?').get(r.radarId) as { data_json: string };
  const d = JSON.parse(row.data_json); d.video.stage = 'inspecionando';
  h.db.prepare('UPDATE content_radar SET data_json=? WHERE id=?').run(JSON.stringify(d), r.radarId);
  const runs = h.manager.runs.length;
  const again = h.mk();
  await again.sync();
  await until(() => again.state().radar.find(y => y.id === r.radarId)?.video?.stage === 'analisando');
  assert.equal(again.state().radar.filter(x => x.video).length, 1);
  assert.equal(h.manager.runs.length, runs, 'a análise que já estava na fila continua (nenhuma tarefa nova)');
  assert.equal(again.state().rounds.filter(x => x.kind === 'video').length, 1);
});

test('peça na lixeira: "Produzir esta versão" não recria, o cartão diz "Peça na lixeira"; mandar o link de novo pedindo o vídeo produz outra', async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'threads'], null, null);
  const url = 'https://www.tiktok.com/@alguem/video/7700000000000000002';
  const r = await h.content.handle({ type: 'content.video.add', reqId: 'v', ref: { url } }) as { radarId: string };
  await until(() => h.content.state().radar.find(y => y.id === r.radarId)?.video?.stage === 'bloqueada');
  const v = h.content.state().radar.find(y => y.id === r.radarId)!.video!;
  h.db.prepare('UPDATE content_radar SET data_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse((h.db.prepare('SELECT data_json FROM content_radar WHERE id=?').get(r.radarId) as { data_json: string }).data_json), video: { ...v, stage: 'proposta', synthesis: { messageId: 's', text: 'Recomendada: X', author: 'Claude', at: 1 } } }), r.radarId);
  await h.content.handle({ type: 'content.video.produce', reqId: 'p', id: r.radarId, slot: 'instagram-aurora' });
  const first = h.content.state().items[0];
  await h.content.handle({ type: 'content.items.trash', reqId: 't', ids: [first.id] });
  assert.equal(h.content.state().radar.find(y => y.id === r.radarId)!.video!.stage, 'lixeira');
  const runs = h.manager.runs.length;
  await assert.rejects(h.content.handle({ type: 'content.video.produce', reqId: 'p2', id: r.radarId, slot: 'instagram-aurora' }), /está na lixeira/);
  assert.equal(h.manager.runs.length, runs, 'nenhuma produção nova pelo cartão');
  assert.equal(h.content.state().items.filter(i => i.referenceIds.includes(r.radarId) && !i.deletedAt).length, 0);
  // Pedido explícito no campo (o mesmo link + "quero um vídeo...") vale: sai outra versão.
  await h.content.handle({ type: 'content.video.add', reqId: 'v3', ref: { url, instruction: 'quero um vídeo inspirado neste para a Aurora' } });
  const live = h.content.state().items.filter(i => i.referenceIds.includes(r.radarId) && !i.deletedAt);
  assert.equal(live.length, 1); assert.notEqual(live[0].id, first.id); assert.equal(live[0].status, 'em_producao');
  assert.notEqual(h.content.state().radar.find(y => y.id === r.radarId)!.video!.stage, 'lixeira');
});

test('três vídeos no mesmo pedido (base + áudio + estilo): cada um inspecionado, papéis no pedido do pesquisador e no briefing com o áudio extraído', { skip: HAS_FFMPEG ? false : 'ffmpeg não instalado' }, async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'threads'], null, null);
  const mp4 = fs.readFileSync(sampleVideo(h.dir)).toString('base64');
  const audioUrl = 'https://www.tiktok.com/@thinker/video/7695619685718461702';
  const styleUrl = 'https://www.tiktok.com/@pedroca/video/7699591974520704276';
  const r = await h.content.handle({ type: 'content.video.add', reqId: 'v', ref: {
    file: { name: 'pedra.mp4', mediaType: 'video/mp4', dataBase64: mp4 }, instruction: 'queria criar um video igual esse só que código [vídeo 2] pode ser esse audio [vídeo 3] esse estilo o video', slot: 'instagram-tuco',
    extras: [{ url: audioUrl, role: 'audio', note: 'pode ser esse audio' }, { url: styleUrl, role: 'estilo', note: 'esse estilo o video' }, { url: audioUrl, role: 'audio', note: 'repetido' }],
  } }) as { radarId: string; mode: string };
  assert.equal(r.mode, 'produzir');
  const ref = await until(() => { const x = h.content.state().radar.find(y => y.id === r.radarId); return x?.video?.stage === 'analisando' ? x : null; });
  const ex = ref.video!.extras!;
  assert.equal(ex.length, 2, 'link repetido não entra duas vezes');
  assert.deepEqual(ex.map(x => x.role), ['audio', 'estilo']);
  assert.ok(ex.every(x => x.error), 'sem yt-dlp, os links a mais ficam marcados como não abertos');
  const ask = h.manager.runs.at(-1)!;
  assert.match(ask.text, /Vídeo 2 \(áudio\): https:\/\/www\.tiktok\.com\/@thinker/); assert.match(ask.text, /Vídeo 3 \(estilo do vídeo\)/); assert.match(ask.text, /NÃO abriu/);
  // O Chefe anexa o vídeo do áudio (como se o download tivesse funcionado) e manda tentar de novo: só os que falharam são refeitos.
  fs.copyFileSync(sampleVideo(h.dir), path.join(ex[0].dir, 'original.mp4'));
  await h.content.handle({ type: 'content.video.retry', reqId: 'r', id: r.radarId });
  const ok = await until(() => { const x = h.content.state().radar.find(y => y.id === r.radarId); return x?.video?.extras?.[0]?.level === 'video_sem_audio' && x.video.stage === 'analisando' ? x : null; });
  const audio = ok.video!.extras![0];
  assert.equal(audio.error, null); assert.ok(audio.audioFile && fs.existsSync(audio.audioFile), 'áudio extraído para a mistura');
  assert.ok(audio.sheets.length > 0 && fs.existsSync(audio.evidence!));
  assert.ok(ok.video!.extras![1].error, 'o de estilo continua sem abrir');
  assert.equal(h.content.state().rounds.filter(x => x.kind === 'video').length, 1, 'a análise que já estava na fila continua');
  // Análise → produção direta (modo produzir), com o áudio extraído e os papéis no briefing.
  const round = h.content.state().rounds.find(x => x.kind === 'video')!;
  fs.writeFileSync(round.outputPath, JSON.stringify({ ideiaCentral: 'o código toca o som da pedra', recomendada: { resumo: 'Reel do Tuco: python roda e a frase aparece no tempo do áudio', esforco: 'medio' } }));
  h.manager.finish(round.taskId!);
  await h.content.sync();
  assert.ok(!h.meetings.calls.some(c => c.type === 'meeting.create'), 'nenhuma reunião no modo produzir');
  const item = h.content.state().items.find(i => i.referenceIds.includes(r.radarId))!;
  assert.match(item.brief, /audio-referencia\.json/); assert.ok(item.brief.includes(audio.audioFile!), 'o briefing cita o áudio extraído');
  assert.ok(item.sources.includes(audioUrl) && item.sources.includes(styleUrl));
});

test('modo análise: cada referência abre a própria reunião (contexto sem colidir) e, se a reunião não começar, o cartão diz o motivo', { skip: HAS_FFMPEG ? false : 'ffmpeg não instalado' }, async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'tiktok'], null, null);
  const mp4 = fs.readFileSync(sampleVideo(h.dir)).toString('base64');
  const analyse = async (name: string) => {
    const r = await h.content.handle({ type: 'content.video.add', reqId: name, ref: { file: { name, mediaType: 'video/mp4', dataBase64: mp4 }, slot: 'instagram-tuco', mode: 'analise' } }) as { radarId: string; mode: string };
    assert.equal(r.mode, 'analise');
    await until(() => h.content.state().radar.find(y => y.id === r.radarId)?.video?.stage === 'analisando');
    const round = h.content.state().rounds.filter(x => x.kind === 'video' && x.status === 'aguardando').at(-1)!;
    fs.writeFileSync(round.outputPath, JSON.stringify({ ideiaCentral: `ideia de ${name}`, recomendada: { resumo: `Reel a partir de ${name}` } }));
    h.manager.finish(round.taskId!);
    await h.content.sync();
    return h.content.state().radar.find(y => y.id === r.radarId)!;
  };
  const a = await analyse('um.mp4');
  const b = await analyse('dois.mp4');
  assert.equal(a.video!.stage, 'discussao', a.video!.error ?? '');
  assert.equal(b.video!.stage, 'discussao', `2ª referência também abre a reunião: ${b.video!.error ?? ''}`);
  const sets = h.meetings.calls.filter(c => c.type === 'meeting.context.set') as Extract<MeetingClientMessage, { type: 'meeting.context.set' }>[];
  assert.equal(sets.length, 2);
  assert.ok(sets[0].items.every(i => String(i.id).startsWith('m1:')) && sets[1].items.every(i => String(i.id).startsWith('m2:')), 'ids do contexto por reunião');
  assert.equal(h.content.state().items.length, 0, 'modo análise não produz sozinho');
  h.meetings.failCreate = 'banco ocupado';
  const c = await analyse('tres.mp4');
  assert.equal(c.video!.stage, 'proposta');
  assert.match(c.video!.error ?? '', /a reunião não começou \(banco ocupado\)/);
});

test('pedido rápido da tela Conteúdo: o texto do Chefe vira a peça e já entra na produção, no formato e na conta pedidos', async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'tiktok'], null, null);
  const pedido = 'quero um reel explicando o que é API com o garçom levando o pedido, uns 20 segundos';
  const r = await h.content.handle({ type: 'content.quick.create', reqId: 'q', text: pedido, slot: 'instagram-tuco', format: 'video' }) as { itemId: string };
  const item = h.content.state().items.find(i => i.id === r.itemId)!;
  assert.equal(item.status, 'em_producao'); assert.equal(item.format, 'Reel'); assert.equal(item.slot, 'instagram-tuco');
  assert.ok(item.brief.includes(pedido), 'o briefing leva o texto exato do Chefe');
  assert.match(item.title, /^Reel explicando o que é API/);
  const run = h.manager.runs.at(-1)!;
  assert.match(run.text, /video\.json/); assert.match(run.text, /não entregue só roteiro/);
  const tt = await h.content.handle({ type: 'content.quick.create', reqId: 'q2', text: 'carrossel com 5 atalhos do VS Code', slot: 'tiktok', format: 'carrossel' }) as { itemId: string };
  assert.equal(h.content.state().items.find(i => i.id === tt.itemId)!.format, 'carrossel de fotos (TikTok)');
  await assert.rejects(h.content.handle({ type: 'content.quick.create', reqId: 'q3', text: 'um post', slot: 'threads', format: 'texto' }), /pausad/i);
  await assert.rejects(h.content.handle({ type: 'content.quick.create', reqId: 'q4', text: ' ', slot: 'tiktok', format: 'video' }), /Escreva o que você quer postar/);
  assert.equal(h.content.state().items.length, 2, 'pedido recusado não deixa peça');
});

test('pedido rápido no Threads da Aurora (06/11): formato texto, post pronto com até 500 caracteres; vídeo no Threads é recusado', async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'threads'], null, null);
  await assert.rejects(h.content.handle({ type: 'content.quick.create', reqId: 'q1', text: 'um vídeo no threads', slot: 'threads', format: 'video' }), /post de texto/);
  await assert.rejects(h.content.handle({ type: 'content.quick.create', reqId: 'q2', text: 'um texto no instagram', slot: 'instagram-aurora', format: 'texto' }), /vídeo ou carrossel/);
  const r = await h.content.handle({ type: 'content.quick.create', reqId: 'q3', text: 'post no threads: proposta em PDF ou o site já funcionando?', slot: 'threads', format: 'texto' }) as { itemId: string };
  const item = h.content.state().items.find(i => i.id === r.itemId)!;
  assert.equal(item.format, 'post Threads'); assert.equal(item.slot, 'threads'); assert.equal(item.status, 'em_producao');
  assert.match(item.reviewCriteria, /500 caracteres/);
  const run = h.manager.runs.at(-1)!;
  assert.match(run.text, /entrega\.json/); assert.match(run.text, /500 caracteres/);
  assert.equal(h.content.state().items.length, 1, 'pedidos recusados não deixam peça');
});

test('referência parada em "analisando" com a análise pronta (defeito de 05/11): a HQ retoma sozinha e produz, sem refazer a análise', { skip: HAS_FFMPEG ? false : 'ffmpeg não instalado' }, async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'tiktok'], null, null);
  const mp4 = fs.readFileSync(sampleVideo(h.dir)).toString('base64');
  const r = await h.content.handle({ type: 'content.video.add', reqId: 'v', ref: { file: { name: 'pedra.mp4', mediaType: 'video/mp4', dataBase64: mp4 }, instruction: 'queria criar um video igual esse só que código', slot: 'instagram-tuco' } }) as { radarId: string };
  await until(() => h.content.state().radar.find(y => y.id === r.radarId)?.video?.stage === 'analisando');
  const runs = h.manager.runs.length;
  // Estado do banco real de 05/11: rodada concluída, análise gravada, sem reunião e sem peça.
  const round = h.content.state().rounds.find(x => x.kind === 'video')!;
  h.db.prepare("UPDATE content_rounds SET status='concluida' WHERE id=?").run(round.id);
  const row = h.db.prepare('SELECT data_json FROM content_radar WHERE id=?').get(r.radarId) as { data_json: string };
  const d = JSON.parse(row.data_json); d.video.analysis = { file: round.outputPath, md: null, central: 'o código faz o barulho', recommended: 'Reel: python roda e a frase aparece no tempo do áudio', at: Date.now() };
  h.db.prepare('UPDATE content_radar SET data_json=? WHERE id=?').run(JSON.stringify(d), r.radarId);
  const again = h.mk();
  await again.sync();
  const ref = again.state().radar.find(y => y.id === r.radarId)!;
  assert.equal(ref.video!.itemIds.length, 1, ref.video!.error ?? 'peça criada');
  const item = again.state().items.find(i => i.id === ref.video!.itemIds[0])!;
  assert.equal(item.status, 'em_producao'); assert.match(item.brief, /python roda/);
  assert.equal(h.manager.runs.length, runs + 1, 'só a produção entrou na fila (a análise não foi refeita)');
  await again.sync();
  assert.equal(again.state().items.length, 1, 'passar de novo não duplica');
});

test('áudio "provisório" que é o áudio pedido pelo Chefe, com video-com-audio.mp4 pronto, não deixa a peça parcial; pedido de dia passado sai da Mesa', async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'tiktok'], null, null);
  await h.content.handle({ type: 'content.item.create', reqId: 'c', item: { title: 'Pedra', slot: 'instagram-tuco', format: 'Reel' } });
  const it = h.content.state().items[0];
  const dir = path.join(h.dir, 'peca-pedra'); fs.mkdirSync(dir, { recursive: true });
  for (const f of ['video.mp4', 'video-com-audio.mp4', 'capa.png']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(path.join(dir, 'audio-referencia.json'), JSON.stringify({ arquivo: 'audio.m4a', entraEm: 2.4, inicio: 0, fim: 16.6 }));
  fs.writeFileSync(path.join(dir, 'video-conferencia.json'), JSON.stringify({ ok: true, cover: path.join(dir, 'capa.png'), plan: { audio: { provisorio: true, observacao: 'o som é o do vídeo 2' } } }));
  fs.writeFileSync(path.join(dir, 'entrega.json'), JSON.stringify({ files: ['video.mp4', 'capa.png'], text: 'legenda' }));
  h.db.prepare("UPDATE content_items SET status='parcial', folder=? WHERE id=?").run(dir, it.id);
  const r = await h.content.handle({ type: 'content.items.verify', reqId: 'v', ids: [it.id], apply: true }) as { rows: { to: string; missing: string[]; have: string[] }[] };
  assert.equal(r.rows[0].to, 'revisar', `falta: ${r.rows[0].missing.join('; ')}`);
  assert.ok(r.rows[0].have.some(x => /video-com-audio/.test(x)));
  // Sem o video-com-audio.mp4, o áudio provisório continua sendo pendência.
  fs.rmSync(path.join(dir, 'video-com-audio.mp4'));
  const r2 = await h.content.handle({ type: 'content.items.verify', reqId: 'v2', ids: [it.id], apply: false }) as { rows: { to: string; missing: string[] }[] };
  assert.ok(r2.rows[0].missing.some(m => /áudio final/.test(m)));
  // Pedido de um dia que já passou é arquivado na passada seguinte (as peças ficam como estão).
  const old = await h.content.handle({ type: 'content.request.create', reqId: 'r', date: '2020-01-01', slots: ['instagram-tuco'], autoProduce: false }) as { requestId: string };
  await h.content.sync();
  assert.equal(h.content.state().requests.find(x => x.id === old.requestId)?.status, 'arquivado');
  assert.equal(h.content.state().items.length, 1, 'nenhuma peça foi mexida');
});

test('equipes por perfil (06/11): o pedido vai para a equipe da conta; Reel para a edição de vídeo, carrossel e texto para a criação', async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'threads'], null, null);
  const byName = (n: string) => h.store.listEmployees().find(e => e.name === n)!.id;
  const ask = async (slot: string, format: string, text: string) => {
    const r = await h.content.handle({ type: 'content.quick.create', reqId: text, text, slot: slot as never, format: format as never }) as { itemId: string };
    const it = h.content.state().items.find(i => i.id === r.itemId)!;
    return { owner: it.ownerId, ran: (h.manager.runs.at(-1) as { employeeId?: string }).employeeId };
  };
  assert.deepEqual(await ask('instagram-tuco', 'video', 'reel do garçom e a API'), { owner: byName('Teo'), ran: byName('Teo') });
  assert.deepEqual(await ask('instagram-tuco', 'carrossel', 'carrossel de atalhos do VS Code'), { owner: byName('Nina'), ran: byName('Nina') });
  assert.deepEqual(await ask('instagram-aurora', 'video', 'reel do site que vira cliente'), { owner: byName('Clara'), ran: byName('Clara') });
  assert.deepEqual(await ask('threads', 'texto', 'post sobre proposta em PDF'), { owner: byName('Bia'), ran: byName('Bia') });
  // Peça antiga do Tuco com a Bia (de antes das equipes): pedir de novo leva para a equipe Tuco.
  const old = h.content.state().items.find(i => i.slot === 'instagram-tuco' && i.format === 'carrossel')!;
  h.store.updateTask(old.taskId!, { status: 'done' });
  (h.content as unknown as { cdb: { updateItem(id: string, p: Record<string, unknown>): void } }).cdb.updateItem(old.id, { status: 'revisar', ownerId: byName('Bia') });
  await h.content.handle({ type: 'content.item.produce', reqId: 'again', id: old.id });
  assert.equal(h.content.state().items.find(i => i.id === old.id)!.ownerId, byName('Nina'));
});
