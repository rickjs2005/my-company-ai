// Contrato dos componentes de interface (apresentação pura, sem acesso a WebSocket/estado global).
// O App (src/App.tsx) e o estado (src/state/*) são de responsabilidade do orquestrador e injetam estas props.

import type {
  ActivityState, AiProviderId, AiProviderStatus, AiTestResult, Attachment, ChatItem, EditorialProfile, EffortLevel, Employee,
  FileNode, GitStatusEntry, LogEntry, PendingPermission, PermissionModeOption, Project, Room, ServerInfo, ServiceStatus, Session, Settings, Task, Worker,
} from '@milweb-hq/protocol';

/** steer = falar no meio da tarefa: entra no próximo passo do turno em andamento, sem interromper (09/11/2026). */
export type SendMode = 'send' | 'queue' | 'interrupt' | 'steer';

export interface OutgoingAttachment { name: string; mediaType: string; dataBase64: string; sizeBytes: number }

export interface ChatViewProps {
  items: ChatItem[];
  /** Texto parcial da resposta em andamento (vazio quando não há streaming). */
  streamingText: string;
  /** Quem está escrevendo o texto parcial (provedor da conversa); sem o campo, Claude. */
  streamingAuthor?: 'claude' | 'openai';
  busy: boolean;
  pending: PendingPermission[];
  onAllow(requestId: string, rememberSuggestion: boolean): void;
  onDeny(requestId: string, message?: string): void;
  onAnswer(requestId: string, answers: Record<string, string>): void;
  onOpenFile?(path: string): void;
}

export interface ComposerProps {
  session: Session | null;
  project: Project | null;
  room: Room | null;
  profiles: EditorialProfile[];
  profileId: string | null;
  busy: boolean;             // turno em andamento na sessão
  queuedCount: number;
  connected: boolean;
  disabledReason?: string | null;
  onSend(text: string, attachments: OutgoingAttachment[], mode: SendMode): void;
  onInterrupt(): void;
  onProfileChange(profileId: string | null): void;
  onModelChange(model: string | null): void;
  onPermissionModeChange(mode: PermissionModeOption): void;
}

export interface TimelineEntry { seq: number; taskId: string | null; entry: LogEntry }

export interface ActivityTimelineProps {
  entries: TimelineEntry[];
  activity: ActivityState | null;
  processState: Session['processState'];
}

export interface FilesPanelProps {
  project: Project | null;
  tree: FileNode | null;
  gitStatus: GitStatusEntry[] | null;
  touchedFiles: string[];
  loading: boolean;
  onLoadTree(path?: string): void;
  onReadFile(path: string): Promise<{ content: string; truncated: boolean; binary: boolean }>;
  onDiff(path?: string): Promise<string>;
  onOpenExternal(target: 'folder' | 'file' | 'url', value: string): void;
}

export interface DeliverablesPanelProps {
  tasks: Task[];
  project: Project | null;
  previewUrl: string | null;
  /** Nomes para mostrar o responsável e a sessão da tarefa (opcional). */
  employees?: Employee[];
  /** Reexecuta uma tarefa perdida/falha como nova tentativa (task.retry). */
  onRetry?(taskId: string): void;
  /** O Chefe conferiu uma tarefa "resultado a conferir" (task.markVerified). */
  onMarkVerified?(taskId: string): void;
  /** Libera uma tarefa em espera (task.release). */
  onRelease?(taskId: string): void;
  /** Cancela uma tarefa ainda na fila (task.cancelQueued). */
  onCancelQueued?(taskId: string): void;
  onOpenExternal(target: 'folder' | 'file' | 'url', value: string): void;
  onSetPreviewUrl(url: string | null): void;
  onCheckPreview(url: string): Promise<{ ok: boolean; status?: number; error?: string }>;
  /** Marco 1: prévia dos arquivos do projeto (servidor da HQ em outra origem, só leitura). */
  onLocalPreview?(): Promise<{ url: string; entry: string } | { error: string }>;
}

export interface PreviewPaneProps {
  url: string | null;
  onOpenTab(url: string): void;
}

export type PanelTab = 'chat' | 'activity' | 'files' | 'deliveries' | 'terminal';

export interface WorkerPanelProps {
  worker: Worker | null;
  session: Session | null;
  /** Funcionário dono do painel (identidade persistente); null para sessões observadas. */
  employee?: Employee | null;
  /** Conversas não arquivadas do funcionário, para o seletor (a ativa é employee.activeSessionId). */
  conversations?: Session[];
  tab: PanelTab;
  onTab(tab: PanelTab): void;
  onClose(): void;
  /** Recolhe o painel numa faixa estreita (a seleção continua). */
  onCollapse?(): void;
  onCloseSession(): void;
  onResumeSession(): void;
  onArchiveSession(): void;
  onSelectConversation?(sessionId: string): void;
  onNewConversation?(): void;
  onEditEmployee?(): void;
  onArchiveEmployee?(): void;
  /** "Dar tarefa": preenche o compositor "O que vamos fazer?" com este funcionário. */
  onGiveTask?(): void;
  /** Conversa particular com este funcionário (só entre o Chefe e ele, fora do mural e da fila). */
  onPrivateChat?(): void;
  chat: ChatViewProps;
  composer: ComposerProps;
  timeline: ActivityTimelineProps;
  files: FilesPanelProps;
  deliveries: DeliverablesPanelProps;
  /** O terminal integrado chega em etapa posterior; a aba mostra o aviso enquanto não existir. */
  terminal?: React.ReactNode;
}

export interface SidebarProps {
  rooms: Room[];
  projects: Project[];
  sessions: Session[];
  workers: Worker[];
  selectedRoomId: string | null;
  selectedSessionId: string | null;
  connected: boolean;
  serverInfo: ServerInfo | null;
  onSelectRoom(roomId: string): void;
  onSelectSession(sessionId: string): void;
  onNewSession(roomId: string, projectId: string | null): void;
  onAddProject(roomId: string): void;
  onEditRoom(roomId: string): void;
  onOpenSettings(): void;
}

export interface NewSessionDialogProps {
  open: boolean;
  room: Room | null;
  projects: Project[];
  /** Funcionário fixo (conversa dele). Null = escolher entre os funcionários da sala ou contratar um novo. */
  employee?: Employee | null;
  /** Funcionários ativos da sala (para o seletor quando `employee` é null). */
  roomEmployees?: Employee[];
  defaultProjectId: string | null;
  defaultModel: string | null;
  defaultPermissionMode: PermissionModeOption;
  /** Conversas pausadas/perdidas retomáveis (do funcionário, quando houver). */
  resumable: Session[];
  onCreate(input: { projectId: string; employeeId: string | null; name: string; model: string | null; permissionMode: PermissionModeOption; profileId: string | null }): void;
  onResume(sessionId: string): void;
  onAddProject(): void;
  onCancel(): void;
}

export interface AddProjectDialogProps {
  open: boolean;
  rooms: Room[];
  defaultRoomId: string | null;
  onCreate(input: { name: string; path: string; roomId: string }): Promise<{ ok: boolean; error?: string }>;
  onCancel(): void;
}

export interface RoomEditorProps {
  open: boolean;
  room: Room | null;
  onSave(patch: Partial<Omit<Room, 'id'>>): void;
  onCancel(): void;
}

export interface SettingsDialogProps {
  /** Central de Redes (contas sociais), mostrada na aba Conexões. */
  socialSection?: React.ReactNode;
  open: boolean;
  /** Aba mostrada ao abrir (padrão 'general'); a tela de Reuniões abre direto em 'ai'. */
  initialTab?: 'general' | 'ai' | 'data';
  settings: Settings;
  serverInfo: ServerInfo | null;
  /** As preferências de IA vão em patch.ai = { claude: {model, effort}, openai: {model, effort} }. */
  onSave(patch: Partial<Settings>): void;
  onCancel(): void;
  // Aba "Conexões" (id 'ai'; todas opcionais; sem `ai` a aba diz que o estado dos provedores ainda não carregou).
  /** Estado real dos provedores (Snapshot.ai / mensagem ai.status). */
  ai?: AiProviderStatus[];
  /** Redescobre instalação, login e catálogo com chamadas reais (nunca automático a cada clique de seletor). */
  onAiRefresh?(provider: AiProviderId): Promise<void>;
  /** Turno real de teste com o modelo/esforço escolhidos no cartão. */
  onAiTest?(provider: AiProviderId, model: string | null, effort: EffortLevel | null): Promise<AiTestResult>;
  /** Fluxo de login oficial (Codex): devolve a URL para abrir no navegador. */
  onAiLoginStart?(provider: AiProviderId): Promise<{ url: string | null; detail: string }>;
  onAiLoginCancel?(provider: AiProviderId): void;
  onOpenExternal?(url: string): void;
  // Cartão "Serviço da HQ" (todas opcionais; o cartão só aparece quando `connection` é informada).
  /** Estado da conexão desta aba com o serviço (ConnectionState do cliente). */
  connection?: 'connecting' | 'open' | 'closed' | 'unauthorized';
  /** Momento do último snapshot completo recebido. */
  lastSnapshotAt?: number | null;
  /** Resposta de service.status (store.serviceStatus); null = ainda não carregado. */
  service?: ServiceStatus | null;
  onReconnect?(): void;
  /** Pede service.status de novo. */
  onRefreshService?(): Promise<void>;
  /** service.pause: a fila não despacha nada novo; o que está rodando termina. */
  onServicePause?(paused: boolean): void;
  /** service.autostart: registra/remove a tarefa agendada "MilWeb HQ" do Windows. */
  onServiceAutostart?(enabled: boolean): Promise<void>;
  onServiceOpenLogs?(): void;
  /** service.shutdown (o cartão pede confirmação antes). */
  onServiceShutdown?(): void;
  /** Marco 0: cartão "Dados" (banco em uso, contagens, backups e exclusões recentes). */
  onDataInfo?(): Promise<import('@milweb-hq/protocol').DataInfo>;
  onBackupNow?(): Promise<{ file: string; info: import('@milweb-hq/protocol').DataInfo }>;
}

export interface StatusBarProps {
  /** Fila por equipe ("Aurora 1 · Tuco Dev 2"); a fila e o limite continuam únicos. */
  queuedByTeam?: string | null;
  /** Conversas particulares rodando agora (fora da fila e do limite de execução). */
  dmRunning?: number;
  connected: boolean;
  serverInfo: ServerInfo | null;
  activeCount: number;
  /** Turnos de reunião rodando agora (ocupam a mesma vaga das tarefas). */
  meetingTurns?: number;
  queuedCount: number;
  rateLimit?: ActivityState['rateLimit'];
  attachments?: Attachment[];
  /** Atalhos da vista atual (v4): ficam aqui, numa linha própria, em vez de cobrir o mapa. */
  hint?: string | null;
}
