// Mapeamento fase real (WorkerPhase) → pose visual. Puro, testável. A pose só REPRESENTA o estado que o
// servidor informou; nada aqui inventa atividade.

import type { WorkerPhase } from '@milweb-hq/protocol';

export type BodyPose =
  | 'sit'      // sentado, olhando a tela
  | 'type'     // digitando (2 frames)
  | 'read'     // segura uma folha
  | 'wait';    // mão no queixo

export type MonitorState = 'off' | 'on' | 'exec';

export type BubbleKind = 'permission' | 'question' | 'done' | 'error' | 'disconnected';

export interface Pose {
  body: BodyPose;
  monitor: MonitorState;
  bubble: BubbleKind | null;
  /** Sessão desconectada: personagem esmaecido em cinza. */
  ghost: boolean;
  /** Permite comportamentos decorativos de ocioso (olhar em volta, alongar). */
  idle: boolean;
}

export const ALL_PHASES: readonly WorkerPhase[] = [
  'idle', 'thinking', 'responding', 'reading', 'writing', 'executing', 'delegating',
  'waiting_permission', 'waiting_answer', 'done', 'error', 'disconnected',
];

const POSES: Record<WorkerPhase, Pose> = {
  idle:               { body: 'sit',  monitor: 'on',   bubble: null,           ghost: false, idle: true },
  thinking:           { body: 'sit',  monitor: 'on',   bubble: null,           ghost: false, idle: false },
  responding:         { body: 'type', monitor: 'on',   bubble: null,           ghost: false, idle: false },
  reading:            { body: 'read', monitor: 'on',   bubble: null,           ghost: false, idle: false },
  writing:            { body: 'type', monitor: 'on',   bubble: null,           ghost: false, idle: false },
  executing:          { body: 'type', monitor: 'exec', bubble: null,           ghost: false, idle: false },
  delegating:         { body: 'wait', monitor: 'exec', bubble: null,           ghost: false, idle: false },
  waiting_permission: { body: 'wait', monitor: 'on',   bubble: 'permission',   ghost: false, idle: false },
  waiting_answer:     { body: 'wait', monitor: 'on',   bubble: 'question',     ghost: false, idle: false },
  done:               { body: 'sit',  monitor: 'on',   bubble: 'done',         ghost: false, idle: true },
  error:              { body: 'sit',  monitor: 'on',   bubble: 'error',        ghost: false, idle: false },
  disconnected:       { body: 'sit',  monitor: 'off',  bubble: 'disconnected', ghost: true,  idle: false },
};

/** Pose para uma fase. Fases desconhecidas (versão nova do protocolo) caem em "sentado, tela ligada". */
export function poseForPhase(phase: WorkerPhase): Pose {
  return POSES[phase] ?? POSES.thinking;
}

/** Tempo (ms) que a bolha "✓" fica visível depois da fase virar done. */
export const DONE_BUBBLE_MS = 2500;

/** Texto curto em português para a fase (usado nos rótulos quando o detalhe está vazio). */
export function phaseLabel(phase: WorkerPhase): string {
  switch (phase) {
    case 'idle': return 'Disponível';
    case 'thinking': return 'Pensando';
    case 'responding': return 'Respondendo';
    case 'reading': return 'Lendo';
    case 'writing': return 'Escrevendo';
    case 'executing': return 'Executando';
    case 'delegating': return 'Delegando';
    case 'waiting_permission': return 'Aguardando permissão';
    case 'waiting_answer': return 'Aguardando resposta';
    case 'done': return 'Concluído';
    case 'error': return 'Erro';
    case 'disconnected': return 'Desconectado';
    default: return String(phase);
  }
}
