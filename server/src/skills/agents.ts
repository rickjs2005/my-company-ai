// Agentes nativos (subagentes) definidos em arquivos .md: ~/.claude/agents, <projeto>/.claude/agents e <plugin>/agents.
// A HQ só lê o frontmatter e o corpo; "Contratar funcionário" pode importar a definição como perfil, aplicando o que
// consegue (ferramentas via --tools, modelo, modo de permissão, skills preferidas, instruções) e listando o que não aplica.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDefinition, AgentSource, EffortLevel } from '@milweb-hq/protocol';
import { asList, asString, parseFrontmatter } from './frontmatter.js';
import type { PluginInstall } from './catalog.js';

const EFFORTS: EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'];
/** Campos que o Claude Code aceita num agente e a HQ não consegue reproduzir num funcionário. */
const UNSUPPORTED: Record<string, string> = {
  mcpServers: 'servidores MCP exclusivos do agente: as conversas da HQ usam a configuração MCP normal do projeto',
  hooks: 'hooks do agente só valem quando o Claude Code o executa como subagente',
  memory: 'memória persistente de subagente não existe nas conversas da HQ',
  maxTurns: 'limite de turnos é do subagente; na HQ o limite é o tempo máximo da tarefa',
  background: 'execução em segundo plano é decisão da fila da HQ, não do perfil',
  isolation: 'worktree isolado por agente não é criado pela HQ',
  color: 'cor é só do terminal',
};

function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function listAgentFiles(root: string): string[] {
  if (!isDir(root)) return [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter(d => d.name.endsWith('.md') && !d.name.startsWith('.') && !d.name.startsWith('_')).map(d => path.join(root, d.name)).filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

export function parseAgentFile(file: string, source: AgentSource, plugin: string | null, projectId: string | null): AgentDefinition {
  const raw = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(raw);
  const problems = [...fm.problems];
  const d = fm.data;
  const fallback = path.basename(file, '.md');
  const name = (asString(d.name) ?? '').trim() || fallback;
  if (!fm.present) problems.push('sem frontmatter: o Claude Code exige name e description num agente');
  const description = (asString(d.description) ?? '').trim();
  if (fm.present && !description) problems.push('sem description');
  const tools = d.tools === undefined ? null : asList(d.tools);
  const disallowed = d.disallowedTools === undefined ? null : asList(d.disallowedTools);
  const permissionMode = asString(d.permissionMode)?.trim() || null;
  if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) problems.push(`permissionMode "${permissionMode}" desconhecido`);
  const effortRaw = asString(d.effort);
  const effort = effortRaw && (EFFORTS as string[]).includes(effortRaw) ? (effortRaw as EffortLevel) : null;
  if (effortRaw && !effort) problems.push(`effort "${effortRaw}" desconhecido`);
  const unsupported: AgentDefinition['unsupported'] = [];
  for (const [field, reason] of Object.entries(UNSUPPORTED)) if (d[field] !== undefined) unsupported.push({ field, reason });
  const prefix = plugin ? `${plugin.split('@')[0]}:` : '';
  return {
    id: `${source}:${prefix}${name}:${file}`.toLowerCase(), name: `${prefix}${name}`, description, source, path: file, plugin, projectId,
    prompt: fm.body.trim(), tools, disallowedTools: disallowed, model: asString(d.model)?.trim() || null, permissionMode, skills: asList(d.skills), effort, unsupported, problems,
  };
}

export function scanAgents(input: { claudeHome: string; project: { id: string; path: string } | null; plugins: PluginInstall[] }): { agents: AgentDefinition[]; roots: { source: AgentSource; path: string; exists: boolean }[]; warnings: string[] } {
  const warnings: string[] = [];
  const roots: { source: AgentSource; path: string; exists: boolean }[] = [];
  const agents: AgentDefinition[] = [];
  const read = (file: string, source: AgentSource, plugin: string | null, projectId: string | null) => {
    try { agents.push(parseAgentFile(file, source, plugin, projectId)); } catch (err) { warnings.push(`${file}: ${(err as Error).message}`); }
  };
  const userRoot = path.join(input.claudeHome, 'agents');
  roots.push({ source: 'user', path: userRoot, exists: isDir(userRoot) });
  for (const f of listAgentFiles(userRoot)) read(f, 'user', null, null);
  if (input.project) {
    const projRoot = path.join(input.project.path, '.claude', 'agents');
    roots.push({ source: 'project', path: projRoot, exists: isDir(projRoot) });
    for (const f of listAgentFiles(projRoot)) read(f, 'project', null, input.project.id);
  }
  for (const pl of input.plugins) {
    const root = path.join(pl.installPath, 'agents');
    if (!isDir(root)) continue;
    roots.push({ source: 'plugin', path: root, exists: true });
    for (const f of listAgentFiles(root)) read(f, 'plugin', pl.key, pl.scope === 'project' ? input.project?.id ?? null : null);
  }
  // nomes repetidos: projeto sobrepõe usuário (regra do Claude Code); plugins são prefixados, não colidem
  const seen = new Map<string, AgentDefinition>();
  for (const a of [...agents].sort((x, y) => (x.source === 'project' ? 0 : x.source === 'user' ? 1 : 2) - (y.source === 'project' ? 0 : y.source === 'user' ? 1 : 2))) {
    const prev = seen.get(a.name);
    if (prev) a.problems.push(`outro agente com o mesmo nome tem prioridade (${prev.source}: ${prev.path})`); else seen.set(a.name, a);
  }
  return { agents, roots, warnings };
}
