// Motor do estúdio 3D. Mesma ideia da sala isométrica: a cena só REPRESENTA o estado real do servidor.
// Caminhar, sentar e apresentar são encenação de eventos reais; sem execução real o personagem fica parado (disponível,
// em pausa ou na fila). Nada aqui chama IA nem gera fala.
import * as THREE from 'three';
import type { SceneMeeting, SceneWorker } from '../scene/types';
import type { BoardCounts, IsoTarget } from '../scene/iso/socialRoom';
import { Character, lookFor, type Activity } from './character';
import { desiredFor, bossQueue, type PlaceKey } from './behavior';
import {
  BOSS, D, DESKS, ENTRANCE, MEETING, TEAM_TABLES, W, blockOriented, buildGrid, cellOf, deskByIndex, findPath, meetingSeat, teamOfSeatIndex,
  teamSeat, teamTableRadius, zoneRect, type Grid, type Pt, type StudioTeamId, type ZoneId,
} from './layout';
import { buildWorld, drawSocials, mergeByMaterial, type World } from './world';
import { TeamSign, roundTeamTable, type Screen } from './props';
import { disposeMaterials } from './materials';

export type Quality = 'alta' | 'equilibrada' | 'economia';

export interface StudioOptions {
  inputEnabled: boolean;
  reducedMotion: boolean;
  paused: boolean;
  quality: Quality;
  showLabels: boolean;
  insets: { left: number; right: number; top: number; bottom: number };
  /** Teto de quadros por segundo; 0 = sem teto (só para medir a capacidade). Padrão: o da qualidade. */
  fpsCap?: number;
}

export interface StudioStats {
  fps: number; frameMs: number; calls: number; triangles: number; geometries: number; textures: number;
  heapMB: number | null; quality: Quality; pixelRatio: number; renderer: string; characters: number; meshes: { before: number; after: number };
}

/** Equipe permanente na sala: assentos = integrantes reais; resumo só com dados reais (execução, fila, revisão, bloqueios). */
export interface StudioTeam { id: StudioTeamId; label: string; channels: string; color: string; rug: string; seats: number; summary: string | null }

export interface StudioHandlers {
  onInteract(target: IsoTarget): void;
  onHover?(label: string | null): void;
  onFail?(reason: string): void;
}

export interface Studio {
  setWorkers(workers: SceneWorker[]): void;
  setMeeting(meeting: SceneMeeting | null, title?: string | null): void;
  setBoard(counts: BoardCounts): void;
  setSocials(items: { label: string; state: 'connected' | 'configured' | 'error' | 'off' }[]): void;
  setStudioStatus(text: string | null): void;
  setPlayer(p: { name: string; appearance: { skin: number; hair: number; shirt: number } }): void;
  /** As duas equipes da Social Media: mesas redondas do tamanho da equipe, placas e resumos. */
  setTeams(teams: StudioTeam[]): void;
  /** Enquadra e mantém o enquadramento quando o palco muda (painel abriu): 'all' = empresa inteira; 'teams' = as duas mesas. */
  frame(target: 'all' | ZoneId): void;
  setSelected(workerId: string | null): void;
  setOptions(o: Partial<StudioOptions>): void;
  center(): void;
  zoomBy(dir: 1 | -1): void;
  focusWorker(id: string): void;
  focusZone(id: ZoneId): void;
  /** Posição na tela (px CSS dentro do palco) da cabeça de um funcionário. */
  screenPos(workerId: string): { x: number; y: number } | null;
  resize(): void;
  destroy(): void;
  hoveredLabel(): string | null;
  stats(): StudioStats;
  /**
   * Encenação curta de um evento REAL (revisão pedida, entrega validada): o funcionário vai até o revisor ou até a mesa do
   * Chefe, mostra o texto e volta. Só acontece se ele não estiver trabalhando nem em reunião; a mesma chave não repete.
   */
  errand(workerId: string, e: { to: 'boss' | { workerId: string }; text: string; ms: number; key: string }): void;
  /** Dirige um personagem manualmente (área piloto e testes visuais): ir a um lugar e fazer uma atividade. */
  debugAct?(id: string, place: PlaceKey, activity: Activity): void;
}

interface Actor {
  id: string;
  char: Character;
  worker: SceneWorker | null;
  deskIndex: number;
  /** Lugar onde está (ou para onde vai) e se já chegou/sentou. */
  goal: PlaceKey | null;
  at: PlaceKey | null;
  seated: boolean;
  busy: boolean; // levantando, andando ou sentando
  activity: Activity;
  tag: HTMLDivElement;
  bubble: HTMLDivElement;
  bubbleText: string;
  manager?: boolean;
  bossSlot: number;
  leaving?: boolean;
  errand?: { to: 'boss' | { workerId: string }; text: string; until: number };
}

const QUALITY: Record<Quality, { pr: number; shadow: number; fps: number; outline: boolean }> = {
  alta: { pr: 1.5, shadow: 2048, fps: 60, outline: true },
  equilibrada: { pr: 1, shadow: 1024, fps: 45, outline: true },
  economia: { pr: 0.75, shadow: 0, fps: 30, outline: false },
};

export function createStudio(canvas: HTMLCanvasElement, overlay: HTMLElement, handlers: StudioHandlers, initial: Partial<StudioOptions> = {}): Studio {
  const opts: StudioOptions = {
    inputEnabled: true, reducedMotion: false, paused: false, quality: 'equilibrada', showLabels: true,
    insets: { left: 0, right: 0, top: 0, bottom: 0 }, ...initial,
  };
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: opts.quality !== 'economia', alpha: true, powerPreference: 'high-performance', stencil: false });
  } catch (err) {
    handlers.onFail?.(String((err as Error)?.message ?? err));
    throw err;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = QUALITY[opts.quality].shadow > 0;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // o cenário é estático: a sombra projetada é desenhada uma vez
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'WebGL';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.5, 200);
  // luz: céu claro + reflexo quente do piso, e um "sol" da frente-esquerda (rostos iluminados)
  const hemi = new THREE.HemisphereLight('#fff5fa', '#e9cdb6', 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff0d6', 2.3);
  sun.position.set(W / 2 - 9, 16, D / 2 + 12);
  sun.target.position.set(W / 2, 0, D / 2);
  scene.add(sun, sun.target);
  sun.castShadow = renderer.shadowMap.enabled;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -15; sc.right = 15; sc.top = 12; sc.bottom = -12; sc.near = 2; sc.far = 50;
  sun.shadow.mapSize.set(QUALITY[opts.quality].shadow || 512, QUALITY[opts.quality].shadow || 512);
  sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.02; sun.shadow.radius = 4;
  const fill = new THREE.DirectionalLight('#f3e6ff', 0.45); fill.position.set(W + 6, 8, -4); scene.add(fill);

  const world: World = buildWorld();
  scene.add(world.root);
  renderer.shadowMap.needsUpdate = true;
  let grid: Grid = buildGrid();

  // anel de seleção
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.46, 40), new THREE.MeshBasicMaterial({ color: '#f0a830', transparent: true, opacity: 0.9, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; ring.visible = false; ring.renderOrder = 3;
  scene.add(ring);

  // ---------------- DOM sobreposto (nomes, balões, placas) ----------------
  overlay.classList.add('st-overlay');
  const zoneEls = world.zoneLabels.map(z => { const el = document.createElement('div'); el.className = 'st-zone'; el.textContent = z.label; overlay.appendChild(el); return { ...z, el }; });
  const hint = document.createElement('div'); hint.className = 'st-hint'; hint.hidden = true; overlay.appendChild(hint);

  // ---------------- câmera ----------------
  const cam = { target: new THREE.Vector3(W / 2, 0, D / 2), dist: 30, az: 0.58, el: 0.74, follow: null as string | null };
  const camGoal = { target: cam.target.clone(), dist: cam.dist };
  let width = 1, height = 1;
  /** Enquanto o Chefe não mexer na câmera, o enquadramento acompanha o tamanho do palco (painel abrindo ou fechando). */
  let autoFit = true;
  let fitTarget: 'all' | ZoneId = 'all';
  function applyCamera(): void {
    const c = Math.cos(cam.el);
    camera.position.set(cam.target.x + Math.sin(cam.az) * c * cam.dist, cam.target.y + Math.sin(cam.el) * cam.dist, cam.target.z + Math.cos(cam.az) * c * cam.dist);
    camera.lookAt(cam.target);
    camera.updateMatrixWorld();
  }
  const fitPoints = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(W, 0, 0), new THREE.Vector3(0, 0, D), new THREE.Vector3(W, 0, D), new THREE.Vector3(0, 3, 0), new THREE.Vector3(W, 3, 0), new THREE.Vector3(0, 3, D), new THREE.Vector3(W / 2, 0, D + 0.3)];
  function usable() {
    const i = opts.insets;
    return { x0: i.left, y0: i.top, x1: Math.max(i.left + 50, width - i.right), y1: Math.max(i.top + 50, height - i.bottom) };
  }
  /** Distância e alvo que enquadram o estúdio inteiro na área útil (descontados os painéis). */
  function fitView(points = fitPoints, margin = 18): { target: THREE.Vector3; dist: number } {
    const u = usable();
    const save = { t: cam.target.clone(), d: cam.dist };
    const center = new THREE.Vector3();
    for (const p of points) center.add(p);
    center.divideScalar(points.length); center.y = 0;
    cam.target.copy(center);
    let lo = 4, hi = 120;
    for (let it = 0; it < 26; it++) {
      cam.dist = (lo + hi) / 2; applyCamera();
      const b = bounds(points);
      const fits = b.x1 - b.x0 <= u.x1 - u.x0 - margin * 2 && b.y1 - b.y0 <= u.y1 - u.y0 - margin * 2;
      if (fits) hi = cam.dist; else lo = cam.dist;
    }
    cam.dist = hi; applyCamera();
    // desloca o alvo para o centro da área útil
    for (let it = 0; it < 3; it++) {
      const b = bounds(points);
      const dx = (u.x0 + u.x1) / 2 - (b.x0 + b.x1) / 2, dy = (u.y0 + u.y1) / 2 - (b.y0 + b.y1) / 2;
      const a = groundAt(width / 2, height / 2), bb = groundAt(width / 2 - dx, height / 2 - dy);
      if (a && bb) cam.target.add(bb.sub(a));
      applyCamera();
    }
    const out = { target: cam.target.clone(), dist: cam.dist };
    cam.target.copy(save.t); cam.dist = save.d; applyCamera();
    return out;
  }
  function bounds(points: THREE.Vector3[]) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const v = new THREE.Vector3();
    for (const p of points) { v.copy(p).project(camera); const x = (v.x + 1) / 2 * width, y = (1 - v.y) / 2 * height; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { x0, y0, x1, y1 };
  }
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function groundAt(px: number, py: number): THREE.Vector3 | null {
    ray.setFromCamera(new THREE.Vector2(px / width * 2 - 1, -(py / height) * 2 + 1), camera);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out : null;
  }
  function clampTarget(t: THREE.Vector3): void { t.x = Math.max(-2, Math.min(W + 2, t.x)); t.z = Math.max(-2, Math.min(D + 2, t.z)); }

  // ---------------- personagens ----------------
  const actors = new Map<string, Actor>();
  let player: Actor | null = null;
  let selected: string | null = null;
  let meeting: SceneMeeting | null = null;
  let bossOrder: string[] = [];
  let dirtyPlans = true;
  let initialized = false;
  // ---------------- equipes (mesas redondas) ----------------
  const teams = new Map<StudioTeamId, { def: StudioTeam; seats: number; group: THREE.Object3D | null; screens: Screen[]; sign: TeamSign; pick: THREE.Mesh; pill: HTMLDivElement }>();
  /** Mesa avulsa (índice da planta) ou assento de equipe (100+ Aurora, 200+ Tuco Dev). */
  function seatSpot(n: number) {
    const t = teamOfSeatIndex(n);
    if (t) { const st = teams.get(t); return teamSeat(t, n % 100, Math.max(2, st?.seats ?? (n % 100) + 1)); }
    return deskByIndex(n);
  }
  function screensOf(n: number): Screen[] | undefined {
    const t = teamOfSeatIndex(n);
    if (t) { const s = teams.get(t)?.screens[n % 100]; return s ? [s] : undefined; }
    return world.deskScreens.get(n);
  }
  function teamGrid(): Grid {
    const g = buildGrid(Object.fromEntries([...teams].map(([k, v]) => [k, v.seats])));
    for (const st of teams.values()) blockOriented(g, st.sign.group.position.x, st.sign.group.position.z, 1.0, 0.08, 0, 0.06);
    return g;
  }
  const errandKeys = new Set<string>();

  function makeTag(name: string, kind: 'worker' | 'player' | 'manager'): { tag: HTMLDivElement; bubble: HTMLDivElement } {
    const tag = document.createElement('div'); tag.className = `st-tag st-tag--${kind}`;
    const dot = document.createElement('span'); dot.className = 'st-tag__dot';
    const nm = document.createElement('span'); nm.className = 'st-tag__name'; nm.textContent = name;
    tag.append(dot, nm); overlay.appendChild(tag);
    const bubble = document.createElement('div'); bubble.className = 'st-bubble'; bubble.hidden = true; overlay.appendChild(bubble);
    return { tag, bubble };
  }

  function spawn(id: string, name: string, look: ReturnType<typeof lookFor>, kind: 'worker' | 'player' | 'manager', at: Pt): Actor {
    const char = new Character(id, look, { outline: QUALITY[opts.quality].outline });
    char.place(at.x, at.z, Math.PI);
    scene.add(char.root);
    const { tag, bubble } = makeTag(name, kind);
    const a: Actor = { id, char, worker: null, deskIndex: -1, goal: null, at: null, seated: false, busy: false, activity: 'stand', tag, bubble, bubbleText: '', bossSlot: -1, manager: kind === 'manager' };
    return a;
  }

  function placePoint(a: Actor, key: PlaceKey): (Pt & { facing: number; seat?: Pt & { facing: number } }) | null {
    if (key === 'desk:-1') return { ...BOSS.seatApproach, facing: BOSS.seat.facing, seat: BOSS.seat };
    if (key.startsWith('desk:')) {
      const d = seatSpot(Number(key.slice(5)));
      if (!d) return null;
      return { ...d.approach, facing: d.seat.facing, seat: d.seat };
    }
    if (key === 'boss') {
      const slot = Math.max(0, a.bossSlot);
      return slot === 0 ? BOSS.attend : BOSS.queue[Math.min(slot - 1, BOSS.queue.length - 1)];
    }
    if (key.startsWith('visit:')) {
      const d = seatSpot(Number(key.slice(6)));
      if (!d) return null;
      const dx = d.seat.x - d.approach.x, dz = d.seat.z - d.approach.z;
      return { x: d.approach.x - dx * 0.15, z: d.approach.z - dz * 0.15, facing: Math.atan2(dx, dz) };
    }
    if (key.startsWith('meeting:')) {
      const s = meetingSeat(Number(key.slice(8)) % MEETING.seats);
      return { ...s.approach, facing: s.facing, seat: { x: s.x, z: s.z, facing: s.facing } };
    }
    return null;
  }

  function occupiedFn(self: Actor) {
    const cells = new Set<number>();
    for (const o of actors.values()) if (o !== self && !o.char.moving) { const c = cellOf({ x: o.char.position.x, z: o.char.position.z }); cells.add(c.cz * 10000 + c.cx); }
    if (player && player !== self && !player.char.moving) { const c = cellOf({ x: player.char.position.x, z: player.char.position.z }); cells.add(c.cz * 10000 + c.cx); }
    return (cx: number, cz: number) => cells.has(cz * 10000 + cx);
  }

  /** Leva o ator até o lugar: levanta se estiver sentado, caminha, e ao chegar senta ou fica de pé. */
  function goTo(a: Actor, key: PlaceKey): void {
    a.goal = key;
    const p = placePoint(a, key);
    if (!p) return;
    const run = () => {
      if (opts.reducedMotion) { arrive(a, key, true); return; }
      const from = { x: a.char.position.x, z: a.char.position.z };
      const path = findPath(grid, from, p, occupiedFn(a));
      a.busy = true;
      a.char.follow(path.map(q => new THREE.Vector2(q.x, q.z)), () => arrive(a, key, false));
      if (!path.length) arrive(a, key, true);
    };
    if (a.seated) standUp(a, run); else run();
  }

  function standUp(a: Actor, then: () => void): void {
    a.busy = true;
    const from = a.at ? placePoint(a, a.at) : null;
    a.seated = false;
    a.char.activity = 'stand';
    if (!from || opts.reducedMotion) { if (from) a.char.place(from.x, from.z); a.busy = false; then(); return; }
    a.char.slide(new THREE.Vector2(from.x, from.z), 0.55, () => { a.busy = false; then(); });
  }

  function arrive(a: Actor, key: PlaceKey, instant: boolean): void {
    const p = placePoint(a, key);
    if (!p) return;
    a.at = key;
    if (instant) a.char.place(p.x, p.z, p.facing);
    a.char.turnTo(p.facing);
    if (p.seat) {
      const seat = p.seat;
      a.char.activity = 'sit';
      const done = () => { a.seated = true; a.busy = false; a.char.activity = a.activity; };
      if (instant) { a.char.place(seat.x, seat.z, seat.facing); done(); }
      else a.char.slide(new THREE.Vector2(seat.x, seat.z), 0.6, done);
    } else {
      a.busy = false;
      a.char.activity = a.activity;
    }
  }

  function syncActivity(a: Actor): void {
    if (a.busy || a.char.moving) return;
    if (a.goal && a.at !== a.goal) return;
    let act = a.activity;
    if (a.at === 'boss') act = a.bossSlot === 0 ? 'present' : 'wait';
    if (a.seated && !['sit', 'type', 'think', 'sitTalk', 'sitListen'].includes(act)) act = 'sit';
    a.char.activity = act;
  }

  function planAll(): void {
    dirtyPlans = false;
    // fila do chefe
    const wanting = new Set<string>();
    const meetingSeats = new Map<string, { seat: number; speaking: boolean }>();
    if (meeting?.active) for (const m of meeting.actors) meetingSeats.set(m.id, { seat: m.seat, speaking: m.state === 'responding' });
    const desired = new Map<string, ReturnType<typeof desiredFor>>();
    for (const a of actors.values()) {
      if (!a.worker || a.manager) continue;
      let d = desiredFor(a.worker, a.deskIndex, meetingSeats.get(a.id) ?? null);
      const free = d.place === `desk:${a.deskIndex}` && d.activity === 'sit';
      if (a.errand && a.errand.until > performance.now() && free) {
        const to = a.errand.to;
        const target = to === 'boss' ? null : actors.get(to.workerId);
        const place = to === 'boss' ? 'boss' as const : target ? `visit:${target.deskIndex}` as PlaceKey : null;
        if (place) d = { ...d, place, activity: to === 'boss' ? 'present' : 'talk', mood: 'happy', bubble: { text: a.errand.text, tone: 'work' } };
      } else if (a.errand && (a.errand.until <= performance.now() || !free)) a.errand = undefined;
      desired.set(a.id, d);
      if (d.place === 'boss') wanting.add(a.id);
    }
    bossOrder = bossQueue(bossOrder, wanting);
    for (const a of actors.values()) {
      if (a.manager) continue;
      const d = desired.get(a.id);
      if (!d || !a.worker) continue;
      a.activity = d.activity;
      a.char.mood = d.mood;
      const newSlot = d.place === 'boss' ? bossOrder.indexOf(a.id) : -1;
      const slotChanged = newSlot !== a.bossSlot;
      a.bossSlot = newSlot;
      setBubble(a, d.bubble ? (d.place === 'boss' && newSlot > 0 ? `${d.bubble.text} · na fila (${newSlot}º)` : d.bubble.text) : '', d.bubble?.tone ?? 'work');
      const screens = screensOf(a.deskIndex);
      if (screens) { screens[0]?.set(d.screen); screens[1]?.set(d.screen.kind === 'off' ? d.screen : { kind: 'idle', name: a.worker.name.split(' ')[0] }); }
      if (a.goal !== d.place || (d.place === 'boss' && slotChanged)) goTo(a, d.place);
      else syncActivity(a);
      const visitTarget = d.place.startsWith('visit:') && a.errand && a.errand.to !== 'boss' ? actors.get(a.errand.to.workerId) : null;
      a.char.lookTarget = d.place === 'boss' && player ? player.char.position.clone().setY(1.2) : visitTarget ? visitTarget.char.position.clone() : null;
    }
    // o Chefe olha para quem está no atendimento
    if (player) {
      const attending = bossOrder[0] ? actors.get(bossOrder[0]) : null;
      player.char.lookTarget = attending && attending.at === 'boss' ? attending.char.position.clone() : null;
      if (player.seated) player.char.activity = attending && attending.at === 'boss' && !attending.char.moving ? 'sitListen' : 'sit';
    }
    // gerentes de IA na reunião (entram e saem pela porta da sala)
    const managerIds = new Set((meeting?.active ? meeting.actors : []).filter(m => !actors.has(m.id) || actors.get(m.id)!.manager).filter(m => m.provider && !isEmployee(m.id)).map(m => m.id));
    for (const m of meeting?.active ? meeting.actors : []) {
      if (!managerIds.has(m.id)) continue;
      let a = actors.get(m.id);
      if (!a) {
        const look = lookFor(m.id, m.provider === 'openai' ? { skin: 2, hair: 5, shirt: 4 } : { skin: 1, hair: 4, shirt: 2 }, 'gerente', { hairStyle: m.provider === 'openai' ? 'short' : 'bob', accessory: 'badge' });
        a = spawn(m.id, m.name, look, 'manager', { x: 5.2, z: 5.6 });
        actors.set(m.id, a);
      }
      a.activity = m.state === 'responding' ? 'sitTalk' : 'sitListen';
      setBubble(a, m.state === 'responding' ? 'falando na reunião' : '', 'work');
      const key: PlaceKey = `meeting:${m.seat}`;
      if (a.goal !== key) goTo(a, key); else syncActivity(a);
    }
    for (const a of [...actors.values()]) {
      if (!a.manager || managerIds.has(a.id) || a.leaving) continue;
      a.leaving = true;
      const out = () => { removeActor(a); };
      if (a.seated) standUp(a, () => walkOut(a, out)); else walkOut(a, out);
    }
  }
  function isEmployee(id: string): boolean { const a = actors.get(id); return !!a && !a.manager; }
  function walkOut(a: Actor, done: () => void): void {
    const path = findPath(grid, { x: a.char.position.x, z: a.char.position.z }, { x: 5.2, z: 5.6 });
    if (opts.reducedMotion || !path.length) { done(); return; }
    a.char.follow(path.map(q => new THREE.Vector2(q.x, q.z)), done);
  }
  function removeActor(a: Actor): void {
    scene.remove(a.char.root); a.char.dispose(); a.tag.remove(); a.bubble.remove(); actors.delete(a.id);
  }

  function setBubble(a: Actor, text: string, tone: string): void {
    if (text === a.bubbleText && a.bubble.dataset.tone === tone) return;
    a.bubbleText = text;
    a.bubble.textContent = text;
    a.bubble.dataset.tone = tone;
    a.bubble.hidden = !text;
    a.tag.dataset.tone = text ? tone : 'idle';
  }

  // ---------------- entrada (mouse e teclado) ----------------
  let hovered: { label: string; target: IsoTarget } | null = null;
  let hoveredWorker: string | null = null;
  let pointer: { x: number; y: number } | null = null;
  let drag: { x: number; y: number; ground: THREE.Vector3 | null; moved: boolean; id: number } | null = null;

  function pickAt(px: number, py: number): { label: string; target: IsoTarget } | null {
    ray.setFromCamera(new THREE.Vector2(px / width * 2 - 1, -(py / height) * 2 + 1), camera);
    const charPicks = [...actors.values()].filter(a => !a.manager).map(a => a.char.pick);
    const hitsC = ray.intersectObjects(charPicks, false);
    const hitsW = ray.intersectObjects(world.picks.map(p => p.mesh), false);
    const hitsT = ray.intersectObjects([...teams.values()].map(t => t.pick), false);
    const c = hitsC[0], w = hitsW[0], tm = hitsT[0];
    if (tm && (!c || tm.distance < c.distance - 0.4) && (!w || tm.distance <= w.distance)) {
      const st = [...teams.values()].find(t => t.pick === tm.object)!;
      return { label: `${st.def.label}: integrantes, tarefas e entregas`, target: { kind: 'team', team: st.def.id } };
    }
    if (c && (!w || c.distance <= w.distance + 0.6)) {
      const id = c.object.userData.characterId as string;
      const a = actors.get(id);
      return { label: a?.worker ? `${a.worker.name} · ${a.worker.role}` : 'Funcionário', target: { kind: 'worker', id } };
    }
    if (w) {
      const p = world.picks.find(x => x.mesh === w.object)!;
      const target = p.target;
      if (target.kind === 'desk') {
        const di = target.deskIndex;
        const owner = [...actors.values()].find(a => a.deskIndex === di && a.worker);
        return { label: owner?.worker ? `Mesa de ${owner.worker.name}` : `${p.label}: contratar alguém`, target: { kind: 'desk', deskIndex: di, workerId: owner?.id ?? null } };
      }
      return { label: p.label, target };
    }
    return null;
  }

  const onPointerMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (drag && (drag.moved || Math.hypot(pointer.x - drag.x, pointer.y - drag.y) > 5)) {
      drag.moved = true;
      cam.follow = null; autoFit = false;
      const now = groundAt(pointer.x, pointer.y);
      if (drag.ground && now) { const d = drag.ground.clone().sub(now); cam.target.add(d); camGoal.target.copy(cam.target); clampTarget(cam.target); applyCamera(); }
      canvas.style.cursor = 'grabbing';
      return;
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    drag = { x, y, ground: groundAt(x, y), moved: false, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    canvas.releasePointerCapture(drag.id);
    drag = null;
    canvas.style.cursor = '';
    if (wasDrag || !opts.inputEnabled) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = pickAt(x, y);
    if (hit) { handlers.onInteract(hit.target); return; }
    // clique no chão: o Chefe anda até lá
    const g = groundAt(x, y);
    if (g && player && g.x > 0.3 && g.x < W - 0.3 && g.z > 0.3 && g.z < D - 0.3) walkPlayer({ x: g.x, z: g.z });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const before = groundAt(px, py);
    autoFit = false;
    cam.dist = Math.max(5, Math.min(70, cam.dist * Math.exp(e.deltaY * 0.0012)));
    camGoal.dist = cam.dist;
    applyCamera();
    const after = groundAt(px, py);
    if (before && after) { cam.target.add(before.sub(after)); clampTarget(cam.target); camGoal.target.copy(cam.target); applyCamera(); }
    cam.follow = null;
  };
  const onDbl = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const hit = pickAt(e.clientX - r.left, e.clientY - r.top);
    if (hit?.target.kind === 'chefe-desk' && player) goTo(player, 'desk:-1' as PlaceKey);
    if (hit?.target.kind === 'worker') focusWorker(hit.target.id);
  };
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDbl);
  const onLeave = () => { pointer = null; };
  canvas.addEventListener('pointerleave', onLeave);

  function walkPlayer(to: Pt): void {
    if (!player) return;
    const p = player;
    const run = () => {
      const path = findPath(grid, { x: p.char.position.x, z: p.char.position.z }, to, occupiedFn(p));
      p.goal = null; p.at = null; p.busy = true;
      p.char.follow(path.map(q => new THREE.Vector2(q.x, q.z)), () => { p.busy = false; p.char.activity = 'stand'; });
      if (!path.length) p.busy = false;
    };
    if (p.seated) standUp(p, run); else run();
  }

  // ---------------- laço de desenho ----------------
  let raf = 0;
  let last = performance.now();
  let lastFrame = 0;
  let t = 0;
  const frameTimes: number[] = [];
  let destroyed = false;

  function tick(now: number): void {
    raf = 0;
    if (destroyed || opts.paused || document.hidden) return;
    raf = requestAnimationFrame(tick);
    const cap = opts.fpsCap ?? QUALITY[opts.quality].fps;
    if (cap > 0) {
      // cadência fixa: em tela de 60 Hz desenha todo quadro; em 85 ou 144 Hz pula o necessário para ficar no teto
      const interval = 1000 / cap;
      const since = now - lastFrame;
      if (since < interval - 1) return;
      lastFrame = since < interval * 2 ? now - (since % interval) : now;
    } else lastFrame = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t0 = performance.now();
    t += opts.reducedMotion ? dt * 0.35 : dt;
    for (const a of actors.values()) if (a.errand && a.errand.until <= performance.now()) { a.errand = undefined; dirtyPlans = true; }
    if (dirtyPlans) planAll();
    for (const a of actors.values()) { a.char.update(dt, t); if (!a.busy && !a.char.moving) syncActivity(a); }
    if (player) { player.char.update(dt, t); }
    // câmera: acompanha o funcionário escolhido ou anima até o enquadramento pedido
    if (cam.follow) {
      const a = actors.get(cam.follow);
      if (a) camGoal.target.set(a.char.position.x, a.seated ? 0.75 : 1.0, a.char.position.z);
    }
    const k = 1 - Math.exp(-dt * 6);
    if (!drag) { cam.target.lerp(camGoal.target, k); cam.dist += (camGoal.dist - cam.dist) * k; }
    applyCamera();
    // anel de seleção
    const sel = selected ? actors.get(selected) : null;
    ring.visible = !!sel;
    if (sel) { ring.position.x = sel.char.position.x; ring.position.z = sel.char.position.z; const s = 1 + Math.sin(t * 4) * 0.06; ring.scale.set(s, s, s); }
    renderer.render(scene, camera);
    layoutOverlay();
    // dica do que está sob o ponteiro (não a cada quadro: a cada 3)
    if (pointer && !drag && Math.floor(now / 50) % 2 === 0) {
      const h = opts.inputEnabled ? pickAt(pointer.x, pointer.y) : null;
      if (h?.label !== hovered?.label) { hovered = h; handlers.onHover?.(h?.label ?? null); }
      hoveredWorker = h?.target.kind === 'worker' ? h.target.id : null;
      canvas.style.cursor = h ? 'pointer' : '';
      if (h && h.target.kind !== 'worker') { hint.hidden = false; hint.textContent = h.label; hint.style.transform = `translate(${Math.round(pointer.x + 14)}px, ${Math.round(pointer.y + 16)}px)`; } else hint.hidden = true;
    } else if (!pointer) { hint.hidden = true; hoveredWorker = null; }
    frameTimes.push(performance.now() - t0);
    if (frameTimes.length > 120) frameTimes.shift();
    fpsWindow.push(now); while (fpsWindow.length && now - fpsWindow[0] > 1000) fpsWindow.shift();
  }
  const fpsWindow: number[] = [];
  function wake(): void { if (!raf && !destroyed && !opts.paused && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(tick); } }
  const onVis = () => wake();
  document.addEventListener('visibilitychange', onVis);

  const tmpV = new THREE.Vector3();
  function toScreen(x: number, y: number, z: number): { x: number; y: number; vis: boolean } {
    tmpV.set(x, y, z).project(camera);
    return { x: (tmpV.x + 1) / 2 * width, y: (1 - tmpV.y) / 2 * height, vis: tmpV.z < 1 && tmpV.x > -1.2 && tmpV.x < 1.2 && tmpV.y > -1.2 && tmpV.y < 1.3 };
  }
  /**
   * Rótulos sem sobreposição (08/11): de longe, só um ponto de status sobre cada pessoa; perto, o primeiro nome; com o
   * mouse em cima ou selecionada, nome completo, cargo e a tarefa. Balão de decisão ou erro sempre que couber. Nada cobre o
   * rosto de outra pessoa nem empilha em cima de outro rótulo: quem não cabe vira ponto (a pessoa escolhida sempre aparece).
   */
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const hit = (r: Box, list: Box[]) => list.some(o => r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0);
  function sizeOf(el: HTMLElement): { w: number; h: number } {
    const key = `${el.className}|${el.textContent}`;
    if (el.dataset.sizeKey !== key) { el.hidden = false; el.dataset.sizeKey = key; el.dataset.w = String(el.offsetWidth); el.dataset.h = String(el.offsetHeight); }
    return { w: Number(el.dataset.w) || 0, h: Number(el.dataset.h) || 0 };
  }
  function setTagMode(a: Actor, mode: 'dot' | 'name' | 'full'): void {
    if (a.tag.dataset.mode === mode && (mode !== 'full' || a.tag.dataset.full === a.worker?.role)) return;
    a.tag.dataset.mode = mode;
    a.tag.classList.toggle('st-tag--dot', mode === 'dot');
    const nm = a.tag.querySelector('.st-tag__name') as HTMLElement;
    const first = a.worker ? a.worker.name.split(' ')[0] : nm.dataset.first ?? nm.textContent ?? '';
    if (!nm.dataset.first) nm.dataset.first = first;
    nm.textContent = mode === 'full' && a.worker ? `${a.worker.name} · ${a.worker.role}` : nm.dataset.first || first;
    a.tag.dataset.full = mode === 'full' ? a.worker?.role ?? '' : '';
  }
  function layoutOverlay(): void {
    const near = cam.dist < 15;
    const all = player ? [...actors.values(), player] : [...actors.values()];
    // cabeças na tela (obstáculos para os rótulos dos outros)
    const heads = new Map<Actor, Box & { cx: number; top: number; vis: boolean }>();
    for (const a of all) {
      const sc = a.char.root.scale.y || 1;
      const hy = sc * (a.seated ? 1.12 : 1.5);
      const c = toScreen(a.char.position.x, hy, a.char.position.z);
      const t = toScreen(a.char.position.x, hy + sc * 0.22, a.char.position.z);
      const r = Math.max(6, Math.abs(c.y - t.y));
      heads.set(a, { x0: c.x - r * 0.85, y0: c.y - r, x1: c.x + r * 0.85, y1: c.y + r * 0.95, cx: c.x, top: c.y - r * 1.15, vis: c.vis });
    }
    const focusOf = (a: Actor) => a.id === selected || a.id === hoveredWorker;
    const rank = (a: Actor) => (focusOf(a) ? 0 : a.bubble.dataset.tone === 'wait' || a.bubble.dataset.tone === 'error' ? 1 : a === player ? 2 : 3);
    const order = [...all].sort((x, y) => rank(x) - rank(y));
    const placed: Box[] = [];
    for (const st of teams.values()) {
      const p = toScreen(st.sign.group.position.x, 2.05, st.sign.group.position.z);
      if (!p.vis || !opts.showLabels) { st.pill.hidden = true; continue; }
      const sz = sizeOf(st.pill);
      const tb: Box = { x0: p.x - sz.w / 2, y0: p.y - sz.h, x1: p.x + sz.w / 2, y1: p.y };
      st.pill.hidden = false;
      st.pill.style.transform = `translate(${Math.round(tb.x0)}px, ${Math.round(tb.y0)}px)`;
      placed.push(tb);
    }
    for (const a of order) {
      const h = heads.get(a)!;
      a.tag.classList.toggle('st-tag--selected', a.id === selected);
      if (!h.vis || !opts.showLabels) { a.tag.hidden = true; a.bubble.hidden = true; continue; }
      const others = [...heads].filter(([o]) => o !== a).map(([, b]) => b);
      const focus = focusOf(a);
      const tone = a.bubble.dataset.tone;
      // etiqueta: completa (foco), nome (perto) ou ponto
      let mode: 'dot' | 'name' | 'full' = focus ? 'full' : near || a === player ? 'name' : 'dot';
      setTagMode(a, mode);
      let sz = sizeOf(a.tag);
      let box: Box = { x0: h.cx - sz.w / 2, y0: h.top - sz.h, x1: h.cx + sz.w / 2, y1: h.top };
      if (!focus && mode !== 'dot' && (hit(box, placed) || hit(box, others))) { mode = 'dot'; setTagMode(a, mode); sz = sizeOf(a.tag); box = { x0: h.cx - sz.w / 2, y0: h.top - sz.h, x1: h.cx + sz.w / 2, y1: h.top }; }
      // ponto também não encosta em outro rótulo: tenta acima, um pouco à esquerda e à direita; sem lugar, some
      if (!focus && mode === 'dot' && hit(box, placed)) {
        const alt = [-1, 1].map(k => ({ x0: box.x0 + k * (sz.w + 3), y0: box.y0, x1: box.x1 + k * (sz.w + 3), y1: box.y1 })).find(r => !hit(r, placed));
        if (!alt) { a.tag.hidden = true; a.bubble.hidden = true; continue; }
        box = alt;
      }
      a.tag.hidden = false;
      a.tag.style.transform = `translate(${Math.round(box.x0)}px, ${Math.round(box.y0)}px)`;
      placed.push(box);
      // balão: decisão/erro sempre que couber; trabalho só de perto ou com foco
      const want = !!a.bubbleText && (focus || tone === 'wait' || tone === 'error' || (near && mode !== 'dot'));
      if (!want) { a.bubble.hidden = true; continue; }
      const bs = sizeOf(a.bubble);
      const bb: Box = { x0: h.cx - bs.w / 2, y0: box.y0 - 6 - bs.h, x1: h.cx + bs.w / 2, y1: box.y0 - 6 };
      if (!focus && (hit(bb, placed) || hit(bb, others))) { a.bubble.hidden = true; continue; }
      a.bubble.hidden = false;
      a.bubble.style.transform = `translate(${Math.round(bb.x0)}px, ${Math.round(bb.y0)}px)`;
      placed.push(bb);
    }
    // placas do chão por último: somem quando bateriam num rótulo de pessoa
    const headList = [...heads.values()];
    for (const z of zoneEls) {
      const p = toScreen(z.x, 0.02, z.z);
      if (!p.vis || !opts.showLabels) { z.el.hidden = true; continue; }
      z.el.classList.toggle('st-zone--far', !near);
      const sz = sizeOf(z.el);
      const zb: Box = { x0: p.x - sz.w / 2, y0: p.y - sz.h / 2, x1: p.x + sz.w / 2, y1: p.y + sz.h / 2 };
      if (hit(zb, placed) || hit(zb, headList)) { z.el.hidden = true; continue; }
      z.el.hidden = false;
      z.el.style.transform = `translate(${Math.round(zb.x0)}px, ${Math.round(zb.y0)}px)`;
      placed.push(zb);
    }
  }

  // ---------------- API ----------------
  function resize(): void {
    const host = canvas.parentElement ?? canvas;
    width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[opts.quality].pr));
    renderer.setSize(width, height, false);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    camera.aspect = width / height; camera.updateProjectionMatrix();
    applyCamera();
    if (autoFit && width > 50 && height > 50) { const f = fitView(framePoints(fitTarget), fitTarget === 'all' ? 18 : 28); camGoal.target.copy(f.target); camGoal.dist = fitTarget === 'all' ? f.dist : Math.max(7, f.dist); }
    wake();
  }
  function center(): void { frame('all'); }
  function framePoints(t: 'all' | ZoneId): THREE.Vector3[] {
    if (t === 'all') return fitPoints;
    const r = zoneRect(t);
    return [new THREE.Vector3(r.x0, 0, r.z0), new THREE.Vector3(r.x1, 0, r.z0), new THREE.Vector3(r.x0, 0, r.z1), new THREE.Vector3(r.x1, 0, r.z1), new THREE.Vector3(r.x0, 2.2, r.z0), new THREE.Vector3(r.x1, 2.2, r.z0)];
  }
  function frame(t: 'all' | ZoneId): void {
    fitTarget = t; autoFit = true; cam.follow = null;
    const f = fitView(framePoints(t), t === 'all' ? 18 : 28);
    camGoal.target.copy(f.target); camGoal.dist = t === 'all' ? f.dist : Math.max(7, f.dist);
    wake();
  }
  function focusWorker(id: string): void {
    const a = actors.get(id); if (!a) return;
    cam.follow = id; autoFit = false; camGoal.target.set(a.char.position.x, 1.0, a.char.position.z); camGoal.dist = Math.min(camGoal.dist, 13); wake();
  }
  function focusZone(id: ZoneId): void { frame(id); }

  resize();
  { const f = fitView(); cam.target.copy(f.target); cam.dist = f.dist; camGoal.target.copy(f.target); camGoal.dist = f.dist; applyCamera(); }
  wake();

  const studio: Studio = {
    setWorkers(list) {
      // primeira carga: todo mundo já está na mesa (sem desfile pela porta); quem chega depois entra pela recepção
      const initial = !initialized && list.length > 0;
      if (list.length) initialized = true;
      const seen = new Set<string>();
      const taken = new Set<number>();
      for (const w of list) if (w.deskIndex >= 0 && seatSpot(w.deskIndex)) taken.add(w.deskIndex);
      for (const w of list) {
        let a = actors.get(w.id);
        let desk = w.deskIndex >= 0 && seatSpot(w.deskIndex) ? w.deskIndex : -1;
        // sem assento: mesa livre (sem equipe, depois as de sessão externa); sem nenhuma livre, a pessoa não entra na cena
        // (ela continua na Gestão e no painel) em vez de sentar em cima de alguém
        if (desk < 0) {
          const free = DESKS.find(d => !taken.has(d.index) && (w.observed ? d.zone === 'dev' : d.zone === 'island')) ?? DESKS.find(d => !taken.has(d.index) && (d.zone === 'island' || d.zone === 'dev'));
          if (!free) continue;
          desk = free.index; taken.add(desk);
        }
        if (!a) {
          const look = lookFor(w.id, w.appearance, w.role);
          const fresh = initial;
          a = spawn(w.id, w.name.split(' ')[0], look, 'worker', fresh || opts.reducedMotion ? seatSpot(desk)!.approach : ENTRANCE);
          a.deskIndex = desk;
          actors.set(w.id, a);
          if (fresh || opts.reducedMotion) { a.goal = `desk:${desk}`; arrive(a, `desk:${desk}`, true); }
        }
        seen.add(w.id);
        if (a.deskIndex !== desk) { a.deskIndex = desk; }
        a.worker = w;
        a.tag.dataset.mode = ''; // nome ou cargo podem ter mudado: o próximo quadro redesenha a etiqueta
      }
      for (const a of [...actors.values()]) if (!a.manager && !seen.has(a.id)) removeActor(a);
      dirtyPlans = true; wake();
    },
    setMeeting(m, title) {
      meeting = m;
      world.meetingScreen.set(m?.active ? { kind: 'work', name: 'Reunião', text: title || 'reunião em andamento', tone: 'work' } : { kind: 'idle', name: 'Sala de reunião' });
      dirtyPlans = true; wake();
    },
    setBoard(c) {
      world.mural.set([
        { label: 'na fila', value: c.queued, color: '#9a93a3' },
        { label: 'produzindo', value: c.producing, color: '#7a62c9' },
        { label: 'em revisão', value: c.review, color: '#f4a28c' },
        { label: 'prontas', value: c.ready ?? 0, color: '#4f9e6a' },
        { label: 'esperando você', value: c.waiting ?? 0, color: '#f0a830' },
      ]);
      const desk = c.desk ?? 0;
      world.bossScreen.set(desk > 0 ? { kind: 'work', name: 'Sua mesa', text: `${desk} ${desk === 1 ? 'item espera' : 'itens esperam'} você`, tone: 'wait' } : { kind: 'idle', name: 'Sua mesa' });
      wake();
    },
    setSocials(items) { drawSocials(world.socialsPanel, items); wake(); },
    setStudioStatus(text) { world.studioScreen.set(text ? { kind: 'work', name: 'Estúdio', text, tone: 'work' } : { kind: 'idle', name: 'Estúdio' }); wake(); },
    setTeams(list) {
      let changed = false;
      for (const t of list) {
        const tt = TEAM_TABLES.find(x => x.id === t.id); if (!tt) continue;
        let st = teams.get(t.id);
        const seats = Math.max(2, t.seats);
        if (!st) {
          const sign = new TeamSign(t.label, t.channels, t.color);
          scene.add(sign.group);
          const pick = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 20), new THREE.MeshBasicMaterial({ visible: false }));
          scene.add(pick);
          // placa em DOM sobre a placa 3D: nome e canais legíveis em qualquer zoom (não só pela cor)
          const pill = document.createElement('div'); pill.className = `st-team st-team--${t.id}`; overlay.appendChild(pill);
          st = { def: t, seats: -1, group: null, screens: [], sign, pick, pill };
          teams.set(t.id, st);
        }
        st.def = t;
        if (st.seats !== seats) {
          if (st.group) { scene.remove(st.group); st.group.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose(); }); }
          const R = teamTableRadius(seats);
          const built = roundTeamTable(seats, R, t.color, t.rug);
          const holder = new THREE.Group(); holder.add(built.group);
          built.group.position.set(tt.x, 0, tt.z);
          // tudo que não muda vira poucas malhas; as telas continuam vivas (material próprio de cada uma)
          const merged = mergeByMaterial(holder);
          scene.add(merged);
          st.group = merged; st.screens = built.screens; st.seats = seats;
          st.pick.scale.set(R + 0.15, 1.3, R + 0.15); st.pick.position.set(tt.x, 0.65, tt.z);
          st.sign.group.position.set(tt.x, 0, tt.z - (R + 1.35));
          changed = true;
        }
        st.sign.set(t.summary);
        st.pill.innerHTML = '';
        const nm = document.createElement('strong'); nm.textContent = t.label;
        const ch = document.createElement('span'); ch.textContent = t.channels;
        st.pill.append(nm, ch);
      }
      if (changed) {
        grid = teamGrid();
        renderer.shadowMap.needsUpdate = true;
        // quem estava sentado numa mesa que mudou de tamanho vai para o assento novo
        for (const a of actors.values()) if (teamOfSeatIndex(a.deskIndex) && a.seated && !a.char.moving) { const s = seatSpot(a.deskIndex); if (s) a.char.place(s.seat.x, s.seat.z, s.seat.facing); }
        dirtyPlans = true;
      }
      wake();
    },
    frame,
    setPlayer(p) {
      if (player) return;
      const look = lookFor('chefe', p.appearance, 'chefe', { hairStyle: 'short', accessory: 'none', outer: '#3a2f3d', shirt: '#f0a830', height: 1.03 });
      const a = spawn('chefe', 'Chefe · Você', look, 'player', BOSS.attend);
      player = a;
      a.char.place(BOSS.seat.x, BOSS.seat.z, BOSS.seat.facing);
      a.seated = true; a.at = 'desk:-1' as PlaceKey; a.goal = a.at; a.activity = 'sit'; a.char.activity = 'sit';
      wake();
    },
    setSelected(id) {
      if (selected && actors.get(selected)) actors.get(selected)!.char.setHighlight(false);
      selected = id;
      if (id) actors.get(id)?.char.setHighlight(true);
      wake();
    },
    setOptions(o) {
      const prevQ = opts.quality;
      Object.assign(opts, o);
      if (o.insets) { /* o enquadramento manual do usuário é mantido; center() usa os insets novos */ }
      if (o.quality && o.quality !== prevQ) {
        const q = QUALITY[o.quality];
        renderer.shadowMap.enabled = q.shadow > 0; sun.castShadow = q.shadow > 0;
        if (q.shadow > 0) { sun.shadow.mapSize.set(q.shadow, q.shadow); sun.shadow.map?.dispose(); (sun.shadow as { map: THREE.WebGLRenderTarget | null }).map = null; }
        scene.traverse(x => { if (x instanceof THREE.Mesh && x.material instanceof THREE.Material) x.material.needsUpdate = true; });
        renderer.shadowMap.needsUpdate = true;
        for (const a of actors.values()) a.char.setOutline(q.outline);
        player?.char.setOutline(q.outline);
        resize();
      }
      if (o.reducedMotion !== undefined) dirtyPlans = true;
      wake();
    },
    center,
    zoomBy(dir) { autoFit = false; camGoal.dist = Math.max(4, Math.min(70, camGoal.dist * (dir > 0 ? 0.8 : 1.25))); wake(); },
    focusWorker,
    focusZone,
    screenPos(id) { const a = actors.get(id); if (!a) return null; const p = toScreen(a.char.position.x, a.seated ? 1.3 : 1.75, a.char.position.z); return p.vis ? { x: p.x, y: p.y } : null; },
    resize,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('pointerleave', onLeave);
      for (const a of [...actors.values()]) removeActor(a);
      if (player) { scene.remove(player.char.root); player.char.dispose(); player.tag.remove(); player.bubble.remove(); }
      for (const z of zoneEls) z.el.remove();
      hint.remove();
      world.dispose();
      disposeMaterials();
      renderer.dispose();
    },
    hoveredLabel() { return hovered?.label ?? null; },
    stats() {
      const info = renderer.info;
      const avg = frameTimes.length ? frameTimes.reduce((s, x) => s + x, 0) / frameTimes.length : 0;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return {
        fps: fpsWindow.length, frameMs: Math.round(avg * 100) / 100, calls: info.render.calls, triangles: info.render.triangles,
        geometries: info.memory.geometries, textures: info.memory.textures, heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
        quality: opts.quality, pixelRatio: renderer.getPixelRatio(), renderer: rendererName, characters: actors.size + (player ? 1 : 0),
        meshes: { before: world.stats.meshesBefore, after: world.stats.meshesAfter },
      };
    },
    errand(workerId, e) {
      if (errandKeys.has(e.key)) return;
      errandKeys.add(e.key);
      const a = actors.get(workerId);
      if (!a || a.manager) return;
      if (e.to !== 'boss' && (e.to.workerId === workerId || !actors.has(e.to.workerId))) return;
      a.errand = { to: e.to, text: e.text, until: performance.now() + (opts.reducedMotion ? Math.min(e.ms, 4000) : e.ms) };
      dirtyPlans = true; wake();
    },
    debugAct(id, place, activity) {
      const a = actors.get(id); if (!a) return;
      a.activity = activity;
      if (place === 'boss') { bossOrder = [id, ...bossOrder.filter(x => x !== id)]; a.bossSlot = 0; }
      goTo(a, place);
    },
  };
  return studio;
}
