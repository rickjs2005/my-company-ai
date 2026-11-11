// Entrada do serviço local da MilWeb HQ.
// Ordem importa: primeiro a porta (se outra HQ já estiver rodando, reaproveitamos a instância e NÃO tocamos no banco dela),
// depois o banco (migração com backup), os processos e o WebSocket.
import { loadConfig } from './config.js';
import { initLog, log } from './log.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { childEnv, probeClaude, toServerInfo, type ClaudeInfo } from './claude-info.js';
import { isolatedEnv } from './access.js';
import { DataGuard } from './data.js';
import { PreviewServer } from './preview.js';
import { SessionManager } from './sessions.js';
import { ExternalObserver } from './external.js';
import { createHttpServer } from './http.js';
import { attachWs } from './ws.js';
import { DeskService } from './desk/service.js';
import { KnowledgeService } from './knowledge/service.js';
import { createFsService } from './fs/index.js';
import { createSkillsService } from './skills/index.js';
import { openExternal } from './open-external.js';
import { AiRegistry } from './ai/registry.js';
import { ClaudeAdapter } from './ai/claude/adapter.js';
import { CodexAdapter } from './ai/codex/adapter.js';
import { MeetingStore } from './meetings/store.js';
import { MeetingController } from './meetings/controller.js';
import { RoutineService } from './routines.js';
import { ServiceControl } from './service.js';
import { SocialService, callbackPage } from './social/service.js';
import { createVault } from './social/vault.js';
import { recordAudit } from './audit.js';
import { ContentService } from './content/service.js';
import { execFileSync } from 'node:child_process';
import { remotionRenderer } from './content/video.js';
import { findTools } from './content/videoref.js';
import { pageSnapshot } from './content/pagesnap.js';
import { renderWithEdge } from './content/render.js';
import { edgeSlideRenderer } from './content/carousel.js';
import { BROWSER_ENGINE, BrowserBroker, BrowserError } from './browser/broker.js';
import { fileURLToPath } from 'node:url';
import type { HttpHook } from './http.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerInfo, ServerMessage } from '@milweb-hq/protocol';

export const APP_ID = 'milweb-hq';

interface HealthInfo { app?: string; version?: string; pid?: number }

/** Pergunta a quem está na porta se é uma MilWeb HQ (GET /api/health). null = não respondeu como HQ. */
async function probeExisting(host: string, port: number): Promise<HealthInfo | null> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`http://${host}:${port}/api/health`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json() as Record<string, unknown>;
    return { app: typeof j.app === 'string' ? j.app : undefined, version: typeof j.version === 'string' ? j.version : undefined, pid: typeof j.pid === 'number' ? j.pid : undefined };
  } catch { return null; }
}

async function main() {
  const cfg = loadConfig();
  initLog(cfg.logsDir);
  const startedAt = Date.now();
  const wantOpen = process.argv.includes('--open') && process.env.MILWEB_HQ_NO_OPEN !== '1';
  const url = `http://${cfg.host}:${cfg.port}/#token=${cfg.token}`; // o token só vai para o navegador e para o terminal do Chefe, nunca para o log
  log.info(`MilWeb HQ v${cfg.version} iniciando · dados em ${cfg.dataDir}`);

  let claude: ClaudeInfo = { exePath: null, version: null, authOk: null, authDetail: 'verificando…', apiKeyInEnv: Boolean(process.env.ANTHROPIC_API_KEY) };
  // Retorno do login das redes (a página HTTPS da Aurora repassa para cá). Ligado depois que o serviço social sobe.
  let socialRef: SocialService | null = null;
  const socialHook: HttpHook = (url, req, res) => {
    if (url.pathname !== '/social/oauth/callback') return false;
    if (req.method !== 'GET' || !socialRef) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('A HQ ainda está iniciando. Tente de novo em alguns segundos.'); return true; }
    socialRef.handleCallback(url.searchParams).then(r => {
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(callbackPage(r));
    }).catch(err => { log.error('retorno do login social falhou', err); res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Erro ao concluir a conexão. Veja o log da HQ.'); });
    return true;
  };
  // Navegador da HQ: as ferramentas dos funcionários (servidor MCP por stdio) chegam aqui com o token da conversa.
  let browserRef: BrowserBroker | null = null;
  const browserHook: HttpHook = (url, req, res) => {
    if (url.pathname !== '/browser/call') return false;
    const reply = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || !browserRef) { reply(503, { ok: false, text: 'navegador da HQ indisponível' }); return true; }
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const sessionId = auth ? browserRef.sessionForToken(auth) : null;
    if (!sessionId) { reply(401, { ok: false, text: 'token do navegador inválido' }); return true; }
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > 1_000_000) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      let body: { tool?: string; args?: Record<string, unknown> } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { reply(400, { ok: false, text: 'pedido inválido' }); return; }
      browserRef!.call(sessionId, String(body.tool ?? ''), body.args ?? {})
        .then(text => reply(200, { ok: true, text }))
        .catch(err => { if (!(err instanceof BrowserError)) log.warn(`navegador: falha em ${body.tool}`, err); reply(200, { ok: false, text: (err as Error).message }); });
    });
    return true;
  };
  const httpServer = createHttpServer(cfg, () => ({ app: APP_ID, pid: process.pid, startedAt, version: cfg.version, claude: claude.version, auth: claude.authOk }), [socialHook, browserHook]);

  // 1) Porta. Ocupada por outra HQ (mesma pasta de dados → mesmo token): abre a janela nela e sai sem mexer em nada.
  try {
    await new Promise<void>((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(cfg.port, cfg.host, () => resolve()); });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const other = await probeExisting(cfg.host, cfg.port);
      if (other?.app === APP_ID) {
        log.info(`a MilWeb HQ já está em execução em http://${cfg.host}:${cfg.port} (v${other.version ?? '?'}${other.pid ? `, pid ${other.pid}` : ''}); reaproveitando essa instância`);
        console.log(`[MilWeb HQ] Ja esta em execucao em http://${cfg.host}:${cfg.port}. Usando essa instancia (nenhum segundo servico foi iniciado).`);
        if (wantOpen) { try { openExternal('url', url); } catch (e) { log.warn('não abriu o navegador', e); } }
        if (process.argv.includes('--print-url')) console.log(url);
        process.exit(0);
      }
      log.error(`a porta ${cfg.port} está ocupada por outro programa (não é uma MilWeb HQ). Feche-o ou defina MILWEB_HQ_PORT com outra porta, ex.: 4778.`);
      process.exit(2);
    }
    throw err;
  }
  httpServer.on('error', err => log.error('erro no servidor HTTP', err));
  log.info(`ouvindo em http://${cfg.host}:${cfg.port} (loopback)`);

  // 2) Banco (migração com backup consistente antes de mudar o esquema).
  const db = openDb(cfg.dbFile, { backupsDir: cfg.backupsDir, onMigrate: info => log.info(`banco migrado da versão ${info.from} para ${info.to}${info.backupFile ? ` · backup em ${info.backupFile}` : ' (banco vazio, sem backup)'}`) });
  const store = new Store(db);
  store.seedDefaultRooms();

  const serverInfo = (): ServerInfo => toServerInfo(claude, { version: cfg.version, dataDir: cfg.dataDir, maxParallel: store.getSettings().maxParallel, startedAt });

  // 3) Processos, observação externa, arquivos e WebSocket.
  let probing = true;
  let meetingsRef: MeetingController | null = null;
  let wsHandle: { broadcast: (m: ServerMessage) => void; close: () => void } | null = null;
  const broadcast = (m: ServerMessage) => wsHandle?.broadcast(m);

  // Provedores de IA: Claude via Claude Code e ChatGPT via Codex app-server; estado real, nada presumido.
  // Marco 0: turnos de reunião e o Codex rodam sem credenciais de integração (gh, git remoto, Vercel). Ver access.ts.
  const isolationDir = path.join(cfg.dataDir, 'isolamento');
  const claudeAdapter = new ClaudeAdapter({ exeOverride: process.env.MILWEB_HQ_CLAUDE_PATH, log, env: () => isolatedEnv(childEnv(), isolationDir) });
  const codexAdapter = new CodexAdapter({ log: m => log.info(m), wrapEnv: e => isolatedEnv(e, isolationDir) });
  const registry = new AiRegistry({ store, adapters: [claudeAdapter, codexAdapter], broadcast, testCwd: cfg.dataDir, log });

  // Catálogo de skills/agentes nativos: leitura de arquivos locais (pessoais, projeto, plugins habilitados, sincronizadas); nada é executado.
  const skills = createSkillsService({ store, claudeVersion: () => claude.version, codexStatus: () => { const s = codexAdapter.status(); return { installed: s.installed, version: s.version }; }, broadcast, log });

  // Sala Social Media travada na pasta de conteúdo (a escolhida em "Preparar a sala"); outras salas usam o projeto do pedido.
  const roomProject = (roomId: string): string | null => {
    if (store.getRoom(roomId)?.kind !== 'social') return null;
    try { return (db.prepare("SELECT value FROM social_config WHERE key='content.projectId'").get() as { value: string } | undefined)?.value ?? null; } catch { return null; }
  };
  // Conhecimento da equipe: orientações persistidas (banco), entregues no pedido de cada tarefa conforme o escopo.
  const knowledge = new KnowledgeService({ db, store, broadcast, log });
  const manager = new SessionManager({ knowledge, store, exePath: () => claude.exePath, probing: () => probing, attachmentsDir: cfg.attachmentsDir, isolationDir, externalActive: () => meetingsRef?.activeCount() ?? 0, ai: registry, skills, roomProject });
  manager.reconcileOnStart();
  // Mesa do Chefe: entregas das tarefas distribuídas (persistidas) e bloqueios do plano; perguntas vêm do gerenciador.
  const meetingStore = new MeetingStore(db);
  const desk = new DeskService({ db, store, meetings: meetingStore, manager, broadcast, log });
  const meetings = new MeetingController({ store, meetings: meetingStore, registry, manager, dataDir: cfg.dataDir, broadcast, log, needs: { add: i => desk.addNeed(i) } });
  meetingsRef = meetings;
  meetings.recoverOnStart();
  meetings.startReturnWatch();
  meetings.recoverPlans();
  desk.recover();
  const external = new ExternalObserver(store, () => claude.exePath, view => broadcast({ kind: 'external', sessions: view.sessions, workers: view.workers, projects: view.virtualProjects }));
  const fsService = createFsService({ store, config: cfg, manager: { listSessions: () => manager.listSessions() }, broadcast, log });
  // v4: rotinas (agendador determinístico em America/Sao_Paulo) e controle do serviço em segundo plano.
  // Rotinas da sala de conteúdo (Radar diário, análise semanal) montam o pedido na hora do disparo pelo serviço de conteúdo.
  let contentRef: ContentService | null = null;
  const routines = new RoutineService({ store, manager, broadcast, log, workflows: { prepare: (wf, r) => { if (!contentRef) throw new Error('o trabalho de conteúdo ainda está iniciando'); return contentRef.prepareRoutine(wf, r); } } });
  let shutdownRef: ((why: string) => void) | null = null;
  const launch = process.env.MILWEB_HQ_LAUNCH;
  // Marco 1: prévia local dos projetos (porta própria = outra origem; os scripts do site não alcançam o token da HQ).
  const preview = new PreviewServer({ secret: cfg.token, listProjects: () => store.listProjects(), blockedDirs: [cfg.dataDir], log });
  const data = new DataGuard({ db, dbFile: cfg.dbFile, dataDir: cfg.dataDir, backupsDir: cfg.backupsDir, store, log });
  data.start();
  const service = new ServiceControl({
    cfg, store, manager, broadcast, startedAt, log, data,
    launchMode: launch === 'background' ? 'background' : launch === 'scheduled-task' ? 'scheduled-task' : 'terminal',
    shutdown: why => shutdownRef?.(why),
    taskName: process.env.MILWEB_HQ_TASK_NAME || undefined,
    defaultDataDir: path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'MilWebHQ'),
  });
  // Contas sociais: identidade e estado no banco; segredos e tokens no cofre do Windows (DPAPI), fora do banco e dos backups.
  const social = new SocialService({
    db, vault: createVault(cfg.dataDir), port: cfg.port, broadcast, log,
    profileIds: () => store.listRooms().flatMap(r => r.profiles.map(p => p.id)),
    audit: e => { recordAudit(store, { ...e, detail: e.detail ?? null }); },
  });
  await social.init().catch(err => log.warn('cofre das redes não abriu', err));
  socialRef = social;
  social.start();
  // Sala de conteúdo: radar, calendário, peças, revisão, publicação com evidência e resultados (tarefas reais na fila única).
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const content = new ContentService({
    knowledge,
    db, store, manager, social, skills, broadcast, log, render: renderWithEdge,
    routines: { handle: m => routines.handle(m), update: (id, patch) => routines.handle({ type: 'routine.update', reqId: 'content', id, patch }) },
    slideRender: edgeSlideRenderer, carouselFontsDir: path.join(repoRoot, 'server', 'assets', 'carrossel', 'fonts'),
    // Vídeo da equipe: o video.json vira MP4 com a composição CenasReel do projeto Remotion do Chefe (local, sem custo).
    video: remotionRenderer(process.env.MILWEB_HQ_REMOTION_DIR || path.join(os.homedir(), 'projetos', 'remotion-video')),
    // Referência de vídeo: ferramentas locais (yt-dlp, FFmpeg, whisper.cpp do remotion-video) e o Edge sem janela para a página.
    videoTools: { ...findTools(os.homedir(), cmd => { try { return execFileSync('where', [cmd], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim() || null; } catch { return null; } }), page: pageSnapshot },
    meetings: { handle: m => meetings.handle(m), messages: id => meetingStore.listMessages(id) },
    kitDir: path.join(repoRoot, 'content-kit'),
    trusted: folder => { try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }; const k = Object.keys(j.projects ?? {}).find(p => path.resolve(p).toLowerCase() === path.resolve(folder).toLowerCase()); return k ? Boolean(j.projects![k].hasTrustDialogAccepted) : false; } catch { return null; } },
    defaultFolder: process.env.MILWEB_HQ_CONTENT_DIR || path.join(os.homedir(), 'projetos', 'hq-conteudos'),
    audit: e => { recordAudit(store, { ...e, detail: e.detail ?? null }); },
  });
  contentRef = content;
  // Navegador da HQ (um componente só): perfis persistentes por conta, uma janela por vez, identidade conferida, porta de publicação.
  const browser = new BrowserBroker({
    db, profilesRoot: path.join(cfg.dataDir, 'browser-profiles'), log,
    // Pedido do Chefe (02/11/2026): a sala usa o Edge dele, com os logins que ele já tem, pela extensão oficial do Playwright.
    engine: process.env.MILWEB_HQ_BROWSER_ENGINE === 'perfil' ? 'perfil' : 'extensao',
    extensionToken: () => social.extensionToken(),
    account: slot => social.account(slot),
    content: {
      folder: () => content.contentFolder(),
      publishGate: (i, s) => content.publishGate(i, s), openAttempt: i => content.openAttempt(i),
      browserIntent: (i, s, m, w) => content.browserIntent(i, s, m, w), browserClicked: (i, c, sig) => content.browserClicked(i, c, sig),
      browserUncertain: (i, c, r) => content.browserUncertain(i, c, r), browserNotFound: (i, e) => content.browserNotFound(i, e),
      browserPublished: (i, u, d, m) => content.browserPublished(i, u, d, m), browserResult: r => content.browserResult(r),
    },
    notify: (sid, level, text) => manager.noticeTo(sid, level, text),
    sessionLabel: sid => manager.sessionLabel(sid),
    onChange: () => social.refresh(),
  });
  browserRef = browser;
  social.setBrowser(browser, BROWSER_ENGINE);
  await social.loadExtensionToken();
  manager.setBrowserMcp(sid => ({ command: process.execPath, args: [path.join(repoRoot, 'server', 'browser-mcp.mjs')], url: `http://${cfg.host}:${cfg.port}`, token: browser.issueToken(sid) }));
  manager.on('task_finished', taskId => { const sid = manager.taskSession(taskId); if (sid) browser.release(sid); });
  content.start();
  wsHandle = attachWs(httpServer, { preview, config: cfg, store, manager, external, serverInfo, fs: fsService, meetings, ai: registry, skills, routines, service, social, content, desk, knowledge, startedAt });
  routines.start().catch(err => log.warn('rotinas não iniciaram', err));
  const ws = wsHandle;

  // Inspeção do Claude Code real (não bloqueia a abertura da interface).
  probeClaude(process.env.MILWEB_HQ_CLAUDE_PATH).then(info => {
    claude = info;
    log.info(`Claude Code: ${info.exePath ?? 'não encontrado'} · versão ${info.version ?? '?'} · auth ${info.authOk === null ? '?' : info.authOk ? 'ok' : 'FALHOU'} (${info.authDetail ?? ''})${info.apiKeyInEnv ? ' · ANTHROPIC_API_KEY presente no ambiente (ignorada nos processos da HQ)' : ''}`);
    ws.broadcast({ kind: 'serverInfo', serverInfo: serverInfo() });
    claudeAdapter.seed(info);
    probing = false;
    manager.dispatch();
    meetings.pump();
    external.start(15_000);
    // ChatGPT via Codex: descobre instalação, login e modelos em segundo plano (sem login o cartão diz isso, honestamente).
    registry.refresh('openai').then(s => log.info(`Codex: ${s.installed ? `${s.exePath} · versão ${s.version ?? '?'}` : 'não encontrado'} · login ${s.authState}${s.authMethod ? ' (' + s.authMethod + ')' : ''} · ${s.models.length} modelo(s)`)).catch(err => log.warn('inspeção do Codex falhou', err));
  }).catch(err => { log.error('inspeção do Claude Code falhou', err); probing = false; manager.dispatch(); });

  if (wantOpen) {
    try { openExternal('url', url); } catch (err) { log.warn('não abriu o navegador', err); }
  }
  if (process.argv.includes('--print-url')) console.log(url);

  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return; shuttingDown = true;
    log.info(`encerrando (${why})…`);
    routines.stop();
    social.stop();
    content.stop();
    try { await browser.shutdown(); } catch (err) { log.warn('erro ao fechar o navegador da HQ', err); }
    data.stop();
    await preview.stop().catch(() => { /* ignorar */ });
    external.stop();
    try { fsService.close(); } catch (err) { log.warn('erro ao encerrar o serviço de arquivos', err); }
    try { await meetings.shutdown(); } catch (err) { log.warn('erro ao encerrar a reunião', err); }
    try { await registry.shutdown(); } catch (err) { log.warn('erro ao encerrar os provedores de IA', err); }
    try { await manager.shutdown(); } catch (err) { log.error('erro ao encerrar processos', err); }
    ws.close();
    httpServer.close();
    try { db.close(); } catch { /* ignorar */ }
    setTimeout(() => process.exit(0), 200).unref();
  };
  shutdownRef = why => { shutdown(why).catch(err => log.error('erro ao encerrar', err)); };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('uncaughtException', err => { log.error('exceção não tratada', err); });
  process.on('unhandledRejection', err => { log.error('promessa rejeitada', err as Error); });
}

main().catch(err => { console.error(err); process.exit(1); });
