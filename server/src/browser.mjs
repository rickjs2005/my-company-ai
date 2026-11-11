// Abre um endereço http no navegador SEM perder o "#token=…". JavaScript puro porque o lançador (launch.mjs) usa sem tsx.
// Por que não só "explorer.exe <url>": quando a associação de links do Windows aponta para um navegador que foi desinstalado
// (nesta máquina, o Brave), o Windows cai no Edge por um caminho de reserva que descarta o fragmento, e a aba abre sem acesso.
// Aqui o comando do navegador é lido do registro e o executável é chamado direto; se o padrão não existir mais, usa o Edge.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

const HTTP_CHOICE = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice';

/** Monta { file, args } a partir do comando de abertura do registro ("…\\msedge.exe" --single-argument %1). */
export function parseOpenCommand(command, url, env = process.env) {
  if (!command || !command.trim()) return null;
  const expanded = command.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, name) => env[name] ?? m);
  const tokens = [...expanded.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
  if (!tokens.length || !tokens[0]) return null;
  const [file, ...rest] = tokens;
  let placed = false;
  const args = [];
  for (const a of rest) {
    if (/%[1lL*]/.test(a)) {
      placed = placed || /%[1lL]/.test(a);
      const v = a.replace(/%[1lL]/g, url).replace(/%\*/g, '');
      if (v) args.push(v);
    } else args.push(a);
  }
  if (!placed) args.push(url);
  return { file, args };
}

/** Lê um valor do registro pelo reg.exe (rápido, sem PowerShell). null quando a chave ou o valor não existe. */
export function readRegistry(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, ...(value ? ['/v', value] : ['/ve'])], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const m = /REG_(?:EXPAND_)?SZ[ \t]+(.*)$/m.exec(out);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/** Comando para abrir a URL no Windows: navegador padrão se ele ainda existe; senão o Edge. null se nenhum foi achado. */
export function findBrowserCommand(url, deps = {}) {
  const read = deps.readRegistry ?? readRegistry;
  const exists = deps.exists ?? (p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const env = deps.env ?? process.env;
  const commands = [];
  const progId = read(HTTP_CHOICE, 'ProgId');
  if (progId) commands.push(read(`HKCR\\${progId}\\shell\\open\\command`, null));
  commands.push(read('HKCR\\MSEdgeHTM\\shell\\open\\command', null));
  for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]) {
    if (base) commands.push(`"${base}\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1`);
  }
  for (const c of commands) {
    const parsed = parseOpenCommand(c, url, env);
    if (parsed && exists(parsed.file)) return parsed;
  }
  return null;
}

/** Abre a URL e devolve o programa usado (para o log). Fora do Windows usa open/xdg-open. */
export function openUrl(url) {
  let cmd;
  if (process.platform === 'win32') cmd = findBrowserCommand(url) ?? { file: 'explorer.exe', args: [url] };
  else cmd = { file: process.platform === 'darwin' ? 'open' : 'xdg-open', args: [url] };
  spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return cmd.file;
}
