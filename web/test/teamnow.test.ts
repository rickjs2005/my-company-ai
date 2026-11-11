// "Equipe agora" e conversa particular (08/11/2026): estado real de cada funcionário pelas tarefas (conversa particular não conta
// como trabalho), mensagens simples da conversa e o bloco ```pedido-hq separado da resposta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatItem, ContentState, Employee, Session, Task } from '@milweb-hq/protocol';
import { DM_SESSION_NAME } from '@milweb-hq/protocol';
import { dmMessages, dmStatus, splitRequest, teamNow, whatOf } from '../src/shell/social/teamNowBoard';
import { stepLine } from '../src/shell/social/TeamNow';

const emp = (id: string, name: string, role = 'Equipe'): Employee => ({ id, name, role, roomId: 'r', archivedAt: null } as unknown as Employee);
const task = (id: string, status: Task['status'], employeeId: string, o: Partial<Task> = {}): Task => ({ id, status, prompt: 'Rodada do Radar da gringa.', sessionId: 'work', projectId: 'p', roomId: 'r', clientId: id, attachments: [], mode: 'send', createdAt: 10, startedAt: status === 'running' ? 20 : null, finishedAt: null, employeeId, errors: [], ...o } as unknown as Task);
const sessions = [{ id: 'work', name: 'Trabalho' }, { id: 'dm', name: DM_SESSION_NAME }] as unknown as Session[];

test('Equipe agora: fazendo, esperando, na fila e livre pelas tarefas reais; conversa particular não conta como trabalho', () => {
  const content = { items: [{ id: 'i1', title: 'O que é uma API', taskId: 't-prod', reviewTaskId: null, pipeline: null }], rounds: [] } as unknown as ContentState;
  const rows = teamNow(
    [emp('a', 'Clara'), emp('b', 'Caio'), emp('c', 'Otto'), emp('d', 'Vítor')],
    [task('t-prod', 'running', 'a'), task('t2', 'queued', 'a'), task('t3', 'queued', 'b'), task('t4', 'waiting_permission', 'c'), task('t-dm', 'running', 'd', { sessionId: 'dm' })],
    sessions, content,
  );
  assert.deepEqual(rows.map(r => [r.name, r.state]), [['Clara', 'fazendo'], ['Otto', 'espera'], ['Caio', 'fila'], ['Vítor', 'livre']]);
  assert.equal(rows[0].what, 'produzindo "O que é uma API"'); assert.equal(rows[0].queued, 1);
  assert.equal(rows[2].what, 'Radar');
});

test('Equipe agora: quem está fazendo traz a conversa da tarefa (para o Ajustar) e o passo de agora; quem não está, não', () => {
  const ss = [{ id: 'work', name: 'Trabalho', activity: { phase: 'tool', detail: 'Escrevendo video.json' } }, { id: 'dm', name: DM_SESSION_NAME }] as unknown as Session[];
  const rows = teamNow([emp('a', 'Nina'), emp('b', 'Bia')], [task('t1', 'running', 'a'), task('t2', 'queued', 'b')], ss, null);
  assert.equal(rows[0].sessionId, 'work'); assert.equal(rows[0].detail, 'Escrevendo video.json');
  assert.equal(rows[1].sessionId, null); assert.equal(rows[1].detail, null);
  const idle = [{ id: 'work', name: 'Trabalho', activity: { phase: 'idle', detail: 'Disponível' } }] as unknown as Session[];
  assert.equal(teamNow([emp('a', 'Nina')], [task('t1', 'running', 'a')], idle, null)[0].detail, null, '"Disponível" não é passo');
});

test('o que cada tarefa é: etapa da peça e plano da gerente em palavras simples', () => {
  const content = {
    items: [{ id: 'i1', title: 'API com garçom', taskId: null, reviewTaskId: null, pipeline: { steps: [{ key: 'direcao', roundId: 'r1' }] } }],
    rounds: [{ id: 'r1', kind: 'etapa', taskId: 't1' }, { id: 'r2', kind: 'plano', taskId: 't2' }],
  } as unknown as ContentState;
  assert.equal(whatOf(task('t1', 'running', 'x'), content), 'direção de vídeo de "API com garçom"');
  assert.equal(whatOf(task('t2', 'running', 'x'), content), 'planejando o seu pedido');
});

test('conversa particular: mensagens do Chefe e do funcionário, ferramentas viram contagem, pedido separado do texto', () => {
  const items = [
    { id: '1', ts: 1, taskId: 'a', kind: 'user', text: 'faz um Reel estilo trailer', attachments: [] },
    { id: '2', ts: 2, taskId: 'a', kind: 'tool', toolUseId: 'x', name: 'Read', summary: '', input: {}, done: true },
    { id: '3', ts: 3, taskId: 'a', kind: 'assistant', text: 'Fechado.\n\n```pedido-hq\n{"pedido": "Reel estilo trailer do Olaria"}\n```' },
    { id: '4', ts: 4, taskId: 'a', kind: 'notice', text: 'só info', level: 'info' },
    { id: '5', ts: 5, taskId: 'b', kind: 'result', status: 'error', summary: 'limite de uso' },
  ] as ChatItem[];
  const m = dmMessages(items);
  assert.deepEqual(m.map(x => x.from), ['chefe', 'func', 'aviso']);
  assert.equal(m[1].text, 'Fechado.'); assert.equal(m[1].request, 'Reel estilo trailer do Olaria'); assert.equal(m[1].tools, 1);
  assert.match(m[2].text, /limite de uso/);
  assert.deepEqual(splitRequest('sem bloco'), { text: 'sem bloco', request: null });
  assert.equal(dmStatus([task('q', 'queued', 'v', { sessionId: 'dm' })], 'dm', 'Vítor'), 'Mensagem enviada: Vítor responde em instantes');
  assert.equal(dmStatus([task('q', 'running', 'v', { sessionId: 'dm' })], 'dm', 'Vítor'), 'Vítor está escrevendo…');
  assert.equal(dmStatus([], 'dm', 'Vítor'), null);
});

test('etapa da peça em uma linha: quem está fazendo, o que falhou, produção e revisão', () => {
  const base = { id: 'i', title: 'x', status: 'planejada', ownerId: 'c', review: null } as const;
  const p = (steps: unknown[], o: Record<string, unknown> = {}) => ({ ...base, ...o, pipeline: { steps, createdAt: 1 } }) as never;
  assert.equal(stepLine(p([{ key: 'roteiro', status: 'fazendo', employeeName: 'Nina' }]), []), 'Roteiro com Nina');
  assert.equal(stepLine(p([{ key: 'direcao', status: 'falhou' }]), []), 'Direção de vídeo não deu certo');
  assert.equal(stepLine(p([{ key: 'roteiro', status: 'feito' }], { status: 'em_producao' }), [emp('c', 'Clara')]), 'Produção com Clara');
});

test('peça na linha de produção: etapa rodando fica em "fazendo", etapa que falhou espera o Chefe, todas feitas volta ao normal', async () => {
  const { pieceColumn } = await import('../src/shell/social/pieceBoard');
  const it = (steps: unknown[]) => ({ id: 'i', status: 'planejada', pausedReason: null, taskId: null, reviewTaskId: null, review: null, pipeline: { steps, createdAt: 1 } }) as never;
  assert.equal(pieceColumn(it([{ key: 'roteiro', status: 'fazendo' }]), []), 'producao');
  assert.equal(pieceColumn(it([{ key: 'roteiro', status: 'feito' }, { key: 'direcao', status: 'pendente' }]), []), 'fila');
  assert.equal(pieceColumn(it([{ key: 'roteiro', status: 'falhou' }]), []), 'parcial');
  assert.equal(pieceColumn(it([{ key: 'roteiro', status: 'feito' }]), []), 'planejada');
});

test('trabalho solto: produção antiga de peça refeita não vira "entrega" mesmo com a skill no começo do pedido', async () => {
  const { looseWork } = await import('../src/shell/social/homeBoard');
  const t = { id: 'old', status: 'done', prompt: '/milweb-video-studio Produzir a peça "Versão própria"', sessionId: 's', createdAt: 1, finishedAt: Date.now(), errors: [], deliverables: [], origin: 'composer' } as unknown as Task;
  const w = looseWork([t], { items: [], rounds: [], hidden: [] } as unknown as ContentState);
  assert.equal(w.delivered.length, 0);
});

test('peça que o revisor pediu ajuste depois da rodada automática espera a decisão do Chefe (não "planejada")', () => {
  const it = { id: 'i', title: 'x', status: 'ajustar', ownerId: null, reviewTaskId: 'r', review: { verdict: 'ajustar' }, pipeline: { steps: [{ key: 'roteiro', status: 'feito' }], createdAt: 1 } } as never;
  assert.equal(stepLine(it, []), 'espera a sua decisão (o revisor pediu ajuste)');
});
