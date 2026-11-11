// Helpers puros do compositor único "O que vamos fazer?" (sem React/DOM, para rodarem em web/test).
// Rascunho persistente, sugestão de funcionário rotulada, disponibilidade de skill por provedor e lista do que falta.
import type { AiProviderId, AiProviderStatus, EffortLevel, Employee, Project, Room, Settings, SkillInfo, Task, Worker } from '@milweb-hq/protocol';
import { EFFORT_LABELS, isEffortLevel, isSocialSlot } from '@milweb-hq/protocol';

export const DRAFT_KEY = 'milweb-hq.composer.draft.v1';
export const FAVORITES_KEY = 'milweb-hq.skills.favorites.v1';

/** ultracode: configuração do Claude Code (muitos subagentes), separada do esforço; o esforço escolhido continua valendo. */
export interface ComposerOptions { model: string | null; effort: EffortLevel | null; permissionMode: string | null; ultracode: boolean }

export interface ComposerDraft {
  text: string;
  projectId: string | null;
  employeeId: string | null;
  /** Invocação da skill; null = Automática. */
  skill: string | null;
  options: ComposerOptions;
  /** Marco 1: arquivos de contexto (caminhos relativos ao projeto escolhido), entregues por referência. */
  contextFiles: string[];
  /** Sala Social Media: destino da peça (organiza o mural; não publica nada). */
  destination?: string | null;
  /** Identidade do pedido: o servidor nunca cria duas tarefas com o mesmo clientId (duplo clique, reconexão, F5). */
  clientId: string;
  /** Projeto escolhido antes de entrar numa sala travada (volta ao sair dela). undefined = nenhuma trava ativa. */
  projectBeforeLock?: string | null;
}

export const EMPTY_OPTIONS: ComposerOptions = { model: null, effort: null, permissionMode: null, ultracode: false };

export function emptyDraft(clientId: string): ComposerDraft {
  return { text: '', projectId: null, employeeId: null, skill: null, options: { ...EMPTY_OPTIONS }, contextFiles: [], clientId };
}

/** Lê o rascunho salvo com tolerância a lixo (campos ausentes voltam ao padrão; clientId ausente ganha um novo). */
export function parseDraft(raw: string | null | undefined, newId: () => string): ComposerDraft {
  const base = emptyDraft(newId());
  if (!raw) return base;
  try {
    const d = JSON.parse(raw) as Partial<ComposerDraft> | null;
    if (!d || typeof d !== 'object') return base;
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
    const opts = (d.options && typeof d.options === 'object' ? d.options : {}) as Partial<ComposerOptions>;
    return {
      text: typeof d.text === 'string' ? d.text : '',
      projectId: str(d.projectId), employeeId: str(d.employeeId), skill: str(d.skill),
      options: { model: str(opts.model), effort: isEffortLevel(opts.effort) ? opts.effort : null, permissionMode: str(opts.permissionMode), ultracode: opts.ultracode === true },
      destination: isSocialSlot(d.destination) ? d.destination : null,
      contextFiles: Array.isArray(d.contextFiles) ? d.contextFiles.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 20) : [],
      clientId: str(d.clientId) ?? base.clientId,
      ...('projectBeforeLock' in d ? { projectBeforeLock: str(d.projectBeforeLock) } : {}),
    };
  } catch { return base; }
}

export function serializeDraft(d: ComposerDraft): string { return JSON.stringify(d); }

/** Sala travada numa pasta (05/11/2026): na sala Social Media o projeto é sempre a pasta de conteúdo; ao sair dela volta o projeto
 *  que estava escolhido antes. Devolve a mudança do rascunho, ou null quando nada muda (ou a pasta da sala ainda não chegou). */
export function applyProjectLock(d: ComposerDraft, lockedId: string | null, projects: Pick<Project, 'id'>[]): Partial<ComposerDraft> | null {
  if (lockedId) {
    if (d.projectId === lockedId || !projects.some(p => p.id === lockedId)) return null;
    return { projectId: lockedId, contextFiles: [], projectBeforeLock: d.projectBeforeLock !== undefined ? d.projectBeforeLock : d.projectId };
  }
  if (d.projectBeforeLock === undefined) return null;
  return { projectId: d.projectBeforeLock, contextFiles: [], projectBeforeLock: undefined };
}

/** O que ainda falta para "Executar tarefa" funcionar, na ordem em que aparece na interface. */
export function missingItems(d: Pick<ComposerDraft, 'text' | 'projectId' | 'employeeId'>, employees: Employee[], projects: Project[]): string[] {
  const out: string[] = [];
  if (!d.text.trim()) out.push('o pedido (escreva o que vamos fazer)');
  if (!d.projectId) out.push('o projeto');
  else if (!projects.some(p => p.id === d.projectId)) out.push('um projeto válido (o escolhido não existe mais)');
  if (!d.employeeId) out.push('o funcionário');
  else if (!employees.some(e => e.id === d.employeeId && !e.archivedAt)) out.push('um funcionário ativo (o escolhido foi arquivado ou não existe mais)');
  return out;
}

export interface EmployeeSuggestion { id: string; reason: string }

/**
 * Sugestão rotulada de funcionário (nunca escolhe sozinha): skill preferida > sala do projeto (livre primeiro) > quem está livre > único.
 * null quando não há funcionário ativo.
 */
export function suggestEmployee(input: { employees: Employee[]; workers: Worker[]; project: Project | null; rooms: Room[]; skill: string | null; roomId?: string | null }): EmployeeSuggestion | null {
  const active = input.employees.filter(e => !e.archivedAt);
  if (active.length === 0) return null;
  const isFree = (e: Employee) => { const w = input.workers.find(x => x.id === e.id); return !w || !w.busy; };
  if (input.skill) {
    const bySkill = active.filter(e => e.skills?.some(s => s.replace(/^\//, '') === input.skill!.replace(/^\//, '')));
    const pick = bySkill.find(isFree) ?? bySkill[0];
    if (pick) return { id: pick.id, reason: `tem /${input.skill.replace(/^\//, '')} entre as skills preferidas${isFree(pick) ? ' e está livre' : ''}` };
  }
  if (input.project) {
    const room = input.rooms.find(r => r.id === input.project!.roomId);
    const inRoom = active.filter(e => e.roomId === input.project!.roomId);
    const pick = inRoom.find(isFree) ?? inRoom[0];
    if (pick) return { id: pick.id, reason: `trabalha na sala do projeto${room ? ` (${room.name})` : ''}${isFree(pick) ? ' e está livre' : ', mas está ocupado'}` };
  }
  // Sala onde o Chefe está (ex.: Social Media): quem trabalha nela vem antes de qualquer outro livre.
  if (input.roomId) {
    const room = input.rooms.find(r => r.id === input.roomId);
    const inRoom = active.filter(e => e.roomId === input.roomId);
    const pick = inRoom.find(isFree) ?? inRoom[0];
    if (pick) return { id: pick.id, reason: `trabalha nesta sala${room ? ` (${room.name})` : ''}${isFree(pick) ? ' e está livre' : ', mas está ocupado'}` };
  }
  const free = active.find(isFree);
  if (free) return { id: free.id, reason: active.length === 1 ? 'único funcionário contratado' : 'está livre agora' };
  return { id: active[0].id, reason: active.length === 1 ? 'único funcionário contratado (ocupado: a tarefa entra na fila)' : 'todos estão ocupados; a tarefa entra na fila' };
}

export const PROVIDER_SHORT: Record<AiProviderId, string> = { claude: 'Claude', openai: 'OpenAI (Codex)' };

/** Pode esta skill ser pedida para este provedor? Devolve o motivo quando não. */
export function skillAvailability(s: SkillInfo, provider: AiProviderId): { ok: boolean; reason: string | null } {
  if (s.disabled) return { ok: false, reason: 'desativada nas configurações do Claude Code (skillOverrides: off)' };
  if (s.shadowedBy) return { ok: false, reason: `outra skill com o mesmo nome tem prioridade (${s.shadowedBy})` };
  const sup = s.providers?.[provider];
  if (!sup) return { ok: false, reason: `sem informação de suporte para ${PROVIDER_SHORT[provider]}` };
  if (sup.mode === 'unavailable') return { ok: false, reason: sup.detail || `não disponível para ${PROVIDER_SHORT[provider]}` };
  return { ok: true, reason: null };
}

/** Opções de skill do compositor: visíveis para o projeto (sem sombreadas), filtradas por texto; favoritas (por id) primeiro, depois ordem alfabética. */
export function skillOptionsFor(skills: readonly SkillInfo[], query: string, projectId: string | null, favorites: readonly string[] = []): SkillInfo[] {
  const q = query.trim().toLowerCase();
  const fav = new Set(favorites);
  return skills
    .filter(s => !s.shadowedBy)
    .filter(s => !s.projectId || s.projectId === projectId)
    .filter(s => !q || s.invocation.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    .sort((a, b) => Number(fav.has(b.id)) - Number(fav.has(a.id)) || a.invocation.localeCompare(b.invocation));
}

/** Resumo em uma linha do que vale para a próxima conversa (opções da tarefa > funcionário > padrão global > provedor). */
export function optionsSummary(input: { options: ComposerOptions; employee: Employee | null; settings: Settings; status: AiProviderStatus | null }): string {
  const { options, employee, settings } = input;
  const provider: AiProviderId = employee?.provider ?? 'claude';
  const global = settings.ai?.[provider] ?? { model: null, effort: null };
  const model = options.model ?? employee?.model ?? global.model;
  const modelSrc = options.model ? 'tarefa' : employee?.model ? 'funcionário' : global.model ? 'padrão global' : 'provedor';
  const effort = options.effort ?? employee?.effort ?? global.effort;
  const effortSrc = options.effort ? 'tarefa' : employee?.effort ? 'funcionário' : global.effort ? 'padrão global' : 'provedor';
  const mode = options.permissionMode ?? employee?.permissionMode ?? settings.defaultPermissionMode;
  const modeSrc = options.permissionMode ? 'tarefa' : employee ? 'funcionário' : 'padrão global';
  const modelLabel = model ? (input.status?.models.find(m => m.id === model)?.label ?? model) : 'padrão do provedor';
  const effortText = effort ? (EFFORT_LABELS[effort] ?? effort) : 'padrão';
  return `modelo ${modelLabel} (${modelSrc}) · esforço ${effortText} (${effortSrc}) · modo ${mode} (${modeSrc})${options.ultracode ? ' · Ultracode ligado (tarefa)' : ''}`;
}

export type ConfigState = 'confirmado' | 'enviado, não confirmado' | 'aguardando o início' | 'padrão';
export interface ConfigLine { item: string; value: string; state: ConfigState; detail?: string }

/**
 * Configuração da tarefa linha a linha, com o estado da evidência. Só o que o Claude Code informou no início do processo
 * (modelo, modo de permissão, MCP) aparece como "confirmado"; esforço e Ultracode o CLI não informa: "enviado, não confirmado".
 */
export function taskConfigLines(t: Pick<Task, 'applied' | 'requested' | 'evidence' | 'status' | 'provider'>): ConfigLine[] {
  const ev = t.evidence ?? null;
  const applied = t.applied ?? null;
  const waiting: ConfigState = 'aguardando o início';
  const lines: ConfigLine[] = [];
  lines.push(ev?.model
    ? { item: 'Modelo', value: ev.model, state: 'confirmado', detail: `informado pelo Claude Code ao iniciar (${ev.source})` }
    : { item: 'Modelo', value: applied?.model ?? 'padrão do provedor', state: t.status === 'queued' ? waiting : 'enviado, não confirmado' });
  lines.push(ev?.permissionMode
    ? { item: 'Permissões', value: ev.permissionMode, state: 'confirmado' }
    : { item: 'Permissões', value: applied?.permissionMode ?? 'padrão', state: t.status === 'queued' ? waiting : 'enviado, não confirmado' });
  const effort = ev ? ev.sentEffort : applied?.effort ?? null;
  lines.push(effort
    ? { item: 'Esforço', value: EFFORT_LABELS[effort as EffortLevel] ?? effort, state: 'enviado, não confirmado', detail: 'o Claude Code não informa o esforço na resposta' }
    : { item: 'Esforço', value: 'padrão do modelo', state: 'padrão' });
  const ultra = ev ? ev.sentUltracode : Boolean(applied?.ultracode);
  if (ultra || t.requested?.ultracode) lines.push({ item: 'Ultracode', value: 'ligado', state: ev ? 'enviado, não confirmado' : waiting, detail: 'o Claude Code não informa se o Ultracode foi aplicado' });
  if (ev) lines.push({ item: 'Servidores MCP', value: ev.mcpServers.length ? ev.mcpServers.join(', ') : 'nenhum', state: 'confirmado' });
  return lines;
}

export function loadFavorites(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
