// Testes puros da cena v2: planta, caminho, sprites, poses, câmera (fitAll) e avatar (colisão, diagonal, posição
// segura). Rodar: node --import tsx --test test/scene.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRANCE, GRID_H, GRID_W, LOUNGE_SPOTS, MEETING_SLOT, PLAYER_START, ROOM_SLOTS, WORLD_H, WORLD_W, buildLayout, flood, getDeskPositions,
  getLoungeRect, getMeetingSeats, getMeetingTableRect, getRoomDoor, getRoomRect, getRoomSlot, inRect, roomCenterTile, slotAtTile, validateLayout,
  type Tile,
} from '../src/scene/layout';
import { findPath, nearestWalkable } from '../src/scene/pathfinding';
import {
  CHARACTER_KEYS, CHAR_H, CHAR_W, HAIR_COLORS, PALETTE, PLAYER_SHIRT_COLORS, SHIRT_COLORS, SKIN_COLORS, SIT_BODY_H, SPRITES, TILE, characterPalette,
  isValidChar, mirror,
} from '../src/scene/sprites';
import { ALL_PHASES, poseForPhase, phaseLabel } from '../src/scene/poses';
import { FIT_MARGIN, ZOOM_FIT_MIN, ZOOM_MAX, ZOOM_MIN, clampCameraTo, fitCameraFor, fitZoomFor, followCamera, usableRect, visibleWorldRect } from '../src/scene/camera';
import { PLAYER_SPEED, canStand, moveVector, safePlayerPosition, stepPlayer, tileOfPoint, tileToPlayerPos } from '../src/scene/player';
import type { WorkerPhase } from '@milweb-hq/protocol';

const KINDS = { 0: 'dev', 1: 'social', 2: 'design', 3: 'research', 4: 'management', 5: 'direction' } as const;
/** Os 7 kinds, com a sala de Reuniões no slot 6 (como o App passará). */
const KINDS7 = { ...KINDS, 6: 'meeting' } as const;
/** Slots de trabalho (0..5): a sala de Reuniões (6) não tem mesa, armário nem mural. */
const WORK_SLOTS = Array.from({ length: ROOM_SLOTS }, (_, s) => s).filter((s) => s !== MEETING_SLOT);

function assertPathOk(walkable: boolean[][], path: Tile[], from: Tile, to: Tile, what: string): void {
  assert.ok(path.length >= 1, `sem caminho até ${what}`);
  assert.deepEqual(path[0], from, `${what}: não começa na origem`);
  assert.deepEqual(path[path.length - 1], to, `${what}: não termina no destino`);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    assert.equal(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 1, `${what}: passo diagonal ou salto`);
    assert.ok(walkable[b.y][b.x], `${what}: passou por tile bloqueado (${b.x},${b.y})`);
  }
}

// ------------------------------------------------------------------------------------------------ planta
test('planta: salas dentro da grade, sem sobreposição, 4 mesas nos slots 0..5 e nenhuma na sala de Reuniões', () => {
  assert.equal(ROOM_SLOTS, 7);
  assert.equal(MEETING_SLOT, 6);
  for (let s = 0; s < ROOM_SLOTS; s++) {
    const r = getRoomRect(s);
    assert.ok(r.x >= 1 && r.y >= 1 && r.x + r.w < GRID_W && r.y + r.h < GRID_H, `slot ${s} fora da grade`);
    const desks = getDeskPositions(s);
    assert.equal(desks.length, s === MEETING_SLOT ? 0 : 4, `slot ${s}: número de mesas`);
    for (const d of desks) {
      assert.ok(d.desk.x >= r.x && d.desk.x + 1 < r.x + r.w && d.desk.y >= r.y && d.desk.y < r.y + r.h, `mesa fora da sala ${s}`);
      assert.ok(d.chair.x >= r.x && d.chair.x < r.x + r.w && d.chair.y >= r.y && d.chair.y < r.y + r.h, `cadeira fora da sala ${s}`);
    }
    for (let t = s + 1; t < ROOM_SLOTS; t++) {
      const o = getRoomRect(t);
      const overlap = r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h;
      assert.ok(!overlap, `salas ${s} e ${t} se sobrepõem`);
    }
    assert.equal(getRoomDoor(s).length, 2);
  }
});

test('planta v2: valida sem sobreposição, com portas livres, armário e mural em cada sala de trabalho', () => {
  // (a) todos os tipos (inclusive a diretoria no slot 5 e a reunião no 6), salas vazias e uma permutação
  assert.deepEqual(validateLayout(buildLayout(KINDS)), []);
  assert.deepEqual(validateLayout(buildLayout(KINDS7)), []);
  assert.deepEqual(validateLayout(buildLayout({})), []);
  assert.deepEqual(validateLayout(buildLayout({ 0: 'management', 1: 'dev', 2: 'social', 3: 'design', 4: 'research', 5: 'custom' })), []);
  assert.deepEqual(validateLayout(buildLayout({ 0: 'direction', 1: 'direction', 2: 'direction', 3: 'direction', 4: 'direction', 5: 'direction' })), []);
  const layout = buildLayout(KINDS);
  for (let s = 0; s < ROOM_SLOTS; s++) {
    const { side } = getRoomSlot(s);
    for (const d of getRoomDoor(s)) {
      assert.equal(layout.grid[d.y][d.x].kind, 'door');
      assert.ok(layout.walkable[d.y][d.x], `porta do slot ${s} bloqueada`);
      assert.ok(layout.walkable[d.y][side === 'left' ? d.x - 1 : d.x + 1], `lado de dentro da porta do slot ${s} bloqueado`);
      assert.ok(layout.walkable[d.y][side === 'left' ? d.x + 1 : d.x - 1], `lado de fora da porta do slot ${s} bloqueado`);
    }
  }
  for (const s of WORK_SLOTS) {
    const props = layout.props.filter((p) => p.slot === s);
    assert.ok(props.some((p) => p.interact?.kind === 'cabinet'), `slot ${s} sem armário/estante interativo`);
    assert.ok(props.some((p) => p.interact?.kind === 'board'), `slot ${s} sem mural/quadro interativo`);
    assert.equal(props.filter((p) => p.interact?.kind === 'desk').length, 4, `slot ${s} sem 4 mesas interativas`);
  }
  assert.ok(layout.props.some((p) => p.interact?.kind === 'reception'), 'sem balcão da recepção');
  assert.ok(layout.props.some((p) => p.sprite === 'sign'), 'sem placa MILWEB');
  assert.ok(layout.props.some((p) => p.sprite === 'coffee'), 'sem máquina de café');
  assert.ok(layout.props.some((p) => p.sprite === 'cat'), 'sem gato decorativo');
  // mobiliário próprio de cada tipo
  const sprites = (s: number) => new Set(layout.props.filter((p) => p.slot === s).map((p) => p.sprite));
  assert.ok(sprites(0).has('board.white') && sprites(0).has('shelf.tech') && layout.rooms[0].dualMonitors, 'dev sem quadro branco/estante/monitores duplos');
  assert.ok(sprites(1).has('tripod.camera') && sprites(1).has('ring.light') && sprites(1).has('board.content') && sprites(1).has('backdrop'), 'social sem câmera/ring light/mural/fundo');
  assert.ok(layout.rooms[2].deskSprite === 'desk.tablet' && sprites(2).has('station.edit') && sprites(2).has('shelf.gear'), 'design sem mesa digitalizadora/estação/prateleira');
  assert.ok(sprites(3).has('board.map') && sprites(3).has('board.plan') && sprites(3).has('cabinet.archive') && layout.rooms[3].deskSprite === 'desk.research', 'pesquisa sem mapa/planejamento/arquivo/lupa');
  assert.ok(sprites(4).has('table.meeting') && sprites(4).has('board.kanban') && sprites(4).has('shelf.books'), 'gestão sem mesa de reunião/kanban/estante');
  assert.ok(sprites(5).has('desk.exec') && sprites(5).has('armchair') && sprites(5).has('shelf.exec') && sprites(5).has('frame.art'), 'diretoria sem mesa executiva/poltrona/estante/quadro');
});

// ------------------------------------------------------------------------------------------------ sala de Reuniões
test('reunião: slot 6 fixo à direita da convivência, porta na parede esquerda (x 33) e sempre mobiliado como meeting', () => {
  const slot = getRoomSlot(MEETING_SLOT);
  assert.deepEqual(slot.rect, { x: 34, y: 31, w: 19, h: 8 });
  assert.deepEqual(getRoomDoor(MEETING_SLOT), [{ x: 33, y: 34 }, { x: 33, y: 35 }]);
  assert.deepEqual(getDeskPositions(MEETING_SLOT), []);
  const lounge = getLoungeRect();
  assert.deepEqual(lounge, { x: 1, y: 31, w: 32, h: 8 });
  assert.ok(lounge.x + lounge.w < slot.rect.x, 'convivência invade a sala de Reuniões');
  // mobiliada como 'meeting' mesmo quando o banco não tem a sala (kind vazio) ou pede outro tipo
  for (const requested of ['empty', 'dev', 'meeting'] as const) {
    const room = buildLayout(requested === 'empty' ? {} : { [MEETING_SLOT]: requested }).rooms[MEETING_SLOT];
    assert.equal(room.kind, 'meeting', `slot 6 pedido como ${requested} não virou meeting`);
    const props = room.props;
    assert.ok(props.some((p) => p.sprite === 'table.conference' && p.interact?.kind === 'meeting'), 'sem mesa de reunião interativa');
    assert.ok(props.filter((p) => p.sprite === 'chair.seat').length >= 4, 'menos de 4 cadeiras');
    assert.ok(props.some((p) => p.sprite.startsWith('board.')), 'sem tela/quadro na parede');
    assert.ok(props.some((p) => p.sprite.startsWith('lamp.')), 'sem luminária');
    assert.ok(props.some((p) => p.sprite.startsWith('plant.')), 'sem planta');
    assert.ok(room.lights.length >= 1, 'sem luz própria');
    assert.equal(props.filter((p) => p.interact?.kind === 'desk').length, 0, 'sala de reunião com mesa de trabalho');
    for (const p of props) assert.ok(inRect({ ...slot.rect, y: slot.rect.y - 1, h: slot.rect.h + 1 }, p.tile), `${p.sprite} fora da sala de Reuniões`);
  }
});

test('reunião: a porta funciona (flood a partir de PLAYER_START entra na sala) e slotAtTile devolve 6 lá dentro', () => {
  const layout = buildLayout(KINDS7);
  const reach = flood(layout.walkable, PLAYER_START);
  const center = roomCenterTile(MEETING_SLOT);
  assert.ok(reach[center.y][center.x], `centro da sala de Reuniões (${center.x},${center.y}) inalcançável`);
  for (const d of getRoomDoor(MEETING_SLOT)) {
    assert.ok(reach[d.y][d.x], `porta (${d.x},${d.y}) inalcançável`);
    assert.ok(reach[d.y][d.x + 1], 'lado de dentro da porta inalcançável');
    assert.ok(reach[d.y][d.x - 1], 'lado de fora (convivência) inalcançável');
  }
  const path = findPath(layout.walkable, PLAYER_START, center);
  assertPathOk(layout.walkable, path, PLAYER_START, center, 'centro da sala de Reuniões');
  assert.ok(path.some((t) => t.x === 33 && (t.y === 34 || t.y === 35)), 'caminho não passa pela porta da sala de Reuniões');
  // slotAtTile: dentro da sala é 6; na porta, na convivência e na parede é -1
  assert.equal(slotAtTile(layout.grid, center), MEETING_SLOT);
  assert.equal(slotAtTile(layout.grid, { x: 34, y: 31 }), MEETING_SLOT);
  assert.equal(slotAtTile(layout.grid, { x: 52, y: 38 }), MEETING_SLOT);
  assert.equal(slotAtTile(layout.grid, { x: 33, y: 34 }), -1);
  assert.equal(slotAtTile(layout.grid, { x: 20, y: 34 }), -1);
  assert.equal(slotAtTile(layout.grid, { x: 33, y: 31 }), -1);
  assert.equal(layout.grid[33][33].kind, 'wall');
});

test('reunião: 9 assentos distintos ao redor da mesa, cada um alcançável pelo ator (só o próprio assento é liberado)', () => {
  const layout = buildLayout(KINDS7);
  const seats = getMeetingSeats();
  const table = getMeetingTableRect();
  const rect = getRoomRect(MEETING_SLOT);
  assert.equal(seats.length, 9);
  assert.equal(new Set(seats.map((s) => `${s.tile.x},${s.tile.y}`)).size, 9, 'assentos repetidos');
  const door = getRoomDoor(MEETING_SLOT)[0];
  for (const [i, s] of seats.entries()) {
    assert.ok(inRect(rect, s.tile), `assento ${i} fora da sala`);
    assert.ok(!inRect(table, s.tile), `assento ${i} em cima da mesa`);
    assert.ok(!layout.walkable[s.tile.y][s.tile.x], `assento ${i}: a cadeira devia bloquear o passo`);
    // a mesa é vizinha do assento (o ator senta encostado nela)
    const near = s.tile.x >= table.x - 1 && s.tile.x <= table.x + table.w && s.tile.y >= table.y - 1 && s.tile.y <= table.y + table.h;
    assert.ok(near, `assento ${i} longe da mesa`);
    const walk = layout.walkable.map((r) => r.slice());
    walk[s.tile.y][s.tile.x] = true;
    assertPathOk(walk, findPath(walk, door, s.tile), door, s.tile, `assento ${i} da reunião`);
  }
  for (let y = table.y; y < table.y + table.h; y++) for (let x = table.x; x < table.x + table.w; x++) assert.ok(!layout.walkable[y][x], `mesa não bloqueia (${x},${y})`);
});

test('reunião: todos os props da convivência ficam dentro do retângulo novo (x 1..32)', () => {
  const layout = buildLayout(KINDS7);
  const lounge = getLoungeRect();
  const loungeProps = layout.props.filter((p) => p.slot === -1 && p.tile.y >= lounge.y);
  assert.ok(loungeProps.length >= 8, 'convivência quase vazia');
  for (const p of loungeProps) {
    for (let y = 0; y < Math.max(1, p.blockH); y++) for (let x = 0; x < Math.max(1, p.blockW); x++) {
      const t = { x: p.tile.x + x, y: p.tile.y - y };
      assert.ok(inRect(lounge, t), `${p.sprite} em (${t.x},${t.y}) fora da convivência`);
    }
  }
  assert.ok(loungeProps.some((p) => p.sprite === 'coffee'), 'café saiu da convivência');
  assert.ok(loungeProps.some((p) => p.sprite === 'sofa'), 'sofá saiu da convivência');
  assert.ok(loungeProps.some((p) => p.sprite === 'lamp.floor'), 'luminária de pé saiu da convivência');
  assert.ok(loungeProps.filter((p) => p.sprite.startsWith('plant.')).length >= 3, 'convivência com menos de 3 plantas');
  // o caminho até cada lugar em pé continua livre com a planta nova
  for (const spot of LOUNGE_SPOTS) assert.ok(findPath(layout.walkable, ENTRANCE, spot).length > 1, `lugar (${spot.x},${spot.y}) inalcançável`);
});

test('planta: validador acusa mesa bloqueada e porta bloqueada', () => {
  const layout = buildLayout(KINDS);
  const chair = getDeskPositions(0)[0].chair;
  layout.walkable[chair.y][chair.x] = false;
  assert.ok(validateLayout(layout).some((e) => e.includes('slot 0 mesa 0')));
  const l2 = buildLayout(KINDS);
  const door = getRoomDoor(1)[0];
  l2.walkable[door.y][door.x] = false;
  assert.ok(validateLayout(l2).some((e) => e.includes('porta')), 'porta bloqueada não acusada');
});

// ------------------------------------------------------------------------------------------------ caminho
test('caminho: da entrada até cada cadeira, só por tiles livres, em passos de 1 e pela porta', () => {
  const layout = buildLayout(KINDS);
  for (let s = 0; s < ROOM_SLOTS; s++) {
    for (const d of getDeskPositions(s)) {
      const path = findPath(layout.walkable, ENTRANCE, d.chair);
      assertPathOk(layout.walkable, path, ENTRANCE, d.chair, `cadeira do slot ${s}`);
      const door = getRoomDoor(s);
      assert.ok(path.some((t) => door.some((dt) => dt.x === t.x && dt.y === t.y)), `caminho para slot ${s} não passa pela porta`);
    }
  }
  for (const spot of LOUNGE_SPOTS) assert.ok(findPath(layout.walkable, ENTRANCE, spot).length > 1);
});

test('caminho (b): da recepção até o centro de cada uma das 6 salas e até cada cadeira', () => {
  const layout = buildLayout(KINDS);
  // o avatar não pisa em cadeiras (só o destino libera a própria cadeira)
  const walk = layout.walkable.map((r) => r.slice());
  for (let s = 0; s < ROOM_SLOTS; s++) for (const d of getDeskPositions(s)) walk[d.chair.y][d.chair.x] = false;
  assert.ok(walk[PLAYER_START.y][PLAYER_START.x], 'ponto seguro bloqueado');
  for (let s = 0; s < ROOM_SLOTS; s++) {
    const center = roomCenterTile(s);
    const r = getRoomRect(s);
    assert.ok(center.x >= r.x && center.x < r.x + r.w && center.y >= r.y && center.y < r.y + r.h);
    assertPathOk(walk, findPath(walk, PLAYER_START, center), PLAYER_START, center, `centro do slot ${s}`);
    for (const d of getDeskPositions(s)) {
      const g = walk.map((row) => row.slice());
      g[d.chair.y][d.chair.x] = true;
      assertPathOk(g, findPath(g, PLAYER_START, d.chair), PLAYER_START, d.chair, `cadeira (${d.chair.x},${d.chair.y}) do slot ${s}`);
    }
  }
});

test('caminho: respeita paredes e devolve vazio quando não há passagem', () => {
  const grid: boolean[][] = [
    [true, true, true, true],
    [false, false, false, true],
    [true, true, true, true],
    [true, false, false, false],
  ];
  const path = findPath(grid, { x: 0, y: 0 }, { x: 0, y: 2 });
  assert.deepEqual(path, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1 }, { x: 3, y: 2 }, { x: 2, y: 2 }, { x: 1, y: 2 }, { x: 0, y: 2 }]);
  assert.deepEqual(findPath(grid, { x: 0, y: 0 }, { x: 0, y: 3 }).length, 9 + 1);
  assert.deepEqual(findPath(grid, { x: 0, y: 0 }, { x: 1, y: 1 }), []); // destino é parede
  assert.deepEqual(findPath(grid, { x: 0, y: 0 }, { x: 9, y: 9 }), []); // fora da grade
  assert.deepEqual(findPath(grid, { x: 2, y: 0 }, { x: 2, y: 0 }), [{ x: 2, y: 0 }]);
  const isolated: boolean[][] = [[true, false, true]];
  assert.deepEqual(findPath(isolated, { x: 0, y: 0 }, { x: 2, y: 0 }), []);
  assert.deepEqual(nearestWalkable(grid, { x: 1, y: 1 }), { x: 1, y: 0 });
});

// ------------------------------------------------------------------------------------------------ avatar
test('avatar (c): tentar atravessar uma parede não muda de tile; deslizar ao longo dela ainda anda', () => {
  const layout = buildLayout(KINDS);
  const walk = layout.walkable;
  // topo do corredor: (26,1) é piso e (26,0) é parede
  const start = tileToPlayerPos({ x: 26, y: 1 });
  assert.ok(canStand(walk, start));
  let pos = start;
  for (let i = 0; i < 90; i++) pos = stepPlayer(pos, { x: 0, y: -1 }, 16, walk).pos;
  assert.deepEqual(tileOfPoint(pos), { x: 26, y: 1 }, 'atravessou a parede de cima');
  assert.ok(canStand(walk, pos));
  // encostado na parede, empurrando em diagonal para cima e para a esquerda: desliza para a esquerda
  let p2 = pos;
  for (let i = 0; i < 30; i++) p2 = stepPlayer(p2, moveVector({ up: true, down: false, left: true, right: false }), 16, walk).pos;
  assert.ok(p2.x < pos.x - 20, 'não deslizou ao longo da parede');
  assert.equal(tileOfPoint(p2).y, 1);
  // parede lateral: na coluna 21 do corredor, (20,y) é parede (fora da porta)
  const side = tileToPlayerPos({ x: 21, y: 2 });
  let p3 = side;
  for (let i = 0; i < 90; i++) p3 = stepPlayer(p3, { x: -1, y: 0 }, 16, walk).pos;
  assert.equal(tileOfPoint(p3).x, 21, 'atravessou a parede lateral');
  // quadro longo (dt grande) também não atravessa
  const p4 = stepPlayer(start, { x: 0, y: -1 }, 500, walk).pos;
  assert.deepEqual(tileOfPoint(p4), { x: 26, y: 1 });
  // porta é passagem: do corredor (26,30) para a convivência (26,31)
  let p5 = tileToPlayerPos({ x: 26, y: 29 });
  for (let i = 0; i < 60; i++) p5 = stepPlayer(p5, { x: 0, y: 1 }, 16, walk).pos;
  assert.ok(tileOfPoint(p5).y >= 31, 'não passou pela porta da convivência');
});

test('avatar (e): diagonal normalizada, velocidade igual em módulo e independente do frame', () => {
  const d = moveVector({ up: true, down: false, left: false, right: true });
  assert.ok(Math.abs(Math.hypot(d.x, d.y) - 1) < 1e-9);
  assert.ok(Math.abs(d.x - Math.SQRT1_2) < 1e-9 && Math.abs(d.y + Math.SQRT1_2) < 1e-9);
  assert.deepEqual(moveVector({ up: true, down: true, left: false, right: false }), { x: 0, y: 0 });
  assert.deepEqual(moveVector({ up: false, down: false, left: false, right: false }), { x: 0, y: 0 });
  // chão aberto: a convivência (sem obstáculos no meio)
  const open: boolean[][] = Array.from({ length: GRID_H }, () => Array.from({ length: GRID_W }, () => true));
  const start = tileToPlayerPos({ x: 20, y: 20 });
  const straight = stepPlayer(start, { x: 1, y: 0 }, 1000, open).pos;
  const diag = stepPlayer(start, moveVector({ up: false, down: true, left: false, right: true }), 1000, open).pos;
  const ds = Math.hypot(straight.x - start.x, straight.y - start.y);
  const dd = Math.hypot(diag.x - start.x, diag.y - start.y);
  assert.ok(Math.abs(ds - PLAYER_SPEED) < 0.5, `reto andou ${ds}`);
  assert.ok(Math.abs(dd - PLAYER_SPEED) < 0.5, `diagonal andou ${dd}`);
  // 10 quadros de 100 ms = 1 quadro de 1000 ms
  let p = start;
  for (let i = 0; i < 10; i++) p = stepPlayer(p, { x: 1, y: 0 }, 100, open).pos;
  assert.ok(Math.abs(p.x - straight.x) < 1e-6);
});

test('avatar (f): setPlayerPosition com tile bloqueado cai no ponto seguro (recepção)', () => {
  const layout = buildLayout(KINDS);
  const safe = tileToPlayerPos(PLAYER_START);
  assert.deepEqual(safePlayerPosition({ x: 8, y: 8 }, layout.walkable, PLAYER_START), safe); // parede externa
  assert.deepEqual(safePlayerPosition({ x: -50, y: 10 }, layout.walkable, PLAYER_START), safe); // fora da grade
  assert.deepEqual(safePlayerPosition({ x: Number.NaN, y: 10 }, layout.walkable, PLAYER_START), safe);
  assert.deepEqual(safePlayerPosition(null, layout.walkable, PLAYER_START), safe);
  const shelf = layout.props.find((p) => p.slot === 0 && p.interact?.kind === 'cabinet')!;
  const onShelf = tileToPlayerPos(shelf.tile);
  assert.deepEqual(safePlayerPosition(onShelf, layout.walkable, PLAYER_START), safe); // em cima de móvel
  const ok = tileToPlayerPos({ x: 26, y: 10 });
  assert.deepEqual(safePlayerPosition(ok, layout.walkable, PLAYER_START), ok); // tile livre é mantido
  assert.ok(canStand(layout.walkable, safe));
});

// ------------------------------------------------------------------------------------------------ câmera
test('câmera (d): fitAll escolhe o maior zoom que cabe e enquadra a planta inteira com margem', () => {
  const cases: [number, number, { left: number; right: number; top: number; bottom: number }][] = [
    [1920, 1080, { left: 0, right: 420, top: 0, bottom: 0 }],
    [1366, 768, { left: 0, right: 420, top: 0, bottom: 0 }],
    [1920, 1080, { left: 0, right: 0, top: 0, bottom: 0 }],
    [3840, 2160, { left: 0, right: 420, top: 0, bottom: 0 }],
    [800, 600, { left: 0, right: 0, top: 0, bottom: 0 }], // nem o zoom 1 cabe: centraliza
  ];
  const fullW = WORLD_W + FIT_MARGIN * 2;
  const fullH = WORLD_H + FIT_MARGIN * 2;
  for (const [vw, vh, ins] of cases) {
    const z = fitZoomFor(vw, vh, ins);
    const u = usableRect(vw, vh, ins);
    assert.ok(z >= ZOOM_FIT_MIN && z <= ZOOM_MAX);
    assert.ok(z >= 1 ? Number.isInteger(z * 4) : Number.isInteger(z * 16), `${vw}x${vh}: zoom ${z} fora dos passos (1/4 acima de 1, 1/16 abaixo)`);
    const fits = (zz: number) => fullW * zz <= u.w && fullH * zz <= u.h;
    if (fits(ZOOM_FIT_MIN)) {
      assert.ok(fits(z), `${vw}x${vh}: zoom ${z} não cabe`);
      const step = z >= 1 ? 0.25 : 1 / 16;
      if (z < ZOOM_MAX) assert.ok(!fits(z + step), `${vw}x${vh}: zoom ${z + step} caberia`);
      const cam = clampCameraTo(fitCameraFor(vw, vh, ins, z), z, vw, vh, ins);
      const view = visibleWorldRect(cam, z, vw, vh, ins);
      assert.ok(view.x <= -FIT_MARGIN + 1e-6 && view.y <= -FIT_MARGIN + 1e-6, `${vw}x${vh}: corta a margem de cima/esquerda (${view.x},${view.y})`);
      assert.ok(view.x + view.w >= WORLD_W + FIT_MARGIN - 1e-6 && view.y + view.h >= WORLD_H + FIT_MARGIN - 1e-6, `${vw}x${vh}: corta a margem de baixo/direita`);
      // centralizada na área útil
      assert.ok(Math.abs((view.x + view.w / 2) - WORLD_W / 2) < 1 && Math.abs((view.y + view.h / 2) - WORLD_H / 2) < 1);
    } else {
      assert.equal(z, ZOOM_FIT_MIN);
      const cam = clampCameraTo(fitCameraFor(vw, vh, ins, z), z, vw, vh, ins);
      const view = visibleWorldRect(cam, z, vw, vh, ins);
      assert.ok(Math.abs((view.x + view.w / 2) - WORLD_W / 2) < 1 || view.w >= fullW);
    }
  }
  // Área real da cena medida no navegador (1366×768: ~1296×553 com cabeçalho e compositor; 1920×1080: ~1850×880).
  const small = fitZoomFor(1296, 553);
  assert.ok(small < 1 && fullH * small <= 553 && fullW * small <= 1296, `1366×768: a planta inteira cabe (zoom ${small})`);
  const big = fitZoomFor(1850, 880);
  assert.ok(big > 1, `1920×1080: personagens maiores que no zoom 1 (zoom ${big})`);
  assert.ok(ZOOM_MIN === 1, 'zoom manual continua inteiro');
});

test('câmera: clamp respeita a margem e o follow só move fora da zona morta', () => {
  const ins = { left: 0, right: 0, top: 0, bottom: 0 };
  const c = clampCameraTo({ x: -999, y: -999 }, 3, 800, 600, ins);
  assert.ok(c.x >= -FIT_MARGIN - 1e-6 && c.y >= -FIT_MARGIN - 1e-6);
  const c2 = clampCameraTo({ x: 9999, y: 9999 }, 3, 800, 600, ins);
  assert.ok(c2.x + 800 / 3 <= WORLD_W + FIT_MARGIN + 1e-6 && c2.y + 600 / 3 <= WORLD_H + FIT_MARGIN + 1e-6);
  const cam = { x: 100, y: 100 };
  const center = { x: 100 + 400 / 2, y: 100 + 300 / 2 }; // zoom 2, 800x600 → área 400x300 do mundo
  assert.deepEqual(followCamera(cam, center, 2, 800, 600, ins), cam);
  assert.deepEqual(followCamera(cam, { x: center.x + 20, y: center.y }, 2, 800, 600, ins), cam); // dentro da zona morta (30% de 400 = 120 → ±60)
  const moved = followCamera(cam, { x: center.x + 100, y: center.y }, 2, 800, 600, ins);
  assert.ok(moved.x > cam.x && moved.y === cam.y);
});

// ------------------------------------------------------------------------------------------------ sprites e poses
test('sprites: linhas da mesma largura, caracteres na paleta, tamanhos esperados (personagem 20x28)', () => {
  const names = Object.keys(SPRITES);
  assert.ok(names.length > 60);
  for (const name of names) {
    const m = SPRITES[name];
    assert.ok(m.length > 0, `${name} vazio`);
    const w = m[0].length;
    assert.ok(w > 0, `${name} sem largura`);
    m.forEach((row, i) => {
      assert.equal(row.length, w, `${name} linha ${i} tem largura ${row.length} (esperado ${w})`);
      for (const ch of row) assert.ok(isValidChar(ch), `${name} usa caractere fora da paleta: '${ch}'`);
    });
  }
  for (let v = 0; v < 3; v++) {
    assert.equal(SPRITES[`floor.wood.${v}`].length, TILE);
    assert.equal(SPRITES[`floor.carpet.${v}`].length, TILE);
    assert.equal(SPRITES[`floor.tile.${v}`].length, TILE);
    assert.equal(SPRITES[`floor.wood.${v}`][0].length, TILE);
  }
  assert.equal(SPRITES['wall.top'].length, TILE);
  assert.equal(SPRITES['wall.face'].length, TILE);
  // personagem 20x28: cabeça 12 + corpo 16; sentado 9 linhas
  assert.equal(CHAR_W, 20);
  assert.equal(CHAR_H, 28);
  for (const h of ['c.head.down', 'c.head.up', 'c.head.side']) assert.equal(SPRITES[h][0].length, CHAR_W);
  assert.equal(SPRITES['c.head.down'].length + SPRITES['c.body.stand.front'].length, CHAR_H);
  assert.equal(SPRITES['c.head.side'].length + SPRITES['c.body.walk.side.0'].length, CHAR_H);
  for (const b of ['c.body.sit', 'c.body.sit.type0', 'c.body.sit.type1', 'c.body.sit.armup', 'c.body.sit.stretch']) assert.equal(SPRITES[b].length, SIT_BODY_H);
  for (const req of ['desk', 'desk.tablet', 'desk.research', 'desk.exec', 'monitor.off', 'monitor.on', 'monitor.exec0', 'monitor.exec1', 'chair.seat', 'chair.back', 'armchair',
    'shelf.books', 'shelf.tech', 'shelf.gear', 'shelf.media', 'shelf.exec', 'cabinet.archive', 'rack.server', 'plant.a', 'plant.b', 'lamp.floor', 'lamp.ceiling', 'coffee', 'sofa',
    'reception.counter', 'sign', 'rug', 'board.white', 'board.content', 'board.mood', 'board.map', 'board.plan', 'board.kanban', 'frame.art', 'tripod.camera', 'ring.light', 'backdrop',
    'station.edit', 'table.meeting', 'cat', 'bubble.permission', 'bubble.question', 'bubble.done', 'bubble.error', 'bubble.disconnected', 'icon.eye', 'icon.key.e',
    'c.body.walk.front.0', 'c.body.walk.side.1', 'c.body.sit.type0', 'c.body.sit.type1', 'c.body.sit.armup']) {
    assert.ok(SPRITES[req], `sprite obrigatório ausente: ${req}`);
  }
  // caracteres dinâmicos só aparecem em sprites de personagem
  for (const name of names) {
    if (name.startsWith('c.')) continue;
    for (const row of SPRITES[name]) for (const ch of row) assert.ok(!(CHARACTER_KEYS as readonly string[]).includes(ch) || ch in PALETTE, `${name} usa caractere de personagem '${ch}'`);
  }
  assert.deepEqual(mirror(['ab.', '..c']), ['.ba', 'c..']);
});

test('sprites: 4 opções de pele, cabelo e camisa; avatar com camisa escura e detalhe âmbar; fantasma esmaecido', () => {
  assert.equal(SKIN_COLORS.length, 4);
  assert.equal(HAIR_COLORS.length, 4);
  assert.equal(SHIRT_COLORS.length, 4);
  assert.equal(PLAYER_SHIRT_COLORS.length, 4);
  const p = characterPalette({ skin: 1, hair: 2, shirt: 3 });
  assert.equal(p.S, SKIN_COLORS[1][0]);
  assert.equal(p.H, HAIR_COLORS[2][0]);
  assert.equal(p.T, SHIRT_COLORS[3][0]);
  assert.equal(characterPalette({ skin: 5, hair: -1, shirt: 8 }).S, SKIN_COLORS[1][0]); // índice fora do intervalo dá a volta
  const ghost = characterPalette({ skin: 0, hair: 0, shirt: 0 }, true);
  assert.notEqual(ghost.S, p.S);
  for (const k of CHARACTER_KEYS) assert.ok(ghost[k], `fantasma sem cor para ${k}`);
  for (let i = 0; i < 4; i++) {
    const me = characterPalette({ skin: 0, hair: 0, shirt: i }, false, true);
    assert.equal(me.T, PLAYER_SHIRT_COLORS[i][0]);
    assert.ok(!SHIRT_COLORS.some(([c]) => c === me.T), 'camisa do avatar igual à de funcionário');
    assert.ok(['#f0a830', '#ffd27a'].includes(me.t), 'avatar sem detalhe âmbar');
  }
});

test('poses: toda fase de WorkerPhase tem pose, bolha certa e rótulo em português', () => {
  const expected: WorkerPhase[] = ['idle', 'thinking', 'responding', 'reading', 'writing', 'executing', 'delegating', 'waiting_permission', 'waiting_answer', 'done', 'error', 'disconnected'];
  assert.deepEqual([...ALL_PHASES].sort(), [...expected].sort());
  for (const ph of expected) {
    const pose = poseForPhase(ph);
    assert.ok(['sit', 'type', 'read', 'wait'].includes(pose.body), `${ph}: corpo inválido`);
    assert.ok(['off', 'on', 'exec'].includes(pose.monitor), `${ph}: monitor inválido`);
    if (pose.bubble) assert.ok(SPRITES[`bubble.${pose.bubble}`], `${ph}: bolha sem sprite`);
    assert.notEqual(phaseLabel(ph), ph);
  }
  assert.equal(poseForPhase('waiting_permission').bubble, 'permission');
  assert.equal(poseForPhase('waiting_answer').bubble, 'question');
  assert.equal(poseForPhase('done').bubble, 'done');
  assert.equal(poseForPhase('error').bubble, 'error');
  assert.equal(poseForPhase('disconnected').bubble, 'disconnected');
  assert.equal(poseForPhase('disconnected').ghost, true);
  assert.equal(poseForPhase('disconnected').monitor, 'off');
  assert.equal(poseForPhase('executing').monitor, 'exec');
  assert.equal(poseForPhase('writing').body, 'type');
  assert.equal(poseForPhase('reading').body, 'read');
  assert.equal(poseForPhase('idle').idle, true);
  assert.equal(poseForPhase('writing').idle, false);
});
