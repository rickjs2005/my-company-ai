// Mural por peça: colunas pelo estado real, filtros (marca, conta, data, estado), lixeira e arquivo fora dos contadores,
// alcance do "Cancelar tarefa e mover para a lixeira", progresso do pedido do dia e pedidos avulsos separados das peças.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentItem, ContentRequest, ContentState, Task } from '@milweb-hq/protocol';
import { filterPieces, looseTasks, pieceColumn, pieceCounts, requestProgress, runningScope } from '../src/shell/social/pieceBoard';

const item = (o: Partial<ContentItem> & Pick<ContentItem, 'id'>): ContentItem => ({ weekStart: null, baseId: null, baseTitle: null, date: '2026-11-04', time: null, slot: 'threads', profileId: 'aurora', format: 'post', objective: '', title: o.id, brief: '', sources: [], files: [], material: 'nao_precisa', ownerId: null, skill: null, reviewCriteria: '', status: 'planejada', taskId: null, reviewTaskId: null, radarId: null, folder: null, deliverable: null, checks: [], review: null, nextStep: null, approvalId: null, publication: null, deletedAt: null, archivedAt: null, requestId: null, history: [], pausedReason: null, hypothesis: null, referenceIds: [], learning: null, pipeline: null, createdAt: 1, updatedAt: 1, ...o });
const task = (id: string, status: Task['status'], prompt = 'x'): Task => ({ id, status, prompt, sessionId: 's', projectId: 'p', roomId: 'r', clientId: id, attachments: [], mode: 'send', createdAt: 1, errors: [] } as unknown as Task);

test('coluna da peça: fila, produção, revisão do Otto rodando, para revisar, parcial ou falhou, aprovada', () => {
  const tasks = [task('q', 'queued'), task('r', 'running'), task('rv', 'running'), task('d', 'done')];
  assert.equal(pieceColumn(item({ id: 'a', status: 'em_producao', taskId: 'q' }), tasks), 'fila');
  assert.equal(pieceColumn(item({ id: 'b', status: 'em_producao', taskId: 'r' }), tasks), 'producao');
  assert.equal(pieceColumn(item({ id: 'c', status: 'revisar', reviewTaskId: 'rv' }), tasks), 'producao', 'Otto revisando');
  assert.equal(pieceColumn(item({ id: 'd', status: 'revisar', reviewTaskId: 'd', review: { verdict: 'aprovar', notes: '', checks: [], employeeId: null, at: 1 } }), tasks), 'revisar');
  assert.equal(pieceColumn(item({ id: 'e', status: 'parcial' }), tasks), 'parcial');
  assert.equal(pieceColumn(item({ id: 'f', status: 'falhou' }), tasks), 'parcial');
  assert.equal(pieceColumn(item({ id: 'g', status: 'aprovada' }), tasks), 'pronto');
});

test('filtros e contadores: marca, conta, período e estado; lixeira e arquivadas ficam fora do mural ativo e dos números', () => {
  const items = [
    item({ id: 'mil-th', profileId: 'aurora', slot: 'threads', status: 'revisar' }),
    item({ id: 'goj-ig', profileId: 'tuco-dev', slot: 'instagram-tuco', status: 'revisar', date: '2026-11-05' }),
    item({ id: 'lixo', status: 'revisar', deletedAt: 5 }),
    item({ id: 'arq', status: 'revisar', archivedAt: 5 }),
    item({ id: 'plan', status: 'planejada' }),
  ];
  const f = { profileId: null, slot: '' as const, from: '', to: '', view: 'ativas' as const };
  assert.deepEqual(filterPieces(items, f, []).map(i => i.id), ['mil-th', 'plan', 'goj-ig']);
  assert.deepEqual(filterPieces(items, { ...f, profileId: 'aurora', view: 'revisar' }, []).map(i => i.id), ['mil-th']);
  assert.deepEqual(filterPieces(items, { ...f, slot: 'instagram-tuco' }, []).map(i => i.id), ['goj-ig']);
  assert.deepEqual(filterPieces(items, { ...f, from: '2026-11-05', to: '2026-11-05' }, []).map(i => i.id), ['goj-ig']);
  assert.deepEqual(filterPieces(items, { ...f, view: 'lixeira' }, []).map(i => i.id), ['lixo']);
  assert.deepEqual(filterPieces(items, { ...f, view: 'arquivadas' }, []).map(i => i.id), ['arq']);
  assert.deepEqual(pieceCounts(items, []), { queued: 0, producing: 0, review: 2, ready: 0, partial: 0 });
  assert.deepEqual(pieceCounts(items, [], 'aurora').review, 1);
});

test('"Cancelar tarefa e mover para a lixeira" diz o alcance: a que roda e as da fila', () => {
  const tasks = [task('prod', 'running'), task('rev', 'queued')];
  const s = runningScope(item({ id: 'x', status: 'em_producao', taskId: 'prod', reviewTaskId: 'rev' }), tasks);
  assert.deepEqual(s.running.map(t => t.id), ['prod']); assert.deepEqual(s.queued.map(t => t.id), ['rev']);
  assert.deepEqual(runningScope(item({ id: 'y', status: 'revisar', taskId: 'feito' }), [task('feito', 'done')]), { running: [], queued: [] });
});

test('progresso do pedido: uma linha por conta, contada das peças e tarefas reais', () => {
  const req: ContentRequest = { id: 'q', title: 'Conteúdo de 04/11', date: '2026-11-04', slots: ['threads', 'linkedin', 'x', 'pinterest'], note: null, origin: 'interface', autoProduce: true, status: 'ativo', createdAt: 1, updatedAt: 1, plan: null };
  const items = [
    item({ id: 'th', slot: 'threads', status: 'revisar', requestId: 'q' }),
    item({ id: 'li', slot: 'linkedin', status: 'em_producao', taskId: 't1', requestId: 'q' }),
    item({ id: 'x', slot: 'x', status: 'parcial', nextStep: 'entrega parcial: falta texto do post', requestId: 'q' }),
    item({ id: 'velho', slot: 'pinterest', status: 'revisar', requestId: 'q', deletedAt: 9 }),
  ];
  const p = requestProgress(req, items, [task('t1', 'waiting_permission')]);
  assert.deepEqual(p.rows.map(r => [r.slot, r.state]), [['threads', 'pronta'], ['linkedin', 'producao'], ['x', 'parcial'], ['pinterest', 'removida']]);
  assert.equal(p.rows[1].text, 'esperando a sua autorização (Mesa → Bloqueios)');
  // 05/11: a peça que o Chefe mandou para a lixeira não é "peça faltando" (antes virava bloqueio preso no pedido).
  assert.match(p.rows[3].text, /lixeira/);
  assert.deepEqual([p.expected, p.ready, p.producing, p.pending], [3, 1, 1, 1]);
});

test('pedidos avulsos: tudo que não é peça, pesquisa, calendário ou entrega de reunião', () => {
  const c = { rounds: [{ taskId: 'radar' }] } as unknown as ContentState;
  const tasks = [task('radar', 'done', 'Rodada do Radar de oportunidades'), task('prod', 'done', '/rede-x Produzir a peça'), task('reuniao', 'done'), task('livre', 'done', 'Ideias de vídeos curtos')];
  const loose = looseTasks(tasks, c, [{ taskId: 'reuniao' } as never], t => (t.id === 'prod' ? item({ id: 'p' }) : null));
  assert.deepEqual(loose.map(t => t.id), ['livre']);
});

test('foco: peça de destino pausado vai para "Pausadas pelo foco", não conta como pronta e o pedido do dia não espera por ela', () => {
  const paused = item({ id: 'tk', slot: 'tiktok', status: 'revisar', pausedReason: 'Foco atual: Instagrams Tuco Dev e Aurora + Threads Aurora', requestId: 'r' });
  const live = item({ id: 'th', slot: 'threads', status: 'revisar', requestId: 'r' });
  assert.equal(pieceColumn(paused, []), 'pausada');
  assert.equal(pieceCounts([paused, live], []).review, 1);
  assert.deepEqual(filterPieces([paused, live], { profileId: null, slot: '', from: '', to: '', view: 'pausadas' }, []).map(i => i.id), ['tk']);
  assert.deepEqual(filterPieces([paused, live], { profileId: null, slot: '', from: '', to: '', view: 'revisar' }, []).map(i => i.id), ['th']);
  const req = { id: 'r', title: 'Pedido', date: '2026-11-04', slots: ['threads', 'tiktok', 'linkedin'], note: null, origin: 'interface', autoProduce: true, status: 'ativo', createdAt: 1, updatedAt: 1 } as ContentRequest;
  const p = requestProgress(req, [paused, live], [], ['tiktok', 'linkedin']);
  assert.equal(p.expected, 1); assert.equal(p.ready, 1); assert.equal(p.pending, 0);
  assert.deepEqual(p.rows.map(r => r.state), ['pronta', 'pausado', 'pausado']);
});

test('aprovar: só peça entregue (para revisar ou ajustar), sem pausa, lixeira, arquivo ou tarefa rodando; período de hoje até a data (ou 7 dias)', async () => {
  const { canApprove, approvalWindow } = await import('../src/shell/social/pieceBoard');
  assert.equal(canApprove(item({ id: 'a', status: 'revisar' }), []), true);
  assert.equal(canApprove(item({ id: 'b', status: 'ajustar' }), []), true);
  assert.equal(canApprove(item({ id: 'c', status: 'parcial' }), []), false);
  assert.equal(canApprove(item({ id: 'd', status: 'revisar', pausedReason: 'Foco' }), []), false);
  assert.equal(canApprove(item({ id: 'e', status: 'revisar', deletedAt: 1 }), []), false);
  assert.equal(canApprove(item({ id: 'f', status: 'revisar', reviewTaskId: 'rv' }), [task('rv', 'running')]), false);
  assert.deepEqual(approvalWindow(item({ id: 'g', date: '2026-11-05' }), '2026-11-04'), { from: '2026-11-04', to: '2026-11-05' });
  assert.deepEqual(approvalWindow(item({ id: 'h', date: null }), '2026-11-04'), { from: '2026-11-04', to: '2026-11-11' });
  assert.deepEqual(approvalWindow(item({ id: 'i', date: '2026-11-01' }), '2026-11-04'), { from: '2026-11-04', to: '2026-11-11' });
});

test('"Já publiquei": peça entregue ou aprovada marca; publicada sem link só acrescenta o link; parcial, lixeira e tarefa rodando não', async () => {
  const { publishAction } = await import('../src/shell/social/pieceBoard');
  assert.equal(publishAction(item({ id: 'a', status: 'aprovada' }), []), 'marcar');
  assert.equal(publishAction(item({ id: 'b', status: 'revisar' }), []), 'marcar');
  assert.equal(publishAction(item({ id: 'c', status: 'parcial' }), []), null);
  assert.equal(publishAction(item({ id: 'd', status: 'aprovada', deletedAt: 1 }), []), null);
  assert.equal(publishAction(item({ id: 'e', status: 'publicada', publication: { url: null, at: 1, verifiedBy: 'chefe', detail: '' } }), []), 'link');
  assert.equal(publishAction(item({ id: 'f', status: 'publicada', publication: { url: 'https://www.instagram.com/p/x/', at: 1, verifiedBy: 'link', detail: '' } }), []), null);
  assert.equal(publishAction(item({ id: 'g', status: 'revisar', reviewTaskId: 'rv' }), [task('rv', 'running')]), null);
});
