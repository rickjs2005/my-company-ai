// Estúdio 3D (08/11): a planta tem caminho para todo lugar sem atravessar móvel, e o comportamento só representa estado real.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SceneWorker } from '../src/scene/types';
import { BOSS, DESKS, ENTRANCE, MEETING, APPROACH, buildGrid, cellOf, centerOf, findPath, lineFree, meetingSeat, walkable, zoneForKind, zoneAt } from '../src/studio/layout';
import { bossQueue, desiredFor } from '../src/studio/behavior';

const grid = buildGrid();
const reachable = (to: { x: number; z: number }) => {
  const path = findPath(grid, ENTRANCE, to);
  assert.ok(path.length > 0, `sem caminho até (${to.x.toFixed(2)}, ${to.z.toFixed(2)})`);
  // cada trecho do caminho passa só por chão livre (não atravessa mesa, vidro nem parede)
  const s0 = cellOf(ENTRANCE); let prev = centerOf(s0.cx, s0.cz); // o caminho parte do centro da célula de origem
  for (const p of path.slice(0, -1)) { assert.ok(lineFree(grid, prev, p), `trecho atravessa móvel perto de (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`); prev = p; }
  const last = path[path.length - 1];
  assert.ok(Math.hypot(last.x - to.x, last.z - to.z) < 0.01, 'termina no ponto pedido');
  return path;
};

test('toda mesa tem cadeira e chegada livres e caminho desde a recepção', () => {
  for (const d of DESKS) {
    for (const p of [d.seat, d.approach]) { const c = cellOf(p); assert.ok(walkable(grid, c.cx, c.cz), `mesa ${d.index}: ponto bloqueado`); }
    reachable(d.approach);
  }
});

test('mesa do Chefe: atendimento e quatro lugares de fila alcançáveis e distintos', () => {
  reachable(BOSS.attend);
  for (const q of BOSS.queue) reachable(q);
  const cells = new Set([BOSS.attend, ...BOSS.queue].map(p => { const c = cellOf(p); return `${c.cx},${c.cz}`; }));
  assert.equal(cells.size, 1 + BOSS.queue.length, 'ninguém fica em cima de ninguém na fila');
  // quem atende olha para o Chefe (de frente um para o outro)
  const diff = Math.abs(Math.atan2(Math.sin(BOSS.attend.facing - BOSS.seat.facing), Math.cos(BOSS.attend.facing - BOSS.seat.facing)));
  assert.ok(Math.abs(diff - Math.PI) < 0.01);
});

test('reunião: todas as cadeiras têm chegada alcançável; objetos interativos também', () => {
  for (let i = 0; i < MEETING.seats; i++) reachable(meetingSeat(i).approach);
  for (const p of Object.values(APPROACH)) reachable(p);
});

test('a grade bloqueia o tampo das mesas (ninguém anda por cima)', () => {
  for (const d of DESKS) { const c = cellOf({ x: d.x, z: d.z }); assert.equal(walkable(grid, c.cx, c.cz), false, `mesa ${d.index} livre no centro`); }
  const b = cellOf({ x: BOSS.x, z: BOSS.z }); assert.equal(walkable(grid, b.cx, b.cz), false);
});

test('salas do cadastro viram áreas do estúdio', () => {
  assert.equal(zoneForKind('social'), 'teams', 'a sala Social Media enquadra as duas mesas das equipes');
  assert.equal(zoneForKind('meeting'), 'meeting');
  assert.equal(zoneForKind('design'), 'studio');
  assert.equal(zoneForKind('direction'), 'boss');
  assert.equal(zoneAt({ x: BOSS.x, z: BOSS.z }), 'boss');
});

const w = (p: Partial<SceneWorker>): SceneWorker => ({ id: 'x', roomId: 'r', name: 'Nina Souza', role: 'Criação', phase: 'idle', detail: '', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0, controllable: true, status: 'idle', ...p });

test('sem execução real ninguém digita: disponível, na fila e em pausa ficam sentados', () => {
  for (const st of [{ status: 'idle' as const }, { status: 'queued' as const }, { status: 'paused' as const }, { status: 'interrupted' as const }]) {
    const d = desiredFor(w(st), 3, null);
    assert.equal(d.place, 'desk:3');
    assert.equal(d.activity, 'sit', JSON.stringify(st));
  }
  const paused = desiredFor(w({ status: 'paused' }), 3, null);
  assert.match(paused.bubble?.text ?? '', /pausa/);
  assert.equal(desiredFor(w({ status: 'idle' }), 3, null).bubble, null, 'livre não ganha balão');
});

test('trabalho real: escrevendo digita, pensando pensa; a tela mostra o detalhe real', () => {
  const d = desiredFor(w({ status: 'running', phase: 'writing', detail: 'Roteiro do Reel' }), 1, null);
  assert.equal(d.activity, 'type');
  assert.deepEqual(d.screen, { kind: 'work', name: 'Nina', text: 'Roteiro do Reel', tone: 'work' });
  assert.equal(desiredFor(w({ status: 'running', phase: 'thinking' }), 1, null).activity, 'think');
});

test('pergunta ou permissão: vai até a mesa do Chefe apresentar; reunião: vai para a cadeira dela', () => {
  const q = desiredFor(w({ status: 'waiting_answer', phase: 'waiting_answer' }), 2, null);
  assert.equal(q.place, 'boss'); assert.equal(q.activity, 'present'); assert.match(q.bossReason ?? '', /pergunta/);
  const p = desiredFor(w({ status: 'waiting_permission', phase: 'waiting_permission' }), 2, null);
  assert.equal(p.place, 'boss'); assert.match(p.bossReason ?? '', /permissão/);
  const m = desiredFor(w({ status: 'running', phase: 'responding' }), 2, { seat: 4, speaking: true });
  assert.equal(m.place, 'meeting:4'); assert.equal(m.activity, 'sitTalk');
  assert.equal(desiredFor(w({ observed: true, status: 'running', phase: 'writing' }), 2, null).bubble, null, 'sessão observada não ganha balão');
});

test('fila do chefe: quem pediu primeiro continua na frente; quem saiu libera a vaga', () => {
  let order = bossQueue([], new Set(['a']));
  order = bossQueue(order, new Set(['b', 'a']));
  assert.deepEqual(order, ['a', 'b']);
  order = bossQueue(order, new Set(['b', 'c']));
  assert.deepEqual(order, ['b', 'c']);
});
