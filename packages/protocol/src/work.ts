// Trabalho diário no My Company AI (v4): entrada única de tarefa, catálogo de skills, agentes nativos descobertos,
// rotinas, serviço em segundo plano, modo ausente e resumo de ausência. Tudo descreve estado REAL verificado pelo
// servidor; "skill solicitada" e "ativação confirmada" são registradas separadamente, com a evidência observada.
import type { AiProviderId, EffortLevel } from './ai.js';

// ---------------- Skills ----------------

/** De onde a skill veio. 'bundled' = embutida no Claude Code (só aparece na lista do init, sem arquivo local conhecido). */
export type SkillSource = 'personal' | 'project' | 'nested' | 'plugin' | 'synced' | 'bundled';

export interface SkillInfo {
  /** Chave única no catálogo (origem + invocação + caminho). */
  id: string;
  /** Nome como o Claude Code invoca (`/nome` ou `/plugin:nome`). */
  invocation: string;
  name: string;
  description: string;
  /** Campo when_to_use do frontmatter (quando usar), se houver. */
  whenToUse: string | null;
  /** argument-hint do frontmatter (o que a skill espera receber). */
  argumentHint: string | null;
  /** Argumentos nomeados declarados em `arguments:`. */
  arguments: string[];
  source: SkillSource;
  /** Caminho real do SKILL.md (null para skills embutidas). */
  path: string | null;
  /** Plugin de origem (ex.: 'superpowers@claude-plugins-official'), quando for de plugin. */
  plugin: string | null;
  /** Projeto da HQ a que a skill pertence (skills de projeto/aninhadas); null = vale para todos. */
  projectId: string | null;
  /** Desativada por skillOverrides ('off'): o Claude Code não a lista nem a invoca. */
  disabled: boolean;
  /** Valor do skillOverrides aplicado ('on' quando ausente). */
  override: 'on' | 'name-only' | 'user-invocable-only' | 'off';
  /** false quando `disable-model-invocation: true` (só o Chefe pode chamar). */
  modelInvocable: boolean;
  /** false quando `user-invocable: false` (não aparece no menu de barra; só o Claude usa). */
  userInvocable: boolean;
  allowedTools: string[];
  model: string | null;
  effort: EffortLevel | null;
  /** `context: fork` roda num subagente. */
  forks: boolean;
  /** O conteúdo tem comandos de shell embutidos que o Claude Code executa ao ativar a skill (a HQ NUNCA executa isso ao catalogar). */
  hasShellInjection: boolean;
  /** Outra skill de prioridade maior tem o mesmo nome (pessoal > projeto): esta não é a que o Claude Code carrega. */
  shadowedBy: string | null;
  /** Como cada provedor recebe a skill. */
  providers: Record<AiProviderId, SkillProviderSupport>;
  /** Verificação real: a skill apareceu na lista `skills` do último init do Claude Code neste projeto? */
  verified: { listed: boolean; at: number } | null;
  /** Problemas de formato encontrados ao ler o SKILL.md (frontmatter inválido, nome ausente...). */
  problems: string[];
  /** 'command' = arquivo .md de comandos/ (formato legado que o Claude Code trata como skill). */
  kind: 'skill' | 'command';
}

export type SkillProviderSupport =
  /** Invocação nativa (`/nome` no início da mensagem; o Claude Code expande a skill). */
  | { mode: 'native'; detail: string }
  /** O texto do SKILL.md vai como instrução identificada no pedido (o provedor não tem mecanismo de skill nesta versão). */
  | { mode: 'inject'; detail: string }
  | { mode: 'unavailable'; detail: string };

export interface SkillCatalog {
  skills: SkillInfo[];
  /** Raízes varridas (para a área técnica mostrar de onde veio a lista). */
  roots: { source: SkillSource; path: string; projectId: string | null; exists: boolean }[];
  scannedAt: number;
  /** Mensagens de aviso da varredura (plugin sem manifesto, link quebrado...). */
  warnings: string[];
}

/** Registro na tarefa: o que foi pedido e o que foi observado. Nunca presume ativação. */
export interface SkillUsage {
  requested: string;              // invocação (ex.: 'sistema-web')
  source: SkillSource | null;
  provider: AiProviderId;
  /** Como a HQ entregou a skill ao provedor. */
  delivery: 'native' | 'inject';
  /** Evidência observada: 'listed' = estava na lista skills do init do processo que executou; 'not_listed' = não estava
   *  (o provedor pode ter tratado a barra como texto); 'unknown' = o processo não informou a lista (ex.: OpenAI). */
  confirmation: 'pending' | 'listed' | 'not_listed' | 'unknown';
  evidence: string | null;
  checkedAt: number | null;
}

/** Resposta de skills.inspectLocal: validação de uma pasta de skill SEM copiar nada (prévia antes de "Adicionar skill local"). */
export interface SkillInspection {
  ok: boolean;
  /** Pasta que seria copiada (a que contém o SKILL.md). */
  sourceDir: string;
  name: string;
  description: string;
  problems: string[];
  hasShellInjection: boolean;
  /** Conteúdo bruto do SKILL.md, para o Chefe ler antes de adicionar. */
  content: string;
  /** Arquivos que acompanham a skill (relativos), para mostrar o que será copiado. */
  files: string[];
  totalBytes: number;
}

/** Resposta de skills.addLocal. */
export interface SkillAddResult { info: SkillInfo; destination: string }

/** Resposta de skills.read. */
export interface SkillFileContent { path: string; content: string }

// ---------------- Agentes nativos (definições em .claude/agents e plugins) ----------------

export type AgentSource = 'user' | 'project' | 'plugin';

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  source: AgentSource;
  path: string;
  plugin: string | null;
  projectId: string | null;
  /** Corpo do arquivo (system prompt do agente). */
  prompt: string;
  tools: string[] | null;
  disallowedTools: string[] | null;
  model: string | null;
  permissionMode: string | null;
  skills: string[];
  effort: EffortLevel | null;
  /** Campos do frontmatter que a HQ NÃO consegue aplicar num funcionário (ex.: mcpServers, hooks, memory), com o motivo. */
  unsupported: { field: string; reason: string }[];
  problems: string[];
}

/** Resposta de agents.list. */
export interface AgentCatalog {
  agents: AgentDefinition[];
  roots: { source: AgentSource; path: string; exists: boolean }[];
  warnings: string[];
}

/** Vínculo do funcionário com a definição nativa de que foi importado (só referência; o arquivo continua sendo a fonte). */
export interface EmployeeAgentRef {
  name: string;
  source: AgentSource;
  path: string;
  /** Ferramentas da definição aplicadas às conversas do funcionário via --tools (null = sem restrição). */
  tools: string[] | null;
  importedAt: number;
  /** O que a HQ não aplicou e por quê (mostrado no perfil). */
  unsupported: { field: string; reason: string }[];
}

// ---------------- Modelos de papel (contratação) ----------------

export interface RoleTemplate {
  id: string;
  name: string;
  role: string;
  roomKind: string;
  instructions: string;
  preferredSkills: string[];
  permissionMode: string;
}

// ---------------- Entrada única de tarefa ----------------

export interface TaskRunInput {
  reqId: string;
  /** Idempotência: o mesmo clientId nunca cria duas tarefas (duplo clique, reconexão, atualização da página). */
  clientId: string;
  text: string;
  projectId: string;
  employeeId: string;
  /** Invocação da skill (ex.: 'sistema-web', 'superpowers:brainstorming'); null = automática (o provedor decide). */
  skill: string | null;
  /** "Planejar antes": a conversa vai para o modo plano e o pedido pede plano, sem alterar arquivos. */
  plan: boolean;
  options?: { model?: string | null; effort?: EffortLevel | null; permissionMode?: string | null; ultracode?: boolean };
  attachments?: { name: string; mediaType: string; dataBase64: string }[];
  /** Fluxos da própria HQ (análise de vídeo, correção): até 30 imagens. Padrão: 10 (o que o campo de pedido aceita). */
  maxAttachments?: number;
  /** Marco 1: arquivos de contexto (caminhos relativos ao projeto), entregues por referência no pedido. */
  contextFiles?: string[];
  /** Sala Social Media: conta de destino (id do cartão em Redes). Validada no servidor e gravada na tarefa. */
  destinationId?: string | null;
  /** Sala Social Media: perfil editorial desta tarefa (Aurora, Tuco Dev). undefined = mantém o da conversa. */
  profileId?: string | null;
}

/** Resposta do task.run: o que foi criado de fato e onde acompanhar. */
export interface TaskRunResult {
  taskId: string;
  sessionId: string;
  employeeId: string;
  projectId: string;
  status: string;
  /** Posição na fila (1 = próxima) ou null quando já está em execução. */
  queuePosition: number | null;
  /** Por que está na fila (ex.: 'Léo está ocupado com outra tarefa'; 'limite de 1 execução ao mesmo tempo'). */
  queueReason: string | null;
  /** Conversa nova foi aberta para este projeto (true) ou a ativa foi reaproveitada (false). */
  newSession: boolean;
  /** Configuração realmente aplicada à conversa (modelo/esforço/modo), com a origem de cada valor. */
  applied: { model: string | null; effort: EffortLevel | null; permissionMode: string; source: string; ultracode?: boolean };
  /** Avisos honestos (ex.: skill entregue por texto no OpenAI; modo análise). */
  notes: string[];
  /** A tarefa já existia (mesmo clientId): nada novo foi criado. */
  duplicate: boolean;
}

// ---------------- Rotinas ----------------

/** `times` (opcional) = vários horários no mesmo dia (ex.: Radar às 10:00 e 17:00); `time` continua sendo o primeiro. */
export type RoutineSchedule =
  | { kind: 'daily'; time: string; times?: string[] }                       // 'HH:MM' em America/Sao_Paulo
  | { kind: 'weekly'; time: string; days: number[]; times?: string[] }      // 0 = domingo .. 6 = sábado
  | { kind: 'interval'; everyMinutes: number };

export type MissedPolicy = 'skip' | 'run_once';

export interface Routine {
  id: string;
  title: string;
  prompt: string;
  employeeId: string;
  projectId: string;
  skill: string | null;
  schedule: RoutineSchedule;
  timezone: string;             // sempre 'America/Sao_Paulo' nesta versão
  enabled: boolean;
  permissionMode: string | null;
  model: string | null;
  effort: EffortLevel | null;
  /** O que fazer quando o horário passou com o serviço desligado: pular ou rodar uma vez ao voltar (nunca acumula). */
  missedPolicy: MissedPolicy;
  lastRunAt: number | null;
  lastTaskId: string | null;
  nextRunAt: number | null;
  /** Último motivo de não execução (ex.: 'tarefa anterior ainda na fila'). */
  lastSkipReason: string | null;
  /** Fluxo da sala de conteúdo que monta o pedido na hora do disparo (Radar diário, análise semanal); null = pedido fixo. */
  workflow?: RoutineWorkflow | null;
  createdAt: number;
  updatedAt: number;
}

export type RoutineWorkflow = 'content.radar' | 'content.analise';

export type RoutineInput = Pick<Routine, 'title' | 'prompt' | 'employeeId' | 'projectId' | 'skill' | 'schedule' | 'enabled' | 'permissionMode' | 'model' | 'effort' | 'missedPolicy'> & { workflow?: RoutineWorkflow | null };

// ---------------- Serviço em segundo plano ----------------

export interface ServiceStatus {
  pid: number;
  startedAt: number;
  port: number;
  version: string;
  dataDir: string;
  logFile: string;
  /** Tarefa agendada do Windows "MilWeb HQ" registrada no usuário atual (inicia com o Windows, sem janela). */
  autostart: { supported: boolean; registered: boolean | null; detail: string | null; taskName: string };
  /** Pausa de novas tarefas: a fila não despacha nada novo; o que está rodando termina. */
  pauseNewTasks: boolean;
  /** Condições reais que o serviço consegue observar sobre a máquina. */
  machine: { platform: string; hostname: string; uptimeSec: number; onBattery: boolean | null; networkOnline: boolean | null };
  /** Como o serviço foi iniciado: janela do terminal (`start-hq.cmd --janela`), segundo plano pelo `start-hq.cmd`, ou tarefa agendada no logon. */
  launchMode: 'terminal' | 'background' | 'scheduled-task' | 'unknown';
  checkedAt: number;
  /** Filas suspensas agora por limite de uso ou falta de conexão com a API (vazio = nenhuma). */
  providerHolds?: { provider: AiProviderId; kind: 'usage_limit' | 'network'; until: number; reason: string }[];
}

// ---------------- Modo ausente ----------------

export interface AbsencePolicy {
  enabled: boolean;
  /** Projetos em que o trabalho pode continuar sem o Chefe (vazio = nenhum: tudo fica "Aguardando Chefe"). */
  allowedProjectIds: string[];
  /** Funcionários autorizados (vazio = todos os que tiverem tarefa em projeto permitido). */
  allowedEmployeeIds: string[];
  /** Limites: tarefas iniciadas na ausência, duração por tarefa, tentativas por tarefa. */
  maxTasks: number;
  maxTaskMinutes: number;
  maxAttempts: number;
  /** Momento em que o modo foi ligado (para contar tarefas e montar o resumo). */
  since: number | null;
  /** Rotinas podem disparar na ausência? (sempre dentro dos projetos permitidos). */
  allowRoutines: boolean;
}

export const DEFAULT_ABSENCE: AbsencePolicy = { enabled: false, allowedProjectIds: [], allowedEmployeeIds: [], maxTasks: 10, maxTaskMinutes: 90, maxAttempts: 2, since: null, allowRoutines: true };

// ---------------- Resumo de ausência ----------------

export interface AwaySummary {
  since: number;
  until: number;
  done: { taskId: string; sessionId: string; employee: string; project: string; title: string; finishedAt: number; files: number }[];
  failed: { taskId: string; sessionId: string; employee: string; project: string; title: string; status: string; error: string | null }[];
  waiting: { taskId: string | null; sessionId: string; employee: string; project: string; kind: 'permission' | 'question'; summary: string }[];
  toVerify: { taskId: string; sessionId: string; employee: string; project: string; title: string; note: string }[];
  queued: { taskId: string; sessionId: string; employee: string; project: string; title: string; held: boolean; heldReason: string | null }[];
  filesProduced: { path: string; taskId: string; changeType: string }[];
  routinesRun: { routineId: string; title: string; taskId: string; at: number }[];
}

// ---------------- Mensagens ----------------

export type WorkClientMessage =
  | ({ type: 'task.run' } & TaskRunInput)
  /** Reexecuta uma tarefa perdida/falha como nova tentativa (mesmo pedido, attempt + 1). */
  | { type: 'task.retry'; reqId: string; taskId: string }
  /** O Chefe conferiu uma tarefa "resultado a conferir". */
  | { type: 'task.markVerified'; taskId: string }
  | { type: 'skills.list'; reqId: string; projectId?: string | null; refresh?: boolean }
  /** Conteúdo bruto do SKILL.md (para o painel técnico e para a prévia antes de adicionar). */
  | { type: 'skills.read'; reqId: string; path: string }
  /** Valida uma pasta/arquivo de skill local SEM copiar nada (prévia: nome, descrição, problemas, conteúdo). */
  | { type: 'skills.inspectLocal'; reqId: string; path: string }
  /** Copia a skill validada para ~/.claude/skills/<nome> (pessoal) ou <projeto>/.claude/skills/<nome>. */
  | { type: 'skills.addLocal'; reqId: string; path: string; scope: 'personal' | 'project'; projectId?: string | null }
  | { type: 'agents.list'; reqId: string; projectId?: string | null }
  | { type: 'routine.create'; reqId: string; routine: RoutineInput }
  | { type: 'routine.update'; reqId: string; id: string; patch: Partial<RoutineInput> }
  | { type: 'routine.delete'; id: string }
  | { type: 'routine.runNow'; reqId: string; id: string }
  | { type: 'service.status'; reqId: string }
  | { type: 'service.autostart'; reqId: string; enabled: boolean }
  | { type: 'service.pause'; paused: boolean }
  /** Encerra o serviço de forma ordenada (processos fechados, conversas retomáveis). */
  | { type: 'service.shutdown' }
  | { type: 'service.openLogs' }
  /** Identidade do banco em uso, contagens, último backup e exclusões recentes. */
  | { type: 'service.dataInfo'; reqId: string }
  /** Backup consistente agora (VACUUM INTO em backups/). */
  | { type: 'service.backupNow'; reqId: string }
  | { type: 'away.summary'; reqId: string; since?: number | null };

export type WorkServerMessage =
  | { kind: 'routine'; op: 'upsert' | 'delete'; routine: Routine | { id: string } }
  | { kind: 'service.status'; status: ServiceStatus }
  /** Catálogo mudou (skill adicionada, init novo verificou a lista): a interface pede skills.list de novo. */
  | { kind: 'skills.changed' };
