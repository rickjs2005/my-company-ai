import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface Config {
  host: '127.0.0.1';
  port: number;
  dataDir: string;
  attachmentsDir: string;
  logsDir: string;
  /** Lixeira da HQ (itens apagados pela interface ficam aqui até restaurar ou excluir de vez). */
  trashDir: string;
  /** Backups do banco feitos antes de migrações. */
  backupsDir: string;
  /** Pasta da instalação da HQ (código): protegida contra operações de arquivo da interface. */
  installDir: string;
  dbFile: string;
  token: string;
  webDist: string | null;
  /** Origens extras aceitas no WebSocket em desenvolvimento (Vite). */
  devOrigins: string[];
  version: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = overrides.port ?? Number(process.env.MILWEB_HQ_PORT ?? 4777);
  const dataDir = overrides.dataDir ?? process.env.MILWEB_HQ_DATA ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'MilWebHQ');
  const attachmentsDir = path.join(dataDir, 'attachments');
  const logsDir = path.join(dataDir, 'logs');
  const trashDir = path.join(dataDir, 'trash');
  const backupsDir = path.join(dataDir, 'backups');
  const installDir = path.resolve(here, '..', '..');
  for (const d of [dataDir, attachmentsDir, logsDir, trashDir, backupsDir]) fs.mkdirSync(d, { recursive: true });
  const tokenFile = path.join(dataDir, 'token');
  let token = overrides.token ?? '';
  if (!token) {
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { token = ''; }
    if (!/^[a-f0-9]{48,}$/.test(token)) {
      token = randomBytes(32).toString('hex');
      fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    }
  }
  // MILWEB_HQ_WEB_DIST: frontend compilado em outra pasta (instância de prova isolada, sem trocar o web/dist da HQ ligada).
  const webDistCandidate = process.env.MILWEB_HQ_WEB_DIST ? path.resolve(process.env.MILWEB_HQ_WEB_DIST) : path.resolve(here, '..', '..', 'web', 'dist');
  const webDist = overrides.webDist !== undefined ? overrides.webDist : (fs.existsSync(path.join(webDistCandidate, 'index.html')) ? webDistCandidate : null);
  const dev = process.env.MILWEB_HQ_DEV === '1';
  const devOrigins = dev ? [5173, 5174, 5175].flatMap(p => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]) : [];
  let version = '0.1.0';
  try { version = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8')).version ?? version; } catch { /* ignorar */ }
  return { host: '127.0.0.1', port, dataDir, attachmentsDir, logsDir, trashDir, backupsDir, installDir, dbFile: path.join(dataDir, 'hq.sqlite'), token, webDist, devOrigins, version };
}
