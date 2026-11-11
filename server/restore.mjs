// Restaura um backup do banco do My Company AI (Marco 0). JavaScript puro, roda com a HQ DESLIGADA.
// Uso: node restore.mjs <arquivo-de-backup> [--data PASTA] [--port 4777] [--yes]
// Sem --yes só confere e mostra o que faria. Com --yes:
//   1) recusa se a HQ responde na porta (encerre antes: Ajustes > Conexões > Encerrar HQ);
//   2) confere o backup: integridade do SQLite, versão do esquema e relações entre registros (tarefa → conversa,
//      conversa → projeto/funcionário, falas/participantes/turnos → reunião, mensagens → conversa);
//   3) guarda o banco atual em backups/hq-antes-de-restaurar-<data>.sqlite (nada se perde);
//   4) copia o backup por cima de hq.sqlite (sem os arquivos -wal/-shm do banco antigo) e mostra as contagens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const backup = argv.find(a => !a.startsWith('--') && a !== arg('--data') && a !== arg('--port'));
const dataDir = path.resolve(arg('--data') ?? process.env.MILWEB_HQ_DATA ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'MilWebHQ'));
const port = Number(arg('--port') ?? process.env.MILWEB_HQ_PORT ?? 4777);
const yes = argv.includes('--yes');
const say = (m) => console.log(`[restaurar] ${m}`);

/** Relações que precisam fechar num banco saudável (consultas que devolvem quantos registros estão órfãos). */
export const RELATIONS = [
  ['tarefas sem conversa', 'SELECT COUNT(*) n FROM tasks t WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = t.session_id)'],
  ['conversas sem projeto', 'SELECT COUNT(*) n FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = s.project_id)'],
  ['conversas com funcionário inexistente', 'SELECT COUNT(*) n FROM sessions s WHERE s.employee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = s.employee_id)'],
  ['mensagens sem conversa', 'SELECT COUNT(*) n FROM chat_items c WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = c.session_id)'],
  ['participantes sem reunião', 'SELECT COUNT(*) n FROM meeting_participants x WHERE NOT EXISTS (SELECT 1 FROM meetings m WHERE m.id = x.meeting_id)'],
  ['falas sem reunião', 'SELECT COUNT(*) n FROM meeting_messages x WHERE NOT EXISTS (SELECT 1 FROM meetings m WHERE m.id = x.meeting_id)'],
  ['turnos sem reunião', 'SELECT COUNT(*) n FROM meeting_turns x WHERE NOT EXISTS (SELECT 1 FROM meetings m WHERE m.id = x.meeting_id)'],
  ['turnos com participante inexistente', 'SELECT COUNT(*) n FROM meeting_turns x WHERE NOT EXISTS (SELECT 1 FROM meeting_participants p WHERE p.id = x.participant_id)'],
];
export const COUNTS = ['projects', 'employees', 'sessions', 'tasks', 'chat_items', 'events', 'meetings', 'meeting_participants', 'meeting_messages', 'meeting_turns', 'routines', 'audit_log'];

export function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const counts = {}; for (const t of COUNTS) if (tables.has(t)) counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const orphans = {}; for (const [label, sql] of RELATIONS) { try { const n = db.prepare(sql).get().n; if (n) orphans[label] = n; } catch { /* tabela ausente em versão antiga */ } }
    return { integrity, version, counts, orphans };
  } finally { db.close(); }
}

async function hqRunning() {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal }); clearTimeout(t);
    const j = await r.json().catch(() => null); return Boolean(j && j.app === 'milweb-hq');
  } catch { return false; }
}

async function main() {
  if (!backup) { say('informe o arquivo de backup (pasta backups/ dentro dos dados da HQ).'); return 2; }
  const src = path.resolve(backup);
  const dbFile = path.join(dataDir, 'hq.sqlite');
  if (!fs.existsSync(src)) { say(`backup não encontrado: ${src}`); return 2; }
  if (path.resolve(src) === path.resolve(dbFile)) { say('o backup não pode ser o próprio banco em uso.'); return 2; }
  const info = inspect(src);
  say(`backup: ${src}`);
  say(`integridade: ${info.integrity} · versão do esquema: ${info.version}`);
  say(`contagens: ${Object.entries(info.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (info.integrity !== 'ok') { say('o backup está corrompido; nada foi feito.'); return 1; }
  if (Object.keys(info.orphans).length) { say(`relações quebradas no backup: ${JSON.stringify(info.orphans)}; nada foi feito.`); return 1; }
  say('relações conferidas: nenhuma tarefa, conversa, mensagem ou registro de reunião órfão.');
  if (!yes) { say(`conferência ok. Para restaurar sobre ${dbFile}, rode de novo com --yes (com a HQ desligada).`); return 0; }
  if (await hqRunning()) { say(`a HQ está ligada na porta ${port}. Encerre antes (Ajustes > Conexões > Encerrar HQ).`); return 3; }
  const backupsDir = path.join(dataDir, 'backups'); fs.mkdirSync(backupsDir, { recursive: true });
  if (fs.existsSync(dbFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const keep = path.join(backupsDir, `hq-antes-de-restaurar-${stamp}.sqlite`);
    const cur = new DatabaseSync(dbFile);
    try { cur.exec(`VACUUM INTO '${keep.replace(/\\/g, '/').replace(/'/g, "''")}'`); } finally { cur.close(); }
    say(`banco atual guardado em ${keep}`);
  }
  for (const f of [`${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  fs.copyFileSync(src, dbFile);
  const after = inspect(dbFile);
  say(`restaurado: ${Object.entries(after.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  say('pronto. Abra a HQ de novo pelo start-hq.cmd.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
}
