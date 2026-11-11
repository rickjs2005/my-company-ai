// Paleta do estúdio 3D da Aurora (direção de 08/11/2026: animação 3D estilizada com expressividade de anime).
// Base clara, madeira suave, vidro e toques de lavanda, coral e rosa; o âmbar da Aurora é a assinatura.

export const STUDIO = {
  // estrutura
  floor: '#e6cba6',          // piso de madeira clara (mel)
  floorPlank: '#dfcfba',
  wall: '#f6efe6',
  wallTrim: '#e6d6c3',
  wallAccent: '#f2e3ef',     // parede rosada (estúdio de vídeo)
  baseboard: '#d9c2a8',
  // madeira e móveis
  wood: '#d4a676',
  woodDark: '#b9875a',
  woodLight: '#e8c9a0',
  white: '#fbf8f4',
  metal: '#c9c4cf',
  metalDark: '#7d7884',
  fabric: '#c9b8e8',         // lavanda
  fabricCoral: '#f4a28c',
  fabricPink: '#f5b8cf',
  fabricTeal: '#9fd3cf',
  // marca
  amber: '#f0a830',
  amberDeep: '#d98a12',
  ink: '#3a2f3d',            // texto e contornos (berinjela escura, nunca preto puro)
  // vidro e telas
  glass: '#cfe7f3',
  glassFrame: '#e9e2ee',
  screenOff: '#2b2733',
  screenGlow: '#fff4dd',
  // natureza
  leaf: '#7cbf7a',
  leafDark: '#5a9f63',
  pot: '#e8b49a',
  // luz
  sun: '#fff1d8',
  sky: '#fdf6ff',
  bounce: '#f3dcc8',
} as const;

/** Tons de pele (índices compatíveis com `appearance.skin` 0..5 do cadastro). */
export const SKIN = ['#f8d9c4', '#f1c3a1', '#dca37f', '#c58660', '#9c6446', '#6f4532'];
/** Cabelos (índices compatíveis com `appearance.hair` 0..7). */
export const HAIR = ['#3b2a26', '#6b3f2a', '#a8673a', '#e3b36a', '#c9533e', '#2d2a3a', '#b8b2c4', '#7a4e8c'];
/** Roupas (índices compatíveis com `appearance.shirt` 0..7). */
export const SHIRT = ['#f0a830', '#8fb8f0', '#f4a28c', '#b9a3e3', '#8fd0b9', '#f5b8cf', '#f6efe6', '#6d7fb8'];
export const PANTS = ['#4a4458', '#5d6b8a', '#8a6d5a', '#3f5a63', '#6b5a7d', '#e8dccb'];
export const EYES = ['#5a3b2e', '#3f6fa8', '#4f8a5a', '#7a4e8c', '#8a5a2e', '#3a4a6a'];

export function pick<T>(list: readonly T[], index: number | undefined | null): T {
  const n = list.length;
  const i = ((Math.floor(index ?? 0) % n) + n) % n;
  return list[i];
}

/** Hash estável (FNV-1a) para variar cabelo e detalhes sem depender do nome. */
export function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
