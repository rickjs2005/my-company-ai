// Leitura do pedido do Chefe no campo "O que vamos criar?" (10/11/2026): diferencia conversar, analisar, ensinar, produzir,
// corrigir e "o que depende de mim", sem chamada de IA (regras sobre o texto). O resultado é o resumo compacto mostrado antes
// de enfileirar (marca, objetivo, entrega esperada) e o que realmente falta. Mandar referência para aprender não é produzir.
import { TEAMS, type TeamId } from './teams.js';
import { detectDirective, teamsMentioned } from './knowledge.js';

export type RequestIntent = 'status' | 'corrigir' | 'ensinar' | 'analisar' | 'produzir' | 'conversar';

export interface RequestReading {
  intent: RequestIntent;
  /** Marcas do pedido (citadas no texto; senão a do perfil escolhido). Vazio = não deu para saber. */
  teams: TeamId[];
  hasLink: boolean;
  /** O texto traz uma orientação para os próximos trabalhos ("lembre disso", "sempre..."). */
  remember: boolean;
  summary: { marca: string; objetivo: string; entrega: string };
  /** Só o dado essencial que falta para começar (vazio = pode executar). */
  missing: string[];
}

export const REQUEST_INTENT_LABEL: Record<RequestIntent, string> = {
  status: 'Ver o que depende de você', corrigir: 'Corrigir uma entrega', ensinar: 'Ensinar a equipe', analisar: 'Analisar', produzir: 'Produzir', conversar: 'Conversar',
};

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const LINK = /https?:\/\/\S+/i;

function deliverable(n: string): string {
  if (/\b(video|reel|reels|shorts|animacao)\b/.test(n)) return 'vídeo em arquivo reproduzível (roteiro sozinho não conta como vídeo)';
  if (/\bcarrossel\b/.test(n)) return 'carrossel com as imagens exportadas e a legenda';
  if (/\broteiro\b/.test(n)) return 'roteiro em texto';
  if (/\b(post|legenda|texto|threads|thread)\b/.test(n)) return 'texto final do post';
  return 'a peça pronta, com os arquivos na pasta da equipe';
}

export function readRequest(raw: string, ctx: { profileTeam?: TeamId | null; hasFile?: boolean } = {}): RequestReading {
  const text = String(raw ?? '').trim();
  const n = norm(text);
  const hasLink = LINK.test(text);
  const hasRef = hasLink || Boolean(ctx.hasFile);
  const mentioned = teamsMentioned(text);
  const teams = mentioned.length ? mentioned : ctx.profileTeam ? [ctx.profileTeam] : [];
  const remember = Boolean(detectDirective(text));
  const marca = teams.length ? teams.map(t => TEAMS.find(x => x.id === t)!.short).join(' e ') : 'não indicada';
  const missing: string[] = [];
  const objetivo = text.replace(/\s+/g, ' ').slice(0, 140);

  const isStatus = /\b(o que|oque)\s+(depende|precisa|falta|espera)\b[^.?!]{0,20}\b(de mim|eu)\b|\bdepende de mim\b|\bme mostr(e|a) o que\b|\b(o que|oque) (esta|ta|ficou) (pendente|parado|esperando|travado)\b|\bresumo (do dia|de hoje)\b|\bcomo (estao|esta|andam|anda) (as|os|a|o) (tarefas|pedidos|entregas|equipe)\b/.test(n);
  if (isStatus) return { intent: 'status', teams, hasLink, remember: false, summary: { marca, objetivo: 'ver entregas, perguntas e bloqueios que esperam você', entrega: 'nada é enfileirado: abre a Minha mesa' }, missing };

  const isFix = /\b(est[ae]|ess[ae]|aquel[ae]|a ultima|a)\s+(entrega|versao|peca)\b|\b(ajust|corrij|corrig|refac|refaz|encurt|troqu|mud)[a-z]*\b[^.?!]{0,40}\b(entrega|versao|peca)\b|\bdeix(e|a|em) (mais|menos)\b/.test(n);
  if (isFix) {
    missing.push('qual entrega (abra a entrega na Minha mesa e use "Pedir ajuste")');
    return { intent: 'corrigir', teams, hasLink, remember, summary: { marca, objetivo, entrega: 'nova versão da entrega, com a anterior guardada' + (remember ? '; a preferência fica registrada' : '') }, missing };
  }

  const makes = /\b(produz|cri(e|em|ar)\b|fac(a|am)\b|faz(er)?\b|prepar|escrev|grav(e|em|ar)\b|mont(e|em|ar)\b|edit(e|em|ar)\b|public|post(e|em|ar)\b)/.test(n);
  const teaches = /\b(aprend|ensin|estud(e|em|ar)\b|trein)/.test(n) || (remember && !makes);
  if (teaches) {
    if (/\b(est[ae]|ess[ae]|aquel[ae]|o|a)\s+(video|referencia|link|tutorial|aula)\b/.test(n) && !hasRef) missing.push('o link ou o arquivo da referência');
    return { intent: 'ensinar', teams, hasLink, remember, summary: { marca: teams.length ? marca : 'empresa (vale para todos)', objetivo, entrega: hasRef ? 'técnica em procedimento (pré-requisitos, passos, exemplo, critério) e exercício quando possível; não produz nem publica peça' : 'orientação registrada no Conhecimento da equipe' }, missing };
  }

  const analyzes = /\b(analis|avali|compar|diagnostic|investig|pesquis|levant(e|em)\b|mape)/.test(n);
  if (analyzes && !makes) return { intent: 'analisar', teams, hasLink, remember, summary: { marca, objetivo, entrega: 'análise escrita com o que foi possível verificar; não produz nem publica' }, missing };

  if (makes || /\b(video|reel|carrossel|post|roteiro|legenda)\b/.test(n)) {
    if (!teams.length) missing.push('a marca (Aurora ou Tuco Dev)');
    return { intent: 'produzir', teams, hasLink, remember, summary: { marca, objetivo, entrega: deliverable(n) + '; aprovar a peça não publica' }, missing };
  }
  return { intent: 'conversar', teams, hasLink, remember, summary: { marca, objetivo, entrega: 'resposta na conversa (vira tarefa só se você pedir)' }, missing };
}
