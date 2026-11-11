// Motor da cena do escritório em canvas 2D (v2): câmera com modos (follow/overview/free), zoom inteiro, hit-test,
// personagens que caminham até a mesa, poses por fase, bolhas, iluminação aconchegante, rótulos nítidos, avatar
// do usuário (WASD/setas, clique no chão, tecla E) e dados para o minimapa. A cena só representa o estado que
// chega do servidor (fase e detalhe reais); animações são decorativas e nunca atrasam a informação.

import {
  ENTRANCE, GRID_H, GRID_W, LOUNGE_SPOTS, MEETING_COLOR, MEETING_LABEL, MEETING_SLOT, PLAYER_START, ROOM_SLOTS, WORLD_H, WORLD_W,
  buildLayout, getDeskPositions, getLoungeRect, getMeetingSeats, getReceptionRect, getRoomDoor, getRoomRect, propPixelRect, roomCenterPx, slotAtTile,
  type DeskPosition, type Light, type MeetingSeat, type OfficeLayout, type Prop, type Rect, type Tile,
} from './layout';
import type { ParticipantState } from '@milweb-hq/protocol';
import { findPath, nearestWalkable } from './pathfinding';
import { DONE_BUBBLE_MS, phaseLabel, poseForPhase, type BodyPose } from './poses';
import { CHARACTER_KEYS, CHAR_H, HEAD_H, PALETTE, SIT_BODY_H, SpriteCache, TILE, characterPalette, spriteSize } from './sprites';
import {
  FIT_MARGIN, NO_INSETS, ZOOM_MAX, ZOOM_MIN, cameraCenteredOn, clampCameraTo, clampZoom, fitCameraFor, fitZoomFor, followCamera,
  smoothTowards, visibleWorldRect, type Insets,
} from './camera';
import {
  INTERACT_REACH, NO_INPUT, PLAYER_SPEED, canStand, distanceToTileRect, moveVector, safePlayerPosition, stepAlongPath, stepPlayer,
  tileOfPoint, tileToPlayerPos, type Dir, type PlayerInput, type Vec,
} from './player';
import type {
  CameraMode, MinimapData, OfficeScene, SceneHandlers, SceneInteractable, SceneMeeting, SceneMeetingActor, SceneOptions, ScenePlayer, SceneRoom,
  SceneSelection, SceneWorker,
} from './types';

const BG = '#241f1a'; // fundo em volta da planta: marrom quente (v4), não preto
const AMBER = '#f0a830';
const AMBER_BRIGHT = '#ffd27a';
const FONT_UI = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
const FONT_PIXEL = "'Press Start 2P'";
const WALK_SPEED = 88;         // funcionários: px do mundo por segundo (5,5 tiles/s)
const FRAME_MS = 1000 / 30;    // animação a 30 fps; interações redesenham na hora
const DRAG_THRESHOLD = 4;      // px de tela: abaixo disto é clique, acima é arrastar
const PLAYER_MOVE_REPORT_MS = 1000;
const CHAR_HALF_W = 10;        // metade da largura do personagem (20 px)

interface Seat {
  tile: Tile;
  kind: 'desk' | 'stand';
  slot: number;
  desk?: DeskPosition;
}

interface IdleAction { kind: 'look' | 'stretch'; until: number; side: 'left' | 'right' }

/** Alvo de uma interação pedida por clique (objeto ou funcionário), guardado até o avatar chegar. */
interface PendingInteract { key: string; prop: Prop | null; actorId: string | null }

interface Actor {
  id: string;
  data: SceneWorker;
  x: number;            // centro em px do mundo
  y: number;            // base (pés) em px do mundo
  dir: Dir;
  path: Tile[];
  pathIdx: number;
  seat: Seat | null;
  seated: boolean;
  walkT: number;
  phaseSince: number;
  idle: IdleAction | null;
  nextIdleAt: number;
  leaving: boolean;
  seed: number;
}

/** Participante de IA na sala de Reuniões. Não é funcionário: entra pela porta da sala, senta no assento e sai quando a reunião termina. */
interface MeetingActor {
  id: string;
  data: SceneMeetingActor;
  x: number;
  y: number;
  dir: Dir;
  path: Tile[];
  pathIdx: number;
  walkT: number;
  seat: MeetingSeat | null;
  seated: boolean;
  leaving: boolean;
  stateSince: number;
  seed: number;
}

/** Aparência fixa por provedor (índices de pele/cabelo distintos; a camisa é trocada pela cor do provedor ao desenhar). */
const MEETING_APPEARANCE: Record<SceneMeetingActor['provider'], { skin: number; hair: number; shirt: number }> = {
  claude: { skin: 1, hair: 1, shirt: 0 },
  openai: { skin: 0, hair: 0, shirt: 2 },
};
/** Camisa laranja/âmbar (Claude) e verde-água (ChatGPT): [cor, sombra]. */
const MEETING_SHIRT: Record<SceneMeetingActor['provider'], [string, string]> = {
  claude: ['#f0a830', '#b97d1e'],
  openai: ['#4fd1c5', '#2f8f86'],
};
const MEETING_BADGE: Record<SceneMeetingActor['provider'], { letter: string; color: string }> = {
  claude: { letter: 'C', color: '#f0a830' },
  openai: { letter: 'G', color: '#4fd1c5' },
};

/** Texto curto em português para o estado do participante. */
function participantLabel(state: ParticipantState): string {
  switch (state) {
    case 'available': return 'disponível';
    case 'waiting_turn': return 'aguardando a vez';
    case 'responding': return 'respondendo…';
    case 'waiting_chefe': return 'aguardando o Chefe';
    case 'interrupted': return 'interrompido';
    case 'unavailable': return 'indisponível';
    default: return String(state);
  }
}

interface Player {
  data: ScenePlayer;
  x: number;
  y: number;
  dir: Dir;
  walkT: number;
  moving: boolean;
  path: Vec[];
  pathIdx: number;
  /** Interação pedida por clique num objeto ou funcionário: dispara ao chegar ao alcance. */
  pending: PendingInteract | null;
  lastReportAt: number;
  roomId: string | null;
}

interface Camera { x: number; y: number; zoom: number }

interface CamAnim { fromX: number; fromY: number; toX: number; toY: number; start: number; dur: number }

interface Interactable { target: SceneInteractable; label: string; key: string; prop: Prop | null; actor: Actor | null }

/** Dyn de silhueta: todos os caracteres viram uma só cor. */
function silhouette(color: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(PALETTE)) out[k] = color;
  for (const k of CHARACTER_KEYS) out[k] = color;
  return out;
}

function easeOut(t: number): number { return 1 - Math.pow(1 - t, 3); }

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, Math.max(0, lo)).trimEnd() + '…';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function interactableKey(t: SceneInteractable): string {
  switch (t.kind) {
    case 'worker': return `worker:${t.id}`;
    case 'desk': return `desk:${t.roomId}:${t.workerId ?? ''}`;
    case 'cabinet': return `cabinet:${t.roomId}`;
    case 'shelf': return `shelf:${t.roomId}`;
    case 'computer': return `computer:${t.roomId}`;
    case 'board': return `board:${t.roomId}`;
    case 'reception': return 'reception';
    case 'meeting': return `meeting:${t.roomId}`;
  }
}

/** true quando o foco está num campo de texto (o teclado não deve mover o avatar). */
function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

export function createOfficeScene(canvas: HTMLCanvasElement, handlers: SceneHandlers, options?: Partial<SceneOptions>): OfficeScene {
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('canvas 2d indisponível');
  const ctx = ctx2d;
  const cache = new SpriteCache();

  const opts: SceneOptions = {
    reducedMotion: false, showLabels: true, zoom: 2, insets: { ...NO_INSETS }, inputEnabled: true,
    ...options,
    ...(options?.insets ? { insets: { ...NO_INSETS, ...options.insets } } : {}),
  };
  opts.zoom = clampZoom(opts.zoom);

  // ---------------- estado ----------------
  let rooms: SceneRoom[] = [];
  let roomBySlot = new Map<number, SceneRoom>();
  let roomById = new Map<string, SceneRoom>();
  let layout: OfficeLayout = buildLayout({});
  let layoutKey = '';
  let walkBase: boolean[][] = layout.walkable;   // caminhável com cadeiras bloqueadas
  const actors = new Map<string, Actor>();
  const meetingActors = new Map<string, MeetingActor>();
  let meeting: SceneMeeting | null = null;
  let selection: SceneSelection = { kind: 'none' };
  let hovered: SceneSelection = { kind: 'none' };
  let hoveredProp: Prop | null = null;
  const cam: Camera = { x: 0, y: 0, zoom: opts.zoom };
  let camMode: CameraMode = 'overview';
  let camAnim: CamAnim | null = null;
  let viewW = 1;
  let viewH = 1;
  let dpr = 1;
  let staticCv: HTMLCanvasElement | null = null;
  let staticDirty = true;
  let lightCv: HTMLCanvasElement | null = null;
  let pixelFontOk = false;
  let destroyed = false;
  let raf = 0;
  let lastFrame = 0;
  let lastTick = 0;
  let dirty = true;
  let clock = 0; // tempo acumulado em ms (para animações)
  const keys = new Set<string>();
  let drag: { id: number; sx: number; sy: number; cx: number; cy: number; moved: boolean } | null = null;
  let player: Player | null = null;
  let savedPlayerPos: Vec | null = null;
  let interactable: Interactable | null = null;

  // ---------------- fontes ----------------
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (fonts) {
    Promise.all([fonts.load(`8px ${FONT_PIXEL}`), fonts.load(`600 11px Inter`), fonts.load(`400 10px Inter`)])
      .then(() => { pixelFontOk = fonts.check(`8px ${FONT_PIXEL}`); })
      .catch(() => { /* usa fallback */ })
      .finally(() => { staticDirty = true; dirty = true; });
  }

  // ---------------- câmera ----------------
  function insets(): Insets { return opts.insets ?? NO_INSETS; }
  function worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom };
  }
  function screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y };
  }
  function clampCamera(): void {
    const c = clampCameraTo(cam, cam.zoom, viewW, viewH, insets());
    cam.x = c.x;
    cam.y = c.y;
  }
  function setMode(mode: CameraMode): void {
    if (mode === camMode) return;
    camMode = mode;
    camAnim = null;
    dirty = true;
    handlers.onCameraModeChange?.(mode);
  }
  function centerOn(wx: number, wy: number, animate: boolean): void {
    const target = clampCameraTo(cameraCenteredOn({ x: wx, y: wy }, cam.zoom, viewW, viewH, insets()), cam.zoom, viewW, viewH, insets());
    if (!animate || opts.reducedMotion) {
      camAnim = null;
      cam.x = target.x; cam.y = target.y;
    } else {
      camAnim = { fromX: cam.x, fromY: cam.y, toX: target.x, toY: target.y, start: clock, dur: 380 };
    }
    dirty = true;
  }
  function setZoom(z: number, anchorX?: number, anchorY?: number): void {
    const nz = clampZoom(z);
    if (nz === cam.zoom) return;
    const ax = anchorX ?? viewW / 2;
    const ay = anchorY ?? viewH / 2;
    const before = screenToWorld(ax, ay);
    cam.zoom = nz;
    opts.zoom = nz;
    cam.x = before.x - ax / nz;
    cam.y = before.y - ay / nz;
    camAnim = null;
    clampCamera();
    dirty = true;
  }
  function fitAll(): void {
    cam.zoom = fitZoomFor(viewW, viewH, insets());
    opts.zoom = cam.zoom;
    const c = fitCameraFor(viewW, viewH, insets(), cam.zoom);
    cam.x = c.x; cam.y = c.y;
    clampCamera();
    camAnim = null;
    dirty = true;
    setMode('overview');
  }
  function playerFocusPoint(p: Player): Vec { return { x: p.x, y: p.y - 14 }; }

  // ---------------- planta ----------------
  function rebuildLayoutIfNeeded(): void {
    const kinds: Partial<Record<number, SceneRoom['kind']>> = {};
    for (const r of rooms) if (r.slot >= 0 && r.slot < ROOM_SLOTS) kinds[r.slot] = r.kind;
    const key = JSON.stringify(kinds);
    if (key === layoutKey) return;
    layoutKey = key;
    layout = buildLayout(kinds);
    // cadeiras não são passagem: só o destino libera a própria cadeira
    walkBase = layout.walkable.map((row) => row.slice());
    for (let s = 0; s < ROOM_SLOTS; s++) for (const d of getDeskPositions(s)) walkBase[d.chair.y][d.chair.x] = false;
    staticDirty = true;
    for (const a of actors.values()) assignSeat(a, true);
    if (player) {
      const safe = safePlayerPosition({ x: player.x, y: player.y }, walkBase, PLAYER_START);
      if (safe.x !== player.x || safe.y !== player.y) { player.x = safe.x; player.y = safe.y; stopPlayerPath(); }
    }
  }

  function slotOfRoom(roomId: string): number {
    const r = roomById.get(roomId);
    if (r && r.slot >= 0 && r.slot < ROOM_SLOTS) return r.slot;
    // a sala de Reuniões existe na planta mesmo sem sala no banco
    return roomId === 'meeting' ? MEETING_SLOT : -1;
  }

  /** Id da sala de Reuniões para interações: a SceneRoom no slot 6 quando existe, senão 'meeting'. */
  function meetingRoomId(): string { return roomBySlot.get(MEETING_SLOT)?.id ?? 'meeting'; }

  function loungeSpotFor(a: Actor): Tile {
    const taken = new Set<string>();
    for (const o of actors.values()) if (o !== a && o.seat?.kind === 'stand') taken.add(`${o.seat.tile.x},${o.seat.tile.y}`);
    const free = LOUNGE_SPOTS.find((t) => !taken.has(`${t.x},${t.y}`));
    return free ?? LOUNGE_SPOTS[Math.floor(a.seed * LOUNGE_SPOTS.length)];
  }

  function seatFor(a: Actor): Seat {
    const slot = slotOfRoom(a.data.roomId);
    if (slot >= 0) {
      const desks = getDeskPositions(slot);
      const d = desks[a.data.deskIndex];
      if (d) return { tile: d.chair, kind: 'desk', slot, desk: d };
    }
    return { tile: loungeSpotFor(a), kind: 'stand', slot };
  }

  /** Quem anda pela grade: funcionário ou participante de reunião. */
  interface Mover { x: number; y: number; dir: Dir; path: Tile[]; pathIdx: number; walkT: number }

  function tileOf(a: Mover): Tile {
    return { x: Math.floor(a.x / TILE), y: Math.max(0, Math.ceil(a.y / TILE) - 1) };
  }

  /** Avança pelo caminho em WALK_SPEED. Devolve true no quadro em que o caminho termina. */
  function advancePath(m: Mover, dt: number): boolean {
    if (!m.path.length || m.pathIdx >= m.path.length) return false;
    let budget = WALK_SPEED * (dt / 1000);
    while (budget > 0 && m.pathIdx < m.path.length) {
      const t = m.path[m.pathIdx];
      const tx = t.x * TILE + TILE / 2;
      const ty = (t.y + 1) * TILE;
      const dx = tx - m.x;
      const dy = ty - m.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) { m.x = tx; m.y = ty; m.pathIdx++; budget -= dist; continue; }
      m.x += (dx / dist) * budget;
      m.y += (dy / dist) * budget;
      m.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      budget = 0;
    }
    m.walkT += dt;
    return m.pathIdx >= m.path.length;
  }

  function walkableFor(target: Tile): boolean[][] {
    const w = walkBase.map((row) => row.slice());
    if (target.y >= 0 && target.y < GRID_H && target.x >= 0 && target.x < GRID_W) w[target.y][target.x] = true;
    return w;
  }

  function teleport(a: Mover, t: Tile): void {
    a.x = t.x * TILE + TILE / 2;
    a.y = (t.y + 1) * TILE;
    a.path = [];
    a.pathIdx = 0;
  }

  /** Define o destino do ator e começa a caminhada (ou teleporta em reducedMotion / sem caminho). */
  function assignSeat(a: Actor, keepIfSame: boolean): void {
    const seat = seatFor(a);
    if (keepIfSame && a.seat && a.seat.kind === seat.kind && a.seat.tile.x === seat.tile.x && a.seat.tile.y === seat.tile.y && a.seat.slot === seat.slot) {
      a.seat = seat;
      return;
    }
    a.seat = seat;
    a.seated = false;
    if (opts.reducedMotion) { teleport(a, seat.tile); arrive(a); return; }
    const from = tileOf(a);
    const grid = walkableFor(seat.tile);
    const start = nearestWalkable(grid, from) ?? from;
    const path = findPath(grid, start, seat.tile);
    if (path.length <= 1) { teleport(a, seat.tile); arrive(a); return; }
    a.path = path;
    a.pathIdx = 0;
    a.walkT = 0;
    dirty = true;
  }

  function arrive(a: Actor): void {
    a.path = [];
    a.pathIdx = 0;
    if (a.seat?.kind === 'desk') { a.seated = true; a.dir = 'up'; }
    else { a.seated = false; a.dir = 'down'; }
    a.nextIdleAt = clock + 2500 + a.seed * 5000;
    dirty = true;
  }

  function spawnActor(w: SceneWorker): Actor {
    const a: Actor = {
      id: w.id, data: w, x: 0, y: 0, dir: 'up', path: [], pathIdx: 0, seat: null, seated: false, walkT: 0,
      phaseSince: clock, idle: null, nextIdleAt: clock + 4000, leaving: false, seed: hashStr(w.id),
    };
    teleport(a, ENTRANCE);
    actors.set(w.id, a);
    assignSeat(a, false);
    return a;
  }

  function startLeaving(a: Actor): void {
    if (opts.reducedMotion) { actors.delete(a.id); dirty = true; return; }
    a.leaving = true;
    a.seated = false;
    a.seat = null;
    const from = tileOf(a);
    const grid = walkableFor(ENTRANCE);
    const start = nearestWalkable(grid, from) ?? from;
    const path = findPath(grid, start, ENTRANCE);
    if (path.length <= 1) { actors.delete(a.id); dirty = true; return; }
    a.path = path;
    a.pathIdx = 0;
    a.walkT = 0;
    dirty = true;
  }

  // ---------------- atores de reunião ----------------
  function meetingDoorTile(): Tile { return getRoomDoor(MEETING_SLOT)[0]; }

  function meetingSeatFor(ma: MeetingActor): MeetingSeat {
    const seats = getMeetingSeats(MEETING_SLOT);
    const i = Number.isInteger(ma.data.seat) ? ((ma.data.seat % seats.length) + seats.length) % seats.length : 0;
    return seats[i];
  }

  function meetingArrive(ma: MeetingActor): void {
    ma.path = [];
    ma.pathIdx = 0;
    if (ma.seat) { ma.seated = true; ma.dir = ma.seat.face; }
    dirty = true;
  }

  /** Caminha (pathfinding existente) da posição atual até o assento; em reducedMotion ou sem caminho, aparece sentado. */
  function assignMeetingSeat(ma: MeetingActor): void {
    const seat = meetingSeatFor(ma);
    ma.seat = seat;
    ma.seated = false;
    ma.leaving = false;
    if (opts.reducedMotion) { teleport(ma, seat.tile); meetingArrive(ma); return; }
    const from = tileOf(ma);
    const grid = walkableFor(seat.tile);
    const start = nearestWalkable(grid, from) ?? from;
    const path = findPath(grid, start, seat.tile);
    if (path.length <= 1) { teleport(ma, seat.tile); meetingArrive(ma); return; }
    ma.path = path;
    ma.pathIdx = 0;
    ma.walkT = 0;
    dirty = true;
  }

  function spawnMeetingActor(d: SceneMeetingActor): MeetingActor {
    const ma: MeetingActor = {
      id: d.id, data: d, x: 0, y: 0, dir: 'right', path: [], pathIdx: 0, walkT: 0, seat: null, seated: false, leaving: false,
      stateSince: clock, seed: hashStr(d.id),
    };
    teleport(ma, meetingDoorTile());
    meetingActors.set(d.id, ma);
    assignMeetingSeat(ma);
    return ma;
  }

  /** Levanta e caminha até a porta da sala; some ao chegar (ou na hora, em reducedMotion). */
  function startMeetingLeaving(ma: MeetingActor): void {
    if (opts.reducedMotion) { meetingActors.delete(ma.id); dirty = true; return; }
    ma.leaving = true;
    ma.seated = false;
    ma.seat = null;
    const door = meetingDoorTile();
    const from = tileOf(ma);
    const grid = walkableFor(door);
    const start = nearestWalkable(grid, from) ?? from;
    const path = findPath(grid, start, door);
    if (path.length <= 1) { meetingActors.delete(ma.id); dirty = true; return; }
    ma.path = path;
    ma.pathIdx = 0;
    ma.walkT = 0;
    dirty = true;
  }

  function stepMeetingActor(ma: MeetingActor, dt: number): void {
    if (!advancePath(ma, dt)) return;
    if (ma.leaving) { meetingActors.delete(ma.id); dirty = true; return; }
    meetingArrive(ma);
  }

  function actorAtDesk(slot: number, deskIndex: number): Actor | null {
    for (const a of actors.values()) {
      if (a.leaving || !a.seat || a.seat.kind !== 'desk' || a.seat.slot !== slot || a.data.deskIndex !== deskIndex) continue;
      return a;
    }
    return null;
  }

  // ---------------- avatar ----------------
  function keyInput(): PlayerInput {
    return {
      up: keys.has('w') || keys.has('ArrowUp'),
      down: keys.has('s') || keys.has('ArrowDown'),
      left: keys.has('a') || keys.has('ArrowLeft'),
      right: keys.has('d') || keys.has('ArrowRight'),
    };
  }
  function stopPlayerPath(): void {
    if (!player) return;
    player.path = [];
    player.pathIdx = 0;
    player.pending = null;
  }
  function reportPlayer(force: boolean): void {
    if (!player || !handlers.onPlayerMove) return;
    if (!force && clock - player.lastReportAt < PLAYER_MOVE_REPORT_MS) return;
    player.lastReportAt = clock;
    handlers.onPlayerMove({ x: Math.round(player.x), y: Math.round(player.y) });
  }
  function setPlayerMoving(moving: boolean): void {
    if (!player || player.moving === moving) return;
    player.moving = moving;
    if (!moving) { player.walkT = 0; reportPlayer(true); }
  }
  function pathTo(from: Vec, to: Tile): Tile[] {
    const start = nearestWalkable(walkBase, tileOfPoint(from), 3);
    if (!start) return [];
    const path = findPath(walkBase, start, to);
    if (path.length > 1 && start.x === tileOfPoint(from).x && start.y === tileOfPoint(from).y) return path.slice(1);
    return path;
  }
  function walkPlayerTo(tile: Tile, pending: PendingInteract | null): boolean {
    if (!player) return false;
    const path = pathTo({ x: player.x, y: player.y }, tile);
    if (!path.length) return false;
    player.path = path.map(tileToPlayerPos);
    player.pathIdx = 0;
    player.pending = pending;
    dirty = true;
    return true;
  }
  /** Tiles livres ao redor do retângulo de alcance de um objeto (para andar até ele). */
  function approachTiles(hit: Rect): Tile[] {
    const out: Tile[] = [];
    for (let y = hit.y - 1; y <= hit.y + hit.h; y++) for (let x = hit.x - 1; x <= hit.x + hit.w; x++) {
      const inside = x >= hit.x && y >= hit.y && x < hit.x + hit.w && y < hit.y + hit.h;
      const corner = (x === hit.x - 1 || x === hit.x + hit.w) && (y === hit.y - 1 || y === hit.y + hit.h);
      if (corner) continue;
      if (walkBase[y]?.[x]) out.push({ x, y });
      else if (inside && walkBase[y]?.[x]) out.push({ x, y });
    }
    return out;
  }
  /** fire=false: o painel já abriu no clique; o avatar só caminha até o objeto (animação, sem disparar de novo). */
  function walkPlayerToProp(p: Prop, fire = true): void {
    if (!player || !p.hit || !p.interact) return;
    const key = interactableKey(targetForProp(p));
    const cands = approachTiles(p.hit);
    if (!cands.length) return;
    const from = { x: player.x, y: player.y };
    let best: { tile: Tile; len: number } | null = null;
    for (const t of cands) {
      const len = pathTo(from, t).length;
      if (len === 0 && (tileOfPoint(from).x !== t.x || tileOfPoint(from).y !== t.y)) continue;
      if (!best || len < best.len) best = { tile: t, len };
    }
    if (!best) return;
    const pending: PendingInteract | null = fire ? { key, prop: p, actorId: null } : null;
    if (best.len === 0) { stopPlayerPath(); if (pending) firePending(pending); return; }
    walkPlayerTo(best.tile, pending);
  }
  function walkPlayerToActor(a: Actor): void {
    if (!player) return;
    const key = interactableKey({ kind: 'worker', id: a.id });
    const t = tileOf(a);
    walkPlayerToProp({ sprite: '', tile: t, blockW: 0, blockH: 0, interact: { kind: 'cabinet' }, hit: { x: t.x, y: t.y, w: 1, h: 1 } });
    if (player.pending) player.pending = { key, prop: null, actorId: a.id };
  }
  /** Ao chegar: dispara o alvo pedido se ele ainda estiver ao alcance, mesmo que outro objeto esteja mais perto
   *  (ex.: funcionário parado ao lado do armário clicado). O alvo é recalculado na hora (a mesa pode ter mudado de dono). */
  function firePending(pending: PendingInteract): void {
    updateInteractable();
    if (interactable?.key === pending.key) { fireInteract(); return; }
    if (!player) return;
    const pp = { x: player.x, y: player.y };
    if (pending.actorId) {
      const a = actors.get(pending.actorId);
      if (a && !a.leaving && Math.hypot(pp.x - a.x, pp.y - a.y) <= INTERACT_REACH + 16) handlers.onInteract?.({ kind: 'worker', id: a.id });
      return;
    }
    if (pending.prop?.hit && distanceToTileRect(pp, pending.prop.hit) <= INTERACT_REACH + 6) handlers.onInteract?.(targetForProp(pending.prop));
  }
  function targetForProp(p: Prop): SceneInteractable {
    const roomId = p.slot !== undefined && p.slot >= 0 ? (roomBySlot.get(p.slot)?.id ?? `slot-${p.slot}`) : '';
    switch (p.interact?.kind) {
      case 'desk': {
        const a = p.slot !== undefined ? actorAtDesk(p.slot, p.interact.deskIndex) : null;
        return { kind: 'desk', roomId, workerId: a ? a.id : null };
      }
      case 'cabinet': return { kind: 'cabinet', roomId };
      case 'shelf': return { kind: 'shelf', roomId };
      case 'computer': return { kind: 'computer', roomId };
      case 'board': return { kind: 'board', roomId };
      case 'meeting': return { kind: 'meeting', roomId: meetingRoomId() };
      default: return { kind: 'reception' };
    }
  }
  function labelFor(t: SceneInteractable, actor: Actor | null, p: Prop | null): string {
    const roomName = (roomId: string) => roomById.get(roomId)?.name ?? (p && p.slot !== undefined && p.slot >= 0 ? 'Sala livre' : '');
    switch (t.kind) {
      case 'worker': return `Conversar com ${actor?.data.name ?? 'funcionário'}`;
      case 'desk': {
        const a = t.workerId ? actors.get(t.workerId) : null;
        return a ? `Mesa de ${a.data.name}` : `Mesa livre · ${roomName(t.roomId)}`;
      }
      case 'cabinet': return `Armário de projetos · ${roomName(t.roomId)}`;
      case 'shelf': return 'Estante de skills';
      case 'computer': return 'Computador · ferramentas do projeto';
      case 'board': return `Quadro: fila e andamento · ${roomName(t.roomId)}`;
      case 'reception': return 'Balcão da recepção';
      case 'meeting': return 'Mesa de reunião';
    }
  }
  function updateInteractable(): void {
    let next: Interactable | null = null;
    if (player) {
      const pp = { x: player.x, y: player.y };
      let bestScore = Infinity;
      for (const a of actors.values()) {
        if (a.leaving) continue;
        const d = Math.hypot(pp.x - a.x, pp.y - a.y);
        if (d > INTERACT_REACH + 10) continue;
        const score = d - 24; // conversar com quem está perto vale mais do que a mesa/armário ao lado
        if (score < bestScore) {
          bestScore = score;
          const target: SceneInteractable = { kind: 'worker', id: a.id };
          next = { target, label: labelFor(target, a, null), key: interactableKey(target), prop: null, actor: a };
        }
      }
      for (const p of layout.props) {
        if (!p.interact || !p.hit) continue;
        const d = distanceToTileRect(pp, p.hit);
        if (d > INTERACT_REACH) continue;
        if (d < bestScore) {
          bestScore = d;
          const target = targetForProp(p);
          next = { target, label: labelFor(target, null, p), key: interactableKey(target), prop: p, actor: null };
        }
      }
    }
    const prevKey = interactable?.key ?? null;
    const nextKey = next?.key ?? null;
    const prevLabel = interactable?.label ?? null;
    interactable = next;
    if (prevKey !== nextKey || prevLabel !== (next?.label ?? null)) {
      dirty = true;
      handlers.onInteractableChange?.(next ? next.target : null, next ? next.label : null);
    }
  }
  function fireInteract(): void {
    if (!interactable) return;
    handlers.onInteract?.(interactable.target);
  }
  function updatePlayerRoom(): void {
    if (!player) return;
    const slot = slotAtTile(layout.grid, tileOfPoint(player));
    const id = slot >= 0 ? (roomBySlot.get(slot)?.id ?? null) : null;
    if (id !== player.roomId) {
      player.roomId = id;
      handlers.onEnterRoom?.(id);
    }
  }
  function stepPlayerTick(dt: number): void {
    if (!player) return;
    const input = opts.inputEnabled ? keyInput() : NO_INPUT;
    const v = moveVector(input);
    let moved = false;
    if (v.x !== 0 || v.y !== 0) {
      if (player.path.length) stopPlayerPath();
      const r = stepPlayer({ x: player.x, y: player.y }, v, dt, walkBase, PLAYER_SPEED);
      player.x = r.pos.x;
      player.y = r.pos.y;
      player.dir = v.x !== 0 && v.y !== 0 ? (Math.abs(v.x) >= Math.abs(v.y) ? (v.x > 0 ? 'right' : 'left') : (v.y > 0 ? 'down' : 'up')) : (v.x > 0 ? 'right' : v.x < 0 ? 'left' : v.y > 0 ? 'down' : 'up');
      moved = r.moved;
    } else if (player.path.length && player.pathIdx < player.path.length) {
      const r = stepAlongPath({ x: player.x, y: player.y }, player.path, player.pathIdx, dt, PLAYER_SPEED);
      moved = r.pos.x !== player.x || r.pos.y !== player.y;
      player.x = r.pos.x;
      player.y = r.pos.y;
      player.pathIdx = r.idx;
      if (r.dir) player.dir = r.dir;
      if (player.pathIdx >= player.path.length) {
        const pending = player.pending;
        player.path = [];
        player.pathIdx = 0;
        player.pending = null;
        if (pending) firePending(pending); else updateInteractable();
      }
    }
    if (moved) {
      player.walkT += dt;
      setPlayerMoving(true);
      reportPlayer(false);
      dirty = true;
    } else {
      setPlayerMoving(false);
    }
    updatePlayerRoom();
    updateInteractable();
  }

  // ---------------- atualização ----------------
  function stepActor(a: Actor, dt: number): void {
    if (a.path.length && a.pathIdx < a.path.length) {
      if (advancePath(a, dt)) {
        if (a.leaving) { actors.delete(a.id); return; }
        arrive(a);
      }
      return;
    }
    // ocioso sentado: olhar para os lados ou alongar (decorativo; nada que pareça trabalho)
    const pose = poseForPhase(a.data.phase);
    if (a.seated && pose.idle && !opts.reducedMotion) {
      if (a.idle && clock >= a.idle.until) { a.idle = null; a.nextIdleAt = clock + 3500 + Math.random() * 6000; }
      else if (!a.idle && clock >= a.nextIdleAt) {
        const look = Math.random() < 0.7;
        a.idle = { kind: look ? 'look' : 'stretch', until: clock + (look ? 900 : 1300), side: Math.random() < 0.5 ? 'left' : 'right' };
      }
    } else if (a.idle) {
      a.idle = null;
    }
  }

  function tick(dt: number): void {
    clock += dt;
    if (player) {
      stepPlayerTick(dt);
    } else if (keys.size && opts.inputEnabled) {
      // sem avatar: as teclas rolam a câmera (compatibilidade)
      const input = keyInput();
      const sp = (dt / 16) * 10 / cam.zoom;
      let movedCam = false;
      if (input.left) { cam.x -= sp; movedCam = true; }
      if (input.right) { cam.x += sp; movedCam = true; }
      if (input.up) { cam.y -= sp; movedCam = true; }
      if (input.down) { cam.y += sp; movedCam = true; }
      if (movedCam) { camAnim = null; clampCamera(); setMode('free'); dirty = true; }
    }
    if (camAnim) {
      const t = Math.min(1, (clock - camAnim.start) / camAnim.dur);
      const e = easeOut(t);
      cam.x = camAnim.fromX + (camAnim.toX - camAnim.fromX) * e;
      cam.y = camAnim.fromY + (camAnim.toY - camAnim.fromY) * e;
      if (t >= 1) camAnim = null;
      dirty = true;
    }
    if (player && camMode === 'follow') {
      const want = clampCameraTo(followCamera(cam, playerFocusPoint(player), cam.zoom, viewW, viewH, insets()), cam.zoom, viewW, viewH, insets());
      if (want.x !== cam.x || want.y !== cam.y) {
        if (opts.reducedMotion) { cam.x = want.x; cam.y = want.y; }
        else { cam.x = smoothTowards(cam.x, want.x, dt); cam.y = smoothTowards(cam.y, want.y, dt); }
        dirty = true;
      }
    }
    for (const a of Array.from(actors.values())) stepActor(a, dt);
    for (const ma of Array.from(meetingActors.values())) stepMeetingActor(ma, dt);
  }

  // ---------------- camada estática (zoom 1) ----------------
  function roomFont(): string { return pixelFontOk ? `8px ${FONT_PIXEL}` : `bold 9px ui-monospace, Consolas, monospace`; }

  function renderStatic(): HTMLCanvasElement {
    const cv = staticCv ?? document.createElement('canvas');
    cv.width = WORLD_W;
    cv.height = WORLD_H;
    const c = cv.getContext('2d');
    if (!c) throw new Error('canvas 2d indisponível');
    c.imageSmoothingEnabled = false;
    c.fillStyle = BG;
    c.fillRect(0, 0, WORLD_W, WORLD_H);
    const grid = layout.grid;
    const isWall = (x: number, y: number) => x < 0 || y < 0 || x >= GRID_W || y >= GRID_H || grid[y][x].kind === 'wall';
    // pisos
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      const cell = grid[y][x];
      if (cell.kind === 'wall') continue;
      const v = (x * 7 + y * 13) % 3;
      const name = cell.kind === 'carpet' ? `floor.carpet.${v}` : cell.kind === 'tile' ? `floor.tile.${(x + y) % 2}` : `floor.wood.${v}`;
      c.drawImage(cache.get(name, 1), x * TILE, y * TILE);
    }
    // tom da sala (cor da sala, bem leve); a sala de Reuniões tem cor própria mesmo sem sala no banco
    for (let s = 0; s < ROOM_SLOTS; s++) {
      const room = roomBySlot.get(s);
      const r = getRoomRect(s);
      const color = room?.color ?? (s === MEETING_SLOT ? MEETING_COLOR : null);
      if (color) {
        c.fillStyle = color;
        c.globalAlpha = 0.13;
        c.fillRect(r.x * TILE, r.y * TILE, r.w * TILE, r.h * TILE);
        c.globalAlpha = 1;
      }
    }
    // sombra das paredes sobre o piso
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      if (grid[y][x].kind === 'wall' || !isWall(x, y - 1)) continue;
      const g = c.createLinearGradient(0, y * TILE, 0, y * TILE + 6);
      g.addColorStop(0, 'rgba(0,0,0,0.26)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(x * TILE, y * TILE, TILE, 6);
    }
    // paredes com bitmask (face quando há piso abaixo; topo nos demais; bordas só junto ao piso)
    const top = cache.get('wall.top', 1);
    const face = cache.get('wall.face', 1);
    c.fillStyle = PALETTE.o;
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      if (grid[y][x].kind !== 'wall') continue;
      const n = isWall(x, y - 1), s = isWall(x, y + 1), w = isWall(x - 1, y), e = isWall(x + 1, y);
      const nw = isWall(x - 1, y - 1), ne = isWall(x + 1, y - 1), sw = isWall(x - 1, y + 1), se = isWall(x + 1, y + 1);
      if (n && s && w && e && nw && ne && sw && se) continue; // parede interna, invisível
      const px = x * TILE;
      const py = y * TILE;
      if (!s) {
        c.drawImage(face, px, py);
        if (!w) c.fillRect(px, py, 1, TILE);
        if (!e) c.fillRect(px + TILE - 1, py, 1, TILE);
      } else {
        c.drawImage(top, px, py);
        if (!n) c.fillRect(px, py, TILE, 1);
        if (!w) c.fillRect(px, py, 1, TILE);
        if (!e) c.fillRect(px + TILE - 1, py, 1, TILE);
        if (n && w && !nw) c.fillRect(px, py, 1, 1);
        if (n && e && !ne) c.fillRect(px + TILE - 1, py, 1, 1);
      }
    }
    // soleiras das portas
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      if (grid[y][x].kind !== 'door') continue;
      const px = x * TILE;
      const py = y * TILE;
      c.fillStyle = 'rgba(0,0,0,0.35)';
      if (isWall(x, y - 1)) c.fillRect(px, py, TILE, 2);
      if (isWall(x, y + 1) && y + 1 < GRID_H) c.fillRect(px, py + TILE - 2, TILE, 2);
      if (isWall(x - 1, y)) c.fillRect(px, py, 2, TILE);
      if (isWall(x + 1, y)) c.fillRect(px + TILE - 2, py, 2, TILE);
    }
    // objetos planos (mesas, assentos, tapetes, quadros na parede)
    for (const p of layout.props) if (p.flat) drawPropOn(c, p, 1, 0, 0);
    // placas com o nome das salas (fonte pixel) na parede do topo
    c.font = roomFont();
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    for (let s = 0; s < ROOM_SLOTS; s++) {
      const r = getRoomRect(s);
      const room = roomBySlot.get(s);
      const isMeeting = s === MEETING_SLOT;
      const label = (room ? room.name : isMeeting ? MEETING_LABEL : 'SALA LIVRE').toUpperCase();
      const named = !!room || isMeeting;
      const tw = Math.ceil(c.measureText(label).width);
      const cx = (r.x + r.w / 2) * TILE;
      const py = (r.y - 1) * TILE;
      const bw = tw + 12;
      c.fillStyle = PALETTE.k;
      c.fillRect(Math.round(cx - bw / 2), py + 1, bw, 14);
      c.fillStyle = room ? room.color : isMeeting ? MEETING_COLOR : PALETTE.G;
      c.fillRect(Math.round(cx - bw / 2), py + 1, bw, 1);
      c.fillRect(Math.round(cx - bw / 2), py + 14, bw, 1);
      c.fillStyle = named ? AMBER_BRIGHT : PALETTE.G;
      c.fillText(label, Math.round(cx), py + 8);
    }
    // placas de "RECEPÇÃO" e "CONVIVÊNCIA" discretas no piso
    c.fillStyle = 'rgba(255,210,122,0.5)';
    c.textAlign = 'left';
    const rec = getReceptionRect();
    const lou = getLoungeRect();
    c.fillText('RECEPÇÃO', rec.x * TILE + 4, rec.y * TILE + 8);
    c.fillText('CONVIVÊNCIA', (lou.x + 9) * TILE, lou.y * TILE + 8);
    staticCv = cv;
    staticDirty = false;
    return cv;
  }

  function drawPropOn(c: CanvasRenderingContext2D, p: Prop, zoom: number, offX: number, offY: number): void {
    const img = cache.get(p.sprite, zoom);
    const { h } = spriteSize(p.sprite);
    const wx = p.tile.x * TILE + (p.dx ?? 0);
    const wy = (p.tile.y + 1) * TILE + (p.dy ?? 0) - h;
    c.drawImage(img, Math.round((wx - offX) * zoom), Math.round((wy - offY) * zoom));
  }

  // ---------------- personagens ----------------
  interface Drawable { baseY: number; draw(): void }

  function headSprite(dir: Dir): { name: string; flip: boolean } {
    if (dir === 'up') return { name: 'c.head.up', flip: false };
    if (dir === 'down') return { name: 'c.head.down', flip: false };
    return { name: 'c.head.side', flip: dir === 'left' };
  }

  function bodySpriteWalking(dir: Dir, walkT: number): { name: string; flip: boolean } {
    const side = dir === 'left' || dir === 'right';
    const frame = Math.floor(walkT / 130) % 4;
    const step = frame === 1 ? 0 : frame === 3 ? 1 : -1;
    if (side) return { name: step < 0 ? 'c.body.stand.side' : `c.body.walk.side.${step}`, flip: dir === 'left' };
    return { name: step < 0 ? 'c.body.stand.front' : `c.body.walk.front.${step}`, flip: false };
  }

  function sitBody(body: BodyPose, a: Actor): string {
    if (a.idle?.kind === 'stretch') return 'c.body.sit.stretch';
    switch (body) {
      case 'type': return opts.reducedMotion ? 'c.body.sit.type0' : `c.body.sit.type${Math.floor((clock + a.seed * 1000) / 170) % 2}`;
      case 'read': return 'c.body.sit.armup';
      case 'wait': return 'c.body.sit.armup';
      default: return 'c.body.sit';
    }
  }

  function drawShadow(sx: number, sy: number, z: number): void {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(Math.round(sx), Math.round(sy - 1 * z), 8 * z, 3 * z, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawOutline(parts: { name: string; flip: boolean; dx: number; dy: number }[], ox: number, oy: number, z: number, color: string, alpha: number): void {
    const sil = silhouette(color);
    ctx.globalAlpha = alpha;
    for (const p of parts) {
      const img = cache.get(p.name, z, sil, p.flip);
      for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) ctx.drawImage(img, ox + p.dx * z + ddx * z, oy + p.dy * z + ddy * z);
    }
    ctx.globalAlpha = 1;
  }

  function pulse(): number { return opts.reducedMotion ? 1 : 0.65 + 0.35 * Math.sin(clock / 220); }

  function drawActor(a: Actor, z: number, offX: number, offY: number): void {
    const pose = poseForPhase(a.data.phase);
    const dyn = characterPalette(a.data.appearance, pose.ghost);
    const walking = a.path.length > 0 && a.pathIdx < a.path.length;
    const sel = selection.kind === 'worker' && selection.id === a.id;
    const hov = hovered.kind === 'worker' && hovered.id === a.id;
    const isTarget = interactable?.actor === a;
    const sx = (a.x - offX) * z;
    const sy = (a.y - offY) * z;
    drawShadow(sx, sy, z);

    const parts: { name: string; flip: boolean; dx: number; dy: number }[] = [];
    let baseLift = 0;
    if (a.seated && !walking) {
      baseLift = 3;
      const dir: Dir = a.idle?.kind === 'look' ? a.idle.side : 'up';
      const head = headSprite(dir);
      const body = sitBody(pose.body, a);
      parts.push({ name: body, flip: false, dx: -CHAR_HALF_W, dy: -SIT_BODY_H });
      parts.push({ name: head.name, flip: head.flip, dx: -CHAR_HALF_W, dy: -(SIT_BODY_H + HEAD_H) });
      if (body === 'c.body.sit.armup') {
        if (pose.body === 'read') parts.push({ name: 'c.sheet', flip: false, dx: 5, dy: -19 });
        else parts.push({ name: 'c.hand', flip: false, dx: 4, dy: -15 });
      }
    } else {
      const body = walking ? bodySpriteWalking(a.dir, a.walkT) : { name: a.dir === 'left' || a.dir === 'right' ? 'c.body.stand.side' : 'c.body.stand.front', flip: a.dir === 'left' };
      const head = headSprite(a.dir);
      parts.push({ name: body.name, flip: body.flip, dx: -CHAR_HALF_W, dy: -(CHAR_H - HEAD_H) });
      parts.push({ name: head.name, flip: head.flip, dx: -CHAR_HALF_W, dy: -CHAR_H });
    }
    const ox = Math.round(sx);
    const oy = Math.round(sy - baseLift * z);
    if (isTarget) drawOutline(parts, ox, oy, z, AMBER_BRIGHT, pulse());
    else if (sel || hov) drawOutline(parts, ox, oy, z, sel ? AMBER : 'rgba(255,255,255,0.55)', sel ? 1 : 0.7);
    if (pose.ghost) ctx.globalAlpha = 0.8;
    for (const p of parts) ctx.drawImage(cache.get(p.name, z, dyn, p.flip), ox + p.dx * z, oy + p.dy * z);
    ctx.globalAlpha = 1;
    const seatedNow = a.seated && !walking;
    const headTop = oy - (seatedNow ? SIT_BODY_H + HEAD_H : CHAR_H) * z;
    // olho = sessão observada
    if (a.data.observed) {
      const eye = cache.get('icon.eye', z);
      ctx.drawImage(eye, ox - 17 * z, headTop - 2 * z);
    }
    // bolha de estado
    let bubble = pose.bubble;
    let alpha = 1;
    if (bubble === 'done') {
      const age = clock - a.phaseSince;
      if (age > DONE_BUBBLE_MS) bubble = null;
      else if (age > DONE_BUBBLE_MS - 600) alpha = (DONE_BUBBLE_MS - age) / 600;
    }
    if (bubble) {
      const bob = opts.reducedMotion ? 0 : Math.round(Math.sin((clock + a.seed * 900) / 260));
      // sentado: a bolha flutua acima do monitor, para não esconder a tela
      const lift = seatedNow && a.seat?.kind === 'desk' ? 30 : 17;
      ctx.globalAlpha = alpha;
      ctx.drawImage(cache.get(`bubble.${bubble}`, z), ox + 2 * z, headTop - lift * z + bob * z);
      ctx.globalAlpha = 1;
    }
  }

  /** Corpo sentado do participante: gesticula enquanto responde, mão no queixo quando aguarda o Chefe. */
  function meetingSitBody(ma: MeetingActor): string {
    switch (ma.data.state) {
      case 'responding': return opts.reducedMotion ? 'c.body.sit.type0' : `c.body.sit.type${Math.floor((clock + ma.seed * 1000) / 300) % 2}`;
      case 'waiting_chefe': return 'c.body.sit.armup';
      default: return 'c.body.sit';
    }
  }

  function drawMeetingActor(ma: MeetingActor, z: number, offX: number, offY: number): void {
    const ghost = ma.data.state === 'unavailable';
    const dyn = characterPalette(ma.data.appearance ?? MEETING_APPEARANCE[ma.data.provider] ?? MEETING_APPEARANCE.claude, ghost);
    if (!ghost && !ma.data.appearance) {
      const [shirt, shade] = MEETING_SHIRT[ma.data.provider] ?? MEETING_SHIRT.claude;
      dyn.T = shirt;
      dyn.t = shade;
    }
    const walking = ma.path.length > 0 && ma.pathIdx < ma.path.length;
    const sx = (ma.x - offX) * z;
    const sy = (ma.y - offY) * z;
    drawShadow(sx, sy, z);
    const parts: { name: string; flip: boolean; dx: number; dy: number }[] = [];
    let baseLift = 0;
    const seatedNow = ma.seated && !walking;
    if (seatedNow) {
      baseLift = 3;
      const head = headSprite(ma.dir);
      const body = meetingSitBody(ma);
      parts.push({ name: body, flip: false, dx: -CHAR_HALF_W, dy: -SIT_BODY_H });
      parts.push({ name: head.name, flip: head.flip, dx: -CHAR_HALF_W, dy: -(SIT_BODY_H + HEAD_H) });
      if (body === 'c.body.sit.armup') parts.push({ name: 'c.hand', flip: false, dx: 4, dy: -15 });
    } else {
      const body = walking ? bodySpriteWalking(ma.dir, ma.walkT) : { name: ma.dir === 'left' || ma.dir === 'right' ? 'c.body.stand.side' : 'c.body.stand.front', flip: ma.dir === 'left' };
      const head = headSprite(ma.dir);
      parts.push({ name: body.name, flip: body.flip, dx: -CHAR_HALF_W, dy: -(CHAR_H - HEAD_H) });
      parts.push({ name: head.name, flip: head.flip, dx: -CHAR_HALF_W, dy: -CHAR_H });
    }
    const ox = Math.round(sx);
    const oy = Math.round(sy - baseLift * z);
    if (ghost) ctx.globalAlpha = 0.6;
    for (const p of parts) ctx.drawImage(cache.get(p.name, z, dyn, p.flip), ox + p.dx * z, oy + p.dy * z);
    ctx.globalAlpha = 1;
    const headTop = oy - (seatedNow ? SIT_BODY_H + HEAD_H : CHAR_H) * z;
    // bolha de estado: "..." animado enquanto responde, "?" aguardando o Chefe, "zz" indisponível
    const st = ma.data.state;
    const bubble = st === 'responding' ? (opts.reducedMotion ? 'talk2' : `talk${Math.floor(clock / 350) % 3}`) : st === 'waiting_chefe' ? 'question' : st === 'unavailable' ? 'disconnected' : null;
    if (bubble) {
      const bob = opts.reducedMotion ? 0 : Math.round(Math.sin((clock + ma.seed * 900) / 260));
      ctx.drawImage(cache.get(`bubble.${bubble}`, z), ox + 2 * z, headTop - 24 * z + bob * z);
    }
  }

  /** Distintivo "C"/"G" acima da cabeça (espaço de tela, nítido em qualquer zoom). */
  function drawMeetingBadge(ma: MeetingActor, z: number, offX: number, offY: number): void {
    const walking = ma.path.length > 0 && ma.pathIdx < ma.path.length;
    const seatedNow = ma.seated && !walking;
    const sx = Math.round((ma.x - offX) * z);
    const headTop = Math.round((ma.y - offY) * z) - ((seatedNow ? 3 : 0) + (seatedNow ? SIT_BODY_H + HEAD_H : CHAR_H)) * z;
    if (sx < -40 || headTop < -40 || sx > viewW + 40 || headTop > viewH + 40) return;
    const base = MEETING_BADGE[ma.data.provider] ?? MEETING_BADGE.claude;
    const badge = ma.data.initial ? { letter: ma.data.initial, color: base.color } : base;
    const size = 13;
    const x = sx - size / 2;
    const y = headTop - 6 - size;
    ctx.globalAlpha = ma.data.state === 'unavailable' ? 0.5 : 1;
    ctx.fillStyle = 'rgba(18,16,20,0.9)';
    roundRect(ctx, x, y, size, size, 3);
    ctx.fill();
    ctx.strokeStyle = badge.color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = badge.color;
    ctx.font = `700 9px ${FONT_UI}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badge.letter, sx, y + size / 2 + 0.5);
    ctx.globalAlpha = 1;
  }

  function drawPlayer(p: Player, z: number, offX: number, offY: number): void {
    const dyn = characterPalette(p.data.appearance, false, true);
    const sx = (p.x - offX) * z;
    const sy = (p.y - offY) * z;
    drawShadow(sx, sy, z);
    const walking = p.moving && !opts.reducedMotion;
    const body = walking ? bodySpriteWalking(p.dir, p.walkT) : { name: p.dir === 'left' || p.dir === 'right' ? 'c.body.stand.side' : 'c.body.stand.front', flip: p.dir === 'left' };
    const head = headSprite(p.dir);
    const parts = [
      { name: body.name, flip: body.flip, dx: -CHAR_HALF_W, dy: -(CHAR_H - HEAD_H) },
      { name: head.name, flip: head.flip, dx: -CHAR_HALF_W, dy: -CHAR_H },
    ];
    const ox = Math.round(sx);
    const oy = Math.round(sy);
    drawOutline(parts, ox, oy, z, 'rgba(240,168,48,0.45)', 1);
    for (const part of parts) ctx.drawImage(cache.get(part.name, z, dyn, part.flip), ox + part.dx * z, oy + part.dy * z);
  }

  function monitorState(slot: number, deskIndex: number): 'off' | 'on' | 'exec' {
    const a = actorAtDesk(slot, deskIndex);
    // a tela só acende com o funcionário sentado (enquanto ele anda até a mesa, fica apagada)
    return a && a.seated ? poseForPhase(a.data.phase).monitor : 'off';
  }

  function monitorSprite(state: 'off' | 'on' | 'exec'): string {
    if (state === 'exec') return opts.reducedMotion ? 'monitor.exec0' : `monitor.exec${Math.floor(clock / 420) % 2}`;
    return state === 'on' ? 'monitor.on' : 'monitor.off';
  }

  // ---------------- iluminação ----------------
  function drawLighting(z: number, offX: number, offY: number, extra: Light[]): void {
    const lcv = lightCv ?? document.createElement('canvas');
    lightCv = lcv;
    if (lcv.width !== canvas.width || lcv.height !== canvas.height) { lcv.width = canvas.width; lcv.height = canvas.height; }
    const lc = lcv.getContext('2d');
    if (!lc) return;
    lc.setTransform(dpr, 0, 0, dpr, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, viewW, viewH); // sem isto o escurecimento acumula quadro a quadro
    lc.fillStyle = 'rgba(14,9,18,0.10)'; // escurecimento base leve: escritório claro, as luzes só dão calor (v4; era 0,28)
    lc.fillRect(0, 0, viewW, viewH);
    lc.globalCompositeOperation = 'destination-out';
    const all = layout.lights.concat(extra);
    const flick = (l: Light, i: number) => opts.reducedMotion ? 1 : 1 + 0.06 * Math.sin(clock / 700 + i * 1.7) + 0.03 * Math.sin(clock / 230 + i);
    for (let i = 0; i < all.length; i++) {
      const l = all[i];
      const x = (l.x - offX) * z;
      const y = (l.y - offY) * z;
      const r = l.radius * z;
      if (x + r < 0 || y + r < 0 || x - r > viewW || y - r > viewH) continue;
      const g = lc.createRadialGradient(x, y, 0, x, y, r);
      const st = Math.min(1, l.strength * 3.4 * flick(l, i));
      g.addColorStop(0, `rgba(0,0,0,${st})`);
      g.addColorStop(0.55, `rgba(0,0,0,${st * 0.45})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lc.fillStyle = g;
      lc.fillRect(x - r, y - r, r * 2, r * 2);
    }
    lc.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(lcv, 0, 0);
    ctx.restore();
    // halos coloridos (aditivos)
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < all.length; i++) {
      const l = all[i];
      const x = (l.x - offX) * z;
      const y = (l.y - offY) * z;
      const r = l.radius * z * 0.8;
      if (x + r < 0 || y + r < 0 || x - r > viewW || y - r > viewH) continue;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = l.strength * 0.42 * flick(l, i);
      g.addColorStop(0, hexA(l.color, a));
      g.addColorStop(1, hexA(l.color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    // vinheta leve
    const v = ctx.createRadialGradient(viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.55, viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.9);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.08)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, viewW, viewH);
  }

  function hexA(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  }

  // ---------------- rótulos (espaço de tela, Inter) ----------------
  type LabelStyle = 'normal' | 'selected' | 'hover' | 'player';
  interface LabelSpec { sx: number; y: number; name: string; detail: string | null; style: LabelStyle; color: string; w: number; h: number }
  const LABEL_PRIORITY: Record<LabelStyle, number> = { selected: 0, player: 1, hover: 2, normal: 3 };

  function labelSize(name: string, detail: string | null): { w: number; h: number } {
    ctx.font = `600 11px ${FONT_UI}`;
    const nameW = ctx.measureText(truncate(ctx, name, 150)).width;
    ctx.font = `400 10px ${FONT_UI}`;
    const detW = detail ? ctx.measureText(truncate(ctx, detail, 170)).width : 0;
    return { w: Math.ceil(Math.max(nameW, detW)) + 14, h: detail ? 30 : 18 };
  }

  /**
   * Rótulos que se encostariam (dois funcionários em mesas vizinhas, nome comprido) descem uma linha em vez de se
   * sobrepor. Os mais importantes (selecionado, você, sob o mouse) ficam no lugar e são desenhados por cima.
   */
  function layoutLabels(specs: LabelSpec[]): LabelSpec[] {
    const ordered = [...specs].sort((a, b) => LABEL_PRIORITY[a.style] - LABEL_PRIORITY[b.style] || a.y - b.y || a.sx - b.sx);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const hits = (x: number, y: number, w: number, h: number) => placed.some(r => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y);
    for (const s of ordered) {
      const x = Math.round(s.sx - s.w / 2);
      let y = s.y;
      for (let i = 0; i < 4 && hits(x, y, s.w, s.h); i++) y += s.h + 3;
      s.y = y;
      placed.push({ x, y, w: s.w, h: s.h });
    }
    return ordered.reverse(); // desenha do menos para o mais importante
  }

  function drawLabelBox(sx: number, y: number, name: string, detail: string | null, style: LabelStyle, detailColor = '#a89f93'): void {
    ctx.font = `600 11px ${FONT_UI}`;
    const nameTxt = truncate(ctx, name, 150);
    ctx.font = `400 10px ${FONT_UI}`;
    const detTxt = detail ? truncate(ctx, detail, 170) : '';
    const { w, h } = labelSize(name, detail);
    const x = Math.round(sx - w / 2);
    ctx.fillStyle = style === 'selected' ? 'rgba(42,30,10,0.9)' : style === 'player' ? 'rgba(30,22,8,0.9)' : 'rgba(18,16,20,0.82)';
    roundRect(ctx, x, y, w, h, 5);
    ctx.fill();
    ctx.strokeStyle = style === 'selected' || style === 'player' ? AMBER : style === 'hover' ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = style === 'selected' || style === 'player' ? AMBER_BRIGHT : '#ece6dc';
    ctx.font = `600 11px ${FONT_UI}`;
    ctx.fillText(nameTxt, sx, y + 9.5);
    if (detail) {
      ctx.fillStyle = detailColor;
      ctx.font = `400 10px ${FONT_UI}`;
      ctx.fillText(detTxt, sx, y + 21.5);
    }
  }

  function drawLabels(z: number, offX: number, offY: number): void {
    if (!opts.showLabels) return;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const specs: LabelSpec[] = [];
    const add = (sx: number, y: number, name: string, detail: string | null, style: LabelStyle, color: string) => { const { w, h } = labelSize(name, detail); specs.push({ sx, y, name, detail, style, color, w, h }); };
    for (const a of actors.values()) {
      if (a.leaving) continue;
      const sel = selection.kind === 'worker' && selection.id === a.id;
      const hov = hovered.kind === 'worker' && hovered.id === a.id;
      const sx = Math.round((a.x - offX) * z);
      const sy = Math.round((a.y - offY) * z);
      if (sx < -200 || sy < -60 || sx > viewW + 200 || sy > viewH + 60) continue;
      const showDetail = z >= 2 || sel || hov;
      const detail = a.data.detail || phaseLabel(a.data.phase);
      const color = a.data.phase === 'error' ? '#e36a5a' : a.data.phase === 'disconnected' ? '#8b8793' : '#a89f93';
      add(sx, sy + 3, a.data.name, showDetail ? detail : null, sel ? 'selected' : hov ? 'hover' : 'normal', color);
    }
    for (const ma of meetingActors.values()) {
      if (ma.leaving) continue;
      const sx = Math.round((ma.x - offX) * z);
      const sy = Math.round((ma.y - offY) * z);
      if (sx < -200 || sy < -60 || sx > viewW + 200 || sy > viewH + 60) continue;
      const st = ma.data.state;
      const color = st === 'unavailable' ? '#8b8793' : st === 'interrupted' ? '#e36a5a' : st === 'responding' ? AMBER_BRIGHT : '#a89f93';
      add(sx, sy + 3, ma.data.name, participantLabel(st), 'normal', color);
    }
    if (player) {
      const sx = Math.round((player.x - offX) * z);
      const sy = Math.round((player.y - offY) * z);
      add(sx, sy + 3, `${player.data.name} · Você`, null, 'player', '#a89f93');
    }
    for (const s of layoutLabels(specs)) drawLabelBox(s.sx, s.y, s.name, s.detail, s.style, s.color);
  }

  /** Contorno pulsante e tecla "E" no alvo de interação. */
  function drawInteractHint(z: number, offX: number, offY: number): void {
    if (!interactable || !player) return;
    const a = pulse();
    let topX: number;
    let topY: number;
    let belowY: number; // alternativa quando a dica não cabe acima do alvo (alvo encostado no topo da tela)
    if (interactable.actor) {
      const act = interactable.actor;
      topX = Math.round((act.x - offX) * z);
      topY = Math.round((act.y - offY) * z) - (act.seated ? SIT_BODY_H + HEAD_H + 3 : CHAR_H) * z - 6 * z;
      belowY = Math.round((act.y - offY) * z) + 36;
    } else if (interactable.prop) {
      const p = interactable.prop;
      const { w, h } = spriteSize(p.sprite);
      const r = propPixelRect(p, h, w);
      const x = Math.round((r.x - offX) * z);
      const y = Math.round((r.y - offY) * z);
      ctx.strokeStyle = `rgba(255,210,122,${(0.45 + 0.55 * a).toFixed(3)})`;
      ctx.lineWidth = 2;
      roundRect(ctx, x - 2, y - 2, r.w * z + 4, r.h * z + 4, 3);
      ctx.stroke();
      topX = x + (r.w * z) / 2;
      topY = y - 6;
      belowY = y + r.h * z + 8;
    } else return;
    const key = cache.get('icon.key.e', 2);
    const bob = opts.reducedMotion ? 0 : Math.round(Math.sin(clock / 260) * 2);
    // sem espaço acima (alvo na parede do topo), a dica vai para baixo do alvo
    if (topY - key.height + bob < 4) topY = belowY + key.height;
    ctx.font = `600 11px ${FONT_UI}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const txt = interactable.label;
    const tw = Math.ceil(ctx.measureText(txt).width) + 12;
    // tecla + texto ficam dentro da área útil (deslocam para a esquerda junto à borda direita)
    const total = key.width + 4 + tw;
    const right = viewW - Math.max(0, insets().right) - 6;
    let keyX = Math.round(topX - key.width / 2);
    if (keyX + total > right) keyX = Math.max(4, right - total);
    ctx.globalAlpha = 0.75 + 0.25 * a;
    ctx.drawImage(key, keyX, Math.round(topY - key.height + bob));
    ctx.globalAlpha = 1;
    // texto da dica ao lado da tecla
    const bx = keyX + key.width + 4;
    const by = Math.round(topY - key.height + bob + 1);
    ctx.fillStyle = 'rgba(30,22,8,0.92)';
    roundRect(ctx, bx, by, tw, key.height - 2, 5);
    ctx.fill();
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = AMBER_BRIGHT;
    ctx.fillText(txt, bx + 6, by + (key.height - 2) / 2);
    ctx.textAlign = 'center';
  }

  // ---------------- quadro ----------------
  function render(): void {
    const z = cam.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Reduzindo (visão geral em telas baixas) a suavização evita sumir linha de 1 px; ampliando, pixel nítido.
    ctx.imageSmoothingEnabled = z < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, viewW, viewH);
    const offX = Math.round(cam.x * z) / z;  // alinha a pixels de tela
    const offY = Math.round(cam.y * z) / z;
    if (staticDirty || !staticCv) renderStatic();
    const sc = staticCv as HTMLCanvasElement;
    // recorte visível da camada estática
    const sx0 = Math.max(0, Math.floor(offX));
    const sy0 = Math.max(0, Math.floor(offY));
    const sx1 = Math.min(WORLD_W, Math.ceil(offX + viewW / z));
    const sy1 = Math.min(WORLD_H, Math.ceil(offY + viewH / z));
    if (sx1 > sx0 && sy1 > sy0) {
      ctx.drawImage(sc, sx0, sy0, sx1 - sx0, sy1 - sy0, Math.round((sx0 - offX) * z), Math.round((sy0 - offY) * z), (sx1 - sx0) * z, (sy1 - sy0) * z);
    }
    // realce da sala sob o cursor
    if (hovered.kind === 'room' && !(selection.kind === 'room' && selection.id === hovered.id)) {
      const slot = slotOfRoom(hovered.id);
      if (slot >= 0) {
        const r = getRoomRect(slot);
        ctx.fillStyle = 'rgba(255,210,122,0.07)';
        ctx.fillRect((r.x * TILE - offX) * z, (r.y * TILE - offY) * z, r.w * TILE * z, r.h * TILE * z);
      }
    }
    // monitores (estado real por mesa) e luzes dos monitores
    const extraLights: Light[] = [];
    for (let s = 0; s < ROOM_SLOTS; s++) {
      const dual = layout.rooms[s]?.dualMonitors ?? false;
      getDeskPositions(s).forEach((d, i) => {
        const st = monitorState(s, i);
        const name = monitorSprite(st);
        const img = cache.get(name, z);
        const wx = d.desk.x * TILE;
        const wy = d.desk.y * TILE - 7;
        const xs = dual ? [wx + 1, wx + 17] : [wx + 9];
        for (const x of xs) ctx.drawImage(img, Math.round((x - offX) * z), Math.round((wy - offY) * z));
        if (st !== 'off') extraLights.push({ x: wx + 16, y: wy + 6, radius: 26, color: st === 'exec' ? '#7cc47f' : '#8fb8e8', strength: 0.22 });
      });
    }
    // objetos altos + personagens + encostos + avatar, ordenados por profundidade
    const list: Drawable[] = [];
    for (const p of layout.props) {
      if (p.flat) continue;
      list.push({ baseY: (p.tile.y + 1) * TILE + (p.dy ?? 0), draw: () => drawPropOn(ctx, p, z, offX, offY) });
    }
    for (let s = 0; s < ROOM_SLOTS; s++) {
      for (const d of getDeskPositions(s)) {
        const by = (d.chair.y + 1) * TILE;
        list.push({ baseY: by, draw: () => ctx.drawImage(cache.get('chair.back', z), Math.round((d.chair.x * TILE - offX) * z), Math.round((by - 8 - offY) * z)) });
      }
    }
    // encostos das cadeiras da reunião: quem olha para cima tem o encosto à frente (por cima); nos demais fica atrás
    for (const s of getMeetingSeats(MEETING_SLOT)) {
      const by = (s.tile.y + 1) * TILE;
      const front = s.face === 'up';
      list.push({ baseY: front ? by : s.tile.y * TILE + 1, draw: () => ctx.drawImage(cache.get('chair.back', z), Math.round((s.tile.x * TILE - offX) * z), Math.round(((front ? by - 8 : by - TILE - 6) - offY) * z)) });
    }
    for (const a of actors.values()) list.push({ baseY: a.y - 0.5, draw: () => drawActor(a, z, offX, offY) });
    for (const ma of meetingActors.values()) list.push({ baseY: ma.y - 0.5, draw: () => drawMeetingActor(ma, z, offX, offY) });
    if (player) { const p = player; list.push({ baseY: p.y - 0.25, draw: () => drawPlayer(p, z, offX, offY) }); }
    list.sort((p, q) => p.baseY - q.baseY);
    for (const d of list) d.draw();
    // iluminação
    drawLighting(z, offX, offY, extraLights);
    // contorno da sala selecionada
    if (selection.kind === 'room') {
      const slot = slotOfRoom(selection.id);
      if (slot >= 0) {
        const r = getRoomRect(slot);
        ctx.strokeStyle = AMBER;
        ctx.lineWidth = 2;
        roundRect(ctx, (r.x * TILE - offX) * z - 1, (r.y * TILE - offY) * z - 1, r.w * TILE * z + 2, r.h * TILE * z + 2, 3);
        ctx.stroke();
      }
    }
    // objeto interativo sob o cursor
    if (hoveredProp && hoveredProp !== interactable?.prop) {
      const { w, h } = spriteSize(hoveredProp.sprite);
      const r = propPixelRect(hoveredProp, h, w);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      roundRect(ctx, Math.round((r.x - offX) * z) - 1.5, Math.round((r.y - offY) * z) - 1.5, r.w * z + 3, r.h * z + 3, 3);
      ctx.stroke();
    }
    drawLabels(z, offX, offY);
    for (const ma of meetingActors.values()) if (!ma.leaving) drawMeetingBadge(ma, z, offX, offY);
    drawInteractHint(z, offX, offY);
  }

  // ---------------- laço ----------------
  function frame(now: number): void {
    raf = 0;
    if (destroyed) return;
    if (!lastTick) lastTick = now;
    const dt = Math.min(50, now - lastTick);
    lastTick = now;
    tick(dt);
    const animating = actors.size > 0 || meetingActors.size > 0 || camAnim !== null || keys.size > 0 || !opts.reducedMotion || (player?.path.length ?? 0) > 0;
    if (dirty || (animating && now - lastFrame >= FRAME_MS)) {
      lastFrame = now;
      dirty = false;
      render();
    }
    schedule();
  }
  function schedule(): void {
    if (destroyed || raf || opts.paused || (typeof document !== 'undefined' && document.hidden)) return;
    raf = requestAnimationFrame(frame);
  }
  function onVisibility(): void {
    keys.clear();
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; }
    else { lastTick = 0; dirty = true; schedule(); }
  }

  // ---------------- interação ----------------
  function actorAt(sx: number, sy: number): Actor | null {
    const w = screenToWorld(sx, sy);
    let best: Actor | null = null;
    for (const a of actors.values()) {
      if (a.leaving) continue;
      const h = a.seated ? SIT_BODY_H + HEAD_H + 3 : CHAR_H;
      if (w.x >= a.x - CHAR_HALF_W && w.x <= a.x + CHAR_HALF_W && w.y >= a.y - h && w.y <= a.y + 1) {
        if (!best || a.y > best.y) best = a;
      }
    }
    return best;
  }
  function propAt(sx: number, sy: number): Prop | null {
    const w = screenToWorld(sx, sy);
    let best: Prop | null = null;
    for (const p of layout.props) {
      if (!p.interact) continue;
      const { w: pw, h: ph } = spriteSize(p.sprite);
      const r = propPixelRect(p, ph, pw);
      if (w.x >= r.x && w.x < r.x + r.w && w.y >= r.y && w.y < r.y + r.h) {
        if (!best || r.y + r.h > (best.tile.y + 1) * TILE) best = p;
      }
    }
    return best;
  }
  function hitTest(sx: number, sy: number): SceneSelection {
    const a = actorAt(sx, sy);
    if (a) return { kind: 'worker', id: a.id };
    const w = screenToWorld(sx, sy);
    const tx = Math.floor(w.x / TILE);
    const ty = Math.floor(w.y / TILE);
    if (tx >= 0 && ty >= 0 && tx < GRID_W && ty < GRID_H) {
      const slot = layout.grid[ty][tx].slot;
      const room = slot >= 0 ? roomBySlot.get(slot) : undefined;
      if (room) return { kind: 'room', id: room.id };
    }
    return { kind: 'none' };
  }
  function sameSel(a: SceneSelection, b: SceneSelection): boolean {
    return a.kind === b.kind && (a.kind === 'none' || (b.kind !== 'none' && a.id === b.id));
  }
  function updateHover(sx: number, sy: number): void {
    const h = hitTest(sx, sy);
    const p = h.kind === 'worker' ? null : propAt(sx, sy);
    if (p !== hoveredProp) { hoveredProp = p; dirty = true; }
    if (!sameSel(h, hovered)) {
      hovered = h;
      handlers.onHover?.(h);
      dirty = true;
    }
    canvas.style.cursor = drag?.moved ? 'grabbing' : h.kind === 'worker' || p ? 'pointer' : player ? 'crosshair' : 'grab';
  }
  function localPos(e: PointerEvent | MouseEvent | WheelEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const p = localPos(e);
    drag = { id: e.pointerId, sx: p.x, sy: p.y, cx: cam.x, cy: cam.y, moved: false };
    canvas.setPointerCapture(e.pointerId);
    if (!isEditableTarget(document.activeElement)) canvas.focus({ preventScroll: true });
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = localPos(e);
    if (drag && drag.id === e.pointerId) {
      const dx = p.x - drag.sx;
      const dy = p.y - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) { drag.moved = true; canvas.style.cursor = 'grabbing'; setMode('free'); }
      if (drag.moved) {
        camAnim = null;
        cam.x = drag.cx - dx / cam.zoom;
        cam.y = drag.cy - dy / cam.zoom;
        clampCamera();
        dirty = true;
      }
      return;
    }
    updateHover(p.x, p.y);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return;
    const wasClick = !drag.moved;
    drag = null;
    const p = localPos(e);
    if (wasClick) handleClick(p.x, p.y);
    updateHover(p.x, p.y);
  };
  function handleClick(sx: number, sy: number): void {
    const a = actorAt(sx, sy);
    if (a) {
      selection = { kind: 'worker', id: a.id };
      handlers.onSelect(selection);
      if (player && opts.inputEnabled) walkPlayerToActor(a);
      dirty = true;
      return;
    }
    const p = propAt(sx, sy);
    if (p) {
      // Marco 1: o clique abre o painel NA HORA; andar até o objeto é só animação (opcional, nunca condição).
      handlers.onInteract?.(targetForProp(p));
      if (player && opts.inputEnabled) walkPlayerToProp(p, false);
      dirty = true;
      return;
    }
    const h = hitTest(sx, sy);
    selection = h;
    handlers.onSelect(h);
    if (player && opts.inputEnabled) api.walkTo(screenToWorld(sx, sy));
    dirty = true;
  }
  const onPointerLeave = () => {
    if (hovered.kind !== 'none') { hovered = { kind: 'none' }; handlers.onHover?.(hovered); dirty = true; }
    if (hoveredProp) { hoveredProp = null; dirty = true; }
  };
  const onDblClick = (e: MouseEvent) => {
    const p = localPos(e);
    const a = actorAt(p.x, p.y);
    if (a) handlers.onOpenWorker?.(a.id);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = localPos(e);
    const before = cam.zoom;
    if (e.deltaY < 0) setZoom(cam.zoom + 1, p.x, p.y);
    else if (e.deltaY > 0) setZoom(cam.zoom - 1, p.x, p.y);
    if (cam.zoom !== before) setMode('free');
  };
  const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'd', 'w', 's']);
  function normKey(e: KeyboardEvent): string { return e.key.length === 1 ? e.key.toLowerCase() : e.key; }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // atalhos de edição (Ctrl+C/V/X/Z/A...) nunca são roubados
    if (!opts.inputEnabled || isEditableTarget(e.target as Element | null) || isEditableTarget(document.activeElement)) return;
    const k = normKey(e);
    if (MOVE_KEYS.has(k)) { if (!keys.has(k)) { keys.add(k); dirty = true; } e.preventDefault(); return; }
    if (k === 'e' && player) { if (!e.repeat) api.interact(); e.preventDefault(); return; }
    if (k === '+' || k === '=') { api.zoomBy(1); e.preventDefault(); }
    else if (k === '-' || k === '_') { api.zoomBy(-1); e.preventDefault(); }
    else if (k === '0') { api.fitAll(); e.preventDefault(); }
    // Espaço alterna "ver empresa" (planta inteira) e "explorar" (câmera no avatar), como os botões do palco.
    else if (k === ' ' && player) { if (api.getCameraMode() === 'overview') api.followPlayer(); else api.fitAll(); e.preventDefault(); }
    // Esc, F2, Delete e demais teclas ficam para o App
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = normKey(e);
    if (keys.delete(k)) dirty = true;
  };
  const onBlur = () => { keys.clear(); dirty = true; };

  canvas.tabIndex = canvas.tabIndex >= 0 ? canvas.tabIndex : 0;
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';
  canvas.style.outline = 'none';
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  // ---------------- API ----------------
  const api: OfficeScene = {
    setRooms(next) {
      rooms = next.slice();
      roomBySlot = new Map();
      roomById = new Map();
      for (const r of rooms) {
        roomById.set(r.id, r);
        if (r.slot >= 0 && r.slot < ROOM_SLOTS && !roomBySlot.has(r.slot)) roomBySlot.set(r.slot, r);
      }
      rebuildLayoutIfNeeded();
      staticDirty = true; // nomes/cores podem ter mudado
      for (const a of actors.values()) assignSeat(a, true);
      if (player) { player.roomId = null; updatePlayerRoom(); }
      updateInteractable();
      dirty = true;
    },
    setWorkers(next) {
      const seen = new Set<string>();
      for (const w of next) {
        seen.add(w.id);
        const a = actors.get(w.id);
        if (!a) { spawnActor(w); continue; }
        const prev = a.data;
        a.data = w;
        if (a.leaving) { a.leaving = false; assignSeat(a, false); }
        if (prev.phase !== w.phase) { a.phaseSince = clock; a.idle = null; }
        if (prev.roomId !== w.roomId || prev.deskIndex !== w.deskIndex) assignSeat(a, true);
      }
      for (const a of Array.from(actors.values())) if (!seen.has(a.id) && !a.leaving) startLeaving(a);
      if (selection.kind === 'worker' && !seen.has(selection.id)) selection = { kind: 'none' };
      updateInteractable();
      dirty = true;
    },
    setMeeting(next) {
      meeting = next;
      const wanted = next && next.active ? next.actors : [];
      const seen = new Set<string>();
      for (const d of wanted) {
        seen.add(d.id);
        const ma = meetingActors.get(d.id);
        if (!ma) { spawnMeetingActor(d); continue; }
        const prev = ma.data;
        ma.data = d;
        if (prev.state !== d.state) ma.stateSince = clock;
        if (ma.leaving || prev.seat !== d.seat) assignMeetingSeat(ma);
      }
      for (const ma of Array.from(meetingActors.values())) if (!seen.has(ma.id) && !ma.leaving) startMeetingLeaving(ma);
      dirty = true;
    },
    setOptions(patch) {
      const prevReduced = opts.reducedMotion;
      const wasPaused = Boolean(opts.paused);
      const { insets: nextInsets, ...rest } = patch;
      Object.assign(opts, rest);
      if (nextInsets) opts.insets = { ...NO_INSETS, ...nextInsets };
      // zoom nas opções é um comando (OfficeCanvas só repassa quando o App muda o valor): aplica quando difere do atual
      if (patch.zoom !== undefined && clampZoom(patch.zoom) !== cam.zoom) {
        const before = cam.zoom;
        if (camMode === 'follow' && player) {
          const s = worldToScreen(playerFocusPoint(player).x, playerFocusPoint(player).y);
          setZoom(patch.zoom, s.x, s.y);
        } else setZoom(patch.zoom);
        if (cam.zoom !== before && camMode === 'overview') setMode('free');
      }
      if (!prevReduced && opts.reducedMotion) {
        // sem animação: todo mundo vai direto para o lugar
        for (const a of Array.from(actors.values())) {
          if (a.leaving) { actors.delete(a.id); continue; }
          if (a.seat && a.path.length) { teleport(a, a.seat.tile); arrive(a); }
          a.idle = null;
        }
        for (const ma of Array.from(meetingActors.values())) {
          if (ma.leaving) { meetingActors.delete(ma.id); continue; }
          if (ma.seat && ma.path.length) { teleport(ma, ma.seat.tile); meetingArrive(ma); }
        }
        camAnim = null;
      }
      if (patch.inputEnabled === false) keys.clear();
      if (nextInsets) {
        if (camMode === 'overview') fitAll(); else clampCamera();
      }
      dirty = true;
      if (wasPaused && !opts.paused) { dirty = true; schedule(); }
    },
    getOptions() { return { ...opts, insets: { ...opts.insets }, zoom: cam.zoom }; },
    select(sel) { selection = sel; dirty = true; },
    focusRoom(roomId, animate = true) {
      const slot = slotOfRoom(roomId);
      if (slot < 0) return;
      const c = roomCenterPx(slot);
      setMode('free');
      centerOn(c.x, c.y, animate);
    },
    focusWorker(workerId, animate = true) {
      const a = actors.get(workerId);
      if (!a) return;
      const target = a.seat && !a.leaving ? { x: a.seat.tile.x * TILE + TILE / 2, y: a.seat.tile.y * TILE } : { x: a.x, y: a.y - 12 };
      setMode('free');
      centerOn(target.x, target.y, animate);
    },
    zoomBy(delta) {
      // "Afastar" abaixo do zoom da visão geral (que pode ser fracionário) volta para a visão geral, em vez de pular de 0,8 para 1.
      if (delta < 0 && cam.zoom - 1 < fitZoomFor(viewW, viewH, insets())) { fitAll(); return; }
      const before = cam.zoom;
      if (camMode === 'follow' && player) {
        const s = worldToScreen(playerFocusPoint(player).x, playerFocusPoint(player).y);
        setZoom(cam.zoom + Math.round(delta), s.x, s.y);
      } else {
        setZoom(cam.zoom + Math.round(delta));
        if (cam.zoom !== before && camMode === 'overview') setMode('free');
      }
    },
    fitAll() { fitAll(); },
    resetView() { fitAll(); },

    setPlayer(p) {
      if (!p) {
        if (player) { player = null; keys.clear(); updateInteractable(); dirty = true; }
        return;
      }
      if (player) { player.data = p; dirty = true; return; }
      const pos = safePlayerPosition(savedPlayerPos, walkBase, PLAYER_START);
      player = { data: p, x: pos.x, y: pos.y, dir: 'down', walkT: 0, moving: false, path: [], pathIdx: 0, pending: null, lastReportAt: -Infinity, roomId: null };
      updatePlayerRoom();
      updateInteractable();
      dirty = true;
    },
    setPlayerPosition(pos) {
      savedPlayerPos = pos ? { x: pos.x, y: pos.y } : null;
      if (!player) return;
      const safe = safePlayerPosition(pos, walkBase, PLAYER_START);
      player.x = safe.x;
      player.y = safe.y;
      stopPlayerPath();
      setPlayerMoving(false);
      updatePlayerRoom();
      updateInteractable();
      dirty = true;
    },
    getPlayerPosition() { return player ? { x: Math.round(player.x), y: Math.round(player.y) } : null; },
    walkTo(pos) {
      if (!player) return;
      const want = tileOfPoint({ x: pos.x, y: pos.y + 1 });
      const target = nearestWalkable(walkBase, want, 4);
      if (!target) return;
      const here = tileOfPoint(player);
      if (here.x === target.x && here.y === target.y) {
        // mesmo tile: só ajusta para o ponto clicado se for pisável
        const p = { x: pos.x, y: pos.y };
        if (canStand(walkBase, p)) { player.path = [p]; player.pathIdx = 0; player.pending = null; dirty = true; }
        return;
      }
      walkPlayerTo(target, null);
    },
    interact() { fireInteract(); },

    setCameraMode(mode) {
      if (mode === 'overview') { fitAll(); return; }
      if (mode === 'follow') { if (player) { setMode('follow'); camAnim = null; } return; }
      setMode('free');
    },
    getCameraMode() { return camMode; },
    followPlayer() { if (player) { setMode('follow'); camAnim = null; dirty = true; } },
    getMinimap(): MinimapData {
      const roomsOut: MinimapData['rooms'] = [];
      for (let s = 0; s < ROOM_SLOTS; s++) {
        const r = getRoomRect(s);
        const room = roomBySlot.get(s);
        const isMeeting = s === MEETING_SLOT;
        roomsOut.push({
          id: room?.id ?? (isMeeting ? 'meeting' : `slot-${s}`), name: room?.name ?? (isMeeting ? MEETING_LABEL : 'Sala livre'),
          color: room?.color ?? (isMeeting ? MEETING_COLOR : '#6e6578'), x: r.x * TILE, y: r.y * TILE, w: r.w * TILE, h: r.h * TILE,
        });
      }
      const workersOut: MinimapData['workers'] = [];
      for (const a of actors.values()) {
        if (a.leaving) continue;
        const room = roomById.get(a.data.roomId);
        workersOut.push({ id: a.id, x: Math.round(a.x), y: Math.round(a.y), color: a.data.phase === 'disconnected' ? '#8b8793' : (room?.color ?? '#ece6dc') });
      }
      for (const ma of meetingActors.values()) {
        if (ma.leaving) continue;
        workersOut.push({ id: ma.id, x: Math.round(ma.x), y: Math.round(ma.y), color: ma.data.state === 'unavailable' ? '#8b8793' : (MEETING_BADGE[ma.data.provider] ?? MEETING_BADGE.claude).color });
      }
      return {
        world: { w: WORLD_W, h: WORLD_H },
        rooms: roomsOut,
        workers: workersOut,
        player: player ? { x: Math.round(player.x), y: Math.round(player.y) } : null,
        view: visibleWorldRect(cam, cam.zoom, viewW, viewH, insets()),
      };
    },
    lookAt(pos) {
      setMode('free');
      centerOn(pos.x, pos.y, false);
    },

    resize() {
      const parent = canvas.parentElement;
      const w = Math.max(1, Math.floor(parent ? parent.clientWidth : canvas.clientWidth));
      const h = Math.max(1, Math.floor(parent ? parent.clientHeight : canvas.clientHeight));
      dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      viewW = w;
      viewH = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
      if (camMode === 'overview') fitAll(); else clampCamera();
      dirty = true;
      schedule();
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      cache.clear();
      actors.clear();
      meetingActors.clear();
      meeting = null;
      player = null;
    },
  };

  api.resize();
  fitAll();
  return api;
}

export { FIT_MARGIN, ZOOM_MAX, ZOOM_MIN };
