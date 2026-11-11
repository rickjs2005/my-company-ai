// Renderiza uma composição HTML local (ex.: pin.html) em PNG com o Edge instalado no Windows, sem rede e sem conta.
// O funcionário escreve o HTML; a HQ gera a imagem (assim ninguém precisa de permissão para rodar comandos).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EDGE_CANDIDATES = [
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

export function findEdge(): string | null { return EDGE_CANDIDATES.find(p => fs.existsSync(p)) ?? null; }

export type PngRenderer = (htmlFile: string, pngFile: string, width: number, height: number) => Promise<void>;

export const renderWithEdge: PngRenderer = async (htmlFile, pngFile, width, height) => {
  const exe = findEdge();
  if (!exe) throw new Error('Microsoft Edge não encontrado para gerar a imagem');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-render-'));
  try {
    fs.rmSync(pngFile, { force: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--allow-file-access-from-files', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--screenshot=${pngFile}`,
        '--virtual-time-budget=4000', pathToFileURL(htmlFile).href,
      ], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(new Error('o Edge passou de 60 s para gerar a imagem')); }, 60_000);
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (!fs.existsSync(pngFile)) throw new Error('o Edge terminou sem gerar a imagem');
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* perfil temporário: o Windows pode segurar por alguns segundos */ }
  }
};
