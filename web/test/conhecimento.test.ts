// Conhecimento da equipe (10/11): funções puras da tela. Indicadores contam registros reais; nada de nível ou porcentagem.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DeskDelivery, Employee, KnowledgeBoard, KnowledgeItem, Task } from '@milweb-hq/protocol';
import { currentItems, demonstrated, filterItems, parseScopeKey, reaches, scopeKey, scopeOptions, sinceLastVisit, tabCounts, usesOf, usesOfTask, versionsOf } from '../src/shell/knowledgeBoard';

const emp = (id: string, name: string, profileId: string | null, template: string | null): Employee => ({ id, name, role: 'x', roomId: 'r', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0, instructions: '', profileId, model: null, effort: null, permissionMode: 'default', activeSessionId: null, archivedAt: null, createdAt: 0, updatedAt: 0, provider: 'claude', skills: [], agent: null, template, access: {} as Employee['access'] });
const item = (p: Partial<KnowledgeItem> & { id: string }): KnowledgeItem => ({ chainId: p.id, version: 1, kind: 'preferencia', scope: { type: 'empresa', id: null }, title: 't', text: 'texto', state: 'ativo', origin: 'chefe', originNote: null, evidence: [], supersedesId: null, supersededById: null, createdAt: 1, updatedAt: 1, uses: 0, lastUsedAt: null, ...p });
const nina = emp('n', 'Nina', 'tuco-dev', 'conteudo-criador'); const bia = emp('b', 'Bia', 'aurora', 'conteudo-criador'); const otto = emp('o', 'Otto', null, 'conteudo-revisor');

const board: KnowledgeBoard = {
  items: [
    item({ id: 'g2', chainId: 'g', version: 2, scope: { type: 'equipe', id: 'tuco-dev' }, text: 'Comece direto no assunto', updatedAt: 5, supersedesId: 'g1' }),
    item({ id: 'g1', chainId: 'g', version: 1, scope: { type: 'equipe', id: 'tuco-dev' }, text: 'Comece com piada', state: 'substituido', supersededById: 'g2' }),
    item({ id: 'p1', kind: 'procedimento', state: 'proposto', origin: 'referencia', text: 'Transição com máscara' }),
    item({ id: 'd1', state: 'desativado', scope: { type: 'funcionario', id: 'b' } }),
    item({ id: 'f1', scope: { type: 'funcao', id: 'conteudo-revisor' }, text: 'Conferir fontes' }),
  ],
  recentUses: [
    { knowledgeId: 'g1', chainId: 'g', version: 1, title: 't', kind: 'preferencia', taskId: 't1', taskTitle: 'vídeo 1', employeeId: 'n', profileId: 'tuco-dev', at: 10 },
    { knowledgeId: 'g2', chainId: 'g', version: 2, title: 't', kind: 'preferencia', taskId: 't2', taskTitle: 'vídeo 2', employeeId: 'n', profileId: 'tuco-dev', at: 20 },
  ],
};

test('abas: em uso, propostos e desativados; versão substituída só aparece no histórico da ficha', () => {
  assert.deepEqual(tabCounts(board), { vigentes: 2, propostos: 1, historico: 1 });
  assert.ok(!currentItems(board).some(i => i.id === 'g1'));
  assert.deepEqual(versionsOf(board, board.items[0]).map(i => i.id), ['g1']);
  assert.deepEqual(filterItems(board, { tab: 'vigentes', scope: 'equipe:tuco-dev', query: '' }).map(i => i.id), ['g2']);
  assert.deepEqual(filterItems(board, { tab: 'vigentes', scope: '', query: 'FONTES' }).map(i => i.id), ['f1']);
  assert.deepEqual(filterItems(board, { tab: 'propostos', scope: '', query: '' }).map(i => i.id), ['p1']);
});

test('uso: cada tarefa mostra a versão que recebeu; a ficha soma as versões', () => {
  assert.deepEqual(usesOf(board, board.items[0]).map(u => [u.taskId, u.version]), [['t2', 2], ['t1', 1]]);
  assert.deepEqual(usesOfTask(board, 't1').map(u => u.version), [1]);
  assert.deepEqual(usesOfTask(board, null), []);
});

test('alcance: equipe não vaza para a outra marca; função e pessoa são exatas; a chave do seletor vai e volta', () => {
  const g = board.items[0]; const f = board.items[4];
  assert.equal(reaches(g, nina), true); assert.equal(reaches(g, bia), false, 'preferência do Tuco não alcança a Aurora');
  assert.equal(reaches(g, otto), false, 'apoio recebe a da equipe só dentro da tarefa dela (decidido no servidor)');
  assert.equal(reaches(f, otto), true); assert.equal(reaches(f, nina), false);
  for (const s of [{ type: 'empresa', id: null }, { type: 'equipe', id: 'aurora' }, { type: 'funcionario', id: 'n' }] as const) assert.deepEqual(parseScopeKey(scopeKey(s)), s);
  const opts = scopeOptions([nina, bia, otto], []);
  assert.ok(opts.some(o => o.key === 'equipe:tuco-dev') && opts.some(o => o.key === 'funcao:conteudo-revisor') && opts.some(o => o.key === 'funcionario:n'));
});

test('o que cada pessoa demonstrou: só registros (orientação ativa, uso em tarefa, entrega aprovada); sem registro fica zero', () => {
  const deliveries = [{ id: 'e1', employeeId: 'n', rootTaskId: 't1', status: 'aprovada' }, { id: 'e2', employeeId: 'n', rootTaskId: 't9', status: 'nova' }] as unknown as DeskDelivery[];
  const rows = demonstrated([nina, bia, otto], board, deliveries, [], []);
  const n = rows.find(r => r.employee.id === 'n')!; const b = rows.find(r => r.employee.id === 'b')!;
  assert.equal(n.guidance, 1); assert.equal(n.applied, 2); assert.equal(n.approved, 1); assert.equal(n.delivered, 2); assert.equal(n.exercises, 0);
  assert.equal(b.guidance, 0, 'item desativado e proposto não contam como orientação registrada'); assert.equal(b.applied, 0);
});

test('resumo desde a última visita vem das tarefas persistidas', () => {
  const t = (id: string, status: string, finishedAt: number | null, held = false) => ({ id, status, finishedAt, held }) as unknown as Task;
  const s = sinceLastVisit([t('a', 'done', 50), t('b', 'done', 150), t('c', 'running', null), t('d', 'queued', null), t('e', 'queued', null, true), t('f', 'error', 200)], 100);
  assert.deepEqual({ done: s.done, running: s.running, queued: s.queued, waiting: s.waiting, failed: s.failed }, { done: 1, running: 1, queued: 1, waiting: 1, failed: 1 });
});
