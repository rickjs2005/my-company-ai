// Localiza o Codex CLI instalado (@openai/codex via npm global) sem shell e sem "where": só caminhos conhecidos.
// Verificado em 31/10/2026: @openai/codex 0.58.0 em %APPDATA%/npm/node_modules/@openai/codex, com o binário nativo em
// vendor/<alvo>/codex/codex.exe e o lançador bin/codex.js (que exige o node). O shim codex.cmd precisa de shell, por isso é ignorado.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexInstall {
  /** Executável a passar ao spawn (codex.exe, ou o node quando a rota é bin/codex.js). */
  exePath: string;
  /** Argumentos que vêm antes de 'app-server' (vazio para o binário nativo; [bin/codex.js] na rota pelo node). */
  prefixArgs: string[];
  source: 'env' | 'npm-vendor' | 'npm-bin';
}

/** Alvo (target triple) que o pacote @openai/codex usa na pasta vendor/, conforme plataforma e arquitetura. */
export function codexVendorTarget(platform = process.platform, arch = process.arch): string | null {
  if (platform === 'win32') return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (platform === 'linux') return arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
  return null;
}

/** Pastas onde o npm costuma instalar pacotes globais nesta máquina (sem rodar `npm prefix`). */
export function npmGlobalModuleDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  if (env.npm_config_prefix) dirs.push(path.join(env.npm_config_prefix, 'node_modules'), path.join(env.npm_config_prefix, 'lib', 'node_modules'));
  if (process.platform === 'win32') {
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm', 'node_modules'));
    dirs.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'));
  } else {
    dirs.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'));
    dirs.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', '/opt/homebrew/lib/node_modules');
  }
  return [...new Set(dirs)];
}

export function locateCodex(env: NodeJS.ProcessEnv = process.env): CodexInstall | null {
  const override = env.MILWEB_HQ_CODEX_EXE;
  if (override && existsSync(override)) return { exePath: override, prefixArgs: [], source: 'env' };
  const target = codexVendorTarget();
  const exeName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of npmGlobalModuleDirs(env)) {
    const pkg = path.join(dir, '@openai', 'codex');
    if (!existsSync(pkg)) continue;
    if (target) {
      const native = path.join(pkg, 'vendor', target, 'codex', exeName);
      if (existsSync(native)) return { exePath: native, prefixArgs: [], source: 'npm-vendor' };
    }
    const launcher = path.join(pkg, 'bin', 'codex.js');
    if (existsSync(launcher)) return { exePath: process.execPath, prefixArgs: [launcher], source: 'npm-bin' };
  }
  return null;
}
