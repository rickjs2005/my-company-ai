import fs from 'node:fs';
import path from 'node:path';

let stream: fs.WriteStream | null = null;

export function initLog(logsDir: string) {
  try {
    const file = path.join(logsDir, 'server.log');
    try { if (fs.statSync(file).size > 5_000_000) fs.renameSync(file, file + '.1'); } catch { /* sem arquivo */ }
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch { stream = null; }
}

function line(level: string, args: unknown[]) {
  const text = args.map(a => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const out = `${new Date().toISOString()} ${level} ${text}`;
  if (level === 'ERROR') console.error(out); else console.log(out);
  stream?.write(out + '\n');
}

export const log = {
  info: (...a: unknown[]) => line('INFO', a),
  warn: (...a: unknown[]) => line('WARN', a),
  error: (...a: unknown[]) => line('ERROR', a),
  debug: (...a: unknown[]) => { if (process.env.MILWEB_HQ_DEBUG) line('DEBUG', a); },
};
