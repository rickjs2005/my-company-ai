// Sala de reunião (v3): Chefe + os gerentes (Claude e ChatGPT) e/ou funcionários escolhidos (cada um fala com o próprio motor,
// Claude Code ou Codex). O servidor coordena os turnos; a autoria de cada fala é do adaptador que realmente respondeu. Nada aqui é simulado: estados de participante vêm do turno real em andamento.
import type { AiProviderId, AiProviderPrefs, EffortLevel } from './ai.js';
import type { SocialSlotId } from './social.js';

/** 'guided' = Conversa guiada (cada destinatário responde uma vez). 'debate' = Discutir a pauta (rodadas com revisão e síntese). */
export type MeetingMode = 'guided' | 'debate';
export type MeetingStatus = 'draft' | 'active' | 'paused' | 'ended';

export type ParticipantState =
  | 'available'      // disponível
  | 'waiting_turn'   // aguardando sua vez
  | 'responding'     // respondendo (turno real em andamento)
  | 'waiting_chefe'   // aguardando o Chefe
  | 'interrupted'    // turno interrompido pelo Chefe
  | 'unavailable'    // provedor indisponível (sem login, não instalado, falha)
  | 'away';          // fora da reunião: o provedor parou (limite de uso, modelo recusado); volta só quando o Chefe chamar

/**
 * Participante tirado da reunião pela HQ porque o provedor parou (limite de uso da assinatura, troca forçada de modelo,
 * modelo recusado). A conversa segue com quem ficou. Quando o motivo passa, a HQ pergunta ao Chefe (asking = true);
 * só ele chama de volta (meeting.participant.rejoin). A sessão/thread é mantida para a volta continuar a conversa.
 */
export interface ParticipantAway {
  /**
   * 'usage_limit' = limite de uso (5 h, semanal ou troca forçada de modelo); 'auth' = login perdido na conexão;
   * 'config' = erro de configuração (ex.: modelo que o provedor recusa); 'unavailable' = provedor parado por outro motivo.
   * Falha temporária (rede, sobrecarga) NÃO tira ninguém da reunião: o turno falha e pode ser tentado de novo.
   */
  kind: 'usage_limit' | 'auth' | 'config' | 'unavailable';
  /** Motivo em português para a interface. */
  reason: string;
  since: number;
  /** Próxima checagem: horário informado pela conexão, ou uma estimativa interna (ver untilInformed). null = sem previsão. */
  until: number | null;
  /** true só quando a própria conexão informou o horário de liberação (a interface só mostra previsão nesse caso). */
  untilInformed?: boolean;
  /** true = o motivo passou e a HQ está perguntando ao Chefe se o participante volta. */
  asking: boolean;
}

export interface MeetingParticipant {
  id: string;
  meetingId: string;
  kind: 'chefe' | 'ai';
  provider: AiProviderId | null;
  /** 'Chefe' | 'Claude' | 'ChatGPT' (gerentes) ou o nome do funcionário escolhido para a reunião. */
  name: string;
  /** Funcionário que está à mesa (traz nome, função, instruções e preferências); null = gerente Claude ou ChatGPT. */
  employeeId: string | null;
  /** Personalização nesta reunião; ignorada quando useGlobal = true. */
  model: string | null;
  effort: EffortLevel | null;
  useGlobal: boolean;
  state: ParticipantState;
  stateDetail: string | null;
  /** Sessão/thread real no provedor (id de sessão do Claude Code ou thread do Codex); null até o primeiro turno. */
  threadId: string | null;
  /** Lugar na mesa (0..n) para a cena. */
  seat: number;
  order: number;
  /** Fora da reunião por parada do provedor (null = à mesa). */
  away?: ParticipantAway | null;
}

export interface MeetingMinutes {
  /** Ata em Markdown, editável pelo Chefe. */
  text: string;
  generatedAt: number;
  editedAt: number | null;
}

export interface Meeting {
  id: string;
  title: string;
  agenda: string;
  projectId: string | null;
  mode: MeetingMode;
  status: MeetingStatus;
  /** Limite de rodadas de revisão no modo debate (padrão 2). */
  roundLimit: number;
  currentRound: number;
  /** Incrementa a cada mudança na pauta ou no contexto; cada turno registra a versão que usou. */
  contextVersion: number;
  /** Quem faz a síntese ao fim do debate (null = primeiro participante de IA). */
  synthesisParticipantId: string | null;
  /** Incluir o contexto da empresa (salas, projetos, funcionários) no pacote de contexto. */
  companyContext: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  participants: MeetingParticipant[];
  minutes: MeetingMinutes | null;
  /** Turno em execução agora (null = nenhum). */
  activeTurnId: string | null;
  /** Turnos ainda na fila desta reunião. */
  queuedTurns: number;
  /** Na lixeira de reuniões desde (null = ativa). Some de vez 30 dias depois. */
  deletedAt?: number | null;
  /** "Encerrar e distribuir tarefas": em que pé está (null = ainda não pedido). */
  distribution?: MeetingDistribution | null;
}

export interface MeetingDistribution {
  /** planning = o gerente está consolidando; waiting_manager = nenhum gerente disponível (pausado até um voltar); distributed = tarefas na fila; failed = o plano não pôde ser lido. */
  state: 'planning' | 'waiting_manager' | 'distributed' | 'failed';
  requestedAt: number;
  planVersion: number | null;
  error: string | null;
}

export type PlanPriority = 'alta' | 'media' | 'baixa';

/** Uma tarefa do plano consolidado (o que o gerente escreveu, já validado pelo servidor). */
export interface PlanTaskSpec {
  /** Identidade estável dentro da reunião (ex.: "t1"): a mesma chave nunca vira duas tarefas. */
  key: string;
  title: string;
  objective: string;
  /** Funcionário existente (null = ninguém apto na equipe: vira bloqueio na mesa do Chefe). */
  employeeId: string | null;
  employeeName: string | null;
  projectId: string | null;
  slot: SocialSlotId | null;
  context: string;
  references: string[];
  skill: string | null;
  deliverable: string;
  criteria: string[];
  priority: PlanPriority;
  /** Chaves de outras tarefas do plano que precisam terminar antes. */
  dependsOn: string[];
  /** Prazo só quando definido na reunião (deadlineProposed = sugestão do gerente, não decisão do Chefe). */
  deadline: string | null;
  deadlineProposed: boolean;
}

export interface MeetingPlan {
  id: string;
  meetingId: string;
  version: number;
  authorParticipantId: string | null;
  authorName: string;
  createdAt: number;
  summary: string;
  /** Só o que o Chefe decidiu (quadro confirmado ou instrução dele). */
  decisions: string[];
  /** Propostas ainda não decididas: ficam como pendência, nunca viram decisão por concordância entre as IAs. */
  pending: string[];
  /** Trabalho sem ninguém apto na equipe (vai para a mesa do Chefe como bloqueio). */
  needs: string[];
  tasks: PlanTaskSpec[];
}

/** Estado persistido de cada tarefa do plano (a execução real fica na Task ligada). */
export interface PlanTaskRecord {
  /** Estável: `${meetingId}:${key}`. */
  id: string;
  meetingId: string;
  planVersion: number;
  key: string;
  spec: PlanTaskSpec;
  /** pending = ainda não entrou na fila; created = tarefa real criada; blocked = não pôde entrar (motivo em blockedReason). */
  status: 'pending' | 'created' | 'blocked';
  taskId: string | null;
  sessionId: string | null;
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 'plan' = consolidação do plano pelo gerente responsável, ao "Encerrar e distribuir tarefas". */
export type TurnPhase = 'reply' | 'opinion' | 'revision' | 'synthesis' | 'plan';
export type TurnStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'lost' | 'skipped';

export interface MeetingTurn {
  id: string;
  meetingId: string;
  participantId: string;
  round: number;
  phase: TurnPhase;
  status: TurnStatus;
  /** O que foi pedido e o que foi realmente aplicado (validado no servidor antes do turno). */
  requested: AiProviderPrefs;
  applied: (AiProviderPrefs & { resolvedModel: string | null }) | null;
  contextVersion: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  messageId: string | null;
  /** Tamanho do contexto enviado (caracteres) e uso informado pelo provedor quando existir (dado confiável, nunca estimado). */
  promptChars: number;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  durationMs: number | null;
  /** Posição na fila da reunião: o servidor executa nessa ordem ("Tentar de novo" manda o turno para o fim). */
  order: number;
}

export interface MeetingMessage {
  id: string;
  meetingId: string;
  turnId: string | null;
  participantId: string;
  authorName: string;
  provider: AiProviderId | null;
  /** 'chefe' = fala do Chefe; 'speech' = fala real de um participante de IA; 'notice' = aviso do sistema (falhas, pausas). */
  kind: 'chefe' | 'speech' | 'notice';
  text: string;
  ts: number;
  round: number | null;
  phase: TurnPhase | null;
  /** Ids dos participantes destinatários (vazio = todos). */
  targets: string[];
  /** Configuração usada no turno que gerou a fala. */
  config: { model: string | null; effort: EffortLevel | null; resolvedModel: string | null } | null;
  contextVersion: number;
  /** true quando o turno foi interrompido no meio (entrega parcial, registrada como tal). */
  partial: boolean;
}

/** Quadro: decisão confirmada pelo Chefe, proposta dos modelos, divergência/pergunta aberta, próxima ação. */
export type DecisionKind = 'decision' | 'proposal' | 'divergence' | 'question' | 'action';

export interface MeetingDecision {
  id: string;
  meetingId: string;
  kind: DecisionKind;
  text: string;
  /** Quem propôs (null = Chefe). */
  participantId: string | null;
  /** Só o Chefe confirma (ação na interface ou instrução inequívoca). Concordância dos modelos não confirma nada. */
  confirmed: boolean;
  /** Alternativa descartada (vai para a ata como descartada). */
  dismissed: boolean;
  assigneeEmployeeId: string | null;
  messageId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MeetingContextItem {
  id: string;
  /** 'file' = arquivo do explorador (caminho real, lido no servidor a cada turno); 'note' = texto livre. */
  kind: 'file' | 'note';
  label: string;
  path: string | null;
  text: string | null;
  enabled: boolean;
}

export interface MeetingTaskItem {
  id: string;
  meetingId: string;
  title: string;
  instructions: string;
  employeeId: string | null;
  roomId: string | null;
  projectId: string | null;
  status: 'proposed' | 'created' | 'dismissed';
  /** Tarefa real criada na fila (null até criar). */
  taskId: string | null;
  sessionId: string | null;
  createdAt: number;
  /** Decisão do quadro que originou o item (null quando criado à mão): uma decisão nunca vira duas tarefas. */
  decisionId: string | null;
}

export interface MeetingHistory {
  messages: MeetingMessage[];
  turns: MeetingTurn[];
  decisions: MeetingDecision[];
  context: MeetingContextItem[];
  taskItems: MeetingTaskItem[];
  /** Planos consolidados (versões) e as tarefas distribuídas. */
  plans?: MeetingPlan[];
  planTasks?: PlanTaskRecord[];
}

/** Com employeeId, quem entra é o funcionário (nome e motor dele; provider é ignorado). Sem employeeId, o gerente do provedor. */
export interface MeetingParticipantInput { provider: AiProviderId; employeeId?: string | null; model?: string | null; effort?: EffortLevel | null }

export type MeetingClientMessage =
  | { type: 'meeting.create'; reqId: string; title: string; agenda: string; projectId: string | null; mode: MeetingMode; roundLimit?: number; participants: MeetingParticipantInput[] }
  | { type: 'meeting.update'; id: string; patch: Partial<Pick<Meeting, 'title' | 'agenda' | 'projectId' | 'mode' | 'roundLimit' | 'synthesisParticipantId' | 'companyContext'>> }
  /** Manda a reunião para a lixeira de reuniões (restaurável por 30 dias); as tarefas já criadas continuam existindo. */
  | { type: 'meeting.delete'; id: string }
  /** Tira a reunião da lixeira, com falas, quadro, contexto e ata. */
  | { type: 'meeting.restore'; reqId: string; id: string }
  /** Reuniões na lixeira (mais recentes primeiro). */
  | { type: 'meeting.trash'; reqId: string }
  | { type: 'meeting.participant.add'; reqId: string; meetingId: string; participant: MeetingParticipantInput }
  | { type: 'meeting.participant.update'; meetingId: string; participantId: string; patch: { model?: string | null; effort?: EffortLevel | null; useGlobal?: boolean; employeeId?: string | null } }
  | { type: 'meeting.participant.remove'; meetingId: string; participantId: string }
  /** O Chefe chama de volta um participante que a HQ tirou da reunião (limite de uso, modelo recusado). */
  | { type: 'meeting.participant.rejoin'; meetingId: string; participantId: string }
  /** Substitui a lista de itens de contexto (ids novos podem vir do cliente) e incrementa contextVersion. */
  | { type: 'meeting.context.set'; reqId: string; meetingId: string; items: MeetingContextItem[] }
  | { type: 'meeting.history'; reqId: string; meetingId: string }
  /** Fala do Chefe. targets vazio = todos os participantes de IA; menções @Nome no texto também contam. Responde um turno por destinatário. */
  | { type: 'meeting.say'; reqId: string; meetingId: string; clientId: string; text: string; targets: string[] }
  /** Discutir a pauta: opinião inicial → rodadas de revisão (até roundLimit) → síntese. */
  | { type: 'meeting.discuss'; reqId: string; meetingId: string; clientId: string }
  | { type: 'meeting.pause'; meetingId: string }
  | { type: 'meeting.resume'; meetingId: string }
  /** Interrompe o turno em execução (a fala parcial fica registrada como parcial). */
  | { type: 'meeting.interrupt'; meetingId: string }
  | { type: 'meeting.anotherRound'; meetingId: string }
  | { type: 'meeting.retryTurn'; meetingId: string; turnId: string }
  /** Encerra e gera o rascunho da ata (editável). */
  | { type: 'meeting.end'; reqId: string; meetingId: string }
  /**
   * "Encerrar e distribuir tarefas": o gerente responsável consolida o plano, a HQ grava ata, plano e tarefas e põe na fila.
   * Idempotente por reunião: repetir (clique duplo, reconexão) devolve o andamento atual e nunca duplica tarefa.
   */
  | { type: 'meeting.endAndDistribute'; reqId: string; meetingId: string; clientId: string }
  | { type: 'meeting.reopen'; meetingId: string }
  | { type: 'meeting.minutes.save'; reqId: string; meetingId: string; text: string }
  | { type: 'meeting.decision.add'; reqId: string; meetingId: string; kind: DecisionKind; text: string; assigneeEmployeeId?: string | null }
  | { type: 'meeting.decision.update'; meetingId: string; id: string; patch: Partial<Pick<MeetingDecision, 'kind' | 'text' | 'confirmed' | 'dismissed' | 'assigneeEmployeeId'>> }
  | { type: 'meeting.decision.delete'; meetingId: string; id: string }
  | { type: 'meeting.taskItem.upsert'; reqId: string; meetingId: string; item: { id?: string; title: string; instructions?: string; employeeId?: string | null; roomId?: string | null; projectId?: string | null; decisionId?: string | null } }
  | { type: 'meeting.taskItem.delete'; meetingId: string; id: string }
  /**
   * Cria tarefas reais na fila existente a partir dos itens revisados. Idempotente por item (recarregar a página não duplica).
   * start=false cria a tarefa em espera (não inicia até liberar com task.release).
   */
  | { type: 'meeting.tasks.create'; reqId: string; meetingId: string; items: { id: string; employeeId: string; projectId: string; instructions: string; start: boolean }[] }
  /** Libera uma tarefa criada em espera para a fila normal. */
  | { type: 'task.release'; taskId: string };

export type MeetingServerMessage =
  | { kind: 'meeting.message'; meetingId: string; message: MeetingMessage }
  /** Texto parcial acumulado do turno em andamento ('' ao terminar). */
  | { kind: 'meeting.delta'; meetingId: string; turnId: string; participantId: string; text: string }
  | { kind: 'meeting.turn'; meetingId: string; turn: MeetingTurn }
  | { kind: 'meeting.decision'; meetingId: string; op: 'upsert' | 'delete'; decision: MeetingDecision | { id: string } }
  | { kind: 'meeting.context'; meetingId: string; items: MeetingContextItem[]; contextVersion: number }
  | { kind: 'meeting.taskItem'; meetingId: string; op: 'upsert' | 'delete'; item: MeetingTaskItem | { id: string } }
  | { kind: 'meeting.plan'; meetingId: string; plans: MeetingPlan[]; planTasks: PlanTaskRecord[] };

export const MEETING_DEFAULT_ROUNDS = 2;
/** Teto absoluto de rodadas de revisão por reunião (nunca loop infinito). */
export const MEETING_MAX_ROUNDS = 6;
/** Participantes de IA por reunião (gerentes + funcionários): cadeiras da mesa além da do Chefe; turnos rodam um por vez. */
export const MEETING_MAX_AI_PARTICIPANTS = 8;
