// Área piloto do estúdio 3D (só desenvolvimento): mesa do Chefe, estações e personagens com estados simulados AQUI,
// rotulados como teste. Serve para validar visual e desempenho antes de ligar no app. Parâmetros na URL:
// ?n=2 (funcionários) · q=alta|equilibrada|economia · zone=boss|island|meeting|studio · script=0 (sem roteiro)
import '@fontsource-variable/nunito';
import '../styles/base.css';
import '../styles/studio.css';
import type { SceneWorker } from '../scene/types';
import { createStudio, type Quality } from './engine';
import type { ZoneId } from './layout';
import { runSheet } from './sheet';
import type { Activity } from './character';

const params = new URLSearchParams(location.search);
const n = Math.max(1, Math.min(14, Number(params.get('n') ?? 2)));
const quality = (params.get('q') as Quality) ?? 'equilibrada';
const stage = document.getElementById('stage')!;
const canvas = stage.querySelector('canvas')!;
const overlay = stage.querySelector('.st-overlay') as HTMLElement;

const NAMES = ['Nina', 'Teo', 'Marina', 'Caio', 'Bia', 'Clara', 'Otto', 'Vítor', 'Léo', 'Ana', 'Davi', 'Luna', 'Rui', 'Iris'];
const ROLES = ['Criação de conteúdo', 'Edição de vídeo', 'Coordenação editorial', 'Pesquisa', 'Criação de conteúdo', 'Edição de vídeo', 'Revisão e análise', 'Diretor de vídeo', 'Desenvolvimento', 'Mesa livre', 'Mesa livre', 'Mesa livre', 'Mesa livre', 'Mesa livre'];
const DESK_OF = [0, 1, 5, 4, 2, 3, 6, 7, 8, 10, 11, 12, 13, 9];

let workers: SceneWorker[] = Array.from({ length: n }, (_, i) => ({
  id: `teste-${i}`, roomId: 'social', name: NAMES[i], role: ROLES[i], phase: 'idle', detail: '', appearance: { skin: i % 6, hair: (i * 3) % 8, shirt: (i * 5) % 8 }, deskIndex: DESK_OF[i], controllable: true, status: 'idle',
}));
if (n >= 1) workers[0] = { ...workers[0], phase: 'writing', status: 'running', detail: 'Roteiro do Reel: o que é uma API' };
if (n >= 3) workers[2] = { ...workers[2], phase: 'thinking', status: 'running', detail: 'Planejando a semana do Tuco' };
if (n >= 4) workers[3] = { ...workers[3], phase: 'reading', status: 'running', detail: 'Lendo a documentação da MDN' };
if (n >= 7) workers[6] = { ...workers[6], status: 'queued', phase: 'idle' };
if (n >= 9) workers[8] = { ...workers[8], phase: 'executing', status: 'running', detail: 'pnpm test' };

if (params.get('sheet')) { runSheet(canvas, (params.get('act') as Activity) ?? 'stand'); throw new Error('folha de personagens'); }
const studio = createStudio(canvas, overlay, {
  onInteract: t => { console.log('[piloto] interação', JSON.stringify(t)); if (t.kind === 'worker') studio.setSelected(t.id); },
  onFail: r => { stage.innerHTML = `<div class="st-fallback">O escritório 3D não abriu: ${r}</div>`; },
}, { quality, ...(params.get('cap') ? { fpsCap: Number(params.get('cap')) } : {}) });
studio.setPlayer({ name: 'Chefe', appearance: { skin: 1, hair: 0, shirt: 0 } });
if (params.get('labels') === '0') { studio.setOptions({ showLabels: false }); overlay.style.display = 'none'; }
studio.setWorkers(workers);
studio.setBoard({ queued: 2, producing: 3, review: 1, ready: 4, waiting: 2, desk: 3 });
studio.setSocials([{ label: 'Instagram Aurora', state: 'configured' }, { label: 'Instagram Tuco Dev', state: 'configured' }, { label: 'Threads Aurora', state: 'off' }]);
studio.setStudioStatus('Renderizando: Reel o que é uma API (teste)');
const ro = new ResizeObserver(() => studio.resize()); ro.observe(stage);
const zone = params.get('zone') as ZoneId | null;
if (zone) studio.focusZone(zone);

function update(i: number, patch: Partial<SceneWorker>): void {
  workers = workers.map((w, k) => (k === i ? { ...w, ...patch } : w));
  studio.setWorkers(workers);
}

// roteiro do piloto: o funcionário 1 pede uma decisão ao Chefe, espera, volta e trabalha
if (params.get('script') !== '0' && n >= 2) {
  setTimeout(() => update(1, { status: 'waiting_answer', phase: 'waiting_answer', detail: 'Qual música uso no Reel da API?' }), 2500);
  setTimeout(() => update(1, { status: 'running', phase: 'executing', detail: 'Renderizando o Reel da API' }), 14000);
  if (n >= 5) setTimeout(() => update(4, { status: 'waiting_permission', phase: 'waiting_permission', detail: 'Pesquisa na web' }), 5000);
  if (n >= 5) setTimeout(() => update(4, { status: 'running', phase: 'writing', detail: 'Legenda do carrossel' }), 20000);
}

(window as unknown as { studio: typeof studio; pilot: { update: typeof update } }).studio = studio;
(window as unknown as { pilot: { update: typeof update } }).pilot = { update };

const statsEl = document.getElementById('stats')!;
setInterval(() => {
  const s = studio.stats();
  statsEl.textContent = `${s.fps} fps · quadro ${s.frameMs} ms · ${s.calls} desenhos · ${(s.triangles / 1000).toFixed(0)} mil triângulos\nqualidade ${s.quality} · escala ${s.pixelRatio} · ${s.characters} personagens · memória JS ${s.heapMB ?? '?'} MB\nmalhas do cenário ${s.meshes.before} → ${s.meshes.after} · ${s.renderer}`;
}, 500);
