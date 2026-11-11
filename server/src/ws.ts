// WebSocket em loopback com token e checagem de origem. Toda operação que controla o computador passa por aqui.
import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { isTeamId, readRequest, teamOfSlot, type TeamId } from '@milweb-hq/protocol';
import type { AiClientMessage, ClientMessage, Folder, FsClientMessage, MeetingClientMessage, ServerInfo, ServerMessage, Snapshot, WorkClientMessage } from '@milweb-hq/protocol';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { SessionManager } from './sessions.js';
import type { ExternalObserver } from './external.js';
import { fileTree, gitDiff, gitStatus, readProjectFile } from './files.js';
import { openExternal } from './open-external.js';
import { viewFile } from './file-view.js';
import { recordAudit } from './audit.js';
import { log } from './log.js';
import fs from 'node:fs';
import path from 'node:path';

/** Serviço de arquivos, pastas extras e lixeira (server/src/fs). Tipado pela forma para o ws.ts não depender da implementação. */
export interface FsServiceLike {
  /** Executa a mensagem e devolve o dado do reply (undefined para mensagens sem reqId). Erros estruturados levam `code`/`data`. */
  handle(msg: FsClientMessage, client: object): Promise<unknown>;
  /** Cancela assinaturas (fs.watch) do cliente que desconectou. */
  onClientClose(client: object): void;
}

/** Sala de reunião e provedores de IA (v3), tipados pela forma. */
export interface MeetingsLike { list(): import('@milweb-hq/protocol').Meeting[]; handle(msg: MeetingClientMessage): Promise<unknown> }
export interface AiLike { statuses(): import('@milweb-hq/protocol').AiProviderStatus[]; handle(msg: AiClientMessage): Promise<unknown>; onSettingsChanged(): void }

/** Serviços da v4 (catálogo de skills/agentes, rotinas, serviço em segundo plano), tipados pela forma. */
export interface WorkServiceLike { handle(msg: WorkClientMessage): Promise<unknown> }
/** Contas sociais (central de Redes). */
export interface SocialLike { state(): import('@milweb-hq/protocol').SocialState; handle(msg: import('@milweb-hq/protocol').SocialClientMessage): Promise<unknown> }
/** Trabalho de conteúdo da sala Social Media (radar, calendário, peças, resultados). */
export interface DeskLike { state(): import('@milweb-hq/protocol').DeskState; handle(msg: import('@milweb-hq/protocol').DeskClientMessage): Promise<unknown>; watch?(taskId: string, request: string): void }
/** Conhecimento da equipe: orientações persistidas, recuperadas por escopo em cada tarefa. */
export interface KnowledgeLike {
  board(): import('@milweb-hq/protocol').KnowledgeBoard;
  handle(msg: import('@milweb-hq/protocol').KnowledgeClientMessage): Promise<unknown>;
  captureFromChefe(text: string, ctx: { team?: import('@milweb-hq/protocol').TeamId | null; taskId?: string | null; where: string }): unknown;
  teach(input: import('@milweb-hq/protocol').KnowledgeInput, clientId?: string | null): unknown;
}
export interface ContentLike { state(): import('@milweb-hq/protocol').ContentState; handle(msg: import('@milweb-hq/protocol').ContentClientMessage): Promise<unknown> }

export interface WsDeps {
  /** Marco 1: prévia local dos projetos. */
  preview?: { urlFor(p: import('@milweb-hq/protocol').Project): Promise<{ url: string; entry: string } | { error: string }>; fileUrl(abs: string): Promise<{ url: string; real: string; projectId: string }> };
  config: Config; store: Store; manager: SessionManager; external: ExternalObserver; serverInfo: () => ServerInfo; fs?: FsServiceLike; meetings?: MeetingsLike; ai?: AiLike;
  skills?: WorkServiceLike; routines?: WorkServiceLike; service?: WorkServiceLike; social?: SocialLike; content?: ContentLike; desk?: DeskLike; knowledge?: KnowledgeLike;
  /** Momento em que o serviço subiu (fallback do "Enquanto você esteve fora" quando não há lastSeenAt). */
  startedAt?: number;
}

function tokenOk(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function originAllowed(origin: string | undefined, cfg: Config): boolean {
  if (!origin) return true; // clientes sem Origin (scripts locais) não são navegadores; o token continua obrigatório
  const allowed = new Set([`http://127.0.0.1:${cfg.port}`, `http://localhost:${cfg.port}`, ...cfg.devOrigins]);
  return allowed.has(origin);
}

const FS_PREFIX = /^(fs|trash|folder)\./;
const MEETING_PREFIX = /^(meeting\.|task\.release$)/;
const AI_PREFIX = /^ai\./;
const SKILLS_PREFIX = /^(skills\.|agents\.)/;
const ROUTINE_PREFIX = /^routine\./;
const SERVICE_PREFIX = /^service\./;
const SOCIAL_PREFIX = /^social\./;
const CONTENT_PREFIX = /^content\./;
const DESK_PREFIX = /^desk\./;
const KNOWLEDGE_PREFIX = /^knowledge\./;

export function attachWs(server: http.Server, deps: WsDeps): { broadcast: (m: ServerMessage) => void; close: () => void } {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${deps.config.host}:${deps.config.port}`);
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    if (!originAllowed(req.headers.origin, deps.config)) { log.warn(`origem recusada no WebSocket: ${req.headers.origin}`); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  const sendTo = (ws: WebSocket, m: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const broadcast = (m: ServerMessage) => { const s = JSON.stringify(m); for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s); };

  deps.manager.on('broadcast', broadcast);

  function snapshot(): Snapshot {
    const ext = deps.external.current();
    return {
      serverInfo: deps.serverInfo(), settings: deps.store.getSettings(), rooms: deps.store.listRooms(),
      projects: [...deps.store.listProjects(), ...ext.virtualProjects],
      folders: deps.store.listFolders(), employees: deps.store.listEmployees(),
      sessions: [...deps.manager.listSessions(), ...ext.sessions], workers: [...deps.manager.listWorkers(), ...ext.workers],
      tasks: deps.store.listTasks(200), pendingPermissions: deps.manager.pendingPermissions(), snapshotAt: Date.now(), seq: 0,
      meetings: deps.meetings?.list() ?? [], ai: deps.ai?.statuses() ?? [], routines: deps.store.listRoutines(), social: deps.social?.state(), content: deps.content?.state(), desk: deps.desk?.state(), knowledge: deps.knowledge?.board(),
    };
  }
  /** Última vez em que havia uma interface conectada: gravada quando o último cliente sai (base do "Enquanto você esteve fora"). */
  let closing = false;
  const noteLastSeen = () => { if (clients.size === 0 && !closing) { try { deps.store.saveSettings({ lastSeenAt: Date.now() }); } catch (err) { log.warn('não gravou lastSeenAt', err); } } };

  wss.on('connection', (ws) => {
    let authed = false;
    ws.on('message', async (data) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(String(data)) as ClientMessage; } catch { sendTo(ws, { kind: 'error', message: 'mensagem inválida' }); return; }
      if (!authed) {
        if (msg.type === 'hello' && typeof msg.token === 'string' && tokenOk(msg.token, deps.config.token)) {
          authed = true; clients.add(ws); sendTo(ws, { kind: 'snapshot', snapshot: snapshot() });
        } else { sendTo(ws, { kind: 'error', message: 'token inválido' }); ws.close(4001, 'unauthorized'); }
        return;
      }
      try { await handle(msg, ws); } catch (err) {
        const e = err as Error & { code?: unknown; data?: unknown };
        const text = e?.message ?? String(err);
        // Erro estruturado (ex.: FsError com code 'in_use' e a lista de execuções dependentes) chega inteiro ao cliente.
        const code = typeof e?.code === 'string' ? e.code : undefined;
        if ('reqId' in msg && typeof msg.reqId === 'string') sendTo(ws, { kind: 'reply', reqId: msg.reqId, ok: false, error: text, ...(code ? { code } : {}), ...(e?.data !== undefined ? { data: e.data } : {}) });
        else sendTo(ws, { kind: 'error', message: text });
      }
    });
    ws.on('close', () => { const was = clients.delete(ws); deps.fs?.onClientClose(ws); if (was) noteLastSeen(); });
  });

  async function handle(msg: ClientMessage, ws: WebSocket): Promise<void> {
    const { store, manager } = deps;
    const reply = (reqId: string, data: unknown) => sendTo(ws, { kind: 'reply', reqId, ok: true, data });
    const projectOf = (id: string) => { const p = store.getProject(id); if (!p) throw new Error('projeto não encontrado'); return p; };

    // Explorador de arquivos, pastas extras e lixeira: delegados ao serviço de arquivos (valida caminhos no servidor).
    if (FS_PREFIX.test(msg.type)) {
      if (!deps.fs) throw new Error('o explorador de arquivos não está disponível neste serviço');
      const fsMsg = msg as FsClientMessage;
      const data = await deps.fs.handle(fsMsg, ws);
      if ('reqId' in fsMsg && typeof fsMsg.reqId === 'string') reply(fsMsg.reqId, data);
      // O serviço já avisa 'entity folder upsert' ao cadastrar; a remoção é avisada aqui.
      if (fsMsg.type === 'folder.remove') broadcast({ kind: 'entity', entity: 'folder', op: 'delete', item: { id: fsMsg.id } });
      return;
    }
    // Sala de reunião: o coordenador valida tudo no servidor e transmite as mudanças.
    if (MEETING_PREFIX.test(msg.type)) {
      if (!deps.meetings) throw new Error('a sala de reunião não está disponível neste serviço');
      const mm = msg as MeetingClientMessage;
      const data = await deps.meetings.handle(mm);
      if ('reqId' in mm && typeof mm.reqId === 'string') reply(mm.reqId, data);
      return;
    }
    if (AI_PREFIX.test(msg.type)) {
      if (!deps.ai) throw new Error('os provedores de IA não estão disponíveis neste serviço');
      const am = msg as AiClientMessage;
      const data = await deps.ai.handle(am);
      if ('reqId' in am && typeof am.reqId === 'string') reply(am.reqId, data);
      return;
    }
    if (SOCIAL_PREFIX.test(msg.type)) {
      if (!deps.social) throw new Error('a central de Redes não está disponível neste serviço');
      const sm = msg as import('@milweb-hq/protocol').SocialClientMessage;
      const data = await deps.social.handle(sm);
      if ('reqId' in sm && typeof sm.reqId === 'string') reply(sm.reqId, data);
      return;
    }
    if (DESK_PREFIX.test(msg.type)) {
      if (!deps.desk) throw new Error('a mesa do Chefe não está disponível neste serviço');
      const dm = msg as import('@milweb-hq/protocol').DeskClientMessage;
      const data = await deps.desk.handle(dm);
      if (dm.type === 'desk.adjust' && dm.note?.trim()) {
        // Correção pontual vale para esta entrega. Vira preferência só quando o Chefe marca "Usar nos próximos trabalhos"
        // (escopo escolhido por ele) ou escreve a orientação explícita ("sempre...", "lembre disso para...").
        const d = deps.desk.state().deliveries.find(x => x.id === dm.id) ?? null;
        const team = isTeamId(d?.profileId) ? d!.profileId as TeamId : teamOfSlot(d?.slot ?? null);
        try {
          if (dm.remember) deps.knowledge?.teach({ kind: 'preferencia', scope: dm.remember, text: dm.note.trim(), origin: 'ajuste', originNote: `Ajuste seu na entrega "${d?.title ?? ''}" v${d?.version ?? '?'}, marcado para os próximos trabalhos`, evidence: d ? [{ kind: 'entrega', ref: d.id, label: `${d.title} v${d.version}` }, { kind: 'tarefa', ref: d.taskId, label: 'tarefa da versão que você corrigiu' }] : [] }, `desk:remember:${dm.id}`);
          else deps.knowledge?.captureFromChefe(dm.note, { team, taskId: d?.adjustTaskId ?? null, where: `no ajuste da entrega "${d?.title ?? ''}"` });
        } catch (err) { log.warn('conhecimento: preferência do ajuste não registrada', err); }
      }
      if ('reqId' in dm && typeof dm.reqId === 'string') reply(dm.reqId, data);
      return;
    }
    if (KNOWLEDGE_PREFIX.test(msg.type)) {
      if (!deps.knowledge) throw new Error('o conhecimento da equipe não está disponível neste serviço');
      const km = msg as import('@milweb-hq/protocol').KnowledgeClientMessage;
      const data = await deps.knowledge.handle(km);
      if ('reqId' in km && typeof km.reqId === 'string') reply(km.reqId, data);
      return;
    }
    if (CONTENT_PREFIX.test(msg.type)) {
      if (!deps.content) throw new Error('o trabalho de conteúdo não está disponível neste serviço');
      const cm = msg as import('@milweb-hq/protocol').ContentClientMessage;
      const data = await deps.content.handle(cm);
      // Orientação explícita dentro do pedido ("lembre disso para o Tuco", "sempre...") fica registrada no escopo indicado.
      if (cm.type === 'content.manager.ask') deps.knowledge?.captureFromChefe(cm.text, { team: cm.teams?.length === 1 ? cm.teams[0] : null, where: 'no pedido à gerente' });
      else if (cm.type === 'content.quick.create') deps.knowledge?.captureFromChefe(cm.text, { team: teamOfSlot(cm.slot), where: 'no pedido de uma peça' });
      else if (cm.type === 'content.item.produce' && cm.note) deps.knowledge?.captureFromChefe(cm.note, { team: teamOfSlot(deps.content.state().items?.find(i => i.id === cm.id)?.slot ?? null), where: 'no ajuste de uma peça' });
      if ('reqId' in cm && typeof cm.reqId === 'string') reply(cm.reqId, data);
      return;
    }
    // v4: catálogo de skills/agentes, rotinas e serviço em segundo plano (cada um valida no servidor e transmite mudanças).
    const workService = SKILLS_PREFIX.test(msg.type) ? ['o catálogo de skills', deps.skills] as const : ROUTINE_PREFIX.test(msg.type) ? ['as rotinas', deps.routines] as const : SERVICE_PREFIX.test(msg.type) ? ['o controle do serviço', deps.service] as const : null;
    if (workService) {
      const [label, svc] = workService;
      if (!svc) throw new Error(`${label} não está disponível neste serviço`);
      const wm = msg as WorkClientMessage;
      const data = await svc.handle(wm);
      if ('reqId' in wm && typeof wm.reqId === 'string') reply(wm.reqId, data);
      return;
    }

    switch (msg.type) {
      case 'hello': sendTo(ws, { kind: 'snapshot', snapshot: snapshot() }); return;
      case 'room.create': { const room = store.createRoom(msg.room); broadcast({ kind: 'entity', entity: 'room', op: 'upsert', item: room }); return; }
      case 'room.update': { const room = store.updateRoom(msg.id, msg.patch); if (room) broadcast({ kind: 'entity', entity: 'room', op: 'upsert', item: room }); return; }
      case 'room.delete': {
        if (store.listProjects().some(p => p.roomId === msg.id) || store.listSessions().some(s => s.roomId === msg.id) || store.listActiveEmployees().some(e => e.roomId === msg.id)) throw new Error('mova os projetos, funcionários e sessões antes de apagar a sala');
        const room = store.getRoom(msg.id);
        store.deleteRoom(msg.id); broadcast({ kind: 'entity', entity: 'room', op: 'delete', item: { id: msg.id } });
        recordAudit(store, { action: 'excluir', entity: 'sala', entityId: msg.id, title: room?.name ?? null, origin: 'interface', detail: null }); return;
      }
      case 'project.create': {
        const p = path.resolve(msg.path.trim());
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`a pasta não existe: ${p}`);
        if (!store.getRoom(msg.roomId)) throw new Error('sala não encontrada');
        const dup = store.findProjectByPath(p);
        if (dup) throw new Error(`esta pasta já está cadastrada como "${dup.name}"`);
        const project = store.createProject({ name: msg.name.trim() || path.basename(p), path: p, roomId: msg.roomId });
        broadcast({ kind: 'entity', entity: 'project', op: 'upsert', item: project }); reply(msg.reqId, project); return;
      }
      case 'project.update': { const project = store.updateProject(msg.id, msg.patch); if (project) broadcast({ kind: 'entity', entity: 'project', op: 'upsert', item: project }); return; }
      case 'project.delete': {
        // "Remover da HQ": só tira do cadastro; os arquivos ficam onde estão (apagar arquivos é outra ação, pelo explorador).
        if (store.listSessions().some(s => s.projectId === msg.id)) throw new Error('arquive as conversas deste projeto antes de removê-lo da HQ');
        const project = store.getProject(msg.id);
        store.deleteProject(msg.id); broadcast({ kind: 'entity', entity: 'project', op: 'delete', item: { id: msg.id } });
        recordAudit(store, { action: 'remover da HQ', entity: 'projeto', entityId: msg.id, title: project?.name ?? null, origin: 'interface', detail: project ? `pasta mantida no disco: ${project.path}` : null }); return;
      }
      case 'employee.create': { const e = manager.createEmployee(msg); reply(msg.reqId, e); return; }
      case 'employee.update': manager.updateEmployee(msg.id, msg.patch); return;
      case 'employee.archive': { const e = store.getEmployee(msg.id); await manager.archiveEmployee(msg.id); recordAudit(store, { action: 'arquivar', entity: 'funcionário', entityId: msg.id, title: e?.name ?? null, origin: 'interface', detail: 'conversas e tarefas guardadas' }); return; }
      case 'employee.unarchive': { const e = store.getEmployee(msg.id); manager.unarchiveEmployee(msg.id); recordAudit(store, { action: 'desarquivar', entity: 'funcionário', entityId: msg.id, title: e?.name ?? null, origin: 'interface', detail: null }); return; }
      case 'employee.setActiveSession': manager.setActiveSession(msg.id, msg.sessionId); return;
      case 'session.create': { const s = manager.createSession(msg); reply(msg.reqId, s); return; }
      case 'employee.dm.open': { const s = manager.openDm(msg.employeeId); reply(msg.reqId, s); return; }
      case 'session.resume': manager.resumeSession(msg.sessionId); return;
      case 'session.close': await manager.closeSession(msg.sessionId); return;
      case 'session.archive': { const s = store.getSession(msg.sessionId); await manager.closeSession(msg.sessionId, true); recordAudit(store, { action: 'arquivar', entity: 'conversa', entityId: msg.sessionId, title: s?.name ?? null, origin: 'interface', detail: 'histórico guardado' }); return; }
      case 'session.interrupt': await manager.interrupt(msg.sessionId); return;
      case 'session.setModel': manager.updateSessionOptions(msg.sessionId, { model: msg.model }); return;
      case 'session.setPermissionMode': manager.updateSessionOptions(msg.sessionId, { permissionMode: msg.mode }); return;
      case 'session.setEffort': manager.updateSessionOptions(msg.sessionId, { effort: msg.effort }); return;
      case 'session.setProfile': manager.setProfile(msg.sessionId, msg.profileId); return;
      case 'prompt.send': {
        const task = await manager.sendPrompt(msg);
        const sp = store.getSession(msg.sessionId)?.profileId ?? null;
        deps.knowledge?.captureFromChefe(msg.text, { team: isTeamId(sp) ? sp : null, taskId: task.id, where: 'na conversa' });
        reply(msg.reqId, task); return;
      }
      case 'prompt.steer': { reply(msg.reqId, await manager.steer(msg)); return; }
      case 'task.run': {
        const result = await manager.runTask(msg);
        if (!result.duplicate) {
          const t = store.getTask(result.taskId);
          const team = isTeamId(t?.profileId) ? t!.profileId as TeamId : teamOfSlot(msg.destinationId ?? null);
          deps.knowledge?.captureFromChefe(msg.text, { team, taskId: result.taskId, where: 'no pedido' });
          // Pedido de trabalho (não conversa): o resultado chega à Minha mesa como entrega, com o que a HQ conferiu.
          if (!msg.plan && !['conversar', 'status'].includes(readRequest(msg.text, { profileTeam: team }).intent)) deps.desk?.watch?.(result.taskId, msg.text);
        }
        reply(msg.reqId, result); return;
      }
      case 'task.retry': { const task = await manager.retryTask(msg.taskId); reply(msg.reqId, task); return; }
      case 'task.markVerified': manager.markVerified(msg.taskId); return;
      case 'away.summary': { const since = msg.since ?? store.getSettings().lastSeenAt ?? deps.startedAt ?? Date.now(); reply(msg.reqId, manager.awaySummary(since)); return; }
      case 'task.cancelQueued': manager.cancelQueued(msg.taskId); return;
      case 'permission.respond': manager.respondPermission(msg.sessionId, msg.requestId, msg.behavior, msg.message, msg.remember); return;
      case 'question.answer': manager.answerQuestion(msg.sessionId, msg.requestId, msg.answers); return;
      case 'chat.history': reply(msg.reqId, store.listChat(msg.sessionId, msg.limit ?? 400)); return;
      case 'events.history': reply(msg.reqId, store.listEvents(msg.sessionId, msg.limit ?? 500)); return;
      case 'files.tree': { const p = projectOf(msg.projectId); reply(msg.reqId, fileTree(p.path, msg.path, Math.min(msg.depth ?? 1, 3))); return; }
      case 'files.read': { const p = projectOf(msg.projectId); reply(msg.reqId, readProjectFile(p.path, msg.path)); return; }
      case 'git.status': { const p = projectOf(msg.projectId); reply(msg.reqId, await gitStatus(p.path)); return; }
      case 'git.diff': { const p = projectOf(msg.projectId); reply(msg.reqId, await gitDiff(p.path, msg.path)); return; }
      case 'preview.check': reply(msg.reqId, await checkPreview(msg.url)); return;
      case 'preview.local': {
        if (!deps.preview) throw new Error('a prévia local não está disponível neste serviço');
        reply(msg.reqId, await deps.preview.urlFor(projectOf(msg.projectId))); return;
      }
      case 'settings.update': {
        // O nome da empresa só entra por company.setName (validado); aqui ele é ignorado.
        const { companyName: _companyName, ...patch } = msg.patch ?? {};
        const s = store.saveSettings(patch); broadcast({ kind: 'settings', settings: s }); deps.ai?.onSettingsChanged(); manager.dispatch(); return;
      }
      case 'company.setName': {
        // Primeiro acesso e Ajustes → Empresa. Só responde depois de gravar no SQLite; repetir o mesmo nome não muda nada.
        const before = store.getSettings().companyName;
        const s = store.setCompanyName(msg.name);
        if (s.companyName !== before) { log.info(`nome da empresa ${before ? 'alterado' : 'definido'}`); broadcast({ kind: 'settings', settings: s }); }
        reply(msg.reqId, { companyName: s.companyName }); return;
      }
      case 'external.refresh': { await deps.external.refresh(); sendTo(ws, { kind: 'snapshot', snapshot: snapshot() }); return; }
      case 'open.external': openExternal(msg.target, msg.value); return;
      case 'file.view': reply(msg.reqId, await viewFile(msg.path, deps.preview)); return;
      default: throw new Error(`operação desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  return { broadcast, close: () => {
    // Encerrando com a interface aberta: grava a "última vez visto" AGORA, antes de o banco fechar (as conexões fecham depois).
    if (clients.size > 0) { try { deps.store.saveSettings({ lastSeenAt: Date.now() }); } catch (err) { log.warn('não gravou lastSeenAt', err); } }
    closing = true;
    for (const c of clients) c.close(); wss.close();
  } };
}

async function checkPreview(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, error: 'URL inválida' }; }
  if (!/^https?:$/.test(u.protocol) || !['localhost', '127.0.0.1'].includes(u.hostname)) return { ok: false, error: 'o preview embutido só aceita endereços locais (localhost / 127.0.0.1)' };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(u, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(t);
    return { ok: res.status < 500, status: res.status };
  } catch (err) { return { ok: false, error: `sem resposta em ${u.host} (${(err as Error).name === 'AbortError' ? 'tempo esgotado' : 'conexão recusada'})` }; }
}
