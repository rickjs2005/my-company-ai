// Contrato da cena do escritório (canvas 2D). Implementação em ./office.ts; wrapper React em ./OfficeCanvas.tsx.
// A cena só REPRESENTA estado que vem do servidor; ela nunca inventa atividade. Comportamentos decorativos de
// personagens ociosos (olhar em volta, tomar café, circular) são apenas visuais e não geram registro.
// O avatar do Chefe é controlado por teclado/mouse: não inicia processo nem consome sessão.

import type { ParticipantState, RoomKind, WorkerPhase, WorkerStatus } from '@milweb-hq/protocol';

export interface SceneRoom {
  id: string;
  name: string;
  kind: RoomKind;
  color: string;
  /** Posição na planta (0..5 salas de trabalho; 6 = sala de Reuniões). Salas além das vagas ficam só na lista lateral. */
  slot: number;
}

/** Participante de IA sentado à mesa de reunião (não é funcionário: não tem mesa de trabalho nem fase de sessão). */
export interface SceneMeetingActor {
  id: string;
  /** 'Claude' | 'ChatGPT' (gerentes) ou o nome do funcionário à mesa. */
  name: string;
  provider: 'claude' | 'openai';
  /** Funcionário à mesa: aparência e inicial dele (o gerente usa a aparência fixa do provedor). */
  appearance?: { skin: number; hair: number; shirt: number };
  initial?: string;
  /** Estado real do participante no turno em andamento (vem do servidor). */
  state: ParticipantState;
  /** Assento ao redor da mesa (0..8, ordem fixa de getMeetingSeats). */
  seat: number;
}

/** Reunião mostrada na sala de Reuniões. `active` false (ou meeting null) faz os atores saírem pela porta. */
export interface SceneMeeting {
  /** Id da SceneRoom no slot 6, ou 'meeting' quando a sala não existe no banco. */
  roomId: string;
  active: boolean;
  actors: SceneMeetingActor[];
}

export interface SceneWorker {
  id: string;
  roomId: string;
  name: string;
  role: string;
  phase: WorkerPhase;
  /** Texto curto e real do que está acontecendo (ex.: "Editando index.html"). */
  detail: string;
  appearance: { skin: number; hair: number; shirt: number };
  deskIndex: number;
  controllable: boolean;
  /** Sessão observada (iniciada fora da HQ) ganha marcação visual diferente (olho) e nunca ganha botões de comando. */
  observed?: boolean;
  /** Estado real derivado no servidor (idle, running, paused…); a pose vem de `phase`, o rótulo pode usar isto. */
  status?: WorkerStatus;
}

/** Avatar do usuário ("Chefe · Você"). Separado dos funcionários e das sessões observadas. */
export interface ScenePlayer {
  name: string;
  appearance: { skin: number; hair: number; shirt: number };
}

/** 'follow' acompanha o avatar com suavidade; 'overview' enquadra a planta inteira; 'free' depois de arrastar/zoom manual. */
export type CameraMode = 'follow' | 'overview' | 'free';

export interface SceneOptions {
  reducedMotion: boolean;
  showLabels: boolean;
  /** Zoom inteiro (1..6). */
  zoom: number;
  /** Área útil do palco em px CSS: margens ocupadas por painéis sobrepostos. fitAll() e o follow respeitam. */
  insets: { left: number; right: number; top: number; bottom: number };
  /** Teclado/mouse movem o avatar só quando true (false enquanto o foco está em texto ou formulário). */
  inputEnabled: boolean;
  /** Planta fora da tela (a sala isométrica está à vista): não desenha nem agenda quadros. */
  paused?: boolean;
}

export type SceneSelection = { kind: 'none' } | { kind: 'room'; id: string } | { kind: 'worker'; id: string };

/** Alvo de interação (tecla E ou clique no objeto) ao alcance do avatar. */
export type SceneInteractable =
  | { kind: 'worker'; id: string }                                 // conversar: abre o painel do funcionário
  | { kind: 'desk'; roomId: string; workerId: string | null }      // mesa: tarefas (do funcionário sentado, se houver)
  | { kind: 'cabinet'; roomId: string }                            // armário: projetos da sala (Marco 1)
  | { kind: 'shelf'; roomId: string }                              // estante de livros: skills
  | { kind: 'computer'; roomId: string }                           // computador/rack: ferramentas do projeto
  | { kind: 'board'; roomId: string }                              // mural/quadro: visão de tarefas
  | { kind: 'reception' }                                          // balcão da recepção
  | { kind: 'meeting'; roomId: string };                           // mesa/tela da sala de Reuniões (roomId = sala no slot 6 ou 'meeting')

export interface SceneHandlers {
  onSelect(sel: SceneSelection): void;
  onHover?(sel: SceneSelection): void;
  /** Duplo clique num funcionário (abrir painel). */
  onOpenWorker?(workerId: string): void;
  /** Tecla E (ou clique num objeto interativo) com um alvo ao alcance. */
  onInteract?(target: SceneInteractable): void;
  /** O alvo ao alcance mudou (null = nada perto). `label` é o texto da dica, ex.: "Conversar com Léo". */
  onInteractableChange?(target: SceneInteractable | null, label: string | null): void;
  /** O avatar entrou numa sala (null = corredor, recepção ou convivência). */
  onEnterRoom?(roomId: string | null): void;
  onCameraModeChange?(mode: CameraMode): void;
  /** Posição do avatar em px do mundo: no máximo ~1x por segundo enquanto anda e sempre ao parar (para persistir). */
  onPlayerMove?(pos: { x: number; y: number }): void;
}

export interface MinimapData {
  world: { w: number; h: number };
  rooms: { id: string; name: string; color: string; x: number; y: number; w: number; h: number }[];
  workers: { id: string; x: number; y: number; color: string }[];
  player: { x: number; y: number } | null;
  /** Retângulo visível da câmera em px do mundo. */
  view: { x: number; y: number; w: number; h: number };
}

export interface OfficeScene {
  setRooms(rooms: SceneRoom[]): void;
  setWorkers(workers: SceneWorker[]): void;
  /**
   * Reunião em andamento na sala de Reuniões: com `active` e atores, cada ator entra pela porta e senta no seu
   * assento; `active` false ou null faz todos saírem pela porta. Só representa o estado recebido; nada é inventado.
   */
  setMeeting(meeting: SceneMeeting | null): void;
  setOptions(opts: Partial<SceneOptions>): void;
  getOptions(): SceneOptions;
  select(sel: SceneSelection): void;
  focusRoom(roomId: string, animate?: boolean): void;
  focusWorker(workerId: string, animate?: boolean): void;
  zoomBy(delta: number): void;
  /** "Ver empresa": enquadra a planta inteira (paredes, placas e margens) na área útil (insets); entra no modo 'overview'. */
  fitAll(): void;
  /** Compatibilidade: igual a fitAll(). */
  resetView(): void;

  // ---- avatar ----
  /** Liga o avatar (null desliga). Começa na última posição passada em setPlayerPosition, senão na recepção. */
  setPlayer(player: ScenePlayer | null): void;
  /** Restaura uma posição persistida; se o tile não for transitável no layout atual, cai no ponto seguro (recepção). */
  setPlayerPosition(pos: { x: number; y: number }): void;
  getPlayerPosition(): { x: number; y: number } | null;
  /** Anda até um ponto do mundo (A* até o tile transitável mais próximo); destino inacessível é ignorado. */
  walkTo(pos: { x: number; y: number }): void;
  /** Interage com o alvo ao alcance (mesmo efeito da tecla E). */
  interact(): void;

  // ---- câmera ----
  setCameraMode(mode: CameraMode): void;
  getCameraMode(): CameraMode;
  /** Volta a câmera para o avatar (modo 'follow'). */
  followPlayer(): void;
  getMinimap(): MinimapData;
  /** Centraliza a câmera num ponto do mundo (ex.: clique no minimapa); entra no modo 'free'. */
  lookAt(pos: { x: number; y: number }): void;

  /** Recalcula tamanho a partir do elemento pai (chamar em resize). */
  resize(): void;
  destroy(): void;
}

export declare function createOfficeScene(canvas: HTMLCanvasElement, handlers: SceneHandlers, options?: Partial<SceneOptions>): OfficeScene;
