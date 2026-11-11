// Planta do estúdio Aurora (metros). Funções puras: dá para testar sem WebGL.
// O piso vai de x 0..W (oeste→leste) e z 0..D (norte→sul). As paredes de fundo ficam no norte (z = 0) e no oeste
// (x = 0); a câmera olha de sudeste, então as paredes sul e leste são "cortadas" (vista de casa de bonecas aberta).
import type { RoomKind } from '@milweb-hq/protocol';

export const W = 22;
export const D = 14;
export const WALL_H = 3.0;
export const CELL = 0.25;
export const GW = Math.round(W / CELL);
export const GD = Math.round(D / CELL);

export interface Rect { x0: number; z0: number; x1: number; z1: number }
export interface Pt { x: number; z: number }

export type ZoneId = 'reception' | 'island' | 'dev' | 'meeting' | 'studio' | 'boss' | 'lounge' | 'archive' | 'aurora' | 'tuco' | 'teams';

export interface Zone { id: ZoneId; label: string; rect: Rect; kinds: RoomKind[]; color: string; labelAt: Pt }

/** Áreas do estúdio e as salas do cadastro que cada uma representa. */
export const ZONES: Zone[] = [
  { id: 'meeting', label: 'Sala de reunião', rect: { x0: 0.3, z0: 0.3, x1: 6.2, z1: 5.0 }, kinds: ['meeting'], color: '#b9a3e3', labelAt: { x: 2.4, z: 4.55 } },
  { id: 'studio', label: 'Estúdio de vídeo', rect: { x0: 6.8, z0: 0.3, x1: 13.4, z1: 4.8 }, kinds: ['design'], color: '#f5b8cf', labelAt: { x: 8.2, z: 4.55 } },
  { id: 'dev', label: 'Desenvolvimento', rect: { x0: 14.0, z0: 0.3, x1: 21.7, z1: 4.8 }, kinds: ['dev'], color: '#8fb8f0', labelAt: { x: 18.6, z: 4.4 } },
  { id: 'archive', label: 'Mural e arquivo', rect: { x0: 0.3, z0: 5.4, x1: 3.6, z1: 9.4 }, kinds: ['management', 'research'], color: '#9fd3cf', labelAt: { x: 1.7, z: 9.6 } },
  { id: 'island', label: 'Apoio às duas equipes', rect: { x0: 4.2, z0: 9.7, x1: 13.6, z1: 11.4 }, kinds: ['social', 'custom'], color: '#9fd3cf', labelAt: { x: 8.8, z: 11.55 } },
  // as duas equipes permanentes da Social Media (placas próprias em 3D; aqui só a área para enquadrar a câmera)
  { id: 'aurora', label: 'Equipe Aurora', rect: { x0: 4.1, z0: 5.3, x1: 8.4, z1: 9.6 }, kinds: [], color: '#f0a830', labelAt: { x: 6.2, z: 9.75 } },
  { id: 'tuco', label: 'Equipe Tuco Dev', rect: { x0: 9.4, z0: 5.3, x1: 13.7, z1: 9.6 }, kinds: [], color: '#8b7fe8', labelAt: { x: 11.6, z: 9.75 } },
  { id: 'boss', label: 'Mesa do Chefe', rect: { x0: 14.4, z0: 5.4, x1: 21.7, z1: 10.6 }, kinds: ['direction'], color: '#f0a830', labelAt: { x: 19.6, z: 9.9 } },
  { id: 'reception', label: 'Recepção', rect: { x0: 0.3, z0: 9.8, x1: 4.6, z1: 13.7 }, kinds: [], color: '#f4a28c', labelAt: { x: 3.2, z: 13.45 } },
  { id: 'lounge', label: 'Café', rect: { x0: 14.4, z0: 11.0, x1: 21.7, z1: 13.7 }, kinds: [], color: '#f4a28c', labelAt: { x: 17.6, z: 13.55 } },
];

export function zoneForKind(kind: RoomKind): ZoneId {
  if (kind === 'social') return 'teams';
  return ZONES.find(z => z.kinds.includes(kind))?.id ?? 'island';
}
/** Retângulo para enquadrar: uma área, ou as duas equipes juntas ('teams'). */
export function zoneRect(id: ZoneId): Rect {
  if (id === 'teams') return { x0: 4.0, z0: 5.2, x1: 13.8, z1: 11.4 };
  return ZONES.find(z => z.id === id)!.rect;
}
export function zoneAt(p: Pt): ZoneId | null {
  return ZONES.find(z => p.x >= z.rect.x0 && p.x <= z.rect.x1 && p.z >= z.rect.z0 && p.z <= z.rect.z1)?.id ?? null;
}

/** Ângulo de frente (0 = +z, sul; π = -z, norte; π/2 = +x, leste). */
export const FACE = { south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 } as const;

/** Mesa de trabalho: centro, rotação do móvel, onde a pessoa senta, por onde chega e de onde a tela é vista. */
export interface DeskSpot {
  index: number;
  zone: ZoneId;
  label: string;
  x: number; z: number; ry: number;
  monitors: 1 | 2;
  seat: Pt & { facing: number };
  approach: Pt;
}

const DESK_D = 0.72;
function desk(index: number, zone: ZoneId, label: string, x: number, z: number, ry: number, monitors: 1 | 2 = 1, side: 1 | -1 = 1): DeskSpot {
  // no móvel, a pessoa senta em +z local olhando para -z; a cadeira fica a DESK_D/2 + 0,2 do centro
  const sd = DESK_D / 2 + 0.2;
  const c = Math.cos(ry), s = Math.sin(ry);
  const rot = (lx: number, lz: number) => ({ x: x + lx * c + lz * s, z: z - lx * s + lz * c });
  const seat = rot(0, sd);
  const approach = rot(side * 0.72, sd + 0.15);
  return { index, zone, label, x, z, ry, monitors, seat: { ...seat, facing: ry + Math.PI }, approach };
}

/**
 * Mesas. 0..7 mantêm o sentido de `seatFor` (sala Social Media): 0 criação Tuco, 1 vídeo Tuco, 2 criação Aurora,
 * 3 vídeo Aurora, 4 pesquisa, 5 pauta/coordenação, 6 revisão, 7 diretor de vídeo (estação de edição no estúdio).
 * 8..9 desenvolvimento; 10..13 mesas livres das ilhas.
 */
export const DESKS: DeskSpot[] = [
  // 0..3 eram as mesas pequenas das equipes (08/11: viraram as duas mesas redondas, assentos 100+ e 200+)
  // fileira de apoio: quem atende as duas equipes, de rosto para a câmera
  desk(4, 'island', 'Pesquisa · apoio', 6.05, 10.9, Math.PI, 1, 1),
  desk(5, 'island', 'Coordenação · apoio', 8.8, 10.9, Math.PI, 1, -1),
  desk(6, 'island', 'Revisão · apoio', 11.55, 10.9, Math.PI, 1, -1),
  // estação de edição do diretor de vídeo (no estúdio, de frente para o set)
  desk(7, 'studio', 'Direção de vídeo', 12.35, 3.7, Math.PI / 2, 2, 1),
  // desenvolvimento
  desk(8, 'dev', 'Desenvolvimento', 15.6, 2.9, 0, 2, -1),
  desk(9, 'dev', 'Desenvolvimento', 17.3, 2.9, 0, 1, 1),
  // sem equipe ainda (atribuir na Equipe): mesa avulsa no fim da fileira de apoio
  desk(10, 'island', 'Sem equipe · atribuir', 13.3, 10.9, Math.PI, 1, -1),
  // sessões externas observadas (Claude Code aberto fora da HQ): no desenvolvimento, longe das duas equipes
  desk(11, 'dev', 'Sessão externa', 19.0, 2.9, 0, 1, -1),
  desk(12, 'dev', 'Sessão externa', 20.45, 2.9, 0, 1, 1),
];
/** Índice da mesa (ou assento de equipe) → mesa avulsa; assentos de equipe começam em 100 (Aurora) e 200 (Tuco Dev). */
export function deskByIndex(i: number): DeskSpot | undefined { return DESKS.find(d => d.index === i); }

// ---------------- as duas mesas redondas das equipes ----------------
export type StudioTeamId = 'aurora' | 'tuco-dev';
export const TEAM_TABLES: { id: StudioTeamId; x: number; z: number; base: number }[] = [
  { id: 'aurora', x: 6.2, z: 7.45, base: 100 },
  { id: 'tuco-dev', x: 11.6, z: 7.45, base: 200 },
];
/** Raio do tampo pelo número de assentos (a mesa cresce com a equipe; mínimo de dois lugares). */
export function teamTableRadius(seats: number): number { return seats <= 2 ? 0.85 : Math.min(1.3, 0.62 + 0.11 * seats); }
/**
 * Assento i de n na mesa redonda: em volta do centro, voltado para ele. Poucas pessoas sentam no arco do fundo (de rosto
 * para a câmera); a partir de seis, o círculo inteiro. A chegada é pelo lado da cadeira (nunca atravessa o encosto).
 */
export function teamSeat(team: StudioTeamId, i: number, n: number): DeskSpot {
  const t = TEAM_TABLES.find(x => x.id === team)!;
  const seats = Math.max(2, n);
  const step = Math.min((Math.PI * 2) / seats, 1.1);
  const a = Math.PI + (i - (seats - 1) / 2) * step;
  const rc = teamTableRadius(seats) + 0.5;
  const x = t.x + Math.sin(a) * rc, z = t.z + Math.cos(a) * rc;
  const facing = Math.atan2(t.x - x, t.z - z);
  const side = i % 2 === 0 ? 1 : -1;
  const aa = a + side * Math.min(0.42, step * 0.45);
  const approach = { x: t.x + Math.sin(aa) * (rc + 0.12), z: t.z + Math.cos(aa) * (rc + 0.12) };
  return { index: t.base + i, zone: team === 'aurora' ? 'aurora' : 'tuco', label: team === 'aurora' ? 'Equipe Aurora' : 'Equipe Tuco Dev', x, z, ry: facing + Math.PI, monitors: 1, seat: { x, z, facing }, approach };
}
export function teamOfSeatIndex(i: number): StudioTeamId | null { return i >= 200 && i < 300 ? 'tuco-dev' : i >= 100 && i < 200 ? 'aurora' : null; }

/** Mesa do Chefe: girada 45° para quem atende e o Chefe aparecerem de perfil para a câmera. */
export const BOSS = (() => {
  const x = 18.4, z = 7.9, ry = -Math.PI / 4;
  const c = Math.cos(ry), s = Math.sin(ry);
  const rot = (lx: number, lz: number) => ({ x: x + lx * c + lz * s, z: z - lx * s + lz * c });
  const seat = rot(0, -0.45 - 0.25);
  // ponto de atendimento (diante da mesa) e a fila atrás dele, em leque
  const attend = rot(0, 1.05);
  const queue = [rot(0.95, 1.75), rot(-0.95, 1.75), rot(0, 2.45), rot(1.2, 2.55)];
  const seatApproach = rot(0.8, -0.55);
  return { x, z, ry, seat: { ...seat, facing: ry }, seatApproach, attend: { ...attend, facing: ry + Math.PI }, queue: queue.map(q => ({ ...q, facing: ry + Math.PI })) };
})();

/** Mesa de reunião (8 lugares) e a tela de pauta. */
export const MEETING = { x: 3.1, z: 2.7, seats: 8, screen: { x: 3.1, z: 0.12 } };
export function meetingSeat(i: number): Pt & { facing: number; approach: Pt } {
  const a = (i / MEETING.seats) * Math.PI * 2;
  const sx = Math.sin(a) * 1.35 * 1.32, sz = Math.cos(a) * 0.72 * 1.5;
  const x = MEETING.x + sx * 0.92, z = MEETING.z + sz * 0.92;
  const facing = Math.atan2(MEETING.x - x, MEETING.z - z);
  const out = Math.hypot(sx, sz);
  const approach = { x: MEETING.x + sx * (1 + 0.55 / out), z: MEETING.z + sz * (1 + 0.55 / out) };
  return { x, z, facing, approach };
}

export const STUDIO_SET = { x: 9.7, z: 1.65 };
export const MURAL = { x: 0.12, z: 7.2 };
export const ARCHIVE = { x: 0.45, z: 8.6 };
export const SOCIALS = { x: 0.12, z: 5.9 };
export const RECEPTION = { x: 2.3, z: 11.7 };
export const ENTRANCE: Pt = { x: 0.7, z: 13.2 };
export const LOUNGE = { sofa: { x: 16.2, z: 11.6 }, table: { x: 16.2, z: 12.55 }, bar: { x: 19.9, z: 12.85 } };

/** Pontos onde o Chefe (avatar) para diante de cada objeto. */
export const APPROACH: Record<'chefe-desk' | 'board' | 'media-cabinet' | 'meeting-table' | 'studio' | 'door' | 'socials', Pt & { facing: number }> = {
  'chefe-desk': { ...BOSS.attend },
  board: { x: 1.15, z: 7.2, facing: FACE.west },
  'media-cabinet': { x: 1.25, z: 8.75, facing: FACE.west },
  socials: { x: 1.15, z: 5.95, facing: FACE.west },
  'meeting-table': { x: 5.2, z: 5.45, facing: FACE.north },
  studio: { x: 10.4, z: 4.4, facing: FACE.north },
  door: { x: 1.3, z: 12.9, facing: FACE.west },
};

// ---------------- grade de navegação ----------------
export type Grid = Uint8Array; // 1 = livre

export function cellOf(p: Pt): { cx: number; cz: number } {
  return { cx: Math.max(0, Math.min(GW - 1, Math.floor(p.x / CELL))), cz: Math.max(0, Math.min(GD - 1, Math.floor(p.z / CELL))) };
}
export function centerOf(cx: number, cz: number): Pt { return { x: (cx + 0.5) * CELL, z: (cz + 0.5) * CELL }; }

/** Retângulo girado (centro, meia-largura, meia-profundidade, rotação) marcado como bloqueado. */
export function blockOriented(g: Grid, cx: number, cz: number, hw: number, hd: number, ry: number, pad = 0.12): void {
  const c = Math.cos(ry), s = Math.sin(ry);
  const r = Math.hypot(hw, hd) + pad;
  for (let z = Math.floor((cz - r) / CELL); z <= Math.ceil((cz + r) / CELL); z++) for (let x = Math.floor((cx - r) / CELL); x <= Math.ceil((cx + r) / CELL); x++) {
    if (x < 0 || z < 0 || x >= GW || z >= GD) continue;
    const p = centerOf(x, z);
    const dx = p.x - cx, dz = p.z - cz;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    if (Math.abs(lx) <= hw + pad && Math.abs(lz) <= hd + pad) g[z * GW + x] = 0;
  }
}
export function blockRect(g: Grid, r: Rect): void {
  for (let z = Math.floor(r.z0 / CELL); z < Math.ceil(r.z1 / CELL); z++) for (let x = Math.floor(r.x0 / CELL); x < Math.ceil(r.x1 / CELL); x++) if (x >= 0 && z >= 0 && x < GW && z < GD) g[z * GW + x] = 0;
}
export function freeRect(g: Grid, r: Rect): void {
  for (let z = Math.floor(r.z0 / CELL); z < Math.ceil(r.z1 / CELL); z++) for (let x = Math.floor(r.x0 / CELL); x < Math.ceil(r.x1 / CELL); x++) if (x >= 0 && z >= 0 && x < GW && z < GD) g[z * GW + x] = 1;
}

/** Grade do estúdio: móveis, paredes de vidro (com portas) e a borda do piso bloqueados. */
export function buildGrid(teamSeats: Partial<Record<StudioTeamId, number>> = {}): Grid {
  const g: Grid = new Uint8Array(GW * GD).fill(1);
  // borda e paredes de fundo
  blockRect(g, { x0: 0, z0: 0, x1: W, z1: 0.3 });
  blockRect(g, { x0: 0, z0: 0, x1: 0.3, z1: D });
  blockRect(g, { x0: 0, z0: D - 0.2, x1: W, z1: D });
  blockRect(g, { x0: W - 0.2, z0: 0, x1: W, z1: D });
  // sala de reunião: vidro a leste (porta em z 4.0) e ao sul (porta em x 5.2)
  blockRect(g, { x0: 6.1, z0: 0.3, x1: 6.35, z1: 3.5 });
  blockRect(g, { x0: 0.3, z0: 4.9, x1: 4.6, z1: 5.15 });
  blockOriented(g, MEETING.x, MEETING.z, 1.35, 0.72, 0, 0.1);
  // estúdio: set e câmera
  blockRect(g, { x0: 7.8, z0: 0.3, x1: 11.6, z1: 2.5 });
  blockOriented(g, STUDIO_SET.x + 0.3, STUDIO_SET.z + 1.6, 0.25, 0.25, 0, 0.05);
  blockOriented(g, STUDIO_SET.x - 1.35, STUDIO_SET.z + 0.9, 0.3, 0.3, 0, 0);
  blockOriented(g, STUDIO_SET.x + 1.35, STUDIO_SET.z + 0.9, 0.3, 0.3, 0, 0);
  blockOriented(g, STUDIO_SET.x + 1.25, STUDIO_SET.z + 1.55, 0.35, 0.15, 0, 0);
  blockOriented(g, STUDIO_SET.x - 0.45, STUDIO_SET.z + 1.3, 0.12, 0.12, 0, 0);
  // mesas (tampo) — a cadeira bloqueia, mas o assento e a chegada continuam livres
  for (const d of DESKS) blockOriented(g, d.x, d.z, d.monitors === 2 ? 0.8 : 0.7, 0.36, d.ry, 0.08);
  for (const t of TEAM_TABLES) blockCircle(g, t.x, t.z, teamTableRadius(Math.max(2, teamSeats[t.id] ?? 2)) + 0.1);
  blockOriented(g, BOSS.x, BOSS.z, 1.0, 0.45, BOSS.ry, 0.1);
  // parede oeste: mural, arquivo, painel das redes; recepção
  blockRect(g, { x0: 0.3, z0: 8.1, x1: 0.9, z1: 9.5 });
  blockOriented(g, RECEPTION.x, RECEPTION.z, 1.15, 0.4, Math.PI / 2, 0.08);
  // estantes do desenvolvimento e plantas
  blockRect(g, { x0: 19.2, z0: 0.3, x1: 21.6, z1: 0.75 });
  // café
  blockOriented(g, LOUNGE.sofa.x, LOUNGE.sofa.z, 0.95, 0.42, 0, 0.05);
  blockOriented(g, LOUNGE.table.x, LOUNGE.table.z, 0.45, 0.45, 0, 0.02);
  blockOriented(g, LOUNGE.bar.x, LOUNGE.bar.z, 1.13, 0.33, 0, 0.05);
  // assentos e pontos de chegada sempre livres
  for (const d of DESKS) { markFree(g, d.approach); markFree(g, d.seat); }
  for (const t of TEAM_TABLES) { const n = Math.max(2, teamSeats[t.id] ?? 2); for (let i = 0; i < n; i++) { const s = teamSeat(t.id, i, n); markFree(g, s.approach); markFree(g, s.seat); } }
  markFree(g, BOSS.attend); markFree(g, BOSS.seatApproach); markFree(g, BOSS.seat); for (const q of BOSS.queue) markFree(g, q);
  for (let i = 0; i < MEETING.seats; i++) markFree(g, meetingSeat(i).approach);
  for (const a of Object.values(APPROACH)) markFree(g, a);
  markFree(g, ENTRANCE);
  return g;
}

export function blockCircle(g: Grid, cx: number, cz: number, r: number): void {
  for (let z = Math.floor((cz - r) / CELL); z <= Math.ceil((cz + r) / CELL); z++) for (let x = Math.floor((cx - r) / CELL); x <= Math.ceil((cx + r) / CELL); x++) {
    if (x < 0 || z < 0 || x >= GW || z >= GD) continue;
    const p = centerOf(x, z);
    if (Math.hypot(p.x - cx, p.z - cz) <= r) g[z * GW + x] = 0;
  }
}

function markFree(g: Grid, p: Pt): void { const { cx, cz } = cellOf(p); g[cz * GW + cx] = 1; }

export function walkable(g: Grid, cx: number, cz: number): boolean {
  return cx >= 0 && cz >= 0 && cx < GW && cz < GD && g[cz * GW + cx] === 1;
}

/** A* em 8 direções sem cortar quina de obstáculo; devolve pontos (centros de célula) já suavizados por linha de visão. */
export function findPath(g: Grid, from: Pt, to: Pt, occupied?: (cx: number, cz: number) => boolean): Pt[] {
  const s = cellOf(from), t0 = cellOf(to);
  const t = walkable(g, t0.cx, t0.cz) ? t0 : nearestFree(g, t0.cx, t0.cz);
  if (!t) return [];
  let start = s;
  if (!walkable(g, s.cx, s.cz)) { const n = nearestFree(g, s.cx, s.cz); if (!n) return []; start = n; }
  const N = GW * GD;
  const gs = new Float32Array(N).fill(Infinity);
  const fs = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const si = start.cz * GW + start.cx, ti = t.cz * GW + t.cx;
  const h = (i: number) => { const dx = Math.abs((i % GW) - t.cx), dz = Math.abs(Math.floor(i / GW) - t.cz); return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz); };
  const heap: number[] = [];
  const push = (i: number) => { heap.push(i); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (fs[heap[p]] <= fs[heap[c]]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; let p = 0; for (;;) { const l = 2 * p + 1, r = l + 1; let m = p; if (l < heap.length && fs[heap[l]] < fs[heap[m]]) m = l; if (r < heap.length && fs[heap[r]] < fs[heap[m]]) m = r; if (m === p) break; [heap[p], heap[m]] = [heap[m], heap[p]]; p = m; } } return top; };
  gs[si] = 0; fs[si] = h(si); push(si);
  const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.length) {
    const cur = pop();
    if (cur === ti) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % GW, cz = Math.floor(cur / GW);
    for (const [dx, dz, cost] of dirs) {
      const nx = cx + dx, nz = cz + dz;
      if (!walkable(g, nx, nz)) continue;
      if (dx && dz && (!walkable(g, cx + dx, cz) || !walkable(g, cx, cz + dz))) continue; // não corta quina
      const ni = nz * GW + nx;
      const extra = occupied && ni !== ti && occupied(nx, nz) ? 6 : 0; // contorna quem está parado no caminho
      const ng = gs[cur] + cost + extra;
      if (ng < gs[ni]) { gs[ni] = ng; came[ni] = cur; fs[ni] = ng + h(ni); push(ni); }
    }
  }
  if (came[ti] === -1 && si !== ti) return [];
  const cells: number[] = [];
  for (let i = ti; i !== -1; i = came[i]) { cells.push(i); if (i === si) break; }
  cells.reverse();
  const pts = cells.map(i => centerOf(i % GW, Math.floor(i / GW)));
  const smooth = smoothPath(g, pts);
  // o último ponto é o destino exato (não o centro da célula)
  if (smooth.length) smooth[smooth.length - 1] = { x: to.x, z: to.z };
  return smooth;
}

export function nearestFree(g: Grid, cx: number, cz: number): { cx: number; cz: number } | null {
  for (let r = 1; r < 12; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    if (walkable(g, cx + dx, cz + dz)) return { cx: cx + dx, cz: cz + dz };
  }
  return null;
}

/** Linha de visão na grade (amostragem a cada quarto de célula, com folga para o corpo). */
export function lineFree(g: Grid, a: Pt, b: Pt): boolean {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.ceil(d / (CELL * 0.25));
  for (let i = 0; i <= steps; i++) {
    const k = i / Math.max(1, steps);
    const x = a.x + (b.x - a.x) * k, z = a.z + (b.z - a.z) * k;
    for (const [ox, oz] of [[0, 0], [0.12, 0], [-0.12, 0], [0, 0.12], [0, -0.12]]) {
      const c = cellOf({ x: x + ox, z: z + oz });
      if (!walkable(g, c.cx, c.cz)) return false;
    }
  }
  return true;
}

export function smoothPath(g: Grid, pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts.slice(1);
  const out: Pt[] = [];
  let anchor = pts[0];
  let i = 1;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !lineFree(g, anchor, pts[j])) j--;
    out.push(pts[j]); anchor = pts[j]; i = j + 1;
  }
  return out;
}
