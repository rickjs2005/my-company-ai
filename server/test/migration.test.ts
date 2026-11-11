// Migração do banco v1 → v2: backup consistente (VACUUM INTO) antes de qualquer alteração, funcionários criados a partir
// das sessões existentes (mesmo nome, aparência, mesa e sala) e todos os dados antigos preservados.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION, type MigrationInfo } from '../src/db.js';
import { Store } from '../src/store.js';

// Esquema v1 tal como os bancos criados antes do versionamento (user_version 0).
const V1_SCHEMA = `
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '', profiles_json TEXT NOT NULL DEFAULT '[]',
    color TEXT NOT NULL, order_index INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, room_id TEXT NOT NULL,
    preview_url TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, claude_session_id TEXT, room_id TEXT NOT NULL, project_id TEXT NOT NULL, profile_id TEXT,
    name TEXT NOT NULL, model TEXT, permission_mode TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL,
    controllable INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
    claude_version TEXT, last_error TEXT, worker_name TEXT NOT NULL, appearance_json TEXT NOT NULL, desk_index INTEGER NOT NULL DEFAULT 0,
    activity_json TEXT
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, client_id TEXT UNIQUE, session_id TEXT NOT NULL, project_id TEXT NOT NULL, room_id TEXT NOT NULL, profile_id TEXT,
    prompt TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'send',
    created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
    result_text TEXT, result_subtype TEXT, terminal_reason TEXT, errors_json TEXT NOT NULL DEFAULT '[]',
    duration_ms INTEGER, num_turns INTEGER, cost_usd REAL, deliverables_json TEXT NOT NULL DEFAULT '[]', touched_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE chat_items (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`;

function seedV1(file: string) {
  const db = new DatabaseSync(file);
  db.exec(V1_SCHEMA);
  db.prepare("INSERT INTO rooms VALUES ('r1','desenvolvimento','Desenvolvimento','dev','','[]','#f0a830',0)").run();
  db.prepare("INSERT INTO rooms VALUES ('r2','social-media','Social Media','social','','[]','#e36a5a',1)").run();
  db.prepare("INSERT INTO projects VALUES ('p1','Projeto','C:/tmp/projeto','r1',NULL,1,2)").run();
  const ins = db.prepare('INSERT INTO sessions (id, claude_session_id, room_id, project_id, profile_id, name, model, permission_mode, status, controllable, created_at, last_active_at, worker_name, appearance_json, desk_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('s-paused', 'claude-1', 'r1', 'p1', null, 'Landing', 'sonnet', 'default', 'paused', 1, 10, 20, 'Léo', '{"skin":1,"hair":2,"shirt":0}', 1);
  ins.run('s-archived', 'claude-2', 'r2', 'p1', null, 'Pautas', null, 'acceptEdits', 'archived', 1, 11, 21, 'Bia', '{"skin":2,"hair":0,"shirt":3}', 0);
  ins.run('s-ext', 'claude-3', 'r1', 'p1', null, 'Terminal', null, 'default', 'observed', 0, 12, 22, 'Chefe (terminal)', '{"skin":0,"hair":1,"shirt":2}', 2);
  db.prepare("INSERT INTO tasks (id, client_id, session_id, project_id, room_id, prompt, status, created_at) VALUES ('t1','c1','s-paused','p1','r1','oi','done',15)").run();
  db.prepare("INSERT INTO chat_items VALUES ('c1','s-paused','t1',15,'user','{\"id\":\"c1\",\"ts\":15,\"taskId\":\"t1\",\"kind\":\"user\",\"text\":\"oi\",\"attachments\":[]}')").run();
  db.prepare("INSERT INTO chat_items VALUES ('c2','s-paused','t1',16,'assistant','{\"id\":\"c2\",\"ts\":16,\"taskId\":\"t1\",\"kind\":\"assistant\",\"text\":\"olá\"}')").run();
  db.close();
}

const userVersion = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
const count = (db: DatabaseSync, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(r => r.name);

test('migração v1 → v2: backup antes de alterar, funcionários nascem das sessões e nada se perde', () => {
  const dir = tempDir('hq-mig-');
  const file = path.join(dir, 'hq.sqlite');
  const backupsDir = path.join(dir, 'backups');
  seedV1(file);
  const infos: MigrationInfo[] = [];
  const db = openDb(file, { backupsDir, onMigrate: i => infos.push(i) });
  try {
    assert.equal(infos.length, 1);
    assert.equal(infos[0].from, 1);
    assert.equal(infos[0].to, SCHEMA_VERSION);
    const backup = infos[0].backupFile;
    assert.ok(backup && backup.startsWith(backupsDir) && path.basename(backup).startsWith('hq-v1-') && backup.endsWith('.sqlite'), `backup em ${backup}`);
    assert.ok(fs.existsSync(backup));

    // O backup é o estado anterior, íntegro e legível por si só (sem WAL pendente).
    const b = new DatabaseSync(backup, { readOnly: true });
    assert.equal(userVersion(b), 1);
    assert.equal(count(b, 'sessions'), 3);
    assert.equal(count(b, 'chat_items'), 2);
    assert.ok(!tables(b).includes('employees'));
    b.close();

    // Banco migrado.
    assert.equal(userVersion(db), SCHEMA_VERSION);
    for (const t of ['employees', 'folders', 'trash_items', 'meetings', 'meeting_participants', 'meeting_messages', 'meeting_turns', 'meeting_decisions', 'meeting_context_items', 'meeting_task_items']) assert.ok(tables(db).includes(t), `tabela ${t}`);
    for (const [t, c] of [['tasks', 'held'], ['tasks', 'meeting_id'], ['employees', 'effort'], ['sessions', 'effort']]) assert.ok((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some(x => x.name === c), `coluna ${t}.${c}`);
    const store = new Store(db);
    const emps = store.listEmployees();
    assert.equal(emps.length, 2, 'uma sessão controlável = um funcionário; a observada não vira funcionário');
    const leo = emps.find(e => e.name === 'Léo')!;
    assert.ok(leo);
    assert.equal(leo.roomId, 'r1');
    assert.equal(leo.role, 'Desenvolvimento');
    assert.equal(leo.deskIndex, 1);
    assert.deepEqual(leo.appearance, { skin: 1, hair: 2, shirt: 0 });
    assert.equal(leo.model, 'sonnet');
    assert.equal(leo.activeSessionId, 's-paused');
    assert.equal(leo.archivedAt, null);
    assert.equal(leo.createdAt, 10);
    const bia = emps.find(e => e.name === 'Bia')!;
    assert.equal(bia.permissionMode, 'acceptEdits');
    assert.equal(bia.archivedAt, 21, 'sessão arquivada vira funcionário arquivado');
    assert.equal(store.listActiveEmployees().length, 1);

    const emp = (id: string) => (db.prepare('SELECT employee_id FROM sessions WHERE id = ?').get(id) as { employee_id: string | null }).employee_id;
    assert.equal(emp('s-paused'), leo.id);
    assert.equal(emp('s-archived'), bia.id);
    assert.equal(emp('s-ext'), null);
    assert.equal(count(db, 'sessions'), 3);
    assert.equal(count(db, 'tasks'), 1);
    assert.equal(store.listChat('s-paused').map(c => c.kind).join(','), 'user,assistant');
  } finally { db.close(); }

  // Reabrir: nada a migrar e nenhum backup novo.
  const infos2: MigrationInfo[] = [];
  const db2 = openDb(file, { backupsDir, onMigrate: i => infos2.push(i) });
  assert.equal(userVersion(db2), SCHEMA_VERSION);
  db2.close();
  assert.equal(infos2.length, 0);
  assert.equal(fs.readdirSync(backupsDir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migração v2 → v3: backup hq-v2, tabelas de reunião, colunas de esforço/espera e dados preservados', () => {
  const dir = tempDir('hq-mig-');
  const file = path.join(dir, 'hq.sqlite');
  const backupsDir = path.join(dir, 'backups');
  seedV1(file);
  // Leva o banco ao estado v2 real (esquema + funcionários) e grava user_version 2 como um serviço v2 teria deixado.
  const v2 = new DatabaseSync(file);
  v2.exec(`CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', room_id TEXT NOT NULL, appearance_json TEXT NOT NULL, desk_index INTEGER NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '', profile_id TEXT, model TEXT, permission_mode TEXT NOT NULL DEFAULT 'default', active_session_id TEXT, archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, added_at INTEGER NOT NULL);
    CREATE TABLE trash_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, origin_path TEXT NOT NULL, root_id TEXT, kind TEXT NOT NULL, size INTEGER, count INTEGER, stored_path TEXT NOT NULL, deleted_at INTEGER NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}');
    ALTER TABLE sessions ADD COLUMN employee_id TEXT;
    INSERT INTO employees VALUES ('e1','Léo','Desenvolvimento','r1','{"skin":1,"hair":2,"shirt":0}',1,'',NULL,'sonnet','default','s-paused',NULL,10,20);
    UPDATE sessions SET employee_id = 'e1' WHERE id = 's-paused';
    PRAGMA user_version = 2;`);
  v2.close();
  const infos: MigrationInfo[] = [];
  const db = openDb(file, { backupsDir, onMigrate: i => infos.push(i) });
  try {
    assert.equal(infos.length, 1); assert.equal(infos[0].from, 2); assert.equal(infos[0].to, SCHEMA_VERSION);
    assert.ok(infos[0].backupFile && path.basename(infos[0].backupFile).startsWith('hq-v2-'));
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.ok(tables(db).includes('meetings'));
    const store = new Store(db);
    const leo = store.getEmployee('e1')!;
    assert.equal(leo.name, 'Léo'); assert.equal(leo.effort, null); assert.equal(leo.model, 'sonnet');
    assert.equal(store.getSession('s-paused')!.effort, null);
    assert.equal(store.getTask('t1')!.held, false); assert.equal(store.getTask('t1')!.meetingId, null);
    assert.equal(store.listEmployees().length, 1, 'a migração v2 não roda de novo (nenhum funcionário duplicado)');
    store.seedDefaultRooms();
    assert.ok(store.listRooms().some(r => r.kind === 'meeting'), 'a sala de Reuniões entra num banco antigo');
    assert.equal(store.listRooms().filter(r => r.kind === 'meeting').length, 1);
    store.updateEmployee('e1', { effort: 'high' });
    assert.equal(store.getEmployee('e1')!.effort, 'high');
    const t = store.createTask({ clientId: 'c-held', sessionId: 's-paused', projectId: 'p1', roomId: 'r1', prompt: 'x', attachments: [], mode: 'queue', held: true, meetingId: 'm1' });
    assert.equal(t.held, true); assert.equal(t.meetingId, 'm1');
    assert.equal(store.updateTask(t.id, { held: false })!.held, false);
  } finally { db.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('instalação nova (banco vazio): vai direto para a versão atual, sem backup', () => {
  const dir = tempDir('hq-mig-');
  const file = path.join(dir, 'hq.sqlite');
  const backupsDir = path.join(dir, 'backups');
  const infos: MigrationInfo[] = [];
  const db = openDb(file, { backupsDir, onMigrate: i => infos.push(i) });
  try {
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.equal(infos.length, 1);
    assert.equal(infos[0].backupFile, null);
    assert.ok(!fs.existsSync(backupsDir) || fs.readdirSync(backupsDir).length === 0);
    const store = new Store(db);
    store.seedDefaultRooms();
    assert.equal(store.listEmployees().length, 0);
    assert.equal(store.listFolders().length, 0);
  } finally { db.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migração → v4: colunas novas com padrões, responsável das tarefas antigas preenchido, rotinas e capacidades gravam e leem', () => {
  const dir = tempDir('hq-mig-');
  const file = path.join(dir, 'hq.sqlite');
  const backupsDir = path.join(dir, 'backups');
  seedV1(file);
  const v2 = new DatabaseSync(file);
  v2.exec(`CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', room_id TEXT NOT NULL, appearance_json TEXT NOT NULL, desk_index INTEGER NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '', profile_id TEXT, model TEXT, permission_mode TEXT NOT NULL DEFAULT 'default', active_session_id TEXT, archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, added_at INTEGER NOT NULL);
    CREATE TABLE trash_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, origin_path TEXT NOT NULL, root_id TEXT, kind TEXT NOT NULL, size INTEGER, count INTEGER, stored_path TEXT NOT NULL, deleted_at INTEGER NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}');
    ALTER TABLE sessions ADD COLUMN employee_id TEXT;
    INSERT INTO employees VALUES ('e1','Léo','Desenvolvimento','r1','{"skin":1,"hair":2,"shirt":0}',1,'',NULL,'sonnet','default','s-paused',NULL,10,20);
    UPDATE sessions SET employee_id = 'e1' WHERE id = 's-paused';
    PRAGMA user_version = 2;`);
  v2.close();
  const infos: MigrationInfo[] = [];
  const db = openDb(file, { backupsDir, onMigrate: i => infos.push(i) });
  try {
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.ok(infos[0].backupFile && fs.existsSync(infos[0].backupFile), 'backup consistente antes de mudar o esquema');
    for (const t of ['routines', 'provider_caps']) assert.ok(tables(db).includes(t), `tabela ${t}`);
    for (const [t, c] of [['employees', 'provider'], ['employees', 'skills_json'], ['employees', 'agent_json'], ['sessions', 'provider'], ['sessions', 'thread_id'], ['tasks', 'employee_id'], ['tasks', 'skill_json'], ['tasks', 'attempt'], ['tasks', 'plan'], ['tasks', 'review'], ['tasks', 'routine_id'], ['tasks', 'held_reason']]) {
      assert.ok((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some(x => x.name === c), `coluna ${t}.${c}`);
    }
    const store = new Store(db);
    const leo = store.getEmployee('e1')!;
    assert.equal(leo.provider, 'claude'); assert.deepEqual(leo.skills, []); assert.equal(leo.agent, null); assert.equal(leo.template, null);
    const t1 = store.getTask('t1')!;
    assert.equal(t1.employeeId, 'e1', 'tarefa antiga ganha o responsável a partir da conversa');
    assert.equal(t1.provider, 'claude'); assert.equal(t1.attempt, 1); assert.equal(t1.plan, false); assert.equal(t1.skill, null); assert.equal(t1.review, null); assert.equal(t1.origin, 'chat');
    assert.equal(store.getSession('s-paused')!.provider, 'claude'); assert.equal(store.getSession('s-paused')!.threadId, null);
    // Ida e volta dos campos novos.
    const gpt = store.createEmployee({ name: 'Gepeto', role: 'Pesquisa', roomId: 'r1', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 2, provider: 'openai', skills: ['prospeccao-internacional'], agent: { name: 'ai-architect', source: 'plugin', path: 'C:/x/agents/ai-architect.md', tools: ['Read', 'Grep'], importedAt: 1, unsupported: [{ field: 'hooks', reason: 'não aplicado' }] }, template: 'research' });
    assert.equal(gpt.provider, 'openai'); assert.deepEqual(gpt.skills, ['prospeccao-internacional']); assert.equal(gpt.agent?.tools?.length, 2); assert.equal(gpt.template, 'research');
    store.updateEmployee(gpt.id, { skills: [], provider: 'claude' });
    assert.equal(store.getEmployee(gpt.id)!.provider, 'claude'); assert.deepEqual(store.getEmployee(gpt.id)!.skills, []);
    const t = store.createTask({ clientId: 'c-v4', sessionId: 's-paused', projectId: 'p1', roomId: 'r1', prompt: '/sistema-web x', attachments: [], mode: 'queue', employeeId: 'e1', provider: 'claude', skill: { requested: 'sistema-web', source: 'personal', provider: 'claude', delivery: 'native', confirmation: 'pending', evidence: null, checkedAt: null }, attempt: 2, retryOf: 't1', plan: true, requested: { model: 'opus', effort: 'high', permissionMode: null }, applied: { model: 'opus', effort: 'high', permissionMode: 'plan', source: 'opções desta tarefa' }, origin: 'composer' });
    assert.equal(t.skill?.requested, 'sistema-web'); assert.equal(t.attempt, 2); assert.equal(t.retryOf, 't1'); assert.equal(t.plan, true); assert.equal(t.applied?.permissionMode, 'plan'); assert.equal(t.origin, 'composer');
    store.updateTask(t.id, { skill: { ...t.skill!, confirmation: 'listed', evidence: 'init', checkedAt: 5 }, review: 'to_verify', held: true, heldReason: 'Modo ausente: x' });
    const t2 = store.getTask(t.id)!;
    assert.equal(t2.skill?.confirmation, 'listed'); assert.equal(t2.review, 'to_verify'); assert.equal(t2.heldReason, 'Modo ausente: x');
    const r = store.createRoutine({ title: 'Pautas', prompt: 'gere pautas', employeeId: 'e1', projectId: 'p1', skill: null, schedule: { kind: 'daily', time: '09:00' }, enabled: true, permissionMode: null, model: null, effort: null, missedPolicy: 'skip', nextRunAt: 123 });
    assert.equal(store.listRoutines().length, 1); assert.equal(r.timezone, 'America/Sao_Paulo'); assert.equal(r.nextRunAt, 123);
    store.updateRoutine(r.id, { enabled: false, lastRunAt: 50, lastSkipReason: 'ocupado' });
    assert.equal(store.getRoutine(r.id)!.enabled, false); assert.equal(store.getRoutine(r.id)!.lastSkipReason, 'ocupado');
    store.deleteRoutine(r.id); assert.equal(store.listRoutines().length, 0);
    store.saveProviderCaps('p1', 'claude', { skills: ['a'], slashCommands: ['a'], agents: [], plugins: [], tools: ['Read'], model: 'm', version: '1' });
    assert.deepEqual(store.getProviderCaps('p1', 'claude')!.caps.skills, ['a']);
    assert.equal(store.listProviderCaps('claude').length, 1);
    const settings = store.getSettings();
    assert.equal(settings.absence.enabled, false); assert.equal(settings.pauseNewTasks, false); assert.ok(settings.roleTemplates.length >= 5); assert.equal(settings.lastSeenAt, null);
  } finally { db.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});
