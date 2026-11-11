// Marco 0: acessos dos funcionários (MCP e integrações), backups (diário, manual, retenção), identidade do banco e conferência
// de restauração (integridade + relações). A prova com o Claude Code real fica na validação (scratchpad/validate-m0.mjs).
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, SCHEMA_VERSION } from '../src/db.js';
import { Store } from '../src/store.js';
import { DataGuard, parseBackupName, AUTO_BACKUPS_KEPT } from '../src/data.js';
import { claudeAccessArgs, isolatedEnv, normalizeAccess, DENIED_COMMANDS } from '../src/access.js';
// @ts-expect-error módulo JavaScript puro (restore.mjs roda sem tsx)
import { inspect } from '../restore.mjs';

const quiet = { info() {}, warn() {} };

test('acessos: padrão sem MCP; "herdar" é explícito; integrações sempre negadas', () => {
  assert.deepEqual(normalizeAccess(undefined), { mcp: 'none' });
  assert.deepEqual(normalizeAccess({ mcp: 'qualquer' }), { mcp: 'none' });
  const none = claudeAccessArgs({ mcp: 'none' });
  assert.deepEqual(none.slice(0, 3), ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
  const inherit = claudeAccessArgs({ mcp: 'inherit' });
  assert.ok(!inherit.includes('--strict-mcp-config'), 'herdar não restringe MCP');
  for (const args of [none, inherit]) {
    const i = args.indexOf('--disallowedTools');
    assert.ok(i >= 0); for (const rule of ['Bash(gh:*)', 'Bash(git push:*)', 'Bash(vercel:*)']) assert.ok(args[i + 1].split(',').includes(rule), rule);
  }
  assert.ok(DENIED_COMMANDS.length >= 3);
});

test('ambiente do funcionário: sem tokens, gh sem login, git sem credencial nem SSH; o resto do ambiente fica', () => {
  const dir = tempDir('hq-iso-');
  const env = isolatedEnv({ PATH: 'C:/bin', GH_TOKEN: 'segredo', GITHUB_TOKEN: 'x', VERCEL_TOKEN: 'y', HOME: 'C:/u' }, dir);
  assert.equal(env.PATH, 'C:/bin'); assert.equal(env.HOME, 'C:/u');
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'VERCEL_TOKEN']) assert.equal(env[k], undefined, k);
  assert.equal(env.GH_CONFIG_DIR, path.join(dir, 'gh')); assert.ok(fs.existsSync(path.join(dir, 'gh')));
  assert.equal(env.GIT_TERMINAL_PROMPT, '0'); assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper'); assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_SSH_COMMAND, 'false');
});

test('backups: nome → tipo e data; automático 1x/dia só com dados; retenção dos 7 automáticos; manuais ficam', () => {
  assert.equal(parseBackupName('C:/x/hq-auto-2026-11-01T18-12-41-327Z.sqlite')?.kind, 'auto');
  assert.equal(parseBackupName('hq-v3-pre-v4-2026-10-31T21-04-38-200Z.sqlite')?.kind, 'migração');
  assert.equal(parseBackupName('hq-manual-2026-11-01T18-12-41-327Z.sqlite')?.at, Date.parse('2026-11-01T18:12:41.327Z'));
  assert.equal(parseBackupName('outro.sqlite'), null);
  const dir = tempDir('hq-data-');
  const dbFile = path.join(dir, 'hq.sqlite'); const backupsDir = path.join(dir, 'backups');
  const db = openDb(dbFile, { backupsDir });
  try {
    const store = new Store(db); store.seedDefaultRooms();
    const guard = new DataGuard({ db, dbFile, dataDir: dir, backupsDir, store, log: quiet });
    assert.equal(guard.autoBackupIfDue(), null, 'banco sem dados: nada a copiar');
    const room = store.listRooms()[0];
    store.createProject({ name: 'P', path: dir, roomId: room.id });
    const first = guard.autoBackupIfDue();
    assert.ok(first && fs.existsSync(first));
    assert.equal(guard.autoBackupIfDue(), null, 'menos de 24 h desde o último automático');
    // Simula 9 automáticos antigos: a retenção deixa 7.
    for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(backupsDir, `hq-auto-2026-10-${String(10 + i).padStart(2, '0')}T08-00-00-000Z.sqlite`), 'x');
    const manual = guard.backupNow('manual');
    assert.equal(guard.listBackups().filter(b => b.kind === 'auto').length, AUTO_BACKUPS_KEPT);
    assert.ok(fs.existsSync(manual), 'manual não entra na retenção');
    const info = guard.info();
    assert.equal(info.dbFile, dbFile); assert.equal(info.schemaVersion, SCHEMA_VERSION); assert.equal(info.counts.projetos, 1);
    assert.equal(info.lastBackup?.file, manual);
  } finally { db.close(); }
});

test('restauração: conferência aponta integridade e registros órfãos (tarefa sem conversa, fala sem reunião)', () => {
  const dir = tempDir('hq-restore-');
  const dbFile = path.join(dir, 'hq.sqlite');
  const db = openDb(dbFile);
  const store = new Store(db); store.seedDefaultRooms();
  const room = store.listRooms()[0];
  const p = store.createProject({ name: 'P', path: dir, roomId: room.id });
  const s = store.createSession({ roomId: room.id, projectId: p.id, name: 'S', permissionMode: 'default', workerName: 'Léo', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0 });
  store.createTask({ clientId: 'c1', sessionId: s.id, projectId: p.id, roomId: room.id, prompt: 'x', attachments: [], mode: 'queue' });
  db.exec(`VACUUM INTO '${path.join(dir, 'bom.sqlite').replace(/\\/g, '/')}'`);
  const ok = inspect(path.join(dir, 'bom.sqlite'));
  assert.equal(ok.integrity, 'ok'); assert.equal(ok.version, SCHEMA_VERSION); assert.deepEqual(ok.orphans, {}); assert.equal(ok.counts.tasks, 1);
  db.exec(`DELETE FROM sessions; INSERT INTO meeting_messages(id, meeting_id, turn_id, participant_id, author_name, provider, kind, text, round, phase, targets_json, config_json, context_version, partial, client_id, ts) VALUES ('m1','sem-reuniao',NULL,'p','Chefe',NULL,'message','oi',NULL,NULL,'[]',NULL,1,0,NULL,1)`);
  db.exec(`VACUUM INTO '${path.join(dir, 'ruim.sqlite').replace(/\\/g, '/')}'`);
  db.close();
  const bad = inspect(path.join(dir, 'ruim.sqlite'));
  assert.equal(bad.orphans['tarefas sem conversa'], 1);
  assert.equal(bad.orphans['falas sem reunião'], 1);
});
