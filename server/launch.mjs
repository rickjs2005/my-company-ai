// Lançador do My Company AI (v4). Sobe o serviço em SEGUNDO PLANO, sem janela e desacoplado deste processo, espera ele responder
// e (com --open) abre o navegador. Depois sai: a janela do start-hq.cmd pode ser fechada e o serviço continua.
// JavaScript puro (sem tsx) para começar na hora; é também o que a tarefa agendada "Iniciar com o Windows" chama (--scheduled).
// Uso: node launch.mjs [--open] [--scheduled] [--port N] [--data PASTA]
// Duas instâncias: se já houver uma HQ respondendo na porta, só abre o navegador nela. Porta ocupada por outro programa: o
// serviço sai com código 2 e este lançador mostra o motivo (nenhum processo de terceiros é encerrado).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUrl } from './src/browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const scheduled = argv.includes('--scheduled');
const wantOpen = argv.includes('--open');
const port = Number(arg('--port') ?? process.env.MILWEB_HQ_PORT ?? 4777);
const dataDir = path.resolve(arg('--data') ?? process.env.MILWEB_HQ_DATA ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'MilWebHQ'));
const logsDir = path.join(dataDir, 'logs');
const say = (m) => console.log(`[My Company AI] ${m}`);

async function health() {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.app === 'milweb-hq' ? j : null;
  } catch { return null; }
}

function openBrowser() {
  let token = '';
  try { token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim(); } catch { /* sem token: a página pede o link do terminal */ }
  const url = `http://127.0.0.1:${port}/${token ? `#token=${token}` : ''}`;
  try { openUrl(url); } catch (err) { say(`não consegui abrir o navegador (${err.message}).`); }
}

async function main() {
  const running = await health();
  if (running) {
    say(`já está em execução em http://127.0.0.1:${port} (pid ${running.pid}). Nenhum segundo serviço foi iniciado.`);
    if (wantOpen) openBrowser();
    return 0;
  }
  fs.mkdirSync(logsDir, { recursive: true });
  // Saída do console do serviço (erros antes do log abrir, por exemplo) vai para um arquivo, já que não há janela.
  const out = fs.openSync(path.join(logsDir, 'service-console.log'), 'a');
  const env = { ...process.env, MILWEB_HQ_PORT: String(port), MILWEB_HQ_DATA: dataDir, MILWEB_HQ_LAUNCH: scheduled ? 'scheduled-task' : 'background' };
  delete env.MILWEB_HQ_NO_OPEN;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: here, env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 1; });
  child.unref();
  say(`iniciando o serviço em segundo plano (pid ${child.pid})…`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      say(exited === 2 ? `a porta ${port} está ocupada por outro programa (não é um My Company AI). Feche-o ou use outra porta (set MILWEB_HQ_PORT=4790).` : `o serviço terminou com código ${exited}. Veja ${logsDir}.`);
      return exited || 1;
    }
    const h = await health();
    if (h) {
      say(`rodando em segundo plano em http://127.0.0.1:${port} (pid ${h.pid}). Pode fechar esta janela: o serviço continua.`);
      say('Para encerrar: Ajustes > Conexões > Encerrar HQ.');
      if (wantOpen) openBrowser();
      return 0;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  say(`o serviço não respondeu em 2 minutos. Veja ${logsDir}.`);
  return 1;
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
