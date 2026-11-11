// Contrato dos adaptadores de IA da sala de reunião. Um adaptador por provedor (Claude via Claude Code; ChatGPT via Codex
// app-server). O coordenador de reuniões (server/src/meetings) só conhece esta interface: descoberta, início/retomada de
// thread, envio de turno com texto parcial, interrupção, teste de conexão e encerramento.
import type { EventEmitter } from 'node:events';
import type { AiModelOption, AiProviderId, AiProviderStatus, AiTestResult, EffortLevel, MeetingTurn } from '@milweb-hq/protocol';

export interface TurnRequest {
  meetingId: string;
  turnId: string;
  participantId: string;
  /** Thread/sessão real a retomar (null = iniciar uma nova). */
  threadId: string | null;
  /** Pasta de trabalho (projeto da reunião ou pasta da reunião nos dados da HQ). */
  cwd: string;
  /** Identidade e regras do participante (vai como system prompt / instruções do desenvolvedor). */
  systemPrompt: string;
  /** Conteúdo do turno (pacote de contexto + pedido). Vai como dado, nunca por shell. */
  text: string;
  /** Nome legível para a sessão no provedor (ex.: "Reunião: Pauta X"). */
  title: string;
  model: string | null;
  effort: EffortLevel | null;
  /** Texto parcial ACUMULADO (o adaptador junta os deltas). */
  onDelta?(text: string): void;
  /** Tempo máximo do turno; ao estourar o adaptador interrompe e devolve 'failed' com o motivo. */
  timeoutMs?: number;
}

export interface TurnOutcome {
  status: 'done' | 'failed' | 'interrupted';
  /** Texto final (ou parcial, se interrompido/falhou no meio). */
  text: string;
  threadId: string | null;
  applied: { model: string | null; effort: EffortLevel | null; resolvedModel: string | null };
  error: string | null;
  durationMs: number;
  /** Só dados que o provedor informou (tokens, custo do CLI); null quando não há dado confiável. */
  usage: MeetingTurn['usage'];
  /**
   * O provedor parou por um motivo que não é deste turno (limite de uso da assinatura, troca forçada de modelo, modelo recusado):
   * o coordenador tira da reunião quem usa esse provedor e pergunta ao Chefe quando ele puder voltar. Ausente/null = nada disso.
   */
  stop?: ProviderTurnStop | null;
}

export interface ProviderTurnStop {
  /** usage_limit = limite de uso; auth = login perdido; config = erro de configuração (modelo recusado); unavailable = outro motivo. */
  kind: 'usage_limit' | 'auth' | 'config' | 'unavailable';
  /** Motivo curto em português (ex.: "limite de uso de 5 h esgotado"). */
  reason: string;
  /** Próxima checagem (ms): o horário informado pela conexão ou uma estimativa (untilInformed = false). null = sem previsão. */
  until: number | null;
  /** true só quando a conexão informou o horário (a interface só mostra previsão nesse caso). */
  untilInformed?: boolean;
}

export interface TurnHandle {
  done: Promise<TurnOutcome>;
  /** Interrompe o turno (idempotente). O `done` resolve com status 'interrupted' e o texto parcial. */
  interrupt(): Promise<void>;
}

export type ValidationResult =
  | { ok: true; model: string | null; effort: EffortLevel | null; note: string | null }
  | { ok: false; reason: string; model: string | null; effort: EffortLevel | null; alternatives: EffortLevel[] };

export interface AiAdapterEvents { status: [AiProviderStatus] }

export interface AiAdapter extends EventEmitter<AiAdapterEvents> {
  readonly provider: AiProviderId;
  /** Último estado conhecido (não chama o provedor). */
  status(): AiProviderStatus;
  /** Redescobre instalação, login e catálogo com chamadas reais ao provedor. Nunca lança: erros viram authState 'error'. */
  refresh(): Promise<AiProviderStatus>;
  /** Valida modelo/esforço contra o catálogo real. Nunca substitui em silêncio: recusa com motivo e alternativas. */
  validate(model: string | null, effort: EffortLevel | null): ValidationResult;
  /** Opções do catálogo (do último refresh). */
  models(): AiModelOption[];
  /** Inicia um turno real. Lança só se o pedido for inválido (ex.: provedor indisponível); falhas do provedor voltam em `done`. */
  startTurn(req: TurnRequest): TurnHandle;
  /** Turno curto de teste (o provedor é avisado de que é um teste); registra em status().lastTest. */
  test(model: string | null, effort: EffortLevel | null, cwd: string): Promise<AiTestResult>;
  /** Fluxo de login oficial (Codex). Devolve a URL a abrir no navegador quando houver. */
  startLogin?(): Promise<{ url: string | null; detail: string }>;
  cancelLogin?(): Promise<void>;
  /** Encerra processos do provedor (retomáveis pelo threadId). */
  shutdown(): Promise<void>;
}

/** Prompt de teste padrão: avisa o provedor de que é um teste de conexão. */
export const TEST_PROMPT = 'Isto é um teste de conexão da MilWeb HQ (não é uma tarefa). Responda apenas com a palavra: ok';
