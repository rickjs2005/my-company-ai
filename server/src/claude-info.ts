// Inspeciona a instalação real do Claude Code: executável, versão e método de autenticação (assinatura x API key).
import { execFile } from 'node:child_process';
import { locateClaude, sanitizedEnv } from '@milweb-hq/claude-bridge';
import type { ServerInfo } from '@milweb-hq/protocol';

export interface ClaudeInfo {
  exePath: string | null;
  version: string | null;
  authOk: boolean | null;
  authDetail: string | null;
  apiKeyInEnv: boolean;
  subscriptionType?: string | null;
}

export function childEnv(): NodeJS.ProcessEnv {
  const env = sanitizedEnv();
  // Com ANTHROPIC_API_KEY no ambiente o CLI cobraria na API e não na assinatura (docs: authentication). A HQ nunca faz isso em silêncio.
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
  return env;
}

function run(exe: string, args: string[], timeoutMs = 45_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(exe, args, { env: childEnv(), windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? null : 0;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
    });
  });
}

export async function probeClaude(exeOverride?: string): Promise<ClaudeInfo> {
  const apiKeyInEnv = Boolean(process.env.ANTHROPIC_API_KEY);
  const install = exeOverride ? { exePath: exeOverride, version: null, source: 'env' as const } : locateClaude();
  if (!install) return { exePath: null, version: null, authOk: null, authDetail: 'Claude Code não encontrado (esperado em ~/.local/bin/claude.exe ou no PATH)', apiKeyInEnv };
  let version = install.version;
  if (!version) { const v = await run(install.exePath, ['--version'], 30_000); version = v.stdout.trim() || null; }
  // "2.1.316 (Claude Code)" → "2.1.316": a tela já escreve "Claude Code" antes da versão.
  if (version) version = version.replace(/\s*\(Claude Code\)\s*$/i, '') || version;
  const auth = await run(install.exePath, ['auth', 'status', '--json']);
  let authOk: boolean | null = null; let authDetail: string | null = null; let subscriptionType: string | null = null;
  try {
    const info = JSON.parse(auth.stdout.trim()) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string };
    authOk = Boolean(info.loggedIn);
    subscriptionType = info.subscriptionType ?? null;
    authDetail = info.loggedIn ? `${info.authMethod ?? 'login'}${info.subscriptionType ? ' · ' + info.subscriptionType : ''}` : 'Não está logado: rode `claude` no terminal e faça /login';
  } catch {
    authDetail = (auth.stderr || auth.stdout || 'não foi possível ler `claude auth status`').trim().slice(0, 300);
  }
  return { exePath: install.exePath, version, authOk, authDetail, apiKeyInEnv, subscriptionType };
}

export function toServerInfo(info: ClaudeInfo, extra: Omit<ServerInfo, 'claudeExePath' | 'claudeVersion' | 'authOk' | 'authDetail' | 'apiKeyInEnv'>): ServerInfo {
  return { ...extra, claudeExePath: info.exePath, claudeVersion: info.version, authOk: info.authOk, authDetail: info.authDetail, apiKeyInEnv: info.apiKeyInEnv };
}

/** Sessões ativas do Claude Code nesta máquina (forma oficial: `claude agents --json`). */
export interface ExternalAgent { id?: string; pid?: number; cwd: string; kind: 'interactive' | 'background' | string; startedAt?: number; sessionId: string; name?: string; status?: string; state?: string }
export async function listClaudeAgents(exePath: string): Promise<ExternalAgent[]> {
  const r = await run(exePath, ['agents', '--json', '--all'], 30_000);
  try { const arr = JSON.parse(r.stdout.trim()); return Array.isArray(arr) ? arr as ExternalAgent[] : []; } catch { return []; }
}
