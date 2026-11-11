// Pixel art procedural do My Company AI (v2). Nenhum asset externo: cada sprite é uma matriz de caracteres
// (uma linha por fileira de pixels) e cada caractere é uma cor da paleta. As matrizes viram canvases
// offscreen cacheados por zoom (ver SpriteCache). Paleta: tons escuros, madeira e âmbar.
// Personagens 20x28 (cabeça 20x12 + corpo 20x16), 4 direções, andar, sentado e poses.

export const TILE = 16;

export type Matrix = string[];

/** Paleta fixa (móveis, piso, objetos). '.' é transparente. */
export const PALETTE: Record<string, string> = {
  o: '#1a1216', // contorno
  k: '#0f0c10', // quase preto
  q: '#2d2630', // cinza escuro
  g: '#4a4350', // cinza
  G: '#6e6578', // cinza claro
  m: '#9a93a6', // metal claro
  w: '#7a5634', // madeira do piso (v4: mais clara e quente)
  W: '#8d653d', // madeira do piso (clara)
  d: '#5c3f25', // madeira escura
  D: '#45301b', // frisos do piso
  B: '#8a5a33', // tampo de madeira
  b: '#a9733f', // tampo de madeira (claro)
  a: '#f0a830', // âmbar
  A: '#ffd27a', // âmbar brilhante
  j: '#b97d1e', // âmbar escuro
  n: '#7cc47f', // verde
  N: '#4f8f52', // verde escuro
  r: '#e36a5a', // vermelho
  R: '#9e3e33', // vermelho escuro
  u: '#6fb3e0', // azul
  U: '#2d4a6e', // azul escuro (tela)
  v: '#b07ae0', // violeta
  V: '#5e3f7c', // violeta escuro
  l: '#5f9e4a', // folha
  L: '#8fd06a', // folha clara
  c: '#2f6a3f', // folha escura
  y: '#e8d6b8', // papel
  Y: '#fff6e0', // branco quente
  p: '#e07aa8', // rosa (neon)
  t: '#4fd1c5', // teal (neon)
  x: '#5a4c5e', // tecido escuro (carpete das salas; v4: mais claro)
  X: '#6c5e70', // tecido claro
  f: '#6b2f2f', // sofá (vinho)
  F: '#8c4040', // sofá (claro)
  C: '#9c5a3c', // barro (vaso)
  z: '#1e1b27', // tela desligada
  e: '#3b3647', // cinza azulado
  i: '#c9b8a0', // bege (livros)
  Q: '#3b3036', // topo da parede
  M: '#5e4c52', // face da parede
  J: '#7a666a', // friso claro da parede
  Z: '#3e3238', // linha escura da parede
  I: '#6b4a2e', // rodapé (madeira clara)
  '1': '#33493a', // piso de ladrilho escuro
  '2': '#425c49', // piso de ladrilho claro
  '3': '#5a4632', // couro (poltrona)
  '4': '#7a5f44', // couro claro
  '5': '#c9c2b8', // branco acinzentado (quadro branco)
  '6': '#9fd8ff', // luz branca fria (ring light)
};

/** Caracteres que dependem da aparência do personagem (resolvidos em runtime). */
export const CHARACTER_KEYS = ['S', 's', 'H', 'h', 'T', 't', 'P', 'K', 'E'] as const;

export const SKIN_COLORS: [string, string][] = [
  ['#f1c9a5', '#d9a983'],
  ['#d9a06a', '#b47e4e'],
  ['#a9703f', '#845128'],
  ['#5f3a24', '#432816'],
];
export const HAIR_COLORS: [string, string][] = [
  ['#2a2226', '#17121a'],
  ['#6b3d1a', '#4a2810'],
  ['#d9a441', '#a9772a'],
  ['#9b3a24', '#6d2617'],
];
export const SHIRT_COLORS: [string, string][] = [
  ['#f0a830', '#b97d1e'],
  ['#3f7fbf', '#2a5a8c'],
  ['#5fa66a', '#3f7a48'],
  ['#c45c7a', '#8c3c56'],
];
/** Camisas do avatar do usuário: escuras, com detalhe âmbar (segundo valor). */
export const PLAYER_SHIRT_COLORS: [string, string][] = [
  ['#2a2630', '#f0a830'],
  ['#1f2a3a', '#f0a830'],
  ['#2e2230', '#ffd27a'],
  ['#1e2a24', '#f0a830'],
];
const PANTS = '#2b2a3a';
const SHOES = '#15131a';
const EYES = '#1a1216';

export interface Appearance { skin: number; hair: number; shirt: number }

/**
 * Cores dos caracteres dinâmicos para uma aparência. `ghost` = sessão desconectada (tudo cinza).
 * `player` = avatar do usuário (camisa escura com detalhe âmbar, sempre distinta dos funcionários).
 */
export function characterPalette(app: Appearance, ghost = false, player = false): Record<string, string> {
  const pick = <T,>(arr: T[], i: number): T => arr[((i % arr.length) + arr.length) % arr.length];
  const skin = pick(SKIN_COLORS, app.skin);
  const hair = pick(HAIR_COLORS, app.hair);
  const shirt = pick(player ? PLAYER_SHIRT_COLORS : SHIRT_COLORS, app.shirt);
  if (ghost) {
    return { S: '#8b8793', s: '#6f6b78', H: '#5a5663', h: '#45414d', T: '#767283', t: '#5c5867', P: '#4a4752', K: '#33303a', E: '#2a272f', o: '#2a272f', Y: '#9a97a3' };
  }
  return { S: skin[0], s: skin[1], H: hair[0], h: hair[1], T: shirt[0], t: shirt[1], P: player ? '#1c1a24' : PANTS, K: SHOES, E: EYES };
}

// ---------------------------------------------------------------------------------------------
// Mini DSL de pintura: facilita montar móveis grandes sem digitar centenas de caracteres.
// ---------------------------------------------------------------------------------------------
class Painter {
  readonly g: string[][];
  constructor(readonly w: number, readonly h: number, fill = '.') {
    this.g = Array.from({ length: h }, () => Array.from({ length: w }, () => fill));
  }
  px(x: number, y: number, ch: string): this {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.g[y][x] = ch;
    return this;
  }
  rect(x: number, y: number, w: number, h: number, ch: string): this {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.px(xx, yy, ch);
    return this;
  }
  /** Retângulo só com a borda. */
  frame(x: number, y: number, w: number, h: number, ch: string): this {
    for (let xx = x; xx < x + w; xx++) { this.px(xx, y, ch); this.px(xx, y + h - 1, ch); }
    for (let yy = y; yy < y + h; yy++) { this.px(x, yy, ch); this.px(x + w - 1, yy, ch); }
    return this;
  }
  /** Caixa com contorno e preenchimento. */
  box(x: number, y: number, w: number, h: number, fill: string, outline = 'o'): this {
    return this.rect(x, y, w, h, fill).frame(x, y, w, h, outline);
  }
  put(m: Matrix, x: number, y: number): this {
    m.forEach((row, yy) => { for (let xx = 0; xx < row.length; xx++) if (row[xx] !== '.') this.px(x + xx, y + yy, row[xx]); });
    return this;
  }
  done(): Matrix { return this.g.map((r) => r.join('')); }
}

/** Espelha horizontalmente. */
export function mirror(m: Matrix): Matrix { return m.map((r) => r.split('').reverse().join('')); }

// ---------------------------------------------------------------------------------------------
// Piso e paredes
// ---------------------------------------------------------------------------------------------
function woodTile(variant: number): Matrix {
  const p = new Painter(TILE, TILE, 'w');
  for (let y = 0; y < TILE; y++) {
    const plank = Math.floor(y / 4);
    for (let x = 0; x < TILE; x++) {
      const seamY = y % 4 === 3;
      const seamX = (x + plank * 5 + variant * 3) % TILE === 0;
      if (seamY) p.px(x, y, 'D');
      else if (seamX) p.px(x, y, 'd');
      else if ((x * 7 + y * 13 + variant * 5) % 11 === 0) p.px(x, y, 'W');
      else if ((x * 3 + y * 5 + variant) % 13 === 0) p.px(x, y, 'd');
    }
  }
  return p.done();
}

function carpetTile(variant: number): Matrix {
  const p = new Painter(TILE, TILE, 'q');
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const n = (x * 31 + y * 17 + variant * 7) % 23;
    if (n === 0 || n === 11) p.px(x, y, 'x');
    else if (n === 5) p.px(x, y, 'e');
    else if ((x + y + variant) % 8 === 0) p.px(x, y, 'z');
  }
  return p.done();
}

/** Ladrilho 16x16 (recepção e convivência): quadrados 8x8 alternados com rejunte. */
function tileFloor(variant: number): Matrix {
  const p = new Painter(TILE, TILE, '1');
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const cx = Math.floor(x / 8);
    const cy = Math.floor(y / 8);
    const light = (cx + cy + variant) % 2 === 0;
    if (x % 8 === 0 || y % 8 === 0) p.px(x, y, 'D');
    else if (light) p.px(x, y, '2');
    else if ((x * 5 + y * 3 + variant) % 9 === 0) p.px(x, y, '2');
  }
  return p.done();
}

/** Tapete 48x32 (3x2 tiles) com borda e losangos âmbar. */
function rug(): Matrix {
  const p = new Painter(48, 32, 'f');
  p.frame(0, 0, 48, 32, 'R').frame(1, 1, 46, 30, 'j').frame(2, 2, 44, 28, 'R');
  for (let cx = 10; cx < 48; cx += 14) {
    for (let d = 0; d < 4; d++) { p.px(cx - d, 16 - 4 + d, 'a'); p.px(cx + d, 16 - 4 + d, 'a'); p.px(cx - d, 16 + 4 - d, 'a'); p.px(cx + d, 16 + 4 - d, 'a'); }
    p.px(cx, 16, 'A');
  }
  for (let x = 4; x < 44; x += 3) { p.px(x, 5, 'a'); p.px(x, 26, 'a'); }
  return p.done();
}

/** Tapete redondo 32x24 (convivência). */
function rugRound(): Matrix {
  const p = new Painter(32, 24);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
    const dx = (x - 15.5) / 16;
    const dy = (y - 11.5) / 12;
    const d = dx * dx + dy * dy;
    if (d <= 1) p.px(x, y, d > 0.8 ? 'R' : d > 0.62 ? 'j' : d > 0.5 ? 'f' : (x + y) % 5 === 0 ? 'a' : 'f');
  }
  return p.done();
}

/** Capacho da entrada 32x8. */
function doormat(): Matrix {
  const p = new Painter(32, 8, 'd');
  p.frame(0, 0, 32, 8, 'o');
  for (let x = 2; x < 30; x += 2) for (let y = 1; y < 7; y++) if ((x + y) % 2 === 0) p.px(x, y, 'w');
  return p.done();
}

/** Topo da parede 16x16 (paredes vistas de cima; bordas desenhadas pelo bitmask em runtime). */
function wallTop(): Matrix {
  const p = new Painter(TILE, TILE, 'Q');
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if ((x * 5 + y * 3) % 17 === 0) p.px(x, y, 'Z');
  return p.done();
}

/** Face da parede 16x16 (lado que dá para o piso abaixo): painel escuro com lambri de madeira. */
function wallFace(): Matrix {
  const p = new Painter(TILE, TILE, 'M');
  p.rect(0, 0, TILE, 1, 'J');
  p.rect(0, 1, TILE, 1, 'Z');
  for (let y = 2; y < 10; y++) if (y % 4 === 1) p.rect(0, y, TILE, 1, 'Z');
  p.rect(0, 10, TILE, 1, 'I').rect(0, 11, TILE, 3, 'w').rect(0, 14, TILE, 1, 'D').rect(0, 15, TILE, 1, 'o');
  p.px(7, 12, 'd').px(3, 12, 'd').px(11, 12, 'd');
  return p.done();
}

// ---------------------------------------------------------------------------------------------
// Mesas e cadeiras
// ---------------------------------------------------------------------------------------------
function deskBase(w: number): Painter {
  const p = new Painter(w, 16);
  p.box(0, 0, w, 12, 'B');
  p.rect(1, 1, w - 2, 1, 'b'); // reflexo do tampo
  p.rect(1, 10, w - 2, 1, 'd'); // sombra na borda
  p.rect(0, 12, w, 3, 'w').frame(0, 11, w, 4, 'o'); // frente
  p.px(2, 15, 'o').px(3, 15, 'o').px(w - 4, 15, 'o').px(w - 3, 15, 'o'); // pés
  return p;
}

/** Mesa 32x16 (2 tiles) com teclado, mouse e caneca. Monitores são sprites separados (estado muda). */
function desk(): Matrix {
  const p = deskBase(32);
  p.box(3, 7, 10, 3, 'g');
  for (let x = 4; x < 12; x += 2) p.px(x, 8, 'G');
  p.box(15, 7, 3, 3, 'G'); // mouse
  p.box(25, 4, 4, 4, 'a').px(29, 5, 'o').px(29, 6, 'o').px(26, 5, 'A'); // caneca
  p.box(19, 3, 5, 5, 'y').px(20, 5, 'g').px(21, 5, 'g'); // folhas
  return p.done();
}

/** Mesa 32x16 com mesa digitalizadora e caneta (design). */
function deskTablet(): Matrix {
  const p = deskBase(32);
  p.box(2, 5, 13, 6, 'q').rect(3, 6, 11, 4, 'z').px(4, 7, 'v').px(5, 7, 'v').px(6, 8, 'p');
  p.rect(16, 6, 1, 4, 'A').px(16, 10, 'o'); // caneta
  p.box(19, 6, 3, 3, 'G'); // mouse
  p.box(24, 3, 5, 5, 'y').px(25, 4, 'r').px(26, 4, 'p').px(27, 4, 't').px(25, 6, 'v').px(26, 6, 'a'); // amostras
  return p.done();
}

/** Mesa 32x16 com papéis, lupa e caderno (pesquisa). */
function deskResearch(): Matrix {
  const p = deskBase(32);
  p.box(3, 7, 9, 3, 'g');
  for (let x = 4; x < 11; x += 2) p.px(x, 8, 'G');
  p.box(14, 3, 7, 7, 'y').rect(15, 5, 5, 1, 'g').rect(15, 7, 3, 1, 'g'); // relatório
  p.frame(23, 3, 5, 5, 'm').px(24, 4, 'u').px(25, 4, 'u').px(24, 5, 'u').px(25, 5, '6'); // lupa
  p.px(28, 8, 'o').px(29, 9, 'o'); // cabo da lupa
  p.box(22, 9, 7, 2, 'R'); // caderno
  return p.done();
}

/** Mesa executiva 48x18 de madeira escura (diretoria), com luminária, papéis e telefone. Sem monitor. */
function deskExec(): Matrix {
  const p = new Painter(48, 18);
  p.box(0, 0, 48, 13, 'd').rect(1, 1, 46, 1, 'B').rect(1, 11, 46, 1, 'D');
  p.rect(0, 13, 48, 4, 'D').frame(0, 12, 48, 5, 'o');
  p.rect(2, 14, 2, 1, 'B').rect(44, 14, 2, 1, 'B');
  p.px(1, 17, 'o').px(2, 17, 'o').px(45, 17, 'o').px(46, 17, 'o');
  p.box(5, 2, 8, 6, 'a').rect(6, 3, 6, 1, 'A').rect(8, 8, 2, 3, 'g'); // luminária de mesa
  p.box(18, 3, 10, 7, 'y').rect(19, 5, 8, 1, 'g').rect(19, 7, 6, 1, 'g'); // papéis
  p.box(33, 3, 8, 5, 'q').rect(34, 4, 6, 1, 'G').px(35, 6, 'a'); // telefone
  p.box(42, 7, 4, 4, 'a'); // caneca
  return p.done();
}

/** Mesa de reunião 48x48 (3x3 tiles) com seis cadeiras ao redor, vista de cima. */
function meetingTable(): Matrix {
  const p = new Painter(48, 48);
  const chair = (x: number, y: number) => p.box(x, y, 8, 7, 'x').rect(x + 1, y + 1, 6, 1, 'X');
  chair(8, 1); chair(20, 1); chair(32, 1);
  chair(8, 40); chair(20, 40); chair(32, 40);
  p.box(4, 8, 40, 32, 'B').rect(5, 9, 38, 1, 'b').rect(5, 38, 38, 1, 'd');
  p.px(4, 8, '.').px(43, 8, '.').px(4, 39, '.').px(43, 39, '.');
  p.px(5, 8, 'o').px(4, 9, 'o').px(42, 8, 'o').px(43, 9, 'o').px(5, 39, 'o').px(4, 38, 'o').px(42, 39, 'o').px(43, 38, 'o');
  p.box(18, 18, 12, 9, 'y').rect(20, 20, 8, 1, 'g').rect(20, 22, 6, 1, 'g').rect(20, 24, 7, 1, 'g'); // pauta
  p.box(34, 14, 5, 5, 'a').px(35, 15, 'A'); // caneca
  p.box(9, 26, 6, 4, 'u').rect(10, 27, 4, 1, 'U'); // tablet
  p.rect(8, 44, 32, 2, 'o'); // sombra dos pés
  return p.done();
}

/** Mesa de reunião 48x32 (3x2 tiles) sem cadeiras pintadas: as cadeiras são props à parte (assentos dos atores). */
function conferenceTable(): Matrix {
  const p = new Painter(48, 32);
  p.box(1, 2, 46, 26, 'B').rect(2, 3, 44, 1, 'b').rect(2, 26, 44, 1, 'd');
  p.px(1, 2, '.').px(46, 2, '.').px(1, 27, '.').px(46, 27, '.');
  p.px(2, 2, 'o').px(1, 3, 'o').px(45, 2, 'o').px(46, 3, 'o').px(2, 27, 'o').px(1, 26, 'o').px(45, 27, 'o').px(46, 26, 'o');
  p.box(18, 10, 12, 9, 'y').rect(20, 12, 8, 1, 'g').rect(20, 14, 6, 1, 'g').rect(20, 16, 7, 1, 'g'); // pauta
  p.box(35, 7, 5, 5, 'a').px(36, 8, 'A'); // caneca
  p.box(7, 18, 6, 4, 'u').rect(8, 19, 4, 1, 'U'); // tablet
  p.box(34, 19, 7, 4, 'Y').rect(35, 20, 5, 1, 'i'); // bloco de notas
  p.rect(6, 28, 36, 2, 'o'); // sombra dos pés
  return p.done();
}

/** Tela de reunião 40x22 na parede: moldura escura, tela com três colunas (uma por participante) e luz de standby. */
function meetingScreen(): Matrix {
  const p = new Painter(40, 22);
  p.box(0, 0, 40, 22, 'q', 'o').frame(1, 1, 38, 20, 'g');
  p.rect(2, 2, 36, 18, 'U');
  p.rect(4, 4, 10, 2, 'a').rect(4, 7, 10, 1, 'u').rect(4, 9, 7, 1, 'u').rect(4, 11, 9, 1, 'u');
  p.rect(16, 4, 8, 2, 'A').rect(16, 7, 8, 1, 'u').rect(16, 9, 6, 1, 'u');
  p.rect(26, 4, 10, 2, 't').rect(26, 7, 10, 1, 'u').rect(26, 9, 8, 1, 'u').rect(26, 11, 5, 1, 'u');
  p.rect(4, 15, 32, 1, 'g').rect(4, 17, 20, 1, 'g');
  p.px(36, 18, 'n'); // luz de standby
  return p.done();
}

/** Mesa redonda 32x24 da convivência, com duas canecas. */
function roundTable(): Matrix {
  const p = new Painter(32, 24);
  for (let y = 0; y < 14; y++) for (let x = 0; x < 32; x++) {
    const dx = (x - 15.5) / 16;
    const dy = (y - 6.5) / 7;
    const d = dx * dx + dy * dy;
    if (d <= 1) p.px(x, y, d > 0.86 ? 'o' : y < 3 ? 'b' : 'B');
  }
  p.rect(14, 14, 4, 8, 'd').rect(10, 22, 12, 2, 'o').rect(11, 22, 10, 1, 'd');
  p.box(8, 5, 4, 4, 'a').box(20, 4, 4, 4, 'Y');
  return p.done();
}

/** Monitor 14x11: tela 14x9 + pé. Estados: desligado, ligado (código), executando (2 quadros). */
function monitor(kind: 'off' | 'on' | 'exec0' | 'exec1'): Matrix {
  const p = new Painter(14, 11);
  p.box(0, 0, 14, 9, kind === 'off' ? 'z' : kind === 'on' ? 'U' : 'k');
  if (kind === 'on') {
    p.rect(2, 2, 4, 1, 'a').rect(7, 2, 3, 1, 'u').rect(2, 4, 6, 1, 'u').rect(3, 6, 4, 1, 'a').px(9, 6, 'Y');
  } else if (kind === 'exec0') {
    p.rect(2, 2, 4, 1, 'n').rect(7, 3, 4, 1, 'n').rect(2, 4, 5, 1, 'N').rect(3, 6, 2, 1, 'n');
  } else if (kind === 'exec1') {
    p.rect(2, 2, 5, 1, 'N').rect(2, 3, 3, 1, 'n').rect(7, 4, 4, 1, 'n').rect(2, 6, 6, 1, 'N').px(10, 7, 'n');
  } else {
    p.px(2, 2, 'e').px(11, 7, 'e');
  }
  p.rect(5, 9, 4, 1, 'o').px(6, 9, 'g').px(7, 9, 'g');
  p.rect(3, 10, 8, 1, 'o').rect(4, 10, 6, 1, 'g');
  return p.done();
}

/** Assento da cadeira 16x16 (desenhado embaixo do personagem). */
function chairSeat(): Matrix {
  const p = new Painter(16, 16);
  p.box(2, 3, 12, 8, 'x').rect(3, 4, 10, 1, 'X');
  p.rect(6, 11, 4, 1, 'o').rect(7, 11, 2, 1, 'g');
  p.rect(3, 12, 10, 1, 'o').rect(4, 12, 8, 1, 'g');
  return p.done();
}

/** Encosto da cadeira 16x8 (desenhado por cima do personagem sentado). */
function chairBack(): Matrix {
  const p = new Painter(16, 8);
  p.box(2, 0, 12, 5, 'x').rect(3, 1, 10, 1, 'X');
  p.rect(6, 5, 4, 1, 'o').rect(7, 5, 2, 1, 'g');
  p.rect(3, 6, 10, 1, 'o').rect(4, 6, 8, 1, 'g');
  return p.done();
}

/** Poltrona executiva 16x20 (couro escuro com friso âmbar), vista de frente. */
function armchair(): Matrix {
  const p = new Painter(16, 20);
  p.box(2, 0, 12, 12, '3').rect(3, 1, 10, 1, '4').frame(3, 2, 10, 8, '4');
  p.box(0, 10, 16, 6, '3').rect(1, 11, 14, 1, '4').rect(1, 15, 14, 1, 'o');
  p.rect(1, 12, 1, 3, 'a').rect(14, 12, 1, 3, 'a');
  p.rect(7, 16, 2, 2, 'g').rect(3, 18, 10, 1, 'o').rect(4, 18, 8, 1, 'g').px(2, 19, 'o').px(13, 19, 'o');
  return p.done();
}

// ---------------------------------------------------------------------------------------------
// Estantes, armários e equipamentos
// ---------------------------------------------------------------------------------------------
/** Estante 16x28 com prateleiras; `books` = cores dos livros por prateleira. */
function shelf(books: string[]): Matrix {
  const p = new Painter(16, 28);
  p.box(0, 0, 16, 27, 'W');
  p.px(1, 27, 'o').px(2, 27, 'o').px(13, 27, 'o').px(14, 27, 'o');
  books.forEach((row, i) => {
    const y = 2 + i * 8;
    p.rect(1, y, 14, 7, 'o').rect(2, y, 12, 6, 'D');
    for (let x = 0; x < 12 && x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      const h = 4 + ((x * 7 + i) % 3);
      p.rect(2 + x, y + 6 - h, 1, h, ch);
    }
  });
  return p.done();
}

/** Arquivo de aço 16x26 com três gavetas e etiquetas (pesquisa). */
function archiveCabinet(): Matrix {
  const p = new Painter(16, 26);
  p.box(1, 0, 14, 25, 'g').rect(2, 1, 12, 1, 'G');
  for (let i = 0; i < 3; i++) {
    const y = 2 + i * 8;
    p.frame(2, y, 12, 7, 'q').rect(6, y + 2, 4, 1, 'm').rect(4, y + 4, 8, 1, 'y');
  }
  p.px(2, 25, 'o').px(3, 25, 'o').px(12, 25, 'o').px(13, 25, 'o');
  return p.done();
}

/** Prateleira de equipamento 16x28: câmera, HD externo, lente, caixas (design/vídeo). */
function gearShelf(): Matrix {
  const p = new Painter(16, 28);
  p.box(0, 0, 16, 27, 'q').rect(1, 1, 14, 1, 'G');
  for (const y of [2, 10, 18]) p.rect(1, y, 14, 7, 'k').rect(1, y + 7, 14, 1, 'G');
  p.box(2, 4, 6, 5, 'g').px(4, 5, 'u').px(5, 5, 'u').px(3, 3, 'G'); // câmera
  p.box(9, 5, 5, 4, 'z').px(10, 6, 'n'); // HD
  p.box(3, 12, 4, 5, 'G').rect(4, 13, 2, 1, 'u'); // lente
  p.box(8, 12, 6, 5, 'a').px(9, 13, 'A'); // caixa
  p.box(2, 20, 5, 5, 'r').box(8, 21, 6, 4, 'y').px(9, 22, 'g').px(10, 22, 'g'); // caixas
  p.px(1, 27, 'o').px(2, 27, 'o').px(13, 27, 'o').px(14, 27, 'o');
  return p.done();
}

/** Estante de mídia 16x28: celulares, anéis, troféu de placa (social). */
function mediaShelf(): Matrix {
  const p = new Painter(16, 28);
  p.box(0, 0, 16, 27, 'W');
  for (const y of [2, 10, 18]) p.rect(1, y, 14, 7, 'D').rect(1, y + 7, 14, 1, 'B');
  p.box(3, 3, 3, 6, 'k').px(4, 4, 'p').box(8, 3, 3, 6, 'k').px(9, 4, 't'); // celulares
  p.box(2, 11, 12, 6, 'a').rect(3, 12, 10, 1, 'A').rect(5, 13, 6, 2, 'k'); // placa
  p.box(3, 20, 4, 5, 'p').box(9, 20, 4, 5, 't'); // caixas coloridas
  p.px(1, 27, 'o').px(2, 27, 'o').px(13, 27, 'o').px(14, 27, 'o');
  return p.done();
}

/** Rack de servidor 16x28 com LEDs (desenvolvimento). */
function serverRack(): Matrix {
  const p = new Painter(16, 28);
  p.box(1, 0, 14, 27, 'q').rect(2, 1, 12, 1, 'G');
  for (let i = 0; i < 6; i++) {
    const y = 2 + i * 4;
    p.rect(2, y, 12, 3, 'k').rect(3, y + 1, 6, 1, 'g');
    p.px(11, y + 1, i % 2 === 0 ? 'n' : 'a').px(12, y + 1, 'u');
  }
  p.rect(2, 26, 12, 1, 'o');
  return p.done();
}

/** Bebedouro 16x26 (corredor). */
function waterCooler(): Matrix {
  const p = new Painter(16, 26);
  p.box(4, 0, 8, 9, 'u').rect(5, 1, 6, 1, '6').rect(5, 4, 6, 3, 'U');
  p.box(3, 9, 10, 15, 'm').rect(4, 10, 8, 1, 'Y').px(6, 13, 'u').px(9, 13, 'r');
  p.rect(5, 16, 6, 3, 'z');
  p.rect(4, 24, 8, 1, 'o');
  return p.done();
}

// ---------------------------------------------------------------------------------------------
// Quadros e murais (pendurados na parede; desenhados na camada plana)
// ---------------------------------------------------------------------------------------------
function boardFrame(w: number, h: number, fill: string, frame = 'd'): Painter {
  const p = new Painter(w, h);
  p.box(0, 0, w, h, fill, frame).frame(1, 1, w - 2, h - 2, frame === 'd' ? 'B' : 'G');
  return p;
}

/** Quadro branco 40x22 com rabiscos de código e diagrama (desenvolvimento). */
function whiteboard(): Matrix {
  const p = boardFrame(40, 22, '5', 'm');
  p.rect(4, 4, 10, 1, 'U').rect(4, 6, 7, 1, 'u').rect(6, 8, 9, 1, 'U').rect(4, 10, 12, 1, 'r');
  p.frame(20, 4, 8, 6, 'U').frame(30, 10, 7, 6, 'r').rect(28, 7, 2, 1, 'U').px(29, 8, 'U').px(29, 9, 'U');
  p.rect(5, 14, 14, 1, 'n').rect(5, 16, 9, 1, 'U').rect(22, 15, 10, 1, 'U');
  p.rect(4, 19, 8, 1, 'g').rect(20, 19, 6, 1, 'r').rect(30, 19, 6, 1, 'u'); // canetas
  return p.done();
}

/** Mural de conteúdo 40x22: miniaturas de posts com coração/curtidas (social). */
function contentBoard(): Matrix {
  const p = boardFrame(40, 22, 'D');
  const tiles: [number, number, string][] = [[3, 3, 'p'], [12, 3, 't'], [21, 3, 'a'], [30, 3, 'v'], [3, 12, 'u'], [12, 12, 'a'], [21, 12, 'p'], [30, 12, 'n']];
  for (const [x, y, c] of tiles) { p.box(x, y, 7, 7, c, 'k').px(x + 1, y + 1, 'Y').rect(x + 1, y + 5, 3, 1, 'k'); }
  p.rect(12, 4, 1, 1, 'r').px(13, 4, 'r').px(12, 5, 'r').px(13, 5, 'r'); // coração
  return p.done();
}

/** Moodboard 40x22: amostras de cor, tipografia e referência (design). */
function moodBoard(): Matrix {
  const p = boardFrame(40, 22, 'y');
  p.rect(3, 3, 5, 5, 'v').rect(9, 3, 5, 5, 'p').rect(15, 3, 5, 5, 'a').rect(21, 3, 5, 5, 't').rect(27, 3, 5, 5, 'u');
  p.rect(3, 10, 16, 1, 'k').rect(3, 12, 11, 1, 'k').rect(3, 14, 14, 1, 'g').rect(3, 16, 8, 1, 'g');
  p.box(22, 10, 14, 9, 'V').rect(24, 12, 10, 3, 'v').rect(24, 16, 6, 1, 'p');
  p.px(34, 3, 'r').px(35, 3, 'r'); // alfinete
  return p.done();
}

/** Mapa de pesquisa 40x22 com alfinetes e linhas (pesquisa e prospecção). */
function researchMap(): Matrix {
  const p = boardFrame(40, 22, 'U');
  p.rect(4, 4, 9, 6, 'l').rect(6, 10, 4, 6, 'l').rect(16, 5, 11, 4, 'l').rect(19, 9, 7, 7, 'l').rect(29, 6, 7, 5, 'l').px(8, 6, 'L').px(21, 7, 'L').px(32, 8, 'L');
  const pins: [number, number][] = [[7, 7], [22, 10], [31, 8], [10, 14], [24, 15]];
  for (const [x, y] of pins) p.px(x, y, 'r').px(x, y - 1, 'r').px(x + 1, y - 1, 'A');
  p.px(12, 8, 'A').px(16, 9, 'A').px(27, 9, 'A').px(14, 12, 'A').px(18, 14, 'A'); // linhas entre pontos
  p.rect(28, 16, 8, 3, 'y').rect(29, 17, 6, 1, 'g'); // legenda
  return p.done();
}

/** Quadro de planejamento 32x22 (calendário) para a sala de pesquisa. */
function planBoard(): Matrix {
  const p = boardFrame(32, 22, 'Y', 'm');
  p.rect(3, 3, 26, 2, 'g');
  for (let x = 3; x < 29; x += 4) for (let y = 7; y < 19; y += 4) p.rect(x, y, 3, 3, (x + y) % 3 === 0 ? 'a' : (x * y) % 5 === 0 ? 'u' : 'i');
  return p.done();
}

/** Kanban 40x22 com três colunas e cartões (gestão). */
function kanbanBoard(): Matrix {
  const p = boardFrame(40, 22, '5', 'm');
  for (const x of [3, 15, 27]) p.rect(x, 3, 10, 2, 'g');
  const cards: [number, number, string][] = [[3, 7, 'a'], [3, 11, 'u'], [3, 15, 'a'], [15, 7, 'u'], [15, 11, 'p'], [27, 7, 'n'], [27, 11, 'n'], [27, 15, 'n']];
  for (const [x, y, c] of cards) p.rect(x, y, 10, 3, c).rect(x + 1, y + 1, 6, 1, 'k');
  return p.done();
}

/** Quadro artístico 32x22 com moldura dourada (diretoria): paisagem noturna. */
function artFrame(): Matrix {
  const p = new Painter(32, 22);
  p.box(0, 0, 32, 22, 'j', 'o').frame(1, 1, 30, 20, 'A').frame(2, 2, 28, 18, 'j');
  p.rect(3, 3, 26, 16, 'U');
  p.rect(3, 13, 26, 6, 'V').rect(3, 16, 26, 3, 'k');
  for (let x = 5; x < 28; x += 3) p.px(x, 14 - ((x * 7) % 4), 'V');
  p.px(24, 6, 'A').px(25, 6, 'A').px(24, 7, 'A').px(25, 7, 'A').px(8, 5, 'Y').px(14, 8, 'Y').px(19, 4, 'Y'); // lua e estrelas
  return p.done();
}

/** Fita de neon 32x4 (rosa e teal alternados). */
function neonStrip(): Matrix {
  const p = new Painter(32, 4);
  p.rect(0, 1, 32, 2, 'o');
  for (let x = 1; x < 31; x++) p.px(x, 1, x % 8 < 4 ? 'p' : 't').px(x, 2, x % 8 < 4 ? 'p' : 't');
  return p.done();
}

/** Letreiro de neon "coração" 16x14 (social). */
function neonHeart(): Matrix {
  return [
    '................',
    '...ppp....ppp...',
    '..p...p..p...p..',
    '.p.....pp.....p.',
    '.p............p.',
    '.p............p.',
    '..p..........p..',
    '...p........p...',
    '....p......p....',
    '.....p....p.....',
    '......p..p......',
    '.......pp.......',
    '................',
    '................',
  ];
}

// ---------------------------------------------------------------------------------------------
// Equipamento de gravação, edição e objetos de chão
// ---------------------------------------------------------------------------------------------
/** Câmera em tripé 16x30 (social). */
function tripodCamera(): Matrix {
  const p = new Painter(16, 30);
  p.box(3, 2, 10, 8, 'q').rect(4, 3, 8, 1, 'G').px(11, 4, 'r');
  p.box(0, 4, 4, 5, 'g').px(1, 5, 'u').px(2, 5, '6'); // lente
  p.rect(7, 10, 2, 4, 'm');
  for (let i = 0; i < 14; i++) { p.px(7 - Math.floor(i / 2), 14 + i, 'm'); p.px(8 + Math.floor(i / 2), 14 + i, 'm'); p.px(7, 14 + i, i % 3 === 0 ? 'G' : 'm'); }
  p.rect(0, 28, 3, 1, 'o').rect(13, 28, 3, 1, 'o').rect(6, 28, 3, 1, 'o');
  return p.done();
}

/** Ring light 16x30 com pé (social). */
function ringLight(): Matrix {
  const p = new Painter(16, 30);
  for (let y = 0; y < 14; y++) for (let x = 0; x < 16; x++) {
    const dx = (x - 7.5) / 7.5;
    const dy = (y - 6.5) / 7;
    const d = dx * dx + dy * dy;
    if (d <= 1 && d > 0.5) p.px(x, y, d > 0.85 ? 'o' : '6');
  }
  p.px(7, 6, 'k').px(8, 6, 'k'); // celular no centro
  p.rect(7, 14, 2, 12, 'm');
  p.rect(3, 26, 10, 1, 'g').rect(2, 27, 12, 1, 'o');
  return p.done();
}

/** Fundo de gravação 48x30 (painel de tecido em suporte), social. */
function backdrop(): Matrix {
  const p = new Painter(48, 30);
  p.rect(0, 0, 48, 2, 'm').rect(1, 0, 46, 1, 'G');
  p.rect(2, 2, 44, 24, 'V');
  for (let y = 2; y < 26; y++) for (let x = 2; x < 46; x++) if ((x + y * 3) % 9 === 0) p.px(x, y, 'v');
  p.rect(2, 2, 44, 1, 'x').rect(2, 25, 44, 1, 'x');
  p.rect(3, 26, 2, 3, 'g').rect(43, 26, 2, 3, 'g').rect(1, 29, 6, 1, 'o').rect(41, 29, 6, 1, 'o');
  return p.done();
}

/** Estação de edição 48x30 (design e vídeo): mesa com monitor grande e caixas de som. */
function editStation(): Matrix {
  const p = new Painter(48, 30);
  p.box(0, 14, 48, 12, 'B').rect(1, 15, 46, 1, 'b').rect(1, 24, 46, 1, 'd');
  p.rect(0, 26, 48, 3, 'w').frame(0, 25, 48, 5, 'o');
  p.px(2, 29, 'o').px(3, 29, 'o').px(44, 29, 'o').px(45, 29, 'o');
  p.box(10, 0, 28, 16, 'k'); // monitor grande
  p.rect(11, 1, 26, 14, 'U');
  p.rect(12, 2, 26, 8, 'V').rect(13, 3, 10, 6, 'v').rect(24, 3, 12, 6, 'p'); // timeline/preview
  p.rect(12, 11, 24, 1, 'a').rect(12, 13, 18, 1, 't').rect(12, 12, 8, 1, 'u');
  p.rect(22, 16, 4, 2, 'o').rect(20, 18, 8, 1, 'o'); // pé
  p.box(2, 6, 6, 12, 'q').px(4, 8, 'G').px(5, 8, 'G').px(4, 13, 'g').px(5, 13, 'g'); // caixa de som esq
  p.box(40, 6, 6, 12, 'q').px(42, 8, 'G').px(43, 8, 'G').px(42, 13, 'g').px(43, 13, 'g'); // caixa de som dir
  p.box(14, 19, 12, 3, 'g'); // teclado
  return p.done();
}

function plantA(): Matrix {
  return [
    '......oo........',
    '....ooLLo.oo....',
    '...oLLlLLoLLo...',
    '..oLllLLllLLLo..',
    '..olLLclLLlllo..',
    '...oclLLclLLo...',
    '....olccLlco....',
    '.....oclco......',
    '......oco.......',
    '......olo.......',
    '....oooooooo....',
    '...oCCCCCCCCo...',
    '...oCCCCCCCCo...',
    '....oCCCCCCo....',
    '....oCCCCCCo....',
    '....oCCCCCCo....',
    '.....oooooo.....',
  ];
}

function plantB(): Matrix {
  return [
    '.......oo.......',
    '......oLLo......',
    '.....oLlLLo.....',
    '..oo.oLlLLo.oo..',
    '.oLLooLlLLooLLo.',
    '.olLLoLlLLolLLo.',
    '.olLLoLlLLolLLo.',
    '.oclLolLLLoclLo.',
    '..oclolLLlolco..',
    '...ocoolLloco...',
    '....oocLlcoo....',
    '.....ocLco......',
    '......ollo......',
    '.....oooooo.....',
    '....oxxxxxxo....',
    '....oxXxxxxo....',
    '....oxxxxxxo....',
    '.....oxxxxo.....',
    '.....oxxxxo.....',
    '......oooo......',
  ];
}

function floorLamp(): Matrix {
  const p = new Painter(16, 30);
  p.box(2, 0, 12, 7, 'a').rect(3, 1, 10, 1, 'A').rect(3, 5, 10, 1, 'j');
  p.rect(7, 7, 2, 18, 'm').px(6, 7, 'o').px(9, 7, 'o');
  p.box(4, 25, 8, 3, 'q').rect(5, 28, 6, 1, 'o');
  return p.done();
}

function ceilingLamp(): Matrix {
  return [
    '.....oo.....',
    '.....om.....',
    '....oooo....',
    '..oAAAAAAo..',
    '.oaaaaaaaao.',
    'oaaaaaaaaaao',
    'ojjjjjjjjjjo',
    'oooooooooooo',
    '...oYYYYo...',
    '....oooo....',
  ];
}

/** Máquina de café em cima de um balcão 16x26. */
function coffeeMachine(): Matrix {
  const p = new Painter(16, 26);
  p.box(4, 0, 9, 11, 'q').rect(5, 1, 7, 1, 'G').px(6, 3, 'a').px(10, 3, 'r');
  p.rect(6, 5, 5, 1, 'o').rect(6, 6, 1, 4, 'o').rect(10, 6, 1, 4, 'o');
  p.rect(7, 7, 3, 2, 'Y').rect(7, 9, 3, 1, 'o');
  p.box(0, 11, 16, 8, 'B').rect(1, 12, 14, 1, 'b');
  p.rect(0, 19, 16, 6, 'w').frame(0, 18, 16, 7, 'o');
  p.rect(2, 25, 2, 1, 'o').rect(12, 25, 2, 1, 'o');
  return p.done();
}

/** Balcão simples 16x15 (apoio da máquina de café). */
function counterTile(): Matrix {
  const p = new Painter(16, 15);
  p.box(0, 0, 16, 8, 'B').rect(1, 1, 14, 1, 'b');
  p.rect(0, 8, 16, 6, 'w').frame(0, 7, 16, 7, 'o');
  p.rect(2, 14, 2, 1, 'o').rect(12, 14, 2, 1, 'o');
  p.box(3, 2, 4, 4, 'Y').px(4, 3, 'a').box(9, 3, 3, 3, 'a');
  return p.done();
}

/** Sofá 48x20 (3 tiles de largura). */
function sofa(): Matrix {
  const p = new Painter(48, 20);
  p.box(0, 0, 48, 9, 'F').rect(1, 1, 46, 1, 'f'); // encosto
  p.rect(2, 3, 44, 5, 'f');
  p.box(0, 8, 48, 9, 'f'); // assento
  p.rect(1, 9, 46, 1, 'F');
  for (const x of [1, 16, 31]) p.box(x, 9, 16, 7, 'f').rect(x + 1, 10, 14, 1, 'F');
  p.box(0, 2, 4, 15, 'F').box(44, 2, 4, 15, 'F'); // braços
  p.rect(1, 16, 46, 2, 'R').frame(0, 15, 48, 4, 'o'); // base
  p.px(2, 19, 'o').px(3, 19, 'o').px(44, 19, 'o').px(45, 19, 'o');
  p.box(20, 4, 8, 5, 'a').px(21, 5, 'A'); // almofada âmbar
  return p.done();
}

/** Balcão de recepção 64x28 (4 tiles). */
function receptionCounter(): Matrix {
  const p = new Painter(64, 28);
  p.box(0, 0, 64, 12, 'B').rect(1, 1, 62, 1, 'b').rect(1, 10, 62, 1, 'd');
  p.rect(0, 12, 64, 12, 'w').frame(0, 11, 64, 13, 'o');
  p.rect(2, 14, 60, 1, 'a'); // friso âmbar
  p.rect(2, 20, 60, 1, 'j');
  p.rect(3, 24, 58, 2, 'd').rect(2, 26, 2, 1, 'o').rect(60, 26, 2, 1, 'o');
  // sineta, planta pequena, folhas
  p.box(8, 3, 5, 5, 'A').px(10, 2, 'a').px(10, 8, 'o');
  p.box(26, 3, 10, 6, 'y').rect(28, 5, 6, 1, 'g').rect(28, 7, 4, 1, 'g');
  p.box(50, 5, 6, 4, 'C').rect(50, 2, 6, 3, 'l').px(51, 1, 'L').px(54, 1, 'L').px(52, 3, 'c');
  p.rect(40, 4, 6, 4, 'z').frame(40, 4, 6, 4, 'o').px(42, 5, 'u'); // monitor da recepção
  return p.done();
}

const SIGN_FONT: Record<string, Matrix> = {
  M: ['A...A', 'AA.AA', 'A.A.A', 'A...A', 'A...A', 'A...A', 'A...A'],
  I: ['AAAAA', '..A..', '..A..', '..A..', '..A..', '..A..', 'AAAAA'],
  L: ['A....', 'A....', 'A....', 'A....', 'A....', 'A....', 'AAAAA'],
  W: ['A...A', 'A...A', 'A...A', 'A.A.A', 'A.A.A', 'AA.AA', 'A...A'],
  E: ['AAAAA', 'A....', 'A....', 'AAAA.', 'A....', 'A....', 'AAAAA'],
  B: ['AAAA.', 'A...A', 'A...A', 'AAAA.', 'A...A', 'A...A', 'AAAA.'],
};

/** Placa "MILWEB" iluminada, 88x24 (letras 2x). */
function sign(): Matrix {
  const p = new Painter(88, 24);
  p.box(0, 3, 88, 20, 'k').frame(1, 4, 86, 18, 'j').frame(2, 5, 84, 16, 'o');
  for (const x of [12, 30, 48, 66]) p.rect(x, 0, 4, 3, 'a').px(x + 1, 0, 'A');
  const word = 'MILWEB';
  let x = 9;
  for (const ch of word) {
    const m = SIGN_FONT[ch];
    for (let yy = 0; yy < m.length; yy++) for (let xx = 0; xx < m[yy].length; xx++) {
      if (m[yy][xx] === '.') continue;
      p.rect(x + xx * 2, 7 + yy * 2, 2, 2, yy < 2 ? 'A' : 'a');
    }
    x += 12;
  }
  // brilho sob as letras
  for (let xx = 8; xx < 80; xx += 2) p.px(xx, 21, 'j');
  return p.done();
}

/** Globo 16x18 (pesquisa). */
function globe(): Matrix {
  const p = new Painter(16, 18);
  p.box(4, 1, 8, 8, 'u').px(5, 2, 'U').rect(6, 3, 3, 2, 'l').rect(8, 6, 2, 2, 'l').px(7, 1, 'l');
  p.frame(3, 0, 10, 10, 'm').px(3, 0, '.').px(12, 0, '.').px(3, 9, '.').px(12, 9, '.');
  p.rect(7, 10, 2, 4, 'g').box(4, 14, 8, 3, 'q');
  return p.done();
}

/** Gato dormindo 16x10 (decorativo, nunca um personagem). */
function cat(): Matrix {
  return [
    '................',
    '.....oo.........',
    '....oHHoooooo...',
    '...oHHHHHHHHHo..',
    '..oHEHHHHHHHHHo.',
    '..oHHHHHHHHHHHo.',
    '...oHhHHHHhHHHo.',
    '....oooHHHooooo.',
    '......ooooo.oo..',
    '................',
  ].map((r) => r.replace(/H/g, 'x').replace(/h/g, 'X').replace(/E/g, 'A'));
}

// ---------------------------------------------------------------------------------------------
// Personagem 20x28: cabeça 20x12 + corpo 20x16. Caracteres dinâmicos: S/s pele, H/h cabelo,
// T/t camisa, P calça, K sapato, E olho. 'o' contorno.
// ---------------------------------------------------------------------------------------------
const HEAD_DOWN: Matrix = [
  '.......oooooo.......',
  '.....ooHHHHHHoo.....',
  '....oHHHHHHHHHHo....',
  '....oHHhHHHHHhHo....',
  '....oHHHHHHHHHHo....',
  '....oHSSSSSSSSHo....',
  '....oSSSSSSSSSSo....',
  '....oSSESSSSESSo....',
  '....oSSESSSSESSo....',
  '....oSSSSSSSSSSo....',
  '.....oSSSssSSSo.....',
  '.......oSSSSo.......',
];
const HEAD_UP: Matrix = [
  '.......oooooo.......',
  '.....ooHHHHHHoo.....',
  '....oHHHHHHHHHHo....',
  '....oHHHHHhHHHHo....',
  '....oHHhHHHHHHHo....',
  '....oHHHHHHHhHHo....',
  '....oHHHHHHHHHHo....',
  '....oHhHHHHHHHHo....',
  '....oHHHHHhHHHHo....',
  '....oHHHHHHHHHHo....',
  '.....ohhHHHHhho.....',
  '.......oSSSSo.......',
];
/** Olhando para a direita (espelhar para a esquerda). */
const HEAD_SIDE: Matrix = [
  '.......oooooo.......',
  '.....ooHHHHHHoo.....',
  '....oHHHHHHHHHHo....',
  '....oHHhHHHHHHHo....',
  '....oHHHHHHHHHHo....',
  '....oHHHHHSSSSSo....',
  '....oHHHHSSSSSSo....',
  '....oHHhHSSSSESo....',
  '....oHHhHSSSSESo....',
  '....oHHHHSSSSSSo....',
  '.....oHHSSSsSSo.....',
  '.......oSSSSo.......',
];

const TORSO_FRONT: Matrix = [
  '.....oTTTTTTTTo.....',
  '...ooTTTTTTTTTToo...',
  '..oTToTTTTTTTToTTo..',
  '..oTToTTtTTtTToTTo..',
  '..oTToTTTTTTTToTTo..',
  '..oTToTTTTTTTToTTo..',
  '..oTToTTTTTTTToTTo..',
  '..oSSoTTTTTTTToSSo..',
  '...oooTTTTTTTTooo...',
];
const LEGS_STAND: Matrix = [
  '.....oPPPPPPPPo.....',
  '.....oPPPPPPPPo.....',
  '.....oPPPooPPPo.....',
  '.....oPPPooPPPo.....',
  '.....oKKKooKKKo.....',
  '.....oKKKooKKKo.....',
  '.....oooooooooo.....',
];
const LEGS_STEP: Matrix = [
  '.....oPPPPPPPPo.....',
  '.....oPPPPPPPPo.....',
  '.....oPPPooPPPo.....',
  '.....oKKKooPPPo.....',
  '.....oKKKooPPPo.....',
  '.....ooooooKKKo.....',
  '..........ooooo.....',
];
const TORSO_SIDE: Matrix = [
  '......oTTTTTTTo.....',
  '.....oTTTTTTTTTo....',
  '.....oTTTTTToTTo....',
  '.....oTTtTTToTTo....',
  '.....oTTTTTToTTo....',
  '.....oTTTTTToTTo....',
  '.....oTTTTTToTTo....',
  '.....oTTTTTToSSo....',
  '.....oTTTTTTTooo....',
];
const LEGS_SIDE_STAND: Matrix = [
  '......oPPPPPPo......',
  '......oPPPPPPo......',
  '......oPPPoPPo......',
  '......oPPPoPPo......',
  '......oKKKoKKo......',
  '......oKKKoKKo......',
  '......oooooooo......',
];
const LEGS_SIDE_A: Matrix = [
  '......oPPPPPPo......',
  '......oPPPPPPo......',
  '.....oPPPooPPPo.....',
  '....oPPPo..oPPPo....',
  '....oKKKo..oKKKo....',
  '....oKKKo..oKKKo....',
  '.....ooo....ooo.....',
];
const LEGS_SIDE_B: Matrix = [
  '......oPPPPPPo......',
  '......oPPPPPPo......',
  '......oPPPPPPo......',
  '.....oPPPooPPPo.....',
  '.....oKKKooKKKo.....',
  '.....oKKKooKKKo.....',
  '......ooo..ooo......',
];
/** Sentado (visto de costas), braços relaxados. O encosto cobre as linhas de baixo. */
const SIT_IDLE: Matrix = [
  '.....oTTTTTTTTo.....',
  '...ooTTTTTTTTTToo...',
  '..oTToTTTTTTTToTTo..',
  '..oTToTTTTTTTToTTo..',
  '..oTToTTTTTTTToTTo..',
  '..oSSoTTTTTTTToSSo..',
  '...oooTTTTTTTTooo...',
  '.....oPPPPPPPPo.....',
  '.....oooooooooo.....',
];
const SIT_TYPE_A: Matrix = [
  '.....oTTTTTTTTo.....',
  '...ooTTTTTTTTTToo...',
  '..oSToTTTTTTTToTSo..',
  '..oTToTTTTTTTToTTo..',
  '...ooTTTTTTTTTToo...',
  '.....oTTTTTTTTo.....',
  '.....oTTTTTTTTo.....',
  '.....oPPPPPPPPo.....',
  '.....oooooooooo.....',
];
const SIT_TYPE_B: Matrix = [
  '.....oTTTTTTTTo.....',
  '...ooTTTTTTTTTToo...',
  '..oTToTTTTTTTToTTo..',
  '..oSToTTTTTTTToTSo..',
  '...ooTTTTTTTTTToo...',
  '.....oTTTTTTTTo.....',
  '.....oTTTTTTTTo.....',
  '.....oPPPPPPPPo.....',
  '.....oooooooooo.....',
];
/** Sentado com o braço direito levantado (segura folha ou mão no queixo). */
const SIT_ARM_UP: Matrix = [
  '.....oTTTTTTTTooo...',
  '...ooTTTTTTTTToSSo..',
  '..oTToTTTTTTTToSSo..',
  '..oTToTTTTTTTTooo...',
  '..oTToTTTTTTTTo.....',
  '..oSSoTTTTTTTTo.....',
  '...oooTTTTTTTTo.....',
  '.....oPPPPPPPPo.....',
  '.....oooooooooo.....',
];
/** Alongando: dois braços para cima. */
const SIT_STRETCH: Matrix = [
  '..oSSoTTTTTTTToSSo..',
  '..oTToTTTTTTTToTTo..',
  '..oTToTTTTTTTToTTo..',
  '...ooTTTTTTTTTToo...',
  '.....oTTTTTTTTo.....',
  '.....oTTTTTTTTo.....',
  '.....oTTTTTTTTo.....',
  '.....oPPPPPPPPo.....',
  '.....oooooooooo.....',
];
const SHEET: Matrix = [
  'oooooo',
  'oYYYYo',
  'oYggYo',
  'oYYYYo',
  'oYggYo',
  'oYYYYo',
  'oYgYYo',
  'oYYYYo',
  'oooooo',
];
const HAND: Matrix = [
  '.oo.',
  'oSSo',
  'oSso',
  '.oo.',
];

function stack(...parts: Matrix[]): Matrix { return parts.flat(); }

// ---------------------------------------------------------------------------------------------
// Bolhas e ícones
// ---------------------------------------------------------------------------------------------
function bubble(symbol: Matrix, bg: string, ink: string): Matrix {
  const p = new Painter(15, 15);
  p.box(0, 0, 15, 12, bg);
  p.px(0, 0, '.').px(14, 0, '.').px(0, 11, '.').px(14, 11, '.');
  p.px(1, 0, 'o').px(0, 1, 'o').px(13, 0, 'o').px(14, 1, 'o').px(1, 11, 'o').px(0, 10, 'o').px(13, 11, 'o').px(14, 10, 'o');
  p.rect(3, 12, 3, 1, bg).px(2, 12, 'o').px(6, 12, 'o').rect(3, 13, 2, 1, bg).px(2, 13, 'o').px(5, 13, 'o').px(3, 14, 'o').px(4, 14, 'o');
  const sym = symbol.map((r) => r.replace(/#/g, ink));
  const sw = sym[0].length;
  const sh = sym.length;
  p.put(sym, Math.floor((15 - sw) / 2), Math.floor((12 - sh) / 2));
  return p.done();
}
const SYM_EXCL: Matrix = ['.##.', '.##.', '.##.', '.##.', '....', '.##.'];
const SYM_QUEST: Matrix = ['.###.', '#...#', '....#', '..##.', '..#..', '.....', '..#..'];
const SYM_CHECK: Matrix = ['......#', '.....#.', '#...#..', '.#.#...', '..#....'];
const SYM_X: Matrix = ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'];
const SYM_ZZ: Matrix = ['###..', '..#..', '.#...', '###.#', '....#', '...##', '....#'];
/** Três pontos de "falando": quadros com 1, 2 e 3 pontos acesos (os apagados ficam em cinza). */
function symDots(lit: number): Matrix {
  const row = (ch: (i: number) => string) => `${ch(0)}${ch(0)}.${ch(1)}${ch(1)}.${ch(2)}${ch(2)}`;
  const on = (i: number) => (i < lit ? '#' : 'G');
  return [row(on), row(on)];
}

const EYE_ICON: Matrix = [
  '..ooooo..',
  '.oYYYYYo.',
  'oYYouoYYo',
  '.oYYYYYo.',
  '..ooooo..',
];

/** Tecla "E" 11x11 para a dica de interação. */
const KEY_E: Matrix = [
  '.ooooooooo.',
  'oAAAAAAAAAo',
  'oAkkkkkkkAo',
  'oAkAAAAAkAo',
  'oAkAkkkkkAo',
  'oAkAAAAkkAo',
  'oAkAkkkkkAo',
  'oAkAAAAAkAo',
  'oAkkkkkkkAo',
  'oaaaaaaaaao',
  '.ooooooooo.',
];

// ---------------------------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------------------------
export const SPRITES: Record<string, Matrix> = {
  'floor.wood.0': woodTile(0),
  'floor.wood.1': woodTile(1),
  'floor.wood.2': woodTile(2),
  'floor.carpet.0': carpetTile(0),
  'floor.carpet.1': carpetTile(1),
  'floor.carpet.2': carpetTile(2),
  'floor.tile.0': tileFloor(0),
  'floor.tile.1': tileFloor(1),
  'floor.tile.2': tileFloor(0),
  'wall.top': wallTop(),
  'wall.face': wallFace(),
  rug: rug(),
  'rug.round': rugRound(),
  doormat: doormat(),
  desk: desk(),
  'desk.tablet': deskTablet(),
  'desk.research': deskResearch(),
  'desk.exec': deskExec(),
  'table.meeting': meetingTable(),
  'table.conference': conferenceTable(),
  'table.round': roundTable(),
  'monitor.off': monitor('off'),
  'monitor.on': monitor('on'),
  'monitor.exec0': monitor('exec0'),
  'monitor.exec1': monitor('exec1'),
  'chair.seat': chairSeat(),
  'chair.back': chairBack(),
  armchair: armchair(),
  'shelf.books': shelf(['rRuuNNyyvv.i', 'yy.rruuNiiRv', 'uuvvrryyNN.i']),
  'shelf.tech': shelf(['ggGGuuggUU.m', 'mmggGGuuUUgg', 'GGggmmuugg.U']),
  'shelf.research': shelf(['yyiiyyiiyyii', 'uuNNyyiirr.v', 'iiyyuuNNii.y']),
  'shelf.exec': shelf(['RRjjRRjjii.A', 'iiRRjjRRii.a', 'jjiiRRjjRRii']),
  'shelf.gear': gearShelf(),
  'shelf.media': mediaShelf(),
  'cabinet.archive': archiveCabinet(),
  'rack.server': serverRack(),
  cooler: waterCooler(),
  'plant.a': plantA(),
  'plant.b': plantB(),
  'lamp.floor': floorLamp(),
  'lamp.ceiling': ceilingLamp(),
  coffee: coffeeMachine(),
  counter: counterTile(),
  sofa: sofa(),
  'reception.counter': receptionCounter(),
  sign: sign(),
  'board.white': whiteboard(),
  'board.content': contentBoard(),
  'board.mood': moodBoard(),
  'board.map': researchMap(),
  'board.plan': planBoard(),
  'board.kanban': kanbanBoard(),
  'board.screen': meetingScreen(),
  'frame.art': artFrame(),
  'neon.strip': neonStrip(),
  'neon.heart': neonHeart(),
  'tripod.camera': tripodCamera(),
  'ring.light': ringLight(),
  backdrop: backdrop(),
  'station.edit': editStation(),
  globe: globe(),
  cat: cat(),
  // personagem
  'c.head.down': HEAD_DOWN,
  'c.head.up': HEAD_UP,
  'c.head.side': HEAD_SIDE,
  'c.body.stand.front': stack(TORSO_FRONT, LEGS_STAND),
  'c.body.walk.front.0': stack(TORSO_FRONT, LEGS_STEP),
  'c.body.walk.front.1': stack(TORSO_FRONT, mirror(LEGS_STEP)),
  'c.body.stand.side': stack(TORSO_SIDE, LEGS_SIDE_STAND),
  'c.body.walk.side.0': stack(TORSO_SIDE, LEGS_SIDE_A),
  'c.body.walk.side.1': stack(TORSO_SIDE, LEGS_SIDE_B),
  'c.body.sit': SIT_IDLE,
  'c.body.sit.type0': SIT_TYPE_A,
  'c.body.sit.type1': SIT_TYPE_B,
  'c.body.sit.armup': SIT_ARM_UP,
  'c.body.sit.stretch': SIT_STRETCH,
  'c.sheet': SHEET,
  'c.hand': HAND,
  // bolhas
  'bubble.permission': bubble(SYM_EXCL, 'Y', 'a'),
  'bubble.question': bubble(SYM_QUEST, 'Y', 'u'),
  'bubble.done': bubble(SYM_CHECK, 'Y', 'n'),
  'bubble.error': bubble(SYM_X, 'Y', 'r'),
  'bubble.disconnected': bubble(SYM_ZZ, 'G', 'q'),
  'bubble.talk0': bubble(symDots(1), 'Y', 'k'),
  'bubble.talk1': bubble(symDots(2), 'Y', 'k'),
  'bubble.talk2': bubble(symDots(3), 'Y', 'k'),
  'icon.eye': EYE_ICON,
  'icon.key.e': KEY_E,
};

/** Dimensões do personagem (px do mundo). */
export const CHAR_W = 20;
export const CHAR_H = 28;
export const HEAD_H = 12;
export const SIT_BODY_H = 9;

/** Caracteres válidos em qualquer sprite (paleta fixa + dinâmicos + '#', usado só dentro dos símbolos). */
export function isValidChar(ch: string): boolean {
  return ch === '.' || ch in PALETTE || (CHARACTER_KEYS as readonly string[]).includes(ch);
}

export function spriteSize(name: string): { w: number; h: number } {
  const m = SPRITES[name];
  if (!m) throw new Error(`sprite desconhecido: ${name}`);
  return { w: m[0]?.length ?? 0, h: m.length };
}

// ---------------------------------------------------------------------------------------------
// Cache de canvases offscreen por zoom (só roda no navegador).
// ---------------------------------------------------------------------------------------------
export class SpriteCache {
  private readonly map = new Map<string, HTMLCanvasElement>();

  /** Canvas do sprite já escalado para o zoom (pixels inteiros, sem suavização). */
  get(name: string, zoom: number, dyn?: Record<string, string>, flip = false): HTMLCanvasElement {
    const variant = dyn ? Object.values(dyn).join('') : '';
    const key = `${name}|${zoom}|${variant}|${flip ? 1 : 0}`;
    const hit = this.map.get(key);
    if (hit) return hit;
    const m = SPRITES[name];
    if (!m) throw new Error(`sprite desconhecido: ${name}`);
    const src = flip ? mirror(m) : m;
    const w = src[0].length;
    const h = src.length;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, w * zoom);
    cv.height = Math.max(1, h * zoom);
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('canvas 2d indisponível');
    let last = '';
    for (let y = 0; y < h; y++) {
      const row = src[y];
      for (let x = 0; x < w; x++) {
        const ch = row[x];
        if (ch === '.') continue;
        const color = (dyn && dyn[ch]) ?? PALETTE[ch] ?? '#ff00ff';
        if (color !== last) { ctx.fillStyle = color; last = color; }
        ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
      }
    }
    this.map.set(key, cv);
    return cv;
  }

  clear(): void { this.map.clear(); }
}
