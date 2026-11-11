// Planta v3 do escritório em grade de tiles de 16 px. Funções puras (sem DOM) para que o layout seja testável.
// Grade 54x40: corredor central vertical (12 tiles), três pares de salas 19x9 (slots 0..5), recepção no fim do
// corredor (parede com a placa MILWEB e balcão), convivência embaixo à esquerda e a sala de Reuniões (slot 6,
// fixa na planta) embaixo à direita, com porta para a convivência. A geometria daqui é a fonte única para
// desenho, colisão e caminhos (buildWalkable a partir dos props).

import type { RoomKind } from '@milweb-hq/protocol';
import { TILE } from './sprites';

export const GRID_W = 54;
export const GRID_H = 40;
export const WORLD_W = GRID_W * TILE;
export const WORLD_H = GRID_H * TILE;
export const ROOM_SLOTS = 7;
/** Slot da sala de Reuniões (sempre mobiliada como 'meeting', exista ou não a sala no banco). */
export const MEETING_SLOT = 6;
/** Cor e rótulo usados quando o banco não tem uma sala de kind 'meeting' no slot 6. */
export const MEETING_COLOR = '#5fb8a8';
export const MEETING_LABEL = 'Reuniões';

export interface Tile { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface DeskPosition {
  /** Tile da esquerda do tampo (a mesa ocupa 2 tiles). */
  desk: Tile;
  /** Tile da cadeira (onde o personagem senta). */
  chair: Tile;
}

/** O que um objeto faz quando o avatar interage com ele (tecla E ou clique). */
export type PropInteract =
  | { kind: 'cabinet' }
  | { kind: 'shelf' }
  | { kind: 'computer' }
  | { kind: 'board' }
  | { kind: 'reception' }
  | { kind: 'meeting' }
  | { kind: 'desk'; deskIndex: number };

export type Facing = 'up' | 'down' | 'left' | 'right';

/** Assento da mesa de reunião: tile da cadeira e para onde o ator sentado olha. */
export interface MeetingSeat { tile: Tile; face: Facing }

/** Objeto da planta (móvel, equipamento, quadro, planta). */
export interface Prop {
  sprite: string;
  /** Tile base (canto inferior esquerdo do objeto). */
  tile: Tile;
  /** Largura em tiles ocupada (bloqueia caminhada). 0 = não bloqueia (ex.: objeto na parede, tapete). */
  blockW: number;
  blockH: number;
  /** Deslocamento em px do sprite em relação ao tile base (padrão: alinhado pela base). */
  dx?: number;
  dy?: number;
  /** true = desenhado na camada estática (nunca sobreposto por personagens). */
  flat?: boolean;
  /** Slot da sala a que pertence (-1 = áreas comuns). */
  slot?: number;
  /** Interação possível e os tiles que contam como "ao alcance" (adjacentes a este retângulo). */
  interact?: PropInteract;
  hit?: Rect;
}

export interface Light {
  x: number; y: number; // centro em px do mundo
  radius: number;
  color: string;
  /** 0..1 */
  strength: number;
}

export interface RoomSlotLayout {
  slot: number;
  /** Interior (sem paredes), em tiles. */
  rect: Rect;
  door: Tile;
  /** Lado do corredor em relação à sala. */
  side: 'left' | 'right';
}

// ---------------------------------------------------------------------------------------------
// Geometria fixa
// ---------------------------------------------------------------------------------------------
const ROOM_W = 19;
const ROOM_H = 9;
const HALL_X0 = 21;
const HALL_X1 = 32;
const LEFT_X = 1;
const RIGHT_X = 34;
const ROW_Y = [1, 11, 21];
const LOUNGE: Rect = { x: 1, y: 31, w: 32, h: 8 };
/** Sala de Reuniões: parte direita do térreo, porta na parede esquerda (x 33) que dá para a convivência. */
const MEETING_RECT: Rect = { x: 34, y: 31, w: 19, h: 8 };
const RECEPTION: Rect = { x: HALL_X0, y: 21, w: HALL_X1 - HALL_X0 + 1, h: 9 };
const HALL: Rect = { x: HALL_X0, y: 1, w: HALL_X1 - HALL_X0 + 1, h: 29 };
/** Parede curta no meio da recepção, onde fica a placa MILWEB (2 tiles de altura: topo + face). */
const SIGN_WALL: Rect = { x: 24, y: 23, w: 6, h: 2 };

/** Tile da porta de entrada (na parede de baixo). Personagens surgem e saem por aqui. */
export const ENTRANCE: Tile = { x: 26, y: 39 };
export const ENTRANCE_TILES: Tile[] = [{ x: 26, y: 39 }, { x: 27, y: 39 }];
/** Abertura entre a convivência e a recepção. */
export const LOUNGE_DOOR: Tile[] = [{ x: 25, y: 30 }, { x: 26, y: 30 }, { x: 27, y: 30 }, { x: 28, y: 30 }];
/** Ponto seguro do avatar: em frente ao balcão da recepção. */
export const PLAYER_START: Tile = { x: 26, y: 28 };

/** Lugares em pé na convivência para funcionários cuja sala não tem vaga na planta. */
export const LOUNGE_SPOTS: Tile[] = [
  { x: 10, y: 34 }, { x: 12, y: 34 }, { x: 14, y: 34 }, { x: 16, y: 34 }, { x: 18, y: 34 }, { x: 20, y: 34 },
  { x: 10, y: 37 }, { x: 12, y: 37 }, { x: 14, y: 37 }, { x: 16, y: 37 }, { x: 18, y: 37 }, { x: 20, y: 37 },
];

export function getRoomSlot(slot: number): RoomSlotLayout {
  if (!Number.isInteger(slot) || slot < 0 || slot >= ROOM_SLOTS) throw new RangeError(`slot inválido: ${slot}`);
  if (slot === MEETING_SLOT) {
    // porta de 2 tiles na parede esquerda (x 33, y 34..35); "lado right" = o lado de fora fica em x-1
    return { slot, rect: { ...MEETING_RECT }, door: { x: MEETING_RECT.x - 1, y: MEETING_RECT.y + 3 }, side: 'right' };
  }
  const row = Math.floor(slot / 2);
  const side: 'left' | 'right' = slot % 2 === 0 ? 'left' : 'right';
  const x = side === 'left' ? LEFT_X : RIGHT_X;
  const y = ROW_Y[row];
  const rect: Rect = { x, y, w: ROOM_W, h: ROOM_H };
  const door: Tile = { x: side === 'left' ? x + ROOM_W : x - 1, y: y + 3 };
  return { slot, rect, door, side };
}

/** Retângulo interior da sala (em tiles). */
export function getRoomRect(slot: number): Rect { return getRoomSlot(slot).rect; }

/** Tiles da porta da sala (abertura de 2 tiles na parede do corredor). */
export function getRoomDoor(slot: number): Tile[] {
  const d = getRoomSlot(slot).door;
  return [d, { x: d.x, y: d.y + 1 }];
}

/** Mesas da sala, na ordem do deskIndex (0..3). A sala de Reuniões não tem mesa de trabalho. */
export function getDeskPositions(slot: number): DeskPosition[] {
  const { rect } = getRoomSlot(slot);
  const out: DeskPosition[] = [];
  if (slot === MEETING_SLOT) return out;
  for (const dy of [1, 5]) for (const dx of [4, 12]) {
    out.push({ desk: { x: rect.x + dx, y: rect.y + dy }, chair: { x: rect.x + dx, y: rect.y + dy + 1 } });
  }
  return out;
}

/**
 * Assentos ao redor da mesa de reunião, em ordem fixa (0..8): três em cima olhando para baixo, dois embaixo
 * olhando para cima, a cabeceira à esquerda olhando para a direita e, para reuniões com a equipe, a cabeceira à
 * direita e as segundas cadeiras das duas pontas. O tile central da sala fica livre entre os dois assentos de baixo
 * (é por ali que o avatar chega à mesa).
 */
export function getMeetingSeats(slot = MEETING_SLOT): MeetingSeat[] {
  const { rect } = getRoomSlot(slot);
  const cx = rect.x + Math.floor(rect.w / 2);
  const mid = rect.y + Math.floor(rect.h / 2);
  return [
    { tile: { x: cx - 1, y: mid - 3 }, face: 'down' },
    { tile: { x: cx, y: mid - 3 }, face: 'down' },
    { tile: { x: cx + 1, y: mid - 3 }, face: 'down' },
    { tile: { x: cx - 1, y: mid }, face: 'up' },
    { tile: { x: cx + 1, y: mid }, face: 'up' },
    { tile: { x: cx - 2, y: mid - 2 }, face: 'right' },
    { tile: { x: cx + 2, y: mid - 2 }, face: 'left' },
    { tile: { x: cx - 2, y: mid - 1 }, face: 'right' },
    { tile: { x: cx + 2, y: mid - 1 }, face: 'left' },
  ];
}

/** Retângulo de tiles ocupado pela mesa de reunião (3x2, entre as fileiras de cadeiras). */
export function getMeetingTableRect(slot = MEETING_SLOT): Rect {
  const { rect } = getRoomSlot(slot);
  const cx = rect.x + Math.floor(rect.w / 2);
  const mid = rect.y + Math.floor(rect.h / 2);
  return { x: cx - 1, y: mid - 2, w: 3, h: 2 };
}

export function getLoungeRect(): Rect { return LOUNGE; }
export function getReceptionRect(): Rect { return RECEPTION; }
export function getHallRect(): Rect { return HALL; }

export function roomCenterPx(slot: number): { x: number; y: number } {
  const r = getRoomRect(slot);
  return { x: (r.x + r.w / 2) * TILE, y: (r.y + r.h / 2) * TILE };
}

/** Tile livre mais próximo do centro da sala (para o A* chegar "ao centro"). */
export function roomCenterTile(slot: number): Tile {
  const r = getRoomRect(slot);
  return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
}

export function tileCenterPx(t: Tile): { x: number; y: number } { return { x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE }; }

export function inRect(r: Rect, t: Tile): boolean { return t.x >= r.x && t.y >= r.y && t.x < r.x + r.w && t.y < r.y + r.h; }

// ---------------------------------------------------------------------------------------------
// Grade de paredes e pisos
// ---------------------------------------------------------------------------------------------
export type TileKind = 'wall' | 'wood' | 'carpet' | 'tile' | 'door';

export interface GridCell { kind: TileKind; /** slot da sala (carpete), -1 fora de sala */ slot: number }

/** Mapa base (paredes, pisos, portas), independente dos móveis. */
export function buildGrid(): GridCell[][] {
  const g: GridCell[][] = Array.from({ length: GRID_H }, () => Array.from({ length: GRID_W }, () => ({ kind: 'wall' as TileKind, slot: -1 })));
  const fill = (r: Rect, kind: TileKind, slot = -1) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) g[y][x] = { kind, slot };
  };
  fill(HALL, 'wood');
  fill(RECEPTION, 'tile');
  fill(LOUNGE, 'tile');
  fill(SIGN_WALL, 'wall');
  for (let s = 0; s < ROOM_SLOTS; s++) {
    fill(getRoomRect(s), 'carpet', s);
    for (const d of getRoomDoor(s)) g[d.y][d.x] = { kind: 'door', slot: -1 };
  }
  for (const d of LOUNGE_DOOR) g[d.y][d.x] = { kind: 'door', slot: -1 };
  for (const d of ENTRANCE_TILES) g[d.y][d.x] = { kind: 'door', slot: -1 };
  return g;
}

// ---------------------------------------------------------------------------------------------
// Móveis por sala e áreas comuns
// ---------------------------------------------------------------------------------------------
export interface FurnishedRoom {
  slot: number;
  kind: RoomKind | 'empty';
  props: Prop[];
  lights: Light[];
  /** Mesas com dois monitores (desenvolvimento). */
  dualMonitors: boolean;
  /** Sprite da mesa de trabalho usada nesta sala. */
  deskSprite: string;
}

function px(t: Tile, ox = 0, oy = 0): { x: number; y: number } { return { x: t.x * TILE + ox, y: t.y * TILE + oy }; }

/**
 * Móveis e luzes de uma sala conforme o tipo. Coordenadas relativas ao interior (dx 0..18, dy 0..rect.h-1).
 * O slot da sala de Reuniões é sempre mobiliado como 'meeting', mesmo que o banco não tenha essa sala.
 */
export function furnishRoom(slot: number, requestedKind: RoomKind | 'empty'): FurnishedRoom {
  const kind: RoomKind | 'empty' = slot === MEETING_SLOT ? 'meeting' : requestedKind;
  const { rect } = getRoomSlot(slot);
  const props: Prop[] = [];
  const lights: Light[] = [];
  const bottom = rect.h - 1;
  const at = (x: number, y: number): Tile => ({ x: rect.x + x, y: rect.y + y });
  const topWall = (x: number): Tile => ({ x: rect.x + x, y: rect.y - 1 });
  const add = (p: Omit<Prop, 'slot'>) => props.push({ ...p, slot });
  /** Objeto em pé contra a parede (estante, armário, rack): bloqueia o tile. */
  const standing = (sprite: string, x: number, y: number, interact?: PropInteract) =>
    add({ sprite, tile: at(x, y), blockW: 1, blockH: 1, interact, hit: interact ? { x: rect.x + x, y: rect.y + y, w: 1, h: 1 } : undefined });
  /** Quadro/mural pendurado na parede de cima; alcance = tiles do piso logo abaixo. */
  const wallBoard = (sprite: string, x: number, widthTiles: number, dx = 0, interact?: PropInteract) =>
    add({ sprite, tile: topWall(x), blockW: 0, blockH: 0, dx, dy: -2, flat: true, interact, hit: interact ? { x: rect.x + x, y: rect.y, w: widthTiles, h: 1 } : undefined });
  const floorLamp = (x: number, y: number) => {
    standing('lamp.floor', x, y);
    lights.push({ ...px(at(x, y), 8, -22), radius: 70, color: '#f0a830', strength: 0.3 });
  };
  const deskSprite = kind === 'design' ? 'desk.tablet' : kind === 'research' ? 'desk.research' : 'desk';
  if (kind !== 'meeting') {
    // mesas de trabalho (todas as salas, inclusive a diretoria: a vaga existe mesmo sem funcionários)
    getDeskPositions(slot).forEach((d, i) => {
      add({ sprite: deskSprite, tile: d.desk, blockW: 2, blockH: 1, flat: true, interact: { kind: 'desk', deskIndex: i }, hit: { x: d.desk.x, y: d.desk.y, w: 2, h: 2 } });
      add({ sprite: 'chair.seat', tile: d.chair, blockW: 0, blockH: 0, flat: true });
    });
    // luminária de teto no centro
    const c = px(at(9, 4), 8, 0);
    lights.push({ x: c.x + 2, y: c.y + 8, radius: 140, color: '#f0a830', strength: 0.22 });
    add({ sprite: 'lamp.ceiling', tile: at(9, 3), blockW: 0, blockH: 0, dx: 2, dy: -6 });
  }

  switch (kind) {
    case 'meeting': {
      // mesa de reunião 3x2 no meio, nove cadeiras ao redor (os tiles das cadeiras são os assentos dos atores;
      // bloqueiam o passo), tela na parede de cima, dois pendentes, abajur e plantas nos cantos
      const table = getMeetingTableRect(slot);
      const seats = getMeetingSeats(slot);
      const hitTop = Math.min(...seats.map((s) => s.tile.y));
      const hitBottom = Math.max(...seats.map((s) => s.tile.y));
      add({
        sprite: 'table.conference', tile: { x: table.x, y: table.y + table.h - 1 }, blockW: table.w, blockH: table.h,
        interact: { kind: 'meeting' }, hit: { x: table.x, y: hitTop, w: table.w, h: hitBottom - hitTop + 1 },
      });
      for (const s of seats) add({ sprite: 'chair.seat', tile: s.tile, blockW: 1, blockH: 1, flat: true });
      const bx = table.x - rect.x;
      wallBoard('board.screen', bx, table.w, 4, { kind: 'meeting' });
      lights.push({ ...px({ x: table.x + 1, y: table.y }, 8, 4), radius: 150, color: '#f0a830', strength: 0.26 });
      for (const lx of [bx - 3, bx + table.w + 2]) {
        add({ sprite: 'lamp.ceiling', tile: at(lx, table.y - rect.y), blockW: 0, blockH: 0, dx: 2, dy: -6 });
        lights.push({ ...px(at(lx, table.y - rect.y), 8, 8), radius: 80, color: '#f0a830', strength: 0.18 });
      }
      floorLamp(18, Math.floor(rect.h / 2));
      standing('plant.b', 0, bottom);
      standing('plant.a', 18, 0);
      standing('plant.a', 18, bottom);
      break;
    }
    case 'dev':
      standing('shelf.tech', 0, 0, { kind: 'cabinet' });
      // Sala piloto (Marco 1): estante de skills e computador (ferramentas) também são clicáveis.
      standing('shelf.books', 1, 0, { kind: 'shelf' });
      standing('rack.server', 18, 0, { kind: 'computer' });
      standing('cooler', 17, 0);
      wallBoard('board.white', 2, 3, 0, { kind: 'board' });
      add({ sprite: 'rug', tile: at(8, bottom), blockW: 0, blockH: 0, dx: 8, dy: -2, flat: true });
      floorLamp(18, 6);
      standing('plant.a', 0, bottom);
      standing('plant.b', 18, bottom);
      standing('plant.a', 9, 0);
      break;
    case 'social':
      standing('shelf.media', 0, 0, { kind: 'cabinet' });
      wallBoard('board.content', 2, 3, 0, { kind: 'board' });
      add({ sprite: 'neon.heart', tile: topWall(15), blockW: 0, blockH: 0, dx: 0, dy: -1, flat: true });
      lights.push({ ...px(topWall(15), 8, 12), radius: 70, color: '#e07aa8', strength: 0.24 });
      add({ sprite: 'neon.strip', tile: topWall(5), blockW: 0, blockH: 0, dx: 0, dy: 2, flat: true });
      lights.push({ ...px(topWall(6), 0, 14), radius: 60, color: '#4fd1c5', strength: 0.16 });
      add({ sprite: 'backdrop', tile: at(16, 0), blockW: 3, blockH: 1 });
      standing('ring.light', 15, 1);
      lights.push({ ...px(at(15, 1), 8, -22), radius: 60, color: '#9fd8ff', strength: 0.3 });
      standing('tripod.camera', 17, 2);
      add({ sprite: 'sofa', tile: at(7, bottom), blockW: 3, blockH: 1 });
      add({ sprite: 'rug.round', tile: at(8, 4), blockW: 0, blockH: 0, dx: 8, dy: -2, flat: true });
      standing('plant.a', 0, bottom);
      standing('plant.b', 18, bottom);
      break;
    case 'design':
      standing('shelf.gear', 0, 0, { kind: 'cabinet' });
      wallBoard('board.mood', 2, 3, 0, { kind: 'board' });
      add({ sprite: 'station.edit', tile: at(15, 0), blockW: 3, blockH: 1 });
      lights.push({ ...px(at(16, 0), 8, 2), radius: 60, color: '#b07ae0', strength: 0.26 });
      standing('plant.b', 18, 0);
      add({ sprite: 'rug', tile: at(8, bottom), blockW: 0, blockH: 0, dx: 8, dy: -2, flat: true });
      add({ sprite: 'sofa', tile: at(14, bottom), blockW: 3, blockH: 1 });
      floorLamp(18, 6);
      standing('plant.a', 0, bottom);
      standing('plant.b', 9, 0);
      break;
    case 'research':
      standing('cabinet.archive', 0, 0, { kind: 'cabinet' });
      standing('shelf.research', 1, 0);
      wallBoard('board.map', 2, 3, 0, { kind: 'board' });
      wallBoard('board.plan', 16, 2, 0);
      standing('globe', 18, 0);
      add({ sprite: 'table.round', tile: at(8, 0), blockW: 2, blockH: 1, dx: 8 });
      add({ sprite: 'rug.round', tile: at(8, bottom), blockW: 0, blockH: 0, dx: 8, dy: -2, flat: true });
      floorLamp(18, 6);
      standing('plant.b', 0, bottom);
      standing('plant.a', 18, bottom);
      break;
    case 'management':
      standing('shelf.books', 0, 0, { kind: 'cabinet' });
      wallBoard('board.kanban', 2, 3, 0, { kind: 'board' });
      add({ sprite: 'table.meeting', tile: at(6, 5), blockW: 3, blockH: 3 });
      standing('shelf.research', 1, 0);
      add({ sprite: 'sofa', tile: at(14, bottom), blockW: 3, blockH: 1 });
      standing('plant.b', 18, 0);
      standing('plant.a', 9, 0);
      floorLamp(18, 6);
      standing('plant.a', 0, bottom);
      standing('plant.a', 18, bottom);
      break;
    case 'direction':
      standing('shelf.exec', 0, 0, { kind: 'cabinet' });
      standing('shelf.exec', 1, 0);
      wallBoard('frame.art', 3, 2, 0, { kind: 'board' });
      add({ sprite: 'rug', tile: at(10, 6), blockW: 0, blockH: 0, flat: true });
      add({ sprite: 'desk.exec', tile: at(10, 4), blockW: 3, blockH: 1, flat: true });
      lights.push({ ...px(at(10, 4), 9, 2), radius: 60, color: '#f0a830', strength: 0.3 });
      standing('armchair', 11, 3);
      add({ sprite: 'sofa', tile: at(2, bottom), blockW: 3, blockH: 1 });
      add({ sprite: 'table.round', tile: at(6, bottom), blockW: 2, blockH: 1, dx: 8 });
      standing('plant.b', 18, 0);
      standing('plant.a', 9, 0);
      floorLamp(18, 6);
      standing('plant.a', 0, bottom);
      standing('plant.b', 18, bottom);
      break;
    case 'custom':
      standing('shelf.books', 0, 0, { kind: 'cabinet' });
      wallBoard('board.plan', 2, 2, 0, { kind: 'board' });
      standing('plant.a', 18, bottom);
      standing('plant.b', 0, bottom);
      break;
    default:
      standing('shelf.books', 0, 0, { kind: 'cabinet' });
      wallBoard('board.plan', 2, 2, 0, { kind: 'board' });
      standing('plant.a', 18, bottom);
      break;
  }
  return { slot, kind, props, lights, dualMonitors: kind === 'dev', deskSprite };
}

/** Móveis e luzes do corredor, da recepção e da convivência (fixos). */
export function commonProps(): { props: Prop[]; lights: Light[] } {
  const props: Prop[] = [];
  const lights: Light[] = [];
  const add = (p: Omit<Prop, 'slot'>) => props.push({ ...p, slot: -1 });
  const standing = (sprite: string, x: number, y: number) => add({ sprite, tile: { x, y }, blockW: 1, blockH: 1 });
  const floorLamp = (x: number, y: number) => {
    standing('lamp.floor', x, y);
    lights.push({ x: x * TILE + 8, y: y * TILE - 6, radius: 80, color: '#f0a830', strength: 0.3 });
  };
  // corredor
  for (const y of [5, 15]) {
    add({ sprite: 'lamp.ceiling', tile: { x: 26, y }, blockW: 0, blockH: 0, dx: 10, dy: -6 });
    lights.push({ x: 27 * TILE, y: y * TILE + 10, radius: 110, color: '#f0a830', strength: 0.2 });
  }
  add({ sprite: 'rug', tile: { x: 25, y: 12 }, blockW: 0, blockH: 0, dx: 8, flat: true });
  for (const y of [9, 19]) { standing('plant.b', HALL_X0, y); standing('plant.a', HALL_X1, y); }
  standing('cooler', HALL_X0, 2);
  standing('plant.a', HALL_X1, 2);
  // recepção: placa na parede curta, balcão em frente, tapete, plantas e luminárias
  add({ sprite: 'sign', tile: { x: SIGN_WALL.x, y: SIGN_WALL.y + 1 }, blockW: 0, blockH: 0, dx: 4, dy: -2, flat: true });
  lights.push({ x: (SIGN_WALL.x + 3) * TILE, y: (SIGN_WALL.y + 1) * TILE + 6, radius: 130, color: '#f0a830', strength: 0.36 });
  add({ sprite: 'reception.counter', tile: { x: 25, y: 26 }, blockW: 4, blockH: 1, interact: { kind: 'reception' }, hit: { x: 25, y: 26, w: 4, h: 1 } });
  add({ sprite: 'rug', tile: { x: 25, y: 28 }, blockW: 0, blockH: 0, dx: 8, flat: true });
  standing('plant.b', 22, 22);
  standing('plant.b', 31, 22);
  floorLamp(21, 28);
  floorLamp(32, 28);
  // convivência (x 1..32): sofás, mesa redonda, café encostado na parede da sala de Reuniões, plantas, gato
  add({ sprite: 'sofa', tile: { x: 3, y: 32 }, blockW: 3, blockH: 1 });
  add({ sprite: 'rug.round', tile: { x: 3, y: 36 }, blockW: 0, blockH: 0, dx: 8, dy: -2, flat: true });
  add({ sprite: 'table.round', tile: { x: 3, y: 35 }, blockW: 2, blockH: 1, dx: 8 });
  add({ sprite: 'cat', tile: { x: 7, y: 36 }, blockW: 0, blockH: 0, flat: true });
  floorLamp(1, 32);
  add({ sprite: 'lamp.ceiling', tile: { x: 14, y: 34 }, blockW: 0, blockH: 0, dx: 2, dy: -6 });
  lights.push({ x: 14 * TILE + 8, y: 34 * TILE + 10, radius: 130, color: '#f0a830', strength: 0.22 });
  standing('counter', 29, 31);
  standing('coffee', 30, 31);
  standing('counter', 31, 31);
  add({ sprite: 'sofa', tile: { x: 29, y: 37 }, blockW: 3, blockH: 1 });
  add({ sprite: 'lamp.ceiling', tile: { x: 24, y: 35 }, blockW: 0, blockH: 0, dx: 2, dy: -6 });
  lights.push({ x: 24 * TILE + 8, y: 35 * TILE + 10, radius: 130, color: '#f0a830', strength: 0.22 });
  standing('plant.b', 32, 31);
  standing('plant.a', 32, 38);
  standing('plant.b', 1, 38);
  standing('plant.a', 22, 31);
  add({ sprite: 'doormat', tile: { x: 26, y: 38 }, blockW: 0, blockH: 0, dy: 8, flat: true });
  return { props, lights };
}

// ---------------------------------------------------------------------------------------------
// Grade de caminhada
// ---------------------------------------------------------------------------------------------
/** true = tile livre para andar. */
export function buildWalkable(grid: GridCell[][], props: Prop[]): boolean[][] {
  const w: boolean[][] = grid.map((row) => row.map((c) => c.kind !== 'wall'));
  for (const p of props) {
    for (let y = 0; y < p.blockH; y++) for (let x = 0; x < p.blockW; x++) {
      const ty = p.tile.y - y;
      const tx = p.tile.x + x;
      if (ty >= 0 && ty < GRID_H && tx >= 0 && tx < GRID_W) w[ty][tx] = false;
    }
  }
  return w;
}

export interface OfficeLayout {
  grid: GridCell[][];
  walkable: boolean[][];
  props: Prop[];
  lights: Light[];
  rooms: FurnishedRoom[];
}

/** Monta a planta completa para a configuração de salas (slot → tipo). */
export function buildLayout(kinds: Partial<Record<number, RoomKind>>): OfficeLayout {
  const grid = buildGrid();
  const rooms: FurnishedRoom[] = [];
  const props: Prop[] = [];
  const lights: Light[] = [];
  for (let s = 0; s < ROOM_SLOTS; s++) {
    const r = furnishRoom(s, kinds[s] ?? 'empty');
    rooms.push(r);
    props.push(...r.props);
    lights.push(...r.lights);
  }
  const common = commonProps();
  props.push(...common.props);
  lights.push(...common.lights);
  const walkable = buildWalkable(grid, props);
  return { grid, walkable, props, lights, rooms };
}

/** Slot da sala em que um tile está (-1 = corredor, recepção, convivência ou parede). */
export function slotAtTile(grid: GridCell[][], t: Tile): number {
  if (t.x < 0 || t.y < 0 || t.x >= GRID_W || t.y >= GRID_H) return -1;
  return grid[t.y][t.x].slot;
}

/** Retângulo em px do mundo ocupado pelo sprite de um objeto (para contorno de interação). */
export function propPixelRect(p: Prop, spriteH: number, spriteW: number): Rect {
  const x = p.tile.x * TILE + (p.dx ?? 0);
  const y = (p.tile.y + 1) * TILE + (p.dy ?? 0) - spriteH;
  return { x, y, w: spriteW, h: spriteH };
}

// ---------------------------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------------------------
export function flood(walkable: boolean[][], from: Tile): boolean[][] {
  const seen: boolean[][] = walkable.map((r) => r.map(() => false));
  if (!walkable[from.y]?.[from.x]) return seen;
  const q: Tile[] = [from];
  seen[from.y][from.x] = true;
  while (q.length) {
    const t = q.shift() as Tile;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = t.x + dx;
      const ny = t.y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      if (!walkable[ny][nx] || seen[ny][nx]) continue;
      seen[ny][nx] = true;
      q.push({ x: nx, y: ny });
    }
  }
  return seen;
}

/**
 * Problemas da planta (vazio = válida): mesas inalcançáveis, móveis sobrepostos, objetos fora da grade,
 * portas bloqueadas (o tile da porta e os dois tiles vizinhos, dentro e fora, precisam estar livres),
 * centro de sala inalcançável, objetos interativos sem tile livre ao lado.
 */
export function validateLayout(layout: OfficeLayout): string[] {
  const errors: string[] = [];
  const walk = layout.walkable;
  const reach = flood(walk, ENTRANCE);
  const free = (t: Tile) => !!walk[t.y]?.[t.x];
  for (let s = 0; s < ROOM_SLOTS; s++) {
    getDeskPositions(s).forEach((d, i) => {
      if (!free(d.chair)) errors.push(`slot ${s} mesa ${i}: cadeira bloqueada`);
      else if (!reach[d.chair.y][d.chair.x]) errors.push(`slot ${s} mesa ${i}: cadeira inalcançável`);
    });
    const { side } = getRoomSlot(s);
    for (const d of getRoomDoor(s)) {
      const inside = { x: side === 'left' ? d.x - 1 : d.x + 1, y: d.y };
      const outside = { x: side === 'left' ? d.x + 1 : d.x - 1, y: d.y };
      if (!free(d)) errors.push(`slot ${s}: porta (${d.x},${d.y}) bloqueada`);
      if (!free(inside)) errors.push(`slot ${s}: lado de dentro da porta (${inside.x},${inside.y}) bloqueado`);
      if (!free(outside)) errors.push(`slot ${s}: lado de fora da porta (${outside.x},${outside.y}) bloqueado`);
    }
    const center = roomCenterTile(s);
    if (!free(center) || !reach[center.y][center.x]) errors.push(`slot ${s}: centro da sala (${center.x},${center.y}) inalcançável`);
  }
  for (const d of [...LOUNGE_DOOR, ...ENTRANCE_TILES]) {
    if (!free(d)) errors.push(`porta comum (${d.x},${d.y}) bloqueada`);
    if (d.y > 0 && !free({ x: d.x, y: d.y - 1 })) errors.push(`acima da porta comum (${d.x},${d.y}) bloqueado`);
  }
  if (!free(PLAYER_START) || !reach[PLAYER_START.y][PLAYER_START.x]) errors.push('ponto seguro do avatar bloqueado ou inalcançável');
  for (const t of LOUNGE_SPOTS) if (!reach[t.y]?.[t.x]) errors.push(`lugar da convivência (${t.x},${t.y}) inalcançável`);
  // sobreposição de móveis que bloqueiam
  const occ = new Map<string, string>();
  for (const p of layout.props) {
    for (let y = 0; y < p.blockH; y++) for (let x = 0; x < p.blockW; x++) {
      const tx = p.tile.x + x;
      const ty = p.tile.y - y;
      if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) { errors.push(`${p.sprite} fora da grade em (${tx},${ty})`); continue; }
      const key = `${tx},${ty}`;
      const prev = occ.get(key);
      if (prev) errors.push(`${p.sprite} sobrepõe ${prev} em ${key}`);
      occ.set(key, p.sprite);
      if (layout.grid[ty][tx].kind === 'wall') errors.push(`${p.sprite} em cima de parede em ${key}`);
      if (layout.grid[ty][tx].kind === 'door') errors.push(`${p.sprite} em cima de porta em ${key}`);
    }
    // objeto interativo precisa de pelo menos um tile livre e alcançável ao lado do retângulo de alcance
    if (p.interact && p.hit) {
      let ok = false;
      for (let y = p.hit.y - 1; y <= p.hit.y + p.hit.h && !ok; y++) for (let x = p.hit.x - 1; x <= p.hit.x + p.hit.w && !ok; x++) {
        if (inRect(p.hit, { x, y })) continue;
        if (walk[y]?.[x] && reach[y][x]) ok = true;
      }
      if (!ok) errors.push(`${p.sprite} (${p.interact.kind}) sem tile livre ao lado`);
    }
  }
  return errors;
}
