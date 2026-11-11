// Skill Watch (plugin watch@claude-video, instalado pelo Chefe em 07/11/2026) rodada pela própria HQ sobre a referência de
// vídeo: baixa (sem cookies) ou lê o arquivo local, escolhe quadros por mudança de cena com o tempo de cada um e pega a
// legenda nativa quando existe. Motor "local" (nada sai da máquina; o motor Gemini e a transcrição em nuvem ficam de fora,
// porque pedem chave e enviam o vídeo para terceiros). Os funcionários não rodam scripts (cada comando pede autorização do
// Chefe): a HQ roda a Watch e entrega o relatório e os quadros, dentro da pasta da referência.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface WatchTool { python: string; script: string; version: string | null }

export interface WatchRun {
  ok: boolean;
  /** relatorio.md (saída da Watch) na pasta indicada. */
  report: string | null;
  frames: { file: string; t: string }[];
  /** Linha "Transcript" do relatório (ex.: "6 segments (via captions (en, manual, unknown))" ou "none"). */
  transcript: string | null;
  /** Vídeo que a Watch baixou (quando veio por link). */
  localMedia: string | null;
  error: string | null;
}

/** Acha a Watch instalada como plugin do Claude Code (installed_plugins.json) e o Python 3.10+. null = não instalada. */
export function findWatch(claudeHome: string, which: (cmd: string) => string | null): WatchTool | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, { installPath?: string; version?: string }[]> };
    const entries = j.plugins?.['watch@claude-video'] ?? [];
    for (const e of entries) {
      const script = e.installPath ? path.join(e.installPath, 'skills', 'watch', 'scripts', 'watch.py') : null;
      if (!script || !fs.existsSync(script)) continue;
      const python = which('python') ?? which('py');
      if (!python || /WindowsApps/i.test(python)) return null;
      return { python, script, version: e.version ?? null };
    }
  } catch { /* sem plugins */ }
  return null;
}

/** Lê o relatório da Watch (markdown): quadros com o tempo, linha da transcrição e o vídeo local. */
export function parseWatchReport(md: string): { frames: { file: string; t: string }[]; transcript: string | null; localMedia: string | null } {
  const frames = [...md.matchAll(/^- `([^`]+\.(?:jpe?g|png))` \(t=([\d:.]+)/gim)].map(m => ({ file: m[1], t: m[2] }));
  const transcript = md.match(/^- \*\*Transcript:\*\* (.+)$/m)?.[1]?.trim() ?? null;
  const localMedia = md.match(/^- \*\*Local media:\*\* `([^`]+)`/m)?.[1] ?? null;
  return { frames, transcript, localMedia };
}

function run(cmd: string, args: string[], o: { timeoutMs: number; cwd: string }): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(resolve => {
    let p: ReturnType<typeof spawn>;
    try { p = spawn(cmd, args, { cwd: o.cwd, windowsHide: true, shell: false, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }); } catch (e) { resolve({ code: -1, out: '', err: (e as Error).message }); return; }
    let out = ''; let err = '';
    const t = setTimeout(() => { try { p.kill(); } catch { /* já saiu */ } err += `\n(tempo esgotado: ${Math.round(o.timeoutMs / 1000)} s)`; }, o.timeoutMs);
    p.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); if (out.length > 2_000_000) out = out.slice(-2_000_000); });
    p.stderr?.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-20_000); });
    p.on('error', e => { err += e.message; });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/**
 * Roda a Watch sobre um link ou arquivo. Saída em `<dir>/watch/` (a Watch cria a subpasta da execução); o relatório fica em
 * `<dir>/watch/relatorio.md`. Uma execução anterior com quadros existentes é reaproveitada (retomada sem baixar de novo).
 */
export async function runWatch(o: { tool: WatchTool; source: string; dir: string; maxFrames?: number; timeoutMs?: number }): Promise<WatchRun> {
  const outDir = path.join(o.dir, 'watch');
  const reportFile = path.join(outDir, 'relatorio.md');
  if (fs.existsSync(reportFile)) {
    const prev = parseWatchReport(fs.readFileSync(reportFile, 'utf8'));
    if (prev.frames.length && prev.frames.every(f => fs.existsSync(f.file))) return { ok: true, report: reportFile, ...prev, error: null };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const args = [o.tool.script, o.source, '--engine', 'local', '--detail', 'balanced', '--max-frames', String(o.maxFrames ?? 40), '--no-whisper', '--out-dir', outDir];
  const r = await run(o.tool.python, args, { timeoutMs: o.timeoutMs ?? 6 * 60_000, cwd: outDir });
  const md = r.out.trim();
  if (r.code !== 0 || !md.includes('# watch')) {
    const last = (r.err || md).trim().split('\n').filter(l => l.trim() && !/^\[watch\] (working dir|checking|downloading)/.test(l)).slice(-3).join(' | ');
    return { ok: false, report: null, frames: [], transcript: null, localMedia: null, error: `a Watch não conseguiu assistir (código ${r.code}): ${last.slice(0, 400) || 'sem mensagem'}` };
  }
  fs.writeFileSync(reportFile, md + '\n', 'utf8');
  const parsed = parseWatchReport(md);
  const frames = parsed.frames.filter(f => fs.existsSync(f.file));
  if (!frames.length) return { ok: false, report: reportFile, frames: [], transcript: parsed.transcript, localMedia: parsed.localMedia, error: 'a Watch terminou sem quadros (vídeo sem imagem ou só legenda)' };
  return { ok: true, report: reportFile, frames, transcript: parsed.transcript, localMedia: parsed.localMedia, error: null };
}
