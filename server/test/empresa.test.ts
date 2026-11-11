// Nome da empresa: validação única (interface e servidor), gravação no SQLite que sobrevive a reabrir o banco,
// repetição sem duplicar, e o nome chegando ao contexto dos agentes sem renomear perfis, equipes nem tarefas antigas.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCompanyName, companyDisplayName, companyForAgents, COMPANY_NAME_MAX, configuredCompanyName, documentTitle, PRODUCT_NAME } from '@milweb-hq/protocol';
import type { Meeting, MeetingParticipant, ServerMessage } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import { buildContextPackage, buildSystemPrompt } from '../src/meetings/prompts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.resolve(here, '..', '..', 'packages', 'claude-bridge', 'test', 'fake-claude.mjs');

test('validação: tira espaços, aceita acentos e outros alfabetos, recusa vazio, controle e nome longo', () => {
  assert.deepEqual(checkCompanyName('  Aurora   Social  '), { ok: true, name: 'Aurora Social' });
  assert.deepEqual(checkCompanyName('Estúdio Açaí & Cia.'), { ok: true, name: 'Estúdio Açaí & Cia.' });
  assert.deepEqual(checkCompanyName('株式会社さくら'), { ok: true, name: '株式会社さくら' });
  assert.deepEqual(checkCompanyName('Студия Заря'), { ok: true, name: 'Студия Заря' });
  assert.deepEqual(checkCompanyName('Linha\nDupla'), { ok: true, name: 'Linha Dupla' });
  for (const bad of ['', '   ', '\t\n', null, undefined, 42, {}]) assert.equal(checkCompanyName(bad).ok, false, `deveria recusar ${JSON.stringify(bad)}`);
  assert.equal(checkCompanyName('Nome\u0000oculto').ok, false);
  assert.equal(checkCompanyName('Nome‮invertido').ok, false);
  assert.equal(checkCompanyName('a'.repeat(COMPANY_NAME_MAX)).ok, true);
  assert.equal(checkCompanyName('a'.repeat(COMPANY_NAME_MAX + 1)).ok, false);
  // O limite conta caracteres, não unidades UTF-16 (emoji vale 1).
  assert.equal(checkCompanyName('😀'.repeat(COMPANY_NAME_MAX)).ok, true);
  // Marcação não é interpretada: o nome fica como texto (a interface o renderiza como texto).
  assert.deepEqual(checkCompanyName('<b>Aurora</b>'), { ok: true, name: '<b>Aurora</b>' });
});

test('nome do produto é fixo e separado do nome da empresa', () => {
  assert.equal(PRODUCT_NAME, 'My Company AI');
  assert.equal(configuredCompanyName({ companyName: null }), null);
  assert.equal(configuredCompanyName({}), null);
  assert.equal(companyDisplayName({ companyName: null }), 'My Company AI');
  assert.equal(companyDisplayName({ companyName: 'Aurora Social' }), 'Aurora Social');
  assert.equal(documentTitle({ companyName: null }), 'My Company AI');
  assert.equal(documentTitle({ companyName: 'Aurora Social' }), 'Aurora Social · My Company AI');
  assert.match(companyForAgents({ companyName: 'Aurora Social' }), /^Aurora Social \(empresa de social media que opera no aplicativo My Company AI\)$/);
  assert.match(companyForAgents({ companyName: null }), /^uma empresa de social media/);
});

test('instalação nova começa sem nome; o nome gravado sobrevive a fechar e reabrir o banco', () => {
  const file = path.join(tempDir('hq-empresa-'), 'hq.db');
  let db = openDb(file);
  let store = new Store(db);
  assert.equal(store.getSettings().companyName, null);
  assert.equal(store.setCompanyName('  Estúdio Açaí  ').companyName, 'Estúdio Açaí');
  db.close();
  db = openDb(file);
  store = new Store(db);
  assert.equal(store.getSettings().companyName, 'Estúdio Açaí');
  db.close();
});

test('servidor recusa nome inválido e não grava nada', () => {
  const store = new Store(openDb(':memory:'));
  assert.throws(() => store.setCompanyName('   '), /Informe o nome da empresa/);
  assert.throws(() => store.setCompanyName('x'.repeat(COMPANY_NAME_MAX + 1)), /até 60 caracteres/);
  assert.throws(() => store.setCompanyName(undefined), /Informe o nome da empresa/);
  assert.equal(store.getSettings().companyName, null);
});

test('repetir o mesmo nome (clique duplo, reconexão) não duplica: continua uma linha só de configuração', () => {
  const db = openDb(':memory:');
  const store = new Store(db);
  store.setCompanyName('Aurora Social');
  store.setCompanyName('Aurora Social');
  store.setCompanyName(' Aurora  Social ');
  const rows = db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
  assert.equal(rows.n, 1);
  assert.equal(store.getSettings().companyName, 'Aurora Social');
});

test('renomear a empresa preserva configurações, salas, perfis, funcionários e projetos', () => {
  const store = new Store(openDb(':memory:'));
  store.seedDefaultRooms();
  store.saveSettings({ maxParallel: 3, onboardingDone: true });
  const room = store.listRooms()[0];
  const dir = tempDir('hq-empresa-proj-');
  const project = store.createProject({ name: 'Projeto do cliente', path: dir, roomId: room.id });
  const roomsBefore = JSON.stringify(store.listRooms());
  store.setCompanyName('Primeira');
  store.setCompanyName('Segunda Ltda.');
  const s = store.getSettings();
  assert.equal(s.companyName, 'Segunda Ltda.');
  assert.equal(s.maxParallel, 3);
  assert.equal(s.onboardingDone, true);
  assert.equal(JSON.stringify(store.listRooms()), roomsBefore, 'salas e perfis editoriais não mudam com o nome da empresa');
  assert.equal(store.listProjects().find(p => p.id === project.id)?.name, 'Projeto do cliente');
});

test('instalação antiga (configurações gravadas sem companyName) continua sem nome e com os dados intactos', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO settings(key, value_json) VALUES (?, ?)').run('settings', JSON.stringify({ maxParallel: 2, onboardingDone: true }));
  const store = new Store(db);
  const s = store.getSettings();
  assert.equal(s.companyName, null);
  assert.equal(s.maxParallel, 2);
  assert.equal(s.onboardingDone, true);
});

test('tarefa: o contexto do agente leva o nome da empresa em vigor (e o novo nome depois de renomear)', async () => {
  const store = new Store(openDb(':memory:'));
  store.seedDefaultRooms();
  const projDir = tempDir('hq-empresa-task-');
  const attachmentsDir = tempDir('hq-empresa-att-');
  const room = store.listRooms()[0];
  const project = store.createProject({ name: 'Projeto teste', path: projDir, roomId: room.id });
  const manager = new SessionManager({ store, exePath: () => process.execPath, attachmentsDir, commandPrefixArgs: [fake] });
  const msgs: ServerMessage[] = [];
  manager.on('broadcast', m => msgs.push(m));
  const doneTask = (id: string, ms = 8000) => new Promise<{ resultText?: string | null }>((resolve, reject) => {
    const hit = (m: ServerMessage) => m.kind === 'entity' && m.entity === 'task' && (m.item as { id?: string; status?: string }).id === id && (m.item as { status?: string }).status === 'done';
    const found = msgs.find(hit); if (found) return resolve((found as { item: { resultText?: string | null } }).item);
    const t = setTimeout(() => reject(new Error('timeout esperando a tarefa')), ms);
    const h = (m: ServerMessage) => { if (hit(m)) { clearTimeout(t); manager.off('broadcast', h); resolve((m as unknown as { item: { resultText?: string | null } }).item); } };
    manager.on('broadcast', h);
  });
  try {
    store.setCompanyName('Estúdio Açaí');
    const a = manager.createSession({ roomId: room.id, projectId: project.id, name: 'Sessão A' });
    const t1 = await manager.sendPrompt({ sessionId: a.id, clientId: 'empresa-1', text: 'ARGS', mode: 'send' });
    const r1 = await doneTask(t1.id);
    assert.match(String(r1.resultText), /trabalha para Estúdio Açaí \(empresa de social media que opera no aplicativo My Company AI\)/);
    assert.doesNotMatch(String(r1.resultText), /MilWeb HQ/);

    // Renomear vale para os próximos trabalhos (processo novo); a tarefa já feita fica como foi gravada.
    store.setCompanyName('Nova Aurora');
    const b = manager.createSession({ roomId: room.id, projectId: project.id, name: 'Sessão B' });
    const t2 = await manager.sendPrompt({ sessionId: b.id, clientId: 'empresa-2', text: 'ARGS', mode: 'send' });
    const r2 = await doneTask(t2.id);
    assert.match(String(r2.resultText), /trabalha para Nova Aurora \(/);
    assert.match(String(store.getTask(t1.id)?.resultText), /Estúdio Açaí/, 'a entrega antiga não é reescrita');
  } finally {
    await manager.shutdown();
    fs.rmSync(projDir, { recursive: true, force: true }); fs.rmSync(attachmentsDir, { recursive: true, force: true });
  }
});

test('reunião: o prompt cita a empresa pelo nome escolhido; sem nome, fala de forma genérica', () => {
  const me = { id: 'p1', name: 'Claude', kind: 'ai', provider: 'claude', employeeId: null } as unknown as MeetingParticipant;
  const meeting = { id: 'm1', title: 'Pauta', agenda: 'Decidir a pauta', mode: 'guided', contextVersion: 1, participants: [me] } as unknown as Meeting;
  const named = buildSystemPrompt(meeting, me, null, null, 'Estúdio Açaí');
  assert.match(named, /reunião de Estúdio Açaí \(empresa de social media/);
  const unnamed = buildSystemPrompt(meeting, me, null, null);
  assert.match(unnamed, /reunião de uma empresa de social media que opera no aplicativo My Company AI/);
  assert.doesNotMatch(named + unnamed, /MilWeb HQ/);
  const pkg = buildContextPackage({ meeting, project: null, messages: [], decisions: [], context: [], fileContents: new Map(), company: { name: 'Estúdio Açaí', rooms: [], projects: [], employees: [] } });
  assert.match(pkg, /## Contexto da empresa \(Estúdio Açaí\)/);
});
