// Trabalho de conteúdo da sala Social Media: Radar de oportunidades, calendário de sete dias, peças com responsável e
// revisão, publicação registrada só com evidência e resultados com métrica, período e fonte. Tudo é estado REAL: o que um
// funcionário entregou e a HQ conferiu, o que o Chefe digitou ou importou. Nada simulado é mostrado como real.
import type { SocialSlotId } from './social.js';

// ---------------- Destinos (objetivo por conta) ----------------

/** Objetivo editorial de um destino. Separado da conta (identidade) e do perfil editorial (marca). Proposta inicial editável. */
export interface ContentDestination {
  slot: SocialSlotId;
  /** Papel do destino no plano (uma frase). */
  objective: string;
  audience: string;
  /** 'pt-BR', 'en'... O X começa em inglês; os outros seguem o perfil. */
  language: string;
  pillars: string[];
  /** Que tipo de conteúdo cabe aqui. */
  content: string;
  /** Indicador principal (o que diz se o destino está cumprindo o papel). */
  indicator: string;
  /** 'proposta' = matriz inicial ainda não revista pelo Chefe; 'confirmado' = ele revisou. */
  state: 'proposta' | 'confirmado';
  updatedAt: number;
}

// ---------------- Foco (destinos ativos) e fontes de pesquisa ----------------

/** Fontes de pesquisa do Radar. Pesquisar numa rede NÃO libera produção, agendamento nem publicação nela (isso é o foco). */
export type ResearchSource = 'instagram' | 'tiktok' | 'x' | 'reddit';
export const RESEARCH_SOURCES: { source: ResearchSource; label: string; role: string }[] = [
  { source: 'instagram', label: 'Instagram', role: 'Reels, carrosséis e memes: aberturas, capas, revelações, animações, jeitos de explicar tecnologia, comentários e formatos recorrentes' },
  { source: 'tiktok', label: 'TikTok', role: 'vídeos, memes, narrativas, transições, ritmo, edição, demonstrações e usos de áudio do nicho (adaptados para os nossos Instagrams)' },
  { source: 'x', label: 'X', role: 'posts, imagens, demonstrações de ferramentas, novidades, humor e conversas que virem conteúdo visual ou comentário no Threads' },
  { source: 'reddit', label: 'Reddit', role: 'discussões, dúvidas, relatos, projetos e memes das comunidades, com o contexto da publicação' },
];
export interface ResearchSourceState {
  source: ResearchSource;
  /** Ligada como fonte de pesquisa (controle separado dos destinos). */
  enabled: boolean;
  /** Acesso real na última rodada que declarou esta fonte. */
  access: 'acessada' | 'parcial' | 'bloqueada' | 'nao_verificada';
  detail: string | null;
  at: number | null;
}
export const FOCUS_REASON_DEFAULT = 'Foco atual: Instagrams Tuco Dev e Aurora + Threads Aurora';
/** Motivo da pausa a partir dos destinos ativos (o conjunto de 03/11 dá exatamente FOCUS_REASON_DEFAULT). */
export function focusReasonFor(slots: SocialSlotId[]): string {
  const parts: string[] = [];
  const ig = (['instagram-tuco', 'instagram-aurora'] as SocialSlotId[]).filter(s => slots.includes(s));
  if (ig.length === 2) parts.push('Instagrams Tuco Dev e Aurora');
  else if (ig.length === 1) parts.push(ig[0] === 'instagram-tuco' ? 'Instagram Tuco Dev' : 'Instagram Aurora');
  const other: Record<string, string> = { threads: 'Threads Aurora', tiktok: 'TikTok', linkedin: 'LinkedIn', x: 'X', pinterest: 'Pinterest' };
  for (const s of slots) if (other[s]) parts.push(other[s]);
  return `Foco atual: ${parts.join(' + ')}`;
}
export const FOCUS_EXPANSION_RULE = 'As outras redes só voltam quando a sala estiver entregando conteúdo utilizável, houver resultados observados nos dois Instagrams e o Chefe decidir expandir. Nada reativa sozinho por data ou por um post com muitas visualizações.';

export interface ContentFocus {
  /** Destinos com produção, agendamento e publicação liberados; os outros ficam pausados (conta, conexão, histórico e arquivos
   *  preservados). null = foco nunca definido (todos liberados, como antes). */
  activeSlots: SocialSlotId[] | null;
  reason: string;
  sources: ResearchSourceState[];
  expansion: string;
  updatedAt: number | null;
}

/** Capacidade real da fila: no máximo `limit` ideias do Radar em produção ao mesmo tempo; revisão acumulada segura a fila. */
export interface ContentCapacity {
  limit: number;
  /** Ideias do Radar (ou referências) em produção agora: planejada, em produção, parcial, falhou ou ajustar. */
  load: number;
  /** Peças completas esperando a revisão do Chefe nos destinos ativos. */
  reviewBacklog: number;
  reviewMax: number;
  /** Motivo de o Radar não puxar ideia nova agora (null = há vaga). */
  blocked: string | null;
}

/** Rotina do Radar como a tela mostra: agenda, última e próxima execução, resultado e erro reais. */
export interface RadarSchedule {
  routineId: string | null;
  title: string | null;
  label: string | null;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastResult: string | null;
  lastError: string | null;
  note: string;
}

// ---------------- Radar ----------------

/** Origem do achado: referência enviada pelo Chefe, achado pontual, padrão em várias publicações ou hipótese criativa. */
export type RadarKind = 'chefe' | 'achado' | 'padrao' | 'hipotese';
export const RADAR_KIND_LABEL: Record<RadarKind, string> = { chefe: 'Referência do Chefe', achado: 'Achado pontual', padrao: 'Padrão em várias publicações', hipotese: 'Hipótese criativa' };
/** O que foi realmente inspecionado. */
export type RadarInspected = 'captura' | 'imagem' | 'texto' | 'video_parcial' | 'video_sem_audio' | 'video_completo_audio';
export const RADAR_INSPECTED_LABEL: Record<RadarInspected, string> = {
  captura: 'captura de tela', imagem: 'imagem', texto: 'texto', video_parcial: 'vídeo parcial', video_sem_audio: 'vídeo assistido sem áudio', video_completo_audio: 'vídeo completo com áudio',
};
/** Métrica pública com o nome que a plataforma usa e o texto cru (ex.: "1.2M"). value null = indisponível. */
export interface RadarMetric { name: string; value: number | null; raw: string | null }
export interface RadarExample { url: string; author: string | null; platform: string | null; metrics: string | null; sameVideo: boolean }

/** Grau de evidência (milweb-video-studio/references/research.md). Um post popular não é tendência. */
export type RadarEvidence = 'referencia' | 'tendencia' | 'hipotese' | 'nao_verificado';
export const RADAR_EVIDENCE_LABEL: Record<RadarEvidence, string> = {
  referencia: 'Referência pontual', tendencia: 'Tendência observada', hipotese: 'Hipótese', nao_verificado: 'Não verificado',
};
/** Janela de atualidade da fonte. 'duravel' = referência durável (Pinterest, cases), nunca apresentada como novidade. */
export type RadarWindow = '24-48h' | '7d' | '30d' | 'duravel';

export interface RadarItem {
  id: string;
  roundId: string;
  sourceUrl: string;
  sourceName: string | null;
  author: string | null;
  /** Data de publicação como a fonte informa (ISO ou rótulo como "há 5 dias"); null = a fonte não informa. */
  publishedAt: string | null;
  /** Data e hora da consulta (ISO). */
  consultedAt: string;
  subject: string;
  /** Sinais observados (o que foi visto de fato, com números e nomes de métrica como aparecem). */
  signals: string;
  evidence: RadarEvidence;
  window: RadarWindow | null;
  /** Conta adequada (null = nenhuma das sete). */
  slot: SocialSlotId | null;
  interpretation: string;
  /** Proposta original (mecanismo adaptado, criação própria). */
  proposal: string;
  /** 1 a 3 = prioridade da rodada; null = registrada sem prioridade. */
  priority: number | null;
  reason: string | null;
  /** Material necessário (o que já existe e o que falta gravar). */
  material: string | null;
  /** Custo adicional (deve ser zero nesta etapa). */
  extraCost: string | null;
  /** 'analisando' = referência do Chefe esperando a análise do pesquisador. */
  status: 'nova' | 'analisando' | 'virou_peca' | 'descartada';
  itemId: string | null;
  createdAt: number;
  // ---- Radar da gringa (v12) ----
  kind: RadarKind;
  /** instagram, tiktok, x, reddit, web ou null (referência sem link). */
  platform: string | null;
  /** Identidade normalizada do post (ex.: "instagram:DAbc123", "reddit:1abcd"); a mesma chave atualiza em vez de duplicar. */
  postKey: string | null;
  language: string | null;
  /** Só com evidência (idioma não prova país). */
  region: string | null;
  metrics: RadarMetric[];
  inspected: RadarInspected | null;
  /** O que foi visto de fato (abertura, progressão, animação, virada, encerramento). */
  observed: string | null;
  summaryPt: string | null;
  context: string | null;
  /** Limitação do sinal de popularidade (likes acumulados não provam crescimento atual). */
  popularityLimit: string | null;
  /** Exemplos do mesmo padrão (criadores distintos; sameVideo = republicação do mesmo vídeo). */
  examples: RadarExample[];
  format: string | null;
  fit: string | null;
  opening: string | null;
  effort: string | null;
  /** Áudio citado e a situação da permissão no destino (nunca presumida). */
  audio: string | null;
  /** Arquivos da referência (envio do Chefe, capturas de evidência), dentro da pasta de conteúdo. */
  files: string[];
  /** Texto do Chefe junto da referência. */
  note: string | null;
  /** Quantas coletas viram esta referência (a nova coleta atualiza a existente). */
  seen: number;
  updatedAt: number;
  /** Referência de vídeo enviada pelo Chefe (link ou arquivo): inspeção, análise, reunião e produção. null = não é desse fluxo. */
  video: VideoRefState | null;
}

// ---------------- Referência de vídeo (link ou arquivo → análise → reunião → produção) ----------------

/** 'estudo' (07/11, "Equipe, estudem esse vídeo"): o Diretor de Vídeo analisa, separa o observado do inferido, dá a aula,
 *  distribui exercícios e guarda o aprendizado na Academia de Vídeo. Não produz peça. */
export type VideoRefMode = 'analise' | 'produzir' | 'estudo';
export const VIDEO_MODE_LABEL: Record<VideoRefMode, string> = { analise: 'analisar com a equipe', produzir: 'analisar e produzir', estudo: 'estudar (Academia)' };
export type VideoRefStage = 'recebida' | 'inspecionando' | 'analisando' | 'discussao' | 'proposta' | 'producao' | 'renderizando' | 'revisar' | 'aula' | 'exercicios' | 'bloqueada' | 'concluida' | 'lixeira';
export const VIDEO_STAGE_LABEL: Record<VideoRefStage, string> = {
  recebida: 'Referência recebida', inspecionando: 'Abrindo o vídeo', analisando: 'Em análise', discussao: 'Em discussão', proposta: 'Proposta pronta',
  producao: 'Em produção', renderizando: 'Renderizando', revisar: 'Para revisar', aula: 'Aula com a equipe', exercicios: 'Exercícios da equipe',
  bloqueada: 'Bloqueada', concluida: 'Concluída', lixeira: 'Peça na lixeira',
};
/** Estado simples da tarefa (pedido do Chefe, 07/11): pendente, em análise, em produção, bloqueada ou concluída. */
export type VideoTaskStatus = 'pendente' | 'em_analise' | 'em_producao' | 'bloqueada' | 'concluida';
export const VIDEO_TASK_STATUS_LABEL: Record<VideoTaskStatus, string> = { pendente: 'Pendente', em_analise: 'Em análise', em_producao: 'Em produção', bloqueada: 'Bloqueada', concluida: 'Concluída' };
export const VIDEO_TASK_STATUS: Record<VideoRefStage, VideoTaskStatus> = {
  recebida: 'pendente', inspecionando: 'em_analise', analisando: 'em_analise', discussao: 'em_analise', aula: 'em_analise', proposta: 'pendente',
  producao: 'em_producao', renderizando: 'em_producao', exercicios: 'em_producao', revisar: 'concluida', bloqueada: 'bloqueada', concluida: 'concluida', lixeira: 'concluida',
};
/** Linha do histórico de uma referência de vídeo (o que aconteceu, quando e com quem). */
export interface VideoRefEvent { at: number; text: string; who: string | null }
/** Papel de cada link num pedido com vários vídeos ("igual a este", "pode ser este áudio", "neste estilo"). */
export type VideoRefRole = 'base' | 'audio' | 'estilo' | 'referencia';
export const VIDEO_ROLE_LABEL: Record<VideoRefRole, string> = { base: 'base (o que adaptar)', audio: 'áudio', estilo: 'estilo do vídeo', referencia: 'outra referência' };
/** Link a mais no mesmo pedido: inspecionado como o principal, com o papel que o Chefe deu. */
export interface VideoRefExtra {
  url: string;
  role: Exclude<VideoRefRole, 'base'>;
  /** O que o Chefe escreveu sobre este link ("pode ser esse áudio"). */
  note: string | null;
  dir: string;
  level: VideoInspectionLevel | null;
  summary: string | null;
  title: string | null;
  author: string | null;
  duration: number | null;
  sheets: string[];
  /** Áudio extraído (papel "áudio"): a HQ mistura no vídeo com o tempo que a criação marcar. */
  audioFile: string | null;
  evidence: string | null;
  error: string | null;
}
/** Nível real da inspeção (o que as ferramentas permitiram verificar). */
export type VideoInspectionLevel = 'bloqueada' | 'pagina' | 'trechos' | 'video_sem_audio' | 'video_transcricao' | 'audiovisual';
export const VIDEO_LEVEL_LABEL: Record<VideoInspectionLevel, string> = {
  bloqueada: 'sem acesso', pagina: 'página e miniatura', trechos: 'trechos visuais', video_sem_audio: 'vídeo inteiro em quadros, sem áudio analisado',
  video_transcricao: 'vídeo inteiro em quadros + transcrição da fala', audiovisual: 'análise audiovisual completa',
};

export interface VideoRefState {
  /** 'analise' = só analisar e propor (não produz nem posta); 'produzir' = segue para a produção com a direção recomendada. */
  mode: VideoRefMode;
  stage: VideoRefStage;
  /** "O que gostei neste vídeo" (opcional: animação, humor, abertura, trecho 00:12–00:18...). */
  liked: string | null;
  /** Destino pedido (precisa estar no foco para produzir). */
  slot: SocialSlotId | null;
  /** Instrução do Chefe no chat ("quero um vídeo inspirado neste para o Tuco Dev"). */
  instruction: string | null;
  /** Conversa de origem (quando veio do campo de pedido). */
  sessionId: string | null;
  /** Pasta da referência (radar/entrada/...). */
  dir: string;
  /** Vídeo anexado pelo Chefe (quando não veio por link). */
  file: string | null;
  inspection: {
    level: VideoInspectionLevel; summary: string; limits: string[]; blocked: { reason: string; actions: ('login' | 'tentar' | 'anexar')[] } | null;
    title: string | null; author: string | null; platform: string | null; publishedAt: string | null; duration: number | null;
    thumbnail: string | null; pageShot: string | null; sheets: string[]; cuts: number[]; sameMedia: boolean | null; at: string;
    /** Skill Watch (plugin watch@claude-video) rodada pela HQ: quadros por mudança de cena com o tempo e a legenda nativa. */
    watch?: WatchRunInfo | null;
  } | null;
  /** Análise do Diretor de Vídeo (ou do pesquisador, sem Diretor): analise-video.json / analise.md (formato do Video Analyzer)
   *  e direcao.md (roteiro curto e storyboard da versão recomendada). */
  analysis: { file: string; md: string | null; central: string | null; recommended: string | null; at: number; direction?: string | null; by?: string | null } | null;
  meetingId: string | null;
  /** Síntese do gerente (fim da discussão): a direção a produzir. */
  synthesis: { messageId: string; text: string; author: string; at: number } | null;
  /** Produções que saíram desta referência (pode haver mais de uma, com conta e objetivo próprios). */
  itemIds: string[];
  /** Outros links do mesmo pedido (áudio, estilo, outra referência). Ausente em cartões antigos. */
  extras?: VideoRefExtra[];
  /** Histórico (07/11): cada passo com hora e quem fez. Ausente em cartões antigos. */
  events?: VideoRefEvent[];
  /** Modo estudo: o estudo da Academia de Vídeo ligado a esta referência. */
  studyId?: string | null;
  error: string | null;
  updatedAt: number;
}

/** Resultado da skill Watch rodada pela HQ sobre a referência. */
export interface WatchRunInfo {
  ok: boolean;
  /** Relatório da Watch (markdown), dentro da pasta da referência. */
  report: string | null;
  /** Quadros (JPEG, até 512 px de largura) com o tempo no vídeo original. */
  frames: { file: string; t: string }[];
  /** Origem da transcrição segundo a Watch ("captions (en, manual)", "none"...). */
  transcript: string | null;
  /** O que foi assistido: o link ou o arquivo local. */
  source: 'link' | 'arquivo';
  version: string | null;
  error: string | null;
}

// ---------------- Academia de Vídeo (07/11) ----------------

/** Observado = visto nos quadros, nas evidências medidas ou na transcrição; inferido = hipótese do Diretor (não verificado). */
export type TechniqueEvidence = 'observado' | 'inferido';
export const TECHNIQUE_EVIDENCE_LABEL: Record<TechniqueEvidence, string> = { observado: 'observado', inferido: 'inferência (não verificado)' };
export type TechniqueCategory = 'animacao' | 'transicao' | 'corte' | 'tipografia' | 'som' | 'ritmo' | 'camera' | 'composicao' | 'narrativa' | 'cor' | 'efeito' | 'outro';
export const TECHNIQUE_CATEGORY_LABEL: Record<TechniqueCategory, string> = {
  animacao: 'Animação', transicao: 'Transição', corte: 'Corte', tipografia: 'Tipografia', som: 'Som', ritmo: 'Ritmo', camera: 'Câmera', composicao: 'Composição',
  narrativa: 'Narrativa', cor: 'Cor', efeito: 'Efeito', outro: 'Outro',
};
export type TechniqueTool = 'remotion' | 'ffmpeg' | 'gsap' | 'css' | 'edicao' | 'outro';
export interface AcademyTechnique {
  id: string;
  /** Identificador estável (kebab-case); a mesma técnica em outro estudo soma a fonte em vez de duplicar. */
  slug: string;
  name: string;
  category: TechniqueCategory;
  /** O que é, em uma ou duas frases. */
  summary: string;
  /** Como fazer com as ferramentas da casa. */
  how: { tool: TechniqueTool; text: string }[];
  /** Onde foi vista (estudo, trecho) e com que grau de evidência. */
  sources: { studyId: string; title: string; at: string | null; evidence: TechniqueEvidence; note: string | null }[];
  /** Exercícios da equipe que aplicaram a técnica, com a correção do Diretor. */
  examples: { studyId: string; exerciseId: string; employee: string | null; file: string | null; verdict: 'ok' | 'ajustar' | null; note: string | null }[];
  pitfalls: string[];
  /** Ficha em academia/tecnicas/<slug>.md. */
  file: string | null;
  createdAt: number;
  updatedAt: number;
}
export type AcademyExerciseStatus = 'pendente' | 'em_producao' | 'concluido' | 'falhou';
export const ACADEMY_EXERCISE_STATUS_LABEL: Record<AcademyExerciseStatus, string> = { pendente: 'Pendente', em_producao: 'Em produção', concluido: 'Entregue', falhou: 'Não deu certo' };
export interface AcademyExercise {
  id: string;
  title: string;
  role: ContentRole;
  /** Equipe (perfil) do exercício; null = quem atende as duas. */
  profileId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  techniques: string[];
  instructions: string;
  /** O que entregar (ex.: "video.json que a HQ renderiza", "roteiro.md + storyboard.md"). */
  deliverable: string;
  dir: string;
  status: AcademyExerciseStatus;
  taskId: string | null;
  result: { summary: string | null; files: string[]; learned: string | null; doubts: string | null; render: string | null; at: number } | null;
  feedback: { verdict: 'ok' | 'ajustar'; note: string; at: number } | null;
  error: string | null;
}
export type AcademyStudyStatus = 'analisando' | 'aula' | 'exercicios' | 'correcao' | 'concluido' | 'bloqueado';
export const ACADEMY_STUDY_STATUS_LABEL: Record<AcademyStudyStatus, string> = {
  analisando: 'Diretor estudando o vídeo', aula: 'Aula com a equipe', exercicios: 'Exercícios em andamento', correcao: 'Diretor corrigindo', concluido: 'Concluído', bloqueado: 'Bloqueado',
};
export interface AcademyStudy {
  id: string;
  radarId: string;
  title: string;
  url: string | null;
  /** Pasta do estudo (academia/estudos/<data>-<nome>/): vídeo, quadros, análise, lição, exercícios e correção. */
  folder: string;
  /** O que o Chefe escreveu ao mandar o vídeo. */
  request: string | null;
  status: AcademyStudyStatus;
  /** A lição em uma frase. */
  summary: string | null;
  lesson: string | null;
  analysis: string | null;
  techniques: { slug: string; evidence: TechniqueEvidence }[];
  exercises: AcademyExercise[];
  meetingId: string | null;
  /** Síntese da aula (gerente) e a correção do Diretor. */
  lessonSynthesis: string | null;
  feedback: string | null;
  history: VideoRefEvent[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface AcademyState {
  studies: AcademyStudy[];
  techniques: AcademyTechnique[];
  /** academia/INDICE.md (o que a equipe lê antes de produzir vídeo). */
  index: string | null;
}

/** Envio de uma referência de vídeo pelo campo de pedido (link colado ou arquivo). */
export interface VideoRefInput {
  url?: string | null;
  file?: { name: string; mediaType: string; dataBase64: string } | null;
  /** Arquivo de vídeo que já está no computador. */
  path?: string | null;
  liked?: string | null;
  slot?: SocialSlotId | null;
  /** Ausente = decidido pela instrução ("quero um vídeo inspirado neste..." produz; só o link, analisa). */
  mode?: VideoRefMode | null;
  instruction?: string | null;
  sessionId?: string | null;
  profileId?: string | null;
  /** Outros links do mesmo pedido, com o papel de cada um. */
  extras?: { url: string; role: Exclude<VideoRefRole, 'base'>; note?: string | null }[] | null;
}

// ---------------- Rodadas (radar, semana, análise, transcrição) ----------------

export type ContentRoundKind = 'radar' | 'semana' | 'analise' | 'transcricao' | 'referencia' | 'video' | 'estudo' | 'exercicio' | 'correcao' | 'plano' | 'etapa';
export const CONTENT_ROUND_LABEL: Record<ContentRoundKind, string> = {
  radar: 'Radar', semana: 'Preparar minha semana', analise: 'Análise semanal', transcricao: 'Transcrição de captura', referencia: 'Análise de referência', video: 'Análise de vídeo',
  estudo: 'Estudo de vídeo (Academia)', exercicio: 'Exercício da Academia', correcao: 'Correção dos exercícios', plano: 'Plano da gerente', etapa: 'Etapa da peça',
};

// ---------------- Etapas da peça (linha de produção, 08/11/2026) ----------------
/** Etapas antes da produção final: pesquisa (pesquisador), roteiro (criação da equipe), direção (Diretor de Vídeo). Depois
 *  vêm a produção (edição ou criação, o que já existia), a revisão (Otto) e a aprovação do Chefe. A HQ passa de uma etapa para
 *  a outra sozinha, conferindo no disco o arquivo de cada uma. */
export type PieceStepKey = 'pesquisa' | 'roteiro' | 'direcao';
export const PIECE_STEP_LABEL: Record<PieceStepKey | 'producao' | 'revisao' | 'aprovacao', string> = {
  pesquisa: 'Pesquisa', roteiro: 'Roteiro', direcao: 'Direção de vídeo', producao: 'Produção', revisao: 'Revisão', aprovacao: 'Sua aprovação',
};
export const PIECE_STEP_FILE: Record<PieceStepKey, string> = { pesquisa: 'pesquisa.md', roteiro: 'roteiro.md', direcao: 'direcao.md' };
export interface PieceStep {
  key: PieceStepKey;
  /** Quem faz (funcionário escolhido quando a etapa começa). */
  employeeId: string | null;
  employeeName: string | null;
  status: 'pendente' | 'fazendo' | 'feito' | 'falhou';
  roundId: string | null;
  /** Arquivos entregues (dentro da pasta da peça). */
  files: string[];
  summary: string | null;
  error: string | null;
  startedAt: number | null;
  doneAt: number | null;
}
export interface PiecePipeline { steps: PieceStep[]; createdAt: number }

/** Plano da gerente para um pedido em texto livre do Chefe ("Preparem os conteúdos de amanhã..."). */
export interface ManagerPlan {
  status: 'planejando' | 'pronto' | 'falhou';
  /** O que a gerente entendeu e decidiu. */
  summary: string | null;
  /** plano.json na pasta de conteúdo. */
  file: string | null;
  managerId: string | null;
  managerName: string | null;
  roundId: string | null;
  /** Peças criadas pelo plano. */
  itemIds: string[];
  /** Perguntas que só o Chefe responde (o resto a equipe decide). */
  questions: string[];
  /** O que ficou fora e por quê. */
  left: string[];
  error: string | null;
  at: number;
}

export interface ContentRound {
  id: string;
  kind: ContentRoundKind;
  taskId: string | null;
  routineId: string | null;
  employeeId: string | null;
  /** 'aguardando' = tarefa na fila ou em execução; 'concluida' = saída importada; 'vazia' = rodou e não achou nada pertinente;
   *  'falhou' = a tarefa falhou ou a saída não passou na validação (motivo em error). */
  status: 'aguardando' | 'concluida' | 'vazia' | 'falhou';
  startedAt: number;
  finishedAt: number | null;
  /** Cobertura real declarada pelo pesquisador (redes e fontes acessadas, bloqueios). */
  coverage: string | null;
  summary: string | null;
  /** Arquivo JSON esperado (caminho absoluto). */
  outputPath: string;
  error: string | null;
  /** Semana de referência (segunda-feira, YYYY-MM-DD), para 'semana' e 'analise'. */
  weekStart: string | null;
  /** Quem fez: 'rotina' (agendador), 'tela' (botão), 'sessao' (pesquisa feita fora da fila, importada com essa marca), 'referencia'. */
  origin: 'rotina' | 'tela' | 'sessao' | 'referencia' | null;
  /** Cobertura real por fonte declarada na rodada. */
  sources: ResearchSourceState[] | null;
}

// ---------------- Peças (calendário) ----------------

/** parcial = a produção terminou, mas falta o que o formato exige (ex.: roteiro sem vídeo); falhou = a tarefa terminou com erro,
 *  limite ou interrupção. Nenhum dos dois conta como "para revisar". */
export type ContentItemStatus = 'planejada' | 'em_producao' | 'parcial' | 'falhou' | 'revisar' | 'ajustar' | 'aprovada' | 'publicacao_pendente' | 'agendada' | 'publicada' | 'descartada';
export const CONTENT_ITEM_STATUS_LABEL: Record<ContentItemStatus, string> = {
  planejada: 'Planejada', em_producao: 'Em produção', parcial: 'Entrega parcial', falhou: 'Falhou', revisar: 'Para revisar', ajustar: 'Ajustar', aprovada: 'Aprovada',
  publicacao_pendente: 'Publicação a conferir', agendada: 'Agendada no site', publicada: 'Publicada', descartada: 'Descartada',
};
/** Estado do material: o que já existe e o que ainda precisa ser gravado ou editado. */
export type ContentMaterial = 'pronto' | 'gravar' | 'editar' | 'nao_precisa';
export const CONTENT_MATERIAL_LABEL: Record<ContentMaterial, string> = { pronto: 'Material pronto', gravar: 'Falta gravar', editar: 'Falta editar', nao_precisa: 'Sem material visual' };

/** Verificação automática da entrega (tamanho de texto, link real, arquivo existente...). */
export interface ContentCheck { name: string; ok: boolean; detail: string }

export interface ContentReview {
  verdict: 'aprovar' | 'ajustar';
  notes: string;
  checks: ContentCheck[];
  employeeId: string | null;
  at: number;
}

export interface ContentPublication {
  url: string | null;
  at: number;
  /** 'provedor' = a API devolveu o post; 'navegador' = o post foi aberto na conta logada e o texto confere; 'link' = o link
   *  respondeu e é da rede certa; 'pendente' = sem confirmação ainda (inclui "resultado a verificar" depois de clique sem resposta);
   *  'chefe' = o Chefe informou que publicou ("Já publiquei"), sem link conferido. */
  verifiedBy: 'provedor' | 'navegador' | 'link' | 'pendente' | 'chefe';
  detail: string;
}

export interface ContentItem {
  id: string;
  /** Semana (segunda-feira, YYYY-MM-DD) do calendário em que entrou. */
  weekStart: string | null;
  /** Peça-base comum (um projeto pode render Reel, case e Pin com recortes próprios). */
  baseId: string | null;
  baseTitle: string | null;
  /** Data sugerida (YYYY-MM-DD). */
  date: string | null;
  /** Horário (HH:MM, America/Sao_Paulo) para publicar pela fila da HQ; null = sem horário. */
  time: string | null;
  slot: SocialSlotId | null;
  profileId: string | null;
  format: string;
  objective: string;
  title: string;
  /** Texto, roteiro ou briefing (o que o criador deve fazer). */
  brief: string;
  sources: string[];
  /** Arquivos necessários (caminhos reais ou descrição do que falta). */
  files: string[];
  material: ContentMaterial;
  /** Responsável (funcionário). */
  ownerId: string | null;
  skill: string | null;
  reviewCriteria: string;
  status: ContentItemStatus;
  taskId: string | null;
  reviewTaskId: string | null;
  radarId: string | null;
  /** Pasta da peça (marcas/<marca>/pecas/<data>-<slug>). */
  folder: string | null;
  /** Arquivo principal entregue. */
  deliverable: string | null;
  checks: ContentCheck[];
  review: ContentReview | null;
  nextStep: string | null;
  approvalId: string | null;
  publication: ContentPublication | null;
  /** Lixeira (restaurável): fora do mural ativo, dos contadores e de qualquer produção ou publicação automática. */
  deletedAt: number | null;
  /** Arquivada: preservada fora da visão principal. */
  archivedAt: number | null;
  /** Pedido de origem (ex.: "conteúdo de 04/11 para todas as contas"). */
  requestId: string | null;
  /** Histórico das mudanças de estado (quem, quando e por quê). */
  history: ContentItemHistory[];
  createdAt: number;
  updatedAt: number;
  /** Pausada pelo foco (destino fora dos ativos): nada produz, agenda ou publica; o trabalho e os arquivos ficam. */
  pausedReason: string | null;
  /** Hipótese editorial principal que a peça testa. */
  hypothesis: string | null;
  /** Referências do Radar ligadas à peça (inclui as enviadas pelo Chefe, com ou sem link). */
  referenceIds: string[];
  /** Decisão depois de olhar os resultados. */
  learning: ContentLearning | null;
  /** Etapas antes da produção (pesquisa, roteiro, direção), quando a peça veio de um plano. null = produção direta. */
  pipeline: PiecePipeline | null;
}

export type ContentDecision = 'repetir' | 'ajustar' | 'testar' | 'abandonar';
export const CONTENT_DECISION_LABEL: Record<ContentDecision, string> = { repetir: 'Repetir', ajustar: 'Ajustar', testar: 'Testar outra abertura ou ritmo', abandonar: 'Abandonar a hipótese' };
export interface ContentLearning { decision: ContentDecision; note: string; at: number }

export interface ContentItemHistory { at: number; from: ContentItemStatus | null; to: ContentItemStatus | null; action: string; detail: string | null; origin: string }

/** Pedido do Chefe: um dia e as contas que ele espera, uma publicação principal por conta. O progresso vem das peças ligadas. */
export interface ContentRequest {
  id: string;
  title: string;
  /** Dia das publicações (YYYY-MM-DD). */
  date: string;
  slots: SocialSlotId[];
  note: string | null;
  origin: string;
  /** Produção autorizada: conta sem peça recebe uma da pesquisa (Radar) assim que ela terminar, e vai para a fila. */
  autoProduce: boolean;
  status: 'ativo' | 'concluido' | 'arquivado';
  createdAt: number;
  updatedAt: number;
  /** Pedido em texto livre que a gerente transformou em plano (null = pedido feito pelo formulário). */
  plan: ManagerPlan | null;
}

/** Cartão escondido do mural ou da mesa (tarefa avulsa ou entrega de reunião): a tarefa e os arquivos continuam existindo. */
export interface ContentHidden { key: string; kind: 'task' | 'delivery'; state: 'arquivada' | 'lixeira'; at: number; title: string | null }

/** Conferência de uma peça contra o que o formato exige (usada na correção dos registros, com histórico). */
export interface ContentVerifyRow { id: string; title: string; slot: SocialSlotId | null; from: ContentItemStatus; to: ContentItemStatus; have: string[]; missing: string[]; reason: string }

// ---------------- Aprovação em lote ----------------

/** Aprovação do Chefe para um lote (peças, contas e período). Dentro do escopo a HQ não pede confirmação de novo. */
export interface ContentApproval {
  id: string;
  itemIds: string[];
  slots: SocialSlotId[];
  from: string;
  to: string;
  note: string | null;
  createdAt: number;
  revokedAt: number | null;
}

// ---------------- Resultados ----------------

export type ResultSource = 'integracao' | 'navegador' | 'csv' | 'captura' | 'manual';
export interface ContentResult {
  id: string;
  itemId: string | null;
  slot: SocialSlotId | null;
  postUrl: string | null;
  /** Nome exato da métrica como a rede chama (ex.: "Contas alcançadas", "Visualizações", "Cliques no link"). */
  metric: string;
  /** null = não coletado (nunca estimado). */
  value: number | null;
  unit: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Idade do post na coleta (horas), para comparar posts de idade semelhante. */
  ageHours: number | null;
  /** Denominador de qualquer taxa (ex.: "contas alcançadas"). */
  denominator: string | null;
  source: ResultSource;
  evidencePath: string | null;
  /** Transcrição de captura ainda não conferida pelo Chefe. */
  uncertain: boolean;
  /** Hipótese testada por esta publicação. */
  hypothesis: string | null;
  note: string | null;
  collectedAt: number;
}

export interface ContentAnalysis {
  roundId: string;
  weekStart: string | null;
  observed: string[];
  promising: string[];
  adjust: string[];
  nextTest: { hypothesis: string; change: string; metric: string; criterion: string } | null;
  limits: string[];
  at: number;
}

// ---------------- Configuração da sala ----------------

export type ContentRole = 'coordenador' | 'pesquisador' | 'criador' | 'revisor' | 'video' | 'direcao';
export const CONTENT_ROLE_LABEL: Record<ContentRole, string> = {
  coordenador: 'Coordenação editorial', pesquisador: 'Pesquisa de tendências', criador: 'Criação de conteúdo', revisor: 'Revisão e análise', video: 'Edição de vídeo',
  direcao: 'Diretor de Vídeo & Motion Design',
};
/**
 * Equipes por perfil (pedido do Chefe, 06/11/2026): cada perfil do Instagram tem criação e vídeo próprios; pesquisa (Caio),
 * pauta (Marina) e revisão (Otto) atendem as duas. O perfil da equipe é o `profileId` do funcionário.
 */
export const CONTENT_SQUADS: { profileId: string; label: string; focus: string; members: { role: 'criador' | 'video'; name: string }[] }[] = [
  { profileId: 'tuco-dev', label: 'Equipe Tuco Dev', focus: 'Sua equipe cuida só do Instagram do Tuco Dev (@tucoexemplo): tecnologia, programação e IA explicadas sem complicar, com humor de dev.',
    members: [{ role: 'criador', name: 'Nina' }, { role: 'video', name: 'Teo' }] },
  { profileId: 'aurora', label: 'Equipe Aurora', focus: 'Sua equipe cuida do Instagram (@auroraexemplo) e do Threads da Aurora: o trabalho real do Chefe, na voz dele.',
    members: [{ role: 'criador', name: 'Bia' }, { role: 'video', name: 'Clara' }] },
];
/** As seis especialidades por rede (skills de projeto na pasta de conteúdo). */
export const CONTENT_SPECIALTIES = ['rede-instagram', 'rede-threads', 'rede-tiktok', 'rede-linkedin', 'rede-x', 'rede-pinterest'] as const;

export interface ContentSetup {
  projectId: string | null;
  folder: string | null;
  folderExists: boolean;
  team: { role: ContentRole; employeeId: string | null; name: string | null }[];
  /** Especialidades encontradas na pasta (arquivo real) e a verificação do catálogo. */
  specialties: { name: string; path: string | null; ok: boolean; detail: string }[];
  routines: { kind: 'radar' | 'analise'; routineId: string | null; label: string | null }[];
  /** O que falta e quem resolve. */
  missing: string[];
}

export interface ContentState {
  setup: ContentSetup;
  destinations: ContentDestination[];
  rounds: ContentRound[];
  radar: RadarItem[];
  items: ContentItem[];
  approvals: ContentApproval[];
  results: ContentResult[];
  analyses: ContentAnalysis[];
  requests: ContentRequest[];
  hidden: ContentHidden[];
  focus: ContentFocus;
  capacity: ContentCapacity;
  radarSchedule: RadarSchedule;
  /** Academia de Vídeo (estudos, técnicas e exercícios). Ausente em servidores antigos. */
  academy?: AcademyState;
}

/** Formato do pedido rápido: vídeo (renderizado pela HQ), carrossel (slides desenhados pela HQ) ou texto (post do Threads). */
export type QuickFormat = 'video' | 'carrossel' | 'texto';
/** Contas da tela Conteúdo (foco de 06/11: Instagram do Tuco e Instagram + Threads da Aurora; o TikTok é do Chefe). */
export const QUICK_SLOTS = ['instagram-tuco', 'instagram-aurora', 'threads'] as const;
/** Formatos que cada conta aceita no pedido rápido: Threads é texto; as outras, vídeo e carrossel. */
export function quickFormatsFor(slot: SocialSlotId): QuickFormat[] { return slot === 'threads' ? ['texto'] : ['video', 'carrossel']; }
/** Nome do formato gravado na peça (o mesmo texto que a produção e a conferência já reconhecem). */
export function quickFormatName(format: QuickFormat, slot: SocialSlotId): string {
  if (format === 'texto') return 'post Threads';
  if (format === 'carrossel') return slot === 'tiktok' ? 'carrossel de fotos (TikTok)' : 'carrossel';
  return slot === 'tiktok' ? 'vídeo TikTok' : 'Reel';
}
/** Título curto a partir do pedido: primeira linha, sem link, cortado numa palavra. */
export function quickTitle(text: string): string {
  const line = text.replace(/https?:\/\/\S+/g, '').split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '';
  const clean = line.replace(/\s+/g, ' ').replace(/^(quero|queria|faz|faça|fazer|cria|crie|criar)\s+(um|uma)?\s*/i, '');
  if (clean.length <= 90) return clean.charAt(0).toUpperCase() + clean.slice(1);
  const cut = clean.slice(0, 90); const sp = cut.lastIndexOf(' ');
  return `${(sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, '')}…`.replace(/^./, c => c.toUpperCase());
}

export interface ContentItemPatch {
  date?: string | null; time?: string | null; slot?: SocialSlotId | null; profileId?: string | null; format?: string; objective?: string; title?: string; brief?: string;
  sources?: string[]; files?: string[]; material?: ContentMaterial; ownerId?: string | null; skill?: string | null; reviewCriteria?: string;
  status?: 'planejada' | 'descartada'; hypothesis?: string | null;
}

/** Referência enviada pelo Chefe ("Usar como referência"): imagem, vídeo, URL ou texto, com ou sem link original. */
export interface ContentReferenceInput {
  url?: string | null;
  text?: string | null;
  /** Arquivo enviado pela tela (até 40 MB cada). */
  files?: { name: string; mediaType: string; dataBase64: string }[];
  /** Arquivo que já está no computador (pasta cadastrada); é copiado para radar/entrada. */
  paths?: string[];
  /** Destino sugerido (precisa estar no foco). */
  slot?: SocialSlotId | null;
  title?: string | null;
  /** true (padrão) = o pesquisador analisa e a peça segue para a produção. */
  analyze?: boolean;
}

/** O que a peça entregou, conferido no disco: arquivos existentes (na ordem de uso), o texto exato a publicar e os caminhos citados que não existem. */
export interface ContentItemFiles {
  itemId: string;
  files: { path: string; name: string; kind: 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'other'; size: number }[];
  /** Texto do post (entrega.json "text"); null quando a entrega não tem. */
  text: string | null;
  title: string | null;
  description: string | null;
  /** Caminhos citados na entrega (entrega.json, peca.md, ficha) que não existem no disco. */
  missing: string[];
}

export type ContentClientMessage =
  | { type: 'content.state'; reqId: string }
  /** Prepara a sala (idempotente): pasta, estrutura, especialidades, equipe, rotinas e destinos. Nunca apaga nem move nada. */
  | { type: 'content.setup'; reqId: string; folder?: string }
  | { type: 'content.destination.save'; reqId: string; destination: Omit<ContentDestination, 'updatedAt' | 'state'> & { confirm?: boolean } }
  /** Rodada de Radar agora (mesma tarefa que a rotina diária). */
  | { type: 'content.radar.run'; reqId: string; focus?: string | null }
  | { type: 'content.radar.discard'; reqId: string; id: string }
  /** Oportunidade → peça planejada (responsável = criador; o Chefe ajusta antes de produzir). */
  | { type: 'content.radar.toItem'; reqId: string; id: string; slot?: SocialSlotId | null }
  /** "Preparar minha semana": o coordenador monta o calendário de sete dias a partir do radar, objetivos, materiais e resultados. */
  | { type: 'content.week.prepare'; reqId: string; weekStart?: string | null; note?: string | null }
  /** Produz de uma vez as peças planejadas da semana (cada uma vai para a fila da criação e depois para uma revisão). */
  | { type: 'content.week.produce'; reqId: string; weekStart?: string | null }
  | { type: 'content.item.create'; reqId: string; item: ContentItemPatch & { title: string } }
  /** Pedido rápido da tela Conteúdo (05/11): o texto do Chefe vira a peça e já vai para a produção (sem calendário, sem reunião). */
  | { type: 'content.quick.create'; reqId: string; text: string; slot: SocialSlotId; format: QuickFormat }
  | { type: 'content.item.update'; reqId: string; id: string; patch: ContentItemPatch }
  /** Cria a tarefa de produção (fila única). */
  | { type: 'content.item.produce'; reqId: string; id: string; note?: string | null }
  /** Cria a tarefa de revisão (uma passada; o resultado volta para o Chefe). */
  | { type: 'content.item.review'; reqId: string; id: string }
  /** Arquivos que existem de verdade na entrega da peça (slides, vídeo, texto) e o texto exato a publicar. */
  | { type: 'content.item.files'; reqId: string; id: string }
  /** Lixeira: cancela o que estiver na fila ou rodando dessas peças e tira do mural ativo. Os arquivos ficam; nada sai das redes. */
  | { type: 'content.items.trash'; reqId: string; ids: string[] }
  /** Restaura da lixeira (não volta a produzir sozinha). */
  | { type: 'content.items.restore'; reqId: string; ids: string[] }
  | { type: 'content.items.archive'; reqId: string; ids: string[]; archived: boolean }
  /** Confere as peças contra o que o formato exige; apply = grava a correção de estado com histórico. */
  | { type: 'content.items.verify'; reqId: string; ids?: string[] | null; apply: boolean }
  /** Esconde ou mostra um cartão de tarefa avulsa ou de entrega de reunião (lixeira: cancela a tarefa se estiver na fila ou rodando). */
  | { type: 'content.hidden.set'; reqId: string; key: string; kind: 'task' | 'delivery'; state: 'arquivada' | 'lixeira' | null; title?: string | null; cancelTaskId?: string | null }
  /** Pedido do dia: liga as peças existentes daquela data e cria as que faltam (pieces) ou espera a pesquisa (autoProduce). */
  | { type: 'content.request.create'; reqId: string; date: string; slots: SocialSlotId[]; title?: string | null; note?: string | null; autoProduce?: boolean; itemIds?: string[]; pieces?: (ContentItemPatch & { title: string; slot: SocialSlotId })[] }
  | { type: 'content.request.update'; reqId: string; id: string; status?: ContentRequest['status']; note?: string | null }
  /** Pedido em texto livre para a gerente da sala: ela planeja as peças (conta, formato, data, etapas) e a HQ toca a produção. */
  /** Pedido geral à gerente. `teams` limita as contas às equipes escolhidas (Aurora, Tuco Dev ou as duas); vazio = todas as ativas. */
  | { type: 'content.manager.ask'; reqId: string; text: string; teams?: ('aurora' | 'tuco-dev')[] }
  /** Etapa que falhou (pesquisa, roteiro ou direção): pedir de novo. */
  | { type: 'content.item.step.retry'; reqId: string; id: string }
  /** Aprovação em lote: peças, contas e período. */
  | { type: 'content.approve'; reqId: string; itemIds: string[]; from: string; to: string; note?: string | null }
  | { type: 'content.approval.revoke'; reqId: string; id: string }
  /** Desfazer a aprovação destas peças: voltam para "Para revisar" (publicada fica como está). */
  | { type: 'content.items.unapprove'; reqId: string; ids: string[] }
  /** "Já publiquei": o Chefe postou no app. Aprova se ainda não estava aprovada e marca como publicada; com link, a HQ confere
   *  o domínio da rede (e o texto, onde houver conferência pública). Numa peça já publicada sem link, só acrescenta o link. */
  | { type: 'content.item.markPublished'; reqId: string; id: string; url?: string | null }
  /** Desfaz o "Já publiquei" (registro errado): a peça volta para aprovada. Nada é removido das redes. */
  | { type: 'content.item.unmarkPublished'; reqId: string; id: string }
  /** Referência de vídeo pelo campo de pedido: cria (ou reaproveita, pelo mesmo link) o cartão, inspeciona, analisa, discute e,
   *  no modo produzir, segue para a produção. Só o link, sem instrução de produzir, fica na análise. */
  | { type: 'content.video.add'; reqId: string; ref: VideoRefInput }
  /** Tentar de novo a inspeção (depois de um bloqueio) ou anexar o vídeo (Anexar vídeo). */
  | { type: 'content.video.retry'; reqId: string; id: string; file?: { name: string; mediaType: string; dataBase64: string } | null }
  /** "Produzir esta versão" (modo análise, depois da proposta) ou outra produção com conta própria. */
  | { type: 'content.video.produce'; reqId: string; id: string; slot?: SocialSlotId | null }
  /** Publica pela API quando a conta permite e a peça está aprovada; senão devolve o pacote manual e abre o site. */
  | { type: 'content.item.publish'; reqId: string; id: string; clientId: string }
  /** Registro de publicação feita à mão: a HQ confere o link antes de marcar como publicada. */
  | { type: 'content.item.registerPost'; reqId: string; id: string; url: string }
  | { type: 'content.result.add'; reqId: string; result: Omit<ContentResult, 'id' | 'collectedAt' | 'uncertain' | 'source' | 'evidencePath'> & { source?: 'manual' } }
  /** CSV simples (cabeçalho em português ou inglês; ver Resultados → modelo). */
  | { type: 'content.result.importCsv'; reqId: string; csv: string; fileName?: string | null }
  /** Captura como evidência: salva a imagem e pede a transcrição ao analista (valores ficam "a conferir"). */
  | { type: 'content.result.capture'; reqId: string; itemId?: string | null; slot?: SocialSlotId | null; name: string; mediaType: string; dataBase64: string }
  | { type: 'content.result.confirm'; reqId: string; id: string; value?: number | null }
  | { type: 'content.result.delete'; reqId: string; id: string }
  | { type: 'content.analysis.run'; reqId: string; weekStart?: string | null }
  /** Navegador: leva a peça até a prévia de publicação na conta (sem o clique final) e guarda a captura. */
  | { type: 'content.item.prepare'; reqId: string; id: string }
  /** Navegador: o revisor lê as métricas disponíveis nas contas verificadas e registra com data e definição. */
  | { type: 'content.results.collect'; reqId: string; slots?: SocialSlotId[] | null }
  /** Foco: destinos ativos (o resto pausa, com o motivo, sem apagar nada) e fontes de pesquisa (controle separado). */
  | { type: 'content.focus.save'; reqId: string; activeSlots: SocialSlotId[]; sources?: { source: ResearchSource; enabled: boolean }[]; reason?: string | null }
  /** "Usar como referência": registra a referência do Chefe no Radar, liga ao trabalho e pede a análise ao pesquisador. */
  | { type: 'content.reference.add'; reqId: string; reference: ContentReferenceInput }
  /** Importa uma rodada do Radar gravada fora da fila (pesquisa da sessão), com a origem marcada. Mesmo dedup da rotina. */
  | { type: 'content.radar.import'; reqId: string; path: string }
  /** Radar → produção dentro do foco (a capacidade aparece como aviso; quem decide é o Chefe). */
  | { type: 'content.radar.select'; reqId: string; id: string; slot?: SocialSlotId | null; produce?: boolean }
  /** Decisão depois dos resultados (repetir, ajustar, testar outra abertura/ritmo, abandonar). */
  | { type: 'content.item.learning'; reqId: string; id: string; decision: ContentDecision; note: string }
  /** Vídeo feito pela HQ: renderiza de novo o mesmo video.json (versão anterior guardada), refaz a conferência e pede a revisão. */
  | { type: 'content.item.rerender'; reqId: string; id: string }
  /** Academia: pede de novo um exercício que não deu certo (exerciseId) ou a etapa parada do estudo (aula, correção). */
  | { type: 'content.academy.retry'; reqId: string; studyId: string; exerciseId?: string | null };

export type ContentServerMessage = { kind: 'content.state'; state: ContentState };
