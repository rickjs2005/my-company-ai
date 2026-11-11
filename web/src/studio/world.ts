// Monta o cenário estático do estúdio e devolve as partes vivas (telas, mural, alvos de clique).
// O que não muda é fundido por material no fim (poucas chamadas de desenho no notebook).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { IsoTarget } from '../scene/iso/socialRoom';
import { basic, lightPoolTexture } from './materials';
import { withIndex } from './character';
import { STUDIO as C } from './palette';
import {
  ARCHIVE, BOSS, D, DESKS, LOUNGE, MEETING, MURAL, RECEPTION, SOCIALS, STUDIO_SET, W, WALL_H, ZONES,
} from './layout';
import {
  Mural, Screen, bossDesk, cabinet, coffeeBar, coffeeTable, floorSlab, glassWall, lightShaft, logoSign, meetingTable,
  plant, receptionDesk, rug, shelf, sofa, stool, videoSet, wall, wallScreen, workstation, CanvasPanel, roundRect,
} from './props';

export interface Pickable { mesh: THREE.Object3D; target: IsoTarget; label: string }

export interface World {
  root: THREE.Group;
  deskScreens: Map<number, Screen[]>;
  bossScreen: Screen;
  studioScreen: Screen;
  meetingScreen: Screen;
  socialsPanel: CanvasPanel;
  mural: Mural;
  picks: Pickable[];
  zoneLabels: { id: string; label: string; x: number; z: number }[];
  stats: { meshesBefore: number; meshesAfter: number };
  dispose(): void;
}

const FONT = '"Nunito Variable", "Nunito", "Segoe UI", system-ui, sans-serif';

function pickBox(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false }));
  m.position.set(x, y, z); m.rotation.y = ry;
  return m;
}

export function buildWorld(): World {
  const root = new THREE.Group();
  const staticG = new THREE.Group(); // será fundido
  const live = new THREE.Group();    // telas, vidro, textos: ficam separados
  root.add(staticG, live);
  const picks: Pickable[] = [];
  const deskScreens = new Map<number, Screen[]>();

  // piso, laje e paredes de fundo
  staticG.add(floorSlab(W, D)); // piso tem textura própria: não entra na fusão
  const north = wall(W, WALL_H, 'x', [{ at: 2.0, w: 2.0, h: 1.5, y: 1.0 }, { at: 15.6, w: 2.2, h: 1.5, y: 1.0 }, { at: 18.6, w: 2.2, h: 1.5, y: 1.0 }]);
  north.position.set(0, 0, -0.09);
  staticG.add(north);
  const west = wall(D, WALL_H, 'z', [{ at: 10.0, w: 1.6, h: 1.5, y: 1.0 }]);
  // a parede oeste corre ao longo de z; o grupo girado aponta o comprimento para -z, então ela começa em z = D
  west.rotation.y = Math.PI / 2; west.position.set(-0.09, 0, D);
  staticG.add(west);
  // faixa de cor nas paredes (rosa no estúdio, lavanda na reunião)
  const tint = (x0: number, x1: number, color: string) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, WALL_H - 0.2), basic(color, { opacity: 0.55 })); m.position.set((x0 + x1) / 2, (WALL_H - 0.2) / 2 + 0.12, 0.005); live.add(m); };
  tint(6.9, 13.3, '#f7d6e6');
  tint(0.1, 0.95, '#e7dcf6'); tint(3.0, 6.1, '#e7dcf6');
  // luz das janelas
  for (const x of [2.0, 15.6, 18.6]) { const s = lightShaft(2.0, 3.4); s.position.set(x, 0, 0.1); live.add(s); }
  { const s = lightShaft(1.6, 3.0); s.rotation.y = Math.PI / 2; s.position.set(0.1, 0, D - 10.0); live.add(s); }

  // tapetes das áreas
  // (as duas equipes têm tapete redondo próprio, montado com a mesa delas)
  const r3 = rug(4.4, 2.4, '#eadff6', C.fabric); r3.position.set(MEETING.x, 0, MEETING.z); staticG.add(r3);
  const r4 = rug(3.8, 2.8, '#fff2df', C.fabricCoral); r4.position.set(16.6, 0, 12.2); staticG.add(r4);
  const r5 = rug(3.2, 2.8, '#fbe7c6', C.amber); r5.position.set(BOSS.x, 0, BOSS.z); r5.rotation.y = BOSS.ry; staticG.add(r5);

  // ---------------- sala de reunião ----------------
  const mt = meetingTable(MEETING.seats); mt.group.position.set(MEETING.x, 0, MEETING.z); staticG.add(mt.group);
  const glassE = glassWall(4.7, 2.3, { at: 3.9, w: 1.0 }); glassE.rotation.y = -Math.PI / 2; glassE.position.set(6.22, 0, 0.3); staticG.add(glassE);
  const glassS = glassWall(5.9, 2.3, { at: 4.9, w: 1.0 }); glassS.position.set(0.3, 0, 5.0); staticG.add(glassS);
  const ws = wallScreen(2.0, 1.1); ws.group.position.set(MEETING.screen.x + 0.4, 1.75, 0.05); staticG.add(ws.group);
  const pm = plant(1.2); pm.position.set(0.75, 0, 4.4); staticG.add(pm);
  picks.push({ mesh: pickBox(3.8, 1.2, 2.4, MEETING.x, 0.6, MEETING.z), target: { kind: 'meeting-table' }, label: 'Sala de reunião' });
  picks.push({ mesh: pickBox(2.1, 1.2, 0.3, MEETING.screen.x + 0.4, 1.75, 0.2), target: { kind: 'meeting-table' }, label: 'Tela da reunião' });

  // ---------------- estúdio de vídeo ----------------
  const vs = videoSet(); vs.group.position.set(STUDIO_SET.x, 0, STUDIO_SET.z); staticG.add(vs.group);
  const sp = plant(1.0); sp.position.set(7.3, 0, 0.75); staticG.add(sp);
  picks.push({ mesh: pickBox(4.4, 2.6, 3.4, STUDIO_SET.x, 1.3, STUDIO_SET.z + 0.8), target: { kind: 'studio' }, label: 'Estúdio: edição e render' });

  // ---------------- estações de trabalho ----------------
  const accents = [C.fabricPink, C.fabric, C.fabricTeal, C.fabricCoral];
  for (const d of DESKS) {
    const parts = workstation({ monitors: d.monitors, seed: d.index, accent: d.index % 3 === 0 ? accents[d.index % 4] : undefined, chairColor: d.zone === 'dev' ? '#8fb8f0' : d.zone === 'studio' ? '#f5b8cf' : accents[(d.index + 1) % 4] });
    parts.group.position.set(d.x, 0, d.z); parts.group.rotation.y = d.ry;
    // telas e cadeira ficam vivas; o resto do móvel entra na fusão
    for (const s of parts.screens) { s.mesh.userData.keep = true; }
    staticG.add(parts.group);
    deskScreens.set(d.index, parts.screens);
    picks.push({ mesh: pickBox(1.5, 1.2, 1.5, d.x, 0.6, d.z, d.ry), target: { kind: 'desk', deskIndex: d.index, workerId: null }, label: d.label });
  }
  // mesa do Chefe
  const bd = bossDesk(); bd.group.position.set(BOSS.x, 0, BOSS.z); bd.group.rotation.y = BOSS.ry;
  bd.screens[0].mesh.userData.keep = true;
  staticG.add(bd.group);
  picks.push({ mesh: pickBox(2.2, 1.3, 1.9, BOSS.x, 0.65, BOSS.z, BOSS.ry), target: { kind: 'chefe-desk' }, label: 'Mesa do Chefe: decisões, entregas e bloqueios' });
  const bp = plant(1.3); bp.position.set(20.9, 0, 6.0); staticG.add(bp);

  // ---------------- desenvolvimento ----------------
  const ds = shelf(2.2, 2.1); ds.position.set(20.4, 0, 0.5); staticG.add(ds);
  const dp = plant(1.1); dp.position.set(14.5, 0, 0.8); staticG.add(dp);

  // ---------------- mural, arquivo e redes (parede oeste) ----------------
  const mural = new Mural(2.4, 1.25); mural.group.rotation.y = Math.PI / 2; mural.group.position.set(MURAL.x, 0, MURAL.z); staticG.add(mural.group);
  picks.push({ mesh: pickBox(0.4, 1.5, 2.6, MURAL.x + 0.2, 1.55, MURAL.z), target: { kind: 'board' }, label: 'Mural: tarefas e referências' });
  const arch = cabinet(1.3, 1.05); arch.rotation.y = Math.PI / 2; arch.position.set(ARCHIVE.x, 0, ARCHIVE.z); staticG.add(arch);
  const arch2 = cabinet(0.9, 0.72, C.woodLight); arch2.rotation.y = Math.PI / 2; arch2.position.set(ARCHIVE.x, 0, ARCHIVE.z - 1.25); staticG.add(arch2);
  picks.push({ mesh: pickBox(0.8, 1.2, 2.4, ARCHIVE.x + 0.15, 0.6, ARCHIVE.z - 0.5), target: { kind: 'media-cabinet' }, label: 'Arquivo: entregas e arquivos' });
  const socialsPanel = new CanvasPanel(512, 320);
  const sm = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.69), new THREE.MeshBasicMaterial({ map: socialsPanel.texture, toneMapped: false }));
  sm.rotation.y = Math.PI / 2; sm.position.set(SOCIALS.x + 0.02, 1.55, SOCIALS.z); staticG.add(sm);
  const smf = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.77, 1.18), new THREE.MeshToonMaterial({ color: '#3f3846' })); smf.position.set(SOCIALS.x - 0.01, 1.55, SOCIALS.z); staticG.add(smf);
  picks.push({ mesh: pickBox(0.4, 0.9, 1.3, SOCIALS.x + 0.2, 1.55, SOCIALS.z), target: { kind: 'socials' }, label: 'Painel das redes' });

  // ---------------- recepção e entrada ----------------
  const rd = receptionDesk(); rd.rotation.y = Math.PI / 2; rd.position.set(RECEPTION.x, 0, RECEPTION.z); staticG.add(rd);
  const logo = logoSign(2.2); logo.rotation.y = Math.PI / 2; logo.position.set(0.05, 2.15, 12.0); staticG.add(logo);
  const door = new THREE.Group();
  const dframe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.3, 1.25), new THREE.MeshToonMaterial({ color: '#ffffff' })); dframe.position.set(0.02, 1.15, 13.15); door.add(dframe);
  const dpanel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.1, 1.0), new THREE.MeshToonMaterial({ color: C.woodLight })); dpanel.position.set(0.1, 1.05, 13.15); door.add(dpanel);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), new THREE.MeshToonMaterial({ color: C.amberDeep })); knob.position.set(0.16, 1.0, 12.8); door.add(knob);
  staticG.add(door);
  picks.push({ mesh: pickBox(0.4, 2.2, 1.2, 0.2, 1.1, 13.15), target: { kind: 'door' }, label: 'Porta: ir para outra área' });
  const mat = rug(1.2, 1.4, '#f6e2c8', C.amber); mat.position.set(0.9, 0, 13.0); staticG.add(mat);
  const rp = plant(1.15); rp.position.set(0.7, 0, 10.6); staticG.add(rp);
  for (const [x, z] of [[3.9, 13.3], [13.3, 13.3]]) { const p = plant(1.0); p.position.set(x, 0, z); staticG.add(p); }

  // ---------------- café ----------------
  const sf = sofa(C.fabric); sf.position.set(LOUNGE.sofa.x, 0, LOUNGE.sofa.z); staticG.add(sf);
  const ct = coffeeTable(); ct.position.set(LOUNGE.table.x, 0, LOUNGE.table.z); staticG.add(ct);
  const cb = coffeeBar(); cb.position.set(LOUNGE.bar.x, 0, LOUNGE.bar.z); cb.rotation.y = Math.PI; staticG.add(cb);
  for (let i = 0; i < 3; i++) { const s = stool([C.amber, C.fabricPink, C.fabricTeal][i]); s.position.set(LOUNGE.bar.x - 0.7 + i * 0.7, 0, LOUNGE.bar.z - 0.75); staticG.add(s); }
  const lp = plant(1.25); lp.position.set(21.2, 0, 11.4); staticG.add(lp);

  // ---------------- luminárias pendentes e poças de luz ----------------
  for (const [x, z, c] of [[6.2, 7.45, C.amber], [11.6, 7.45, C.fabric], [8.8, 10.9, C.fabric], [16.4, 12.0, C.fabricCoral], [16.4, 2.9, '#8fb8f0']] as const) {
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshBasicMaterial({ map: lightPoolTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    pool.rotation.x = -Math.PI / 2; pool.position.set(x, 0.015, z); live.add(pool);
  }

  // placas das áreas (texto em DOM, nítido; aqui só as posições)
  const zoneLabels = ZONES.map(z => ({ id: z.id, label: z.label, x: z.labelAt.x, z: z.labelAt.z }));

  // telas que precisam ficar vivas saem do grupo fundido
  const keep: THREE.Object3D[] = [];
  staticG.traverse(o => { if (o.userData.keep) keep.push(o); });
  for (const o of keep) { o.updateWorldMatrix(true, false); const m = o.matrixWorld.clone(); o.removeFromParent(); live.add(o); m.decompose(o.position, o.quaternion, o.scale); }
  const before = countMeshes(staticG);
  const merged = mergeByMaterial(staticG);
  root.remove(staticG); root.add(merged);
  const after = countMeshes(merged);

  for (const p of picks) root.add(p.mesh);
  return {
    root, deskScreens, bossScreen: bd.screens[0], studioScreen: vs.screen, meetingScreen: ws.screen, socialsPanel, mural, picks, zoneLabels,
    stats: { meshesBefore: before, meshesAfter: after },
    dispose() {
      root.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); const m = o.material as THREE.Material | THREE.Material[]; for (const x of Array.isArray(m) ? m : [m]) { const map = (x as THREE.MeshBasicMaterial).map; map?.dispose(); } } });
    },
  };
}

function countMeshes(g: THREE.Object3D): number { let n = 0; g.traverse(o => { if (o instanceof THREE.Mesh) n++; }); return n; }

/** Funde todas as malhas opacas do grupo por material (geometria já no espaço do mundo). */
export function mergeByMaterial(group: THREE.Group): THREE.Group {
  group.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const out = new THREE.Group();
  group.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material as THREE.Material;
    if (Array.isArray(o.material) || (mat as THREE.Material & { transparent?: boolean }).transparent) {
      const c = o.clone(); o.matrixWorld.decompose(c.position, c.quaternion, c.scale); out.add(c); return;
    }
    const g = withIndex(o.geometry.clone());
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.applyMatrix4(o.matrixWorld);
    const list = buckets.get(mat) ?? []; list.push(g); buckets.set(mat, list);
  });
  for (const [mat, geos] of buckets) {
    const g = mergeGeometries(geos, false);
    for (const x of geos) x.dispose();
    if (!g) continue;
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true;
    out.add(m);
  }
  return out;
}

/** Painel das redes: estado de cada conexão (configurada, conectada, com erro), sem inventar número. */
export function drawSocials(panel: CanvasPanel, items: { label: string; state: 'connected' | 'configured' | 'error' | 'off' }[]): void {
  const g = panel.g; const Wd = 512, H = 320;
  g.fillStyle = '#fff8ef'; g.fillRect(0, 0, Wd, H);
  g.fillStyle = '#3a2f3d'; g.font = `800 30px ${FONT}`; g.textBaseline = 'top'; g.fillText('Redes', 22, 16);
  const colors = { connected: '#4f9e6a', configured: '#d98a12', error: '#d0505e', off: '#9a93a3' };
  const words = { connected: 'conectada', configured: 'configurada', error: 'com erro', off: 'desligada' };
  items.slice(0, 5).forEach((it, i) => {
    const y = 66 + i * 48;
    g.fillStyle = 'rgba(58,47,61,0.06)'; roundRect(g, 16, y, Wd - 32, 40, 12); g.fill();
    g.fillStyle = colors[it.state]; g.beginPath(); g.arc(38, y + 20, 8, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3a2f3d'; g.font = `700 21px ${FONT}`; g.textBaseline = 'middle'; g.fillText(it.label.slice(0, 22), 56, y + 21);
    g.fillStyle = colors[it.state]; g.font = `700 18px ${FONT}`; g.textAlign = 'right'; g.fillText(words[it.state], Wd - 30, y + 21); g.textAlign = 'left';
  });
  if (!items.length) { g.fillStyle = 'rgba(58,47,61,0.6)'; g.font = `600 20px ${FONT}`; g.fillText('nenhuma conta cadastrada', 22, 80); }
  panel.commit();
}
