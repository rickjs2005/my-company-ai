// Conhecimento da equipe (10/11/2026): memória persistente da empresa. NÃO é treinamento de modelo: são orientações gravadas
// no banco da HQ, recuperadas por escopo (empresa, equipe, projeto, função, funcionário) e entregues no pedido de cada tarefa.
// Cada alteração cria uma versão nova (a anterior fica no histórico como "substituído" e deixa de ser recuperada), e cada tarefa
// que recebeu um item registra qual versão usou.
import type { TeamId } from './teams.js';

/** Naturezas diferentes ficam separadas: o que o Chefe prefere, fatos, como fazer, exemplos aprovados e sugestões vindas de referência. */
export type KnowledgeKind = 'preferencia' | 'fato' | 'procedimento' | 'exemplo' | 'sugestao';
export type KnowledgeScopeType = 'empresa' | 'equipe' | 'projeto' | 'funcao' | 'funcionario';
/** id: equipe = TeamId; projeto = id do projeto; funcao = modelo de papel (ex.: conteudo-criador); funcionario = id; empresa = null. */
export interface KnowledgeScope { type: KnowledgeScopeType; id: string | null }
/** proposto = ainda não vale (ex.: conclusão da IA esperando o Chefe); ativo = recuperado nas tarefas; substituído e desativado = só histórico. */
export type KnowledgeState = 'proposto' | 'ativo' | 'substituido' | 'desativado';
/** Quem originou: o Chefe (tela ou frase "lembre disso"), um ajuste dele numa entrega, uma referência estudada, ou dado de teste. */
export type KnowledgeOrigin = 'chefe' | 'ajuste' | 'referencia' | 'equipe' | 'teste';

export interface KnowledgeEvidence {
  kind: 'tarefa' | 'entrega' | 'arquivo' | 'link' | 'estudo' | 'peca';
  /** Id (tarefa, entrega, estudo, peça), caminho absoluto ou URL. */
  ref: string;
  label: string | null;
}

export interface KnowledgeItem {
  id: string;
  /** Igual em todas as versões do mesmo ensinamento. */
  chainId: string;
  version: number;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  title: string;
  text: string;
  state: KnowledgeState;
  origin: KnowledgeOrigin;
  /** De onde veio, em palavras (ex.: a frase original do Chefe, "ajuste da entrega X v2", "estudo do vídeo Y"). */
  originNote: string | null;
  evidence: KnowledgeEvidence[];
  /** Versão que esta substituiu / versão que a substituiu. */
  supersedesId: string | null;
  supersededById: string | null;
  createdAt: number;
  updatedAt: number;
  /** Quantas tarefas receberam esta versão e quando foi a última. */
  uses: number;
  lastUsedAt: number | null;
}

/** Uma tarefa que recebeu um item no pedido (a versão exata fica registrada). */
export interface KnowledgeUse {
  knowledgeId: string;
  chainId: string;
  version: number;
  title: string;
  kind: KnowledgeKind;
  taskId: string;
  taskTitle: string;
  employeeId: string | null;
  profileId: string | null;
  at: number;
}

export interface KnowledgeBoard {
  items: KnowledgeItem[];
  /** Usos recentes (a tela cruza com tarefas e entregas pelo taskId). */
  recentUses: KnowledgeUse[];
}

export interface KnowledgeInput {
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  title?: string | null;
  text: string;
  evidence?: KnowledgeEvidence[];
  /** Padrão: ativo quando vem do Chefe; proposto quando vem de referência ou da equipe. */
  state?: 'proposto' | 'ativo';
  origin?: KnowledgeOrigin;
  originNote?: string | null;
}

export type KnowledgeClientMessage =
  | { type: 'knowledge.state'; reqId: string }
  /** Ensinar: grava um item novo. O mesmo clientId nunca grava dois (duplo clique, reconexão). */
  | { type: 'knowledge.teach'; reqId: string; clientId: string; item: KnowledgeInput }
  /** Corrigir ou substituir: cria a versão seguinte (ativa) e marca a atual como substituída. */
  | { type: 'knowledge.replace'; reqId: string; id: string; patch: { title?: string; text?: string; kind?: KnowledgeKind; scope?: KnowledgeScope } }
  /** Ativar um proposto, desativar um ativo ou reativar um desativado. */
  | { type: 'knowledge.setState'; reqId: string; id: string; state: 'ativo' | 'desativado' }
  /** Exclui o ensinamento inteiro (todas as versões e o registro de uso). */
  | { type: 'knowledge.delete'; reqId: string; id: string }
  /** Desfaz o registro automático feito por uma frase "lembre disso" (apaga se nunca foi substituído). */
  | { type: 'knowledge.undo'; reqId: string; id: string }
  | { type: 'knowledge.uses'; reqId: string; id: string }
  /** O que seria entregue a um funcionário/equipe para um pedido (sem criar tarefa nem registrar uso). */
  | { type: 'knowledge.preview'; reqId: string; text: string; profileId: string | null; employeeId: string | null; projectId: string | null };

export type KnowledgeServerMessage =
  | { kind: 'knowledge.state'; state: KnowledgeBoard }
  /** A HQ registrou sozinha uma orientação explícita do Chefe ("lembre disso para o Tuco"): a tela mostra o resumo com Desfazer. */
  | { kind: 'knowledge.captured'; item: KnowledgeItem };

export const KNOWLEDGE_KIND_LABEL: Record<KnowledgeKind, string> = {
  preferencia: 'Preferência do Chefe', fato: 'Fato', procedimento: 'Procedimento', exemplo: 'Exemplo aprovado', sugestao: 'Sugestão de referência',
};
export const KNOWLEDGE_STATE_LABEL: Record<KnowledgeState, string> = { proposto: 'proposto', ativo: 'ativo', substituido: 'substituído', desativado: 'desativado' };
export const KNOWLEDGE_ORIGIN_LABEL: Record<KnowledgeOrigin, string> = {
  chefe: 'ensinado por você', ajuste: 'ajuste seu numa entrega', referencia: 'extraído de referência', equipe: 'proposto pela equipe', teste: 'dado de teste',
};

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Marca citada no texto: "tuco" → Tuco Dev; "aurora" → Aurora (sem contar o nome do aplicativo "MilWeb HQ"). */
export function teamsMentioned(text: string): TeamId[] {
  const t = norm(text).replace(/milweb\s*hq/g, ' ');
  const out: TeamId[] = [];
  if (/\baurora\b/.test(t)) out.push('aurora');
  if (/\btuco\b/.test(t)) out.push('tuco-dev');
  return out;
}

export interface Directive { scope: KnowledgeScope; text: string; title: string }

const REMEMBER = /\b(lembr(e|em|ar)(-se)?|guard(e|em)|anot(e|em)|memoriz(e|em)|registr(e|em))\b[^.!?\n]{0,60}\b(diss[oa]|dist[oa]|dess[ae]|dest[ae]|iss[oa]|ess[ae]|est[ae]|que|para|pro|pra)\b/;
const ALWAYS = /\b(sempre|nunca( mais)?|jamais)\s+(\w+\s+){0,2}?(fac|use|usa|usem|comec|coloqu|termin|evit|escrev|abr|fech|inclu|mant|cit|publi|post|grav|edit|cort|mostr|fal|respond)/;
const FROM_NOW = /\b(daqui (pra|para) (a )?frente|de agora em diante|a partir de agora|nos proximos (trabalhos|videos|posts|conteudos|reels|pedidos)|nas proximas (pecas|entregas|vezes)|use(m)? (isso |isto )?nos proximos)\b/;

/** Regra geral sobre um formato ("nos vídeos do Tuco, comece direto no assunto"), desde que a frase não seja um pedido de produção. */
const GENERAL = /\b(n[oa]s|em tod[oa]s? ?(os|as)?)\s+(videos|posts|reels|carrosseis|conteudos|pecas|legendas|roteiros|textos)\b/;
const MAKES = /\b(produz|cri(e|em|ar)\b|prepar|escrev(a|am)\b|mont(e|em)\b|grav(e|em)\b)/;
function hitsDirective(n: string): boolean { return REMEMBER.test(n) || ALWAYS.test(n) || FROM_NOW.test(n) || (GENERAL.test(n) && !MAKES.test(n)); }

/**
 * Orientação EXPLÍCITA do Chefe para valer nos próximos trabalhos ("lembre disso para o Tuco", "sempre faça assim",
 * "de agora em diante..."). Correção pontual ("essa introdução está longa") não casa: vale só para a tarefa.
 * O escopo vem do texto (marca citada, "a empresa toda", nome de funcionário); sem indicação, a equipe do contexto; sem
 * contexto, a empresa. O texto gravado é a frase do Chefe, sem acrescentar nada que ele não disse.
 */
export function detectDirective(raw: string, ctx: { team?: TeamId | null; employees?: { id: string; name: string }[] } = {}): Directive | null {
  const text = String(raw ?? '').trim();
  if (text.length < 8 || text.length > 4000) return null;
  const n = norm(text);
  if (!hitsDirective(n)) return null;
  // Frases com o gatilho; se a frase só aponta para trás ("lembre disso"), a anterior é o conteúdo.
  const sentences = text.split(/(?<=[.!?\n])\s+/).map(s => s.trim()).filter(Boolean);
  const hit = (s: string) => hitsDirective(norm(s));
  const picked: string[] = [];
  sentences.forEach((s, i) => {
    if (!hit(s)) return;
    const pointsBack = /\b(diss[oa]|dist[oa]|iss[oa]|assim|dessa forma|desse jeito)\b/.test(norm(s)) && norm(s).replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).length <= 14;
    if (pointsBack && i > 0 && !picked.includes(sentences[i - 1])) picked.push(sentences[i - 1]);
    if (!picked.includes(s)) picked.push(s);
  });
  const body = (picked.length ? picked.join(' ') : text).slice(0, 700).trim();
  const teams = teamsMentioned(text);
  const named = (ctx.employees ?? []).find(e => e.name.length >= 3 && new RegExp(`\\b(para|pro|pra)\\s+(a|o)?\\s*${norm(e.name)}\\b`).test(n));
  let scope: KnowledgeScope;
  if (/\b(empresa (toda|inteira)|todas? as (equipes|marcas)|todo mundo|as duas (equipes|marcas))\b/.test(n) || teams.length === 2) scope = { type: 'empresa', id: null };
  else if (teams.length === 1) scope = { type: 'equipe', id: teams[0] };
  else if (named) scope = { type: 'funcionario', id: named.id };
  else if (ctx.team) scope = { type: 'equipe', id: ctx.team };
  else scope = { type: 'empresa', id: null };
  return { scope, text: body, title: body.replace(/\s+/g, ' ').slice(0, 80) };
}
