// Materiais do estúdio: sombreamento "cel" (anime) nos personagens e rampa suave no cenário, os dois com sombras
// levantadas (nada de preto). Um cache por cor evita centenas de materiais iguais.
import * as THREE from 'three';

function ramp(tones: number[], smooth: boolean): THREE.DataTexture {
  const data = new Uint8Array(tones.length * 4);
  tones.forEach((t, i) => { const v = Math.round(t * 255); data.set([v, v, v, 255], i * 4); });
  const tex = new THREE.DataTexture(data, tones.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Personagens: três faixas nítidas, sombra clara (estilo anime). */
export const CEL_RAMP = ramp([0.74, 0.9, 1], false);
/** Cenário: rampa contínua com piso alto (luz de animação, sem cantos escuros). */
export const SOFT_RAMP = ramp([0.56, 0.72, 0.88, 1], true);

const cache = new Map<string, THREE.Material>();

export function toon(color: string, opts: { soft?: boolean; emissive?: string; emissiveIntensity?: number; transparent?: boolean; opacity?: number; side?: THREE.Side } = {}): THREE.MeshToonMaterial {
  const key = `toon|${color}|${opts.soft ? 1 : 0}|${opts.emissive ?? ''}|${opts.emissiveIntensity ?? ''}|${opts.opacity ?? ''}|${opts.side ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit as THREE.MeshToonMaterial;
  const m = new THREE.MeshToonMaterial({ color, gradientMap: opts.soft ? SOFT_RAMP : CEL_RAMP });
  if (opts.emissive) { m.emissive = new THREE.Color(opts.emissive); m.emissiveIntensity = opts.emissiveIntensity ?? 1; }
  if (opts.transparent || opts.opacity !== undefined) { m.transparent = true; m.opacity = opts.opacity ?? 1; m.depthWrite = (opts.opacity ?? 1) > 0.95; }
  if (opts.side !== undefined) m.side = opts.side;
  cache.set(key, m);
  return m;
}

export function basic(color: string, opts: { opacity?: number; additive?: boolean; side?: THREE.Side } = {}): THREE.MeshBasicMaterial {
  const key = `basic|${color}|${opts.opacity ?? ''}|${opts.additive ? 1 : 0}|${opts.side ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit as THREE.MeshBasicMaterial;
  const m = new THREE.MeshBasicMaterial({ color });
  if (opts.opacity !== undefined) { m.transparent = true; m.opacity = opts.opacity; m.depthWrite = false; }
  if (opts.additive) { m.blending = THREE.AdditiveBlending; m.transparent = true; m.depthWrite = false; }
  if (opts.side !== undefined) m.side = opts.side;
  cache.set(key, m);
  return m;
}

/** Vidro barato: transparente, com leve brilho; sem refração (desempenho no notebook). */
export function glass(color: string, opacity = 0.22): THREE.MeshLambertMaterial {
  const key = `glass|${color}|${opacity}`;
  const hit = cache.get(key);
  if (hit) return hit as THREE.MeshLambertMaterial;
  const m = new THREE.MeshLambertMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  m.emissive = new THREE.Color(color); m.emissiveIntensity = 0.25;
  cache.set(key, m);
  return m;
}

/**
 * Contorno discreto por "casca invertida": a mesma geometria, inflada pela normal e desenhada só pelo lado de trás.
 * A espessura é em metros do mundo; cor berinjela escura (o contorno do anime, nunca preto puro).
 */
export function outlineMaterial(thickness = 0.008, color = '#4a3a4f'): THREE.ShaderMaterial {
  const key = `outline|${thickness}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit as THREE.ShaderMaterial;
  const m = new THREE.ShaderMaterial({
    uniforms: { uThickness: { value: thickness }, uColor: { value: new THREE.Color(color) } },
    vertexShader: `
      uniform float uThickness;
      void main() {
        vec3 p = position + normal * uThickness;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    side: THREE.BackSide,
  });
  cache.set(key, m);
  return m;
}

/** Sombra de contato (mancha macia no chão), usada mesmo com as sombras projetadas desligadas. */
let blobTex: THREE.CanvasTexture | null = null;
export function blobShadowTexture(): THREE.CanvasTexture {
  if (blobTex) return blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(74,50,70,0.42)');
  grad.addColorStop(0.55, 'rgba(74,50,70,0.2)');
  grad.addColorStop(1, 'rgba(74,50,70,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(c);
  blobTex.colorSpace = THREE.SRGBColorSpace;
  return blobTex;
}

let blobMat: THREE.MeshBasicMaterial | null = null;
export function blobShadowMaterial(): THREE.MeshBasicMaterial {
  if (blobMat) return blobMat;
  blobMat = new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false });
  return blobMat;
}

/** Poça de luz (luminária, janela): gradiente aditivo no chão; não custa luz dinâmica. */
let poolTex: THREE.CanvasTexture | null = null;
export function lightPoolTexture(): THREE.CanvasTexture {
  if (poolTex) return poolTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 63);
  grad.addColorStop(0, 'rgba(255,236,200,0.26)');
  grad.addColorStop(0.5, 'rgba(255,226,190,0.1)');
  grad.addColorStop(1, 'rgba(255,220,190,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  poolTex = new THREE.CanvasTexture(c);
  poolTex.colorSpace = THREE.SRGBColorSpace;
  return poolTex;
}

export function disposeMaterials(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
  blobTex?.dispose(); blobTex = null;
  blobMat?.dispose(); blobMat = null;
  poolTex?.dispose(); poolTex = null;
}
