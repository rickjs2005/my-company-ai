// Câmera da cena: funções puras (sem DOM) para enquadrar a planta, limitar a rolagem e seguir o avatar.
// Convenção: `cam` é o ponto do mundo que aparece no canto superior esquerdo do canvas; tela = (mundo - cam) * zoom.
// A "área útil" é o viewport menos os insets (painéis sobrepostos). fitAll e o follow trabalham dentro dela.

import { WORLD_H, WORLD_W } from './layout';
import { TILE } from './sprites';

export interface Insets { left: number; right: number; top: number; bottom: number }
export interface Size { w: number; h: number }
export interface Point { x: number; y: number }
export interface ViewRect { x: number; y: number; w: number; h: number }

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;
/** Margem (px do mundo) ao redor da planta em fitAll e na rolagem livre. */
export const FIT_MARGIN = TILE;
export const NO_INSETS: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
const WORLD: Size = { w: WORLD_W, h: WORLD_H };

export function clampZoom(z: number): number { return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z))); }

/** Área útil em px de tela (nunca menor que 1x1). */
export function usableRect(viewW: number, viewH: number, insets: Insets): ViewRect {
  const left = Math.max(0, insets.left);
  const top = Math.max(0, insets.top);
  const w = Math.max(1, viewW - left - Math.max(0, insets.right));
  const h = Math.max(1, viewH - top - Math.max(0, insets.bottom));
  return { x: left, y: top, w, h };
}

/** Menor zoom da visão geral (telas muito pequenas): abaixo disso a planta fica ilegível; aí ela é centralizada e cortada. */
export const ZOOM_FIT_MIN = 0.5;
/** Passos da visão geral: 1/4 acima de 1 (a pixel art continua nítida o bastante) e 1/16 abaixo de 1 (cabe o mais justo possível). */
const FIT_STEP_UP = 4;
const FIT_STEP_DOWN = 16;

/** Zoom da visão geral: o maior em que a planta INTEIRA (com margem) cabe na área útil. Em 1366×768 isso fica abaixo de 1 (antes
 *  o zoom só aceitava inteiros e a planta saía cortada em cima e embaixo); em 1920×1080 fica acima de 1 (personagens maiores). */
export function fitZoomFor(viewW: number, viewH: number, insets: Insets = NO_INSETS, world: Size = WORLD, margin = FIT_MARGIN): number {
  const u = usableRect(viewW, viewH, insets);
  const raw = Math.min(u.w / (world.w + margin * 2), u.h / (world.h + margin * 2));
  if (raw >= 1) return Math.min(ZOOM_MAX, Math.floor(raw * FIT_STEP_UP) / FIT_STEP_UP);
  return Math.max(ZOOM_FIT_MIN, Math.floor(raw * FIT_STEP_DOWN) / FIT_STEP_DOWN);
}

/** Origem da câmera que centraliza a planta na área útil para um zoom. */
export function fitCameraFor(viewW: number, viewH: number, insets: Insets, zoom: number, world: Size = WORLD): Point {
  const u = usableRect(viewW, viewH, insets);
  const cx = world.w / 2;
  const cy = world.h / 2;
  return { x: cx - (u.x + u.w / 2) / zoom, y: cy - (u.y + u.h / 2) / zoom };
}

/**
 * Limita a câmera: quando a planta (com margem) cabe na área útil num eixo, centraliza nesse eixo; senão impede que
 * a área útil saia dos limites da planta com margem.
 */
export function clampCameraTo(cam: Point, zoom: number, viewW: number, viewH: number, insets: Insets, world: Size = WORLD, margin = FIT_MARGIN): Point {
  const u = usableRect(viewW, viewH, insets);
  const uw = u.w / zoom;
  const uh = u.h / zoom;
  const minX = -margin;
  const maxX = world.w + margin;
  const minY = -margin;
  const maxY = world.h + margin;
  let x: number;
  let y: number;
  if (uw >= maxX - minX) x = (minX + maxX) / 2 - uw / 2 - u.x / zoom;
  else x = Math.min(Math.max(cam.x, minX - u.x / zoom), maxX - uw - u.x / zoom);
  if (uh >= maxY - minY) y = (minY + maxY) / 2 - uh / 2 - u.y / zoom;
  else y = Math.min(Math.max(cam.y, minY - u.y / zoom), maxY - uh - u.y / zoom);
  return { x, y };
}

/** Retângulo do mundo visível na área útil. */
export function visibleWorldRect(cam: Point, zoom: number, viewW: number, viewH: number, insets: Insets): ViewRect {
  const u = usableRect(viewW, viewH, insets);
  return { x: cam.x + u.x / zoom, y: cam.y + u.y / zoom, w: u.w / zoom, h: u.h / zoom };
}

/** Origem da câmera que coloca um ponto do mundo no centro da área útil. */
export function cameraCenteredOn(target: Point, zoom: number, viewW: number, viewH: number, insets: Insets): Point {
  const u = usableRect(viewW, viewH, insets);
  return { x: target.x - (u.x + u.w / 2) / zoom, y: target.y - (u.y + u.h / 2) / zoom };
}

/**
 * Câmera desejada no modo follow: só se move quando o alvo sai da zona morta (fração do centro da área útil).
 * Devolve a própria câmera quando o alvo já está dentro da zona.
 */
export function followCamera(cam: Point, target: Point, zoom: number, viewW: number, viewH: number, insets: Insets, deadZone = 0.3): Point {
  const u = usableRect(viewW, viewH, insets);
  const uw = u.w / zoom;
  const uh = u.h / zoom;
  const cx = cam.x + u.x / zoom + uw / 2;
  const cy = cam.y + u.y / zoom + uh / 2;
  const halfW = (uw * deadZone) / 2;
  const halfH = (uh * deadZone) / 2;
  let nx = cam.x;
  let ny = cam.y;
  if (target.x < cx - halfW) nx += target.x - (cx - halfW);
  else if (target.x > cx + halfW) nx += target.x - (cx + halfW);
  if (target.y < cy - halfH) ny += target.y - (cy - halfH);
  else if (target.y > cy + halfH) ny += target.y - (cy + halfH);
  return { x: nx, y: ny };
}

/** Interpolação exponencial independente do frame (tau em ms). */
export function smoothTowards(current: number, target: number, dt: number, tau = 110): number {
  if (dt <= 0) return current;
  const k = 1 - Math.exp(-dt / tau);
  const next = current + (target - current) * k;
  return Math.abs(target - next) < 0.01 ? target : next;
}
