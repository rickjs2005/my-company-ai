// Localiza o executável do Claude Code instalado (sem baixar nada, sem SDK embutido).
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export interface ClaudeInstall { exePath: string; version: string | null; source: 'env' | 'native' | 'path' }

export function locateClaude(): ClaudeInstall | null {
  const candidates: { p: string; source: ClaudeInstall['source'] }[] = [];
  if (process.env.MILWEB_HQ_CLAUDE_PATH) candidates.push({ p: process.env.MILWEB_HQ_CLAUDE_PATH, source: 'env' });
  const home = os.homedir();
  const ext = process.platform === 'win32' ? '.exe' : '';
  candidates.push({ p: path.join(home, '.local', 'bin', 'claude' + ext), source: 'native' });
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['claude'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const p of out) candidates.push({ p, source: 'path' });
  } catch { /* não está no PATH */ }
  for (const c of candidates) {
    if (!existsSync(c.p)) continue;
    let version: string | null = null;
    try { version = execFileSync(c.p, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim(); } catch { version = null; }
    return { exePath: c.p, version, source: c.source };
  }
  return null;
}
