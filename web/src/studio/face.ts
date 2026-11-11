// Rosto desenhado num canvas e aplicado na frente da cabeça: olhos grandes de anime (íris em degradê, dois brilhos,
// cílio superior marcado), sobrancelhas, boca e blush. Expressões e fala trocam o desenho; o canvas só é redesenhado
// quando algo muda (piscar, falar, mudar de humor).
import * as THREE from 'three';

export type Eyes = 'open' | 'closed' | 'happy' | 'half';
export type Brows = 'neutral' | 'raised' | 'worried' | 'focus';
export type Mouth = 'smile' | 'neutral' | 'open1' | 'open2' | 'o' | 'flat';

export interface FaceState { eyes: Eyes; brows: Brows; mouth: Mouth; lookX: number; lookY: number }

export interface FaceLook { eye: string; brow: string; lash: string; skin: string; blush: number; lashes: 'soft' | 'bold' }

export const FACE_SIZE = 256;

/** Desenho puro do rosto num contexto 2D (exportado para testes visuais e para a prévia do cadastro). */
export function drawFace(g: CanvasRenderingContext2D, look: FaceLook, st: FaceState): void {
  const S = FACE_SIZE;
  g.clearRect(0, 0, S, S);
  const eyeY = 136;
  const eyeDX = 43;
  // blush
  if (look.blush > 0) {
    for (const s of [-1, 1]) {
      const grad = g.createRadialGradient(128 + s * 60, 170, 2, 128 + s * 60, 170, 22);
      grad.addColorStop(0, `rgba(244,140,150,${0.45 * look.blush})`);
      grad.addColorStop(1, 'rgba(244,140,150,0)');
      g.fillStyle = grad; g.beginPath(); g.ellipse(128 + s * 60, 170, 24, 14, 0, 0, Math.PI * 2); g.fill();
    }
  }
  // olhos
  for (const s of [-1, 1]) drawEye(g, 128 + s * eyeDX, eyeY, s, look, st);
  // sobrancelhas
  g.strokeStyle = look.brow; g.lineCap = 'round'; g.lineWidth = 6;
  for (const s of [-1, 1]) {
    const cx = 128 + s * eyeDX;
    let y = eyeY - 36; let tiltIn = 0;
    if (st.brows === 'raised') y -= 7;
    if (st.brows === 'worried') tiltIn = -7;
    if (st.brows === 'focus') { y += 4; tiltIn = 5; }
    g.beginPath();
    g.moveTo(cx - s * 17, y + 2 + tiltIn);
    g.quadraticCurveTo(cx + s * 2, y - 5 + tiltIn * 0.3, cx + s * 18, y + 2 - tiltIn * 0.4);
    g.stroke();
  }
  // nariz (só um traço de sombra)
  g.strokeStyle = 'rgba(160,90,80,0.55)'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(130, 168); g.quadraticCurveTo(133, 174, 127, 176); g.stroke();
  // boca
  drawMouth(g, 128, 196, st.mouth);
}

function drawEye(g: CanvasRenderingContext2D, cx: number, cy: number, side: number, look: FaceLook, st: FaceState): void {
  const w = 20, h = 26;
  g.lineCap = 'round'; g.lineJoin = 'round';
  if (st.eyes === 'closed') {
    g.strokeStyle = look.lash; g.lineWidth = 5;
    g.beginPath(); g.moveTo(cx - w, cy + 2); g.quadraticCurveTo(cx, cy + 10, cx + w, cy + 2); g.stroke();
    return;
  }
  if (st.eyes === 'happy') {
    g.strokeStyle = look.lash; g.lineWidth = 5.5;
    g.beginPath(); g.moveTo(cx - w, cy + 6); g.quadraticCurveTo(cx, cy - 12, cx + w, cy + 6); g.stroke();
    return;
  }
  const lid = st.eyes === 'half' ? 0.45 : 0; // pálpebra baixa (concentração)
  g.save();
  // branco do olho
  g.beginPath(); g.ellipse(cx, cy, w, h, 0, 0, Math.PI * 2); g.closePath();
  g.fillStyle = '#fffaf6'; g.fill();
  g.clip();
  // íris
  const ix = cx + st.lookX * 5, iy = cy + 3 + st.lookY * 4;
  const grad = g.createLinearGradient(0, iy - 18, 0, iy + 16);
  grad.addColorStop(0, shade(look.eye, -0.45));
  grad.addColorStop(0.55, look.eye);
  grad.addColorStop(1, shade(look.eye, 0.35));
  g.fillStyle = grad; g.beginPath(); g.ellipse(ix, iy, 15.5, 20, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = shade(look.eye, -0.6); g.beginPath(); g.ellipse(ix, iy + 1, 7.5, 10, 0, 0, Math.PI * 2); g.fill();
  // brilhos
  g.fillStyle = '#ffffff';
  g.beginPath(); g.ellipse(ix - 6 * side - 1, iy - 8, 6, 7, 0, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 0.85; g.beginPath(); g.arc(ix + 5, iy + 8, 2.6, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
  // pálpebra superior (concentrado)
  if (lid > 0) { g.fillStyle = look.skin; g.fillRect(cx - w - 2, cy - h - 2, w * 2 + 4, (h * 2 + 4) * lid); }
  g.restore();
  // cílio superior: arco grosso com "asa" no canto de fora
  const top = cy - h + (h * 2) * lid;
  g.strokeStyle = look.lash; g.fillStyle = look.lash;
  g.lineWidth = look.lashes === 'bold' ? 6.5 : 5;
  g.beginPath();
  g.moveTo(cx - side * (w + 1), cy - 2 + lid * 10);
  g.quadraticCurveTo(cx - side * 4, top - 7, cx + side * (w + 3), top + 6);
  g.stroke();
  if (look.lashes === 'bold') { g.beginPath(); g.moveTo(cx + side * (w + 3), top + 6); g.lineTo(cx + side * (w + 9), top + 1); g.lineWidth = 4; g.stroke(); }
  // cílio inferior discreto
  g.lineWidth = 2; g.globalAlpha = 0.55;
  g.beginPath(); g.moveTo(cx - 9, cy + h - 1); g.quadraticCurveTo(cx, cy + h + 2, cx + 9, cy + h - 1); g.stroke();
  g.globalAlpha = 1;
}

function drawMouth(g: CanvasRenderingContext2D, cx: number, cy: number, m: Mouth): void {
  g.lineCap = 'round';
  const line = '#8a4a52';
  const inside = '#a8434f';
  if (m === 'smile') {
    g.strokeStyle = line; g.lineWidth = 4.5;
    g.beginPath(); g.moveTo(cx - 13, cy - 2); g.quadraticCurveTo(cx, cy + 9, cx + 13, cy - 2); g.stroke();
  } else if (m === 'neutral') {
    g.strokeStyle = line; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx - 9, cy + 1); g.quadraticCurveTo(cx, cy + 4, cx + 9, cy + 1); g.stroke();
  } else if (m === 'flat') {
    g.strokeStyle = line; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx - 8, cy + 2); g.lineTo(cx + 8, cy + 2); g.stroke();
  } else {
    const [rw, rh] = m === 'open1' ? [10, 6] : m === 'open2' ? [12, 10] : [7, 8];
    g.fillStyle = inside; g.beginPath(); g.ellipse(cx, cy + 3, rw, rh, 0, 0, Math.PI * 2); g.fill();
    if (m === 'open2') { g.fillStyle = '#f08a96'; g.beginPath(); g.ellipse(cx, cy + 3 + rh * 0.45, rw * 0.6, rh * 0.4, 0, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = line; g.lineWidth = 2.5; g.beginPath(); g.ellipse(cx, cy + 3, rw, rh, 0, 0, Math.PI * 2); g.stroke();
  }
}

/** Clareia (+) ou escurece (-) uma cor #rrggbb. */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  const f = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  r = f(r); gg = f(gg); b = f(b);
  return `#${((1 << 24) | (r << 16) | (gg << 8) | b).toString(16).slice(1)}`;
}

/** Rosto vivo de um personagem: canvas próprio, textura e redesenho só quando o estado muda. */
export class Face {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private key = '';
  constructor(private readonly look: FaceLook) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = FACE_SIZE;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 2;
  }
  set(st: FaceState): void {
    const k = `${st.eyes}|${st.brows}|${st.mouth}|${st.lookX.toFixed(1)}|${st.lookY.toFixed(1)}`;
    if (k === this.key) return;
    this.key = k;
    drawFace(this.g, this.look, st);
    this.texture.needsUpdate = true;
  }
  dispose(): void { this.texture.dispose(); }
}
