// Sala Social Media em perspectiva isométrica (piloto). Arte ORIGINAL desenhada em código (formas geométricas e os sprites
// de personagem da própria HQ); nada da arte do Habbo. A sala é desenhada numa resolução baixa e ampliada sem suavização
// (aspecto pixel art, com volume); nomes e rótulos são desenhados por cima, na fonte da interface, para ficarem nítidos.
// Consumo: só desenha quando algo muda, quando o avatar anda ou quando um funcionário trabalha de verdade (4 quadros/s);
// com a janela oculta não desenha nada.
import { SpriteCache, characterPalette, CHAR_H, HEAD_H, SIT_BODY_H } from '../sprites';
import { findPath } from '../pathfinding';
import type { SceneWorker } from '../types';

// ---------------- geometria (funções puras, testadas) ----------------
// 06/11: sala maior (16x12) para as duas equipes por perfil + pesquisa, pauta e revisão.
export const ROOM_W = 16;
export const ROOM_H = 12;
export const TW = 64;
export const TH = 32;
export const WALL_H = 118;
const MARGIN = 26;
export const ORIGIN_X = ROOM_H * (TW / 2) + MARGIN;
export const ORIGIN_Y = WALL_H + MARGIN;
export const LOW_W = (ROOM_W + ROOM_H) * (TW / 2) + MARGIN * 2;
export const LOW_H = ORIGIN_Y + (ROOM_W + ROOM_H) * (TH / 2) + MARGIN;
/** Área desenhada de fato (sem as margens): é ela que precisa caber no palco. */
export const CONTENT_W = LOW_W - MARGIN * 2;
export const CONTENT_H = LOW_H - MARGIN * 2;
export const ZOOM_MIN = 0.75;
export const ZOOM_MAX = 3;

/** Ponto do mundo (tiles; z em px acima do piso) → pixel na imagem base da sala. */
export function toLow(x: number, y: number, z = 0): { x: number; y: number } {
  return { x: ORIGIN_X + (x - y) * (TW / 2), y: ORIGIN_Y + (x + y) * (TH / 2) - z };
}
/** Pixel da imagem base (no piso, z = 0) → ponto do mundo em tiles. */
export function fromLow(lx: number, ly: number): { x: number; y: number } {
  const a = (lx - ORIGIN_X) / (TW / 2);
  const b = (ly - ORIGIN_Y) / (TH / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
/** Zoom inicial útil: a sala inteira (sem as margens da imagem base) cabe no palco, em passos de 0,25 (pixels mais regulares). */
export function fitZoom(stageW: number, stageH: number): number {
  const raw = Math.min(stageW / CONTENT_W, stageH / CONTENT_H) * 0.97;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.floor(raw * 4) / 4));
}
export function pointInPoly(px: number, py: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---------------- o que a sala sabe fazer ----------------
export type IsoTarget =
  | { kind: 'chefe-desk' }
  | { kind: 'desk'; deskIndex: number; workerId: string | null }
  | { kind: 'worker'; id: string }
  | { kind: 'media-cabinet' }
  | { kind: 'board' }
  | { kind: 'meeting-table' }
  | { kind: 'door' }
  | { kind: 'studio' }
  | { kind: 'socials' }
  /** Mesa redonda de uma equipe (estúdio 3D, 08/11): abre o painel da equipe. */
  | { kind: 'team'; team: 'aurora' | 'tuco-dev' };

export interface SocialRoomHandlers {
  onInteract(target: IsoTarget): void;
}
/** Contagens reais do perfil: fila, produção, para revisar, prontas para postar e pedidos esperando resposta do Chefe. */
export interface BoardCounts { queued: number; producing: number; review: number; ready?: number; waiting?: number; social?: number; socialTotal?: number; /** Caixa de entrada da mesa (entregas novas, perguntas, bloqueios). */ desk?: number }
export interface SocialRoom {
  setWorkers(workers: SceneWorker[]): void;
  setBoard(counts: BoardCounts): void;
  setPlayer(p: { name: string; appearance: { skin: number; hair: number; shirt: number } }): void;
  setSelected(workerId: string | null): void;
  setOptions(o: { inputEnabled?: boolean; reducedMotion?: boolean; paused?: boolean }): void;
  center(): void;
  zoomBy(dir: 1 | -1): void;
  resize(): void;
  destroy(): void;
  /** Rótulo do alvo sob o ponteiro (para testes e acessibilidade). */
  hoveredLabel(): string | null;
}

/** Mesas: ilha do Tuco Dev (0 criação, 1 vídeo), ilha da Aurora (2 criação, 3 vídeo), a fileira de quem atende as duas
 *  (4 pesquisa, 5 pauta, 6 revisão) e a do Diretor de Vídeo (7), ao lado do estúdio (07/11). */
export const DESKS: { x0: number; y0: number }[] = [{ x0: 2, y0: 5 }, { x0: 5, y0: 5 }, { x0: 9, y0: 5 }, { x0: 12, y0: 5 }, { x0: 2, y0: 8 }, { x0: 5, y0: 8 }, { x0: 9, y0: 8 }, { x0: 9, y0: 2 }];
/** Placas das equipes no piso (tapete e nome): a ilha de cada perfil. */
export const TEAM_AREAS: { label: string; x0: number; x1: number; y0: number; y1: number; rug: string; edge: string }[] = [
  { label: 'Equipe Tuco Dev', x0: 1.6, x1: 7.6, y0: 3.4, y1: 6.8, rug: '#2a3150', edge: '#7aa2ff' },
  { label: 'Equipe Aurora', x0: 8.6, x1: 14.6, y0: 3.4, y1: 6.8, rug: '#3a2620', edge: '#e8722c' },
];
/** Mesa de cada papel (template + perfil do funcionário). Quem não é da equipe de conteúdo fica com a mesa livre que sobrar. */
export function seatFor(template: string | null | undefined, profileId: string | null | undefined): number | null {
  const team = profileId === 'tuco-dev' ? 0 : profileId === 'aurora' ? 2 : null;
  if (template === 'conteudo-criador' && team !== null) return team;
  if (template === 'conteudo-video' && team !== null) return team + 1;
  if (template === 'conteudo-pesquisador') return 4;
  if (template === 'conteudo-coordenador') return 5;
  if (template === 'conteudo-revisor') return 6;
  if (template === 'conteudo-diretor-video') return 7;
  return null;
}
const CHEFE_DESK = { x0: 12.4, y0: 8, x1: 14.6, y1: 9 };
const MEETING = { cx: 8, cy: 10.3, r: 0.85 };
const CABINET = { x0: 0, y0: 1, x1: 1, y1: 2.7 };
const BOARD = { x0: 1.5, x1: 6.9, z0: 40, z1: 104 };
const DOOR = { y0: 9.6, y1: 11.1, h: 92 };

/** Tiles bloqueados para andar (móveis, cadeiras e o cantinho de gravação). */
export function blockedTiles(): boolean[][] {
  const g: boolean[][] = Array.from({ length: ROOM_H }, () => Array.from({ length: ROOM_W }, () => true));
  const block = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) if (g[y]?.[x] !== undefined) g[y][x] = false;
  };
  block(CABINET.x0, CABINET.y0, CABINET.x1, CABINET.y1);
  for (const d of DESKS) { block(d.x0, d.y0, d.x0 + 2, d.y0 + 1); block(d.x0, d.y0 - 1, d.x0 + 2, d.y0); }
  block(CHEFE_DESK.x0, CHEFE_DESK.y0, CHEFE_DESK.x1, CHEFE_DESK.y1);
  block(MEETING.cx - 1, MEETING.cy - 1, MEETING.cx + 1, MEETING.cy + 1);
  block(12.6, 0, 16, 3.2); // gravação
  block(15, 4, 16, 5); block(0, 11, 1, 12); // plantas
  return g;
}

/** Onde o avatar para diante de cada objeto (centro de um tile livre) e para onde olha ao chegar. */
export interface Approach { x: number; y: number; look: { x: number; y: number } }
export function approachFor(t: IsoTarget, deskOfWorker?: (id: string) => number | null): Approach | null {
  const front = (i: number): Approach | null => { const d = DESKS[i]; return d ? { x: d.x0 + 1.5, y: d.y0 + 1.5, look: { x: d.x0 + 1, y: d.y0 + 0.5 } } : null; };
  switch (t.kind) {
    case 'chefe-desk': return { x: 13.5, y: 9.5, look: { x: 13.5, y: 8.5 } };
    case 'board': return { x: 4.5, y: 0.5, look: { x: 4.5, y: -1 } };
    case 'socials': return { x: 0.5, y: 4.5, look: { x: -1, y: 4.5 } };
    case 'media-cabinet': return { x: 1.5, y: 1.5, look: { x: 0.5, y: 1.85 } };
    case 'meeting-table': return { x: 6.5, y: 10.5, look: { x: 8, y: 10.3 } };
    case 'door': return { x: 0.5, y: 10.5, look: { x: -1, y: 10.5 } };
    case 'studio': return { x: 11.5, y: 3.5, look: { x: 14, y: 1.5 } };
    case 'desk': return front(t.deskIndex);
    case 'worker': { const i = deskOfWorker?.(t.id); return i == null ? null : front(i); }
    case 'team': return null;
  }
}

/** Balão sobre o funcionário: o que ele faz agora, com o estado real (nada aparece quando ele está livre). */
export type BubbleTone = 'work' | 'wait' | 'queue' | 'error';
const PHASE_TEXT: Record<string, string> = { thinking: 'pensando', responding: 'escrevendo a resposta', reading: 'lendo arquivos', writing: 'escrevendo arquivo', executing: 'rodando comando', delegating: 'delegando a um subagente' };
export function bubbleFor(w: Pick<SceneWorker, 'phase' | 'detail' | 'status' | 'observed'>): { text: string; tone: BubbleTone } | null {
  if (w.observed) return null;
  if (w.status === 'waiting_permission' || w.phase === 'waiting_permission') return { text: 'precisa da sua permissão', tone: 'wait' };
  if (w.status === 'waiting_answer' || w.phase === 'waiting_answer') return { text: 'tem uma pergunta para você', tone: 'wait' };
  if (w.status === 'error') return { text: 'parou com erro', tone: 'error' };
  if (w.status === 'queued') return { text: 'na fila', tone: 'queue' };
  const phase = PHASE_TEXT[String(w.phase)];
  if (!phase && w.status !== 'running') return null;
  const detail = (w.detail ?? '').trim();
  const useDetail = detail && !/^(pensando|trabalhando|executando)$/i.test(detail);
  const text = useDetail ? (detail.length > 34 ? detail.slice(0, 33).trimEnd() + '…' : detail) : phase ?? 'trabalhando';
  return { text, tone: 'work' };
}

// ---------------- cores (identidade Aurora: escuro, âmbar, madeira, plantas) ----------------
const C = {
  bg: '#1b1714', floorA: '#6b4a32', floorB: '#5f4129', floorLine: 'rgba(30,18,10,0.35)',
  rug: '#3b2a3f', rugEdge: '#d9973a', wallL: '#3a3036', wallR: '#463940', wallTop: '#c9832f', base: '#2a2024',
  wood: '#9a6a3f', woodDark: '#6e4a2b', woodTop: '#b98552', metal: '#2f3138', metalTop: '#4a4d57',
  amber: '#f0a830', amberSoft: 'rgba(240,168,48,0.35)', screen: '#7fd1ff', cork: '#a77b4f', leaf: '#4f8a4a', leafDark: '#356b38', pot: '#7a4a33',
  teal: '#2c6e73', fabric: '#2a3b45',
};

interface Drawable { anchor?: { x: number; y: number; z: number }; key?: string; depth: number; draw(): void; hit?: { x: number; y: number }[][]; target?: IsoTarget; label?: string; short?: string; alert?: boolean; box?: { x: number; y: number; w: number; h: number } }

export function createSocialRoom(canvas: HTMLCanvasElement, handlers: SocialRoomHandlers): SocialRoom {
  const ctx = canvas.getContext('2d')!;
  const low = document.createElement('canvas');
  low.width = LOW_W; low.height = LOW_H;
  const g = low.getContext('2d')!;
  const sprites = new SpriteCache();
  const walk = blockedTiles();
  let workers: SceneWorker[] = [];
  let board: BoardCounts = { queued: 0, producing: 0, review: 0, ready: 0, waiting: 0 };
  let selected: string | null = null;
  let player = { name: 'Chefe', appearance: { skin: 1, hair: 1, shirt: 0 } };
  const avatar = { x: 11.5, y: 10.5, path: [] as { x: number; y: number }[], dir: 'down' as 'up' | 'down' | 'left' | 'right', walkT: 0, look: null as { x: number; y: number } | null };
  let opts = { inputEnabled: true, reducedMotion: false, paused: false };
  let zoom = 1; let ox = 0; let oy = 0; let fitted = false; let autoFit = true;
  let hovered: Drawable | null = null;
  let drawables: Drawable[] = [];
  let dirty = true; let raf = 0; let slowTimer = 0; let destroyed = false; let clock = 0; let last = 0;
  const keys = new Set<string>();
  let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;

  // ---------- desenho base (na resolução baixa) ----------
  const P = (x: number, y: number, z = 0) => toLow(x, y, z);
  const poly = (pts: { x: number; y: number }[], fill: string, stroke?: string) => {
    g.beginPath(); g.moveTo(Math.round(pts[0].x), Math.round(pts[0].y));
    for (const p of pts.slice(1)) g.lineTo(Math.round(p.x), Math.round(p.y));
    g.closePath(); g.fillStyle = fill; g.fill();
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
  };
  /** Prisma retangular: devolve os polígonos visíveis (para clique e realce). */
  const prism = (x0: number, y0: number, x1: number, y1: number, z0: number, h: number, top: string, left: string, right: string) => {
    const t = [P(x0, y0, z0 + h), P(x1, y0, z0 + h), P(x1, y1, z0 + h), P(x0, y1, z0 + h)];
    const l = [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z0 + h), P(x0, y1, z0 + h)];
    const r = [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z0 + h), P(x1, y0, z0 + h)];
    poly(l, left); poly(r, right); poly(t, top);
    return [t, l, r];
  };
  const shade = (hex: string, k: number) => {
    const n = parseInt(hex.slice(1), 16); const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  };
  const box = (x0: number, y0: number, x1: number, y1: number, z0: number, h: number, base: string) => prism(x0, y0, x1, y1, z0, h, shade(base, 1.18), shade(base, 0.82), shade(base, 0.62));

  function drawFloorAndWalls(): void {
    // piso de madeira em tábuas (alterna tons por tile) + rejunte discreto
    for (let y = 0; y < ROOM_H; y++) for (let x = 0; x < ROOM_W; x++) {
      poly([P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)], (x + Math.floor(y / 2)) % 2 ? C.floorA : C.floorB, C.floorLine);
    }
    // tapetes: um por equipe de perfil (cor da marca na borda) e o da fileira que atende as duas
    for (const a of TEAM_AREAS) {
      poly([P(a.x0, a.y0), P(a.x1, a.y0), P(a.x1, a.y1), P(a.x0, a.y1)], a.rug);
      poly([P(a.x0, a.y0), P(a.x1, a.y0), P(a.x1, a.y1), P(a.x0, a.y1)], 'rgba(0,0,0,0)', a.edge);
    }
    poly([P(1.6, 7.1), P(11.6, 7.1), P(11.6, 9.8), P(1.6, 9.8)], C.rug);
    poly([P(1.6, 7.1), P(11.6, 7.1), P(11.6, 9.8), P(1.6, 9.8)], 'rgba(0,0,0,0)', C.rugEdge);
    // paredes abertas para a câmera: só as duas do fundo
    poly([P(0, 0), P(0, ROOM_H), P(0, ROOM_H, WALL_H), P(0, 0, WALL_H)], C.wallL);
    poly([P(0, 0), P(ROOM_W, 0), P(ROOM_W, 0, WALL_H), P(0, 0, WALL_H)], C.wallR);
    poly([P(0, 0, WALL_H), P(0, ROOM_H, WALL_H), P(0, ROOM_H, WALL_H + 5), P(0, 0, WALL_H + 5)], C.wallTop);
    poly([P(0, 0, WALL_H), P(ROOM_W, 0, WALL_H), P(ROOM_W, 0, WALL_H + 5), P(0, 0, WALL_H + 5)], C.wallTop);
    poly([P(0, 0), P(0, ROOM_H), P(0, ROOM_H, 7), P(0, 0, 7)], C.base);
    poly([P(0, 0), P(ROOM_W, 0), P(ROOM_W, 0, 7), P(0, 0, 7)], C.base);
    // janela com luz do fim de tarde
    poly([P(7.3, 0, 46), P(8.5, 0, 46), P(8.5, 0, 100), P(7.3, 0, 100)], '#2b4a5c', C.woodDark);
    poly([P(7.3, 0, 72), P(8.5, 0, 72), P(8.5, 0, 74), P(7.3, 0, 74)], C.woodDark);
    // placa da sala (neon âmbar): MILWEB / SOCIAL MEDIA
    poly([P(0, 3.0, 72), P(0, 5.8, 72), P(0, 5.8, 106), P(0, 3.0, 106)], '#1e181b', C.amber);
    // texto acompanhando a parede da esquerda (direção na tela: +32 px em x, -16 px em y por tile)
    const wallText = (text: string, y: number, z: number, px: number, color: string) => {
      const p0 = P(0, y, z);
      g.save(); g.fillStyle = color; g.font = `${px}px 'Press Start 2P', monospace`; g.textBaseline = 'alphabetic';
      g.setTransform(1, -0.5, 0, 1, p0.x, p0.y); g.fillText(text, 0, 0); g.restore();
    };
    wallText('MILWEB', 5.45, 90, 8, C.amber);
    wallText('SOCIAL MEDIA', 5.62, 78, 6, '#e3d6c0');
    // fundo de gravação (tecido) na parede da direita
    poly([P(8.8, 0, 0), P(11.8, 0, 0), P(11.8, 0, 104), P(8.8, 0, 104)], C.fabric);
  }

  function seatOf(i: number): { x: number; y: number } { const d = DESKS[i]; return { x: d.x0 + 1, y: d.y0 - 0.45 }; }

  function buildDrawables(): Drawable[] {
    const out: Drawable[] = [];
    // armário de mídia
    out.push({ key: 'media-cabinet', depth: CABINET.x1 + CABINET.y1, target: { kind: 'media-cabinet' }, short: 'Mídia', label: 'Armário de mídia · arquivos e referências', draw() {
      const faces = box(CABINET.x0, CABINET.y0, CABINET.x1, CABINET.y1, 0, 82, C.woodDark);
      // prateleiras e caixas coloridas na frente (face da direita)
      for (let k = 1; k <= 3; k++) poly([P(1, 1.05, k * 20), P(1, 2.65, k * 20), P(1, 2.65, k * 20 + 2), P(1, 1.05, k * 20 + 2)], C.wood);
      const cols = ['#d9973a', '#2c6e73', '#b5486a', '#e3d6c0', '#4f8a4a'];
      for (let k = 0; k < 9; k++) { const yy = 1.15 + (k % 3) * 0.48; const zz = 4 + Math.floor(k / 3) * 20; poly([P(1, yy, zz), P(1, yy + 0.32, zz), P(1, yy + 0.32, zz + 14), P(1, yy, zz + 14)], cols[k % cols.length]); }
      this.hit = faces;
    } });
    // mural de conteúdo (parede da direita): Fila / Produção / Revisar / Pronto, notas = contagens reais do perfil
    const ready = board.ready ?? 0;
    // rótulo no canto alto do mural (a parede desce para a direita): fica acima das etiquetas das colunas
    out.push({ key: 'board', anchor: { x: BOARD.x0 + 0.75, y: 0, z: BOARD.z1 + 9 }, depth: 0.5, target: { kind: 'board' }, short: board.review ? `Mural · ${board.review} para revisar` : 'Mural', alert: board.review > 0,
      label: `Mural · ${board.queued} na fila, ${board.producing} em produção, ${board.review} para revisar, ${ready} pronta(s)`, draw() {
      const q = [P(BOARD.x0, 0, BOARD.z0), P(BOARD.x1, 0, BOARD.z0), P(BOARD.x1, 0, BOARD.z1), P(BOARD.x0, 0, BOARD.z1)];
      poly(q, C.cork, C.woodDark);
      const colW = (BOARD.x1 - BOARD.x0 - 0.2) / 4;
      const cols: [string, string, number][] = [['Fila', '#f2d15b', board.queued], ['Criando', '#7fd1ff', board.producing], ['Revisar', '#f0a830', board.review], ['Pronto', '#9be38f', ready]];
      cols.forEach(([title, color, n], ci) => {
        const cx0 = BOARD.x0 + 0.1 + ci * colW;
        poly([P(cx0 + 0.04, 0, BOARD.z1 - 7), P(cx0 + colW - 0.04, 0, BOARD.z1 - 7), P(cx0 + colW - 0.04, 0, BOARD.z1 - 4), P(cx0 + 0.04, 0, BOARD.z1 - 4)], color);
        void title;
        if (ci > 0) poly([P(cx0, 0, BOARD.z0 + 3), P(cx0 + 0.03, 0, BOARD.z0 + 3), P(cx0 + 0.03, 0, BOARD.z1 - 3), P(cx0, 0, BOARD.z1 - 3)], 'rgba(60,40,24,0.45)');
        const nw = colW / 2 - 0.14;
        for (let k = 0; k < Math.min(6, n); k++) {
          const xx = cx0 + 0.1 + (k % 2) * (colW / 2 - 0.04); const zz = BOARD.z1 - 30 - Math.floor(k / 2) * 17;
          poly([P(xx, 0, zz), P(xx + nw, 0, zz), P(xx + nw, 0, zz + 12), P(xx, 0, zz + 12)], color);
          const pin = P(xx + nw / 2, 0, zz + 10); g.fillStyle = '#3a2416'; g.fillRect(Math.round(pin.x) - 1, Math.round(pin.y) - 1, 2, 2);
        }
        if (n > 6) { const pl = P(cx0 + 0.15, 0, BOARD.z0 + 4); g.save(); g.fillStyle = '#fff6d8'; g.font = "5px 'Press Start 2P', monospace"; g.setTransform(1, 0.5, 0, 1, pl.x, pl.y); g.fillText(`+${n - 6}`, 0, 0); g.restore(); }
      });
      this.hit = [q];
    } });
    // telinhas das redes na parede da esquerda: identificáveis e apagadas (não conectadas)
    out.push({ key: 'socials', anchor: { x: 0, y: 4.45, z: 12 }, depth: 0.45, target: { kind: 'socials' }, short: `Redes ${board.social ?? 0}/${board.socialTotal ?? 7}`, label: `Central de Redes · ${board.social ?? 0} de ${board.socialTotal ?? 7} contas verificadas`, draw() {
      const nets: [string, string][] = [['IG', '#b5486a'], ['TT', '#2a9d9f'], ['IN', '#2f6aa8']];
      const faces: { x: number; y: number }[][] = [];
      nets.forEach(([name, tint], k) => {
        const yA = 5.45 - k * 0.72, yB = yA - 0.6, z0 = 30, z1 = 60;
        const frame = [P(0, yB, z0), P(0, yA, z0), P(0, yA, z1), P(0, yB, z1)];
        poly(frame, '#16181d', '#3a3036');
        poly([P(0, yB + 0.06, z0 + 3), P(0, yA - 0.06, z0 + 3), P(0, yA - 0.06, z1 - 3), P(0, yB + 0.06, z1 - 3)], shade(tint, 0.45));
        const t0 = P(0, yA - 0.12, z0 + 18);
        g.save(); g.fillStyle = shade(tint, 1.35); g.font = "6px 'Press Start 2P', monospace"; g.setTransform(1, -0.5, 0, 1, t0.x, t0.y); g.fillText(name, 0, 0); g.restore();
        const dot = P(0, yB + 0.14, z0 + 7); g.fillStyle = '#8a8f99'; g.fillRect(Math.round(dot.x) - 1, Math.round(dot.y) - 1, 3, 3);
        faces.push(frame);
      });
      this.hit = faces;
    } });
    // porta (parede da esquerda) → outras salas
    out.push({ key: 'door', depth: 0.4, target: { kind: 'door' }, short: 'Porta', label: 'Porta · outras salas', draw() {
      const q = [P(0, DOOR.y0), P(0, DOOR.y1), P(0, DOOR.y1, DOOR.h), P(0, DOOR.y0, DOOR.h)];
      poly(q, C.wood, C.woodDark);
      const h = P(0, DOOR.y1 - 0.25, 44); g.fillStyle = C.amber; g.fillRect(Math.round(h.x) - 2, Math.round(h.y) - 2, 3, 3);
      this.hit = [q];
    } });
    // estúdio de vídeo: fundo de tecido, luz de anel, tripé com câmera e banco
    out.push({ key: 'studio', depth: 14.5 + 1.6, target: { kind: 'studio' }, short: 'Estúdio', label: 'Estúdio de vídeo · roteiros, Reels e TikTok', draw() {
      const base = P(14.5, 1.6); g.fillStyle = C.metal; g.fillRect(Math.round(base.x) - 1, Math.round(base.y) - 74, 2, 74);
      g.strokeStyle = '#fff6d8'; g.lineWidth = 4; g.beginPath(); g.ellipse(Math.round(base.x), Math.round(base.y) - 82, 13, 15, 0, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = C.amberSoft; g.lineWidth = 9; g.stroke();
      const t = P(13.4, 2.6); g.strokeStyle = C.metal; g.lineWidth = 2; g.beginPath(); g.moveTo(t.x, t.y - 46); g.lineTo(t.x - 9, t.y); g.moveTo(t.x, t.y - 46); g.lineTo(t.x + 9, t.y); g.moveTo(t.x, t.y - 46); g.lineTo(t.x, t.y + 3); g.stroke();
      g.fillStyle = '#16181d'; g.fillRect(Math.round(t.x) - 9, Math.round(t.y) - 58, 18, 12); g.fillStyle = C.screen; g.fillRect(Math.round(t.x) + 6, Math.round(t.y) - 54, 3, 3);
      box(14.1, 2.5, 14.7, 3.1, 0, 18, '#3c3f48');
      const rect = (cx: number, top: number, bottom: number, half: number) => [{ x: cx - half, y: top }, { x: cx + half, y: top }, { x: cx + half, y: bottom }, { x: cx - half, y: bottom }];
      this.hit = [[P(12.8, 0, 0), P(15.8, 0, 0), P(15.8, 0, 104), P(12.8, 0, 104)], rect(base.x, base.y - 100, base.y, 16), rect(t.x, t.y - 60, t.y + 4, 12)];
    } });
    // plantas
    const plant = (x: number, y: number, s = 1) => out.push({ depth: x + y + 0.8, draw() {
      box(x, y, x + 0.6, y + 0.6, 0, 16, C.pot);
      const c = P(x + 0.3, y + 0.3, 16);
      for (const [dx, dy, r, col] of [[0, -14, 11, C.leafDark], [-7, -8, 8, C.leaf], [7, -9, 8, C.leaf], [0, -24, 8, C.leaf]] as [number, number, number, string][]) { g.fillStyle = col; g.beginPath(); g.arc(Math.round(c.x + dx * s), Math.round(c.y + dy * s), r * s, 0, Math.PI * 2); g.fill(); }
    } });
    plant(15.2, 4.2, 1.2); plant(0.2, 11.2, 1.1);
    // mesas dos funcionários (cadeira atrás, funcionário de frente para a câmera)
    DESKS.forEach((d, i) => {
      const w = workerAt(i);
      out.push({ depth: d.x0 + 1 + d.y0 - 1.2, draw() { box(d.x0 + 0.6, d.y0 - 1.05, d.x0 + 1.4, d.y0 - 0.9, 0, 44, C.metal); box(d.x0 + 0.65, d.y0 - 0.9, d.x0 + 1.35, d.y0 - 0.35, 0, 14, C.metal); } });
      const target: IsoTarget = { kind: 'desk', deskIndex: i, workerId: w?.id ?? null };
      out.push({ key: `desk:${i}`, depth: d.x0 + 2 + d.y0 + 1, target, short: w ? undefined : 'Mesa livre', label: w ? `Mesa de ${w.name} · conversa e tarefas` : 'Mesa livre · contratar funcionário', draw() {
        const top = box(d.x0, d.y0, d.x0 + 2, d.y0 + 1, 0, 24, C.wood);
        // monitor de costas para a câmera; brilho quando a pessoa trabalha de verdade
        const busy = Boolean(w && isWorking(w));
        if (busy) { const c = P(d.x0 + 1, d.y0 + 0.3, 46); g.fillStyle = 'rgba(127,209,255,0.22)'; g.beginPath(); g.arc(Math.round(c.x), Math.round(c.y), 22, 0, Math.PI * 2); g.fill(); }
        box(d.x0 + 0.55, d.y0 + 0.2, d.x0 + 1.45, d.y0 + 0.36, 24, 30, '#23252b');
        box(d.x0 + 0.92, d.y0 + 0.36, d.x0 + 1.08, d.y0 + 0.5, 24, 8, C.metalTop);
        box(d.x0 + 1.6, d.y0 + 0.55, d.x0 + 1.8, d.y0 + 0.75, 24, 7, w ? '#e3d6c0' : '#6b5c50'); // caneca
        this.hit = top;
      } });
    });
    // mesa do Chefe: notebook aberto, papéis e luminária
    const forChefe = board.desk ?? ((board.waiting ?? 0) + board.review);
    out.push({ key: 'chefe-desk', depth: CHEFE_DESK.x1 + CHEFE_DESK.y1, target: { kind: 'chefe-desk' }, short: forChefe ? `Sua mesa · ${forChefe}` : 'Sua mesa', alert: forChefe > 0,
      label: forChefe ? `Mesa do Chefe · ${forChefe} item(ns) na caixa de entrada (entregas, perguntas, bloqueios)` : 'Mesa do Chefe · entregas, perguntas e bloqueios', draw() {
      const faces = box(CHEFE_DESK.x0, CHEFE_DESK.y0, CHEFE_DESK.x1, CHEFE_DESK.y1, 0, 26, '#8c5d36');
      box(9.0, 5.25, 9.8, 5.75, 26, 2, '#cfd3da');
      poly([P(9.0, 5.25, 28), P(9.8, 5.25, 28), P(9.8, 5.25, 46), P(9.0, 5.25, 46)], '#20232a', '#cfd3da');
      poly([P(9.08, 5.25, 31), P(9.72, 5.25, 31), P(9.72, 5.25, 43), P(9.08, 5.25, 43)], C.screen);
      box(10.0, 5.4, 10.35, 5.8, 26, 1, '#efe8d8');
      const l = P(8.7, 5.4, 26); g.fillStyle = C.metal; g.fillRect(Math.round(l.x), Math.round(l.y) - 22, 2, 22); g.fillStyle = C.amber; g.fillRect(Math.round(l.x) - 4, Math.round(l.y) - 26, 10, 5);
      this.hit = faces;
    } });
    // mesa de reunião redonda com bancos
    out.push({ key: 'meeting-table', depth: MEETING.cx + MEETING.cy + 0.6, target: { kind: 'meeting-table' }, short: 'Reunião', label: 'Mesa de reunião · reuniões e participantes', draw() {
      const c = P(MEETING.cx, MEETING.cy); const rx = MEETING.r * TW / 2 * 1.4, ry = rx / 2;
      for (const [sx, sy] of [[-0.95, 0], [0.95, 0], [0, -0.95], [0, 0.95]] as [number, number][]) box(MEETING.cx + sx - 0.18, MEETING.cy + sy - 0.18, MEETING.cx + sx + 0.18, MEETING.cy + sy + 0.18, 0, 12, C.woodDark);
      g.fillStyle = C.woodDark; g.fillRect(Math.round(c.x) - 3, Math.round(c.y) - 22, 6, 22);
      g.fillStyle = shade(C.wood, 0.75); g.beginPath(); g.ellipse(Math.round(c.x), Math.round(c.y) - 22, rx, ry, 0, 0, Math.PI); g.lineTo(c.x - rx, c.y - 26); g.fill();
      g.fillStyle = C.woodTop; g.beginPath(); g.ellipse(Math.round(c.x), Math.round(c.y) - 26, rx, ry, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = C.amber; g.lineWidth = 1; g.stroke();
      this.hit = [Array.from({ length: 12 }, (_, k) => ({ x: c.x + Math.cos(k / 12 * Math.PI * 2) * rx, y: c.y - 26 + Math.sin(k / 12 * Math.PI * 2) * ry + (Math.sin(k / 12 * Math.PI * 2) > 0 ? 6 : 0) }))];
    } });
    // funcionários sentados
    DESKS.forEach((_, i) => {
      const w = workerAt(i); if (!w) return;
      const s = seatOf(i);
      out.push({ key: `worker:${w.id}`, depth: s.x + s.y, target: { kind: 'worker', id: w.id }, label: `${w.name}${w.observed ? ' (observado)' : ''} · ${statusText(w)}`, draw() { this.box = drawCharacter(s.x, s.y, w.appearance, true, isWorking(w), Boolean(w.observed), 'down'); } });
    });
    // avatar do Chefe
    out.push({ depth: avatar.x + avatar.y + 0.01, label: `${player.name} · você`, draw() { this.box = drawCharacter(avatar.x, avatar.y, player.appearance, false, false, false, avatar.dir, true); } });
    return out.sort((a, b) => a.depth - b.depth);
  }

  function workerAt(i: number): SceneWorker | null {
    const placed = placement();
    return placed.get(i) ?? null;
  }
  /** Mesa de cada funcionário: a do servidor (deskIndex) quando livre; senão a primeira livre. Sem mesa, fica fora da cena. */
  function placement(): Map<number, SceneWorker> {
    const m = new Map<number, SceneWorker>();
    const sorted = [...workers].sort((a, b) => Number(Boolean(a.observed)) - Number(Boolean(b.observed)));
    for (const w of sorted) {
      let i = w.deskIndex >= 0 && w.deskIndex < DESKS.length && !m.has(w.deskIndex) ? w.deskIndex : -1;
      if (i < 0) i = DESKS.findIndex((_, k) => !m.has(k));
      if (i >= 0) m.set(i, w);
    }
    return m;
  }
  function isWorking(w: SceneWorker): boolean { return ['thinking', 'responding', 'reading', 'writing', 'executing', 'delegating'].includes(String(w.phase)) || w.status === 'running'; }
  function statusText(w: SceneWorker): string {
    if (w.observed) return 'sessão observada';
    if (w.status === 'waiting_permission' || w.status === 'waiting_answer') return 'aguardando você';
    if (isWorking(w)) return 'trabalhando';
    if (w.status === 'queued') return 'na fila';
    if (w.status === 'error') return 'com erro';
    return 'disponível';
  }

  const CHAR_SCALE = 2;
  function drawCharacter(x: number, y: number, app: { skin: number; hair: number; shirt: number }, seated: boolean, typing: boolean, ghost: boolean, dir: 'up' | 'down' | 'left' | 'right', isPlayer = false): { x: number; y: number; w: number; h: number } {
    const p = P(x, y);
    const dyn = characterPalette(app, ghost, isPlayer);
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.beginPath(); g.ellipse(Math.round(p.x), Math.round(p.y), 15, 6, 0, 0, Math.PI * 2); g.fill();
    const z = CHAR_SCALE;
    const parts: { name: string; flip: boolean; dy: number }[] = [];
    if (seated) {
      const body = typing && !opts.reducedMotion ? `c.body.sit.type${Math.floor(clock / 260) % 2}` : 'c.body.sit';
      parts.push({ name: body, flip: false, dy: -(SIT_BODY_H + 12) }, { name: 'c.head.down', flip: false, dy: -(SIT_BODY_H + HEAD_H + 12) });
    } else {
      const side = dir === 'left' || dir === 'right';
      const moving = avatar.path.length > 0 || keys.size > 0;
      const frame = Math.floor(avatar.walkT / 130) % 4; const step = frame === 1 ? 0 : frame === 3 ? 1 : -1;
      const body = moving && step >= 0 ? `c.body.walk.${side ? 'side' : 'front'}.${step}` : side ? 'c.body.stand.side' : 'c.body.stand.front';
      const head = dir === 'up' ? 'c.head.up' : dir === 'down' ? 'c.head.down' : 'c.head.side';
      parts.push({ name: body, flip: dir === 'left', dy: -(CHAR_H - HEAD_H) }, { name: head, flip: dir === 'left', dy: -CHAR_H });
    }
    if (ghost) g.globalAlpha = 0.78;
    let top = Infinity;
    for (const part of parts) {
      let cv: HTMLCanvasElement;
      try { cv = sprites.get(part.name, z, dyn, part.flip); } catch { continue; }
      const px = Math.round(p.x - cv.width / 2); const py = Math.round(p.y + part.dy * z);
      g.drawImage(cv, px, py); top = Math.min(top, py);
    }
    g.globalAlpha = 1;
    return { x: Math.round(p.x - 10 * z), y: top === Infinity ? p.y - 56 : top, w: 20 * z, h: (top === Infinity ? 56 : p.y - top) };
  }

  // ---------- quadro ----------
  function render(): void {
    if (!fitted) center();
    g.clearRect(0, 0, LOW_W, LOW_H);
    drawFloorAndWalls();
    drawables = buildDrawables();
    for (const d of drawables) d.draw.call(d);
    if (hovered) hovered = drawables.find(d => d.key && d.key === hovered!.key) ?? null;
    // realce do alvo sob o ponteiro: contorno âmbar nas faces visíveis
    if (hovered && hovered.target) {
      const cur = hovered;
      for (const face of cur?.hit ?? []) poly(face, 'rgba(240,168,48,0.10)', C.amber);
      if (cur?.box) { g.strokeStyle = C.amber; g.lineWidth = 1; g.strokeRect(cur.box.x - 1, cur.box.y - 1, cur.box.w + 2, cur.box.h + 2); }
    }
    // luz quente ambiente (sem escurecer o que importa)
    const lg = g.createRadialGradient(LOW_W * 0.55, LOW_H * 0.45, 40, LOW_W * 0.55, LOW_H * 0.45, LOW_W * 0.7);
    lg.addColorStop(0, 'rgba(255,190,110,0.08)'); lg.addColorStop(1, 'rgba(0,0,0,0.18)');
    // só sobre o que foi desenhado (source-atop): fora da sala fica transparente e o fundo do palco aparece
    g.globalCompositeOperation = 'source-atop'; g.fillStyle = lg; g.fillRect(0, 0, LOW_W, LOW_H); g.globalCompositeOperation = 'source-over';

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(low, Math.round(ox), Math.round(oy), Math.round(LOW_W * zoom), Math.round(LOW_H * zoom));
    drawLabels();
  }

  function screenOf(lx: number, ly: number) { return { x: ox + lx * zoom, y: oy + ly * zoom }; }
  function tag(text: string, sx: number, sy: number, style: 'name' | 'hover' | 'me' | 'warn' | 'obj' | 'objwarn', team?: string) {
    const small = style === 'obj' || style === 'objwarn';
    ctx.font = `${small ? 500 : 600} ${small ? 11 : 12}px 'Inter', system-ui, sans-serif`;
    const w = Math.ceil(ctx.measureText(text).width) + (small ? 12 : 14); const h = small ? 18 : 20;
    const x = Math.round(sx - w / 2); const y = Math.round(sy - h);
    ctx.fillStyle = style === 'hover' ? 'rgba(240,168,48,0.95)' : style === 'me' ? 'rgba(42,30,10,0.92)' : style === 'warn' ? 'rgba(90,60,10,0.95)' : style === 'objwarn' ? 'rgba(240,168,48,0.9)' : style === 'obj' ? 'rgba(18,16,20,0.62)' : 'rgba(18,16,20,0.85)';
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.fill();
    if (style === 'name' || style === 'me' || style === 'warn') { ctx.strokeStyle = style === 'name' ? team ?? 'rgba(255,255,255,0.12)' : C.amber; ctx.lineWidth = team && style === 'name' ? 1.5 : 1; ctx.stroke(); }
    ctx.fillStyle = style === 'hover' || style === 'objwarn' ? '#1a1206' : style === 'name' ? '#ece6dc' : style === 'obj' ? '#d9cdb9' : '#ffd27a';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, sx, y + h / 2 + 0.5);
  }
  const BUBBLE: Record<BubbleTone, { bg: string; border: string; fg: string }> = {
    work: { bg: 'rgba(22,40,52,0.95)', border: '#7fd1ff', fg: '#d6f0ff' },
    wait: { bg: 'rgba(240,168,48,0.97)', border: '#ffd27a', fg: '#1a1206' },
    queue: { bg: 'rgba(40,36,44,0.92)', border: '#6b5c50', fg: '#d9cdb9' },
    error: { bg: 'rgba(90,31,26,0.95)', border: '#e36a5a', fg: '#ffd9d3' },
  };
  /** Balão com ponta para baixo; reticências animadas enquanto o funcionário trabalha (a 4 quadros/s). */
  function bubble(b: { text: string; tone: BubbleTone }, sx: number, sy: number, animate: boolean) {
    const st = BUBBLE[b.tone];
    const dots = animate && !opts.reducedMotion ? '.'.repeat(1 + (Math.floor(clock / 500) % 3)) : '';
    const text = b.tone === 'work' && !b.text.endsWith('…') ? b.text + dots : b.text;
    ctx.font = "500 11px 'Inter', system-ui, sans-serif";
    const w = Math.ceil(ctx.measureText(b.text + (b.tone === 'work' ? '...' : '')).width) + 14; const h = 19;
    const x = Math.round(sx - w / 2); const y = Math.round(sy - h - 5);
    ctx.fillStyle = st.bg; ctx.strokeStyle = st.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx - 4, y + h); ctx.lineTo(sx, y + h + 5); ctx.lineTo(sx + 4, y + h); ctx.closePath(); ctx.fillStyle = st.bg; ctx.fill();
    ctx.fillStyle = st.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 7, y + h / 2 + 0.5);
  }
  /** Legenda das equipes no canto da sala (fora do piso, então nunca cobre ninguém). */
  function teamLegend() {
    ctx.font = "600 12px 'Inter', system-ui, sans-serif"; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    let y = 44;
    for (const a of TEAM_AREAS) {
      const w = Math.ceil(ctx.measureText(a.label).width) + 30;
      ctx.fillStyle = 'rgba(14,12,16,0.78)'; ctx.beginPath(); ctx.roundRect(22, y - 11, w, 22, 6); ctx.fill();
      ctx.fillStyle = a.rug; ctx.strokeStyle = a.edge; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(30, y - 5, 10, 10, 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = a.edge; ctx.fillText(a.label, 46, y + 0.5);
      y += 27;
    }
  }
  function drawLabels(): void {
    // rótulos curtos e fixos dos objetos (o que está sob o ponteiro ganha o rótulo completo, abaixo)
    for (const d of drawables) {
      if (!d.short || !d.target || d === hovered) continue;
      if (d.anchor) { const a = P(d.anchor.x, d.anchor.y, d.anchor.z); const s = screenOf(a.x, a.y); tag(d.short, s.x, s.y, d.alert ? 'objwarn' : 'obj'); continue; }
      const b = boundsOf(d); if (!b) continue;
      const s = screenOf(b.x + b.w / 2, b.y - 3); tag(d.short, s.x, s.y, d.alert ? 'objwarn' : 'obj');
    }
    boardPills();
    // legenda fixa das equipes (canto de cima da sala): a cor de cada uma é a do tapete e a da borda do nome
    teamLegend();
    for (const d of drawables) {
      if (!d.box) continue;
      const top = screenOf(d.box.x + d.box.w / 2, d.box.y - 4);
      const t = d.target;
      if (t?.kind === 'worker') {
        const w = workers.find(x => x.id === t.id);
        if (!w) continue;
        const waiting = w.status === 'waiting_permission' || w.status === 'waiting_answer';
        tag(w.name, top.x, top.y, waiting ? 'warn' : selected === w.id ? 'me' : 'name', TEAM_AREAS.find(a => w.role?.includes(a.label))?.edge);
        const b = bubbleFor(w);
        if (b) bubble(b, top.x, top.y - 22, isWorking(w));
      } else if (d.label?.endsWith('· você')) tag(d.label.replace(' · você', ' · Você'), top.x, top.y, 'me');
    }
    if (hovered && hovered.target && hovered.target.kind !== 'worker') {
      const b = boundsOf(hovered);
      if (b) { const s = screenOf(b.x + b.w / 2, b.y - 6); tag(hovered.label ?? '', s.x, s.y, 'hover'); }
    }
  }
  /** Etiquetas nítidas no topo de cada coluna do mural: nome e contagem quando cabe; só a contagem quando a coluna é estreita. */
  function boardPills(): void {
    const colW = (BOARD.x1 - BOARD.x0 - 0.2) / 4;
    const cols: [string, string, number][] = [['Fila', '#f2d15b', board.queued], ['Criando', '#7fd1ff', board.producing], ['Revisar', '#f0a830', board.review], ['Pronto', '#9be38f', board.ready ?? 0]];
    ctx.font = "600 9.5px 'Inter', system-ui, sans-serif";
    const colPx = colW * (TW / 2) * zoom;
    cols.forEach(([name, color, n], ci) => {
      const c = P(BOARD.x0 + 0.1 + ci * colW + colW / 2, 0, BOARD.z1 - 13); const s = screenOf(c.x, c.y);
      const full = `${name} ${n}`; const text = ctx.measureText(full).width + 8 <= colPx ? full : String(n);
      const w = Math.ceil(ctx.measureText(text).width) + 7, h = 14;
      ctx.fillStyle = 'rgba(24,16,10,0.82)'; ctx.beginPath(); ctx.roundRect(Math.round(s.x - w / 2), Math.round(s.y - h / 2), w, h, 4); ctx.fill();
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, s.x, s.y + 0.5);
    });
  }
  function boundsOf(d: Drawable): { x: number; y: number; w: number; h: number } | null {
    if (d.box) return d.box;
    const pts = (d.hit ?? []).flat(); if (!pts.length) return null;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }

  // ---------- agendamento leve ----------
  function needsMotion(): boolean { return avatar.path.length > 0 || keys.size > 0; }
  function needsSlow(): boolean { return !opts.reducedMotion && workers.some(w => isWorking(w)); }
  function frame(now: number): void {
    raf = 0; if (destroyed || opts.paused || document.hidden) return;
    const dt = last ? Math.min(60, now - last) : 16; last = now; clock += dt;
    step(dt);
    render(); dirty = false;
    if (needsMotion()) raf = requestAnimationFrame(frame); else { last = 0; scheduleSlow(); }
  }
  function kick(): void {
    if (destroyed || opts.paused || document.hidden) return;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function scheduleSlow(): void {
    if (slowTimer || !needsSlow() || opts.paused) return;
    slowTimer = window.setTimeout(() => { slowTimer = 0; clock += 250; dirty = true; kick(); }, 250);
  }
  const markDirty = () => { dirty = true; kick(); };

  // ---------- movimento ----------
  const SPEED = 3.2; // tiles/s
  function step(dt: number): void {
    const move = SPEED * dt / 1000;
    if (keys.size && opts.inputEnabled) {
      let dx = 0, dy = 0;
      if (keys.has('up')) { dx -= 1; dy -= 1; } if (keys.has('down')) { dx += 1; dy += 1; }
      if (keys.has('left')) { dx -= 1; dy += 1; } if (keys.has('right')) { dx += 1; dy -= 1; }
      const len = Math.hypot(dx, dy) || 1; const nx = avatar.x + dx / len * move, ny = avatar.y + dy / len * move;
      if (free(nx, avatar.y)) avatar.x = nx; if (free(avatar.x, ny)) avatar.y = ny;
      avatar.path = []; avatar.look = null; avatar.walkT += dt; setDir(dx, dy);
    } else if (avatar.path.length) {
      const t = avatar.path[0]; const dx = t.x - avatar.x, dy = t.y - avatar.y; const d = Math.hypot(dx, dy);
      if (d <= move) { avatar.x = t.x; avatar.y = t.y; avatar.path.shift(); } else { avatar.x += dx / d * move; avatar.y += dy / d * move; }
      avatar.walkT += dt; setDir(dx, dy);
      if (!avatar.path.length && avatar.look) { setDir(avatar.look.x - avatar.x, avatar.look.y - avatar.y); avatar.look = null; }
    }
  }
  function setDir(dx: number, dy: number): void {
    const sx = dx - dy, sy = dx + dy; // direção na tela
    if (Math.abs(sx) > Math.abs(sy)) avatar.dir = sx > 0 ? 'right' : 'left'; else if (sy !== 0) avatar.dir = sy > 0 ? 'down' : 'up';
  }
  function free(x: number, y: number): boolean { const tx = Math.floor(x), ty = Math.floor(y); return ty >= 0 && ty < ROOM_H && tx >= 0 && tx < ROOM_W && walk[ty][tx]; }
  function walkTo(x: number, y: number): void {
    const from = { x: Math.floor(avatar.x), y: Math.floor(avatar.y) };
    let to = { x: Math.floor(x), y: Math.floor(y) };
    if (!walk[to.y]?.[to.x]) {
      // destino bloqueado (móvel): o tile livre mais perto do ponto clicado
      let best: { x: number; y: number } | null = null; let bd = Infinity;
      for (let yy = 0; yy < ROOM_H; yy++) for (let xx = 0; xx < ROOM_W; xx++) if (walk[yy][xx]) { const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y); if (d < bd) { bd = d; best = { x: xx, y: yy }; } }
      if (!best) return; to = best;
    }
    const path = findPath(walk, from, to);
    avatar.path = path.slice(1).map(t => ({ x: t.x + 0.5, y: t.y + 0.5 }));
    if (!path.length || (path.length === 1 && (from.x !== to.x || from.y !== to.y))) avatar.path = [{ x: to.x + 0.5, y: to.y + 0.5 }];
    kick();
  }

  // ---------- câmera ----------
  function cssSize() { const r = canvas.getBoundingClientRect(); return { w: Math.max(1, r.width), h: Math.max(1, r.height) }; }
  function center(): void {
    const { w, h } = cssSize();
    zoom = fitZoom(w, h);
    ox = (w - LOW_W * zoom) / 2; oy = (h - LOW_H * zoom) / 2;
    fitted = true; autoFit = true;
  }
  function clampPan(): void {
    const { w, h } = cssSize(); const W = LOW_W * zoom, H = LOW_H * zoom;
    ox = W <= w ? (w - W) / 2 : Math.min(40, Math.max(w - W - 40, ox));
    oy = H <= h ? (h - H) / 2 : Math.min(40, Math.max(h - H - 40, oy));
  }
  function zoomAround(next: number, sx: number, sy: number): void {
    next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    const lx = (sx - ox) / zoom, ly = (sy - oy) / zoom;
    zoom = next; ox = sx - lx * zoom; oy = sy - ly * zoom; autoFit = false; clampPan(); markDirty();
  }

  // ---------- entrada ----------
  function local(e: { clientX: number; clientY: number }) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function pick(sx: number, sy: number): Drawable | null {
    const lx = (sx - ox) / zoom, ly = (sy - oy) / zoom;
    for (let i = drawables.length - 1; i >= 0; i--) {
      const d = drawables[i]; if (!d.target) continue;
      if (d.box && lx >= d.box.x && lx <= d.box.x + d.box.w && ly >= d.box.y && ly <= d.box.y + d.box.h) return d;
      if (d.hit?.some(face => pointInPoly(lx, ly, face))) return d;
    }
    return null;
  }
  const onMove = (e: PointerEvent) => {
    const p = local(e);
    if (drag) { const dx = p.x - drag.x, dy = p.y - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true; if (drag.moved) { ox = drag.ox + dx; oy = drag.oy + dy; autoFit = false; clampPan(); markDirty(); } return; }
    const h = pick(p.x, p.y);
    if ((h?.key ?? h?.label) !== (hovered?.key ?? hovered?.label)) { hovered = h; canvas.style.cursor = h ? 'pointer' : 'default'; markDirty(); }
  };
  const onDown = (e: PointerEvent) => { if (e.button !== 0) return; const p = local(e); drag = { x: p.x, y: p.y, ox, oy, moved: false }; canvas.setPointerCapture?.(e.pointerId); };
  const onUp = (e: PointerEvent) => {
    if (!drag) return; const wasDrag = drag.moved; drag = null; if (wasDrag) return;
    const p = local(e); const hit = pick(p.x, p.y);
    if (hit?.target) {
      // abre na hora; o avatar caminha até perto só como animação
      handlers.onInteract(hit.target);
      const a = approachFor(hit.target, id => { for (const [i, w] of placement()) if (w.id === id) return i; return null; });
      if (a && opts.inputEnabled) { walkTo(a.x, a.y); avatar.look = a.look; }
      return;
    }
    if (!opts.inputEnabled) return;
    const w = fromLow((p.x - ox) / zoom, (p.y - oy) / zoom);
    if (w.x >= 0 && w.y >= 0 && w.x < ROOM_W && w.y < ROOM_H) walkTo(w.x, w.y);
  };
  const onWheel = (e: WheelEvent) => { e.preventDefault(); const p = local(e); zoomAround(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), p.x, p.y); };
  const KEYMAP: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  const typingTarget = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!opts.inputEnabled || opts.paused || typingTarget(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = KEYMAP[e.code]; if (!k) return;
    e.preventDefault(); keys.add(k); kick();
  };
  const onKeyUp = (e: KeyboardEvent) => { const k = KEYMAP[e.code]; if (k) { keys.delete(k); markDirty(); } };
  const onVisibility = () => { if (document.hidden) { keys.clear(); if (raf) cancelAnimationFrame(raf); raf = 0; } else markDirty(); };
  const onBlur = () => { keys.clear(); };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', () => { if (hovered) { hovered = null; canvas.style.cursor = 'default'; markDirty(); } });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  function resize(): void {
    const { w, h } = cssSize(); const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    // painel abriu/fechou ou a janela mudou: se o Chefe não mexeu na câmera, a sala volta a caber inteira
    if (!fitted || autoFit) center(); else clampPan();
    markDirty();
  }

  return {
    setWorkers(next) { workers = next; markDirty(); scheduleSlow(); },
    setBoard(c) { board = c; markDirty(); },
    setPlayer(p) { player = p; markDirty(); },
    setSelected(id) { selected = id; markDirty(); },
    setOptions(o) { const wasPaused = opts.paused; opts = { ...opts, ...o }; if (o.inputEnabled === false) keys.clear(); if (wasPaused && !opts.paused) markDirty(); if (!opts.paused) scheduleSlow(); },
    center() { center(); markDirty(); },
    zoomBy(dir) { const { w, h } = cssSize(); zoomAround(zoom * (dir > 0 ? 1.25 : 0.8), w / 2, h / 2); },
    resize,
    destroy() {
      destroyed = true; if (raf) cancelAnimationFrame(raf); if (slowTimer) clearTimeout(slowTimer);
      canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); document.removeEventListener('visibilitychange', onVisibility);
    },
    hoveredLabel() { return hovered?.label ?? null; },
  };
}
