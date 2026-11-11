// Estado do app: espelho do snapshot do servidor + atualizações incrementais. Só o que o servidor observou entra aqui.
// Ao desconectar, nada é apagado: a interface mostra o "último estado conhecido" com a hora do último retrato.
import { useSyncExternalStore } from 'react';
import type { ContentState,
  AiProviderStatus, ChatItem, Employee, Folder, Meeting, MeetingDecision, MeetingHistory, MeetingTaskItem, PendingPermission, Project, Room, Routine, ServerInfo,
  ServerMessage, ServiceStatus, Session, Settings, Snapshot, Task, Worker, DeskState, KnowledgeBoard, KnowledgeItem } from '@milweb-hq/protocol';
import { DEFAULT_SETTINGS } from '@milweb-hq/protocol';
import type { SocialState } from '@milweb-hq/protocol';
import type { TimelineEntry } from '../panel/types';
import type { ConnectionState } from './client';

export interface Notice { id: number; level: 'info' | 'warn' | 'error'; text: string; ts: number; /** Ação opcional (ex.: Desfazer). */ action?: { label: string; run(): void } }

export interface FsChange { nonce: number; paths: string[] }

export interface AppState {
  connection: ConnectionState;
  serverInfo: ServerInfo | null;
  settings: Settings;
  rooms: Room[];
  projects: Project[];
  folders: Folder[];
  /** Todos os funcionários, inclusive arquivados (archivedAt != null). */
  employees: Employee[];
  sessions: Session[];
  workers: Worker[];
  tasks: Task[];
  pending: PendingPermission[];
  /** Por sessão: histórico do chat (carregado sob demanda) e texto parcial em streaming. */
  chat: Record<string, ChatItem[]>;
  chatLoaded: Record<string, boolean>;
  streaming: Record<string, string>;
  events: Record<string, TimelineEntry[]>;
  eventsLoaded: Record<string, boolean>;
  /** Reuniões (sala de reunião v3), mais recente primeiro. */
  meetings: Meeting[];
  /** Estado real dos provedores de IA (Claude via Claude Code, ChatGPT via Codex). */
  ai: AiProviderStatus[];
  /** Central de Redes: contas, apps e cofre (sem credenciais). null = serviço sem o módulo social. */
  social: SocialState | null;
  /** Trabalho de conteúdo da sala Social Media (radar, calendário, peças, resultados). null = serviço sem o módulo. */
  content: ContentState | null;
  /** Mesa do Chefe: entregas e bloqueios persistidos no servidor. */
  desk: DeskState | null;
  /** Conhecimento da equipe: orientações persistidas e usos recentes. */
  knowledge: KnowledgeBoard | null;
  /** Última orientação que a HQ registrou sozinha a partir de uma frase do Chefe (a tela mostra o resumo com Desfazer). */
  knowledgeCaptured: KnowledgeItem | null;
  /** Por reunião: histórico (falas, turnos, quadro, contexto, itens de tarefa). Entradas ao vivo entram antes de carregar; a carga faz a união. */
  meetingHistory: Record<string, MeetingHistory>;
  /** true quando o histórico completo daquela reunião já veio do servidor (zera a cada snapshot). */
  meetingHistoryLoaded: Record<string, boolean>;
  /** Texto parcial acumulado por turno em andamento (turnId → texto); a chave some quando o turno termina. */
  meetingStreaming: Record<string, string>;
  notices: Notice[];
  /** Momento (do servidor) do último retrato completo recebido; null antes da primeira conexão. */
  lastSnapshotAt: number | null;
  /** Última mudança no disco avisada pelo servidor, por raiz; o explorador recarrega a pasta afetada. */
  fsChanges: Record<string, FsChange>;
  /** A mais recente de todas (nonce global crescente), para o explorador reagir a qualquer raiz. */
  lastFsChange: (FsChange & { rootId: string }) | null;
  /** Incrementa a cada mudança na lixeira. */
  trashNonce: number;
  /** Rotinas agendadas (v4). */
  routines: Routine[];
  /** Estado do serviço em segundo plano (chega por service.status; null até o primeiro pedido). */
  serviceStatus: ServiceStatus | null;
  /** Incrementa quando o servidor avisa que o catálogo de skills mudou (skill adicionada, init novo com a lista). */
  skillsNonce: number;
}

const MAX_CHAT = 600;
const MAX_EVENTS = 800;
let noticeSeq = 0;

export function emptyState(): AppState {
  return {
    connection: 'closed', serverInfo: null, settings: DEFAULT_SETTINGS, rooms: [], projects: [], folders: [], employees: [], sessions: [], workers: [], tasks: [], pending: [],
    chat: {}, chatLoaded: {}, streaming: {}, events: {}, eventsLoaded: {},
    meetings: [], ai: [], social: null, content: null, desk: null, knowledge: null, knowledgeCaptured: null, meetingHistory: {}, meetingHistoryLoaded: {}, meetingStreaming: {},
    notices: [], lastSnapshotAt: null, fsChanges: {}, lastFsChange: null, trashNonce: 0,
    routines: [], serviceStatus: null, skillsNonce: 0,
  };
}

export function emptyMeetingHistory(): MeetingHistory { return { messages: [], turns: [], decisions: [], context: [], taskItems: [] }; }

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex(x => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice(); next[i] = item; return next;
}
function remove<T extends { id: string }>(list: T[], id: string): T[] { return list.filter(x => x.id !== id); }

/** Troca o histórico de uma reunião aplicando uma função sobre o atual (ou sobre um vazio, antes da carga). */
function withHistory(s: AppState, meetingId: string, fn: (h: MeetingHistory) => MeetingHistory): AppState {
  const cur = s.meetingHistory[meetingId] ?? emptyMeetingHistory();
  return { ...s, meetingHistory: { ...s.meetingHistory, [meetingId]: fn(cur) } };
}

const TERMINAL_TURN = new Set(['done', 'failed', 'interrupted', 'lost', 'skipped']);

/** Aplica uma mensagem do servidor ao estado (função pura; usada pelo store e pelos testes). */
export function applyMessage(s: AppState, m: ServerMessage): AppState {
  switch (m.kind) {
    case 'snapshot': return applySnapshot(s, m.snapshot);
    case 'serverInfo': return { ...s, serverInfo: m.serverInfo };
    case 'settings': return { ...s, settings: m.settings };
    case 'entity': {
      const id = m.item.id;
      switch (m.entity) {
        case 'room': return { ...s, rooms: m.op === 'delete' ? remove(s.rooms, id) : sortRooms(upsert(s.rooms, m.item as Room)) };
        case 'project': return { ...s, projects: m.op === 'delete' ? remove(s.projects, id) : upsert(s.projects, m.item as Project) };
        case 'folder': return { ...s, folders: m.op === 'delete' ? remove(s.folders, id) : upsert(s.folders, m.item as Folder) };
        case 'employee': return { ...s, employees: m.op === 'delete' ? remove(s.employees, id) : upsert(s.employees, m.item as Employee) };
        case 'session': return { ...s, sessions: m.op === 'delete' ? remove(s.sessions, id) : upsert(s.sessions, m.item as Session) };
        case 'worker': return { ...s, workers: m.op === 'delete' ? remove(s.workers, id) : upsert(s.workers, m.item as Worker) };
        case 'task': return { ...s, tasks: m.op === 'delete' ? remove(s.tasks, id) : upsert(s.tasks, m.item as Task) };
        case 'meeting': {
          if (m.op === 'delete') {
            const { [id]: _h, ...meetingHistory } = s.meetingHistory; void _h;
            const { [id]: _l, ...meetingHistoryLoaded } = s.meetingHistoryLoaded; void _l;
            return { ...s, meetings: remove(s.meetings, id), meetingHistory, meetingHistoryLoaded };
          }
          return { ...s, meetings: sortMeetings(upsert(s.meetings, m.item as Meeting)) };
        }
      }
      return s;
    }
    case 'session.activity': {
      const sessions = s.sessions.map(x => x.id === m.sessionId ? { ...x, activity: m.activity, processState: m.processState } : x);
      return { ...s, sessions, workers: upsert(s.workers, m.worker) };
    }
    case 'event': {
      const list = s.events[m.sessionId] ?? [];
      if (list.some(e => e.seq === m.seq)) return s;
      const next = [...list, { seq: m.seq, taskId: m.taskId, entry: m.entry }];
      return { ...s, events: { ...s.events, [m.sessionId]: next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next } };
    }
    case 'chat.delta': return { ...s, streaming: { ...s.streaming, [m.sessionId]: m.text } };
    case 'chat.item': {
      const list = s.chat[m.sessionId] ?? [];
      const next = upsert(list, m.item);
      return { ...s, chat: { ...s.chat, [m.sessionId]: next.length > MAX_CHAT ? next.slice(-MAX_CHAT) : next } };
    }
    case 'permission.request': {
      const pending = s.pending.filter(p => p.request.requestId !== m.pending.request.requestId);
      return { ...s, pending: [...pending, m.pending] };
    }
    case 'permission.resolved': return { ...s, pending: s.pending.filter(p => p.request.requestId !== m.requestId) };
    case 'external': return {
      ...s,
      sessions: [...s.sessions.filter(x => x.status !== 'observed'), ...m.sessions],
      workers: [...s.workers.filter(w => w.kind !== 'observed'), ...m.workers],
      projects: [...s.projects.filter(p => !p.id.startsWith('ext:')), ...m.projects],
    };
    case 'fs.changed': {
      const prev = s.fsChanges[m.rootId];
      const nonce = (s.lastFsChange?.nonce ?? 0) + 1;
      return { ...s, fsChanges: { ...s.fsChanges, [m.rootId]: { nonce: (prev?.nonce ?? 0) + 1, paths: m.paths } }, lastFsChange: { rootId: m.rootId, paths: m.paths, nonce } };
    }
    case 'trash.changed': return { ...s, trashNonce: s.trashNonce + 1 };
    // ---- sala de reunião ----
    case 'meeting.message': return withHistory(s, m.meetingId, h => ({ ...h, messages: upsert(h.messages, m.message) }));
    case 'meeting.delta': {
      if (m.text === '') { if (!(m.turnId in s.meetingStreaming)) return s; const { [m.turnId]: _t, ...rest } = s.meetingStreaming; void _t; return { ...s, meetingStreaming: rest }; }
      return { ...s, meetingStreaming: { ...s.meetingStreaming, [m.turnId]: m.text } };
    }
    case 'meeting.turn': {
      let next = withHistory(s, m.meetingId, h => ({ ...h, turns: upsert(h.turns, m.turn) }));
      if (TERMINAL_TURN.has(m.turn.status) && m.turn.id in next.meetingStreaming) { const { [m.turn.id]: _t, ...rest } = next.meetingStreaming; void _t; next = { ...next, meetingStreaming: rest }; }
      return next;
    }
    case 'meeting.decision': return withHistory(s, m.meetingId, h => ({ ...h, decisions: m.op === 'delete' ? remove(h.decisions, m.decision.id) : upsert(h.decisions, m.decision as MeetingDecision) }));
    case 'meeting.context': {
      const next = withHistory(s, m.meetingId, h => ({ ...h, context: m.items }));
      return { ...next, meetings: next.meetings.map(x => x.id === m.meetingId ? { ...x, contextVersion: m.contextVersion } : x) };
    }
    case 'meeting.taskItem': return withHistory(s, m.meetingId, h => ({ ...h, taskItems: m.op === 'delete' ? remove(h.taskItems, m.item.id) : upsert(h.taskItems, m.item as MeetingTaskItem) }));
    case 'ai.status': return { ...s, ai: m.providers };
    case 'social.state': return { ...s, social: m.state };
    case 'content.state': return { ...s, content: m.state };
    case 'desk.state': return { ...s, desk: m.state };
    case 'knowledge.state': return { ...s, knowledge: m.state };
    case 'knowledge.captured': return { ...s, knowledgeCaptured: m.item };
    case 'meeting.plan': return withHistory(s, m.meetingId, h => ({ ...h, plans: m.plans, planTasks: m.planTasks }));
    // ---- trabalho diário (v4) ----
    case 'routine': return { ...s, routines: m.op === 'delete' ? remove(s.routines, m.routine.id) : upsert(s.routines, m.routine as Routine) };
    case 'service.status': return { ...s, serviceStatus: m.status };
    case 'skills.changed': return { ...s, skillsNonce: s.skillsNonce + 1 };
    case 'notice': return pushNotice(s, m.level, m.text);
    case 'error': return pushNotice(s, 'error', m.message);
    case 'reply': return s;
  }
  return s;
}

function sortRooms(rooms: Room[]): Room[] { return rooms.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)); }
/** Mais recente primeiro (criação); a lista da tela decide destaques por estado. */
function sortMeetings(meetings: Meeting[]): Meeting[] { return meetings.slice().sort((a, b) => b.createdAt - a.createdAt || a.title.localeCompare(b.title)); }

/**
 * União do histórico carregado do servidor com o que chegou ao vivo enquanto o pedido estava em curso:
 * o carregado manda (é o retrato completo), e itens ao vivo que ainda não estão nele entram no fim.
 */
export function mergeMeetingHistory(loaded: MeetingHistory, live: MeetingHistory | undefined): MeetingHistory {
  if (!live) return loaded;
  const union = <T extends { id: string }>(a: T[], b: T[]) => { const out = [...a]; for (const it of b) if (!out.some(x => x.id === it.id)) out.push(it); return out; };
  return {
    messages: union(loaded.messages, live.messages),
    turns: union(loaded.turns, live.turns),
    decisions: union(loaded.decisions, live.decisions),
    context: loaded.context,
    taskItems: union(loaded.taskItems, live.taskItems),
  };
}

export function applySnapshot(s: AppState, snap: Snapshot): AppState {
  return {
    ...s,
    serverInfo: snap.serverInfo, settings: snap.settings, rooms: sortRooms(snap.rooms), projects: snap.projects,
    folders: snap.folders ?? [], employees: snap.employees ?? [],
    sessions: snap.sessions, workers: snap.workers, tasks: snap.tasks, pending: snap.pendingPermissions,
    meetings: sortMeetings(snap.meetings ?? []), ai: snap.ai ?? [], routines: snap.routines ?? [], social: snap.social ?? null, content: snap.content ?? null, desk: snap.desk ?? null, knowledge: snap.knowledge ?? null,
    lastSnapshotAt: snap.snapshotAt ?? Date.now(),
    // Histórico por sessão/reunião é recarregado quando o painel abrir (pode ter mudado enquanto estávamos desconectados).
    chatLoaded: {}, eventsLoaded: {}, streaming: {}, meetingHistoryLoaded: {}, meetingStreaming: {},
    // O histórico de reunião guardado cai também: o que foi apagado no servidor enquanto estávamos fora não pode voltar pela união com o ao vivo.
    meetingHistory: {},
    // Depois de reconectar o disco pode ter mudado: o explorador recarrega tudo.
    fsChanges: Object.fromEntries(Object.entries(s.fsChanges).map(([k, v]) => [k, { nonce: v.nonce + 1, paths: [] }])),
    lastFsChange: s.lastFsChange ? { ...s.lastFsChange, paths: [], nonce: s.lastFsChange.nonce + 1 } : null,
    trashNonce: s.trashNonce + 1,
  };
}

export function pushNotice(s: AppState, level: Notice['level'], text: string, action?: Notice['action']): AppState {
  const n: Notice = { id: ++noticeSeq, level, text, ts: Date.now(), action };
  return { ...s, notices: [...s.notices.slice(-4), n] };
}

// ---------------- store com useSyncExternalStore ----------------

type Listener = () => void;

export class AppStore {
  private state: AppState = emptyState();
  private listeners = new Set<Listener>();
  get = () => this.state;
  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  set(updater: (s: AppState) => AppState) {
    const next = updater(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }
  apply(m: ServerMessage) { this.set(s => applyMessage(s, m)); }
}

export function useAppState<T>(store: AppStore, selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}
