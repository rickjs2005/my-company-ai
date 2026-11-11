// Trabalho de conteúdo da sala Social Media. A HQ organiza; quem pesquisa, planeja, produz e revisa são os funcionários
// (Claude Code real, na fila única). Cada fluxo é uma tarefa com um arquivo de saída definido pela HQ; a HQ só importa o
// que existir e for válido. Encadeamento automático limitado a um passo (produção → uma revisão); o resto volta ao Chefe.
import { CHANNEL_LABEL, isTeamId, teamDef, teamOfSlot, type TeamId } from '@milweb-hq/protocol';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AcademyExercise, AcademyState, AcademyStudy, ContentAnalysis, ContentCapacity, ContentCheck, ContentClientMessage, ContentDecision, ContentDestination, ContentFocus, ContentItem, ContentItemFiles, ContentItemPatch, ContentReferenceInput, ContentRequest, ContentVerifyRow, ContentRole, ContentRound, ContentSetup, ContentState,
  Employee, MeetingClientMessage, MeetingMessage, RadarItem, RadarSchedule, ResearchSource, Routine, RoutineInput, ServerMessage, SkillCatalog, SocialSlotId, Task, TaskRunInput, TaskRunResult,
  QuickFormat, VideoRefExtra, VideoRefInput, VideoRefMode, VideoRefStage, VideoRefState,
} from '@milweb-hq/protocol';
import { ACADEMY_EXERCISE_STATUS_LABEL, CONTENT_ITEM_STATUS_LABEL, isDmSession, PIECE_STEP_FILE, PIECE_STEP_LABEL, type PieceStep, type PieceStepKey, CONTENT_SPECIALTIES, CONTENT_SQUADS, FOCUS_REASON_DEFAULT, RESEARCH_SOURCES, focusReasonFor, SOCIAL_SLOTS, VIDEO_LEVEL_LABEL, VIDEO_MODE_LABEL, VIDEO_ROLE_LABEL, isSocialSlot, quickFormatName, quickFormatsFor, quickTitle, slotDef } from '@milweb-hq/protocol';
/** Instrução que pede produção ("quero um vídeo inspirado neste", "faz uma versão nossa"). Só o link fica na análise. */
const PRODUCE_INTENT = /\b(quero|queria|faz(e|er)?|fa[çc]a|cria(r)?|produz(ir|a)?|monta(r)?|gera(r)?)\b.{0,40}\b(v[íi]deo|reel|vers[aã]o|pe[çc]a)\b|inspirad[oa] (n|ness)[eoa]/i;
/** Instrução de estudo ("Equipe, estudem esse vídeo", "aprende a fazer um edit"): vai para a Academia de Vídeo, não produz peça. */
export const STUDY_INTENT = /(?<!\p{L})(estud(a|e|em|ar|em)|aprend(a|e|er|am|am)|ensin(a|e|ar)|trein(a|e|ar|em)|academia)(?!\p{L})/iu;
/** Aula sem síntese depois deste tempo: os exercícios seguem com a lição escrita. */
const LESSON_TIMEOUT_MS = 45 * 60_000;
export const DIRECTOR_TEMPLATE = 'conteudo-diretor-video';
import { parseOpportunity, parseSources, platformOf, postKey, readFocus, slotActive, writeFocus } from './focus.js';
import { missingCaptures, newestCapture, parseVideoPlan, probeVideo, sceneMotion, type VideoRenderer } from './video.js';
import { newSteps, parsePlan, planBrief, planPrompt, stepPrompt, stepsFor, stepsNote } from './pipeline.js';
import { evidenceMarkdown, extractAudio, inspectVideo, mixReferenceAudio, parseAudioMix, type VideoTools } from './videoref.js';
import { mergeTechnique, parseCorrection, parseExerciseResult, parseStudy, writeAcademyIndex, writeTechniqueCard } from './academy.js';
import { scheduleLabel } from '../routines.js';
import type { Store } from '../store.js';
import type { SocialService } from '../social/service.js';
import { ContentDb } from './db.js';
import { SLOT_SKILL, checkPiece, parseEntrega, verifyPost, type Entrega } from './checks.js';
import { csvToResults } from './csv.js';
import { DEFAULT_DESTINATIONS, brandFolder, copyKit, defaultMirrors, defaultOrigins, slugify, writeDestinations, writeInventory, writeMirrors, type MirrorSource, type OriginSource } from './kit.js';
import { analysisPrompt, browserPreparePrompt, browserPublishPrompt, collectPrompt, correctionPrompt, exercisePrompt, lessonAgenda, piecePrompt, radarPrompt, referencePrompt, reviewPrompt, studyPrompt, transcriptionPrompt, weekPrompt, videoAnalysisPrompt, videoMeetingAgenda, videoPieceBrief, type RadarScope } from './prompts.js';
import type { PngRenderer } from './render.js';
import { parseCarousel, renderCarousel, type CarouselBrand, type SlideRenderer } from './carousel.js';
import { AUTO_REWORK_MARK, hadAutoRound, isCarousel } from './prompts.js';
import { viewKind } from '../file-view.js';

const OPEN: Task['status'][] = ['queued', 'running', 'waiting_permission', 'waiting_answer'];
const DAY = 86_400_000;
/** Limites de tempo por fluxo (minutos). A fila continua única; isto só corta execuções que se estenderem. */
const LIMITS = { radar: 30, semana: 20, analise: 15, transcricao: 10, referencia: 15, video: 25, estudo: 40, exercicio: 25, correcao: 20, peca: 25, revisao: 15, plano: 15, etapa: 20 } as const;
/** Capacidade real (pedido do Chefe, 03/11/2026): no máximo 3 ideias prioritárias do Radar na produção; revisão acumulada segura a fila. */
export const PRODUCTION_LIMIT = 3;
export const REVIEW_BACKLOG_MAX = 6;
/** Agenda inicial do Radar da gringa (ajustável na tela de Rotinas). */
export const RADAR_TIMES = ['10:00', '17:00'];
const RADAR_TITLE = 'Radar da gringa (pesquisa)';
/** Estados em que a peça ainda está "na produção" (conta para a capacidade). */
const IN_PRODUCTION: ContentItem['status'][] = ['planejada', 'em_producao', 'parcial', 'falhou', 'ajustar'];
/** Estados em que uma peça de destino pausado fica parada pelo foco (publicada, agendada e descartada ficam como estão). */
const PAUSABLE: ContentItem['status'][] = ['planejada', 'em_producao', 'parcial', 'falhou', 'revisar', 'ajustar', 'aprovada', 'publicacao_pendente'];

interface TeamDef { role: ContentRole; template: string; names: string[]; title: string; skills: string[]; instructions: string }
export const RESEARCHER_TITLE = 'Pesquisador de tendências — Radar da gringa';
const RESEARCHER_INSTRUCTIONS = 'Você é o Radar da gringa da sala Social Media da Aurora: procura publicações estrangeiras (sobretudo em inglês) sobre programação, IA, ferramentas, web design, desenvolvimento, rotina freelancer, memes de dev e curiosidades tech no Instagram, TikTok, X e Reddit, e transforma o que achar numa seleção pequena e priorizada para os Instagrams do Tuco Dev e da Aurora e o Threads da Aurora. Registre só o que viu: link, autor, plataforma, idioma, datas, métricas com o nome da plataforma, o que inspecionou (imagem, texto, vídeo parcial ou completo) e a limitação do sinal. Achado pontual, padrão em vários criadores e hipótese criativa são coisas diferentes. Siga equipe/funcoes/pesquisador.md e equipe/base.md. Só leitura; nunca publique, curta, comente, siga nem fale com terceiros.';
/** Textos padrão anteriores (só estes são trocados sozinhos; o que o Chefe editou fica). */
const OLD_RESEARCHER = { title: 'Pesquisa de tendências', instructions: 'Você pesquisa referências, perguntas do público, notícias e formatos para o Radar da sala Social Media da Aurora. Toda oportunidade leva fonte, autor, datas, sinais observados e grau de evidência; um post popular não é tendência. Siga equipe/funcoes/pesquisador.md e equipe/base.md. Só leitura na web; nunca publique nem fale com terceiros.' };
export const CONTENT_TEAM: TeamDef[] = [
  { role: 'coordenador', template: 'conteudo-coordenador', names: ['Marina', 'Helena', 'Lívia'], title: 'Coordenação editorial', skills: [],
    instructions: 'Você coordena o conteúdo da sala Social Media da Aurora: prioridades, capacidade de produção e calendário. Transforme objetivos em peças concretas, evite repetir pautas e siga equipe/funcoes/coordenador.md e equipe/base.md. Você não produz as peças nem conversa com os outros funcionários: o calendário é a distribuição. Nunca publique, agende ou fale com terceiros.' },
  { role: 'pesquisador', template: 'conteudo-pesquisador', names: ['Caio', 'Davi', 'Nico'], title: RESEARCHER_TITLE, skills: ['milweb-video-studio'],
    instructions: RESEARCHER_INSTRUCTIONS },
  { role: 'criador', template: 'conteudo-criador', names: ['Bia', 'Clara', 'Nina'], title: 'Criação de conteúdo', skills: [...CONTENT_SPECIALTIES, 'milweb-video-studio'],
    instructions: 'Você cria textos, carrosséis, Pins e roteiros da Aurora e do Tuco Dev, reaproveitando vídeos, capturas e projetos reais com versões próprias por rede. Uma peça por tarefa, na pasta indicada, com entrega.json. Siga equipe/funcoes/criador.md, equipe/base.md e a especialidade da rede. Nunca publique.' },
  { role: 'revisor', template: 'conteudo-revisor', names: ['Otto', 'Rafa', 'Davi'], title: 'Revisão e análise', skills: ['milweb-video-studio'],
    instructions: 'Você revisa as peças da sala Social Media (fatos na fonte, clareza, identidade, limites da rede) e analisa resultados com métrica, período e denominador. Uma passada por peça: aprovar ou dizer o que ajustar. Siga equipe/funcoes/revisor.md e equipe/base.md. Nunca publique.' },
  // Edição de vídeo (06/11): um por equipe (CONTENT_SQUADS). Monta o Reel pedido; carrossel e texto ficam com a criação da equipe.
  { role: 'video', template: 'conteudo-video', names: ['Teo', 'Clara'], title: 'Edição de vídeo', skills: ['rede-instagram', 'milweb-video-studio'],
    instructions: 'Você monta os Reels da sua equipe na sala Social Media da Aurora: o vídeo pronto pelo video.json que a HQ renderiza, com gancho no primeiro segundo, movimento que explica e prova real (gravação ou captura de verdade, não mockup). Uma peça por tarefa, na pasta indicada, com entrega.json. Siga equipe/funcoes/video.md, equipe/funcoes/criador.md (Vídeo), equipe/base.md e a skill rede-instagram. Nunca publique.' },
  // Diretor de Vídeo & Motion Design (07/11, pedido do Chefe): assiste aos vídeos que ele compartilha (skill Watch rodada pela HQ),
  // escreve o relatório no formato do Video Analyzer, dirige roteiro e storyboard, dá a aula e corrige os exercícios da Academia.
  { role: 'direcao', template: DIRECTOR_TEMPLATE, names: ['Vítor', 'Dante', 'Leon'], title: 'Diretor de Vídeo & Motion Design', skills: ['video-analyze', 'watch:watch', 'milweb-video-studio', 'rede-instagram'],
    instructions: 'Você é o Diretor de Vídeo & Motion Design da sala Social Media da Aurora. Assiste aos vídeos que o Chefe compartilha (a HQ roda a skill Watch e entrega os quadros e a transcrição), examina animações, transições, cortes, tipografia, som e ritmo, e escreve a análise no formato do Video Analyzer, separando o que foi observado do que é inferência. Dirige o roteiro e o storyboard das versões próprias com Teo e Clara (edição) e Nina e Bia (criação), ensina a equipe na Academia de Vídeo (lição, exercícios, correção) e só propõe o que dá para fazer com as ferramentas da casa (Remotion/CenasReel, FFmpeg, GSAP/CSS), sem copiar obra de terceiros. Siga equipe/funcoes/diretor-video.md e equipe/base.md. Nunca publique.' },
];
/** Papéis que existem uma vez por equipe de perfil (os outros atendem a sala inteira). */
const SQUAD_ROLES = new Set<ContentRole>(['criador', 'video']);
/** Formato de vídeo (Reel, vídeo TikTok): vai para a edição de vídeo da equipe, quando houver. */
const isVideoFormat = (format: string) => /\breel\b|v[íi]deo/i.test(format);

export interface ContentManagerLike {
  runTask(input: TaskRunInput, extra?: { origin?: Task['origin']; routineId?: string | null }): Promise<TaskRunResult>;
  createEmployee(input: { roomId: string; name?: string; role?: string; instructions?: string; permissionMode?: Employee['permissionMode']; provider?: Employee['provider']; skills?: string[]; template?: string | null; profileId?: string | null; access?: Employee['access'] }): Employee;
  updateEmployee?(id: string, patch: { access?: Employee['access']; role?: string; instructions?: string; profileId?: string | null }): unknown;
  setTaskLimit(fn: (taskId: string) => number | null): void;
  on(event: 'task_finished', fn: (taskId: string) => void): unknown;
  /** Cancela uma tarefa ainda na fila (a lixeira usa para o trabalho futuro da peça). */
  cancelQueued?(taskId: string): void;
  /** Interrompe a execução atual da conversa (a lixeira usa para a tarefa que está rodando). */
  interrupt?(sessionId: string): Promise<void>;
}

export interface ContentDeps {
  db: DatabaseSync;
  store: Store;
  manager: ContentManagerLike;
  social: SocialService;
  routines?: { handle(msg: { type: 'routine.create'; reqId: string; routine: RoutineInput }): Promise<unknown>; update?(id: string, patch: Partial<RoutineInput>): Promise<unknown> };
  skills?: { invalidate(): void; catalog(projectId: string | null, refresh?: boolean): SkillCatalog };
  broadcast(m: ServerMessage): void;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
  /** Conhecimento da equipe: técnica de um estudo concluído entra como PROPOSTA (não vale até o Chefe ativar). */
  knowledge?: { propose(key: string, input: import('@milweb-hq/protocol').KnowledgeInput): unknown };
  /** Pasta do kit no repositório da HQ (instruções, especialidades, contratos). */
  kitDir: string;
  /** Pasta padrão da sala quando ainda não há uma cadastrada. */
  defaultFolder: string;
  /** Originais do Chefe para o inventário (padrão: portfólio, episódios, Vídeos, renders). */
  origins?: OriginSource[];
  /** Código do site (para listar as páginas de projeto do portfólio); null = não listar. */
  siteDir?: string | null;
  /** Referências copiadas para dentro da pasta (padrão: skill de vídeo, estudo, episódios, capturas). [] = nenhuma. */
  mirrors?: MirrorSource[];
  /** A pasta é confiável para o Claude Code? (só então as regras do .claude/settings.json da pasta valem). null = não sei. */
  trusted?: (folder: string) => boolean | null;
  fetch?: typeof fetch;
  render?: PngRenderer;
  /** Desenha os slides do carrossel (Edge sem janela). Ausente = carrossel fica só no carrossel.json. */
  slideRender?: SlideRenderer;
  /** Fontes do carrossel (server/assets/carrossel/fonts). */
  carouselFontsDir?: string;
  /** Renderiza o video.json com o Remotion do Chefe e confere o MP4 (ffprobe). Ausente = vídeo fica como pendência, com o motivo. */
  video?: VideoRenderer | null;
  /** Ferramentas locais para inspecionar referências de vídeo (yt-dlp, FFmpeg, whisper.cpp, navegador sem janela). */
  videoTools?: VideoTools | null;
  /** Reuniões existentes (a referência de vídeo é discutida numa reunião vinculada a ela). */
  meetings?: { handle(msg: MeetingClientMessage): Promise<unknown>; messages(meetingId: string): MeetingMessage[] } | null;
  now?: () => number;
  audit?(e: { action: string; entity: string; entityId: string | null; title: string | null; origin: string; detail?: string | null }): void;
}

/** Um quadro a 90% de cada cena (quadros/fim-NN.png), para conferir se o texto ficou inteiro antes do corte. */
async function sceneEndFrames(file: string, plan: { cenas: { duracao: number }[] }, dir: string, ffmpeg: string): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = []; let start = 0;
  for (const [i, c] of plan.cenas.entries()) {
    const f = path.join(dir, `fim-${String(i + 1).padStart(2, '0')}.png`);
    const t = start + c.duracao * 0.9; start += c.duracao;
    const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', f], { windowsHide: true });
    if (r.status === 0 && isFile(f)) out.push(f);
  }
  return out;
}

/** "01:02" → "01m02s"; "1:02:03" → "1h02m03s" (nome do quadro da Watch anexado). */
const timeName = (t: string) => { const p = t.split(':'); return p.length === 3 ? `${Number(p[0])}h${p[1]}m${p[2].split('.')[0]}s` : `${p[0]}m${(p[1] ?? '00').split('.')[0]}s`; };
/** Até n itens espalhados pela lista (primeiro e último incluídos). */
const spread = <T,>(list: T[], n: number): T[] => (list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]));

/** Data (YYYY-MM-DD) no fuso de Brasília. */
export function brtDate(ms: number): string { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
const addDays = (d: string, n: number) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const txt = (v: unknown, max = 4000): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export class ContentService {
  private cdb: ContentDb;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private pending: Promise<void> | null = null;
  private now: () => number;

  constructor(private deps: ContentDeps) {
    this.cdb = new ContentDb(deps.db);
    this.now = deps.now ?? Date.now;
    deps.manager.setTaskLimit(id => this.limitFor(id));
    deps.manager.on('task_finished', () => { void this.sync(); });
    deps.manager.on('task_finished', (taskId: string) => { void this.dmRequest(taskId); });
  }

  /** Ao subir: importa o que terminou com a HQ desligada e segue a cada minuto (retomada sem depender do navegador). */
  start(intervalMs = 60_000): void {
    // O kit da equipe muda com a HQ (ex.: carrossel.json em 02/11/2026): atualiza na pasta o que o Chefe não editou.
    const folder = this.folder();
    if (folder && fs.existsSync(folder)) {
      try {
        const r = copyKit(this.deps.kitDir, folder);
        if (r.length || r.updated?.length) this.deps.log.info(`conteúdo: kit da equipe atualizado na pasta (${r.length} novo(s), ${r.updated?.length ?? 0} atualizado(s)${r.kept?.length ? `; mantidos por terem sido editados: ${r.kept.join(', ')}` : ''})`);
      } catch (err) { this.deps.log.warn('conteúdo: o kit da equipe não foi atualizado na pasta', err); }
    }
    try { this.upgradeResearcher(); } catch (err) { this.deps.log.warn('conteúdo: perfil do pesquisador não foi atualizado', err); }
    try { const s = this.ensureSquads(); if (s.length) { this.deps.log.info(`conteúdo: equipes por perfil montadas (${s.join('; ')})`); this.deps.audit?.({ action: 'equipes', entity: 'sala de conteúdo', entityId: null, title: 'Equipes por perfil', origin: 'interface', detail: s.join('; ') }); } } catch (err) { this.deps.log.warn('conteúdo: as equipes por perfil não foram montadas', err); }
    try { const d = this.ensureDirector(); if (d) { this.deps.log.info(`conteúdo: contratado ${d}`); this.deps.audit?.({ action: 'contratar', entity: 'sala de conteúdo', entityId: null, title: 'Diretor de Vídeo & Motion Design', origin: 'interface', detail: d }); } } catch (err) { this.deps.log.warn('conteúdo: o Diretor de Vídeo não foi contratado', err); }
    try { this.refreshAcademyFiles(); } catch (err) { this.deps.log.warn('conteúdo: a Academia de Vídeo não foi gravada na pasta', err); }
    void this.upgradeRadarRoutine().catch(err => this.deps.log.warn('conteúdo: a agenda do Radar não foi atualizada', err));
    void this.sync();
    this.timer = setInterval(() => { void this.sync(); }, intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Pesquisador vira o Radar da gringa (pedido do Chefe, 03/11/2026): cargo e instruções padrão trocados só se ninguém editou;
   *  pesquisa na web (WebSearch e WebFetch, só leitura) liberada para ele, visível no perfil. Os gerentes e o resto da equipe ficam. */
  private upgradeResearcher(): void {
    const e = this.teamMember('pesquisador'); if (!e || !this.deps.manager.updateEmployee) return;
    const patch: { role?: string; instructions?: string; access?: Employee['access'] } = {};
    if (e.role === OLD_RESEARCHER.title) patch.role = RESEARCHER_TITLE;
    if ((e.instructions ?? '').trim() === OLD_RESEARCHER.instructions) patch.instructions = RESEARCHER_INSTRUCTIONS;
    if (!e.access?.web) patch.access = { ...(e.access ?? { mcp: 'none' }), web: true };
    if (Object.keys(patch).length) { this.deps.manager.updateEmployee(e.id, patch); this.deps.log.info(`conteúdo: ${e.name} configurado como ${RESEARCHER_TITLE}${patch.access ? ' (pesquisa na web liberada, só leitura)' : ''}`); }
  }

  /**
   * Diretor de Vídeo & Motion Design (pedido do Chefe, 07/11/2026): contratado uma vez numa sala já preparada. Se o Chefe
   * arquivar o Diretor depois, ele não volta sozinho (a marca fica em social_config).
   */
  private ensureDirector(): string | null {
    const room = this.room(); if (!room || !this.projectId()) return null;
    const flag = this.deps.db.prepare("SELECT value FROM social_config WHERE key='content.director'").get() as { value: string } | undefined;
    if (flag?.value === 'v1') return null;
    let hired: string | null = null;
    if (!this.teamMember('direcao')) {
      const t = CONTENT_TEAM.find(x => x.role === 'direcao')!;
      const taken = new Set(this.deps.store.listEmployees().map(e => e.name.toLowerCase()));
      const name = t.names.find(n => !taken.has(n.toLowerCase())) ?? 'Diretor';
      this.deps.manager.createEmployee({ roomId: room.id, name, role: t.title, instructions: t.instructions, permissionMode: 'acceptEdits', provider: 'claude', skills: t.skills, template: t.template, access: { mcp: 'none', browser: true } });
      hired = `${name} (${t.title})`;
    }
    this.deps.db.prepare("INSERT INTO social_config(key, value) VALUES ('content.director', 'v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    return hired;
  }

  /** A rotina de Radar que já existe passa para 10:00 e 17:00 (uma vez; depois quem manda é a tela de Rotinas). Não duplica. */
  private async upgradeRadarRoutine(): Promise<void> {
    const done = this.deps.db.prepare("SELECT value FROM social_config WHERE key='content.radarSchedule'").get() as { value: string } | undefined;
    if (done?.value === 'v2') return;
    const r = this.deps.store.listRoutines().find(x => x.workflow === 'content.radar');
    if (!r || !this.deps.routines?.update) return;
    const old = r.schedule.kind === 'daily' && r.schedule.time === '08:00' && !r.schedule.times?.length;
    if (old || r.title === 'Radar diário (pesquisa)') {
      await this.deps.routines.update(r.id, { ...(old ? { schedule: { kind: 'daily', time: RADAR_TIMES[0], times: RADAR_TIMES } } : {}), ...(r.title === 'Radar diário (pesquisa)' ? { title: RADAR_TITLE } : {}), missedPolicy: 'run_once' });
      this.deps.log.info(`conteúdo: rotina do Radar atualizada (${old ? 'todo dia às 10:00 e 17:00' : 'agenda mantida'}; título "${RADAR_TITLE}")`);
    }
    this.deps.db.prepare("INSERT INTO social_config(key, value) VALUES ('content.radarSchedule', 'v2') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  }

  // ------------------------------------------------------------------ foco e capacidade
  focus(): ContentFocus { return readFocus(this.deps.db); }
  private active(slot: SocialSlotId | null | undefined): boolean { return slotActive(this.focus(), slot); }
  private pausedWhy(slot: SocialSlotId | null): string { const f = this.focus(); return `${slot ? slotDef(slot).label : 'Sem conta'}: destino pausado. ${f.reason}.`; }
  private requireActive(slot: SocialSlotId | null, what: string): void { if (!this.active(slot)) throw new Error(`${this.pausedWhy(slot)} ${what} só volta quando o Chefe incluir este destino no foco.`); }

  capacity(): ContentCapacity {
    const items = this.cdb.listItems(500).filter(i => !i.archivedAt && !i.pausedReason && this.active(i.slot));
    const load = items.filter(i => (i.radarId || i.referenceIds.length) && IN_PRODUCTION.includes(i.status)).length;
    const reviewBacklog = items.filter(i => i.status === 'revisar').length;
    const blocked = load >= PRODUCTION_LIMIT ? `${load} ideia(s) do Radar já estão na produção (limite ${PRODUCTION_LIMIT}): as novas esperam no Radar.`
      : reviewBacklog >= REVIEW_BACKLOG_MAX ? `${reviewBacklog} peças esperam a sua revisão: a sala conclui e ajusta essas antes de puxar ideia nova do Radar.` : null;
    return { limit: PRODUCTION_LIMIT, load, reviewBacklog, reviewMax: REVIEW_BACKLOG_MAX, blocked };
  }

  radarSchedule(): RadarSchedule {
    const r = this.deps.store.listRoutines().find(x => x.workflow === 'content.radar') ?? null;
    const last = r ? this.cdb.listRounds(60).find(x => x.kind === 'radar' && x.routineId === r.id) ?? null : null;
    const t = r?.lastTaskId ? this.deps.store.getTask(r.lastTaskId) : null;
    const lastResult = last ? (last.status === 'aguardando' ? 'rodando ou na fila' : last.status === 'concluida' ? `concluída: ${this.cdb.listRadar(300).filter(x => x.roundId === last.id).length} referência(s)` : last.status === 'vazia' ? 'concluída sem nada pertinente' : 'falhou') : null;
    return {
      routineId: r?.id ?? null, title: r?.title ?? null, label: r ? scheduleLabel(r.schedule) : null, enabled: Boolean(r?.enabled), lastRunAt: r?.lastRunAt ?? null, nextRunAt: r?.enabled ? r.nextRunAt : null,
      lastResult, lastError: last?.status === 'falhou' ? last.error : r?.lastSkipReason ?? (t && t.status === 'error' ? t.errors[t.errors.length - 1] ?? null : null),
      note: 'Roda pelo agendador da HQ, com o app (e o notebook) ligado. Horário perdido com a HQ desligada roda uma vez ao voltar, sem disparar várias buscas atrasadas; uma rodada ainda aberta impede a próxima. É pesquisa interna: não agenda nem publica nada.',
    };
  }

  // ------------------------------------------------------------------ estado
  private room() { return this.deps.store.listRooms().find(r => r.kind === 'social') ?? null; }
  private projectId(): string | null {
    const r = this.deps.db.prepare("SELECT value FROM social_config WHERE key='content.projectId'").get() as { value: string } | undefined;
    return r && this.deps.store.getProject(r.value) ? r.value : null;
  }
  private folder(): string | null { const id = this.projectId(); return id ? this.deps.store.getProject(id)?.path ?? null : null; }
  /** Funcionário do papel; com perfil, o da equipe desse perfil (sem equipe montada, qualquer um do papel, como antes). */
  private teamMember(role: ContentRole, profileId: string | null = null): Employee | null {
    const t = CONTENT_TEAM.find(x => x.role === role)!;
    const all = this.deps.store.listEmployees().filter(e => e.template === t.template && !e.archivedAt);
    if (profileId) { const own = all.find(e => e.profileId === profileId); if (own) return own; }
    return all.find(e => !e.profileId) ?? all[0] ?? null;
  }
  /**
   * Perfil (equipe) de uma conta: o perfil ligado à conta na Central de Redes; senão o padrão do destino. O Threads é da Aurora
   * (Chefe, 06/11/2026: "instagram + threads do aurora") mesmo antes de o perfil ser ligado à conta.
   */
  private squadOf(slot: SocialSlotId | null): string | null {
    if (!slot) return null;
    let linked: string | null = null;
    try { linked = this.deps.social.account(slot).profileIds[0] ?? null; } catch { linked = null; }
    return linked ?? slotDef(slot).defaultProfileIds[0] ?? (slot === 'threads' ? 'aurora' : null);
  }
  /** Quem produz: vídeo vai para a edição de vídeo da equipe da conta; o resto, para a criação da equipe. */
  private producerFor(slot: SocialSlotId | null, format: string): Employee | null {
    const squad = this.squadOf(slot);
    return (isVideoFormat(format) ? this.teamMember('video', squad) : null) ?? this.teamMember('criador', squad);
  }
  /** Todos os funcionários da equipe de conteúdo (todos os papéis, as duas equipes). */
  private contentStaff(): Employee[] {
    const templates = new Set(CONTENT_TEAM.map(t => t.template));
    return this.deps.store.listEmployees().filter(e => e.template && templates.has(e.template) && !e.archivedAt);
  }

  /**
   * Monta as equipes por perfil (CONTENT_SQUADS): quem já trabalhava sem equipe e tem o nome previsto (a Bia) entra na equipe
   * dele; quem falta é contratado com o perfil da equipe. Nada é arquivado nem apagado. Devolve quem foi contratado ou movido.
   */
  private ensureSquads(): string[] {
    const room = this.room(); if (!room || !this.projectId()) return [];
    const done: string[] = [];
    for (const sq of CONTENT_SQUADS) {
      if (!room.profiles.some(p => p.id === sq.profileId)) continue;
      for (const m of sq.members) {
        const t = CONTENT_TEAM.find(x => x.role === m.role)!;
        const all = this.deps.store.listEmployees().filter(e => e.template === t.template && !e.archivedAt);
        if (all.some(e => e.profileId === sq.profileId)) continue;
        const role = `${t.title} · ${sq.label}`;
        const instructions = `${t.instructions} ${sq.focus}`;
        const loose = all.find(e => !e.profileId && e.name.toLowerCase() === m.name.toLowerCase());
        if (loose && this.deps.manager.updateEmployee) {
          this.deps.manager.updateEmployee(loose.id, { profileId: sq.profileId, role });
          done.push(`${loose.name} → ${sq.label}`);
          continue;
        }
        const taken = new Set(this.deps.store.listEmployees().map(e => e.name.toLowerCase()));
        const name = taken.has(m.name.toLowerCase()) ? (t.names.find(n => !taken.has(n.toLowerCase())) ?? `${m.name} ${sq.label.split(' ').pop()}`) : m.name;
        this.deps.manager.createEmployee({ roomId: room.id, name, role, instructions, profileId: sq.profileId, permissionMode: 'acceptEdits', provider: 'claude', skills: t.skills, template: t.template, access: { mcp: 'none', browser: true } });
        done.push(`${name} (${role})`);
      }
    }
    return done;
  }
  private profileName = (id: string) => this.room()?.profiles.find(p => p.id === id)?.name ?? id;

  setupState(): ContentSetup {
    const projectId = this.projectId(); const folder = this.folder();
    const folderExists = Boolean(folder && fs.existsSync(folder));
    // Papéis da sala inteira: um funcionário; criação e vídeo: um por equipe de perfil (Tuco Dev e Aurora).
    const room = this.room();
    const squads = CONTENT_SQUADS.filter(sq => room?.profiles.some(p => p.id === sq.profileId));
    const team = CONTENT_TEAM.flatMap(t => {
      if (!SQUAD_ROLES.has(t.role) || !squads.length) { const e = this.teamMember(t.role); return [{ role: t.role, employeeId: e?.id ?? null, name: e?.name ?? null }]; }
      return squads.map(sq => { const e = this.deps.store.listEmployees().find(x => x.template === t.template && !x.archivedAt && x.profileId === sq.profileId); return { role: t.role, employeeId: e?.id ?? null, name: e ? `${e.name} · ${sq.label}` : null }; });
    });
    let catalog: SkillCatalog | null = null;
    try { catalog = projectId && this.deps.skills ? this.deps.skills.catalog(projectId) : null; } catch { catalog = null; }
    const specialties = CONTENT_SPECIALTIES.map(name => {
      const p = folder ? path.join(folder, '.claude', 'skills', name, 'SKILL.md') : null;
      const exists = Boolean(p && fs.existsSync(p));
      const info = catalog?.skills.find(s => s.name === name && s.source === 'project');
      const problems = info?.problems ?? [];
      const ok = exists && (!catalog || (Boolean(info) && problems.length === 0));
      const listed = info?.verified?.listed ? ' · confirmada pelo Claude Code numa execução' : '';
      return { name, path: exists ? p : null, ok, detail: !exists ? 'arquivo não encontrado na pasta' : !catalog ? 'arquivo presente' : !info ? 'arquivo presente, mas fora do catálogo de skills do projeto' : problems.length ? problems.join('; ') : `no catálogo do projeto${listed}` };
    });
    const routines = (['radar', 'analise'] as const).map(kind => {
      const r = this.deps.store.listRoutines().find(x => x.workflow === `content.${kind}`);
      return { kind, routineId: r?.id ?? null, label: r ? `${r.title}${r.enabled ? '' : ' (desligada)'}` : null };
    });
    const missing: string[] = [];
    if (!projectId) missing.push('Preparar a sala: pasta de conteúdo, equipe, especialidades e rotinas (botão "Preparar a sala").');
    else if (!folderExists) missing.push(`A pasta ${folder} não existe mais: prepare a sala de novo.`);
    for (const t of team) if (!t.employeeId) missing.push(`Falta o funcionário de ${CONTENT_TEAM.find(x => x.role === t.role)!.title}${SQUAD_ROLES.has(t.role) && squads.length ? ' em uma das equipes (prepare a sala de novo)' : ''}.`);
    for (const s of specialties) if (projectId && !s.ok) missing.push(`Especialidade ${s.name}: ${s.detail}.`);
    for (const r of routines) if (projectId && !r.routineId) missing.push(`Rotina ${r.kind === 'radar' ? 'de pesquisa diária' : 'de revisão semanal'} não cadastrada.`);
    if (folder && folderExists && this.deps.trusted?.(folder) === false && !this.teamMember('pesquisador')?.access?.web) missing.push(`Pesquisa na web: o Claude Code ainda não confia na pasta ${folder}, então a liberação de pesquisa (WebSearch e WebFetch, só leitura) do .claude/settings.json dela não vale e cada busca pede a sua autorização. Abra a pasta uma vez no Claude Code e aceite "confiar", ou aprove com "sempre" quando o Caio pedir.`);
    return { projectId, folder, folderExists, team, specialties, routines, missing };
  }

  state(): ContentState {
    return {
      setup: this.setupState(), destinations: this.cdb.listDestinations(), rounds: this.cdb.listRounds(30), radar: this.cdb.listRadar(150).map(r => (r.video ? { ...r, video: { ...r.video, stage: this.videoStage(r) } } : r)),
      items: this.cdb.listItems(400, true), approvals: this.cdb.listApprovals(20), results: this.cdb.listResults(400), analyses: this.cdb.listAnalyses(6),
      requests: this.cdb.listRequests(30), hidden: this.cdb.listHidden(), focus: this.focus(), capacity: this.capacity(), radarSchedule: this.radarSchedule(),
      academy: this.academyState(),
    };
  }
  private push(): void { this.deps.broadcast({ kind: 'content.state', state: this.state() }); }

  // ------------------------------------------------------------------ mensagens
  async handle(msg: ContentClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'content.state': return this.state();
      case 'content.setup': return this.setup(msg.folder);
      case 'content.destination.save': return this.saveDestination(msg.destination);
      case 'content.radar.run': return this.startRadar(msg.focus ?? null);
      case 'content.radar.discard': { if (!this.cdb.getRadar(msg.id)) throw new Error('oportunidade não encontrada'); this.cdb.setRadarStatus(msg.id, 'descartada'); this.push(); return this.state(); }
      case 'content.radar.toItem': return this.radarToItem(msg.id, msg.slot ?? null);
      case 'content.week.prepare': return this.prepareWeek(msg.weekStart ?? null, msg.note ?? null);
      case 'content.week.produce': return this.produceWeek(msg.weekStart ?? null);
      case 'content.item.create': return this.createItem(msg.item);
      case 'content.quick.create': return this.quickCreate(msg.text, msg.slot, msg.format);
      case 'content.item.update': return this.updateItem(msg.id, msg.patch);
      case 'content.item.produce': return this.produce(msg.id, msg.note ?? null);
      case 'content.item.review': return this.review(msg.id);
      case 'content.item.files': return this.itemFiles(msg.id);
      case 'content.items.trash': return this.trashItems(msg.ids);
      case 'content.items.restore': return this.restoreItems(msg.ids);
      case 'content.items.archive': return this.archiveItems(msg.ids, msg.archived);
      case 'content.items.verify': return this.verifyItems(msg.ids ?? null, msg.apply === true);
      case 'content.hidden.set': return this.setHidden(msg.key, msg.kind, msg.state, msg.title ?? null, msg.cancelTaskId ?? null);
      case 'content.request.create': return this.createRequest(msg);
      case 'content.request.update': { if (!this.cdb.updateRequest(msg.id, { ...(msg.status ? { status: msg.status } : {}), ...(msg.note !== undefined ? { note: msg.note } : {}) })) throw new Error('pedido não encontrado'); this.push(); return this.state(); }
      case 'content.approve': return this.approve(msg.itemIds, msg.from, msg.to, msg.note ?? null);
      case 'content.approval.revoke': { this.cdb.revokeApproval(msg.id); this.push(); return this.state(); }
      case 'content.items.unapprove': return this.unapprove(msg.ids);
      case 'content.item.markPublished': return this.markPublished(msg.id, msg.url ?? null);
      case 'content.item.unmarkPublished': return this.unmarkPublished(msg.id);
      case 'content.video.add': return this.addVideo(msg.ref);
      case 'content.video.retry': return this.retryVideo(msg.id, msg.file ?? null);
      case 'content.video.produce': { await this.produceFromVideo(msg.id, msg.slot ?? null, true, true); this.push(); return this.state(); }
      case 'content.item.publish': return this.publish(msg.id, msg.clientId);
      case 'content.item.registerPost': return this.registerPost(msg.id, msg.url);
      case 'content.result.add': return this.addResult(msg.result);
      case 'content.result.importCsv': return this.importCsv(msg.csv, msg.fileName ?? null);
      case 'content.result.capture': return this.capture(msg);
      case 'content.result.confirm': { this.cdb.confirmResult(msg.id, msg.value); this.push(); return this.state(); }
      case 'content.result.delete': { this.cdb.deleteResult(msg.id); this.push(); return this.state(); }
      case 'content.analysis.run': return this.startAnalysis(msg.weekStart ?? null);
      case 'content.item.prepare': return this.browserTask(msg.id, 'preparar', null);
      case 'content.results.collect': return this.collectResults(msg.slots ?? null);
      case 'content.focus.save': return this.saveFocus(msg.activeSlots, msg.sources ?? null, msg.reason ?? null);
      case 'content.reference.add': return this.addReference(msg.reference);
      case 'content.radar.import': return this.importSessionRound(msg.path);
      case 'content.radar.select': return this.selectRadar(msg.id, msg.slot ?? null, msg.produce !== false);
      case 'content.item.learning': return this.setLearning(msg.id, msg.decision, msg.note);
      case 'content.item.rerender': return this.rerender(msg.id);
      case 'content.academy.retry': return this.retryAcademy(msg.studyId, msg.exerciseId ?? null);
      case 'content.manager.ask': return this.askManager(msg.text, msg.teams);
      case 'content.item.step.retry': return this.retryStep(msg.id);
      default: throw new Error(`operação de conteúdo desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  // ------------------------------------------------------------------ preparar a sala (idempotente, nunca apaga nem move)
  async setup(folderArg?: string): Promise<ContentState> {
    const room = this.room(); if (!room) throw new Error('A sala Social Media não existe nesta HQ.');
    let projectId = this.projectId();
    const folder = path.resolve(folderArg?.trim() || this.folder() || this.deps.defaultFolder);
    fs.mkdirSync(folder, { recursive: true });
    const created = copyKit(this.deps.kitDir, folder);
    if (!projectId || this.deps.store.getProject(projectId)?.path !== folder) {
      const existing = this.deps.store.findProjectByPath(folder);
      const project = existing ?? this.deps.store.createProject({ name: 'Conteúdos Aurora', path: folder, roomId: room.id });
      if (!existing) this.deps.broadcast({ kind: 'entity', entity: 'project', op: 'upsert', item: project });
      projectId = project.id;
      this.deps.db.prepare("INSERT INTO social_config(key, value) VALUES ('content.projectId', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(projectId);
    }
    for (const d of DEFAULT_DESTINATIONS) this.cdb.upsertDestination(d, true);
    // Nenhuma conta vem pré-cadastrada: cada pessoa informa as suas na central de Redes.
    const s = this.deps.social;
    const profiles = new Set(room.profiles.map(p => p.id));
    const propose = (slot: SocialSlotId, id: string) => { if (profiles.has(id)) s.seedProfiles(slot, [id]); };
    propose('tiktok', 'tuco-dev'); propose('linkedin', 'aurora'); propose('x', 'tuco-dev'); propose('pinterest', 'aurora');
    // Equipe: quatro perfis persistentes; nenhum processo fica aberto (a conversa sobe quando houver tarefa, na fila única).
    const hired: string[] = [];
    for (const t of CONTENT_TEAM) {
      if (SQUAD_ROLES.has(t.role)) continue;
      if (this.teamMember(t.role)) continue;
      const taken = new Set(this.deps.store.listEmployees().map(e => e.name.toLowerCase()));
      const name = t.names.find(n => !taken.has(n.toLowerCase())) ?? `${t.names[0]} ${t.title.split(' ')[0]}`;
      this.deps.manager.createEmployee({ roomId: room.id, name, role: t.title, instructions: t.instructions, permissionMode: 'acceptEdits', provider: 'claude', skills: t.skills, template: t.template });
      hired.push(`${name} (${t.title})`);
    }
    // Equipes por perfil (Tuco Dev e Aurora): criação e vídeo de cada uma.
    hired.push(...this.ensureSquads());
    // Navegador da HQ: só a equipe de conteúdo recebe as ferramentas (os outros funcionários continuam como estavam).
    for (const e of this.contentStaff()) {
      if (!e.access?.browser && this.deps.manager.updateEmployee) this.deps.manager.updateEmployee(e.id, { access: { ...(e.access ?? { mcp: 'none' }), browser: true } });
    }
    await this.ensureRoutine('content.radar', projectId);
    await this.ensureRoutine('content.analise', projectId);
    this.refreshFiles();
    this.deps.skills?.invalidate();
    try { this.deps.skills?.catalog(projectId, true); } catch (err) { this.deps.log.warn('catálogo de skills não atualizou', err); }
    this.deps.audit?.({ action: 'preparar', entity: 'sala de conteúdo', entityId: projectId, title: folder, origin: 'interface', detail: `${created.length} arquivo(s) do kit criados${created.updated?.length ? `, ${created.updated.length} atualizados` : ''}${created.kept?.length ? `, ${created.kept.length} mantidos por terem sido editados (${created.kept.join(', ')})` : ''}${hired.length ? `; contratados: ${hired.join(', ')}` : ''}` });
    this.deps.log.info(`conteúdo: sala preparada em ${folder} (${created.length} arquivo(s) novos${hired.length ? `, ${hired.length} funcionário(s)` : ''})`);
    this.push();
    return this.state();
  }

  /** Regenera os arquivos da HQ na pasta (destinos e inventário). Os do kit e os do Chefe nunca são sobrescritos. */
  private refreshFiles(): void {
    const folder = this.folder(); if (!folder || !fs.existsSync(folder)) return;
    try { writeDestinations(folder, this.cdb.listDestinations(), this.deps.social.state().accounts, this.profileName, this.focus()); } catch (err) { this.deps.log.warn('não gravou equipe/destinos.md', err); }
    try {
      const home = process.env.USERPROFILE ?? path.dirname(path.dirname(folder));
      writeInventory(folder, this.deps.origins ?? defaultOrigins(home), this.deps.siteDir === undefined ? path.join(home, 'projetos', 'aurora') : this.deps.siteDir, this.now());
    } catch (err) { this.deps.log.warn('não gravou referencias/originais.md', err); }
    try {
      const home = process.env.USERPROFILE ?? path.dirname(path.dirname(folder));
      writeMirrors(folder, this.deps.mirrors ?? defaultMirrors(home), this.now());
    } catch (err) { this.deps.log.warn('não atualizou referencias/espelho', err); }
  }

  private async ensureRoutine(workflow: 'content.radar' | 'content.analise', projectId: string): Promise<void> {
    if (this.deps.store.listRoutines().some(r => r.workflow === workflow)) return;
    if (!this.deps.routines) return;
    const role: ContentRole = workflow === 'content.radar' ? 'pesquisador' : 'revisor';
    const e = this.teamMember(role); if (!e) return;
    const routine: RoutineInput = workflow === 'content.radar'
      ? { title: RADAR_TITLE, prompt: 'Rodada do Radar da gringa. O pedido completo é montado pela HQ na hora do disparo.', employeeId: e.id, projectId, skill: null, schedule: { kind: 'daily', time: RADAR_TIMES[0], times: RADAR_TIMES }, enabled: true, permissionMode: null, model: null, effort: null, missedPolicy: 'run_once', workflow }
      : { title: 'Revisão semanal de resultados', prompt: 'Análise semanal de resultados. O pedido completo é montado pela HQ na hora do disparo.', employeeId: e.id, projectId, skill: null, schedule: { kind: 'weekly', time: '17:00', days: [5] }, enabled: true, permissionMode: null, model: null, effort: null, missedPolicy: 'run_once', workflow };
    await this.deps.routines.handle({ type: 'routine.create', reqId: 'content', routine });
  }

  private saveDestination(d: Omit<ContentDestination, 'updatedAt' | 'state'> & { confirm?: boolean }): ContentState {
    if (!isSocialSlot(d.slot)) throw new Error('destino desconhecido');
    const objective = txt(d.objective, 300); if (!objective) throw new Error('Escreva o objetivo do destino.');
    const cur = this.cdb.listDestinations().find(x => x.slot === d.slot);
    this.cdb.upsertDestination({
      slot: d.slot, objective, audience: txt(d.audience, 300) ?? '', language: txt(d.language, 40) ?? 'pt-BR',
      pillars: (Array.isArray(d.pillars) ? d.pillars : []).map(p => String(p).trim()).filter(Boolean).slice(0, 8),
      content: txt(d.content, 300) ?? '', indicator: txt(d.indicator, 300) ?? '', state: d.confirm ? 'confirmado' : cur?.state ?? 'proposta',
    });
    this.refreshFiles();
    this.push();
    return this.state();
  }

  // ------------------------------------------------------------------ rodadas (radar, semana, análise, transcrição)
  private requireReady(role: ContentRole): { folder: string; projectId: string; employee: Employee } {
    const projectId = this.projectId(); const folder = this.folder();
    if (!projectId || !folder || !fs.existsSync(folder)) throw new Error('Prepare a sala primeiro (pasta de conteúdo, equipe e especialidades).');
    const employee = this.teamMember(role);
    if (!employee) throw new Error(`Falta o funcionário de ${CONTENT_TEAM.find(t => t.role === role)!.title}: prepare a sala de novo.`);
    return { folder, projectId, employee };
  }

  private rel(folder: string, abs: string): string { return path.relative(folder, abs).split(path.sep).join('/'); }

  /** O que o pesquisador precisa saber do foco: destinos ativos, fontes ligadas e as referências já registradas (para não duplicar). */
  private radarScope(): RadarScope {
    const f = this.focus();
    const active = (f.activeSlots ?? SOCIAL_SLOTS.map(s => s.slot)).map(s => ({ slot: s, label: `${slotDef(s).label}${this.deps.social.account(s).declared?.handle ? ` @${this.deps.social.account(s).declared!.handle}` : ''}` }));
    const sources = f.sources.filter(s => s.enabled).map(s => { const d = RESEARCH_SOURCES.find(x => x.source === s.source)!; return { source: s.source, label: d.label, role: d.role }; });
    const known = this.cdb.listRadar(200).filter(r => r.postKey && !r.sourceUrl.startsWith('chefe://')).map(r => r.sourceUrl);
    return { active, sources, known };
  }

  private radarRoundPaths(folder: string): { outputPath: string; previous: string[] } {
    const stamp = new Date(this.now()).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16).replace(' ', '-').replace(':', '');
    let dir = path.join(folder, 'radar', stamp); let k = 2;
    while (fs.existsSync(dir)) dir = path.join(folder, 'radar', `${stamp}-${k++}`);
    const previous = this.cdb.listRounds(30).filter(r => r.kind === 'radar' && r.status === 'concluida').slice(0, 5).map(r => this.rel(folder, r.outputPath));
    return { outputPath: path.join(dir, 'oportunidades.json'), previous };
  }

  /** Rodada do Radar pedida pela tela (a rotina diária usa prepareRoutine). */
  private async startRadar(focus: string | null): Promise<ContentState> {
    const { folder, projectId, employee } = this.requireReady('pesquisador');
    this.refreshFiles();
    const { outputPath, previous } = this.radarRoundPaths(folder);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const round = this.cdb.createRound({ kind: 'radar', taskId: null, routineId: null, employeeId: employee.id, status: 'aguardando', startedAt: this.now(), outputPath, weekStart: null });
    const text = radarPrompt({ outputPath, now: this.now(), focus, previous, scope: this.radarScope() });
    await this.run(round, { text, projectId, employeeId: employee.id, skill: null });
    return this.state();
  }

  private async prepareWeek(start: string | null, note: string | null): Promise<ContentState> {
    const { folder, projectId, employee } = this.requireReady('coordenador');
    this.refreshFiles();
    const weekStart = isDate(start) ? start : brtDate(this.now());
    const weekEnd = addDays(weekStart, 6);
    let dir = path.join(folder, 'calendario', `semana-${weekStart}`); let k = 2;
    while (fs.existsSync(path.join(dir, 'calendario.json'))) dir = path.join(folder, 'calendario', `semana-${weekStart}-${k++}`);
    fs.mkdirSync(dir, { recursive: true });
    const outputPath = path.join(dir, 'calendario.json');
    const rounds = this.cdb.listRounds(40);
    const radar = rounds.filter(r => r.kind === 'radar' && r.status === 'concluida').slice(0, 3).map(r => this.rel(folder, r.outputPath));
    const calendars = rounds.filter(r => r.kind === 'semana' && r.status === 'concluida').slice(0, 4).map(r => this.rel(folder, r.outputPath));
    const results = rounds.filter(r => r.kind === 'analise' && r.status === 'concluida').slice(0, 2).map(r => this.rel(folder, r.outputPath));
    const csv = this.exportResults(path.join(dir, 'resultados-ate-agora.csv'));
    if (csv) results.push(this.rel(folder, csv));
    const round = this.cdb.createRound({ kind: 'semana', taskId: null, routineId: null, employeeId: employee.id, status: 'aguardando', startedAt: this.now(), outputPath, weekStart });
    await this.run(round, { text: weekPrompt({ outputPath, now: this.now(), weekStart, weekEnd, note, radar, calendars, results }), projectId, employeeId: employee.id, skill: null });
    return this.state();
  }

  private async startAnalysis(start: string | null): Promise<ContentState> {
    const prep = this.prepareAnalysis(start);
    await this.run(prep.round, { text: prep.text, projectId: prep.projectId, employeeId: prep.employeeId, skill: null });
    return this.state();
  }

  private prepareAnalysis(start: string | null): { round: ContentRound; text: string; projectId: string; employeeId: string } {
    const { folder, projectId, employee } = this.requireReady('revisor');
    const weekStart = isDate(start) ? start : addDays(brtDate(this.now()), -6);
    let dir = path.join(folder, 'resultados', `analise-${weekStart}`); let k = 2;
    while (fs.existsSync(path.join(dir, 'analise.json'))) dir = path.join(folder, 'resultados', `analise-${weekStart}-${k++}`);
    fs.mkdirSync(dir, { recursive: true });
    const outputPath = path.join(dir, 'analise.json');
    const csv = this.exportResults(path.join(dir, 'resultados-exportados.csv')) ?? path.join(dir, 'resultados-exportados.csv');
    if (!fs.existsSync(csv)) fs.writeFileSync(csv, 'metrica,valor\n', 'utf8');
    const published = this.cdb.listItems(300).filter(i => i.status === 'publicada' && i.publication && i.publication.at >= Date.parse(`${weekStart}T00:00:00-03:00`))
      .map(i => `${i.title} (${i.slot ? slotDef(i.slot).label : 'sem conta'}${i.publication?.url ? `, ${i.publication.url}` : ''})`);
    const round = this.cdb.createRound({ kind: 'analise', taskId: null, routineId: null, employeeId: employee.id, status: 'aguardando', startedAt: this.now(), outputPath, weekStart });
    return { round, text: analysisPrompt({ outputPath, now: this.now(), weekStart, resultsCsv: this.rel(folder, csv), items: published }), projectId, employeeId: employee.id };
  }

  /** Para as rotinas: monta o pedido na hora do disparo e liga a rodada à tarefa criada pela rotina. */
  async prepareRoutine(workflow: 'content.radar' | 'content.analise', r: Routine): Promise<{ text: string; skill: string | null; after(taskId: string): void }> {
    if (workflow === 'content.analise') {
      const prep = this.prepareAnalysis(null);
      this.deps.db.prepare('UPDATE content_rounds SET routine_id=? WHERE id=?').run(r.id, prep.round.id);
      return { text: prep.text, skill: null, after: taskId => { this.cdb.updateRound(prep.round.id, { taskId }); this.push(); } };
    }
    const { folder } = this.requireReady('pesquisador');
    this.refreshFiles();
    const { outputPath, previous } = this.radarRoundPaths(folder);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const round = this.cdb.createRound({ kind: 'radar', taskId: null, routineId: r.id, employeeId: r.employeeId, status: 'aguardando', startedAt: this.now(), outputPath, weekStart: null });
    this.push();
    return { text: radarPrompt({ outputPath, now: this.now(), focus: null, previous, scope: this.radarScope() }), skill: null, after: taskId => { this.cdb.updateRound(round.id, { taskId }); this.push(); } };
  }

  private async run(round: ContentRound, o: { text: string; projectId: string; employeeId: string; skill: string | null }): Promise<void> {
    try {
      const res = await this.deps.manager.runTask({ reqId: 'content', clientId: `content:${round.id}`, text: o.text, projectId: o.projectId, employeeId: o.employeeId, skill: o.skill, plan: false });
      this.cdb.updateRound(round.id, { taskId: res.taskId });
    } catch (err) {
      this.cdb.updateRound(round.id, { status: 'falhou', finishedAt: this.now(), error: `a tarefa não foi criada: ${(err as Error).message}` });
      this.push();
      throw err;
    }
    this.push();
  }

  /** Exporta os resultados registrados para o funcionário ler (CSV). null = nenhum resultado ainda. */
  private exportResults(file: string): string | null {
    const rows = this.cdb.listResults(1000);
    if (!rows.length) return null;
    const esc = (v: unknown) => { const t = v == null ? '' : String(v); return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = ['conta,url,metrica,valor,unidade,periodo_inicio,periodo_fim,idade_horas,denominador,fonte,a_conferir,hipotese,observacao,peca'];
    const items = new Map(this.cdb.listItems(500).map(i => [i.id, i.title]));
    for (const r of rows) lines.push([r.slot, r.postUrl, r.metric, r.value, r.unit, r.periodStart, r.periodEnd, r.ageHours, r.denominator, r.source, r.uncertain ? 'sim' : 'não', r.hypothesis, r.note, r.itemId ? items.get(r.itemId) : ''].map(esc).join(','));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return file;
  }

  // ------------------------------------------------------------------ peças
  private skillFor(slot: SocialSlotId | null): string | null { return slot ? SLOT_SKILL[slot] : null; }

  private createItem(p: ContentItemPatch & { title: string }): ContentState {
    const title = txt(p.title, 200); if (!title) throw new Error('Dê um título à peça.');
    const slot = p.slot && isSocialSlot(p.slot) ? p.slot : null;
    if (slot) this.requireActive(slot, 'Peça nova neste destino');
    this.cdb.insertItem({
      hypothesis: txt(p.hypothesis, 600),
      weekStart: null, baseId: null, baseTitle: null, date: isDate(p.date) ? p.date : null, time: isTime(p.time) ? p.time : null, slot, profileId: p.profileId ?? (slot ? slotDef(slot).defaultProfileIds[0] ?? null : null),
      format: txt(p.format, 80) ?? '', objective: txt(p.objective, 400) ?? this.cdb.listDestinations().find(d => d.slot === slot)?.objective ?? '', title, brief: txt(p.brief) ?? '',
      sources: (p.sources ?? []).filter(Boolean).slice(0, 20), files: (p.files ?? []).filter(Boolean).slice(0, 30), material: p.material ?? 'nao_precisa',
      ownerId: p.ownerId ?? this.producerFor(slot, txt(p.format, 80) ?? '')?.id ?? null, skill: p.skill ?? this.skillFor(slot), reviewCriteria: txt(p.reviewCriteria, 600) ?? '',
      status: 'planejada', taskId: null, reviewTaskId: null, radarId: null, folder: null, deliverable: null, checks: [], review: null, nextStep: null, approvalId: null, publication: null,
    });
    this.push();
    return this.state();
  }

  /**
   * Pedido rápido (tela Conteúdo, 05/11): "o que você quer postar" + conta + formato → peça com o texto exato do Chefe no briefing,
   * já na fila da criação. Sem calendário, Radar ou reunião no caminho; a revisão automática segue como sempre.
   */
  private async quickCreate(textArg: string, slotArg: SocialSlotId, format: QuickFormat): Promise<{ itemId: string }> {
    const text = String(textArg ?? '').trim();
    if (text.length < 3) throw new Error('Escreva o que você quer postar (uma frase basta).');
    if (!isSocialSlot(slotArg)) throw new Error('Escolha a conta: Instagram Tuco Dev, Instagram Aurora ou Threads da Aurora.');
    if (!quickFormatsFor(slotArg).includes(format)) throw new Error(slotArg === 'threads' ? 'No Threads o formato é post de texto.' : 'Escolha o formato: vídeo ou carrossel.');
    this.requireActive(slotArg, 'Peça nova neste destino');
    this.requireReady('criador');
    const def = slotDef(slotArg);
    const fmt = quickFormatName(format, slotArg);
    const deliver = format === 'video'
      ? 'o vídeo pronto: escreva o `video.json` que a HQ renderiza em MP4 (não entregue só roteiro, ideias ou perguntas)'
      : format === 'texto'
        ? 'o post pronto: o texto final no `peca.md` e no campo `text` do `entrega.json`, com no máximo 500 caracteres (não entregue só ideias ou perguntas)'
        : 'o carrossel pronto: escreva o `carrossel.json` que a HQ desenha em imagens (não entregue só ideias ou perguntas)';
    const brief = [
      `Pedido do Chefe, com as palavras dele: "${text.slice(0, 4000)}"`,
      `Entregue ${deliver}.`,
      `Conta: ${def.label}. Formato: ${fmt}. Não troque o assunto, a conta nem o formato.`,
      'Se faltar uma decisão que muda o resultado e que só o Chefe sabe, pergunte uma vez com AskUserQuestion (aparece na Mesa dele). Para o resto, decida pelo caminho mais simples, registre a suposição no peca.md e entregue. Não abra reunião.',
    ].join('\n');
    const item = this.cdb.insertItem({
      weekStart: null, baseId: null, baseTitle: null, date: brtDate(this.now()), time: null, slot: slotArg, profileId: def.defaultProfileIds[0] ?? null,
      format: fmt, objective: this.cdb.listDestinations().find(d => d.slot === slotArg)?.objective ?? '', title: quickTitle(text) || `${fmt} para ${def.label}`, brief,
      sources: (text.match(/https?:\/\/\S+/g) ?? []).slice(0, 10), files: [], material: 'nao_precisa', ownerId: this.producerFor(slotArg, fmt)?.id ?? null, skill: this.skillFor(slotArg),
      reviewCriteria: format === 'texto'
        ? 'entregou exatamente o que o Chefe pediu (assunto e conta); post pronto com até 500 caracteres, na voz do Chefe, que faz sentido sozinho; primeira frase prende; nada inventado'
        : 'entregou exatamente o que o Chefe pediu (assunto, conta e formato); arquivo final pronto; gancho nos 3 primeiros segundos ou no 1º slide; nada inventado',
      status: 'planejada', taskId: null, reviewTaskId: null, radarId: null, folder: null, deliverable: null, checks: [], review: null, nextStep: null, approvalId: null, publication: null,
    }, { action: 'pedido do Chefe (tela Conteúdo)', detail: text.slice(0, 300), origin: 'interface' });
    await this.produce(item.id, null);
    return { itemId: item.id };
  }

  private updateItem(id: string, p: ContentItemPatch): ContentState {
    const cur = this.cdb.getItem(id); if (!cur) throw new Error('peça não encontrada');
    if (cur.status === 'em_producao' && p.status) throw new Error('A peça está em produção: espere terminar.');
    if (p.status && cur.status === 'publicada') throw new Error('Peça publicada não muda de estado (o registro fica).');
    const slot = p.slot === undefined ? cur.slot : p.slot && isSocialSlot(p.slot) ? p.slot : null;
    if (p.slot !== undefined && slot !== cur.slot && slot) this.requireActive(slot, 'Mover a peça para este destino');
    if (p.hypothesis !== undefined) this.cdb.setItemExtras(id, { hypothesis: txt(p.hypothesis, 600) });
    if (p.slot !== undefined && slot !== cur.slot && cur.pausedReason && this.active(slot)) this.cdb.setPaused(id, null, { action: 'retomada', detail: `movida para ${slot ? slotDef(slot).label : 'sem conta'}`, origin: 'interface' });
    this.cdb.updateItem(id, {
      date: p.date === undefined ? cur.date : isDate(p.date) ? p.date : null, time: p.time === undefined ? cur.time : isTime(p.time) ? p.time : null, slot, profileId: p.profileId === undefined ? cur.profileId : p.profileId,
      format: p.format ?? cur.format, objective: p.objective ?? cur.objective, title: txt(p.title, 200) ?? cur.title, brief: p.brief ?? cur.brief,
      sources: p.sources ?? cur.sources, files: p.files ?? cur.files, material: p.material ?? cur.material, ownerId: p.ownerId === undefined ? cur.ownerId : p.ownerId,
      skill: p.skill === undefined ? (p.slot !== undefined ? this.skillFor(slot) : cur.skill) : p.skill, reviewCriteria: p.reviewCriteria ?? cur.reviewCriteria,
      status: p.status ?? cur.status,
    });
    this.push();
    return this.state();
  }

  private radarToItem(id: string, slotArg: SocialSlotId | null): ContentState {
    const r = this.cdb.getRadar(id); if (!r) throw new Error('oportunidade não encontrada');
    if (r.itemId && this.cdb.getItem(r.itemId)) throw new Error('Esta oportunidade já virou peça.');
    const slot = slotArg && isSocialSlot(slotArg) ? slotArg : r.slot;
    if (slot) this.requireActive(slot, 'Transformar a referência em peça neste destino');
    const dest = this.cdb.listDestinations().find(d => d.slot === slot);
    const fmt = r.format === 'reel' ? 'Reel' : r.format === 'carrossel' ? 'carrossel' : r.format === 'imagem' ? 'imagem' : r.format === 'threads' ? 'post Threads' : null;
    const ref = [
      `Referência (${r.kind === 'chefe' ? 'enviada pelo Chefe' : r.kind}${r.platform ? `, ${r.platform}` : ''}): ${r.sourceUrl.startsWith('chefe://') ? 'sem link original' : r.sourceUrl}${r.author ? ` · ${r.author}` : ''}`,
      r.observed ? `O que foi observado: ${r.observed}` : null,
      r.opening ? `Abertura proposta: ${r.opening}` : null,
      r.fit ? `Por que serve: ${r.fit}` : null,
      r.audio ? `Áudio: ${r.audio}` : null,
      r.files.length ? `Arquivos da referência: ${r.files.join(' ; ')}` : null,
      r.note ? `Nota do Chefe: ${r.note}` : null,
    ].filter(Boolean).join('\n');
    const item = this.cdb.insertItem({
      hypothesis: r.reason ?? r.fit ?? null, referenceIds: [r.id],
      weekStart: null, baseId: null, baseTitle: null, date: null, time: null, slot, profileId: slot ? slotDef(slot).defaultProfileIds[0] ?? null : null,
      format: fmt ?? (slot === 'x' ? 'nota X' : slot === 'pinterest' ? 'pin' : ''), objective: dest?.objective ?? '', title: r.subject.slice(0, 200),
      brief: `${r.proposal}\n\nInterpretação do Radar: ${r.interpretation}${r.material ? `\nMaterial: ${r.material}` : ''}\n\n${ref}`, sources: r.sourceUrl.startsWith('chefe://') ? [] : [r.sourceUrl], files: r.files.slice(0, 12),
      material: slot === 'x' ? 'nao_precisa' : 'pronto', ownerId: this.producerFor(slot, fmt ?? '')?.id ?? null, skill: this.skillFor(slot),
      reviewCriteria: slot === 'x' ? 'fato confirmado na origem, datas corretas, sem urgência inventada, tradução fiel' : 'fatos com fonte, identidade da marca, limites da rede',
      status: 'planejada', taskId: null, reviewTaskId: null, radarId: r.id, folder: null, deliverable: null, checks: [], review: null, nextStep: null, approvalId: null, publication: null,
    });
    this.cdb.setRadarStatus(id, 'virou_peca', item.id);
    this.push();
    return this.state();
  }

  private pieceFolder(item: ContentItem, folder: string): string {
    if (item.folder && fs.existsSync(item.folder)) return item.folder;
    const net = item.slot ? slotDef(item.slot).network : 'geral';
    const base = path.join(folder, 'marcas', brandFolder(item.profileId, item.slot), 'pecas', `${item.date ?? brtDate(this.now())}-${net}-${slugify(item.title)}`);
    let dir = base; let k = 2;
    while (fs.existsSync(dir)) dir = `${base}-${k++}`;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async produce(id: string, note: string | null, noteFrom: 'chefe' | 'revisor' | 'conferencia' = 'chefe'): Promise<ContentState> {
    const item = this.cdb.getItem(id); if (!item) throw new Error('peça não encontrada');
    if (item.status === 'em_producao') throw new Error('Esta peça já está em produção.');
    if (item.status === 'publicada' || item.status === 'descartada') throw new Error('Peça publicada ou descartada não volta para produção.');
    if (item.deletedAt) throw new Error('Esta peça está na lixeira: restaure antes de produzir.');
    if (item.archivedAt) throw new Error('Esta peça está arquivada: desarquive antes de produzir.');
    if (!item.slot) throw new Error('Escolha a conta de destino antes de produzir.');
    if (item.pausedReason || !this.active(item.slot)) throw new Error(`${this.pausedWhy(item.slot)} A peça fica guardada como está; produzir de novo só quando o Chefe incluir este destino no foco.`);
    // Peça de um plano com etapa por fazer (pesquisa, roteiro, direção): a linha de produção vem antes da produção final.
    if (item.pipeline && item.pipeline.steps.some(st => st.status !== 'feito')) { await this.advancePipeline(id); return this.state(); }
    const { folder, projectId } = this.requireReady('criador');
    const owner = item.ownerId ? this.deps.store.getEmployee(item.ownerId) : null;
    // Dono antigo de outra equipe (peça do Tuco com a Bia, de antes das equipes) passa para a equipe da conta.
    const squad = this.squadOf(item.slot);
    const ownerFits = owner && !owner.archivedAt && (!owner.profileId || !squad || owner.profileId === squad);
    const employee = ownerFits ? owner : this.producerFor(item.slot, item.format) ?? this.teamMember('criador')!;
    const dir = this.pieceFolder(item, folder);
    this.refreshFiles();
    // Material citado fora da pasta de conteúdo vira cópia na pasta da peça (o funcionário lê sem pedir autorização; o original fica intacto).
    const files = item.files.map(f => {
      const abs = path.resolve(f);
      if (!path.isAbsolute(f) || !fs.existsSync(abs) || abs.toLowerCase().startsWith(folder.toLowerCase() + path.sep)) return f;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) return f;
        // Vídeo e arquivo grande ficam só como referência (o funcionário não assiste vídeo; não vale duplicar no disco).
        if (/\.(mp4|mov|mkv|webm|avi)$/i.test(abs) || st.size > 8_000_000) return `${abs} (referência: vídeo ou arquivo grande, não copiado; use o roteiro, a legenda .srt e as anotações)`;
        const dst = path.join(dir, 'material', path.basename(abs));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (!fs.existsSync(dst)) fs.copyFileSync(abs, dst);
        return `${dst} (cópia de ${abs})`;
      } catch { return f; }
    });
    const fresh = { ...item, folder: dir, files };
    const text = piecePrompt({ item: fresh, folder: dir, profileName: item.profileId ? this.profileName(item.profileId) : null, note, noteFrom, academy: this.academyIndexExists(), steps: item.pipeline ? stepsNote(item.pipeline.steps) : null });
    const res = await this.deps.manager.runTask({ reqId: 'content', clientId: `content:item:${id}:${this.now()}`, text, projectId, employeeId: employee.id, skill: item.skill, plan: false, destinationId: item.slot, profileId: item.profileId ?? undefined });
    this.cdb.updateItem(id, { status: 'em_producao', taskId: res.taskId, folder: dir, ownerId: employee.id, review: null, reviewTaskId: null, checks: [], nextStep: null, approvalId: null }, { action: note ? (noteFrom === 'chefe' ? 'ajuste pedido pelo Chefe' : noteFrom === 'revisor' ? 'ajuste pedido pelo revisor' : 'correção pedida pela conferência') : 'produção', detail: note ? note.slice(0, 300) : null, origin: noteFrom === 'chefe' ? 'interface' : noteFrom === 'revisor' ? 'revisor' : 'conferência' });
    this.push();
    return this.state();
  }

  /**
   * A semana inteira para a fila: cada peça planejada (com conta e sem material a gravar ou editar) vai para a criação, e cada
   * entrega segue sozinha para uma revisão. O Chefe só aprova no fim. Peça que não pode ser produzida fica com o motivo.
   */
  private async produceWeek(weekArg: string | null, auto = false): Promise<ContentState & { produced: number; skipped: string[] }> {
    const items = this.cdb.listItems(500).filter(i => i.status === 'planejada' && !i.archivedAt);
    const ws = weekArg && isDate(weekArg) ? weekArg : items.map(i => i.weekStart).filter((w): w is string => Boolean(w)).sort().pop() ?? null;
    if (!ws) throw new Error('Não há peças planejadas para produzir. Peça o calendário da semana primeiro.');
    const end = new Date(Date.parse(`${ws}T12:00:00Z`) + 6 * DAY).toISOString().slice(0, 10);
    // Da semana: veio do calendário dela ou foi criada à mão com data dentro dela.
    const week = items.filter(i => i.weekStart === ws || (!i.weekStart && i.date != null && i.date >= ws && i.date <= end)).sort((a, b) => `${a.date ?? ''}${a.time ?? ''}`.localeCompare(`${b.date ?? ''}${b.time ?? ''}`));
    const skipped: string[] = []; let produced = 0;
    for (const i of week) {
      if (!i.slot) { skipped.push(`"${i.title}": sem conta de destino`); continue; }
      if (i.pausedReason || !this.active(i.slot)) { skipped.push(`"${i.title}": destino pausado (${this.focus().reason})`); continue; }
      if (i.material === 'gravar' || i.material === 'editar') { skipped.push(`"${i.title}": precisa ${i.material === 'gravar' ? 'gravar' : 'editar'} o material antes`); continue; }
      try { await this.produce(i.id, null); produced++; }
      catch (err) { skipped.push(`"${i.title}": ${(err as Error).message}`); }
    }
    this.deps.log.info(`conteúdo: semana ${ws}${auto ? ' (automático, depois do calendário)' : ''}: ${produced} peça(s) para a produção${skipped.length ? `; fora: ${skipped.join('; ')}` : ''}`);
    this.deps.audit?.({ action: 'produzir semana', entity: 'conteúdo', entityId: ws, title: `${produced} peça(s)`, origin: auto ? 'sistema' : 'interface', detail: skipped.length ? `fora: ${skipped.join('; ')}` : null });
    this.push();
    return { ...this.state(), produced, skipped };
  }

  private async review(id: string): Promise<ContentState> {
    const item = this.cdb.getItem(id); if (!item) throw new Error('peça não encontrada');
    if (!item.folder || !fs.existsSync(path.join(item.folder, 'entrega.json'))) throw new Error('A peça ainda não tem entrega para revisar.');
    if (item.reviewTaskId) { const t = this.deps.store.getTask(item.reviewTaskId); if (t && OPEN.includes(t.status)) throw new Error('A revisão desta peça já está na fila.'); }
    if (item.pausedReason || !this.active(item.slot)) throw new Error(`${this.pausedWhy(item.slot)} A revisão fica para quando o destino voltar ao foco.`);
    const { projectId, employee } = this.requireReady('revisor');
    const checks = item.checks.length ? item.checks.map(c => `${c.ok ? 'ok' : 'FALHOU'}: ${c.name} (${c.detail})`).join('; ') : 'nenhuma ainda';
    const res = await this.deps.manager.runTask({ reqId: 'content', clientId: `content:review:${id}:${this.now()}`, text: reviewPrompt({ item, folder: item.folder, checks }), projectId, employeeId: employee.id, skill: item.skill, plan: false, destinationId: item.slot, profileId: item.profileId ?? undefined });
    this.cdb.updateItem(id, { reviewTaskId: res.taskId, review: null, status: item.status === 'ajustar' ? 'ajustar' : 'revisar' });
    this.push();
    return this.state();
  }

  private approve(itemIds: string[], from: string, to: string, note: string | null): ContentState {
    if (!isDate(from) || !isDate(to) || to < from) throw new Error('Período inválido: use datas de início e fim (fim igual ou depois do início).');
    const items = [...new Set(itemIds)].map(id => this.cdb.getItem(id)).filter((i): i is ContentItem => Boolean(i));
    if (!items.length) throw new Error('Escolha as peças do lote.');
    // "Ajustar" também entra: depois da rodada automática a decisão é do Chefe, e aprovar assim mesmo é uma decisão dele.
    const bad = items.filter(i => !['revisar', 'ajustar', 'aprovada'].includes(i.status) || i.deletedAt || i.archivedAt);
    if (bad.length) throw new Error(`Só peças entregues (para revisar ou ajustar) podem ser aprovadas: ${bad.map(b => `"${b.title}"`).join(', ')}.`);
    const paused = items.filter(i => i.pausedReason || !this.active(i.slot));
    if (paused.length) throw new Error(`Destino pausado pelo foco (${this.focus().reason}): ${paused.map(b => `"${b.title}"`).join(', ')} fica(m) fora do lote.`);
    const slots = [...new Set(items.map(i => i.slot).filter((s): s is SocialSlotId => Boolean(s)))];
    const a = this.cdb.insertApproval({ itemIds: items.map(i => i.id), slots, from, to, note });
    for (const i of items) this.cdb.updateItem(i.id, { status: 'aprovada', approvalId: a.id, nextStep: `aprovada pelo Chefe (${from} a ${to}); postar continua manual enquanto a conta não estiver conectada` }, { action: 'aprovada pelo Chefe', detail: i.status === 'ajustar' ? 'aprovada mesmo com o pedido de ajuste do revisor' : null, origin: 'interface' });
    this.deps.audit?.({ action: 'aprovar lote', entity: 'conteúdo', entityId: a.id, title: `${items.length} peça(s)`, origin: 'interface', detail: `contas: ${slots.join(', ') || 'nenhuma'}; período ${from} a ${to}` });
    this.push();
    return this.state();
  }

  /** Desfazer aprovação: a peça volta para "Para revisar" e sai do lote (o lote sem peça nenhuma é revogado). Publicada fica. */
  private unapprove(itemIds: string[]): ContentState & { undone: string[] } {
    const undone: string[] = [];
    for (const id of [...new Set(itemIds)]) {
      const i = this.cdb.getItem(id); if (!i || i.status !== 'aprovada') continue;
      this.cdb.updateItem(id, { status: 'revisar', approvalId: null, nextStep: 'aprovação desfeita: falta a sua revisão' }, { action: 'aprovação desfeita', detail: null, origin: 'interface' });
      undone.push(id);
      if (i.approvalId && !this.cdb.listItems(800).some(x => x.approvalId === i.approvalId)) this.cdb.revokeApproval(i.approvalId);
    }
    if (undone.length) this.deps.audit?.({ action: 'desfazer aprovação', entity: 'conteúdo', entityId: null, title: `${undone.length} peça(s)`, origin: 'interface', detail: null });
    this.push();
    return { ...this.state(), undone };
  }

  private approvalCovers(item: ContentItem, day: string): boolean {
    if (!item.approvalId) return false;
    const a = this.cdb.getApproval(item.approvalId);
    return Boolean(a && !a.revokedAt && a.itemIds.includes(item.id) && item.slot && a.slots.includes(item.slot) && day >= a.from && day <= a.to);
  }

  private entrega(item: ContentItem): Entrega | null {
    if (!item.folder) return null;
    try { const p = parseEntrega(JSON.parse(fs.readFileSync(path.join(item.folder, 'entrega.json'), 'utf8'))); return p.ok ? p.value : null; } catch { return null; }
  }

  /** Publica pela API quando a conta permite e o lote aprovado cobre a peça hoje; senão devolve o pacote manual. */
  private async publish(id: string, clientId: string): Promise<unknown> {
    const item = this.cdb.getItem(id); if (!item) throw new Error('peça não encontrada');
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(clientId)) throw new Error('identificador de envio inválido');
    if (item.status === 'publicada') return { mode: 'done', publication: item.publication };
    if (item.status !== 'aprovada' && item.status !== 'publicacao_pendente') throw new Error('Aprove a peça (lote com contas e período) antes de publicar.');
    if (!item.slot) throw new Error('A peça não tem conta de destino.');
    if (item.pausedReason || !this.active(item.slot)) throw new Error(`${this.pausedWhy(item.slot)} Nada é publicado nem agendado neste destino.`);
    const e = this.entrega(item); if (!e) throw new Error('A entrega da peça não foi encontrada ou é inválida.');
    const prior = this.cdb.attempt(clientId);
    if (prior?.status === 'published') return { mode: 'api', url: prior.url, duplicate: true };
    const acct = this.deps.social.account(item.slot);
    const today = brtDate(this.now());
    if (acct.browser?.mode === 'navegador' && acct.browser.state === 'verificada' && this.approvalCovers(item, today)) return this.browserTask(id, 'publicar', clientId);
    const apiReady = acct.mode === 'api' && (acct.status === 'connected' || acct.status === 'expiring') && Boolean(acct.capabilities.publish.hqReady);
    if (apiReady && this.approvalCovers(item, today)) {
      this.cdb.saveAttempt(clientId, id, item.slot, 'sending', null, null);
      try {
        const r = await this.deps.social.publish(item.slot, clientId, e.text, item.taskId);
        this.cdb.saveAttempt(clientId, id, item.slot, 'published', `post ${r.remotePostId}`, r.url);
        this.cdb.updateItem(id, { status: 'publicada', publication: { url: r.url, at: this.now(), verifiedBy: 'provedor', detail: `a API devolveu o post ${r.remotePostId}` } });
        this.push();
        return { mode: 'api', url: r.url, duplicate: r.duplicate };
      } catch (err) {
        // Sem confirmação do provedor: fica pendente (a mesma chave não publica duas vezes).
        this.cdb.saveAttempt(clientId, id, item.slot, 'failed', (err as Error).message.slice(0, 300), null);
        this.cdb.updateItem(id, { status: 'publicacao_pendente', publication: { url: null, at: this.now(), verifiedBy: 'pendente', detail: `a tentativa pela API não foi confirmada: ${(err as Error).message}` } });
        this.push();
        throw err;
      }
    }
    // Manual: pacote pronto + site oficial. O registro só vira "publicada" com o link conferido.
    const def = slotDef(item.slot);
    const openUrl = def.network === 'x' ? `https://x.com/intent/post?text=${encodeURIComponent(e.text)}` : def.siteUrl;
    const why = acct.mode === 'manual' ? `${def.label} é manual nesta etapa` : !apiReady ? `${def.label} ainda não está conectada para publicar pela HQ` : 'a peça está fora do período ou das contas do lote aprovado';
    this.cdb.updateItem(id, { status: 'publicacao_pendente', publication: { url: null, at: this.now(), verifiedBy: 'pendente', detail: `pacote entregue para publicação manual (${why}); cole o link do post para a HQ conferir` } });
    this.push();
    const files = (e.files.length ? e.files : ['peca.md']).map(f => path.isAbsolute(f) ? f : path.join(item.folder!, f));
    if (def.network === 'pinterest' && fs.existsSync(path.join(item.folder!, 'pin.png'))) files.unshift(path.join(item.folder!, 'pin.png'));
    return {
      mode: 'manual', why, openUrl, text: e.text, title: e.title, description: e.description, board: e.board, destinationUrl: e.destinationUrl, files: [...new Set(files)],
      steps: def.network === 'x' ? ['Entre na conta do X no navegador (o login é seu).', 'Confira o texto pré-preenchido e publique.', 'Copie o link do post e cole na HQ para conferir.']
        : def.network === 'pinterest' ? ['Abra o criador de Pins com a conta business.', 'Envie o pin.png, cole título, descrição e o link de destino, escolha a pasta.', 'Publique e cole o link do Pin na HQ.']
          : ['Abra a rede com a conta certa.', 'Publique com o texto e os arquivos do pacote.', 'Cole o link do post na HQ para conferir.'],
    };
  }

  /**
   * "Já publiquei" (o Chefe postou pelo app): aprova se faltava e marca como publicada agora. Link de outra rede ou inválido é
   * recusado (corrigir o link); link certo que a rede não deixa conferir fica registrado com o motivo. Sem link, vale a palavra
   * do Chefe e a peça diz que falta o link para medir resultados. Publicar à mão não é publicação automática: vale também para
   * destino pausado (é só o registro do que aconteceu).
   */
  private async markPublished(id: string, urlArg: string | null): Promise<ContentState & { ok: boolean; detail: string }> {
    const item = this.cdb.getItem(id); if (!item) throw new Error('peça não encontrada');
    if (item.deletedAt) throw new Error('A peça está na lixeira: restaure antes.');
    if (!item.slot) throw new Error('A peça não tem conta de destino.');
    const url = txt(urlArg, 600);
    const addingLink = item.status === 'publicada' && item.publication?.verifiedBy === 'chefe' && !item.publication.url;
    if (item.status === 'publicada' && !addingLink) throw new Error('Esta peça já está registrada como publicada.');
    if (!addingLink && !['revisar', 'ajustar', 'aprovada', 'publicacao_pendente', 'agendada'].includes(item.status)) throw new Error('Só peça entregue pode ser marcada como publicada (esta ainda não tem entrega completa).');
    if (addingLink && !url) throw new Error('Cole o link do post.');
    let verifiedBy: 'link' | 'chefe' = 'chefe';
    let detail = 'informado pelo Chefe, sem link: cole o link do post para a HQ medir os resultados';
    if (url) {
      const v = await verifyPost(slotDef(item.slot).network, url, this.entrega(item)?.text ?? null, this.deps.fetch ?? fetch);
      if (!v.ok && /link inválido|precisa começar|não é do|não encontrou este post|texto não confere/.test(v.detail)) throw new Error(`Link não aceito: ${v.detail}.`);
      verifiedBy = v.ok ? 'link' : 'chefe';
      detail = v.ok ? `publicada pelo Chefe; ${v.detail}` : `informado pelo Chefe; o link não foi conferido agora (${v.detail})`;
    }
    const now = this.now();
    if (['revisar', 'ajustar'].includes(item.status)) {
      const day = brtDate(now);
      const a = this.cdb.insertApproval({ itemIds: [id], slots: [item.slot], from: day, to: day, note: 'aprovada ao registrar a publicação feita pelo Chefe' });
      this.cdb.updateItem(id, { status: 'aprovada', approvalId: a.id }, { action: 'aprovada pelo Chefe', detail: 'ao marcar "Já publiquei"', origin: 'interface' });
    }
    const at = addingLink ? item.publication!.at : now;
    this.cdb.updateItem(id, { status: 'publicada', publication: { url: url ?? null, at, verifiedBy, detail }, nextStep: url ? null : 'cole o link do post (botão "Adicionar link") para a HQ medir os resultados de 24 h e 7 dias' }, { action: addingLink ? 'link da publicação' : 'publicada pelo Chefe', detail: `${url ?? 'sem link'} · ${detail}`, origin: 'interface' });
    this.deps.audit?.({ action: addingLink ? 'link da publicação' : 'publicada pelo Chefe', entity: 'conteúdo', entityId: id, title: item.title, origin: 'interface', detail: `${url ?? 'sem link'} · ${detail}` });
    this.push();
    return { ...this.state(), ok: verifiedBy === 'link', detail };
  }

  /** Desfaz o "Já publiquei" (registro errado). A peça volta para aprovada; nada é removido de rede nenhuma. */
  private unmarkPublished(id: string): ContentState {
    const item = this.cdb.getItem(id); if (!item) throw new Error('peça não encontrada');
    if (item.status !== 'publicada' || !['chefe', 'link'].includes(item.publication?.verifiedBy ?? '')) throw new Error('Só o registro feito por "Já publiquei" pode ser desfeito aqui.');
    this.cdb.updateItem(id, { status: 'aprovada', publication: null, nextStep: 'registro de publicação desfeito pelo Chefe' }, { action: 'publicação desfeita', detail: 'registro corrigido pelo Chefe; nada foi removido das redes', origin: 'interface' });
    this.deps.audit?.({ action: 'desfazer publicação', entity: 'conteúdo', entityId: id, title: item.title, origin: 'interface', detail: 'só o registro na HQ' });
    this.push();
    return this.state();
  }

  private async registerPost(id: string, url: string): Promise<{ ok: boolean; detail: string; state: ContentState }> {
    const item = this.cdb.getItem(id); if (!item) throw new Error('peça não encontrada');
    if (!item.slot) throw new Error('A peça não tem conta de destino.');
    const e = this.entrega(item);
    const v = await verifyPost(slotDef(item.slot).network, url, e?.text ?? null, this.deps.fetch ?? fetch);
    if (v.ok) {
      this.cdb.updateItem(id, { status: 'publicada', publication: { url: url.trim(), at: this.now(), verifiedBy: 'link', detail: v.detail } });
      this.deps.audit?.({ action: 'registrar publicação', entity: 'conteúdo', entityId: id, title: item.title, origin: 'interface', detail: `${url.trim()} · ${v.detail}` });
    } else {
      this.cdb.updateItem(id, { status: 'publicacao_pendente', publication: { url: url.trim(), at: this.now(), verifiedBy: 'pendente', detail: v.detail } });
    }
    this.push();
    return { ok: v.ok, detail: v.detail, state: this.state() };
  }

  // ------------------------------------------------------------------ resultados
  private addResult(r: Extract<ContentClientMessage, { type: 'content.result.add' }>['result']): ContentState {
    const metric = txt(r.metric, 120); if (!metric) throw new Error('Escreva o nome da métrica como a rede chama.');
    if (r.slot && !isSocialSlot(r.slot)) throw new Error('conta desconhecida');
    if (r.itemId && !this.cdb.getItem(r.itemId)) throw new Error('peça não encontrada');
    const value = r.value == null || r.value === ('' as unknown) ? null : Number(r.value);
    if (value != null && !Number.isFinite(value)) throw new Error('Valor inválido (deixe vazio se não foi coletado).');
    this.cdb.insertResult({ itemId: r.itemId ?? null, slot: r.slot ?? null, postUrl: txt(r.postUrl, 600), metric, value, unit: txt(r.unit, 30), periodStart: txt(r.periodStart, 30), periodEnd: txt(r.periodEnd, 30), ageHours: r.ageHours ?? null, denominator: txt(r.denominator, 120), source: 'manual', evidencePath: null, uncertain: false, hypothesis: txt(r.hypothesis, 400), note: txt(r.note, 600) });
    this.push();
    return this.state();
  }

  private importCsv(csv: string, fileName: string | null): { imported: number; skipped: string[]; state: ContentState } {
    if (!csv || csv.length > 2_000_000) throw new Error('CSV vazio ou grande demais (limite de 2 MB).');
    const folder = this.folder();
    let evidence: string | null = null;
    if (folder) {
      const dir = path.join(folder, 'resultados', 'importados'); fs.mkdirSync(dir, { recursive: true });
      evidence = path.join(dir, `${brtDate(this.now())}-${slugify(fileName?.replace(/\.csv$/i, '') ?? 'resultados')}-${String(this.now()).slice(-5)}.csv`);
      fs.writeFileSync(evidence, csv, 'utf8');
    }
    const { rows, skipped } = csvToResults(csv, evidence);
    const byUrl = new Map(this.cdb.listItems(500).filter(i => i.publication?.url).map(i => [i.publication!.url!, i]));
    for (const r of rows) { const it = r.postUrl ? byUrl.get(r.postUrl) : undefined; this.cdb.insertResult({ ...r, itemId: it?.id ?? null, slot: r.slot ?? it?.slot ?? null }); }
    this.push();
    return { imported: rows.length, skipped, state: this.state() };
  }

  private async capture(m: Extract<ContentClientMessage, { type: 'content.result.capture' }>): Promise<ContentState> {
    if (!/^image\/(png|jpeg|webp)$/.test(m.mediaType)) throw new Error('A captura precisa ser PNG, JPEG ou WebP.');
    const buf = Buffer.from(m.dataBase64, 'base64');
    if (!buf.length || buf.length > 8_000_000) throw new Error('Imagem vazia ou maior que 8 MB.');
    const { folder, projectId, employee } = this.requireReady('revisor');
    const dir = path.join(folder, 'resultados', 'evidencias', `${brtDate(this.now())}-${String(this.now()).slice(-6)}`);
    fs.mkdirSync(dir, { recursive: true });
    const img = path.join(dir, `captura${m.mediaType === 'image/png' ? '.png' : m.mediaType === 'image/webp' ? '.webp' : '.jpg'}`);
    fs.writeFileSync(img, buf);
    const outputPath = path.join(dir, 'transcricao.json');
    const round = this.cdb.createRound({ kind: 'transcricao', taskId: null, routineId: null, employeeId: employee.id, status: 'aguardando', startedAt: this.now(), outputPath, weekStart: null });
    fs.writeFileSync(path.join(dir, 'contexto.json'), JSON.stringify({ itemId: m.itemId ?? null, slot: m.slot ?? null, nome: m.name }, null, 2), 'utf8');
    await this.run(round, { text: transcriptionPrompt({ outputPath, imagePath: img, slot: m.slot ?? null }), projectId, employeeId: employee.id, skill: null });
    return this.state();
  }

  // ------------------------------------------------------------------ acompanhamento das tarefas (retomada)
  private limitFor(taskId: string): number | null {
    const r = this.cdb.roundByTask(taskId);
    if (r) return LIMITS[r.kind];
    if (this.cdb.itemByTask(taskId)) return LIMITS.peca;
    if (this.cdb.itemByReviewTask(taskId)) return LIMITS.revisao;
    return null;
  }

  /** Segue tarefas reexecutadas (retry automático depois de queda) até a última tentativa. */
  private follow(taskId: string): Task | null {
    let t = this.deps.store.getTask(taskId);
    for (let i = 0; t && i < 20; i++) {
      if (!['interrupted', 'lost', 'error'].includes(t.status)) break;
      // Queda (retry:) ou limite de uso/rede (resume:, retomada na mesma conversa): a peça segue a nova tentativa.
      const n = (t.attempt ?? 1) + 1;
      const next = this.deps.store.findTaskByClientId(`retry:${t.id}:${n}`) ?? this.deps.store.findTaskByClientId(`resume:${t.id}:${n}`);
      if (!next) break;
      t = next;
    }
    return t;
  }

  /** Uma passada por vez; chamadas durante uma passada viram UMA passada seguinte (quem espera recebe o resultado dela). */
  sync(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.running) { this.running = this.syncOnce().finally(() => { this.running = null; }); return this.running; }
    this.pending = this.running.then(() => { this.pending = null; return this.sync(); });
    return this.pending;
  }

  private async syncOnce(): Promise<void> {
    let changed = false;
    try {
      // Peça na lixeira: retentativa ou tarefa que apareceu depois (reinício, queda) é cancelada; a peça nunca volta sozinha.
      for (const item of this.cdb.trashedWithTasks()) await this.stopItemWork(item, 'peça na lixeira');
      // Destino pausado pelo foco: retentativa (queda, limite de uso) ou retomada depois de reiniciar também não roda.
      for (const item of this.cdb.pausedWithTasks()) { if ((await this.stopItemWork(item, 'destino pausado pelo foco')).length) changed = true; }
      // Pedido do dia que já passou sai da Mesa (05/11: "as mensagens estão presas no dia 04/11"). Só o pedido é arquivado; as
      // peças dele ficam como estão, no Mural e na tela Conteúdo.
      const today = brtDate(this.now());
      for (const r of this.cdb.listRequests(200)) if (r.status === 'ativo' && r.date < today) { this.cdb.updateRequest(r.id, { status: 'arquivado' }); changed = true; }
      for (const round of this.cdb.openRounds()) {
        if (!round.taskId) {
          if (this.now() - round.startedAt > 5 * 60_000) { this.cdb.updateRound(round.id, { status: 'falhou', finishedAt: this.now(), error: 'a tarefa não chegou a ser criada (HQ desligada no meio ou erro ao criar)' }); changed = true; }
          continue;
        }
        const t = this.follow(round.taskId);
        if (!t) { this.cdb.updateRound(round.id, { status: 'falhou', finishedAt: this.now(), error: 'a tarefa não existe mais' }); changed = true; continue; }
        if (t.id !== round.taskId) { this.cdb.updateRound(round.id, { taskId: t.id }); changed = true; }
        if (OPEN.includes(t.status)) continue;
        await this.importRound(this.cdb.getRound(round.id)!, t); changed = true;
      }
      for (const item of this.cdb.itemsWithOpenWork()) {
        if (item.status === 'em_producao' && item.taskId) {
          const t = this.follow(item.taskId);
          if (t && t.id !== item.taskId) { this.cdb.updateItem(item.id, { taskId: t.id }); changed = true; }
          if (!t || OPEN.includes(t.status)) continue;
          await this.importPiece(this.cdb.getItem(item.id)!, t); changed = true;
        } else if (item.reviewTaskId) {
          const t = this.follow(item.reviewTaskId);
          if (t && t.id !== item.reviewTaskId) { this.cdb.updateItem(item.id, { reviewTaskId: t.id }); changed = true; }
          if (!t || OPEN.includes(t.status)) continue;
          await this.importReview(this.cdb.getItem(item.id)!, t); changed = true;
        }
      }
      if (await this.syncVideos()) changed = true;
      if (await this.syncStudies()) changed = true;
      if (await this.autoPublish()) changed = true;
    } catch (err) {
      this.deps.log.warn('conteúdo: falha ao acompanhar as tarefas', err);
    } finally {
      if (changed) this.push();
    }
  }

  /** O que a peça entregou, conferido no disco, para o visualizador da HQ: slides, Pin, vídeo e texto (nessa ordem), o texto
   *  exato a publicar (entrega.json) e os caminhos de mídia citados que não existem. Só arquivos dentro da pasta de conteúdo. */
  itemFiles(id: string, folderOverride?: string | null): ContentItemFiles {
    const item = this.cdb.getItem(id);
    if (!item) throw new Error('peça não encontrada');
    const root = this.folder();
    const pick = folderOverride ?? item.folder;
    const folder = pick && fs.existsSync(pick) ? pick : null;
    const within = (p: string) => [root, folder].some(r => r && isInside(r, p));
    const found = new Map<string, string>(); const missing = new Set<string>();
    const add = (abs: string) => { const p = path.normalize(abs); if (!found.has(p.toLowerCase()) && within(p) && isFile(p)) found.set(p.toLowerCase(), p); };
    /** Caminho citado (absoluto, relativo à pasta da peça ou à pasta de conteúdo): entra se existir. Só o que a entrega LISTA e
     *  não existe vai para "faltando"; citação no texto que não resolve (abreviação como ".../02.png") é ignorada. */
    const cite = (raw: string, listed = false) => {
      const r = raw.trim().replace(/^\.[\\/]/, '');
      if (!r || /^https?:/i.test(r)) return;
      const tries = path.isAbsolute(r) ? [r] : [folder ? path.join(folder, r) : null, root ? path.join(root, r) : null].filter((x): x is string => Boolean(x));
      const hit = tries.find(t => within(path.normalize(t)) && isFile(t));
      if (hit) add(hit);
      else if (listed && tries.length) { const t = path.normalize(tries[tries.length - 1]); if (!fs.existsSync(t)) missing.add(t); }
    };
    let e: Entrega | null = null;
    if (folder) {
      const j = this.readJson(path.join(folder, 'entrega.json'));
      const parsed = j.ok ? parseEntrega(j.value) : null;
      e = parsed?.ok ? parsed.value : null;
      const slides = path.join(folder, 'slides');
      if (fs.existsSync(slides)) for (const f of fs.readdirSync(slides).filter(n => /^\d{2}\.png$/i.test(n)).sort()) add(path.join(slides, f));
      for (const f of e?.files ?? []) if (!/\.(json|html?)$/i.test(f)) cite(f, true);
      const texts = [e?.text ?? '', e?.nextStep ?? '', ...(e?.needs ?? []), safeRead(path.join(folder, 'peca.md'))];
      for (const t of texts) for (const m of t.matchAll(/`([^`\n]+\.[a-z0-9]{2,5})`/gi)) if (MEDIA_EXT.test(m[1])) cite(m[1]);
      for (const f of fs.readdirSync(folder, { withFileTypes: true })) if (f.isFile() && !/\.(json|html?)$/i.test(f.name)) add(path.join(folder, f.name));
    }
    for (const f of item.files) if (MEDIA_EXT.test(f) && !/\s/.test(f.trim())) cite(f);
    if (item.deliverable) add(item.deliverable);
    const rank = (p: string) => {
      const n = path.basename(p).toLowerCase(); const k = viewKind(p);
      if (/[\\/]slides[\\/]\d{2}\.png$/i.test(p)) return 0;
      if (n === 'pin.png') return 1;
      if (k === 'video') return /legendad|com-audio/i.test(n) ? 2 : 3;
      if (n === 'peca.md') return 4;
      if (k === 'image') return 5;
      if (n === 'revisao.md') return 7;
      return 6;
    };
    const files = [...found.values()].map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(({ p }) => ({ path: p, name: path.basename(p).toLowerCase() === 'video-com-audio.mp4' ? 'vídeo com o áudio da referência.mp4' : path.basename(p), kind: viewKind(p), size: fs.statSync(p).size }));
    // Versões anteriores do vídeo (renderizar de novo, refação): no fim da lista, com a data no nome.
    const vdir = folder ? path.join(folder, 'versoes') : null;
    if (vdir && fs.existsSync(vdir)) for (const s of fs.readdirSync(vdir).sort().reverse()) { const p = path.join(vdir, s, 'video.mp4'); if (isFile(p)) files.push({ path: p, name: `versão anterior ${s}.mp4`, kind: 'video', size: fs.statSync(p).size }); }
    return { itemId: item.id, files, text: e?.text ?? null, title: e?.title ?? null, description: e?.description ?? null, missing: [...missing].filter(m => !found.has(m.toLowerCase())) };
  }

  /** O que o formato exige e o que existe no disco. Texto: o texto final do post. Carrossel: imagens exportadas (descrição de
   *  slides não substitui). Pin: pin.png. Reels/TikTok em vídeo: um arquivo de vídeo (roteiro não substitui). Arquivo listado
   *  na entrega que não existe também falta. */
  deliveryCheck(item: ContentItem, e: Entrega | null): { required: string; have: string[]; missing: string[] } {
    const network = item.slot ? slotDef(item.slot).network : e?.network ?? null;
    const required = requiredDelivery(item.format, network);
    const have: string[] = []; const missing: string[] = [];
    if (!e) return { required, have, missing: ['entrega.json válido com o texto do post'] };
    if (e.text.trim()) have.push('texto do post'); else missing.push('texto do post');
    // Listado na entrega e existente (caminho relativo à pasta da peça ou à pasta de conteúdo), ou gerado na própria pasta.
    const root = this.folder();
    const resolve = (f: string) => (path.isAbsolute(f) ? [f] : [item.folder ? path.join(item.folder, f) : null, root ? path.join(root, f) : null]).filter((x): x is string => Boolean(x)).find(x => isFile(x)) ?? null;
    const listed = (e.files ?? []).map(resolve).filter((x): x is string => Boolean(x));
    const own = item.folder && fs.existsSync(item.folder) ? fs.readdirSync(item.folder).map(n => path.join(item.folder!, n)).filter(isFile) : [];
    if (required === 'imagens do carrossel') {
      const sdir = item.folder ? path.join(item.folder, 'slides') : null;
      const slides = sdir && fs.existsSync(sdir) ? fs.readdirSync(sdir).filter(n => /^\d{2}\.png$/i.test(n)) : [];
      const imgs = listed.filter(f => viewKind(f) === 'image');
      const n = Math.max(slides.length, imgs.length);
      if (n >= 2) have.push(`${n} imagens exportadas${slides.length >= imgs.length ? '' : ' (listadas na entrega)'}`); else missing.push('as imagens exportadas do carrossel (slides/01.png… ou listadas na entrega); descrição de slides não substitui');
    } else if (required === 'Pin') {
      if (item.folder && fs.existsSync(path.join(item.folder, 'pin.png'))) have.push('pin.png'); else missing.push('pin.png renderizado');
    } else if (required === 'vídeo') {
      const v = [...listed, ...own].filter(f => viewKind(f) === 'video');
      if (v.length) have.push(path.basename(v[0])); else missing.push('o arquivo de vídeo pronto (mp4) listado na entrega; roteiro ou vídeo bruto citado não substitui o vídeo editado');
      // Vídeo feito pela HQ (video.json): o MP4 precisa abrir no formato planejado, ter capa e áudio final.
      const rep = item.folder ? (() => { try { return JSON.parse(fs.readFileSync(path.join(item.folder, 'video-conferencia.json'), 'utf8')) as { ok?: boolean; error?: string | null; plan?: { audio?: { provisorio?: boolean; observacao?: string | null } }; cover?: string | null }; } catch { return null; } })() : null;
      if (rep) {
        if (rep.ok === false) missing.push(`vídeo que abre no formato planejado (${rep.error ?? 'render ou conferência falhou'})`);
        // Áudio "provisório" porque é o áudio do link que o Chefe mandou ("pode ser esse áudio"): a HQ já fez o
        // video-com-audio.mp4, então não falta nada; publicar com o som de terceiros é decisão dele na aprovação (05/11).
        const mixed = Boolean(item.folder && isFile(path.join(item.folder, 'audio-referencia.json')) && isFile(path.join(item.folder, 'video-com-audio.mp4')));
        if (mixed) have.push('video-com-audio.mp4 (com o áudio que você escolheu)');
        else if (rep.plan?.audio?.provisorio) missing.push(`áudio final (o atual é provisório${rep.plan.audio.observacao ? `: ${rep.plan.audio.observacao}` : ''})`);
        if (rep.ok !== false && !rep.cover) missing.push('capa do Reel (capa.png)');
        else if (rep.cover) have.push('capa.png');
      }
    }
    for (const f of e.files ?? []) {
      if (/\.(json|html?)$/i.test(f)) continue;
      const tries = path.isAbsolute(f) ? [f] : [item.folder ? path.join(item.folder, f) : null, this.folder() ? path.join(this.folder()!, f) : null].filter((x): x is string => Boolean(x));
      if (!tries.some(t => fs.existsSync(t))) missing.push(`${f} (listado na entrega, não existe)`);
    }
    return { required, have, missing };
  }

  /** Para o trabalho ligado à peça: tarefa na fila é cancelada; a que roda é interrompida. Devolve as tarefas paradas. */
  private async stopItemWork(item: ContentItem, why: string): Promise<string[]> {
    const stopped: string[] = [];
    for (const id of [item.taskId, item.reviewTaskId]) {
      if (!id) continue;
      const t = this.follow(id);
      if (!t || !OPEN.includes(t.status)) continue;
      if (t.status === 'queued') { this.deps.manager.cancelQueued?.(t.id); stopped.push(t.id); }
      else if (this.deps.manager.interrupt) { try { await this.deps.manager.interrupt(t.sessionId); stopped.push(t.id); } catch (err) { this.deps.log.warn(`conteúdo: não consegui interromper a tarefa ${t.id.slice(0, 8)} (${why})`, err); } }
    }
    if (stopped.length) this.deps.log.info(`conteúdo: ${stopped.length} tarefa(s) de "${item.title}" parada(s) (${why})`);
    return stopped;
  }

  /** Lixeira: primeiro marca (evento atrasado não ressuscita), depois cancela a fila e interrompe a execução atual. */
  private async trashItems(ids: string[]): Promise<ContentState & { trashed: string[]; cancelled: string[] }> {
    const trashed: string[] = []; const cancelled: string[] = [];
    for (const id of [...new Set(ids)]) {
      const item = this.cdb.getItem(id); if (!item || item.deletedAt) continue;
      if (item.status === 'publicada') throw new Error(`"${item.title}" já foi publicada: o registro fica (a HQ não apaga post das redes).`);
      const running = item.status === 'em_producao';
      const reviewing = Boolean(item.reviewTaskId && !item.review);
      this.cdb.trashItem(id, this.now(), running ? 'planejada' : item.status, { action: 'lixeira', detail: running ? 'produção cancelada ao mover para a lixeira' : reviewing ? 'revisão cancelada ao mover para a lixeira' : null, origin: 'interface' });
      const stopped = await this.stopItemWork(item, 'movida para a lixeira');
      cancelled.push(...stopped);
      if (running || reviewing) this.cdb.updateItem(id, { nextStep: running ? 'produção cancelada ao mover para a lixeira; ao restaurar, produza de novo quando quiser' : 'revisão cancelada ao mover para a lixeira; peça a revisão de novo se quiser', ...(reviewing ? { reviewTaskId: null } : {}) });
      trashed.push(id);
      this.deps.audit?.({ action: 'lixeira', entity: 'peça de conteúdo', entityId: id, title: item.title, origin: 'interface', detail: stopped.length ? `${stopped.length} tarefa(s) cancelada(s)` : 'arquivos preservados; nada removido das redes' });
    }
    this.push();
    return { ...this.state(), trashed, cancelled };
  }

  /** Restaurar: volta para o mural com o estado que tinha (produção cancelada fica "planejada"); nada recomeça sozinho. */
  private restoreItems(ids: string[]): ContentState & { restored: string[] } {
    const restored: string[] = [];
    for (const id of [...new Set(ids)]) {
      const item = this.cdb.getItem(id); if (!item || !item.deletedAt) continue;
      this.cdb.restoreItem(id, this.now(), item.status, item.nextStep, { action: 'restaurada', detail: 'restaurada da lixeira; nada foi reiniciado', origin: 'interface' });
      restored.push(id);
      this.deps.audit?.({ action: 'restaurar', entity: 'peça de conteúdo', entityId: id, title: item.title, origin: 'interface', detail: null });
    }
    this.push();
    return { ...this.state(), restored };
  }

  private archiveItems(ids: string[], archived: boolean): ContentState {
    for (const id of [...new Set(ids)]) {
      const item = this.cdb.getItem(id); if (!item || item.deletedAt) continue;
      if (archived && item.status === 'em_producao') throw new Error(`"${item.title}" está em produção: espere terminar ou mova para a lixeira (cancela a tarefa).`);
      if (Boolean(item.archivedAt) === archived) continue;
      this.cdb.updateItem(id, { archivedAt: archived ? this.now() : null }, { action: archived ? 'arquivada' : 'desarquivada', origin: 'interface' });
      this.deps.audit?.({ action: archived ? 'arquivar' : 'desarquivar', entity: 'peça de conteúdo', entityId: id, title: item.title, origin: 'interface', detail: null });
    }
    this.push();
    return this.state();
  }

  /** Conferência dos registros: cada peça contra o que o formato exige; apply grava a correção com histórico. */
  private verifyItems(ids: string[] | null, apply: boolean): ContentState & { rows: ContentVerifyRow[] } {
    const rows: ContentVerifyRow[] = [];
    const pool = this.cdb.listItems(500).filter(i => (!ids || ids.includes(i.id)) && ['revisar', 'ajustar', 'parcial', 'aprovada'].includes(i.status));
    for (const item of pool) {
      const e = this.entrega(item);
      const need = this.deliveryCheck(item, e);
      let to = item.status;
      if (need.missing.length && (item.status === 'revisar' || item.status === 'ajustar' || item.status === 'aprovada')) to = 'parcial';
      else if (!need.missing.length && item.status === 'parcial') to = 'revisar';
      const reason = need.missing.length ? `${need.required}: falta ${need.missing.join('; ')}` : `${need.required}: completo (${need.have.join(', ')})`;
      rows.push({ id: item.id, title: item.title, slot: item.slot, from: item.status, to, have: need.have, missing: need.missing, reason });
      if (apply && to !== item.status) {
        this.cdb.updateItem(item.id, { status: to, nextStep: to === 'parcial' ? `entrega parcial: falta ${need.missing.join('; ')}` : 'entrega completa conferida: falta a sua revisão', ...(to === 'parcial' ? { approvalId: null } : {}) }, { action: 'conferência da entrega', detail: reason, origin: 'conferência (sessão a pedido do Chefe)' });
        this.deps.audit?.({ action: 'corrigir estado', entity: 'peça de conteúdo', entityId: item.id, title: item.title, origin: 'conferência', detail: `${item.status} → ${to}: ${reason}` });
      }
    }
    if (apply) this.push();
    return { ...this.state(), rows };
  }

  /** Cartão de tarefa avulsa ou de entrega de reunião: arquivar, lixeira (cancela a tarefa ligada se estiver na fila ou rodando) ou mostrar de novo. */
  private async setHidden(key: string, kind: 'task' | 'delivery', state: 'arquivada' | 'lixeira' | null, title: string | null, cancelTaskId: string | null): Promise<ContentState & { cancelled: string[] }> {
    if (!/^(task|desk):[A-Za-z0-9-]{8,80}$/.test(key)) throw new Error('cartão inválido');
    const cancelled: string[] = [];
    if (state === null) this.cdb.clearHidden(key);
    else {
      this.cdb.setHidden({ key, kind, state, at: this.now(), title: txt(title, 200) });
      if (state === 'lixeira' && cancelTaskId) {
        const t = this.follow(cancelTaskId);
        if (t && OPEN.includes(t.status)) {
          if (t.status === 'queued') { this.deps.manager.cancelQueued?.(t.id); cancelled.push(t.id); }
          else if (this.deps.manager.interrupt) { await this.deps.manager.interrupt(t.sessionId); cancelled.push(t.id); }
        }
      }
    }
    this.deps.audit?.({ action: state === null ? 'mostrar de novo' : state === 'lixeira' ? 'lixeira' : 'arquivar', entity: kind === 'task' ? 'cartão de tarefa' : 'entrega da mesa', entityId: key, title, origin: 'interface', detail: cancelled.length ? `${cancelled.length} tarefa(s) cancelada(s)` : 'tarefa, conversa e arquivos preservados' });
    this.push();
    return { ...this.state(), cancelled };
  }

  /** Pedido do dia: uma publicação principal por conta. Liga as peças daquela data, cria as que vieram descritas e, com produção
   *  autorizada, manda para a fila; conta sem peça espera a pesquisa (Radar), que a preenche quando terminar. */
  private async createRequest(msg: Extract<ContentClientMessage, { type: 'content.request.create' }>): Promise<ContentState & { requestId: string; produced: number; waiting: SocialSlotId[]; skipped: string[] }> {
    if (!isDate(msg.date)) throw new Error('Data do pedido inválida (AAAA-MM-DD).');
    const slots = [...new Set((msg.slots ?? []).filter(s => isSocialSlot(s)))] as SocialSlotId[];
    if (!slots.length) throw new Error('Escolha as contas do pedido.');
    const day = msg.date.split('-').reverse().slice(0, 2).join('/');
    const req = this.cdb.insertRequest({ title: txt(msg.title, 200) ?? `Conteúdo de ${day}`, date: msg.date, slots, note: txt(msg.note, 2000), origin: 'interface', autoProduce: msg.autoProduce !== false, status: 'ativo' });
    const link = (id: string) => { const it = this.cdb.getItem(id); if (it && !it.deletedAt && !it.requestId) this.cdb.updateItem(id, { requestId: req.id }, { action: 'ligada ao pedido', detail: req.title, origin: 'interface' }); };
    for (const id of msg.itemIds ?? []) link(id);
    for (const pc of msg.pieces ?? []) {
      if (!isSocialSlot(pc.slot) || !txt(pc.title, 200)) continue;
      this.createItem({ ...pc, date: isDate(pc.date) ? pc.date : msg.date });
      const created = this.cdb.listItems(500).filter(i => i.title === txt(pc.title, 200) && i.slot === pc.slot && !i.requestId).pop();
      if (created) link(created.id);
    }
    // Peças daquela data já existentes (uma por conta), sem pedido: entram no pedido.
    for (const s of slots) if (!this.cdb.itemsOfRequest(req.id).some(i => i.slot === s)) {
      const it = this.cdb.listItems(500).find(i => i.date === msg.date && i.slot === s && !i.requestId && !i.archivedAt && i.status !== 'descartada');
      if (it) link(it.id);
    }
    const skipped: string[] = []; let produced = 0;
    if (req.autoProduce) for (const it of this.cdb.itemsOfRequest(req.id)) {
      if (!['planejada', 'falhou'].includes(it.status)) continue;
      if (it.material === 'gravar' || it.material === 'editar') { skipped.push(`"${it.title}": precisa ${it.material === 'gravar' ? 'gravar' : 'editar'} o material`); continue; }
      try { await this.produce(it.id, null); produced++; } catch (err) { skipped.push(`"${it.title}": ${(err as Error).message}`); }
    }
    // Destino pausado pelo foco não recebe tarefa: fica no pedido como "pausado", sem pesquisa encaminhando produção para ele.
    const waiting = slots.filter(s => this.active(s) && !this.cdb.itemsOfRequest(req.id).some(i => i.slot === s));
    if (req.autoProduce && waiting.length) await this.fillRequestsFromRadar(null);
    const still = slots.filter(s => this.active(s) && !this.cdb.itemsOfRequest(req.id).some(i => i.slot === s));
    for (const s of slots.filter(x => !this.active(x))) skipped.push(`${slotDef(s).label}: destino pausado (${this.focus().reason})`);
    if (req.autoProduce && still.length && !this.cdb.openRounds().some(r => r.kind === 'radar')) {
      try { await this.startRadar(`Pedido "${req.title}": falta pauta para ${still.map(s => slotDef(s).label).join(', ')}. A produção dessas contas sai do que esta pesquisa encontrar.`); }
      catch (err) { skipped.push(`pesquisa para ${still.join(', ')} não começou: ${(err as Error).message}`); }
    }
    this.deps.log.info(`conteúdo: pedido "${req.title}" (${slots.length} conta(s)): ${produced} para a produção${still.length ? `, esperando pesquisa: ${still.join(', ')}` : ''}${skipped.length ? `; fora: ${skipped.join('; ')}` : ''}`);
    this.deps.audit?.({ action: 'pedido', entity: 'conteúdo', entityId: req.id, title: req.title, origin: 'interface', detail: `contas: ${slots.join(', ')}; produzidas: ${produced}${still.length ? `; esperando pesquisa: ${still.join(', ')}` : ''}` });
    this.push();
    return { ...this.state(), requestId: req.id, produced, waiting: still, skipped };
  }

  // ------------------------------------------------------------------ gerente e linha de produção (08/11)
  private dmHandled = new Set<string>();
  /** Conversa particular: quando o funcionário devolve um bloco ```pedido-hq, o pedido do Chefe vai para a gerente planejar. */
  private async dmRequest(taskId: string): Promise<void> {
    if (this.dmHandled.has(taskId)) return;
    const t = this.deps.store.getTask(taskId); if (!t || t.status !== 'done' || !t.resultText) return;
    const sess = this.deps.store.getSession(t.sessionId); if (!isDmSession(sess)) return;
    const m = /```pedido-hq\s*([\s\S]*?)```/.exec(t.resultText); if (!m) return;
    this.dmHandled.add(taskId);
    let pedido: string | null = null;
    try { const j = JSON.parse(m[1].trim()) as { pedido?: unknown }; pedido = typeof j.pedido === 'string' ? j.pedido.trim() : null; } catch { pedido = m[1].trim().slice(0, 2000) || null; }
    if (!pedido) return;
    const who = t.employeeId ? this.deps.store.getEmployee(t.employeeId)?.name ?? 'funcionário' : 'funcionário';
    try {
      const r = await this.askManager(`${pedido}\n\n(Pedido feito na conversa particular do Chefe com ${who}.)`);
      this.deps.log.info(`conteúdo: pedido da conversa com ${who} foi para a gerente (pedido ${r.requestId})`);
    } catch (err) { this.deps.log.warn(`conteúdo: pedido da conversa com ${who} não foi para a gerente (${(err as Error).message})`); }
  }

  /** Pedido em texto livre do Chefe: a gerente da sala planeja (plano.json) e a HQ cria as peças com as etapas e toca a produção. */
  private async askManager(textArg: string, teamsArg?: ('aurora' | 'tuco-dev')[]): Promise<ContentState & { requestId: string }> {
    const text = String(textArg ?? '').trim();
    if (text.length < 3) throw new Error('Escreva o que a equipe deve preparar (uma frase basta).');
    const { folder, projectId, employee } = this.requireReady('coordenador');
    const teams = (teamsArg ?? []).filter(isTeamId);
    // Equipes escolhidas no pedido: só as contas delas entram no plano (pedido para "as duas" vira peças separadas por equipe).
    const active = (this.focus().activeSlots ?? []).filter(sl => this.active(sl) && (!teams.length || teams.includes(teamOfSlot(sl) as TeamId)));
    if (!active.length) throw new Error(teams.length ? `Nenhuma conta ativa no foco para ${teams.map(t => teamDef(t).label).join(' e ')}: inclua uma em Conteúdo → Foco.` : 'Nenhum destino ativo no foco: escolha pelo menos uma conta em Conteúdo → Foco.');
    const now = this.now(); const today = brtDate(now); const tomorrow = brtDate(now + DAY);
    const stamp = new Date(now).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16).replace(' ', '-').replace(':', '');
    const dir = path.join(folder, 'planos', `${stamp}-${slugify(text.slice(0, 50)) || 'pedido'}`);
    fs.mkdirSync(dir, { recursive: true });
    const outputPath = path.join(dir, 'plano.json');
    fs.writeFileSync(path.join(dir, 'pedido.md'), `# Pedido do Chefe\n\n${text}\n\nRecebido em ${new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.\n`, 'utf8');
    const round = this.cdb.createRound({ kind: 'plano', taskId: null, routineId: null, employeeId: employee.id, status: 'aguardando', startedAt: now, outputPath, weekStart: null, origin: 'tela' });
    const req = this.cdb.insertRequest({ title: text.replace(/\s+/g, ' ').slice(0, 90), date: tomorrow, slots: active, note: text.slice(0, 2000), origin: 'gerente', autoProduce: true, status: 'ativo',
      plan: { status: 'planejando', summary: null, file: outputPath, managerId: employee.id, managerName: employee.name, roundId: round.id, itemIds: [], questions: [], left: [], error: null, at: now } });
    const open = this.cdb.listItems(300).filter(i => !i.deletedAt && !i.archivedAt && ['planejada', 'em_producao', 'parcial', 'revisar', 'ajustar', 'aprovada'].includes(i.status)).slice(0, 15)
      .map(i => `${i.title} (${i.slot ?? 'sem conta'}, ${CONTENT_ITEM_STATUS_LABEL[i.status]})`);
    const radar = this.cdb.listRadar(80).filter(r => r.status === 'nova' && this.now() - r.createdAt < 7 * DAY).slice(0, 8)
      .map(r => `id ${r.id}: ${r.subject.slice(0, 120)}${r.slot ? ` (${r.slot})` : ''}${r.proposal ? `: ${r.proposal.slice(0, 160)}` : ''}`);
    const team = this.contentStaff().map(e => ({ name: e.name, role: e.role }));
    const prompt = planPrompt({
      text, now: new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), today, tomorrow, outputPath,
      slots: active.map(sl => ({ id: sl, label: slotDef(sl).label, formats: quickFormatsFor(sl), objective: this.cdb.listDestinations().find(d => d.slot === sl)?.objective ?? null })),
      team, open, radar, academy: this.academyIndexExists(),
      teams: (teams.length ? teams : [...new Set(active.map(sl => teamOfSlot(sl)).filter((t): t is TeamId => Boolean(t)))]).map(t => ({ label: teamDef(t).label, channels: teamDef(t).slots.filter(sl => active.includes(sl)).map(sl => CHANNEL_LABEL[sl] ?? sl), focus: teamDef(t).focus })),
    });
    await this.run(round, { text: prompt, projectId, employeeId: employee.id, skill: null });
    this.deps.audit?.({ action: 'pedido à gerente', entity: 'conteúdo', entityId: req.id, title: req.title, origin: 'interface', detail: `${employee.name} planeja; contas ativas: ${active.join(', ')}` });
    this.push();
    return { ...this.state(), requestId: req.id };
  }

  private async importPlan(round: ContentRound, o: Record<string, unknown>): Promise<void> {
    const req = this.cdb.listRequests(60).find(r => r.plan?.roundId === round.id);
    if (!req?.plan) { this.cdb.updateRound(round.id, { status: 'falhou', finishedAt: this.now(), error: 'pedido do plano não encontrado' }); return; }
    const now = this.now();
    const active = (this.focus().activeSlots ?? []).filter(sl => this.active(sl));
    const parsed = parsePlan(o, { activeSlots: active, today: brtDate(now), tomorrow: brtDate(now + DAY), formatsFor: quickFormatsFor });
    if (!parsed.ok) { this.failRound(round, parsed.error); return; }
    const pl = parsed.value; const itemIds: string[] = []; const left = [...pl.left];
    for (const pc of pl.pieces) {
      try {
        const def = slotDef(pc.slot); const fmt = quickFormatName(pc.format, pc.slot);
        const keys = stepsFor(pc.format, pc.research);
        const item = this.cdb.insertItem({
          weekStart: null, baseId: null, baseTitle: null, date: pc.date, time: null, slot: pc.slot, profileId: def.defaultProfileIds[0] ?? null,
          format: fmt, objective: pc.objective || (this.cdb.listDestinations().find(d => d.slot === pc.slot)?.objective ?? ''), title: pc.title, brief: planBrief(pc, req.note ?? req.title),
          sources: pc.refs.filter(r => /^https?:\/\//.test(r)).slice(0, 10), files: [], material: pc.material, ownerId: this.producerFor(pc.slot, fmt)?.id ?? null, skill: this.skillFor(pc.slot),
          reviewCriteria: [pc.metric ? `métrica: ${pc.metric}` : '', 'gancho que prende no começo; fatos com fonte; identidade da marca; arquivo final pronto (vídeo renderizado, slides ou texto)'].filter(Boolean).join('; '),
          status: 'planejada', taskId: null, reviewTaskId: null, radarId: null, folder: null, deliverable: null, checks: [], review: null, nextStep: keys.length ? `etapas: ${keys.map(k => PIECE_STEP_LABEL[k]).join(' → ')} → produção → revisão → sua aprovação` : 'produção → revisão → sua aprovação', approvalId: null, publication: null,
          requestId: req.id, hypothesis: pc.hypothesis, referenceIds: pc.refs.filter(r => this.cdb.getRadar(r)).slice(0, 8), pipeline: keys.length ? { steps: newSteps(keys), createdAt: now } : null,
        }, { action: `plano de ${req.plan.managerName ?? 'gerente'}`, detail: req.title, origin: 'gerente' });
        itemIds.push(item.id);
      } catch (err) { left.push(`"${pc.title}": ${(err as Error).message}`); }
    }
    const dates = this.cdb.itemsOfRequest(req.id).map(i => i.date).filter((d): d is string => Boolean(d)).sort();
    this.cdb.updateRequest(req.id, { date: dates[0] ?? req.date, slots: [...new Set(pl.pieces.map(p => p.slot))].length ? [...new Set(pl.pieces.map(p => p.slot))] : req.slots,
      plan: { ...req.plan, status: 'pronto', summary: pl.summary, itemIds, questions: pl.questions, left: [...left, ...pl.warnings], error: null, at: now } });
    this.cdb.updateRound(round.id, { status: itemIds.length ? 'concluida' : 'vazia', finishedAt: now, summary: pl.summary.slice(0, 600) });
    this.deps.log.info(`conteúdo: plano de ${req.plan.managerName}: ${itemIds.length} peça(s)${left.length ? `; fora: ${left.join('; ')}` : ''}`);
    // A linha de produção começa sozinha: cada peça vai para a primeira etapa (ou para a produção, se não tiver etapa).
    for (const id of itemIds) {
      try { await this.produce(id, null); }
      catch (err) { this.cdb.updateItem(id, { nextStep: `não começou: ${(err as Error).message}` }); }
    }
  }

  private itemByStepRound(roundId: string): { item: ContentItem; index: number; step: PieceStep } | null {
    for (const item of this.cdb.listItems(800)) {
      const index = item.pipeline?.steps.findIndex(st => st.roundId === roundId) ?? -1;
      if (index >= 0) return { item, index, step: item.pipeline!.steps[index] };
    }
    return null;
  }

  private setStep(itemId: string, index: number, p: Partial<PieceStep>): void {
    const item = this.cdb.getItem(itemId); if (!item?.pipeline) return;
    const steps = item.pipeline.steps.map((st, k) => (k === index ? { ...st, ...p } : st));
    this.cdb.updateItem(itemId, { pipeline: { ...item.pipeline, steps } });
  }

  private stepEmployee(key: PieceStepKey, item: ContentItem): Employee | null {
    if (key === 'pesquisa') return this.teamMember('pesquisador');
    if (key === 'direcao') { this.ensureDirector(); return this.teamMember('direcao'); }
    return this.teamMember('criador', this.squadOf(item.slot)) ?? this.teamMember('criador');
  }

  /** Próxima etapa da peça: começa a primeira pendente; sem pendente (todas feitas), vai para a produção final. */
  private async advancePipeline(id: string): Promise<void> {
    const item = this.cdb.getItem(id); if (!item?.pipeline) return;
    if (item.deletedAt || item.archivedAt || item.pausedReason || !this.active(item.slot)) return;
    if (item.pipeline.steps.some(st => st.status === 'fazendo')) return;
    const index = item.pipeline.steps.findIndex(st => st.status === 'pendente');
    if (index < 0) {
      if (item.pipeline.steps.some(st => st.status === 'falhou')) return; // espera o "Tentar a etapa de novo"
      if (item.status === 'planejada' || item.status === 'falhou') await this.produce(id, null);
      return;
    }
    const step = item.pipeline.steps[index];
    const { folder, projectId } = this.requireReady('criador');
    const emp = this.stepEmployee(step.key, item);
    if (!emp) { this.setStep(id, index, { status: 'falhou', error: `ninguém na sala faz ${PIECE_STEP_LABEL[step.key].toLowerCase()}` }); return; }
    const dir = this.pieceFolder(item, folder);
    const outputPath = path.join(dir, 'etapas', `${step.key}.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    try { fs.rmSync(outputPath, { force: true }); } catch { /* sobra de tentativa anterior */ }
    const prev = item.pipeline.steps.slice(0, index).filter(st => st.status === 'feito').map(st => ({ key: st.key, file: path.join(dir, PIECE_STEP_FILE[st.key]), who: st.employeeName }));
    const round = this.cdb.createRound({ kind: 'etapa', taskId: null, routineId: null, employeeId: emp.id, status: 'aguardando', startedAt: this.now(), outputPath, weekStart: null, origin: 'tela' });
    this.cdb.updateItem(id, { folder: dir, nextStep: `${PIECE_STEP_LABEL[step.key]} com ${emp.name} (etapa ${index + 1} de ${item.pipeline.steps.length} antes da produção)` });
    this.setStep(id, index, { status: 'fazendo', roundId: round.id, employeeId: emp.id, employeeName: emp.name, error: null, startedAt: this.now(), doneAt: null });
    const text = stepPrompt({ key: step.key, item: { ...item, folder: dir }, slotLabel: item.slot ? slotDef(item.slot).label : 'sem conta', dir, outputPath, prev });
    const skill = step.key === 'direcao' ? 'video-analyze' : step.key === 'pesquisa' ? null : item.skill;
    try { await this.run(round, { text, projectId, employeeId: emp.id, skill: step.key === 'direcao' ? null : skill }); }
    catch (err) { this.setStep(id, index, { status: 'falhou', error: `a tarefa não foi criada: ${(err as Error).message}` }); }
    this.push();
  }

  private async importStep(round: ContentRound, o: Record<string, unknown>): Promise<void> {
    const hit = this.itemByStepRound(round.id);
    if (!hit) { this.cdb.updateRound(round.id, { status: 'falhou', finishedAt: this.now(), error: 'peça da etapa não encontrada' }); return; }
    const { item, index, step } = hit;
    const dir = item.folder ?? path.dirname(path.dirname(round.outputPath));
    const main = path.join(dir, PIECE_STEP_FILE[step.key]);
    const size = isFile(main) ? fs.statSync(main).size : 0;
    if (size < 300) { this.failRound(round, `${PIECE_STEP_FILE[step.key]} ${size ? 'curto demais' : 'não foi gravado'} na pasta da peça`); return; }
    const summary = typeof o.resumo === 'string' ? o.resumo.slice(0, 600) : null;
    const pend = Array.isArray(o.pendencias) ? o.pendencias.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 5) : [];
    this.cdb.updateRound(round.id, { status: 'concluida', finishedAt: this.now(), summary });
    this.setStep(item.id, index, { status: 'feito', files: [main], summary: [summary, pend.length ? `pendências: ${pend.join('; ')}` : ''].filter(Boolean).join(' · ') || null, error: null, doneAt: this.now() });
    this.cdb.updateItem(item.id, { files: [...new Set([...item.files, main])] }, { action: `${PIECE_STEP_LABEL[step.key].toLowerCase()} pronta`, detail: `${step.employeeName ?? 'equipe'}: ${summary ?? PIECE_STEP_FILE[step.key]}`, origin: 'sistema' });
    await this.advancePipeline(item.id);
  }

  private async retryStep(id: string): Promise<ContentState> {
    const item = this.cdb.getItem(id); if (!item?.pipeline) throw new Error('Esta peça não tem etapas.');
    const index = item.pipeline.steps.findIndex(st => st.status === 'falhou');
    if (index < 0) throw new Error('Nenhuma etapa falhou nesta peça.');
    this.setStep(id, index, { status: 'pendente', error: null, roundId: null });
    await this.advancePipeline(id);
    this.push();
    return this.state();
  }

  /** Pesquisa concluída encaminha a produção já autorizada: cada conta sem peça num pedido ativo recebe a oportunidade de maior
   *  prioridade daquela conta (da rodada indicada ou das recentes) e vai para a fila. */
  private async fillRequestsFromRadar(roundId: string | null): Promise<void> {
    for (const req of this.cdb.listRequests(10).filter(r => r.status === 'ativo' && r.autoProduce)) {
      const have = new Set(this.cdb.itemsOfRequest(req.id).map(i => i.slot));
      for (const slot of req.slots.filter(s => !have.has(s) && this.active(s))) {
        const pool = this.cdb.listRadar(200).filter(r => r.status === 'nova' && r.slot === slot && (!roundId || r.roundId === roundId) && this.now() - r.createdAt < 7 * DAY)
          .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || b.createdAt - a.createdAt);
        const pick = pool[0]; if (!pick) continue;
        try {
          this.radarToItem(pick.id, slot);
          const it = this.cdb.getRadar(pick.id)?.itemId ? this.cdb.getItem(this.cdb.getRadar(pick.id)!.itemId!) : null;
          if (!it) continue;
          this.cdb.updateItem(it.id, { date: req.date, requestId: req.id }, { action: 'ligada ao pedido', detail: `${req.title} (da pesquisa)`, origin: 'sistema' });
          await this.produce(it.id, null);
          this.deps.log.info(`conteúdo: pesquisa concluída encaminhou "${it.title}" (${slot}) do pedido "${req.title}" para a produção`);
        } catch (err) { this.deps.log.warn(`conteúdo: pedido "${req.title}": a oportunidade de ${slot} não foi para a produção (${(err as Error).message})`); }
      }
    }
  }

  // ------------------------------------------------------------------ foco (destinos ativos × fontes de pesquisa)
  /** Grava o foco. Destino que sai: as peças dele pausam com o motivo (fila cancelada, execução interrompida, nada apagado;
   *  publicada e agendada ficam como estão). Destino que volta: as peças saem da pausa, sem produzir nada sozinhas. */
  async saveFocus(activeArg: SocialSlotId[], sourcesArg: { source: ResearchSource; enabled: boolean }[] | null, reasonArg: string | null): Promise<ContentState & { paused: string[]; resumed: string[]; cancelled: string[] }> {
    const activeSlots = [...new Set((activeArg ?? []).filter(s => isSocialSlot(s)))] as SocialSlotId[];
    if (!activeSlots.length) throw new Error('Escolha pelo menos um destino ativo.');
    const cur = this.focus();
    // Destinos mudaram sem motivo escrito: o motivo descreve o foco novo (antes ficava o texto antigo, "+ Threads", nas pausas).
    const same = cur.activeSlots && cur.activeSlots.length === activeSlots.length && activeSlots.every(s => cur.activeSlots!.includes(s));
    const reason = txt(reasonArg, 200) ?? (cur.activeSlots ? (same ? cur.reason : focusReasonFor(activeSlots)) : FOCUS_REASON_DEFAULT);
    const sources = cur.sources.map(s => { const n = sourcesArg?.find(x => x.source === s.source); return n ? { ...s, enabled: n.enabled !== false } : s; });
    const next: ContentFocus = { ...cur, activeSlots, reason, sources, updatedAt: this.now() };
    writeFocus(this.deps.db, next);
    const paused: string[] = []; const resumed: string[] = []; const cancelled: string[] = [];
    for (const item of this.cdb.listItems(800)) {
      const on = Boolean(item.slot && activeSlots.includes(item.slot));
      if (!on && item.slot && !item.pausedReason && PAUSABLE.includes(item.status)) {
        const running = item.status === 'em_producao';
        const stopped = await this.stopItemWork(item, 'destino pausado pelo foco');
        cancelled.push(...stopped);
        if (running) this.cdb.updateItem(item.id, { status: 'planejada', nextStep: `produção pausada pelo foco (${reason}); o que já foi gravado continua na pasta` }, { action: 'pausada', detail: reason, origin: 'foco' });
        else if (item.reviewTaskId && !item.review && stopped.length) this.cdb.updateItem(item.id, { reviewTaskId: null });
        this.cdb.setPaused(item.id, reason, { action: 'pausada', detail: `${reason}${stopped.length ? ` · ${stopped.length} tarefa(s) parada(s)` : ''}`, origin: 'foco' });
        paused.push(item.id);
      } else if (on && item.pausedReason) {
        this.cdb.setPaused(item.id, null, { action: 'retomada', detail: 'destino voltou ao foco; nada foi reiniciado', origin: 'foco' });
        resumed.push(item.id);
      }
    }
    // Tarefas soltas (sem peça) ainda na fila para um destino pausado também param.
    for (const t of this.deps.store.listTasksByStatus(['queued'])) {
      if (t.destinationId && isSocialSlot(t.destinationId) && !activeSlots.includes(t.destinationId) && !this.cdb.itemByTask(t.id) && !this.cdb.itemByReviewTask(t.id)) { this.deps.manager.cancelQueued?.(t.id); cancelled.push(t.id); }
    }
    this.refreshFiles();
    this.deps.audit?.({ action: 'foco', entity: 'sala de conteúdo', entityId: null, title: reason, origin: 'interface', detail: `ativos: ${activeSlots.join(', ')}; pausadas ${paused.length} peça(s), retomadas ${resumed.length}, ${cancelled.length} tarefa(s) parada(s); fontes: ${sources.filter(s => s.enabled).map(s => s.source).join(', ') || 'nenhuma'}` });
    this.deps.log.info(`conteúdo: foco gravado (${activeSlots.join(', ')}): ${paused.length} peça(s) pausada(s), ${resumed.length} retomada(s), ${cancelled.length} tarefa(s) parada(s)`);
    this.push();
    return { ...this.state(), paused, resumed, cancelled };
  }

  // ------------------------------------------------------------------ referências do Chefe ("Usar como referência")
  private async addReference(ref: ContentReferenceInput): Promise<ContentState & { radarId: string; roundId: string | null }> {
    const { folder, projectId, employee } = this.requireReady('pesquisador');
    const url = txt(ref.url, 800);
    if (url && !/^https?:\/\//i.test(url)) throw new Error('O link precisa começar com http:// ou https://.');
    const text = txt(ref.text, 4000);
    const files = Array.isArray(ref.files) ? ref.files : [];
    const paths = (Array.isArray(ref.paths) ? ref.paths : []).map(p => String(p)).filter(Boolean);
    if (!url && !text && !files.length && !paths.length) throw new Error('Envie uma imagem, um vídeo, um link ou um texto para usar como referência.');
    const slot = ref.slot && isSocialSlot(ref.slot) ? ref.slot : null;
    if (slot) this.requireActive(slot, 'Referência para este destino');
    // Mesmo post enviado de novo: atualiza a referência existente em vez de criar outra.
    const key = postKey(url);
    const dup = key ? this.cdb.radarByKey(key) : null;
    const stamp = new Date(this.now()).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16).replace(' ', '-').replace(':', '');
    const title = txt(ref.title, 160) ?? (text ? text.split('\n')[0].slice(0, 80) : files[0]?.name ?? (paths[0] ? path.basename(paths[0]) : url ?? 'referência'));
    // Referência de uma equipe (o canal tem dono) fica na pasta dela; sem canal, na entrada geral do Radar.
    const refRoot = slot && teamOfSlot(slot) ? path.join(folder, 'marcas', brandFolder(teamOfSlot(slot), slot), 'referencias') : path.join(folder, 'radar', 'entrada');
    let dir = path.join(refRoot, `${stamp}-${slugify(title).slice(0, 40) || 'referencia'}`); let k = 2;
    while (fs.existsSync(dir)) dir = `${path.join(refRoot, `${stamp}-${slugify(title).slice(0, 40) || 'referencia'}`)}-${k++}`;
    fs.mkdirSync(dir, { recursive: true });
    const saved: string[] = [];
    for (const f of files.slice(0, 6)) {
      if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|quicktime|webm))$/.test(f.mediaType)) throw new Error(`Formato não aceito: ${f.mediaType} (use PNG, JPEG, WebP, GIF, MP4, MOV ou WebM).`);
      const buf = Buffer.from(f.dataBase64, 'base64');
      if (!buf.length || buf.length > 40_000_000) throw new Error(`"${f.name}" está vazio ou passa de 40 MB.`);
      const name = path.basename(f.name).replace(/[^\w.\- ()À-ú]/g, '_').slice(0, 80) || 'arquivo';
      const dst = path.join(dir, name); fs.writeFileSync(dst, buf); saved.push(dst);
    }
    for (const p of paths.slice(0, 6)) {
      const abs = path.resolve(p);
      if (!isFile(abs)) throw new Error(`Arquivo não encontrado: ${p}`);
      if (!MEDIA_EXT.test(abs)) throw new Error(`Formato não aceito: ${path.basename(abs)}`);
      const dst = path.join(dir, path.basename(abs)); if (!fs.existsSync(dst)) fs.copyFileSync(abs, dst); saved.push(dst);
    }
    fs.writeFileSync(path.join(dir, 'referencia.json'), JSON.stringify({ url, texto: text, arquivos: saved.map(s => path.basename(s)), origem: paths.length ? paths : null, destino: slot, enviadaEm: new Date(this.now()).toISOString() }, null, 2), 'utf8');
    const outputPath = path.join(dir, 'analise.json');
    const round = this.cdb.createRound({ kind: 'referencia', taskId: null, routineId: null, employeeId: employee.id, status: 'aguardando', startedAt: this.now(), outputPath, weekStart: null, origin: 'referencia' });
    const inspected = saved.some(s => /\.(mp4|mov|webm)$/i.test(s)) ? 'video_parcial' : saved.length ? 'captura' : text ? 'texto' : null;
    const base = {
      roundId: round.id, sourceUrl: url ?? `chefe://${round.id}`, sourceName: url ? new URL(url).hostname : 'enviada pelo Chefe', author: null, publishedAt: null, consultedAt: new Date(this.now()).toISOString(),
      subject: title, signals: 'referência enviada pelo Chefe (sem métrica observada)', evidence: 'nao_verificado' as const, window: null, slot, interpretation: 'aguardando a análise do pesquisador', proposal: 'aguardando a análise do pesquisador',
      priority: null, reason: null, material: null, extraCost: null, kind: 'chefe' as const, postKey: key, files: saved, note: text, inspected: inspected as RadarItem['inspected'],
    };
    const radar = dup ? this.cdb.updateRadar(dup.id, { ...base, kind: 'chefe', files: [...new Set([...dup.files, ...saved])] })! : this.cdb.insertRadar({ ...base, status: 'analisando' });
    if (dup) this.cdb.setRadarStatus(dup.id, dup.status === 'virou_peca' ? 'virou_peca' : 'analisando');
    if (ref.analyze === false) { this.cdb.updateRound(round.id, { status: 'concluida', finishedAt: this.now(), summary: 'referência registrada sem análise (pedido do Chefe)' }); this.cdb.setRadarStatus(radar.id, 'nova'); this.push(); return { ...this.state(), radarId: radar.id, roundId: null }; }
    const active = (this.focus().activeSlots ?? SOCIAL_SLOTS.map(s => s.slot)) as SocialSlotId[];
    const text2 = referencePrompt({ outputPath, now: this.now(), dir, files: saved.map(s => this.rel(folder, s)), url, text, slot, active: active.map(s => ({ slot: s, label: slotDef(s).label })), radarId: radar.id });
    try {
      const res = await this.deps.manager.runTask({ reqId: 'content', clientId: `content:${round.id}`, text: text2, projectId, employeeId: employee.id, skill: 'milweb-video-studio', plan: false });
      this.cdb.updateRound(round.id, { taskId: res.taskId });
    } catch (err) {
      this.cdb.updateRound(round.id, { status: 'falhou', finishedAt: this.now(), error: `a tarefa não foi criada: ${(err as Error).message}` });
      this.push(); throw err;
    }
    this.deps.audit?.({ action: 'referência', entity: 'radar', entityId: radar.id, title, origin: 'interface', detail: `${saved.length} arquivo(s)${url ? `, link ${url}` : ''}${dup ? ' (atualizou referência existente)' : ''}` });
    this.push();
    return { ...this.state(), radarId: radar.id, roundId: round.id };
  }

  /** Análise do pesquisador sobre a referência do Chefe: atualiza a referência (sem perder o envio) e manda para a produção. */
  private async importReference(round: ContentRound, o: Record<string, unknown>): Promise<void> {
    const radar = this.cdb.listRadar(400).find(r => r.roundId === round.id || (r.kind === 'chefe' && r.status === 'analisando' && r.files.some(f => path.dirname(f).toLowerCase() === path.dirname(round.outputPath).toLowerCase())));
    if (!radar) { this.failRound(round, 'referência do Chefe não encontrada no Radar'); return; }
    const raw = (o.reference ?? o) as Record<string, unknown>;
    const parsed = parseOpportunity({ ...raw, kind: 'chefe', sourceUrl: radar.sourceUrl, consultedAt: txt(raw.consultedAt, 60) ?? new Date(this.now()).toISOString() }, { allowNoUrl: true });
    if (!parsed.ok) { this.failRound(round, `analise.json: ${parsed.error}`); return; }
    const v = parsed.value;
    const slot = v.slot && this.active(v.slot) ? v.slot : radar.slot && this.active(radar.slot) ? radar.slot : null;
    this.cdb.updateRadar(radar.id, { ...v, kind: 'chefe', sourceUrl: radar.sourceUrl, postKey: radar.postKey ?? v.postKey, files: [...new Set([...radar.files, ...v.files.map(f => path.isAbsolute(f) ? f : path.join(path.dirname(round.outputPath), f))])].filter(f => isFile(f)), note: radar.note, slot, priority: v.priority ?? 1, roundId: radar.roundId }, false);
    this.cdb.setRadarStatus(radar.id, radar.itemId ? 'virou_peca' : 'nova');
    this.cdb.updateRound(round.id, { status: 'concluida', finishedAt: this.now(), summary: txt(o.summary, 1500) ?? v.summaryPt ?? v.subject, coverage: txt(o.coverage, 2000) });
    // Distribuição: referência do Chefe é pedido explícito, então segue para a produção do destino proposto (dentro do foco).
    if (o.produce !== false && slot && !radar.itemId) {
      try { await this.selectRadar(radar.id, slot, true, 'referência do Chefe analisada'); }
      catch (err) { this.cdb.updateRound(round.id, { error: `a peça não foi para a produção: ${(err as Error).message}` }); }
    } else if (!slot) this.cdb.updateRound(round.id, { error: 'a análise não indicou um destino ativo: escolha a conta no Radar' });
  }

  /** Radar → peça → produção. Respeita o foco; a capacidade só segura a escolha automática (aqui é o Chefe ou uma referência dele). */
  private async selectRadar(id: string, slotArg: SocialSlotId | null, produce: boolean, why = 'selecionada no Radar'): Promise<ContentState & { itemId: string | null }> {
    const r = this.cdb.getRadar(id); if (!r) throw new Error('referência não encontrada');
    const slot = slotArg && isSocialSlot(slotArg) ? slotArg : r.slot;
    if (!slot) throw new Error('Escolha o destino (um dos que estão no foco).');
    this.requireActive(slot, 'Produção');
    if (r.itemId && this.cdb.getItem(r.itemId) && !this.cdb.getItem(r.itemId)!.deletedAt) throw new Error('Esta referência já virou peça (abra a peça para ajustar).');
    this.radarToItem(id, slot);
    const it = this.cdb.getRadar(id)?.itemId ? this.cdb.getItem(this.cdb.getRadar(id)!.itemId!) : null;
    if (it) this.cdb.updateItem(it.id, {}, { action: 'ligada à referência', detail: `${why}: ${r.subject}`, origin: r.kind === 'chefe' ? 'referência do Chefe' : 'radar' });
    if (it && produce) await this.produce(it.id, null);
    this.push();
    return { ...this.state(), itemId: it?.id ?? null };
  }

  /** Depois de uma rodada: as prioridades dos destinos ativos entram na produção até a capacidade (3), sem passar da revisão acumulada. */
  private async autoSelect(roundId: string): Promise<string[]> {
    const picked: string[] = [];
    const pool = this.cdb.listRadar(300).filter(r => r.roundId === roundId && r.status === 'nova' && r.priority != null && r.slot && this.active(r.slot) && !r.itemId)
      .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));
    for (const r of pool) {
      if (this.capacity().blocked) break;
      try { await this.selectRadar(r.id, r.slot, true, `prioridade ${r.priority} do Radar`); picked.push(r.id); }
      catch (err) { this.deps.log.warn(`conteúdo: prioridade "${r.subject}" não foi para a produção (${(err as Error).message})`); }
    }
    return picked;
  }

  /** Rodada gravada fora da fila (pesquisa da sessão): importada com a origem marcada, o mesmo dedup e a cobertura por fonte. */
  private async importSessionRound(p: string): Promise<ContentState & { roundId: string }> {
    const folder = this.folder(); if (!folder) throw new Error('Prepare a sala primeiro.');
    const abs = path.resolve(path.isAbsolute(p) ? p : path.join(folder, p));
    if (!isInside(folder, abs) || !/oportunidades\.json$/i.test(abs) || !isFile(abs)) throw new Error('Use um oportunidades.json dentro da pasta de conteúdo (radar/...).');
    const prev = this.cdb.roundByOutput(abs);
    if (prev && prev.status !== 'falhou') throw new Error('Esta rodada já foi importada (a mesma pasta não entra duas vezes).');
    const round = prev ?? this.cdb.createRound({ kind: 'radar', taskId: null, routineId: null, employeeId: null, status: 'aguardando', startedAt: fs.statSync(abs).mtimeMs, outputPath: abs, weekStart: null, origin: 'sessao' });
    await this.importRound(round, { status: 'done', errors: [] } as unknown as Task);
    this.push();
    return { ...this.state(), roundId: round.id };
  }

  private setLearning(id: string, decision: ContentDecision, note: string): ContentState {
    const item = this.cdb.getItem(id); if (!item) throw new Error('peça não encontrada');
    if (!['repetir', 'ajustar', 'testar', 'abandonar'].includes(decision)) throw new Error('decisão inválida');
    const n = txt(note, 1500); if (!n) throw new Error('Escreva em uma frase o que os resultados mostraram (com a métrica e o período).');
    this.cdb.setItemExtras(id, { learning: { decision, note: n, at: this.now() } });
    this.cdb.updateItem(id, {}, { action: 'decisão pelos resultados', detail: `${decision}: ${n.slice(0, 200)}`, origin: 'interface' });
    this.push();
    return this.state();
  }

  // ------------------------------------------------------------------ referência de vídeo (link ou arquivo → análise → reunião → produção)
  private videoRunning = new Set<string>();
  private rendering = new Set<string>();

  private setVideo(id: string, p: Partial<VideoRefState>): RadarItem | null {
    const r = this.cdb.getRadar(id); if (!r?.video) return r;
    return this.cdb.updateRadar(id, { video: { ...r.video, ...p, updatedAt: this.now() } }, false);
  }

  /** Links a mais do pedido (áudio, estilo, outra referência): até 4, sem repetir o principal nem entre si. */
  private extrasInput(raw: VideoRefInput['extras'], mainKey: string | null): { url: string; role: VideoRefExtra['role']; note: string | null }[] {
    const out: { url: string; role: VideoRefExtra['role']; note: string | null }[] = []; const seen = new Set(mainKey ? [mainKey] : []);
    for (const x of Array.isArray(raw) ? raw : []) {
      const url = txt(x?.url, 800); if (!url || !/^https?:\/\//i.test(url)) continue;
      const k = postKey(url) ?? url; if (seen.has(k)) continue; seen.add(k);
      const role: VideoRefExtra['role'] = x.role === 'audio' || x.role === 'estilo' ? x.role : 'referencia';
      out.push({ url, role, note: txt(x.note, 300) });
      if (out.length >= 4) break;
    }
    return out;
  }

  private newExtra(dir: string, x: { url: string; role: VideoRefExtra['role']; note: string | null }, k: number): VideoRefExtra {
    return { url: x.url, role: x.role, note: x.note, dir: path.join(dir, `extra-${k + 2}-${x.role}`), level: null, summary: null, title: null, author: null, duration: null, sheets: [], audioFile: null, evidence: null, error: null };
  }

  private extrasRunning = new Set<string>();
  /** Inspeção de cada link a mais, como a do principal; o de "áudio" também tem o áudio extraído para a mistura. */
  private async inspectExtras(id: string): Promise<void> {
    const tools = this.deps.videoTools; if (!tools || this.extrasRunning.has(id)) return;
    this.extrasRunning.add(id);
    try {
      for (const x of this.cdb.getRadar(id)?.video?.extras ?? []) {
        if (x.level) continue;
        let next: VideoRefExtra;
        try {
          const insp = await inspectVideo({ url: x.url, file: null, dir: x.dir, tools, now: () => new Date(this.now()) });
          const evidence = path.join(x.dir, 'evidencias.md'); fs.writeFileSync(evidence, evidenceMarkdown(insp), 'utf8');
          const audioFile = x.role === 'audio' && insp.media?.audio ? await extractAudio(insp.media.file, x.dir, tools) : null;
          const noVideo = insp.level === 'bloqueada' || insp.level === 'pagina';
          next = {
            ...x, level: insp.level, summary: insp.summary, title: insp.meta?.title ? insp.meta.title.split('\n')[0].slice(0, 160) : null, author: insp.meta?.author ? `@${insp.meta.author.replace(/^@/, '')}` : null,
            duration: insp.media?.duration ?? insp.meta?.duration ?? null, sheets: insp.sheets, audioFile, evidence,
            error: noVideo ? (insp.blocked?.reason ?? 'o vídeo não foi obtido') : x.role === 'audio' && !audioFile ? 'o áudio deste link não foi extraído (sem faixa de áudio ou falha do FFmpeg)' : null,
          };
        } catch (err) { next = { ...x, level: 'bloqueada', error: `a inspeção falhou: ${(err as Error).message}` }; }
        const cur = this.cdb.getRadar(id)?.video; if (!cur) return;
        this.setVideo(id, { extras: (cur.extras ?? []).map(e => (e.dir === x.dir ? next : e)) });
        this.push();
      }
    } finally { this.extrasRunning.delete(id); }
  }

  /** Destino pela instrução ("para o Tuco Dev") ou pelo perfil selecionado na conversa. */
  private videoSlot(text: string | null, profileId: string | null | undefined): SocialSlotId | null {
    const t = (text ?? '').toLowerCase();
    if (/tuco/.test(t)) return 'instagram-tuco';
    if (/threads/.test(t)) return 'threads';
    if (/aurora/.test(t)) return 'instagram-aurora';
    return profileId === 'tuco-dev' ? 'instagram-tuco' : profileId === 'aurora' ? 'instagram-aurora' : null;
  }

  /** Envio pelo campo de pedido. O mesmo link reaproveita o cartão; produzir só quando o modo (ou a instrução) pede. */
  private async addVideo(ref: VideoRefInput): Promise<ContentState & { radarId: string; reused: boolean; mode: VideoRefMode }> {
    const { folder } = this.requireReady('pesquisador');
    const url = txt(ref.url, 800);
    if (url && !/^https?:\/\//i.test(url)) throw new Error('O link precisa começar com http:// ou https://.');
    if (!url && !ref.file && !ref.path) throw new Error('Cole o link do vídeo ou anexe o arquivo.');
    const instruction = txt(ref.instruction, 1500);
    const mode: VideoRefMode = ref.mode === 'produzir' || ref.mode === 'analise' || ref.mode === 'estudo' ? ref.mode
      : instruction && STUDY_INTENT.test(instruction) ? 'estudo' : instruction && PRODUCE_INTENT.test(instruction) ? 'produzir' : 'analise';
    const slot = ref.slot && isSocialSlot(ref.slot) ? ref.slot : this.videoSlot(instruction, ref.profileId);
    if (mode === 'produzir') {
      if (!slot) throw new Error('Para produzir, diga o perfil: Tuco Dev ou Aurora.');
      this.requireActive(slot, 'Produção');
    }
    const liked = txt(ref.liked, 1500);
    const key = postKey(url);
    const extrasIn = this.extrasInput(ref.extras, key);
    const prev = key ? this.cdb.radarByKey(key) : null;
    if (prev?.video && mode === 'estudo' && !prev.video.studyId) {
      // Link já analisado e agora o Chefe quer que a equipe estude: o mesmo cartão vira estudo (a inspeção é reaproveitada).
      const v = prev.video;
      const st = this.cdb.insertStudy({ radarId: prev.id, title: prev.subject, url, folder: v.dir, request: instruction, status: 'analisando', summary: null, lesson: null, analysis: null, techniques: [], exercises: [], meetingId: null, lessonSynthesis: null, feedback: null, history: [], error: null });
      this.setVideo(prev.id, { mode: 'estudo', stage: 'recebida', studyId: st.id, instruction: instruction ?? v.instruction, liked: liked ?? v.liked, error: null });
      this.videoEvent(prev.id, `Chefe pediu para a equipe estudar este vídeo${instruction ? `: "${instruction.slice(0, 200)}"` : ''}`, 'Chefe');
      this.push();
      void this.advanceVideo(prev.id);
      return { ...this.state(), radarId: prev.id, reused: true, mode };
    }
    if (prev?.video) {
      // Mesmo link: o cartão é o mesmo. Pedido de produção para uma conta que ainda não tem peça viva vira uma produção nova.
      const v = prev.video;
      const known = new Set((v.extras ?? []).map(x => postKey(x.url) ?? x.url));
      const added = extrasIn.filter(x => !known.has(postKey(x.url) ?? x.url)).map((x, k) => this.newExtra(v.dir, x, (v.extras?.length ?? 0) + k));
      this.setVideo(prev.id, { liked: liked ?? v.liked, instruction: instruction ?? v.instruction, ...(added.length ? { extras: [...(v.extras ?? []), ...added] } : {}), ...(mode === 'produzir' ? { mode, slot } : {}) });
      if (added.length) await this.inspectExtras(prev.id);
      if (mode === 'produzir' && slot && v.synthesis) await this.produceFromVideo(prev.id, slot, true);
      this.push();
      return { ...this.state(), radarId: prev.id, reused: true, mode: this.cdb.getRadar(prev.id)?.video?.mode ?? mode };
    }
    const stamp = new Date(this.now()).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16).replace(' ', '-').replace(':', '');
    const slug = slugify(ref.file?.name?.replace(/\.[a-z0-9]+$/i, '') ?? (url ? new URL(url).hostname.replace(/^www\./, '') : 'video')).slice(0, 30) || 'video';
    // Estudo vai para a Academia (academia/estudos/...): vídeo, quadros, análise, lição, exercícios e correção numa pasta só.
    // Vídeo de referência de uma equipe fica na pasta dela (marcas/<equipe>/referencias); estudo vai para a Academia.
    const team = slot ? teamOfSlot(slot) : null;
    const base = mode === 'estudo' ? path.join(folder, 'academia', 'estudos', `${stamp}-${slug}`)
      : team ? path.join(folder, 'marcas', brandFolder(team, slot), 'referencias', `${stamp}-video-${slug}`)
      : path.join(folder, 'radar', 'entrada', `${stamp}-video-${slug}`);
    let dir = base; let k = 2;
    while (fs.existsSync(dir)) dir = `${base}-${k++}`;
    fs.mkdirSync(dir, { recursive: true });
    let file: string | null = null;
    if (ref.file) {
      if (!/^video\/(mp4|quicktime|webm|x-matroska)$/.test(ref.file.mediaType)) throw new Error(`Formato de vídeo não aceito: ${ref.file.mediaType} (use MP4, MOV, WebM ou MKV).`);
      const buf = Buffer.from(ref.file.dataBase64, 'base64');
      if (!buf.length || buf.length > 300_000_000) throw new Error('Vídeo vazio ou maior que 300 MB.');
      file = path.join(dir, `original${path.extname(ref.file.name) || '.mp4'}`); fs.writeFileSync(file, buf);
    } else if (ref.path) {
      const abs = path.resolve(ref.path);
      if (!isFile(abs) || !/\.(mp4|mov|webm|mkv)$/i.test(abs)) throw new Error('Arquivo de vídeo não encontrado (MP4, MOV, WebM ou MKV).');
      file = path.join(dir, `original${path.extname(abs)}`); fs.copyFileSync(abs, file);
    }
    const extras = extrasIn.map((x, k) => this.newExtra(dir, x, k));
    fs.writeFileSync(path.join(dir, 'referencia.json'), JSON.stringify({ url, arquivo: file ? path.basename(file) : null, gostei: liked, pedido: instruction, modo: mode, destino: slot, outros: extras.map(x => ({ url: x.url, papel: x.role, nota: x.note })), enviadaEm: new Date(this.now()).toISOString() }, null, 2), 'utf8');
    const video: VideoRefState = { mode, stage: 'recebida', liked, slot, instruction, sessionId: txt(ref.sessionId, 80), dir, file, inspection: null, analysis: null, meetingId: null, synthesis: null, itemIds: [], extras, error: null, updatedAt: this.now() };
    let id: string;
    if (prev) {
      // O link já estava no Radar (achado da pesquisa): o cartão é o mesmo e a origem da pesquisa fica; quem enviou vai na nota.
      this.cdb.updateRadar(prev.id, { note: instruction ?? prev.note ?? 'enviado pelo campo de pedido', video }, false);
      this.cdb.setRadarStatus(prev.id, 'analisando'); id = prev.id;
    } else {
      id = this.cdb.insertRadar({
        roundId: `video:${stamp}`, sourceUrl: url ?? `chefe://${path.basename(dir)}`, sourceName: url ? new URL(url).hostname.replace(/^www\./, '') : 'enviado pelo Chefe', author: null, publishedAt: null,
        consultedAt: new Date(this.now()).toISOString(), subject: url ? 'Vídeo enviado pelo Chefe (abrindo…)' : `Vídeo enviado pelo Chefe: ${ref.file?.name ?? path.basename(file ?? 'video')}`,
        signals: 'referência enviada pelo Chefe (não é tendência nem prova de crescimento)', evidence: 'nao_verificado', window: null, slot, interpretation: 'aguardando a análise', proposal: 'aguardando a análise',
        priority: null, reason: null, material: null, extraCost: null, kind: 'chefe', postKey: key, note: instruction, files: file ? [file] : [], video, status: 'analisando',
      }).id;
    }
    if (mode === 'estudo') {
      const st = this.cdb.insertStudy({ radarId: id, title: url ? `Vídeo de ${new URL(url).hostname.replace(/^www\./, '')}` : ref.file?.name ?? 'Vídeo enviado', url, folder: dir, request: instruction, status: 'analisando', summary: null, lesson: null, analysis: null, techniques: [], exercises: [], meetingId: null, lessonSynthesis: null, feedback: null, history: [], error: null });
      this.setVideo(id, { studyId: st.id });
    }
    this.videoEvent(id, `Recebido do Chefe (${VIDEO_MODE_LABEL[mode]})${instruction ? `: "${instruction.slice(0, 200)}"` : ''}`, 'Chefe');
    this.deps.audit?.({ action: 'referência de vídeo', entity: 'radar', entityId: id, title: url ?? ref.file?.name ?? 'vídeo', origin: 'interface', detail: `modo ${mode}${slot ? `, destino ${slot}` : ''}${liked ? `; gostou: ${liked.slice(0, 120)}` : ''}${extras.length ? `; mais ${extras.length} link(s): ${extras.map(x => x.role).join(', ')}` : ''}` });
    this.push();
    void this.advanceVideo(id);
    return { ...this.state(), radarId: id, reused: false, mode };
  }

  /** Tentar de novo (depois de um bloqueio) ou com o vídeo anexado agora. A referência e o que já foi feito ficam. */
  private async retryVideo(id: string, f: { name: string; mediaType: string; dataBase64: string } | null): Promise<ContentState> {
    const r = this.cdb.getRadar(id); if (!r?.video) throw new Error('referência de vídeo não encontrada');
    let file = r.video.file;
    if (f) {
      if (!/^video\/(mp4|quicktime|webm|x-matroska)$/.test(f.mediaType)) throw new Error(`Formato de vídeo não aceito: ${f.mediaType}.`);
      const buf = Buffer.from(f.dataBase64, 'base64'); if (!buf.length || buf.length > 300_000_000) throw new Error('Vídeo vazio ou maior que 300 MB.');
      file = path.join(r.video.dir, `original-anexado${path.extname(f.name) || '.mp4'}`); fs.writeFileSync(file, buf);
    }
    // Links a mais que não abriram também são tentados de novo; os que já abriram ficam.
    const extras = (r.video.extras ?? []).map(x => (x.error ? { ...x, level: null, summary: null, error: null } : x));
    this.setVideo(id, { stage: 'recebida', error: null, file, analysis: f ? null : r.video.analysis, extras });
    if (r.video.studyId) this.studyUpdate(r.video.studyId, { status: 'analisando', error: null });
    this.videoEvent(id, f ? `Chefe anexou o vídeo (${f.name})` : 'Chefe pediu para tentar de novo', 'Chefe');
    this.push();
    void this.advanceVideo(id);
    return this.state();
  }

  /** Inspeção (Edge sem janela, yt-dlp, FFmpeg, whisper.cpp) e o pedido de análise ao pesquisador. Uma por vez por referência. */
  async advanceVideo(id: string): Promise<void> {
    if (this.videoRunning.has(id)) return;
    this.videoRunning.add(id);
    try {
      const r = this.cdb.getRadar(id); const v = r?.video; if (!r || !v) return;
      if (v.stage !== 'recebida' && v.stage !== 'inspecionando') return;
      if (!this.deps.videoTools) { this.setVideo(id, { stage: 'bloqueada', error: 'ferramentas de vídeo indisponíveis nesta HQ (FFmpeg e yt-dlp)' }); this.push(); return; }
      this.setVideo(id, { stage: 'inspecionando', error: null }); this.push();
      const url = r.sourceUrl.startsWith('chefe://') ? null : r.sourceUrl;
      const insp = await inspectVideo({ url, file: v.file, dir: v.dir, tools: this.deps.videoTools, now: () => new Date(this.now()) });
      fs.writeFileSync(path.join(v.dir, 'evidencias.md'), evidenceMarkdown(insp), 'utf8');
      const ins: NonNullable<VideoRefState['inspection']> = {
        level: insp.level, summary: insp.summary, limits: insp.limits, blocked: insp.blocked, title: insp.meta?.title ?? null, author: insp.meta?.author ?? null, platform: insp.meta?.platform ?? platformOf(url),
        publishedAt: insp.meta?.uploadDate ?? null, duration: insp.media?.duration ?? insp.meta?.duration ?? null, thumbnail: insp.thumbnail, pageShot: insp.pageShot, sheets: insp.sheets, cuts: insp.cuts, sameMedia: insp.sameMedia, at: insp.at,
        watch: insp.watch ? { ok: insp.watch.ok, report: insp.watch.report, frames: insp.watch.frames, transcript: insp.watch.transcript, source: insp.watch.source, version: insp.watch.version, error: insp.watch.error } : null,
      };
      const title = insp.meta?.title ? insp.meta.title.split('\n')[0].slice(0, 160) : r.subject;
      this.cdb.updateRadar(id, {
        subject: title, author: insp.meta?.author ? `@${insp.meta.author.replace(/^@/, '')}` : r.author, publishedAt: insp.meta?.uploadDate ?? r.publishedAt, platform: ins.platform,
        metrics: insp.meta?.metrics.map(m => ({ name: m.name, value: m.value, raw: null })) ?? r.metrics, inspected: insp.level === 'pagina' ? 'imagem' : insp.media ? 'video_sem_audio' : r.inspected,
        observed: insp.summary, files: [...new Set([...(v.file ? [v.file] : []), ...insp.sheets, ...(insp.thumbnail ? [insp.thumbnail] : [])])],
        video: { ...v, stage: 'inspecionando', inspection: ins, updatedAt: this.now() },
      }, false);
      if (v.studyId) this.cdb.updateStudy(v.studyId, { title });
      this.videoEvent(id, `HQ abriu o vídeo: ${VIDEO_LEVEL_LABEL[insp.level]}${insp.watch ? (insp.watch.ok ? ` · Watch: ${insp.watch.frames.length} quadro(s)${insp.watch.transcript && !/^none/i.test(insp.watch.transcript) ? `, transcrição ${insp.watch.transcript}` : ''}` : ` · Watch não assistiu (${insp.watch.error ?? '?'})`) : ''}`, 'HQ');
      if (insp.level === 'bloqueada') {
        const why = insp.blocked?.reason ?? 'sem acesso ao post';
        this.setVideo(id, { stage: 'bloqueada', error: why });
        this.videoEvent(id, `Bloqueado: ${why}. Anexe o arquivo (MP4 ou MOV) ou tente de novo; a HQ não usa a sua conta para baixar.`, 'HQ');
        if (v.studyId) this.studyUpdate(v.studyId, { status: 'bloqueado', error: why });
        this.push(); return;
      }
      await this.inspectExtras(id);
      await this.startVideoAnalysis(id);
    } catch (err) {
      this.setVideo(id, { stage: 'bloqueada', error: `a inspeção falhou: ${(err as Error).message}` });
      const sid = this.cdb.getRadar(id)?.video?.studyId; if (sid) this.studyUpdate(sid, { status: 'bloqueado', error: `a inspeção falhou: ${(err as Error).message}` });
      this.deps.log.warn('conteúdo: inspeção de vídeo falhou', err);
      this.push();
    } finally { this.videoRunning.delete(id); }
  }

  /**
   * A análise vai para o Diretor de Vídeo (07/11; sem Diretor, para o pesquisador, como antes) com os quadros da Watch e as
   * folhas da HQ ANEXADOS como imagem (o modelo vê os quadros) e as evidências medidas. O Diretor usa a skill video-analyze;
   * no modo estudo, grava também a lição, as técnicas e os exercícios (estudo.json).
   */
  private async startVideoAnalysis(id: string): Promise<void> {
    const r = this.cdb.getRadar(id)!; const v = r.video!; const ins = v.inspection!;
    const { projectId } = this.requireReady('pesquisador');
    const study = v.mode === 'estudo';
    const analyst = this.teamMember('direcao') ?? this.teamMember('pesquisador')!;
    const director = analyst.template === DIRECTOR_TEMPLATE;
    if (study && !director) { this.setVideo(id, { stage: 'bloqueada', error: 'falta o Diretor de Vídeo para o estudo (prepare a sala de novo)' }); this.push(); return; }
    const outputPath = path.join(v.dir, study ? 'estudo.json' : 'analise-video.json');
    // Retomada: a análise desta referência já está na fila (ou rodando) → continua a mesma tarefa, sem criar outra.
    const open = this.cdb.openRounds().find(x => (x.kind === 'video' || x.kind === 'estudo') && x.taskId && x.outputPath.toLowerCase() === outputPath.toLowerCase());
    if (open) { this.setVideo(id, { stage: 'analisando' }); this.push(); return; }
    // Watch: wNN-MMmSSs.jpg (o tempo no nome); HQ: folha-NN.png (com Watch, até 8 folhas espalhadas); links a mais: vN-folha-NN.png.
    const extras = v.extras ?? [];
    // Até 30 imagens (limite da HQ para os fluxos dela): até 16 quadros da Watch e 8 folhas espalhados pelo vídeo, a página e os extras.
    const wf = ins.watch?.ok ? spread(ins.watch.frames, 16) : [];
    const images: { file: string; name: string; type: string }[] = wf.map((f, k) => ({ file: f.file, name: `w${String(k + 1).padStart(2, '0')}-${timeName(f.t)}${path.extname(f.file).toLowerCase() || '.jpg'}`, type: /\.png$/i.test(f.file) ? 'image/png' : 'image/jpeg' }));
    for (const f of [...(wf.length ? spread(ins.sheets, 8) : ins.sheets), ...(ins.pageShot ? [ins.pageShot] : [])]) images.push({ file: f, name: path.basename(f), type: 'image/png' });
    extras.forEach((x, k) => { for (const f of x.role === 'audio' ? x.sheets.slice(0, 1) : spread(x.sheets, 3)) images.push({ file: f, name: `v${k + 2}-${path.basename(f)}`, type: 'image/png' }); });
    let total = 0;
    const attachments = images.filter(i => isFile(i.file)).slice(0, 30).flatMap(i => { const b = fs.readFileSync(i.file); if (total + b.length > 12_000_000) return []; total += b.length; return [{ name: i.name, mediaType: i.type, dataBase64: b.toString('base64') }]; });
    const round = this.cdb.createRound({ kind: study ? 'estudo' : 'video', taskId: null, routineId: null, employeeId: analyst.id, status: 'aguardando', startedAt: this.now(), outputPath, weekStart: null, origin: 'referencia' });
    const others = extras.map((x, k) => ({ n: k + 2, url: x.url, role: x.role, note: x.note, level: x.level ? VIDEO_LEVEL_LABEL[x.level] : 'não inspecionado', summary: x.summary, evidence: x.evidence, error: x.error, sheets: attachments.filter(a => a.name.startsWith(`v${k + 2}-`)).length, audioFile: x.audioFile }));
    const watch = ins.watch ? { frames: attachments.filter(a => /^w\d+-/.test(a.name)).length, report: ins.watch.report, transcript: ins.watch.transcript, error: ins.watch.error } : null;
    const base = { now: this.now(), outputPath, dir: v.dir, url: r.sourceUrl.startsWith('chefe://') ? null : r.sourceUrl, level: VIDEO_LEVEL_LABEL[ins.level], summary: ins.summary, liked: v.liked, instruction: v.instruction, sheets: attachments.filter(a => /^folha/.test(a.name)).length, hasPage: attachments.some(a => a.name === 'pagina.png'), others, watch };
    const text = study ? studyPrompt({ ...base, team: this.studyTeam() }) : videoAnalysisPrompt({ ...base, target: v.slot ? slotDef(v.slot).label : null, director });
    const input = { reqId: 'content', clientId: `content:${round.id}`, text, projectId, employeeId: analyst.id, skill: director ? 'video-analyze' : 'milweb-video-studio', plan: false, attachments, maxAttachments: attachments.length };
    try {
      let res: TaskRunResult; let note = '';
      try { res = await this.deps.manager.runTask(input); }
      catch (err) {
        // Skill do Video Analyzer fora do catálogo desta máquina: o Diretor segue com o formato descrito no pedido.
        if (!director || !/skill/i.test((err as Error).message)) throw err;
        res = await this.deps.manager.runTask({ ...input, skill: 'milweb-video-studio' }); note = ' (skill video-analyze indisponível: formato pelo pedido)';
      }
      this.cdb.updateRound(round.id, { taskId: res.taskId });
      this.setVideo(id, { stage: 'analisando' });
      this.videoEvent(id, `${study ? 'Estudo' : 'Análise'} com ${analyst.name}${director ? ` (skill video-analyze${wf.length ? `, ${watch?.frames ?? 0} quadro(s) da Watch` : ''})` : ''}${note}`, analyst.name);
    } catch (err) {
      this.cdb.updateRound(round.id, { status: 'falhou', finishedAt: this.now(), error: `a tarefa não foi criada: ${(err as Error).message}` });
      this.setVideo(id, { stage: 'bloqueada', error: `a análise não entrou na fila: ${(err as Error).message}` });
      if (v.studyId) this.studyUpdate(v.studyId, { status: 'bloqueado', error: `o estudo não entrou na fila: ${(err as Error).message}` });
    }
    this.push();
  }

  /** Análise importada: com o vídeo inteiro, abre a reunião; só com a página, fica como análise parcial esperando o vídeo. */
  private async importVideoAnalysis(round: ContentRound, o: Record<string, unknown>): Promise<void> {
    const dir = path.dirname(round.outputPath).toLowerCase();
    const r = this.cdb.listRadar(400).find(x => x.video && x.video.dir.toLowerCase() === dir);
    if (!r?.video) { this.failRound(round, 'referência de vídeo não encontrada'); return; }
    const central = txt(o.ideiaCentral ?? o.ideia_central ?? o.central, 600);
    const rec = (o.recomendada ?? o.recomendacao) as Record<string, unknown> | string | undefined;
    const recommended = typeof rec === 'string' ? txt(rec, 1500) : txt(rec?.resumo ?? rec?.titulo ?? rec?.descricao, 1500);
    if (!central && !recommended) { this.failRound(round, 'analise-video.json sem ideia central nem recomendação'); return; }
    const md = path.join(path.dirname(round.outputPath), 'analise.md');
    this.cdb.updateRadar(r.id, {
      summaryPt: central ?? r.summaryPt, interpretation: txt(o.promessa, 800) ?? txt(o.publico, 800) ?? r.interpretation, proposal: recommended ?? r.proposal,
      reason: txt(rec && typeof rec === 'object' ? rec.motivo : null, 800) ?? r.reason, effort: txt(rec && typeof rec === 'object' ? rec.esforco : null, 40) ?? r.effort,
      video: { ...r.video, analysis: { file: round.outputPath, md: isFile(md) ? md : null, central, recommended, at: this.now(), direction: isFile(path.join(path.dirname(round.outputPath), 'direcao.md')) ? path.join(path.dirname(round.outputPath), 'direcao.md') : null, by: (round.employeeId && this.deps.store.getEmployee(round.employeeId)?.name) || null }, updatedAt: this.now() },
    }, false);
    this.videoEvent(r.id, `Análise entregue${round.employeeId && this.deps.store.getEmployee(round.employeeId) ? ` por ${this.deps.store.getEmployee(round.employeeId)!.name}` : ''}${isFile(path.join(path.dirname(round.outputPath), 'direcao.md')) ? ' (com roteiro e storyboard)' : ''}`, (round.employeeId && this.deps.store.getEmployee(round.employeeId)?.name) || null);
    this.cdb.updateRound(round.id, { status: 'concluida', finishedAt: this.now(), summary: central ?? recommended });
    this.cdb.setRadarStatus(r.id, r.itemId ? 'virou_peca' : 'nova');
    if (r.video.inspection && r.video.inspection.level === 'pagina') {
      this.setVideo(r.id, { stage: 'bloqueada', error: `análise parcial (só a página): ${r.video.inspection.blocked?.reason ?? 'o vídeo não foi obtido'}. Anexe o vídeo ou tente de novo para a equipe ver o vídeo inteiro.` });
      return;
    }
    await this.continueAfterAnalysis(r.id);
  }

  /**
   * 05/11 (Chefe: "queria o vídeo, veio roteiro e reunião"): "Analisar e produzir" vai direto da análise para a produção.
   * A reunião fica para "Analisar com a equipe" (quando o Chefe quer discutir antes de decidir).
   */
  private async continueAfterAnalysis(id: string): Promise<void> {
    const v = this.cdb.getRadar(id)?.video; if (!v) return;
    if (v.mode === 'produzir') {
      if (!v.slot) { this.setVideo(id, { stage: 'proposta', error: 'escolha o perfil no cartão para a produção começar' }); this.push(); return; }
      try { await this.produceFromVideo(id, v.slot, false); }
      catch (err) { this.setVideo(id, { stage: 'proposta', error: `a produção não começou: ${(err as Error).message}` }); }
      this.push();
      return;
    }
    await this.startVideoMeeting(id);
  }

  /** Reunião existente vinculada à referência: pesquisador, editorial, edição e os dois gerentes; uma proposta e uma revisão. */
  private async startVideoMeeting(id: string): Promise<void> {
    const r = this.cdb.getRadar(id)!; const v = r.video!;
    const m = this.deps.meetings;
    if (!m) { this.setVideo(id, { stage: 'proposta', error: 'reuniões indisponíveis nesta HQ: a proposta é a análise do pesquisador' }); return; }
    const projectId = this.projectId();
    // 07/11: quem analisou (o Diretor de Vídeo, quando existe) apresenta; a edição e a criação da equipe da conta executam.
    const squad = this.squadOf(v.slot);
    const caio = this.teamMember('direcao') ?? this.teamMember('pesquisador'); const marina = this.teamMember('coordenador'); const bia = this.teamMember('criador', squad);
    const editor = this.teamMember('direcao') ? this.teamMember('video', squad) : null;
    if (!caio || !marina || !bia) { this.setVideo(id, { stage: 'bloqueada', error: 'falta funcionário da sala (pesquisa, coordenação ou criação) para a reunião' }); return; }
    const ins = v.inspection;
    const extras = v.extras ?? [];
    const agenda = videoMeetingAgenda({ title: r.subject, url: r.sourceUrl.startsWith('chefe://') ? null : r.sourceUrl, level: ins ? VIDEO_LEVEL_LABEL[ins.level] : 'desconhecido', target: v.slot ? slotDef(v.slot).label : null, liked: v.liked, mode: v.mode, researcher: caio.name, editorial: marina.name, editor: editor ? `${editor.name} (edição, com ${bia.name} no roteiro)` : bia.name, others: extras.map((x, k) => ({ n: k + 2, url: x.url, role: x.role, note: x.note, error: x.error })) });
    // Se a reunião não começar, o cartão diz o motivo (05/11: a 2ª referência ficou em "analisando" sem erro visível).
    try { await this.openVideoMeeting(id, r, v, agenda, projectId, caio, marina, bia, extras, editor); }
    catch (err) { this.setVideo(id, { stage: 'proposta', error: `a reunião não começou (${(err as Error).message}); a proposta é a análise do pesquisador` }); this.push(); }
  }

  private async openVideoMeeting(id: string, r: RadarItem, v: NonNullable<RadarItem['video']>, agenda: string, projectId: string | null, caio: { id: string; name: string }, marina: { id: string }, bia: { id: string }, extras: NonNullable<NonNullable<RadarItem['video']>['extras']>, editor: { id: string; name: string } | null = null): Promise<void> {
    const m = this.deps.meetings!;
    const created = await m.handle({ type: 'meeting.create', reqId: 'content', title: `Referência: ${r.subject.slice(0, 70)}`, agenda, projectId, mode: 'debate', roundLimit: 2, participants: [
      { provider: 'claude', employeeId: caio.id }, { provider: 'claude', employeeId: marina.id }, { provider: 'claude', employeeId: bia.id }, ...(editor ? [{ provider: 'claude' as const, employeeId: editor.id }] : []), { provider: 'claude' }, { provider: 'openai' },
    ] }) as { meeting: { id: string; participants: { id: string; provider: string | null; employeeId: string | null }[] } };
    const meetingId = created.meeting.id;
    const claudeManager = created.meeting.participants.find(p => p.provider === 'claude' && !p.employeeId);
    if (claudeManager) await m.handle({ type: 'meeting.update', id: meetingId, patch: { synthesisParticipantId: claudeManager.id } });
    // Os ids do contexto são chave primária global no banco: um por reunião (antes "briefing" fixo quebrava na 2ª referência).
    const items = [
      { id: `${meetingId}:briefing`, kind: 'note' as const, label: 'Pedido do Chefe', path: null, text: [`Referência: ${r.sourceUrl.startsWith('chefe://') ? 'vídeo anexado (sem link)' : r.sourceUrl}`, v.instruction ? `Pedido: ${v.instruction}` : 'Pedido: só o link (analisar)', v.liked ? `Gostou de: ${v.liked}` : 'Não disse do que gostou', `Modo: ${v.mode === 'produzir' ? 'analisar e produzir' : 'só análise'}`, v.slot ? `Destino: ${slotDef(v.slot).label}` : 'Destino: a definir', ...extras.map((x, k) => `Vídeo ${k + 2} (${VIDEO_ROLE_LABEL[x.role]}): ${x.url}${x.note ? ` · o Chefe escreveu: "${x.note}"` : ''}${x.error ? ` · não abriu: ${x.error}` : ''}`)].join('\n'), enabled: true },
      ...(v.analysis?.md ? [{ id: `${meetingId}:analise`, kind: 'file' as const, label: `Relatório de ${caio.name}`, path: v.analysis.md, text: null, enabled: true }] : []),
      ...(v.analysis?.direction && isFile(v.analysis.direction) ? [{ id: `${meetingId}:direcao`, kind: 'file' as const, label: `Roteiro e storyboard de ${caio.name}`, path: v.analysis.direction, text: null, enabled: true }] : []),
      { id: `${meetingId}:evidencias`, kind: 'file' as const, label: 'Evidências medidas pela HQ', path: path.join(v.dir, 'evidencias.md'), text: null, enabled: true },
      ...extras.flatMap((x, k) => (x.evidence && isFile(x.evidence) ? [{ id: `${meetingId}:evidencias-v${k + 2}`, kind: 'file' as const, label: `Evidências do vídeo ${k + 2} (${VIDEO_ROLE_LABEL[x.role]})`, path: x.evidence, text: null, enabled: true }] : [])),
    ];
    await m.handle({ type: 'meeting.context.set', reqId: 'content', meetingId, items });
    this.setVideo(id, { stage: 'discussao', meetingId });
    this.videoEvent(id, `Reunião aberta: ${caio.name} apresenta${editor ? `, ${editor.name} na edição` : ''}`, caio.name);
    this.push();
    try { await m.handle({ type: 'meeting.discuss', reqId: 'content', meetingId, clientId: `video:${id}` }); }
    catch (err) { this.setVideo(id, { error: `a discussão não começou: ${(err as Error).message}` }); }
  }

  /** "Produzir esta versão" ou o modo produzir depois da síntese. Não recria peça que o Chefe removeu, a não ser pelo botão. */
  /**
   * explicit = o Chefe pediu agora (botão do cartão ou o link mandado de novo pedindo um vídeo). fromCard = veio do botão do cartão:
   * peça desta conta que está na lixeira NÃO é recriada por ele (em 05/11 um clique no cartão trouxe de volta o Reel que o Chefe
   * tinha jogado fora). Para outra versão, o Chefe manda o link de novo pedindo; para a mesma, restaura pela Lixeira.
   */
  private async produceFromVideo(id: string, slotArg: SocialSlotId | null, explicit: boolean, fromCard = false): Promise<ContentItem | null> {
    const r = this.cdb.getRadar(id); const v = r?.video; if (!r || !v) throw new Error('referência de vídeo não encontrada');
    const slot = slotArg && isSocialSlot(slotArg) ? slotArg : v.slot;
    if (!slot) throw new Error('Escolha o perfil: Tuco Dev ou Aurora.');
    this.requireActive(slot, 'Produção');
    if (!v.synthesis && !v.analysis?.recommended) throw new Error('Ainda não há proposta: espere a análise e a discussão terminarem.');
    const mine = v.itemIds.map(x => this.cdb.getItem(x)).filter((i): i is ContentItem => Boolean(i) && i!.slot === slot);
    const live = mine.find(i => !i.deletedAt && i.status !== 'descartada');
    if (live) return live;
    if (mine.some(i => i.deletedAt)) {
      if (fromCard) throw new Error(`A versão desta referência para ${slotDef(slot).label} está na lixeira. Para recuperá-la, restaure pela Lixeira; para outra versão, cole o link de novo pedindo o vídeo.`);
      if (!explicit) { this.setVideo(id, { stage: 'proposta', error: 'a produção desta conta está na lixeira: nada foi recriado' }); return null; }
    }
    const dest = this.cdb.listDestinations().find(d => d.slot === slot);
    const evidence = path.join(v.dir, 'evidencias.md');
    const extras = (v.extras ?? []).map((x, k) => ({ n: k + 2, url: x.url, role: x.role, note: x.note, evidence: x.evidence && isFile(x.evidence) ? x.evidence : null, audioFile: x.audioFile && isFile(x.audioFile) ? x.audioFile : null, error: x.error }));
    const item = this.cdb.insertItem({
      weekStart: null, baseId: null, baseTitle: null, date: null, time: null, slot, profileId: slotDef(slot).defaultProfileIds[0] ?? null, format: 'Reel', objective: dest?.objective ?? '',
      title: `Versão própria: ${r.subject.slice(0, 160)}`, brief: videoPieceBrief({ synthesis: v.synthesis?.text ?? v.analysis?.recommended ?? '', title: r.subject, url: r.sourceUrl.startsWith('chefe://') ? null : r.sourceUrl, analysisMd: v.analysis?.md ?? null, evidence, liked: v.liked, instruction: v.instruction, others: extras, direction: v.analysis?.direction && isFile(v.analysis.direction) ? v.analysis.direction : null, analyst: v.analysis?.by ?? null }),
      sources: [...(r.sourceUrl.startsWith('chefe://') ? [] : [r.sourceUrl]), ...extras.map(x => x.url)], files: [v.analysis?.md, v.analysis?.direction, evidence, ...extras.map(x => x.evidence)].filter((f): f is string => Boolean(f && isFile(f))), material: 'pronto', ownerId: this.producerFor(slot, 'Reel')?.id ?? null,
      skill: 'milweb-video-studio', reviewCriteria: 'mecanismo da referência adaptado com material e identidade próprios (nada do vídeo de terceiros no nosso); origem registrada no peca.md; movimento que ajuda a entender (não imagem com zoom e legenda); fato técnico com fonte primária; Aurora só com projeto e decisão reais (demo, conceito e cliente identificados)',
      status: 'planejada', taskId: null, reviewTaskId: null, radarId: null, folder: null, deliverable: null, checks: [], review: null, nextStep: null, approvalId: null, publication: null,
      referenceIds: [id], hypothesis: v.analysis?.recommended ? `Adaptar "${r.subject.slice(0, 80)}": ${v.analysis.recommended.slice(0, 400)}` : null,
    }, { action: 'criada da referência de vídeo', detail: v.synthesis ? `síntese de ${v.synthesis.author}` : 'recomendação do pesquisador', origin: explicit ? 'interface' : 'reunião' });
    this.setVideo(id, { itemIds: [...v.itemIds, item.id], stage: 'producao', mode: 'produzir', slot, error: null });
    this.videoEvent(id, `Produção para ${slotDef(slot).label} com ${(item.ownerId && this.deps.store.getEmployee(item.ownerId)?.name) || 'a edição'}`, null);
    this.cdb.setRadarStatus(id, 'virou_peca', item.id);
    await this.produce(item.id, null);
    return this.cdb.getItem(item.id);
  }

  /** Acompanha as referências de vídeo: retoma a inspeção depois de reiniciar e lê a síntese da reunião quando ela chega. */
  private async syncVideos(): Promise<boolean> {
    let changed = false;
    for (const r of this.cdb.listRadar(400).filter(x => x.video)) {
      const v = r.video!;
      if ((v.stage === 'recebida' || v.stage === 'inspecionando') && !this.videoRunning.has(r.id)) { void this.advanceVideo(r.id); continue; }
      // Análise gravada, mas a etapa seguinte nunca começou (05/11: a reunião caiu no UNIQUE do contexto e o cartão ficou
      // parado em "analisando", sem erro). Sem análise na fila para esta referência, segue daqui: produção ou reunião.
      if (v.stage === 'analisando' && v.analysis && !v.meetingId && !v.itemIds.length && !this.videoRunning.has(r.id)) {
        const dir = v.dir.toLowerCase();
        const pending = this.cdb.listRounds(200).some(x => x.kind === 'video' && x.status === 'aguardando' && path.dirname(x.outputPath).toLowerCase() === dir);
        if (!pending) { this.videoRunning.add(r.id); try { await this.continueAfterAnalysis(r.id); } finally { this.videoRunning.delete(r.id); } changed = true; continue; }
      }
      if (v.stage !== 'discussao' || !v.meetingId || !this.deps.meetings) continue;
      const msgs = this.deps.meetings.messages(v.meetingId);
      const synth = msgs.filter(x => x.phase === 'synthesis' && x.kind === 'speech' && !x.partial).pop();
      if (!synth) continue;
      this.setVideo(r.id, { synthesis: { messageId: synth.id, text: synth.text, author: synth.authorName, at: synth.ts } });
      this.videoEvent(r.id, `Direção decidida na reunião (síntese de ${synth.authorName})`, synth.authorName);
      changed = true;
      // A reunião cumpriu o papel: encerra com a ata (sem turno novo). Antes ficava "em andamento" para sempre (Neymar, 07/11).
      const meetingId = v.meetingId;
      void this.deps.meetings.handle({ type: 'meeting.end', reqId: 'content', meetingId }).catch(err => this.deps.log.warn(`conteúdo: a reunião ${meetingId} não foi encerrada (${(err as Error).message})`));
      if (v.mode === 'produzir' && v.slot) {
        try { await this.produceFromVideo(r.id, v.slot, false); } catch (err) { this.setVideo(r.id, { stage: 'proposta', error: `a produção não começou: ${(err as Error).message}` }); }
      } else this.setVideo(r.id, { stage: 'proposta' });
    }
    return changed;
  }

  /** Estado mostrado: depois da produção, vem da peça (em produção, renderizando, para revisar, concluída). */
  private videoStage(r: RadarItem): VideoRefStage {
    const v = r.video!;
    const items = v.itemIds.map(x => this.cdb.getItem(x)).filter((i): i is ContentItem => Boolean(i) && !i!.deletedAt);
    // Tudo o que saiu desta referência foi para a lixeira: o cartão diz isso (e não oferece produzir de novo).
    if (!items.length) return v.itemIds.length ? 'lixeira' : v.stage;
    if (items.some(i => this.rendering.has(i.id))) return 'renderizando';
    if (items.some(i => i.status === 'em_producao')) return 'producao';
    if (items.some(i => i.status === 'revisar' || i.status === 'ajustar')) return 'revisar';
    if (items.some(i => i.status === 'parcial' || i.status === 'falhou')) return 'bloqueada';
    if (items.every(i => ['aprovada', 'publicada', 'publicacao_pendente', 'agendada'].includes(i.status))) return 'concluida';
    return v.stage;
  }

  // ------------------------------------------------------------------ Academia de Vídeo (estudo → aula → exercícios → correção)
  private academyRendering = new Set<string>();

  private academyIndexFile(): string | null { const f = this.folder(); return f ? path.join(f, 'academia', 'INDICE.md') : null; }
  private academyIndexExists(): boolean { const f = this.academyIndexFile(); return Boolean(f && isFile(f)); }
  private academyState(): AcademyState {
    const idx = this.academyIndexFile();
    return { studies: this.cdb.listStudies(40), techniques: this.cdb.listTechniques(), index: idx && isFile(idx) ? idx : null };
  }

  /** Linha no histórico da referência e do estudo ligado a ela (quem fez, o quê, quando). */
  private videoEvent(radarId: string, text: string, who: string | null): void {
    const r = this.cdb.getRadar(radarId); if (!r?.video) return;
    const ev = { at: this.now(), text: text.slice(0, 500), who };
    this.cdb.updateRadar(radarId, { video: { ...r.video, events: [...(r.video.events ?? []), ev].slice(-60) } }, false);
    if (r.video.studyId) { const st = this.cdb.getStudy(r.video.studyId); if (st) this.cdb.updateStudy(st.id, { history: [...st.history, ev].slice(-80) }); }
  }
  private studyUpdate(id: string, p: Partial<Omit<AcademyStudy, 'id' | 'createdAt' | 'updatedAt' | 'radarId'>>, event?: string, who: string | null = null): AcademyStudy | null {
    const st = this.cdb.updateStudy(id, p);
    if (st && event) this.videoEvent(st.radarId, event, who);
    return this.cdb.getStudy(id);
  }
  private setExercise(studyId: string, exId: string, p: Partial<AcademyExercise>, event?: string, who: string | null = null): AcademyStudy | null {
    const st = this.cdb.getStudy(studyId); if (!st) return null;
    return this.studyUpdate(studyId, { exercises: st.exercises.map(e => (e.id === exId ? { ...e, ...p } : e)) }, event, who);
  }
  private exerciseByDir(dir: string): { study: AcademyStudy; ex: AcademyExercise } | null {
    const d = path.resolve(dir).toLowerCase();
    for (const st of this.cdb.listStudies(200)) { const ex = st.exercises.find(e => path.resolve(e.dir).toLowerCase() === d); if (ex) return { study: st, ex }; }
    return null;
  }
  /** Quem a Academia treina: edição e criação das duas equipes, revisão e pauta. */
  private studyTeam(): { name: string; role: string; profile: string | null }[] {
    return this.contentStaff().filter(e => e.template !== DIRECTOR_TEMPLATE && e.template !== 'conteudo-pesquisador').map(e => ({ name: e.name, role: e.role, profile: e.profileId ? this.profileName(e.profileId) : null }));
  }
  /** Fichas das técnicas e o índice, na pasta de conteúdo (o que a equipe lê nas próximas tarefas). */
  private refreshAcademyFiles(): void {
    const folder = this.folder(); if (!folder || !fs.existsSync(folder)) return;
    const studies = this.cdb.listStudies(200);
    // Sem estudo nenhum, nada de índice vazio (o pedido de vídeo só manda ler a Academia quando ela tem conteúdo).
    if (!studies.length && !this.cdb.listTechniques().length) return;
    for (const t of this.cdb.listTechniques()) {
      try { const file = writeTechniqueCard(folder, t, studies); if (t.file !== file) this.cdb.saveTechnique({ ...t, file }); } catch (err) { this.deps.log.warn(`academia: ficha ${t.slug} não foi gravada`, err); }
    }
    try { writeAcademyIndex(folder, this.cdb.listTechniques(), studies, this.now()); } catch (err) { this.deps.log.warn('academia: academia/INDICE.md não foi gravado', err); }
  }

  /** estudo.json do Diretor: técnicas para a biblioteca, exercícios com o funcionário de cada um e, em seguida, a aula. */
  private async importStudy(round: ContentRound, o: Record<string, unknown>): Promise<void> {
    const dir = path.dirname(round.outputPath);
    const r = this.cdb.listRadar(400).find(x => x.video && x.video.dir.toLowerCase() === dir.toLowerCase());
    const st = r?.video?.studyId ? this.cdb.getStudy(r.video.studyId) : null;
    if (!r?.video || !st) { this.failRound(round, 'estudo não encontrado na Academia'); return; }
    const parsed = parseStudy(o);
    if (!parsed.ok) { this.failRound(round, parsed.error); return; }
    const p = parsed.value;
    const who = (round.employeeId && this.deps.store.getEmployee(round.employeeId)?.name) || 'Diretor';
    const md = path.join(dir, 'analise.md'); const lesson = path.join(dir, 'licao.md');
    this.cdb.updateRadar(r.id, {
      summaryPt: p.central ?? p.summary, proposal: p.summary,
      video: { ...r.video, analysis: { file: round.outputPath, md: isFile(md) ? md : null, central: p.central, recommended: p.summary, at: this.now(), direction: null, by: who }, updatedAt: this.now() },
    }, false);
    for (const t of p.techniques) this.cdb.saveTechnique(mergeTechnique(this.cdb.getTechnique(t.slug), t, { studyId: st.id, title: st.title }));
    const exercises: AcademyExercise[] = p.exercises.map((e, k) => {
      const emp = this.teamMember(e.role, e.profileId);
      const id = `e${k + 1}`;
      return {
        id, title: e.title, role: e.role, profileId: e.profileId ?? emp?.profileId ?? null, employeeId: emp?.id ?? null, employeeName: emp?.name ?? null, techniques: e.techniques,
        instructions: e.instructions, deliverable: e.deliverable, dir: path.join(dir, 'exercicios', `${id}-${slugify(emp?.name ?? e.role).slice(0, 20) || e.role}`),
        status: emp ? 'pendente' : 'falhou', taskId: null, result: null, feedback: null, error: emp ? null : `ninguém no papel "${e.role}" para fazer o exercício`,
      };
    });
    this.cdb.updateRound(round.id, { status: 'concluida', finishedAt: this.now(), summary: p.summary, error: p.warnings.length ? p.warnings.join('; ').slice(0, 1500) : null });
    const obs = p.techniques.filter(t => t.evidence === 'observado').length;
    this.studyUpdate(st.id, {
      summary: p.summary, lesson: isFile(lesson) ? lesson : null, analysis: isFile(md) ? md : null, techniques: p.techniques.map(t => ({ slug: t.slug, evidence: t.evidence })), exercises, status: 'aula', error: null,
    }, `${who} entregou o estudo: ${p.techniques.length} técnica(s) (${obs} observada(s), ${p.techniques.length - obs} inferida(s)) e ${exercises.length} exercício(s)${isFile(lesson) ? '' : '; falta o licao.md'}`, who);
    this.cdb.setRadarStatus(r.id, 'nova');
    this.refreshAcademyFiles();
    await this.startLesson(st.id);
  }

  /** Aula: reunião com o Diretor, quem tem exercício e o gerente (consolida). Sem reunião, os exercícios seguem com a lição escrita. */
  private async startLesson(studyId: string): Promise<void> {
    const st = this.cdb.getStudy(studyId); if (!st) return;
    const director = this.teamMember('direcao');
    const m = this.deps.meetings;
    this.setVideo(st.radarId, { stage: 'aula', error: null });
    const people = [...new Map(st.exercises.filter(e => e.employeeId && e.status === 'pendente').map(e => [e.employeeId!, e])).values()];
    if (!m || !director || !st.lesson || !people.length) {
      this.studyUpdate(studyId, {}, `Aula sem reunião (${!m ? 'reuniões indisponíveis nesta HQ' : !director ? 'sem Diretor' : !st.lesson ? 'o Diretor não gravou o licao.md' : 'ninguém com exercício'}): os exercícios seguem com a lição escrita`);
      await this.dispatchExercises(studyId);
      return;
    }
    try {
      const agenda = lessonAgenda({ title: st.title, director: director.name, lesson: st.lesson, summary: st.summary ?? '', techniques: st.techniques.map(t => ({ name: this.cdb.getTechnique(t.slug)?.name ?? t.slug, evidence: t.evidence === 'observado' ? 'observado' : 'inferido' })), exercises: st.exercises.map(e => ({ who: e.employeeName ?? e.role, title: e.title })) });
      const created = await m.handle({ type: 'meeting.create', reqId: 'content', title: `Aula: ${st.title.slice(0, 70)}`, agenda, projectId: this.projectId(), mode: 'debate', roundLimit: 1, participants: [
        { provider: 'claude', employeeId: director.id }, ...people.map(e => ({ provider: 'claude' as const, employeeId: e.employeeId! })), { provider: 'claude' },
      ] }) as { meeting: { id: string; participants: { id: string; provider: string | null; employeeId: string | null }[] } };
      const meetingId = created.meeting.id;
      const mgr = created.meeting.participants.find(p => p.provider === 'claude' && !p.employeeId);
      if (mgr) await m.handle({ type: 'meeting.update', id: meetingId, patch: { synthesisParticipantId: mgr.id } });
      await m.handle({ type: 'meeting.context.set', reqId: 'content', meetingId, items: [
        { id: `${meetingId}:licao`, kind: 'file' as const, label: `Lição de ${director.name}`, path: st.lesson, text: null, enabled: true },
        ...(st.analysis ? [{ id: `${meetingId}:analise`, kind: 'file' as const, label: 'Análise do vídeo (Video Analyzer)', path: st.analysis, text: null, enabled: true }] : []),
      ] });
      this.studyUpdate(studyId, { meetingId, status: 'aula' }, `Aula aberta: ${[director.name, ...people.map(e => e.employeeName)].join(', ')}`, director.name);
      this.push();
      try { await m.handle({ type: 'meeting.discuss', reqId: 'content', meetingId, clientId: `aula:${studyId}` }); }
      catch (err) { this.studyUpdate(studyId, {}, `A aula não começou (${(err as Error).message}): os exercícios seguem com a lição escrita`); await this.dispatchExercises(studyId); }
    } catch (err) {
      this.studyUpdate(studyId, {}, `A aula não abriu (${(err as Error).message}): os exercícios seguem com a lição escrita`);
      await this.dispatchExercises(studyId);
    }
  }

  /** Manda cada exercício pendente (ou só um) para o funcionário dele, como tarefa real na fila, com a saída resultado.json. */
  private async dispatchExercises(studyId: string, only: string | null = null): Promise<void> {
    const st = this.cdb.getStudy(studyId); const projectId = this.projectId(); const folder = this.folder();
    if (!st || !projectId || !folder) return;
    const director = this.teamMember('direcao');
    this.studyUpdate(studyId, { status: 'exercicios', error: null });
    this.setVideo(st.radarId, { stage: 'exercicios', error: null });
    for (const e of st.exercises) {
      if (e.status !== 'pendente' || (only && e.id !== only)) continue;
      const emp = e.employeeId ? this.deps.store.getEmployee(e.employeeId) : null;
      if (!emp || emp.archivedAt) { this.setExercise(studyId, e.id, { status: 'falhou', error: 'funcionário não encontrado (arquivado?)' }, `Exercício "${e.title}" sem funcionário`); continue; }
      fs.mkdirSync(e.dir, { recursive: true });
      const outputPath = path.join(e.dir, 'resultado.json');
      const round = this.cdb.createRound({ kind: 'exercicio', taskId: null, routineId: null, employeeId: emp.id, status: 'aguardando', startedAt: this.now(), outputPath, weekStart: null, origin: 'referencia' });
      const video = e.role === 'video';
      const text = exercisePrompt({
        now: this.now(), study: st.title, director: director?.name ?? 'o Diretor', title: e.title, instructions: e.instructions, deliverable: e.deliverable, dir: e.dir, lesson: st.lesson,
        techniqueFiles: e.techniques.map(s => path.join(folder, 'academia', 'tecnicas', `${s}.md`)).filter(f => isFile(f)), synthesis: st.lessonSynthesis, video, brand: e.profileId === 'aurora' ? 'aurora' : 'tuco-dev',
      });
      try {
        const res = await this.deps.manager.runTask({ reqId: 'content', clientId: `content:${round.id}`, text, projectId, employeeId: emp.id, skill: video ? 'milweb-video-studio' : null, plan: false });
        this.cdb.updateRound(round.id, { taskId: res.taskId });
        this.setExercise(studyId, e.id, { status: 'em_producao', taskId: res.taskId, error: null, employeeName: emp.name }, `Exercício "${e.title}" na fila de ${emp.name}`, director?.name ?? null);
      } catch (err) {
        const why = (err as Error).message;
        this.cdb.updateRound(round.id, { status: 'falhou', finishedAt: this.now(), error: `a tarefa não foi criada: ${why}` });
        this.setExercise(studyId, e.id, { status: 'falhou', error: `não entrou na fila: ${why}` }, `Exercício "${e.title}" não entrou na fila: ${why}`);
      }
    }
    this.push();
    await this.checkStudyDone(studyId);
  }

  /** resultado.json do exercício: arquivos conferidos; o de edição ainda passa pelo render da HQ (CenasReel). */
  private async importExercise(round: ContentRound, o: Record<string, unknown>): Promise<void> {
    const hit = this.exerciseByDir(path.dirname(round.outputPath));
    if (!hit) { this.failRound(round, 'exercício não encontrado na Academia'); return; }
    const parsed = parseExerciseResult(o, hit.ex.dir, this.folder() ?? hit.study.folder);
    if (!parsed.ok) { this.failRound(round, parsed.error); return; }
    const p = parsed.value;
    this.cdb.updateRound(round.id, { status: 'concluida', finishedAt: this.now(), summary: p.summary, error: p.missing.length ? `arquivos citados que não existem: ${p.missing.join(', ').slice(0, 800)}` : null });
    const needsRender = hit.ex.role === 'video' && isFile(path.join(hit.ex.dir, 'video.json'));
    const result = { summary: p.summary, files: p.files, learned: p.learned, doubts: p.doubts, render: needsRender ? (this.deps.video ? 'renderizando' : 'não renderizado: renderizador indisponível nesta HQ') : null, at: this.now() };
    const who = hit.ex.employeeName;
    if (needsRender && this.deps.video) {
      this.setExercise(hit.study.id, hit.ex.id, { result }, `${who ?? 'A equipe'} entregou "${hit.ex.title}"; a HQ renderiza o vídeo`, who);
      void this.renderExercise(hit.study.id, hit.ex.id);
      return;
    }
    this.setExercise(hit.study.id, hit.ex.id, { status: 'concluido', result, error: null }, `${who ?? 'A equipe'} entregou "${hit.ex.title}"`, who);
    this.addExamples(hit.study.id, hit.ex.id);
    await this.checkStudyDone(hit.study.id);
  }

  /** Render do video.json do exercício (mesmo renderizador das peças): exercicio.mp4, capa e um quadro por cena. */
  private async renderExercise(studyId: string, exId: string): Promise<void> {
    const key = `${studyId}:${exId}`; const v = this.deps.video;
    if (this.academyRendering.has(key) || !v) return;
    this.academyRendering.add(key);
    let render = 'não renderizado'; const add: string[] = [];
    try {
      const ex = this.cdb.getStudy(studyId)?.exercises.find(e => e.id === exId); if (!ex) return;
      const planFile = path.join(ex.dir, 'video.json');
      const j = this.readJson(planFile);
      const plan = j.ok ? parseVideoPlan(j.value) : j;
      if (!plan.ok) render = `não renderizado: video.json ${plan.error}`;
      else {
        const out = path.join(ex.dir, 'exercicio.mp4'); const cover = path.join(ex.dir, 'capa.png');
        const rr = await v.render({ planFile, out, cover, framesDir: path.join(ex.dir, 'quadros') });
        if (!rr.ok) render = `não renderizado: ${rr.error ?? 'falhou'}`;
        else {
          const pr = await probeVideo(out, v.ffprobe);
          render = pr.ok ? `ok: ${pr.width}×${pr.height}, ${pr.duration?.toFixed(1)} s (render em ${Math.round(rr.ms / 1000)} s)` : `o MP4 não abriu: ${pr.error}`;
          if (pr.ok) {
            add.push(out); if (isFile(cover)) add.push(cover);
            // A mesma conferência das peças (movimento por cena) e um quadro do FIM de cada cena: o do meio não prova que o
            // texto chegou inteiro antes do corte (correção do Diretor, 07/11).
            const motion = await sceneMotion(out, plan.value, v.ffmpeg);
            const ends = await sceneEndFrames(out, plan.value, path.join(ex.dir, 'quadros'), v.ffmpeg);
            this.writeVideoReport(ex.dir, { ok: true, exercicio: true, plan: plan.value, probe: pr, motion, quadros: 'quadros/quadro-NN.png = meio de cada cena; quadros/fim-NN.png = 90% da cena (antes do corte)', fim: ends, cover: isFile(cover) ? cover : null });
            add.push(path.join(ex.dir, 'video-conferencia.json'));
          }
        }
      }
    } catch (err) { render = `não renderizado: ${(err as Error).message}`; }
    finally { this.academyRendering.delete(key); }
    const cur = this.cdb.getStudy(studyId)?.exercises.find(e => e.id === exId); if (!cur) return;
    const result = { ...(cur.result ?? { summary: null, learned: null, doubts: null, files: [], render: null, at: this.now() }), files: [...new Set([...add, ...(cur.result?.files ?? [])])], render };
    this.setExercise(studyId, exId, { status: 'concluido', result, error: null }, `Vídeo do exercício de ${cur.employeeName ?? 'edição'}: ${render}`);
    this.addExamples(studyId, exId);
    await this.checkStudyDone(studyId);
    this.push();
  }

  /** O exercício entregue vira exemplo nas fichas das técnicas que ele aplicou (o veredito vem na correção). */
  private addExamples(studyId: string, exId: string): void {
    const ex = this.cdb.getStudy(studyId)?.exercises.find(e => e.id === exId); if (!ex) return;
    const file = ex.result?.files.find(f => /\.mp4$/i.test(f)) ?? ex.result?.files[0] ?? null;
    for (const slug of ex.techniques) {
      const t = this.cdb.getTechnique(slug); if (!t) continue;
      const examples = [...t.examples.filter(x => !(x.studyId === studyId && x.exerciseId === exId)), { studyId, exerciseId: exId, employee: ex.employeeName, file, verdict: null, note: null }];
      this.cdb.saveTechnique({ ...t, examples: examples.slice(-20) });
    }
    this.refreshAcademyFiles();
  }

  /** Todos os exercícios terminaram (entregues ou não): a correção do Diretor começa. */
  private async checkStudyDone(studyId: string): Promise<boolean> {
    const st = this.cdb.getStudy(studyId);
    if (!st || st.status !== 'exercicios' || !st.exercises.length) return false;
    if (st.exercises.some(e => e.status === 'pendente' || e.status === 'em_producao')) return false;
    await this.startCorrection(studyId);
    return true;
  }

  private async startCorrection(studyId: string): Promise<void> {
    const st = this.cdb.getStudy(studyId); if (!st) return;
    const director = this.teamMember('direcao'); const projectId = this.projectId();
    if (!director || !projectId) { this.finishStudy(studyId, null, 'sem Diretor para corrigir: os exercícios ficam sem correção'); return; }
    const outputPath = path.join(st.folder, 'correcao.json');
    if (this.cdb.openRounds().some(r => r.kind === 'correcao' && r.outputPath.toLowerCase() === outputPath.toLowerCase())) return;
    // O Diretor vê a capa e alguns quadros dos vídeos dos exercícios (anexados), além dos arquivos na pasta.
    const images: { name: string; file: string }[] = [];
    for (const e of st.exercises) {
      const cover = path.join(e.dir, 'capa.png'); if (isFile(cover)) images.push({ name: `${e.id}-capa.png`, file: cover });
      const qd = path.join(e.dir, 'quadros');
      if (fs.existsSync(qd)) for (const f of fs.readdirSync(qd).filter(n => /\.(png|jpe?g)$/i.test(n)).sort().slice(0, 10)) images.push({ name: `${e.id}-${f}`, file: path.join(qd, f) });
    }
    let total = 0;
    const attachments = images.slice(0, 30).flatMap(i => { const b = fs.readFileSync(i.file); if (total + b.length > 8_000_000) return []; total += b.length; return [{ name: i.name, mediaType: /\.png$/i.test(i.file) ? 'image/png' : 'image/jpeg', dataBase64: b.toString('base64') }]; });
    const round = this.cdb.createRound({ kind: 'correcao', taskId: null, routineId: null, employeeId: director.id, status: 'aguardando', startedAt: this.now(), outputPath, weekStart: null, origin: 'referencia' });
    const text = correctionPrompt({
      now: this.now(), study: st.title, outputPath, dir: st.folder, lesson: st.lesson,
      exercises: st.exercises.map(e => ({ id: e.id, who: e.employeeName ?? e.role, title: e.title, dir: e.dir, status: ACADEMY_EXERCISE_STATUS_LABEL[e.status], result: e.result?.summary ?? null, files: e.result?.files ?? [], error: e.error ?? (e.result?.render && !/^ok/.test(e.result.render) ? e.result.render : null) })),
    });
    try {
      const res = await this.deps.manager.runTask({ reqId: 'content', clientId: `content:${round.id}`, text, projectId, employeeId: director.id, skill: null, plan: false, attachments, maxAttachments: attachments.length });
      this.cdb.updateRound(round.id, { taskId: res.taskId });
      this.studyUpdate(studyId, { status: 'correcao', error: null }, `Exercícios terminados: ${director.name} está corrigindo`, director.name);
    } catch (err) {
      const why = (err as Error).message;
      this.cdb.updateRound(round.id, { status: 'falhou', finishedAt: this.now(), error: `a tarefa não foi criada: ${why}` });
      this.studyUpdate(studyId, { status: 'bloqueado', error: `a correção não entrou na fila: ${why}` }, `Correção não entrou na fila: ${why}`);
    }
    this.push();
  }

  private finishStudy(studyId: string, feedback: string | null, note: string | null): void {
    const st = this.studyUpdate(studyId, { status: 'concluido', feedback, error: note }, note ? `Estudo concluído (${note})` : 'Estudo concluído: aprendizado salvo na Academia');
    if (st) this.setVideo(st.radarId, { stage: 'concluida', error: null });
    this.refreshAcademyFiles();
    if (st) this.proposeKnowledge(st);
    this.push();
  }

  /**
   * Estudo concluído → cada técnica vira uma proposta no Conhecimento da equipe, com a evidência que existe (o que foi possível
   * analisar na referência, a ficha e os exercícios corrigidos). É conclusão da equipe a partir de material externo: fica
   * "proposta" e só passa a acompanhar os pedidos quando o Chefe ativar. A mesma técnica não é proposta duas vezes.
   */
  private proposeKnowledge(st: AcademyStudy): void {
    if (!this.deps.knowledge) return;
    for (const ref of st.techniques ?? []) {
      const t = this.cdb.getTechnique(ref.slug); if (!t) continue;
      const src = t.sources.find(s => s.studyId === st.id) ?? t.sources[0] ?? null;
      const done = t.examples.filter(e => e.studyId === st.id);
      const text = [
        `${t.name}: ${t.summary}`,
        t.how.length ? `Como fazer: ${t.how.map(h => `(${h.tool}) ${h.text}`).join(' ')}` : '',
        t.pitfalls.length ? `Cuidados: ${t.pitfalls.join('; ')}` : '',
        src ? `Evidência na referência: ${src.evidence}${src.at ? ` em ${src.at}` : ''}${src.note ? ` (${src.note})` : ''}.` : '',
        done.length ? `Exercício da equipe: ${done.map(e => `${e.employee ?? 'equipe'}: ${e.verdict === 'ok' ? 'validado pelo Diretor de Vídeo' : e.verdict === 'ajustar' ? 'precisa de ajuste' : 'sem correção'}`).join('; ')}.` : 'Sem exercício produzido ainda.',
      ].filter(Boolean).join('\n');
      this.deps.knowledge.propose(`academia:${t.slug}`, {
        kind: 'procedimento', scope: { type: 'empresa', id: null }, title: `Técnica: ${t.name}`, text, origin: 'referencia',
        originNote: `Estudo da referência "${st.title}" (Academia de Vídeo). Material de estudo: não é ordem sua.`,
        evidence: [
          { kind: 'estudo', ref: st.id, label: st.title },
          ...(t.file ? [{ kind: 'arquivo' as const, ref: t.file, label: 'ficha da técnica' }] : []),
          ...done.filter(e => e.file).slice(0, 4).map(e => ({ kind: 'arquivo' as const, ref: e.file!, label: `exercício de ${e.employee ?? 'equipe'}${e.verdict ? ` (${e.verdict})` : ''}` })),
        ],
      });
    }
  }

  /** correcao.json: veredito por exercício, exemplos e armadilhas nas fichas; o estudo fica concluído. */
  private async importCorrection(round: ContentRound, o: Record<string, unknown>): Promise<void> {
    const st = this.cdb.listStudies(200).find(s => path.join(s.folder, 'correcao.json').toLowerCase() === round.outputPath.toLowerCase());
    if (!st) { this.failRound(round, 'estudo não encontrado na Academia'); return; }
    const parsed = parseCorrection(o);
    if (!parsed.ok) { this.failRound(round, parsed.error); return; }
    const p = parsed.value; const at = this.now();
    const exercises = st.exercises.map(e => { const f = p.exercises.find(x => x.id === e.id); return f ? { ...e, feedback: { verdict: f.verdict, note: f.note, at } } : e; });
    this.cdb.updateStudy(st.id, { exercises });
    for (const ts of st.techniques) {
      const t = this.cdb.getTechnique(ts.slug); if (!t) continue;
      const examples = t.examples.map(x => { if (x.studyId !== st.id) return x; const f = exercises.find(e => e.id === x.exerciseId)?.feedback; return f ? { ...x, verdict: f.verdict, note: f.note.slice(0, 300) } : x; });
      const pitfalls = [...new Set([...t.pitfalls, ...(p.techniques.find(x => x.slug === t.slug)?.pitfalls ?? [])])].slice(0, 12);
      this.cdb.saveTechnique({ ...t, examples, pitfalls });
    }
    this.cdb.updateRound(round.id, { status: 'concluida', finishedAt: this.now(), summary: p.summary });
    const ok = p.exercises.filter(x => x.verdict === 'ok').length;
    const md = path.join(st.folder, 'correcao.md');
    const who = (round.employeeId && this.deps.store.getEmployee(round.employeeId)?.name) || 'Diretor';
    this.videoEvent(st.radarId, `${who} corrigiu: ${ok} aprovado(s), ${p.exercises.length - ok} para ajustar`, who);
    // Exercício pedido de novo enquanto esta correção esperava na fila: o estudo segue até ele chegar (e ganha outra correção).
    const open = exercises.filter(e => e.status === 'pendente' || e.status === 'em_producao');
    if (open.length) { this.studyUpdate(st.id, { status: 'exercicios', feedback: isFile(md) ? md : null }, `Correção parcial: falta ${open.map(e => e.employeeName ?? e.role).join(', ')}`); this.refreshAcademyFiles(); this.push(); return; }
    this.finishStudy(st.id, isFile(md) ? md : null, null);
  }

  /** Acompanha a aula (síntese → exercícios), renders interrompidos e o fim dos exercícios. */
  private async syncStudies(): Promise<boolean> {
    let changed = false;
    for (const st of this.cdb.listStudies(60)) {
      if (st.status === 'aula') {
        const pending = st.exercises.some(e => e.status === 'pendente');
        if (!st.meetingId) { if (pending && this.now() - st.updatedAt > 60_000) { await this.dispatchExercises(st.id); changed = true; } continue; }
        const synth = (this.deps.meetings?.messages(st.meetingId) ?? []).filter(x => x.phase === 'synthesis' && x.kind === 'speech' && !x.partial).pop();
        const opened = [...st.history].reverse().find(h => /^Aula aberta/.test(h.text))?.at ?? st.updatedAt;
        if (synth) {
          const file = path.join(st.folder, 'aula-sintese.md');
          try { fs.writeFileSync(file, `# Síntese da aula\n\n${synth.authorName} · ${new Date(synth.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n\n${synth.text}\n`, 'utf8'); } catch (err) { this.deps.log.warn('academia: síntese da aula não foi gravada', err); }
          this.studyUpdate(st.id, { lessonSynthesis: isFile(file) ? file : null }, `Aula encerrada (síntese de ${synth.authorName})`, synth.authorName);
          await this.dispatchExercises(st.id); changed = true;
        } else if (this.now() - opened > LESSON_TIMEOUT_MS) {
          this.studyUpdate(st.id, {}, `A aula passou de ${Math.round(LESSON_TIMEOUT_MS / 60_000)} min sem síntese: os exercícios seguem com a lição escrita`);
          await this.dispatchExercises(st.id); changed = true;
        }
        continue;
      }
      if (st.status === 'exercicios') {
        for (const e of st.exercises) if (e.status === 'em_producao' && e.result?.render === 'renderizando' && !this.academyRendering.has(`${st.id}:${e.id}`)) { void this.renderExercise(st.id, e.id); changed = true; }
        if (await this.checkStudyDone(st.id)) changed = true;
      }
    }
    return changed;
  }

  /** "Pedir de novo": exercício que não deu certo, ou a etapa parada do estudo (aula sem exercícios, correção que falhou). */
  private async retryAcademy(studyId: string, exerciseId: string | null): Promise<ContentState> {
    const st = this.cdb.getStudy(studyId); if (!st) throw new Error('estudo não encontrado');
    if (exerciseId) {
      const ex = st.exercises.find(e => e.id === exerciseId); if (!ex) throw new Error('exercício não encontrado');
      if (ex.status !== 'falhou') throw new Error('Só dá para pedir de novo um exercício que não deu certo.');
      const emp = (ex.employeeId ? this.deps.store.getEmployee(ex.employeeId) : null) ?? this.teamMember(ex.role, ex.profileId);
      this.setExercise(studyId, exerciseId, { status: 'pendente', error: null, result: null, feedback: null, employeeId: emp?.id ?? null, employeeName: emp?.name ?? null }, `Chefe pediu de novo o exercício "${ex.title}"`, 'Chefe');
      await this.dispatchExercises(studyId, exerciseId);
    } else if (!st.exercises.length) {
      this.studyUpdate(studyId, { status: 'analisando', error: null }, 'Chefe pediu o estudo de novo', 'Chefe');
      return this.retryVideo(st.radarId, null);
    } else if (st.exercises.some(e => e.status === 'pendente')) {
      await this.dispatchExercises(studyId);
    } else {
      this.studyUpdate(studyId, { status: 'exercicios', error: null }, 'Chefe pediu a correção de novo', 'Chefe');
      await this.checkStudyDone(studyId);
    }
    this.push();
    return this.state();
  }

  /** Falha de uma rodada: o cartão e o estudo dizem o motivo (antes a análise que falhava deixava o cartão em "Em análise"). */
  private afterRoundFail(round: ContentRound, why: string): void {
    const dir = path.dirname(round.outputPath).toLowerCase();
    if (round.kind === 'plano') {
      const req = this.cdb.listRequests(60).find(r => r.plan?.roundId === round.id);
      if (req?.plan) this.cdb.updateRequest(req.id, { plan: { ...req.plan, status: 'falhou', error: why, at: this.now() } });
      return;
    }
    if (round.kind === 'etapa') {
      const hit = this.itemByStepRound(round.id); if (!hit) return;
      this.setStep(hit.item.id, hit.index, { status: 'falhou', error: why, doneAt: this.now() });
      this.cdb.updateItem(hit.item.id, { nextStep: `a etapa ${PIECE_STEP_LABEL[hit.step.key].toLowerCase()} não deu certo: ${why.slice(0, 200)}. Use "Tentar a etapa de novo".` }, { action: 'etapa falhou', detail: `${PIECE_STEP_LABEL[hit.step.key]}: ${why.slice(0, 200)}`, origin: 'sistema' });
      return;
    }
    if (round.kind === 'video' || round.kind === 'estudo') {
      const r = this.cdb.listRadar(400).find(x => x.video && x.video.dir.toLowerCase() === dir);
      if (!r?.video) return;
      if (r.video.stage === 'analisando' || r.video.stage === 'inspecionando') { this.setVideo(r.id, { stage: 'bloqueada', error: `a análise falhou: ${why}` }); this.videoEvent(r.id, `Análise falhou: ${why}`, null); }
      if (round.kind === 'estudo' && r.video.studyId) this.studyUpdate(r.video.studyId, { status: 'bloqueado', error: `o estudo falhou: ${why}` });
      return;
    }
    if (round.kind === 'exercicio') {
      const hit = this.exerciseByDir(path.dirname(round.outputPath)); if (!hit) return;
      this.setExercise(hit.study.id, hit.ex.id, { status: 'falhou', error: why }, `Exercício de ${hit.ex.employeeName ?? 'equipe'} não deu certo: ${why}`);
      void this.checkStudyDone(hit.study.id).then(ch => { if (ch) this.push(); });
      return;
    }
    if (round.kind === 'correcao') {
      const st = this.cdb.listStudies(200).find(s => s.folder.toLowerCase() === dir);
      if (st) this.studyUpdate(st.id, { status: 'bloqueado', error: `a correção falhou: ${why}` }, `Correção falhou: ${why}`);
    }
  }

  private failRound(round: ContentRound, why: string): void {
    this.cdb.updateRound(round.id, { status: 'falhou', finishedAt: this.now(), error: why });
    try { this.afterRoundFail(round, why); } catch (err) { this.deps.log.warn('conteúdo: falha da rodada não foi registrada no cartão', err); }
  }

  private readJson(file: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    if (!fs.existsSync(file)) return { ok: false, error: `o funcionário terminou sem gravar ${path.basename(file)}` };
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v as Record<string, unknown> } : { ok: false, error: `${path.basename(file)} não é um objeto JSON` };
    } catch (err) { return { ok: false, error: `${path.basename(file)} com JSON inválido: ${(err as Error).message.slice(0, 120)}` }; }
  }

  private async importRound(round: ContentRound, t: Task): Promise<void> {
    if (t.status !== 'done') { this.failRound(round, `a tarefa terminou como ${t.status}${t.errors.length ? `: ${t.errors[t.errors.length - 1].slice(0, 200)}` : ''}`); return; }
    const j = this.readJson(round.outputPath);
    if (!j.ok) { this.failRound(round, j.error); return; }
    const o = j.value;
    if (round.kind === 'referencia') { await this.importReference(round, o); return; }
    if (round.kind === 'video') { await this.importVideoAnalysis(round, o); return; }
    if (round.kind === 'estudo') { await this.importStudy(round, o); return; }
    if (round.kind === 'exercicio') { await this.importExercise(round, o); return; }
    if (round.kind === 'correcao') { await this.importCorrection(round, o); return; }
    if (round.kind === 'plano') { await this.importPlan(round, o); return; }
    if (round.kind === 'etapa') { await this.importStep(round, o); return; }
    if (round.kind === 'radar') {
      const list = Array.isArray(o.opportunities) ? o.opportunities : [];
      const skipped: string[] = []; const notes: string[] = []; let imported = 0; let updated = 0; const seenPriority = new Set<number>(); const seenKeys = new Set<string>();
      for (const [i, raw] of list.entries()) {
        const parsed = parseOpportunity((raw ?? {}) as Record<string, unknown>);
        if (!parsed.ok) { skipped.push(`item ${i + 1}: ${parsed.error}`); continue; }
        const v = parsed.value;
        if (v.kind === 'chefe') v.kind = 'achado'; // referência do Chefe só entra pelo envio dele
        if (v.postKey && seenKeys.has(v.postKey)) { skipped.push(`item ${i + 1}: repetido na mesma rodada (${v.sourceUrl})`); continue; }
        if (v.postKey) seenKeys.add(v.postKey);
        if (v.priority && seenPriority.has(v.priority)) v.priority = null; if (v.priority) seenPriority.add(v.priority);
        // Destino fora do foco: a referência fica no Radar como ideia, sem destino (pesquisar não libera produção na rede).
        if (v.slot && !this.active(v.slot)) { notes.push(`"${v.subject.slice(0, 60)}": destino ${slotDef(v.slot).label} pausado, ficou sem destino`); v.slot = null; v.priority = null; }
        // Mesmo post (URL normalizada ou id): a nova coleta atualiza a referência existente, sem cartão repetido.
        const prev = v.postKey ? this.cdb.radarByKey(v.postKey) : null;
        if (prev) {
          this.cdb.updateRadar(prev.id, { ...v, kind: prev.kind === 'chefe' ? 'chefe' : v.kind, roundId: round.id, slot: v.slot ?? prev.slot, priority: prev.status === 'nova' ? v.priority : prev.priority, files: [...new Set([...prev.files, ...v.files])], note: prev.note });
          updated++;
          continue;
        }
        this.cdb.insertRadar({ roundId: round.id, ...v });
        imported++;
      }
      const sources = parseSources(o.sources, this.now());
      if (sources.length) {
        this.cdb.setRoundSources(round.id, sources);
        const f = this.focus();
        // Fonte ligada que esta rodada não pesquisou não guarda o aviso da rodada anterior (06/11: o Instagram ficou mostrando
        // "precisa do login do Chefe" das 10:34 depois de a pesquisa já funcionar, e a equipe repetia isso nas reuniões).
        const when = new Date(this.now()).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        writeFocus(this.deps.db, { ...f, sources: f.sources.map(s => {
          const n = sources.find(x => x.source === s.source);
          if (n) return { ...s, access: n.access, detail: n.detail, at: n.at };
          return s.enabled ? { ...s, access: 'nao_verificada' as const, detail: `não pesquisada na rodada de ${when}`, at: this.now() } : s;
        }) });
      }
      const nothing = o.nothingRelevant === true || imported + updated === 0;
      const tail = [updated ? `${updated} referência(s) já registradas foram atualizadas (sem cartão novo)` : null, notes.length ? notes.join('; ') : null, skipped.length ? `ignorados: ${skipped.join('; ')}` : null].filter(Boolean).join(' · ') || null;
      const by = round.origin === 'sessao' ? 'Pesquisa feita pela sessão do Claude Code a pedido do Chefe (fora da fila da equipe). ' : '';
      this.cdb.updateRound(round.id, { status: nothing ? 'vazia' : 'concluida', finishedAt: this.now(), coverage: txt(`${by}${txt(o.coverage, 3000) ?? ''}`, 3200), summary: txt(o.summary, 2000), error: tail });
      if (!nothing) {
        await this.fillRequestsFromRadar(round.id);
        // Rodada da sessão não puxa produção sozinha (o piloto escolhe à mão); a da equipe puxa até a capacidade.
        if (round.origin !== 'sessao' && this.focus().activeSlots) { const picked = await this.autoSelect(round.id); if (picked.length) this.deps.log.info(`conteúdo: ${picked.length} prioridade(s) do Radar foram para a produção`); }
      }
      return;
    }
    if (round.kind === 'semana') {
      const list = Array.isArray(o.items) ? o.items : [];
      if (!list.length) { this.failRound(round, 'calendario.json sem itens'); return; }
      const skipped: string[] = []; let imported = 0;
      const ws = isDate(o.weekStart) ? o.weekStart : round.weekStart;
      // Novo calendário da mesma semana substitui só o que ainda estava planejado e intocado no anterior.
      const stale = this.cdb.listItems(500).filter(i => i.weekStart === ws && i.status === 'planejada' && i.updatedAt === i.createdAt);
      for (const [i, raw] of list.entries()) {
        const x = raw as Record<string, unknown>;
        const title = txt(x.title, 200);
        if (!title) { skipped.push(`item ${i + 1}: sem título`); continue; }
        const slot = isSocialSlot(x.slot) ? x.slot : null;
        if (x.slot != null && !slot) { skipped.push(`item ${i + 1}: conta "${String(x.slot)}" desconhecida`); continue; }
        const role = String(x.owner ?? 'criador') as ContentRole;
        const owner = this.teamMember(['coordenador', 'pesquisador', 'criador', 'revisor'].includes(role) ? role : 'criador');
        const skill = typeof x.skill === 'string' && (CONTENT_SPECIALTIES as readonly string[]).concat('milweb-video-studio').includes(x.skill) ? x.skill : this.skillFor(slot);
        const material = ['pronto', 'gravar', 'editar', 'nao_precisa'].includes(String(x.material)) ? x.material as ContentItem['material'] : 'nao_precisa';
        const radarId = typeof x.radarId === 'string' && this.cdb.getRadar(x.radarId) ? x.radarId : null;
        const item = this.cdb.insertItem({
          pausedReason: slot && !this.active(slot) ? this.focus().reason : null, hypothesis: txt(x.hypothesis, 600), referenceIds: radarId ? [radarId] : [],
          weekStart: ws, baseId: txt(x.baseId, 40) ? `${round.id.slice(0, 8)}:${txt(x.baseId, 40)}` : null, baseTitle: txt(x.baseTitle, 200), date: isDate(x.date) ? x.date : null, time: isTime(x.time) ? x.time : null, slot,
          profileId: slot ? (this.deps.social.account(slot).profileIds[0] ?? slotDef(slot).defaultProfileIds[0] ?? null) : null,
          format: txt(x.format, 80) ?? '', objective: txt(x.objective, 400) ?? '', title, brief: txt(x.brief) ?? '',
          sources: Array.isArray(x.sources) ? x.sources.filter((s): s is string => typeof s === 'string').slice(0, 20) : [],
          files: Array.isArray(x.files) ? x.files.filter((s): s is string => typeof s === 'string').slice(0, 30) : [], material, ownerId: owner?.id ?? null, skill,
          reviewCriteria: txt(x.reviewCriteria, 600) ?? '', status: 'planejada', taskId: null, reviewTaskId: null, radarId, folder: null, deliverable: null, checks: [], review: null,
          nextStep: material === 'gravar' ? 'gravar o material antes de produzir' : material === 'editar' ? 'editar o material antes de produzir' : null, approvalId: null, publication: null,
        });
        if (radarId) this.cdb.setRadarStatus(radarId, 'virou_peca', item.id);
        imported++;
      }
      if (imported) for (const s of stale) this.cdb.updateItem(s.id, { status: 'descartada', nextStep: 'substituída por um calendário mais novo da mesma semana' });
      this.cdb.updateRound(round.id, { status: imported ? 'concluida' : 'falhou', finishedAt: this.now(), summary: [txt(o.summary, 1500), txt(o.capacity, 500) ? `Capacidade: ${txt(o.capacity, 500)}` : null].filter(Boolean).join(' · ') || null, error: skipped.length ? `ignorados: ${skipped.join('; ')}` : imported ? null : 'nenhum item válido' });
      // Pedido do Chefe (02/11/2026): a equipe produz sozinha. Calendário pronto = a semana entra na fila da criação e da revisão.
      if (imported) { try { await this.produceWeek(ws, true); } catch (err) { this.deps.log.warn(`conteúdo: a produção automática da semana não começou (${(err as Error).message})`); } }
      return;
    }
    if (round.kind === 'analise') {
      const arr = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map(s => s.slice(0, 600)).slice(0, 12) : []);
      const nt = o.nextTest as Record<string, unknown> | null | undefined;
      const a: ContentAnalysis = {
        roundId: round.id, weekStart: round.weekStart, observed: arr(o.observed), promising: arr(o.promising), adjust: arr(o.adjust), limits: arr(o.limits), at: this.now(),
        nextTest: nt && txt(nt.hypothesis) ? { hypothesis: txt(nt.hypothesis, 600)!, change: txt(nt.change, 600) ?? '', metric: txt(nt.metric, 200) ?? '', criterion: txt(nt.criterion, 600) ?? '' } : null,
      };
      if (!a.observed.length && !a.limits.length) { this.failRound(round, 'analise.json sem observações nem limites'); return; }
      this.cdb.saveAnalysis(a);
      this.cdb.updateRound(round.id, { status: 'concluida', finishedAt: this.now(), summary: a.observed[0] ?? a.limits[0] ?? null });
      return;
    }
    // transcrição de captura
    const ctx = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(round.outputPath), 'contexto.json'), 'utf8')) as { itemId: string | null; slot: SocialSlotId | null }; } catch { return { itemId: null, slot: null }; } })();
    const rows = Array.isArray(o.rows) ? o.rows : [];
    const img = fs.readdirSync(path.dirname(round.outputPath)).find(f => /^captura\./.test(f));
    let n = 0;
    for (const raw of rows) {
      const x = raw as Record<string, unknown>;
      const metric = txt(x.metric, 120); if (!metric) continue;
      const value = typeof x.value === 'number' && Number.isFinite(x.value) ? x.value : null;
      this.cdb.insertResult({ itemId: ctx.itemId && this.cdb.getItem(ctx.itemId) ? ctx.itemId : null, slot: isSocialSlot(x.slot) ? x.slot : ctx.slot, postUrl: txt(x.postUrl, 600), metric, value, unit: txt(x.unit, 30), periodStart: txt(x.periodStart, 30), periodEnd: txt(x.periodEnd, 30), ageHours: null, denominator: null, source: 'captura', evidencePath: img ? path.join(path.dirname(round.outputPath), img) : null, uncertain: true, hypothesis: null, note: txt(x.note, 400) });
      n++;
    }
    this.cdb.updateRound(round.id, { status: n ? 'concluida' : 'vazia', finishedAt: this.now(), summary: n ? `${n} valor(es) transcritos, a conferir` : o.legible === false ? 'captura ilegível' : 'nenhum valor legível' });
  }

  private async importPiece(item: ContentItem, t: Task): Promise<void> {
    if (t.status !== 'done') {
      const why = t.errors.length ? t.errors[t.errors.length - 1].slice(0, 240) : t.status === 'interrupted' ? 'interrompida' : t.status;
      const fix = /Sem resposta da API|ENOTFOUND|conex/i.test(why) ? 'a conexão com a API ficou fora por muito tempo; quando a internet estiver normal, clique em Produzir de novo (o que já foi gravado na pasta continua lá)'
        : /Tempo máximo/i.test(why) ? 'a produção passou do tempo máximo duas vezes; clique em Produzir de novo para continuar de onde parou (o que já foi gravado na pasta continua lá)'
        : /limit|limite|usage|rate/i.test(why) ? 'espere o limite de uso liberar e clique em Produzir de novo' : /permiss|autoriza/i.test(why) ? 'responda o pedido de autorização na Mesa e produza de novo' : 'clique em Produzir de novo (o que já foi gravado na pasta continua lá)';
      this.cdb.updateItem(item.id, { status: 'falhou', nextStep: `a produção terminou como ${t.status} (${why}); próximo passo: ${fix}` });
      return;
    }
    const folder = item.folder!;
    const j = this.readJson(path.join(folder, 'entrega.json'));
    const parsed = j.ok ? parseEntrega(j.value) : j;
    if (!parsed.ok) {
      this.cdb.updateItem(item.id, { status: 'ajustar', checks: [{ name: 'Entrega', ok: false, detail: parsed.error }], nextStep: 'a entrega veio sem o entrega.json válido: produza de novo' });
      return;
    }
    const e = parsed.value;
    const network = item.slot ? slotDef(item.slot).network : e.network;
    const extra: ContentCheck[] = [];
    if (network === 'pinterest') {
      const html = path.join(folder, 'pin.html');
      if (fs.existsSync(html) && this.deps.render) {
        try { await this.deps.render(html, path.join(folder, 'pin.png'), 1000, 1500); }
        catch (err) { extra.push({ name: 'Renderização do Pin', ok: false, detail: (err as Error).message }); }
      } else if (!fs.existsSync(html)) extra.push({ name: 'Renderização do Pin', ok: false, detail: 'pin.html não encontrado' });
    }
    // Carrossel: a HQ desenha os slides a partir do carrossel.json (o funcionário não roda nada). As imagens são a peça.
    let slides: string[] = [];
    const carFile = path.join(folder, 'carrossel.json');
    if (fs.existsSync(carFile) && this.deps.slideRender && this.deps.carouselFontsDir) {
      const j = this.readJson(carFile);
      const parsed = j.ok ? parseCarousel(j.value) : j;
      if (!parsed.ok) extra.push({ name: 'Imagens do carrossel', ok: false, detail: `carrossel.json inválido: ${parsed.error}` });
      else {
        const brand: CarouselBrand = item.profileId === 'tuco-dev' || item.profileId === 'aurora' ? item.profileId : parsed.value.marca ?? (item.slot === 'instagram-tuco' ? 'tuco-dev' : 'aurora');
        const root = this.folder();
        const mascotFile = root ? path.join(root, 'marcas', 'tuco-dev', 'x-conta', 'mascote-original.png') : null;
        try {
          const r = await renderCarousel({ folder, carousel: parsed.value, brand, render: this.deps.slideRender, fontsDir: this.deps.carouselFontsDir, mascotFile, root: root ?? folder });
          slides = r.files;
          extra.push({ name: 'Imagens do carrossel', ok: r.errors.length === 0 && r.files.length > 0, detail: r.errors.length ? r.errors.join('; ') : `${r.files.length} slides 1080×1350 em slides/ (identidade ${brand === 'tuco-dev' ? 'Tuco Dev' : 'Aurora'})` });
        } catch (err) { extra.push({ name: 'Imagens do carrossel', ok: false, detail: (err as Error).message }); }
      }
    } else if (isCarousel(item.format, network)) {
      // Carrossel que reaproveita imagens já exportadas (listadas na entrega) não precisa de carrossel.json.
      const reused = e.files.filter(f => /\.(png|jpe?g|webp)$/i.test(f)).filter(f => [path.isAbsolute(f) ? f : path.join(folder, f), this.folder() ? path.join(this.folder()!, f) : ''].some(x => x && fs.existsSync(x)));
      if (reused.length >= 2) extra.push({ name: 'Imagens do carrossel', ok: true, detail: `${reused.length} imagens já exportadas, reaproveitadas (listadas na entrega)` });
      else extra.push({ name: 'Imagens do carrossel', ok: false, detail: fs.existsSync(carFile) ? 'o gerador de slides não está disponível nesta HQ' : 'carrossel.json não encontrado: sem ele a HQ não desenha as imagens' });
    }
    // Vídeo: a HQ renderiza o video.json (sequência de cenas) com o Remotion do Chefe e confere o MP4 de verdade.
    const planFile = path.join(folder, 'video.json');
    if (requiredDelivery(item.format, network) === 'vídeo' && fs.existsSync(planFile)) {
      this.rendering.add(item.id); this.push();
      try { extra.push(...await this.renderVideo(folder, planFile)); } finally { this.rendering.delete(item.id); }
    }
    else if (requiredDelivery(item.format, network) === 'vídeo') extra.push({ name: 'Direção do vídeo', ok: false, detail: 'video.json não encontrado: sem a sequência de cenas a HQ não renderiza (roteiro sozinho não é vídeo)' });
    const checks = [...extra, ...await checkPiece(item, e, folder, this.deps.fetch ?? fetch, this.folder())];
    const main = slides[0] ?? ['peca.md', ...e.files].map(f => path.isAbsolute(f) ? f : path.join(folder, f)).find(f => fs.existsSync(f)) ?? null;
    // "Terminei" não basta: a HQ confere no disco o que o formato exige (texto, imagens exportadas, Pin ou vídeo).
    const need = this.deliveryCheck({ ...item, folder }, e);
    checks.unshift({ name: 'Entrega exigida', ok: need.missing.length === 0, detail: need.missing.length ? `${need.required}: falta ${need.missing.join('; ')}${need.have.length ? ` (existe: ${need.have.join(', ')})` : ''}` : `${need.required}: ${need.have.join(', ')}` });
    if (need.missing.length) {
      // Entrega incompleta não chega ao Chefe como "pronta". Se a equipe resolve sozinha, quem produziu recebe UMA correção
      // automática com o erro exato; se falta algo que só o Chefe faz (o take dele) ou a correção já foi tentada, a peça fica
      // "parcial" com uma decisão curta para ele. Nunca vira laço nem cartão repetido.
      const fix = deliveryFix(need, checks);
      const prod = item.taskId ? this.deps.store.getTask(item.taskId) : null;
      const already = hadAutoRound(prod?.prompt);
      this.cdb.updateItem(item.id, { status: 'parcial', checks, deliverable: main, nextStep: fix.chefeOnly ? fix.decision : already ? `a correção automática não resolveu: ${fix.problem}. Decida: produzir de novo com uma observação sua, editar à mão ou descartar.` : `entrega parcial: ${fix.problem}. A HQ devolveu para quem produziu corrigir.` }, { action: 'conferência da entrega', detail: fix.problem.slice(0, 300), origin: 'conferência' });
      if (!fix.chefeOnly && !already) {
        try {
          await this.produce(item.id, fix.note, 'conferencia');
          // a conferência que mandou corrigir continua visível na peça enquanto a correção roda
          this.cdb.updateItem(item.id, { checks, nextStep: `entrega parcial (${fix.problem}): quem produziu está corrigindo uma vez sozinho; depois a HQ confere de novo` });
          this.deps.log.info(`conteúdo: "${item.title}" volta para quem produziu: ${fix.problem}`);
        } catch (err) {
          this.cdb.updateItem(item.id, { nextStep: `entrega parcial (${fix.problem}); a correção automática não começou (${(err as Error).message}). Decida: produzir de novo, editar à mão ou descartar.` });
          this.deps.log.warn(`conteúdo: a correção automática de "${item.title}" não começou (${(err as Error).message})`);
        }
      }
      this.push();
      return;
    }
    const updated = this.cdb.updateItem(item.id, { status: 'revisar', checks, deliverable: main, nextStep: e.nextStep ?? (e.needs.length ? `falta: ${e.needs.join('; ')}` : 'revisão') })!;
    // Um passo automático: a revisão entra na fila. Depois disso a decisão é do Chefe.
    try { await this.review(updated.id); } catch (err) { this.deps.log.warn(`conteúdo: revisão automática não entrou na fila (${(err as Error).message})`); }
  }

  /**
   * Render e conferência do vídeo: video.mp4, capa.png e quadros/ (um quadro por cena, para a revisão). Reaproveita o MP4 quando
   * ele é mais novo que o video.json. Grava video-conferencia.json (lido pela conferência da entrega e pelo revisor).
   */
  async renderVideo(folder: string, planFile: string): Promise<ContentCheck[]> {
    const checks: ContentCheck[] = [];
    const j = this.readJson(planFile);
    const plan = j.ok ? parseVideoPlan(j.value) : j;
    if (!plan.ok) { checks.push({ name: 'Direção do vídeo', ok: false, detail: `video.json: ${plan.error}` }); return checks; }
    let p = plan.value;
    checks.push({ name: 'Direção do vídeo', ok: true, detail: `${p.cenas.length} cenas, ${p.duracao} s planejados (${p.cenas.map(c => c.tipo).join(' → ')})${plan.warnings.length ? `; atenção: ${plan.warnings.join('; ')}` : ''}` });
    const out = path.join(folder, 'video.mp4'); const cover = path.join(folder, 'capa.png'); const frames = path.join(folder, 'quadros');
    const v = this.deps.video;
    // Gravações do site (cena "captura"): com gravacoes.json na pasta, a HQ grava o que falta antes do render.
    const recFile = path.join(folder, 'gravacoes.json');
    if (p.cenas.some(c => c.tipo === 'captura') && isFile(recFile)) {
      if (!v?.record) checks.push({ name: 'Gravações do site', ok: false, detail: 'o gravador de site não está disponível nesta HQ' });
      else {
        const rec = await v.record({ file: recFile });
        checks.push({ name: 'Gravações do site', ok: rec.ok, detail: rec.ok ? (rec.recorded.length ? `${rec.recorded.map(r => `${r.arquivo} (${r.segundos.toFixed(1).replace('.', ',')} s)`).join(', ')} gravado(s) pela HQ em ${Math.round(rec.ms / 1000)} s` : 'gravações já estavam prontas') : `gravacoes.json: ${rec.error}` });
      }
    }
    const missing = missingCaptures(folder, p);
    if (missing.length) {
      checks.push({ name: 'Gravações das capturas', ok: false, detail: `faltam ${missing.join(', ')} na pasta da peça. ${isFile(recFile) ? 'O gravacoes.json não gerou esses arquivos: confira os nomes e os passos.' : 'Gravação de site: escreva gravacoes.json (equipe/funcoes/video.md, "Gravar o site") que a HQ grava. Take seu (rosto, mãos, tela do celular): o Chefe precisa gravar e deixar o arquivo com esse nome.'}` });
      this.writeVideoReport(folder, { ok: false, error: `faltam as gravações: ${missing.join(', ')}`, plan: p });
      return checks;
    }
    const fresh = isFile(out) && fs.statSync(out).mtimeMs >= Math.max(fs.statSync(planFile).mtimeMs, newestCapture(folder, p));
    let render: { ok: boolean; error: string | null; ms: number } = { ok: fresh, error: null, ms: 0 };
    if (!fresh && isFile(out)) {
      // Versão anterior preservada (o Chefe compara e comenta): versoes/<data-hora>/video.mp4, capa e quadros.
      const stamp = new Date(this.now()).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16).replace(' ', '-').replace(':', '');
      let keep = path.join(folder, 'versoes', stamp); let k = 2; while (fs.existsSync(keep)) keep = `${path.join(folder, 'versoes', stamp)}-${k++}`;
      fs.mkdirSync(keep, { recursive: true });
      for (const f of ['video.mp4', 'video-com-audio.mp4', 'capa.png', 'video-conferencia.json', 'quadros']) { const src = path.join(folder, f); if (fs.existsSync(src)) fs.renameSync(src, path.join(keep, f)); }
    }
    if (!fresh) {
      if (!v) { checks.push({ name: 'Render do vídeo', ok: false, detail: 'renderizador indisponível nesta HQ (projeto Remotion com scripts/render-cenas.mjs não encontrado)' }); this.writeVideoReport(folder, { ok: false, error: 'renderizador indisponível', plan: p }); return checks; }
      render = await v.render({ planFile, out, cover, framesDir: frames });
      // A narração (audio.voz = "gerar") pode alongar cenas para a fala caber: o render regrava o video.json; vale o novo.
      const again = this.readJson(planFile); const re = again.ok ? parseVideoPlan(again.value) : null;
      if (re?.ok && re.value.duracao !== p.duracao) {
        checks.push({ name: 'Tempo da narração', ok: true, detail: `cenas alongadas para a fala caber: ${p.duracao} s → ${re.value.duracao} s (video.json atualizado pela HQ; a fala fica em narracao/voz.wav)` });
        p = re.value;
      }
    }
    checks.push({ name: 'Render do vídeo', ok: render.ok, detail: render.ok ? (fresh ? 'video.mp4 já estava renderizado a partir deste video.json' : `renderizado em ${Math.round(render.ms / 1000)} s`) : render.error ?? 'falhou' });
    if (!render.ok) { this.writeVideoReport(folder, { ok: false, error: render.error, plan: p }); return checks; }
    const probe = await probeVideo(out, v?.ffprobe);
    const fmtOk = probe.ok && probe.width === p.largura && probe.height === p.altura;
    const durOk = probe.ok && probe.duration != null && Math.abs(probe.duration - p.duracao) <= 1.5;
    checks.push({ name: 'Vídeo abre', ok: probe.ok, detail: probe.ok ? `${probe.width}×${probe.height}, ${probe.duration?.toFixed(1)} s, ${probe.vcodec}${probe.audio ? ', com áudio' : ', sem faixa de áudio'}` : probe.error ?? 'não abriu' });
    if (probe.ok) checks.push({ name: 'Formato planejado', ok: fmtOk && durOk, detail: `planejado ${p.largura}×${p.altura} e ${p.duracao} s; entregue ${probe.width}×${probe.height} e ${probe.duration?.toFixed(1)} s` });
    const motion = probe.ok ? await sceneMotion(out, p, v?.ffmpeg) : [];
    const still = motion.filter(m => m.still && m.tipo !== 'encerramento');
    if (motion.length) checks.push({ name: 'Movimento por cena', ok: still.length === 0, detail: motion.map(m => `${m.id}: ${m.motion == null ? '?' : `${(m.motion * 100).toFixed(1)}%`}${m.still ? ' (parada)' : ''}`).join(' · ') });
    const mix = probe.ok && isFile(path.join(folder, 'audio-referencia.json')) ? await this.mixAudio(folder, out) : null;
    if (p.audio.provisorio) checks.push(mix?.ok
      ? { name: 'Áudio final', ok: true, detail: 'o som é o áudio da referência que o Chefe pediu (video-com-audio.mp4); o video.mp4 fica sem ele. Publicar com o áudio de terceiros é decisão dele na aprovação.' }
      : { name: 'Áudio final', ok: false, detail: `áudio provisório${p.audio.observacao ? `: ${p.audio.observacao}` : ''}` });
    if (mix) checks.push(mix);
    if (!isFile(cover)) checks.push({ name: 'Capa', ok: false, detail: 'capa.png não foi gerada' });
    this.writeVideoReport(folder, { ok: probe.ok && fmtOk, error: probe.ok ? (fmtOk ? null : 'formato diferente do planejado') : probe.error, plan: p, probe, motion, cover: isFile(cover) ? cover : null });
    return checks;
  }

  /**
   * Áudio de um link do pedido ("pode ser esse áudio"): a criação marca o trecho e o instante em audio-referencia.json e a HQ
   * gera video-com-audio.mp4 ao lado do video.mp4 (que fica sem o áudio de terceiros). Refaz só quando algo mudou.
   */
  private async mixAudio(folder: string, video: string): Promise<ContentCheck> {
    const name = 'Áudio da referência';
    const planFile = path.join(folder, 'audio-referencia.json'); const out = path.join(folder, 'video-com-audio.mp4');
    const j = this.readJson(planFile);
    const plan = j.ok ? parseAudioMix(j.value, folder) : j;
    if (!plan.ok) return { name, ok: false, detail: `audio-referencia.json: ${plan.error}` };
    const root = this.folder();
    if (root && !isInside(root, plan.value.arquivo)) return { name, ok: false, detail: `o áudio precisa estar na pasta de conteúdo (veio ${plan.value.arquivo})` };
    const p = plan.value;
    const what = `trecho ${p.inicio.toFixed(1).replace('.', ',')}–${p.fim != null ? `${p.fim.toFixed(1).replace('.', ',')} s` : 'fim'} entrando em ${p.entraEm.toFixed(1).replace('.', ',')} s`;
    const newest = Math.max(fs.statSync(video).mtimeMs, fs.statSync(planFile).mtimeMs);
    if (isFile(out) && fs.statSync(out).mtimeMs >= newest) return { name, ok: true, detail: `video-com-audio.mp4 já estava pronto (${what})` };
    const tools = { ffmpeg: this.deps.videoTools?.ffmpeg ?? this.deps.video?.ffmpeg ?? 'ffmpeg', ffprobe: this.deps.videoTools?.ffprobe ?? this.deps.video?.ffprobe ?? 'ffprobe' };
    const r = await mixReferenceAudio({ video, out, plan: p, tools });
    return r.ok ? { name, ok: true, detail: `video-com-audio.mp4 (${r.duration.toFixed(1).replace('.', ',')} s): ${what}. O áudio é de terceiros: publicar com ele é decisão sua; o video.mp4 fica sem ele.` } : { name, ok: false, detail: r.error };
  }

  private writeVideoReport(folder: string, r: Record<string, unknown>): void {
    try { fs.writeFileSync(path.join(folder, 'video-conferencia.json'), JSON.stringify({ ...r, at: new Date(this.now()).toISOString() }, null, 2), 'utf8'); } catch (err) { this.deps.log.warn('não gravou video-conferencia.json', err); }
  }

  /**
   * Renderizar de novo (a composição mudou, o render anterior saiu misturado): o MP4, a capa e os quadros anteriores vão para
   * versoes/<data-hora>/, a HQ renderiza o mesmo video.json, refaz a conferência e a revisão volta para a fila. A criação não
   * é acionada (nada muda no que ela escreveu).
   */
  private async rerender(id: string): Promise<ContentState & { status: ContentItem['status'] }> {
    const item = this.cdb.getItem(id); if (!item) throw new Error('peça não encontrada');
    const plan = item.folder ? path.join(item.folder, 'video.json') : null;
    if (!plan || !isFile(plan)) throw new Error('Esta peça não tem video.json: só vídeo feito pela HQ pode ser renderizado de novo.');
    if (item.status === 'em_producao') throw new Error('A peça está em produção: espere terminar.');
    if (item.deletedAt || item.archivedAt) throw new Error('A peça está na lixeira ou arquivada.');
    if (item.pausedReason || !this.active(item.slot)) throw new Error(`${this.pausedWhy(item.slot)} Nada é renderizado para este destino.`);
    const folder = item.folder!;
    const stamp = new Date(this.now()).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16).replace(' ', '-').replace(':', '');
    const keep = path.join(folder, 'versoes', stamp);
    for (const f of ['video.mp4', 'video-com-audio.mp4', 'capa.png', 'video-conferencia.json', 'quadros']) {
      const src = path.join(folder, f); if (!fs.existsSync(src)) continue;
      fs.mkdirSync(keep, { recursive: true }); fs.renameSync(src, path.join(keep, f));
    }
    this.rendering.add(id); this.push();
    let vchecks: ContentCheck[] = [];
    try { vchecks = await this.renderVideo(folder, plan); } finally { this.rendering.delete(id); }
    const need = this.deliveryCheck(item, this.entrega(item));
    const names = new Set(['Entrega exigida', ...vchecks.map(c => c.name)]);
    const checks: ContentCheck[] = [{ name: 'Entrega exigida', ok: need.missing.length === 0, detail: need.missing.length ? `${need.required}: falta ${need.missing.join('; ')}` : `${need.required}: ${need.have.join(', ')}` }, ...vchecks, ...item.checks.filter(c => !names.has(c.name))];
    const status: ContentItem['status'] = need.missing.length ? 'parcial' : 'revisar';
    const main = isFile(path.join(folder, 'video.mp4')) ? path.join(folder, 'video.mp4') : item.deliverable;
    this.cdb.updateItem(id, { status, checks, deliverable: main, review: null, reviewTaskId: null, nextStep: need.missing.length ? `render refeito, mas falta ${need.missing.join('; ')}` : 'render refeito pela HQ: a revisão confere de novo' }, { action: 'render refeito pela HQ', detail: `versão anterior em versoes/${stamp}`, origin: 'interface' });
    if (status === 'revisar') { try { await this.review(id); } catch (err) { this.deps.log.warn(`conteúdo: a revisão depois do render não entrou na fila (${(err as Error).message})`); } }
    this.push();
    return { ...this.state(), status };
  }

  private async importReview(item: ContentItem, t: Task): Promise<void> {
    if (t.status !== 'done') { this.cdb.updateItem(item.id, { reviewTaskId: null, nextStep: `a revisão terminou como ${t.status}; peça a revisão de novo` }); return; }
    const j = this.readJson(path.join(item.folder ?? '', 'revisao.json'));
    if (!j.ok) { this.cdb.updateItem(item.id, { reviewTaskId: null, nextStep: `revisão sem resultado: ${j.error}` }); return; }
    const o = j.value;
    const verdict = o.verdict === 'aprovar' ? 'aprovar' : o.verdict === 'ajustar' ? 'ajustar' : null;
    if (!verdict) { this.cdb.updateItem(item.id, { reviewTaskId: null, nextStep: 'revisao.json sem veredito (aprovar ou ajustar)' }); return; }
    const checks = Array.isArray(o.checks) ? o.checks.flatMap(c => { const x = c as Record<string, unknown>; const name = txt(x.name, 120); return name ? [{ name, ok: x.ok === true, detail: txt(x.detail, 600) ?? '' }] : []; }).slice(0, 20) : [];
    this.cdb.updateItem(item.id, {
      status: verdict === 'aprovar' ? 'revisar' : 'ajustar',
      review: { verdict, notes: txt(o.notes, 3000) ?? '', checks, employeeId: this.teamMember('revisor')?.id ?? null, at: this.now() },
      nextStep: verdict === 'aprovar' ? 'revisor aprovou: falta a sua aprovação (lote, contas e período)' : 'revisor pediu ajustes: produza de novo com a observação',
    });
    // Ajuste que a equipe resolve sozinha: a criação refaz UMA vez com as observações e a peça volta para uma revisão.
    // Se já foi a rodada automática, a peça fica em "ajustar" para o Chefe decidir (nunca vira laço).
    if (verdict === 'ajustar') {
      const prod = item.taskId ? this.deps.store.getTask(item.taskId) : null;
      const already = Boolean(prod?.prompt.includes(AUTO_REWORK_MARK));
      const notes = txt(o.notes, 2500);
      if (!already && notes) {
        try {
          await this.produce(item.id, notes, 'revisor');
          this.cdb.updateItem(item.id, { nextStep: 'revisor pediu ajustes: a criação está refazendo uma vez sozinha, e a peça volta para revisão' });
          this.deps.log.info(`conteúdo: "${item.title}" volta para a criação com as observações do revisor (rodada automática)`);
        } catch (err) { this.deps.log.warn(`conteúdo: a rodada automática de ajuste de "${item.title}" não começou (${(err as Error).message})`); }
      } else if (already) {
        this.cdb.updateItem(item.id, { nextStep: 'revisor ainda pediu ajustes depois da rodada automática: decida (produzir de novo com a sua observação, editar ou descartar)' });
      }
    }
  }

  // ------------------------------------------------------------------ navegador (porta de publicação e tarefas)
  approvalCoversNow(item: ContentItem): boolean { return this.approvalCovers(item, brtDate(this.now())); }
  getItem(id: string): ContentItem | null { return this.cdb.getItem(id); }
  contentFolder(): string | null { return this.folder(); }

  publishGate(itemId: string, slot: SocialSlotId): { ok: true; text: string; title: string | null; files: string[]; destinationUrl: string | null } | { ok: false; reason: string } {
    const item = this.cdb.getItem(itemId);
    if (!item) return { ok: false, reason: 'peça não encontrada' };
    if (item.slot !== slot) return { ok: false, reason: `a peça é de ${item.slot ?? 'nenhuma conta'}, não de ${slot}` };
    if (item.pausedReason || !this.active(slot)) return { ok: false, reason: `destino pausado pelo foco (${this.focus().reason}): nada é publicado nem agendado nele` };
    if (item.status === 'publicada' || item.status === 'agendada') return { ok: false, reason: 'a peça já foi publicada ou agendada (registro conferido)' };
    if (item.status !== 'aprovada' && item.status !== 'publicacao_pendente') return { ok: false, reason: 'a peça não está aprovada: fica em revisão até o Chefe aprovar um lote com esta conta e período' };
    if (!this.approvalCovers(item, brtDate(this.now()))) return { ok: false, reason: 'a aprovação registrada não cobre hoje, esta conta ou esta peça' };
    const e = this.entrega(item); if (!e) return { ok: false, reason: 'entrega da peça não encontrada ou inválida' };
    const net = slotDef(slot).network;
    const files = (e.files.length ? e.files : []).map(f => path.isAbsolute(f) ? f : path.join(item.folder!, f)).filter(f => fs.existsSync(f));
    if (net === 'pinterest' && fs.existsSync(path.join(item.folder!, 'pin.png'))) files.unshift(path.join(item.folder!, 'pin.png'));
    return { ok: true, text: net === 'pinterest' ? (e.description ?? e.text) : e.text, title: e.title, files: [...new Set(files)], destinationUrl: e.destinationUrl };
  }
  openAttempt(itemId: string): { clientId: string; status: string } | null {
    return (this.deps.db.prepare("SELECT client_id AS clientId, status FROM content_publish_attempts WHERE item_id=? AND status IN ('intencao','clicado','a_verificar') ORDER BY at DESC LIMIT 1").get(itemId) as { clientId: string; status: string } | undefined) ?? null;
  }
  browserIntent(itemId: string, slot: SocialSlotId, mode: 'publicar' | 'agendar', when: string | null): string {
    const n = (this.deps.db.prepare("SELECT COUNT(*) AS n FROM content_publish_attempts WHERE item_id=? AND client_id LIKE 'nav:%'").get(itemId) as { n: number }).n + 1;
    const clientId = `nav:${itemId}:${n}`;
    this.cdb.saveAttempt(clientId, itemId, slot, 'intencao', `${mode}${when ? ' ' + when : ''}`, null);
    this.cdb.updateItem(itemId, { status: 'publicacao_pendente', publication: { url: null, at: this.now(), verifiedBy: 'pendente', detail: `intenção de ${mode} registrada (${clientId}); clique final em andamento` } });
    this.push();
    return clientId;
  }
  browserClicked(itemId: string, clientId: string, signal: string): void {
    this.cdb.saveAttempt(clientId, itemId, this.cdb.getItem(itemId)?.slot ?? null, 'clicado', signal, null);
    this.cdb.updateItem(itemId, { publication: { url: null, at: this.now(), verifiedBy: 'pendente', detail: `clique final confirmado pela página (${signal}); falta conferir o post no perfil` } });
    this.push();
  }
  browserUncertain(itemId: string, clientId: string, reason: string): void {
    this.cdb.saveAttempt(clientId, itemId, this.cdb.getItem(itemId)?.slot ?? null, 'a_verificar', reason, null);
    this.cdb.updateItem(itemId, { status: 'publicacao_pendente', publication: { url: null, at: this.now(), verifiedBy: 'pendente', detail: `resultado a verificar: ${reason}. Confira o perfil antes de qualquer nova tentativa.` }, nextStep: 'resultado a verificar: conferir o perfil antes de tentar de novo' });
    this.push();
  }
  browserNotFound(itemId: string, evidence: string): void {
    const a = this.openAttempt(itemId);
    if (a) this.cdb.saveAttempt(a.clientId, itemId, this.cdb.getItem(itemId)?.slot ?? null, 'falhou', `post não apareceu no perfil (captura: ${evidence})`, null);
    this.cdb.updateItem(itemId, { status: 'aprovada', publication: null, nextStep: `conferido: o post não apareceu no perfil (captura ${path.basename(evidence)}); pode ser enviado de novo` });
    this.push();
  }
  browserPublished(itemId: string, url: string | null, detail: string, mode: 'publicar' | 'agendar'): void {
    const a = this.openAttempt(itemId);
    if (a) this.cdb.saveAttempt(a.clientId, itemId, this.cdb.getItem(itemId)?.slot ?? null, mode === 'agendar' ? 'agendado' : 'published', detail, url);
    this.cdb.updateItem(itemId, { status: mode === 'agendar' ? 'agendada' : 'publicada', publication: { url, at: this.now(), verifiedBy: 'navegador', detail }, nextStep: null });
    this.deps.audit?.({ action: mode === 'agendar' ? 'agendar (navegador)' : 'publicar (navegador)', entity: 'conteúdo', entityId: itemId, title: this.cdb.getItem(itemId)?.title ?? null, origin: 'navegador', detail: `${url ?? ''} · ${detail}` });
    this.push();
  }
  browserResult(r: { slot: SocialSlotId; itemId: string | null; postUrl: string | null; metric: string; value: number | null; unit: string | null; periodStart: string | null; periodEnd: string | null; denominator: string | null; evidencePath: string | null; note: string | null }): void {
    this.cdb.insertResult({ itemId: r.itemId && this.cdb.getItem(r.itemId) ? r.itemId : null, slot: r.slot, postUrl: r.postUrl, metric: r.metric, value: r.value, unit: r.unit, periodStart: r.periodStart, periodEnd: r.periodEnd, ageHours: null, denominator: r.denominator, source: 'navegador', evidencePath: r.evidencePath, uncertain: false, hypothesis: null, note: r.note ?? 'lido na interface do site pelo navegador da HQ' });
    this.push();
  }

  /** Tarefa de navegador para a peça: 'preparar' (até a prévia, sem publicar) ou 'publicar' (dentro da aprovação). */
  private async browserTask(id: string, kind: 'preparar' | 'publicar', clientId: string | null): Promise<unknown> {
    const item = this.cdb.getItem(id); if (!item) throw new Error('peça não encontrada');
    if (!item.slot) throw new Error('A peça não tem conta de destino.');
    if (item.pausedReason || !this.active(item.slot)) throw new Error(`${this.pausedWhy(item.slot)} Nada é preparado, publicado nem agendado neste destino.`);
    const acct = this.deps.social.account(item.slot);
    if (acct.browser?.mode !== 'navegador') throw new Error(`${acct.label} não está no modo navegador.`);
    if (acct.browser.state !== 'verificada') throw new Error(`${acct.label} precisa de login verificado no navegador da HQ (estado: ${acct.browser.state}). Use "Conectar pelo navegador" na central de Redes.`);
    const e = this.entrega(item); if (!e) throw new Error('A peça ainda não tem entrega válida.');
    if (kind === 'publicar') { const g = this.publishGate(id, item.slot); if (!g.ok) throw new Error(g.reason); if (this.openAttempt(id)) throw new Error('Há um envio anterior sem confirmação: confira o perfil primeiro.'); }
    const { projectId, employee } = this.requireReady('criador');
    const net = slotDef(item.slot).network;
    const g = this.publishGate(id, item.slot);
    const files = g.ok ? g.files : (e.files.map(f => path.isAbsolute(f) ? f : path.join(item.folder!, f)));
    const base = { item, network: net, files, text: net === 'pinterest' ? (e.description ?? e.text) : e.text, title: e.title, destinationUrl: e.destinationUrl, board: e.board };
    const text = kind === 'preparar' ? browserPreparePrompt(base) : browserPublishPrompt({ ...base, when: item.date ? `${item.date} ${item.time ?? '09:00'}` : null });
    const res = await this.deps.manager.runTask({ reqId: 'content', clientId: `content:${kind}:${id}:${clientId ?? this.now()}`, text, projectId, employeeId: employee.id, skill: item.skill, plan: false, destinationId: item.slot, profileId: item.profileId ?? undefined });
    this.cdb.updateItem(id, { nextStep: kind === 'preparar' ? `preparação no navegador na fila (tarefa ${res.taskId.slice(0, 8)})` : `publicação pelo navegador na fila (tarefa ${res.taskId.slice(0, 8)})` });
    this.push();
    return { mode: 'navegador', kind, taskId: res.taskId, duplicate: res.duplicate };
  }

  private async collectResults(slots: SocialSlotId[] | null): Promise<unknown> {
    const { projectId, employee } = this.requireReady('revisor');
    const ok = SOCIAL_SLOTS.filter(s => (!slots || slots.includes(s.slot)) && this.deps.social.account(s.slot).browser?.state === 'verificada');
    if (!ok.length) throw new Error('Nenhuma conta verificada no navegador da HQ ainda: conecte pela central de Redes.');
    const res = await this.deps.manager.runTask({ reqId: 'content', clientId: `content:coleta:${this.now()}`, text: collectPrompt({ slots: ok.map(s => ({ slot: s.slot, label: s.label })), now: this.now() }), projectId, employeeId: employee.id, skill: null, plan: false });
    this.push();
    return { taskId: res.taskId, slots: ok.map(s => s.slot) };
  }

  /** Publica pela API, sem perguntar de novo, o que estiver aprovado no lote, na data, em conta conectada com publicação de texto.
   *  Contas no navegador: cria a tarefa de publicação no horário (fila local, notebook ligado); horário vencido há mais de 2 h
   *  (HQ desligada) não publica sozinho: a peça pede reavaliação da atualidade. */
  private async autoPublish(): Promise<boolean> {
    const today = brtDate(this.now());
    let did = false;
    for (const item of this.cdb.listItems(300).filter(i => i.status === 'aprovada' && i.slot && i.date && !i.archivedAt && !i.pausedReason && this.active(i.slot))) {
      const acct = this.deps.social.account(item.slot!);
      if (acct.browser?.mode !== 'navegador') continue;
      const due = Date.parse(`${item.date}T${item.time ?? '09:00'}:00-03:00`);
      if (!Number.isFinite(due) || due > this.now()) continue;
      const key = `tarefa:${item.id}:${item.date}T${item.time ?? '09:00'}`;
      if (this.cdb.attempt(key)) continue;
      if (this.now() - due > 2 * 3_600_000) {
        this.cdb.saveAttempt(key, item.id, item.slot, 'vencido', 'horário passou com a HQ desligada', null);
        this.cdb.updateItem(item.id, { nextStep: `horário de ${item.date} ${item.time ?? '09:00'} passou sem a HQ: reavalie a atualidade e publique pelo botão (nada foi enviado)` });
        did = true; continue;
      }
      if (!this.approvalCovers(item, today) || acct.browser.state !== 'verificada') continue;
      this.cdb.saveAttempt(key, item.id, item.slot, 'tarefa', 'tarefa de publicação criada no horário', null);
      try { await this.browserTask(item.id, 'publicar', `agenda-${item.date}`); } catch (err) { this.cdb.updateItem(item.id, { nextStep: `publicação no horário não começou: ${(err as Error).message}` }); }
      did = true;
    }
    for (const item of this.cdb.listItems(300).filter(i => i.status === 'aprovada' && i.slot && i.date && i.date <= today && !i.archivedAt && !i.pausedReason && this.active(i.slot))) {
      if (!this.approvalCovers(item, today)) continue;
      const acct = this.deps.social.account(item.slot!);
      if (acct.browser?.mode === 'navegador') continue;
      if (acct.mode !== 'api' || !(acct.status === 'connected' || acct.status === 'expiring') || !acct.capabilities.publish.hqReady) continue;
      try { await this.publish(item.id, `auto-${item.id}`); did = true; } catch (err) { this.deps.log.warn(`conteúdo: publicação automática de "${item.title}" ficou pendente`, err); did = true; }
    }
    return did;
  }
}

const MEDIA_EXT = /\.(mp4|m4v|mov|webm|png|jpe?g|webp|gif|pdf|mp3|wav|m4a)$/i;
function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
function safeRead(p: string): string { try { return fs.readFileSync(p, 'utf8').slice(0, 200_000); } catch { return ''; } }
function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** O que a publicação exige pelo formato e pela rede (TikTok sem "carrossel" no formato é vídeo; roteiro não basta). */
export function requiredDelivery(format: string, network: string | null): 'texto' | 'imagens do carrossel' | 'Pin' | 'vídeo' {
  if (isCarousel(format, network) || /post de imagens|fotos/i.test(format)) return 'imagens do carrossel';
  if (network === 'pinterest' || /\bpin\b/i.test(format)) return 'Pin';
  if (/reel|v[íi]deo|short|tiktok/i.test(format) || network === 'tiktok') return 'vídeo';
  return 'texto';
}

/**
 * O que fazer com uma entrega que não tem o que o formato exige. Função pura (testada): `problem` é a frase curta do erro,
 * `note` vai para quem produziu, `chefeOnly` diz que só o Chefe resolve (o take dele) e `decision` é a decisão objetiva para ele.
 */
export function deliveryFix(need: { required: string; missing: string[]; have: string[] }, checks: ContentCheck[]): { problem: string; note: string; chefeOnly: boolean; decision: string } {
  const failing = checks.filter(c => !c.ok && c.name !== 'Entrega exigida');
  const problem = `falta ${need.missing.join('; ')}`.slice(0, 400);
  const details = failing.map(c => `${c.name}: ${c.detail}`).join(' | ').slice(0, 1500);
  const note = `A conferência da HQ não encontrou o que o formato (${need.required}) exige: ${problem}.${details ? ` Detalhes da conferência: ${details}.` : ''} Corrija e grave os arquivos na pasta da peça.`;
  // Só o Chefe resolve: o take dele (rosto, mãos, celular) ou a escolha do áudio final.
  const takes = failing.find(c => c.name === 'Gravações das capturas' && /Take seu|o Chefe precisa gravar/i.test(c.detail));
  if (takes) {
    const files = takes.detail.match(/faltam (.+?) na pasta/)?.[1] ?? 'o take';
    return { problem, note, chefeOnly: true, decision: `Falta o take que só você grava (${files}). Grave e deixe na pasta da peça com esse nome, ou peça para a equipe trocar a cena por uma gravação do site.` };
  }
  const audio = need.missing.find(m => /^áudio final/.test(m));
  if (audio) return { problem, note, chefeOnly: true, decision: `Falta decidir o ${audio}. Escolha a música (ou aprove assim) para a peça seguir.${need.missing.length > 1 ? ` Também: ${need.missing.filter(m => m !== audio).join('; ')}.` : ''}` };
  // A conferência da própria HQ não rodou (ferramenta ausente): não é erro de quem produziu; nada volta para a equipe.
  const hq = failing.find(c => /ENOENT|indispon[íi]vel|não está disponível|ffprobe-que-nao-existe/i.test(c.detail));
  if (hq) return { problem, note, chefeOnly: true, decision: `A conferência da HQ não rodou (${hq.name}: ${hq.detail.slice(0, 160)}). Nada voltou para a equipe; confira a ferramenta e peça a conferência de novo.` };
  return { problem, note, chefeOnly: false, decision: `entrega parcial: ${problem}` };
}
