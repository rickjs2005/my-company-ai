// Repositório das reuniões (tabelas meeting_* do esquema v3). Só persistência: as regras ficam no coordenador.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AiProviderId, AiProviderPrefs, EffortLevel, Meeting, MeetingContextItem, MeetingDecision, MeetingMessage, MeetingMinutes, MeetingParticipant,
  MeetingTaskItem, MeetingTurn, TurnStatus, MeetingDistribution, MeetingPlan, PlanTaskRecord, PlanTaskSpec,
} from '@milweb-hq/protocol';

type Row = Record<string, unknown>;
/** Ordem das etapas dentro de uma rodada (resposta e opinião abrem; revisão depois; síntese fecha). */
const STAGE_RANK: Record<MeetingTurn['phase'], number> = { reply: 0, opinion: 0, revision: 1, synthesis: 2, plan: 3 };
const j =(v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(s: unknown, fallback: T): T => { try { return s == null ? fallback : (JSON.parse(String(s)) as T); } catch { return fallback; } };
const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

export class MeetingStore {
  constructor(readonly db: DatabaseSync) {}

  // ---------- reuniões ----------
  /** Reuniões ativas (fora da lixeira). A fila, a retomada e a tela só enxergam estas. */
  listMeetings(): Meeting[] {
    return (this.db.prepare('SELECT * FROM meetings WHERE deleted_at IS NULL ORDER BY updated_at DESC').all() as Row[]).map(r => this.rowToMeeting(r));
  }
  /** Lixeira de reuniões, mais recentes primeiro. */
  listDeletedMeetings(): Meeting[] {
    return (this.db.prepare('SELECT * FROM meetings WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all() as Row[]).map(r => this.rowToMeeting(r));
  }
  /** Manda para a lixeira: nada é apagado; falas, quadro, contexto e ata ficam guardados. */
  softDeleteMeeting(id: string, at = Date.now()): void {
    this.db.prepare('UPDATE meetings SET deleted_at = ?, active_turn_id = NULL WHERE id = ?').run(at, id);
  }
  restoreMeeting(id: string): void {
    this.db.prepare('UPDATE meetings SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
  getMeeting(id: string): Meeting | null {
    const r = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToMeeting(r) : null;
  }
  createMeeting(input: { id?: string; title: string; agenda: string; projectId: string | null; mode: Meeting['mode']; roundLimit: number; companyContext?: boolean }): Meeting {
    const id = input.id ?? randomUUID(); const now = Date.now();
    this.db.prepare('INSERT INTO meetings(id, title, agenda, project_id, mode, status, round_limit, current_round, context_version, synthesis_participant_id, company_context, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.title, input.agenda, input.projectId, input.mode, 'draft', input.roundLimit, 0, 1, null, input.companyContext === false ? 0 : 1, now, now);
    return this.getMeeting(id)!;
  }
  updateMeeting(id: string, patch: Partial<Pick<Meeting, 'title' | 'agenda' | 'projectId' | 'mode' | 'status' | 'roundLimit' | 'currentRound' | 'contextVersion' | 'synthesisParticipantId' | 'companyContext' | 'startedAt' | 'endedAt' | 'minutes' | 'activeTurnId' | 'distribution'>>): Meeting | null {
    const cur = this.getMeeting(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE meetings SET title=?, agenda=?, project_id=?, mode=?, status=?, round_limit=?, current_round=?, context_version=?, synthesis_participant_id=?, company_context=?, updated_at=?, started_at=?, ended_at=?, minutes_json=?, active_turn_id=?, distribution_json=? WHERE id=?')
      .run(n.title, n.agenda, n.projectId ?? null, n.mode, n.status, n.roundLimit, n.currentRound, n.contextVersion, n.synthesisParticipantId ?? null, n.companyContext ? 1 : 0, Date.now(), n.startedAt ?? null, n.endedAt ?? null, n.minutes ? j(n.minutes) : null, n.activeTurnId ?? null, n.distribution ? j(n.distribution) : null, id);
    return this.getMeeting(id);
  }
  deleteMeeting(id: string): void {
    for (const t of ['meeting_participants', 'meeting_messages', 'meeting_turns', 'meeting_decisions', 'meeting_context_items', 'meeting_task_items', 'meeting_plans', 'plan_tasks']) {
      this.db.prepare(`DELETE FROM ${t} WHERE meeting_id = ?`).run(id);
    }
    this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  }

  // ---------- participantes ----------
  listParticipants(meetingId: string): MeetingParticipant[] {
    return (this.db.prepare('SELECT * FROM meeting_participants WHERE meeting_id = ? ORDER BY order_index, name').all(meetingId) as Row[]).map(rowToParticipant);
  }
  getParticipant(id: string): MeetingParticipant | null {
    const r = this.db.prepare('SELECT * FROM meeting_participants WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToParticipant(r) : null;
  }
  addParticipant(input: { id?: string; meetingId: string; kind: 'chefe' | 'ai'; provider: AiProviderId | null; name: string; employeeId?: string | null; model?: string | null; effort?: EffortLevel | null; useGlobal?: boolean; seat?: number; order?: number }): MeetingParticipant {
    const id = input.id ?? randomUUID();
    const existing = this.listParticipants(input.meetingId);
    const order = input.order ?? existing.length;
    const seat = input.seat ?? (existing.length ? Math.max(...existing.map(p => p.seat)) + 1 : 0);
    this.db.prepare('INSERT INTO meeting_participants(id, meeting_id, kind, provider, name, employee_id, model, effort, use_global, state, state_detail, thread_id, seat, order_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.meetingId, input.kind, input.provider, input.name, input.employeeId ?? null, input.model ?? null, input.effort ?? null, input.useGlobal === false ? 0 : 1, 'available', null, null, seat, order);
    this.touch(input.meetingId);
    return this.getParticipant(id)!;
  }
  updateParticipant(id: string, patch: Partial<Pick<MeetingParticipant, 'name' | 'employeeId' | 'model' | 'effort' | 'useGlobal' | 'state' | 'stateDetail' | 'threadId' | 'seat' | 'order' | 'away'>>): MeetingParticipant | null {
    const cur = this.getParticipant(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE meeting_participants SET name=?, employee_id=?, model=?, effort=?, use_global=?, state=?, state_detail=?, thread_id=?, seat=?, order_index=?, away_json=? WHERE id=?')
      .run(n.name, n.employeeId ?? null, n.model ?? null, n.effort ?? null, n.useGlobal ? 1 : 0, n.state, n.stateDetail ?? null, n.threadId ?? null, n.seat, n.order, n.away ? j(n.away) : null, id);
    return this.getParticipant(id);
  }
  removeParticipant(id: string): void {
    const p = this.getParticipant(id); if (!p) return;
    this.db.prepare('DELETE FROM meeting_participants WHERE id = ?').run(id);
    this.touch(p.meetingId);
  }

  // ---------- mensagens ----------
  listMessages(meetingId: string, limit = 2000): MeetingMessage[] {
    const rows = this.db.prepare('SELECT * FROM meeting_messages WHERE meeting_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(meetingId, limit) as Row[];
    return rows.reverse().map(rowToMessage);
  }
  getMessage(id: string): MeetingMessage | null {
    const r = this.db.prepare('SELECT * FROM meeting_messages WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToMessage(r) : null;
  }
  findMessageByClientId(clientId: string): MeetingMessage | null {
    const r = this.db.prepare('SELECT * FROM meeting_messages WHERE client_id = ?').get(clientId) as Row | undefined;
    return r ? rowToMessage(r) : null;
  }
  addMessage(m: Omit<MeetingMessage, 'id' | 'ts'> & { id?: string; ts?: number; clientId?: string | null }): MeetingMessage {
    const id = m.id ?? randomUUID(); const ts = m.ts ?? Date.now();
    this.db.prepare('INSERT INTO meeting_messages(id, meeting_id, turn_id, participant_id, author_name, provider, kind, text, ts, round, phase, targets_json, config_json, context_version, partial, client_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, m.meetingId, m.turnId ?? null, m.participantId, m.authorName, m.provider ?? null, m.kind, m.text, ts, m.round ?? null, m.phase ?? null, j(m.targets ?? []), m.config ? j(m.config) : null, m.contextVersion, m.partial ? 1 : 0, m.clientId ?? null);
    this.touch(m.meetingId);
    return this.getMessage(id)!;
  }
  updateMessage(id: string, patch: Partial<Pick<MeetingMessage, 'text' | 'partial' | 'config' | 'turnId'>>): MeetingMessage | null {
    const cur = this.getMessage(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE meeting_messages SET text=?, partial=?, config_json=?, turn_id=? WHERE id=?').run(n.text, n.partial ? 1 : 0, n.config ? j(n.config) : null, n.turnId ?? null, id);
    return this.getMessage(id);
  }

  // ---------- turnos ----------
  listTurns(meetingId: string): MeetingTurn[] {
    return (this.db.prepare('SELECT * FROM meeting_turns WHERE meeting_id = ? ORDER BY order_index, created_at').all(meetingId) as Row[]).map(rowToTurn);
  }
  getTurn(id: string): MeetingTurn | null {
    const r = this.db.prepare('SELECT * FROM meeting_turns WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToTurn(r) : null;
  }
  listTurnsByStatus(statuses: TurnStatus[], meetingId?: string): MeetingTurn[] {
    const q = statuses.map(() => '?').join(',');
    const rows = meetingId
      ? this.db.prepare(`SELECT * FROM meeting_turns WHERE meeting_id = ? AND status IN (${q}) ORDER BY order_index, created_at`).all(meetingId, ...statuses)
      : this.db.prepare(`SELECT * FROM meeting_turns WHERE status IN (${q}) ORDER BY order_index, created_at`).all(...statuses);
    return (rows as Row[]).map(rowToTurn);
  }
  countQueued(meetingId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM meeting_turns WHERE meeting_id = ? AND status = 'queued'").get(meetingId) as Row).n);
  }
  createTurn(input: { id?: string; meetingId: string; participantId: string; round: number; phase: MeetingTurn['phase']; requested: AiProviderPrefs; contextVersion: number }): MeetingTurn {
    const id = input.id ?? randomUUID(); const now = Date.now();
    const order = Number((this.db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS o FROM meeting_turns WHERE meeting_id = ?').get(input.meetingId) as Row).o);
    this.db.prepare('INSERT INTO meeting_turns(id, meeting_id, participant_id, round, phase, status, requested_json, applied_json, context_version, created_at, prompt_chars, order_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.meetingId, input.participantId, input.round, input.phase, 'queued', j(input.requested), null, input.contextVersion, now, 0, order);
    return this.getTurn(id)!;
  }
  /** Consolidação que muda de dono (gerente saiu): o mesmo turno, sem refazer rodadas; o pedido passa a ser o do novo dono. */
  reassignTurn(id: string, participantId: string, requested: AiProviderPrefs): void {
    this.db.prepare('UPDATE meeting_turns SET participant_id = ?, requested_json = ? WHERE id = ?').run(participantId, j(requested), id);
  }
  updateTurn(id: string, patch: Partial<Pick<MeetingTurn, 'status' | 'applied' | 'contextVersion' | 'startedAt' | 'finishedAt' | 'error' | 'messageId' | 'promptChars' | 'usage' | 'durationMs' | 'requested'>>): MeetingTurn | null {
    const cur = this.getTurn(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE meeting_turns SET status=?, requested_json=?, applied_json=?, context_version=?, started_at=?, finished_at=?, error=?, message_id=?, prompt_chars=?, usage_json=?, duration_ms=? WHERE id=?')
      .run(n.status, j(n.requested), n.applied ? j(n.applied) : null, n.contextVersion, n.startedAt ?? null, n.finishedAt ?? null, n.error ?? null, n.messageId ?? null, n.promptChars, n.usage ? j(n.usage) : null, n.durationMs ?? null, id);
    return this.getTurn(id);
  }
  /** Reordena um turno para o fim da fila (ex.: "tentar de novo"). */
  /**
   * Volta o turno para a fila. Vai para o fim, exceto quando já há na fila etapas posteriores da discussão (revisão ou
   * síntese depois de uma opinião que faltou): aí entra antes delas, porque a rodada seguinte depende da fala refeita.
   */
  requeueTurn(id: string): MeetingTurn | null {
    const cur = this.getTurn(id); if (!cur) return null;
    const stage = (t: MeetingTurn) => t.round * 10 + STAGE_RANK[t.phase];
    const later = this.listTurnsByStatus(['queued'], cur.meetingId).filter(t => t.id !== id && stage(t) > stage(cur));
    let order: number;
    if (later.length) {
      order = later[0].order;
      this.db.prepare('UPDATE meeting_turns SET order_index = order_index + 1 WHERE meeting_id = ? AND order_index >= ? AND id <> ?').run(cur.meetingId, order, id);
    } else order = Number((this.db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS o FROM meeting_turns WHERE meeting_id = ?').get(cur.meetingId) as Row).o);
    this.db.prepare("UPDATE meeting_turns SET status='queued', order_index=?, error=NULL, started_at=NULL, finished_at=NULL, applied_json=NULL, message_id=NULL, duration_ms=NULL, usage_json=NULL WHERE id=?").run(order, id);
    return this.getTurn(id);
  }

  // ---------- quadro (decisões, propostas, divergências, ações) ----------
  listDecisions(meetingId: string): MeetingDecision[] {
    return (this.db.prepare('SELECT * FROM meeting_decisions WHERE meeting_id = ? ORDER BY created_at').all(meetingId) as Row[]).map(rowToDecision);
  }
  getDecision(id: string): MeetingDecision | null {
    const r = this.db.prepare('SELECT * FROM meeting_decisions WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToDecision(r) : null;
  }
  addDecision(input: { id?: string; meetingId: string; kind: MeetingDecision['kind']; text: string; participantId?: string | null; confirmed?: boolean; assigneeEmployeeId?: string | null; messageId?: string | null }): MeetingDecision {
    const id = input.id ?? randomUUID(); const now = Date.now();
    this.db.prepare('INSERT INTO meeting_decisions(id, meeting_id, kind, text, participant_id, confirmed, dismissed, assignee_employee_id, message_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.meetingId, input.kind, input.text, input.participantId ?? null, input.confirmed ? 1 : 0, 0, input.assigneeEmployeeId ?? null, input.messageId ?? null, now, now);
    this.touch(input.meetingId);
    return this.getDecision(id)!;
  }
  updateDecision(id: string, patch: Partial<Pick<MeetingDecision, 'kind' | 'text' | 'confirmed' | 'dismissed' | 'assigneeEmployeeId'>>): MeetingDecision | null {
    const cur = this.getDecision(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE meeting_decisions SET kind=?, text=?, confirmed=?, dismissed=?, assignee_employee_id=?, updated_at=? WHERE id=?')
      .run(n.kind, n.text, n.confirmed ? 1 : 0, n.dismissed ? 1 : 0, n.assigneeEmployeeId ?? null, Date.now(), id);
    return this.getDecision(id);
  }
  deleteDecision(id: string): void { this.db.prepare('DELETE FROM meeting_decisions WHERE id = ?').run(id); }

  // ---------- contexto ----------
  listContext(meetingId: string): MeetingContextItem[] {
    return (this.db.prepare('SELECT * FROM meeting_context_items WHERE meeting_id = ? ORDER BY order_index').all(meetingId) as Row[]).map(rowToContextItem);
  }
  setContext(meetingId: string, items: MeetingContextItem[]): MeetingContextItem[] {
    this.db.prepare('DELETE FROM meeting_context_items WHERE meeting_id = ?').run(meetingId);
    const ins = this.db.prepare('INSERT INTO meeting_context_items(id, meeting_id, kind, label, path, text, enabled, order_index) VALUES (?,?,?,?,?,?,?,?)');
    items.forEach((it, i) => ins.run(it.id || randomUUID(), meetingId, it.kind, it.label, it.path ?? null, it.text ?? null, it.enabled === false ? 0 : 1, i));
    this.touch(meetingId);
    return this.listContext(meetingId);
  }

  // ---------- tarefas propostas ----------
  listTaskItems(meetingId: string): MeetingTaskItem[] {
    return (this.db.prepare('SELECT * FROM meeting_task_items WHERE meeting_id = ? ORDER BY created_at').all(meetingId) as Row[]).map(rowToTaskItem);
  }
  getTaskItem(id: string): MeetingTaskItem | null {
    const r = this.db.prepare('SELECT * FROM meeting_task_items WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToTaskItem(r) : null;
  }
  upsertTaskItem(input: { id?: string; meetingId: string; title: string; instructions?: string; employeeId?: string | null; roomId?: string | null; projectId?: string | null; status?: MeetingTaskItem['status']; taskId?: string | null; sessionId?: string | null; decisionId?: string | null }): MeetingTaskItem {
    const cur = input.id ? this.getTaskItem(input.id) : null;
    if (cur) {
      const n = { ...cur, ...input };
      this.db.prepare('UPDATE meeting_task_items SET title=?, instructions=?, employee_id=?, room_id=?, project_id=?, status=?, task_id=?, session_id=?, decision_id=? WHERE id=?')
        .run(n.title, n.instructions ?? '', n.employeeId ?? null, n.roomId ?? null, n.projectId ?? null, n.status ?? 'proposed', n.taskId ?? null, n.sessionId ?? null, n.decisionId ?? cur.decisionId ?? null, cur.id);
      this.touch(cur.meetingId);
      return this.getTaskItem(cur.id)!;
    }
    const id = input.id ?? randomUUID();
    this.db.prepare('INSERT INTO meeting_task_items(id, meeting_id, title, instructions, employee_id, room_id, project_id, status, task_id, session_id, created_at, decision_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.meetingId, input.title, input.instructions ?? '', input.employeeId ?? null, input.roomId ?? null, input.projectId ?? null, input.status ?? 'proposed', input.taskId ?? null, input.sessionId ?? null, Date.now(), input.decisionId ?? null);
    this.touch(input.meetingId);
    return this.getTaskItem(id)!;
  }
  deleteTaskItem(id: string): void { this.db.prepare('DELETE FROM meeting_task_items WHERE id = ?').run(id); }

  // ---------- plano consolidado e tarefas distribuídas ----------
  listPlans(meetingId: string): MeetingPlan[] {
    return (this.db.prepare('SELECT * FROM meeting_plans WHERE meeting_id = ? ORDER BY version').all(meetingId) as Row[]).map(r => ({ ...pj<Omit<MeetingPlan, 'id' | 'meetingId' | 'version' | 'createdAt'>>(r.json, { authorParticipantId: null, authorName: '?', summary: '', decisions: [], pending: [], needs: [], tasks: [] }), id: String(r.id), meetingId: String(r.meeting_id), version: Number(r.version), createdAt: Number(r.created_at) }));
  }
  /** Grava a próxima versão do plano (a unicidade reunião+versão é garantida pelo banco). */
  addPlan(input: Omit<MeetingPlan, 'id' | 'version' | 'createdAt'>): MeetingPlan {
    const version = Number((this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM meeting_plans WHERE meeting_id = ?').get(input.meetingId) as { v: number }).v) + 1;
    const id = randomUUID(); const now = Date.now();
    const { meetingId, ...rest } = input;
    this.db.prepare('INSERT INTO meeting_plans(id, meeting_id, version, author_participant_id, author_name, json, created_at) VALUES (?,?,?,?,?,?,?)').run(id, meetingId, version, input.authorParticipantId, input.authorName, j(rest), now);
    return { ...input, id, version, createdAt: now };
  }
  listPlanTasks(meetingId: string): PlanTaskRecord[] {
    return (this.db.prepare('SELECT * FROM plan_tasks WHERE meeting_id = ? ORDER BY created_at, key').all(meetingId) as Row[]).map(rowToPlanTask);
  }
  getPlanTask(id: string): PlanTaskRecord | null {
    const r = this.db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToPlanTask(r) : null;
  }
  findPlanTaskByTask(taskId: string): PlanTaskRecord | null {
    const r = this.db.prepare('SELECT * FROM plan_tasks WHERE task_id = ?').get(taskId) as Row | undefined;
    return r ? rowToPlanTask(r) : null;
  }
  /**
   * Item do plano com identidade estável (reunião + chave). Já existente e criado na fila: fica como está (nunca duplica).
   * Ainda pendente ou bloqueado: a versão nova do plano atualiza a especificação.
   */
  upsertPlanTask(meetingId: string, version: number, spec: PlanTaskSpec): PlanTaskRecord {
    const id = `${meetingId}:${spec.key}`; const now = Date.now();
    const cur = this.getPlanTask(id);
    if (cur && cur.status === 'created') return cur;
    if (cur) this.db.prepare("UPDATE plan_tasks SET plan_version=?, spec_json=?, status='pending', blocked_reason=NULL, updated_at=? WHERE id=?").run(version, j(spec), now, id);
    else this.db.prepare('INSERT OR IGNORE INTO plan_tasks(id, meeting_id, plan_version, key, spec_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, meetingId, version, spec.key, j(spec), 'pending', now, now);
    return this.getPlanTask(id)!;
  }
  updatePlanTask(id: string, patch: { status?: PlanTaskRecord['status']; taskId?: string | null; sessionId?: string | null; blockedReason?: string | null }): PlanTaskRecord | null {
    const cur = this.getPlanTask(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE plan_tasks SET status=?, task_id=?, session_id=?, blocked_reason=?, updated_at=? WHERE id=?').run(n.status, n.taskId ?? null, n.sessionId ?? null, n.blockedReason ?? null, Date.now(), id);
    return this.getPlanTask(id);
  }

  // ---------- conversões ----------
  private touch(meetingId: string) { this.db.prepare('UPDATE meetings SET updated_at = ? WHERE id = ?').run(Date.now(), meetingId); }

  private rowToMeeting(r: Row): Meeting {
    const id = String(r.id);
    return {
      id, title: String(r.title), agenda: String(r.agenda ?? ''), projectId: str(r.project_id), mode: r.mode as Meeting['mode'], status: r.status as Meeting['status'],
      roundLimit: Number(r.round_limit ?? 2), currentRound: Number(r.current_round ?? 0), contextVersion: Number(r.context_version ?? 1),
      synthesisParticipantId: str(r.synthesis_participant_id), companyContext: Boolean(r.company_context), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
      startedAt: num(r.started_at), endedAt: num(r.ended_at), participants: this.listParticipants(id), minutes: pj<MeetingMinutes | null>(r.minutes_json, null),
      activeTurnId: str(r.active_turn_id), queuedTurns: this.countQueued(id), deletedAt: num(r.deleted_at),
      distribution: pj<MeetingDistribution | null>(r.distribution_json, null),
    };
  }
}

function rowToParticipant(r: Row): MeetingParticipant {
  return {
    id: String(r.id), meetingId: String(r.meeting_id), kind: r.kind as MeetingParticipant['kind'], provider: (r.provider as AiProviderId | null) ?? null, name: String(r.name),
    employeeId: str(r.employee_id), model: str(r.model), effort: (r.effort as EffortLevel | null) ?? null, useGlobal: Boolean(r.use_global),
    state: r.state as MeetingParticipant['state'], stateDetail: str(r.state_detail), threadId: str(r.thread_id), seat: Number(r.seat ?? 0), order: Number(r.order_index ?? 0),
    away: pj<MeetingParticipant['away']>(r.away_json, null),
  };
}
function rowToMessage(r: Row): MeetingMessage {
  return {
    id: String(r.id), meetingId: String(r.meeting_id), turnId: str(r.turn_id), participantId: String(r.participant_id), authorName: String(r.author_name),
    provider: (r.provider as AiProviderId | null) ?? null, kind: r.kind as MeetingMessage['kind'], text: String(r.text), ts: Number(r.ts), round: num(r.round),
    phase: (r.phase as MeetingMessage['phase']) ?? null, targets: pj<string[]>(r.targets_json, []), config: pj<MeetingMessage['config']>(r.config_json, null),
    contextVersion: Number(r.context_version ?? 1), partial: Boolean(r.partial),
  };
}
function rowToTurn(r: Row): MeetingTurn {
  return {
    id: String(r.id), meetingId: String(r.meeting_id), participantId: String(r.participant_id), round: Number(r.round ?? 0), phase: r.phase as MeetingTurn['phase'],
    status: r.status as MeetingTurn['status'], requested: pj<AiProviderPrefs>(r.requested_json, { model: null, effort: null }), applied: pj<MeetingTurn['applied']>(r.applied_json, null),
    contextVersion: Number(r.context_version ?? 1), createdAt: Number(r.created_at), startedAt: num(r.started_at), finishedAt: num(r.finished_at), error: str(r.error),
    messageId: str(r.message_id), promptChars: Number(r.prompt_chars ?? 0), usage: pj<MeetingTurn['usage']>(r.usage_json, null), durationMs: num(r.duration_ms), order: Number(r.order_index ?? 0),
  };
}
function rowToDecision(r: Row): MeetingDecision {
  return {
    id: String(r.id), meetingId: String(r.meeting_id), kind: r.kind as MeetingDecision['kind'], text: String(r.text), participantId: str(r.participant_id),
    confirmed: Boolean(r.confirmed), dismissed: Boolean(r.dismissed), assigneeEmployeeId: str(r.assignee_employee_id), messageId: str(r.message_id),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}
function rowToContextItem(r: Row): MeetingContextItem {
  return { id: String(r.id), kind: r.kind as MeetingContextItem['kind'], label: String(r.label), path: str(r.path), text: str(r.text), enabled: Boolean(r.enabled) };
}
function rowToTaskItem(r: Row): MeetingTaskItem {
  return {
    id: String(r.id), meetingId: String(r.meeting_id), title: String(r.title), instructions: String(r.instructions ?? ''), employeeId: str(r.employee_id), roomId: str(r.room_id),
    projectId: str(r.project_id), status: r.status as MeetingTaskItem['status'], taskId: str(r.task_id), sessionId: str(r.session_id), createdAt: Number(r.created_at), decisionId: str(r.decision_id),
  };
}

function rowToPlanTask(r: Row): PlanTaskRecord {
  return {
    id: String(r.id), meetingId: String(r.meeting_id), planVersion: Number(r.plan_version), key: String(r.key), spec: pj<PlanTaskSpec>(r.spec_json, {} as PlanTaskSpec),
    status: r.status as PlanTaskRecord['status'], taskId: str(r.task_id), sessionId: str(r.session_id), blockedReason: str(r.blocked_reason),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}
