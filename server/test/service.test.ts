// Controle do serviço (v4): estado real, pausar novas tarefas, encerrar, e a tarefa agendada "Iniciar com o Windows" no
// usuário atual. O PowerShell é falso aqui (registra o script e devolve o que o Windows devolveria); a prova com o Agendador
// de Tarefas real fica na validação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { ServerMessage, ServiceStatus } from '@milweb-hq/protocol';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { ServiceControl, type PsRunner } from '../src/service.js';
import type { Config } from '../src/config.js';

function setup(opts: { registered?: boolean; failRegister?: boolean; port?: number; dataDir?: string } = {}) {
  const store = new Store(openDb(':memory:'));
  const msgs: ServerMessage[] = [];
  const scripts: string[] = [];
  let registered = opts.registered ?? false;
  let dispatched = 0; let shutdownWhy: string | null = null; let opened: string | null = null;
  const cfg = { host: '127.0.0.1', port: opts.port ?? 4777, dataDir: opts.dataDir ?? 'C:\\Users\\chefe\\AppData\\Local\\MilWebHQ', logsDir: 'C:\\dados\\logs', installDir: 'C:\\hq', version: '0.1.0' } as unknown as Config;
  const ps: PsRunner = async script => {
    scripts.push(script);
    if (script.includes('Register-ScheduledTask')) { if (opts.failRegister) return { code: 1, stdout: '', stderr: 'Register-ScheduledTask : Acesso negado.' }; registered = true; return { code: 0, stdout: 'ok\r\n', stderr: '' }; }
    if (script.includes('Unregister-ScheduledTask')) { registered = false; return { code: 0, stdout: 'ok\r\n', stderr: '' }; }
    const args = `"${path.join('C:\\hq', 'server', 'launch.mjs')}" --scheduled${(opts.port ?? 4777) !== 4777 ? ` --port ${opts.port}` : ''}`;
    return { code: 0, stdout: JSON.stringify({ registered, state: registered ? 'Ready' : null, args: registered ? args : null, battery: 2, hasBattery: true }), stderr: '' };
  };
  const svc = new ServiceControl({
    cfg, store, broadcast: m => msgs.push(m), startedAt: 1000, launchMode: 'background', log: { info() {}, warn() {} }, ps, platform: 'win32',
    manager: { dispatch: () => { dispatched++; }, providerHolds: () => [{ provider: 'claude', kind: 'usage_limit', until: 2000, reason: 'Claude em pausa até 00:40' }] },
    shutdown: why => { shutdownWhy = why; }, openLogs: f => { opened = f; }, networkCheck: async () => true, defaultDataDir: 'C:\\Users\\chefe\\AppData\\Local\\MilWebHQ',
  });
  return { svc, store, msgs, scripts, get dispatched() { return dispatched; }, get shutdownWhy() { return shutdownWhy; }, get opened() { return opened; } };
}

test('estado real: pid, porta, modo de início, máquina, tarefa agendada e suspensões dos provedores', async () => {
  const s = setup();
  const st = await s.svc.handle({ type: 'service.status', reqId: 'r' }) as ServiceStatus;
  assert.equal(st.pid, process.pid); assert.equal(st.port, 4777); assert.equal(st.launchMode, 'background');
  assert.equal(st.logFile, path.join('C:\\dados\\logs', 'server.log'));
  assert.deepEqual(st.autostart, { supported: true, registered: false, detail: null, taskName: 'MilWeb HQ' });
  assert.equal(st.machine.onBattery, false, 'BatteryStatus 2 = na tomada'); assert.equal(st.machine.networkOnline, true);
  assert.equal(st.providerHolds?.[0]?.reason, 'Claude em pausa até 00:40');
});

test('iniciar com o Windows: tarefa no logon do usuário atual, sem elevação, apontando para o lançador; desligar remove', async () => {
  const s = setup({ port: 4779, dataDir: 'C:\\prova\\data' });
  const st = await s.svc.handle({ type: 'service.autostart', reqId: 'r', enabled: true }) as ServiceStatus;
  const reg = s.scripts.find(x => x.includes('Register-ScheduledTask'))!;
  assert.match(reg, /New-ScheduledTaskTrigger -AtLogOn -User \$user/);
  assert.match(reg, /-LogonType Interactive -RunLevel Limited/, 'na sessão do Chefe, sem administrador');
  assert.match(reg, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/, 'sem limite de duração');
  assert.match(reg, /-MultipleInstances IgnoreNew/);
  assert.ok(reg.includes(`-WorkingDirectory '${path.join('C:\\hq', 'server')}'`));
  assert.ok(reg.includes(`--scheduled --port 4779 --data "C:\\prova\\data"`), 'porta e dados da instância atual vão junto');
  assert.ok(reg.includes(`-Execute '${process.execPath}'`));
  assert.equal(st.autostart.registered, true);
  assert.ok(s.msgs.some(m => m.kind === 'service.status'));
  const off = await s.svc.handle({ type: 'service.autostart', reqId: 'r', enabled: false }) as ServiceStatus;
  assert.ok(s.scripts.some(x => x.includes('Unregister-ScheduledTask') && x.includes('-Confirm:$false')));
  assert.equal(off.autostart.registered, false);
});

test('Windows recusou criar a tarefa: erro com o motivo, nada fingido', async () => {
  const s = setup({ failRegister: true });
  await assert.rejects(s.svc.handle({ type: 'service.autostart', reqId: 'r', enabled: true }), /O Windows recusou criar a tarefa agendada: Register-ScheduledTask : Acesso negado/);
});

test('pausar novas tarefas grava o ajuste, avisa a interface e despacha ao retomar; encerrar e abrir logs', async () => {
  const s = setup();
  await s.svc.handle({ type: 'service.pause', paused: true });
  assert.equal(s.store.getSettings().pauseNewTasks, true);
  assert.ok(s.msgs.some(m => m.kind === 'settings' && m.settings.pauseNewTasks));
  assert.equal(s.dispatched, 0);
  await s.svc.handle({ type: 'service.pause', paused: false });
  assert.equal(s.store.getSettings().pauseNewTasks, false); assert.equal(s.dispatched, 1);
  await s.svc.handle({ type: 'service.openLogs' });
  assert.equal(s.opened, path.join('C:\\dados\\logs', 'server.log'));
  await s.svc.handle({ type: 'service.shutdown' });
  await new Promise(r => setTimeout(r, 250));
  assert.equal(s.shutdownWhy, 'pedido pela interface');
});
