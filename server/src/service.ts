// Controle do serviço em segundo plano (v4): estado real, pausar novas tarefas, abrir logs, encerrar e "Iniciar com o Windows".
// "Iniciar com o Windows" é uma tarefa agendada NO USUÁRIO ATUAL (logon interativo, sem elevação): o serviço precisa da sessão
// do Chefe para usar os logins do Claude Code e do Codex e as pastas dos projetos. Um serviço de sistema não teria isso.
// A tarefa chama o lançador (`server/launch.mjs --scheduled`), que sobe o serviço oculto e sai.
import { spawn } from 'node:child_process';
import dns from 'node:dns';
import os from 'node:os';
import path from 'node:path';
import type { AiProviderId, ServerMessage, ServiceStatus, WorkClientMessage } from '@milweb-hq/protocol';
import type { Config } from './config.js';
import type { Store } from './store.js';

export const DEFAULT_TASK_NAME = 'MilWeb HQ';
const DEFAULT_PORT = 4777;

export type PsRunner = (script: string, timeoutMs?: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface ServiceDeps {
  cfg: Config;
  store: Store;
  manager: { dispatch(): void; providerHolds(): { provider: AiProviderId; kind: 'usage_limit' | 'network'; until: number; reason: string }[] };
  broadcast(m: ServerMessage): void;
  startedAt: number;
  launchMode: ServiceStatus['launchMode'];
  /** Encerramento ordenado do serviço (o mesmo do Ctrl+C). */
  shutdown(why: string): void;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
  taskName?: string;
  /** Pasta de dados padrão (para saber se a tarefa agendada precisa de `--data`). */
  defaultDataDir?: string;
  ps?: PsRunner;
  openLogs?(file: string): void;
  /** Teste de rede (padrão: resolver o endereço da API do Claude). */
  networkCheck?(): Promise<boolean>;
  platform?: NodeJS.Platform;
  /** Marco 0: identidade do banco e backups (cartão "Dados"). */
  data?: { info(): unknown; backupNow(kind: 'manual'): string };
}

/** PowerShell 5.1 com o script em -EncodedCommand (UTF-16LE): nada de aspas montadas em linha de comando. */
export const runPowerShell: PsRunner = (script, timeoutMs = 30_000) => new Promise(resolve => {
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const t = setTimeout(() => { try { child.kill(); } catch { /* já saiu */ } }, timeoutMs);
  child.on('error', err => { clearTimeout(t); resolve({ code: -1, stdout, stderr: stderr + String(err.message) }); });
  child.on('close', code => { clearTimeout(t); resolve({ code, stdout, stderr }); });
});

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export class ServiceControl {
  constructor(private d: ServiceDeps) {}
  private get taskName() { return this.d.taskName ?? DEFAULT_TASK_NAME; }
  private get platform() { return this.d.platform ?? process.platform; }
  private get ps() { return this.d.ps ?? runPowerShell; }
  get logFile() { return path.join(this.d.cfg.logsDir, 'server.log'); }

  /** Argumentos que a tarefa agendada passa ao lançador (porta e pasta de dados só quando não são as padrão). */
  launcherArgs(): string {
    const launch = path.join(this.d.cfg.installDir, 'server', 'launch.mjs');
    const extra: string[] = [];
    if (this.d.cfg.port !== DEFAULT_PORT) extra.push(`--port ${this.d.cfg.port}`);
    if (this.d.defaultDataDir && path.resolve(this.d.defaultDataDir) !== path.resolve(this.d.cfg.dataDir)) extra.push(`--data "${this.d.cfg.dataDir}"`);
    return [`"${launch}"`, '--scheduled', ...extra].join(' ');
  }

  async handle(msg: WorkClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'service.status': return this.status();
      case 'service.pause': this.pause(msg.paused); return undefined;
      case 'service.autostart': return this.setAutostart(msg.enabled);
      case 'service.openLogs': (this.d.openLogs ?? defaultOpenLogs)(this.logFile); return undefined;
      case 'service.dataInfo': { if (!this.d.data) throw new Error('informações do banco indisponíveis neste serviço'); return this.d.data.info(); }
      case 'service.backupNow': { if (!this.d.data) throw new Error('backup indisponível neste serviço'); const file = this.d.data.backupNow('manual'); return { file, info: this.d.data.info() }; }
      case 'service.shutdown': {
        this.d.log.info('encerramento pedido pela interface');
        setTimeout(() => this.d.shutdown('pedido pela interface'), 150).unref?.();
        return undefined;
      }
      default: throw new Error(`operação do serviço desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  pause(paused: boolean): void {
    const s = this.d.store.saveSettings({ pauseNewTasks: Boolean(paused) });
    this.d.broadcast({ kind: 'settings', settings: s });
    this.d.log.info(paused ? 'novas tarefas pausadas (o que está rodando termina)' : 'novas tarefas liberadas');
    if (!paused) this.d.manager.dispatch();
  }

  async status(): Promise<ServiceStatus> {
    const [win, online] = await Promise.all([this.probeWindows(), (this.d.networkCheck ?? defaultNetworkCheck)().catch(() => null)]);
    return {
      pid: process.pid, startedAt: this.d.startedAt, port: this.d.cfg.port, version: this.d.cfg.version, dataDir: this.d.cfg.dataDir, logFile: this.logFile,
      autostart: { supported: this.platform === 'win32', registered: win.registered, detail: win.detail, taskName: this.taskName },
      pauseNewTasks: this.d.store.getSettings().pauseNewTasks,
      machine: { platform: `${os.type()} ${os.release()}`, hostname: os.hostname(), uptimeSec: Math.round(os.uptime()), onBattery: win.onBattery, networkOnline: online },
      launchMode: this.d.launchMode, checkedAt: Date.now(), providerHolds: this.d.manager.providerHolds(),
    };
  }

  /** Uma chamada ao PowerShell: a tarefa agendada existe (e para onde aponta) e se o notebook está na bateria. */
  private async probeWindows(): Promise<{ registered: boolean | null; detail: string | null; onBattery: boolean | null }> {
    if (this.platform !== 'win32') return { registered: null, detail: 'Início automático só existe no Windows.', onBattery: null };
    const r = await this.ps(`$ErrorActionPreference='SilentlyContinue'
$t = Get-ScheduledTask -TaskName ${q(this.taskName)}
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
$o = [ordered]@{ registered = [bool]$t; state = $null; args = $null; battery = $null; hasBattery = [bool]$b }
if ($t) { $o.state = "$($t.State)"; $o.args = "$($t.Actions[0].Arguments)" }
if ($b) { $o.battery = [int]$b.BatteryStatus }
$o | ConvertTo-Json -Compress`, 20_000);
    try {
      const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? '') as { registered: boolean; state: string | null; args: string | null; battery: number | null; hasBattery: boolean };
      const expected = this.launcherArgs();
      let detail: string | null = null;
      if (j.registered) detail = j.args === expected ? `Tarefa agendada "${this.taskName}" no seu usuário, no logon (estado: ${j.state ?? '?'}).` : `A tarefa "${this.taskName}" existe, mas aponta para outro lugar (${j.args ?? '?'}). Desligue e ligue de novo para corrigir.`;
      // BatteryStatus 1 = descarregando (na bateria); sem bateria = desktop na tomada.
      return { registered: j.registered, detail, onBattery: j.hasBattery ? j.battery === 1 : false };
    } catch {
      return { registered: null, detail: `Não foi possível consultar o Agendador de Tarefas (${(r.stderr || r.stdout).trim().slice(0, 160) || `código ${r.code}`}).`, onBattery: null };
    }
  }

  async setAutostart(enabled: boolean): Promise<ServiceStatus> {
    if (this.platform !== 'win32') throw new Error('Iniciar com o Windows só existe no Windows.');
    const script = enabled ? `$ErrorActionPreference='Stop'
$user = "$env:USERDOMAIN\\$env:USERNAME"
$a = New-ScheduledTaskAction -Execute ${q(process.execPath)} -Argument ${q(this.launcherArgs())} -WorkingDirectory ${q(path.join(this.d.cfg.installDir, 'server'))}
$t = New-ScheduledTaskTrigger -AtLogOn -User $user
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$p = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ${q(this.taskName)} -Action $a -Trigger $t -Settings $s -Principal $p -Description 'MilWeb HQ: sobe o servico local em segundo plano quando voce entra no Windows (sem janela). Criada pela propria HQ; desligue em Ajustes > Conexoes.' -Force | Out-Null
'ok'` : `$ErrorActionPreference='Stop'
if (Get-ScheduledTask -TaskName ${q(this.taskName)} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${q(this.taskName)} -Confirm:$false }
'ok'`;
    const r = await this.ps(script, 45_000);
    if (r.code !== 0 || !/ok\s*$/.test(r.stdout.trim())) {
      const why = (r.stderr || r.stdout).replace(/\s+/g, ' ').trim().slice(0, 300);
      this.d.log.warn(`não foi possível ${enabled ? 'registrar' : 'remover'} a tarefa agendada: ${why}`);
      throw new Error(`O Windows recusou ${enabled ? 'criar' : 'remover'} a tarefa agendada: ${why || `código ${r.code}`}`);
    }
    this.d.log.info(enabled ? `tarefa agendada "${this.taskName}" registrada (logon do usuário atual)` : `tarefa agendada "${this.taskName}" removida`);
    const st = await this.status();
    this.d.broadcast({ kind: 'service.status', status: st });
    return st;
  }
}

function defaultOpenLogs(file: string): void {
  if (process.platform === 'win32') { spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return; }
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [path.dirname(file)], { detached: true, stdio: 'ignore' }).unref();
}

/** Rede "de verdade" para os provedores: resolver o endereço da API do Claude (3 s). */
function defaultNetworkCheck(): Promise<boolean> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), 3000);
    dns.lookup('api.anthropic.com', err => { clearTimeout(t); resolve(!err); });
  });
}
