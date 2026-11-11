// Catálogo de skills e agentes: varredura de uma "casa" do Claude Code descartável + projeto de teste. Nada aqui toca
// ~/.claude de verdade. Confere origens, overrides, sombra de nomes, plugins habilitados/escopo, sincronizadas, comandos
// legados, aninhadas, evidência do init (provider_caps), suporte por provedor, leitura, inspeção/cópia de skill local e agentes.
import { test } from 'node:test';
import { tempDir } from './tmp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillCatalog } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { SkillsService, parseFrontmatter, hasShellInjection } from '../src/skills/index.js';

const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const skill = (name: string, extra = '', body = `# ${name}\n\nManual de ${name}.`) => `---\nname: ${name}\ndescription: Skill ${name} de teste.\n${extra}---\n\n${body}\n`;

function setup(opts: { codex?: { installed: boolean; version: string | null } | null } = {}) {
  const base = tempDir('hq-skills-');
  const home = path.join(base, 'home'); const proj = path.join(base, 'proj'); const elsewhere = path.join(base, 'elsewhere');
  const injected = path.join(base, 'INJETADO.txt');
  // ---- casa do Claude Code ----
  write(path.join(home, 'settings.json'), JSON.stringify({ skillOverrides: { 'off-skill': 'off', quiet: 'name-only', 'manual-only': 'user-invocable-only' }, enabledPlugins: { 'plug@mkt': true, 'dead@mkt': false, 'projplug@mkt': true, 'otherproj@mkt': true } }));
  write(path.join(home, 'skills', 'alpha', 'SKILL.md'), `---\nname: alpha\ndescription: >\n  Skill alfa de teste,\n  com descrição dobrada.\nargument-hint: "[arquivo]"\nallowed-tools: [Read, Grep]\ndisable-model-invocation: true\ncontext: fork\nmodel: sonnet\neffort: high\nmetadata:\n  version: 1.2.3\n  author: teste\n---\n\n# Alpha\n\nEstado atual: !\`node -e "require('fs').writeFileSync('${injected.replace(/\\/g, '/')}', 'x')"\`\n\nUse com cuidado.\n`);
  write(path.join(home, 'skills', 'off-skill', 'SKILL.md'), skill('off-skill'));
  write(path.join(home, 'skills', 'quiet', 'SKILL.md'), skill('quiet'));
  write(path.join(home, 'skills', 'manual-only', 'SKILL.md'), skill('manual-only'));
  write(path.join(home, 'skills', 'hidden', 'SKILL.md'), skill('hidden', 'user-invocable: false\n'));
  write(path.join(home, 'skills', 'broken', 'SKILL.md'), '---\nname: broken\ndescription: sem fechamento\n\n# corpo\n');
  write(path.join(home, 'skills', 'shared', 'SKILL.md'), skill('shared', '', 'versão PESSOAL'));
  write(path.join(elsewhere, 'linked-skill', 'SKILL.md'), skill('linked'));
  fs.symlinkSync(path.join(elsewhere, 'linked-skill'), path.join(home, 'skills', 'linked'), 'junction');
  write(path.join(home, 'skills', 'synced', 'id1', 'manifest.json'), JSON.stringify({ lastUpdated: 1, skills: [{ name: 'docs' }] }));
  write(path.join(home, 'skills', 'synced', 'id1', 'docs', 'SKILL.md'), skill('docs', '', 'versão ANTIGA'));
  write(path.join(home, 'skills', 'synced', 'id2', 'manifest.json'), JSON.stringify({ lastUpdated: 2, skills: [{ name: 'docs' }, { name: 'extra' }] }));
  write(path.join(home, 'skills', 'synced', 'id2', 'docs', 'SKILL.md'), skill('docs', '', 'versão NOVA'));
  write(path.join(home, 'skills', 'synced', 'id2', 'extra', 'SKILL.md'), skill('extra'));
  write(path.join(home, 'commands', 'oldcmd.md'), '---\ndescription: Comando legado.\nargument-hint: [alvo]\n---\n\nFaça X com $ARGUMENTS.\n');
  write(path.join(home, 'agents', 'user-agent.md'), '---\nname: user-agent\ndescription: Agente do usuário.\ntools: Read, Grep\n---\n\nVocê revisa código.\n');
  write(path.join(home, 'agents', 'dup.md'), '---\nname: dup\ndescription: versão do usuário\n---\n\ncorpo\n');
  // plugins
  const plug = path.join(home, 'plugins', 'cache', 'mkt', 'plug', '1.0.0');
  const dead = path.join(home, 'plugins', 'cache', 'mkt', 'dead', '1.0.0');
  const projplug = path.join(home, 'plugins', 'cache', 'mkt', 'projplug', '1.0.0');
  const otherproj = path.join(home, 'plugins', 'cache', 'mkt', 'otherproj', '1.0.0');
  write(path.join(plug, 'skills', 'tool', 'SKILL.md'), skill('tool'));
  write(path.join(plug, 'commands', 'deploy.md'), '---\ndescription: Faz deploy.\n---\n\nDeploy.\n');
  write(path.join(plug, 'commands', '_conventions.md'), 'não é comando');
  write(path.join(plug, 'agents', 'helper.md'), '---\nname: helper\ndescription: Ajudante do plugin.\ntools: [Read, Grep]\nmodel: haiku\npermissionMode: plan\nskills: [tool]\nmcpServers:\n  - foo\nhooks:\n  PreToolUse: []\n---\n\nVocê ajuda.\n');
  write(path.join(plug, 'agents', 'helper.md.tmpl'), 'template, ignorar');
  write(path.join(dead, 'skills', 'dead-tool', 'SKILL.md'), skill('dead-tool'));
  write(path.join(projplug, 'skills', 'ptool', 'SKILL.md'), skill('ptool'));
  write(path.join(otherproj, 'skills', 'otool', 'SKILL.md'), skill('otool'));
  write(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'plug@mkt': [{ scope: 'user', installPath: plug, version: '1.0.0' }],
    'dead@mkt': [{ scope: 'user', installPath: dead, version: '1.0.0' }],
    'projplug@mkt': [{ scope: 'project', projectPath: proj, installPath: projplug, version: '1.0.0' }],
    'otherproj@mkt': [{ scope: 'project', projectPath: path.join(base, 'outro-projeto'), installPath: otherproj, version: '1.0.0' }],
  } }));
  // ---- projeto ----
  write(path.join(proj, '.claude', 'skills', 'shared', 'SKILL.md'), skill('shared', '', 'versão do PROJETO'));
  write(path.join(proj, '.claude', 'skills', 'projonly', 'SKILL.md'), skill('projonly'));
  write(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { projonly: 'user-invocable-only' } }));
  write(path.join(proj, '.claude', 'agents', 'proj-agent.md'), '---\nname: proj-agent\ndescription: Agente do projeto.\n---\n\ncorpo\n');
  write(path.join(proj, '.claude', 'agents', 'dup.md'), '---\nname: dup\ndescription: versão do projeto\n---\n\ncorpo\n');
  write(path.join(proj, 'packages', 'sub', '.claude', 'skills', 'nested-one', 'SKILL.md'), skill('nested-one'));
  write(path.join(proj, 'node_modules', 'x', '.claude', 'skills', 'ignored', 'SKILL.md'), skill('ignored'));
  write(path.join(proj, 'README.md'), '# projeto de teste');

  const db = openDb(':memory:');
  const store = new Store(db); store.seedDefaultRooms();
  const room = store.listRooms()[0];
  const project = store.createProject({ name: 'Projeto skills', path: proj, roomId: room.id });
  const broadcasts: { kind: string }[] = [];
  const svc = new SkillsService({ store, claudeHome: home, claudeVersion: () => '2.1.316', codexStatus: () => (opts.codex === undefined ? { installed: true, version: '0.58.0' } : opts.codex), broadcast: m => broadcasts.push(m), log: { info() {}, warn() {} } });
  return { base, home, proj, injected, store, project, svc, broadcasts, cleanup: () => { try { db.close(); } catch { /* ignorar */ } fs.rmSync(base, { recursive: true, force: true }); } };
}

const find = (cat: SkillCatalog, inv: string, source?: string) => cat.skills.find(s => s.invocation === inv && (!source || s.source === source));

test('frontmatter: subconjunto YAML lido como texto; injeção de shell detectada, nunca executada', () => {
  const fm = parseFrontmatter('---\nname: x\ndescription: "com aspas"\nlist: [a, "b", c]\nblock: |\n  linha 1\n  linha 2\nfolded: >\n  a\n  b\n\n  c\nitems:\n  - um\n  - dois\nmeta:\n  k: v\nflag: true\n---\ncorpo !`rm -rf /`\n');
  assert.equal(fm.present, true);
  assert.deepEqual(fm.data.list, ['a', 'b', 'c']);
  assert.equal(fm.data.description, 'com aspas');
  assert.equal(fm.data.block, 'linha 1\nlinha 2');
  assert.equal(fm.data.folded, 'a b\nc');
  assert.deepEqual(fm.data.items, ['um', 'dois']);
  assert.deepEqual(fm.data.meta, { k: 'v' });
  assert.equal(fm.data.flag, true);
  assert.equal(fm.body.trim(), 'corpo !`rm -rf /`');
  assert.equal(hasShellInjection(fm.body), true);
  assert.equal(parseFrontmatter('sem frontmatter').present, false);
  assert.match(parseFrontmatter('---\nname: a\n').problems[0], /sem fechamento/);
});

test('catálogo do projeto: origens, overrides, sombra, plugins, sincronizadas, comandos, aninhadas, evidência do init', () => {
  const s = setup();
  try {
    s.store.saveProviderCaps(s.project.id, 'claude', { skills: ['alpha', 'shared', 'plug:tool', 'anthropic-skills:docs', 'code-review'], slashCommands: ['plug:deploy', 'oldcmd', 'compact'], agents: [], plugins: [{ name: 'plug' }], tools: [], model: 'm', version: '2.1.316' });
    const cat = s.svc.catalog(s.project.id, true);
    assert.equal(fs.existsSync(s.injected), false, 'o comando embutido NÃO foi executado ao catalogar');
    const sources = new Set(cat.roots.map(r => r.source));
    for (const src of ['personal', 'project', 'nested', 'plugin', 'synced']) assert.ok(sources.has(src as never), `raiz ${src}`);

    const alpha = find(cat, 'alpha')!;
    assert.ok(alpha); assert.equal(alpha.source, 'personal'); assert.equal(alpha.kind, 'skill');
    assert.equal(alpha.description, 'Skill alfa de teste, com descrição dobrada.');
    assert.equal(alpha.argumentHint, '[arquivo]'); assert.deepEqual(alpha.allowedTools, ['Read', 'Grep']);
    assert.equal(alpha.modelInvocable, false); assert.equal(alpha.userInvocable, true); assert.equal(alpha.forks, true); assert.equal(alpha.model, 'sonnet'); assert.equal(alpha.effort, 'high');
    assert.equal(alpha.hasShellInjection, true);
    assert.deepEqual(alpha.verified, { listed: true, at: cat.skills.find(x => x.verified)!.verified!.at });
    assert.equal(alpha.providers.claude.mode, 'native'); assert.equal(alpha.providers.openai.mode, 'inject'); assert.match(alpha.providers.openai.detail, /0\.58\.0/);
    assert.equal(alpha.problems.length, 0, JSON.stringify(alpha.problems));

    const off = find(cat, 'off-skill')!; assert.equal(off.disabled, true); assert.equal(off.override, 'off'); assert.equal(off.providers.claude.mode, 'unavailable'); assert.equal(off.providers.openai.mode, 'unavailable');
    const quiet = find(cat, 'quiet')!; assert.equal(quiet.description, ''); assert.ok(quiet.problems.some(p => /name-only/.test(p)));
    const manual = find(cat, 'manual-only')!; assert.equal(manual.modelInvocable, false); assert.equal(manual.userInvocable, true); assert.equal(manual.providers.claude.mode, 'native');
    const hidden = find(cat, 'hidden')!; assert.equal(hidden.userInvocable, false); assert.equal(hidden.providers.claude.mode, 'unavailable');
    const broken = find(cat, 'broken')!; assert.ok(broken.problems.some(p => /sem fechamento/.test(p)));
    assert.equal(find(cat, 'linked')!.source, 'personal', 'link (junction) seguido');

    const shared = cat.skills.filter(x => x.invocation === 'shared');
    assert.equal(shared.length, 2);
    const personal = shared.find(x => x.source === 'personal')!; const projectOne = shared.find(x => x.source === 'project')!;
    assert.equal(personal.shadowedBy, null); assert.equal(projectOne.shadowedBy, personal.id); assert.ok(projectOne.problems.some(p => /maior prioridade/.test(p)));
    assert.equal(personal.verified?.listed, true); assert.equal(projectOne.verified?.listed, true);

    const docs = cat.skills.filter(x => x.invocation === 'anthropic-skills:docs');
    assert.equal(docs.length, 2); assert.equal(docs.filter(x => !x.shadowedBy).length, 1);
    assert.match(docs.find(x => !x.shadowedBy)!.path!, /id2/); assert.equal(docs.find(x => !x.shadowedBy)!.verified?.listed, true);
    assert.equal(find(cat, 'anthropic-skills:extra')!.source, 'synced');

    const cmd = find(cat, 'oldcmd')!; assert.equal(cmd.kind, 'command'); assert.equal(cmd.description, 'Comando legado.'); assert.equal(cmd.verified?.listed, true);
    const tool = find(cat, 'plug:tool')!; assert.equal(tool.source, 'plugin'); assert.equal(tool.plugin, 'plug@mkt'); assert.equal(tool.projectId, null);
    const deploy = find(cat, 'plug:deploy')!; assert.equal(deploy.kind, 'command'); assert.equal(deploy.verified?.listed, true);
    assert.equal(find(cat, 'plug:_conventions'), undefined);
    assert.equal(find(cat, 'dead:dead-tool'), undefined, 'plugin desabilitado não entra');
    assert.equal(find(cat, 'otherproj:otool'), undefined, 'plugin de outro projeto não entra');
    assert.equal(find(cat, 'projplug:ptool')!.projectId, s.project.id, 'plugin com escopo deste projeto entra');
    const projonly = find(cat, 'projonly')!; assert.equal(projonly.override, 'user-invocable-only'); assert.equal(projonly.modelInvocable, false);
    assert.equal(find(cat, 'nested-one')!.source, 'nested'); assert.equal(find(cat, 'ignored'), undefined, 'node_modules não é varrido');
    const bundled = find(cat, 'code-review')!; assert.equal(bundled.source, 'bundled'); assert.equal(bundled.path, null); assert.equal(bundled.verified?.listed, true); assert.equal(bundled.providers.openai.mode, 'unavailable');
    assert.equal(find(cat, 'compact'), undefined, 'slash command do init que não é skill não vira skill');
    assert.equal(find(cat, 'hidden')!.verified?.listed, false, 'não listada no init → evidência negativa');

    // sem projeto: nada de projeto/aninhado e sem evidência
    const general = s.svc.catalog(null, true);
    assert.equal(general.skills.some(x => x.source === 'project' || x.source === 'nested'), false);
    assert.equal(general.skills.every(x => x.verified === null), true);
    assert.equal(find(general, 'projplug:ptool'), undefined);
  } finally { s.cleanup(); }
});

test('sem Codex instalado, o OpenAI fica indisponível para toda skill (sem fingir)', () => {
  const s = setup({ codex: { installed: false, version: null } });
  try {
    const cat = s.svc.catalog(s.project.id, true);
    assert.ok(cat.skills.length > 0);
    assert.ok(cat.skills.every(x => x.providers.openai.mode === 'unavailable'));
  } finally { s.cleanup(); }
});

test('resolve, read e handle', async () => {
  const s = setup();
  try {
    const r = await s.svc.resolve('alpha', s.project.id);
    assert.ok(r); assert.equal(r!.info.invocation, 'alpha'); assert.match(r!.content!, /Use com cuidado/);
    assert.equal((await s.svc.resolve('/plug:tool', s.project.id))!.info.plugin, 'plug@mkt');
    assert.equal(await s.svc.resolve('nope', s.project.id), null);
    const shared = await s.svc.resolve('shared', s.project.id);
    assert.equal(shared!.info.source, 'personal', 'a de maior prioridade'); assert.match(shared!.content!, /PESSOAL/);
    const read = s.svc.read(r!.info.path!, s.project.id); assert.match(read.content, /# Alpha/);
    assert.throws(() => s.svc.read(path.join(s.proj, 'README.md'), s.project.id), /não faz parte do catálogo/);
    const listed = await s.svc.handle({ type: 'skills.list', reqId: 'r1', projectId: s.project.id }) as SkillCatalog;
    assert.ok(listed.skills.length > 5);
    await assert.rejects(s.svc.handle({ type: 'routine.delete', id: 'x' } as never), /não suportada/);
  } finally { s.cleanup(); }
});

test('agentes nativos: usuário, projeto (prioridade), plugin com campos não aplicáveis', () => {
  const s = setup();
  try {
    const { agents } = s.svc.agents(s.project.id);
    const ua = agents.find(a => a.name === 'user-agent')!; assert.equal(ua.source, 'user'); assert.deepEqual(ua.tools, ['Read', 'Grep']); assert.match(ua.prompt, /revisa código/);
    assert.equal(agents.find(a => a.name === 'proj-agent')!.source, 'project');
    const dups = agents.filter(a => a.name === 'dup'); assert.equal(dups.length, 2);
    assert.equal(dups.find(a => a.source === 'project')!.problems.length, 0); assert.ok(dups.find(a => a.source === 'user')!.problems.some(p => /prioridade/.test(p)));
    const helper = agents.find(a => a.name === 'plug:helper')!;
    assert.ok(helper); assert.equal(helper.plugin, 'plug@mkt'); assert.deepEqual(helper.tools, ['Read', 'Grep']); assert.equal(helper.model, 'haiku'); assert.equal(helper.permissionMode, 'plan'); assert.deepEqual(helper.skills, ['tool']);
    assert.deepEqual(helper.unsupported.map(u => u.field).sort(), ['hooks', 'mcpServers']);
    assert.equal(agents.some(a => a.path.endsWith('.tmpl')), false);
  } finally { s.cleanup(); }
});

test('adicionar skill local: inspeção sem copiar, validação de formato, cópia pessoal/projeto, recusa duplicata', async () => {
  const s = setup();
  try {
    const src = path.join(s.base, 'nova-skill');
    write(path.join(src, 'SKILL.md'), skill('nova-skill', '', 'Manual novo.'));
    write(path.join(src, 'references', 'guia.md'), '# guia');
    write(path.join(src, 'node_modules', 'lixo', 'x.js'), '// ignorado');
    const insp = s.svc.inspectLocal(src);
    assert.equal(insp.ok, true); assert.equal(insp.name, 'nova-skill'); assert.deepEqual(insp.files.sort(), ['SKILL.md', 'references/guia.md']); assert.match(insp.content, /Manual novo/);
    assert.equal(fs.existsSync(path.join(s.home, 'skills', 'nova-skill')), false, 'inspecionar não copia');
    // nome inválido
    const bad = path.join(s.base, 'Bad_Name'); write(path.join(bad, 'SKILL.md'), '---\nname: Bad_Name\ndescription: x\n---\ncorpo');
    assert.equal(s.svc.inspectLocal(bad).ok, false);
    assert.throws(() => s.svc.inspectLocal(path.join(s.base, 'vazia-sem-skill')), /não existe/);
    const semSkill = path.join(s.base, 'sem-skill'); fs.mkdirSync(semSkill); assert.throws(() => s.svc.inspectLocal(semSkill), /não achei SKILL.md/);
    assert.throws(() => s.svc.addLocal(bad, 'personal', null), /não está válida/);

    const added = s.svc.addLocal(src, 'personal', null);
    assert.equal(added.destination, path.join(s.home, 'skills', 'nova-skill'));
    assert.equal(fs.readFileSync(path.join(added.destination, 'references', 'guia.md'), 'utf8'), '# guia');
    assert.equal(fs.existsSync(path.join(added.destination, 'node_modules')), false);
    assert.equal(added.info.source, 'personal'); assert.equal(added.info.invocation, 'nova-skill');
    assert.ok(s.broadcasts.some(b => b.kind === 'skills.changed'));
    assert.throws(() => s.svc.addLocal(src, 'personal', null), /já existe/);
    const addedProj = s.svc.addLocal(src, 'project', s.project.id);
    assert.equal(addedProj.destination, path.join(s.proj, '.claude', 'skills', 'nova-skill'));
    assert.equal(addedProj.info.source, 'project');
    assert.equal(addedProj.info.shadowedBy !== null, true, 'a pessoal recém-adicionada tem prioridade sobre a do projeto');
    assert.throws(() => s.svc.addLocal(src, 'project', null), /escolha o projeto/);
    const r = await s.svc.resolve('nova-skill', s.project.id); assert.equal(r!.info.source, 'personal');
  } finally { s.cleanup(); }
});
