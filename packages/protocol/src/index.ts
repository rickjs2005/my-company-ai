// Contrato compartilhado entre servidor e frontend da MilWeb HQ.
// Tudo aqui descreve estado REAL (processos, sessões, eventos do Claude Code). Nada decorativo entra neste contrato.

// Importações só de tipos (apagadas na compilação): o frontend nunca carrega process.ts (node:child_process).
import type { ActivityState, LogEntry, WorkerPhase } from '@milweb-hq/claude-bridge/activity';
import type { PermissionRequest, PermissionUpdate, ProcessState } from '@milweb-hq/claude-bridge/types';
export type { ActivityState, LogEntry, WorkerPhase } from '@milweb-hq/claude-bridge/activity';
export type { PermissionRequest, PermissionUpdate, ProcessState } from '@milweb-hq/claude-bridge/types';
import type { Folder, FsClientMessage, FsServerMessage } from './fs.js';
export * from './fs.js';
import type { AiClientMessage, AiProviderId, AiProviderStatus, AiServerMessage, AiSettings, EffortLevel } from './ai.js';
import { DEFAULT_AI_SETTINGS } from './ai.js';
export * from './ai.js';
import type { Meeting, MeetingClientMessage, MeetingServerMessage } from './meetings.js';
export * from './meetings.js';
import type { AbsencePolicy, EmployeeAgentRef, RoleTemplate, Routine, SkillUsage, WorkClientMessage, WorkServerMessage } from './work.js';
import { DEFAULT_ABSENCE } from './work.js';
export * from './work.js';
import type { SocialClientMessage, SocialServerMessage, SocialState } from './social.js';
export * from './social.js';
import type { ContentClientMessage, ContentServerMessage, ContentState } from './content.js';
import type { DeskClientMessage, DeskServerMessage, DeskState } from './desk.js';
export * from './desk.js';
import type { KnowledgeBoard, KnowledgeClientMessage, KnowledgeServerMessage } from './knowledge.js';
export * from './knowledge.js';
export * from './intake.js';
export * from './content.js';

/** 'direction' = Diretoria (sala do Chefe; não recebe funcionários por padrão). 'meeting' = Reuniões (Chefe + Claude + ChatGPT). */
export type RoomKind = 'dev' | 'social' | 'design' | 'research' | 'management' | 'direction' | 'meeting' | 'custom';

export interface EditorialProfile {
  id: string;
  name: string;
  instructions: string;
}

export interface Room {
  id: string;
  slug: string;
  name: string;
  kind: RoomKind;
  /** Instruções editáveis, anexadas ao sistema de cada sessão nova desta sala. */
  instructions: string;
  /** Só na sala de Social Media: perfis editoriais separados (Aurora, Tuco Dev). */
  profiles: EditorialProfile[];
  color: string;
  order: number;
}

export interface Project {
  id: string;
  name: string;
  /** Pasta local real; é a referência dos arquivos. Sem cópias. */
  path: string;
  roomId: string;
  previewUrl?: string | null;
  createdAt: number;
  lastUsedAt: number;
  /** Marco 1 (armário de projetos): favorito, cliente e imagem de capa (caminho local; opcional). */
  favorite?: boolean;
  client?: string | null;
  imagePath?: string | null;
}

export type SessionStatus =
  | 'new'        // criada, processo ainda não iniciado (não consome nada)
  | 'active'     // processo vivo e controlável
  | 'paused'     // processo encerrado; pode ser retomada com --resume
  | 'observed'   // sessão iniciada fora da HQ, apenas observada
  | 'lost'       // processo morreu sem ser pedido
  | 'archived';

export type PermissionModeOption = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk';

/**
 * Funcionário = identidade persistente (nome, aparência, função, sala, instruções). Não é evidência de execução:
 * o que executa é a conversa ativa (Session) e seu processo. Fica igual quando o processo é fechado para liberar memória.
 */
export interface Employee {
  id: string;
  name: string;
  role: string;
  roomId: string;
  appearance: { skin: number; hair: number; shirt: number };
  deskIndex: number;
  /** Instruções de atuação; entram no system prompt só de conversas NOVAS (o Claude Code não aceita mudar depois). */
  instructions: string;
  /** Perfil editorial padrão para conversas novas (só faz sentido em salas com perfis, ex.: Social Media). */
  profileId: string | null;
  model: string | null;
  /** Esforço (--effort) para conversas novas; null = padrão global/CLI. Só vale em processo novo. */
  effort: EffortLevel | null;
  permissionMode: PermissionModeOption;
  /** Conversa (sessão) selecionada; null = funcionário sem conversa aberta. */
  activeSessionId: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Provedor que executa as conversas deste funcionário: Claude (Claude Code) ou OpenAI (Codex). */
  provider: AiProviderId;
  /** Skills preferidas (invocações), sugeridas no compositor; nenhuma é ativada sozinha. */
  skills: string[];
  /** Definição nativa de agente de que o funcionário foi importado (null = perfil criado na HQ). */
  agent: EmployeeAgentRef | null;
  /** Modelo de papel usado na contratação (id do RoleTemplate) ou null. */
  template: string | null;
  /** Marco 0: o que este funcionário herda da conta do Chefe (MCP). GitHub, git push e Vercel ficam bloqueados para todos. */
  access: EmployeeAccess;
}

/**
 * Evidência do provedor para uma tarefa. O Claude Code 2.1.316 informa no init o modelo, o modo de permissão e os servidores
 * MCP carregados; NÃO informa esforço nem Ultracode (esses ficam como "enviado, não confirmado").
 */
export interface TaskEvidence {
  source: 'init do Claude Code' | 'processo já aberto' | 'Codex';
  model: string | null;
  permissionMode: string | null;
  mcpServers: string[];
  cliVersion: string | null;
  at: number;
  /** Flags enviadas ao iniciar o processo (sem confirmação do CLI). */
  sentEffort: string | null;
  sentUltracode: boolean;
}

/** Política de acesso do funcionário. mcp 'none' = nenhum servidor MCP (padrão); 'inherit' = todos os do usuário. */
export interface EmployeeAccess {
  mcp: 'none' | 'inherit';
  /** Navegador da HQ (contas sociais pela interface dos sites). Só funcionários com isto recebem as ferramentas de navegador. */
  browser?: boolean;
  /** Pesquisa na web só leitura (WebSearch e WebFetch sem pedir autorização a cada busca). Dado ao pesquisador do Radar. */
  web?: boolean;
}

/** Registro de exclusão/restauração (Marco 0): toda remoção pela HQ deixa rastro com origem. */
export interface AuditEntry {
  id: number;
  at: number;
  /** 'excluir' | 'restaurar' | 'apagar de vez' | 'arquivar' | 'desarquivar' | 'remover da HQ' | 'enviar para a lixeira' | ... */
  action: string;
  /** 'reunião' | 'projeto' | 'sala' | 'rotina' | 'pasta' | 'funcionário' | 'conversa' | 'arquivo' */
  entity: string;
  entityId: string | null;
  title: string | null;
  /** 'interface' (pedido da tela) | 'sistema' (limpeza automática) | 'rotina' ... */
  origin: string;
  detail: string | null;
}

/** Identidade e saúde do banco em uso (cartão "Dados" em Ajustes). */
export interface DataInfo {
  dataDir: string;
  dbFile: string;
  schemaVersion: number;
  sizeBytes: number;
  counts: Record<string, number>;
  lastBackup: { file: string; at: number; kind: 'auto' | 'manual' | 'migração' } | null;
  backupsKept: number;
  recentAudit: AuditEntry[];
}

export interface Session {
  id: string;                 // id do app (uuid)
  claudeSessionId: string | null; // id real do Claude Code (chega no system/init)
  /** Provedor da conversa (herdado do funcionário na criação). */
  provider?: AiProviderId;
  /** Thread real do Codex (funcionário OpenAI); null até o primeiro turno. */
  threadId?: string | null;
  /** Funcionário dono da conversa (null só em sessões observadas, que não pertencem à equipe). */
  employeeId: string | null;
  roomId: string;
  projectId: string;
  profileId?: string | null;
  name: string;               // nome da sessão (--name)
  model?: string | null;
  /** Esforço aplicado ao iniciar o processo (--effort); mudar só vale no próximo processo. */
  effort?: EffortLevel | null;
  permissionMode: PermissionModeOption;
  status: SessionStatus;
  controllable: boolean;      // false para sessões observadas
  processState: ProcessState | null;
  activity: ActivityState;
  createdAt: number;
  lastActiveAt: number;
  claudeVersion?: string | null;
  /** Último erro de processo (spawn falhou, saiu com código != 0). */
  lastError?: string | null;
  /** Ultracode (configuração do Claude Code, não é nível de esforço) pedido ao iniciar o processo desta conversa. */
  ultracode?: boolean;
}

/** Estado real de um funcionário, derivado da conversa ativa e do seu processo (nunca de animação). */
export type WorkerStatus = 'idle' | 'queued' | 'running' | 'waiting_answer' | 'waiting_permission' | 'paused' | 'interrupted' | 'error' | 'observed';

/**
 * Personagem na cena. 'employee' = funcionário cadastrado (id = employee.id; sessionId = conversa ativa ou null).
 * 'observed' = sessão iniciada fora da HQ (id = id da sessão observada), só acompanhada, sem botões de comando.
 */
export interface Worker {
  id: string;
  kind: 'employee' | 'observed';
  employeeId: string | null;
  sessionId: string | null;
  roomId: string;
  projectId: string | null;
  name: string;      // nome do personagem (ex.: "Léo")
  role: string;      // função (ex.: "Desenvolvimento")
  appearance: { skin: number; hair: number; shirt: number };
  deskIndex: number;
  phase: WorkerPhase;
  detail: string;
  status: WorkerStatus;
  controllable: boolean;
  busy: boolean;
}

export type TaskStatus = 'queued' | 'running' | 'waiting_permission' | 'waiting_answer' | 'done' | 'error' | 'interrupted' | 'lost';

export interface Attachment {
  name: string;
  mediaType: string;
  /** Caminho local salvo pelo servidor (as imagens vão para o CLI como base64; o arquivo fica só para o histórico). */
  storedPath?: string;
  sizeBytes: number;
}

export interface Deliverable {
  id: string;
  taskId: string;
  kind: 'file' | 'url' | 'text';
  title: string;
  path?: string;      // arquivo real (absoluto)
  url?: string;
  text?: string;
  changeType?: 'created' | 'modified' | 'deleted' | 'unknown';
  createdAt: number;
}

export interface Task {
  id: string;
  sessionId: string;
  projectId: string;
  roomId: string;
  profileId?: string | null;
  prompt: string;
  attachments: Attachment[];
  status: TaskStatus;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  resultText?: string | null;
  resultSubtype?: string | null;
  terminalReason?: string | null;
  errors: string[];
  durationMs?: number | null;
  numTurns?: number | null;
  costUsd?: number | null;
  deliverables: Deliverable[];
  /** Arquivos tocados por Write/Edit durante a tarefa (evidência real, caminho absoluto). */
  touchedFiles: string[];
  /** Criada em espera (ex.: pela reunião, "criar sem iniciar"): fica na fila mas não é despachada até task.release. */
  held?: boolean;
  /** Motivo de estar em espera quando a HQ segurou a tarefa (ex.: fora do escopo do modo ausente). */
  heldReason?: string | null;
  /** Reunião que originou a tarefa, quando houver. */
  meetingId?: string | null;
  /** Funcionário responsável (dono da conversa no momento da criação). */
  employeeId?: string | null;
  /** Provedor que executa (claude | openai). */
  provider?: AiProviderId;
  /** Skill pedida e a confirmação observada (null = automática). */
  skill?: SkillUsage | null;
  /** Tentativa (1 = primeira). Reexecuções criam tarefa nova com attempt + 1 e `retryOf`. */
  attempt?: number;
  retryOf?: string | null;
  /** "Planejar antes": o pedido foi enviado em modo plano. */
  plan?: boolean;
  /** Configuração pedida e a realmente aplicada (modelo/esforço/modo), para nunca trocar em silêncio. */
  requested?: { model: string | null; effort: EffortLevel | null; permissionMode: string | null; ultracode?: boolean } | null;
  applied?: { model: string | null; effort: EffortLevel | null; permissionMode: string; source: string; ultracode?: boolean } | null;
  /** O que o processo do provedor CONFIRMOU para esta tarefa (evento init do Claude Code). Só o que aparece aqui é "confirmado". */
  evidence?: TaskEvidence | null;
  /** Arquivos de contexto escolhidos pelo Chefe (caminhos relativos ao projeto; vão por referência, sem cópia). */
  contextFiles?: string[];
  /** Conta de destino da peça (cartão da central de Redes). Fica gravada: trocar o perfil na tela não muda tarefas já criadas. */
  destinationId?: string | null;
  /** 'to_verify' = o processo morreu depois de possivelmente alterar arquivos; conferir antes de reexecutar. 'verified' = o Chefe conferiu. */
  review?: 'to_verify' | 'verified' | null;
  /** Rotina que criou a tarefa, quando houver. */
  routineId?: string | null;
  /** Origem da criação. */
  origin?: 'chat' | 'composer' | 'meeting' | 'routine' | 'retry';
}

/** Itens do chat persistidos (deltas de streaming não são persistidos; só o texto final). */
export type ChatItem =
  | { id: string; ts: number; taskId: string; kind: 'user'; text: string; attachments: Attachment[]; /** Mensagem do Chefe no meio da tarefa (entra no próximo passo, sem interromper). */ steer?: boolean }
  /** `author` = provedor que escreveu (ausente = Claude, por compatibilidade com o histórico antigo). */
  | { id: string; ts: number; taskId: string; kind: 'assistant'; text: string; author?: AiProviderId }
  | { id: string; ts: number; taskId: string; kind: 'tool'; toolUseId: string; name: string; summary: string; input: Record<string, unknown>; output?: string; isError?: boolean; done: boolean }
  | { id: string; ts: number; taskId: string; kind: 'permission'; requestId: string; toolName: string; summary: string; input: Record<string, unknown>; decision?: 'allow' | 'deny'; message?: string }
  | { id: string; ts: number; taskId: string; kind: 'question'; requestId: string; questions: QuestionSpec[]; answers?: Record<string, string> }
  | { id: string; ts: number; taskId: string; kind: 'result'; status: TaskStatus; summary: string; durationMs?: number; numTurns?: number; costUsd?: number }
  | { id: string; ts: number; taskId: string; kind: 'notice'; text: string; level: 'info' | 'warn' | 'error' };

export interface QuestionSpec {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: { label: string; description: string; preview?: string }[];
}

export interface PendingPermission {
  sessionId: string;
  taskId: string | null;
  request: PermissionRequest;
  /** true quando é AskUserQuestion (resposta via answers). */
  isQuestion: boolean;
  questions?: QuestionSpec[];
}

export interface ServerInfo {
  version: string;
  claudeExePath: string | null;
  claudeVersion: string | null;
  authOk: boolean | null;
  authDetail?: string | null;
  apiKeyInEnv: boolean;
  dataDir: string;
  maxParallel: number;
  startedAt: number;
}

export interface Settings {
  maxParallel: number;          // execuções simultâneas (padrão 1)
  defaultModel: string | null;  // null = padrão do Claude Code
  defaultPermissionMode: PermissionModeOption;
  reducedMotion: boolean;
  soundEnabled: boolean;
  idleCloseMinutes: number;     // fecha o processo ocioso após N minutos (0 = nunca)
  /** Padrões globais de modelo/esforço por provedor (Configurações → Inteligência artificial). */
  ai: AiSettings;
  /** Modo ausente: o que pode continuar sem o Chefe (política aplicada no executor, nunca "desligando permissões"). */
  absence: AbsencePolicy;
  /** Pausa de novas tarefas (o que está rodando termina; a fila espera). */
  pauseNewTasks: boolean;
  /** Tentativas máximas por tarefa quando o processo morre sem ter alterado arquivos. */
  maxAttempts: number;
  /** Duração máxima de uma tarefa em minutos (0 = sem limite); ao estourar, a HQ interrompe e registra. */
  maxTaskMinutes: number;
  /** Modelos de papel editáveis usados em "Contratar funcionário". */
  roleTemplates: RoleTemplate[];
  /** Último momento em que havia uma interface conectada (para "Enquanto você esteve fora"). */
  lastSeenAt: number | null;
  /** Onboarding de primeiro uso concluído/dispensado. */
  onboardingDone: boolean;
}

export interface FileNode { name: string; path: string; type: 'file' | 'dir'; size?: number; mtime?: number; children?: FileNode[] }
export interface GitStatusEntry { path: string; status: string }

// ---------------- Mensagens cliente → servidor ----------------
/** Nome da sessão da conversa particular (Chefe e um funcionário). Tarefas de trabalho nunca usam esta sessão, e ela não espera
 *  a fila de execuções: uma pergunta do Chefe não fica atrás de um render de 15 minutos. */
export const DM_SESSION_NAME = 'Conversa particular com o Chefe';
export const isDmSession = (s: { name: string } | null | undefined): boolean => s?.name === DM_SESSION_NAME;

export type ClientMessage =
  | { type: 'hello'; token: string; lastSeq?: number }
  | { type: 'room.create'; room: Omit<Room, 'id' | 'order'> }
  | { type: 'room.update'; id: string; patch: Partial<Omit<Room, 'id'>> }
  | { type: 'room.delete'; id: string }
  | { type: 'project.create'; reqId: string; name: string; path: string; roomId: string }
  | { type: 'project.update'; id: string; patch: Partial<Pick<Project, 'name' | 'roomId' | 'previewUrl' | 'favorite' | 'client' | 'imagePath'>> }
  | { type: 'project.delete'; id: string }
  | { type: 'employee.create'; reqId: string; roomId: string; name?: string; role?: string; appearance?: Employee['appearance']; instructions?: string; profileId?: string | null; model?: string | null; effort?: EffortLevel | null; permissionMode?: PermissionModeOption; provider?: AiProviderId; skills?: string[]; agent?: EmployeeAgentRef | null; template?: string | null; access?: EmployeeAccess }
  | { type: 'employee.update'; id: string; patch: Partial<Pick<Employee, 'name' | 'role' | 'roomId' | 'appearance' | 'instructions' | 'profileId' | 'model' | 'effort' | 'permissionMode' | 'provider' | 'skills' | 'agent' | 'template' | 'access'>> }
  /** Arquivar não apaga arquivos nem histórico; as conversas do funcionário ficam guardadas. */
  | { type: 'employee.archive'; id: string }
  | { type: 'employee.unarchive'; id: string }
  | { type: 'employee.setActiveSession'; id: string; sessionId: string | null }
  /** Cria uma conversa. Com employeeId, a conversa é do funcionário (instruções dele + sala + perfil no system prompt); sem, cria um funcionário novo na sala. */
  | { type: 'session.create'; reqId: string; roomId: string; projectId: string; employeeId?: string | null; profileId?: string | null; name?: string; model?: string | null; effort?: EffortLevel | null; permissionMode?: PermissionModeOption }
  | { type: 'session.resume'; sessionId: string }
  | { type: 'session.close'; sessionId: string }
  | { type: 'session.archive'; sessionId: string }
  /** Conversa particular com um funcionário (só entre o Chefe e ele): abre ou reaproveita a sessão própria, separada das tarefas. */
  | { type: 'employee.dm.open'; reqId: string; employeeId: string }
  | { type: 'session.interrupt'; sessionId: string }
  | { type: 'session.setModel'; sessionId: string; model: string | null }
  /** Vale no próximo processo da sessão (o CLI não troca esforço num processo já aberto pela HQ). */
  | { type: 'session.setEffort'; sessionId: string; effort: EffortLevel | null }
  | { type: 'session.setPermissionMode'; sessionId: string; mode: PermissionModeOption }
  | { type: 'session.setProfile'; sessionId: string; profileId: string | null }
  | { type: 'prompt.send'; reqId: string; clientId: string; sessionId: string; text: string; attachments?: { name: string; mediaType: string; dataBase64: string }[]; mode: 'send' | 'queue' | 'interrupt' }
  /** Falar com o funcionário no meio da tarefa: entra no próximo passo do turno em andamento; sem turno, vira pedido na fila. Resposta: SteerResult. */
  | { type: 'prompt.steer'; reqId: string; clientId: string; sessionId: string; text: string }
  | { type: 'task.cancelQueued'; taskId: string }
  | { type: 'permission.respond'; sessionId: string; requestId: string; behavior: 'allow' | 'deny'; message?: string; remember?: PermissionUpdate[] }
  | { type: 'question.answer'; sessionId: string; requestId: string; answers: Record<string, string> }
  | { type: 'chat.history'; reqId: string; sessionId: string; limit?: number }
  | { type: 'events.history'; reqId: string; sessionId: string; limit?: number }
  | { type: 'files.tree'; reqId: string; projectId: string; path?: string; depth?: number }
  | { type: 'files.read'; reqId: string; projectId: string; path: string }
  | { type: 'git.status'; reqId: string; projectId: string }
  | { type: 'git.diff'; reqId: string; projectId: string; path?: string }
  | { type: 'preview.check'; reqId: string; url: string }
  /** Marco 1: URL da prévia local do projeto (servidor da HQ em outra origem, só leitura). */
  | { type: 'preview.local'; reqId: string; projectId: string }
  | { type: 'settings.update'; patch: Partial<Settings> }
  | { type: 'external.refresh' }
  /** Abre fora da HQ: pasta no Explorador, arquivo no programa padrão do Windows, arquivo selecionado na pasta (reveal) ou URL. */
  | { type: 'open.external'; target: 'folder' | 'file' | 'reveal' | 'url'; value: string }
  /** Visualizador da HQ: confere que o arquivo existe numa pasta cadastrada e devolve a URL (imagem, vídeo) ou o texto. */
  | { type: 'file.view'; reqId: string; path: string }
  | FsClientMessage
  | MeetingClientMessage
  | AiClientMessage
  | WorkClientMessage
  | SocialClientMessage
  | ContentClientMessage
  | DeskClientMessage
  | KnowledgeClientMessage;

/** Arquivo aberto no visualizador da HQ. A URL é da prévia local (outra origem, só leitura); texto vem inteiro até 512 KB. */
export type FileViewKind = 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'other';
export interface FileView {
  path: string;
  name: string;
  kind: FileViewKind;
  size: number;
  mtime: number;
  url: string | null;
  text: string | null;
  truncated: boolean;
}

// ---------------- Mensagens servidor → cliente ----------------
export interface Snapshot {
  serverInfo: ServerInfo;
  settings: Settings;
  rooms: Room[];
  projects: Project[];
  folders: Folder[];
  employees: Employee[];       // inclui arquivados (archivedAt != null)
  sessions: Session[];
  workers: Worker[];
  tasks: Task[];               // recentes (últimas 200)
  pendingPermissions: PendingPermission[];
  /** Reuniões (com participantes); histórico de cada uma é carregado sob demanda (meeting.history). */
  meetings: Meeting[];
  /** Estado real dos provedores de IA (último conhecido; ai.refresh redescobre). */
  ai: AiProviderStatus[];
  /** Rotinas cadastradas pelo Chefe. */
  routines: Routine[];
  /** Contas sociais (identidade, estado e capacidades; nunca credenciais). Ausente em serviços sem o módulo social. */
  social?: SocialState;
  /** Trabalho de conteúdo da sala Social Media (radar, calendário, peças, resultados). Ausente sem o módulo. */
  content?: ContentState;
  /** Mesa do Chefe: entregas e bloqueios persistidos (perguntas vêm de pendingPermissions). */
  desk?: DeskState;
  /** Conhecimento da equipe (orientações persistidas e usos recentes). */
  knowledge?: KnowledgeBoard;
  /** Momento em que o servidor montou este retrato (a interface mostra "último estado conhecido" ao desconectar). */
  snapshotAt: number;
  seq: number;
}

export type ServerMessage =
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'reply'; reqId: string; ok: true; data: unknown }
  /** code/data: erro estruturado (ex.: 'in_use' com a lista de execuções dependentes). */
  | { kind: 'reply'; reqId: string; ok: false; error: string; code?: string; data?: unknown }
  | { kind: 'error'; message: string }
  | { kind: 'entity'; entity: 'room' | 'project' | 'folder' | 'employee' | 'session' | 'worker' | 'task' | 'meeting'; op: 'upsert' | 'delete'; item: Room | Project | Folder | Employee | Session | Worker | Task | Meeting | { id: string } }
  | { kind: 'session.activity'; sessionId: string; activity: ActivityState; processState: ProcessState | null; worker: Worker }
  | { kind: 'event'; seq: number; sessionId: string; taskId: string | null; entry: LogEntry }
  | { kind: 'chat.delta'; sessionId: string; taskId: string; text: string }
  | { kind: 'chat.item'; sessionId: string; item: ChatItem }
  | { kind: 'permission.request'; pending: PendingPermission }
  | { kind: 'permission.resolved'; sessionId: string; requestId: string; behavior: 'allow' | 'deny' }
  | { kind: 'settings'; settings: Settings }
  | { kind: 'serverInfo'; serverInfo: ServerInfo }
  /** Sessões iniciadas fora da HQ (observadas) e seus projetos virtuais; substitui o conjunto anterior. */
  | { kind: 'external'; sessions: Session[]; workers: Worker[]; projects: Project[] }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | FsServerMessage
  | MeetingServerMessage
  | AiServerMessage
  | WorkServerMessage
  | SocialServerMessage
  | ContentServerMessage
  | DeskServerMessage
  | KnowledgeServerMessage;

/** Modelos de papel padrão (editáveis em Ajustes). As skills citadas só valem se existirem no catálogo da máquina. */
export const DEFAULT_ROLE_TEMPLATES: RoleTemplate[] = [
  { id: 'dev', name: 'Desenvolvedor(a)', role: 'Desenvolvimento', roomKind: 'dev', permissionMode: 'default', preferredSkills: ['sistema-web', 'site-institucional', 'seo-engineering', 'humanizar-site'],
    instructions: 'Você desenvolve sites, landing pages e sistemas da Aurora. Entregue código funcionando, rode os testes que existirem e diga como abrir o resultado localmente. Não faça commit, push ou deploy sem pedido explícito.' },
  { id: 'social', name: 'Social media', role: 'Social Media', roomKind: 'social', permissionMode: 'acceptEdits', preferredSkills: ['social', 'milweb-video-studio'],
    instructions: 'Você produz pautas, roteiros, legendas e carrosséis. Salve cada entrega como arquivo Markdown na pasta do projeto, com nome descritivo e data. Nunca publique nada.' },
  { id: 'design', name: 'Designer', role: 'Design e Vídeo', roomKind: 'design', permissionMode: 'acceptEdits', preferredSkills: ['milweb-video-studio'],
    instructions: 'Você cuida de briefings, interfaces, materiais visuais e projetos de vídeo. Descreva o que produziu e onde salvou.' },
  { id: 'research', name: 'Pesquisador(a)', role: 'Pesquisa e Prospecção', roomKind: 'research', permissionMode: 'default', preferredSkills: ['prospeccao-internacional'],
    instructions: 'Você pesquisa empresas, mercados e oportunidades e prepara abordagens. Nunca envie mensagens a terceiros: só prepare o material e cite as fontes.' },
  { id: 'reviewer', name: 'Revisor(a)', role: 'Gestão e Revisão', roomKind: 'management', permissionMode: 'plan', preferredSkills: ['code-review', 'verify'],
    instructions: 'Você revisa entregas das outras salas com rigor: diga exatamente o que verificou, o que falhou e o que falta. Não altere arquivos a não ser que a tarefa peça.' },
];

export const DEFAULT_SETTINGS: Settings = {
  maxParallel: 1,
  defaultModel: null,
  defaultPermissionMode: 'default',
  reducedMotion: false,
  soundEnabled: true,
  idleCloseMinutes: 30,
  ai: DEFAULT_AI_SETTINGS,
  absence: DEFAULT_ABSENCE,
  pauseNewTasks: false,
  maxAttempts: 2,
  maxTaskMinutes: 0,
  roleTemplates: DEFAULT_ROLE_TEMPLATES,
  lastSeenAt: null,
  onboardingDone: false,
};

export const PROTOCOL_VERSION = 4;
export * from './teams.js';
