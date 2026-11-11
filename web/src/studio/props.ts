// Móveis e cenário do estúdio, todos em geometria arredondada feita em código (sem modelos baixados).
// Convenção: cada peça é um Group com origem no chão, no centro da área que ocupa; a "frente" é +z.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { SEAT_Y } from './character';
import { SOFT_RAMP, basic, glass, lightPoolTexture, toon } from './materials';
import { STUDIO as C } from './palette';

export const DESK_H = 0.72;
const FONT = '"Nunito Variable", "Nunito", "Segoe UI", system-ui, sans-serif';

function box(w: number, h: number, d: number, color: string, r = 0.02, seg = 2): THREE.Mesh {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)), toon(color, { soft: true }));
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function cyl(rt: number, rb: number, h: number, color: string, seg = 16): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), toon(color, { soft: true }));
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function sphere(r: number, color: string, seg = 12): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(6, seg - 4)), toon(color, { soft: true }));
  m.castShadow = true;
  return m;
}
function at<T extends THREE.Object3D>(o: T, x: number, y: number, z: number, ry = 0): T { o.position.set(x, y, z); o.rotation.y = ry; return o; }

// ---------------- telas e placas com texto (canvas) ----------------
export class CanvasPanel {
  readonly canvas = document.createElement('canvas');
  readonly g: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  constructor(w: number, h: number) {
    this.canvas.width = w; this.canvas.height = h;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
  }
  commit(): void { this.texture.needsUpdate = true; }
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

export function wrapText(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; if (lines.length === maxLines) break; } else cur = next;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    let last = lines[maxLines - 1];
    while (g.measureText(last + '…').width > maxW && last.length > 1) last = last.slice(0, -1);
    lines[maxLines - 1] = last.trimEnd() + '…';
  }
  return lines;
}

export type ScreenMode = { kind: 'off' } | { kind: 'idle'; name: string } | { kind: 'work'; name: string; text: string; tone: 'work' | 'wait' | 'error' | 'queue' } | { kind: 'code'; name: string; text: string };

/** Tela de monitor: mostra o que o funcionário faz de verdade (o mesmo texto do balão), nunca atividade inventada. */
export class Screen {
  readonly panel = new CanvasPanel(320, 200);
  readonly mesh: THREE.Mesh;
  private key = '';
  constructor(w: number, h: number) {
    const mat = new THREE.MeshBasicMaterial({ map: this.panel.texture, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    this.set({ kind: 'off' });
  }
  set(mode: ScreenMode): void {
    const k = JSON.stringify(mode);
    if (k === this.key) return;
    this.key = k;
    const g = this.panel.g; const W = 320, H = 200;
    if (mode.kind === 'off') {
      const grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, '#3a3442'); grad.addColorStop(1, '#2a2632');
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.moveTo(0, 0); g.lineTo(W * 0.55, 0); g.lineTo(W * 0.25, H); g.lineTo(0, H); g.fill();
      this.panel.commit(); return;
    }
    const tone = mode.kind === 'work' ? mode.tone : 'work';
    const bg = mode.kind === 'idle' ? ['#fff6ea', '#f6e9f6'] : tone === 'wait' ? ['#fff1d6', '#ffe2b8'] : tone === 'error' ? ['#ffe4e0', '#f9cfd6'] : ['#f3f0ff', '#e8f4ff'];
    const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, bg[0]); grad.addColorStop(1, bg[1]);
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    // barra de título
    g.fillStyle = 'rgba(58,47,61,0.08)'; g.fillRect(0, 0, W, 30);
    for (const [i, c] of ['#f4a28c', '#f0a830', '#9fd3cf'].entries()) { g.fillStyle = c; g.beginPath(); g.arc(16 + i * 16, 15, 5, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#3a2f3d'; g.font = `700 15px ${FONT}`; g.textBaseline = 'middle';
    g.fillText(mode.name, 70, 16);
    if (mode.kind === 'idle') {
      g.fillStyle = '#f0a830'; g.font = `800 40px ${FONT}`; g.textAlign = 'center';
      g.fillText('Aurora', W / 2, H / 2 + 8); g.textAlign = 'left';
      g.fillStyle = 'rgba(58,47,61,0.55)'; g.font = `600 15px ${FONT}`; g.fillText('disponível', W / 2 - 34, H / 2 + 46);
    } else {
      const accent = tone === 'wait' ? '#d98a12' : tone === 'error' ? '#d0505e' : tone === 'queue' ? '#7d7884' : '#7a62c9';
      g.fillStyle = accent; roundRect(g, 14, 44, 6, H - 60, 3); g.fill();
      g.fillStyle = '#3a2f3d'; g.font = `700 22px ${FONT}`; g.textBaseline = 'top';
      const lines = wrapText(g, mode.text, W - 46, 4);
      lines.forEach((l, i) => g.fillText(l, 30, 46 + i * 30));
      if (mode.kind === 'code') {
        g.font = `600 13px ui-monospace, Consolas, monospace`; g.fillStyle = 'rgba(58,47,61,0.45)';
        g.fillText('$ ' + mode.text.slice(0, 30), 30, H - 26);
      }
    }
    this.panel.commit();
  }
  dispose(): void { this.panel.texture.dispose(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

// ---------------- piso, paredes, janelas ----------------
export function floorTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = C.floor; g.fillRect(0, 0, 512, 512);
  const plankW = 64;
  for (let x = 0; x < 512; x += plankW) {
    for (let y = -((x / plankW) % 2) * 128; y < 512; y += 256) {
      const tone = ((x * 7 + y * 3) % 5) * 3;
      g.fillStyle = `rgba(180,140,100,${0.04 + tone / 300})`;
      g.fillRect(x + 1, y + 1, plankW - 2, 254);
      g.fillStyle = 'rgba(150,110,80,0.18)'; g.fillRect(x, y, plankW, 2);
    }
    g.fillStyle = 'rgba(150,110,80,0.16)'; g.fillRect(x, 0, 2, 512);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** Base do "diorama": piso de madeira em cima de uma laje com borda (estilo casa de bonecas aberta). */
export function floorSlab(w: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const tex = floorTexture(); tex.repeat.set(w / 4, d / 4);
  const top = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshToonMaterial({ map: tex, gradientMap: SOFT_RAMP }));
  top.rotation.x = -Math.PI / 2; top.position.set(w / 2, 0, d / 2); top.receiveShadow = true;
  g.add(top);
  const slab = new THREE.Mesh(new RoundedBoxGeometry(w + 0.3, 0.32, d + 0.3, 2, 0.08), toon('#efe3d3', { soft: true }));
  slab.position.set(w / 2, -0.165, d / 2); slab.receiveShadow = true;
  g.add(slab);
  const trim = new THREE.Mesh(new RoundedBoxGeometry(w + 0.34, 0.06, d + 0.34, 2, 0.03), toon(C.amber, { soft: true }));
  trim.position.set(w / 2, -0.33, d / 2);
  g.add(trim);
  return g;
}

/** Parede de fundo ao longo de x (z fixo) ou de z (x fixo), com rodapé e aberturas de janela. */
export function wall(len: number, h: number, along: 'x' | 'z', windows: { at: number; w: number; h: number; y: number }[] = [], color: string = C.wall): THREE.Group {
  const g = new THREE.Group();
  const t = 0.18;
  // segmentos entre janelas (a parede é recortada de verdade para a luz "entrar")
  const cuts = [...windows].sort((a, b) => a.at - b.at);
  let x = 0;
  const seg = (x0: number, x1: number, y0: number, y1: number) => {
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, t), toon(color, { soft: true }));
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0); m.receiveShadow = true; m.castShadow = true;
    g.add(m);
  };
  for (const wdw of cuts) {
    const a = wdw.at - wdw.w / 2, b = wdw.at + wdw.w / 2;
    seg(x, a, 0, h);
    seg(a, b, 0, wdw.y);
    seg(a, b, wdw.y + wdw.h, h);
    g.add(windowFrame(wdw.w, wdw.h, wdw.at, wdw.y));
    x = b;
  }
  seg(x, len, 0, h);
  // rodapé e moldura de topo
  const base = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, t + 0.04), toon(C.baseboard, { soft: true }));
  base.position.set(len / 2, 0.06, 0.01); g.add(base);
  const cap = new THREE.Mesh(new RoundedBoxGeometry(len + 0.04, 0.08, t + 0.08, 2, 0.03), toon(C.wallTrim, { soft: true }));
  cap.position.set(len / 2, h, 0); g.add(cap);
  if (along === 'z') { g.rotation.y = Math.PI / 2; }
  return g;
}

function windowFrame(w: number, h: number, cx: number, y: number): THREE.Group {
  const g = new THREE.Group();
  const frame = toon('#ffffff', { soft: true });
  const f = 0.06;
  for (const [fw, fh, fx, fy] of [[w, f, cx, y], [w, f, cx, y + h], [f, h, cx - w / 2, y + h / 2], [f, h, cx + w / 2, y + h / 2], [f * 0.6, h, cx, y + h / 2], [w, f * 0.6, cx, y + h * 0.62]] as const) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 0.22), frame); m.position.set(fx, fy, 0); g.add(m);
  }
  // céu do lado de fora (degradê) — não recebe luz da cena
  const c = document.createElement('canvas'); c.width = 8; c.height = 64;
  const gg = c.getContext('2d')!; const grad = gg.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, '#bfe0ff'); grad.addColorStop(0.6, '#fde9f3'); grad.addColorStop(1, '#fff3dc');
  gg.fillStyle = grad; gg.fillRect(0, 0, 8, 64);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  sky.position.set(cx, y + h / 2, -0.12); g.add(sky);
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glass('#ffffff', 0.12));
  pane.position.set(cx, y + h / 2, 0.02); g.add(pane);
  // peitoril
  const sill = new THREE.Mesh(new RoundedBoxGeometry(w + 0.16, 0.05, 0.32, 2, 0.02), frame); sill.position.set(cx, y - 0.02, 0.08); g.add(sill);
  return g;
}

/** Faixa de luz da janela (aditiva) e poça clara no chão. `dir` aponta para dentro da sala. */
export function lightShaft(w: number, len: number): THREE.Group {
  const g = new THREE.Group();
  const c = document.createElement('canvas'); c.width = 16; c.height = 128;
  const gg = c.getContext('2d')!; const grad = gg.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, 'rgba(255,240,215,0.32)'); grad.addColorStop(1, 'rgba(255,240,215,0)');
  gg.fillStyle = grad; gg.fillRect(0, 0, 16, 128);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const shaft = new THREE.Mesh(new THREE.PlaneGeometry(w, len), mat);
  shaft.rotation.x = -Math.PI / 2 + 0.55; shaft.position.set(0, 0.95, len * 0.36);
  g.add(shaft);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.3, len * 0.8), new THREE.MeshBasicMaterial({ map: lightPoolTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  pool.rotation.x = -Math.PI / 2; pool.position.set(0, 0.012, len * 0.55);
  g.add(pool);
  return g;
}

// ---------------- móveis ----------------
export function rug(w: number, d: number, color: string, edge: string): THREE.Group {
  const g = new THREE.Group();
  const outer = new THREE.Mesh(new RoundedBoxGeometry(w, 0.02, d, 2, 0.01), toon(edge, { soft: true }));
  outer.position.y = 0.01; outer.receiveShadow = true; g.add(outer);
  const inner = new THREE.Mesh(new RoundedBoxGeometry(w - 0.16, 0.022, d - 0.16, 2, 0.01), toon(color, { soft: true }));
  inner.position.y = 0.012; inner.receiveShadow = true; g.add(inner);
  return g;
}

export function plant(scale = 1, pot: string = C.pot): THREE.Group {
  const g = new THREE.Group();
  const p = cyl(0.17 * scale, 0.13 * scale, 0.32 * scale, pot); p.position.y = 0.16 * scale; g.add(p);
  const soil = cyl(0.155 * scale, 0.155 * scale, 0.02, '#8a6a52'); soil.position.y = 0.31 * scale; g.add(soil);
  const leaves: [number, number, number, number][] = [[0, 0.62, 0, 0.2], [0.12, 0.5, 0.05, 0.15], [-0.1, 0.52, -0.06, 0.16], [0.03, 0.8, -0.04, 0.14], [-0.07, 0.7, 0.09, 0.13]];
  for (const [x, y, z, r] of leaves) { const l = sphere(r * scale, Math.random() > 0.5 ? C.leaf : C.leafDark, 10); l.position.set(x * scale, y * scale, z * scale); l.scale.y = 1.15; g.add(l); }
  return g;
}

export function chair(color: string = C.fabric): THREE.Group {
  const g = new THREE.Group();
  const seat = box(0.46, 0.08, 0.44, color, 0.04); seat.position.y = SEAT_Y - 0.04; g.add(seat);
  const back = box(0.44, 0.48, 0.07, color, 0.035); back.position.set(0, SEAT_Y + 0.3, 0.22); back.rotation.x = -0.1; g.add(back);
  const post = cyl(0.025, 0.025, SEAT_Y - 0.12, C.metal, 8); post.position.y = (SEAT_Y - 0.12) / 2 + 0.06; g.add(post);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = box(0.05, 0.035, 0.3, C.metalDark, 0.015); leg.position.set(Math.sin(a) * 0.13, 0.045, Math.cos(a) * 0.13); leg.rotation.y = a; g.add(leg);
    const wheel = sphere(0.025, '#5a5262', 8); wheel.position.set(Math.sin(a) * 0.27, 0.025, Math.cos(a) * 0.27); g.add(wheel);
  }
  return g;
}

export interface DeskParts { group: THREE.Group; screens: Screen[]; chair: THREE.Group }

/** Estação de trabalho: tampo de madeira, pés brancos, monitor (tela viva), teclado, caneca e uma planta pequena. */
export function workstation(opts: { width?: number; monitors?: 1 | 2; accent?: string; chairColor?: string; seed?: number } = {}): DeskParts {
  const w = opts.width ?? 1.4, d = 0.72;
  const g = new THREE.Group();
  const top = box(w, 0.05, d, C.woodLight, 0.02); top.position.y = DESK_H - 0.025; g.add(top);
  for (const sx of [-1, 1]) {
    const leg = box(0.05, DESK_H - 0.05, d - 0.1, C.white, 0.02); leg.position.set(sx * (w / 2 - 0.06), (DESK_H - 0.05) / 2, 0); g.add(leg);
  }
  const modesty = box(w - 0.16, 0.32, 0.03, C.white, 0.012); modesty.position.set(0, DESK_H - 0.25, -d / 2 + 0.05); g.add(modesty);
  const screens: Screen[] = [];
  const n = opts.monitors ?? 1;
  for (let i = 0; i < n; i++) {
    const mx = n === 1 ? 0 : (i - 0.5) * 0.56;
    const ry = n === 1 ? 0 : (i === 0 ? 0.22 : -0.22);
    const mon = new THREE.Group();
    const bezel = box(0.56, 0.36, 0.035, '#f6f2f8', 0.025); bezel.position.y = 0.3; mon.add(bezel);
    const back = box(0.2, 0.16, 0.05, '#e3dce8', 0.03); back.position.set(0, 0.3, -0.035); mon.add(back);
    const neck = box(0.05, 0.16, 0.03, '#e3dce8', 0.012); neck.position.set(0, 0.1, -0.03); mon.add(neck);
    const foot = box(0.2, 0.02, 0.14, '#e3dce8', 0.01); foot.position.set(0, 0.01, -0.02); mon.add(foot);
    const scr = new Screen(0.51, 0.31); scr.mesh.position.set(0, 0.3, 0.019); mon.add(scr.mesh);
    screens.push(scr);
    at(mon, mx, DESK_H, -d / 2 + 0.2, ry); g.add(mon);
  }
  const kb = box(0.42, 0.02, 0.13, '#fbf8f4', 0.008); kb.position.set(0, DESK_H + 0.01, 0.08); g.add(kb);
  const mouse = box(0.06, 0.025, 0.09, '#fbf8f4', 0.012); mouse.position.set(0.3, DESK_H + 0.012, 0.1); g.add(mouse);
  const seed = opts.seed ?? 0;
  const mug = cyl(0.04, 0.035, 0.09, [C.fabricCoral, C.amber, C.fabric, C.fabricTeal][seed % 4], 12); mug.position.set(-w / 2 + 0.2, DESK_H + 0.045, 0.05); g.add(mug);
  if (seed % 3 !== 1) { const p = plant(0.38); p.position.set(w / 2 - 0.16, DESK_H, -0.18); g.add(p); }
  if (seed % 3 === 1) { const books = box(0.22, 0.06, 0.16, C.fabricPink, 0.01); books.position.set(w / 2 - 0.2, DESK_H + 0.03, -0.12); g.add(books); }
  if (opts.accent) { const lamp = deskLamp(opts.accent); lamp.position.set(-w / 2 + 0.16, DESK_H, -0.2); g.add(lamp); }
  const ch = chair(opts.chairColor);
  ch.position.set(0, 0, d / 2 + 0.2); // encosto em +z: atrás de quem senta
  g.add(ch);
  return { group: g, screens, chair: ch };
}

export function deskLamp(color: string): THREE.Group {
  const g = new THREE.Group();
  const base = cyl(0.07, 0.08, 0.025, color, 14); base.position.y = 0.012; g.add(base);
  const arm = box(0.02, 0.32, 0.02, C.white, 0.008); arm.position.set(0, 0.17, 0); arm.rotation.z = 0.25; g.add(arm);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.11, 16, 1, true), toon(color, { soft: true, side: THREE.DoubleSide })); shade.position.set(-0.08, 0.33, 0.03); shade.rotation.z = 0.5; g.add(shade);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), basic('#fff6dc')); bulb.position.set(-0.1, 0.3, 0.03); g.add(bulb);
  return g;
}

/** Mesa do Chefe: maior, com luminária, plaquinha com o nome e o ponto de atendimento à frente (+z). */
export function bossDesk(): DeskParts {
  const g = new THREE.Group();
  const w = 2.0, d = 0.9;
  const top = box(w, 0.06, d, C.wood, 0.03); top.position.y = DESK_H - 0.03; g.add(top);
  const pedestal = box(0.5, DESK_H - 0.06, d - 0.08, C.white, 0.03); pedestal.position.set(w / 2 - 0.3, (DESK_H - 0.06) / 2, 0); g.add(pedestal);
  const leg = box(0.06, DESK_H - 0.06, d - 0.12, C.white, 0.02); leg.position.set(-w / 2 + 0.06, (DESK_H - 0.06) / 2, 0); g.add(leg);
  const front = box(w - 0.2, 0.42, 0.04, C.woodDark, 0.015); front.position.set(0, DESK_H - 0.27, d / 2 - 0.06); g.add(front);
  const stripe = box(w - 0.2, 0.04, 0.045, C.amber, 0.01); stripe.position.set(0, DESK_H - 0.12, d / 2 - 0.055); g.add(stripe);
  const screens: Screen[] = [];
  const mon = new THREE.Group();
  const bezel = box(0.7, 0.42, 0.035, '#f6f2f8', 0.025); bezel.position.y = 0.34; mon.add(bezel);
  const neck = box(0.05, 0.18, 0.03, '#e3dce8', 0.012); neck.position.set(0, 0.1, -0.03); mon.add(neck);
  const foot = box(0.22, 0.02, 0.15, '#e3dce8', 0.01); foot.position.set(0, 0.01, -0.02); mon.add(foot);
  const scr = new Screen(0.64, 0.37); scr.mesh.position.set(0, 0.34, 0.019); mon.add(scr.mesh); screens.push(scr);
  // o Chefe senta do lado de trás (-z) e olha para a frente (+z): o monitor fica virado para ele
  at(mon, -0.25, DESK_H, 0.18, Math.PI); g.add(mon);
  const lamp = deskLamp(C.amber); lamp.position.set(0.75, DESK_H, -0.2); g.add(lamp);
  // plaquinha
  const plate = new CanvasPanel(256, 64);
  plate.g.fillStyle = '#3a2f3d'; roundRect(plate.g, 0, 0, 256, 64, 14); plate.g.fill();
  plate.g.fillStyle = '#f0a830'; plate.g.font = `800 34px ${FONT}`; plate.g.textAlign = 'center'; plate.g.textBaseline = 'middle'; plate.g.fillText('Chefe · CEO', 128, 34); plate.commit();
  const plateMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.085), new THREE.MeshBasicMaterial({ map: plate.texture, transparent: true }));
  plateMesh.position.set(0.25, DESK_H + 0.055, d / 2 - 0.05); plateMesh.rotation.x = -0.5; g.add(plateMesh);
  const papers = box(0.24, 0.02, 0.3, '#fffaf2', 0.005); papers.position.set(0.3, DESK_H + 0.01, 0.05); papers.rotation.y = 0.2; g.add(papers);
  const mug = cyl(0.045, 0.04, 0.1, C.amber, 12); mug.position.set(-0.75, DESK_H + 0.05, 0.1); g.add(mug);
  const ch = chair('#f0a830');
  ch.position.set(0, 0, -d / 2 - 0.25); ch.rotation.y = Math.PI; // o Chefe senta em -z olhando para +z
  g.add(ch);
  return { group: g, screens, chair: ch };
}

export function meetingTable(seats: number): { group: THREE.Group; chairs: THREE.Group[] } {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.06, 40), toon(C.woodLight, { soft: true }));
  top.scale.set(1.35, 1, 0.72); top.position.y = DESK_H - 0.03; top.castShadow = true; top.receiveShadow = true; g.add(top);
  const edge = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 8, 48), toon(C.wood, { soft: true }));
  edge.rotation.x = Math.PI / 2; edge.scale.set(1.35, 0.72, 1); edge.position.y = DESK_H - 0.03; g.add(edge);
  for (const sx of [-0.7, 0.7]) { const p = cyl(0.06, 0.12, DESK_H - 0.06, C.white, 14); p.position.set(sx, (DESK_H - 0.06) / 2, 0); g.add(p); }
  const chairs: THREE.Group[] = [];
  for (let i = 0; i < seats; i++) {
    const a = (i / seats) * Math.PI * 2;
    const ch = chair([C.fabric, C.fabricPink, C.fabricTeal, C.fabricCoral][i % 4]);
    const x = Math.sin(a) * 1.35 * 1.32, z = Math.cos(a) * 0.72 * 1.5;
    ch.position.set(x, 0, z); ch.rotation.y = Math.atan2(x, z) + Math.PI; // de frente para a mesa
    // a cadeira olha para a mesa: o encosto fica para fora
    ch.rotation.y = Math.atan2(-x, -z) + Math.PI;
    g.add(ch); chairs.push(ch);
  }
  return { group: g, chairs };
}

export function sofa(color: string, w = 1.9): THREE.Group {
  const g = new THREE.Group();
  const base = box(w, 0.38, 0.85, color, 0.12); base.position.y = 0.24; g.add(base);
  const back = box(w, 0.5, 0.24, color, 0.11); back.position.set(0, 0.6, -0.31); g.add(back);
  for (const s of [-1, 1]) { const arm = box(0.22, 0.42, 0.85, color, 0.1); arm.position.set(s * (w / 2 - 0.08), 0.42, 0); g.add(arm); }
  for (let i = 0; i < 2; i++) { const c = box(w / 2 - 0.2, 0.14, 0.62, '#fbf8f4', 0.06); c.position.set((i - 0.5) * (w / 2 - 0.12), 0.48, 0.04); g.add(c); }
  const pillow = box(0.36, 0.3, 0.12, C.amber, 0.06); pillow.position.set(w / 2 - 0.42, 0.66, -0.12); pillow.rotation.z = 0.2; g.add(pillow);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const f = cyl(0.03, 0.025, 0.06, C.woodDark, 8); f.position.set(sx * (w / 2 - 0.12), 0.03, sz * 0.32); g.add(f); }
  return g;
}

export function coffeeBar(): THREE.Group {
  const g = new THREE.Group();
  const counter = box(2.2, 0.95, 0.6, C.white, 0.04); counter.position.y = 0.475; g.add(counter);
  const top = box(2.26, 0.05, 0.66, C.wood, 0.02); top.position.y = 0.97; g.add(top);
  const front = box(2.0, 0.6, 0.02, C.fabricPink, 0.01); front.position.set(0, 0.5, 0.305); g.add(front);
  const machine = box(0.36, 0.42, 0.32, '#5a4a5f', 0.05); machine.position.set(-0.5, 1.2, -0.05); g.add(machine);
  const spout = box(0.12, 0.06, 0.1, '#c9c4cf', 0.02); spout.position.set(-0.5, 1.14, 0.1); g.add(spout);
  for (let i = 0; i < 3; i++) { const cup = cyl(0.04, 0.034, 0.09, [C.amber, C.fabricCoral, C.fabricTeal][i], 12); cup.position.set(0.1 + i * 0.14, 1.04, 0.05); g.add(cup); }
  const jar = cyl(0.08, 0.08, 0.22, '#fbe7c6', 14); jar.position.set(0.72, 1.1, -0.08); g.add(jar);
  // prateleira com xícaras
  const shelf = box(1.4, 0.04, 0.24, C.wood, 0.01); shelf.position.set(0.2, 1.7, -0.22); g.add(shelf);
  for (let i = 0; i < 4; i++) { const c = cyl(0.045, 0.04, 0.1, [C.fabric, C.amber, C.fabricPink, C.fabricTeal][i], 12); c.position.set(-0.3 + i * 0.3, 1.77, -0.22); g.add(c); }
  return g;
}

export function stool(color: string): THREE.Group {
  const g = new THREE.Group();
  const seat = cyl(0.19, 0.17, 0.07, color, 16); seat.position.y = 0.7; g.add(seat);
  const post = cyl(0.03, 0.03, 0.66, C.metal, 8); post.position.y = 0.34; g.add(post);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.012, 6, 20), toon(C.metal, { soft: true })); ring.rotation.x = Math.PI / 2; ring.position.y = 0.28; g.add(ring);
  const foot = cyl(0.2, 0.22, 0.03, C.metalDark, 16); foot.position.y = 0.015; g.add(foot);
  return g;
}

export function coffeeTable(): THREE.Group {
  const g = new THREE.Group();
  const top = cyl(0.45, 0.45, 0.05, C.woodLight, 28); top.position.y = 0.42; g.add(top);
  const leg = cyl(0.05, 0.16, 0.4, C.white, 12); leg.position.y = 0.2; g.add(leg);
  const book = box(0.24, 0.04, 0.18, C.fabric, 0.01); book.position.set(0.08, 0.465, 0.02); book.rotation.y = 0.4; g.add(book);
  const vase = cyl(0.05, 0.06, 0.16, C.fabricPink, 12); vase.position.set(-0.15, 0.52, -0.1); g.add(vase);
  const fl = sphere(0.07, C.amber, 10); fl.position.set(-0.15, 0.64, -0.1); g.add(fl);
  return g;
}

export function cabinet(w: number, h: number, color: string = C.white): THREE.Group {
  const g = new THREE.Group();
  const body = box(w, h, 0.5, color, 0.03); body.position.y = h / 2; g.add(body);
  const rows = Math.max(1, Math.round(h / 0.36));
  const cols = Math.max(1, Math.round(w / 0.5));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const dw = w / cols - 0.05, dh = h / rows - 0.05;
    const drawer = box(dw, dh, 0.03, (r + c) % 3 === 0 ? C.fabric : (r + c) % 3 === 1 ? C.woodLight : C.fabricPink, 0.015);
    drawer.position.set(-w / 2 + (c + 0.5) * (w / cols), (r + 0.5) * (h / rows), 0.255); g.add(drawer);
    const knob = sphere(0.016, C.amberDeep, 8); knob.position.set(-w / 2 + (c + 0.5) * (w / cols), (r + 0.5) * (h / rows), 0.28); g.add(knob);
  }
  return g;
}

export function shelf(w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  const levels = Math.round(h / 0.42);
  for (const s of [-1, 1]) { const side = box(0.04, h, 0.34, C.wood, 0.01); side.position.set(s * (w / 2), h / 2, 0); g.add(side); }
  for (let i = 0; i <= levels; i++) { const b = box(w, 0.035, 0.34, C.wood, 0.01); b.position.set(0, i * (h / levels) + 0.02, 0); g.add(b); }
  const colors = [C.fabric, C.fabricCoral, C.amber, C.fabricTeal, C.fabricPink, '#fbf8f4'];
  for (let i = 0; i < levels; i++) {
    let x = -w / 2 + 0.06; let k = i * 3;
    while (x < w / 2 - 0.12) {
      const bw = 0.05 + ((k * 37) % 5) * 0.012, bh = 0.24 + ((k * 13) % 4) * 0.025;
      if ((k * 7) % 6 === 0) { const p = plant(0.32); p.position.set(x + 0.09, i * (h / levels) + 0.04, 0); g.add(p); x += 0.22; k++; continue; }
      const b = box(bw, bh, 0.24, colors[k % colors.length], 0.008); b.position.set(x + bw / 2, i * (h / levels) + 0.04 + bh / 2, 0); g.add(b);
      x += bw + 0.01; k++;
    }
  }
  return g;
}

/** Mural de conteúdo: quadro de feltro com cartões; o texto real vem do servidor (setBoard). */
export class Mural {
  readonly group = new THREE.Group();
  readonly panel = new CanvasPanel(768, 384);
  private key = '';
  constructor(w = 2.6, h = 1.3) {
    const frame = box(w + 0.12, h + 0.12, 0.06, C.wood, 0.03); frame.position.set(0, 1.55, 0); this.group.add(frame);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshToonMaterial({ map: this.panel.texture, gradientMap: SOFT_RAMP }));
    face.position.set(0, 1.55, 0.032); this.group.add(face);
    this.set([]);
  }
  set(cols: { label: string; value: number; color: string }[]): void {
    const k = JSON.stringify(cols);
    if (k === this.key) return; this.key = k;
    const g = this.panel.g; const W = 768, H = 384;
    g.fillStyle = '#efe4f6'; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(122,98,201,0.08)'; for (let i = 0; i < 60; i++) g.fillRect((i * 97) % W, (i * 53) % H, 3, 3);
    g.fillStyle = '#3a2f3d'; g.font = `800 34px ${FONT}`; g.textBaseline = 'top'; g.fillText('Mural da equipe', 28, 20);
    const n = Math.max(1, cols.length);
    const cw = (W - 56 - (n - 1) * 14) / n;
    cols.forEach((c, i) => {
      const x = 28 + i * (cw + 14), y = 86;
      g.save(); g.translate(x + cw / 2, y + 120); g.rotate(((i % 3) - 1) * 0.025); g.translate(-(x + cw / 2), -(y + 120));
      g.fillStyle = '#fffaf2'; roundRect(g, x, y, cw, 250, 16); g.fill();
      g.fillStyle = c.color; roundRect(g, x, y, cw, 14, 7); g.fill();
      g.fillStyle = '#d0505e'; g.beginPath(); g.arc(x + cw / 2, y - 4, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3a2f3d'; g.font = `800 92px ${FONT}`; g.textAlign = 'center'; g.fillText(String(c.value), x + cw / 2, y + 48);
      g.font = `700 26px ${FONT}`; g.fillStyle = 'rgba(58,47,61,0.75)';
      wrapText(g, c.label, cw - 20, 2).forEach((l, li) => g.fillText(l, x + cw / 2, y + 168 + li * 30));
      g.textAlign = 'left'; g.restore();
    });
    this.panel.commit();
  }
}

/** Placa da marca na recepção (palavra Aurora em âmbar sobre placa clara). */
export function logoSign(w = 2.4): THREE.Group {
  const g = new THREE.Group();
  const p = new CanvasPanel(1024, 320);
  const gg = p.g;
  gg.clearRect(0, 0, 1024, 320);
  gg.fillStyle = '#f0a830'; gg.beginPath(); gg.arc(170, 160, 120, 0, Math.PI * 2); gg.fill();
  gg.fillStyle = '#fffaf2'; gg.font = `900 150px ${FONT}`; gg.textAlign = 'center'; gg.textBaseline = 'middle'; gg.fillText('M', 170, 168);
  gg.fillStyle = '#3a2f3d'; gg.textAlign = 'left'; gg.font = `900 170px ${FONT}`; gg.fillText('Aurora', 320, 150);
  gg.fillStyle = '#b07ac9'; gg.font = `700 46px ${FONT}`; gg.fillText('estúdio de conteúdo', 330, 262);
  p.commit();
  const plate = box(w + 0.2, w * 0.36, 0.06, '#fffaf2', 0.04); plate.position.y = 0; g.add(plate);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.3125), new THREE.MeshBasicMaterial({ map: p.texture, transparent: true, toneMapped: false }));
  face.position.z = 0.032; g.add(face);
  return g;
}

export function receptionDesk(): THREE.Group {
  const g = new THREE.Group();
  const body = box(2.2, 1.05, 0.7, C.white, 0.08); body.position.y = 0.525; g.add(body);
  const top = box(2.3, 0.05, 0.8, C.wood, 0.025); top.position.y = 1.07; g.add(top);
  const band = box(2.21, 0.16, 0.71, C.amber, 0.05); band.position.y = 0.75; g.add(band);
  const pl = plant(0.45); pl.position.set(-0.85, 1.095, -0.1); g.add(pl);
  const bell = sphere(0.05, C.amberDeep, 10); bell.position.set(0.6, 1.12, 0.1); bell.scale.y = 0.6; g.add(bell);
  return g;
}

/** Estúdio de vídeo: fundo infinito curvo (rosa claro), câmera no tripé, dois softboxes e a luz de aro. */
export function videoSet(): { group: THREE.Group; screen: Screen } {
  const g = new THREE.Group();
  // ciclorama: parede curvando até o chão
  const shape = new THREE.Shape();
  const W = 3.6;
  const curve = new THREE.Group();
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(W, 2.4), toon('#f7d6e6', { soft: true }));
  backdrop.position.set(0, 1.6, -1.2); curve.add(backdrop);
  const cove = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, W, 20, 1, true, Math.PI, Math.PI / 2), toon('#f7d6e6', { soft: true, side: THREE.DoubleSide }));
  cove.rotation.z = Math.PI / 2; cove.position.set(0, 0.4, -0.8); curve.add(cove);
  const floorPart = new THREE.Mesh(new THREE.PlaneGeometry(W, 1.6), toon('#f7d6e6', { soft: true }));
  floorPart.rotation.x = -Math.PI / 2; floorPart.position.set(0, 0.005, 0); curve.add(floorPart);
  void shape;
  g.add(curve);
  // banquinho no set
  const st = stool(C.amber); st.position.set(0, 0, -0.1); g.add(st);
  // câmera no tripé
  const cam = new THREE.Group();
  for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; const leg = box(0.03, 1.3, 0.03, '#5a4a5f', 0.01); leg.position.set(Math.sin(a) * 0.18, 0.62, Math.cos(a) * 0.18); leg.rotation.set(Math.cos(a) * 0.17, 0, -Math.sin(a) * 0.17); cam.add(leg); }
  const body = box(0.26, 0.18, 0.34, '#3f3846', 0.04); body.position.set(0, 1.36, 0); cam.add(body);
  const lens = cyl(0.07, 0.08, 0.16, '#2b2733', 16); lens.rotation.x = Math.PI / 2; lens.position.set(0, 1.36, -0.24); cam.add(lens);
  const rec = sphere(0.018, '#ff5a6e', 8); rec.position.set(0.1, 1.47, -0.1); cam.add(rec);
  at(cam, 0.3, 0, 1.6, 0); g.add(cam);
  // softboxes
  for (const s of [-1, 1]) {
    const sb = new THREE.Group();
    const pole = cyl(0.015, 0.015, 1.7, C.metalDark, 8); pole.position.y = 0.85; sb.add(pole);
    const tri = cyl(0.22, 0.22, 0.03, C.metalDark, 3); tri.position.y = 0.02; sb.add(tri);
    const boxM = box(0.6, 0.6, 0.2, '#fbf8f4', 0.04); boxM.position.set(0, 1.8, 0); boxM.rotation.x = 0.25; sb.add(boxM);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.52), basic('#fff7e6')); glow.position.set(0, 1.79, -0.11); glow.rotation.set(0.25, Math.PI, 0); sb.add(glow);
    at(sb, s * 1.35, 0, 0.9, s * -0.6 + Math.PI); g.add(sb);
  }
  // aro de luz
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 10, 32), basic('#fff7e6'));
  ring.position.set(-0.45, 1.5, 1.3); g.add(ring);
  const ringPole = cyl(0.015, 0.015, 1.5, C.metalDark, 8); ringPole.position.set(-0.45, 0.75, 1.3); g.add(ringPole);
  // monitor de retorno (mostra o que está sendo renderizado de verdade)
  const screen = new Screen(0.62, 0.38);
  const monStand = box(0.7, 0.46, 0.05, '#3f3846', 0.02); monStand.position.set(1.25, 1.2, 1.55); monStand.rotation.y = Math.PI + 0.5; g.add(monStand);
  screen.mesh.position.set(1.25 - Math.sin(0.5) * 0.03, 1.2, 1.55 - Math.cos(0.5) * 0.03); screen.mesh.rotation.y = Math.PI + 0.5;
  g.add(screen.mesh);
  const monPole = cyl(0.02, 0.02, 0.98, C.metalDark, 8); monPole.position.set(1.25, 0.49, 1.6); g.add(monPole);
  return { group: g, screen };
}

/** Divisória de vidro com moldura (sala de reunião). */
export function glassWall(len: number, h = 2.3, door?: { at: number; w: number }): THREE.Group {
  const g = new THREE.Group();
  const frameMat = toon(C.glassFrame, { soft: true });
  const pane = (x0: number, x1: number) => {
    if (x1 - x0 < 0.05) return;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, h - 0.1), glass(C.glass, 0.18));
    p.position.set((x0 + x1) / 2, h / 2, 0); g.add(p);
    const bot = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.08, 0.06), frameMat); bot.position.set((x0 + x1) / 2, 0.04, 0); g.add(bot);
    const topF = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.06, 0.06), frameMat); topF.position.set((x0 + x1) / 2, h, 0); g.add(topF);
    // faixa fosca na altura dos olhos (vidro de escritório)
    const band = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, 0.12), glass('#ffffff', 0.35)); band.position.set((x0 + x1) / 2, 1.3, 0.004); g.add(band);
    for (const x of [x0, x1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, h, 0.07), frameMat); post.position.set(x, h / 2, 0); g.add(post); }
  };
  if (door) { pane(0, door.at - door.w / 2); pane(door.at + door.w / 2, len); const lintel = new THREE.Mesh(new THREE.BoxGeometry(door.w, 0.06, 0.06), frameMat); lintel.position.set(door.at, h, 0); g.add(lintel); }
  else pane(0, len);
  return g;
}

export function pendant(color: string): THREE.Group {
  const g = new THREE.Group();
  const cord = cyl(0.006, 0.006, 0.9, '#7d7884', 6); cord.position.y = 0.45; g.add(cord);
  const shade = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon(color, { soft: true, side: THREE.DoubleSide }));
  shade.rotation.x = Math.PI; shade.position.y = 0.02; shade.scale.y = 0.75; g.add(shade);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), basic('#fff6dc')); bulb.position.y = -0.05; g.add(bulb);
  return g;
}

/** Tela de apresentação na parede (mostra a pauta real da reunião). */
export function wallScreen(w: number, h: number): { group: THREE.Group; screen: Screen } {
  const g = new THREE.Group();
  const frame = box(w + 0.08, h + 0.08, 0.06, '#3f3846', 0.03); g.add(frame);
  const screen = new Screen(w, h); screen.mesh.position.z = 0.032; g.add(screen.mesh);
  return { group: g, screen };
}

// ---------------- mesas redondas das equipes (08/11) ----------------
/**
 * Mesa redonda de uma equipe, com a origem no centro do tampo: tapete redondo na cor da equipe, tampo de madeira com borda
 * colorida, pé central, uma cadeira voltada para o centro e um notebook (tela viva) por assento. Os ângulos são os mesmos de
 * `teamSeat` (layout.ts): quem senta fica de frente para o próprio notebook.
 */
export function roundTeamTable(seats: number, radius: number, color: string, rugColor: string): { group: THREE.Group; screens: Screen[] } {
  const g = new THREE.Group();
  const n = Math.max(2, seats);
  const R = radius;
  const rugO = new THREE.Mesh(new THREE.CylinderGeometry(R + 1.3, R + 1.3, 0.02, 56), toon(color, { soft: true })); rugO.position.y = 0.01; rugO.receiveShadow = true; g.add(rugO);
  const rugI = new THREE.Mesh(new THREE.CylinderGeometry(R + 1.16, R + 1.16, 0.022, 56), toon(rugColor, { soft: true })); rugI.position.y = 0.012; rugI.receiveShadow = true; g.add(rugI);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.07, 56), toon(C.woodLight, { soft: true })); top.position.y = DESK_H - 0.035; top.castShadow = true; top.receiveShadow = true; g.add(top);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.035, 8, 64), toon(color, { soft: true })); rim.rotation.x = Math.PI / 2; rim.position.y = DESK_H - 0.035; g.add(rim);
  const post = cyl(0.13, 0.13, DESK_H - 0.1, C.white, 18); post.position.y = (DESK_H - 0.1) / 2 + 0.04; g.add(post);
  const foot = cyl(0.42, 0.46, 0.05, C.white, 24); foot.position.y = 0.035; g.add(foot);
  // centro: planta pequena e porta-canetas na cor da equipe
  const pl = plant(0.45); pl.position.set(0.08, DESK_H, -0.05); g.add(pl);
  const cup = cyl(0.05, 0.045, 0.11, color, 12); cup.position.set(-0.16, DESK_H + 0.055, 0.1); g.add(cup);
  const screens: Screen[] = [];
  const step = Math.min((Math.PI * 2) / n, 1.1);
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (i - (n - 1) / 2) * step;
    const out = new THREE.Vector2(Math.sin(a), Math.cos(a));
    // cadeira: encosto (+z local) para fora da mesa
    const ch = chair([C.fabric, C.fabricPink, C.fabricTeal, C.fabricCoral][i % 4]);
    ch.position.set(out.x * (R + 0.5), 0, out.y * (R + 0.5)); ch.rotation.y = a;
    g.add(ch);
    // notebook aberto: base no tampo e tela virada para quem senta
    const lap = new THREE.Group();
    const base = box(0.34, 0.018, 0.24, '#e9e4ee', 0.008); base.position.y = 0.009; lap.add(base);
    const lid = box(0.34, 0.22, 0.012, '#e9e4ee', 0.008); lid.position.set(0, 0.12, -0.115); lid.rotation.x = -0.25; lap.add(lid);
    const scr = new Screen(0.31, 0.19); scr.mesh.position.set(0, 0.12, -0.107); scr.mesh.rotation.x = -0.25; lap.add(scr.mesh);
    lap.position.set(out.x * (R - 0.3), DESK_H, out.y * (R - 0.3)); lap.rotation.y = a; // tela (+z) aponta para fora: para a pessoa
    g.add(lap);
    screens.push(scr);
  }
  return { group: g, screens };
}

/** Placa da equipe em pé atrás da mesa: nome, canais e o resumo real (execução, fila, revisão, bloqueios). */
export class TeamSign {
  readonly group = new THREE.Group();
  readonly panel = new CanvasPanel(900, 360);
  private key = '';
  constructor(private readonly title: string, private readonly channels: string, private readonly color: string) {
    for (const s of [-1, 1]) { const p = cyl(0.03, 0.03, 1.1, C.metalDark, 8); p.position.set(s * 0.85, 0.55, -0.02); this.group.add(p); }
    const back = box(2.0, 0.82, 0.05, '#fffaf2', 0.04); back.position.y = 1.42; this.group.add(back);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.94, 0.776), new THREE.MeshBasicMaterial({ map: this.panel.texture, toneMapped: false }));
    face.position.set(0, 1.42, 0.027); this.group.add(face);
    this.set(null);
  }
  set(summary: string | null): void {
    const k = summary ?? '';
    if (k === this.key && this.key !== '') return;
    this.key = k;
    const g = this.panel.g; const W = 900, H = 360;
    g.fillStyle = '#fffaf2'; g.fillRect(0, 0, W, H);
    g.fillStyle = this.color; roundRect(g, 0, 0, W, 34, 0); g.fill();
    g.fillStyle = '#3a2f3d'; g.font = `900 92px ${FONT}`; g.textBaseline = 'top'; g.fillText(this.title, 36, 52);
    g.fillStyle = 'rgba(58,47,61,0.72)'; g.font = `700 42px ${FONT}`; g.fillText(this.channels, 38, 162);
    g.fillStyle = 'rgba(58,47,61,0.08)'; roundRect(g, 30, 236, W - 60, 88, 22); g.fill();
    g.fillStyle = '#3a2f3d'; g.font = `800 38px ${FONT}`;
    g.fillText(summary ?? 'sem tarefas agora', 56, 258);
    this.panel.commit();
  }
}
