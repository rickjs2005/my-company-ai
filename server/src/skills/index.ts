// Serviço do catálogo de skills e agentes nativos. O ws.ts chama `handle` para mensagens 'skills.*' e 'agents.*';
// o SessionManager chama `resolve` ao executar uma tarefa com skill escolhida. Tudo é leitura de arquivos locais —
// nenhum comando embutido no conteúdo é executado. Adicionar skill local = copiar uma pasta validada para a origem
// pessoal ou do projeto (nunca por cima de uma existente).
import fs from 'node:fs';
import path from 'node:path';
import type { AgentCatalog, SkillAddResult, SkillCatalog, SkillFileContent, SkillInfo, SkillInspection, WorkClientMessage } from '@milweb-hq/protocol';
import type { Store } from '../store.js';
import { defaultClaudeHome, parseSkillFile, samePath, scanSkills, validSkillName, type PluginInstall, type ScanInput } from './catalog.js';
import { scanAgents } from './agents.js';

export { parseFrontmatter, hasShellInjection } from './frontmatter.js';
export { scanSkills, parseSkillFile, readSettings, readPlugins, validSkillName, defaultClaudeHome } from './catalog.js';
export { scanAgents, parseAgentFile } from './agents.js';

export interface SkillsServiceDeps {
  store: Store;
  /** Pasta de configuração do Claude Code (padrão ~/.claude; testes passam uma pasta descartável). */
  claudeHome?: string;
  claudeVersion?: () => string | null;
  codexStatus?: () => { installed: boolean; version: string | null } | null;
  broadcast?: (m: { kind: 'skills.changed' }) => void;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}

const CACHE_MS = 20_000;
const MAX_COPY_BYTES = 25 * 1024 * 1024;
const COPY_SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv']);

export class SkillsService {
  private cache = new Map<string, { at: number; catalog: SkillCatalog; plugins: PluginInstall[] }>();
  readonly claudeHome: string;

  constructor(private readonly deps: SkillsServiceDeps) {
    this.claudeHome = deps.claudeHome ?? defaultClaudeHome();
  }

  invalidate(): void { this.cache.clear(); }

  private projectOf(projectId: string | null | undefined): { id: string; path: string } | null {
    if (!projectId) return null;
    const p = this.deps.store.getProject(projectId);
    return p ? { id: p.id, path: p.path } : null;
  }

  private scanInput(projectId: string | null | undefined): ScanInput {
    const project = this.projectOf(projectId);
    const caps = project ? this.deps.store.getProviderCaps(project.id, 'claude') : null;
    const codex = this.deps.codexStatus?.() ?? null;
    return {
      claudeHome: this.claudeHome, project,
      caps: caps ? { skills: caps.caps.skills ?? [], slashCommands: caps.caps.slashCommands ?? [], at: caps.at } : null,
      claudeVersion: this.deps.claudeVersion?.() ?? null,
      codex: { installed: codex?.installed ?? false, version: codex?.version ?? null, skillsApi: false },
    };
  }

  /** Catálogo para um projeto (ou geral, sem skills de projeto). Cache curto; `refresh` força nova varredura. */
  catalog(projectId: string | null | undefined, refresh = false): SkillCatalog {
    const key = projectId ?? '';
    const hit = this.cache.get(key);
    if (hit && !refresh && Date.now() - hit.at < CACHE_MS) return hit.catalog;
    const scanned = scanSkills(this.scanInput(projectId));
    const { settingsFiles, plugins, ...catalog } = scanned;
    void settingsFiles;
    this.cache.set(key, { at: Date.now(), catalog, plugins });
    return catalog;
  }

  agents(projectId: string | null | undefined): AgentCatalog {
    this.catalog(projectId);
    const plugins = this.cache.get(projectId ?? '')?.plugins ?? [];
    return scanAgents({ claudeHome: this.claudeHome, project: this.projectOf(projectId), plugins });
  }

  /** Procura a skill pela invocação (aceita barra inicial). Devolve a de maior prioridade com esse nome. */
  async resolve(invocation: string, projectId: string | null): Promise<{ info: SkillInfo; content: string | null } | null> {
    const inv = invocation.trim().replace(/^\//, '');
    if (!inv) return null;
    const cat = this.catalog(projectId);
    const candidates = cat.skills.filter(s => s.invocation === inv || s.name === inv);
    const info = candidates.find(s => !s.shadowedBy) ?? candidates[0];
    if (!info) return null;
    let content: string | null = null;
    if (info.path) { try { content = fs.readFileSync(info.path, 'utf8'); } catch { content = null; } }
    return { info, content };
  }

  /** Conteúdo bruto de um SKILL.md/.md que esteja no catálogo (não lê arquivos arbitrários). */
  read(filePath: string, projectId: string | null | undefined): SkillFileContent {
    const target = path.resolve(filePath);
    const known = this.catalog(projectId).skills.some(s => s.path && samePath(s.path, target))
      || this.agents(projectId).agents.some(a => samePath(a.path, target));
    if (!known) throw new Error('esse arquivo não faz parte do catálogo de skills/agentes');
    return { path: target, content: fs.readFileSync(target, 'utf8') };
  }

  /** Valida uma pasta (ou um SKILL.md) sem copiar nada. */
  inspectLocal(rawPath: string): SkillInspection {
    const p = path.resolve(String(rawPath ?? '').trim());
    if (!rawPath || !String(rawPath).trim()) throw new Error('informe a pasta da skill (a que contém o SKILL.md)');
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { throw new Error(`caminho não existe: ${p}`); }
    const sourceDir = st.isDirectory() ? p : path.dirname(p);
    const file = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(file)) throw new Error(`não achei SKILL.md em ${sourceDir}`);
    const folderName = path.basename(sourceDir);
    const parsed = parseSkillFile(file, folderName);
    const problems = [...parsed.problems];
    if (!parsed.description) problems.push('description obrigatória para o Claude Code saber quando usar a skill');
    if (!validSkillName(parsed.name)) problems.push('nome inválido: use minúsculas, números e hifens (até 64 caracteres)');
    const files: string[] = []; let total = 0;
    const walk = (dir: string, rel: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (COPY_SKIP.has(d.name)) continue;
        const full = path.join(dir, d.name); const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isSymbolicLink()) { problems.push(`link simbólico ignorado na cópia: ${r}`); continue; }
        if (d.isDirectory()) walk(full, r);
        else if (d.isFile()) { files.push(r); total += fs.statSync(full).size; }
      }
    };
    walk(sourceDir, '');
    if (total > MAX_COPY_BYTES) problems.push(`pasta grande demais para copiar (${Math.round(total / 1024 / 1024)} MB; limite 25 MB)`);
    const fatal = problems.some(x => /nome inválido|description obrigatória|grande demais|sem fechamento/.test(x));
    return { ok: !fatal, sourceDir, name: parsed.name, description: parsed.description, problems, hasShellInjection: parsed.hasShellInjection, content: parsed.raw, files, totalBytes: total };
  }

  /** Copia a skill validada para a origem pessoal ou do projeto. Recusa sobrescrever e recusa copiar de dentro do destino. */
  addLocal(rawPath: string, scope: 'personal' | 'project', projectId: string | null | undefined): SkillAddResult {
    const insp = this.inspectLocal(rawPath);
    if (!insp.ok) throw new Error(`a skill não está válida: ${insp.problems.join('; ')}`);
    let root: string;
    if (scope === 'personal') root = path.join(this.claudeHome, 'skills');
    else {
      const project = this.projectOf(projectId);
      if (!project) throw new Error('escolha o projeto que vai receber a skill');
      if (!fs.existsSync(project.path)) throw new Error(`a pasta do projeto não existe: ${project.path}`);
      root = path.join(project.path, '.claude', 'skills');
    }
    const dest = path.join(root, insp.name);
    if (fs.existsSync(dest)) throw new Error(`já existe uma skill "${insp.name}" em ${root}; remova-a ou escolha outro nome`);
    if (samePath(insp.sourceDir, dest) || dest.toLowerCase().startsWith(insp.sourceDir.toLowerCase() + path.sep)) throw new Error('a origem está dentro do destino');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(dest);
    for (const rel of insp.files) {
      const from = path.join(insp.sourceDir, rel); const to = path.join(dest, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    this.invalidate();
    this.deps.log?.info(`skill "${insp.name}" copiada de ${insp.sourceDir} para ${dest}`);
    this.deps.broadcast?.({ kind: 'skills.changed' });
    const cat = this.catalog(scope === 'project' ? projectId : null, true);
    const info = cat.skills.find(s => s.path && samePath(s.path, path.join(dest, 'SKILL.md')));
    if (!info) throw new Error('a skill foi copiada, mas não apareceu no catálogo; confira a pasta ' + dest);
    return { info, destination: dest };
  }

  async handle(msg: WorkClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'skills.list': return this.catalog(msg.projectId ?? null, Boolean(msg.refresh));
      case 'skills.read': return this.read(msg.path, null);
      case 'skills.inspectLocal': return this.inspectLocal(msg.path);
      case 'skills.addLocal': return this.addLocal(msg.path, msg.scope, msg.projectId ?? null);
      case 'agents.list': return this.agents(msg.projectId ?? null);
      default: throw new Error(`mensagem não suportada pelo catálogo de skills: ${msg.type}`);
    }
  }
}

export function createSkillsService(deps: SkillsServiceDeps): SkillsService { return new SkillsService(deps); }
