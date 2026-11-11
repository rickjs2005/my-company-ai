// Acessos dos funcionários (Marco 0): o que um processo do Claude Code ou do Codex lançado pela HQ herda da conta do Chefe.
// Antes, todo funcionário herdava TODOS os servidores MCP do usuário (conectores do claude.ai, plugins, MCPs locais) e as
// credenciais do terminal (gh logado com repo/workflow, Git Credential Manager, login do Vercel). Agora:
//  - MCP: nenhum por padrão (--strict-mcp-config com lista vazia). "Herdar os do usuário" é escolha explícita no perfil.
//  - Integrações (GitHub, git push, Vercel): bloqueadas para todos até a Central de Conexões (Marco 2). Duas camadas:
//      1) regras de negação do Claude Code (--disallowedTools): o comando nem chega a pedir permissão;
//      2) ambiente sem credenciais: gh sem login (GH_CONFIG_DIR vazio), git sem credential helper nem prompt, sem SSH,
//         sem tokens em variáveis. Vale mesmo quando o comando escapa da regra (ex.: dentro de um script).
// Limite que continua (e aparece na tela): o processo roda como o mesmo usuário do Windows. Um agente determinado ainda
// poderia ler arquivos de credenciais do perfil ou chamar APIs por conta própria; isto evita uso acidental e o caminho
// direto, não é um cofre. Isolamento forte exigiria outra conta do Windows ou sandbox (fora do escopo).
import fs from 'node:fs';
import path from 'node:path';
import type { EmployeeAccess } from '@milweb-hq/protocol';

export const DEFAULT_ACCESS: EmployeeAccess = { mcp: 'none' };

/** Regras de negação (sintaxe de permissão do Claude Code: prefixo com ":*"). */
export const DENIED_COMMANDS = [
  'Bash(gh:*)', 'Bash(gh.exe:*)', 'Bash(git push:*)', 'Bash(vercel:*)', 'Bash(npx vercel:*)', 'Bash(npx -y vercel:*)', 'Bash(pnpm dlx vercel:*)',
];

/** Variáveis com token que nunca passam para um funcionário. */
const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'NETLIFY_AUTH_TOKEN', 'CLOUDFLARE_API_TOKEN'];

export function normalizeAccess(v: unknown): EmployeeAccess {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<EmployeeAccess>;
  return { mcp: o.mcp === 'inherit' ? 'inherit' : 'none', ...(o.browser === true ? { browser: true } : {}), ...(o.web === true ? { web: true } : {}) };
}

/** Servidor MCP do navegador da HQ para um funcionário com acesso ao navegador (token desta conversa). */
export interface BrowserMcp { command: string; args: string[]; url: string; token: string }
export const BROWSER_MCP_NAME = 'hq-navegador';

/** Argumentos do Claude Code para a política: MCP (estrito ou herdado) + negações de integrações. */
export function claudeAccessArgs(access: EmployeeAccess, browser?: BrowserMcp | null): string[] {
  const args: string[] = [];
  // Navegador da HQ: só para quem tem o acesso; as ferramentas ficam liberadas porque a porta de publicação da HQ é quem confere
  // aprovação, conta e texto (o funcionário não publica fora dela).
  const servers = access.browser && browser ? { [BROWSER_MCP_NAME]: { type: 'stdio', command: browser.command, args: browser.args, env: { HQ_BROWSER_URL: browser.url, HQ_BROWSER_TOKEN: browser.token } } } : {};
  if (access.mcp !== 'inherit') args.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: servers }));
  else if (Object.keys(servers).length) args.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
  // Ferramentas liberadas sem pedido: o navegador da HQ (porta de publicação confere tudo) e, para quem tem o acesso "web",
  // só a pesquisa de leitura (WebSearch e WebFetch). Nada de terminal, edição fora da pasta nem integrações.
  const allowed = [...(Object.keys(servers).length ? [`mcp__${BROWSER_MCP_NAME}`] : []), ...(access.web ? ['WebSearch', 'WebFetch'] : [])];
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  args.push('--disallowedTools', DENIED_COMMANDS.join(','));
  return args;
}

/**
 * Ambiente sem credenciais de integração. `isolationDir` guarda uma pasta de configuração do gh vazia (sem login).
 * O git continua funcionando localmente (status, diff, commit); só não acha credencial nem chave para falar com o remoto.
 */
export function isolatedEnv(base: NodeJS.ProcessEnv, isolationDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of TOKEN_VARS) delete env[k];
  const ghDir = path.join(isolationDir, 'gh');
  try { fs.mkdirSync(ghDir, { recursive: true }); } catch { /* sem pasta: o gh cai no padrão e a regra de negação ainda vale */ }
  env.GH_CONFIG_DIR = ghDir;
  env.GH_PROMPT_DISABLED = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  // Esvazia a lista de credential helpers (valor vazio = reset) e corta o SSH do git.
  env.GIT_CONFIG_COUNT = '2';
  env.GIT_CONFIG_KEY_0 = 'credential.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  env.GIT_CONFIG_KEY_1 = 'core.sshCommand';
  env.GIT_CONFIG_VALUE_1 = 'false';
  env.GIT_SSH_COMMAND = 'false';
  env.MILWEB_HQ_ISOLATED = '1';
  return env;
}

/** Resumo legível para o perfil do funcionário (a tela mostra exatamente isto). */
export function accessSummary(access: EmployeeAccess): { item: string; state: string }[] {
  return [
    { item: 'Servidores MCP', state: access.mcp === 'inherit' ? 'herda todos os do usuário (conectores do claude.ai, plugins e MCPs locais)' : 'nenhum' },
    ...(access.web ? [{ item: 'Pesquisa na web', state: 'liberada só para leitura (WebSearch e WebFetch), para o Radar' }] : []),
    { item: 'GitHub, git push e Vercel', state: 'bloqueados (sem credenciais e com regra de negação) até a Central de Conexões' },
    { item: 'Terminal', state: 'comandos locais no projeto, com as permissões normais' },
  ];
}
