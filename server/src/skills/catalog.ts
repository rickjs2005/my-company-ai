// Catálogo REAL de skills: varre as origens que o Claude Code 2.1.x carrega e descreve cada uma sem executar nada do
// conteúdo. Origens (conferidas em 31/10/2026 nesta máquina): pessoais em ~/.claude/skills/<nome>/SKILL.md (links
// simbólicos seguidos), sincronizadas em ~/.claude/skills/synced/<id>/<nome>/SKILL.md (invocadas como
// anthropic-skills:<nome>), de projeto em <projeto>/.claude/skills, aninhadas em subpastas do projeto, de plugins
// habilitados em <installPath>/skills/<nome>/SKILL.md e <installPath>/commands/<nome>.md (invocadas como plugin:nome),
// comandos legados em ~/.claude/commands e <projeto>/.claude/commands. skillOverrides das configurações (usuário,
// projeto e local) desligam ou restringem skills. A evidência de que o Claude Code realmente listou a skill vem do
// `init` guardado em provider_caps (por projeto).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiProviderId, EffortLevel, SkillCatalog, SkillInfo, SkillProviderSupport, SkillSource } from '@milweb-hq/protocol';
import { asBool, asList, asString, hasShellInjection, parseFrontmatter } from './frontmatter.js';

export interface PluginInstall { key: string; name: string; marketplace: string; scope: 'user' | 'project'; projectPath: string | null; installPath: string; version: string | null }

export interface ScanInput {
  claudeHome: string;
  project: { id: string; path: string } | null;
  /** Lista `skills` do último init do Claude Code neste projeto (evidência), se houver. */
  caps: { skills: string[]; slashCommands: string[]; at: number } | null;
  claudeVersion: string | null;
  codex: { installed: boolean; version: string | null; skillsApi: boolean };
}

type Override = SkillInfo['override'];
const OVERRIDES: Override[] = ['on', 'name-only', 'user-invocable-only', 'off'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache', 'vendor', '.venv', '__pycache__']);
const NESTED_MAX_DEPTH = 4;
const EFFORTS: EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
}
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
function realOrSelf(p: string): string { try { return fs.realpathSync.native(p); } catch { return p; } }
export function samePath(a: string, b: string): boolean { return path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase(); }

/** Nome válido para pasta de skill (regra do Claude Code: minúsculas, números e hifens, até 64). */
export function validSkillName(name: string): boolean { return NAME_RE.test(name); }

export interface ParsedSkill {
  name: string; description: string; whenToUse: string | null; argumentHint: string | null; arguments: string[];
  modelInvocable: boolean; userInvocable: boolean; allowedTools: string[]; model: string | null; effort: EffortLevel | null; forks: boolean;
  hasShellInjection: boolean; problems: string[]; body: string; raw: string;
}

/** Lê e interpreta um SKILL.md (ou comando .md). `fallbackName` = nome da pasta/arquivo. Nunca executa o conteúdo. */
export function parseSkillFile(file: string, fallbackName: string): ParsedSkill {
  const raw = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(raw);
  const problems = [...fm.problems];
  if (!fm.present) problems.push('sem frontmatter: o Claude Code usa o nome da pasta e fica sem descrição');
  const d = fm.data;
  let name = (asString(d.name) ?? '').trim() || fallbackName;
  if (!validSkillName(name)) { problems.push(`nome "${name}" fora do padrão (minúsculas, números e hifens, até 64 caracteres)`); }
  if (asString(d.name) && asString(d.name)!.trim() !== fallbackName) problems.push(`o campo name ("${asString(d.name)!.trim()}") difere do nome da pasta ("${fallbackName}"); o Claude Code invoca pelo nome do frontmatter`);
  name = name.trim();
  const description = (asString(d.description) ?? '').trim();
  if (fm.present && !description) problems.push('sem description: o Claude Code não sabe quando usar esta skill');
  if (description.length > 1024) problems.push(`description com ${description.length} caracteres (limite recomendado 1024)`);
  const modelInv = asBool(d['disable-model-invocation']);
  const userInv = asBool(d['user-invocable']);
  const effortRaw = asString(d.effort);
  const effort = effortRaw && (EFFORTS as string[]).includes(effortRaw) ? (effortRaw as EffortLevel) : null;
  if (effortRaw && !effort) problems.push(`effort "${effortRaw}" desconhecido`);
  const ctx = asString(d.context);
  const body = fm.body;
  return {
    name, description,
    whenToUse: asString(d['when_to_use'] ?? d['when-to-use'])?.trim() || null,
    argumentHint: asString(d['argument-hint'])?.trim() || null,
    arguments: asList(d.arguments),
    modelInvocable: modelInv !== true,
    userInvocable: userInv !== false,
    allowedTools: asList(d['allowed-tools']),
    model: asString(d.model)?.trim() || null,
    effort,
    forks: ctx === 'fork',
    hasShellInjection: hasShellInjection(body),
    problems, body, raw,
  };
}

/** Lê skillOverrides e enabledPlugins das configurações (usuário → projeto → local; o último vence). */
export function readSettings(claudeHome: string, projectPath: string | null): { overrides: Record<string, Override>; enabledPlugins: Record<string, boolean>; files: string[] } {
  const files = [path.join(claudeHome, 'settings.json')];
  if (projectPath) files.push(path.join(projectPath, '.claude', 'settings.json'), path.join(projectPath, '.claude', 'settings.local.json'));
  const overrides: Record<string, Override> = {};
  const enabledPlugins: Record<string, boolean> = {};
  const seen: string[] = [];
  for (const f of files) {
    if (!isFile(f)) continue;
    const j = readJson(f); if (!j) continue;
    seen.push(f);
    const so = j.skillOverrides;
    if (so && typeof so === 'object') for (const [k, v] of Object.entries(so as Record<string, unknown>)) if (typeof v === 'string' && (OVERRIDES as string[]).includes(v)) overrides[k] = v as Override;
    const ep = j.enabledPlugins;
    if (ep && typeof ep === 'object') for (const [k, v] of Object.entries(ep as Record<string, unknown>)) if (typeof v === 'boolean') enabledPlugins[k] = v;
  }
  return { overrides, enabledPlugins, files: seen };
}

/** Plugins instalados (installed_plugins.json) filtrados pelos habilitados e pelo escopo (projeto só vale na sua pasta). */
export function readPlugins(claudeHome: string, projectPath: string | null, enabled: Record<string, boolean>, warnings: string[]): PluginInstall[] {
  const file = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  if (!isFile(file)) return [];
  const j = readJson(file);
  if (!j || typeof j.plugins !== 'object' || !j.plugins) { warnings.push(`${file}: formato não reconhecido`); return []; }
  const out: PluginInstall[] = [];
  for (const [key, entries] of Object.entries(j.plugins as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const at = key.indexOf('@');
    const name = at > 0 ? key.slice(0, at) : key; const marketplace = at > 0 ? key.slice(at + 1) : '';
    for (const e of entries as Record<string, unknown>[]) {
      const scope = e.scope === 'project' ? 'project' : 'user';
      const installPath = asString(e.installPath); if (!installPath) continue;
      const pp = asString(e.projectPath);
      if (scope === 'project' && (!projectPath || !pp || !samePath(pp, projectPath))) continue;
      if (enabled[key] === false) continue;
      if (enabled[key] !== true && scope === 'user') { /* sem entrada em enabledPlugins: o Claude Code trata como habilitado quando instalado */ }
      if (!isDir(installPath)) { warnings.push(`plugin ${key}: pasta de instalação não existe (${installPath})`); continue; }
      out.push({ key, name, marketplace, scope, projectPath: pp ?? null, installPath, version: asString(e.version) });
    }
  }
  return out;
}

interface Found { source: SkillSource; invocation: string; file: string; plugin: string | null; projectId: string | null; kind: 'skill' | 'command'; rootPath: string; syncedUpdated?: number }

function listSkillDirs(root: string): { name: string; file: string }[] {
  if (!isDir(root)) return [];
  const out: { name: string; file: string }[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(root, d.name);
    // links simbólicos são seguidos (é como as skills de ~/.agents/skills aparecem em ~/.claude/skills)
    if (!isDir(full)) continue;
    const file = path.join(full, 'SKILL.md');
    if (isFile(file)) out.push({ name: d.name, file });
  }
  return out;
}
function listCommandFiles(root: string): { name: string; file: string }[] {
  if (!isDir(root)) return [];
  const out: { name: string; file: string }[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    if (!d.name.endsWith('.md') || d.name.startsWith('_') || d.name.startsWith('.')) continue;
    const full = path.join(root, d.name);
    if (isFile(full)) out.push({ name: d.name.slice(0, -3), file: full });
  }
  return out;
}
/** Pastas `.claude/skills` em subpastas do projeto (monorepo), até NESTED_MAX_DEPTH níveis, pulando dependências e builds. */
function listNestedSkillRoots(projectPath: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > NESTED_MAX_DEPTH) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(d.name)) continue;
      if (d.name.startsWith('.')) { if (d.name === '.claude' && depth > 0) { const r = path.join(dir, d.name, 'skills'); if (isDir(r)) out.push(r); } continue; }
      walk(path.join(dir, d.name), depth + 1);
    }
  };
  walk(projectPath, 0);
  return out;
}

/** Varredura completa. Síncrona e barata (algumas centenas de arquivos pequenos). */
export function scanSkills(input: ScanInput): SkillCatalog & { settingsFiles: string[]; plugins: PluginInstall[] } {
  const warnings: string[] = [];
  const roots: SkillCatalog['roots'] = [];
  const found: Found[] = [];
  const { claudeHome, project } = input;
  const projectPath = project?.path ?? null;
  const settings = readSettings(claudeHome, projectPath);

  const addRoot = (source: SkillSource, p: string, projectId: string | null) => { roots.push({ source, path: p, projectId, exists: isDir(p) }); };

  // pessoais + comandos pessoais
  const personalRoot = path.join(claudeHome, 'skills');
  addRoot('personal', personalRoot, null);
  for (const s of listSkillDirs(personalRoot)) found.push({ source: 'personal', invocation: s.name, file: s.file, plugin: null, projectId: null, kind: 'skill', rootPath: personalRoot });
  const personalCmds = path.join(claudeHome, 'commands');
  if (isDir(personalCmds)) { addRoot('personal', personalCmds, null); for (const c of listCommandFiles(personalCmds)) found.push({ source: 'personal', invocation: c.name, file: c.file, plugin: null, projectId: null, kind: 'command', rootPath: personalCmds }); }

  // sincronizadas (claude.ai): ~/.claude/skills/synced/<id>/<nome>/SKILL.md, invocadas como anthropic-skills:<nome>
  const syncedRoot = path.join(personalRoot, 'synced');
  if (isDir(syncedRoot)) {
    addRoot('synced', syncedRoot, null);
    for (const id of fs.readdirSync(syncedRoot)) {
      const dir = path.join(syncedRoot, id);
      if (!isDir(dir)) continue;
      const manifest = readJson(path.join(dir, 'manifest.json'));
      const updated = manifest && typeof manifest.lastUpdated === 'number' ? manifest.lastUpdated : 0;
      for (const s of listSkillDirs(dir)) found.push({ source: 'synced', invocation: `anthropic-skills:${s.name}`, file: s.file, plugin: null, projectId: null, kind: 'skill', rootPath: dir, syncedUpdated: updated });
    }
  }

  // projeto + aninhadas + comandos do projeto
  if (project && projectPath) {
    const projRoot = path.join(projectPath, '.claude', 'skills');
    addRoot('project', projRoot, project.id);
    for (const s of listSkillDirs(projRoot)) found.push({ source: 'project', invocation: s.name, file: s.file, plugin: null, projectId: project.id, kind: 'skill', rootPath: projRoot });
    const projCmds = path.join(projectPath, '.claude', 'commands');
    if (isDir(projCmds)) { addRoot('project', projCmds, project.id); for (const c of listCommandFiles(projCmds)) found.push({ source: 'project', invocation: c.name, file: c.file, plugin: null, projectId: project.id, kind: 'command', rootPath: projCmds }); }
    if (isDir(projectPath)) {
      for (const nested of listNestedSkillRoots(projectPath)) {
        addRoot('nested', nested, project.id);
        for (const s of listSkillDirs(nested)) found.push({ source: 'nested', invocation: s.name, file: s.file, plugin: null, projectId: project.id, kind: 'skill', rootPath: nested });
      }
    } else warnings.push(`a pasta do projeto não existe: ${projectPath}`);
  }

  // plugins habilitados
  const plugins = readPlugins(claudeHome, projectPath, settings.enabledPlugins, warnings);
  for (const pl of plugins) {
    const skillsDir = path.join(pl.installPath, 'skills');
    const cmdsDir = path.join(pl.installPath, 'commands');
    if (isDir(skillsDir)) { addRoot('plugin', skillsDir, pl.scope === 'project' ? project?.id ?? null : null); for (const s of listSkillDirs(skillsDir)) found.push({ source: 'plugin', invocation: `${pl.name}:${s.name}`, file: s.file, plugin: pl.key, projectId: pl.scope === 'project' ? project?.id ?? null : null, kind: 'skill', rootPath: skillsDir }); }
    if (isDir(cmdsDir)) { addRoot('plugin', cmdsDir, pl.scope === 'project' ? project?.id ?? null : null); for (const c of listCommandFiles(cmdsDir)) found.push({ source: 'plugin', invocation: `${pl.name}:${c.name}`, file: c.file, plugin: pl.key, projectId: pl.scope === 'project' ? project?.id ?? null : null, kind: 'command', rootPath: cmdsDir }); }
    if (!isDir(skillsDir) && !isDir(cmdsDir)) warnings.push(`plugin ${pl.key}: sem pastas skills/ ou commands/ em ${pl.installPath}`);
  }

  // sincronizadas duplicadas (duas pastas de manifesto): fica a mais recente; a outra vira sombra
  const skills: SkillInfo[] = [];
  const capsSkills = new Set(input.caps?.skills ?? []);
  const capsCommands = new Set(input.caps?.slashCommands ?? []);
  const PRIORITY: Record<SkillSource, number> = { personal: 0, synced: 1, project: 2, nested: 3, plugin: 4, bundled: 5 };
  found.sort((a, b) => PRIORITY[a.source] - PRIORITY[b.source] || (b.syncedUpdated ?? 0) - (a.syncedUpdated ?? 0) || a.file.localeCompare(b.file));
  const byInvocation = new Map<string, SkillInfo>();

  for (const f of found) {
    let parsed: ParsedSkill;
    try { parsed = parseSkillFile(f.file, path.basename(path.dirname(f.file)) === path.basename(f.file, '.md') || f.kind === 'command' ? path.basename(f.file, '.md') : path.basename(path.dirname(f.file))); }
    catch (err) { warnings.push(`${f.file}: ${(err as Error).message}`); continue; }
    const baseName = f.kind === 'command' ? path.basename(f.file, '.md') : path.basename(path.dirname(f.file));
    const shortName = f.kind === 'command' ? baseName : parsed.name;
    // a invocação usa o name do frontmatter quando houver (comandos usam o nome do arquivo)
    const invocation = f.invocation.includes(':') ? `${f.invocation.split(':')[0]}:${shortName}` : shortName;
    const override: Override = settings.overrides[invocation] ?? settings.overrides[shortName] ?? 'on';
    const disabled = override === 'off';
    const modelInvocable = parsed.modelInvocable && override !== 'user-invocable-only' && !disabled;
    const userInvocable = parsed.userInvocable && !disabled;
    const id = `${f.source}:${invocation}:${realOrSelf(f.file)}`.toLowerCase();
    const prev = byInvocation.get(invocation);
    const providers = providerSupport({ invocation, disabled, userInvocable, hasFile: true, kind: f.kind, source: f.source }, input);
    const verified = input.caps ? { listed: capsSkills.has(invocation) || capsCommands.has(invocation), at: input.caps.at } : null;
    const info: SkillInfo = {
      id, invocation, name: shortName, description: override === 'name-only' ? '' : parsed.description, whenToUse: parsed.whenToUse, argumentHint: parsed.argumentHint, arguments: parsed.arguments,
      source: f.source, path: f.file, plugin: f.plugin, projectId: f.projectId, disabled, override, modelInvocable, userInvocable,
      allowedTools: parsed.allowedTools, model: parsed.model, effort: parsed.effort, forks: parsed.forks, hasShellInjection: parsed.hasShellInjection,
      shadowedBy: prev ? prev.id : null, providers, verified, problems: [...parsed.problems], kind: f.kind,
    };
    if (override === 'name-only' && parsed.description) info.problems.push('skillOverrides: name-only — o Claude Code vê só o nome; a descrição acima fica guardada só na HQ');
    if (prev) info.problems.push(`outra skill de maior prioridade usa o mesmo nome (${prev.source}: ${prev.path}); o Claude Code carrega aquela`);
    else byInvocation.set(invocation, info);
    skills.push(info);
  }

  // embutidas: listadas pelo init do Claude Code mas sem arquivo conhecido (ex.: code-review, simplify, init)
  if (input.caps) {
    for (const name of [...capsSkills].sort()) {
      if (byInvocation.has(name)) continue;
      const override: Override = settings.overrides[name] ?? 'on';
      const info: SkillInfo = {
        id: `bundled:${name}`.toLowerCase(), invocation: name, name, description: '', whenToUse: null, argumentHint: null, arguments: [], source: 'bundled', path: null, plugin: null, projectId: project?.id ?? null,
        disabled: override === 'off', override, modelInvocable: override !== 'user-invocable-only' && override !== 'off', userInvocable: override !== 'off', allowedTools: [], model: null, effort: null, forks: false, hasShellInjection: false, shadowedBy: null,
        providers: providerSupport({ invocation: name, disabled: override === 'off', userInvocable: true, hasFile: false, kind: 'skill', source: 'bundled' }, input),
        verified: { listed: true, at: input.caps.at }, problems: ['embutida no Claude Code (ou de uma origem que a HQ não varre): sem arquivo local; descrição desconhecida'], kind: 'skill',
      };
      byInvocation.set(name, info); skills.push(info);
    }
  }

  return { skills, roots, scannedAt: Date.now(), warnings, settingsFiles: settings.files, plugins };
}

function providerSupport(s: { invocation: string; disabled: boolean; userInvocable: boolean; hasFile: boolean; kind: 'skill' | 'command'; source: SkillSource }, input: ScanInput): Record<AiProviderId, SkillProviderSupport> {
  const cv = input.claudeVersion ? ` ${input.claudeVersion}` : '';
  let claude: SkillProviderSupport;
  if (s.disabled) claude = { mode: 'unavailable', detail: 'desativada em skillOverrides (off): o Claude Code não a lista nem a invoca' };
  else if (!s.userInvocable) claude = { mode: 'unavailable', detail: 'user-invocable: false — só o Claude decide usá-la; não dá para pedir /nome' };
  else claude = { mode: 'native', detail: `o pedido começa com /${s.invocation} e o Claude Code${cv} expande a skill (confirmado pela lista skills do init)` };
  let openai: SkillProviderSupport;
  if (!input.codex.installed) openai = { mode: 'unavailable', detail: 'Codex CLI não encontrado nesta máquina' };
  else if (input.codex.skillsApi) openai = { mode: 'native', detail: `Codex ${input.codex.version ?? ''} expõe skills no app-server` };
  else if (s.disabled) openai = { mode: 'unavailable', detail: 'desativada em skillOverrides (off)' };
  else if (!s.hasFile) openai = { mode: 'unavailable', detail: 'skill embutida no Claude Code: não há texto para entregar ao Codex' };
  else openai = { mode: 'inject', detail: `Codex ${input.codex.version ?? ''} não tem descoberta de skills nesta versão: o texto do SKILL.md vai como instrução identificada junto do pedido`.replace(/\s+/g, ' ') };
  return { claude, openai };
}

export function defaultClaudeHome(): string {
  return process.env.MILWEB_HQ_CLAUDE_HOME ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}
