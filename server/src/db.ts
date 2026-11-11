// Persistência simples e confiável: SQLite embutido no Node (node:sqlite), sem dependência nativa externa.
// Esquema versionado por PRAGMA user_version. Antes de migrar um banco existente, um backup consistente é feito com
// VACUUM INTO (funciona com WAL: copia o estado comprometido, sem precisar fechar o banco).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 15;

export interface MigrationInfo { from: number; to: number; backupFile: string | null }

export interface OpenDbOptions {
  /** Pasta dos backups (padrão: <pasta do banco>/backups). Ignorado para ':memory:'. */
  backupsDir?: string;
  /** Chamado quando uma migração aconteceu (para registrar no log). */
  onMigrate?(info: MigrationInfo): void;
}

export function openDb(file: string, opts: OpenDbOptions = {}): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, file, opts);
  return db;
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some(c => c.name === column);
}

/** Backup consistente do banco (VACUUM INTO). Devolve o caminho do arquivo ou null para bancos em memória. */
export function backupDb(db: DatabaseSync, file: string, backupsDir: string | undefined, label: string): string | null {
  if (file === ':memory:' || !file) return null;
  const dir = backupsDir ?? path.join(path.dirname(path.resolve(file)), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `hq-${label}-${stamp}.sqlite`);
  // VACUUM INTO não aceita parâmetro ligado: o caminho vai como literal SQL (aspas simples escapadas, barras normais).
  const literal = target.replace(/\\/g, '/').replace(/'/g, "''");
  db.exec(`VACUUM INTO '${literal}'`);
  return target;
}

function migrate(db: DatabaseSync, file: string, opts: OpenDbOptions) {
  // v1: esquema original (bancos criados antes do versionamento têm user_version 0 e as tabelas já existentes).
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '', profiles_json TEXT NOT NULL DEFAULT '[]',
      color TEXT NOT NULL, order_index INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, room_id TEXT NOT NULL,
      preview_url TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, claude_session_id TEXT, room_id TEXT NOT NULL, project_id TEXT NOT NULL, profile_id TEXT,
      name TEXT NOT NULL, model TEXT, permission_mode TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL,
      controllable INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
      claude_version TEXT, last_error TEXT, worker_name TEXT NOT NULL, appearance_json TEXT NOT NULL, desk_index INTEGER NOT NULL DEFAULT 0,
      activity_json TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, client_id TEXT UNIQUE, session_id TEXT NOT NULL, project_id TEXT NOT NULL, room_id TEXT NOT NULL, profile_id TEXT,
      prompt TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'send',
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      result_text TEXT, result_subtype TEXT, terminal_reason TEXT, errors_json TEXT NOT NULL DEFAULT '[]',
      duration_ms INTEGER, num_turns INTEGER, cost_usd REAL, deliverables_json TEXT NOT NULL DEFAULT '[]', touched_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, created_at);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, task_id TEXT, ts INTEGER NOT NULL,
      kind TEXT NOT NULL, summary TEXT NOT NULL, ok INTEGER, tool_use_id TEXT, data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
    CREATE TABLE IF NOT EXISTS chat_items (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_items(session_id, ts);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  `);
  let v = userVersion(db);
  const countRows = (table: string) => { try { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; } catch { return 0; } };
  // Qualquer dado do Chefe conta (antes, um banco só com reuniões era tratado como vazio e migrava sem backup).
  const hadData = ['sessions', 'employees', 'projects', 'tasks', 'meetings', 'routines'].some(t => countRows(t) > 0);
  if (v === 0) { v = 1; db.exec('PRAGMA user_version = 1'); }
  // Ajuste dentro da v3, feito antes do primeiro uso real (31/10/2026): vínculo do item de tarefa com a decisão de origem.
  if (v >= 3 && !hasColumn(db, 'meeting_task_items', 'decision_id')) db.exec('ALTER TABLE meeting_task_items ADD COLUMN decision_id TEXT');
  if (v >= SCHEMA_VERSION) return;

  const from = v;
  // Backup antes de qualquer alteração de esquema num banco com dados (VACUUM INTO fora de transação).
  const backupFile = hadData ? backupDb(db, file, opts.backupsDir, `v${from}`) : null;

  if (v < 2) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS employees (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', room_id TEXT NOT NULL,
          appearance_json TEXT NOT NULL, desk_index INTEGER NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '',
          profile_id TEXT, model TEXT, permission_mode TEXT NOT NULL DEFAULT 'default', active_session_id TEXT,
          archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, added_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS trash_items (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, origin_path TEXT NOT NULL, root_id TEXT, kind TEXT NOT NULL,
          size INTEGER, count INTEGER, stored_path TEXT NOT NULL, deleted_at INTEGER NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash_items(deleted_at);
      `);
      if (!hasColumn(db, 'sessions', 'employee_id')) db.exec('ALTER TABLE sessions ADD COLUMN employee_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_employee ON sessions(employee_id)');
      // Cada sessão controlável existente vira um funcionário com o mesmo nome/aparência/mesa/sala (migração previsível:
      // nada muda de nome; a sessão passa a ser a conversa ativa do funcionário). Sessões observadas nunca ficam no banco.
      const rows = db.prepare('SELECT s.id, s.room_id, s.worker_name, s.appearance_json, s.desk_index, s.profile_id, s.model, s.permission_mode, s.status, s.created_at, s.last_active_at, r.kind AS room_kind, r.name AS room_name FROM sessions s LEFT JOIN rooms r ON r.id = s.room_id WHERE s.controllable = 1 AND s.employee_id IS NULL ORDER BY s.created_at').all() as Record<string, unknown>[];
      const ins = db.prepare('INSERT INTO employees(id, name, role, room_id, appearance_json, desk_index, instructions, profile_id, model, permission_mode, active_session_id, archived_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const upd = db.prepare('UPDATE sessions SET employee_id = ? WHERE id = ?');
      for (const r of rows) {
        const id = randomUUID();
        const role = ROLE_BY_ROOM_KIND[String(r.room_kind ?? '')] ?? String(r.room_name ?? 'Equipe');
        const archived = r.status === 'archived' ? Number(r.last_active_at) : null;
        ins.run(id, String(r.worker_name), role, String(r.room_id), String(r.appearance_json), Number(r.desk_index), '', (r.profile_id as string | null) ?? null, (r.model as string | null) ?? null, String(r.permission_mode ?? 'default'), String(r.id), archived, Number(r.created_at), Number(r.last_active_at));
        upd.run(id, String(r.id));
      }
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 2;
  }
  if (v < 3) {
    // v3: sala de reunião (Claude + ChatGPT), esforço por funcionário/sessão e tarefas "em espera" criadas pela reunião.
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meetings (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, agenda TEXT NOT NULL DEFAULT '', project_id TEXT, mode TEXT NOT NULL DEFAULT 'guided',
          status TEXT NOT NULL DEFAULT 'draft', round_limit INTEGER NOT NULL DEFAULT 2, current_round INTEGER NOT NULL DEFAULT 0,
          context_version INTEGER NOT NULL DEFAULT 1, synthesis_participant_id TEXT, company_context INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, minutes_json TEXT, active_turn_id TEXT
        );
        CREATE TABLE IF NOT EXISTS meeting_participants (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT, name TEXT NOT NULL, employee_id TEXT,
          model TEXT, effort TEXT, use_global INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'available', state_detail TEXT,
          thread_id TEXT, seat INTEGER NOT NULL DEFAULT 0, order_index INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_mparts_meeting ON meeting_participants(meeting_id, order_index);
        CREATE TABLE IF NOT EXISTS meeting_messages (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, turn_id TEXT, participant_id TEXT NOT NULL, author_name TEXT NOT NULL, provider TEXT,
          kind TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, round INTEGER, phase TEXT, targets_json TEXT NOT NULL DEFAULT '[]',
          config_json TEXT, context_version INTEGER NOT NULL DEFAULT 1, partial INTEGER NOT NULL DEFAULT 0, client_id TEXT UNIQUE
        );
        CREATE INDEX IF NOT EXISTS idx_mmsgs_meeting ON meeting_messages(meeting_id, ts);
        CREATE TABLE IF NOT EXISTS meeting_turns (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, participant_id TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued', requested_json TEXT NOT NULL DEFAULT '{}', applied_json TEXT, context_version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, error TEXT, message_id TEXT, prompt_chars INTEGER NOT NULL DEFAULT 0,
          usage_json TEXT, duration_ms INTEGER, order_index INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_mturns_meeting ON meeting_turns(meeting_id, order_index);
        CREATE TABLE IF NOT EXISTS meeting_decisions (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, participant_id TEXT,
          confirmed INTEGER NOT NULL DEFAULT 0, dismissed INTEGER NOT NULL DEFAULT 0, assignee_employee_id TEXT, message_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mdec_meeting ON meeting_decisions(meeting_id, created_at);
        CREATE TABLE IF NOT EXISTS meeting_context_items (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, path TEXT, text TEXT,
          enabled INTEGER NOT NULL DEFAULT 1, order_index INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_mctx_meeting ON meeting_context_items(meeting_id, order_index);
        CREATE TABLE IF NOT EXISTS meeting_task_items (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', employee_id TEXT, room_id TEXT,
          project_id TEXT, status TEXT NOT NULL DEFAULT 'proposed', task_id TEXT, session_id TEXT, created_at INTEGER NOT NULL, decision_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mtask_meeting ON meeting_task_items(meeting_id, created_at);
      `);
      if (!hasColumn(db, 'tasks', 'held')) db.exec('ALTER TABLE tasks ADD COLUMN held INTEGER NOT NULL DEFAULT 0');
      if (!hasColumn(db, 'tasks', 'meeting_id')) db.exec('ALTER TABLE tasks ADD COLUMN meeting_id TEXT');
      if (!hasColumn(db, 'employees', 'effort')) db.exec('ALTER TABLE employees ADD COLUMN effort TEXT');
      if (!hasColumn(db, 'sessions', 'effort')) db.exec('ALTER TABLE sessions ADD COLUMN effort TEXT');
      if (!hasColumn(db, 'meeting_task_items', 'decision_id')) db.exec('ALTER TABLE meeting_task_items ADD COLUMN decision_id TEXT');
      db.exec('PRAGMA user_version = 3');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 3;
  }
  if (v < 4) {
    // v4 (31/10/2026): a HQ vira a interface diária. Funcionário ganha provedor (claude | openai), skills preferidas e vínculo
    // com agente nativo; conversa guarda provedor e thread do Codex; tarefa registra responsável, skill pedida x confirmada,
    // tentativa, plano, configuração pedida x aplicada e revisão; rotinas agendadas; cache do que o Claude Code listou (skills,
    // comandos, agentes, plugins) por projeto como evidência verificável. Nenhuma coluna existente muda; nada é apagado.
    db.exec('BEGIN');
    try {
      const add = (table: string, column: string, ddl: string) => { if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); };
      add('employees', 'provider', "TEXT NOT NULL DEFAULT 'claude'");
      add('employees', 'skills_json', "TEXT NOT NULL DEFAULT '[]'");
      add('employees', 'agent_json', 'TEXT');
      add('employees', 'template', 'TEXT');
      add('sessions', 'provider', "TEXT NOT NULL DEFAULT 'claude'");
      add('sessions', 'thread_id', 'TEXT');
      add('tasks', 'employee_id', 'TEXT');
      add('tasks', 'provider', "TEXT NOT NULL DEFAULT 'claude'");
      add('tasks', 'skill_json', 'TEXT');
      add('tasks', 'attempt', 'INTEGER NOT NULL DEFAULT 1');
      add('tasks', 'retry_of', 'TEXT');
      add('tasks', 'plan', 'INTEGER NOT NULL DEFAULT 0');
      add('tasks', 'requested_json', 'TEXT');
      add('tasks', 'applied_json', 'TEXT');
      add('tasks', 'review', 'TEXT');
      add('tasks', 'routine_id', 'TEXT');
      add('tasks', 'origin', "TEXT NOT NULL DEFAULT 'chat'");
      add('tasks', 'held_reason', 'TEXT');
      // Tarefas antigas: o responsável é o funcionário da conversa (quando houver).
      db.exec('UPDATE tasks SET employee_id = (SELECT employee_id FROM sessions WHERE sessions.id = tasks.session_id) WHERE employee_id IS NULL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS routines (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, employee_id TEXT NOT NULL, project_id TEXT NOT NULL, skill TEXT,
          schedule_json TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo', enabled INTEGER NOT NULL DEFAULT 1,
          permission_mode TEXT, model TEXT, effort TEXT, missed_policy TEXT NOT NULL DEFAULT 'skip',
          last_run_at INTEGER, last_task_id TEXT, next_run_at INTEGER, last_skip_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_caps (
          project_id TEXT NOT NULL, provider TEXT NOT NULL, caps_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (project_id, provider)
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_employee ON tasks(employee_id, created_at);
      `);
      db.exec('PRAGMA user_version = 4');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 4;
  }
  if (v < 5) {
    // v5 (01/11/2026, Marcos 0 e 1): reunião excluída vai para a lixeira (deleted_at, restaurável por 30 dias); toda exclusão
    // feita pela HQ fica registrada (audit_log, com origem); funcionário ganha política de acesso (access_json: MCP).
    // Nenhuma coluna existente muda; nada é apagado.
    db.exec('BEGIN');
    try {
      const add = (table: string, column: string, ddl: string) => { if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); };
      add('meetings', 'deleted_at', 'INTEGER');
      add('employees', 'access_json', 'TEXT');
      // Marco 1 (mesma versão, para não migrar duas vezes no mesmo dia): evidência do provedor e contexto por tarefa,
      // Ultracode por conversa e o armário de projetos (favorito, cliente, imagem).
      add('tasks', 'evidence_json', 'TEXT');
      add('tasks', 'context_json', "TEXT NOT NULL DEFAULT '[]'");
      add('sessions', 'ultracode', 'INTEGER NOT NULL DEFAULT 0');
      add('projects', 'favorite', 'INTEGER NOT NULL DEFAULT 0');
      add('projects', 'client', 'TEXT');
      add('projects', 'image_path', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL,
          entity_id TEXT, title TEXT, origin TEXT NOT NULL, detail TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
      `);
      db.exec('PRAGMA user_version = 5');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 5;
  }
  if (v < 6) {
    // v6 (02/11/2026, contas sociais): destino de cada tarefa (id do cartão da central de Redes), contas conectadas (só
    // identidade, estado e capacidades; tokens e segredos ficam no cofre do Windows, fora do banco), publicações feitas a
    // pedido do Chefe (idempotentes por client_id) e configuração não secreta. Nada existente muda.
    db.exec('BEGIN');
    try {
      if (!hasColumn(db, 'tasks', 'destination_id')) db.exec('ALTER TABLE tasks ADD COLUMN destination_id TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS social_accounts (
          slot TEXT PRIMARY KEY, network TEXT NOT NULL, remote_id TEXT, username TEXT, display_name TEXT, avatar TEXT, account_kind TEXT,
          profile_ids_json TEXT NOT NULL DEFAULT '[]', scopes_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'not_connected',
          status_detail TEXT, caps_json TEXT, connected_at INTEGER, last_check_at INTEGER, last_check_ok INTEGER, last_error TEXT,
          token_expires_at INTEGER, updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_social_remote ON social_accounts(network, remote_id) WHERE remote_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS social_posts (
          id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, slot TEXT NOT NULL, remote_account_id TEXT, remote_post_id TEXT, url TEXT,
          text TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS social_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      db.exec('PRAGMA user_version = 6');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 6;
  }
  if (v < 7) {
    // v7 (02/11/2026, equipe de conteúdo): objetivo por destino, rodadas (radar, semana, análise), oportunidades do Radar,
    // peças do calendário, aprovações em lote, resultados e análises. Conta informada pelo Chefe (sem API) e fluxo das
    // rotinas da sala de conteúdo. Nada existente muda; tabelas novas começam vazias.
    db.exec('BEGIN');
    try {
      if (!hasColumn(db, 'routines', 'workflow')) db.exec('ALTER TABLE routines ADD COLUMN workflow TEXT');
      if (!hasColumn(db, 'social_accounts', 'declared_json')) db.exec('ALTER TABLE social_accounts ADD COLUMN declared_json TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS content_destinations (
          slot TEXT PRIMARY KEY, objective TEXT NOT NULL, audience TEXT NOT NULL, language TEXT NOT NULL, pillars_json TEXT NOT NULL DEFAULT '[]',
          content TEXT NOT NULL DEFAULT '', indicator TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'proposta', updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_rounds (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, task_id TEXT, routine_id TEXT, employee_id TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL,
          finished_at INTEGER, coverage TEXT, summary TEXT, output_path TEXT NOT NULL, error TEXT, week_start TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_content_rounds_task ON content_rounds(task_id);
        CREATE TABLE IF NOT EXISTS content_radar (
          id TEXT PRIMARY KEY, round_id TEXT NOT NULL, source_url TEXT NOT NULL, source_name TEXT, author TEXT, published_at TEXT, consulted_at TEXT NOT NULL,
          subject TEXT NOT NULL, signals TEXT NOT NULL, evidence TEXT NOT NULL, window TEXT, slot TEXT, interpretation TEXT NOT NULL, proposal TEXT NOT NULL,
          priority INTEGER, reason TEXT, material TEXT, extra_cost TEXT, status TEXT NOT NULL DEFAULT 'nova', item_id TEXT, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_content_radar_round ON content_radar(round_id);
        CREATE TABLE IF NOT EXISTS content_items (
          id TEXT PRIMARY KEY, week_start TEXT, base_id TEXT, base_title TEXT, date TEXT, slot TEXT, profile_id TEXT, format TEXT NOT NULL DEFAULT '',
          objective TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', sources_json TEXT NOT NULL DEFAULT '[]',
          files_json TEXT NOT NULL DEFAULT '[]', material TEXT NOT NULL DEFAULT 'nao_precisa', owner_id TEXT, skill TEXT, review_criteria TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'planejada', task_id TEXT, review_task_id TEXT, radar_id TEXT, folder TEXT, deliverable TEXT,
          checks_json TEXT NOT NULL DEFAULT '[]', review_json TEXT, next_step TEXT, approval_id TEXT, publication_json TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_content_items_task ON content_items(task_id);
        CREATE INDEX IF NOT EXISTS idx_content_items_review ON content_items(review_task_id);
        CREATE TABLE IF NOT EXISTS content_approvals (
          id TEXT PRIMARY KEY, item_ids_json TEXT NOT NULL, slots_json TEXT NOT NULL, date_from TEXT NOT NULL, date_to TEXT NOT NULL, note TEXT,
          created_at INTEGER NOT NULL, revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS content_results (
          id TEXT PRIMARY KEY, item_id TEXT, slot TEXT, post_url TEXT, metric TEXT NOT NULL, value REAL, unit TEXT, period_start TEXT, period_end TEXT,
          age_hours REAL, denominator TEXT, source TEXT NOT NULL, evidence_path TEXT, uncertain INTEGER NOT NULL DEFAULT 0, hypothesis TEXT, note TEXT,
          collected_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_analyses (
          round_id TEXT PRIMARY KEY, week_start TEXT, data_json TEXT NOT NULL, at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_publish_attempts (
          client_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, slot TEXT, status TEXT NOT NULL, detail TEXT, url TEXT, at INTEGER NOT NULL
        );
      `);
      db.exec('PRAGMA user_version = 7');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 7;
  }
  if (v < 8) {
    // v8 (02/11/2026, redes pelo navegador): estado de cada conta no navegador da HQ (perfil persistente próprio, identidade lida
    // na interface, capacidades testadas) e horário das peças para a fila local. Sessões e cookies ficam no perfil, fora do banco.
    db.exec('BEGIN');
    try {
      if (!hasColumn(db, 'content_items', 'time')) db.exec('ALTER TABLE content_items ADD COLUMN time TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_accounts (
          slot TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'navegador', state TEXT NOT NULL DEFAULT 'cadastrada', detail TEXT,
          detected_handle TEXT, detected_name TEXT, detected_at INTEGER, verified_at INTEGER, last_check_at INTEGER, last_error TEXT,
          caps_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
        );
      `);
      db.exec('PRAGMA user_version = 8');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 8;
  }
  if (v < 9) {
    // v9 (02/11/2026, reunião): participante tirado da reunião pela HQ quando o provedor para (limite de uso, modelo recusado),
    // com o motivo, o horário de liberação e se a HQ já está perguntando ao Chefe se ele volta.
    db.exec('BEGIN');
    try {
      if (!hasColumn(db, 'meeting_participants', 'away_json')) db.exec('ALTER TABLE meeting_participants ADD COLUMN away_json TEXT');
      db.exec('PRAGMA user_version = 9');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 9;
  }
  if (v < 10) {
    // v10 (02/11/2026, gerentes e distribuição): plano consolidado por versão, tarefas do plano com identidade estável
    // (reunião + chave, única no banco: clique repetido, reconexão ou troca de gerente nunca duplicam), entregas e bloqueios
    // da mesa do Chefe, e o andamento da distribuição na reunião.
    db.exec('BEGIN');
    try {
      if (!hasColumn(db, 'meetings', 'distribution_json')) db.exec('ALTER TABLE meetings ADD COLUMN distribution_json TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS meeting_plans (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, version INTEGER NOT NULL, author_participant_id TEXT, author_name TEXT NOT NULL,
          json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(meeting_id, version)
        );
        CREATE TABLE IF NOT EXISTS plan_tasks (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, plan_version INTEGER NOT NULL, key TEXT NOT NULL, spec_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', task_id TEXT, session_id TEXT, blocked_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(meeting_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_plan_tasks_task ON plan_tasks(task_id);
        CREATE TABLE IF NOT EXISTS desk_deliveries (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, root_task_id TEXT NOT NULL, version INTEGER NOT NULL, meeting_id TEXT, plan_task_id TEXT,
          employee_id TEXT, title TEXT NOT NULL, slot TEXT, profile_id TEXT, summary TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]',
          links_json TEXT NOT NULL DEFAULT '[]', criteria_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'nova', note TEXT,
          adjust_task_id TEXT UNIQUE, created_at INTEGER NOT NULL, seen_at INTEGER, decided_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS desk_needs (
          id TEXT PRIMARY KEY, meeting_id TEXT, plan_task_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER,
          UNIQUE(meeting_id, text)
        );
      `);
      db.exec('PRAGMA user_version = 10');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 10;
  }
  if (v < 11) {
    // v11 (03/11/2026, entregas de verdade e controle do mural): peça com lixeira (deleted_at, restaurável; status_before guarda
    // o estado para restaurar), arquivo, pedido de origem e histórico das mudanças; pedidos do dia; cartões escondidos do mural
    // e da mesa (tarefa avulsa e entrega de reunião). Nada existente muda nem é apagado.
    db.exec('BEGIN');
    try {
      const add = (table: string, column: string, ddl: string) => { if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); };
      add('content_items', 'deleted_at', 'INTEGER');
      add('content_items', 'archived_at', 'INTEGER');
      add('content_items', 'status_before', 'TEXT');
      add('content_items', 'request_id', 'TEXT');
      add('content_items', 'history_json', "TEXT NOT NULL DEFAULT '[]'");
      db.exec(`
        CREATE TABLE IF NOT EXISTS content_requests (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL, slots_json TEXT NOT NULL DEFAULT '[]', note TEXT, origin TEXT NOT NULL,
          auto_produce INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ativo', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_hidden (
          key TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, title TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_content_items_request ON content_items(request_id);
      `);
      db.exec('PRAGMA user_version = 11');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 11;
  }
  if (v < 12) {
    // v12 (03/11/2026, foco nos Instagrams e Radar da gringa): referência com origem (Chefe, achado, padrão, hipótese), chave
    // normalizada do post (a nova coleta atualiza em vez de duplicar) e os campos novos num JSON; peça pausada pelo foco, com
    // hipótese, referências e decisão; rodada com origem e cobertura por fonte. Só acrescenta colunas.
    db.exec('BEGIN');
    try {
      const add = (table: string, column: string, ddl: string) => { if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); };
      add('content_radar', 'kind', "TEXT NOT NULL DEFAULT 'achado'");
      add('content_radar', 'post_key', 'TEXT');
      add('content_radar', 'data_json', 'TEXT');
      add('content_radar', 'seen', 'INTEGER NOT NULL DEFAULT 1');
      add('content_radar', 'updated_at', 'INTEGER');
      add('content_items', 'paused_reason', 'TEXT');
      add('content_items', 'hypothesis', 'TEXT');
      add('content_items', 'refs_json', "TEXT NOT NULL DEFAULT '[]'");
      add('content_items', 'learning_json', 'TEXT');
      add('content_rounds', 'origin', 'TEXT');
      add('content_rounds', 'sources_json', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_content_radar_post ON content_radar(post_key)');
      db.exec('PRAGMA user_version = 12');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 12;
  }
  if (v < 13) {
    // v13 (07/11/2026, Academia de Vídeo): estudos de vídeo (análise, aula, exercícios e correção num JSON) e a biblioteca de
    // técnicas (uma linha por técnica; o mesmo slug em outro estudo soma a fonte). Só tabelas novas.
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS content_academy_studies (
          id TEXT PRIMARY KEY, radar_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, folder TEXT NOT NULL,
          data_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_academy_studies_radar ON content_academy_studies(radar_id);
        CREATE TABLE IF NOT EXISTS content_academy_techniques (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL,
          data_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `);
      db.exec('PRAGMA user_version = 13');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 13;
  }
  if (v < 14) {
    // v14 (08/11/2026, linha de produção): etapas da peça (pesquisa, roteiro, direção) e o plano da gerente para um pedido em
    // texto livre. Só colunas novas, vazias nas linhas antigas.
    db.exec('BEGIN');
    try {
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
      if (!cols('content_items').includes('pipeline_json')) db.exec('ALTER TABLE content_items ADD COLUMN pipeline_json TEXT');
      if (!cols('content_requests').includes('plan_json')) db.exec('ALTER TABLE content_requests ADD COLUMN plan_json TEXT');
      db.exec('PRAGMA user_version = 14');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 14;
  }
  if (v < 15) {
    // v15 (10/11/2026, conhecimento da equipe): orientações persistidas com escopo, versão e estado; registro de qual versão
    // cada tarefa recebeu; e, na entrega da Mesa, o que a HQ conferiu, a origem e o pedido. Só tabelas e colunas novas.
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_items (
          id TEXT PRIMARY KEY, chain_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT,
          title TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, origin TEXT NOT NULL, origin_note TEXT, evidence_json TEXT,
          supersedes_id TEXT, superseded_by_id TEXT, client_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS knowledge_items_client ON knowledge_items(client_id) WHERE client_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS knowledge_items_scope ON knowledge_items(state, scope_type, scope_id);
        CREATE INDEX IF NOT EXISTS knowledge_items_chain ON knowledge_items(chain_id);
        CREATE TABLE IF NOT EXISTS knowledge_uses (
          knowledge_id TEXT NOT NULL, chain_id TEXT NOT NULL, version INTEGER NOT NULL, task_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
          PRIMARY KEY (knowledge_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS knowledge_uses_task ON knowledge_uses(task_id);
        CREATE INDEX IF NOT EXISTS knowledge_uses_chain ON knowledge_uses(chain_id);
        CREATE TABLE IF NOT EXISTS desk_watch (task_id TEXT PRIMARY KEY, request TEXT NOT NULL, created_at INTEGER NOT NULL);
      `);
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
      const dd = cols('desk_deliveries');
      if (!dd.includes('checks_json')) db.exec('ALTER TABLE desk_deliveries ADD COLUMN checks_json TEXT');
      if (!dd.includes('source')) db.exec('ALTER TABLE desk_deliveries ADD COLUMN source TEXT');
      if (!dd.includes('request')) db.exec('ALTER TABLE desk_deliveries ADD COLUMN request TEXT');
      db.exec('PRAGMA user_version = 15');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    v = 15;
  }
  opts.onMigrate?.({ from, to: v, backupFile });
}

// Cópia local (sem importar names.ts) para a migração não depender de módulos que podem mudar.
const ROLE_BY_ROOM_KIND: Record<string, string> = {
  dev: 'Desenvolvimento', social: 'Social Media', design: 'Design e Vídeo', research: 'Pesquisa e Prospecção', management: 'Gestão e Revisão', direction: 'Diretoria', meeting: 'Reuniões', custom: 'Equipe',
};
