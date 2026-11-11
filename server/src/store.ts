// Repositórios sobre o SQLite. Converte linhas em objetos do contrato (@milweb-hq/protocol).
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AiProviderId, AuditEntry, ChatItem, Deliverable, EffortLevel, Employee, EmployeeAccess, Folder, LogEntry, Project, Room, Routine, RoutineInput, Session, Settings, SkillUsage, Task } from '@milweb-hq/protocol';
import { checkCompanyName, DEFAULT_ABSENCE, DEFAULT_AI_SETTINGS, DEFAULT_ROLE_TEMPLATES, DEFAULT_SETTINGS } from '@milweb-hq/protocol';
import { initialActivity } from '@milweb-hq/claude-bridge';
import { normalizeAccess } from './access.js';

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(s: unknown, fallback: T): T => { try { return s == null ? fallback : (JSON.parse(String(s)) as T); } catch { return fallback; } };

export const DEFAULT_ROOMS: Omit<Room, 'id'>[] = [
  { slug: 'desenvolvimento', name: 'Desenvolvimento', kind: 'dev', color: '#f0a830', order: 0, profiles: [],
    instructions: 'Sala de Desenvolvimento: sites, landing pages, sistemas, correções e testes. Entregue código funcionando, rode os testes que existirem e diga como abrir o resultado localmente.' },
  { slug: 'social-media', name: 'Social Media', kind: 'social', color: '#e36a5a', order: 1,
    profiles: [
      { id: 'aurora', name: 'Aurora', instructions: 'Perfil editorial de exemplo (marca fictícia Aurora): o trabalho do Chefe, projetos, bastidores e serviços da Aurora (sites, landing pages, sistemas, conteúdo e vídeo). Tom humano, direto, em português do Brasil, sem travessão e sem jargão de IA. Nunca publicar nada: só produzir o conteúdo pedido.' },
      { id: 'tuco-dev', name: 'Tuco Dev', instructions: 'Perfil editorial de exemplo (marca fictícia Tuco Dev): conteúdo educativo sobre programação, IA, automação e tecnologia, em português do Brasil, didático e bem-humorado, para quem está aprendendo. Nunca publicar nada: só produzir o conteúdo pedido.' },
    ],
    instructions: 'Sala de Social Media: pautas, roteiros, legendas, carrosséis e calendários. Salve cada entrega como arquivo Markdown na pasta do projeto, com nome descritivo e data.' },
  { slug: 'design-video', name: 'Design e Vídeo', kind: 'design', color: '#b07ae0', order: 2, profiles: [],
    instructions: 'Sala de Design e Vídeo: briefings, interfaces, materiais visuais e projetos de vídeo (Remotion quando disponível no projeto).' },
  { slug: 'pesquisa-prospeccao', name: 'Pesquisa e Prospecção', kind: 'research', color: '#6fb3e0', order: 3, profiles: [],
    instructions: 'Sala de Pesquisa e Prospecção: pesquisas, análise de empresas, oportunidades e preparação de abordagens. Nunca enviar mensagens a terceiros: só preparar o material.' },
  { slug: 'gestao-revisao', name: 'Gestão e Revisão', kind: 'management', color: '#7cc47f', order: 4, profiles: [],
    instructions: 'Sala de Gestão e Revisão: visão das tarefas, entregas, pendências e verificações. Revise com rigor e aponte exatamente o que foi verificado.' },
  { slug: 'diretoria', name: 'Diretoria', kind: 'direction', color: '#d8b04a', order: 5, profiles: [],
    instructions: 'Diretoria: a sala do Chefe. Funcionários alocados aqui atuam como assistentes diretos da direção: prioridades, decisões, acompanhamento dos projetos e revisão do que as outras salas entregaram.' },
  { slug: 'reunioes', name: 'Reuniões', kind: 'meeting', color: '#5fb8a8', order: 6, profiles: [],
    instructions: 'Sala de Reuniões: o Chefe, o Claude e o ChatGPT discutem a pauta e o Chefe decide. Participantes em modo análise: nenhum arquivo é alterado durante a reunião; o que for decidido vira tarefa na fila dos funcionários.' },
];

export class Store {
  constructor(readonly db: DatabaseSync) {}

  // ---------- settings ----------
  getSettings(): Settings {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get('settings') as Row | undefined;
    const stored = pj<Partial<Settings>>(row?.value_json, {});
    // As preferências de IA (v3) podem faltar ou vir parciais num banco antigo: completa provedor a provedor.
    const ai = { claude: { ...DEFAULT_AI_SETTINGS.claude, ...(stored.ai?.claude ?? {}) }, openai: { ...DEFAULT_AI_SETTINGS.openai, ...(stored.ai?.openai ?? {}) } };
    // v4: política de ausência e modelos de papel também completam campo a campo (banco antigo não tem nada disso).
    const absence = { ...DEFAULT_ABSENCE, ...(stored.absence ?? {}) };
    const roleTemplates = Array.isArray(stored.roleTemplates) && stored.roleTemplates.length ? stored.roleTemplates : DEFAULT_ROLE_TEMPLATES;
    return { ...DEFAULT_SETTINGS, ...stored, ai, absence, roleTemplates };
  }
  saveSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.getSettings(), ...patch };
    this.db.prepare('INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run('settings', j(next));
    return next;
  }
  /**
   * Nome da empresa (primeiro acesso e Ajustes → Empresa). Valida aqui, no servidor, com a mesma regra da interface.
   * É uma chave só dentro da linha única de settings: gravar duas vezes o mesmo nome (clique duplo, reconexão) não
   * cria nada novo. Não toca em perfis, equipes, contas, tarefas nem conversas.
   */
  setCompanyName(raw: unknown): Settings {
    const check = checkCompanyName(raw);
    if (!check.ok) throw new Error(check.error);
    const current = this.getSettings();
    if (current.companyName === check.name) return current;
    return this.saveSettings({ companyName: check.name });
  }

  // ---------- rooms ----------
  seedDefaultRooms(): void {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as Row).n as number;
    if (n === 0) { for (const r of DEFAULT_ROOMS) this.createRoom(r); return; }
    // Banco antigo: a Diretoria (v2) e a sala de Reuniões (v3) entram sem mexer nas salas que já existem.
    const rooms = this.listRooms();
    for (const r of DEFAULT_ROOMS) if ((r.kind === 'direction' || r.kind === 'meeting') && !rooms.some(x => x.kind === r.kind)) this.createRoom(r);
  }
  listRooms(): Room[] {
    return (this.db.prepare('SELECT * FROM rooms ORDER BY order_index, name').all() as Row[]).map(rowToRoom);
  }
  getRoom(id: string): Room | null { const r = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Row | undefined; return r ? rowToRoom(r) : null; }
  createRoom(input: Omit<Room, 'id' | 'order'> & { order?: number }): Room {
    const id = randomUUID();
    const order = input.order ?? ((this.db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS o FROM rooms').get() as Row).o as number);
    this.db.prepare('INSERT INTO rooms(id, slug, name, kind, instructions, profiles_json, color, order_index) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, input.slug, input.name, input.kind, input.instructions ?? '', j(input.profiles ?? []), input.color, order);
    return this.getRoom(id)!;
  }
  updateRoom(id: string, patch: Partial<Omit<Room, 'id'>>): Room | null {
    const cur = this.getRoom(id); if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db.prepare('UPDATE rooms SET slug=?, name=?, kind=?, instructions=?, profiles_json=?, color=?, order_index=? WHERE id=?')
      .run(next.slug, next.name, next.kind, next.instructions, j(next.profiles), next.color, next.order, id);
    return this.getRoom(id);
  }
  deleteRoom(id: string): void { this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id); }

  // ---------- projects ----------
  listProjects(): Project[] { return (this.db.prepare('SELECT * FROM projects ORDER BY last_used_at DESC').all() as Row[]).map(rowToProject); }
  getProject(id: string): Project | null { const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined; return r ? rowToProject(r) : null; }
  findProjectByPath(p: string): Project | null {
    const norm = normalizePath(p);
    return this.listProjects().find(x => normalizePath(x.path) === norm) ?? null;
  }
  createProject(input: { name: string; path: string; roomId: string }): Project {
    const id = randomUUID(); const now = Date.now();
    this.db.prepare('INSERT INTO projects(id, name, path, room_id, preview_url, created_at, last_used_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.name, input.path, input.roomId, null, now, now);
    return this.getProject(id)!;
  }
  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'roomId' | 'previewUrl' | 'lastUsedAt' | 'favorite' | 'client' | 'imagePath'>>): Project | null {
    const cur = this.getProject(id); if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db.prepare('UPDATE projects SET name=?, room_id=?, preview_url=?, last_used_at=?, favorite=?, client=?, image_path=? WHERE id=?').run(next.name, next.roomId, next.previewUrl ?? null, next.lastUsedAt, next.favorite ? 1 : 0, next.client ?? null, next.imagePath ?? null, id);
    return this.getProject(id);
  }
  deleteProject(id: string): void { this.db.prepare('DELETE FROM projects WHERE id = ?').run(id); }

  // ---------- sessions ----------
  listSessions(): Session[] { return (this.db.prepare("SELECT * FROM sessions WHERE status != 'archived' ORDER BY last_active_at DESC").all() as Row[]).map(rowToSession); }
  listAllSessions(): Session[] { return (this.db.prepare('SELECT * FROM sessions ORDER BY last_active_at DESC').all() as Row[]).map(rowToSession); }
  getSession(id: string): Session | null { const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined; return r ? rowToSession(r) : null; }
  getWorkerMeta(id: string): { workerName: string; appearance: { skin: number; hair: number; shirt: number }; deskIndex: number } | null {
    const r = this.db.prepare('SELECT worker_name, appearance_json, desk_index FROM sessions WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    return { workerName: String(r.worker_name), appearance: pj(r.appearance_json, { skin: 0, hair: 0, shirt: 0 }), deskIndex: Number(r.desk_index) };
  }
  /** Nomes de personagem em uso em todo o escritório (um nome por funcionário, independente da sala). */
  listWorkerNames(): string[] {
    return (this.db.prepare("SELECT worker_name FROM sessions WHERE status != 'archived'").all() as Row[]).map(r => String(r.worker_name));
  }
  listWorkerMetaByRoom(roomId: string): { id: string; workerName: string; deskIndex: number }[] {
    return (this.db.prepare("SELECT id, worker_name, desk_index FROM sessions WHERE room_id = ? AND status != 'archived'").all(roomId) as Row[])
      .map(r => ({ id: String(r.id), workerName: String(r.worker_name), deskIndex: Number(r.desk_index) }));
  }
  listSessionsByEmployee(employeeId: string): Session[] {
    return (this.db.prepare('SELECT * FROM sessions WHERE employee_id = ? ORDER BY last_active_at DESC').all(employeeId) as Row[]).map(rowToSession);
  }
  createSession(input: { id?: string; roomId: string; projectId: string; employeeId?: string | null; profileId?: string | null; name: string; model?: string | null; effort?: EffortLevel | null; permissionMode: Session['permissionMode']; controllable?: boolean; status?: Session['status']; workerName: string; appearance: { skin: number; hair: number; shirt: number }; deskIndex: number; claudeSessionId?: string | null; provider?: AiProviderId }): Session {
    const id = input.id ?? randomUUID(); const now = Date.now();
    this.db.prepare(`INSERT INTO sessions(id, claude_session_id, employee_id, room_id, project_id, profile_id, name, model, effort, permission_mode, status, controllable, created_at, last_active_at, worker_name, appearance_json, desk_index, activity_json, provider)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.claudeSessionId ?? null, input.employeeId ?? null, input.roomId, input.projectId, input.profileId ?? null, input.name, input.model ?? null, input.effort ?? null, input.permissionMode, input.status ?? 'new', input.controllable === false ? 0 : 1, now, now, input.workerName, j(input.appearance), input.deskIndex, j(initialActivity()), input.provider ?? 'claude');
    return this.getSession(id)!;
  }
  updateSession(id: string, patch: Partial<Pick<Session, 'claudeSessionId' | 'employeeId' | 'roomId' | 'status' | 'lastActiveAt' | 'claudeVersion' | 'lastError' | 'model' | 'effort' | 'permissionMode' | 'name' | 'profileId' | 'activity' | 'threadId' | 'ultracode'>>): Session | null {
    const cur = this.getSession(id); if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db.prepare('UPDATE sessions SET claude_session_id=?, employee_id=?, room_id=?, status=?, last_active_at=?, claude_version=?, last_error=?, model=?, effort=?, permission_mode=?, name=?, profile_id=?, activity_json=?, thread_id=?, ultracode=? WHERE id=?')
      .run(next.claudeSessionId, next.employeeId ?? null, next.roomId, next.status, next.lastActiveAt, next.claudeVersion ?? null, next.lastError ?? null, next.model ?? null, next.effort ?? null, next.permissionMode, next.name, next.profileId ?? null, j(next.activity), next.threadId ?? null, next.ultracode ? 1 : 0, id);
    return this.getSession(id);
  }

  // ---------- employees (identidade persistente; não é evidência de execução) ----------
  listEmployees(): Employee[] { return (this.db.prepare('SELECT * FROM employees ORDER BY created_at').all() as Row[]).map(rowToEmployee); }
  listActiveEmployees(): Employee[] { return (this.db.prepare('SELECT * FROM employees WHERE archived_at IS NULL ORDER BY created_at').all() as Row[]).map(rowToEmployee); }
  getEmployee(id: string): Employee | null { const r = this.db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as Row | undefined; return r ? rowToEmployee(r) : null; }
  /** Nomes em uso por funcionários não arquivados (um nome por funcionário em todo o escritório). */
  listEmployeeNames(): string[] { return (this.db.prepare('SELECT name FROM employees WHERE archived_at IS NULL').all() as Row[]).map(r => String(r.name)); }
  listEmployeesByRoom(roomId: string): Employee[] { return (this.db.prepare('SELECT * FROM employees WHERE room_id = ? AND archived_at IS NULL ORDER BY created_at').all(roomId) as Row[]).map(rowToEmployee); }
  createEmployee(input: { id?: string; name: string; role: string; roomId: string; appearance: Employee['appearance']; deskIndex: number; instructions?: string; profileId?: string | null; model?: string | null; effort?: EffortLevel | null; permissionMode?: Employee['permissionMode']; provider?: AiProviderId; skills?: string[]; agent?: Employee['agent']; template?: string | null; access?: EmployeeAccess }): Employee {
    const id = input.id ?? randomUUID(); const now = Date.now();
    this.db.prepare('INSERT INTO employees(id, name, role, room_id, appearance_json, desk_index, instructions, profile_id, model, effort, permission_mode, active_session_id, archived_at, created_at, updated_at, provider, skills_json, agent_json, template, access_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.name, input.role, input.roomId, j(input.appearance), input.deskIndex, input.instructions ?? '', input.profileId ?? null, input.model ?? null, input.effort ?? null, input.permissionMode ?? 'default', null, null, now, now, input.provider ?? 'claude', j(input.skills ?? []), input.agent ? j(input.agent) : null, input.template ?? null, j(normalizeAccess(input.access)));
    return this.getEmployee(id)!;
  }
  updateEmployee(id: string, patch: Partial<Pick<Employee, 'name' | 'role' | 'roomId' | 'appearance' | 'deskIndex' | 'instructions' | 'profileId' | 'model' | 'effort' | 'permissionMode' | 'activeSessionId' | 'archivedAt' | 'provider' | 'skills' | 'agent' | 'template' | 'access'>>): Employee | null {
    const cur = this.getEmployee(id); if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db.prepare('UPDATE employees SET name=?, role=?, room_id=?, appearance_json=?, desk_index=?, instructions=?, profile_id=?, model=?, effort=?, permission_mode=?, active_session_id=?, archived_at=?, updated_at=?, provider=?, skills_json=?, agent_json=?, template=?, access_json=? WHERE id=?')
      .run(next.name, next.role, next.roomId, j(next.appearance), next.deskIndex, next.instructions, next.profileId ?? null, next.model ?? null, next.effort ?? null, next.permissionMode, next.activeSessionId ?? null, next.archivedAt ?? null, Date.now(), next.provider ?? 'claude', j(next.skills ?? []), next.agent ? j(next.agent) : null, next.template ?? null, j(normalizeAccess(next.access)), id);
    return this.getEmployee(id);
  }

  // ---------- folders (pastas extras só cadastradas; nada é copiado) ----------
  listFolders(): Folder[] { return (this.db.prepare('SELECT * FROM folders ORDER BY added_at').all() as Row[]).map(rowToFolder); }
  getFolder(id: string): Folder | null { const r = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Row | undefined; return r ? rowToFolder(r) : null; }
  findFolderByPath(p: string): Folder | null { const norm = normalizePath(p); return this.listFolders().find(f => normalizePath(f.path) === norm) ?? null; }
  addFolder(input: { name: string; path: string }): Folder {
    const id = randomUUID();
    this.db.prepare('INSERT INTO folders(id, name, path, added_at) VALUES (?,?,?,?)').run(id, input.name, input.path, Date.now());
    return this.getFolder(id)!;
  }
  removeFolder(id: string): void { this.db.prepare('DELETE FROM folders WHERE id = ?').run(id); }

  // ---------- tasks ----------
  listTasks(limit = 200): Task[] { return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(rowToTask); }
  listTasksBySession(sessionId: string, limit = 200): Task[] { return (this.db.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT ?').all(sessionId, limit) as Row[]).map(rowToTask); }
  listTasksByStatus(statuses: Task['status'][]): Task[] {
    const q = statuses.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM tasks WHERE status IN (${q}) ORDER BY created_at`).all(...statuses) as Row[]).map(rowToTask);
  }
  getTask(id: string): Task | null { const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined; return r ? rowToTask(r) : null; }
  findTaskByClientId(clientId: string): Task | null { const r = this.db.prepare('SELECT * FROM tasks WHERE client_id = ?').get(clientId) as Row | undefined; return r ? rowToTask(r) : null; }
  createTask(input: { clientId: string | null; sessionId: string; projectId: string; roomId: string; profileId?: string | null; prompt: string; attachments: Task['attachments']; mode: string; held?: boolean; heldReason?: string | null; meetingId?: string | null; employeeId?: string | null; provider?: AiProviderId; skill?: SkillUsage | null; attempt?: number; retryOf?: string | null; plan?: boolean; requested?: Task['requested']; applied?: Task['applied']; routineId?: string | null; origin?: Task['origin']; contextFiles?: string[]; destinationId?: string | null }): Task {
    const id = randomUUID(); const now = Date.now();
    this.db.prepare(`INSERT INTO tasks(id, client_id, session_id, project_id, room_id, profile_id, prompt, attachments_json, status, mode, created_at, held, meeting_id, employee_id, provider, skill_json, attempt, retry_of, plan, requested_json, applied_json, routine_id, origin, held_reason, context_json, destination_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.clientId, input.sessionId, input.projectId, input.roomId, input.profileId ?? null, input.prompt, j(input.attachments), 'queued', input.mode, now, input.held ? 1 : 0, input.meetingId ?? null,
        input.employeeId ?? null, input.provider ?? 'claude', input.skill ? j(input.skill) : null, input.attempt ?? 1, input.retryOf ?? null, input.plan ? 1 : 0, input.requested ? j(input.requested) : null, input.applied ? j(input.applied) : null, input.routineId ?? null, input.origin ?? 'chat', input.heldReason ?? null, j(input.contextFiles ?? []), input.destinationId ?? null);
    return this.getTask(id)!;
  }
  updateTask(id: string, patch: Partial<Task>): Task | null {
    const cur = this.getTask(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db.prepare(`UPDATE tasks SET status=?, started_at=?, finished_at=?, result_text=?, result_subtype=?, terminal_reason=?, errors_json=?, duration_ms=?, num_turns=?, cost_usd=?, deliverables_json=?, touched_json=?, held=?, held_reason=?, skill_json=?, applied_json=?, review=?, attempt=?, evidence_json=? WHERE id=?`)
      .run(n.status, n.startedAt ?? null, n.finishedAt ?? null, n.resultText ?? null, n.resultSubtype ?? null, n.terminalReason ?? null, j(n.errors), n.durationMs ?? null, n.numTurns ?? null, n.costUsd ?? null, j(n.deliverables), j(n.touchedFiles), n.held ? 1 : 0, n.heldReason ?? null, n.skill ? j(n.skill) : null, n.applied ? j(n.applied) : null, n.review ?? null, n.attempt ?? 1, n.evidence ? j(n.evidence) : null, id);
    return this.getTask(id);
  }
  /** Tarefas terminadas/alteradas a partir de um instante (resumo "Enquanto você esteve fora"). */
  listTasksSince(since: number, limit = 300): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE created_at >= ? OR finished_at >= ? OR started_at >= ? ORDER BY created_at LIMIT ?').all(since, since, since, limit) as Row[]).map(rowToTask);
  }
  /** Tarefas de um funcionário (todas as conversas). */
  listTasksByEmployee(employeeId: string, limit = 100): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE employee_id = ? ORDER BY created_at DESC LIMIT ?').all(employeeId, limit) as Row[]).map(rowToTask);
  }

  // ---------- rotinas ----------
  listRoutines(): Routine[] { return (this.db.prepare('SELECT * FROM routines ORDER BY created_at').all() as Row[]).map(rowToRoutine); }
  getRoutine(id: string): Routine | null { const r = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Row | undefined; return r ? rowToRoutine(r) : null; }
  createRoutine(input: RoutineInput & { id?: string; nextRunAt?: number | null }): Routine {
    const id = input.id ?? randomUUID(); const now = Date.now();
    this.db.prepare(`INSERT INTO routines(id, title, prompt, employee_id, project_id, skill, schedule_json, timezone, enabled, permission_mode, model, effort, missed_policy, last_run_at, last_task_id, next_run_at, last_skip_reason, created_at, updated_at, workflow)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.title, input.prompt, input.employeeId, input.projectId, input.skill ?? null, j(input.schedule), 'America/Sao_Paulo', input.enabled ? 1 : 0, input.permissionMode ?? null, input.model ?? null, input.effort ?? null, input.missedPolicy ?? 'skip', null, null, input.nextRunAt ?? null, null, now, now, input.workflow ?? null);
    return this.getRoutine(id)!;
  }
  updateRoutine(id: string, patch: Partial<Omit<Routine, 'id' | 'createdAt' | 'updatedAt' | 'timezone'>>): Routine | null {
    const cur = this.getRoutine(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE routines SET title=?, prompt=?, employee_id=?, project_id=?, skill=?, schedule_json=?, enabled=?, permission_mode=?, model=?, effort=?, missed_policy=?, last_run_at=?, last_task_id=?, next_run_at=?, last_skip_reason=?, workflow=?, updated_at=? WHERE id=?')
      .run(n.title, n.prompt, n.employeeId, n.projectId, n.skill ?? null, j(n.schedule), n.enabled ? 1 : 0, n.permissionMode ?? null, n.model ?? null, n.effort ?? null, n.missedPolicy, n.lastRunAt ?? null, n.lastTaskId ?? null, n.nextRunAt ?? null, n.lastSkipReason ?? null, n.workflow ?? null, Date.now(), id);
    return this.getRoutine(id);
  }
  deleteRoutine(id: string): void { this.db.prepare('DELETE FROM routines WHERE id = ?').run(id); }

  // ---------- capacidades observadas do provedor por projeto (evidência: o que o init do Claude Code listou) ----------
  getProviderCaps(projectId: string, provider: AiProviderId): { caps: ProviderCaps; at: number } | null {
    const r = this.db.prepare('SELECT caps_json, at FROM provider_caps WHERE project_id = ? AND provider = ?').get(projectId, provider) as Row | undefined;
    return r ? { caps: pj<ProviderCaps>(r.caps_json, { skills: [], slashCommands: [], agents: [], plugins: [], tools: [], model: null, version: null }), at: Number(r.at) } : null;
  }
  saveProviderCaps(projectId: string, provider: AiProviderId, caps: ProviderCaps): void {
    this.db.prepare('INSERT INTO provider_caps(project_id, provider, caps_json, at) VALUES (?,?,?,?) ON CONFLICT(project_id, provider) DO UPDATE SET caps_json = excluded.caps_json, at = excluded.at').run(projectId, provider, j(caps), Date.now());
  }
  listProviderCaps(provider: AiProviderId): { projectId: string; caps: ProviderCaps; at: number }[] {
    return (this.db.prepare('SELECT project_id, caps_json, at FROM provider_caps WHERE provider = ?').all(provider) as Row[]).map(r => ({ projectId: String(r.project_id), caps: pj<ProviderCaps>(r.caps_json, { skills: [], slashCommands: [], agents: [], plugins: [], tools: [], model: null, version: null }), at: Number(r.at) }));
  }

  // ---------- registro de exclusões e restaurações (Marco 0) ----------
  addAudit(e: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): AuditEntry {
    const at = e.at ?? Date.now();
    const r = this.db.prepare('INSERT INTO audit_log(at, action, entity, entity_id, title, origin, detail) VALUES (?,?,?,?,?,?,?)')
      .run(at, e.action, e.entity, e.entityId ?? null, e.title ?? null, e.origin, e.detail ?? null);
    return { id: Number(r.lastInsertRowid), at, action: e.action, entity: e.entity, entityId: e.entityId ?? null, title: e.title ?? null, origin: e.origin, detail: e.detail ?? null };
  }
  listAudit(limit = 50): AuditEntry[] {
    return (this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(r => ({
      id: Number(r.id), at: Number(r.at), action: String(r.action), entity: String(r.entity), entityId: (r.entity_id as string | null) ?? null,
      title: (r.title as string | null) ?? null, origin: String(r.origin), detail: (r.detail as string | null) ?? null,
    }));
  }

  // ---------- events / chat ----------
  appendEvent(sessionId: string, taskId: string | null, entry: LogEntry): number {
    const r = this.db.prepare('INSERT INTO events(session_id, task_id, ts, kind, summary, ok, tool_use_id, data_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(sessionId, taskId, entry.ts, entry.kind, entry.summary, entry.ok == null ? null : entry.ok ? 1 : 0, entry.toolUseId ?? null, entry.data ? j(entry.data) : null);
    return Number(r.lastInsertRowid);
  }
  listEvents(sessionId: string, limit = 500): { seq: number; taskId: string | null; entry: LogEntry }[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?').all(sessionId, limit) as Row[];
    return rows.reverse().map(r => ({ seq: Number(r.seq), taskId: (r.task_id as string | null) ?? null, entry: { ts: Number(r.ts), kind: r.kind as LogEntry['kind'], summary: String(r.summary), ok: r.ok == null ? undefined : Boolean(r.ok), toolUseId: (r.tool_use_id as string | null) ?? undefined, data: pj<Record<string, unknown> | undefined>(r.data_json, undefined) } }));
  }
  upsertChatItem(sessionId: string, item: ChatItem): void {
    this.db.prepare('INSERT INTO chat_items(id, session_id, task_id, ts, kind, json) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(item.id, sessionId, item.taskId, item.ts, item.kind, j(item));
  }
  getChatItem(id: string): ChatItem | null { const r = this.db.prepare('SELECT json FROM chat_items WHERE id = ?').get(id) as Row | undefined; return r ? pj<ChatItem | null>(r.json, null) : null; }
  listChat(sessionId: string, limit = 400): ChatItem[] {
    const rows = this.db.prepare('SELECT json FROM chat_items WHERE session_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(sessionId, limit) as Row[];
    return rows.reverse().map(r => pj<ChatItem>(r.json, null as unknown as ChatItem)).filter(Boolean);
  }
}

export function normalizePath(p: string): string { return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase(); }

/** O que o processo do provedor declarou no init (Claude Code: system/init). Guardado por projeto como evidência verificável. */
export interface ProviderCaps {
  skills: string[];
  slashCommands: string[];
  agents: string[];
  plugins: { name: string; path?: string }[];
  tools: string[];
  model: string | null;
  version: string | null;
}

function rowToRoutine(r: Row): Routine {
  return {
    id: String(r.id), title: String(r.title), prompt: String(r.prompt), employeeId: String(r.employee_id), projectId: String(r.project_id), skill: (r.skill as string | null) ?? null,
    schedule: pj<Routine['schedule']>(r.schedule_json, { kind: 'daily', time: '09:00' }), timezone: String(r.timezone ?? 'America/Sao_Paulo'), enabled: Boolean(r.enabled),
    permissionMode: (r.permission_mode as string | null) ?? null, model: (r.model as string | null) ?? null, effort: (r.effort as EffortLevel | null) ?? null,
    missedPolicy: (r.missed_policy as Routine['missedPolicy']) ?? 'skip', lastRunAt: (r.last_run_at as number | null) ?? null, lastTaskId: (r.last_task_id as string | null) ?? null,
    nextRunAt: (r.next_run_at as number | null) ?? null, lastSkipReason: (r.last_skip_reason as string | null) ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    workflow: (r.workflow as Routine['workflow']) ?? null,
  };
}

function rowToRoom(r: Row): Room {
  return { id: String(r.id), slug: String(r.slug), name: String(r.name), kind: r.kind as Room['kind'], instructions: String(r.instructions ?? ''), profiles: pj(r.profiles_json, []), color: String(r.color), order: Number(r.order_index) };
}
function rowToProject(r: Row): Project {
  return { id: String(r.id), name: String(r.name), path: String(r.path), roomId: String(r.room_id), previewUrl: (r.preview_url as string | null) ?? null, createdAt: Number(r.created_at), lastUsedAt: Number(r.last_used_at), favorite: Boolean(r.favorite), client: (r.client as string | null) ?? null, imagePath: (r.image_path as string | null) ?? null };
}
function rowToEmployee(r: Row): Employee {
  return {
    id: String(r.id), name: String(r.name), role: String(r.role ?? ''), roomId: String(r.room_id), appearance: pj(r.appearance_json, { skin: 0, hair: 0, shirt: 0 }), deskIndex: Number(r.desk_index ?? 0),
    instructions: String(r.instructions ?? ''), profileId: (r.profile_id as string | null) ?? null, model: (r.model as string | null) ?? null, effort: (r.effort as EffortLevel | null) ?? null, permissionMode: (r.permission_mode as Employee['permissionMode']) ?? 'default',
    activeSessionId: (r.active_session_id as string | null) ?? null, archivedAt: (r.archived_at as number | null) ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    provider: ((r.provider as string | null) === 'openai' ? 'openai' : 'claude'), skills: pj<string[]>(r.skills_json, []), agent: pj<Employee['agent']>(r.agent_json, null), template: (r.template as string | null) ?? null,
    access: normalizeAccess(pj<unknown>(r.access_json, null)),
  };
}
function rowToFolder(r: Row): Folder {
  return { id: String(r.id), name: String(r.name), path: String(r.path), addedAt: Number(r.added_at) };
}
function rowToSession(r: Row): Session {
  return {
    id: String(r.id), claudeSessionId: (r.claude_session_id as string | null) ?? null, employeeId: (r.employee_id as string | null) ?? null, roomId: String(r.room_id), projectId: String(r.project_id), profileId: (r.profile_id as string | null) ?? null,
    name: String(r.name), model: (r.model as string | null) ?? null, effort: (r.effort as EffortLevel | null) ?? null, permissionMode: (r.permission_mode as Session['permissionMode']) ?? 'default', status: r.status as Session['status'],
    controllable: Boolean(r.controllable), processState: null, activity: pj(r.activity_json, initialActivity()), createdAt: Number(r.created_at), lastActiveAt: Number(r.last_active_at),
    claudeVersion: (r.claude_version as string | null) ?? null, lastError: (r.last_error as string | null) ?? null,
    provider: ((r.provider as string | null) === 'openai' ? 'openai' : 'claude'), threadId: (r.thread_id as string | null) ?? null, ultracode: Boolean(r.ultracode),
  };
}
function rowToTask(r: Row): Task {
  return {
    id: String(r.id), sessionId: String(r.session_id), projectId: String(r.project_id), roomId: String(r.room_id), profileId: (r.profile_id as string | null) ?? null,
    prompt: String(r.prompt), attachments: pj(r.attachments_json, []), status: r.status as Task['status'], createdAt: Number(r.created_at),
    startedAt: (r.started_at as number | null) ?? null, finishedAt: (r.finished_at as number | null) ?? null, resultText: (r.result_text as string | null) ?? null,
    resultSubtype: (r.result_subtype as string | null) ?? null, terminalReason: (r.terminal_reason as string | null) ?? null, errors: pj(r.errors_json, []),
    durationMs: (r.duration_ms as number | null) ?? null, numTurns: (r.num_turns as number | null) ?? null, costUsd: (r.cost_usd as number | null) ?? null,
    deliverables: pj<Deliverable[]>(r.deliverables_json, []), touchedFiles: pj(r.touched_json, []),
    held: Boolean(r.held), heldReason: (r.held_reason as string | null) ?? null, meetingId: (r.meeting_id as string | null) ?? null,
    employeeId: (r.employee_id as string | null) ?? null, provider: ((r.provider as string | null) === 'openai' ? 'openai' : 'claude'), skill: pj<SkillUsage | null>(r.skill_json, null),
    attempt: Number(r.attempt ?? 1), retryOf: (r.retry_of as string | null) ?? null, plan: Boolean(r.plan), requested: pj<Task['requested']>(r.requested_json, null), applied: pj<Task['applied']>(r.applied_json, null),
    review: (r.review as Task['review']) ?? null, routineId: (r.routine_id as string | null) ?? null, origin: (r.origin as Task['origin']) ?? 'chat',
    evidence: pj<Task['evidence']>(r.evidence_json, null), contextFiles: pj<string[]>(r.context_json, []), destinationId: (r.destination_id as string | null) ?? null,
  };
}
