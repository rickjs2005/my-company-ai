// Avatar do usuário: funções puras (sem DOM) de movimento, colisão e posição segura.
// Posição = centro dos pés em px do mundo (x no meio, y na base). A colisão usa uma caixinha ao redor dos pés,
// testada tile a tile contra a grade de caminhada (paredes e móveis bloqueiam; portas são passagem).

import { GRID_H, GRID_W, type Tile } from './layout';
import { TILE } from './sprites';

export interface PlayerInput { up: boolean; down: boolean; left: boolean; right: boolean }
export interface Vec { x: number; y: number }
export type Dir = 'up' | 'down' | 'left' | 'right';

/** Velocidade do avatar em px do mundo por segundo (6 tiles/s). */
export const PLAYER_SPEED = 96;
/** Meia largura e altura da caixa de colisão dos pés (px do mundo). */
export const FEET_HALF_W = 5;
export const FEET_H = 5;
/** Distância máxima (px) até um alvo de interação. */
export const INTERACT_REACH = 22;

export const NO_INPUT: PlayerInput = { up: false, down: false, left: false, right: false };

/** Vetor unitário do teclado (diagonal normalizada; zero quando nada ou direções opostas). */
export function moveVector(input: PlayerInput): Vec {
  const x = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const y = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  const len = Math.hypot(x, y);
  return { x: x / len, y: y / len };
}

/** Direção de desenho para um vetor (mantém a anterior quando parado). */
export function dirFromVector(v: Vec, prev: Dir): Dir {
  if (v.x === 0 && v.y === 0) return prev;
  if (Math.abs(v.x) > Math.abs(v.y)) return v.x > 0 ? 'right' : 'left';
  return v.y > 0 ? 'down' : 'up';
}

export function tileOfPoint(p: Vec): Tile {
  return { x: Math.floor(p.x / TILE), y: Math.floor((p.y - 1) / TILE) };
}

/** Centro de um tile para o avatar (base um pouco acima da borda inferior, para a caixa dos pés caber no tile). */
export function tileToPlayerPos(t: Tile): Vec {
  return { x: t.x * TILE + TILE / 2, y: (t.y + 1) * TILE - 3 };
}

function tileFree(walkable: boolean[][], x: number, y: number): boolean {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return false;
  return !!walkable[ty]?.[tx];
}

/** true quando a caixa dos pés em `p` só toca tiles livres. */
export function canStand(walkable: boolean[][], p: Vec): boolean {
  const x0 = p.x - FEET_HALF_W;
  const x1 = p.x + FEET_HALF_W - 1;
  const y0 = p.y - FEET_H;
  const y1 = p.y - 1;
  return tileFree(walkable, x0, y0) && tileFree(walkable, x1, y0) && tileFree(walkable, x0, y1) && tileFree(walkable, x1, y1);
}

/**
 * Avança o avatar por `dt` ms na direção `v` (unitária), deslizando ao encostar em obstáculos
 * (tenta X e Y separadamente). Devolve a nova posição e se houve deslocamento.
 */
export function stepPlayer(pos: Vec, v: Vec, dt: number, walkable: boolean[][], speed = PLAYER_SPEED): { pos: Vec; moved: boolean } {
  if ((v.x === 0 && v.y === 0) || dt <= 0) return { pos, moved: false };
  const dist = speed * (dt / 1000);
  let x = pos.x;
  let y = pos.y;
  // passos pequenos para não atravessar paredes em quadros longos
  const steps = Math.max(1, Math.ceil(dist / 4));
  const sx = (v.x * dist) / steps;
  const sy = (v.y * dist) / steps;
  for (let i = 0; i < steps; i++) {
    if (sx !== 0 && canStand(walkable, { x: x + sx, y })) x += sx;
    if (sy !== 0 && canStand(walkable, { x, y: y + sy })) y += sy;
  }
  const moved = x !== pos.x || y !== pos.y;
  return { pos: moved ? { x, y } : pos, moved };
}

/** Avança ao longo de uma lista de pontos (clique no chão); devolve posição e índice do próximo ponto. */
export function stepAlongPath(pos: Vec, path: Vec[], idx: number, dt: number, speed = PLAYER_SPEED): { pos: Vec; idx: number; dir: Dir | null } {
  let budget = speed * (dt / 1000);
  let x = pos.x;
  let y = pos.y;
  let i = idx;
  let dir: Dir | null = null;
  while (budget > 0 && i < path.length) {
    const t = path[i];
    const dx = t.x - x;
    const dy = t.y - y;
    const d = Math.hypot(dx, dy);
    if (d > 0.01) dir = dirFromVector({ x: dx / d, y: dy / d }, dir ?? 'down');
    if (d <= budget) { x = t.x; y = t.y; i++; budget -= d; continue; }
    x += (dx / d) * budget;
    y += (dy / d) * budget;
    budget = 0;
  }
  return { pos: { x, y }, idx: i, dir };
}

/** Posição persistida validada: se o tile não for transitável (ou estiver fora da grade), volta ao ponto seguro. */
export function safePlayerPosition(pos: Vec | null | undefined, walkable: boolean[][], fallback: Tile): Vec {
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && canStand(walkable, pos)) return { x: pos.x, y: pos.y };
  return tileToPlayerPos(fallback);
}

/** Distância (px) de um ponto a um retângulo de tiles (0 quando está dentro). */
export function distanceToTileRect(p: Vec, r: { x: number; y: number; w: number; h: number }): number {
  const x0 = r.x * TILE;
  const y0 = r.y * TILE;
  const x1 = (r.x + r.w) * TILE;
  const y1 = (r.y + r.h) * TILE;
  const dx = p.x < x0 ? x0 - p.x : p.x > x1 ? p.x - x1 : 0;
  const dy = p.y < y0 ? y0 - p.y : p.y > y1 ? p.y - y1 : 0;
  return Math.hypot(dx, dy);
}
