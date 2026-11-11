// Wrapper React da cena: cria o motor uma vez, repassa props por efeitos e trata resize com ResizeObserver.
// Props antigas (rooms/workers/selection/options/focus/onSelect/onHover/onOpenWorker) continuam valendo; as novas
// (player, playerPosition, cameraMode, onInteract, onInteractableChange, onEnterRoom, onCameraModeChange,
// onPlayerMove, sceneRef) ligam o avatar e a câmera.
import { useEffect, useRef, type Ref } from 'react';
import { createOfficeScene } from './office';
import type { CameraMode, OfficeScene, SceneHandlers, SceneInteractable, SceneMeeting, SceneOptions, ScenePlayer, SceneRoom, SceneSelection, SceneWorker } from './types';

export interface SceneFocus { kind: 'room' | 'worker'; id: string; nonce: number }

export interface OfficeCanvasProps {
  rooms: SceneRoom[];
  workers: SceneWorker[];
  /** Reunião em andamento na sala de Reuniões (null/undefined = ninguém sentado; os atores saem pela porta). */
  meeting?: SceneMeeting | null;
  selection: SceneSelection;
  options: Partial<SceneOptions>;
  /** Mude o `nonce` para focar de novo o mesmo alvo. */
  focus?: SceneFocus | null;
  /** Avatar do usuário (null/undefined = sem avatar). */
  player?: ScenePlayer | null;
  /** Posição persistida do avatar; aplicada quando muda (tile bloqueado cai no ponto seguro). */
  playerPosition?: { x: number; y: number } | null;
  /** Modo de câmera desejado; aplicado quando muda. A cena avisa trocas internas por onCameraModeChange. */
  cameraMode?: CameraMode;
  /** Acesso imperativo (walkTo, lookAt, getMinimap, interact, fitAll...). */
  sceneRef?: Ref<OfficeScene | null>;
  onSelect(sel: SceneSelection): void;
  onHover?(sel: SceneSelection): void;
  onOpenWorker?(workerId: string): void;
  onInteract?(target: SceneInteractable): void;
  onInteractableChange?(target: SceneInteractable | null, label: string | null): void;
  onEnterRoom?(roomId: string | null): void;
  onCameraModeChange?(mode: CameraMode): void;
  onPlayerMove?(pos: { x: number; y: number }): void;
  className?: string;
  style?: React.CSSProperties;
}

export function OfficeCanvas(props: OfficeCanvasProps) {
  const {
    rooms, workers, meeting, selection, options, focus, player, playerPosition, cameraMode, sceneRef,
    onSelect, onHover, onOpenWorker, onInteract, onInteractableChange, onEnterRoom, onCameraModeChange, onPlayerMove, className, style,
  } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<OfficeScene | null>(null);
  // Handlers sempre atuais sem recriar a cena.
  const handlersRef = useRef<SceneHandlers>({ onSelect });
  handlersRef.current = { onSelect, onHover, onOpenWorker, onInteract, onInteractableChange, onEnterRoom, onCameraModeChange, onPlayerMove };
  const initialOptions = useRef(options);
  const lastOptions = useRef<Partial<SceneOptions>>(options);
  const initialPlayer = useRef({ player, playerPosition, cameraMode });

  const sceneRefLatest = useRef(sceneRef);
  sceneRefLatest.current = sceneRef;
  // a ref externa é atribuída quando a cena existe de verdade (useImperativeHandle rodaria antes do efeito de criação)
  const assignRef = (value: OfficeScene | null) => {
    const r = sceneRefLatest.current;
    if (!r) return;
    if (typeof r === 'function') r(value); else (r as { current: OfficeScene | null }).current = value;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const scene = createOfficeScene(canvas, {
      onSelect: (s) => handlersRef.current.onSelect(s),
      onHover: (s) => handlersRef.current.onHover?.(s),
      onOpenWorker: (id) => handlersRef.current.onOpenWorker?.(id),
      onInteract: (t) => handlersRef.current.onInteract?.(t),
      onInteractableChange: (t, l) => handlersRef.current.onInteractableChange?.(t, l),
      onEnterRoom: (id) => handlersRef.current.onEnterRoom?.(id),
      onCameraModeChange: (m) => handlersRef.current.onCameraModeChange?.(m),
      onPlayerMove: (p) => handlersRef.current.onPlayerMove?.(p),
    }, initialOptions.current);
    engineRef.current = scene;
    assignRef(scene);
    const init = initialPlayer.current;
    if (init.playerPosition) scene.setPlayerPosition(init.playerPosition);
    if (init.player) scene.setPlayer(init.player);
    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(host);
    scene.resize();
    if (init.cameraMode) scene.setCameraMode(init.cameraMode);
    return () => {
      ro.disconnect();
      scene.destroy();
      engineRef.current = null;
      assignRef(null);
    };
  }, []);

  useEffect(() => { engineRef.current?.setRooms(rooms); }, [rooms]);
  useEffect(() => { engineRef.current?.setWorkers(workers); }, [workers]);
  useEffect(() => { engineRef.current?.setMeeting(meeting ?? null); }, [meeting]);
  useEffect(() => { engineRef.current?.select(selection); }, [selection]);
  useEffect(() => {
    // repassa só o que mudou: `zoom` constante no objeto não desfaz o zoom da roda/fitAll a cada re-render
    const prev = lastOptions.current;
    lastOptions.current = options;
    const patch: Partial<SceneOptions> = {};
    for (const key of Object.keys(options) as (keyof SceneOptions)[]) {
      const a = options[key];
      const b = prev[key];
      if (key === 'insets') {
        const ia = a as SceneOptions['insets'] | undefined;
        const ib = b as SceneOptions['insets'] | undefined;
        if (ia && (!ib || ia.left !== ib.left || ia.right !== ib.right || ia.top !== ib.top || ia.bottom !== ib.bottom)) patch.insets = ia;
      } else if (a !== undefined && a !== b) {
        (patch as Record<string, unknown>)[key] = a;
      }
    }
    if (Object.keys(patch).length) engineRef.current?.setOptions(patch);
  }, [options]);
  useEffect(() => { engineRef.current?.setPlayer(player ?? null); }, [player]);
  useEffect(() => { if (playerPosition) engineRef.current?.setPlayerPosition(playerPosition); }, [playerPosition]);
  useEffect(() => {
    const scene = engineRef.current;
    if (!scene || !cameraMode || scene.getCameraMode() === cameraMode) return;
    scene.setCameraMode(cameraMode);
  }, [cameraMode]);
  useEffect(() => {
    if (!focus) return;
    const scene = engineRef.current;
    if (!scene) return;
    if (focus.kind === 'room') scene.focusRoom(focus.id); else scene.focusWorker(focus.id);
  }, [focus]);

  return (
    <div ref={hostRef} className={className} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#121014', ...style }}>
      <canvas ref={canvasRef} aria-label="Escritório da MilWeb HQ" role="img" style={{ display: 'block', position: 'absolute', inset: 0 }} />
    </div>
  );
}
