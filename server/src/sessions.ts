// Gerenciador de sessões: cada sessão controlável é um processo real do Claude Code (claude-bridge).
// Regras do briefing: uma execução ativa por padrão; nunca duplicar envio; fila x interrupção explícitas;
// registrar só o que foi observado; não marcar processo morto como ativo.
import { CHANNEL_LABEL, isTeamId, teamDef, teamOfSlot, type SocialSlotId } from '@milweb-hq/protocol';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProcess, DELEGATE_TOOLS, EXEC_TOOLS, WRITE_TOOLS, initialActivity, reduceActivity, summarizeToolInput } from '@milweb-hq/claude-bridge';
import type { ActivityState, ContentBlock, InitInfo, PermissionRequest, PermissionResult, PermissionUpdate, RawEvent, ResultInfo } from '@milweb-hq/claude-bridge';
import type { AbsencePolicy, AiProviderId, Attachment, AwaySummary, ChatItem, Deliverable, EffortLevel, Employee, PendingPermission, PermissionModeOption, Project, QuestionSpec, Room, ServerMessage, Session, SkillInfo, SkillUsage, Task, TaskEvidence, TaskRunInput, TaskRunResult, Worker, WorkerPhase, WorkerStatus } from '@milweb-hq/protocol';
import { companyForAgents, DM_SESSION_NAME, isDmSession, isSocialSlot } from '@milweb-hq/protocol';
import type { ProviderCaps, Store } from './store.js';
import type { AiAdapter, TurnHandle, TurnOutcome } from './ai/types.js';
import { childEnv } from './claude-info.js';
import { claudeAccessArgs, isolatedEnv, normalizeAccess } from './access.js';
import { appearanceFor, pickDesk, pickWorkerName, ROLE_BY_KIND } from './names.js';
import { classifyProviderStop, formatBrt, NETWORK_BACKOFF_MIN, type ProviderStop } from './provider-stop.js';
import { log } from './log.js';

/** Catálogo de skills (v4), tipado pela forma: resolve a invocação pedida (origem, caminho, conteúdo para entregar ao OpenAI). */
export interface SkillResolverLike {
  resolve(invocation: string, projectId: string | null): Promise<{ info: SkillInfo; content: string | null } | null>;
}

export interface ManagerDeps {
  store: Store;
  exePath: () => string | null;
  /** true enquanto o serviço ainda inspeciona a instalação do Claude Code (tarefas ficam na fila até terminar). */
  probing?: () => boolean;
  attachmentsDir: string;
  /** Para testes: prefixo de comando (ex.: node + CLI falso). */
  commandPrefixArgs?: string[];
  extraArgs?: string[];
  /** Execuções ativas fora deste gerenciador (turnos de reunião) que contam no mesmo limite global. */
  externalActive?: () => number;
  /** Adaptadores de IA (v4): funcionário OpenAI executa pelo Codex; validação real de modelo/esforço dos dois provedores. */
  ai?: { get(provider: AiProviderId): AiAdapter };
  /** Catálogo de skills (v4). Sem ele, pedir uma skill explícita é recusado com explicação. */
  skills?: SkillResolverLike;
  /** Marco 0: pasta com a configuração vazia do gh (funcionários sem credenciais de integração). */
  isolationDir?: string;
  /** Sala travada numa pasta (05/11/2026): devolve o projeto obrigatório da sala (Social Media = pasta de conteúdo) ou null. */
  roomProject?: (roomId: string) => string | null;
  /** Conhecimento da equipe (10/11/2026): bloco de orientações persistidas que acompanha o pedido quando a tarefa começa. */
  knowledge?: { blockFor(task: Task): string | null };
}

interface Runtime {
  activity: ActivityState;
  currentTaskId: string | null;
  pending: Map<string, PendingPermission>;
  /** Arquivos tocados por Write/Edit na tarefa atual: existia antes? (evidência para "criado" x "modificado"). */
  fileChanges: Map<string, 'created' | 'modified'>;
  /** Perfil editorial que o processo atual conhece (undefined = desconhecido, ex.: após --resume). */
  activeProfileId: string | null | undefined;
  streaming: string;
  streamTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  lastBroadcastKey: string;
  /** Esforço mudou durante um turno: encerrar o processo (retomável) quando o turno terminar. */
  restartAfterTurn: boolean;
  /** O que o processo do Claude Code declarou no init (skills, comandos, ferramentas): evidência para "skill confirmada". */
  caps: InitInfo | null;
  /** Turno em andamento no Codex (funcionário OpenAI); null quando não há. */
  codexTurn: TurnHandle | null;
  /** Limite de duração da tarefa atual (Ajustes → maxTaskMinutes / modo ausente). */
  taskTimer: NodeJS.Timeout | null;
  /** Quando o limite vence (ms) enquanto o relógio corre; null parado ou sem limite. */
  taskDeadline: number | null;
  /** Relógio parado esperando o Chefe (permissão ou pergunta): quanto falta (ms) quando ele responder. */
  taskPausedLeft: number | null;
  /** Tarefa que a HQ interrompeu por tempo máximo (para continuar de onde parou, em vez de dar como falha). */
  timedOutTaskId: string | null;
  /** Campo `error` da última mensagem do assistente na tarefa atual (ex.: 'rate_limit', 'server_error'). */
  apiError: string | null;
}

/** Fila de um provedor suspensa por limite de uso ou falta de conexão (não é falha da tarefa). */
interface ProviderHold { kind: 'usage_limit' | 'network'; until: number; reason: string; strikes: number }

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s)"'`<>]*)?/gi;
// Texto do CLI 2.1.316 quando `--resume` aponta para uma conversa que não existe mais (vem em result.errors).
const LOST_SESSION_RE = /No conversation found with session ID/i;
const PERMISSION_MODES: PermissionModeOption[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'];
const ABSENCE_HOLD_PREFIX = 'Modo ausente:';
/** Retomadas seguidas por parada do provedor (limite de uso, sem internet) numa mesma tarefa antes de desistir.
 *  Com a espera crescente da rede (1, 2, 5, 10, 15 min…), 8 retomadas cobrem cerca de 1 h 30 sem conexão. */
const PROVIDER_MAX_RESUMES = 8;
/** Erros que a HQ grava quando o provedor para (ver handleResult). */
const PROVIDER_STOP_ERROR_RE = /^(Parada pelo limite|Parada pelo .* do |Sem resposta da API do )/;
/** Erro que a HQ grava quando interrompe a tarefa pelo tempo máximo (ver armTaskTimer). */
const TIMEOUT_ERROR_RE = /^Tempo máximo de \d+ min atingido/;
/** Embrulho da mensagem do Chefe no meio da tarefa: é ajuste do trabalho em andamento, não pedido novo. */
const STEER_PREFIX = 'Mensagem do Chefe agora, no meio desta tarefa: ';
const STEER_SUFFIX = 'Ajuste o que estiver fazendo de acordo com isso e continue a tarefa até o fim, sem recomeçar do zero. Se ele só perguntou algo, responda em uma linha e siga.';
const CONTINUE_AFTER_TIMEOUT = 'Continue a tarefa anterior de onde parou. Ela foi interrompida pelo tempo máximo da HQ, não por erro seu. Antes de repetir qualquer ação, confira o estado atual dos arquivos para não refazer o que já foi feito, e termine a entrega.';

/** Campos extras aceitos por sendPrompt (v4). Tudo opcional para o chat continuar funcionando como antes. */
interface PromptExtras {
  /** Texto mostrado no chat quando o prompt enviado ao provedor foi composto (skill, plano); padrão = o próprio texto. */
  displayText?: string;
  /** Marco 1: arquivos de contexto (relativos ao projeto) registrados na tarefa. */
  contextFiles?: string[];
  /** Conta de destino (cartão da central de Redes), gravada na tarefa. */
  destinationId?: string | null;
  /** Anexos já gravados (reexecução): reaproveitados sem copiar de novo. */
  storedAttachments?: Attachment[];
  heldReason?: string | null;
  employeeId?: string | null;
  provider?: AiProviderId;
  skill?: SkillUsage | null;
  plan?: boolean;
  requested?: Task['requested'];
  applied?: Task['applied'];
  origin?: Task['origin'];
  routineId?: string | null;
  attempt?: number;
  retryOf?: string | null;
}

function providerLabel(p: AiProviderId): string { return p === 'openai' ? 'OpenAI (Codex)' : 'Claude'; }
/** Complemento legível do resumo "Terminou com erro": o subtipo técnico do CLI não vai para a tela ("success" com erro é falha da API). */
export function resultErrorHint(subtype: string | null | undefined): string {
  if (subtype === 'error_max_turns') return ': limite de passos atingido';
  if (subtype === 'error_during_execution') return ' durante a execução';
  if (subtype === 'success') return ' na resposta da API';
  return '';
}

function firstLine(text: string, max = 90): string {
  const clean = text.replace(/^\[[^\]]*\]\s*/g, '').replace(/^\/[\w:-]+\s*/, '');
  const line = clean.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('[')) ?? clean.trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

export class SessionManager extends EventEmitter<{ broadcast: [ServerMessage]; turn_finished: []; task_finished: [string] }> {
  private procs = new Map<string, ClaudeProcess>();
  private rt = new Map<string, Runtime>();
  private closing = false;
  /** Suspensões por provedor (limite de uso / sem conexão). Em memória: depois de um reinício, a primeira tentativa refaz a checagem. */
  private holds = new Map<AiProviderId, ProviderHold>();
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(private deps: ManagerDeps) { super(); this.normalizeSeats(); }

  /**
   * Assento persistente (desk_index) é único dentro de cada equipe da sala (perfil; sem perfil = apoio). O primeiro assento
   * livre vai para quem chega; quem já tinha um válido continua nele.
   */
  seatFor(roomId: string, profileId: string | null, exceptId?: string): number {
    const used = new Set(this.store.listEmployeesByRoom(roomId).filter(x => !x.archivedAt && x.id !== exceptId && (x.profileId ?? null) === (profileId ?? null)).map(x => x.deskIndex));
    let i = 0; while (used.has(i)) i++;
    return i;
  }
  /** Conserta assentos repetidos (cadastros antigos tinham 4 mesas por sala e repetiam). Mantém a ordem de quem já estava. */
  normalizeSeats(): number {
    let fixed = 0;
    try {
      for (const room of this.store.listRooms()) {
        const groups = new Map<string, Employee[]>();
        for (const e of this.store.listEmployeesByRoom(room.id).filter(x => !x.archivedAt)) { const k = e.profileId ?? ''; groups.set(k, [...(groups.get(k) ?? []), e]); }
        for (const list of groups.values()) {
          list.sort((a, b) => a.deskIndex - b.deskIndex || a.createdAt - b.createdAt);
          const used = new Set<number>();
          for (const e of list) {
            if (e.deskIndex >= 0 && !used.has(e.deskIndex)) { used.add(e.deskIndex); continue; }
            let i = 0; while (used.has(i)) i++;
            used.add(i); this.store.updateEmployee(e.id, { deskIndex: i }); fixed++;
          }
        }
      }
    } catch { /* banco sem salas ainda */ }
    return fixed;
  }

  private get store() { return this.deps.store; }
  private send(msg: ServerMessage) { this.emit('broadcast', msg); }

  // ---------------- consultas ----------------
  private runtime(sessionId: string): Runtime {
    let r = this.rt.get(sessionId);
    if (!r) {
      const s = this.store.getSession(sessionId);
      r = { activity: s?.activity ?? initialActivity(), currentTaskId: null, pending: new Map(), fileChanges: new Map(), activeProfileId: undefined, streaming: '', streamTimer: null, idleTimer: null, lastBroadcastKey: '', restartAfterTurn: false, caps: null, codexTurn: null, taskTimer: null, taskDeadline: null, taskPausedLeft: null, timedOutTaskId: null, apiError: null };
      this.rt.set(sessionId, r);
    }
    return r;
  }

  sessionView(s: Session): Session {
    const p = this.procs.get(s.id);
    const r = this.rt.get(s.id);
    return { ...s, processState: p?.alive ? p.state : null, activity: r?.activity ?? s.activity };
  }
  listSessions(): Session[] { return this.store.listSessions().map(s => this.sessionView(s)); }
  getSession(id: string): Session | null { const s = this.store.getSession(id); return s ? this.sessionView(s) : null; }

  /** Há turno em andamento nesta conversa? Processo do Claude Code em turno ou turno do Codex (funcionário OpenAI). */
  private turnActive(sessionId: string, p?: ClaudeProcess): boolean {
    const proc = p ?? this.procs.get(sessionId);
    if (proc?.alive && proc.turnActive) return true;
    return Boolean(this.rt.get(sessionId)?.codexTurn);
  }
  private sessionsInTurn(): string[] {
    const ids = new Set<string>();
    for (const [id, p] of this.procs) if (p.alive && p.turnActive) ids.add(id);
    for (const [id, r] of this.rt) if (r.codexTurn) ids.add(id);
    return [...ids];
  }

  /** Estado real do funcionário: só a partir da conversa ativa, do processo e das tarefas (nunca da animação). */
  private workerStatusFor(s: Session | null, p: ClaudeProcess | undefined, activity: ActivityState): WorkerStatus {
    if (!s) return 'idle';
    if (!s.controllable) return 'observed';
    if (this.turnActive(s.id, p)) {
      if (activity.phase === 'waiting_permission') return 'waiting_permission';
      if (activity.phase === 'waiting_answer') return 'waiting_answer';
      return 'running';
    }
    const last = this.store.listTasksBySession(s.id, 1)[0];
    if (last?.status === 'queued') return 'queued';
    if (s.status === 'lost') return 'error';
    if (s.status === 'paused') return 'paused';
    if (last?.status === 'interrupted') return 'interrupted';
    if (last?.status === 'error' || last?.status === 'lost' || s.lastError) return 'error';
    return 'idle';
  }

  /** Personagem de um funcionário: identidade persistente + estado da conversa ativa (se houver). */
  workerForEmployee(e: Employee, rooms?: Map<string, Room>): Worker {
    const s = e.activeSessionId ? this.store.getSession(e.activeSessionId) : null;
    const v = s ? this.sessionView(s) : null;
    const p = s ? this.procs.get(s.id) : undefined;
    const room = rooms?.get(e.roomId) ?? this.store.getRoom(e.roomId);
    const activity = v?.activity ?? initialActivity();
    const live = Boolean(s && (s.status === 'active' || s.status === 'lost'));
    const phase: WorkerPhase = live ? activity.phase : 'idle';
    const detail = live ? activity.detail : s?.status === 'paused' ? 'Pausado (conversa retomável)' : 'Disponível';
    return {
      id: e.id, kind: 'employee', employeeId: e.id, sessionId: s?.id ?? null, roomId: e.roomId, projectId: s?.projectId ?? null,
      name: e.name, role: e.role || (room ? (ROLE_BY_KIND[room.kind] ?? room.name) : 'Equipe'), appearance: e.appearance, deskIndex: e.deskIndex,
      phase, detail, status: this.workerStatusFor(s, p, activity), controllable: true, busy: Boolean(s && this.turnActive(s.id, p)),
    };
  }
  /** Personagem da sessão (via seu funcionário); null para sessão sem funcionário. */
  workerFor(s: Session, rooms?: Map<string, Room>): Worker | null {
    const e = s.employeeId ? this.store.getEmployee(s.employeeId) : null;
    return e ? this.workerForEmployee(e, rooms) : null;
  }
  listWorkers(): Worker[] {
    const rooms = new Map(this.store.listRooms().map(r => [r.id, r]));
    return this.store.listActiveEmployees().map(e => this.workerForEmployee(e, rooms));
  }
  listEmployees(): Employee[] { return this.store.listEmployees(); }
  pendingPermissions(): PendingPermission[] {
    const out: PendingPermission[] = [];
    for (const r of this.rt.values()) out.push(...r.pending.values());
    return out;
  }
  activeTurns(): number { return this.sessionsInTurn().length; }
  /** Execuções que consomem o provedor agora. Turnos parados esperando o Chefe (permissão/pergunta) não contam no limite:
   *  a fila continua andando com tarefas independentes enquanto uma aguarda autorização. */
  busyTurns(): number {
    // Conversa particular (Chefe e um funcionário) não ocupa a vaga das tarefas: é curta e não pode esperar um render.
    return this.sessionsInTurn().filter(id => { const ph = this.runtime(id).activity.phase; return ph !== 'waiting_permission' && ph !== 'waiting_answer' && !isDmSession(this.store.getSession(id)); }).length;
  }

  // ---------------- ciclo de vida ----------------
  reconcileOnStart(): void {
    const settings = this.store.getSettings();
    // Nenhum processo sobrevive ao reinício do serviço: sessões "ativas" viram pausadas (retomáveis pelo id real).
    for (const s of this.store.listAllSessions()) {
      if (s.status === 'active' || s.status === 'lost') {
        this.store.updateSession(s.id, { status: (s.claudeSessionId || s.threadId) ? 'paused' : 'new', activity: initialActivity() });
      }
    }
    // Tarefas que estavam rodando: conferir antes de repetir se algo pode ter mudado; senão, nova tentativa até o limite.
    for (const t of this.store.listTasksByStatus(['running', 'waiting_permission', 'waiting_answer'])) {
      this.recoverInterruptedTask(t, 'O serviço do My Company AI reiniciou enquanto esta tarefa rodava; o processo não existe mais.', settings.maxAttempts);
    }
    // Fila durável (v4): tarefas na fila sobrevivem ao reinício e seguem na ordem de criação; as "em espera" continuam esperando.
    const queued = this.store.listTasksByStatus(['queued']).filter(t => !t.held);
    if (queued.length) log.info(`${queued.length} tarefa(s) na fila retomada(s) após o reinício`);
    // Conversa ativa que não existe mais (ou foi arquivada) deixa de ser a ativa; o funcionário continua existindo.
    for (const e of this.store.listEmployees()) {
      if (!e.activeSessionId) continue;
      const s = this.store.getSession(e.activeSessionId);
      if (!s || s.status === 'archived' || s.employeeId !== e.id) this.store.updateEmployee(e.id, { activeSessionId: null });
    }
  }

  /** Tarefa interrompida pela morte do processo (reinício ou queda). Se ferramentas que alteram arquivos ou rodam comandos já
   *  tinham sido usadas, vira "resultado a conferir" e NÃO é reexecutada sozinha; se só leu, volta para a fila como nova
   *  tentativa até o limite. Nunca presume que deu certo. */
  private recoverInterruptedTask(t: Task, reason: string, maxAttempts: number): void {
    const attempt = t.attempt ?? 1;
    const limit = Math.max(1, maxAttempts);
    const now = Date.now();
    if (this.taskMayHaveChanged(t)) {
      const text = `${reason} A tarefa já tinha usado ferramentas que alteram arquivos ou rodam comandos (${this.changeEvidence(t)}): confira o resultado antes de reexecutar.`;
      this.store.updateTask(t.id, { status: 'lost', finishedAt: now, errors: [...t.errors, reason], review: 'to_verify' });
      this.store.upsertChatItem(t.sessionId, { id: randomUUID(), ts: now, taskId: t.id, kind: 'notice', level: 'warn', text });
      return;
    }
    if (attempt < limit) {
      this.store.updateTask(t.id, { status: 'lost', finishedAt: now, errors: [...t.errors, reason] });
      const retry = this.store.createTask({
        clientId: `retry:${t.id}:${attempt + 1}`, sessionId: t.sessionId, projectId: t.projectId, roomId: t.roomId, profileId: t.profileId, prompt: t.prompt, attachments: t.attachments, mode: 'queue',
        employeeId: t.employeeId ?? null, provider: t.provider ?? 'claude', skill: t.skill ? { ...t.skill, confirmation: t.skill.delivery === 'inject' ? 'unknown' : 'pending', evidence: null, checkedAt: null } : null,
        attempt: attempt + 1, retryOf: t.id, plan: t.plan, requested: t.requested ?? null, applied: t.applied ?? null, routineId: t.routineId ?? null, origin: 'retry', meetingId: t.meetingId ?? null, destinationId: t.destinationId ?? null,
      });
      this.store.upsertChatItem(t.sessionId, { id: randomUUID(), ts: now, taskId: t.id, kind: 'notice', level: 'warn', text: `${reason} Nenhuma alteração foi observada: a tarefa voltou para a fila como tentativa ${attempt + 1} de ${limit}.` });
      this.store.upsertChatItem(t.sessionId, { id: 'user:' + retry.id, ts: retry.createdAt, taskId: retry.id, kind: 'user', text: this.displayTextOf(t), attachments: t.attachments });
      return;
    }
    this.store.updateTask(t.id, { status: 'lost', finishedAt: now, errors: [...t.errors, reason, `Limite de ${limit} tentativa(s) atingido; não será reexecutada sozinha.`] });
    this.store.upsertChatItem(t.sessionId, { id: randomUUID(), ts: now, taskId: t.id, kind: 'notice', level: 'error', text: `${reason} Limite de ${limit} tentativa(s) atingido: reexecute manualmente se ainda quiser.` });
  }
  private taskMayHaveChanged(t: Task): boolean {
    if (t.touchedFiles.length) return true;
    return this.store.listChat(t.sessionId, 400).some(c => c.taskId === t.id && c.kind === 'tool' && (WRITE_TOOLS.has(c.name) || EXEC_TOOLS.has(c.name) || DELEGATE_TOOLS.has(c.name)));
  }
  private changeEvidence(t: Task): string {
    if (t.touchedFiles.length) return `${t.touchedFiles.length} arquivo(s) tocado(s)`;
    const names = new Set(this.store.listChat(t.sessionId, 400).filter(c => c.taskId === t.id && c.kind === 'tool').map(c => (c as { name: string }).name));
    return [...names].join(', ') || 'ferramentas registradas';
  }
  /** Texto que o Chefe escreveu (o item "user" do chat), sem a composição de skill/plano enviada ao provedor. */
  private displayTextOf(t: Task): string {
    const item = this.store.getChatItem('user:' + t.id);
    return item && item.kind === 'user' ? item.text : t.prompt;
  }

  // ---------------- funcionários (identidade persistente) ----------------
  createEmployee(input: { roomId: string; name?: string; role?: string; appearance?: Employee['appearance']; instructions?: string; profileId?: string | null; model?: string | null; effort?: EffortLevel | null; permissionMode?: PermissionModeOption; provider?: AiProviderId; skills?: string[]; agent?: Employee['agent']; template?: string | null; access?: Employee['access'] }): Employee {
    const room = this.store.getRoom(input.roomId); if (!room) throw new Error('sala não encontrada');
    if (input.profileId && !room.profiles.some(p => p.id === input.profileId)) throw new Error('perfil não existe nesta sala');
    if (input.provider && input.provider !== 'claude' && input.provider !== 'openai') throw new Error('provedor desconhecido (use claude ou openai)');
    if (input.permissionMode && !PERMISSION_MODES.includes(input.permissionMode)) throw new Error('modo de permissão desconhecido');
    const settings = this.store.getSettings();
    const names = this.store.listEmployeeNames();
    const name = input.name?.trim() || pickWorkerName(names);
    if (names.some(n => n.toLowerCase() === name.toLowerCase())) throw new Error(`já existe um funcionário chamado ${name}`);
    const id = randomUUID();
    const e = this.store.createEmployee({
      id, name, role: input.role?.trim() || ROLE_BY_KIND[room.kind] || room.name, roomId: room.id, appearance: input.appearance ?? appearanceFor(id),
      deskIndex: this.seatFor(room.id, input.profileId ?? null), instructions: input.instructions ?? '',
      profileId: input.profileId ?? null, model: input.model ?? null, effort: input.effort ?? null, permissionMode: input.permissionMode ?? settings.defaultPermissionMode,
      provider: input.provider ?? 'claude', skills: (input.skills ?? []).map(s => s.trim()).filter(Boolean), agent: input.agent ?? null, template: input.template ?? null,
      access: normalizeAccess(input.access),
    });
    this.broadcastEmployee(e.id);
    return e;
  }

  updateEmployee(id: string, patch: Partial<Pick<Employee, 'name' | 'role' | 'roomId' | 'appearance' | 'instructions' | 'profileId' | 'model' | 'effort' | 'permissionMode' | 'provider' | 'skills' | 'agent' | 'template' | 'access'>>): Employee {
    const cur = this.store.getEmployee(id); if (!cur) throw new Error('funcionário não encontrado');
    if (patch.provider && patch.provider !== 'claude' && patch.provider !== 'openai') throw new Error('provedor desconhecido (use claude ou openai)');
    if (patch.provider && patch.provider !== cur.provider && cur.activeSessionId) {
      // Conversas existentes pertencem ao provedor antigo (sessão do Claude Code ou thread do Codex): a troca vale para conversas novas.
      this.store.updateEmployee(id, { activeSessionId: null });
    }
    const next: Parameters<Store['updateEmployee']>[1] = { ...patch };
    if (patch.name !== undefined) {
      const name = patch.name.trim(); if (!name) throw new Error('o nome não pode ficar vazio');
      if (this.store.listActiveEmployees().some(e => e.id !== id && e.name.toLowerCase() === name.toLowerCase())) throw new Error(`já existe um funcionário chamado ${name}`);
      next.name = name;
    }
    const roomId = patch.roomId ?? cur.roomId;
    const room = this.store.getRoom(roomId); if (!room) throw new Error('sala não encontrada');
    if (patch.profileId && !room.profiles.some(p => p.id === patch.profileId)) throw new Error('perfil não existe nesta sala');
    if (patch.roomId && patch.roomId !== cur.roomId && !room.profiles.some(p => p.id === (patch.profileId ?? cur.profileId))) next.profileId = null;
    // Mudou de sala ou de equipe: assento novo na mesa da equipe nova (identidade, conversas e histórico ficam).
    const nextProfile = next.profileId !== undefined ? next.profileId ?? null : cur.profileId ?? null;
    if ((patch.roomId && patch.roomId !== cur.roomId) || nextProfile !== (cur.profileId ?? null)) next.deskIndex = this.seatFor(roomId, nextProfile, id);
    if (patch.access !== undefined) next.access = normalizeAccess(patch.access);
    const e = this.store.updateEmployee(id, next)!;
    // Acessos (MCP) são flags de inicialização: processo ocioso reinicia agora; em turno, ao fim do turno.
    if (patch.access !== undefined && cur.access.mcp !== e.access.mcp && e.activeSessionId) {
      const p = this.procs.get(e.activeSessionId);
      if (p?.alive) {
        if (!p.turnActive) { log.info(`funcionário ${e.name}: acessos mudaram (MCP ${e.access.mcp}); processo ocioso encerrado para aplicar no próximo turno`); this.retireProcess(e.activeSessionId, p); }
        else this.runtime(e.activeSessionId).restartAfterTurn = true;
      }
    }
    // Modelo e modo de permissão valem na hora para a conversa ativa (o CLI aceita trocar); o esforço vale no próximo processo
    // (é flag de linha de comando); instruções e perfil só em conversa nova.
    if (e.activeSessionId && (patch.model !== undefined || patch.permissionMode !== undefined || patch.effort !== undefined)) {
      const s = this.store.getSession(e.activeSessionId);
      if (s && s.status !== 'archived') this.updateSessionOptions(s.id, { ...(patch.model !== undefined ? { model: patch.model } : {}), ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}), ...(patch.effort !== undefined ? { effort: patch.effort } : {}) });
    }
    this.broadcastEmployee(id);
    return e;
  }

  /** Arquiva: encerra o processo da conversa ativa (fica retomável) e tira o personagem da sala. Nada é apagado. */
  async archiveEmployee(id: string): Promise<void> {
    const e = this.store.getEmployee(id); if (!e) throw new Error('funcionário não encontrado');
    if (e.activeSessionId) await this.closeSession(e.activeSessionId);
    this.store.updateEmployee(id, { archivedAt: Date.now() });
    this.send({ kind: 'entity', entity: 'employee', op: 'upsert', item: this.store.getEmployee(id)! });
    this.send({ kind: 'entity', entity: 'worker', op: 'delete', item: { id } });
  }

  unarchiveEmployee(id: string): Employee {
    const e = this.store.getEmployee(id); if (!e) throw new Error('funcionário não encontrado');
    if (this.store.listActiveEmployees().some(x => x.name.toLowerCase() === e.name.toLowerCase())) throw new Error(`já existe um funcionário ativo chamado ${e.name}; renomeie um dos dois`);
    if (!this.store.getRoom(e.roomId)) throw new Error('a sala deste funcionário não existe mais; transfira-o antes');
    const next = this.store.updateEmployee(id, { archivedAt: null, deskIndex: this.seatFor(e.roomId, e.profileId ?? null, id) })!;
    this.broadcastEmployee(id);
    return next;
  }

  setActiveSession(id: string, sessionId: string | null): void {
    const e = this.store.getEmployee(id); if (!e) throw new Error('funcionário não encontrado');
    if (sessionId) {
      const s = this.store.getSession(sessionId);
      if (!s || s.employeeId !== id) throw new Error('a conversa não pertence a este funcionário');
      if (s.status === 'archived') this.store.updateSession(sessionId, { status: s.claudeSessionId ? 'paused' : 'new' });
    }
    this.store.updateEmployee(id, { activeSessionId: sessionId });
    this.broadcastEmployee(id);
  }

  private broadcastEmployee(id: string) {
    const e = this.store.getEmployee(id); if (!e) return;
    this.send({ kind: 'entity', entity: 'employee', op: 'upsert', item: e });
    if (!e.archivedAt) this.send({ kind: 'entity', entity: 'worker', op: 'upsert', item: this.workerForEmployee(e) });
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    await Promise.all([...this.procs.entries()].map(async ([id, p]) => {
      try { await p.close(5000); } catch { /* ignorar */ }
      this.store.updateSession(id, { status: this.store.getSession(id)?.claudeSessionId ? 'paused' : 'new' });
    }));
  }

  /** Cria uma conversa. Com employeeId é a conversa de um funcionário existente; sem, cria um funcionário novo na sala. */
  createSession(input: { roomId: string; projectId: string; employeeId?: string | null; profileId?: string | null; name?: string; model?: string | null; effort?: EffortLevel | null; permissionMode?: PermissionModeOption }): Session {
    const project = this.store.getProject(input.projectId); if (!project) throw new Error('projeto não encontrado');
    if (!fs.existsSync(project.path)) throw new Error(`a pasta do projeto não existe: ${project.path}`);
    let employee = input.employeeId ? this.store.getEmployee(input.employeeId) : null;
    if (input.employeeId && !employee) throw new Error('funcionário não encontrado');
    if (employee?.archivedAt) throw new Error('funcionário arquivado: restaure-o antes de abrir uma conversa');
    const room = this.store.getRoom(employee?.roomId ?? input.roomId); if (!room) throw new Error('sala não encontrada');
    if (!employee) employee = this.createEmployee({ roomId: room.id, profileId: input.profileId ?? null, model: input.model ?? null, effort: input.effort ?? null, permissionMode: input.permissionMode });
    const settings = this.store.getSettings();
    const profileId = input.profileId !== undefined ? input.profileId : employee.profileId;
    if (profileId && !room.profiles.some(p => p.id === profileId)) throw new Error('perfil não existe nesta sala');
    const id = randomUUID();
    const provider: AiProviderId = employee.provider ?? 'claude';
    const globalPrefs = settings.ai?.[provider] ?? { model: null, effort: null };
    const s = this.store.createSession({
      id, roomId: room.id, projectId: project.id, employeeId: employee.id, profileId: profileId ?? null, provider,
      name: input.name?.trim() || `${project.name} · ${new Date().toLocaleDateString('pt-BR')}`,
      // Precedência: pedido > funcionário > padrão global do provedor (Configurações → Inteligência artificial; para o Claude, o modelo padrão antigo como fallback).
      model: input.model ?? employee.model ?? globalPrefs.model ?? (provider === 'claude' ? settings.defaultModel ?? null : null),
      effort: input.effort ?? employee.effort ?? globalPrefs.effort ?? null,
      permissionMode: input.permissionMode ?? employee.permissionMode ?? settings.defaultPermissionMode,
      workerName: employee.name, appearance: employee.appearance, deskIndex: employee.deskIndex,
    });
    this.store.updateProject(project.id, { lastUsedAt: Date.now() });
    this.store.updateEmployee(employee.id, { activeSessionId: s.id });
    this.send({ kind: 'entity', entity: 'session', op: 'upsert', item: this.sessionView(s) });
    this.broadcastEmployee(employee.id);
    return this.sessionView(s);
  }

  async closeSession(sessionId: string, archive = false): Promise<void> {
    const p = this.procs.get(sessionId);
    if (p) { try { await p.close(5000); } catch { /* ignorar */ } }
    const r0 = this.rt.get(sessionId);
    if (r0?.codexTurn) { try { await r0.codexTurn.interrupt(); } catch { /* ignorar */ } }
    const s = this.store.getSession(sessionId); if (!s) return;
    const next = archive ? 'archived' : ((s.claudeSessionId || s.threadId) ? 'paused' : 'new');
    this.store.updateSession(sessionId, { status: next });
    const r = this.rt.get(sessionId); if (r) { r.pending.clear(); r.lastBroadcastKey = ''; }
    if (archive) {
      this.send({ kind: 'entity', entity: 'session', op: 'delete', item: { id: sessionId } });
      // O funcionário continua existindo; só deixa de ter conversa ativa.
      const e = s.employeeId ? this.store.getEmployee(s.employeeId) : null;
      if (e && e.activeSessionId === sessionId) { this.store.updateEmployee(e.id, { activeSessionId: null }); this.broadcastEmployee(e.id); }
    } else this.broadcastSession(sessionId);
  }

  resumeSession(sessionId: string): void {
    const s = this.store.getSession(sessionId); if (!s) throw new Error('sessão não encontrada');
    if (s.status === 'archived') this.store.updateSession(sessionId, { status: s.claudeSessionId ? 'paused' : 'new' });
    this.broadcastSession(sessionId);
  }

  updateSessionOptions(sessionId: string, patch: { model?: string | null; effort?: EffortLevel | null; permissionMode?: PermissionModeOption; ultracode?: boolean }): void {
    const s = this.store.getSession(sessionId); if (!s) throw new Error('sessão não encontrada');
    this.store.updateSession(sessionId, patch);
    const p = this.procs.get(sessionId);
    if (p?.alive) {
      if (patch.model !== undefined) p.setModel(patch.model).catch(e => log.warn('set_model falhou', e));
      if (patch.permissionMode !== undefined) p.setPermissionMode(patch.permissionMode).catch(e => log.warn('set_permission_mode falhou', e));
      // Esforço é flag de inicialização (--effort): processo ocioso é encerrado agora (retomável) e o próximo turno nasce com o nível novo;
      // processo em turno recebe o nível quando o turno terminar (handleResult).
      const effortChanged = patch.effort !== undefined && patch.effort !== s.effort;
      const ultraChanged = patch.ultracode !== undefined && Boolean(patch.ultracode) !== Boolean(s.ultracode);
      if (effortChanged || ultraChanged) {
        const what = [effortChanged ? `esforço ${patch.effort ?? 'padrão'}` : '', ultraChanged ? `Ultracode ${patch.ultracode ? 'ligado' : 'desligado'}` : ''].filter(Boolean).join(' e ');
        if (!p.turnActive) { log.info(`sessão ${sessionId.slice(0, 8)}: ${what}; processo ocioso encerrado para aplicar no próximo turno`); this.retireProcess(sessionId, p); }
        else this.runtime(sessionId).restartAfterTurn = true;
      }
    }
    this.broadcastSession(sessionId);
  }

  /** Libera uma tarefa em espera (criada "sem iniciar" numa reunião, ou segurada pelo modo ausente) para a fila normal. */
  releaseTask(taskId: string): void {
    const t = this.store.getTask(taskId); if (!t) throw new Error('tarefa não encontrada');
    if (!t.held) return;
    this.store.updateTask(taskId, { held: false, heldReason: null });
    this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(taskId)! });
    this.dispatch();
  }

  /** Troca o perfil editorial da sessão; a próxima mensagem leva as instruções do perfil novo como texto (dado, não shell). */
  setProfile(sessionId: string, profileId: string | null): void {
    const s = this.store.getSession(sessionId); if (!s) throw new Error('sessão não encontrada');
    const room = this.store.getRoom(s.roomId);
    if (profileId && !room?.profiles.some(p => p.id === profileId)) throw new Error('perfil não existe nesta sala');
    this.store.updateSession(sessionId, { profileId });
    this.send({ kind: 'entity', entity: 'session', op: 'upsert', item: this.sessionView(this.store.getSession(sessionId)!) });
  }

  // ---------------- prompts e fila ----------------
  /** Mensagem do Chefe no meio da tarefa (09/11/2026, "conversar durante a tarefa"): entra no próximo passo do turno em
   *  andamento, sem interromper nem abrir tarefa nova (stream-json com priority "next", provado no Claude Code 2.1.321: a
   *  mensagem chegou depois da primeira ferramenta e o modelo mudou o rumo no mesmo turno). Sem turno rodando (ou com o
   *  funcionário esperando uma resposta do Chefe), vira um pedido normal na fila da mesma conversa. */
  async steer(input: { sessionId: string; clientId: string; text: string }): Promise<{ delivered: boolean; task: Task | null }> {
    const s = this.store.getSession(input.sessionId);
    if (!s) throw new Error('sessão não encontrada');
    if (!s.controllable) throw new Error('esta sessão é apenas observada; abra-a no My Company AI para controlar');
    if (s.status === 'archived') throw new Error('sessão arquivada');
    const text = input.text.trim();
    if (!text) throw new Error('mensagem vazia');
    const dup = this.store.getChatItem('steer:' + input.clientId);
    if (dup && dup.kind === 'user') return { delivered: true, task: this.store.getTask(dup.taskId) };
    const r = this.runtime(s.id);
    const p = this.procs.get(s.id);
    const current = r.currentTaskId ? this.store.getTask(r.currentTaskId) : null;
    const live = !!p?.alive && p.turnActive && !!current && current.status === 'running' && r.pending.size === 0 && (s.provider ?? 'claude') === 'claude';
    if (!live) return { delivered: false, task: await this.sendPrompt({ sessionId: s.id, clientId: input.clientId, text, mode: 'queue' }) };
    p!.sendUser(`${STEER_PREFIX}"${text}"\n${STEER_SUFFIX}`, { priority: 'next' });
    const item: ChatItem = { id: 'steer:' + input.clientId, ts: Date.now(), taskId: current!.id, kind: 'user', text, attachments: [], steer: true };
    this.store.upsertChatItem(s.id, item);
    this.send({ kind: 'chat.item', sessionId: s.id, item });
    log.info(`mensagem no meio da tarefa ${current!.id} (sessão ${s.id})`);
    return { delivered: true, task: current };
  }

  async sendPrompt(input: { sessionId: string; clientId: string; text: string; attachments?: { name: string; mediaType: string; dataBase64: string }[]; maxAttachments?: number; mode: 'send' | 'queue' | 'interrupt'; held?: boolean; meetingId?: string | null } & PromptExtras): Promise<Task> {
    const existing = this.store.findTaskByClientId(input.clientId);
    if (existing) return existing; // reenvio (ex.: atualização da página, duplo clique, reconexão): nunca dispara de novo
    const s = this.store.getSession(input.sessionId);
    if (!s) throw new Error('sessão não encontrada');
    if (!s.controllable) throw new Error('esta sessão é apenas observada; abra-a no My Company AI para controlar');
    if (s.status === 'archived') throw new Error('sessão arquivada');
    if (!input.text.trim() && !(input.attachments?.length) && !(input.storedAttachments?.length)) throw new Error('mensagem vazia');
    const attachments = input.storedAttachments ?? this.storeAttachments(input.attachments ?? [], input.maxAttachments ?? 10).map(a => a.meta);
    const task = this.store.createTask({
      clientId: input.clientId, sessionId: s.id, projectId: s.projectId, roomId: s.roomId, profileId: s.profileId ?? null, prompt: input.text, attachments, mode: input.mode,
      held: Boolean(input.held), heldReason: input.heldReason ?? null, meetingId: input.meetingId ?? null,
      employeeId: input.employeeId ?? s.employeeId ?? null, provider: input.provider ?? s.provider ?? 'claude', skill: input.skill ?? null, attempt: input.attempt ?? 1, retryOf: input.retryOf ?? null,
      plan: Boolean(input.plan), requested: input.requested ?? null, applied: input.applied ?? null, routineId: input.routineId ?? null, origin: input.origin ?? 'chat',
      contextFiles: input.contextFiles ?? [], destinationId: input.destinationId ?? null,
    });
    this.runtime(s.id);
    const userItem: ChatItem = { id: 'user:' + task.id, ts: task.createdAt, taskId: task.id, kind: 'user', text: input.displayText ?? input.text, attachments };
    this.store.upsertChatItem(s.id, userItem);
    this.send({ kind: 'chat.item', sessionId: s.id, item: userItem });
    this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: task });
    if (input.mode === 'interrupt' && this.turnActive(s.id)) {
      await this.interrupt(s.id);
    }
    this.dispatch();
    return this.store.getTask(task.id)!;
  }

  cancelQueued(taskId: string): void {
    const t = this.store.getTask(taskId); if (!t || t.status !== 'queued') return;
    this.store.updateTask(taskId, { status: 'interrupted', finishedAt: Date.now(), errors: ['Cancelada na fila pelo Chefe'] });
    this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(taskId)! });
  }

  // ---------------- entrada única de tarefa (v4) ----------------
  /** Pedido → projeto → funcionário → skill opcional → executar. Valida tudo com mensagens específicas (o que falta aparece
   *  no compositor), reaproveita a conversa do funcionário no projeto ou abre uma nova, registra skill pedida e configuração
   *  pedida x aplicada e entrega para a fila. Idempotente pelo clientId. */
  /** `extra` vem do servidor (rotinas): origem e vínculo da tarefa; a interface nunca escolhe isso. */
  async runTask(input: TaskRunInput, extra?: { origin?: Task['origin']; routineId?: string | null; held?: boolean; heldReason?: string | null; meetingId?: string | null }): Promise<TaskRunResult> {
    const existing = this.store.findTaskByClientId(input.clientId);
    if (existing) return this.runResultFor(existing, { newSession: false, notes: ['Este pedido já tinha sido registrado (mesmo identificador): nenhuma tarefa nova foi criada.'], duplicate: true });
    const text = (input.text ?? '').trim();
    if (!text && !(input.attachments?.length)) throw new Error('Escreva o que vamos fazer antes de executar.');
    if (!input.projectId) throw new Error('Escolha um projeto (ou cadastre a pasta) antes de executar.');
    // Sala travada numa pasta (05/11/2026): quem é da sala Social Media trabalha sempre na pasta de conteúdo, venha o pedido do
    // campo, da conversa, do ajuste da Mesa ou de uma reunião. Em 05/11 dois pedidos saíram com a pasta da HQ e as entregas caíram no código.
    const lockRoomId = input.employeeId ? this.store.getEmployee(input.employeeId)?.roomId ?? null : null;
    const lockedId = lockRoomId ? this.deps.roomProject?.(lockRoomId) ?? null : null;
    const asked = this.store.getProject(input.projectId);
    const lockedProject = lockedId && lockedId !== input.projectId ? this.store.getProject(lockedId) : null;
    const project = lockedProject && fs.existsSync(lockedProject.path) ? lockedProject : asked;
    if (!project) throw new Error('Esse projeto não existe mais na HQ: escolha outro ou cadastre a pasta de novo.');
    if (!fs.existsSync(project.path)) throw new Error(`A pasta do projeto não existe mais: ${project.path}. Corrija o cadastro do projeto.`);
    if (input.destinationId != null && !isSocialSlot(input.destinationId)) throw new Error('Esse destino não existe na central de Redes: escolha outro em Opções.');
    if (!input.employeeId) throw new Error('Escolha um funcionário (ou contrate um) antes de executar.');
    const employee = this.store.getEmployee(input.employeeId);
    if (!employee) throw new Error('Esse funcionário não existe mais: escolha outro ou contrate um.');
    if (employee.archivedAt) throw new Error(`${employee.name} está arquivado: restaure na Equipe antes de dar a tarefa.`);
    // Equipes (08/11): o canal de destino é de uma equipe; quem é de outra equipe não executa (especialista de apoio pode).
    // A tarefa grava o perfil da equipe do canal, e é esse perfil que vai para o executor (instruções da equipe no sistema).
    const destTeam = teamOfSlot(input.destinationId ?? null);
    if (destTeam) {
      const empTeam = isTeamId(employee.profileId) ? employee.profileId : null;
      if (empTeam && empTeam !== destTeam) throw new Error(`${employee.name} é da ${teamDef(empTeam).label}; ${CHANNEL_LABEL[input.destinationId as SocialSlotId] ?? input.destinationId} é da ${teamDef(destTeam).label}. Escolha alguém dessa equipe ou um especialista de apoio.`);
      if (input.profileId && isTeamId(input.profileId) && input.profileId !== destTeam) throw new Error(`O perfil escolhido (${teamDef(input.profileId).short}) não é o da conta de destino (${teamDef(destTeam).short}).`);
      if (input.profileId === undefined || input.profileId === null) input = { ...input, profileId: destTeam };
    }
    const provider: AiProviderId = employee.provider ?? 'claude';
    if (!this.deps.probing?.()) { const why = this.providerBlockReason(provider); if (why) throw new Error(why); }
    const settings = this.store.getSettings();
    const notes: string[] = [];
    const redirected = project !== asked;
    if (redirected) notes.push(`${this.store.getRoom(employee.roomId)?.name ?? 'A sala'} trabalha sempre na pasta "${project.name}": o pedido foi para lá${asked ? `, não para "${asked.name}"` : ''}.`);

    // Opções explícitas desta tarefa (precedência: tarefa > funcionário > padrão global), validadas no catálogo real do provedor.
    const req: NonNullable<Task['requested']> = { model: input.options?.model ?? null, effort: input.options?.effort ?? null, permissionMode: input.options?.permissionMode ?? null, ultracode: Boolean(input.options?.ultracode) };
    if (req.ultracode && provider !== 'claude') throw new Error('Ultracode é uma configuração do Claude Code: escolha um funcionário Claude ou desligue o Ultracode.');
    if (req.ultracode && this.deps.ai) {
      // Docs do Claude Code: o Ultracode fica indisponível em modelo sem o nível xhigh.
      const v = this.deps.ai.get('claude').validate(req.model ?? employee.model ?? null, 'xhigh');
      if (!v.ok) throw new Error(`Ultracode precisa de um modelo com o nível xhigh: ${v.reason}.`);
    }
    // Arquivos de contexto escolhidos em outra pasta não valem na pasta da sala (o caminho é relativo ao projeto).
    const contextFiles = this.validateContextFiles(project, redirected ? [] : input.contextFiles ?? []);
    if (redirected && input.contextFiles?.length) notes.push('Os arquivos de referência escolhidos eram de outra pasta e ficaram de fora.');
    if (req.permissionMode && !PERMISSION_MODES.includes(req.permissionMode as PermissionModeOption)) throw new Error(`Modo de permissão desconhecido: ${req.permissionMode}.`);
    if ((req.model || req.effort) && this.deps.ai) {
      const v = this.deps.ai.get(provider).validate(req.model ?? employee.model ?? null, req.effort ?? employee.effort ?? null);
      if (!v.ok) throw new Error(`Configuração não aceita: ${v.reason}${v.alternatives.length ? ` (níveis aceitos: ${v.alternatives.join(', ')})` : ''}.`);
      if (v.note) notes.push(v.note);
    }

    // Skill: registrada como "solicitada"; a confirmação vem da evidência do provedor (lista do init), nunca presumida.
    let skill: SkillUsage | null = null; let skillInfo: SkillInfo | null = null; let skillContent: string | null = null;
    if (input.skill) {
      if (!this.deps.skills) throw new Error('O catálogo de skills não está disponível neste serviço; escolha "Automática".');
      const found = await this.deps.skills.resolve(input.skill, project.id);
      if (!found) throw new Error(`A skill "${input.skill}" não foi encontrada nesta máquina. Confira na área Skills ou escolha "Automática".`);
      skillInfo = found.info; skillContent = found.content;
      if (skillInfo.disabled) throw new Error(`A skill "${skillInfo.name}" está desativada (skillOverrides: off): o Claude Code não a carrega. Reative nas configurações do Claude Code ou escolha outra.`);
      if (skillInfo.shadowedBy) notes.push(`Existe outra skill "${skillInfo.invocation}" com prioridade maior (${skillInfo.shadowedBy}); é essa que o Claude Code carrega.`);
      const support = skillInfo.providers[provider];
      if (!support || support.mode === 'unavailable') throw new Error(`A skill "${skillInfo.name}" não está disponível para ${provider === 'openai' ? 'OpenAI (Codex)' : 'Claude'}: ${support?.detail ?? 'sem mecanismo compatível nesta versão'}.`);
      if (support.mode === 'inject' && !skillContent) throw new Error(`Não foi possível ler o conteúdo da skill "${skillInfo.name}" para entregá-la ao OpenAI.`);
      skill = { requested: skillInfo.invocation, source: skillInfo.source, provider, delivery: support.mode, confirmation: support.mode === 'inject' ? 'unknown' : 'pending', evidence: support.mode === 'inject' ? support.detail : null, checkedAt: support.mode === 'inject' ? Date.now() : null };
      if (support.mode === 'inject') notes.push(`Skill entregue como texto do manual: ${support.detail}`);
      if (skillInfo.hasShellInjection) notes.push('Esta skill tem comandos de shell embutidos que o Claude Code executa ao ativá-la (a HQ não executou nada ao catalogar).');
    }

    // Conversa: a ativa do funcionário se for deste projeto; senão uma conversa dele neste projeto; senão uma nova.
    const { session, created } = this.sessionForWork(employee, project, req);
    const patch: { model?: string | null; effort?: EffortLevel | null; permissionMode?: PermissionModeOption; ultracode?: boolean } = {};
    if (req.model && req.model !== session.model) patch.model = req.model;
    if (req.effort && req.effort !== session.effort) patch.effort = req.effort;
    if (Boolean(req.ultracode) !== Boolean(session.ultracode)) patch.ultracode = Boolean(req.ultracode);
    const baseMode = (employee.permissionMode ?? settings.defaultPermissionMode) as PermissionModeOption;
    const wantMode: PermissionModeOption | null = (req.permissionMode as PermissionModeOption | null) ?? (input.plan ? 'plan' : (session.permissionMode === 'plan' && !created ? baseMode : null));
    if (wantMode && wantMode !== session.permissionMode) patch.permissionMode = wantMode;
    if (Object.keys(patch).length) this.updateSessionOptions(session.id, patch);
    // Perfil editorial escolhido no topo (sala Social Media): vale a partir deste pedido; tarefas anteriores não mudam.
    if (input.profileId !== undefined && (input.profileId ?? null) !== (session.profileId ?? null)) {
      const room = this.store.getRoom(session.roomId);
      if (!input.profileId || room?.profiles.some(p => p.id === input.profileId)) this.setProfile(session.id, input.profileId ?? null);
      else notes.push(`O perfil editorial escolhido só existe na sala Social Media; ${employee.name} está em ${room?.name ?? 'outra sala'}, então o pedido segue sem perfil.`);
    }
    const cur = this.store.getSession(session.id)!;
    const explicit = Boolean(req.model || req.effort || req.permissionMode || req.ultracode);
    const applied: NonNullable<Task['applied']> = { model: cur.model ?? null, effort: cur.effort ?? null, permissionMode: cur.permissionMode, ultracode: Boolean(cur.ultracode), source: explicit ? 'opções desta tarefa' : created ? ((employee.model || employee.effort) ? 'perfil do funcionário' : 'padrão global') : 'conversa existente do funcionário' };
    if (input.plan) notes.push('Planejar antes: a conversa está em modo plano; o funcionário apresenta o plano sem alterar arquivos.');
    if (provider === 'openai') notes.push('OpenAI (Codex) em modo análise: lê a pasta do projeto e responde, sem alterar arquivos nem rodar comandos.');
    if (req.ultracode) notes.push('Ultracode ligado por configuração do Claude Code (--settings), preservando o esforço escolhido. O Claude Code não confirma o Ultracode nem o esforço na resposta: aparecem como "enviado, não confirmado". Gasta bem mais da assinatura.');

    let prompt = text;
    if (input.plan) prompt = `[Planejar antes] Apresente um plano de execução para o pedido abaixo (etapas, arquivos envolvidos, riscos e o que depende de decisão do Chefe). Não altere arquivos nem rode comandos que mudem algo até o Chefe aprovar.\n\n${prompt}`;
    if (skill && skillInfo) {
      prompt = skill.delivery === 'native'
        ? `/${skillInfo.invocation} ${prompt}`
        : `[Skill solicitada pelo Chefe: ${skillInfo.name} (manual de trabalho). Siga as instruções abaixo ao executar o pedido.]\n\n${skillContent}\n\n[Pedido do Chefe]\n${prompt}`;
    }
    if (contextFiles.length) prompt += '\n\nArquivos de contexto escolhidos pelo Chefe (leia antes de começar; caminhos dentro do projeto):\n' + contextFiles.map(c => '- ' + c).join('\n');
    const task = await this.sendPrompt({ sessionId: session.id, clientId: input.clientId, text: prompt, displayText: text, attachments: input.attachments, maxAttachments: input.maxAttachments, mode: 'queue', employeeId: employee.id, provider, skill, plan: input.plan, requested: req, applied, origin: extra?.origin ?? 'composer', routineId: extra?.routineId ?? null, contextFiles, destinationId: input.destinationId ?? null, held: extra?.held, heldReason: extra?.heldReason ?? null, meetingId: extra?.meetingId ?? null });
    return this.runResultFor(this.store.getTask(task.id)!, { newSession: created, notes, duplicate: false });
  }

  /** Arquivos de contexto: só arquivos existentes DENTRO da pasta do projeto (sem sair por "..", link ou junction). */
  private validateContextFiles(project: Project, files: string[]): string[] {
    if (!Array.isArray(files) || files.length === 0) return [];
    if (files.length > 20) throw new Error('No máximo 20 arquivos de contexto por tarefa.');
    let root: string;
    try { root = fs.realpathSync(project.path); } catch { throw new Error(`A pasta do projeto não existe: ${project.path}`); }
    const lower = (p: string) => p.toLowerCase();
    const out: string[] = [];
    for (const raw of files) {
      const rel = String(raw ?? '').split('\\').join('/').replace(/^\/+/, '');
      if (!rel) continue;
      const abs = path.resolve(project.path, rel);
      let real: string;
      try { real = fs.realpathSync(abs); } catch { throw new Error(`Arquivo de contexto não encontrado no projeto: ${rel}`); }
      const inside = lower(real) === lower(root) || lower(real).startsWith(lower(root) + path.sep);
      if (!inside || lower(real) !== lower(path.resolve(root, path.relative(path.resolve(project.path), abs)))) throw new Error(`Arquivo de contexto fora da pasta do projeto (ou por link): ${rel}`);
      if (!fs.statSync(real).isFile()) throw new Error(`Contexto precisa ser arquivo, não pasta: ${rel}`);
      const norm = path.relative(root, real).split(path.sep).join('/');
      if (!out.includes(norm)) out.push(norm);
    }
    return out;
  }

  private sessionForWork(employee: Employee, project: Project, req: NonNullable<Task['requested']>): { session: Session; created: boolean } {
    const active = employee.activeSessionId ? this.store.getSession(employee.activeSessionId) : null;
    // A conversa particular nunca recebe tarefa de trabalho (o que o Chefe conversa fica só entre os dois).
    if (active && !isDmSession(active) && active.status !== 'archived' && active.controllable && active.projectId === project.id) return { session: active, created: false };
    const other = this.store.listSessionsByEmployee(employee.id).find(s => !isDmSession(s) && s.status !== 'archived' && s.controllable && s.projectId === project.id && (s.provider ?? 'claude') === (employee.provider ?? 'claude'));
    if (other) { this.setActiveSession(employee.id, other.id); return { session: other, created: false }; }
    const s = this.createSession({ roomId: employee.roomId, projectId: project.id, employeeId: employee.id, model: req.model ?? undefined, effort: req.effort ?? undefined, permissionMode: (req.permissionMode as PermissionModeOption | null) ?? undefined });
    return { session: s, created: true };
  }

  private runResultFor(t: Task, extra: { newSession: boolean; notes: string[]; duplicate: boolean }): TaskRunResult {
    const q = this.queueInfo(t);
    return {
      taskId: t.id, sessionId: t.sessionId, employeeId: t.employeeId ?? '', projectId: t.projectId, status: t.status, queuePosition: q.position, queueReason: q.reason,
      newSession: extra.newSession, applied: t.applied ?? { model: null, effort: null, permissionMode: 'default', source: 'desconhecida' }, notes: extra.notes, duplicate: extra.duplicate,
    };
  }

  /** Posição na fila e motivo honesto de estar esperando. */
  queueInfo(t: Task): { position: number | null; reason: string | null } {
    if (t.status !== 'queued') return { position: null, reason: null };
    const settings = this.store.getSettings();
    const queued = this.store.listTasksByStatus(['queued']).filter(x => !x.held);
    const position = t.held ? null : queued.findIndex(x => x.id === t.id) + 1;
    const e = t.employeeId ? this.store.getEmployee(t.employeeId) : null;
    let reason: string | null;
    if (t.held) reason = t.heldReason ?? 'Em espera até você liberar.';
    else if (settings.pauseNewTasks) reason = 'Novas tarefas estão pausadas (Ajustes → Serviço): a fila anda quando você retomar.';
    else if (this.holdFor(t.provider ?? 'claude')) reason = this.holdFor(t.provider ?? 'claude')!.reason;
    else if (this.deps.probing?.()) reason = 'A HQ ainda está verificando a instalação do Claude Code.';
    else if (this.turnActive(t.sessionId)) reason = `${e?.name ?? 'O funcionário'} ainda está em outra tarefa nesta conversa.`;
    else if (this.busyTurns() + (this.deps.externalActive?.() ?? 0) >= Math.max(1, settings.maxParallel)) reason = `Limite de ${Math.max(1, settings.maxParallel)} execução(ões) ao mesmo tempo: a fila anda quando a atual terminar.`;
    else reason = this.providerBlockReason(t.provider ?? 'claude');
    return { position: position || null, reason };
  }

  /** Por que o provedor não pode executar agora (null = pode). Nunca inventa estado: usa o executável encontrado e o status real do Codex. */
  private providerBlockReason(provider: AiProviderId): string | null {
    if (provider === 'claude') return this.deps.exePath() ? null : 'Claude Code não foi encontrado nesta máquina: instale-o ou informe o caminho em Ajustes → Conexões.';
    const a = this.deps.ai?.get('openai');
    if (!a) return 'OpenAI (Codex) não está disponível neste serviço.';
    const st = a.status();
    if (!st.installed) return 'Codex CLI não encontrado nesta máquina: instale-o para usar funcionários OpenAI.';
    if (st.authState !== 'ok') return 'OpenAI sem login no Codex: conclua o login com ChatGPT em Ajustes → Conexões.';
    return null;
  }

  /** Reexecuta uma tarefa perdida/com erro/interrompida como nova tentativa (mesmo pedido, attempt + 1). */
  async retryTask(taskId: string): Promise<Task> {
    const t = this.store.getTask(taskId); if (!t) throw new Error('tarefa não encontrada');
    if (!['lost', 'error', 'interrupted'].includes(t.status)) throw new Error('só tarefas perdidas, com erro ou interrompidas podem ser reexecutadas');
    if (t.review === 'to_verify') throw new Error('Esta tarefa pode ter alterado arquivos antes de parar: confira o resultado e marque como conferido antes de reexecutar.');
    const s = this.store.getSession(t.sessionId);
    if (!s || s.status === 'archived') throw new Error('a conversa desta tarefa não está mais disponível');
    const attempt = (t.attempt ?? 1) + 1;
    return this.sendPrompt({
      sessionId: t.sessionId, clientId: `retry:${t.id}:${attempt}`, text: t.prompt, displayText: this.displayTextOf(t), storedAttachments: t.attachments, mode: 'queue',
      employeeId: t.employeeId ?? null, provider: t.provider ?? 'claude', skill: t.skill ? { ...t.skill, confirmation: t.skill.delivery === 'inject' ? 'unknown' : 'pending', evidence: null, checkedAt: null } : null,
      plan: t.plan, requested: t.requested ?? null, applied: t.applied ?? null, routineId: t.routineId ?? null, attempt, retryOf: t.id, origin: 'retry', meetingId: t.meetingId ?? null, destinationId: t.destinationId ?? null,
    });
  }

  /** O Chefe conferiu uma tarefa "resultado a conferir". */
  markVerified(taskId: string): void {
    const t = this.store.getTask(taskId); if (!t) throw new Error('tarefa não encontrada');
    // "Conferida/revisada pelo Chefe": vale para resultado a conferir e para entrega concluída (Mesa do Chefe, mural).
    if (t.review === 'verified' || (t.review !== 'to_verify' && t.status !== 'done')) return;
    this.store.updateTask(taskId, { review: 'verified' });
    this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(taskId)! });
  }

  /** "Enquanto você esteve fora": só fatos registrados (tarefas, entregas, pendências), sem porcentagens inventadas. */
  awaySummary(since: number): AwaySummary {
    const until = Date.now();
    const out: AwaySummary = { since, until, done: [], failed: [], waiting: [], toVerify: [], queued: [], filesProduced: [], routinesRun: [] };
    const nameOf = (t: Task): string => (t.employeeId ? this.store.getEmployee(t.employeeId)?.name : null) ?? this.store.getWorkerMeta(t.sessionId)?.workerName ?? this.store.getSession(t.sessionId)?.name ?? '?';
    const projectOf = (t: Task): string => this.store.getProject(t.projectId)?.name ?? '?';
    for (const t of this.store.listTasksSince(since)) {
      const base = { taskId: t.id, sessionId: t.sessionId, employee: nameOf(t), project: projectOf(t), title: firstLine(this.displayTextOf(t)) };
      const lastError = t.errors.length ? t.errors[t.errors.length - 1] : null;
      if (t.review === 'to_verify') out.toVerify.push({ ...base, note: lastError ?? 'Confira o resultado antes de reexecutar.' });
      if (t.status === 'done' && t.finishedAt && t.finishedAt >= since) {
        out.done.push({ ...base, finishedAt: t.finishedAt, files: t.deliverables.filter(d => d.kind === 'file').length });
        for (const d of t.deliverables) if (d.kind === 'file') out.filesProduced.push({ path: d.path ?? d.title, taskId: t.id, changeType: d.changeType ?? 'unknown' });
      } else if ((t.status === 'error' || t.status === 'lost' || t.status === 'interrupted') && t.finishedAt && t.finishedAt >= since && t.review !== 'to_verify') {
        out.failed.push({ ...base, status: t.status, error: lastError });
      } else if (t.status === 'queued') {
        out.queued.push({ ...base, held: Boolean(t.held), heldReason: t.heldReason ?? null });
      }
      if (t.routineId && t.startedAt && t.startedAt >= since) out.routinesRun.push({ routineId: t.routineId, title: this.store.getRoutine(t.routineId)?.title ?? 'Rotina', taskId: t.id, at: t.startedAt });
    }
    for (const p of this.pendingPermissions()) {
      const s = this.store.getSession(p.sessionId);
      const employee: string = (s?.employeeId ? this.store.getEmployee(s.employeeId)?.name : null) ?? this.store.getWorkerMeta(p.sessionId)?.workerName ?? '?';
      out.waiting.push({ taskId: p.taskId, sessionId: p.sessionId, employee, project: (s && this.store.getProject(s.projectId)?.name) || '?', kind: p.isQuestion ? 'question' : 'permission', summary: p.isQuestion ? (p.questions?.[0]?.question ?? 'Pergunta do funcionário') : summarizeToolInput(p.request.toolName, p.request.input) });
    }
    return out;
  }

  /** Despacha tarefas na fila respeitando: pausa de novas tarefas, política do modo ausente, limite global de execuções
   *  (turnos esperando o Chefe não contam), uma execução por conversa e disponibilidade real do provedor. */
  dispatch(): void {
    if (this.closing) return;
    if (this.deps.probing?.()) return; // main.ts chama dispatch() de novo quando a inspeção terminar
    const settings = this.store.getSettings();
    if (settings.pauseNewTasks) return;
    const absence = settings.absence;
    if (!absence.enabled) {
      // Modo ausente desligado: o que a HQ segurou por causa dele volta para a fila normal (o que o Chefe segurou continua).
      for (const t of this.store.listTasksByStatus(['queued'])) if (t.held && t.heldReason?.startsWith(ABSENCE_HOLD_PREFIX)) { this.store.updateTask(t.id, { held: false, heldReason: null }); this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(t.id)! }); }
    }
    const queued = this.store.listTasksByStatus(['queued']).filter(t => !t.held);
    let startedInAbsence = absence.enabled && absence.since ? this.store.listTasksSince(absence.since).filter(t => t.startedAt != null && t.startedAt >= (absence.since ?? 0)).length : 0;
    for (const t of queued) {
      if (absence.enabled) {
        const why = this.absenceBlockReason(t, absence, startedInAbsence);
        if (why) {
          this.store.updateTask(t.id, { held: true, heldReason: why });
          this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(t.id)! });
          this.send({ kind: 'chat.item', sessionId: t.sessionId, item: this.chatNotice(t.sessionId, t.id, 'warn', `Aguardando Chefe. ${why}`) });
          continue;
        }
      }
      // Conversa particular passa na frente e não espera a vaga (só a mesma conversa ocupada a segura).
      if (!isDmSession(this.store.getSession(t.sessionId)) && this.busyTurns() + (this.deps.externalActive?.() ?? 0) >= Math.max(1, settings.maxParallel)) continue;
      if (this.turnActive(t.sessionId)) continue; // conversa ocupada: espera o result
      const r = this.runtime(t.sessionId);
      if (r.currentTaskId) continue;
      // Limite de uso / API fora do ar: a fila desse provedor espera o horário de volta (o motivo aparece no cartão da tarefa).
      const hold = this.holdFor(t.provider ?? 'claude');
      if (hold) {
        if (t.heldReason !== hold.reason) { this.store.updateTask(t.id, { heldReason: hold.reason }); this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(t.id)! }); }
        continue;
      }
      const blocked = this.providerBlockReason(t.provider ?? 'claude');
      if (blocked) {
        if (!this.blockNotified.has(t.id)) { this.blockNotified.add(t.id); this.send({ kind: 'chat.item', sessionId: t.sessionId, item: this.chatNotice(t.sessionId, t.id, 'warn', `Tarefa continua na fila: ${blocked}`) }); }
        continue;
      }
      if (t.heldReason) this.store.updateTask(t.id, { heldReason: null }); // motivo de uma suspensão que já passou
      if (absence.enabled) startedInAbsence++;
      this.startTask(t).catch(err => {
        log.error('falha ao iniciar tarefa', err);
        this.store.updateTask(t.id, { status: 'error', finishedAt: Date.now(), errors: [String((err as Error).message ?? err)] });
        this.store.updateSession(t.sessionId, { lastError: String((err as Error).message ?? err) });
        this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(t.id)! });
        this.send({ kind: 'chat.item', sessionId: t.sessionId, item: this.chatNotice(t.sessionId, t.id, 'error', `Não foi possível iniciar ${(t.provider ?? 'claude') === 'openai' ? 'o Codex' : 'o Claude Code'}: ${(err as Error).message ?? err}`) });
        this.broadcastSession(t.sessionId);
      });
    }
  }
  private blockNotified = new Set<string>();

  // ---------------- suspensão por limite de uso / API fora do ar ----------------
  /** Suspensão ativa do provedor (null quando não há ou já passou). */
  holdFor(provider: AiProviderId): ProviderHold | null {
    const h = this.holds.get(provider);
    if (!h) return null;
    if (h.until > Date.now()) return h;
    if (h.kind === 'usage_limit') this.holds.delete(provider); // rede guarda as falhas seguidas até a próxima resposta boa
    return null;
  }
  providerHolds(): { provider: AiProviderId; kind: ProviderHold['kind']; until: number; reason: string }[] {
    return [...this.holds.entries()].filter(([p]) => this.holdFor(p)).map(([provider, h]) => ({ provider, kind: h.kind, until: h.until, reason: h.reason }));
  }
  private noteProviderOk(provider: AiProviderId): void { this.holds.delete(provider); }

  /** O provedor parou por limite de uso ou falta de conexão (não é falha da tarefa): suspende a fila dele até o horário de volta
   *  (ou com espera crescente, na rede) e põe na fila a retomada da MESMA tarefa na mesma conversa, até o limite de tentativas.
   *  Se a tarefa já tinha avançado, a retomada pede para continuar conferindo o estado dos arquivos, em vez de repetir o pedido. */
  private onProviderStop(sessionId: string, t: Task, res: ResultInfo, stop: ProviderStop, provider: AiProviderId): void {
    const now = Date.now();
    const prev = this.holds.get(provider);
    const strikes = stop.kind === 'network' ? (prev?.kind === 'network' ? prev.strikes : 0) + 1 : 0;
    const until = stop.kind === 'usage_limit' ? stop.until : now + NETWORK_BACKOFF_MIN[Math.min(strikes, NETWORK_BACKOFF_MIN.length) - 1] * 60_000;
    const name = providerLabel(provider);
    const when = formatBrt(until, now);
    const reason = stop.kind === 'usage_limit'
      ? `${name} em pausa até ${when} (horário de Brasília): ${stop.label} da assinatura atingido.`
      : `${name} sem conexão com a API; nova tentativa às ${when} (falha ${strikes} seguida).`;
    this.holds.set(provider, { kind: stop.kind, until, reason, strikes });
    log.warn(`fila do provedor ${provider} suspensa até ${new Date(until).toISOString()} (${stop.kind}): ${stop.text.slice(0, 160)}`);
    this.scheduleHoldWake();

    // Parada do provedor (limite de uso, internet caída) não é falha da tarefa: a retomada NÃO gasta tentativa (09/11/2026,
    // três peças do Radar morreram numa queda de DNS). Um teto de retomadas seguidas evita repetir para sempre.
    const attempt = t.attempt ?? 1;
    const stops = this.providerStopsInChain(t);
    const s = this.store.getSession(sessionId);
    let follow: string;
    const clientId = `resume:${t.id}:${attempt + 1}`;
    if (s && s.status !== 'archived' && stops <= PROVIDER_MAX_RESUMES && !this.store.findTaskByClientId(clientId)) {
      const progressed = res.numTurns > 1 || this.taskMayHaveChanged(t);
      const cause = stop.kind === 'usage_limit' ? `o ${stop.label}` : 'falta de conexão com a API';
      const prompt = progressed
        ? `Continue a tarefa anterior de onde parou. Ela foi interrompida por ${cause}, não por erro seu. Antes de repetir qualquer ação, confira o estado atual dos arquivos para não refazer o que já foi feito.`
        : t.prompt;
      const display = progressed ? `Continuar de onde parou (retomada automática: a tarefa anterior parou por ${cause}).` : this.displayTextOf(t);
      const retry = this.store.createTask({
        clientId, sessionId, projectId: t.projectId, roomId: t.roomId, profileId: t.profileId, prompt, attachments: progressed ? [] : t.attachments, mode: 'queue',
        employeeId: t.employeeId ?? null, provider, skill: !progressed && t.skill ? { ...t.skill, confirmation: t.skill.delivery === 'inject' ? 'unknown' : 'pending', evidence: null, checkedAt: null } : null,
        attempt, retryOf: t.id, plan: t.plan, requested: t.requested ?? null, applied: t.applied ?? null, routineId: t.routineId ?? null, origin: 'retry', meetingId: t.meetingId ?? null, heldReason: reason, destinationId: t.destinationId ?? null,
      });
      const userItem: ChatItem = { id: 'user:' + retry.id, ts: retry.createdAt, taskId: retry.id, kind: 'user', text: display, attachments: retry.attachments };
      this.store.upsertChatItem(sessionId, userItem);
      this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: retry });
      this.send({ kind: 'chat.item', sessionId, item: userItem });
      follow = progressed
        ? ` A tarefa continua sozinha nesta conversa quando o ${name} voltar, conferindo o que já foi feito antes de seguir (retomada ${stops} de ${PROVIDER_MAX_RESUMES}; parada do provedor não gasta tentativa).`
        : ` Nada tinha sido feito ainda: o mesmo pedido volta sozinho quando o ${name} voltar (retomada ${stops} de ${PROVIDER_MAX_RESUMES}; parada do provedor não gasta tentativa).`;
    } else {
      follow = ` O ${name} parou ${stops} vezes seguidas nesta tarefa: ela não volta sozinha. Reexecute quando o ${name} estiver normal.`;
    }
    this.send({ kind: 'chat.item', sessionId, item: this.chatNotice(sessionId, t.id, 'warn', reason + follow) });
    // As outras tarefas desse provedor na fila mostram o mesmo motivo no cartão.
    for (const q of this.store.listTasksByStatus(['queued'])) {
      if (q.held || (q.provider ?? 'claude') !== provider || q.heldReason === reason) continue;
      this.store.updateTask(q.id, { heldReason: reason }); this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(q.id)! });
    }
  }

  /** Tarefas da cadeia (esta e as anteriores, por retryOf) que pararam pelo provedor. */
  private providerStopsInChain(t: Task): number {
    let n = 0;
    let cur: Task | null = t;
    for (let i = 0; cur && i < 40; i++) {
      if (cur.errors.some(e => PROVIDER_STOP_ERROR_RE.test(e))) n++;
      cur = cur.retryOf ? this.store.getTask(cur.retryOf) : null;
    }
    return n;
  }
  /** Quantas tarefas ANTERIORES da cadeia já foram interrompidas pelo tempo máximo. */
  private timeoutsBefore(t: Task): number {
    let n = 0;
    let cur: Task | null = t.retryOf ? this.store.getTask(t.retryOf) : null;
    for (let i = 0; cur && i < 40; i++) {
      if (cur.errors.some(e => TIMEOUT_ERROR_RE.test(e))) n++;
      cur = cur.retryOf ? this.store.getTask(cur.retryOf) : null;
    }
    return n;
  }

  /** A HQ interrompeu a tarefa pelo tempo máximo no meio do trabalho. Em vez de a peça ficar como falha, ela continua UMA vez
   *  de onde parou, na mesma conversa (o que já foi gravado fica). Se estourar de novo, para e o Chefe decide (09/11/2026). */
  private onTaskTimeout(sessionId: string, t: Task, res: ResultInfo): void {
    const s = this.store.getSession(sessionId);
    const attempt = t.attempt ?? 1;
    const clientId = `resume:${t.id}:${attempt + 1}`;
    const progressed = res.numTurns > 1 || this.taskMayHaveChanged(t);
    if (!s || s.status === 'archived' || this.store.findTaskByClientId(clientId)) return;
    if (!progressed || this.timeoutsBefore(t) >= 1) {
      const why = progressed ? 'passou do tempo máximo pela segunda vez seguida' : 'passou do tempo máximo sem avançar';
      this.send({ kind: 'chat.item', sessionId, item: this.chatNotice(sessionId, t.id, 'warn', `A tarefa ${why}: ela não continua sozinha. O que já foi gravado fica na pasta; peça para continuar quando quiser.`) });
      return;
    }
    const retry = this.store.createTask({
      clientId, sessionId, projectId: t.projectId, roomId: t.roomId, profileId: t.profileId, prompt: CONTINUE_AFTER_TIMEOUT, attachments: [], mode: 'queue',
      employeeId: t.employeeId ?? null, provider: t.provider ?? 'claude', skill: null,
      attempt, retryOf: t.id, plan: t.plan, requested: t.requested ?? null, applied: t.applied ?? null, routineId: t.routineId ?? null, origin: 'retry', meetingId: t.meetingId ?? null, destinationId: t.destinationId ?? null,
    });
    const userItem: ChatItem = { id: 'user:' + retry.id, ts: retry.createdAt, taskId: retry.id, kind: 'user', text: 'Continuar de onde parou (o tempo máximo interrompeu a tarefa; retomada automática).', attachments: [] };
    this.store.upsertChatItem(sessionId, userItem);
    this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: retry });
    this.send({ kind: 'chat.item', sessionId, item: userItem });
    this.send({ kind: 'chat.item', sessionId, item: this.chatNotice(sessionId, t.id, 'info', 'O tempo máximo interrompeu a tarefa no meio do trabalho: ela continua sozinha de onde parou, nesta conversa, conferindo o que já foi feito. Se estourar de novo, ela para e espera você.') });
  }

  /** Acorda a fila no fim da suspensão mais próxima (o agendamento é código, sem chamar modelo para ver a hora). */
  private scheduleHoldWake(): void {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    const next = Math.min(...[...this.holds.values()].map(h => h.until));
    if (!Number.isFinite(next) || this.closing) return;
    // setTimeout aceita no máximo ~24,8 dias; suspensões mais longas acordam no meio do caminho e reagendam.
    const delay = Math.min(Math.max(0, next - Date.now()) + 2000, 2 ** 31 - 1);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      const now = Date.now();
      for (const [p, h] of this.holds) {
        if (h.until > now) continue;
        for (const q of this.store.listTasksByStatus(['queued'])) if (!q.held && q.heldReason === h.reason) { this.store.updateTask(q.id, { heldReason: null }); this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(q.id)! }); }
        if (h.kind === 'usage_limit') this.holds.delete(p);
        log.info(`fila do provedor ${p} liberada (${h.kind})`);
      }
      this.dispatch();
      if ([...this.holds.values()].some(h => h.until > Date.now())) this.scheduleHoldWake();
    }, delay);
    this.holdTimer.unref?.();
  }

  /** Modo ausente: só continua o que foi autorizado (projetos/funcionários/limites). Nada aqui mexe em permissões do provedor. */
  private absenceBlockReason(t: Task, a: AbsencePolicy, started: number): string | null {
    if (!a.allowedProjectIds.includes(t.projectId)) return `${ABSENCE_HOLD_PREFIX} este projeto não está na lista do que pode continuar sem o Chefe.`;
    if (a.allowedEmployeeIds.length && t.employeeId && !a.allowedEmployeeIds.includes(t.employeeId)) return `${ABSENCE_HOLD_PREFIX} este funcionário não está autorizado a trabalhar na ausência.`;
    if (t.routineId && !a.allowRoutines) return `${ABSENCE_HOLD_PREFIX} rotinas estão desligadas na ausência.`;
    if (started >= a.maxTasks) return `${ABSENCE_HOLD_PREFIX} limite de ${a.maxTasks} tarefa(s) iniciadas na ausência atingido.`;
    if ((t.attempt ?? 1) > a.maxAttempts) return `${ABSENCE_HOLD_PREFIX} tentativa ${t.attempt} acima do limite de ${a.maxAttempts} na ausência.`;
    return null;
  }

  private async startTask(task: Task): Promise<void> {
    const s = this.store.getSession(task.sessionId)!;
    if ((task.provider ?? s.provider ?? 'claude') === 'openai') return this.startCodexTask(task, s);
    const proc = this.ensureProcess(s);
    const r = this.runtime(s.id);
    r.currentTaskId = task.id;
    r.fileChanges = new Map();
    r.apiError = null;
    // Processo já vivo: a lista de skills do init anterior é a evidência disponível agora para a skill pedida.
    const caps = proc.init ?? r.caps;
    if (proc.init) this.recordEvidence(task.id, s, proc.init, 'processo já aberto');
    if (caps && task.skill?.confirmation === 'pending') this.confirmSkill(s.id, task.id, caps);
    const content: ContentBlock[] = [];
    for (const a of task.attachments) {
      if (IMAGE_TYPES.has(a.mediaType) && a.storedPath && fs.existsSync(a.storedPath)) {
        content.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: fs.readFileSync(a.storedPath).toString('base64') } });
      }
    }
    const nonImage = task.attachments.filter(a => !IMAGE_TYPES.has(a.mediaType) && a.storedPath);
    let prefix = '';
    // O perfil que vale é o da TAREFA: com várias tarefas na fila do mesmo funcionário (ex.: revisões de marcas diferentes),
    // o perfil da conversa é o da última criada, não o desta. Sem perfil na tarefa, vale o da conversa.
    const wantProfile = task.profileId ?? s.profileId ?? null;
    if (wantProfile !== (s.profileId ?? null)) this.store.updateSession(s.id, { profileId: wantProfile });
    if (wantProfile !== r.activeProfileId) {
      const profile = this.store.getRoom(s.roomId)?.profiles.find(p => p.id === wantProfile);
      prefix = profile ? `[Perfil editorial a partir desta mensagem: ${profile.name}]\n${profile.instructions.trim()}\n\n` : (r.activeProfileId ? '[Sem perfil editorial a partir desta mensagem]\n\n' : '');
      r.activeProfileId = wantProfile;
    }
    const files = nonImage.length ? '\n\nArquivos anexados pelo Chefe (caminhos locais):\n' + nonImage.map(a => `- ${a.storedPath}`).join('\n') : '';
    // Skill nativa: a invocação precisa ser a primeira coisa da mensagem; o aviso de perfil vai depois.
    // Conhecimento da equipe: só o que vale para a equipe, projeto, função e funcionário desta tarefa; vai depois do pedido
    // (a invocação de skill nativa precisa continuar sendo a primeira coisa da mensagem).
    const known = this.deps.knowledge?.blockFor(task) ?? null;
    const text = (task.skill?.delivery === 'native' && task.prompt.startsWith('/') ? task.prompt + files + (prefix ? '\n\n' + prefix.trim() : '') : prefix + task.prompt + files) + (known ? '\n\n' + known : '');
    content.push({ type: 'text', text });
    this.store.updateTask(task.id, { status: 'running', startedAt: Date.now() });
    this.store.updateSession(s.id, { status: 'active', lastActiveAt: Date.now() });
    this.applyEvent(s.id, { type: 'hq_prompt', text: task.prompt });
    this.clearIdleTimer(r);
    proc.sendUser(content);
    this.armTaskTimer(s.id, task.id);
    this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(task.id)! });
    this.broadcastSession(s.id);
  }

  /** Funcionário OpenAI: a tarefa roda no Codex app-server (modo análise: leitura da pasta, sem aprovações). A autoria
   *  da resposta é sempre 'openai'; nenhuma resposta do Claude passa por aqui. */
  private async startCodexTask(task: Task, s: Session): Promise<void> {
    const adapter = this.deps.ai?.get('openai');
    if (!adapter) throw new Error('OpenAI (Codex) não está disponível neste serviço');
    const st = adapter.status();
    if (!st.installed) throw new Error('Codex CLI não encontrado nesta máquina');
    if (st.authState !== 'ok') throw new Error('OpenAI sem login no Codex: conclua o login com ChatGPT em Ajustes → Conexões');
    const project = this.store.getProject(s.projectId);
    if (!project) throw new Error('projeto da sessão não existe mais');
    if (!fs.existsSync(project.path)) throw new Error(`a pasta do projeto não existe: ${project.path}`);
    const room = this.store.getRoom(s.roomId);
    const r = this.runtime(s.id);
    r.currentTaskId = task.id;
    r.fileChanges = new Map();
    const attached = task.attachments.filter(a => a.storedPath);
    const known = this.deps.knowledge?.blockFor(task) ?? null;
    const text = task.prompt + (attached.length ? '\n\nArquivos anexados pelo Chefe (caminhos locais):\n' + attached.map(a => `- ${a.storedPath}`).join('\n') : '') + (known ? '\n\n' + known : '');
    this.store.updateTask(task.id, { status: 'running', startedAt: Date.now() });
    this.store.updateSession(s.id, { status: 'active', lastActiveAt: Date.now() });
    this.applyEvent(s.id, { type: 'hq_prompt', text: task.prompt });
    this.clearIdleTimer(r);
    if (!s.threadId) this.send({ kind: 'chat.item', sessionId: s.id, item: this.chatNotice(s.id, task.id, 'info', 'OpenAI (Codex) em modo análise: lê a pasta do projeto e responde, sem alterar arquivos nem rodar comandos (é assim que a HQ usa o Codex instalado).') });
    const startedAt = Date.now();
    const timeout = this.taskTimeoutMs(task.id);
    const handle = adapter.startTurn({
      meetingId: `task:${task.id}`, turnId: task.id, participantId: s.employeeId ?? s.id, threadId: s.threadId ?? null, cwd: project.path,
      systemPrompt: this.systemPromptFor(room, project, s), text, title: s.name, model: s.model ?? null, effort: s.effort ?? null,
      onDelta: acc => { r.streaming = acc; if (!r.streamTimer) r.streamTimer = setTimeout(() => { r.streamTimer = null; if (r.currentTaskId === task.id) this.send({ kind: 'chat.delta', sessionId: s.id, taskId: task.id, text: r.streaming }); }, 60); },
      ...(timeout ? { timeoutMs: timeout } : {}),
    });
    r.codexTurn = handle;
    log.info(`turno do Codex iniciado: sessão ${s.id} tarefa ${task.id} cwd ${project.path}${s.threadId ? ' (thread retomada)' : ''}`);
    this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(task.id)! });
    this.broadcastSession(s.id);
    const fallback = (err: unknown): TurnOutcome => ({ status: 'failed', text: '', threadId: s.threadId ?? null, applied: { model: s.model ?? null, effort: s.effort ?? null, resolvedModel: null }, error: String((err as Error)?.message ?? err), durationMs: Date.now() - startedAt, usage: null });
    handle.done.then(o => this.finishCodexTask(s.id, task.id, o), err => this.finishCodexTask(s.id, task.id, fallback(err)));
  }

  private finishCodexTask(sessionId: string, taskId: string, o: TurnOutcome): void {
    const r = this.runtime(sessionId);
    r.codexTurn = null;
    if (r.streamTimer) { clearTimeout(r.streamTimer); r.streamTimer = null; }
    r.streaming = '';
    if (o.threadId) this.store.updateSession(sessionId, { threadId: o.threadId });
    const t = this.store.getTask(taskId);
    if (t) this.store.updateTask(taskId, { applied: { model: o.applied.resolvedModel ?? o.applied.model ?? t.applied?.model ?? null, effort: o.applied.effort ?? t.applied?.effort ?? null, permissionMode: t.applied?.permissionMode ?? 'default', source: `${t.applied?.source ?? 'conversa'} · modo análise do Codex` } });
    if (o.text.trim()) {
      const item: ChatItem = { id: `openai:${taskId}:text`, ts: Date.now(), taskId, kind: 'assistant', text: o.text, author: 'openai' };
      this.store.upsertChatItem(sessionId, item); this.send({ kind: 'chat.item', sessionId, item });
    }
    const subtype = o.status === 'done' ? 'success' : o.status === 'interrupted' ? 'interrupted' : 'error_during_execution';
    const terminalReason = o.status === 'interrupted' ? 'aborted_streaming' : 'completed';
    const errors = o.error ? [o.error] : [];
    // Mesmo evento 'result' sintético que o Claude Code emite: a trilha de atividade e o registro ficam iguais para os dois provedores.
    this.applyEvent(sessionId, { type: 'result', subtype, is_error: o.status === 'failed', terminal_reason: terminalReason, duration_ms: o.durationMs, num_turns: 1, errors });
    this.handleResult(sessionId, { subtype, isError: o.status === 'failed', numTurns: 1, durationMs: o.durationMs, stopReason: null, terminalReason, resultText: o.text, errors, permissionDenials: [], sessionId: o.threadId ?? '', usage: o.usage ? (o.usage as unknown as Record<string, unknown>) : undefined });
  }

  // ---------------- limites de duração ----------------
  /** Limite próprio de alguns fluxos (ex.: sala de conteúdo: pesquisa e produção têm teto de minutos). null = sem limite próprio. */
  private taskLimit: ((taskId: string) => number | null) | null = null;
  setTaskLimit(fn: (taskId: string) => number | null): void { this.taskLimit = fn; }
  /** Navegador da HQ: servidor MCP (com o token da conversa) para funcionários com acesso ao navegador. */
  private browserMcp: ((sessionId: string) => import('./access.js').BrowserMcp | null) | null = null;
  setBrowserMcp(fn: (sessionId: string) => import('./access.js').BrowserMcp | null): void { this.browserMcp = fn; }
  /** Aviso da HQ na conversa (linha do tempo da tarefa atual do funcionário). */
  noticeTo(sessionId: string, level: 'info' | 'warn' | 'error', text: string): void {
    const r = this.runtime(sessionId); if (!r.currentTaskId) return;
    this.send({ kind: 'chat.item', sessionId, item: this.chatNotice(sessionId, r.currentTaskId, level, text) });
  }
  /** Funcionário dono da conversa (para mostrar quem está no navegador). */
  sessionLabel(sessionId: string): string { const s = this.store.getSession(sessionId); const e = s?.employeeId ? this.store.getEmployee(s.employeeId) : null; return e?.name ?? s?.name ?? 'funcionário'; }
  taskSession(taskId: string): string | null { return this.store.getTask(taskId)?.sessionId ?? null; }
  private taskTimeoutMs(taskId?: string): number | null {
    const s = this.store.getSettings();
    const own = taskId && this.taskLimit ? this.taskLimit(taskId) : null;
    const mins = [s.maxTaskMinutes, s.absence.enabled ? s.absence.maxTaskMinutes : 0, own ?? 0].filter(m => typeof m === 'number' && m > 0);
    return mins.length ? Math.min(...mins) * 60_000 : null;
  }
  /** Arma o limite da tarefa. `leftMs` retoma um relógio que parou enquanto a tarefa esperava o Chefe. */
  private armTaskTimer(sessionId: string, taskId: string, leftMs?: number) {
    const r = this.runtime(sessionId);
    this.clearTaskTimer(r);
    const full = this.taskTimeoutMs(taskId); if (!full) return;
    const ms = leftMs ?? full;
    r.taskDeadline = Date.now() + ms;
    r.taskTimer = setTimeout(() => {
      r.taskTimer = null; r.taskDeadline = null;
      if (r.currentTaskId !== taskId) return;
      r.timedOutTaskId = taskId;
      const minutes = Math.round(full / 60_000);
      log.warn(`tarefa ${taskId} passou de ${minutes} min: interrompendo`);
      const t = this.store.getTask(taskId);
      if (t) this.store.updateTask(taskId, { errors: [...t.errors, `Tempo máximo de ${minutes} min atingido; a HQ interrompeu a execução.`] });
      this.send({ kind: 'chat.item', sessionId, item: this.chatNotice(sessionId, taskId, 'warn', `Tempo máximo de ${minutes} min atingido: execução interrompida pela HQ (Ajustes → limites).`) });
      this.interrupt(sessionId).catch(() => { /* registrado no result */ });
    }, ms);
    r.taskTimer.unref?.();
  }
  private clearTaskTimer(r: Runtime) { if (r.taskTimer) { clearTimeout(r.taskTimer); r.taskTimer = null; } r.taskDeadline = null; r.taskPausedLeft = null; }
  /** Esperando o Chefe (permissão ou pergunta): o relógio da tarefa para. Tempo de espera não é tempo de trabalho (09/11/2026). */
  private pauseTaskTimer(r: Runtime) {
    if (!r.taskTimer || r.taskDeadline === null) return;
    const left = Math.max(1000, r.taskDeadline - Date.now());
    clearTimeout(r.taskTimer); r.taskTimer = null; r.taskDeadline = null;
    r.taskPausedLeft = left;
  }
  /** O Chefe respondeu tudo o que estava pendente: o relógio volta a contar de onde parou. */
  private resumeTaskTimer(sessionId: string) {
    const r = this.runtime(sessionId);
    if (r.taskPausedLeft === null || !r.currentTaskId) return;
    const left = r.taskPausedLeft;
    this.armTaskTimer(sessionId, r.currentTaskId, left);
  }

  private ensureProcess(s: Session): ClaudeProcess {
    const existing = this.procs.get(s.id);
    if (existing?.alive) return existing;
    const exe = this.deps.exePath();
    if (!exe) throw new Error('Claude Code não encontrado nesta máquina');
    const project = this.store.getProject(s.projectId);
    if (!project) throw new Error('projeto da sessão não existe mais');
    if (!fs.existsSync(project.path)) throw new Error(`a pasta do projeto não existe: ${project.path}`);
    const room = this.store.getRoom(s.roomId);
    const employee = s.employeeId ? this.store.getEmployee(s.employeeId) : null;
    const proc = new ClaudeProcess({
      exePath: exe,
      commandPrefixArgs: this.deps.commandPrefixArgs,
      cwd: project.path,
      model: s.model ?? undefined,
      effort: s.effort ?? undefined,
      // Funcionário importado de um agente nativo com lista de ferramentas: a restrição vale em todas as conversas dele (--tools).
      tools: employee?.agent?.tools ?? undefined,
      permissionMode: s.permissionMode === 'default' ? undefined : s.permissionMode,
      resume: s.claudeSessionId ?? undefined,
      sessionId: s.claudeSessionId ? undefined : s.id,
      sessionName: s.claudeSessionId ? undefined : s.name,
      appendSystemPrompt: s.claudeSessionId ? undefined : this.systemPromptFor(room, project, s),
      // Marco 0: política de acesso do funcionário (MCP) + integrações bloqueadas (regras de negação e ambiente sem credenciais).
      extraArgs: [...(this.deps.extraArgs ?? []), ...(s.ultracode ? ['--settings', '{"ultracode":true}'] : []), ...claudeAccessArgs(normalizeAccess(employee?.access), normalizeAccess(employee?.access).browser ? this.browserMcp?.(s.id) ?? null : null)],
      env: isolatedEnv(childEnv(), this.deps.isolationDir ?? path.join(os.tmpdir(), 'milweb-hq-isolamento')),
    });
    this.wire(s.id, proc);
    proc.start();
    this.procs.set(s.id, proc);
    // Processo novo recebe o perfil no system prompt; num --resume o perfil em vigor é o do primeiro início (desconhecido aqui).
    this.runtime(s.id).activeProfileId = s.claudeSessionId ? undefined : (s.profileId ?? null);
    log.info(`processo iniciado: sessão ${s.id} pid ${proc.pid} cwd ${project.path}${s.claudeSessionId ? ' (resume)' : ''}`);
    return proc;
  }

  private systemPromptFor(room: Room | null, project: Project, s: Session): string {
    const e = s.employeeId ? this.store.getEmployee(s.employeeId) : null;
    // Empresa operadora: o nome escolhido no primeiro acesso (Ajustes → Empresa). Perfil editorial e equipe vêm depois, separados.
    const company = companyForAgents(this.store.getSettings());
    const who = e ? `Você é ${e.name}${e.role ? ` (${e.role})` : ''} e trabalha para ${company}` : `Você trabalha para ${company}`;
    const parts = [
      `${who}. Quem dirige a empresa e decide é o Chefe. Sala: ${room?.name ?? 'sem sala'}. Projeto: ${project.name} (pasta ${project.path}). Trabalhe somente nessa pasta, salvo pedido explícito. Responda em português do Brasil, de forma direta.`,
    ];
    if (e?.instructions?.trim()) parts.push(`Instruções de atuação de ${e.name}:\n${e.instructions.trim()}`);
    if (room?.instructions?.trim()) parts.push(`Instruções da sala:\n${room.instructions.trim()}`);
    const profile = room?.profiles.find(p => p.id === s.profileId);
    if (profile) parts.push(`Perfil editorial selecionado: ${profile.name}.\n${profile.instructions.trim()}`);
    // Equipe (08/11): o executor sabe de qual equipe é o trabalho, quais canais ela atende e que não mistura com a outra.
    if (isTeamId(s.profileId)) {
      const t = teamDef(s.profileId);
      parts.push(`Equipe desta tarefa: ${t.label} (${t.slots.map(sl => CHANNEL_LABEL[sl] ?? sl).join(' + ')}). Foco: ${t.focus}. Trabalhe só para estes canais; ideia que sirva à outra equipe vira adaptação identificada para ela, sem misturar contexto.`);
    }
    if (isDmSession(s)) parts.push(DM_RULES);
    return parts.join('\n\n');
  }

  /**
   * Conversa particular com um funcionário (08/11, Chefe: "tem que ter como eu conversar individualmente com os funcionários, uma
   * conversa que fica só entre a gente"): sessão própria, na mesma pasta do trabalho dele, que não vira a conversa ativa (as
   * tarefas continuam na sessão de trabalho) e não aparece no mural.
   */
  openDm(employeeId: string): Session {
    const e = this.store.getEmployee(employeeId);
    if (!e) throw new Error('funcionário não encontrado');
    if (e.archivedAt) throw new Error(`${e.name} está arquivado: restaure antes de conversar.`);
    const found = this.store.listSessionsByEmployee(e.id).find(x => isDmSession(x) && x.status !== 'archived' && x.controllable);
    if (found) return found;
    const all = this.store.listSessionsByEmployee(e.id).filter(x => !isDmSession(x));
    const active = e.activeSessionId ? this.store.getSession(e.activeSessionId) : null;
    const room = this.store.getRoom(e.roomId);
    const roomProject = room?.kind === 'social' ? this.store.listProjects().find(p => p.roomId === room.id) ?? null : null;
    const projectId = roomProject?.id ?? (active && !isDmSession(active) ? active.projectId : null) ?? all[0]?.projectId ?? this.store.listProjects().find(p => p.roomId === e.roomId)?.id ?? null;
    if (!projectId) throw new Error(`${e.name} ainda não tem pasta de trabalho: abra uma conversa normal com ele primeiro.`);
    const prev = e.activeSessionId;
    const s = this.createSession({ roomId: e.roomId, projectId, employeeId: e.id, name: DM_SESSION_NAME });
    this.store.updateEmployee(e.id, { activeSessionId: prev ?? null });
    this.send({ kind: 'entity', entity: 'employee', op: 'upsert', item: this.store.getEmployee(e.id)! });
    return s;
  }

  private wire(sessionId: string, proc: ClaudeProcess) {
    proc.on('init', info => {
      const s = this.store.getSession(sessionId); if (!s) return;
      this.store.updateSession(sessionId, { claudeSessionId: info.sessionId, claudeVersion: info.claudeCodeVersion ?? null, status: 'active', lastError: null });
      const mcp = info.mcpServers?.length ? info.mcpServers.map(m => m.name).join(', ') : 'nenhum';
      this.applyEvent(sessionId, { type: 'hq_note', summary: `Processo iniciado · modelo ${info.model} · permissão ${info.permissionMode} · MCP: ${mcp}${s.effort ? ` · esforço enviado: ${s.effort} (não confirmado pelo CLI)` : ''}${s.ultracode ? ' · Ultracode enviado (não confirmado pelo CLI)' : ''}` });
      const tid = this.runtime(sessionId).currentTaskId;
      if (tid) this.recordEvidence(tid, s, info, 'init do Claude Code');
      this.noteCaps(sessionId, s, info);
      this.broadcastSession(sessionId);
    });
    proc.on('raw', ev => this.handleRaw(sessionId, ev));
    proc.on('turn_started', ({ auto }) => { if (auto) this.handleAutoTurn(sessionId); });
    proc.on('permission_request', req => this.handlePermission(sessionId, req));
    proc.on('permission_resolved', ({ requestId, result }) => this.applyEvent(sessionId, { type: 'hq_permission_resolved', requestId, result }));
    proc.on('result', r => this.handleResult(sessionId, r));
    proc.on('stderr', text => { if (text.trim()) log.debug(`[stderr ${sessionId.slice(0, 8)}] ${text.trim().slice(0, 500)}`); });
    proc.on('spawn_error', err => {
      log.error('spawn falhou', err);
      this.store.updateSession(sessionId, { lastError: `Falha ao iniciar o Claude Code: ${err.message}` });
    });
    proc.on('state', () => this.broadcastSession(sessionId));
    proc.on('exit', info => this.handleExit(sessionId, proc, info));
  }

  /** Evidência do provedor na tarefa: só o que o init informa conta como confirmado (modelo, permissão, MCP). */
  private recordEvidence(taskId: string, s: Session, info: InitInfo, source: 'init do Claude Code' | 'processo já aberto') {
    const evidence: TaskEvidence = {
      source, model: info.model ?? null, permissionMode: info.permissionMode ?? null, mcpServers: (info.mcpServers ?? []).map(m => m.name),
      cliVersion: info.claudeCodeVersion ?? null, at: Date.now(), sentEffort: s.effort ?? null, sentUltracode: Boolean(s.ultracode),
    };
    const t = this.store.updateTask(taskId, { evidence });
    if (t) this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: t });
  }

  /** Guarda o que o Claude Code declarou no init (skills, comandos, ferramentas, plugins) por projeto: é a evidência
   *  "verificado na última conversa" do catálogo e a base da confirmação da skill pedida. */
  private noteCaps(sessionId: string, s: Session, info: InitInfo) {
    const r = this.runtime(sessionId);
    r.caps = info;
    const caps: ProviderCaps = { skills: info.skills ?? [], slashCommands: info.slashCommands ?? [], agents: [], plugins: (info.plugins ?? []).map(p => ({ name: p.name })), tools: info.tools, model: info.model, version: info.claudeCodeVersion ?? null };
    this.store.saveProviderCaps(s.projectId, 'claude', caps);
    this.send({ kind: 'skills.changed' });
    if (r.currentTaskId) this.confirmSkill(sessionId, r.currentTaskId, info);
  }

  /** Skill pedida x confirmada: a evidência é a lista de skills/comandos do init do processo que executa a tarefa. */
  private confirmSkill(sessionId: string, taskId: string, info: InitInfo) {
    const t = this.store.getTask(taskId);
    if (!t?.skill || t.skill.confirmation !== 'pending') return;
    const name = t.skill.requested;
    const listed = (info.skills ?? []).includes(name) || (info.slashCommands ?? []).includes(name);
    const version = info.claudeCodeVersion ? ` ${info.claudeCodeVersion}` : '';
    const skill: SkillUsage = { ...t.skill, confirmation: listed ? 'listed' : 'not_listed', checkedAt: Date.now(),
      evidence: listed ? `"${name}" consta na lista de skills do init do Claude Code${version} (sessão ${info.sessionId.slice(0, 8)})` : `"${name}" não consta na lista de skills do init do Claude Code${version}: a invocação pode ter sido lida como texto comum` };
    this.store.updateTask(taskId, { skill });
    this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(taskId)! });
    if (!listed) this.send({ kind: 'chat.item', sessionId, item: this.chatNotice(sessionId, taskId, 'warn', `A skill "${name}" não apareceu na lista do Claude Code para este projeto; ela pode não ter sido ativada.`) });
  }

  // ---------------- eventos ----------------
  private applyEvent(sessionId: string, ev: RawEvent) {
    const r = this.runtime(sessionId);
    const { state, log: entries } = reduceActivity(r.activity, ev);
    const changed = state.phase !== r.activity.phase || state.detail !== r.activity.detail || state.turnActive !== r.activity.turnActive || state.activeTasks.length !== r.activity.activeTasks.length;
    r.activity = state;
    for (const e of entries) {
      const seq = this.store.appendEvent(sessionId, r.currentTaskId, e);
      this.send({ kind: 'event', seq, sessionId, taskId: r.currentTaskId, entry: e });
    }
    if (changed) this.broadcastSession(sessionId);
  }

  private handleRaw(sessionId: string, ev: RawEvent) {
    const r = this.runtime(sessionId);
    // Texto parcial: agrupa deltas e envia a cada ~60 ms.
    if (ev.type === 'stream_event') {
      const e = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string' && !(ev.parent_tool_use_id)) {
        r.streaming += e.delta.text;
        if (!r.streamTimer) r.streamTimer = setTimeout(() => { r.streamTimer = null; if (r.currentTaskId) this.send({ kind: 'chat.delta', sessionId, taskId: r.currentTaskId, text: r.streaming }); }, 60);
      }
    }
    if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
      const apiError = (ev as { error?: unknown }).error;
      if (apiError && r.currentTaskId) r.apiError = typeof apiError === 'string' ? apiError : JSON.stringify(apiError);
      const blocks = ((ev.message as { content?: Record<string, unknown>[] })?.content) ?? [];
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && r.currentTaskId) {
          r.streaming = '';
          const item: ChatItem = { id: `${String(ev.uuid ?? randomUUID())}:text:${blocks.indexOf(b)}`, ts: Date.now(), taskId: r.currentTaskId, kind: 'assistant', text: b.text, author: 'claude' };
          this.store.upsertChatItem(sessionId, item); this.send({ kind: 'chat.item', sessionId, item });
          this.send({ kind: 'chat.delta', sessionId, taskId: r.currentTaskId, text: '' });
        } else if (b.type === 'tool_use') {
          const name = String(b.name); const input = (b.input as Record<string, unknown>) ?? {};
          const filePath = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
          if (r.currentTaskId && name === 'Skill' && typeof input.skill === 'string') {
            // Evidência mais forte de ativação: o Claude Code invocou a ferramenta Skill com o nome pedido.
            const t = this.store.getTask(r.currentTaskId);
            if (t?.skill && t.skill.requested === input.skill && t.skill.confirmation !== 'listed') {
              this.store.updateTask(t.id, { skill: { ...t.skill, confirmation: 'listed', checkedAt: Date.now(), evidence: `ferramenta Skill invocada pelo Claude Code com "${input.skill}"` } });
              this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(t.id)! });
            }
          }
          if (r.currentTaskId) {
            if (filePath && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
              if (!r.fileChanges.has(filePath)) r.fileChanges.set(filePath, fs.existsSync(filePath) ? 'modified' : 'created');
              const t = this.store.getTask(r.currentTaskId);
              if (t && !t.touchedFiles.includes(filePath)) { this.store.updateTask(t.id, { touchedFiles: [...t.touchedFiles, filePath] }); this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(t.id)! }); }
            }
            const item: ChatItem = { id: 'tool:' + String(b.id), ts: Date.now(), taskId: r.currentTaskId, kind: 'tool', toolUseId: String(b.id), name, summary: summarizeToolInput(name, input), input, done: false };
            this.store.upsertChatItem(sessionId, item); this.send({ kind: 'chat.item', sessionId, item });
          }
        }
      }
    }
    if (ev.type === 'user') {
      const blocks = ((ev.message as { content?: Record<string, unknown>[] })?.content) ?? [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const id = 'tool:' + String(b.tool_use_id);
          const prev = this.store.getChatItem(id);
          if (prev && prev.kind === 'tool') {
            const content = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as { text?: string }[]).map(c => c.text ?? '').join('\n') : JSON.stringify(b.content ?? '');
            const item: ChatItem = { ...prev, done: true, isError: Boolean(b.is_error), output: content.slice(0, 4000) };
            this.store.upsertChatItem(sessionId, item); this.send({ kind: 'chat.item', sessionId, item });
          }
        }
      }
    }
    this.applyEvent(sessionId, ev);
  }

  private handleAutoTurn(sessionId: string) {
    const r = this.runtime(sessionId);
    if (!r.currentTaskId) {
      const last = this.store.listTasksBySession(sessionId, 1)[0];
      if (last) { r.currentTaskId = last.id; this.store.updateTask(last.id, { status: 'running' }); this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(last.id)! }); }
    }
    this.applyEvent(sessionId, { type: 'hq_turn_started', auto: true });
  }

  private handlePermission(sessionId: string, req: PermissionRequest) {
    const r = this.runtime(sessionId);
    const isQuestion = req.toolName === 'AskUserQuestion';
    const questions = isQuestion ? ((req.input as { questions?: QuestionSpec[] }).questions ?? []) : undefined;
    const pending: PendingPermission = { sessionId, taskId: r.currentTaskId, request: req, isQuestion, questions };
    r.pending.set(req.requestId, pending);
    if (r.currentTaskId) {
      this.store.updateTask(r.currentTaskId, { status: isQuestion ? 'waiting_answer' : 'waiting_permission' });
      this.pauseTaskTimer(r);
      this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(r.currentTaskId)! });
      const item: ChatItem = isQuestion
        ? { id: 'perm:' + req.requestId, ts: Date.now(), taskId: r.currentTaskId, kind: 'question', requestId: req.requestId, questions: questions ?? [] }
        : { id: 'perm:' + req.requestId, ts: Date.now(), taskId: r.currentTaskId, kind: 'permission', requestId: req.requestId, toolName: req.toolName, summary: summarizeToolInput(req.toolName, req.input), input: req.input };
      this.store.upsertChatItem(sessionId, item); this.send({ kind: 'chat.item', sessionId, item });
    }
    // O evento bruto control_request também passa por handleRaw → applyEvent (registro e fase); não duplicar aqui.
    this.send({ kind: 'permission.request', pending });
  }

  respondPermission(sessionId: string, requestId: string, behavior: 'allow' | 'deny', message?: string, remember?: PermissionUpdate[]): void {
    const p = this.procs.get(sessionId); const r = this.runtime(sessionId);
    const pending = r.pending.get(requestId);
    if (!p?.alive || !pending) throw new Error('pedido de permissão não está mais pendente');
    const result: PermissionResult = behavior === 'allow' ? { behavior: 'allow', ...(remember?.length ? { updatedPermissions: remember } : {}) } : { behavior: 'deny', message: message?.trim() || 'Negado pelo Chefe no My Company AI.' };
    p.respondPermission(requestId, result);
    this.finishPending(sessionId, requestId, behavior, message);
  }

  answerQuestion(sessionId: string, requestId: string, answers: Record<string, string>): void {
    const p = this.procs.get(sessionId); const r = this.runtime(sessionId);
    const pending = r.pending.get(requestId);
    if (!p?.alive || !pending) throw new Error('pergunta não está mais pendente');
    p.answerQuestion(requestId, answers);
    this.finishPending(sessionId, requestId, 'allow', undefined, answers);
  }

  private finishPending(sessionId: string, requestId: string, behavior: 'allow' | 'deny', message?: string, answers?: Record<string, string>) {
    const r = this.runtime(sessionId);
    r.pending.delete(requestId);
    const item = this.store.getChatItem('perm:' + requestId);
    if (item && item.kind === 'permission') { const next: ChatItem = { ...item, decision: behavior, message }; this.store.upsertChatItem(sessionId, next); this.send({ kind: 'chat.item', sessionId, item: next }); }
    if (item && item.kind === 'question') { const next: ChatItem = { ...item, answers }; this.store.upsertChatItem(sessionId, next); this.send({ kind: 'chat.item', sessionId, item: next }); }
    if (r.currentTaskId && r.pending.size === 0) { this.store.updateTask(r.currentTaskId, { status: 'running' }); this.resumeTaskTimer(sessionId); this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(r.currentTaskId)! }); }
    this.send({ kind: 'permission.resolved', sessionId, requestId, behavior });
  }

  async interrupt(sessionId: string): Promise<void> {
    const rt = this.rt.get(sessionId);
    if (rt?.codexTurn) {
      // Funcionário OpenAI: turn/interrupt no Codex; o done resolve com 'interrupted' e finishCodexTask fecha a tarefa.
      const handle = rt.codexTurn;
      this.applyEvent(sessionId, { type: 'hq_interrupt' });
      try { await handle.interrupt(); } catch (err) { log.warn(`interrupt do Codex falhou (sessão ${sessionId.slice(0, 8)})`, err); }
      await Promise.race([handle.done.catch(() => undefined), new Promise<void>(res => { const t = setTimeout(res, 20_000); t.unref?.(); })]);
      return;
    }
    const p = this.procs.get(sessionId);
    if (!p?.alive || !p.turnActive) return;
    this.applyEvent(sessionId, { type: 'hq_interrupt' });
    const r = this.runtime(sessionId);
    // Pedidos pendentes são abandonados pelo CLI na interrupção; limpa para a UI não ficar presa.
    for (const id of [...r.pending.keys()]) { r.pending.delete(id); this.send({ kind: 'permission.resolved', sessionId, requestId: id, behavior: 'deny' }); }
    // O result da interrupção pode chegar no mesmo lote de linhas que a resposta de controle: escutar antes de pedir.
    const settled = new Promise<void>(resolve => {
      const done = () => { p.off('result', done); p.off('exit', done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 20_000); timer.unref?.();
      p.on('result', done); p.on('exit', done);
    });
    try { await p.interrupt(); } catch (err) { log.warn(`interrupt sem resposta de controle (sessão ${sessionId.slice(0, 8)})`, err); }
    await settled;
  }

  private handleResult(sessionId: string, res: ResultInfo) {
    const r = this.runtime(sessionId);
    if (r.streamTimer) { clearTimeout(r.streamTimer); r.streamTimer = null; }
    r.streaming = '';
    this.clearTaskTimer(r);
    const taskId = r.currentTaskId;
    const timedOut = !!taskId && r.timedOutTaskId === taskId;
    r.timedOutTaskId = null;
    r.currentTaskId = null;
    r.pending.clear();
    const interrupted = res.terminalReason === 'aborted_streaming' || res.terminalReason === 'aborted_tools';
    const status: Task['status'] = interrupted ? 'interrupted' : res.isError ? 'error' : 'done';
    if (taskId) {
      const t = this.store.getTask(taskId);
      const s = this.store.getSession(sessionId);
      if (t && s?.claudeSessionId && res.isError && !interrupted && res.errors.some(e => LOST_SESSION_RE.test(e))) {
        // `--resume` de uma conversa que o Claude Code não encontra mais (transcrição apagada ou nunca gravada): a HQ esquece o id,
        // avisa e trata como interrupção antes de começar — nada rodou, então a tarefa pode voltar para a fila até o limite de tentativas.
        const reason = `A conversa anterior não existe mais no Claude Code (id ${s.claudeSessionId}); a próxima mensagem começa uma conversa nova, com o histórico da HQ preservado.`;
        this.store.updateSession(sessionId, { claudeSessionId: null });
        // O processo com `--resume` inválido vai sair sozinho; solta-o já para a nova tentativa subir um processo limpo (sem resume).
        const dying = this.procs.get(sessionId);
        if (dying) this.retireProcess(sessionId, dying, 2000);
        this.send({ kind: 'chat.item', sessionId, item: this.chatNotice(sessionId, taskId, 'warn', reason) });
        this.recoverInterruptedTask(t, reason, this.store.getSettings().maxAttempts);
        this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(taskId)! });
        const retry = this.store.findTaskByClientId(`retry:${t.id}:${(t.attempt ?? 1) + 1}`);
        if (retry) {
          this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: retry });
          const userItem = this.store.getChatItem('user:' + retry.id); if (userItem) this.send({ kind: 'chat.item', sessionId, item: userItem });
        }
      } else if (t) {
        const stop = classifyProviderStop({ isError: res.isError, terminalReason: res.terminalReason, resultText: res.resultText, errors: res.errors, apiError: r.apiError, rateLimit: r.activity.rateLimit ?? null, now: Date.now() });
        r.apiError = null;
        const provider: AiProviderId = t.provider ?? 'claude';
        const deliverables = this.buildDeliverables(t, res, r.fileChanges);
        const errors = [...t.errors, ...res.errors.filter(e => !t.errors.includes(e)), ...(stop ? [stop.kind === 'usage_limit' ? `Parada pelo ${stop.label} do ${providerLabel(provider)}: ${stop.text}` : `Sem resposta da API do ${providerLabel(provider)}: ${stop.text}`] : [])];
        this.store.updateTask(taskId, { status, finishedAt: Date.now(), resultText: res.resultText || t.resultText, resultSubtype: res.subtype, terminalReason: res.terminalReason ?? null, errors, durationMs: res.durationMs, numTurns: res.numTurns, costUsd: res.totalCostUsd ?? null, deliverables });
        const summary = interrupted ? 'Execução interrompida' : res.isError ? `Terminou com erro${resultErrorHint(res.subtype)}` : `Resposta pronta em ${Math.round(res.durationMs / 1000)} s · ${res.numTurns} passo${res.numTurns === 1 ? '' : 's'}`;
        const item: ChatItem = { id: 'result:' + taskId + ':' + Date.now(), ts: Date.now(), taskId, kind: 'result', status, summary, durationMs: res.durationMs, numTurns: res.numTurns, costUsd: res.totalCostUsd };
        this.store.upsertChatItem(sessionId, item); this.send({ kind: 'chat.item', sessionId, item });
        if (res.isError && !interrupted && res.errors.length) this.send({ kind: 'chat.item', sessionId, item: this.chatNotice(sessionId, taskId, 'error', res.errors.join('\n')) });
        this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(taskId)! });
        // A continuação (retomada) nasce antes do aviso de fim: quem segue a tarefa (conteúdo, mesa) já encontra a próxima tentativa.
        if (stop) this.onProviderStop(sessionId, this.store.getTask(taskId)!, res, stop, provider);
        else if (!res.isError) this.noteProviderOk(provider);
        if (timedOut && interrupted && !stop) this.onTaskTimeout(sessionId, this.store.getTask(taskId)!, res);
        this.emit('task_finished', taskId);
      }
    }
    this.store.updateSession(sessionId, { lastActiveAt: Date.now(), activity: r.activity });
    this.send({ kind: 'chat.delta', sessionId, taskId: taskId ?? '', text: '' });
    this.broadcastSession(sessionId);
    if (r.restartAfterTurn) { r.restartAfterTurn = false; const p = this.procs.get(sessionId); if (p?.alive && !p.turnActive) this.retireProcess(sessionId, p); }
    this.scheduleIdleClose(sessionId);
    this.emit('turn_finished');
    this.dispatch();
  }

  private buildDeliverables(t: Task, res: ResultInfo, fileChanges: Map<string, 'created' | 'modified'>): Deliverable[] {
    const out: Deliverable[] = [...t.deliverables];
    const now = Date.now();
    for (const f of t.touchedFiles) {
      if (out.some(d => d.kind === 'file' && d.path === f)) continue;
      const changeType: Deliverable['changeType'] = !fs.existsSync(f) ? 'deleted' : fileChanges.get(f) ?? 'unknown';
      out.push({ id: randomUUID(), taskId: t.id, kind: 'file', title: path.basename(f), path: f, changeType, createdAt: now });
    }
    const urls = new Set<string>();
    for (const m of (res.resultText || '').matchAll(LOCAL_URL_RE)) urls.add(m[0].replace(/[.,;:]+$/, ''));
    for (const u of urls) if (!out.some(d => d.kind === 'url' && d.url === u)) out.push({ id: randomUUID(), taskId: t.id, kind: 'url', title: 'Endereço local citado na resposta', url: u, createdAt: now });
    const room = this.store.getRoom(t.roomId);
    if (room && room.kind !== 'dev' && res.resultText && !res.isError) {
      out.push({ id: randomUUID(), taskId: t.id, kind: 'text', title: res.resultText.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').slice(0, 80) || 'Texto da resposta', text: res.resultText, createdAt: now });
    }
    const project = this.store.getProject(t.projectId);
    if (project && !project.previewUrl && urls.size) this.store.updateProject(project.id, { previewUrl: [...urls][0] });
    return out;
  }

  /** Tira o processo do lugar AGORA (o próximo turno sobe outro, com --resume e as flags novas) e encerra o antigo em
   *  segundo plano. Sem isso, a tarefa seguinte podia ser escrita no stdin do processo que estava fechando ("processo não está
   *  disponível para escrita") e a saída atrasada dele zerava a tarefa nova. */
  private retireProcess(sessionId: string, p: ClaudeProcess, graceMs = 3000): void {
    if (this.procs.get(sessionId) === p) this.procs.delete(sessionId);
    this.retired.add(p);
    const s = this.store.getSession(sessionId);
    if (s && s.status === 'active' && !this.runtime(sessionId).currentTaskId) this.store.updateSession(sessionId, { status: s.claudeSessionId ? 'paused' : 'new' });
    p.close(graceMs).catch(() => { /* já saiu */ });
  }
  private retired = new WeakSet<ClaudeProcess>();

  private handleExit(sessionId: string, proc: ClaudeProcess, info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) {
    if (this.retired.has(proc)) { log.debug(`sessão ${sessionId}: processo aposentado pid ${proc.pid} encerrou (código ${info.code ?? '?'})`); return; }
    const current = this.procs.get(sessionId);
    if (current && current !== proc) {
      // Processo antigo que saiu depois de já ter sido substituído (ex.: --resume inválido): não mexe no estado da sessão nova.
      log.debug(`sessão ${sessionId}: processo anterior pid ${proc.pid} encerrou (código ${info.code ?? '?'}); um processo novo já está no lugar`);
      return;
    }
    if (current === proc) this.procs.delete(sessionId);
    const r = this.runtime(sessionId);
    const s = this.store.getSession(sessionId);
    if (!s) return;
    const resumable = Boolean(s.claudeSessionId);
    this.clearTaskTimer(r);
    if (info.expected || this.closing) {
      this.store.updateSession(sessionId, { status: resumable ? 'paused' : 'new' });
    } else {
      const reason = `O processo do Claude Code encerrou sozinho (código ${info.code ?? '?'}${info.signal ? ', sinal ' + info.signal : ''}).${proc.stderrTail.trim() ? ' ' + proc.stderrTail.trim().slice(-300) : ''}`;
      log.warn(`sessão ${sessionId}: ${reason}`);
      this.store.updateSession(sessionId, { status: 'lost', lastError: reason });
      if (r.currentTaskId) {
        const t = this.store.getTask(r.currentTaskId);
        if (t) {
          // Mesma política do reinício: conferir antes de repetir se algo pode ter mudado; senão nova tentativa até o limite.
          this.recoverInterruptedTask(t, reason, this.store.getSettings().maxAttempts);
          this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: this.store.getTask(t.id)! });
          for (const c of this.store.listChat(sessionId, 10).filter(c => c.ts >= (this.store.getTask(t.id)?.finishedAt ?? 0) - 50)) this.send({ kind: 'chat.item', sessionId, item: c });
          const retry = this.store.findTaskByClientId(`retry:${t.id}:${(t.attempt ?? 1) + 1}`);
          if (retry) this.send({ kind: 'entity', entity: 'task', op: 'upsert', item: retry });
        }
      }
      for (const id of [...r.pending.keys()]) { r.pending.delete(id); this.send({ kind: 'permission.resolved', sessionId, requestId: id, behavior: 'deny' }); }
      this.applyEvent(sessionId, { type: 'hq_disconnected', reason });
    }
    r.currentTaskId = null;
    this.broadcastSession(sessionId);
    this.emit('turn_finished');
    this.dispatch();
  }

  // ---------------- utilidades ----------------
  private chatNotice(sessionId: string, taskId: string, level: 'info' | 'warn' | 'error', text: string): ChatItem {
    const item: ChatItem = { id: randomUUID(), ts: Date.now(), taskId, kind: 'notice', level, text };
    this.store.upsertChatItem(sessionId, item);
    return item;
  }

  private broadcastSession(sessionId: string) {
    const s = this.store.getSession(sessionId); if (!s) return;
    const r = this.runtime(sessionId);
    const view = this.sessionView(s);
    const worker = this.workerFor(s);
    const key = JSON.stringify([view.status, view.processState, view.activity.phase, view.activity.detail, worker?.busy, worker?.status, view.lastError]);
    if (key === r.lastBroadcastKey) return;
    r.lastBroadcastKey = key;
    if (worker && worker.sessionId === sessionId) this.send({ kind: 'session.activity', sessionId, activity: view.activity, processState: view.processState, worker });
    this.send({ kind: 'entity', entity: 'session', op: 'upsert', item: view });
  }

  private scheduleIdleClose(sessionId: string) {
    const r = this.runtime(sessionId);
    this.clearIdleTimer(r);
    const minutes = this.store.getSettings().idleCloseMinutes;
    if (!minutes || minutes <= 0) return;
    if (!this.procs.get(sessionId)) return; // conversa do Codex: não há processo da HQ a encerrar
    r.idleTimer = setTimeout(() => {
      const p = this.procs.get(sessionId);
      if (p?.alive && !p.turnActive && r.pending.size === 0) {
        log.info(`sessão ${sessionId} ociosa há ${minutes} min: encerrando processo (retomável)`);
        this.closeSession(sessionId).catch(() => { /* ignorar */ });
      }
    }, minutes * 60_000);
    r.idleTimer.unref?.();
  }
  private clearIdleTimer(r: Runtime) { if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; } }

  /** Até 10 anexos (o campo de pedido); fluxos da HQ pedem mais (máximo 30). Antes, o 11º em diante sumia sem aviso. */
  private storeAttachments(list: { name: string; mediaType: string; dataBase64: string }[], max = 10): { meta: Attachment }[] {
    const out: { meta: Attachment }[] = [];
    const cap = Math.min(30, Math.max(1, Math.floor(max)));
    if (list.length > cap) log.warn(`anexos: ${list.length} enviados, ${cap} guardados (limite)`);
    for (const a of list.slice(0, cap)) {
      const buf = Buffer.from(a.dataBase64, 'base64');
      if (buf.length > 10 * 1024 * 1024) throw new Error(`anexo ${a.name} maior que 10 MB`);
      const safe = a.name.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'anexo';
      const file = path.join(this.deps.attachmentsDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`);
      fs.writeFileSync(file, buf);
      out.push({ meta: { name: a.name, mediaType: a.mediaType, storedPath: file, sizeBytes: buf.length } });
    }
    return out;
  }
}

/** Como o funcionário age na conversa particular: responde ao Chefe e, quando ele pede trabalho, devolve o pedido para a gerente. */
const DM_RULES = [
  'Esta é a sua conversa particular com o Chefe (quem dirige a empresa), só entre vocês dois: nada daqui vai para o mural nem para a equipe. Responda como você, curto e direto, como numa conversa.',
  'Você pode ler os arquivos da pasta para responder (Glob, Grep, Read), mas não produza peça nem altere arquivo aqui.',
  'Se o Chefe pedir um trabalho (peça, vídeo, pesquisa, estudo, mudança), confirme em uma frase o que entendeu e termine a resposta com este bloco, que a HQ manda para a gerente da sala planejar e distribuir:',
  '```pedido-hq\n{"pedido": "o pedido do Chefe completo, com as palavras dele e o que você entendeu"}\n```',
  'Só use o bloco quando ele pedir trabalho de verdade. Não prometa prazo que você não controla.',
].join('\n');
