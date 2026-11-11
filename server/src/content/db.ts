// Acesso às tabelas de conteúdo (v7). Só tradução linha ↔ tipo e consultas simples; regras ficam no serviço.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AcademyStudy, AcademyTechnique, ContentAnalysis, ContentApproval, ContentDestination, ContentHidden, ContentItem, ContentItemHistory, ContentRequest, ContentResult, ContentRound, RadarItem, ResearchSourceState, SocialSlotId,
} from '@milweb-hq/protocol';

/** Quem e por que mudou o estado de uma peça (vai para o histórico dela). */
export interface ItemChangeMeta { action?: string; detail?: string | null; origin?: string }
const HISTORY_MAX = 60;

type Row = Record<string, unknown>;
const pj = <T,>(v: unknown, fb: T): T => { if (typeof v !== 'string' || !v) return fb; try { return JSON.parse(v) as T; } catch { return fb; } };
const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number | null => (v == null ? null : Number(v));

export class ContentDb {
  constructor(private db: DatabaseSync) {}

  // ---------- destinos ----------
  listDestinations(): ContentDestination[] {
    return (this.db.prepare('SELECT * FROM content_destinations').all() as Row[]).map(r => ({
      slot: String(r.slot) as SocialSlotId, objective: String(r.objective), audience: String(r.audience), language: String(r.language),
      pillars: pj<string[]>(r.pillars_json, []), content: String(r.content ?? ''), indicator: String(r.indicator ?? ''),
      state: r.state === 'confirmado' ? 'confirmado' : 'proposta', updatedAt: Number(r.updated_at),
    }));
  }
  upsertDestination(d: Omit<ContentDestination, 'updatedAt'>, onlyIfMissing = false): void {
    const sql = onlyIfMissing
      ? 'INSERT OR IGNORE INTO content_destinations(slot, objective, audience, language, pillars_json, content, indicator, state, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
      : `INSERT INTO content_destinations(slot, objective, audience, language, pillars_json, content, indicator, state, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(slot) DO UPDATE SET objective=excluded.objective, audience=excluded.audience, language=excluded.language, pillars_json=excluded.pillars_json,
         content=excluded.content, indicator=excluded.indicator, state=excluded.state, updated_at=excluded.updated_at`;
    this.db.prepare(sql).run(d.slot, d.objective, d.audience, d.language, JSON.stringify(d.pillars), d.content, d.indicator, d.state, Date.now());
  }

  // ---------- rodadas ----------
  createRound(r: Omit<ContentRound, 'id' | 'finishedAt' | 'coverage' | 'summary' | 'error' | 'origin' | 'sources'> & { id?: string; origin?: ContentRound['origin'] }): ContentRound {
    const id = r.id ?? randomUUID();
    this.db.prepare('INSERT INTO content_rounds(id, kind, task_id, routine_id, employee_id, status, started_at, output_path, week_start, origin) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, r.kind, r.taskId, r.routineId, r.employeeId, r.status, r.startedAt, r.outputPath, r.weekStart, r.origin ?? (r.routineId ? 'rotina' : 'tela'));
    return this.getRound(id)!;
  }
  setRoundSources(id: string, sources: ResearchSourceState[] | null): void { this.db.prepare('UPDATE content_rounds SET sources_json=? WHERE id=?').run(sources ? JSON.stringify(sources) : null, id); }
  roundByOutput(file: string): ContentRound | null { const r = this.db.prepare('SELECT * FROM content_rounds WHERE lower(output_path)=lower(?)').get(file) as Row | undefined; return r ? toRound(r) : null; }
  getRound(id: string): ContentRound | null { const r = this.db.prepare('SELECT * FROM content_rounds WHERE id=?').get(id) as Row | undefined; return r ? toRound(r) : null; }
  roundByTask(taskId: string): ContentRound | null { const r = this.db.prepare('SELECT * FROM content_rounds WHERE task_id=?').get(taskId) as Row | undefined; return r ? toRound(r) : null; }
  listRounds(limit = 30): ContentRound[] { return (this.db.prepare('SELECT * FROM content_rounds ORDER BY started_at DESC LIMIT ?').all(limit) as Row[]).map(toRound); }
  openRounds(): ContentRound[] { return (this.db.prepare("SELECT * FROM content_rounds WHERE status='aguardando'").all() as Row[]).map(toRound); }
  updateRound(id: string, p: Partial<Pick<ContentRound, 'taskId' | 'status' | 'finishedAt' | 'coverage' | 'summary' | 'error'>>): void {
    const cur = this.getRound(id); if (!cur) return;
    const x = { ...cur, ...p };
    this.db.prepare('UPDATE content_rounds SET task_id=?, status=?, finished_at=?, coverage=?, summary=?, error=? WHERE id=?')
      .run(x.taskId, x.status, x.finishedAt, x.coverage, x.summary, x.error, id);
  }

  // ---------- radar ----------
  insertRadar(r: Omit<RadarItem, 'id' | 'createdAt' | 'status' | 'itemId' | 'seen' | 'updatedAt' | keyof RadarExtra | 'kind' | 'postKey'> & Partial<RadarExtra> & { kind?: RadarItem['kind']; postKey?: string | null; status?: RadarItem['status'] }): RadarItem {
    const id = randomUUID(); const now = Date.now();
    this.db.prepare(`INSERT INTO content_radar(id, round_id, source_url, source_name, author, published_at, consulted_at, subject, signals, evidence, window, slot,
      interpretation, proposal, priority, reason, material, extra_cost, status, created_at, kind, post_key, data_json, seen, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
      .run(id, r.roundId, r.sourceUrl, r.sourceName, r.author, r.publishedAt, r.consultedAt, r.subject, r.signals, r.evidence, r.window, r.slot,
        r.interpretation, r.proposal, r.priority, r.reason, r.material, r.extraCost, r.status ?? 'nova', now, r.kind ?? 'achado', r.postKey ?? null, JSON.stringify(extraOf(r)), now);
    return this.getRadar(id)!;
  }
  getRadar(id: string): RadarItem | null { const r = this.db.prepare('SELECT * FROM content_radar WHERE id=?').get(id) as Row | undefined; return r ? toRadar(r) : null; }
  listRadar(limit = 120): RadarItem[] { return (this.db.prepare('SELECT * FROM content_radar ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?').all(limit) as Row[]).map(toRadar); }
  radarUrlSeen(url: string, since: number): boolean { return Boolean(this.db.prepare('SELECT 1 FROM content_radar WHERE source_url=? AND created_at>=? LIMIT 1').get(url, since)); }
  /** Referência já registrada com a mesma chave de post (qualquer data). */
  radarByKey(key: string): RadarItem | null { const r = this.db.prepare('SELECT * FROM content_radar WHERE post_key=? ORDER BY created_at ASC LIMIT 1').get(key) as Row | undefined; return r ? toRadar(r) : null; }
  setRadarStatus(id: string, status: RadarItem['status'], itemId: string | null = null): void { this.db.prepare('UPDATE content_radar SET status=?, item_id=COALESCE(?, item_id), updated_at=? WHERE id=?').run(status, itemId, Date.now(), id); }
  /** Nova coleta da mesma referência: atualiza métricas, datas e leitura; conta a coleta; mantém estado e peça ligada. */
  updateRadar(id: string, p: Partial<Omit<RadarItem, 'id' | 'createdAt' | 'status' | 'itemId' | 'seen' | 'updatedAt'>>, countSeen = true): RadarItem | null {
    const cur = this.getRadar(id); if (!cur) return null;
    const x = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as RadarItem;
    this.db.prepare(`UPDATE content_radar SET round_id=?, source_url=?, source_name=?, author=?, published_at=?, consulted_at=?, subject=?, signals=?, evidence=?, window=?, slot=?,
      interpretation=?, proposal=?, priority=?, reason=?, material=?, extra_cost=?, kind=?, post_key=?, data_json=?, seen=seen+?, updated_at=? WHERE id=?`)
      .run(x.roundId, x.sourceUrl, x.sourceName, x.author, x.publishedAt, x.consultedAt, x.subject, x.signals, x.evidence, x.window, x.slot, x.interpretation, x.proposal,
        x.priority, x.reason, x.material, x.extraCost, x.kind, x.postKey, JSON.stringify(extraOf(x)), countSeen ? 1 : 0, Date.now(), id);
    return this.getRadar(id);
  }

  // ---------- peças ----------
  insertItem(i: Omit<ContentItem, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'archivedAt' | 'requestId' | 'history' | 'pausedReason' | 'hypothesis' | 'referenceIds' | 'learning' | 'pipeline'> & { requestId?: string | null; pausedReason?: string | null; hypothesis?: string | null; referenceIds?: string[]; pipeline?: ContentItem['pipeline'] }, meta?: ItemChangeMeta): ContentItem {
    const id = randomUUID(); const now = Date.now();
    const history: ContentItemHistory[] = [{ at: now, from: null, to: i.status, action: meta?.action ?? 'criada', detail: meta?.detail ?? null, origin: meta?.origin ?? 'sistema' }];
    this.db.prepare(`INSERT INTO content_items(id, week_start, base_id, base_title, date, time, slot, profile_id, format, objective, title, brief, sources_json, files_json, material,
      owner_id, skill, review_criteria, status, task_id, review_task_id, radar_id, folder, deliverable, checks_json, review_json, next_step, approval_id, publication_json,
      created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, i.weekStart, i.baseId, i.baseTitle, i.date, i.time ?? null, i.slot, i.profileId, i.format, i.objective, i.title, i.brief, JSON.stringify(i.sources), JSON.stringify(i.files),
        i.material, i.ownerId, i.skill, i.reviewCriteria, i.status, i.taskId, i.reviewTaskId, i.radarId, i.folder, i.deliverable, JSON.stringify(i.checks),
        i.review ? JSON.stringify(i.review) : null, i.nextStep, i.approvalId, i.publication ? JSON.stringify(i.publication) : null, now, now);
    this.db.prepare('UPDATE content_items SET request_id=?, history_json=?, paused_reason=?, hypothesis=?, refs_json=?, pipeline_json=? WHERE id=?').run(i.requestId ?? null, JSON.stringify(history), i.pausedReason ?? null, i.hypothesis ?? null, JSON.stringify(i.referenceIds ?? []), i.pipeline ? JSON.stringify(i.pipeline) : null, id);
    return this.getItem(id)!;
  }
  /** Peças com trabalho ligado num destino pausado (retentativa que aparecer depois é cancelada, como na lixeira). */
  pausedWithTasks(): ContentItem[] {
    return (this.db.prepare('SELECT * FROM content_items WHERE deleted_at IS NULL AND paused_reason IS NOT NULL AND (task_id IS NOT NULL OR review_task_id IS NOT NULL)').all() as Row[]).map(toItem);
  }
  setPaused(id: string, reason: string | null, meta: ItemChangeMeta): ContentItem | null {
    const cur = this.getItem(id); if (!cur || (cur.pausedReason ?? null) === reason) return cur;
    this.db.prepare('UPDATE content_items SET paused_reason=?, updated_at=? WHERE id=?').run(reason, Date.now(), id);
    this.pushHistory(id, cur.history, { at: Date.now(), from: cur.status, to: cur.status, action: meta.action ?? (reason ? 'pausada' : 'retomada'), detail: meta.detail ?? reason, origin: meta.origin ?? 'foco' });
    return this.getItem(id);
  }
  setItemExtras(id: string, p: { hypothesis?: string | null; referenceIds?: string[]; learning?: ContentItem['learning'] }): void {
    const cur = this.getItem(id); if (!cur) return;
    this.db.prepare('UPDATE content_items SET hypothesis=?, refs_json=?, learning_json=?, updated_at=? WHERE id=?')
      .run(p.hypothesis !== undefined ? p.hypothesis : cur.hypothesis, JSON.stringify(p.referenceIds ?? cur.referenceIds), JSON.stringify(p.learning !== undefined ? p.learning : cur.learning), Date.now(), id);
  }
  getItem(id: string): ContentItem | null { const r = this.db.prepare('SELECT * FROM content_items WHERE id=?').get(id) as Row | undefined; return r ? toItem(r) : null; }
  itemByTask(taskId: string): ContentItem | null { const r = this.db.prepare('SELECT * FROM content_items WHERE task_id=?').get(taskId) as Row | undefined; return r ? toItem(r) : null; }
  itemByReviewTask(taskId: string): ContentItem | null { const r = this.db.prepare('SELECT * FROM content_items WHERE review_task_id=?').get(taskId) as Row | undefined; return r ? toItem(r) : null; }
  /** Peças fora da lixeira (padrão) ou todas (estado enviado à tela, que mostra a lixeira e as arquivadas). */
  listItems(limit = 300, includeDeleted = false): ContentItem[] {
    return (this.db.prepare(`SELECT * FROM content_items${includeDeleted ? '' : ' WHERE deleted_at IS NULL'} ORDER BY COALESCE(date, '9999') ASC, created_at ASC LIMIT ?`).all(limit) as Row[]).map(toItem);
  }
  itemsWithOpenWork(): ContentItem[] {
    return (this.db.prepare("SELECT * FROM content_items WHERE deleted_at IS NULL AND (status='em_producao' OR (status IN ('revisar','ajustar') AND review_task_id IS NOT NULL AND review_json IS NULL))").all() as Row[]).map(toItem);
  }
  /** Peças na lixeira que ainda apontam para tarefas (para cancelar retentativas que surgirem depois). */
  trashedWithTasks(): ContentItem[] {
    return (this.db.prepare('SELECT * FROM content_items WHERE deleted_at IS NOT NULL AND (task_id IS NOT NULL OR review_task_id IS NOT NULL)').all() as Row[]).map(toItem);
  }
  updateItem(id: string, p: Partial<Omit<ContentItem, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'history'>>, meta?: ItemChangeMeta): ContentItem | null {
    const cur = this.getItem(id); if (!cur) return null;
    const x = { ...cur, ...p };
    if ((p.status && p.status !== cur.status) || meta?.action) this.pushHistory(id, cur.history, { at: Date.now(), from: cur.status, to: x.status, action: meta?.action ?? 'estado', detail: meta?.detail ?? (p.status && p.status !== cur.status ? p.nextStep ?? null : null), origin: meta?.origin ?? 'sistema' });
    if (p.requestId !== undefined || p.archivedAt !== undefined) this.db.prepare('UPDATE content_items SET request_id=?, archived_at=? WHERE id=?').run(x.requestId, x.archivedAt, id);
    if (p.pipeline !== undefined) this.db.prepare('UPDATE content_items SET pipeline_json=? WHERE id=?').run(x.pipeline ? JSON.stringify(x.pipeline) : null, id);
    this.db.prepare(`UPDATE content_items SET week_start=?, base_id=?, base_title=?, date=?, time=?, slot=?, profile_id=?, format=?, objective=?, title=?, brief=?, sources_json=?, files_json=?,
      material=?, owner_id=?, skill=?, review_criteria=?, status=?, task_id=?, review_task_id=?, radar_id=?, folder=?, deliverable=?, checks_json=?, review_json=?, next_step=?,
      approval_id=?, publication_json=?, updated_at=? WHERE id=?`)
      .run(x.weekStart, x.baseId, x.baseTitle, x.date, x.time ?? null, x.slot, x.profileId, x.format, x.objective, x.title, x.brief, JSON.stringify(x.sources), JSON.stringify(x.files),
        x.material, x.ownerId, x.skill, x.reviewCriteria, x.status, x.taskId, x.reviewTaskId, x.radarId, x.folder, x.deliverable, JSON.stringify(x.checks),
        x.review ? JSON.stringify(x.review) : null, x.nextStep, x.approvalId, x.publication ? JSON.stringify(x.publication) : null, Date.now(), id);
    return this.getItem(id);
  }

  private pushHistory(id: string, prev: ContentItemHistory[], h: ContentItemHistory): void {
    this.db.prepare('UPDATE content_items SET history_json=? WHERE id=?').run(JSON.stringify([...prev, h].slice(-HISTORY_MAX)), id);
  }
  /** Lixeira: guarda o estado de antes (para restaurar) e grava o histórico. */
  trashItem(id: string, at: number, newStatus: ContentItem['status'], meta: ItemChangeMeta): ContentItem | null {
    const cur = this.getItem(id); if (!cur || cur.deletedAt) return cur;
    this.db.prepare('UPDATE content_items SET deleted_at=?, status_before=?, status=?, updated_at=? WHERE id=?').run(at, cur.status, newStatus, at, id);
    this.pushHistory(id, cur.history, { at, from: cur.status, to: newStatus, action: meta.action ?? 'lixeira', detail: meta.detail ?? null, origin: meta.origin ?? 'interface' });
    return this.getItem(id);
  }
  restoreItem(id: string, at: number, status: ContentItem['status'], nextStep: string | null, meta: ItemChangeMeta): ContentItem | null {
    const cur = this.getItem(id); if (!cur || !cur.deletedAt) return cur;
    this.db.prepare('UPDATE content_items SET deleted_at=NULL, status_before=NULL, status=?, next_step=?, updated_at=? WHERE id=?').run(status, nextStep, at, id);
    this.pushHistory(id, cur.history, { at, from: cur.status, to: status, action: meta.action ?? 'restaurada', detail: meta.detail ?? null, origin: meta.origin ?? 'interface' });
    return this.getItem(id);
  }
  statusBefore(id: string): ContentItem['status'] | null { const r = this.db.prepare('SELECT status_before FROM content_items WHERE id=?').get(id) as { status_before: string | null } | undefined; return (r?.status_before as ContentItem['status'] | null) ?? null; }
  itemsOfRequest(requestId: string): ContentItem[] { return (this.db.prepare('SELECT * FROM content_items WHERE request_id=? AND deleted_at IS NULL ORDER BY created_at ASC').all(requestId) as Row[]).map(toItem); }

  // ---------- pedidos ----------
  insertRequest(r: Omit<ContentRequest, 'id' | 'createdAt' | 'updatedAt' | 'plan'> & { plan?: ContentRequest['plan'] }): ContentRequest {
    const id = randomUUID(); const now = Date.now();
    this.db.prepare('INSERT INTO content_requests(id, title, date, slots_json, note, origin, auto_produce, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, r.title, r.date, JSON.stringify(r.slots), r.note, r.origin, r.autoProduce ? 1 : 0, r.status, now, now);
    if (r.plan) this.db.prepare('UPDATE content_requests SET plan_json=? WHERE id=?').run(JSON.stringify(r.plan), id);
    return this.getRequest(id)!;
  }
  getRequest(id: string): ContentRequest | null { const r = this.db.prepare('SELECT * FROM content_requests WHERE id=?').get(id) as Row | undefined; return r ? toRequest(r) : null; }
  listRequests(limit = 30): ContentRequest[] { return (this.db.prepare('SELECT * FROM content_requests ORDER BY date DESC, created_at DESC LIMIT ?').all(limit) as Row[]).map(toRequest); }
  updateRequest(id: string, p: Partial<Pick<ContentRequest, 'status' | 'note' | 'slots' | 'autoProduce' | 'plan' | 'date' | 'title'>>): ContentRequest | null {
    const cur = this.getRequest(id); if (!cur) return null;
    const x = { ...cur, ...p };
    this.db.prepare('UPDATE content_requests SET status=?, note=?, slots_json=?, auto_produce=?, plan_json=?, date=?, title=?, updated_at=? WHERE id=?').run(x.status, x.note, JSON.stringify(x.slots), x.autoProduce ? 1 : 0, x.plan ? JSON.stringify(x.plan) : null, x.date, x.title, Date.now(), id);
    return this.getRequest(id);
  }

  // ---------- cartões escondidos (tarefa avulsa, entrega de reunião) ----------
  setHidden(h: ContentHidden): void {
    this.db.prepare('INSERT INTO content_hidden(key, kind, state, at, title) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, state=excluded.state, at=excluded.at, title=COALESCE(excluded.title, content_hidden.title)').run(h.key, h.kind, h.state, h.at, h.title);
  }
  clearHidden(key: string): void { this.db.prepare('DELETE FROM content_hidden WHERE key=?').run(key); }
  listHidden(): ContentHidden[] { return (this.db.prepare('SELECT * FROM content_hidden ORDER BY at DESC').all() as Row[]).map(r => ({ key: String(r.key), kind: r.kind === 'delivery' ? 'delivery' : 'task', state: r.state === 'lixeira' ? 'lixeira' : 'arquivada', at: Number(r.at), title: s(r.title) })); }

  // ---------- aprovações ----------
  insertApproval(a: Omit<ContentApproval, 'id' | 'createdAt' | 'revokedAt'>): ContentApproval {
    const id = randomUUID();
    this.db.prepare('INSERT INTO content_approvals(id, item_ids_json, slots_json, date_from, date_to, note, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, JSON.stringify(a.itemIds), JSON.stringify(a.slots), a.from, a.to, a.note, Date.now());
    return this.getApproval(id)!;
  }
  getApproval(id: string): ContentApproval | null { const r = this.db.prepare('SELECT * FROM content_approvals WHERE id=?').get(id) as Row | undefined; return r ? toApproval(r) : null; }
  listApprovals(limit = 30): ContentApproval[] { return (this.db.prepare('SELECT * FROM content_approvals ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(toApproval); }
  revokeApproval(id: string): void { this.db.prepare('UPDATE content_approvals SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(Date.now(), id); }

  // ---------- tentativas de publicação (idempotência) ----------
  attempt(clientId: string): { status: string; url: string | null; detail: string | null } | null {
    return (this.db.prepare('SELECT status, url, detail FROM content_publish_attempts WHERE client_id=?').get(clientId) as { status: string; url: string | null; detail: string | null } | undefined) ?? null;
  }
  saveAttempt(clientId: string, itemId: string, slot: string | null, status: string, detail: string | null, url: string | null): void {
    this.db.prepare(`INSERT INTO content_publish_attempts(client_id, item_id, slot, status, detail, url, at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(client_id) DO UPDATE SET status=excluded.status, detail=excluded.detail, url=excluded.url, at=excluded.at`).run(clientId, itemId, slot, status, detail, url, Date.now());
  }

  // ---------- resultados ----------
  insertResult(r: Omit<ContentResult, 'id' | 'collectedAt'>): ContentResult {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO content_results(id, item_id, slot, post_url, metric, value, unit, period_start, period_end, age_hours, denominator, source, evidence_path,
      uncertain, hypothesis, note, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, r.itemId, r.slot, r.postUrl, r.metric, r.value, r.unit, r.periodStart, r.periodEnd, r.ageHours, r.denominator, r.source, r.evidencePath,
        r.uncertain ? 1 : 0, r.hypothesis, r.note, Date.now());
    return this.getResult(id)!;
  }
  getResult(id: string): ContentResult | null { const r = this.db.prepare('SELECT * FROM content_results WHERE id=?').get(id) as Row | undefined; return r ? toResult(r) : null; }
  listResults(limit = 400): ContentResult[] { return (this.db.prepare('SELECT * FROM content_results ORDER BY collected_at DESC LIMIT ?').all(limit) as Row[]).map(toResult); }
  confirmResult(id: string, value: number | null | undefined): void {
    if (value === undefined) this.db.prepare('UPDATE content_results SET uncertain=0 WHERE id=?').run(id);
    else this.db.prepare('UPDATE content_results SET uncertain=0, value=? WHERE id=?').run(value, id);
  }
  deleteResult(id: string): void { this.db.prepare('DELETE FROM content_results WHERE id=?').run(id); }

  // ---------- análises ----------
  saveAnalysis(a: ContentAnalysis): void {
    this.db.prepare('INSERT OR REPLACE INTO content_analyses(round_id, week_start, data_json, at) VALUES (?,?,?,?)')
      .run(a.roundId, a.weekStart, JSON.stringify({ observed: a.observed, promising: a.promising, adjust: a.adjust, nextTest: a.nextTest, limits: a.limits }), a.at);
  }
  listAnalyses(limit = 8): ContentAnalysis[] {
    return (this.db.prepare('SELECT * FROM content_analyses ORDER BY at DESC LIMIT ?').all(limit) as Row[]).map(r => {
      const d = pj<Omit<ContentAnalysis, 'roundId' | 'weekStart' | 'at'>>(r.data_json, { observed: [], promising: [], adjust: [], nextTest: null, limits: [] });
      return { roundId: String(r.round_id), weekStart: s(r.week_start), at: Number(r.at), ...d };
    });
  }

  // ---------- Academia de Vídeo (v13) ----------
  insertStudy(st: Omit<AcademyStudy, 'id' | 'createdAt' | 'updatedAt'>): AcademyStudy {
    const id = randomUUID(); const now = Date.now();
    const { radarId, title, status, folder, ...data } = st;
    this.db.prepare('INSERT INTO content_academy_studies(id, radar_id, title, status, folder, data_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, radarId, title, status, folder, JSON.stringify(data), now, now);
    return this.getStudy(id)!;
  }
  getStudy(id: string): AcademyStudy | null { const r = this.db.prepare('SELECT * FROM content_academy_studies WHERE id=?').get(id) as Row | undefined; return r ? toStudy(r) : null; }
  studyByRadar(radarId: string): AcademyStudy | null { const r = this.db.prepare('SELECT * FROM content_academy_studies WHERE radar_id=? ORDER BY created_at DESC LIMIT 1').get(radarId) as Row | undefined; return r ? toStudy(r) : null; }
  listStudies(limit = 60): AcademyStudy[] { return (this.db.prepare('SELECT * FROM content_academy_studies ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(toStudy); }
  updateStudy(id: string, p: Partial<Omit<AcademyStudy, 'id' | 'createdAt' | 'updatedAt' | 'radarId'>>): AcademyStudy | null {
    const cur = this.getStudy(id); if (!cur) return null;
    const next = { ...cur, ...p };
    const { id: _id, radarId: _r, title, status, folder, createdAt: _c, updatedAt: _u, ...data } = next;
    this.db.prepare('UPDATE content_academy_studies SET title=?, status=?, folder=?, data_json=?, updated_at=? WHERE id=?').run(title, status, folder, JSON.stringify(data), Date.now(), id);
    return this.getStudy(id);
  }
  getTechnique(slug: string): AcademyTechnique | null { const r = this.db.prepare('SELECT * FROM content_academy_techniques WHERE slug=?').get(slug) as Row | undefined; return r ? toTechnique(r) : null; }
  listTechniques(): AcademyTechnique[] { return (this.db.prepare('SELECT * FROM content_academy_techniques ORDER BY updated_at DESC').all() as Row[]).map(toTechnique); }
  /** Grava a técnica inteira (nova ou atualizada, pelo slug). */
  saveTechnique(t: Omit<AcademyTechnique, 'id' | 'createdAt' | 'updatedAt'>): AcademyTechnique {
    const now = Date.now();
    const { slug, name, category, ...data } = t;
    this.db.prepare(`INSERT INTO content_academy_techniques(id, slug, name, category, data_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(slug) DO UPDATE SET name=excluded.name, category=excluded.category, data_json=excluded.data_json, updated_at=excluded.updated_at`).run(randomUUID(), slug, name, category, JSON.stringify(data), now, now);
    return this.getTechnique(slug)!;
  }
}

function toStudy(r: Row): AcademyStudy {
  const d = pj<Partial<AcademyStudy>>(r.data_json, {});
  return {
    id: String(r.id), radarId: String(r.radar_id), title: String(r.title), status: r.status as AcademyStudy['status'], folder: String(r.folder),
    url: d.url ?? null, request: d.request ?? null, summary: d.summary ?? null, lesson: d.lesson ?? null, analysis: d.analysis ?? null,
    techniques: Array.isArray(d.techniques) ? d.techniques : [], exercises: Array.isArray(d.exercises) ? d.exercises : [], meetingId: d.meetingId ?? null,
    lessonSynthesis: d.lessonSynthesis ?? null, feedback: d.feedback ?? null, history: Array.isArray(d.history) ? d.history : [], error: d.error ?? null,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}
function toTechnique(r: Row): AcademyTechnique {
  const d = pj<Partial<AcademyTechnique>>(r.data_json, {});
  return {
    id: String(r.id), slug: String(r.slug), name: String(r.name), category: r.category as AcademyTechnique['category'], summary: d.summary ?? '',
    how: Array.isArray(d.how) ? d.how : [], sources: Array.isArray(d.sources) ? d.sources : [], examples: Array.isArray(d.examples) ? d.examples : [],
    pitfalls: Array.isArray(d.pitfalls) ? d.pitfalls : [], file: d.file ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

function toRound(r: Row): ContentRound {
  const origin = s(r.origin);
  return {
    id: String(r.id), kind: r.kind as ContentRound['kind'], taskId: s(r.task_id), routineId: s(r.routine_id), employeeId: s(r.employee_id),
    status: r.status as ContentRound['status'], startedAt: Number(r.started_at), finishedAt: n(r.finished_at), coverage: s(r.coverage), summary: s(r.summary),
    outputPath: String(r.output_path), error: s(r.error), weekStart: s(r.week_start),
    origin: origin === 'rotina' || origin === 'tela' || origin === 'sessao' || origin === 'referencia' ? origin : (r.routine_id ? 'rotina' : null),
    sources: pj<ResearchSourceState[] | null>(r.sources_json, null),
  };
}

/** Campos do Radar da gringa guardados em data_json (v12). */
type RadarExtra = Pick<RadarItem, 'platform' | 'language' | 'region' | 'metrics' | 'inspected' | 'observed' | 'summaryPt' | 'context' | 'popularityLimit' | 'examples' | 'format' | 'fit' | 'opening' | 'effort' | 'audio' | 'files' | 'note' | 'video'>;
const EXTRA_KEYS: (keyof RadarExtra)[] = ['platform', 'language', 'region', 'metrics', 'inspected', 'observed', 'summaryPt', 'context', 'popularityLimit', 'examples', 'format', 'fit', 'opening', 'effort', 'audio', 'files', 'note', 'video'];
function extraOf(r: Partial<RadarExtra>): Partial<RadarExtra> {
  const o: Record<string, unknown> = {};
  for (const k of EXTRA_KEYS) if (r[k] !== undefined && r[k] !== null) o[k] = r[k];
  return o as Partial<RadarExtra>;
}
function toRadar(r: Row): RadarItem {
  const x = pj<Partial<RadarExtra>>(r.data_json, {});
  const kind = s(r.kind);
  return {
    id: String(r.id), roundId: String(r.round_id), sourceUrl: String(r.source_url), sourceName: s(r.source_name), author: s(r.author), publishedAt: s(r.published_at),
    consultedAt: String(r.consulted_at), subject: String(r.subject), signals: String(r.signals), evidence: r.evidence as RadarItem['evidence'], window: (s(r.window) as RadarItem['window']),
    slot: (s(r.slot) as SocialSlotId | null), interpretation: String(r.interpretation), proposal: String(r.proposal), priority: n(r.priority), reason: s(r.reason),
    material: s(r.material), extraCost: s(r.extra_cost), status: r.status as RadarItem['status'], itemId: s(r.item_id), createdAt: Number(r.created_at),
    kind: kind === 'chefe' || kind === 'padrao' || kind === 'hipotese' ? kind : 'achado', postKey: s(r.post_key),
    platform: x.platform ?? null, language: x.language ?? null, region: x.region ?? null, metrics: Array.isArray(x.metrics) ? x.metrics : [], inspected: x.inspected ?? null,
    observed: x.observed ?? null, summaryPt: x.summaryPt ?? null, context: x.context ?? null, popularityLimit: x.popularityLimit ?? null, examples: Array.isArray(x.examples) ? x.examples : [],
    format: x.format ?? null, fit: x.fit ?? null, opening: x.opening ?? null, effort: x.effort ?? null, audio: x.audio ?? null, files: Array.isArray(x.files) ? x.files : [], note: x.note ?? null, video: x.video ?? null,
    seen: Number(r.seen ?? 1), updatedAt: Number(r.updated_at ?? r.created_at),
  };
}
function toItem(r: Row): ContentItem {
  return {
    id: String(r.id), weekStart: s(r.week_start), baseId: s(r.base_id), baseTitle: s(r.base_title), date: s(r.date), time: s(r.time), slot: s(r.slot) as SocialSlotId | null,
    profileId: s(r.profile_id), format: String(r.format ?? ''), objective: String(r.objective ?? ''), title: String(r.title), brief: String(r.brief ?? ''),
    sources: pj<string[]>(r.sources_json, []), files: pj<string[]>(r.files_json, []), material: r.material as ContentItem['material'], ownerId: s(r.owner_id),
    skill: s(r.skill), reviewCriteria: String(r.review_criteria ?? ''), status: r.status as ContentItem['status'], taskId: s(r.task_id), reviewTaskId: s(r.review_task_id),
    radarId: s(r.radar_id), folder: s(r.folder), deliverable: s(r.deliverable), checks: pj(r.checks_json, []), review: pj(r.review_json, null), nextStep: s(r.next_step),
    approvalId: s(r.approval_id), publication: pj(r.publication_json, null), deletedAt: n(r.deleted_at), archivedAt: n(r.archived_at), requestId: s(r.request_id),
    history: pj<ContentItemHistory[]>(r.history_json, []), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    pausedReason: s(r.paused_reason), hypothesis: s(r.hypothesis), referenceIds: pj<string[]>(r.refs_json, []), learning: pj<ContentItem['learning']>(r.learning_json, null),
    pipeline: pj<ContentItem['pipeline']>(r.pipeline_json, null),
  };
}
function toRequest(r: Row): ContentRequest {
  return {
    id: String(r.id), title: String(r.title), date: String(r.date), slots: pj<SocialSlotId[]>(r.slots_json, []), note: s(r.note), origin: String(r.origin),
    autoProduce: Boolean(r.auto_produce), status: r.status === 'concluido' ? 'concluido' : r.status === 'arquivado' ? 'arquivado' : 'ativo', createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    plan: pj<ContentRequest['plan']>(r.plan_json, null),
  };
}
function toApproval(r: Row): ContentApproval {
  return { id: String(r.id), itemIds: pj(r.item_ids_json, []), slots: pj(r.slots_json, []), from: String(r.date_from), to: String(r.date_to), note: s(r.note), createdAt: Number(r.created_at), revokedAt: n(r.revoked_at) };
}
function toResult(r: Row): ContentResult {
  return {
    id: String(r.id), itemId: s(r.item_id), slot: s(r.slot) as SocialSlotId | null, postUrl: s(r.post_url), metric: String(r.metric), value: n(r.value), unit: s(r.unit),
    periodStart: s(r.period_start), periodEnd: s(r.period_end), ageHours: n(r.age_hours), denominator: s(r.denominator), source: r.source as ContentResult['source'],
    evidencePath: s(r.evidence_path), uncertain: Boolean(r.uncertain), hypothesis: s(r.hypothesis), note: s(r.note), collectedAt: Number(r.collected_at),
  };
}
