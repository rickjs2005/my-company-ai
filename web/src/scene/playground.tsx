// Playground da cena (http://127.0.0.1:5174/scene.html): escritório com dados de exemplo e controles para testar
// fases, entrada/saída de funcionários, avatar (WASD/setas, E, clique), modos de câmera, minimapa, insets (painel
// simulado à direita) e reducedMotion. SÓ demonstração (MOCK_BANNER visível).
// `?sheet=1` mostra a folha de sprites (todos os sprites, zoom 4) para conferir a pixel art.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkerPhase } from '@milweb-hq/protocol';
import { MOCK_BANNER, sampleRooms, sampleSessions, sampleWorkers } from '../mock/sample';
import { OfficeCanvas, type SceneFocus } from './OfficeCanvas';
import { ALL_PHASES, phaseLabel } from './poses';
import { SPRITES, SpriteCache, characterPalette } from './sprites';
import type { CameraMode, MinimapData, OfficeScene, SceneInteractable, SceneOptions, ScenePlayer, SceneRoom, SceneSelection, SceneWorker } from './types';
import '../styles/base.css';

const NAMES = ['Nina', 'Caio', 'Duda', 'Theo', 'Lara', 'Rafa', 'Maya', 'Davi', 'Iris', 'Enzo'];
const DETAILS: Record<WorkerPhase, string> = {
  idle: 'Disponível', thinking: 'Pensando na resposta', responding: 'Escrevendo a resposta', reading: 'Lendo src/App.tsx',
  writing: 'Editando index.html', executing: 'Executando: npm test', delegating: 'Subagente: revisão de código',
  waiting_permission: 'Aguardando permissão: pnpm install', waiting_answer: 'Aguardando sua resposta', done: 'Resposta pronta',
  error: 'Falhou: comando saiu com código 1', disconnected: 'Processo encerrado',
};

const initialRooms: SceneRoom[] = [
  ...sampleRooms.map((r) => ({ id: r.id, name: r.name, kind: r.kind, color: r.color, slot: r.order })),
  { id: 'r-direction', name: 'Diretoria', kind: 'direction', color: '#c9a35a', slot: 5 },
];
const initialWorkers: SceneWorker[] = sampleWorkers.map((w) => ({
  id: w.id, roomId: w.roomId, name: w.name, role: w.role, phase: w.phase, detail: w.detail, appearance: w.appearance,
  deskIndex: w.deskIndex, controllable: w.controllable, observed: w.kind === 'observed' || sampleSessions.find((s) => s.id === w.sessionId)?.status === 'observed',
}));
const PLAYER: ScenePlayer = { name: 'Chefe', appearance: { skin: 1, hair: 0, shirt: 0 } };

const btn: React.CSSProperties = { background: '#1f1b22', border: '1px solid #3d3340', color: '#ece6dc', borderRadius: 6, padding: '4px 8px', fontSize: 12 };
const btnOn: React.CSSProperties = { ...btn, background: '#2a1e0a', border: '1px solid #f0a830', color: '#ffd27a' };
const sel: React.CSSProperties = { ...btn, padding: '3px 4px' };

function describeTarget(t: SceneInteractable): string {
  switch (t.kind) {
    case 'worker': return `funcionário ${t.id}`;
    case 'desk': return `mesa (${t.roomId}${t.workerId ? `, ${t.workerId}` : ', livre'})`;
    case 'cabinet': return `armário (${t.roomId})`;
    case 'shelf': return `estante de skills (${t.roomId})`;
    case 'computer': return `computador (${t.roomId})`;
    case 'board': return `mural (${t.roomId})`;
    case 'reception': return 'balcão da recepção';
    case 'meeting': return `mesa de reunião (${t.roomId})`;
  }
}

/** Minimapa simples desenhado a partir de getMinimap(); clique = lookAt. */
function Minimap({ sceneRef }: { sceneRef: React.MutableRefObject<OfficeScene | null> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<MinimapData | null>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const scene = sceneRef.current;
      const cv = ref.current;
      if (!scene || !cv) return;
      const d = scene.getMinimap();
      dataRef.current = d;
      const k = cv.width / d.world.w;
      const c = cv.getContext('2d');
      if (!c) return;
      c.fillStyle = '#0f0c10';
      c.fillRect(0, 0, cv.width, cv.height);
      for (const r of d.rooms) {
        c.fillStyle = r.color;
        c.globalAlpha = 0.35;
        c.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
        c.globalAlpha = 1;
      }
      for (const w of d.workers) { c.fillStyle = w.color; c.fillRect(Math.round(w.x * k) - 1, Math.round(w.y * k) - 2, 3, 3); }
      if (d.player) { c.fillStyle = '#ffd27a'; c.fillRect(Math.round(d.player.x * k) - 2, Math.round(d.player.y * k) - 3, 4, 4); }
      c.strokeStyle = 'rgba(255,255,255,0.7)';
      c.lineWidth = 1;
      c.strokeRect(Math.round(d.view.x * k) + 0.5, Math.round(d.view.y * k) + 0.5, Math.round(d.view.w * k), Math.round(d.view.h * k));
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sceneRef]);
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = dataRef.current;
    const cv = ref.current;
    if (!d || !cv) return;
    const r = cv.getBoundingClientRect();
    const k = d.world.w / cv.width;
    sceneRef.current?.lookAt({ x: (e.clientX - r.left) * (cv.width / r.width) * k, y: (e.clientY - r.top) * (cv.height / r.height) * k });
  };
  return <canvas ref={ref} width={162} height={120} onClick={onClick} data-testid="minimap" style={{ border: '1px solid #3d3340', borderRadius: 4, imageRendering: 'pixelated', cursor: 'pointer' }} />;
}

/** Folha de sprites para conferência visual (?sheet=1). */
function SpriteSheet() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const cache = new SpriteCache();
    const names = Object.keys(SPRITES);
    const Z = 4;
    const COLS = 8;
    const CELL_W = 96 * Z / 2;
    const CELL_H = 60 * Z / 2 + 14;
    cv.width = COLS * CELL_W;
    cv.height = Math.ceil(names.length / COLS) * CELL_H;
    const c = cv.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    c.fillStyle = '#2d2630';
    c.fillRect(0, 0, cv.width, cv.height);
    const dyn = characterPalette({ skin: 1, hair: 0, shirt: 0 });
    names.forEach((n, i) => {
      const x = (i % COLS) * CELL_W;
      const y = Math.floor(i / COLS) * CELL_H;
      const img = cache.get(n, Z, n.startsWith('c.') ? dyn : undefined);
      c.drawImage(img, x + 4, y + 14);
      c.fillStyle = '#ffd27a';
      c.font = '11px Inter';
      c.fillText(n, x + 4, y + 10);
    });
  }, []);
  return <div style={{ overflow: 'auto', height: '100%' }}><canvas ref={ref} /></div>;
}

function Playground() {
  const [rooms, setRooms] = useState<SceneRoom[]>(initialRooms);
  const [workers, setWorkers] = useState<SceneWorker[]>(initialWorkers);
  const [selection, setSelection] = useState<SceneSelection>({ kind: 'none' });
  const [hover, setHover] = useState<SceneSelection>({ kind: 'none' });
  const [reducedMotion, setReducedMotion] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [panel, setPanel] = useState(false);
  const [compact, setCompact] = useState(new URLSearchParams(location.search).get('compact') === '1');
  const [inputEnabled, setInputEnabled] = useState(true);
  const [withPlayer, setWithPlayer] = useState(true);
  const [focus, setFocus] = useState<SceneFocus | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [counter, setCounter] = useState(0);
  const [cameraMode, setCameraMode] = useState<CameraMode>('overview');
  const [hint, setHint] = useState<string | null>(null);
  const [lastInteract, setLastInteract] = useState<string | null>(null);
  const [playerRoom, setPlayerRoom] = useState<string | null>(null);
  const [playerPos, setPlayerPos] = useState<{ x: number; y: number } | null>(null);
  const [moves, setMoves] = useState(0);
  const sceneRef = useRef<OfficeScene | null>(null);

  const options = useMemo<Partial<SceneOptions>>(() => ({
    reducedMotion, showLabels, inputEnabled, insets: { left: 0, right: panel ? 420 : 0, top: 0, bottom: 0 },
  }), [reducedMotion, showLabels, inputEnabled, panel]);

  const patch = useCallback((id: string, p: Partial<SceneWorker>) => {
    setWorkers((ws) => ws.map((w) => (w.id === id ? { ...w, ...p } : w)));
  }, []);
  const setPhase = (id: string, phase: WorkerPhase) => patch(id, { phase, detail: DETAILS[phase] });

  const addWorker = (roomId: string) => {
    const n = counter + 1;
    setCounter(n);
    const used = new Set(workers.filter((w) => w.roomId === roomId).map((w) => w.deskIndex));
    let desk = 0;
    while (used.has(desk) && desk < 4) desk++;
    const w: SceneWorker = {
      id: `demo-${n}`, roomId, name: NAMES[n % NAMES.length], role: rooms.find((r) => r.id === roomId)?.name ?? '',
      phase: 'idle', detail: 'Disponível', appearance: { skin: n % 4, hair: (n * 3) % 4, shirt: (n * 7) % 4 }, deskIndex: desk, controllable: true,
    };
    setWorkers((ws) => [...ws, w]);
  };
  const removeWorker = (id: string) => setWorkers((ws) => ws.filter((w) => w.id !== id));
  const moveWorker = (id: string, roomId: string) => {
    const used = new Set(workers.filter((w) => w.roomId === roomId && w.id !== id).map((w) => w.deskIndex));
    let desk = 0;
    while (used.has(desk) && desk < 4) desk++;
    patch(id, { roomId, deskIndex: desk });
  };
  const describe = (s: SceneSelection) => s.kind === 'none' ? '—' : s.kind === 'room' ? `sala ${rooms.find((r) => r.id === s.id)?.name ?? s.id}` : `funcionário ${workers.find((w) => w.id === s.id)?.name ?? s.id}`;
  const modeBtn = (m: CameraMode, label: string) => (
    <button style={cameraMode === m ? btnOn : btn} onClick={() => { if (m === 'overview') sceneRef.current?.fitAll(); else if (m === 'follow') sceneRef.current?.followPlayer(); else sceneRef.current?.setCameraMode('free'); }}>{label}</button>
  );

  // exposto para os scripts de verificação visual (Playwright)
  useEffect(() => { (window as unknown as { __scene?: OfficeScene | null }).__scene = sceneRef.current; });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ background: '#e36a5a', color: '#1a1216', fontWeight: 600, fontSize: 12, padding: '4px 12px', textAlign: 'center' }}>{MOCK_BANNER}</div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <OfficeCanvas
          rooms={rooms}
          workers={workers}
          selection={selection}
          options={options}
          focus={focus}
          player={withPlayer ? PLAYER : null}
          sceneRef={sceneRef}
          onSelect={setSelection}
          onHover={setHover}
          onOpenWorker={(id) => setOpened(id)}
          onInteract={(t) => setLastInteract(describeTarget(t))}
          onInteractableChange={(_t, label) => setHint(label)}
          onEnterRoom={(id) => setPlayerRoom(id)}
          onCameraModeChange={setCameraMode}
          onPlayerMove={(p) => { setPlayerPos(p); setMoves((n) => n + 1); }}
        />
        {panel && (
          <div data-testid="fake-panel" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 420, background: 'rgba(26,23,28,0.96)', borderLeft: '1px solid #3d3340', padding: 16, fontSize: 12, color: '#a89f93' }}>
            <b style={{ color: '#ece6dc' }}>Painel simulado (420 px)</b>
            <p>Ocupa a área da direita como o painel do funcionário no app. A vista geral e o follow respeitam este inset.</p>
            <input placeholder="campo de texto: WASD aqui não move o avatar" style={{ width: '100%', background: '#15121a', border: '1px solid #3d3340', color: '#ece6dc', padding: 6, borderRadius: 6 }} />
          </div>
        )}
        <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Minimap sceneRef={sceneRef} />
        </div>
        <div data-testid="hint" style={{ position: 'absolute', left: 12, top: 12, fontSize: 12, color: '#ffd27a', background: 'rgba(18,16,20,0.8)', padding: '4px 8px', borderRadius: 6, pointerEvents: 'none' }}>
          {hint ? `E · ${hint}` : withPlayer ? 'WASD/setas movem · clique no chão anda · E interage' : 'sem avatar'}
          {playerRoom ? ` · em: ${rooms.find((r) => r.id === playerRoom)?.name ?? playerRoom}` : ''}
          {lastInteract ? ` · última interação: ${lastInteract}` : ''}
        </div>
      </div>
      <div style={{ borderTop: '1px solid #2d2630', background: '#1a171c', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, maxHeight: '34vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={reducedMotion} onChange={(e) => setReducedMotion(e.target.checked)} /> reduzir animações</label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> rótulos</label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={withPlayer} onChange={(e) => setWithPlayer(e.target.checked)} /> avatar</label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={inputEnabled} onChange={(e) => setInputEnabled(e.target.checked)} /> teclado</label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={panel} onChange={(e) => setPanel(e.target.checked)} /> painel à direita (insets)</label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} /> compacto</label>
          <span style={{ color: '#a89f93' }}>Câmera:</span>
          {modeBtn('overview', 'Ver tudo')}
          {modeBtn('follow', 'Seguir avatar')}
          {modeBtn('free', 'Livre')}
          <button style={btn} onClick={() => sceneRef.current?.zoomBy(1)}>+</button>
          <button style={btn} onClick={() => sceneRef.current?.zoomBy(-1)}>−</button>
          <button style={btn} onClick={() => sceneRef.current?.setPlayerPosition({ x: 100, y: 100 })}>posição inválida (cai no ponto seguro)</button>
          <span style={{ color: '#a89f93', marginLeft: 'auto' }} data-testid="status">
            modo: <b>{cameraMode}</b> · zoom: {sceneRef.current?.getOptions().zoom ?? '—'} · avatar: {playerPos ? `${playerPos.x},${playerPos.y}` : '—'} ({moves} avisos) · seleção: <b>{describe(selection)}</b> · hover: {describe(hover)} {opened ? `· aberto: ${workers.find((w) => w.id === opened)?.name ?? opened}` : ''}
          </span>
        </div>
        {!compact && <>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#a89f93' }}>Focar sala:</span>
          {rooms.map((r) => <button key={r.id} style={btn} onClick={() => setFocus({ kind: 'room', id: r.id, nonce: Date.now() })}>{r.name}</button>)}
          <span style={{ color: '#a89f93' }}>Adicionar funcionário em:</span>
          {rooms.map((r) => <button key={r.id} style={btn} onClick={() => addWorker(r.id)}>+ {r.name}</button>)}
          <button style={btn} onClick={() => { setCounter((c) => c + 1); setWorkers((ws) => [...ws, { id: `demo-x${counter + 1}`, roomId: 'r-sem-sala', name: 'Visitante', role: 'Sem sala', phase: 'idle', detail: 'Sala sem vaga na planta', appearance: { skin: 3, hair: 2, shirt: 1 }, deskIndex: 0, controllable: true }]); }}>+ sem sala (convivência)</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 4 }}>
          {workers.map((w) => (
            <div key={w.id} style={{ display: 'flex', gap: 6, alignItems: 'center', background: selection.kind === 'worker' && selection.id === w.id ? '#2a1e0a' : '#1f1b22', padding: '4px 8px', borderRadius: 6 }}>
              <b style={{ minWidth: 90 }}>{w.name}</b>
              <select style={sel} value={w.phase} onChange={(e) => setPhase(w.id, e.target.value as WorkerPhase)}>
                {ALL_PHASES.map((p) => <option key={p} value={p}>{phaseLabel(p)}</option>)}
              </select>
              <select style={sel} value={w.roomId} onChange={(e) => moveWorker(w.id, e.target.value)}>
                {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                {!rooms.some((r) => r.id === w.roomId) && <option value={w.roomId}>(sem sala)</option>}
              </select>
              <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}><input type="checkbox" checked={!!w.observed} onChange={(e) => patch(w.id, { observed: e.target.checked })} /> observada</label>
              <button style={btn} onClick={() => setFocus({ kind: 'worker', id: w.id, nonce: Date.now() })}>focar</button>
              <button style={btn} onClick={() => removeWorker(w.id)}>remover</button>
            </div>
          ))}
        </div>
        <div style={{ color: '#6f675f' }}>Arraste para mover a câmera (modo livre) · roda do mouse ou +/− para zoom · WASD/setas movem o avatar · clique no chão anda até lá · E interage com o alvo ao alcance · clique seleciona funcionário · duplo clique abre · 0 = ver tudo · clique no minimapa centraliza.</div>
        </>}
      </div>
    </div>
  );
}

const sheet = new URLSearchParams(location.search).get('sheet') === '1';
createRoot(document.getElementById('root')!).render(sheet ? <SpriteSheet /> : <Playground />);
