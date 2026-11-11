// Normalização dos eventos reais do Claude Code em estados observáveis do "funcionário".
// Regra do briefing: a animação representa o que foi observado; nada de porcentagem, reunião ou token inventado.

import type { RawEvent } from './types.js';

export type WorkerPhase =
  | 'idle'                // sem turno ativo
  | 'thinking'            // turno ativo, sem ferramenta em uso, sem texto chegando
  | 'responding'          // texto da resposta chegando
  | 'reading'             // Read, Grep, Glob, WebFetch, WebSearch, ToolSearch...
  | 'writing'             // Write, Edit, MultiEdit, NotebookEdit
  | 'executing'           // Bash, PowerShell e tarefas locais
  | 'delegating'          // subagente real em execução (Agent/Task)
  | 'waiting_permission'  // pedido de permissão pendente
  | 'waiting_answer'      // AskUserQuestion pendente
  | 'done'                // turno encerrado com sucesso (transitório; vira idle)
  | 'error'               // turno encerrado com erro / interrompido
  | 'disconnected';       // processo morreu ou conexão perdida

export interface ActiveTool {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  summary: string;
  startedAt: number;
  parentToolUseId: string | null;
}

export interface ActiveTask {
  taskId: string;
  description: string;
  toolUseId?: string;
  subagentType?: string;
  taskType?: string;
  backgrounded: boolean;
  startedAt: number;
  lastToolName?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
}

export type LogKind = 'prompt' | 'text' | 'tool_start' | 'tool_end' | 'permission' | 'permission_decision' | 'question'
  | 'task_start' | 'task_end' | 'result' | 'error' | 'interrupt' | 'notice' | 'hook' | 'rate_limit' | 'compact';

export interface LogEntry {
  ts: number;
  kind: LogKind;
  summary: string;
  ok?: boolean;
  toolUseId?: string;
  data?: Record<string, unknown>;
}

export interface ActivityState {
  phase: WorkerPhase;
  detail: string;
  turnActive: boolean;
  activeTools: ActiveTool[];
  activeTasks: ActiveTask[];
  pendingPermissionIds: string[];
  pendingQuestionIds: string[];
  streamingText: string;
  lastResult?: { subtype: string; isError: boolean; terminalReason?: string; durationMs: number; numTurns: number };
  rateLimit?: { status: string; utilization?: number; resetsAt?: number; type?: string };
  textDeltaSeen: boolean;
}

export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'NotebookRead']);
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const EXEC_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
export const DELEGATE_TOOLS = new Set(['Agent', 'Task', 'Workflow']);

export function initialActivity(): ActivityState {
  return { phase: 'idle', detail: 'Disponível', turnActive: false, activeTools: [], activeTasks: [], pendingPermissionIds: [], pendingQuestionIds: [], streamingText: '', textDeltaSeen: false };
}

const basename = (p: unknown) => typeof p === 'string' ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p : '';
const trunc = (s: unknown, n = 90) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** Resumo curto e fiel do que a ferramenta vai fazer, a partir do input real. */
export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': return `Lendo ${basename(input.file_path)}`;
    case 'Write': return `Escrevendo ${basename(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editando ${basename(input.file_path)}`;
    case 'NotebookEdit': return `Editando notebook ${basename(input.notebook_path)}`;
    case 'Glob': return `Procurando arquivos ${trunc(input.pattern, 40)}`;
    case 'Grep': return `Buscando "${trunc(input.pattern, 40)}"`;
    case 'LS': return `Listando ${basename(input.path) || 'pasta'}`;
    case 'Bash': case 'PowerShell': return input.description ? `Executando: ${trunc(input.description, 70)}` : `Executando: ${trunc(input.command, 70)}`;
    case 'WebFetch': return `Abrindo ${trunc(input.url, 60)}`;
    case 'WebSearch': return `Pesquisando na web: ${trunc(input.query, 50)}`;
    case 'Agent': case 'Task': return `Delegando: ${trunc(input.description ?? input.prompt, 60)}`;
    case 'AskUserQuestion': return 'Perguntando ao Chefe';
    case 'TodoWrite': return 'Atualizando lista de tarefas';
    case 'Skill': return `Usando skill ${trunc(input.skill, 40)}`;
    default:
      if (name.startsWith('mcp__hq-navegador__')) {
        // Navegador da HQ: a sala mostra a conta e a etapa (pesquisando, lendo métricas, preparando mídia, publicando...).
        const tool = name.slice('mcp__hq-navegador__'.length);
        const etapas: Record<string, string> = { pesquisar: 'pesquisando', ler_metricas: 'lendo métricas', preparar: 'preparando mídia', publicar: 'publicando', verificar: 'verificando resultado' };
        const acoes: Record<string, string> = { contas: 'vendo as contas', abrir_conta: 'abrindo a conta', conferir_identidade: 'conferindo a conta', navegar: 'abrindo página', ler_pagina: 'lendo a página', clicar: 'clicando', preencher: 'preenchendo', teclar: 'teclando', anexar: 'preparando mídia', esperar_texto: 'esperando a página', capturar_tela: 'capturando a tela', publicar: 'publicando', verificar_publicacao: 'verificando resultado', registrar_resultado: 'lendo métricas', registrar_capacidade: 'registrando capacidade', fechar: 'fechando o navegador', pesquisar: 'pesquisando tendências', pesquisar_clicar: 'abrindo publicação', pesquisar_capturar: 'capturando referência' };
        if (tool.startsWith('pesquisar')) {
          let site = ''; try { site = typeof input.url === 'string' ? ` · ${new URL(input.url).hostname.replace(/^www\./, '')}` : ''; } catch { /* url inválida */ }
          return `Navegador${site}: ${acoes[tool] ?? tool}`;
        }
        const etapa = typeof input.etapa === 'string' ? etapas[input.etapa] : undefined;
        const conta = typeof input.conta === 'string' ? ` · ${input.conta}` : '';
        return `Navegador${conta}: ${tool === 'publicar' || tool === 'verificar_publicacao' || !etapa ? acoes[tool] ?? tool : etapa}`;
      }
      return name.startsWith('mcp__') ? `Usando ${name.replace(/^mcp__/, '').replace(/__/g, ' › ')}` : `Usando ${name}`;
  }
}

function phaseForTool(name: string): WorkerPhase {
  if (READ_TOOLS.has(name)) return 'reading';
  if (WRITE_TOOLS.has(name)) return 'writing';
  if (EXEC_TOOLS.has(name)) return 'executing';
  if (DELEGATE_TOOLS.has(name)) return 'delegating';
  if (name === 'AskUserQuestion') return 'waiting_answer';
  return 'executing';
}

function recomputePhase(s: ActivityState): void {
  if (s.phase === 'disconnected') return;
  if (s.pendingQuestionIds.length) { s.phase = 'waiting_answer'; s.detail = 'Aguardando sua resposta'; return; }
  if (s.pendingPermissionIds.length) { s.phase = 'waiting_permission'; s.detail = 'Aguardando permissão'; return; }
  if (!s.turnActive) {
    if (s.phase === 'done' || s.phase === 'error') return; // estados finais transitórios; a UI decide quando voltar a idle
    s.phase = 'idle'; s.detail = 'Disponível'; return;
  }
  if (s.activeTasks.some(t => t.subagentType)) {
    const t = s.activeTasks.find(x => x.subagentType)!;
    s.phase = 'delegating'; s.detail = `Subagente: ${trunc(t.description, 60)}`; return;
  }
  const tool = s.activeTools[s.activeTools.length - 1];
  if (tool) { s.phase = phaseForTool(tool.name); s.detail = tool.summary; return; }
  if (s.textDeltaSeen) { s.phase = 'responding'; s.detail = 'Escrevendo resposta'; return; }
  s.phase = 'thinking'; s.detail = 'Pensando';
}

export interface ReduceOutput { state: ActivityState; log: LogEntry[] }

/** Aplica um evento bruto do CLI ao estado. Retorna o novo estado e as entradas de registro geradas. */
export function reduceActivity(prev: ActivityState, ev: RawEvent, now = Date.now()): ReduceOutput {
  const s: ActivityState = { ...prev, activeTools: [...prev.activeTools], activeTasks: [...prev.activeTasks], pendingPermissionIds: [...prev.pendingPermissionIds], pendingQuestionIds: [...prev.pendingQuestionIds] };
  const log: LogEntry[] = [];
  const msg = ev.message as { content?: unknown } | undefined;

  switch (ev.type) {
    case 'hq_turn_started': { // evento sintético do bridge (não vem do CLI)
      s.turnActive = true; s.streamingText = ''; s.textDeltaSeen = false; s.phase = 'thinking';
      if (ev.auto) log.push({ ts: now, kind: 'notice', summary: 'Claude retomou o turno por conta própria (tarefa em segundo plano concluída)' });
      break;
    }
    case 'hq_prompt': {
      s.turnActive = true; s.streamingText = ''; s.textDeltaSeen = false;
      log.push({ ts: now, kind: 'prompt', summary: trunc(ev.text, 200), data: { text: ev.text } });
      break;
    }
    case 'hq_note': { // registro da HQ na linha do tempo (ex.: o que o processo confirmou ao iniciar)
      log.push({ ts: now, kind: 'notice', summary: trunc(ev.summary, 400) });
      break;
    }
    case 'hq_interrupt': {
      log.push({ ts: now, kind: 'interrupt', summary: 'Interrupção pedida pelo Chefe' });
      break;
    }
    case 'hq_disconnected': {
      s.phase = 'disconnected'; s.detail = String(ev.reason ?? 'Processo encerrado'); s.turnActive = false;
      s.activeTools = []; s.activeTasks = []; s.pendingPermissionIds = []; s.pendingQuestionIds = [];
      log.push({ ts: now, kind: 'error', summary: `Desconectado: ${s.detail}`, ok: false });
      return { state: s, log };
    }
    case 'stream_event': {
      const e = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
        s.streamingText += e.delta.text; s.textDeltaSeen = true; s.turnActive = true;
      }
      break;
    }
    case 'assistant': {
      s.turnActive = true;
      const blocks = Array.isArray(msg?.content) ? msg!.content as Record<string, unknown>[] : [];
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const name = String(b.name); const input = (b.input as Record<string, unknown>) ?? {};
          const summary = summarizeToolInput(name, input);
          s.activeTools.push({ toolUseId: String(b.id), name, input, summary, startedAt: now, parentToolUseId: (ev.parent_tool_use_id as string | null) ?? null });
          log.push({ ts: now, kind: 'tool_start', summary, toolUseId: String(b.id), data: { name, input } });
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          log.push({ ts: now, kind: 'text', summary: trunc(b.text, 200), data: { text: b.text } });
          s.streamingText = '';
        }
      }
      if ((ev as { error?: unknown }).error) log.push({ ts: now, kind: 'error', summary: `Erro da API: ${trunc(JSON.stringify((ev as { error?: unknown }).error), 160)}`, ok: false });
      break;
    }
    case 'user': {
      const blocks = Array.isArray(msg?.content) ? msg!.content as Record<string, unknown>[] : [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const id = String(b.tool_use_id);
          const idx = s.activeTools.findIndex(t => t.toolUseId === id);
          const tool = idx >= 0 ? s.activeTools[idx] : undefined;
          if (idx >= 0) s.activeTools.splice(idx, 1);
          const isError = Boolean(b.is_error);
          const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          log.push({ ts: now, kind: 'tool_end', summary: `${tool?.summary ?? 'Ferramenta'} — ${isError ? 'falhou' : 'concluído'}`, ok: !isError, toolUseId: id, data: { name: tool?.name, output: content.slice(0, 2000), isError } });
        } else if (b.type === 'text' && typeof b.text === 'string' && /^\[Request interrupted/.test(b.text)) {
          log.push({ ts: now, kind: 'interrupt', summary: 'Execução interrompida' });
        }
      }
      break;
    }
    case 'control_request': {
      const r = ev.request as Record<string, unknown>;
      if (r?.subtype === 'can_use_tool') {
        const id = String(ev.request_id);
        if (r.tool_name === 'AskUserQuestion') {
          s.pendingQuestionIds.push(id);
          const qs = ((r.input as { questions?: { question: string }[] })?.questions ?? []).map(q => q.question);
          log.push({ ts: now, kind: 'question', summary: `Pergunta: ${trunc(qs.join(' | '), 160)}`, data: { requestId: id, input: r.input } });
        } else {
          s.pendingPermissionIds.push(id);
          log.push({ ts: now, kind: 'permission', summary: `Permissão pedida: ${summarizeToolInput(String(r.tool_name), (r.input as Record<string, unknown>) ?? {})}`, data: { requestId: id, toolName: r.tool_name, input: r.input, reason: r.decision_reason } });
        }
      }
      break;
    }
    case 'hq_permission_resolved': {
      const id = String(ev.requestId);
      s.pendingPermissionIds = s.pendingPermissionIds.filter(x => x !== id);
      s.pendingQuestionIds = s.pendingQuestionIds.filter(x => x !== id);
      const res = ev.result as { behavior: string; message?: string };
      log.push({ ts: now, kind: 'permission_decision', summary: res.behavior === 'allow' ? 'Permissão concedida' : `Permissão negada${res.message ? ': ' + trunc(res.message, 80) : ''}`, ok: res.behavior === 'allow', data: { requestId: id } });
      break;
    }
    case 'system': {
      switch (ev.subtype) {
        case 'task_started': {
          s.activeTasks.push({ taskId: String(ev.task_id), description: String(ev.description ?? ''), toolUseId: ev.tool_use_id as string | undefined, subagentType: ev.subagent_type as string | undefined, taskType: ev.task_type as string | undefined, backgrounded: Boolean(ev.is_backgrounded), startedAt: now });
          log.push({ ts: now, kind: 'task_start', summary: `${ev.subagent_type ? 'Subagente' : 'Tarefa'} iniciada: ${trunc(ev.description, 100)}${ev.is_backgrounded ? ' (segundo plano)' : ''}`, data: { taskId: ev.task_id, subagentType: ev.subagent_type } });
          break;
        }
        case 'task_progress': {
          const t = s.activeTasks.find(x => x.taskId === ev.task_id);
          if (t) { t.lastToolName = ev.last_tool_name as string | undefined; t.usage = ev.usage as ActiveTask['usage']; }
          break;
        }
        case 'task_notification': {
          const idx = s.activeTasks.findIndex(x => x.taskId === ev.task_id);
          const t = idx >= 0 ? s.activeTasks[idx] : undefined;
          if (idx >= 0) s.activeTasks.splice(idx, 1);
          const status = String(ev.status);
          log.push({ ts: now, kind: 'task_end', summary: `${t?.subagentType ? 'Subagente' : 'Tarefa'} ${status === 'completed' ? 'concluída' : status === 'failed' ? 'falhou' : 'parada'}: ${trunc(ev.summary ?? t?.description, 100)}`, ok: status === 'completed', data: { taskId: ev.task_id, status, usage: ev.usage } });
          break;
        }
        case 'permission_denied':
          log.push({ ts: now, kind: 'permission_decision', summary: `Ferramenta negada automaticamente: ${String(ev.tool_name)}${ev.decision_reason ? ' — ' + trunc(ev.decision_reason, 80) : ''}`, ok: false });
          break;
        case 'notification':
          log.push({ ts: now, kind: 'notice', summary: trunc(ev.text, 160) });
          break;
        case 'informational':
          log.push({ ts: now, kind: 'notice', summary: trunc(ev.content, 160), data: { level: ev.level } });
          break;
        case 'compact_boundary':
          log.push({ ts: now, kind: 'compact', summary: 'Contexto compactado pelo Claude Code' });
          break;
        case 'hook_response':
          if (ev.outcome === 'error') log.push({ ts: now, kind: 'hook', summary: `Hook ${String(ev.hook_name)} falhou`, ok: false, data: { stderr: ev.stderr } });
          break;
        case 'control_request_progress':
          if (ev.status === 'api_retry') log.push({ ts: now, kind: 'notice', summary: `API instável: nova tentativa ${ev.attempt ?? '?'}/${ev.max_retries ?? '?'}` });
          break;
        default: break;
      }
      break;
    }
    case 'rate_limit_event': {
      const info = ev.rate_limit_info as { status?: string; rateLimitType?: string; resetsAt?: number; unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } | undefined;
      if (info) {
        const w = info.unifiedWindows?.five_hour;
        s.rateLimit = { status: String(info.status ?? ''), type: info.rateLimitType, utilization: w?.utilization, resetsAt: w?.resetsAt ?? info.resetsAt };
        if (info.status && info.status !== 'allowed') log.push({ ts: now, kind: 'rate_limit', summary: `Limite de uso reportado pelo Claude: ${info.status}`, ok: false, data: { ...info } });
      }
      break;
    }
    case 'result': {
      const isError = Boolean(ev.is_error);
      const subtype = String(ev.subtype);
      const terminal = ev.terminal_reason as string | undefined;
      s.turnActive = false; s.activeTools = []; s.activeTasks = s.activeTasks.filter(t => t.backgrounded);
      s.pendingPermissionIds = []; s.pendingQuestionIds = []; s.streamingText = ''; s.textDeltaSeen = false;
      s.lastResult = { subtype, isError, terminalReason: terminal, durationMs: Number(ev.duration_ms ?? 0), numTurns: Number(ev.num_turns ?? 0) };
      const interrupted = terminal === 'aborted_streaming' || terminal === 'aborted_tools';
      if (interrupted) { s.phase = 'idle'; s.detail = 'Interrompido'; log.push({ ts: now, kind: 'result', summary: 'Turno interrompido', ok: false, data: { subtype, terminal } }); }
      else if (isError) { s.phase = 'error'; s.detail = trunc((ev.errors as string[] | undefined)?.[0] ?? subtype, 120); log.push({ ts: now, kind: 'error', summary: `Turno terminou com erro (${subtype})`, ok: false, data: { errors: ev.errors } }); }
      else { s.phase = 'done'; s.detail = 'Resposta pronta'; log.push({ ts: now, kind: 'result', summary: `Resposta pronta em ${Math.round(Number(ev.duration_ms ?? 0) / 1000)} s (${ev.num_turns} passos)`, ok: true, data: { subtype, durationMs: ev.duration_ms, numTurns: ev.num_turns, costUsd: ev.total_cost_usd } }); }
      return { state: s, log };
    }
    default: break;
  }
  recomputePhase(s);
  return { state: s, log };
}
