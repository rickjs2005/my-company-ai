// Tela Conteúdo (05/11; 06/11: Tuco · Instagram, Aurora · Instagram e Aurora · Threads), quatro colunas em linguagem simples,
// referências de vídeo sem peça como cartão próprio, trabalho avulso da equipe, foco que falta, link de vídeo vira versão própria
// e a sugestão de conta e formato pelo texto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentItem, ContentState, Employee, RadarItem, Task } from '@milweb-hq/protocol';
import { focusReasonFor, quickFormatName, quickFormatsFor, quickTitle } from '@milweb-hq/protocol';
import { HOME_COLUMNS, ago, focusMissing, hasVideoLink, homeBoard, homeColumn, looseWork, stopReason, suggestFormat, suggestSlot, taskLabel } from '../src/shell/social/homeBoard';
import { plainStatus } from '../src/shell/social/ContentHome';

const item = (o: Partial<ContentItem> & Pick<ContentItem, 'id'>): ContentItem => ({ weekStart: null, baseId: null, baseTitle: null, date: '2026-11-05', time: null, slot: 'instagram-tuco', profileId: 'tuco-dev', format: 'Reel', objective: '', title: o.id, brief: '', sources: [], files: [], material: 'nao_precisa', ownerId: 'bia', skill: null, reviewCriteria: '', status: 'planejada', taskId: null, reviewTaskId: null, radarId: null, folder: null, deliverable: null, checks: [], review: null, nextStep: null, approvalId: null, publication: null, deletedAt: null, archivedAt: null, requestId: null, history: [], pausedReason: null, hypothesis: null, referenceIds: [], learning: null, pipeline: null, createdAt: 1, updatedAt: 1, ...o });
const task = (id: string, status: Task['status'], employeeId = 'bia'): Task => ({ id, status, prompt: 'x', sessionId: 's', projectId: 'p', roomId: 'r', clientId: id, attachments: [], mode: 'send', createdAt: 1, errors: [], employeeId } as unknown as Task);
const ref = (id: string, stage: string, o: Record<string, unknown> = {}): RadarItem => ({ id, status: 'nova', subject: id, sourceUrl: `https://www.tiktok.com/@a/video/${id}`, createdAt: 1, video: { mode: 'produzir', stage, slot: 'instagram-tuco', itemIds: [], updatedAt: 1, error: null, ...o } } as unknown as RadarItem);
const employees = [{ id: 'bia', name: 'Bia' }, { id: 'otto', name: 'Otto' }] as Employee[];
const NOW = Date.parse('2026-11-05T21:00:00Z');

test('colunas: fazendo, para você ver, pronto e postado; outras redes, pausadas, lixeira e postado antigo ficam fora', () => {
  const tasks = [task('q', 'queued'), task('r', 'running'), task('rv', 'running', 'otto')];
  assert.equal(homeColumn(item({ id: 'a', status: 'em_producao', taskId: 'q' }), tasks, NOW), 'fazendo');
  assert.equal(homeColumn(item({ id: 'b', status: 'revisar', reviewTaskId: 'rv' }), tasks, NOW), 'fazendo', 'revisor trabalhando');
  assert.equal(homeColumn(item({ id: 'c', status: 'revisar' }), tasks, NOW), 'ver');
  assert.equal(homeColumn(item({ id: 'd', status: 'falhou' }), tasks, NOW), 'ver');
  assert.equal(homeColumn(item({ id: 'e', status: 'planejada' }), tasks, NOW), 'ver');
  assert.equal(homeColumn(item({ id: 'f', status: 'aprovada', slot: 'threads' }), tasks, NOW), 'pronto', 'Threads da Aurora entra na tela');
  assert.equal(homeColumn(item({ id: 'g', status: 'publicada', publication: { url: null, at: NOW - 3 * 86_400_000, verifiedBy: 'chefe' } as ContentItem['publication'] }), tasks, NOW), 'postado');
  assert.equal(homeColumn(item({ id: 'h', status: 'publicada', publication: { url: null, at: NOW - 20 * 86_400_000, verifiedBy: 'chefe' } as ContentItem['publication'] }), tasks, NOW), null, 'postado há mais de 14 dias');
  assert.equal(homeColumn(item({ id: 'i', status: 'revisar', slot: 'tiktok' }), tasks, NOW), null, 'TikTok é do Chefe, fora da tela');
  assert.equal(homeColumn(item({ id: 'j', status: 'revisar', pausedReason: 'foco' }), tasks, NOW), null, 'pausada');
  assert.equal(homeColumn(item({ id: 'k', status: 'revisar', deletedAt: 5 }), tasks, NOW), null, 'lixeira');
});

test('quadro: referência sem peça vira cartão; com peça viva some (a peça fala por ela); conta outras redes à parte', () => {
  const items = [item({ id: 'p1', status: 'em_producao', taskId: 'r' }), item({ id: 'tk', slot: 'tiktok', status: 'revisar' })];
  const c = { items, radar: [ref('r1', 'analisando'), ref('r2', 'bloqueada'), ref('r3', 'producao', { itemIds: ['p1'] }), ref('r4', 'proposta', { slot: 'linkedin' }), { ...ref('r5', 'analisando'), status: 'descartada' } as RadarItem] } as unknown as ContentState;
  const b = homeBoard(c, [task('r', 'running')], NOW);
  assert.deepEqual(b.cols.fazendo.refs.map(r => r.id), ['r1']);
  assert.deepEqual(b.cols.fazendo.items.map(i => i.id), ['p1']);
  assert.deepEqual(b.cols.ver.refs.map(r => r.id), ['r2']);
  assert.equal(b.otherNetworks, 1);
});

test('estado em palavras simples: quem está com a peça e o que falta', () => {
  const tasks = [task('q', 'queued'), task('r', 'running'), task('rv', 'running', 'otto')];
  assert.equal(plainStatus(item({ id: 'a', status: 'em_producao', taskId: 'q' }), tasks, employees), 'Na fila da equipe');
  assert.equal(plainStatus(item({ id: 'b', status: 'em_producao', taskId: 'r' }), tasks, employees), 'Bia está produzindo');
  assert.equal(plainStatus(item({ id: 'c', status: 'revisar', reviewTaskId: 'rv' }), tasks, employees), 'Otto está revisando');
  assert.equal(plainStatus(item({ id: 'd', status: 'revisar', review: { verdict: 'aprovar', notes: '', checks: [], employeeId: 'otto', at: 1 } }), [], employees), 'Pronto. O revisor aprovou: falta você');
  assert.match(plainStatus(item({ id: 'e', status: 'falhou', nextStep: 'o render falhou' }), [], employees), /Não deu certo: o render falhou/);
});

test('foco: avisa só quando falta uma das três contas da tela; foco nunca definido libera tudo; motivo descreve o foco novo', () => {
  const c = (activeSlots: string[] | null) => ({ focus: { activeSlots } }) as unknown as ContentState;
  assert.deepEqual(focusMissing(c(['instagram-tuco', 'instagram-aurora', 'tiktok'])), ['threads']);
  assert.deepEqual(focusMissing(c(['instagram-tuco', 'instagram-aurora', 'threads'])), []);
  assert.deepEqual(focusMissing(c(null)), []);
  assert.equal(focusReasonFor(['instagram-tuco', 'instagram-aurora', 'threads']), 'Foco atual: Instagrams Tuco Dev e Aurora + Threads Aurora', 'mesmo texto de antes');
  assert.equal(focusReasonFor(['instagram-tuco', 'instagram-aurora', 'tiktok']), 'Foco atual: Instagrams Tuco Dev e Aurora + TikTok');
});

test('pedido: link de vídeo vira versão própria; conta e formato sugeridos pelo texto; título curto', () => {
  assert.equal(hasVideoLink('quero igual a esse https://www.tiktok.com/@o__maloqueiro/video/7685911412610321685?x=1'), true);
  assert.equal(hasVideoLink('olha esse artigo https://nextjs.org/blog/next-16'), false);
  assert.equal(suggestSlot('post no threads sobre proposta em PDF', 'tuco-dev'), 'threads');
  assert.equal(suggestSlot('reel pro tiktok sobre API', 'tuco-dev'), 'instagram-tuco', 'TikTok não é conta da tela');
  assert.equal(suggestSlot('quero igual https://www.tiktok.com/@a/video/1 para o tuco', 'aurora'), 'instagram-tuco', 'o domínio do link não decide a conta');
  assert.equal(suggestSlot('antes e depois do site', 'aurora'), 'instagram-aurora');
  assert.equal(suggestFormat('carrossel com 5 atalhos'), 'carrossel');
  assert.equal(suggestFormat('vídeo do garçom'), 'video');
  assert.equal(suggestFormat('carrossel com 5 atalhos', 'threads'), 'texto', 'Threads é texto');
  assert.deepEqual(quickFormatsFor('threads'), ['texto']);
  assert.deepEqual(quickFormatsFor('instagram-aurora'), ['video', 'carrossel']);
  assert.equal(quickFormatName('texto', 'threads'), 'post Threads');
  assert.equal(quickFormatName('video', 'tiktok'), 'vídeo TikTok');
  assert.equal(quickFormatName('carrossel', 'instagram-aurora'), 'carrossel');
  assert.equal(quickTitle('quero um reel explicando o que é API'), 'Reel explicando o que é API');
  assert.ok(quickTitle('a'.repeat(30) + ' ' + 'palavra '.repeat(20)).endsWith('…'));
});

test('pedido do dia: peça que o Chefe mandou para a lixeira não vira "conta sem peça" nem conta como esperada', async () => {
  const { requestProgress } = await import('../src/shell/social/pieceBoard');
  const req = { id: 'r1', date: '2026-11-04', title: 'Conteúdo de 04/11', slots: ['instagram-aurora', 'instagram-tuco', 'threads'], status: 'ativo', autoProduce: false, note: null, createdAt: 1 } as unknown as import('@milweb-hq/protocol').ContentRequest;
  const items = [item({ id: 'lixo', slot: 'instagram-aurora', requestId: 'r1', status: 'revisar', deletedAt: 5 }), item({ id: 'ok', slot: 'instagram-tuco', requestId: 'r1', status: 'revisar' })];
  const p = requestProgress(req, items, [], ['threads']);
  assert.deepEqual(p.rows.map(r => r.state), ['removida', 'pronta', 'pausado']);
  assert.equal(p.expected, 1); assert.equal(p.ready, 1); assert.equal(p.pending, 0);
});

test('"Esperando você": primeira coluna; pronto para olhar vem antes de pendência e de planejada', () => {
  assert.deepEqual(HOME_COLUMNS.map(c => c.label), ['Esperando você', 'A equipe está fazendo', 'Pronto para postar', 'Postado']);
  const c = { items: [item({ id: 'parc', status: 'parcial', updatedAt: 9 }), item({ id: 'plan', status: 'planejada', updatedAt: 8 }), item({ id: 'rev', status: 'revisar', updatedAt: 1 })], radar: [] } as unknown as ContentState;
  assert.deepEqual(homeBoard(c, [], NOW).cols.ver.items.map(i => i.id), ['rev', 'parc', 'plan']);
});

test('equipe fazendo: tarefa avulsa da sala aparece (rodando antes da fila); peça e vídeo de referência não duplicam; parada vai para "Esperando você"', () => {
  const t = (id: string, status: Task['status'], o: Partial<Task> = {}): Task => ({ ...task(id, status), prompt: '/milweb-video-studio um de voces crie um video ensinando sobre git e github', createdAt: NOW - 600_000, ...o } as Task);
  const tasks = [
    t('solta', 'running', { startedAt: NOW - 360_000 }),
    t('fila', 'queued', { prompt: 'Rodada do Radar da gringa. Agora: 06/11', createdAt: NOW - 60_000 }),
    t('peca', 'running'),
    t('video', 'running'),
    t('caiu', 'interrupted', { finishedAt: NOW - 3_600_000, errors: ['O serviço do My Company AI reiniciou enquanto esta tarefa rodava.'] }),
    t('velha', 'error', { finishedAt: NOW - 3 * 86_400_000 }),
    t('refeita', 'lost', { finishedAt: NOW - 60_000 }), t('nova', 'queued', { retryOf: 'refeita', createdAt: NOW - 30_000 }),
    t('escondida', 'error', { finishedAt: NOW - 60_000 }),
    t('cancelada', 'interrupted', { finishedAt: NOW - 60_000, errors: ['Cancelada na fila pelo Chefe'] }),
    t('revisao', 'error', { finishedAt: NOW - 60_000, prompt: 'Revisar a peça "Vibe coding" (Instagram · Tuco Dev).' }),
  ];
  const c = { items: [item({ id: 'p', status: 'em_producao', taskId: 'peca' })], rounds: [{ id: 'r', kind: 'video', taskId: 'video' }], hidden: [{ key: 'task:escondida', kind: 'task', state: 'arquivada', at: 1, title: null }] } as unknown as ContentState;
  const w = looseWork(tasks, c, NOW);
  assert.deepEqual(w.doing.map(x => x.task.id), ['solta', 'fila', 'nova']);
  assert.equal(w.doing[0].label, 'Um de voces crie um video ensinando sobre git e github', 'sem o comando da skill');
  assert.equal(w.doing[1].label, 'Radar');
  assert.deepEqual(w.stopped.map(x => x.task.id), ['caiu'], 'só o que parou nas últimas 24 h, sem retentativa, sem dispensa, sem o que o Chefe cancelou e sem revisão de peça');
  assert.match(w.stopped[0].reason!, /reiniciou/);
  assert.equal(taskLabel(t('x', 'running', { prompt: '' })), 'Tarefa sem texto');
  assert.equal(taskLabel(t('l', 'running', { prompt: 'https://www.tiktok.com/@o/video/1?is_from_webapp=1. queria um assim pro tuco' })), 'Queria um assim pro tuco', 'o link sai do título');
  assert.equal(taskLabel(t('l2', 'running', { prompt: 'https://x.com/a/status/1' })), 'Análise de um link');
  assert.equal(stopReason(t('d', 'interrupted', { errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'] })), 'Parou no meio (a HQ reiniciou ou a tarefa foi interrompida).', 'diagnóstico técnico não aparece');
  assert.equal(stopReason(t('e', 'lost', { errors: ['O serviço do My Company AI reiniciou enquanto esta tarefa rodava.', '[ede_diagnostic] x=1 y=2'] })), 'O serviço do My Company AI reiniciou enquanto esta tarefa rodava.');
  assert.equal(ago(NOW - 6 * 60_000, NOW), 'há 6 min');
  assert.equal(ago(NOW - 2 * 3_600_000, NOW), 'há 2 h');
});

test('entregue: pedido direto que terminou espera o Chefe em "Esperando você" (24 h, até "Visto"); Radar, rotina e reunião ficam fora', async () => {
  const { mainFiles } = await import('../src/shell/social/homeBoard');
  const t = (id: string, o: Partial<Task> = {}): Task => ({ ...task(id, 'done'), prompt: '/milweb-video-studio video sobre git e github', finishedAt: NOW - 3_600_000, deliverables: [], ...o } as Task);
  const files = ['C:/x/renderizar.cjs', 'C:/x/peca.md', 'C:/x/video.mp4', 'C:/x/index.html'].map((path, i) => ({ id: `d${i}`, taskId: 'git', kind: 'file', title: path, path, changeType: 'created' }));
  const tasks = [
    t('git', { deliverables: files as Task['deliverables'] }),
    t('radar', { prompt: 'Rodada do Radar da gringa' }),
    t('rotina', { origin: 'routine' }),
    t('reuniao', { meetingId: 'm1' } as Partial<Task>),
    t('antiga', { finishedAt: NOW - 3 * 86_400_000 }),
    t('vista'),
  ];
  const c = { items: [], rounds: [{ id: 'r', kind: 'radar', taskId: 'radar' }], hidden: [{ key: 'task:vista', kind: 'task', state: 'arquivada', at: 1, title: null }] } as unknown as ContentState;
  const w = looseWork(tasks, c, NOW);
  assert.deepEqual(w.delivered.map(x => x.task.id), ['git']);
  assert.deepEqual(mainFiles(w.delivered[0].files!), ['C:/x/video.mp4', 'C:/x/peca.md', 'C:/x/index.html'], 'vídeo primeiro; script fica de fora');
});

test('vídeo compartilhado: o cartão diz onde a análise está de verdade (na fila, rodando, esperando o Chefe)', async () => {
  const { refTaskState } = await import('../src/shell/social/homeBoard');
  const r = { id: 'r1', status: 'nova', video: { dir: 'C:/c/radar/entrada/x', stage: 'analisando', mode: 'produzir', itemIds: [] } } as unknown as RadarItem;
  const c = { rounds: [{ id: 'k', kind: 'video', status: 'aguardando', taskId: 't1', employeeId: 'vitor', outputPath: 'C:/c/radar/entrada/x/analise-video.json', startedAt: 1 }] } as unknown as ContentState;
  assert.deepEqual(refTaskState(r, c, [task('t1', 'queued', 'vitor')]), { status: 'fila', employeeId: 'vitor' });
  assert.deepEqual(refTaskState(r, c, [task('t1', 'running', 'vitor')]), { status: 'rodando', employeeId: 'vitor' });
  assert.deepEqual(refTaskState(r, c, [task('t1', 'waiting_permission', 'vitor')]), { status: 'espera', employeeId: 'vitor' });
  assert.equal(refTaskState(r, c, [task('t1', 'done', 'vitor')]), null);
  assert.equal(refTaskState(r, { rounds: [] } as unknown as ContentState, []), null);
});
