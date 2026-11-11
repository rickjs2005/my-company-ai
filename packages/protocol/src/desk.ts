// Mesa do Chefe como caixa de entrada: Entregas (resultado salvo de uma tarefa distribuída), Perguntas e Bloqueios.
// Entregas são persistidas no servidor (chegam com a janela fechada ou o Chefe em outra sala); perguntas e bloqueios vêm do
// estado real das tarefas (pedido de permissão, pergunta do funcionário, falha, dependência, falta de alguém apto).
import type { SocialSlotId } from './social.js';
import type { KnowledgeScope } from './knowledge.js';

export type DeskDeliveryStatus = 'nova' | 'vista' | 'aprovada' | 'ajustes';

export interface DeskCriterion {
  text: string;
  /** true = o funcionário marcou como atendido; false = marcou como pendente; null = não informou (conferir). */
  ok: boolean | null;
  note: string | null;
}

export interface DeskCheck { label: string; ok: boolean | null; detail: string | null }

export interface DeskDelivery {
  id: string;
  /** Tarefa real que gerou esta versão. */
  taskId: string;
  /** Primeira tarefa da série (versões de ajuste apontam para ela). */
  rootTaskId: string;
  version: number;
  meetingId: string | null;
  meetingTitle: string | null;
  /** Item do plano da reunião (null = ajuste avulso). */
  planTaskId: string | null;
  employeeId: string | null;
  title: string;
  slot: SocialSlotId | null;
  profileId: string | null;
  /** Resumo do resultado (texto final do funcionário). */
  summary: string;
  /** Arquivos reais (caminho absoluto) e links citados na entrega. */
  files: string[];
  links: string[];
  criteria: DeskCriterion[];
  /** O que a HQ conferiu sozinha nesta versão (arquivo existe, tamanho, tipo). ok null = depende de avaliação humana. */
  checks?: DeskCheck[];
  /** De onde veio: plano de reunião, pedido direto do Chefe ou ajuste de uma versão anterior. */
  source?: 'reuniao' | 'pedido' | 'ajuste';
  /** O pedido original (resultado esperado), para o cartão não depender do resumo do funcionário. */
  request?: string | null;
  /** 'aprovada' = o Chefe aprovou a entrega (não publica nada); 'ajustes' = voltou ao responsável com a observação. */
  status: DeskDeliveryStatus;
  note: string | null;
  /** Tarefa de ajuste criada a partir desta versão (a próxima versão nasce quando ela terminar). */
  adjustTaskId: string | null;
  createdAt: number;
  seenAt: number | null;
  decidedAt: number | null;
}

/** Bloqueio persistido (o resto vem das tarefas): plano que pediu alguém que a equipe não tem, ou tarefa que não pôde entrar na fila. */
export interface DeskNeed {
  id: string;
  meetingId: string | null;
  meetingTitle: string | null;
  planTaskId: string | null;
  text: string;
  createdAt: number;
  resolvedAt: number | null;
}

export interface DeskState {
  deliveries: DeskDelivery[];
  needs: DeskNeed[];
}

export type DeskClientMessage =
  | { type: 'desk.state'; reqId: string }
  /** Marca entregas como vistas (zera o contador de novas). */
  | { type: 'desk.seen'; reqId: string; ids: string[] }
  /** Aprova a entrega. Não publica nada: produção, revisão e publicação têm estados próprios. */
  | { type: 'desk.approve'; reqId: string; id: string }
  /** Devolve ao mesmo responsável com a observação; a versão atual fica guardada e a próxima nasce quando o ajuste terminar. */
  /** `remember` = "Usar nos próximos trabalhos": além de corrigir esta entrega, a observação vira preferência no escopo indicado. */
  | { type: 'desk.adjust'; reqId: string; id: string; note: string; clientId: string; remember?: KnowledgeScope | null }
  | { type: 'desk.need.resolve'; reqId: string; id: string };

export type DeskServerMessage =
  | { kind: 'desk.state'; state: DeskState };

export const DESK_STATUS_LABEL: Record<DeskDeliveryStatus, string> = { nova: 'nova', vista: 'vista', aprovada: 'aprovada por você', ajustes: 'ajustes pedidos' };
