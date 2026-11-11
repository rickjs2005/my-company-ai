// Busca de caminho em 4 direções na grade de tiles (A* com heurística Manhattan). Função pura, sem DOM.
// Usado quando um funcionário aparece (entra pela recepção) ou troca de sala/mesa.

import type { Tile } from './layout';

/** Caminho do início ao destino (inclui ambos). Vazio quando não há caminho ou o destino está bloqueado. */
export function findPath(walkable: boolean[][], from: Tile, to: Tile): Tile[] {
  const h = walkable.length;
  const w = h ? walkable[0].length : 0;
  const inside = (t: Tile) => t.x >= 0 && t.y >= 0 && t.x < w && t.y < h;
  if (!inside(from) || !inside(to)) return [];
  if (!walkable[to.y][to.x]) return [];
  if (from.x === to.x && from.y === to.y) return [from];

  const idx = (x: number, y: number) => y * w + x;
  const gScore = new Float64Array(w * h).fill(Infinity);
  const cameFrom = new Int32Array(w * h).fill(-1);
  const closed = new Uint8Array(w * h);
  const heur = (x: number, y: number) => Math.abs(x - to.x) + Math.abs(y - to.y);

  // Fila de prioridade simples (heap binário) sobre f = g + h.
  const heap: number[] = [];
  const fOf = new Float64Array(w * h).fill(Infinity);
  const push = (i: number) => {
    heap.push(i);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (fOf[heap[p]] <= fOf[heap[c]]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && fOf[heap[l]] < fOf[heap[m]]) m = l;
        if (r < heap.length && fOf[heap[r]] < fOf[heap[m]]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };

  const start = idx(from.x, from.y);
  const goal = idx(to.x, to.y);
  gScore[start] = 0;
  fOf[start] = heur(from.x, from.y);
  push(start);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

  while (heap.length) {
    const cur = pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!walkable[ny][nx]) continue;
      const ni = idx(nx, ny);
      if (closed[ni]) continue;
      const g = gScore[cur] + 1;
      if (g < gScore[ni]) {
        gScore[ni] = g;
        fOf[ni] = g + heur(nx, ny);
        cameFrom[ni] = cur;
        push(ni);
      }
    }
  }
  if (cameFrom[goal] === -1) return [];
  const path: Tile[] = [];
  for (let i = goal; i !== -1; i = cameFrom[i]) {
    const x = i % w;
    path.push({ x, y: (i - x) / w });
  }
  path.reverse();
  return path;
}

/** Tile livre mais próximo de `t` (busca em largura); o próprio `t` se já estiver livre. null se nada livre. */
export function nearestWalkable(walkable: boolean[][], t: Tile, maxRadius = 6): Tile | null {
  const h = walkable.length;
  const w = h ? walkable[0].length : 0;
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && walkable[y][x];
  if (ok(t.x, t.y)) return t;
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.abs(dx) + Math.abs(dy) !== r) continue;
      if (ok(t.x + dx, t.y + dy)) return { x: t.x + dx, y: t.y + dy };
    }
  }
  return null;
}
