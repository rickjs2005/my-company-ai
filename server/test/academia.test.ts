// Diretor de Vídeo e Academia de Vídeo (07/11/2026): "Equipe, estudem esse vídeo" → a HQ inspeciona (Watch quando instalada)
// → o Diretor estuda (skill video-analyze, quadros anexados) → técnicas na biblioteca (observado × inferido), índice e fichas
// na pasta → aula (reunião com quem tem exercício) → exercícios como tarefas reais → render do exercício de edição → correção
// → estudo concluído. Também: falhas (análise, exercício), "Pedir de novo", retomada depois de reiniciar, link bloqueado com
// o pedido do arquivo, e o aprendizado voltando no pedido de vídeo seguinte. Funcionários e reunião simulados; FFmpeg real.
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
import { ContentService, STUDY_INTENT } from '../src/content/service.js';
import { RoutineService } from '../src/routines.js';
import type { VideoTools } from '../src/content/videoref.js';
import type { VideoRenderer } from '../src/content/video.js';
import { mergeTechnique, parseCorrection, parseExerciseResult, parseStudy, writeAcademyIndex, writeTechniqueCard } from '../src/content/academy.js';
import { findWatch, parseWatchReport } from '../src/content/watchskill.js';
import { tempDir } from './tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(here, '..', '..', 'content-kit');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

class FakeManager extends EventEmitter {
  runs: TaskRunInput[] = [];
  failSkill: string | null = null;
  constructor(public store: Store) { super(); }
  cancelQueued() { /* sem fila */ }
  setTaskLimit() { /* sem teto */ }
  updateEmployee(id: string, patch: Partial<Employee>) { return this.store.updateEmployee(id, patch); }
  createEmployee(input: { roomId: string; name?: string; role?: string; instructions?: string; permissionMode?: Employee['permissionMode']; provider?: Employee['provider']; skills?: string[]; template?: string | null; profileId?: string | null; access?: Employee['access'] }): Employee {
    const n = this.store.listEmployeesByRoom(input.roomId).length;
    return this.store.createEmployee({ name: input.name!, role: input.role ?? '', roomId: input.roomId, appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: n, instructions: input.instructions, permissionMode: input.permissionMode, provider: input.provider, skills: input.skills, template: input.template, profileId: input.profileId ?? null, access: input.access });
  }
  async runTask(input: TaskRunInput): Promise<TaskRunResult> {
    if (this.failSkill && input.skill === this.failSkill) throw new Error(`A skill "${input.skill}" não foi encontrada nesta máquina.`);
    const dup = this.store.findTaskByClientId(input.clientId);
    if (dup) return { taskId: dup.id, sessionId: dup.sessionId, employeeId: input.employeeId, projectId: input.projectId, status: dup.status, queuePosition: null, queueReason: null, newSession: false, applied: { model: null, effort: null, permissionMode: 'default', source: 'teste' }, notes: [], duplicate: true };
    const e = this.store.getEmployee(input.employeeId)!;
    const s = this.store.listSessionsByEmployee(e.id)[0] ?? this.store.createSession({ roomId: e.roomId, projectId: input.projectId, employeeId: e.id, name: e.name, permissionMode: 'acceptEdits', workerName: e.name, appearance: e.appearance, deskIndex: e.deskIndex });
    const t = this.store.createTask({ clientId: input.clientId, sessionId: s.id, projectId: input.projectId, roomId: e.roomId, prompt: input.text, attachments: [], mode: 'send', employeeId: e.id, destinationId: input.destinationId ?? null });
    this.runs.push(input);
    return { taskId: t.id, sessionId: s.id, employeeId: e.id, projectId: input.projectId, status: 'queued', queuePosition: 1, queueReason: null, newSession: false, applied: { model: null, effort: null, permissionMode: 'acceptEdits', source: 'teste' }, notes: [], duplicate: false };
  }
  finish(taskId: string, status: Task['status'] = 'done') { this.store.updateTask(taskId, { status, finishedAt: Date.now(), ...(status === 'error' ? { errors: ['limite de uso'] } : {}) }); this.emit('task_finished', taskId); }
}

class FakeMeetings {
  calls: MeetingClientMessage[] = [];
  msgs: MeetingMessage[] = [];
  n = 0;
  async handle(msg: MeetingClientMessage): Promise<unknown> {
    this.calls.push(msg);
    if (msg.type === 'meeting.create') { this.n++; return { meeting: { id: `m${this.n}`, participants: msg.participants.map((p, i) => ({ id: `p${i}`, provider: p.provider, employeeId: p.employeeId ?? null })) } }; }
    return {};
  }
  messages(id: string) { return this.msgs.filter(m => m.meetingId === id); }
  synthesis(meetingId: string, text: string) { this.msgs.push({ id: `syn-${meetingId}`, meetingId, turnId: 't9', participantId: 'px', authorName: 'Claude', provider: 'claude', kind: 'speech', text, round: 1, phase: 'synthesis', targets: [], config: null, contextVersion: 1, partial: false, ts: Date.now() } as unknown as MeetingMessage); }
}

/** Renderizador simulado com FFmpeg real: MP4 de 2 s, capa e um quadro (o exercício de edição precisa de vídeo de verdade). */
const fakeRenderer: VideoRenderer = {
  ffprobe: 'ffprobe', ffmpeg: 'ffmpeg',
  async render({ out, cover, framesDir }) {
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.mkdirSync(framesDir, { recursive: true });
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', out, '-frames:v', '1', cover]);
    fs.copyFileSync(cover, path.join(framesDir, 'cena-1.png'));
    return { ok: fs.existsSync(out), error: null, ms: 50 };
  },
};

function setup() {
  const dir = tempDir('hq-academia-');
  const db = openDb(path.join(dir, 'hq.sqlite'), { backupsDir: path.join(dir, 'backups') });
  const store = new Store(db); store.seedDefaultRooms();
  const log = { info: () => {}, warn: () => {} };
  const ok = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
  const social = new SocialService({ db, vault: new MemoryVault(), port: 4799, broadcast: () => {}, log, profileIds: () => store.listRooms().flatMap(r => r.profiles.map(p => p.id)), fetch: ok });
  const manager = new FakeManager(store);
  const routines = new RoutineService({ store, manager: manager as never, broadcast: () => {}, log });
  const meetings = new FakeMeetings();
  const tools: VideoTools = { ytdlp: null, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', whisper: null, font: ['C:\\Windows\\Fonts\\arial.ttf'].find(f => fs.existsSync(f)) ?? null, page: null };
  const mk = () => new ContentService({
    db, store, manager, social, broadcast: (_m: ServerMessage) => {}, log, kitDir: KIT, defaultFolder: path.join(dir, 'hq-conteudos'), origins: [], siteDir: null, mirrors: [], trusted: () => true,
    routines: { handle: m => routines.handle(m), update: (id, patch) => routines.handle({ type: 'routine.update', reqId: 't', id, patch }) }, fetch: ok, videoTools: tools, meetings, video: fakeRenderer,
  });
  return { dir, db, store, manager, meetings, mk, content: mk() };
}

async function until<T>(fn: () => T | null | undefined | false, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando a condição'); await new Promise(r => setTimeout(r, 100)); }
}

function sampleVideo(dir: string): string {
  const f = path.join(dir, 'ref.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=3', '-f', 'lavfi', '-i', 'color=c=blue:size=360x640:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  return f;
}

const STUDY = {
  ideiaCentral: 'o texto entra no impacto do corte e o ritmo acompanha a batida',
  resumoLicao: 'Texto que salta no corte, com 3 a 5 quadros de antecipação, dá energia sem poluir.',
  tecnicas: [
    { slug: 'texto-que-salta', nome: 'Texto que salta no corte', categoria: 'animacao', evidencia: 'observado', onde: '00:03', comoSabemos: 'quadro w02 e o corte medido em 00:03.0', oQueE: 'o título cresce e volta no corte', comoFazer: [{ ferramenta: 'remotion', passos: 'spring() damping 12, escala 0,6→1,1→1 em 8 quadros' }], armadilhas: ['cortar o texto na margem'] },
    { slug: 'flash-branco', nome: 'Flash branco na troca', categoria: 'transicao', onde: '00:03', oQueE: 'um quadro branco entre os planos' },
  ],
  exercicios: [
    { titulo: 'Abertura com texto que salta', papel: 'video', equipe: 'tuco-dev', tecnicas: ['texto-que-salta'], instrucoes: 'Reel de 8 s sobre API com o título saltando no corte', entrega: 'video.json' },
    { titulo: 'Storyboard com flash', papel: 'criador', equipe: 'aurora', tecnicas: ['flash-branco'], instrucoes: 'storyboard de um bastidor da Aurora', entrega: 'roteiro.md e storyboard.md' },
    { titulo: 'Checklist do texto que salta', papel: 'revisor', equipe: null, tecnicas: ['texto-que-salta'], instrucoes: 'checklist para revisar', entrega: 'checklist.md' },
  ],
};

test('estudo.json: técnica sem evidência vira inferência; slug, categoria e exercícios conferidos; resultado e correção', () => {
  const r = parseStudy(STUDY as unknown as Record<string, unknown>);
  assert.ok(r.ok);
  assert.deepEqual(r.value.techniques.map(t => [t.slug, t.category, t.evidence]), [['texto-que-salta', 'animacao', 'observado'], ['flash-branco', 'transicao', 'inferido']]);
  assert.ok(r.value.warnings.some(w => /Flash branco.*inferência/.test(w)));
  assert.deepEqual(r.value.exercises.map(e => [e.role, e.profileId, e.techniques]), [['video', 'tuco-dev', ['texto-que-salta']], ['criador', 'aurora', ['flash-branco']], ['revisor', null, ['texto-que-salta']]]);
  assert.equal(parseStudy({ tecnicas: [] }).ok, false);
  assert.match((parseStudy({ resumoLicao: 'x', tecnicas: [{ nome: 'a' }] }) as { error: string }).error, /exercícios/);
  const dir = tempDir('hq-acad-res-'); fs.writeFileSync(path.join(dir, 'video.json'), '{}');
  const res = parseExerciseResult({ resumo: 'fiz', arquivos: ['video.json', 'nao-existe.md', 'C:\\Windows\\win.ini'] }, dir, dir);
  assert.ok(res.ok); assert.deepEqual(res.value.files, [path.join(dir, 'video.json')]); assert.deepEqual(res.value.missing, ['nao-existe.md', 'C:\\Windows\\win.ini'], 'fora da pasta de conteúdo não conta');
  assert.equal(parseExerciseResult({}, dir, dir).ok, false);
  const c = parseCorrection({ exercicios: [{ id: 'e1', veredito: 'ok', comentario: 'boa' }, { id: 'e2', comentario: 'falta o flash' }], tecnicas: [{ slug: 'Flash Branco', armadilhas: ['flash longo demais'] }] });
  assert.ok(c.ok); assert.deepEqual(c.value.exercises.map(e => e.verdict), ['ok', 'ajustar']); assert.equal(c.value.techniques[0].slug, 'flash-branco');
});

test('biblioteca: a mesma técnica em outro estudo soma a fonte; ficha e índice escritos na pasta', () => {
  const p = parseStudy(STUDY as unknown as Record<string, unknown>); assert.ok(p.ok);
  const a = mergeTechnique(null, p.value.techniques[0], { studyId: 's1', title: 'Estudo 1' });
  const t1 = { ...a, id: 'x', createdAt: 1, updatedAt: 1 };
  const b = mergeTechnique(t1, { ...p.value.techniques[0], evidence: 'inferido', pitfalls: ['texto pequeno'] }, { studyId: 's2', title: 'Estudo 2' });
  assert.equal(b.sources.length, 2); assert.deepEqual(b.pitfalls, ['cortar o texto na margem', 'texto pequeno']);
  const root = tempDir('hq-acad-idx-');
  const card = writeTechniqueCard(root, { ...b, id: 'x', createdAt: 1, updatedAt: 2 }, []);
  const md = fs.readFileSync(card, 'utf8');
  assert.match(md, /OBSERVADO em "Estudo 1"/); assert.match(md, /INFERIDO \(hipótese, não verificado\) em "Estudo 2"/); assert.match(md, /\*\*Remotion:\*\* spring\(\)/); assert.match(md, /Erros a evitar/);
  const idx = fs.readFileSync(writeAcademyIndex(root, [{ ...b, id: 'x', createdAt: 1, updatedAt: 2 }], [], Date.now()), 'utf8');
  assert.match(idx, /`texto-que-salta` · Texto que salta no corte \(Animação, observado\)/);
});

test('Watch: lê o relatório (quadros com o tempo, transcrição, vídeo local) e acha o plugin instalado', () => {
  const md = ['# watch: video report', '', '- **Local media:** `C:\\x\\download\\video.mp4`', '- **Transcript:** 6 segments (via captions (en, manual, unknown))', '', '## Frames', '',
    '- `C:\\x\\frames\\frame_0001.jpg` (t=00:00, reason=uniform)', '- `C:\\x\\frames\\frame_0002.jpg` (t=01:02:03, reason=scene)'].join('\n');
  const r = parseWatchReport(md);
  assert.deepEqual(r.frames, [{ file: 'C:\\x\\frames\\frame_0001.jpg', t: '00:00' }, { file: 'C:\\x\\frames\\frame_0002.jpg', t: '01:02:03' }]);
  assert.match(r.transcript!, /captions/); assert.equal(r.localMedia, 'C:\\x\\download\\video.mp4');
  const home = tempDir('hq-watch-home-');
  assert.equal(findWatch(home, () => 'C:\\Python\\python.exe'), null, 'sem plugin');
  const inst = path.join(home, 'plugins', 'cache', 'claude-video', 'watch', '0.3.2'); fs.mkdirSync(path.join(inst, 'skills', 'watch', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'skills', 'watch', 'scripts', 'watch.py'), '');
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'watch@claude-video': [{ installPath: inst, version: '0.3.2' }] } }));
  assert.deepEqual(findWatch(home, () => 'C:\\Python\\python.exe'), { python: 'C:\\Python\\python.exe', script: path.join(inst, 'skills', 'watch', 'scripts', 'watch.py'), version: '0.3.2' });
  assert.equal(findWatch(home, () => 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'), null, 'o atalho da Microsoft Store não é Python de verdade');
});

test('recado do Chefe: "estudem", "aprendam" e "aprende fazer um edit" viram estudo; "quero um vídeo" não', () => {
  for (const t of ['Equipe, estudem esse vídeo. Quero que aprendam a fazer animações desse nível.', 'depois de instala aprende fazer um edit', 'aprendam essa técnica']) assert.ok(STUDY_INTENT.test(t), t);
  for (const t of ['quero um vídeo inspirado neste para o Tuco Dev', 'olha esse', 'estudante de programação']) assert.ok(!STUDY_INTENT.test(t), t);
});

test('fluxo completo: compartilhar → Diretor estuda (video-analyze, quadros anexados) → aula → exercícios → render → correção → Academia; o aprendizado volta no próximo vídeo', { skip: HAS_FFMPEG ? false : 'ffmpeg não instalado' }, async () => {
  const h = setup();
  await h.content.setup();
  await h.content.saveFocus(['instagram-tuco', 'instagram-aurora', 'threads'], null, null);
  const director = h.store.listEmployees().find(e => e.template === 'conteudo-diretor-video')!;
  assert.ok(director, 'Diretor contratado ao preparar a sala');
  const mp4 = fs.readFileSync(sampleVideo(h.dir)).toString('base64');
  const r = await h.content.handle({ type: 'content.video.add', reqId: 'v', ref: { file: { name: 'edit-viral.mov', mediaType: 'video/quicktime', dataBase64: mp4 }, instruction: 'Equipe, estudem esse vídeo. Quero que aprendam a fazer animações desse nível.' } }) as { radarId: string; mode: string };
  assert.equal(r.mode, 'estudo');
  let st = h.content.state().academy!.studies[0];
  assert.equal(st.radarId, r.radarId); assert.equal(st.status, 'analisando');
  assert.match(st.folder.split(path.sep).join('/'), /\/academia\/estudos\/\d{4}-\d{2}-\d{2}-\d{4}-edit-viral$/);
  // A HQ inspeciona e o Diretor recebe o estudo com a skill do Video Analyzer e os quadros anexados.
  await until(() => h.content.state().radar.find(x => x.id === r.radarId)?.video?.stage === 'analisando' && h.manager.runs.length > 0);
  const ask = h.manager.runs.at(-1)!;
  assert.equal(ask.employeeId, director.id); assert.equal(ask.skill, 'video-analyze'); assert.equal(ask.maxAttachments, ask.attachments!.length, 'todas as imagens anexadas chegam ao Diretor');
  assert.ok((ask.attachments ?? []).some(a => /^folha-\d+\.png$/.test(a.name)));
  assert.match(ask.text, /Estudo de vídeo para a Academia/); assert.match(ask.text, /OBSERVADO/); assert.match(ask.text, /NÃO rode scripts/); assert.match(ask.text, /Teo/);
  const round = h.content.state().rounds.find(x => x.kind === 'estudo')!;
  assert.equal(path.dirname(round.outputPath), st.folder);
  fs.writeFileSync(round.outputPath, JSON.stringify(STUDY));
  fs.writeFileSync(path.join(st.folder, 'licao.md'), '# Lição'); fs.writeFileSync(path.join(st.folder, 'analise.md'), '# Análise');
  h.manager.finish(round.taskId!);
  await h.content.sync();
  st = h.content.state().academy!.studies[0];
  assert.equal(st.status, 'aula', st.error ?? '');
  assert.deepEqual(st.exercises.map(e => [e.employeeName, e.status]), [['Teo', 'pendente'], ['Bia', 'pendente'], ['Otto', 'pendente']]);
  assert.equal(h.content.state().academy!.techniques.length, 2);
  const folder = path.dirname(path.dirname(path.dirname(st.folder)));
  assert.match(fs.readFileSync(path.join(folder, 'academia', 'INDICE.md'), 'utf8'), /texto-que-salta/);
  assert.ok(fs.existsSync(path.join(folder, 'academia', 'tecnicas', 'flash-branco.md')));
  // Aula: reunião com o Diretor, quem tem exercício e o gerente; a lição vai no contexto.
  const create = h.meetings.calls.find(c => c.type === 'meeting.create') as Extract<MeetingClientMessage, { type: 'meeting.create' }>;
  assert.deepEqual(create.participants.map(p => p.employeeId ? h.store.getEmployee(p.employeeId)!.name : p.provider), ['Vítor', 'Teo', 'Bia', 'Otto', 'claude']);
  assert.ok(h.meetings.calls.some(c => c.type === 'meeting.context.set' && c.items.some(i => i.path?.endsWith('licao.md'))));
  assert.equal(h.content.state().radar.find(x => x.id === r.radarId)!.video!.stage, 'aula');
  // Reinício no meio da aula: a outra instância lê a síntese e distribui os exercícios (sem duplicar).
  h.manager.removeAllListeners('task_finished'); // a instância antiga "desligou"
  const again = h.mk();
  h.meetings.synthesis(st.meetingId!, 'Técnicas: texto que salta. Dúvidas respondidas.');
  await again.sync();
  st = again.state().academy!.studies[0];
  assert.equal(st.status, 'exercicios');
  assert.ok(st.lessonSynthesis && fs.existsSync(st.lessonSynthesis));
  assert.deepEqual(st.exercises.map(e => e.status), ['em_producao', 'em_producao', 'em_producao']);
  const exRuns = h.manager.runs.slice(-3);
  assert.deepEqual(exRuns.map(x => h.store.getEmployee(x.employeeId)!.name), ['Teo', 'Bia', 'Otto']);
  assert.match(exRuns[0].text, /video\.json/); assert.match(exRuns[0].text, /tecnicas[\\/]texto-que-salta\.md/); assert.equal(exRuns[0].skill, 'milweb-video-studio');
  await again.sync();
  assert.equal(h.manager.runs.length, 4, 'a passada seguinte não manda os exercícios de novo');
  // Teo entrega o video.json (a HQ renderiza); Bia entrega; Otto falha (limite de uso).
  const [teo, bia, otto] = st.exercises;
  fs.writeFileSync(path.join(teo.dir, 'video.json'), JSON.stringify({ composicao: 'CenasReel', marca: 'tuco-dev', titulo: 'API', cenas: [1, 2, 3].map(i => ({ id: `c${i}`, tipo: 'titulo', duracao: 2.5, mostra: 'título', acao: 'salta no corte', informacao: 'API', transicao: 'flash' })), audio: { trilha: 'gerada' } }));
  fs.writeFileSync(path.join(teo.dir, 'resultado.json'), JSON.stringify({ resumo: 'apliquei o salto no corte', arquivos: ['video.json'], aprendi: 'a antecipação', duvidas: null }));
  fs.writeFileSync(path.join(bia.dir, 'storyboard.md'), '# SB');
  fs.writeFileSync(path.join(bia.dir, 'resultado.json'), JSON.stringify({ resumo: 'storyboard com flash', arquivos: ['storyboard.md'] }));
  h.manager.finish(teo.taskId!); h.manager.finish(bia.taskId!); h.manager.finish(otto.taskId!, 'error');
  await again.sync();
  st = await until(() => { const s = again.state().academy!.studies[0]; return s.exercises.every(e => e.status !== 'em_producao') ? s : null; });
  const teoDone = st.exercises[0];
  assert.equal(teoDone.status, 'concluido'); assert.match(teoDone.result!.render!, /^ok: 1080×1920/);
  assert.ok(teoDone.result!.files.some(f => f.endsWith('exercicio.mp4')));
  assert.equal(st.exercises[2].status, 'falhou'); assert.match(st.exercises[2].error!, /terminou como error/);
  // Todos terminaram (um falhou): a correção do Diretor começa, com a capa do vídeo anexada.
  st = await until(() => { const s = again.state().academy!.studies[0]; return s.status === 'correcao' ? s : null; });
  const corr = h.manager.runs.at(-1)!;
  assert.equal(corr.employeeId, director.id); assert.match(corr.text, /Corrigir os exercícios/); assert.ok((corr.attachments ?? []).some(a => a.name === 'e1-capa.png'));
  // "Pedir de novo" o exercício que falhou: volta para o Otto; a correção é refeita depois.
  await again.handle({ type: 'content.academy.retry', reqId: 'r', studyId: st.id, exerciseId: 'e3' });
  st = again.state().academy!.studies[0];
  assert.equal(st.exercises[2].status, 'em_producao'); assert.equal(st.status, 'exercicios');
  fs.writeFileSync(path.join(st.exercises[2].dir, 'checklist.md'), '- [ ] escala');
  fs.writeFileSync(path.join(st.exercises[2].dir, 'resultado.json'), JSON.stringify({ resumo: 'checklist', arquivos: ['checklist.md'] }));
  h.manager.finish(st.exercises[2].taskId!);
  // A correção antiga (ainda na fila) é a mesma saída: a passada não abre outra enquanto ela estiver aberta.
  const corrRound = again.state().rounds.find(x => x.kind === 'correcao')!;
  await again.sync();
  fs.writeFileSync(corrRound.outputPath, JSON.stringify({ resumo: 'bom começo', exercicios: [{ id: 'e1', veredito: 'ok', comentario: 'salto no tempo certo' }, { id: 'e2', veredito: 'ajustar', comentario: 'o flash precisa de 1 quadro só' }, { id: 'e3', veredito: 'ok', comentario: 'checklist útil' }], tecnicas: [{ slug: 'flash-branco', armadilhas: ['flash de mais de 2 quadros cansa'] }] }));
  fs.writeFileSync(path.join(st.folder, 'correcao.md'), '# Correção');
  h.manager.finish(corrRound.taskId!);
  await again.sync();
  st = again.state().academy!.studies[0];
  assert.equal(st.status, 'concluido', st.error ?? '');
  assert.deepEqual(st.exercises.map(e => e.feedback?.verdict), ['ok', 'ajustar', 'ok']);
  assert.ok(st.feedback?.endsWith('correcao.md'));
  const ref = again.state().radar.find(x => x.id === r.radarId)!;
  assert.equal(ref.video!.stage, 'concluida');
  assert.ok(ref.video!.events!.length >= 8, 'histórico com cada passo');
  assert.ok(ref.video!.events!.some(e => /corrigiu: 2 aprovado/.test(e.text)));
  const flash = again.state().academy!.techniques.find(t => t.slug === 'flash-branco')!;
  assert.deepEqual(flash.pitfalls, ['flash de mais de 2 quadros cansa']);
  assert.equal(flash.examples[0].verdict, 'ajustar');
  assert.match(fs.readFileSync(path.join(folder, 'academia', 'tecnicas', 'texto-que-salta.md'), 'utf8'), /Teo: aprovado pelo Diretor/);
  assert.equal(again.state().items.length, 0, 'estudo não vira peça');
  // Próximo vídeo: o pedido de produção de um Reel manda ler a Academia.
  await again.handle({ type: 'content.quick.create', reqId: 'q', text: 'Reel do Tuco explicando cache', slot: 'instagram-tuco', format: 'video' });
  assert.match(h.manager.runs.at(-1)!.text, /academia\/INDICE\.md/);
});

test('falhas: link que pede login bloqueia e pede o arquivo; análise que falha deixa o cartão bloqueado com "Tentar de novo"; sem a skill video-analyze o Diretor segue', { skip: HAS_FFMPEG ? false : 'ffmpeg não instalado' }, async () => {
  const h = setup();
  await h.content.setup();
  // Sem yt-dlp a HQ não abre o post: estudo bloqueado com o motivo e a ação de anexar.
  const r = await h.content.handle({ type: 'content.video.add', reqId: 'v', ref: { url: 'https://www.instagram.com/reel/ABC123/', instruction: 'aprendam essa técnica' } }) as { radarId: string; mode: string };
  assert.equal(r.mode, 'estudo');
  const b = await until(() => { const x = h.content.state().radar.find(y => y.id === r.radarId); return x?.video?.stage === 'bloqueada' ? x : null; });
  assert.ok(b.video!.inspection!.blocked!.actions.includes('anexar'));
  assert.equal(h.content.state().academy!.studies[0].status, 'bloqueado');
  assert.ok(b.video!.events!.some(e => /Anexe o arquivo/.test(e.text)));
  assert.equal(h.manager.runs.length, 0);
  // O Chefe anexa o arquivo: segue para o Diretor. Sem a skill video-analyze na máquina, a tarefa sai com a de vídeo.
  h.manager.failSkill = 'video-analyze';
  const mp4 = fs.readFileSync(sampleVideo(h.dir)).toString('base64');
  await h.content.handle({ type: 'content.video.retry', reqId: 'r', id: r.radarId, file: { name: 'reel.mp4', mediaType: 'video/mp4', dataBase64: mp4 } });
  await until(() => h.manager.runs.length > 0);
  assert.equal(h.manager.runs[0].skill, 'milweb-video-studio');
  assert.equal(h.content.state().academy!.studies[0].status, 'analisando');
  // A tarefa do Diretor cai: cartão bloqueado com o motivo (antes ficava "Em análise" para sempre).
  const round = h.content.state().rounds.find(x => x.kind === 'estudo')!;
  h.manager.finish(round.taskId!, 'error');
  await h.content.sync();
  const after = h.content.state().radar.find(y => y.id === r.radarId)!;
  assert.equal(after.video!.stage, 'bloqueada'); assert.match(after.video!.error!, /a análise falhou/);
  assert.equal(h.content.state().academy!.studies[0].status, 'bloqueado');
  // Análise comum (não estudo) também: JSON sem conteúdo bloqueia com o motivo.
  const v2 = await h.content.handle({ type: 'content.video.add', reqId: 'v2', ref: { file: { name: 'outro.mp4', mediaType: 'video/mp4', dataBase64: mp4 } } }) as { radarId: string; mode: string };
  assert.equal(v2.mode, 'analise');
  await until(() => h.content.state().rounds.some(x => x.kind === 'video' && x.taskId));
  const vr = h.content.state().rounds.find(x => x.kind === 'video')!;
  assert.equal(h.store.getTask(vr.taskId!)!.employeeId, h.store.listEmployees().find(e => e.template === 'conteudo-diretor-video')!.id, 'a análise vai para o Diretor');
  fs.writeFileSync(vr.outputPath, '{}');
  h.manager.finish(vr.taskId!);
  await h.content.sync();
  assert.equal(h.content.state().radar.find(y => y.id === v2.radarId)!.video!.stage, 'bloqueada');
});

test('Diretor contratado uma vez numa sala já pronta; arquivado, não volta sozinho', async () => {
  const h = setup();
  await h.content.setup();
  const d = h.store.listEmployees().find(e => e.template === 'conteudo-diretor-video')!;
  h.store.updateEmployee(d.id, { archivedAt: Date.now() } as never);
  h.db.prepare("DELETE FROM social_config WHERE key='content.director'").run();
  const c2 = h.mk(); c2.start(3_600_000); c2.stop();
  assert.equal(h.store.listEmployees().filter(e => e.template === 'conteudo-diretor-video' && !e.archivedAt).length, 1, 'sala antiga sem Diretor: contrata na subida');
  const d2 = h.store.listEmployees().find(e => e.template === 'conteudo-diretor-video' && !e.archivedAt)!;
  h.store.updateEmployee(d2.id, { archivedAt: Date.now() } as never);
  const c3 = h.mk(); c3.start(3_600_000); c3.stop();
  assert.equal(h.store.listEmployees().filter(e => e.template === 'conteudo-diretor-video' && !e.archivedAt).length, 0, 'o Chefe arquivou: não volta sozinho');
});
