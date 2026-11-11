// Personagem 3D estilizado (animação + anime), feito só com geometria em código: corpo arredondado, articulações
// (ombro, cotovelo, punho, quadril, joelho, tornozelo, pescoço), mãos, cabelo por estilo, rosto desenhado e contorno
// discreto. A animação é procedural: cada estado define a pose-alvo das juntas em função do tempo e o corpo chega lá
// por suavização (as transições ficam naturais sem tabela de animações).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Face, type Brows, type Eyes, type FaceState, type Mouth } from './face';
import { CEL_RAMP, blobShadowMaterial, toon } from './materials';
import { EYES, HAIR, PANTS, SHIRT, SKIN, hashOf, pick } from './palette';

export type HairStyle = 'short' | 'bob' | 'long' | 'ponytail' | 'bun' | 'curly' | 'quiff' | 'wavy';
export type Accessory = 'none' | 'glasses' | 'headphones' | 'badge';
export type Build = 'slim' | 'regular' | 'broad';

export interface CharacterLook {
  skin: string; hair: string; hairStyle: HairStyle; eye: string;
  shirt: string; pants: string; shoes: string; outer: string | null; sleeves: 'long' | 'short';
  build: Build; accessory: Accessory; lashes: 'soft' | 'bold'; height: number;
}

const HAIR_STYLES: HairStyle[] = ['short', 'bob', 'long', 'ponytail', 'bun', 'curly', 'quiff', 'wavy'];
const OUTERS = [null, '#f6efe6', '#c9b8e8', '#e8c9a0', null, '#9fd3cf', null, '#f5b8cf'];

/**
 * Aparência a partir do cadastro (índices de pele, cabelo e roupa) e do id: o estilo de cabelo, o corpo e os detalhes
 * variam pelo id, nunca pelo nome. O cargo só escolhe o acessório de trabalho (fone no vídeo, óculos na revisão).
 */
export function lookFor(id: string, appearance: { skin: number; hair: number; shirt: number }, role = '', extra: Partial<CharacterLook> = {}): CharacterLook {
  const h = hashOf(id);
  const r = role.toLowerCase();
  const accessory: Accessory = /v[íi]deo|edi[çc][ãa]o|motion/.test(r) ? 'headphones' : /revis|pesquis|an[áa]lise|desenvolv/.test(r) ? 'glasses' : (h >>> 9) % 5 === 0 ? 'badge' : 'none';
  return {
    skin: pick(SKIN, appearance.skin),
    hair: pick(HAIR, appearance.hair),
    hairStyle: HAIR_STYLES[(h >>> 3) % HAIR_STYLES.length],
    eye: pick(EYES, h >>> 5),
    shirt: pick(SHIRT, appearance.shirt),
    pants: pick(PANTS, h >>> 7),
    shoes: (h >>> 11) % 2 ? '#5a4a5f' : '#f6efe6',
    outer: OUTERS[(h >>> 13) % OUTERS.length],
    sleeves: (h >>> 15) % 3 === 0 ? 'short' : 'long',
    build: (['slim', 'regular', 'broad'] as Build[])[(h >>> 17) % 3],
    accessory,
    lashes: (h >>> 19) % 2 ? 'bold' : 'soft',
    height: 0.96 + ((h >>> 21) % 9) * 0.01,
    ...extra,
  };
}

// ---------------- medidas (metros, personagem de ~1,70 m) ----------------
// proporção de animação: cabeça grande (~5 cabeças de altura) para a expressão aparecer de longe
export const HIP_Y = 0.81;
const THIGH = 0.36, SHIN = 0.34, UPPER = 0.23, FORE = 0.21;
const HEAD_R = 0.165;
/** Altura do assento das cadeiras do estúdio (o quadril encaixa nele). */
export const SEAT_Y = 0.36;

export type Activity = 'stand' | 'walk' | 'sit' | 'type' | 'think' | 'talk' | 'listen' | 'present' | 'wait' | 'sitTalk' | 'sitListen' | 'celebrate';

type Rot = [number, number, number];
interface Pose {
  bodyY: number; bodyZ: number;
  hips: Rot; spine: Rot; neck: Rot; head: Rot;
  shL: Rot; elL: Rot; wrL: Rot; shR: Rot; elR: Rot; wrR: Rot;
  hipL: Rot; knL: Rot; anL: Rot; hipR: Rot; knR: Rot; anR: Rot;
}
type JointName = Exclude<keyof Pose, 'bodyY' | 'bodyZ'>;
const JOINTS: JointName[] = ['hips', 'spine', 'neck', 'head', 'shL', 'elL', 'wrL', 'shR', 'elR', 'wrR', 'hipL', 'knL', 'anL', 'hipR', 'knR', 'anR'];

function capsule(r: number, len: number, seg = 9): THREE.CapsuleGeometry {
  const g = new THREE.CapsuleGeometry(r, len, 3, seg);
  g.translate(0, -len / 2, 0); // topo da cápsula no centro da junta: articulação arredondada
  return g;
}

function lathe(points: [number, number][], depth: number, segs = 20, phiStart = 0, phiLength = Math.PI * 2): THREE.LatheGeometry {
  const g = new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segs, phiStart, phiLength);
  g.scale(1, 1, depth);
  g.computeVertexNormals();
  return g;
}

/** Queixo: estreita a parte de baixo da esfera da cabeça (mesma deformação no rosto). */
function chin(g: THREE.BufferGeometry, r: number): void {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < 0) {
      const k = Math.pow(-y / r, 1.6);
      p.setX(i, p.getX(i) * (1 - 0.24 * k));
      p.setZ(i, p.getZ(i) * (1 - 0.1 * k) + 0.012 * k * r * 4);
    }
    p.setY(i, y * 1.1);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
}

export class Character {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly look: CharacterLook;
  readonly pick: THREE.Mesh;
  private readonly j = {} as Record<JointName, THREE.Object3D>;
  private readonly face: Face;
  private readonly cur: Pose;
  private readonly phase: number;
  activity: Activity = 'stand';
  /** Ponto que a cabeça procura (mundo); null = olhar para frente. */
  lookTarget: THREE.Vector3 | null = null;
  mood: 'neutral' | 'happy' | 'focus' | 'worried' = 'neutral';
  speed = 1.25;
  private path: THREE.Vector2[] = [];
  private onArrive: (() => void) | null = null;
  private facing = 0;
  private targetFacing: number | null = null;
  private blinkAt = 0;
  private blinkUntil = 0;
  private walkT = 0;
  private settle: { from: THREE.Vector2; to: THREE.Vector2; t: number; dur: number; done?: () => void } | null = null;
  private outline: THREE.SkinnedMesh | null = null;
  private skinned: THREE.SkinnedMesh | null = null;
  private outlineUniforms = { uThickness: { value: 0.0085 }, uColor: { value: new THREE.Color('#4a3a4f') } };
  private shadow: THREE.Mesh;

  constructor(readonly id: string, look: CharacterLook, opts: { outline?: boolean } = {}) {
    this.look = look;
    this.phase = (hashOf(id) % 1000) / 1000 * Math.PI * 2;
    this.face = new Face({ eye: look.eye, brow: shadeHair(look.hair), lash: '#3a2a35', skin: look.skin, blush: 0.9, lashes: look.lashes });
    this.cur = restPose();
    this.build(opts.outline !== false);
    this.root.add(this.body);
    this.root.scale.setScalar(look.height);
    this.bake(opts.outline !== false);
    // sombra de contato
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.75), blobShadowMaterial());
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = 0.006; this.shadow.renderOrder = 1;
    this.root.add(this.shadow);
    // alvo de clique (invisível, mais gordo que o corpo: fácil de acertar)
    this.pick = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.75, 8), new THREE.MeshBasicMaterial({ visible: false }));
    this.pick.position.y = 0.88; this.pick.userData.characterId = id;
    this.root.add(this.pick);
    this.face.set({ eyes: 'open', brows: 'neutral', mouth: 'smile', lookX: 0, lookY: 0 });
  }

  /** Peça do corpo presa a uma junta. Tudo é fundido depois numa única malha com esqueleto (bake). */
  private part(parent: THREE.Object3D, geo: THREE.BufferGeometry, color: string, outline: boolean, pos?: [number, number, number]): THREE.Mesh {
    const m = new THREE.Mesh(geo, toon(color));
    if (pos) m.position.set(...pos);
    m.userData.ol = outline;
    parent.add(m);
    return m;
  }

  private build(outline: boolean): void {
    const L = this.look;
    const sw = L.build === 'slim' ? 0.165 : L.build === 'broad' ? 0.2 : 0.182;
    const hw = L.build === 'slim' ? 0.135 : L.build === 'broad' ? 0.15 : 0.142;
    const mk = (name: JointName, parent: THREE.Object3D, x = 0, y = 0, z = 0) => { const o = new THREE.Bone(); o.name = name; o.position.set(x, y, z); parent.add(o); this.j[name] = o; return o; };

    const hips = mk('hips', this.body, 0, HIP_Y, 0);
    // quadril (calça)
    this.part(hips, lathe([[0, -0.13], [hw * 0.62, -0.125], [hw, -0.07], [hw * 1.03, 0.0], [hw * 0.96, 0.07], [0, 0.07]], 0.74), L.pants, outline);
    const spine = mk('spine', hips, 0, 0.05, 0);
    // tronco (camisa)
    const torso: [number, number][] = [[0, -0.03], [hw * 0.95, -0.03], [hw * 0.84, 0.09], [hw * 0.8, 0.16], [sw * 0.86, 0.26], [sw * 0.98, 0.33], [sw, 0.37], [sw * 0.8, 0.41], [0.075, 0.44], [0, 0.446]];
    this.part(spine, lathe(torso, 0.66), L.shirt, outline);
    if (L.outer) {
      // casaco aberto na frente (lathe com abertura), um pouco maior que o tronco
      const open = lathe(torso.map(([x, y]) => [x * 1.07 + 0.004, y]), 0.7, 22, 0.55, Math.PI * 2 - 1.1);
      this.part(spine, open, L.outer, outline);
    }
    // gola
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.016, 8, 18), toon(L.outer ?? '#fbf8f4'));
    collar.rotation.x = Math.PI / 2; collar.scale.set(1, 0.8, 1); collar.position.set(0, 0.43, 0.004); spine.add(collar);
    if (L.accessory === 'badge') {
      const badge = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.08, 0.012, 2, 0.008), toon('#f0a830'));
      badge.position.set(0.0, 0.25, sw * 0.66 + 0.012); spine.add(badge);
    }
    // pescoço e cabeça
    const neck = mk('neck', spine, 0, 0.43, 0);
    this.part(neck, new THREE.CylinderGeometry(0.045, 0.05, 0.1, 12).translate(0, 0.04, 0), L.skin, false);
    const head = mk('head', neck, 0, 0.165, 0.012);
    const skull = new THREE.SphereGeometry(HEAD_R, 22, 16);
    chin(skull, HEAD_R);
    this.part(head, skull, L.skin, outline);
    // rosto: calota na frente da cabeça com a textura desenhada
    const span = 2.45, t0 = 0.87, tl = 1.31;
    const faceGeo = new THREE.SphereGeometry(HEAD_R * 1.004, 18, 14, Math.PI / 2 - span / 2 + Math.PI, span, t0, tl);
    faceGeo.rotateY(Math.PI);
    chin(faceGeo, HEAD_R * 1.004);
    const faceMat = new THREE.MeshToonMaterial({ map: this.face.texture, transparent: true, gradientMap: CEL_RAMP, depthWrite: false });
    faceMat.polygonOffset = true; faceMat.polygonOffsetFactor = -2;
    const faceMesh = new THREE.Mesh(faceGeo, faceMat);
    faceMesh.renderOrder = 2; faceMesh.userData.keep = true;
    head.add(faceMesh);
    // orelhas
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R * 0.26, 8, 6), toon(this.look.skin));
      ear.scale.set(0.55, 1, 0.75); ear.position.set(s * HEAD_R * 0.97, -0.01, -0.005); head.add(ear);
    }
    this.hair(head, outline);
    this.accessory(head);

    // braços
    for (const s of [1, -1] as const) {
      const sh = mk(s > 0 ? 'shL' : 'shR', spine, s * sw * 0.98, 0.37, -0.005);
      const sleeveColor = L.outer ?? L.shirt;
      this.part(sh, capsule(0.052, UPPER), sleeveColor, outline);
      const el = mk(s > 0 ? 'elL' : 'elR', sh, 0, -UPPER, 0);
      this.part(el, capsule(0.044, FORE), L.sleeves === 'long' || L.outer ? sleeveColor : L.skin, outline);
      const wr = mk(s > 0 ? 'wrL' : 'wrR', el, 0, -FORE, 0);
      // mão: palma arredondada + polegar
      const palm = new THREE.SphereGeometry(0.046, 9, 7); palm.scale(0.9, 1.2, 0.58); palm.translate(0, -0.05, 0);
      this.part(wr, palm, L.skin, outline);
      const thumb = capsule(0.014, 0.035, 8); thumb.rotateZ(s * 0.6); thumb.translate(s * 0.028, -0.025, 0.012);
      this.part(wr, thumb, L.skin, false);
    }
    // pernas
    for (const s of [1, -1] as const) {
      const hp = mk(s > 0 ? 'hipL' : 'hipR', hips, s * 0.082, -0.04, 0);
      this.part(hp, capsule(0.07, THIGH), L.pants, outline);
      const kn = mk(s > 0 ? 'knL' : 'knR', hp, 0, -THIGH, 0);
      this.part(kn, capsule(0.056, SHIN), L.pants, outline);
      const an = mk(s > 0 ? 'anL' : 'anR', kn, 0, -SHIN, 0);
      const shoe = new RoundedBoxGeometry(0.115, 0.08, 0.23, 2, 0.038); shoe.translate(0, -0.03, 0.05);
      this.part(an, shoe, L.shoes, outline);
    }
  }

  private hair(head: THREE.Object3D, outline: boolean): void {
    const L = this.look;
    const c = L.hair;
    const R = HEAD_R;
    const add = (geo: THREE.BufferGeometry, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1], ol = outline) => {
      const m = this.part(head, geo, c, ol, pos);
      m.rotation.set(...rot); m.scale.set(...scale);
      return m;
    };
    const style = L.hairStyle;
    // casca de anime: contorno em mechas pontudas (franja na frente, nuca atrás)
    const shells: Record<HairStyle, HairShape> = {
      short: { front: 1.1, side: 1.52, back: 1.95, locks: 16, lockLen: 0.2, volume: 0.06 },
      quiff: { front: 0.95, side: 1.45, back: 1.9, locks: 14, lockLen: 0.14, volume: 0.05 },
      bob: { front: 1.16, side: 2.05, back: 2.15, locks: 18, lockLen: 0.22, volume: 0.12 },
      long: { front: 1.18, side: 2.0, back: 2.3, locks: 18, lockLen: 0.25, volume: 0.1 },
      wavy: { front: 1.15, side: 2.0, back: 2.3, locks: 12, lockLen: 0.3, volume: 0.12 },
      ponytail: { front: 1.12, side: 1.72, back: 2.0, locks: 16, lockLen: 0.2, volume: 0.06 },
      bun: { front: 1.12, side: 1.72, back: 2.0, locks: 16, lockLen: 0.2, volume: 0.06 },
      curly: { front: 1.08, side: 1.7, back: 2.0, locks: 10, lockLen: 0.16, volume: 0.15 },
    };
    add(hairShell(R * 1.06, shells[style]), [0, 0.006, -0.004]);
    if (style === 'quiff') { add(new THREE.SphereGeometry(R * 0.7, 14, 10), [0, R * 0.95, R * 0.35], [0.4, 0, 0], [1.05, 0.55, 0.95]); }
    if (style === 'curly') {
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        add(new THREE.SphereGeometry(0.052, 9, 7), [Math.sin(a) * R * 0.95, R * 0.55 + Math.cos(a * 2) * 0.02, Math.cos(a) * R * 0.85 - 0.01]);
      }
      add(new THREE.SphereGeometry(0.06, 9, 7), [0, R * 1.05, 0.02]);
    }
    if (style === 'bob') {
      for (const s of [-1, 1]) add(new THREE.SphereGeometry(R * 0.6, 14, 10), [s * R * 0.8, -R * 0.2, -R * 0.12], [0, 0, s * 0.1], [0.62, 1.15, 1.05]);
      add(new THREE.SphereGeometry(R * 0.95, 14, 10), [0, -R * 0.15, -R * 0.38], [0, 0, 0], [1.05, 0.95, 0.7]);
    }
    if (style === 'long' || style === 'wavy') {
      add(capsule(R * 0.9, 0.2, 14), [0, 0.02, -R * 0.42], [0.1, 0, 0], [1, 1, 0.55]);
      for (const s of [-1, 1]) add(capsule(0.036, 0.17, 10), [s * R * 0.93, -0.02, 0.03], [0, 0, s * -0.08]);
      if (style === 'wavy') for (let i = 0; i < 4; i++) add(new THREE.SphereGeometry(0.05, 9, 7), [(i - 1.5) * 0.06, -0.24, -R * 0.42]);
    }
    if (style === 'ponytail') {
      add(new THREE.SphereGeometry(0.04, 9, 7), [0, 0.04, -R * 1.02]);
      add(capsule(0.042, 0.2, 10), [0, 0.05, -R * 1.1], [0.55, 0, 0]);
    }
    if (style === 'bun') add(new THREE.SphereGeometry(0.068, 9, 7), [0, R * 0.98, -R * 0.55]);
  }

  private accessory(head: THREE.Object3D): void {
    const L = this.look;
    if (L.accessory === 'glasses') {
      const mat = toon('#5a4a5f');
      for (const s of [-1, 1]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.027, 0.0045, 6, 20), mat);
        ring.position.set(s * 0.05, -0.002, HEAD_R * 1.02 + 0.006); ring.scale.set(1.1, 0.9, 1); head.add(ring);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 0.1), mat);
        arm.position.set(s * 0.083, 0.004, 0.075); arm.rotation.y = s * 0.12; head.add(arm);
      }
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.004, 0.004), mat);
      bridge.position.set(0, 0.006, HEAD_R * 1.03 + 0.006); head.add(bridge);
    } else if (L.accessory === 'headphones') {
      const mat = toon('#b9a3e3');
      const band = new THREE.Mesh(new THREE.TorusGeometry(HEAD_R * 1.16, 0.012, 8, 24, Math.PI), mat);
      band.position.set(0, 0.0, -0.01); band.scale.set(1, 1.08, 1); head.add(band);
      for (const s of [-1, 1]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.03, 16), toon('#7d6a9c'));
        cup.rotation.z = Math.PI / 2; cup.position.set(s * HEAD_R * 1.1, -0.01, -0.005); head.add(cup);
      }
    }
  }

  // ---------------- movimento ----------------
  get position(): THREE.Vector3 { return this.root.position; }
  get moving(): boolean { return this.path.length > 0 || this.settle !== null; }

  /** Coloca no lugar sem animação. */
  place(x: number, z: number, facing = this.facing): void {
    this.root.position.set(x, 0, z);
    this.facing = facing; this.targetFacing = null; this.root.rotation.y = facing;
    this.path = []; this.settle = null;
  }
  /** Segue o caminho (pontos no chão, x/z); `onArrive` roda ao chegar. */
  follow(path: THREE.Vector2[], onArrive?: () => void): void {
    this.path = path.slice();
    this.onArrive = onArrive ?? null;
    this.settle = null;
    if (this.path.length) this.activity = 'walk';
    else onArrive?.();
  }
  /** Gira para um ângulo (rad, 0 = +z). */
  turnTo(facing: number): void { this.targetFacing = facing; }
  /** Movimento curto e lento entre dois pontos (sentar/levantar), sem pose de caminhada. */
  slide(to: THREE.Vector2, dur: number, done?: () => void): void {
    this.settle = { from: new THREE.Vector2(this.root.position.x, this.root.position.z), to, t: 0, dur, done };
  }
  stop(): void { this.path = []; this.onArrive = null; }

  update(dt: number, t: number): void {
    // deslocamento
    if (this.settle) {
      const s = this.settle; s.t += dt;
      const k = Math.min(1, s.t / s.dur); const e = k * k * (3 - 2 * k);
      this.root.position.x = s.from.x + (s.to.x - s.from.x) * e;
      this.root.position.z = s.from.y + (s.to.y - s.from.y) * e;
      if (k >= 1) { this.settle = null; s.done?.(); }
    } else if (this.path.length) {
      const next = this.path[0];
      const dx = next.x - this.root.position.x, dz = next.y - this.root.position.z;
      const dist = Math.hypot(dx, dz);
      const step = this.speed * dt;
      if (dist <= step) {
        this.root.position.x = next.x; this.root.position.z = next.y; this.path.shift();
        if (!this.path.length) { this.activity = 'stand'; const cb = this.onArrive; this.onArrive = null; cb?.(); }
      } else {
        this.root.position.x += (dx / dist) * step; this.root.position.z += (dz / dist) * step;
        this.targetFacing = Math.atan2(dx, dz);
      }
      this.walkT += dt;
    }
    // giro suave
    if (this.targetFacing !== null) {
      let d = this.targetFacing - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const turn = Math.min(Math.abs(d), dt * 7);
      this.facing += Math.sign(d) * turn;
      if (Math.abs(d) < 0.01) this.targetFacing = null;
      this.root.rotation.y = this.facing;
    }
    // pose
    const target = this.poseFor(this.activity, t + this.phase);
    this.headLook(target);
    const k = 1 - Math.exp(-dt * (this.activity === 'walk' ? 16 : 9));
    this.cur.bodyY += (target.bodyY - this.cur.bodyY) * k;
    this.cur.bodyZ += (target.bodyZ - this.cur.bodyZ) * k;
    for (const n of JOINTS) {
      const a = this.cur[n], b = target[n];
      a[0] += (b[0] - a[0]) * k; a[1] += (b[1] - a[1]) * k; a[2] += (b[2] - a[2]) * k;
      this.j[n].rotation.set(a[0], a[1], a[2]);
    }
    this.body.position.y = this.cur.bodyY;
    this.body.position.z = this.cur.bodyZ;
    this.shadow.visible = this.cur.bodyY > -0.2; // sentado: a cadeira já tem sombra
    this.updateFace(t);
  }

  private headLook(p: Pose): void {
    if (!this.lookTarget) return;
    const dx = this.lookTarget.x - this.root.position.x, dz = this.lookTarget.z - this.root.position.z;
    let a = Math.atan2(dx, dz) - this.facing;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    const yaw = Math.max(-1.0, Math.min(1.0, a));
    p.neck[1] += yaw * 0.45; p.head[1] += yaw * 0.55;
    if (Math.abs(a) > 1.0) p.spine[1] += Math.sign(a) * Math.min(0.35, Math.abs(a) - 1.0);
  }

  private updateFace(t: number): void {
    const now = t;
    if (now > this.blinkAt) { this.blinkUntil = now + 0.12; this.blinkAt = now + 2.4 + ((hashOf(this.id + Math.floor(now)) % 100) / 100) * 3.2; }
    const talking = this.activity === 'talk' || this.activity === 'sitTalk' || this.activity === 'present';
    let mouth: Mouth = this.mood === 'happy' ? 'smile' : this.mood === 'worried' ? 'flat' : this.mood === 'focus' ? 'neutral' : 'smile';
    if (talking) { const m: Mouth[] = ['open1', 'neutral', 'open2', 'o', 'open1', 'smile']; mouth = m[Math.floor(now * 9 + this.phase) % m.length]; }
    let eyes: Eyes = now < this.blinkUntil ? 'closed' : this.mood === 'happy' && this.activity === 'celebrate' ? 'happy' : this.mood === 'focus' && (this.activity === 'type') ? 'half' : 'open';
    const brows: Brows = this.mood === 'worried' ? 'worried' : this.mood === 'focus' ? 'focus' : talking && Math.sin(now * 1.7) > 0.6 ? 'raised' : 'neutral';
    if (this.activity === 'type' && now >= this.blinkUntil) eyes = Math.sin(now * 0.3 + this.phase) > 0.85 ? 'open' : 'half';
    const lookY = this.activity === 'type' ? 0.6 : this.activity === 'think' ? -0.6 : 0;
    const lookX = this.activity === 'think' ? 0.7 : 0;
    const st: FaceState = { eyes, brows, mouth, lookX, lookY };
    this.face.set(st);
  }

  private poseFor(a: Activity, t: number): Pose {
    const p = restPose();
    const breathe = Math.sin(t * 1.7) * 0.018;
    const seated = a === 'sit' || a === 'type' || a === 'think' || a === 'sitTalk' || a === 'sitListen';
    if (seated) {
      p.bodyY = SEAT_Y + 0.068 - (HIP_Y - 0.04);
      p.hipL = [-1.57, 0.06, 0]; p.hipR = [-1.57, -0.06, 0];
      p.knL = [1.57, 0, 0]; p.knR = [1.57, 0, 0];
      p.spine = [-0.04 + breathe, 0, 0];
      p.shL = [-0.42, 0, -0.06]; p.shR = [-0.42, 0, 0.06];
      p.elL = [-0.75, 0, 0]; p.elR = [-0.75, 0, 0];
    }
    switch (a) {
      case 'stand':
        p.spine = [breathe, 0, 0];
        p.hips = [0, 0, Math.sin(t * 0.5) * 0.025];
        p.shL = [0.02, 0, 0.08]; p.shR = [0.02, 0, -0.08];
        p.elL = [-0.15, 0, 0]; p.elR = [-0.15, 0, 0];
        p.neck = [Math.sin(t * 0.37) * 0.03, Math.sin(t * 0.23) * 0.12, 0];
        break;
      case 'walk': {
        const w = this.walkT * Math.PI * 2 * 1.05;
        const s = Math.sin(w), c = Math.cos(w);
        p.hipL = [-0.44 * s, 0, 0.02]; p.hipR = [0.44 * s, 0, -0.02];
        p.knL = [0.1 + 0.8 * Math.max(0, c), 0, 0]; p.knR = [0.1 + 0.8 * Math.max(0, -c), 0, 0];
        p.anL = [0.25 * s - 0.05, 0, 0]; p.anR = [-0.25 * s - 0.05, 0, 0];
        p.shL = [0.38 * s, 0, 0.1]; p.shR = [-0.38 * s, 0, -0.1];
        p.elL = [-0.3 - 0.15 * Math.max(0, -s), 0, 0]; p.elR = [-0.3 - 0.15 * Math.max(0, s), 0, 0];
        p.hips = [0, 0.09 * s, 0]; p.spine = [0.05, -0.12 * s, 0];
        p.bodyY = 0.028 * Math.abs(Math.sin(w)) - 0.012;
        break;
      }
      case 'sit':
        p.neck = [0.02, Math.sin(t * 0.21) * 0.15, 0];
        break;
      case 'type': {
        p.spine = [0.13 + breathe * 0.5, 0, 0];
        p.shL = [-0.55, 0.12, -0.16]; p.shR = [-0.55, -0.12, 0.16];
        const tl = Math.sin(t * 15) * 0.05, tr = Math.sin(t * 13 + 1.3) * 0.05;
        p.elL = [-1.2 + tl, 0, 0]; p.elR = [-1.2 + tr, 0, 0];
        p.wrL = [0.25 + Math.sin(t * 19) * 0.12, 0, 0.1]; p.wrR = [0.25 + Math.sin(t * 17 + 2) * 0.12, 0, -0.1];
        p.neck = [0.1, 0, 0]; p.head = [0.04 + Math.sin(t * 0.8) * 0.02, Math.sin(t * 0.5) * 0.05, 0];
        break;
      }
      case 'think':
        p.spine = [0.06, 0, 0];
        p.shR = [-0.95, -0.15, 0.25]; p.elR = [-2.15, 0, 0]; p.wrR = [0.4, 0, 0];
        p.shL = [-0.5, 0.1, -0.15]; p.elL = [-1.1, 0, 0];
        p.neck = [0.05, 0, 0.08]; p.head = [-0.08, 0.15, 0.05];
        break;
      case 'talk': case 'sitTalk': {
        if (a === 'talk') { p.spine = [breathe, 0, 0]; p.shL = [0.02, 0, 0.08]; p.elL = [-0.2, 0, 0]; }
        p.shR = [-0.5 + Math.sin(t * 2.3) * 0.15, 0, -0.28]; p.elR = [-1.15 + Math.sin(t * 3.1) * 0.25, 0, 0];
        p.wrR = [0, Math.sin(t * 2.7) * 0.4, 0];
        if (Math.sin(t * 0.9) > 0.2) { p.shL = [-0.45 + Math.sin(t * 2.9) * 0.12, 0, 0.25]; p.elL = [-1.0, 0, 0]; }
        p.neck = [0.05 * Math.sin(t * 3), 0, 0.04 * Math.sin(t * 1.3)];
        break;
      }
      case 'listen': case 'sitListen': {
        if (a === 'listen') { p.spine = [breathe, 0, 0]; p.shL = [-0.3, 0, -0.18]; p.shR = [-0.3, 0, 0.18]; p.elL = [-0.95, 0, 0]; p.elR = [-0.95, 0, 0]; }
        const nod = Math.pow(Math.max(0, Math.sin(t * 1.3)), 6) * 0.14;
        p.neck = [nod, 0, 0.11]; p.head = [0, 0, 0.05];
        break;
      }
      case 'present':
        p.spine = [0.03 + breathe, 0, 0];
        p.shR = [-1.1 + Math.sin(t * 1.6) * 0.08, 0, -0.32]; p.elR = [-0.35, 0, 0]; p.wrR = [-0.2, 0.6, 0];
        p.shL = [-0.65, 0.1, -0.12]; p.elL = [-1.4, 0, 0]; p.wrL = [0.2, 0, 0];
        p.neck = [0.04 * Math.sin(t * 2.6), 0, 0];
        break;
      case 'wait':
        p.spine = [breathe, 0, 0];
        p.hips = [0, 0, Math.sin(t * 0.6) * 0.04];
        p.shL = [-0.32, 0, -0.2]; p.shR = [-0.32, 0, 0.2]; p.elL = [-0.9, 0, 0]; p.elR = [-0.9, 0, 0];
        p.neck = [0, Math.sin(t * 0.4) * 0.25, 0];
        break;
      case 'celebrate':
        p.spine = [-0.05, 0, 0];
        p.shL = [-2.6, 0, 0.3]; p.shR = [-2.6 + Math.sin(t * 6) * 0.15, 0, -0.3]; p.elL = [-0.3, 0, 0]; p.elR = [-0.3, 0, 0];
        p.bodyY = Math.abs(Math.sin(t * 6)) * 0.05;
        break;
    }
    return p;
  }

  setOutline(on: boolean): void { if (this.outline) this.outline.visible = on; }
  setHighlight(on: boolean): void {
    this.outlineUniforms.uThickness.value = on ? 0.017 : 0.0085;
    this.outlineUniforms.uColor.value.set(on ? '#f0a830' : '#4a3a4f');
  }

  /**
   * Funde as peças numa SkinnedMesh (cada vértice preso 100% à sua junta) e numa casca de contorno com o mesmo
   * esqueleto: ~4 chamadas de desenho por personagem em vez de ~60.
   */
  private bake(withOutline: boolean): void {
    this.root.updateMatrixWorld(true);
    const inv = this.body.matrixWorld.clone().invert();
    const bones = JOINTS.map(n => this.j[n] as THREE.Bone);
    const index = new Map<THREE.Object3D, number>(bones.map((b, i) => [b, i]));
    const meshes: THREE.Mesh[] = [];
    this.body.traverse(o => { if (o instanceof THREE.Mesh && !o.userData.keep) meshes.push(o); });
    const all: THREE.BufferGeometry[] = [];
    const lines: THREE.BufferGeometry[] = [];
    const tmp = new THREE.Matrix4();
    for (const m of meshes) {
      let b: THREE.Object3D | null = m.parent;
      while (b && !index.has(b)) b = b.parent;
      const bi = b ? index.get(b)! : 0;
      const g = withIndex(m.geometry.clone()); // vértices compartilhados: ~3× menos trabalho de vértice que triângulos soltos
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      g.applyMatrix4(tmp.multiplyMatrices(inv, m.matrixWorld));
      const n = g.attributes.position.count;
      const col = (m.material as THREE.MeshToonMaterial).color ?? new THREE.Color('#ffffff');
      const colors = new Float32Array(n * 3);
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b; si[i * 4] = bi; sw[i * 4] = 1; }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
      all.push(g);
      if (m.userData.ol) lines.push(g);
      m.removeFromParent();
      m.geometry.dispose();
    }
    // pivôs vazios (franja) também saem
    const empties: THREE.Object3D[] = [];
    this.body.traverse(o => { if (!(o instanceof THREE.Bone) && !(o instanceof THREE.Mesh) && o !== this.body && o.children.length === 0) empties.push(o); });
    for (const e of empties) e.removeFromParent();
    const skeleton = new THREE.Skeleton(bones);
    const geo = mergeGeometries(all, false)!;
    const mesh = new THREE.SkinnedMesh(geo, characterMaterial());
    mesh.frustumCulled = false;
    this.body.add(mesh);
    mesh.updateMatrixWorld(true);
    mesh.bind(skeleton);
    this.skinned = mesh;
    if (withOutline && lines.length) {
      const lg = mergeGeometries(lines, false)!;
      const om = new THREE.SkinnedMesh(lg, skinnedOutline(this.outlineUniforms));
      om.frustumCulled = false;
      this.body.add(om);
      om.updateMatrixWorld(true);
      om.bind(skeleton, mesh.matrixWorld);
      this.outline = om;
    }
    for (const g of all) g.dispose();
  }

  dispose(): void {
    this.root.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    (this.outline?.material as THREE.Material | undefined)?.dispose();
    this.face.dispose();
  }
}

/** Garante índice (geometria sem índice ganha 0..n-1) para fundir mantendo os vértices compartilhados. */
export function withIndex(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.index) { const n = g.attributes.position.count; const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
  return g;
}

let charMat: THREE.MeshToonMaterial | null = null;
/** Um material para todos os corpos: a cor vem de cada vértice (pele, roupa, cabelo). */
export function characterMaterial(): THREE.MeshToonMaterial {
  if (!charMat) charMat = new THREE.MeshToonMaterial({ color: '#ffffff', vertexColors: true, gradientMap: CEL_RAMP, side: THREE.DoubleSide });
  return charMat;
}

/** Contorno com esqueleto: infla o vértice pela normal antes do skinning e desenha só o lado de trás. */
function skinnedOutline(uniforms: { uThickness: { value: number }; uColor: { value: THREE.Color } }): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: '#4a3a4f', side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uThickness = uniforms.uThickness;
    sh.uniforms.uColor = uniforms.uColor;
    sh.vertexShader = 'uniform float uThickness;\n' + sh.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = vec3( position ) + normal * uThickness;');
    sh.fragmentShader = 'uniform vec3 uColor;\n' + sh.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( uColor, opacity );');
  };
  m.customProgramCacheKey = () => 'aurora-outline-skinned';
  return m;
}

export interface HairShape { front: number; side: number; back: number; locks: number; lockLen: number; volume: number }

/**
 * Cabelo em casca única: calota cujo contorno desce em mechas pontudas. `front`, `side` e `back` são o ângulo (rad, a
 * partir do topo) da borda na testa, nas orelhas e na nuca; `locks` mechas por volta, `lockLen` quanto cada ponta desce.
 */
export function hairShell(R: number, o: HairShape): THREE.BufferGeometry {
  const NP = 64, NV = 10;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= NP; i++) {
    const phi = Math.PI + (i / NP) * Math.PI * 2; // costura atrás; 0 (≡ 2π) = frente (+z)
    const c = Math.cos(phi);
    let edge = c > 0 ? o.side + (o.front - o.side) * c : o.side + (o.back - o.side) * -c;
    const ph = (((phi / (Math.PI * 2)) * o.locks + 0.5) % 1 + 1) % 1;
    const tooth = Math.pow(1 - Math.abs(2 * ph - 1), 1.6);
    edge += o.lockLen * tooth * (0.55 + 0.45 * Math.max(0, c));
    for (let j = 0; j <= NV; j++) {
      const v = j / NV;
      const theta = v * edge;
      const r = R * (1 + o.volume * Math.sin(v * Math.PI * 0.85)) * (1 - 0.05 * Math.pow(v, 5));
      pos.push(Math.sin(theta) * Math.sin(phi) * r, Math.cos(theta) * r * 1.1, Math.sin(theta) * Math.cos(phi) * r);
    }
  }
  for (let i = 0; i < NP; i++) for (let j = 0; j < NV; j++) {
    const a = i * (NV + 1) + j, b = (i + 1) * (NV + 1) + j;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function restPose(): Pose {
  const z = (): Rot => [0, 0, 0];
  return { bodyY: 0, bodyZ: 0, hips: z(), spine: z(), neck: z(), head: z(), shL: z(), elL: z(), wrL: z(), shR: z(), elR: z(), wrR: z(), hipL: z(), knL: z(), anL: z(), hipR: z(), knR: z(), anR: z() };
}

function shadeHair(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(c * 0.72);
  return `#${((1 << 24) | (f((n >> 16) & 255) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255)).toString(16).slice(1)}`;
}
