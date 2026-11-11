// Nomes e aparência dos funcionários: só representação visual de uma sessão real.
const NAMES = ['Léo', 'Bia', 'Caio', 'Duda', 'Enzo', 'Flor', 'Gui', 'Helô', 'Ian', 'Júlia', 'Kadu', 'Lara', 'Mel', 'Nina', 'Otto', 'Pri', 'Rafa', 'Sofi', 'Téo', 'Vivi'];

export function pickWorkerName(used: string[]): string {
  const free = NAMES.find(n => !used.includes(n));
  if (free) return free;
  let i = 2;
  while (used.includes(`${NAMES[(i - 2) % NAMES.length]} ${i}`)) i++;
  return `${NAMES[(i - 2) % NAMES.length]} ${i}`;
}

export function pickDesk(usedDesks: number[], desksPerRoom = 4): number {
  for (let i = 0; i < desksPerRoom; i++) if (!usedDesks.includes(i)) return i;
  return usedDesks.length % desksPerRoom;
}

export function appearanceFor(seed: string): { skin: number; hair: number; shirt: number } {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return { skin: h % 4, hair: (h >>> 4) % 4, shirt: (h >>> 8) % 4 };
}

export const ROLE_BY_KIND: Record<string, string> = {
  dev: 'Desenvolvimento', social: 'Social Media', design: 'Design e Vídeo', research: 'Pesquisa e Prospecção', management: 'Gestão e Revisão', direction: 'Diretoria', meeting: 'Reuniões', custom: 'Equipe',
};
