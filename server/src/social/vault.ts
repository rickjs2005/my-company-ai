// Cofre das credenciais sociais (segredos dos apps de desenvolvedor e tokens das contas). No Windows usa a proteção de dados
// do próprio Windows (DPAPI, escopo do usuário atual): cada valor fica cifrado num arquivo em <dados>/cofre e só esta conta
// do Windows consegue abrir. Nada disso vai para o banco, para os backups do banco, para os logs ou para a interface.
// A cifragem roda no PowerShell do Windows (System.Security.Cryptography.ProtectedData), com os dados pela entrada padrão
// (nunca na linha de comando). Os valores abertos ficam em memória enquanto o serviço roda, para não chamar o PowerShell a toda hora.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Vault {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  info(): { kind: 'dpapi' | 'memory'; ok: boolean; detail: string };
}

/** Só para testes e para sistemas sem DPAPI: guarda em memória (some ao reiniciar). */
export class MemoryVault implements Vault {
  private m = new Map<string, string>();
  async get(key: string) { return this.m.get(key) ?? null; }
  async set(key: string, value: string) { this.m.set(key, value); }
  async delete(key: string) { this.m.delete(key); }
  info() { return { kind: 'memory' as const, ok: true, detail: 'em memória (teste): some ao reiniciar' }; }
}

const ENTROPY = 'MilWebHQ-social-v1';
const SAFE_KEY = /^[a-z0-9:_-]{1,80}$/i;

function runPs(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { ps.kill(); reject(new Error('o cofre do Windows não respondeu a tempo')); }, 20_000);
    ps.stdout.on('data', d => { out += d; });
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', e => { clearTimeout(timer); reject(e); });
    ps.on('close', code => { clearTimeout(timer); if (code === 0) resolve(out.trim()); else reject(new Error(`o cofre do Windows falhou (${code}): ${err.trim().slice(0, 200)}`)); });
    ps.stdin.end(input);
  });
}
const PROTECT = `Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($in); $e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); $o=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
const UNPROTECT = `Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($in); $e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); $o=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;

export class DpapiVault implements Vault {
  private cache = new Map<string, string | null>();
  private lastError: string | null = null;
  constructor(private dir: string) {}
  private file(key: string) { if (!SAFE_KEY.test(key)) throw new Error('chave inválida no cofre'); return path.join(this.dir, key.replace(/:/g, '__') + '.bin'); }
  async get(key: string): Promise<string | null> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    const f = this.file(key);
    if (!fs.existsSync(f)) { this.cache.set(key, null); return null; }
    try {
      const plain = Buffer.from(await runPs(UNPROTECT, fs.readFileSync(f, 'utf8').trim()), 'base64').toString('utf8');
      this.cache.set(key, plain); this.lastError = null; return plain;
    } catch (err) { this.lastError = (err as Error).message; throw err; }
  }
  async set(key: string, value: string): Promise<void> {
    const f = this.file(key);
    const cipher = await runPs(PROTECT, Buffer.from(value, 'utf8').toString('base64'));
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, cipher, { mode: 0o600 });
    fs.renameSync(tmp, f);
    this.cache.set(key, value); this.lastError = null;
  }
  async delete(key: string): Promise<void> {
    const f = this.file(key);
    try { fs.rmSync(f, { force: true }); } catch { /* já não existe */ }
    this.cache.set(key, null);
  }
  info() {
    return this.lastError
      ? { kind: 'dpapi' as const, ok: false, detail: `cofre do Windows com erro: ${this.lastError}` }
      : { kind: 'dpapi' as const, ok: true, detail: 'cofre do Windows (DPAPI, só este usuário abre)' };
  }
}

export function createVault(dataDir: string): Vault {
  return process.platform === 'win32' ? new DpapiVault(path.join(dataDir, 'cofre')) : new MemoryVault();
}
