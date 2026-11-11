// Abre fora da HQ: pasta no Explorador, arquivo no programa padrão do Windows, arquivo selecionado na pasta ("reveal") ou
// URL no navegador. Só alvos locais existentes ou http(s). A janela é aberta pelo Windows; ela pode surgir atrás do
// navegador (o serviço roda em segundo plano), por isso a tela da HQ mostra o resultado no próprio visualizador primeiro.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openUrl } from './browser.mjs';

export type ExternalTarget = 'folder' | 'file' | 'reveal' | 'url';

/** Argumentos do explorer.exe para cada alvo (exportado para teste). Caminho com barras normais vira barras invertidas. */
export function explorerArgs(target: Exclude<ExternalTarget, 'url'>, value: string): string[] {
  const p = path.win32.normalize(value);
  return target === 'reveal' ? [`/select,${p}`] : [p];
}

export function openExternal(target: ExternalTarget, value: string): void {
  if (target === 'url') {
    if (!/^https?:\/\//i.test(value)) throw new Error('URL inválida');
    // Navegador chamado direto (o explorer.exe pode perder o "#token=…"; ver browser.mjs).
    openUrl(value);
    return;
  }
  const p = path.normalize(value);
  if (!fs.existsSync(p)) throw new Error(`o caminho não existe: ${p}`);
  if (target === 'file' && fs.statSync(p).isDirectory()) target = 'folder';
  if (process.platform === 'win32') {
    spawn('explorer.exe', explorerArgs(target, p), { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [target === 'reveal' ? path.dirname(p) : p], { detached: true, stdio: 'ignore' }).unref();
}
