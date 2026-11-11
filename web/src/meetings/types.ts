// Contrato dos componentes da sala de Reuniões (apresentação pura: nada aqui acessa store ou WebSocket).
// O App (src/App.tsx) injeta as props; o host preenche o reqId das mensagens que esperam resposta.

import type {
  AiProviderStatus, Employee, FsListResult, FsRoot, Meeting, MeetingClientMessage, MeetingContextItem, MeetingDecision,
  MeetingHistory, MeetingMode, MeetingParticipant, MeetingParticipantInput, Project, Room, Settings, Task } from '@milweb-hq/protocol';
import type { TargetSelectValue } from './helpers';

export interface MeetingsViewProps {
  meetings: Meeting[]; selectedId: string | null;
  history: MeetingHistory | null;            // histórico da reunião selecionada (null = carregando)
  streaming: Record<string, string>;         // turnId → texto parcial acumulado do turno em andamento
  employees: Employee[]; projects: Project[]; rooms: Room[];
  ai: AiProviderStatus[]; settings: Settings;
  onSelect(id: string | null): void;
  /** O host preenche reqId: mensagens com reqId devem ser enviadas com reqId: '' e o host devolve a resposta; sem reqId resolve undefined. */
  dispatch(msg: MeetingClientMessage): Promise<unknown>;
  onOpenAiSettings(): void;
  /** Para o seletor de arquivos do contexto (explorador): raízes e listagem de pasta. */
  fsRoots(): Promise<FsRoot[]>;
  fsList(rootId: string, path: string): Promise<FsListResult>;
  /** Tarefas recentes (estado real das tarefas distribuídas pelo plano). */
  tasks?: Task[];
  /** Abre a conversa do funcionário na tarefa. */
  onOpenTask?(taskId: string): void;
}

/** Despacho compartilhado pelos subcomponentes (mesma semântica de MeetingsViewProps.dispatch). */
export type MeetingDispatch = MeetingsViewProps['dispatch'];

/** Aviso dentro da tela (erros de pedidos, confirmações); nunca alert(). */
export interface MeetingNotice { level: 'info' | 'ok' | 'warn' | 'error'; text: string }

export interface MeetingListProps {
  meetings: Meeting[];
  selectedId: string | null;
  projects: Project[];
  onSelect(id: string): void;
  onNew(): void;
  /** Rodapé da coluna (Marco 0: lixeira de reuniões). */
  footer?: import('react').ReactNode;
}

export interface NewMeetingInput {
  title: string;
  agenda: string;
  projectId: string | null;
  mode: MeetingMode;
  roundLimit: number;
  participants: MeetingParticipantInput[];
  /** Índice em participants de quem faz a síntese no modo Discutir a pauta (null = o primeiro). */
  synthesisIndex?: number | null;
}

export interface NewMeetingDialogProps {
  open: boolean;
  projects: Project[];
  employees: Employee[];
  /** Para agrupar a equipe por sala (opcional). */
  rooms?: Room[];
  ai: AiProviderStatus[];
  /** Envia meeting.create; a rejeição vira aviso dentro do diálogo. */
  onCreate(input: NewMeetingInput): Promise<void>;
  onCancel(): void;
  onOpenAiSettings(): void;
}

export interface MeetingPanelProps {
  meeting: Meeting;
  history: MeetingHistory | null;
  streaming: Record<string, string>;
  employees: Employee[]; projects: Project[]; rooms: Room[];
  ai: AiProviderStatus[]; settings: Settings;
  dispatch: MeetingDispatch;
  onOpenAiSettings(): void;
  fsRoots(): Promise<FsRoot[]>;
  fsList(rootId: string, path: string): Promise<FsListResult>;
  /** Chamado depois de meeting.delete, para o host limpar a seleção. */
  onDeleted(): void;
  /** Lista de reuniões à esquerda aberta? (o botão do cabeçalho alterna) */
  listOpen?: boolean;
  onToggleList?(): void;
  tasks?: Task[];
  onOpenTask?(taskId: string): void;
}

export interface ParticipantsBarProps {
  meeting: Meeting;
  employees: Employee[];
  ai: AiProviderStatus[];
  settings: Settings;
  onUpdate(participantId: string, patch: { model?: string | null; effort?: MeetingParticipant['effort']; useGlobal?: boolean; employeeId?: string | null }): void;
  /** Troca o gerente responsável por consolidar o plano (meeting.update synthesisParticipantId). */
  onSetPlanOwner?(participantId: string): void;
  /** Chama um gerente ou alguém da equipe para a mesa (meeting.participant.add). Ausente = sem o botão. */
  onAdd?(input: { provider: 'claude' | 'openai'; employeeId: string | null }): void;
  /** Tira o participante da mesa (os turnos dele na fila são pulados). */
  onRemove?(participantId: string): void;
}

export interface ConversationProps {
  meeting: Meeting;
  history: MeetingHistory | null;
  streaming: Record<string, string>;
  onRetry(turnId: string): void;
}

export interface MeetingComposerProps {
  meeting: Meeting;
  ai: AiProviderStatus[];
  /** Motivo de bloqueio vindo de fora (ex.: desconectado); null = livre. */
  disabledReason?: string | null;
  /** clientId é gerado uma vez por envio; se a promessa rejeitar, o mesmo clientId é reutilizado no reenvio. */
  onSend(text: string, targets: string[], clientId: string): Promise<void>;
  onOpenAiSettings(): void;
  /** Valor inicial do seletor de destino (padrão 'all'). */
  initialTarget?: TargetSelectValue;
}

export interface BoardProps {
  meeting: Meeting;
  decisions: MeetingDecision[];
  employees: Employee[];
  dispatch: MeetingDispatch;
  onNotice(notice: MeetingNotice): void;
}

export interface ContextEditorProps {
  meeting: Meeting;
  items: MeetingContextItem[];
  dispatch: MeetingDispatch;
  onNotice(notice: MeetingNotice): void;
  fsRoots(): Promise<FsRoot[]>;
  fsList(rootId: string, path: string): Promise<FsListResult>;
}

export interface MinutesEditorProps {
  meeting: Meeting;
  history: MeetingHistory;
  employees: Employee[]; projects: Project[]; rooms: Room[];
  dispatch: MeetingDispatch;
  onNotice(notice: MeetingNotice): void;
}

export interface CreateTasksDialogProps {
  open: boolean;
  meeting: Meeting;
  history: MeetingHistory;
  employees: Employee[]; projects: Project[]; rooms: Room[];
  dispatch: MeetingDispatch;
  onClose(): void;
}

export interface PickedFile { rootId: string; rootName: string; relPath: string; absPath: string; name: string }

export interface FilePickerDialogProps {
  open: boolean;
  fsRoots(): Promise<FsRoot[]>;
  fsList(rootId: string, path: string): Promise<FsListResult>;
  onPick(files: PickedFile[]): void;
  onCancel(): void;
  /** Título do diálogo (padrão: "Arquivos para o contexto"). */
  title?: string;
}
