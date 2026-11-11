// Coordenador da sala de reunião. O servidor decide a ordem dos turnos (sempre um de cada vez), monta o contexto público
// de cada turno, chama o adaptador do provedor e registra a fala com a configuração realmente aplicada. Nada é simulado:
// quando um provedor falha, o turno fica 'failed' com o motivo e a reunião segue com quem respondeu.
import fs from 'node:fs';
import path from 'node:path';
import type {
  AiProviderId, AiProviderPrefs, DecisionKind, EffortLevel, Employee, Meeting, MeetingClientMessage, MeetingContextItem, MeetingDecision, MeetingHistory,
  MeetingMessage, MeetingParticipant, MeetingTaskItem, MeetingTurn, ParticipantState, Project, ServerMessage, Session, Task, TurnPhase,
} from '@milweb-hq/protocol';
import { isEffortLevel, MEETING_DEFAULT_ROUNDS, MEETING_MAX_AI_PARTICIPANTS, MEETING_MAX_ROUNDS } from '@milweb-hq/protocol';
import type { Store } from '../store.js';
import { recordAudit } from '../audit.js';
import type { MeetingStore } from './store.js';
import type { AiRegistry } from '../ai/registry.js';
import type { ProviderTurnStop, TurnHandle, TurnOutcome } from '../ai/types.js';
import { formatBrt } from '../time.js';
import { buildContextPackage, buildSystemPrompt, buildTurnText, parseMentions, parseSynthesis, PHASE_LABELS, renderMinutes, chefeDecisionText } from './prompts.js';
import { isDistributeCommand, parsePlan, planBrief, planTaskText, renderPlanSection } from './plan.js';
import { SOCIAL_SLOTS } from '@milweb-hq/protocol';
import type { MeetingPlan, PlanTaskRecord, TaskRunInput, TaskRunResult } from '@milweb-hq/protocol';

/** O que a reunião precisa do gerenciador de sessões (tipado pela forma para os testes usarem um falso). */
export interface MeetingManagerLike {
  activeTurns(): number;
  on(event: 'turn_finished', fn: () => void): unknown;
  /** Tarefa de funcionário terminou (libera as tarefas do plano que dependiam dela). Opcional nos testes antigos. */
  on(event: 'task_finished', fn: (taskId: string) => void): unknown;
  /** Fila real dos funcionários (mesma do compositor): skill, conta e configuração do próprio funcionário. */
  runTask?(input: TaskRunInput, extra?: { origin?: Task['origin']; held?: boolean; heldReason?: string | null; meetingId?: string | null }): Promise<TaskRunResult>;
  createSession(input: { roomId: string; projectId: string; employeeId?: string | null; name?: string }): Session;
  sendPrompt(input: { sessionId: string; clientId: string; text: string; mode: 'queue'; held?: boolean; meetingId?: string | null }): Promise<Task>;
  releaseTask(taskId: string): void;
}

export interface MeetingDeps {
  store: Store;
  meetings: MeetingStore;
  registry: AiRegistry;
  manager: MeetingManagerLike;
  dataDir: string;
  broadcast(m: ServerMessage): void;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  /** Limite de tempo por turno (padrão 10 min). */
  turnTimeoutMs?: number;
  /** Mesa do Chefe: bloqueios do plano (ninguém apto, tarefa que não entrou na fila). */
  needs?: { add(i: { meetingId: string; planTaskId: string | null; text: string }): void };
}

interface ActiveTurn { meetingId: string; turnId: string; participantId: string; handle: TurnHandle | null; text: string; timer: NodeJS.Timeout | null }

const PROVIDER_NAMES: Record<AiProviderId, string> = { claude: 'Claude', openai: 'ChatGPT' };
const SYSTEM_PARTICIPANT = 'system';
const MAX_FILE_BYTES = 60 * 1024;
/** Dias que uma reunião excluída fica na lixeira antes de ser apagada de vez. */
export const TRASH_DAYS = 30;
const BOARD_LINE = /^(?:[-*•]\s*)?(proposta|diverg[êe]ncia|pergunta|a[çc][ãa]o)\s*[:：]\s*(.+)$/i;

export class MeetingController {
  private active: ActiveTurn | null = null;
  private closing = false;
  private waitingNoted = new Set<string>();
  private retryTimer: NodeJS.Timeout | null = null;
  private returnTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MeetingDeps) {
    deps.manager.on('turn_finished', () => this.pump());
    deps.manager.on('task_finished', (taskId: string) => { try { this.onTaskFinished(taskId); } catch (err) { deps.log?.warn('liberação de dependências do plano falhou', err); } });
    // No início do serviço os provedores ainda estão sendo checados: o estado gravado ("indisponível") se corrige quando eles respondem.
    deps.registry.onStatus?.(() => {
      try {
        for (const m of deps.meetings.listMeetings()) if (!m.deletedAt) this.refreshStates(m.id, true);
        this.checkReturns();
      } catch (err) { deps.log?.warn('atualização do estado dos participantes falhou', err); }
    });
  }

  /** Confere a cada minuto se quem saiu por limite de uso já pode voltar (a HQ só pergunta; quem chama de volta é o Chefe). */
  startReturnWatch(intervalMs = 60_000): void {
    if (this.returnTimer) return;
    this.checkReturns();
    this.returnTimer = setInterval(() => { try { this.checkReturns(); } catch (err) { this.deps.log?.warn('checagem de volta dos participantes falhou', err); } }, intervalMs);
    this.returnTimer.unref?.();
  }

  list(): Meeting[] { return this.deps.meetings.listMeetings(); }
  /** 1 enquanto um turno de reunião roda (conta no limite global de execuções, como uma tarefa de funcionário). */
  activeCount(): number { return this.active ? 1 : 0; }

  /** Depois de um reinício nenhum turno sobrevive: fica 'lost' identificado, sem reenvio automático; a reunião pausa. */
  recoverOnStart(): void {
    const ms = this.deps.meetings;
    this.purgeTrash();
    for (const t of ms.listTurnsByStatus(['running'])) {
      ms.updateTurn(t.id, { status: 'lost', finishedAt: Date.now(), error: 'O serviço da MilWeb HQ reiniciou durante este turno. Nada foi reenviado: use "Tentar de novo" se quiser.' });
      const m = ms.getMeeting(t.meetingId);
      const p = m?.participants.find(x => x.id === t.participantId);
      if (m) this.notice(m.id, `O serviço reiniciou durante o turno de ${p?.name ?? 'um participante'} (${PHASE_LABELS[t.phase]}). O turno ficou marcado como perdido; nada foi reenviado.`);
    }
    for (const m of ms.listMeetings()) {
      if (m.status === 'active' && (m.activeTurnId || ms.countQueued(m.id) > 0)) {
        ms.updateMeeting(m.id, { status: 'paused', activeTurnId: null });
        this.notice(m.id, 'Reunião pausada porque o serviço reiniciou. Retome quando quiser: os turnos na fila continuam de onde pararam.');
      } else if (m.activeTurnId) ms.updateMeeting(m.id, { activeTurnId: null });
      this.refreshStates(m.id);
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.returnTimer) { clearInterval(this.returnTimer); this.returnTimer = null; }
    const a = this.active;
    if (a?.handle) { try { await a.handle.interrupt(); await Promise.race([a.handle.done, new Promise(r => setTimeout(r, 10_000))]); } catch { /* ignorar */ } }
  }

  // ---------------- mensagens do cliente ----------------
  async handle(msg: MeetingClientMessage): Promise<unknown> {
    const ms = this.deps.meetings;
    switch (msg.type) {
      case 'meeting.create': return { meeting: this.create(msg) };
      case 'meeting.update': { this.update(msg.id, msg.patch); return undefined; }
      case 'meeting.delete': { await this.remove(msg.id); return undefined; }
      case 'meeting.restore': return { meeting: this.restore(msg.id) };
      case 'meeting.trash': return { meetings: ms.listDeletedMeetings(), keepDays: TRASH_DAYS };
      case 'meeting.participant.add': { const m = this.meeting(msg.meetingId); const p = this.addParticipant(m, msg.participant); this.broadcastMeeting(m.id); return { participant: p }; }
      case 'meeting.participant.update': {
        const m = this.meeting(msg.meetingId);
        const p = m.participants.find(x => x.id === msg.participantId); if (!p) throw new Error('participante não encontrado');
        if (p.kind !== 'ai') throw new Error('o Chefe não tem configuração de modelo');
        if (msg.patch.effort !== undefined && msg.patch.effort !== null && !isEffortLevel(msg.patch.effort)) throw new Error('nível de esforço inválido');
        let name: string | undefined;
        if (msg.patch.employeeId !== undefined && msg.patch.employeeId !== p.employeeId) {
          // Trocar o funcionário troca quem está à mesa: o nome acompanha (o motor da conversa já aberta continua o mesmo).
          if (msg.patch.employeeId) {
            const e = this.deps.store.getEmployee(msg.patch.employeeId); if (!e || e.archivedAt) throw new Error('funcionário não encontrado');
            if (m.participants.some(x => x.id !== p.id && x.employeeId === e.id)) throw new Error(`${e.name} já participa desta reunião`);
            name = this.seatName(m, e.name, p.id);
          } else {
            if (m.participants.some(x => x.id !== p.id && x.kind === 'ai' && x.provider === p.provider && !x.employeeId)) throw new Error(`${PROVIDER_NAMES[p.provider!]} já participa desta reunião`);
            name = PROVIDER_NAMES[p.provider!];
          }
        }
        ms.updateParticipant(p.id, { ...(name ? { name } : {}), ...(msg.patch.model !== undefined ? { model: msg.patch.model } : {}), ...(msg.patch.effort !== undefined ? { effort: msg.patch.effort } : {}), ...(msg.patch.useGlobal !== undefined ? { useGlobal: msg.patch.useGlobal } : {}), ...(msg.patch.employeeId !== undefined ? { employeeId: msg.patch.employeeId } : {}) });
        this.broadcastMeeting(m.id); return undefined;
      }
      case 'meeting.participant.remove': {
        const m = this.meeting(msg.meetingId);
        const p = m.participants.find(x => x.id === msg.participantId); if (!p) throw new Error('participante não encontrado');
        if (p.kind === 'chefe') throw new Error('o Chefe não sai da própria reunião');
        if (this.active?.participantId === p.id) throw new Error('interrompa o turno antes de remover o participante');
        for (const t of ms.listTurnsByStatus(['queued'], m.id)) if (t.participantId === p.id) { ms.updateTurn(t.id, { status: 'skipped', finishedAt: Date.now(), error: 'participante removido' }); this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: ms.getTurn(t.id)! }); }
        ms.removeParticipant(p.id); this.broadcastMeeting(m.id); return undefined;
      }
      case 'meeting.participant.rejoin': { this.rejoin(msg.meetingId, msg.participantId); return undefined; }
      case 'meeting.context.set': return this.setContext(msg.meetingId, msg.items);
      case 'meeting.history': return this.history(msg.meetingId);
      case 'meeting.say': return this.say(msg);
      case 'meeting.discuss': return this.discuss(msg);
      case 'meeting.pause': {
        const m = this.meeting(msg.meetingId);
        if (m.status !== 'active') throw new Error('a reunião não está em andamento');
        ms.updateMeeting(m.id, { status: 'paused' });
        this.notice(m.id, this.active?.meetingId === m.id ? 'Reunião pausada: o turno atual termina e nenhum outro começa até retomar.' : 'Reunião pausada.');
        this.refreshStates(m.id); return undefined;
      }
      case 'meeting.resume': {
        const m = this.meeting(msg.meetingId);
        if (m.status === 'ended') throw new Error('reunião encerrada: use "Reabrir"');
        ms.updateMeeting(m.id, { status: 'active', startedAt: m.startedAt ?? Date.now() });
        this.refreshStates(m.id); this.pump(); return undefined;
      }
      case 'meeting.interrupt': { await this.interrupt(msg.meetingId); return undefined; }
      case 'meeting.anotherRound': { this.anotherRound(msg.meetingId); return undefined; }
      case 'meeting.retryTurn': {
        const m = this.meeting(msg.meetingId);
        const t = ms.getTurn(msg.turnId); if (!t || t.meetingId !== m.id) throw new Error('turno não encontrado');
        if (!['failed', 'lost', 'interrupted', 'skipped'].includes(t.status)) throw new Error('só turnos que falharam, foram perdidos ou interrompidos podem ser tentados de novo');
        if (m.status === 'ended') throw new Error('reunião encerrada: reabra para continuar');
        const re = ms.requeueTurn(t.id)!;
        this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: re });
        if (t.phase === 'plan' && m.distribution && m.distribution.state !== 'distributed') ms.updateMeeting(m.id, { distribution: { ...m.distribution, state: 'planning', error: null } });
        if (m.status !== 'active') ms.updateMeeting(m.id, { status: 'active' });
        this.refreshStates(m.id); this.pump(); return undefined;
      }
      case 'meeting.end': return { meeting: await this.end(msg.meetingId) };
      case 'meeting.endAndDistribute': return this.endAndDistribute(msg.meetingId);
      case 'meeting.reopen': {
        const m = this.meeting(msg.meetingId);
        if (m.status !== 'ended') throw new Error('a reunião não está encerrada');
        ms.updateMeeting(m.id, { status: 'paused', endedAt: null });
        this.notice(m.id, 'Reunião reaberta (pausada). A ata anterior foi mantida.');
        this.refreshStates(m.id); return undefined;
      }
      case 'meeting.minutes.save': {
        const m = this.meeting(msg.meetingId);
        const minutes = { text: msg.text, generatedAt: m.minutes?.generatedAt ?? Date.now(), editedAt: Date.now() };
        ms.updateMeeting(m.id, { minutes });
        this.broadcastMeeting(m.id); return { minutes };
      }
      case 'meeting.decision.add': {
        const m = this.meeting(msg.meetingId);
        const text = msg.text.trim(); if (!text) throw new Error('texto vazio');
        if (msg.assigneeEmployeeId && !this.deps.store.getEmployee(msg.assigneeEmployeeId)) throw new Error('funcionário não encontrado');
        // Item adicionado pelo próprio Chefe: uma decisão dele já nasce confirmada; os demais tipos ficam no quadro para ele confirmar depois.
        const d = ms.addDecision({ meetingId: m.id, kind: msg.kind, text, participantId: null, confirmed: msg.kind === 'decision', assigneeEmployeeId: msg.assigneeEmployeeId ?? null });
        this.deps.broadcast({ kind: 'meeting.decision', meetingId: m.id, op: 'upsert', decision: d }); return { decision: d };
      }
      case 'meeting.decision.update': {
        const m = this.meeting(msg.meetingId);
        const cur = ms.getDecision(msg.id); if (!cur || cur.meetingId !== m.id) throw new Error('item do quadro não encontrado');
        if (msg.patch.assigneeEmployeeId && !this.deps.store.getEmployee(msg.patch.assigneeEmployeeId)) throw new Error('funcionário não encontrado');
        const d = ms.updateDecision(msg.id, msg.patch)!;
        this.deps.broadcast({ kind: 'meeting.decision', meetingId: m.id, op: 'upsert', decision: d }); return undefined;
      }
      case 'meeting.decision.delete': {
        const m = this.meeting(msg.meetingId);
        const cur = ms.getDecision(msg.id); if (!cur || cur.meetingId !== m.id) return undefined;
        ms.deleteDecision(msg.id); this.deps.broadcast({ kind: 'meeting.decision', meetingId: m.id, op: 'delete', decision: { id: msg.id } }); return undefined;
      }
      case 'meeting.taskItem.upsert': {
        const m = this.meeting(msg.meetingId);
        const title = msg.item.title.trim(); if (!title) throw new Error('título vazio');
        const decisionId = msg.item.decisionId ?? null;
        if (decisionId) { const d = ms.getDecision(decisionId); if (!d || d.meetingId !== m.id) throw new Error('a decisão não pertence a esta reunião'); }
        // Um item por decisão: pedido sem id para uma decisão que já tem item atualiza esse item (reenvio ou diálogo reaberto nunca duplicam a tarefa).
        const cur = msg.item.id ? ms.getTaskItem(msg.item.id) : decisionId ? ms.listTaskItems(m.id).find(it => it.decisionId === decisionId && it.status !== 'dismissed') ?? null : null;
        if (cur && cur.meetingId !== m.id) throw new Error('item não pertence a esta reunião');
        if (cur?.status === 'created') throw new Error('esta tarefa já foi criada na fila');
        const item = ms.upsertTaskItem({ id: cur?.id ?? msg.item.id, meetingId: m.id, title, instructions: msg.item.instructions ?? cur?.instructions ?? '', employeeId: msg.item.employeeId ?? cur?.employeeId ?? null, roomId: msg.item.roomId ?? cur?.roomId ?? null, projectId: msg.item.projectId ?? cur?.projectId ?? m.projectId, decisionId: decisionId ?? cur?.decisionId ?? null });
        this.deps.broadcast({ kind: 'meeting.taskItem', meetingId: m.id, op: 'upsert', item }); return { item };
      }
      case 'meeting.taskItem.delete': {
        const m = this.meeting(msg.meetingId);
        const cur = ms.getTaskItem(msg.id); if (!cur || cur.meetingId !== m.id) return undefined;
        if (cur.status === 'created') throw new Error('a tarefa já existe na fila; cancele-a lá se quiser');
        ms.deleteTaskItem(msg.id); this.deps.broadcast({ kind: 'meeting.taskItem', meetingId: m.id, op: 'delete', item: { id: msg.id } }); return undefined;
      }
      case 'meeting.tasks.create': return { items: await this.createTasks(msg.meetingId, msg.items) };
      case 'task.release': { this.deps.manager.releaseTask(msg.taskId); return undefined; }
      default: throw new Error(`operação desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  // ---------------- criação e cadastro ----------------
  private create(msg: Extract<MeetingClientMessage, { type: 'meeting.create' }>): Meeting {
    const title = msg.title.trim(); if (!title) throw new Error('dê um título à reunião');
    if (msg.projectId && !this.deps.store.getProject(msg.projectId)) throw new Error('projeto não encontrado');
    if (msg.mode !== 'guided' && msg.mode !== 'debate') throw new Error('modo inválido');
    const roundLimit = Math.min(MEETING_MAX_ROUNDS, Math.max(1, Math.round(msg.roundLimit ?? MEETING_DEFAULT_ROUNDS)));
    const m = this.deps.meetings.createMeeting({ title, agenda: msg.agenda ?? '', projectId: msg.projectId ?? null, mode: msg.mode, roundLimit });
    this.deps.meetings.addParticipant({ meetingId: m.id, kind: 'chefe', provider: null, name: 'Chefe', seat: 0, order: 0 });
    for (const p of msg.participants) this.addParticipant(this.deps.meetings.getMeeting(m.id)!, p);
    const full = this.refreshStates(m.id);
    this.deps.log?.info(`reunião criada: ${full.title} (${full.id.slice(0, 8)}) · ${full.participants.map(p => p.name).join(', ')}`);
    return full;
  }

  /**
   * Gerente (Claude ou ChatGPT, um de cada) ou funcionário escolhido (cada um uma vez, com o próprio nome e o próprio motor:
   * Claude Code ou Codex, conforme o cadastro). No máximo MEETING_MAX_AI_PARTICIPANTS à mesa além do Chefe.
   */
  private addParticipant(m: Meeting, input: { provider: AiProviderId; employeeId?: string | null; model?: string | null; effort?: EffortLevel | null }): MeetingParticipant {
    const employee = input.employeeId ? this.deps.store.getEmployee(input.employeeId) : null;
    if (input.employeeId && (!employee || employee.archivedAt)) throw new Error('funcionário não encontrado');
    const provider: AiProviderId = employee?.provider ?? input.provider;
    if (!this.deps.registry.has(provider)) throw new Error(`provedor desconhecido: ${provider}`);
    if (employee) { if (m.participants.some(p => p.employeeId === employee.id)) throw new Error(`${employee.name} já participa desta reunião`); }
    else if (m.participants.some(p => p.kind === 'ai' && p.provider === provider && !p.employeeId)) throw new Error(`${PROVIDER_NAMES[provider]} já participa desta reunião`);
    if (m.participants.filter(p => p.kind === 'ai').length >= MEETING_MAX_AI_PARTICIPANTS) throw new Error(`a mesa comporta no máximo ${MEETING_MAX_AI_PARTICIPANTS} participantes além de você`);
    if (input.effort != null && !isEffortLevel(input.effort)) throw new Error('nível de esforço inválido');
    const personalized = input.model != null || input.effort != null;
    const name = employee ? this.seatName(m, employee.name, null) : PROVIDER_NAMES[provider];
    return this.deps.meetings.addParticipant({ meetingId: m.id, kind: 'ai', provider, name, employeeId: employee?.id ?? null, model: input.model ?? null, effort: input.effort ?? null, useGlobal: !personalized });
  }

  /** Nome à mesa sem repetir outro participante (menções @Nome precisam apontar para uma pessoa só). */
  private seatName(m: Meeting, base: string, selfId: string | null): string {
    const taken = new Set(m.participants.filter(p => p.id !== selfId).map(p => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let k = 2; ; k++) if (!taken.has(`${base} ${k}`.toLowerCase())) return `${base} ${k}`;
  }

  private update(id: string, patch: Extract<MeetingClientMessage, { type: 'meeting.update' }>['patch']): void {
    const m = this.meeting(id);
    const next: Parameters<MeetingStore['updateMeeting']>[1] = {};
    if (patch.title !== undefined) { const t = patch.title.trim(); if (!t) throw new Error('o título não pode ficar vazio'); next.title = t; }
    if (patch.projectId !== undefined) { if (patch.projectId && !this.deps.store.getProject(patch.projectId)) throw new Error('projeto não encontrado'); next.projectId = patch.projectId; }
    if (patch.mode !== undefined) { if (patch.mode !== 'guided' && patch.mode !== 'debate') throw new Error('modo inválido'); if (patch.mode !== m.mode && (this.deps.meetings.countQueued(m.id) > 0 || this.active?.meetingId === m.id)) throw new Error('termine ou interrompa os turnos antes de trocar o modo'); next.mode = patch.mode; }
    if (patch.roundLimit !== undefined) next.roundLimit = Math.min(MEETING_MAX_ROUNDS, Math.max(1, Math.round(patch.roundLimit)));
    if (patch.synthesisParticipantId !== undefined) { if (patch.synthesisParticipantId && !m.participants.some(p => p.id === patch.synthesisParticipantId && p.kind === 'ai')) throw new Error('participante de síntese inválido'); next.synthesisParticipantId = patch.synthesisParticipantId; }
    if (patch.companyContext !== undefined) next.companyContext = Boolean(patch.companyContext);
    let contextChanged = false;
    if (patch.agenda !== undefined && patch.agenda !== m.agenda) { next.agenda = patch.agenda; contextChanged = true; }
    if (patch.companyContext !== undefined && Boolean(patch.companyContext) !== m.companyContext) contextChanged = true;
    if (patch.projectId !== undefined && patch.projectId !== m.projectId) contextChanged = true;
    if (contextChanged) next.contextVersion = m.contextVersion + 1;
    this.deps.meetings.updateMeeting(m.id, next);
    if (contextChanged) this.deps.broadcast({ kind: 'meeting.context', meetingId: m.id, items: this.deps.meetings.listContext(m.id), contextVersion: m.contextVersion + 1 });
    this.broadcastMeeting(m.id);
  }

  /** "Excluir" = lixeira de reuniões por 30 dias (TRASH_DAYS), com registro. Turno em andamento é interrompido; a reunião ativa pausa. */
  private async remove(id: string): Promise<void> {
    const m = this.meeting(id);
    if (this.active?.meetingId === m.id) await this.interrupt(m.id);
    if (m.status === 'active') this.deps.meetings.updateMeeting(m.id, { status: 'paused' });
    this.deps.meetings.softDeleteMeeting(m.id);
    recordAudit(this.deps.store, { action: 'excluir (lixeira de reuniões)', entity: 'reunião', entityId: m.id, title: m.title, origin: 'interface', detail: `${m.participants.length} participantes; restaurável por ${TRASH_DAYS} dias` });
    this.deps.broadcast({ kind: 'entity', entity: 'meeting', op: 'delete', item: { id: m.id } });
  }

  private restore(id: string): Meeting {
    const m = this.deps.meetings.getMeeting(id);
    if (!m) throw new Error('reunião não encontrada (pode ter passado do prazo da lixeira)');
    if (!m.deletedAt) return m;
    this.deps.meetings.restoreMeeting(m.id);
    recordAudit(this.deps.store, { action: 'restaurar', entity: 'reunião', entityId: m.id, title: m.title, origin: 'interface', detail: null });
    this.broadcastMeeting(m.id);
    return this.deps.meetings.getMeeting(m.id)!;
  }

  /** Reuniões há mais de 30 dias (TRASH_DAYS) na lixeira são apagadas de vez (registrado). Roda ao iniciar o serviço. */
  purgeTrash(now = Date.now()): number {
    const ms = this.deps.meetings; let n = 0;
    for (const m of ms.listDeletedMeetings()) {
      if (!m.deletedAt || now - m.deletedAt < TRASH_DAYS * 86_400_000) continue;
      ms.deleteMeeting(m.id); n++;
      recordAudit(this.deps.store, { action: 'apagar de vez', entity: 'reunião', entityId: m.id, title: m.title, origin: 'sistema', detail: `${TRASH_DAYS} dias na lixeira de reuniões` });
    }
    return n;
  }

  private setContext(meetingId: string, items: MeetingContextItem[]): { items: MeetingContextItem[]; contextVersion: number } {
    const m = this.meeting(meetingId);
    // Caminho que já estava salvo nesta reunião passa sem nova checagem: a leitura de cada turno confere tudo de novo (raiz, dados da HQ,
    // links) e informa se o arquivo sumiu. Assim um arquivo apagado ou um projeto descadastrado não trava edições sem relação com ele.
    const savedPaths = new Set(this.deps.meetings.listContext(m.id).filter(i => i.kind === 'file' && i.path).map(i => path.resolve(i.path!).toLowerCase()));
    const clean: MeetingContextItem[] = [];
    for (const it of items.slice(0, 50)) {
      if (it.kind !== 'file' && it.kind !== 'note') throw new Error('item de contexto inválido');
      const label = String(it.label ?? '').trim().slice(0, 200) || (it.kind === 'file' ? path.basename(String(it.path ?? '')) : 'Nota');
      if (it.kind === 'file') {
        const raw = String(it.path ?? '').trim();
        if (!raw) throw new Error('arquivo sem caminho');
        const p = path.resolve(raw);
        const problem = savedPaths.has(p.toLowerCase()) ? null : this.contextPathProblem(p);
        if (problem) throw new Error(`${problem}: ${p}`);
        clean.push({ id: String(it.id || ''), kind: 'file', label, path: p, text: null, enabled: it.enabled !== false });
      } else clean.push({ id: String(it.id || ''), kind: 'note', label, path: null, text: String(it.text ?? '').slice(0, 20_000), enabled: it.enabled !== false });
    }
    const saved = this.deps.meetings.setContext(m.id, clean);
    const version = m.contextVersion + 1;
    this.deps.meetings.updateMeeting(m.id, { contextVersion: version });
    this.deps.broadcast({ kind: 'meeting.context', meetingId: m.id, items: saved, contextVersion: version });
    this.broadcastMeeting(m.id);
    return { items: saved, contextVersion: version };
  }

  history(meetingId: string): MeetingHistory {
    const m = this.meeting(meetingId);
    const ms = this.deps.meetings;
    return { messages: ms.listMessages(m.id), turns: ms.listTurns(m.id), decisions: ms.listDecisions(m.id), context: ms.listContext(m.id), taskItems: ms.listTaskItems(m.id), plans: ms.listPlans(m.id), planTasks: ms.listPlanTasks(m.id) };
  }

  // ---------------- falas e turnos ----------------
  private say(msg: Extract<MeetingClientMessage, { type: 'meeting.say' }>): { turns: MeetingTurn[] } {
    const ms = this.deps.meetings;
    const m = this.meeting(msg.meetingId);
    if (m.status === 'ended') throw new Error('reunião encerrada: reabra para continuar');
    const text = msg.text.trim(); if (!text) throw new Error('mensagem vazia');
    if (ms.findMessageByClientId(msg.clientId)) return { turns: [] }; // reenvio (reconexão/recarga): nada novo é criado
    const chefe = m.participants.find(p => p.kind === 'chefe');
    const allAis = m.participants.filter(p => p.kind === 'ai');
    const ais = allAis.filter(p => !p.away);
    const mentioned = parseMentions(text, m.participants);
    const explicit = (msg.targets ?? []).filter(id => allAis.some(p => p.id === id));
    const wanted = [...new Set([...explicit, ...mentioned])];
    const awayWanted = allAis.filter(p => p.away && wanted.includes(p.id));
    const targetIds = wanted.filter(id => ais.some(p => p.id === id));
    const message = ms.addMessage({ meetingId: m.id, turnId: null, participantId: chefe?.id ?? 'chefe', authorName: 'Chefe', provider: null, kind: 'chefe', text, round: m.currentRound || null, phase: null, targets: targetIds, config: null, contextVersion: m.contextVersion, partial: false, clientId: msg.clientId });
    this.deps.broadcast({ kind: 'meeting.message', meetingId: m.id, message });
    const decision = chefeDecisionText(text);
    if (decision) {
      const d = ms.addDecision({ meetingId: m.id, kind: 'decision', text: decision, participantId: null, confirmed: true, messageId: message.id });
      this.deps.broadcast({ kind: 'meeting.decision', meetingId: m.id, op: 'upsert', decision: d });
    }
    if (m.status === 'draft') ms.updateMeeting(m.id, { status: 'active', startedAt: Date.now() });
    // "Pode encerrar e distribuir as tarefas": mesmo efeito do botão (o gerente consolida, a HQ distribui), sem turnos de resposta.
    if (isDistributeCommand(text)) {
      const r = this.endAndDistribute(m.id);
      return { turns: r.turn ? [r.turn] : [] };
    }
    // Uma decisão registrada sem destinatário explícito não pede resposta: entra no contexto dos próximos turnos.
    // Chamou só quem está fora: ninguém responde no lugar dele (a HQ avisa e a fala fica registrada).
    const targets = decision && !targetIds.length ? [] : (targetIds.length ? ais.filter(p => targetIds.includes(p.id)) : awayWanted.length ? [] : ais);
    for (const p of awayWanted) this.notice(m.id, `${p.name} está fora da reunião (${this.awayText(p.away!)}) e não recebeu esta fala. ${p.away!.asking ? 'Ele já pode voltar: use "Chamar de volta".' : 'Quando liberar, eu pergunto se ele volta.'}`);
    const turns = targets.map(p => ms.createTurn({ meetingId: m.id, participantId: p.id, round: m.currentRound, phase: 'reply', requested: this.requestedFor(p), contextVersion: m.contextVersion }));
    for (const t of turns) this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: t });
    this.refreshStates(m.id);
    this.pump();
    return { turns };
  }

  private discuss(msg: Extract<MeetingClientMessage, { type: 'meeting.discuss' }>): { turns: MeetingTurn[] } {
    const ms = this.deps.meetings;
    const m = this.meeting(msg.meetingId);
    if (m.mode !== 'debate') throw new Error('"Discutir a pauta" só existe no modo Discutir a pauta; troque o modo da reunião');
    if (m.status === 'ended') throw new Error('reunião encerrada: reabra para continuar');
    if (ms.findMessageByClientId(msg.clientId)) return { turns: [] }; // reenvio: nada novo
    if (this.active?.meetingId === m.id || ms.countQueued(m.id) > 0) throw new Error('já existe turno em andamento ou na fila');
    if (!m.agenda.trim()) throw new Error('escreva a pauta antes de discutir');
    const ais = m.participants.filter(p => p.kind === 'ai' && !p.away);
    if (!ais.length) throw new Error(m.participants.some(p => p.kind === 'ai') ? 'todos os participantes de IA estão fora da reunião (limite de uso ou provedor parado); chame alguém de volta quando liberar' : 'adicione pelo menos um participante de IA');
    ms.updateMeeting(m.id, { status: 'active', startedAt: m.startedAt ?? Date.now(), currentRound: 0 });
    this.notice(m.id, `Discussão da pauta iniciada: opinião inicial de cada participante, ${m.roundLimit - 1} rodada${m.roundLimit - 1 === 1 ? '' : 's'} de revisão e síntese (limite de ${m.roundLimit} rodada${m.roundLimit === 1 ? '' : 's'}).`, msg.clientId);
    const turns = this.enqueueDebate(this.meeting(m.id), 1);
    this.refreshStates(m.id);
    this.pump();
    return { turns };
  }

  private enqueueDebate(m: Meeting, startRound: number): MeetingTurn[] {
    const ms = this.deps.meetings;
    const ais = m.participants.filter(p => p.kind === 'ai' && !p.away);
    const turns: MeetingTurn[] = [];
    if (startRound <= 1) for (const p of ais) turns.push(ms.createTurn({ meetingId: m.id, participantId: p.id, round: 1, phase: 'opinion', requested: this.requestedFor(p), contextVersion: m.contextVersion }));
    for (let r = Math.max(2, startRound); r <= m.roundLimit; r++) for (const p of ais) turns.push(ms.createTurn({ meetingId: m.id, participantId: p.id, round: r, phase: 'revision', requested: this.requestedFor(p), contextVersion: m.contextVersion }));
    const synth = ais.find(p => p.id === m.synthesisParticipantId) ?? ais[0];
    turns.push(ms.createTurn({ meetingId: m.id, participantId: synth.id, round: m.roundLimit, phase: 'synthesis', requested: this.requestedFor(synth), contextVersion: m.contextVersion }));
    for (const t of turns) this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: t });
    return turns;
  }

  private anotherRound(meetingId: string): void {
    const ms = this.deps.meetings;
    const m = this.meeting(meetingId);
    if (m.mode !== 'debate') throw new Error('"Mais uma rodada" só existe no modo Discutir a pauta');
    if (m.status === 'ended') throw new Error('reunião encerrada: reabra para continuar');
    if (this.active?.meetingId === m.id || ms.countQueued(m.id) > 0) throw new Error('espere os turnos atuais terminarem');
    if (m.roundLimit >= MEETING_MAX_ROUNDS) throw new Error(`limite absoluto de ${MEETING_MAX_ROUNDS} rodadas atingido`);
    if (!m.participants.some(p => p.kind === 'ai' && !p.away)) throw new Error(m.participants.some(p => p.kind === 'ai') ? 'todos os participantes de IA estão fora da reunião; chame alguém de volta antes de pedir outra rodada' : 'adicione pelo menos um participante de IA (Claude ou ChatGPT) antes de pedir outra rodada');
    const next = m.roundLimit + 1;
    ms.updateMeeting(m.id, { roundLimit: next, status: 'active' });
    this.notice(m.id, `Mais uma rodada de revisão (${next} de no máximo ${MEETING_MAX_ROUNDS}) e nova síntese.`);
    this.enqueueDebate(this.meeting(m.id), next);
    this.refreshStates(m.id);
    this.pump();
  }

  private requestedFor(p: MeetingParticipant): AiProviderPrefs {
    if (p.kind !== 'ai' || !p.provider) return { model: null, effort: null };
    const employee = p.employeeId ? this.deps.store.getEmployee(p.employeeId) : null;
    const cfg = this.deps.registry.resolve(p.provider, p, employee);
    return { model: cfg.model, effort: cfg.effort };
  }

  private noteWaiting(m: Meeting): void {
    if (!this.waitingNoted.has(m.id)) {
      this.waitingNoted.add(m.id);
      const limit = Math.max(1, this.deps.store.getSettings().maxParallel);
      this.notice(m.id, `Aguardando capacidade: já existe ${this.deps.manager.activeTurns()} execução ativa de funcionário e o limite de execuções simultâneas é ${limit} (Configurações → Geral). O próximo turno começa quando liberar.`);
    }
    if (!this.retryTimer) { this.retryTimer = setTimeout(() => { this.retryTimer = null; this.pump(); }, 5000); this.retryTimer.unref?.(); }
  }

  /** Um turno de cada vez, respeitando o limite global de execuções simultâneas. */
  pump(): void {
    if (this.closing || this.active) return;
    const ms = this.deps.meetings;
    for (const m of ms.listMeetings()) {
      if (m.status !== 'active') continue;
      const next = ms.listTurnsByStatus(['queued'], m.id)[0];
      if (!next) continue;
      const owner = m.participants.find(x => x.id === next.participantId);
      if (owner?.away) {
        if (this.skipAwayTurn(m, next, owner) === 'paused') continue;
        return this.pump();
      }
      if (this.deps.manager.activeTurns() >= Math.max(1, this.deps.store.getSettings().maxParallel)) { this.noteWaiting(m); return; }
      this.waitingNoted.delete(m.id);
      this.active = { meetingId: m.id, turnId: next.id, participantId: next.participantId, handle: null, text: '', timer: null };
      this.runTurn(m.id, next.id).catch(err => {
        this.deps.log?.error('turno de reunião falhou de forma inesperada', err);
        const t = ms.getTurn(next.id);
        if (t && (t.status === 'running' || t.status === 'queued')) { ms.updateTurn(t.id, { status: 'failed', finishedAt: Date.now(), error: String((err as Error).message ?? err) }); this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: ms.getTurn(t.id)! }); }
        ms.updateMeeting(m.id, { activeTurnId: null });
        this.active = null; this.refreshStates(m.id); this.pump();
      });
      return;
    }
  }

  private async runTurn(meetingId: string, turnId: string): Promise<void> {
    const ms = this.deps.meetings;
    const m = ms.getMeeting(meetingId); const turn = ms.getTurn(turnId);
    if (!m || !turn || turn.status !== 'queued' || m.status !== 'active') { this.active = null; this.pump(); return; }
    const p = m.participants.find(x => x.id === turn.participantId);
    if (!p || p.kind !== 'ai' || !p.provider) { this.failTurn(m, turn, p ?? null, 'participante não existe mais', true); return; }
    if (p.away) { this.skipAwayTurn(m, turn, p); this.active = null; this.pump(); return; }
    const st = this.deps.registry.statusOf(p.provider);
    if (!st.installed || st.authState === 'missing') { this.failTurn(m, turn, p, st.authDetail ?? `${p.name} indisponível`, true); return; }
    const employee = p.employeeId ? this.deps.store.getEmployee(p.employeeId) : null;
    const cfg = this.deps.registry.resolve(p.provider, p, employee);
    const v = this.deps.registry.validate(p.provider, cfg.model, cfg.effort);
    if (!v.ok) { this.failTurn(m, turn, p, `configuração de ${p.name} inválida (modelo definido por: ${cfg.modelSource}; esforço: ${cfg.effortSource}): ${v.reason}. Escolha outro modelo ou nível e tente de novo.`, false); return; }

    const project = m.projectId ? this.deps.store.getProject(m.projectId) : null;
    const room = this.deps.store.listRooms().find(r => r.kind === 'meeting') ?? null;
    const messages = ms.listMessages(m.id); const decisions = ms.listDecisions(m.id); const context = ms.listContext(m.id);
    const fileContents = this.readContextFiles(context);
    const company = m.companyContext ? { rooms: this.deps.store.listRooms(), projects: this.deps.store.listProjects(), employees: this.deps.store.listEmployees() } : null;
    const contextPackage = buildContextPackage({ meeting: m, project, messages, decisions, context, fileContents, company, employees: this.deps.store.listEmployees() });
    const chefeMessage = [...messages].reverse().find(x => x.kind === 'chefe') ?? null;
    const brief = turn.phase === 'plan' ? planBrief({
      me: p, employees: this.deps.store.listEmployees(), rooms: this.deps.store.listRooms(), projects: this.deps.store.listProjects(), decisions,
      handoffFrom: (() => { const gone = m.participants.find(x => x.kind === 'ai' && !x.employeeId && x.away && x.id !== p.id); return gone ? { name: gone.name, reason: gone.away!.reason } : null; })(),
      partialFrom: [...new Set(messages.filter(x => x.kind === 'speech' && x.partial).map(x => x.authorName))], defaultProjectId: m.projectId,
    }) : undefined;
    const text = buildTurnText({ phase: turn.phase, round: turn.round, roundLimit: m.roundLimit, me: p, chefeMessage, contextPackage, others: m.participants.filter(x => x.kind === 'ai' && x.id !== p.id), planBrief: brief });
    const systemPrompt = buildSystemPrompt(m, p, employee, room);
    const cwd = this.cwdFor(m, project);

    const requested: AiProviderPrefs = { model: cfg.model, effort: cfg.effort };
    ms.updateTurn(turn.id, { status: 'running', startedAt: Date.now(), requested, contextVersion: m.contextVersion, promptChars: text.length });
    ms.updateMeeting(m.id, { activeTurnId: turn.id, currentRound: Math.max(m.currentRound, turn.round) });
    ms.updateParticipant(p.id, { state: 'responding', stateDetail: `${PHASE_LABELS[turn.phase]} · ${cfg.model ?? 'modelo padrão'}${cfg.effort ? ' · ' + cfg.effort : ''}` });
    this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: ms.getTurn(turn.id)! });
    this.refreshStates(m.id);

    const adapter = this.deps.registry.get(p.provider);
    let outcome: TurnOutcome;
    try {
      const handle = adapter.startTurn({
        meetingId: m.id, turnId: turn.id, participantId: p.id, threadId: p.threadId, cwd, systemPrompt, text, title: `Reunião: ${m.title}`,
        model: cfg.model, effort: cfg.effort, timeoutMs: this.deps.turnTimeoutMs,
        onDelta: t => this.onDelta(m.id, turn.id, p.id, t),
      });
      if (this.active && this.active.turnId === turn.id) this.active.handle = handle;
      outcome = await handle.done;
    } catch (err) {
      outcome = { status: 'failed', text: '', threadId: p.threadId, applied: { model: cfg.model, effort: cfg.effort, resolvedModel: null }, error: String((err as Error).message ?? err), durationMs: 0, usage: null };
    }
    this.finishTurn(m.id, turn.id, p, outcome);
  }

  private onDelta(meetingId: string, turnId: string, participantId: string, text: string): void {
    const a = this.active; if (!a || a.turnId !== turnId) return;
    a.text = text;
    if (!a.timer) a.timer = setTimeout(() => { a.timer = null; this.deps.broadcast({ kind: 'meeting.delta', meetingId, turnId, participantId, text: a.text }); }, 60);
  }

  private finishTurn(meetingId: string, turnId: string, p: MeetingParticipant, outcome: TurnOutcome): void {
    const ms = this.deps.meetings;
    const phase = ms.getTurn(turnId)?.phase;
    // Plano consolidado: lido e validado antes de o turno contar como concluído (plano ilegível = turno com falha e "Tentar de novo").
    let parsedPlan: ReturnType<typeof parsePlan> | null = null;
    if (phase === 'plan' && outcome.status === 'done') {
      parsedPlan = parsePlan(outcome.text, { employees: this.deps.store.listEmployees(), projects: this.deps.store.listProjects(), defaultProjectId: ms.getMeeting(meetingId)?.projectId ?? null });
      if (!parsedPlan.ok) outcome = { ...outcome, status: 'failed', error: `plano não pôde ser lido: ${parsedPlan.error}` };
    }
    const a = this.active;
    if (a?.timer) { clearTimeout(a.timer); a.timer = null; }
    this.deps.broadcast({ kind: 'meeting.delta', meetingId, turnId, participantId: p.id, text: '' });
    const turn = ms.getTurn(turnId)!;
    const m = ms.getMeeting(meetingId);
    const partial = outcome.status !== 'done';
    let messageId: string | null = null;
    const speech = outcome.text.trim();
    if (speech) {
      const message = ms.addMessage({ meetingId, turnId, participantId: p.id, authorName: p.name, provider: p.provider, kind: 'speech', text: speech, round: turn.round || null, phase: turn.phase, targets: [], config: { model: outcome.applied.model, effort: outcome.applied.effort, resolvedModel: outcome.applied.resolvedModel }, contextVersion: turn.contextVersion, partial });
      this.deps.broadcast({ kind: 'meeting.message', meetingId, message });
      messageId = message.id;
    }
    ms.updateTurn(turnId, { status: outcome.status, applied: { model: outcome.applied.model, effort: outcome.applied.effort, resolvedModel: outcome.applied.resolvedModel }, finishedAt: Date.now(), error: outcome.error, messageId, usage: outcome.usage, durationMs: outcome.durationMs });
    if (outcome.threadId && outcome.threadId !== p.threadId) ms.updateParticipant(p.id, { threadId: outcome.threadId });
    else if (outcome.threadId === null && p.threadId) {
      // O adaptador avisou que a sessão retomada não existe mais: zera para o próximo turno (ou "Tentar de novo") começar uma nova.
      ms.updateParticipant(p.id, { threadId: null });
      this.notice(meetingId, `${p.name}: a sessão anterior não existe mais; o próximo turno começa uma sessão nova, sem a memória das falas anteriores desta reunião.`);
    }
    if (outcome.status === 'failed' && !outcome.stop) this.notice(meetingId, turn.phase === 'plan' && outcome.error?.startsWith('plano não pôde')
      ? `O plano de ${p.name} não pôde ser lido (${outcome.error.replace(/^plano não pôde ser lido: /, '')}). Nada foi distribuído: use "Tentar de novo" neste turno.`
      : `${p.name} não respondeu (${PHASE_LABELS[turn.phase]}): ${outcome.error ?? 'falha sem detalhe'}. A reunião continua com quem responder; use "Tentar de novo" neste turno se quiser.`);
    if (outcome.status === 'interrupted') this.notice(meetingId, `Turno de ${p.name} interrompido${speech ? '; a fala parcial ficou registrada como parcial' : ''}.`);
    if (outcome.status === 'done' && speech && turn.phase !== 'plan') {
      if (turn.phase === 'synthesis') this.boardFromSynthesis(meetingId, p.id, messageId, speech);
      else this.boardFromSpeech(meetingId, p.id, messageId, speech);
    }
    ms.updateMeeting(meetingId, { activeTurnId: null });
    if (outcome.status === 'interrupted' && m && m.status === 'active') ms.updateMeeting(meetingId, { status: 'paused' });
    this.active = null;
    if (outcome.stop && p.provider) {
      this.sendAway(p.provider, outcome.stop);
      // Consolidação cortada pelo limite: o outro gerente continua (o turno novo passa para quem ficou ou espera alguém voltar).
      if (turn.phase === 'synthesis' || turn.phase === 'plan') {
        const fresh = ms.getMeeting(meetingId)!;
        const re = ms.createTurn({ meetingId, participantId: p.id, round: turn.round, phase: turn.phase, requested: this.requestedFor(p), contextVersion: fresh.contextVersion });
        this.deps.broadcast({ kind: 'meeting.turn', meetingId, turn: re });
      }
    }
    if (phase === 'plan') {
      if (parsedPlan?.ok) void this.applyPlan(meetingId, p, parsedPlan.plan, parsedPlan.warnings).catch(err => this.deps.log?.error('distribuição do plano falhou', err));
      else if (outcome.status === 'failed' && !outcome.stop) {
        const md = ms.getMeeting(meetingId)!;
        ms.updateMeeting(meetingId, { distribution: { ...(md.distribution ?? { requestedAt: Date.now(), planVersion: null }), state: 'failed', error: outcome.error } });
      }
    }
    this.deps.broadcast({ kind: 'meeting.turn', meetingId, turn: ms.getTurn(turnId)! });
    this.deps.log?.info(`turno ${turnId.slice(0, 8)} de ${p.name}: ${outcome.status}${outcome.error ? ' · ' + outcome.error.slice(0, 160) : ''} · ${Math.round(outcome.durationMs / 1000)} s`);
    this.refreshStates(meetingId);
    this.pump();
  }

  // ---------------- fora da reunião (limite de uso, provedor parado) ----------------
  private awayText(a: NonNullable<MeetingParticipant['away']>, now = Date.now()): string {
    return a.until && a.until > now && a.untilInformed !== false ? `${a.reason}; libera às ${formatBrt(a.until, now)}` : a.reason;
  }

  /**
   * O provedor parou (limite de uso, troca forçada de modelo, modelo recusado): todos que usam esse provedor saem das reuniões em
   * andamento, os turnos deles na fila são pulados (a síntese passa para quem ficou) e a conversa segue com o Chefe e os demais.
   */
  sendAway(provider: AiProviderId, stop: ProviderTurnStop, now = Date.now()): void {
    const ms = this.deps.meetings;
    for (const m of ms.listMeetings()) {
      if (m.status === 'ended' || m.deletedAt) continue;
      const leaving = m.participants.filter(p => p.kind === 'ai' && p.provider === provider && !p.away);
      if (!leaving.length) continue;
      const away = { kind: stop.kind, reason: stop.reason, since: now, until: stop.until, untilInformed: Boolean(stop.untilInformed ?? (stop.until !== null)), asking: false };
      for (const p of leaving) ms.updateParticipant(p.id, { away, state: 'away', stateDetail: this.awayText(away, now) });
      const fresh = ms.getMeeting(m.id)!;
      for (const t of ms.listTurnsByStatus(['queued'], m.id)) {
        const owner = fresh.participants.find(x => x.id === t.participantId);
        if (owner?.away) this.skipAwayTurn(fresh, t, owner);
      }
      // O responsável pela consolidação saiu: passa ao gerente que ficou (registrado), sem esperar o próximo turno.
      if (fresh.synthesisParticipantId && leaving.some(p => p.id === fresh.synthesisParticipantId)) {
        const to = fresh.participants.find(p => p.kind === 'ai' && !p.employeeId && !p.away);
        const from = leaving.find(p => p.id === fresh.synthesisParticipantId)!;
        if (to) {
          ms.updateMeeting(m.id, { synthesisParticipantId: to.id });
          this.notice(m.id, `Responsabilidade pela consolidação passou de ${from.name} para ${to.name}. ${to.name} segue com o modelo e o esforço escolhidos para ele nesta reunião.`);
        }
      }
      const names = leaving.map(p => p.name).join(', ');
      const stay = fresh.participants.filter(p => p.kind === 'ai' && !p.away).map(p => p.name);
      const when = stop.until && (stop.untilInformed ?? true)
        ? `Quando liberar (${formatBrt(stop.until, now)}, horário de Brasília, informado pela conexão), eu pergunto se ${leaving.length > 1 ? 'eles voltam' : 'ele volta'}.`
        : stop.until ? `A conexão não informou quando libera; confiro de novo mais tarde e pergunto se ${leaving.length > 1 ? 'eles voltam' : 'ele volta'}.`
          : 'Quando um teste em Ajustes → Inteligência artificial passar, eu pergunto se volta; você também pode chamar de volta a qualquer momento.';
      const partial = ms.listMessages(m.id).some(x => x.kind === 'speech' && x.partial && leaving.some(p => p.id === x.participantId));
      this.notice(m.id, `${names} ${leaving.length > 1 ? 'saíram' : 'saiu'} da reunião: ${stop.reason}. ${stay.length ? `A conversa segue com você e ${stay.join(', ')}.` : 'Não ficou nenhuma IA à mesa: a reunião fica pausada; o trabalho já distribuído continua na fila.'} ${partial ? 'A última fala dele ficou parcial e está marcada assim: não conta como decisão. ' : ''}${when}`);
      if (!stay.length) {
        const now2 = ms.getMeeting(m.id)!;
        ms.updateMeeting(m.id, { ...(now2.status === 'active' ? { status: 'paused' as const } : {}), ...(now2.distribution?.state === 'planning' ? { distribution: { ...now2.distribution, state: 'waiting_manager' as const } } : {}) });
      }
      this.deps.log?.info(`reunião ${m.id.slice(0, 8)}: ${names} fora (${stop.kind}${stop.until ? ` até ${new Date(stop.until).toISOString()}` : ''})`);
      this.refreshStates(m.id);
    }
  }

  /**
   * Turno de quem está fora. Fala comum: pulada. Consolidação (síntese ou plano): passa para o gerente que ficou, com a
   * passagem registrada; se nenhum ficou, a reunião pausa com o turno guardado (volta quando um gerente voltar, sem refazer rodadas).
   */
  private skipAwayTurn(m: Meeting, t: MeetingTurn, owner: MeetingParticipant): 'skipped' | 'moved' | 'paused' {
    const ms = this.deps.meetings;
    const stay = m.participants.filter(p => p.kind === 'ai' && !p.away);
    if (t.phase === 'synthesis' || t.phase === 'plan') {
      const to = stay.find(p => !p.employeeId) ?? (t.phase === 'synthesis' ? stay[0] : null);
      if (!to) {
        if (m.status === 'active') {
          ms.updateMeeting(m.id, { status: 'paused', ...(t.phase === 'plan' && m.distribution ? { distribution: { ...m.distribution, state: 'waiting_manager' } } : {}) });
          this.notice(m.id, `Nenhum gerente disponível para ${t.phase === 'plan' ? 'consolidar o plano' : 'fazer a síntese'}: a reunião fica pausada com esse passo guardado. O que já foi distribuído continua na fila. Quando um gerente voltar, a reunião segue de onde parou.`);
          this.refreshStates(m.id);
        }
        return 'paused';
      }
      ms.reassignTurn(t.id, to.id, this.requestedFor(to));
      if (m.synthesisParticipantId === owner.id || !m.synthesisParticipantId) ms.updateMeeting(m.id, { synthesisParticipantId: to.id, ...(t.phase === 'plan' && m.distribution ? { distribution: { ...m.distribution, state: 'planning' } } : {}) });
      this.notice(m.id, `Responsabilidade pela consolidação passou de ${owner.name} para ${to.name} (${owner.away?.reason ?? 'fora da reunião'}). ${to.name} continua com o modelo e o esforço já escolhidos para ele nesta reunião, com o histórico, as decisões e as pendências.`);
      this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: ms.getTurn(t.id)! });
      return 'moved';
    }
    ms.updateTurn(t.id, { status: 'skipped', finishedAt: Date.now(), error: `${owner.name} está fora da reunião (${owner.away ? this.awayText(owner.away) : 'provedor parado'})` });
    this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: ms.getTurn(t.id)! });
    return 'skipped';
  }

  /** Quem saiu por limite e já pode voltar: a HQ pergunta uma vez ao Chefe (aviso na conversa + faixa acima dela). */
  checkReturns(now = Date.now()): void {
    const ms = this.deps.meetings;
    for (const m of ms.listMeetings()) {
      if (m.status === 'ended' || m.deletedAt) continue;
      if (m.status === 'paused' && m.distribution?.state === 'waiting_manager' && this.planOwner(m)) {
        // Um gerente voltou: a consolidação guardada segue sem refazer rodadas nem redistribuir o que já foi feito.
        ms.updateMeeting(m.id, { status: 'active', distribution: { ...m.distribution, state: 'planning' } });
        this.notice(m.id, `${this.planOwner(m)!.name} está disponível: a consolidação do plano continua de onde parou.`);
        this.refreshStates(m.id); this.pump();
      }
      const ready = m.participants.filter(p => {
        if (!p.away || p.away.asking || !p.provider) return false;
        if (p.away.until !== null) return now >= p.away.until;
        const st = this.deps.registry.statusOf(p.provider);
        return Boolean(st.lastTest?.ok && st.lastTest.at > p.away.since);
      });
      if (!ready.length) continue;
      for (const p of ready) ms.updateParticipant(p.id, { away: { ...p.away!, asking: true } });
      const names = ready.map(p => p.name).join(', ');
      this.notice(m.id, `${names} ${ready.length > 1 ? 'podem' : 'pode'} voltar: ${ready[0].away!.until !== null ? 'o limite de uso liberou' : 'o teste de conexão passou'}. Quer chamar de volta? Use "Chamar de volta" acima da conversa (ou "Tirar da reunião" para dispensar).`);
      this.refreshStates(m.id);
    }
  }

  /** O Chefe chama de volta quem a HQ tirou da reunião. A sessão anterior é mantida: a volta continua a mesma conversa. */
  private rejoin(meetingId: string, participantId: string): void {
    const ms = this.deps.meetings;
    const m = this.meeting(meetingId);
    const p = m.participants.find(x => x.id === participantId); if (!p) throw new Error('participante não encontrado');
    if (!p.away) return;
    const early = p.away.until !== null && p.away.until > Date.now();
    ms.updateParticipant(p.id, { away: null, state: 'available', stateDetail: null });
    this.notice(m.id, `Você chamou ${p.name} de volta para a reunião.${early ? ` O limite informado só libera às ${formatBrt(p.away.until!, Date.now())}: se ainda estiver esgotado, ${p.name} sai de novo no próximo turno.` : ''}`);
    this.refreshStates(m.id);
  }

  private failTurn(m: Meeting, turn: MeetingTurn, p: MeetingParticipant | null, reason: string, unavailable: boolean): void {
    const ms = this.deps.meetings;
    ms.updateTurn(turn.id, { status: 'failed', finishedAt: Date.now(), error: reason });
    if (p && unavailable) ms.updateParticipant(p.id, { state: 'unavailable', stateDetail: reason });
    this.notice(m.id, `${p?.name ?? 'Participante'} não pôde responder (${PHASE_LABELS[turn.phase]}): ${reason}`);
    this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: ms.getTurn(turn.id)! });
    this.active = null;
    this.refreshStates(m.id);
    this.pump();
  }

  private async interrupt(meetingId: string): Promise<void> {
    const m = this.meeting(meetingId);
    const a = this.active;
    if (!a || a.meetingId !== m.id) throw new Error('nenhum turno em andamento nesta reunião');
    if (m.status === 'active') this.deps.meetings.updateMeeting(m.id, { status: 'paused' });
    if (a.handle) { await a.handle.interrupt(); await Promise.race([a.handle.done, new Promise(r => setTimeout(r, 15_000))]); }
  }

  private async end(meetingId: string): Promise<Meeting> {
    const ms = this.deps.meetings;
    const m = this.meeting(meetingId);
    if (m.status === 'ended') return m;
    const a = this.active;
    if (a && a.meetingId === m.id && a.handle) { await a.handle.interrupt(); await Promise.race([a.handle.done, new Promise(r => setTimeout(r, 15_000))]); }
    for (const t of ms.listTurnsByStatus(['queued'], m.id)) { ms.updateTurn(t.id, { status: 'skipped', finishedAt: Date.now(), error: 'reunião encerrada' }); this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: ms.getTurn(t.id)! }); }
    const endedAt = Date.now();
    const fresh = ms.updateMeeting(m.id, { status: 'ended', endedAt, activeTurnId: null })!;
    if (m.minutes?.editedAt != null) {
      // A ata editada pelo Chefe nunca é sobrescrita por um rascunho automático; o que veio depois de reabrir continua na conversa.
      this.notice(m.id, 'Reunião encerrada de novo. A ata que você editou foi mantida; o rascunho automático não foi regerado.');
    } else {
      const project = fresh.projectId ? this.deps.store.getProject(fresh.projectId) : null;
      const text = renderMinutes({ meeting: fresh, project, messages: ms.listMessages(m.id), decisions: ms.listDecisions(m.id), employees: this.deps.store.listEmployees() });
      ms.updateMeeting(m.id, { minutes: { text, generatedAt: endedAt, editedAt: null } });
      this.notice(m.id, 'Reunião encerrada. O rascunho da ata está na aba Ata; edite e salve como quiser.');
    }
    return this.refreshStates(m.id);
  }

  // ---------------- encerrar e distribuir ----------------
  /** Gerente responsável pela consolidação: o escolhido (se for gerente e estiver à mesa), senão o outro gerente disponível. */
  planOwner(m: Meeting): MeetingParticipant | null {
    const managers = m.participants.filter(p => p.kind === 'ai' && !p.employeeId);
    const chosen = managers.find(p => p.id === m.synthesisParticipantId && !p.away);
    return chosen ?? managers.find(p => !p.away) ?? null;
  }

  /**
   * "Encerrar e distribuir tarefas" (botão ou instrução inequívoca do Chefe no chat). Idempotente: enquanto há um plano sendo
   * consolidado ou já distribuído, repetir devolve o andamento atual sem criar turno nem tarefa. Falas na fila são encerradas;
   * a consolidação vai para o gerente responsável (ou espera um gerente voltar, com a reunião pausada).
   */
  endAndDistribute(meetingId: string): { distribution: NonNullable<Meeting['distribution']>; turn: MeetingTurn | null } {
    const ms = this.deps.meetings;
    const m = this.meeting(meetingId);
    const cur = m.distribution;
    const openPlan = ms.listTurnsByStatus(['queued', 'running'], m.id).find(t => t.phase === 'plan') ?? (this.active?.meetingId === m.id ? ms.getTurn(this.active.turnId) : null);
    if (cur && (cur.state === 'distributed' || ((cur.state === 'planning' || cur.state === 'waiting_manager') && openPlan?.phase === 'plan'))) return { distribution: cur, turn: null };
    if (!m.participants.some(p => p.kind === 'ai')) throw new Error('não há gerente nem funcionário de IA nesta reunião para consolidar o plano');
    for (const t of ms.listTurnsByStatus(['queued'], m.id)) { ms.updateTurn(t.id, { status: 'skipped', finishedAt: Date.now(), error: 'reunião encerrada para distribuir as tarefas' }); this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn: ms.getTurn(t.id)! }); }
    const owner = this.planOwner(m) ?? m.participants.find(p => p.kind === 'ai' && !p.away) ?? null;
    const target = owner ?? m.participants.find(p => p.id === m.synthesisParticipantId) ?? m.participants.find(p => p.kind === 'ai' && !p.employeeId) ?? m.participants.find(p => p.kind === 'ai')!;
    const distribution = { state: owner ? 'planning' as const : 'waiting_manager' as const, requestedAt: Date.now(), planVersion: cur?.planVersion ?? null, error: null };
    ms.updateMeeting(m.id, { distribution, status: owner ? 'active' : 'paused', startedAt: m.startedAt ?? Date.now(), ...(owner && !m.synthesisParticipantId && !owner.employeeId ? { synthesisParticipantId: owner.id } : {}) });
    const turn = ms.createTurn({ meetingId: m.id, participantId: target.id, round: m.currentRound, phase: 'plan', requested: this.requestedFor(target), contextVersion: m.contextVersion });
    this.deps.broadcast({ kind: 'meeting.turn', meetingId: m.id, turn });
    this.notice(m.id, owner
      ? `Encerrar e distribuir tarefas: ${owner.name} consolida o plano a partir do que foi combinado com você. Propostas sem decisão sua ficam como pendências.`
      : 'Encerrar e distribuir tarefas: nenhum gerente está disponível agora. O pedido fica guardado e a reunião pausada; quando um gerente voltar, ele consolida o plano.');
    this.deps.log?.info(`reunião ${m.id.slice(0, 8)}: encerrar e distribuir (${owner ? `consolida ${owner.name}` : 'esperando um gerente'})`);
    this.refreshStates(m.id);
    this.pump();
    return { distribution: this.deps.meetings.getMeeting(m.id)!.distribution!, turn };
  }

  /** Grava o plano (nova versão), registra pendências e falta de gente, cria as tarefas na fila e encerra com a ata. */
  private async applyPlan(meetingId: string, author: MeetingParticipant, parsed: Pick<MeetingPlan, 'summary' | 'decisions' | 'pending' | 'needs' | 'tasks'>, warnings: string[]): Promise<void> {
    const ms = this.deps.meetings;
    const plan = ms.addPlan({ meetingId, authorParticipantId: author.id, authorName: author.name, ...parsed });
    for (const spec of plan.tasks) ms.upsertPlanTask(meetingId, plan.version, spec);
    for (const n of plan.needs) this.deps.needs?.add({ meetingId, planTaskId: null, text: n });
    await this.dispatchPlanTasks(meetingId);
    const m = ms.getMeeting(meetingId)!;
    const records = ms.listPlanTasks(meetingId);
    const who = new Map(records.map(r => [r.key, r.spec.employeeName ?? '—']));
    const project = m.projectId ? this.deps.store.getProject(m.projectId) : null;
    const base = m.minutes?.editedAt != null ? m.minutes.text : renderMinutes({ meeting: m, project, messages: ms.listMessages(m.id), decisions: ms.listDecisions(m.id), employees: this.deps.store.listEmployees() });
    const minutes = { text: `${base.replace(/\n## Plano consolidado \(v[\s\S]*$/, '')}\n\n${renderPlanSection(plan, who)}`, generatedAt: m.minutes?.generatedAt ?? Date.now(), editedAt: m.minutes?.editedAt ?? null };
    ms.updateMeeting(meetingId, { status: 'ended', endedAt: m.endedAt ?? Date.now(), minutes, distribution: { state: 'distributed', requestedAt: m.distribution?.requestedAt ?? Date.now(), planVersion: plan.version, error: null } });
    const created = records.filter(r => r.status === 'created');
    const blocked = records.filter(r => r.status === 'blocked');
    const lines = created.map(r => `${r.spec.title} → ${r.spec.employeeName}${r.spec.dependsOn.length ? ' (espera dependência)' : ''}`);
    this.notice(meetingId, [
      `Plano v${plan.version} de ${author.name} gravado na ata. ${created.length} tarefa(s) na fila${lines.length ? `: ${lines.join('; ')}` : ''}.`,
      blocked.length ? `${blocked.length} sem poder entrar na fila (na sua mesa, em Bloqueios).` : '',
      plan.pending.length ? `${plan.pending.length} pendência(s) esperando decisão sua.` : '',
      warnings.length ? `Avisos: ${warnings.join('; ')}.` : '',
    ].filter(Boolean).join(' '));
    this.broadcastPlan(meetingId);
    this.refreshStates(meetingId);
  }

  /** Itens pendentes ou bloqueados por motivo passageiro viram tarefas reais (identidade estável: nunca duas cópias). */
  async dispatchPlanTasks(meetingId: string): Promise<void> {
    const ms = this.deps.meetings;
    const m = ms.getMeeting(meetingId); if (!m) return;
    const plans = ms.listPlans(meetingId); const version = plans.length ? plans[plans.length - 1].version : 1;
    const records = ms.listPlanTasks(meetingId);
    const byKey = new Map(records.map(r => [r.key, r]));
    for (const rec of records) {
      if (rec.status === 'created' || (rec.status === 'blocked' && /ninguém apto|não está na equipe|sem projeto/.test(rec.blockedReason ?? ''))) continue;
      const spec = rec.spec;
      const block = (why: string) => { ms.updatePlanTask(rec.id, { status: 'blocked', blockedReason: why }); this.deps.needs?.add({ meetingId, planTaskId: rec.id, text: `"${spec.title}": ${why}` }); };
      const emp = spec.employeeId ? this.deps.store.getEmployee(spec.employeeId) : null;
      if (!emp || emp.archivedAt) { block(spec.employeeName ? `${spec.employeeName} não está na equipe; ninguém apto foi atribuído` : 'ninguém apto na equipe para esta tarefa'); continue; }
      const project = spec.projectId ? this.deps.store.getProject(spec.projectId) : null;
      if (!project) { block('sem projeto ou pasta cadastrada para salvar o resultado'); continue; }
      if (!this.deps.manager.runTask) { block('a fila de tarefas não está disponível neste serviço'); continue; }
      const deps = spec.dependsOn.map(k => byKey.get(k)).filter((d): d is PlanTaskRecord => Boolean(d));
      const waiting = deps.filter(d => !(d.taskId && this.deps.store.getTask(d.taskId)?.status === 'done'));
      const text = planTaskText({ spec, meetingTitle: m.title, planVersion: rec.planVersion || version, employee: emp, project, slotLabel: spec.slot ? SOCIAL_SLOTS.find(x => x.slot === spec.slot)?.label ?? spec.slot : null, depTitles: deps.map(d => d.spec.title) });
      const input: TaskRunInput = { reqId: 'meeting-plan', clientId: `meeting:${meetingId}:plan:${rec.key}`, text, projectId: project.id, employeeId: emp.id, skill: spec.skill, plan: false, destinationId: spec.slot ?? undefined };
      const extra = { origin: 'meeting' as const, meetingId, held: waiting.length > 0, heldReason: waiting.length ? `Aguardando dependência: ${waiting.map(d => d.spec.title).join('; ')}` : null };
      try {
        let res: TaskRunResult;
        try { res = await this.deps.manager.runTask(input, extra); }
        catch (err) {
          // Skill que não existe nesta máquina não trava o trabalho: vai sem ela, e o pedido diz qual era.
          if (!spec.skill || !/skill/i.test((err as Error).message)) throw err;
          res = await this.deps.manager.runTask({ ...input, skill: null, text: `${text}

(Skill sugerida no plano, não encontrada nesta máquina: ${spec.skill}.)` }, extra);
        }
        ms.updatePlanTask(rec.id, { status: 'created', taskId: res.taskId, sessionId: res.sessionId, blockedReason: null });
      } catch (err) { block(`não entrou na fila: ${(err as Error).message}`); }
    }
    this.broadcastPlan(meetingId);
  }

  /** Tarefa do plano terminou: libera as que só esperavam por ela (concluída). Falha mantém as dependentes esperando. */
  private onTaskFinished(taskId: string): void {
    const ms = this.deps.meetings;
    const rec = ms.findPlanTaskByTask(taskId); if (!rec) return;
    this.releaseReady(rec.meetingId);
    this.broadcastPlan(rec.meetingId);
  }

  private releaseReady(meetingId: string): void {
    const ms = this.deps.meetings;
    const records = ms.listPlanTasks(meetingId);
    const byKey = new Map(records.map(r => [r.key, r]));
    for (const r of records) {
      if (r.status !== 'created' || !r.taskId || !r.spec.dependsOn.length) continue;
      const t = this.deps.store.getTask(r.taskId);
      if (!t || t.status !== 'queued' || !t.held || !t.heldReason?.startsWith('Aguardando dependência')) continue;
      const ready = r.spec.dependsOn.every(k => { const d = byKey.get(k); return Boolean(d?.taskId && this.deps.store.getTask(d.taskId)?.status === 'done'); });
      if (ready) { try { this.deps.manager.releaseTask(r.taskId); this.deps.log?.info(`plano: "${r.spec.title}" liberada (dependências concluídas)`); } catch (err) { this.deps.log?.warn('liberar tarefa do plano falhou', err); } }
    }
  }

  /** Depois de um reinício: libera o que ficou pronto e tenta de novo o que não entrou na fila por motivo passageiro. */
  recoverPlans(): void {
    for (const m of this.deps.meetings.listMeetings()) {
      const recs = this.deps.meetings.listPlanTasks(m.id);
      if (!recs.length) continue;
      this.releaseReady(m.id);
      if (recs.some(r => r.status === 'pending' || r.status === 'blocked')) void this.dispatchPlanTasks(m.id).catch(err => this.deps.log?.warn('tarefas do plano não entraram na fila', err));
    }
  }

  private broadcastPlan(meetingId: string): void {
    this.deps.broadcast({ kind: 'meeting.plan', meetingId, plans: this.deps.meetings.listPlans(meetingId), planTasks: this.deps.meetings.listPlanTasks(meetingId) });
  }

  // ---------------- quadro ----------------
  private boardFromSynthesis(meetingId: string, participantId: string, messageId: string | null, text: string): void {
    const parsed = parseSynthesis(text);
    const employees = this.deps.store.listEmployees().filter(e => !e.archivedAt);
    const add = (kind: DecisionKind, t: string, assignee: string | null = null) => {
      if (this.boardHas(meetingId, kind, t)) return; // o mesmo item repetido em outra rodada não duplica no quadro
      const d = this.deps.meetings.addDecision({ meetingId, kind, text: t.slice(0, 1000), participantId, confirmed: false, messageId, assigneeEmployeeId: assignee });
      this.deps.broadcast({ kind: 'meeting.decision', meetingId, op: 'upsert', decision: d });
    };
    for (const t of parsed.proposals) add('proposal', t);
    for (const t of parsed.divergences) add('divergence', t);
    for (const t of parsed.questions) add('question', t);
    for (const a of parsed.actions) {
      const emp = a.assignee ? employees.find(e => e.name.toLowerCase() === a.assignee!.toLowerCase()) ?? null : null;
      add('action', emp || !a.assignee ? a.text : `[${a.assignee}] ${a.text}`, emp?.id ?? null);
    }
  }

  /** Já existe no quadro um item do mesmo tipo com o mesmo texto (sem diferenciar maiúsculas/espaços)? */
  private boardHas(meetingId: string, kind: DecisionKind, text: string): boolean {
    const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    const t = norm(text);
    return this.deps.meetings.listDecisions(meetingId).some(d => d.kind === kind && norm(d.text) === t);
  }

  private boardFromSpeech(meetingId: string, participantId: string, messageId: string | null, text: string): void {
    const kinds: Record<string, DecisionKind> = { proposta: 'proposal', divergência: 'divergence', divergencia: 'divergence', pergunta: 'question', ação: 'action', acao: 'action', açao: 'action', acão: 'action' };
    for (const raw of text.split(/\r?\n/)) {
      const mm = raw.trim().match(BOARD_LINE); if (!mm) continue;
      const kind = kinds[mm[1].toLowerCase()]; if (!kind) continue;
      if (this.boardHas(meetingId, kind, mm[2])) continue;
      const d = this.deps.meetings.addDecision({ meetingId, kind, text: mm[2].trim().slice(0, 1000), participantId, confirmed: false, messageId });
      this.deps.broadcast({ kind: 'meeting.decision', meetingId, op: 'upsert', decision: d });
    }
  }

  // ---------------- tarefas ----------------
  private async createTasks(meetingId: string, items: { id: string; employeeId: string; projectId: string; instructions: string; start: boolean }[]): Promise<MeetingTaskItem[]> {
    const ms = this.deps.meetings;
    const m = this.meeting(meetingId);
    // Valida o lote inteiro antes de criar qualquer tarefa: um item inválido no meio não deixa metade criada.
    type Step = { done: MeetingTaskItem } | { cur: MeetingTaskItem; employeeId: string; projectId: string; instructions: string; start: boolean };
    const steps: Step[] = [];
    for (const it of items) {
      const cur = ms.getTaskItem(it.id);
      if (!cur || cur.meetingId !== m.id) throw new Error('item de tarefa não encontrado');
      if (cur.status === 'created') { steps.push({ done: cur }); continue; } // recarregar a página nunca duplica
      const employee = this.deps.store.getEmployee(it.employeeId);
      if (!employee || employee.archivedAt) throw new Error(`funcionário não encontrado para "${cur.title}"`);
      const project = this.deps.store.getProject(it.projectId);
      if (!project) throw new Error(`projeto não encontrado para "${cur.title}"`);
      const instructions = (it.instructions ?? cur.instructions ?? '').trim();
      if (!instructions) throw new Error(`escreva as instruções da tarefa "${cur.title}"`);
      steps.push({ cur, employeeId: employee.id, projectId: project.id, instructions, start: it.start });
    }
    const out: MeetingTaskItem[] = [];
    for (const step of steps) {
      if ('done' in step) { out.push(step.done); continue; }
      const { cur, instructions } = step;
      const employee = this.deps.store.getEmployee(step.employeeId);
      const project = this.deps.store.getProject(step.projectId);
      if (!employee || employee.archivedAt || !project) throw new Error(`o funcionário ou o projeto de "${cur.title}" mudou durante a criação; as tarefas seguintes não foram criadas`);
      let session: Session | null = employee.activeSessionId ? this.deps.store.getSession(employee.activeSessionId) : null;
      if (!session || session.status === 'archived' || session.projectId !== project.id) session = this.deps.manager.createSession({ roomId: employee.roomId, projectId: project.id, employeeId: employee.id, name: `${project.name} · reunião: ${m.title}`.slice(0, 120) });
      const text = `[Tarefa criada na reunião "${m.title}" da MilWeb HQ]\n${cur.title}\n\n${instructions}`;
      const task = await this.deps.manager.sendPrompt({ sessionId: session.id, clientId: `meeting:${m.id}:task:${cur.id}`, text, mode: 'queue', held: !step.start, meetingId: m.id });
      const saved = ms.upsertTaskItem({ id: cur.id, meetingId: m.id, title: cur.title, instructions, employeeId: employee.id, roomId: employee.roomId, projectId: project.id, status: 'created', taskId: task.id, sessionId: session.id });
      this.deps.broadcast({ kind: 'meeting.taskItem', meetingId: m.id, op: 'upsert', item: saved });
      out.push(saved);
    }
    return out;
  }

  // ---------------- estados e utilidades ----------------
  /** Recalcula o estado real de cada participante a partir dos turnos e do estado dos provedores; devolve e transmite a reunião. */
  refreshStates(meetingId: string, onlyIfChanged = false): Meeting {
    const ms = this.deps.meetings;
    const m = ms.getMeeting(meetingId)!;
    let changed = false;
    const turns = ms.listTurns(m.id);
    const queued = turns.filter(t => t.status === 'queued');
    for (const p of m.participants) {
      let state: ParticipantState = 'available'; let detail: string | null = null;
      if (p.kind === 'ai' && p.provider) {
        const st = this.deps.registry.statusOf(p.provider);
        const mine = turns.filter(t => t.participantId === p.id);
        const last = mine[mine.length - 1];
        if (p.away) { state = 'away'; detail = this.awayText(p.away); }
        else if (!st.installed || st.authState === 'missing') { state = 'unavailable'; detail = st.authDetail ?? (st.installed ? 'sem login' : 'não instalado'); }
        else if (this.active?.participantId === p.id && this.active.meetingId === m.id) { state = 'responding'; detail = p.stateDetail; }
        else if (queued.some(t => t.participantId === p.id)) { state = 'waiting_turn'; detail = m.status === 'active' ? null : 'reunião pausada'; }
        else if (last?.status === 'interrupted') { state = 'interrupted'; detail = null; }
        else if (last?.status === 'failed' || last?.status === 'lost') { state = 'available'; detail = last.error?.slice(0, 200) ?? null; }
        else if (m.status === 'active') { state = 'waiting_chefe'; detail = null; }
      }
      if (p.state !== state || p.stateDetail !== detail) { ms.updateParticipant(p.id, { state, stateDetail: detail }); changed = true; }
    }
    if (onlyIfChanged && !changed) return m;
    return this.broadcastMeeting(m.id);
  }

  private broadcastMeeting(meetingId: string): Meeting {
    const m = this.deps.meetings.getMeeting(meetingId)!;
    this.deps.broadcast({ kind: 'entity', entity: 'meeting', op: 'upsert', item: m });
    return m;
  }

  private notice(meetingId: string, text: string, clientId: string | null = null): MeetingMessage {
    const m = this.deps.meetings.getMeeting(meetingId);
    const message = this.deps.meetings.addMessage({ meetingId, turnId: null, participantId: SYSTEM_PARTICIPANT, authorName: 'MilWeb HQ', provider: null, kind: 'notice', text, round: m?.currentRound || null, phase: null, targets: [], config: null, contextVersion: m?.contextVersion ?? 1, partial: false, clientId });
    this.deps.broadcast({ kind: 'meeting.message', meetingId, message });
    return message;
  }

  private meeting(id: string): Meeting {
    const m = this.deps.meetings.getMeeting(id);
    if (!m) throw new Error('reunião não encontrada');
    if (m.deletedAt) throw new Error('esta reunião está na lixeira de reuniões: restaure-a antes de continuar');
    return m;
  }

  /**
   * Caminho de arquivo de contexto: precisa estar dentro de um projeto ou pasta cadastrada, fora dos dados da HQ
   * (token, banco) e sem link simbólico ou junction em nenhum segmento abaixo da raiz (a HQ nunca segue links).
   * Devolve o motivo da recusa, ou null quando o caminho é aceitável.
   */
  private contextPathProblem(p: string): string | null {
    const norm = (s: string) => path.resolve(s).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    const target = norm(p);
    const roots = [...this.deps.store.listProjects().map(x => x.path), ...this.deps.store.listFolders().map(x => x.path)];
    const root = roots.find(r => { const n = norm(r); return target === n || target.startsWith(n + '/'); });
    if (!root) return 'o arquivo não está em nenhum projeto ou pasta cadastrada na HQ';
    const data = norm(this.deps.dataDir);
    if (target === data || target.startsWith(data + '/')) return 'caminho protegido (dados da MilWeb HQ)';
    const segs = path.relative(path.resolve(root), path.resolve(p)).split(/[\\/]+/).filter(Boolean);
    let cur = path.resolve(root);
    for (const seg of segs) {
      cur = path.join(cur, seg);
      let st: fs.Stats;
      try { st = fs.lstatSync(cur); } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'arquivo não existe' : `não foi possível acessar: ${(err as Error).message}`; }
      if (st.isSymbolicLink()) return `"${seg}" é um link simbólico ou junction; a HQ não segue links`;
    }
    return null;
  }

  private readContextFiles(items: MeetingContextItem[]): Map<string, { text: string; truncated: boolean; error?: string }> {
    const out = new Map<string, { text: string; truncated: boolean; error?: string }>();
    for (const it of items) {
      if (it.kind !== 'file' || !it.enabled || !it.path) continue;
      try {
        const problem = this.contextPathProblem(it.path);
        if (problem) { out.set(it.id, { text: '', truncated: false, error: problem }); continue; }
        const st = fs.lstatSync(it.path);
        if (st.isSymbolicLink()) { out.set(it.id, { text: '', truncated: false, error: 'link simbólico (não seguido)' }); continue; }
        if (!st.isFile()) { out.set(it.id, { text: '', truncated: false, error: 'não é um arquivo' }); continue; }
        const fd = fs.openSync(it.path, 'r');
        try {
          const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          const slice = buf.subarray(0, n);
          if (slice.includes(0)) { out.set(it.id, { text: '', truncated: false, error: 'arquivo binário' }); continue; }
          out.set(it.id, { text: slice.toString('utf8'), truncated: st.size > MAX_FILE_BYTES });
        } finally { fs.closeSync(fd); }
      } catch (err) { out.set(it.id, { text: '', truncated: false, error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'arquivo não existe mais' : String((err as Error).message ?? err) }); }
    }
    return out;
  }

  private cwdFor(m: Meeting, project: Project | null): string {
    if (project && fs.existsSync(project.path)) return project.path;
    const dir = path.join(this.deps.dataDir, 'meetings', m.id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

export type { Employee, MeetingDecision, TurnPhase };
