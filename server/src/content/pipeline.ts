// Linha de produção (08/11/2026, "meu papel é ser CEO, não o funcionário que manda cada agente fazer tudo"): o Chefe escreve um
// pedido em texto livre, a gerente da sala (coordenação editorial) devolve um plano em JSON e a HQ cria as peças com as etapas
// que cada uma precisa (pesquisa, roteiro, direção) antes da produção que já existia (edição ou criação), da revisão do Otto e
// da aprovação do Chefe. Cada etapa é uma tarefa real com um arquivo conferido no disco; a próxima só começa quando ele existe.
import type { ContentItem, PieceStep, PieceStepKey, QuickFormat, SocialSlotId } from '@milweb-hq/protocol';
import { PIECE_STEP_FILE, PIECE_STEP_LABEL } from '@milweb-hq/protocol';

export const PLAN_MAX_PIECES = 6;

export interface PlannedPiece {
  title: string;
  slot: SocialSlotId;
  format: QuickFormat;
  date: string;
  objective: string;
  audience: string | null;
  message: string | null;
  hook: string | null;
  cta: string | null;
  metric: string | null;
  brief: string;
  hypothesis: string | null;
  refs: string[];
  research: boolean;
  material: 'pronto' | 'gravar' | 'nao_precisa';
}

export interface ParsedPlan { summary: string; pieces: PlannedPiece[]; questions: string[]; left: string[]; warnings: string[] }

const str = (v: unknown, max = 600): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const list = (v: unknown, max = 10, len = 300): string[] => (Array.isArray(v) ? v.map(x => str(x, len)).filter((x): x is string => Boolean(x)).slice(0, max) : []);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));

/** Normaliza o formato que a gerente escreveu ("Reel", "vídeo", "carrossel", "post") para os três da sala. */
export function planFormat(v: unknown, slot: SocialSlotId): QuickFormat | null {
  const f = String(v ?? '').toLowerCase();
  if (slot === 'threads') return 'texto';
  if (/reel|v[íi]deo|video|short/.test(f)) return 'video';
  if (/carross|carousel|slide/.test(f)) return 'carrossel';
  if (/texto|post/.test(f)) return null;
  return null;
}

/**
 * Confere o plano.json da gerente: só contas ativas, formato possível na conta, data válida (no passado vira amanhã), no máximo
 * PLAN_MAX_PIECES peças. Peça inválida não derruba o plano: sai em `left` com o motivo.
 */
export function parsePlan(o: Record<string, unknown>, ctx: { activeSlots: SocialSlotId[]; today: string; tomorrow: string; formatsFor(slot: SocialSlotId): QuickFormat[] }): { ok: true; value: ParsedPlan } | { ok: false; error: string } {
  const summary = str(o.resumo, 1500) ?? str(o.summary, 1500);
  if (!summary) return { ok: false, error: 'plano.json sem "resumo" (o que a gerente entendeu e decidiu)' };
  const raw = Array.isArray(o.pecas) ? o.pecas : Array.isArray(o.pieces) ? o.pieces : null;
  if (!raw) return { ok: false, error: 'plano.json sem a lista "pecas"' };
  const pieces: PlannedPiece[] = []; const left = list(o.fora, 10); const warnings: string[] = [];
  for (const [i, x] of raw.entries()) {
    const p = (x ?? {}) as Record<string, unknown>;
    const title = str(p.titulo, 200) ?? str(p.title, 200);
    const where = `peça ${i + 1}${title ? ` ("${title.slice(0, 60)}")` : ''}`;
    if (!title) { left.push(`${where}: sem título`); continue; }
    const slot = String(p.conta ?? p.slot ?? '') as SocialSlotId;
    if (!ctx.activeSlots.includes(slot)) { left.push(`${where}: conta "${String(p.conta ?? '')}" não está entre as ativas (${ctx.activeSlots.join(', ')})`); continue; }
    const format = planFormat(p.formato ?? p.format, slot);
    if (!format || !ctx.formatsFor(slot).includes(format)) { left.push(`${where}: formato "${String(p.formato ?? '')}" não existe em ${slot}`); continue; }
    if (pieces.length >= PLAN_MAX_PIECES) { left.push(`${where}: passou do limite de ${PLAN_MAX_PIECES} peças por plano`); continue; }
    let date = isDate(p.data) ? p.data : ctx.tomorrow;
    if (date < ctx.today) { warnings.push(`${where}: data ${date} no passado, ficou para ${ctx.tomorrow}`); date = ctx.tomorrow; }
    const material = p.material === 'gravar' || p.material === 'pronto' ? p.material : 'nao_precisa';
    pieces.push({
      title, slot, format, date,
      objective: str(p.objetivo, 400) ?? '',
      audience: str(p.publico, 300), message: str(p.mensagem, 400), hook: str(p.gancho, 300), cta: str(p.cta, 200), metric: str(p.metrica, 300),
      brief: str(p.briefing, 3000) ?? '', hypothesis: str(p.hipotese, 600),
      refs: list(p.referencias, 8), research: p.pesquisa === true, material,
    });
  }
  if (!pieces.length && !left.length) return { ok: false, error: 'o plano não tem nenhuma peça' };
  return { ok: true, value: { summary, pieces, questions: list(o.perguntas, 6), left, warnings } };
}

/** Etapas antes da produção: vídeo passa por roteiro (criação) e direção (Diretor); pesquisa só quando a gerente pediu. Carrossel e
 *  texto continuam numa produção só (a criação já é quem escreve), com a pesquisa antes se pedida. */
export function stepsFor(format: QuickFormat, research: boolean): PieceStepKey[] {
  const steps: PieceStepKey[] = research ? ['pesquisa'] : [];
  if (format === 'video') steps.push('roteiro', 'direcao');
  return steps;
}

export function newSteps(keys: PieceStepKey[]): PieceStep[] {
  return keys.map(key => ({ key, employeeId: null, employeeName: null, status: 'pendente', roundId: null, files: [], summary: null, error: null, startedAt: null, doneAt: null }));
}

/** Briefing da peça a partir do plano (o que a criação, o Diretor e a edição leem na ficha). */
export function planBrief(p: PlannedPiece, request: string): string {
  return [
    p.brief,
    p.audience ? `Público: ${p.audience}` : '',
    p.message ? `Mensagem: ${p.message}` : '',
    p.hook ? `Gancho: ${p.hook}` : '',
    p.cta ? `Chamada para ação: ${p.cta}` : '',
    p.metric ? `Métrica de sucesso: ${p.metric}` : '',
    p.refs.length ? `Referências do plano: ${p.refs.join(' ; ')}` : '',
    `Pedido do Chefe que originou o plano: "${request.slice(0, 600)}"`,
  ].filter(Boolean).join('\n');
}

const RULES = 'Regras: não publique, não agende e não envie nada a ninguém; não invente @, cliente, número, data ou fonte; sem ferramenta paga. Para arquivos use Glob, Grep e Read (não use o terminal). WebSearch e WebFetch esperam a autorização do Chefe (a tarefa fica parada até ele responder): evite quando o que você precisa já está na pasta. Se faltar uma decisão que muda o resultado e que só o Chefe sabe (qual trecho, qual conta, confirmar um nome, uma letra ou um número), pergunte com a ferramenta AskUserQuestion: uma pergunta curta, com 2 a 4 opções. Ela aparece na Mesa dele e o seu tempo para enquanto ele não responde. Para o resto, decida pelo caminho mais simples e registre a suposição no peca.md.';

export function planPrompt(o: {
  text: string; now: string; today: string; tomorrow: string; outputPath: string;
  slots: { id: SocialSlotId; label: string; formats: QuickFormat[]; objective: string | null }[];
  team: { name: string; role: string }[];
  open: string[]; radar: string[]; academy: boolean;
  /** Equipes do pedido (cada peça é de uma equipe só, com briefing e entrega próprios). */
  teams?: { label: string; channels: string[]; focus: string }[];
}): string {
  return [
    `Pedido do Chefe (CEO da Aurora), com as palavras dele: "${o.text.slice(0, 4000)}"`,
    '',
    `Agora: ${o.now} (Brasília). Hoje: ${o.today}. Amanhã: ${o.tomorrow}.`,
    'Você é a gerente de operação da sala Social Media. Transforme o pedido num plano executável. Você não produz nenhuma peça nesta tarefa: a HQ cria as peças do seu plano e toca a linha de produção sozinha, na ordem: pesquisa (pesquisador, só quando você pedir) → roteiro (criação da equipe da conta, só em vídeo) → direção de vídeo (Diretor, só em vídeo) → produção (edição de vídeo ou criação) → revisão (Otto) → aprovação do Chefe.',
    '',
    ...(o.teams?.length ? [
      'Equipes deste pedido (fixas; ninguém troca de equipe para cumprir o plano):',
      ...o.teams.map(t => `- ${t.label}: ${t.channels.join(' + ')}. Foco: ${t.focus}.`),
      o.teams.length > 1 ? 'O pedido vale para as duas equipes: cada peça é de UMA equipe, com briefing e entrega próprios. Se a ideia servir às duas, faça uma peça por equipe e diga na segunda que é adaptação da primeira (mesma origem, linguagem do perfil de destino).' : 'Todas as peças são desta equipe.',
      '',
    ] : []),
    'Contas ativas (só estas; as outras redes são só fonte de pesquisa):',
    ...o.slots.map(s => `- \`${s.id}\`: ${s.label}; formatos: ${s.formats.join(', ')}${s.objective ? `; objetivo: ${s.objective}` : ''}`),
    '',
    'Equipe:', ...o.team.map(t => `- ${t.name}: ${t.role}`),
    '',
    o.open.length ? 'Peças já abertas (não repita o assunto):' : 'Nenhuma peça aberta agora.', ...o.open.map(x => `- ${x}`),
    o.radar.length ? 'Oportunidades recentes do Radar (pode usar; cite o id em "referencias"):' : 'Radar sem oportunidade nova.', ...o.radar.map(x => `- ${x}`),
    '',
    `Leia antes: \`equipe/manual-da-agencia.md\` (como a sala trabalha), \`equipe/destinos.md\` (objetivo de cada conta), \`equipe/base.md\`${o.academy ? ', `academia/INDICE.md` (técnicas de vídeo que a equipe já aprendeu)' : ''}.`,
    'Decida: quantas peças (no máximo 6), conta, formato, data, objetivo, público, mensagem, gancho, chamada para ação, métrica de sucesso e se precisa de pesquisa antes do roteiro (só quando faltar referência ou fato verificado). "Amanhã" sem conta dita = uma peça principal por conta ativa. Fato técnico só com fonte; nada de cliente, número ou resultado inventado. O que só o Chefe decide vai em "perguntas", mas planeje mesmo assim com a suposição mais simples e escreva a suposição no briefing.',
    '',
    `Grave \`${o.outputPath}\` (JSON):`,
    '```json',
    '{',
    '  "resumo": "o que você entendeu e o que a equipe vai fazer, em 2 a 4 frases",',
    '  "pecas": [{',
    '    "titulo": "...", "conta": "instagram-tuco", "formato": "video | carrossel | texto", "data": "AAAA-MM-DD",',
    '    "objetivo": "...", "publico": "...", "mensagem": "...", "gancho": "...", "cta": "...", "metrica": "...",',
    '    "briefing": "o que a peça precisa ter, em detalhe", "hipotese": "o que esperamos que aconteça e por quê",',
    '    "referencias": ["id do Radar ou link"], "pesquisa": false, "material": "nao_precisa | pronto | gravar"',
    '  }],',
    '  "perguntas": [], "fora": ["o que não dá para fazer e por quê"]',
    '}',
    '```',
    RULES,
  ].join('\n');
}

const STEP_TASK: Record<PieceStepKey, (dir: string) => string> = {
  pesquisa: dir => [
    `Encontre de 3 a 6 referências verificáveis (posts, vídeos, artigos, documentação oficial) e os fatos de que a peça precisa. Comece pela ferramenta pesquisar do navegador da HQ (X, Reddit, Instagram e Threads, só leitura, sem pedir autorização) e pelos arquivos da pasta (\`radar/\`, \`referencias/\`, \`academia/\`). WebSearch e WebFetch pedem a autorização do Chefe a cada uso e a etapa fica parada até ele responder: use só se for indispensável.`,
    `Grave \`${dir}\\pesquisa.md\`: para cada referência, link, data, o que funciona nela e o que adaptar (sem copiar); os fatos com a fonte primária; e o que NÃO deu para verificar. Leia \`equipe/funcoes/pesquisador.md\`.`,
  ].join('\n'),
  roteiro: dir => [
    `Escreva o roteiro. Leia \`equipe/funcoes/criador.md\`, \`equipe/base.md\`, \`equipe/destinos.md\` e, se existir, \`pesquisa.md\` na pasta da peça.`,
    `Grave \`${dir}\\roteiro.md\` com: gancho (0 a 3 s: o que aparece e o que se ouve), desenvolvimento em blocos com o tempo de cada um, o texto de narração de cada bloco (frases curtas, faladas como gente fala), indicações visuais (o que aparece e o que acontece na tela), chamada para ação, legenda do post e hashtags. Não escreva video.json: a edição monta o vídeo depois da direção.`,
  ].join('\n'),
  direcao: dir => [
    `Defina a direção do vídeo como Diretor de Vídeo & Motion Design. Leia \`roteiro.md\` (e \`pesquisa.md\`, se existir) na pasta da peça, \`equipe/funcoes/diretor-video.md\`, \`equipe/contratos.md\` seção 3c (cenas da CenasReel, inclusive \`captura\`, \`fala\` e acabamento) e \`academia/INDICE.md\`, se existir.`,
    `Grave \`${dir}\\direcao.md\` com o storyboard cena a cena: tipo de cena da CenasReel, duração, o que aparece, a animação (o que se move e por quê), a \`fala\` da narração (com "voz": "gerar" quando o roteiro tiver narração), transição e som; as técnicas da Academia que valem aqui; e o que a edição deve evitar. A edição escreve o video.json seguindo este arquivo.`,
  ].join('\n'),
};

/** Tarefa de uma etapa: ficha da peça, o que fazer e o JSON curto que fecha a etapa. */
export function stepPrompt(o: { key: PieceStepKey; item: ContentItem; slotLabel: string; dir: string; outputPath: string; prev: { key: PieceStepKey; file: string; who: string | null }[] }): string {
  const i = o.item;
  return [
    `${PIECE_STEP_LABEL[o.key]} da peça "${i.title}" (etapa da linha de produção da sala).`,
    '',
    'Ficha:',
    `- Conta: ${o.slotLabel} · formato: ${i.format} · data: ${i.date ?? 'sem data'}`,
    `- Objetivo: ${i.objective || 'ver equipe/destinos.md'}`,
    `- Briefing: ${i.brief || '(sem briefing)'}`,
    i.hypothesis ? `- Hipótese: ${i.hypothesis}` : '',
    i.sources.length ? `- Fontes: ${i.sources.join(' ; ')}` : '',
    `- Pasta da peça: \`${o.dir}\``,
    o.prev.length ? `- Etapas já feitas: ${o.prev.map(p => `${PIECE_STEP_LABEL[p.key]} (${p.who ?? 'equipe'}): \`${p.file}\``).join('; ')}` : '',
    '',
    STEP_TASK[o.key](o.dir),
    '',
    `Por fim grave \`${o.outputPath}\` (JSON): {"resumo": "o que você entregou em 1 ou 2 frases", "arquivos": ["${PIECE_STEP_FILE[o.key]}"], "pendencias": ["o que falta e quem resolve"]}.`,
    RULES,
  ].filter(l => l !== '').join('\n');
}

/** Linha para o prompt da produção: o que as etapas anteriores deixaram na pasta. */
export function stepsNote(steps: PieceStep[]): string | null {
  const done = steps.filter(s => s.status === 'feito');
  if (!done.length) return null;
  return `Etapas já feitas pela equipe (siga-as; você monta a peça final): ${done.map(s => `${PIECE_STEP_LABEL[s.key]} de ${s.employeeName ?? 'equipe'} em \`${PIECE_STEP_FILE[s.key]}\`${s.summary ? ` (${s.summary.slice(0, 200)})` : ''}`).join('; ')}. Se o roteiro tiver narração, use "fala" nas cenas e "voz": "gerar".`;
}
