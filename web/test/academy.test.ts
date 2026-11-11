// "Compartilhar vídeo" e Academia de Vídeo (07/11): plataformas aceitas (Reels, TikTok, YouTube, Shorts, X; arquivo MP4 e
// MOV), o recado do Chefe decide o caminho (estudar, analisar, fazer a nossa versão), o cartão do estudo na tela Conteúdo,
// o progresso dos exercícios e o filtro da biblioteca de técnicas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AcademyStudy, AcademyTechnique, RadarItem } from '@milweb-hq/protocol';
import { VIDEO_TASK_STATUS } from '@milweb-hq/protocol';
import { checkShareFile, checkShareLink, filterTechniques, studyProgress, suggestMode } from '../src/shell/social/academyBoard';
import { homeRefColumn } from '../src/shell/social/homeBoard';

test('links aceitos: Instagram Reels, TikTok, YouTube, Shorts e X; outro site com aviso; texto que não é link recusado', () => {
  const ok = (u: string) => { const r = checkShareLink(u); assert.ok(r.ok, u); return r.ok ? r.platform : ''; };
  assert.equal(ok('https://www.instagram.com/reel/DAbc123xyz/'), 'Instagram Reels');
  assert.equal(ok('https://www.tiktok.com/@dev/video/7300000000000000000'), 'TikTok');
  assert.equal(ok('https://vm.tiktok.com/ZMabc/'), 'TikTok');
  assert.equal(ok('https://www.youtube.com/watch?v=CAITNO_mny8'), 'YouTube');
  assert.equal(ok('https://youtu.be/CAITNO_mny8'), 'YouTube');
  assert.equal(ok('https://www.youtube.com/shorts/abc123'), 'YouTube Shorts');
  assert.equal(ok('https://x.com/dev/status/1850000000000000000'), 'X');
  assert.match((checkShareLink('https://www.instagram.com/reel/x/') as { warn: string }).warn, /login/);
  const other = checkShareLink('https://vimeo.com/123');
  assert.ok(other.ok && other.platform === 'outro site' && /não está na lista/.test(other.warn!));
  assert.equal(checkShareLink('olha esse vídeo').ok, false);
  assert.equal(checkShareLink('').ok, false);
});

test('arquivo: MP4 e MOV até 300 MB', () => {
  assert.equal(checkShareFile({ name: 'edit.mp4', type: 'video/mp4', size: 10_000_000 }), null);
  assert.equal(checkShareFile({ name: 'gravacao.MOV', type: 'video/quicktime', size: 10_000_000 }), null);
  assert.equal(checkShareFile({ name: 'gravacao.mov', type: '', size: 1 }), null, 'Windows às vezes não informa o tipo do .mov');
  assert.match(checkShareFile({ name: 'clip.webm', type: 'video/webm', size: 1 })!, /MP4 ou MOV/);
  assert.match(checkShareFile({ name: 'longo.mp4', type: 'video/mp4', size: 400_000_000 })!, /300 MB/);
});

test('o recado decide o caminho: estudar (Academia), fazer a nossa versão ou analisar', () => {
  assert.equal(suggestMode('Equipe, estudem esse vídeo. Quero que aprendam a fazer animações desse nível.'), 'estudo');
  assert.equal(suggestMode('depois de instala aprende fazer um edit'), 'estudo');
  assert.equal(suggestMode('quero um vídeo inspirado neste para o Tuco Dev'), 'produzir');
  assert.equal(suggestMode(''), 'analise');
});

const study = (o: Partial<AcademyStudy> = {}): AcademyStudy => ({ id: 's1', radarId: 'r1', title: 'Edit', url: null, folder: 'C:\\c\\academia\\estudos\\x', request: null, status: 'exercicios', summary: null, lesson: null, analysis: null, techniques: [], exercises: [], meetingId: null, lessonSynthesis: null, feedback: null, history: [], error: null, createdAt: 1, updatedAt: 1, ...o });
const ex = (id: string, status: AcademyStudy['exercises'][number]['status'], verdict: 'ok' | 'ajustar' | null = null): AcademyStudy['exercises'][number] => ({ id, title: id, role: 'video', profileId: null, employeeId: 'e', employeeName: 'Teo', techniques: [], instructions: '', deliverable: '', dir: '', status, taskId: null, result: null, feedback: verdict ? { verdict, note: '', at: 1 } : null, error: null });

test('progresso do estudo: entregues, falhas e a correção', () => {
  assert.deepEqual(studyProgress(study({ exercises: [ex('e1', 'concluido', 'ok'), ex('e2', 'em_producao'), ex('e3', 'falhou'), ex('e4', 'concluido', 'ajustar')] })), { total: 4, done: 2, failed: 1, running: 1, ok: 1, adjust: 1 });
});

test('estado simples da tarefa (pendente, em análise, em produção, bloqueada, concluída) e o estudo na tela Conteúdo', () => {
  assert.equal(VIDEO_TASK_STATUS.recebida, 'pendente'); assert.equal(VIDEO_TASK_STATUS.analisando, 'em_analise'); assert.equal(VIDEO_TASK_STATUS.aula, 'em_analise');
  assert.equal(VIDEO_TASK_STATUS.exercicios, 'em_producao'); assert.equal(VIDEO_TASK_STATUS.bloqueada, 'bloqueada'); assert.equal(VIDEO_TASK_STATUS.concluida, 'concluida');
  const ref = (stage: string, mode: string, updatedAt = Date.now()) => ({ id: 'r', status: 'nova', video: { mode, stage, slot: null, itemIds: [], updatedAt } } as unknown as RadarItem);
  assert.equal(homeRefColumn(ref('aula', 'estudo'), []), 'fazendo');
  assert.equal(homeRefColumn(ref('exercicios', 'estudo'), []), 'fazendo');
  assert.equal(homeRefColumn(ref('concluida', 'estudo'), []), 'ver', 'estudo concluído espera o Chefe ver a correção');
  assert.equal(homeRefColumn(ref('concluida', 'estudo', Date.now() - 8 * 86_400_000), []), null, 'depois de 7 dias sai da tela (fica na Academia)');
  assert.equal(homeRefColumn(ref('concluida', 'analise'), []), null);
});

test('biblioteca: busca por nome/slug/resumo e categoria; observadas e aprovadas primeiro', () => {
  const t = (slug: string, o: Partial<AcademyTechnique> = {}): AcademyTechnique => ({ id: slug, slug, name: slug.replace(/-/g, ' '), category: 'animacao', summary: '', how: [], sources: [], examples: [], pitfalls: [], file: null, createdAt: 1, updatedAt: 1, ...o });
  const list = [
    t('zoom-de-impacto', { category: 'camera', updatedAt: 5 }),
    t('texto-que-salta', { sources: [{ studyId: 's', title: 'x', at: null, evidence: 'observado', note: null }] }),
    t('flash-branco', { category: 'transicao', summary: 'quadro branco entre planos', examples: [{ studyId: 's', exerciseId: 'e1', employee: 'Teo', file: null, verdict: 'ok', note: null }] }),
  ];
  assert.deepEqual(filterTechniques(list, '', '').map(x => x.slug), ['texto-que-salta', 'flash-branco', 'zoom-de-impacto']);
  assert.deepEqual(filterTechniques(list, 'branco', '').map(x => x.slug), ['flash-branco']);
  assert.deepEqual(filterTechniques(list, '', 'camera').map(x => x.slug), ['zoom-de-impacto']);
});

test('campo da sala ("O que vamos criar?"): "estudem esse vídeo" + link vai para estudo, não para análise nem produção', async () => {
  const { STUDY_INTENT, PRODUCE_INTENT, parseLinks } = await import('../src/shell/social/VideoRefComposer');
  const { instruction } = parseLinks('https://www.youtube.com/watch?v=CAITNO_mny8 depois de instala aprende fazer um edit');
  assert.ok(STUDY_INTENT.test(instruction!));
  assert.ok(!STUDY_INTENT.test('quero um vídeo inspirado neste para o Tuco Dev') && PRODUCE_INTENT.test('quero um vídeo inspirado neste para o Tuco Dev'));
});
