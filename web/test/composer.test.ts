// Helpers puros do compositor "O que vamos fazer?": rascunho tolerante, o que falta, sugestão rotulada, disponibilidade
// de skill por provedor, ordenação com favoritas e resumo de opções em vigor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiProviderStatus, Employee, Project, Room, Settings, SkillInfo, Worker } from '@milweb-hq/protocol';
import { DEFAULT_SETTINGS } from '@milweb-hq/protocol';
import { applyProjectLock, emptyDraft, missingItems, optionsSummary, parseDraft, serializeDraft, skillAvailability, skillOptionsFor, suggestEmployee, taskConfigLines } from '../src/shell/composerHelpers';

const emp = (e: Partial<Employee> & Pick<Employee, 'id' | 'name'>): Employee => ({ access: { mcp: 'none' },
  role: 'Dev', roomId: 'r-dev', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0, instructions: '', profileId: null, model: null, effort: null, permissionMode: 'default',
  activeSessionId: null, archivedAt: null, createdAt: 1, updatedAt: 1, provider: 'claude', skills: [], agent: null, template: null, ...e,
});
const wk = (id: string, busy: boolean): Worker => ({ id, kind: 'employee', employeeId: id, sessionId: null, roomId: 'r-dev', projectId: null, name: id, role: 'Dev', appearance: { skin: 0, hair: 0, shirt: 0 }, deskIndex: 0, phase: 'idle', detail: '', status: busy ? 'working' : 'idle', controllable: true, busy } as unknown as Worker);
const rooms: Room[] = [{ id: 'r-dev', slug: 'dev', name: 'Desenvolvimento', kind: 'dev', instructions: '', profiles: [], color: '#fff', order: 0 } as unknown as Room, { id: 'r-social', slug: 'social', name: 'Social', kind: 'social', instructions: '', profiles: [], color: '#fff', order: 1 } as unknown as Room];
const projects: Project[] = [{ id: 'p1', name: 'Site', path: 'C:\\x', roomId: 'r-dev', previewUrl: null, createdAt: 1 } as unknown as Project];
const skill = (s: Partial<SkillInfo> & Pick<SkillInfo, 'id' | 'invocation'>): SkillInfo => ({
  name: s.invocation, description: 'desc', whenToUse: null, argumentHint: null, arguments: [], source: 'personal', path: null, plugin: null, projectId: null, disabled: false, override: 'on',
  modelInvocable: true, userInvocable: true, allowedTools: [], model: null, effort: null, forks: false, hasShellInjection: false, shadowedBy: null,
  providers: { claude: { mode: 'native', detail: 'invocação /nome' }, openai: { mode: 'inject', detail: 'texto' } } as SkillInfo['providers'],
  verified: null, problems: [], kind: 'skill', ...s,
});

test('parseDraft: lixo, campos ausentes e clientId preservado', () => {
  const d0 = parseDraft(null, () => 'id-1');
  assert.deepEqual(d0, emptyDraft('id-1'));
  const d1 = parseDraft('{nope', () => 'id-2');
  assert.equal(d1.clientId, 'id-2');
  const d2 = parseDraft(JSON.stringify({ text: 'oi', projectId: 'p1', employeeId: '', skill: 'sistema-web', options: { effort: 'turbo', model: 'fable' }, clientId: 'keep' }), () => 'novo');
  assert.equal(d2.text, 'oi'); assert.equal(d2.projectId, 'p1'); assert.equal(d2.employeeId, null); assert.equal(d2.skill, 'sistema-web');
  assert.equal(d2.options.effort, null, 'esforço inválido cai para null'); assert.equal(d2.options.model, 'fable'); assert.equal(d2.clientId, 'keep');
  assert.deepEqual(parseDraft(serializeDraft(d2), () => 'x'), d2, 'ida e volta estável');
});

test('missingItems: ordem fixa e detecção de escolhas que deixaram de existir', () => {
  const employees = [emp({ id: 'e1', name: 'Léo' }), emp({ id: 'e2', name: 'Bia', archivedAt: 5 })];
  assert.deepEqual(missingItems({ text: '  ', projectId: null, employeeId: null }, employees, projects), ['o pedido (escreva o que vamos fazer)', 'o projeto', 'o funcionário']);
  assert.deepEqual(missingItems({ text: 'x', projectId: 'p-sumiu', employeeId: 'e2' }, employees, projects), ['um projeto válido (o escolhido não existe mais)', 'um funcionário ativo (o escolhido foi arquivado ou não existe mais)']);
  assert.deepEqual(missingItems({ text: 'x', projectId: 'p1', employeeId: 'e1' }, employees, projects), []);
});

test('suggestEmployee: skill preferida > sala do projeto (livre primeiro) > quem está livre; sempre com motivo', () => {
  const employees = [emp({ id: 'e1', name: 'Léo', roomId: 'r-dev' }), emp({ id: 'e2', name: 'Bia', roomId: 'r-social', skills: ['social'] }), emp({ id: 'e3', name: 'Caio', roomId: 'r-dev' })];
  const workers = [wk('e1', true), wk('e2', false), wk('e3', false)];
  const bySkill = suggestEmployee({ employees, workers, project: projects[0], rooms, skill: '/social' });
  assert.equal(bySkill?.id, 'e2'); assert.match(bySkill!.reason, /skills preferidas/);
  const byRoom = suggestEmployee({ employees, workers, project: projects[0], rooms, skill: null });
  assert.equal(byRoom?.id, 'e3', 'na sala do projeto e livre ganha do ocupado'); assert.match(byRoom!.reason, /Desenvolvimento/);
  const free = suggestEmployee({ employees, workers, project: null, rooms, skill: null });
  assert.equal(free?.id, 'e2'); assert.match(free!.reason, /livre/);
  assert.equal(suggestEmployee({ employees: [emp({ id: 'a', name: 'A', archivedAt: 1 })], workers: [], project: null, rooms, skill: null }), null);
  const only = suggestEmployee({ employees: [emp({ id: 'e1', name: 'Léo' })], workers: [wk('e1', true)], project: null, rooms, skill: null });
  assert.equal(only?.id, 'e1'); assert.match(only!.reason, /fila/);
});

test('skillAvailability: desativada, sombreada e sem suporte no provedor são recusadas com motivo', () => {
  const s = skill({ id: 's', invocation: 'sistema-web' });
  assert.deepEqual(skillAvailability(s, 'claude'), { ok: true, reason: null });
  assert.equal(skillAvailability({ ...s, disabled: true }, 'claude').ok, false);
  assert.match(skillAvailability({ ...s, shadowedBy: 'personal: x' }, 'claude').reason!, /prioridade/);
  const noOpenai = { ...s, providers: { ...s.providers, openai: { mode: 'unavailable', detail: 'skills API ausente no Codex 0.58.0' } } } as SkillInfo;
  assert.equal(skillAvailability(noOpenai, 'openai').reason, 'skills API ausente no Codex 0.58.0');
  assert.equal(skillAvailability(noOpenai, 'claude').ok, true);
});

test('skillOptionsFor: esconde sombreadas e de outro projeto, filtra por texto, favoritas (por id) primeiro', () => {
  const list = [
    skill({ id: 'b', invocation: 'b-skill', description: 'faz vídeo' }),
    skill({ id: 'a', invocation: 'a-skill' }),
    skill({ id: 'sh', invocation: 'a-skill', shadowedBy: 'personal' }),
    skill({ id: 'other', invocation: 'proj-only', projectId: 'p2' }),
    skill({ id: 'mine', invocation: 'proj-mine', projectId: 'p1' }),
  ];
  assert.deepEqual(skillOptionsFor(list, '', 'p1').map(s => s.id), ['a', 'b', 'mine']);
  assert.deepEqual(skillOptionsFor(list, '', 'p1', ['b']).map(s => s.id), ['b', 'a', 'mine']);
  assert.deepEqual(skillOptionsFor(list, 'vídeo', 'p1').map(s => s.id), ['b']);
  assert.deepEqual(skillOptionsFor(list, '', null).map(s => s.id), ['a', 'b']);
});

test('optionsSummary: precedência tarefa > funcionário > padrão global > provedor, com a origem de cada valor', () => {
  const settings: Settings = { ...DEFAULT_SETTINGS, ai: { claude: { model: 'opus', effort: 'high' }, openai: { model: null, effort: null } } } as Settings;
  const status = { provider: 'claude', models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'], defaultEffort: 'high' }, { id: 'fable', label: 'Fable', efforts: ['max'], defaultEffort: null }] } as unknown as AiProviderStatus;
  const e = emp({ id: 'e1', name: 'Léo', model: 'fable', permissionMode: 'acceptEdits' });
  assert.equal(optionsSummary({ options: { model: null, effort: null, permissionMode: null, ultracode: false }, employee: e, settings, status }), 'modelo Fable (funcionário) · esforço Alto (padrão global) · modo acceptEdits (funcionário)');
  assert.equal(optionsSummary({ options: { model: 'opus', effort: 'low', permissionMode: 'plan', ultracode: false }, employee: e, settings, status }), 'modelo Opus (tarefa) · esforço Baixo (tarefa) · modo plan (tarefa)');
  assert.match(optionsSummary({ options: { model: null, effort: null, permissionMode: null, ultracode: false }, employee: null, settings: DEFAULT_SETTINGS, status: null }), /^modelo padrão do provedor \(provedor\) · esforço padrão \(provedor\) · modo default \(padrão global\)$/);
});

test('Marco 1: rascunho guarda contexto e Ultracode; configuração só é "confirmada" com evidência do provedor', () => {
  const d = parseDraft(JSON.stringify({ text: 'x', contextFiles: ['index.html', '', 3, 'css/styles.css'], options: { ultracode: true, effort: 'high' } }), () => 'id');
  assert.deepEqual(d.contextFiles, ['index.html', 'css/styles.css']);
  assert.equal(d.options.ultracode, true); assert.equal(d.options.effort, 'high');
  assert.equal(parseDraft(JSON.stringify({ options: { ultracode: 'sim' } }), () => 'id').options.ultracode, false);
  // Sem evidência (processo ainda não iniciou): nada confirmado.
  const queued = taskConfigLines({ status: 'queued', provider: 'claude', applied: { model: 'opus', effort: 'high', permissionMode: 'default', source: 'tarefa', ultracode: true }, requested: { model: 'opus', effort: 'high', permissionMode: null, ultracode: true }, evidence: null });
  assert.ok(queued.every(l => l.state !== 'confirmado'));
  assert.equal(queued.find(l => l.item === 'Ultracode')?.state, 'aguardando o início');
  // Com o init: modelo, permissões e MCP confirmados; esforço e Ultracode continuam "enviado, não confirmado".
  const ev = { source: 'init do Claude Code' as const, model: 'claude-opus-5-5', permissionMode: 'default', mcpServers: [], cliVersion: '2.1.316', at: 1, sentEffort: 'high', sentUltracode: true };
  const running = taskConfigLines({ status: 'running', provider: 'claude', applied: { model: 'opus', effort: 'high', permissionMode: 'default', source: 'tarefa', ultracode: true }, requested: null, evidence: ev });
  const by = (k: string) => running.find(l => l.item === k)!;
  assert.equal(by('Modelo').state, 'confirmado'); assert.equal(by('Modelo').value, 'claude-opus-5-5');
  assert.equal(by('Permissões').state, 'confirmado');
  assert.equal(by('Esforço').state, 'enviado, não confirmado'); assert.equal(by('Esforço').value, 'Alto');
  assert.equal(by('Ultracode').state, 'enviado, não confirmado');
  assert.equal(by('Servidores MCP').value, 'nenhum'); assert.equal(by('Servidores MCP').state, 'confirmado');
});

test('suggestEmployee: sem projeto, quem trabalha na sala atual (Social Media) vem antes de outro livre', () => {
  const employees = [emp({ id: 'lia', name: 'Lia', roomId: 'r-dev' }), emp({ id: 'bia', name: 'Bia', roomId: 'r-social' })];
  const workers = [wk('lia', false), wk('bia', false)];
  const s = suggestEmployee({ employees, workers, project: null, rooms, skill: null, roomId: 'r-social' });
  assert.equal(s?.id, 'bia'); assert.match(s!.reason, /nesta sala/);
  // o projeto escolhido continua mandando mais que a sala atual
  assert.equal(suggestEmployee({ employees, workers, project: projects[0], rooms, skill: null, roomId: 'r-social' })?.id, 'lia');
});

test('sala travada (05/11): entra com a pasta da sala, devolve o projeto anterior ao sair e sobrevive ao F5', () => {
  const projects = [{ id: 'hq' }, { id: 'conteudo' }];
  const d0 = { ...emptyDraft('id'), projectId: 'hq', contextFiles: ['a.md'] };
  const p1 = applyProjectLock(d0, 'conteudo', projects)!;
  assert.deepEqual(p1, { projectId: 'conteudo', contextFiles: [], projectBeforeLock: 'hq' });
  const d1 = { ...d0, ...p1 };
  assert.equal(applyProjectLock(d1, 'conteudo', projects), null, 'já travado: nada muda');
  const reloaded = parseDraft(serializeDraft(d1), () => 'x');
  assert.equal(reloaded.projectBeforeLock, 'hq', 'o projeto anterior fica guardado no rascunho');
  const p2 = applyProjectLock(reloaded, null, projects)!;
  assert.equal(p2.projectId, 'hq'); assert.equal(p2.projectBeforeLock, undefined);
  const d2 = { ...reloaded, ...p2 };
  assert.equal(parseDraft(serializeDraft(d2), () => 'x').projectBeforeLock, undefined, 'sem trava, o campo some');
  assert.equal(applyProjectLock(d2, null, projects), null, 'fora da sala e sem trava anterior: nada muda');
  assert.equal(applyProjectLock(d0, 'sumiu', projects), null, 'pasta da sala ainda não chegou: não mexe');
  // Nada escolhido antes de entrar: ao sair, o projeto volta vazio (o Chefe escolhe).
  const e1 = { ...emptyDraft('id'), ...applyProjectLock(emptyDraft('id'), 'conteudo', projects)! };
  assert.equal(e1.projectBeforeLock, null);
  assert.equal(applyProjectLock(e1, null, projects)!.projectId, null);
});
