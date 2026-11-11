// Tipos do protocolo stream-json do Claude Code (modo -p) observados na versão 2.1.314
// e confirmados pelas definições do @anthropic-ai/claude-agent-sdk 0.3.314 (sdk.d.ts).
// Nada aqui é inventado: cada campo foi visto no fluxo real ou na tipagem do SDK.

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'thinking'; thinking?: string }
  | { type: string; [k: string]: unknown };

/** Mensagem de usuário aceita no stdin (SDKUserMessage). */
export interface UserMessageInput {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: string | null;
  session_id?: string;
  priority?: 'now' | 'next' | 'later';
}

/** Regras de permissão que o CLI sugere ao pedir aprovação (PermissionUpdate). */
export type PermissionUpdate =
  | { type: 'addRules' | 'replaceRules' | 'removeRules'; rules: { toolName: string; ruleContent?: string }[]; behavior: 'allow' | 'deny' | 'ask'; destination: string }
  | { type: 'setMode'; mode: PermissionMode; destination: string }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: string };

/** Pedido de permissão vindo do CLI (control_request / can_use_tool). */
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  displayName?: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  description?: string;
  title?: string;
  decisionReason?: string;
  decisionReasonType?: string;
  permissionSuggestions?: PermissionUpdate[];
  blockedPath?: string;
  requiresUserInteraction?: boolean;
  agentId?: string;
  receivedAt: number;
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export interface InitInfo {
  sessionId: string;
  model: string;
  permissionMode: string;
  cwd: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  claudeCodeVersion?: string;
  skills?: string[];
  plugins?: { name: string; version?: string }[];
  slashCommands?: string[];
  apiKeySource?: string;
}

export interface ResultInfo {
  subtype: string; // success | error_during_execution | error_max_turns | ...
  isError: boolean;
  numTurns: number;
  durationMs: number;
  stopReason: string | null;
  terminalReason?: string; // completed | aborted_streaming | aborted_tools | ...
  resultText: string;
  errors: string[];
  permissionDenials: { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }[];
  totalCostUsd?: number;
  usage?: Record<string, unknown>;
  sessionId: string;
}

export type ProcessState = 'starting' | 'idle' | 'running' | 'requires_action' | 'exited';

export interface RawEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  [k: string]: unknown;
}

export interface BridgeOptions {
  /** Caminho do executável (claude.exe). Para testes pode ser o node com commandPrefixArgs. */
  exePath: string;
  commandPrefixArgs?: string[];
  cwd: string;
  model?: string;
  /** Nível de esforço (--effort low|medium|high|xhigh|max); o CLI valida contra o modelo. */
  effort?: string;
  /** Lista de ferramentas disponíveis (--tools "Read,Glob,Grep"); undefined = conjunto padrão do CLI. */
  tools?: string[];
  permissionMode?: PermissionMode;
  /** Retomar sessão existente pelo id. */
  resume?: string;
  /** Criar sessão nova com id fixo (UUID). */
  sessionId?: string;
  sessionName?: string;
  appendSystemPrompt?: string;
  includeHookEvents?: boolean;
  includePartialMessages?: boolean;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Tempo máximo esperando uma resposta de controle (interrupt, set_model...). */
  controlTimeoutMs?: number;
}
