// App real do My Company AI (v3): conecta ao serviço local, mostra o escritório com o avatar do Chefe, a equipe
// (funcionários com identidade persistente), a sala de Reuniões (Chefe + Claude + ChatGPT), projetos, explorador de arquivos e lixeira.
// Tudo o que aparece aqui vem do servidor (processos reais do Claude Code, disco real). Nada é simulado.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VideoRefComposerApi } from './shell/social/VideoRefComposer';
import type {
  AgentCatalog, AgentDefinition, AiTestResult, AwaySummary, ChatItem, DataInfo, Employee, FileNode, FsRoot, GitStatusEntry, LogEntry, MeetingClientMessage, MeetingHistory,
  PermissionModeOption, Project, ServiceStatus, Session, SkillAddResult, SkillCatalog, SkillFileContent, SkillInfo, SkillInspection, Task, TaskRunInput, TaskRunResult, TrashItem,
} from '@milweb-hq/protocol';
import { DEFAULT_ABSENCE, isDmSession } from '@milweb-hq/protocol';
import {
  AddProjectDialog, NewSessionDialog, RoomEditor, SettingsDialog, StatusBar, WorkerPanel,
  normalizePath, rateLimitNotice, truncate, workerStatusColor, type OutgoingAttachment, type PanelTab, type SendMode,
} from './panel';
import { createOfficeScene } from './scene';
import type { CameraMode, OfficeScene, SceneInteractable, SceneMeeting, SceneRoom, SceneSelection, SceneWorker } from './scene/types';
import { createFsApi, FileExplorer, TrashView } from './files';
import { HqClient, readToken, type ConnectionState } from './state/client';
import { AppStore, emptyMeetingHistory, mergeMeetingHistory, useAppState, type Notice } from './state/store';
import { Nav, type MainView } from './shell/Nav';
import { TopBar } from './shell/TopBar';
import { TaskComposer, type ComposerManager, type ComposerPrefill } from './shell/TaskComposer';
import { KnowledgeView, type KnowledgeApi } from './shell/KnowledgeView';
import { currentItems, scopeLabel as knowledgeScopeLabel, sinceLastVisit, usesOfTask } from './shell/knowledgeBoard';
import { DeskInbox, deskItems, type DeskApi, type StalledPiece } from './shell/DeskInbox';
import { FileViewer, type ViewerApi, type ViewerRequest } from './shell/FileViewer';
import { PieceDecision } from './shell/social/PiecesBoard';
import { ContentHome, type HomeMore } from './shell/social/ContentHome';
import { DmPanel, type DmState } from './shell/social/TeamNow';
import { FAVORITES_KEY, loadFavorites } from './shell/composerHelpers';
import { ConnectionOverlay } from './shell/ConnectionOverlay';
import { Minimap } from './shell/Minimap';
import { RoomPanel } from './shell/RoomPanel';
import { TeamView } from './shell/TeamView';
import { ProjectsView } from './shell/ProjectsView';
import { SkillsView } from './shell/SkillsView';
import { AddSkillDialog } from './shell/AddSkillDialog';
import { OnboardingDialog, onboardingSteps } from './shell/OnboardingDialog';
import { AwayDialog, awaySummaryIsEmpty } from './shell/AwayDialog';
import { AbsenceDialog } from './shell/AbsenceDialog';
import { absencePatch } from './shell/absenceHelpers';
import { RoutinesView } from './shell/RoutinesView';
import { EmployeeDialog, type EmployeeInput } from './shell/EmployeeDialog';
import { CompanySetup } from './shell/CompanySetup';
import { MeetingsView } from './meetings';
import { ProjectCabinet } from './shell/ProjectCabinet';
import { QuickSearch, type QuickAction, type QuickFileHit } from './shell/QuickSearch';
import { seatFor, type IsoTarget } from './scene/iso/socialRoom';
import { createStudio, type Quality, type Studio } from './studio/engine';
import { zoneForKind } from './studio/layout';
import { TeamPanel } from './shell/social/TeamPanel';
import { summaryText, teamSummary } from './shell/social/teamBoard';
import { TEAMS, teamDef, teamOfEmployee, teamOfWork, type TeamId } from '@milweb-hq/protocol';
import { ContentBoardPanel, ChefeDeskPanel, STUDIO_STARTS, StudioPanel, type BoardTab, type PieceApi, type StudioStart } from './shell/social/SocialPanels';
import type { ContentApi, PublishOutcome } from './shell/social/ContentViews';
import { activeRequests, isActive, pieceCounts, requestProgress } from './shell/social/pieceBoard';
import { VIDEO_SKILL, boardCounts, destinationLabel, destinationState, destinationsFor, meetingAvailability, pieceOfTask, roomTasks, waitingForChefe } from './shell/social/socialHelpers';
import { SocialHub, readyCount, socialSummary, type SocialHubApi } from './shell/social/SocialHub';
import type { ContentItem, ContentItemFiles, FileView, KnowledgeInput, KnowledgeItem, KnowledgeScope, KnowledgeUse, SocialAppId, SocialPublishResult, SocialSlotId } from '@milweb-hq/protocol';
import { companyDisplayName, configuredCompanyName, documentTitle, SOCIAL_SLOTS } from '@milweb-hq/protocol';
import './styles/panel.css';
import './styles/app.css';
import './styles/files.css';
import './styles/shell.css';
import './styles/composer.css';
import './styles/work.css';
import './styles/social.css';
import './styles/knowledge.css';

type Dialog =
  | { kind: 'none' }
  | { kind: 'session'; roomId: string; projectId: string | null; employeeId: string | null }
  | { kind: 'project'; roomId: string | null }
  | { kind: 'room'; roomId: string }
  | { kind: 'settings'; tab?: 'general' | 'company' | 'ai' | 'data' }
  | { kind: 'employee'; employeeId: string | null; roomId: string | null }
  | { kind: 'addSkill'; projectId: string | null }
  | { kind: 'away'; summary: AwaySummary }
  | { kind: 'absence' };

interface ProjectFiles { tree: FileNode | null; gitStatus: GitStatusEntry[] | null; loading: boolean }
/** Catálogo de skills por projeto ('' = geral). */
interface CatalogState { catalog: SkillCatalog | null; loading: boolean; error: string | null }

const PLAYER_POS_KEY = 'milweb-hq.player.pos';
/** Perfil editorial escolhido no topo (sala Social Media); fica neste navegador. */
const PROFILE_KEY = 'milweb-hq.social.profile';
/** Ausência mínima para mostrar "Enquanto você esteve fora" (reconexões rápidas não contam). */
const AWAY_MIN_MS = 10 * 60_000;
function storageGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
const PLAYER = { name: 'Chefe', appearance: { skin: 1, hair: 0, shirt: 3 } };
const QUALITY_KEY = 'milweb-hq.studio.quality';
function loadQuality(): Quality {
  try { const v = localStorage.getItem(QUALITY_KEY); if (v === 'alta' || v === 'equilibrada' || v === 'economia') return v; } catch { /* sem armazenamento */ }
  return 'equilibrada';
}
function saveQuality(q: Quality): void { try { localStorage.setItem(QUALITY_KEY, q); } catch { /* sem armazenamento */ } }
const EMPTY_MEETING_HISTORY = emptyMeetingHistory();

function loadPlayerPos(): { x: number; y: number } | null {
  try { const raw = localStorage.getItem(PLAYER_POS_KEY); if (!raw) return null; const p = JSON.parse(raw) as { x?: unknown; y?: unknown }; return typeof p?.x === 'number' && typeof p?.y === 'number' ? { x: p.x, y: p.y } : null; } catch { return null; }
}
function savePlayerPos(pos: { x: number; y: number }) { try { localStorage.setItem(PLAYER_POS_KEY, JSON.stringify(pos)); } catch { /* sem storage */ } }

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

function mergeTree(root: FileNode, node: FileNode): FileNode {
  if (normalizePath(root.path) === normalizePath(node.path)) return { ...root, children: node.children };
  if (!root.children) return root;
  return { ...root, children: root.children.map(c => mergeTree(c, node)) };
}

export function App() {
  const token = useMemo(() => readToken(), []);
  if (!token) return <Gate title="Abra pelo atalho" body={<><p>Esta aba foi aberta sem o token de acesso. O My Company AI só aceita o navegador que o próprio serviço abriu.</p><p>Rode o <code>start-hq.cmd</code> de novo. Se a HQ já estiver ligada, ele só abre uma aba nova com o acesso.</p></>} />;
  return <ConnectedApp token={token} />;
}

function Gate({ title, body }: { title: string; body: React.ReactNode }) {
  return <div className="hq-gate"><div className="hq-gate__card"><h1>MY COMPANY AI</h1><p className="hq-strong">{title}</p>{body}</div></div>;
}

function ConnectedApp({ token }: { token: string }) {
  const storeRef = useRef<AppStore | null>(null);
  if (!storeRef.current) storeRef.current = new AppStore();
  const store = storeRef.current;
  const clientRef = useRef<HqClient | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const client = new HqClient(token);
    clientRef.current = client;
    client.onMessage = m => store.apply(m);
    client.onState = s => { setConnection(s); store.set(st => ({ ...st, connection: s })); };
    client.connect();
    return () => client.close();
  }, [token, store]);

  const state = useAppState(store, s => s);
  const client = clientRef.current;
  // Visualizador de entregas (aberto por qualquer botão "Abrir"); declarado cedo porque bloqueia o teclado da cena.
  const [viewer, setViewer] = useState<ViewerRequest | null>(null);
  const notify = useCallback((level: Notice['level'], text: string) => store.set(s => ({ ...s, notices: [...s.notices.slice(-4), { id: Date.now() + Math.random(), level, text, ts: Date.now() }] })), [store]);
  const dismissNotice = useCallback((id: number) => store.set(s => ({ ...s, notices: s.notices.filter(n => n.id !== id) })), [store]);
  const safe = useCallback((fn: () => void | Promise<unknown>) => { try { const r = fn(); if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(err => notify('error', String((err as Error).message ?? err))); } catch (err) { notify('error', String((err as Error).message ?? err)); } }, [notify]);

  // ---------- seleção e vistas ----------
  // 05/11: a HQ abre na tela Conteúdo (Instagram e TikTok); a sala em pixel art fica em "Empresa" e em "Ver a sala".
  const [view, setView] = useState<MainView>('conteudo');
  const [selectedId, setSelectedId] = useState<string | null>(null); // id do personagem (funcionário ou sessão observada)
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [roomPanelOpen, setRoomPanelOpen] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [tab, setTab] = useState<PanelTab>('chat');
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [files, setFiles] = useState<Record<string, ProjectFiles>>({});
  // Explorador: última raiz/pasta visitada (volta onde estava ao reabrir a vista) e pedidos explícitos de abrir numa raiz.
  const [filesLoc, setFilesLoc] = useState<{ rootId?: string; cwd: string }>({ cwd: '' });
  const [filesOpenNonce, setFilesOpenNonce] = useState(0);
  const openFilesAt = useCallback((rootId: string, cwd = '') => { setFilesLoc({ rootId, cwd }); setFilesOpenNonce(n => n + 1); setView('files'); }, []);
  const [typing, setTyping] = useState(false);
  // A cena começa na visão geral (e só avisa quando o modo MUDA): o estado inicial tem de ser o mesmo.
  const [cameraMode, setCameraMode] = useState<CameraMode>('overview');
  const [interactHint, setInteractHint] = useState<string | null>(null);
  const [playerRoomId, setPlayerRoomId] = useState<string | null>(null);
  const [trashCount, setTrashCount] = useState<number | null>(null);
  const [sceneReady, setSceneReady] = useState(false);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  // Pedidos de histórico de reunião já feitos nesta conexão (não pedir duas vezes enquanto a resposta não chega).
  const meetingHistoryRequested = useRef(new Set<string>());
  // ---------- compositor único, catálogo de skills, agentes nativos, ausência, primeiro uso ----------
  const [composerPrefill, setComposerPrefill] = useState<ComposerPrefill | null>(null);
  const [composerFocus, setComposerFocus] = useState(0);
  // Marco 1: armário de projetos (aberto pelo armário da sala, Ctrl+K ou menu) e busca rápida.
  const [cabinet, setCabinet] = useState<{ roomId: string | null; projectId: string | null } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // Sala Social Media (piloto isométrico): a HQ abre nela. A planta vista de cima é a "Visão geral da empresa".
  const [roomMode, setRoomMode] = useState<'social' | 'plan'>('social');
  const [socialPanel, setSocialPanel] = useState<'chefe' | 'board' | 'studio' | 'redes' | null>(null);
  // Mesa de uma equipe aberta (painel da equipe); abrir outro painel da sala fecha este.
  const [teamPanel, setTeamPanel] = useState<TeamId | null>(null);
  useEffect(() => { if (socialPanel) setTeamPanel(null); }, [socialPanel]);
  const [roomNavOpen, setRoomNavOpen] = useState(false);
  const [profilePick, setProfilePick] = useState<string | null>(() => storageGet(PROFILE_KEY));
  const setProfileId = useCallback((id: string) => { setProfilePick(id); try { localStorage.setItem(PROFILE_KEY, id); } catch { /* sem storage */ } }, []);
  const [composerProjectId, setComposerProjectId] = useState<string | null>(null);
  const [skillsViewProjectId, setSkillsViewProjectId] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, CatalogState>>({});
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites(storageGet(FAVORITES_KEY)));
  const [onboardingLater, setOnboardingLater] = useState(false);
  const awayChecked = useRef<number | null>(null);
  const skillsNonceSeen = useRef(0);

  const employee: Employee | null = useMemo(() => state.employees.find(e => e.id === selectedId && !e.archivedAt) ?? null, [state.employees, selectedId]);
  const worker = state.workers.find(w => w.id === selectedId) ?? null;
  const session: Session | null = employee
    ? (employee.activeSessionId ? state.sessions.find(s => s.id === employee.activeSessionId) ?? null : null)
    : (worker?.kind === 'observed' ? state.sessions.find(s => s.id === worker.sessionId) ?? null : null);
  const conversations = useMemo(() => (employee ? state.sessions.filter(s => s.employeeId === employee.id && s.status !== 'archived').sort((a, b) => b.lastActiveAt - a.lastActiveAt) : []), [state.sessions, employee]);
  const project = session ? state.projects.find(p => p.id === session.projectId) ?? null : null;
  const room = employee ? state.rooms.find(r => r.id === employee.roomId) ?? null : session ? state.rooms.find(r => r.id === session.roomId) ?? null : null;
  const selectedRoom = state.rooms.find(r => r.id === selectedRoomId) ?? null;
  const playerRoom = state.rooms.find(r => r.id === playerRoomId) ?? null;
  const sessionTasks = useMemo(() => (session ? state.tasks.filter(t => t.sessionId === session.id).sort((a, b) => b.createdAt - a.createdAt) : []), [state.tasks, session]);
  const queued = useMemo(() => state.tasks.filter(t => t.status === 'queued'), [state.tasks]);
  // Execuções que contam no limite da fila (as mesmas que o servidor conta); conversa particular fica fora da fila de propósito.
  const dmSessionIds = useMemo(() => new Set(state.sessions.filter(s => isDmSession(s)).map(s => s.id)), [state.sessions]);
  const activeCount = useMemo(() => state.tasks.filter(t => t.status === 'running' && !dmSessionIds.has(t.sessionId)).length, [state.tasks, dmSessionIds]);
  const dmRunning = useMemo(() => state.tasks.filter(t => t.status === 'running' && dmSessionIds.has(t.sessionId)).length, [state.tasks, dmSessionIds]);
  // Turno de reunião ocupa a mesma vaga das tarefas (07/11: a barra dizia "0 de 1" com a reunião rodando e parecia tudo parado).
  const meetingTurns = useMemo(() => state.meetings.filter(m => m.activeTurnId).length, [state.meetings]);
  const waitingCount = useMemo(() => state.pending.length, [state.pending]);
  const sessionPending = useMemo(() => (session ? state.pending.filter(p => p.sessionId === session.id) : []), [state.pending, session]);
  // Reunião em andamento (ativa ou pausada): é quem aparece sentado na sala de Reuniões da cena.
  const liveMeeting = useMemo(() => state.meetings.filter(m => m.status === 'active' || m.status === 'paused').sort((a, b) => (b.startedAt ?? b.updatedAt) - (a.startedAt ?? a.updatedAt))[0] ?? null, [state.meetings]);
  const meetingsActive = useMemo(() => state.meetings.filter(m => m.status === 'active').length, [state.meetings]);
  const meetingRoom = useMemo(() => state.rooms.find(r => r.kind === 'meeting') ?? null, [state.rooms]);
  const sceneMeeting: SceneMeeting | null = useMemo(() => {
    if (!liveMeeting) return null;
    const actors = liveMeeting.participants.filter(p => p.kind === 'ai' && (p.provider === 'claude' || p.provider === 'openai'));
    return { roomId: meetingRoom?.id ?? 'meeting', active: true, actors: actors.map(p => {
      const emp = p.employeeId ? state.employees.find(e => e.id === p.employeeId) : null;
      return { id: p.id, name: p.name, provider: p.provider as 'claude' | 'openai', state: p.state, seat: p.seat, ...(emp ? { appearance: emp.appearance, initial: p.name.trim()[0]?.toUpperCase() } : {}) };
    }) };
  }, [liveMeeting, meetingRoom, state.employees]);

  const socialRoom = useMemo(() => state.rooms.find(r => r.kind === 'social') ?? null, [state.rooms]);
  // Sala Social Media travada na pasta de conteúdo (05/11): o campo da sala não deixa escolher outro projeto.
  const contentProjectId = state.content?.setup?.projectId ?? null;
  const contentFolderProject = useMemo(() => { const p = contentProjectId ? state.projects.find(x => x.id === contentProjectId) : null; return p ? { id: p.id, name: p.name } : null; }, [contentProjectId, state.projects]);
  const socialProfile = socialRoom ? socialRoom.profiles.find(p => p.id === (profilePick ?? 'aurora')) ?? socialRoom.profiles[0] ?? null : null;
  // Tarefas da sala (todas) e só do perfil escolhido: o mural filtra pelo perfil; pedidos de resposta aparecem em qualquer perfil.
  // Conversa particular não é trabalho da sala: fica fora do quadro, da Mesa e do "A equipe está fazendo".
  const socialAllTasks = useMemo(() => { const dmIds = new Set(state.sessions.filter(s => isDmSession(s)).map(s => s.id)); return roomTasks(state.tasks, state.sessions, socialRoom?.id ?? null, null).filter(t => !dmIds.has(t.sessionId)); }, [state.tasks, state.sessions, socialRoom]);
  const socialTeam = useMemo(() => state.employees.filter(e => e.roomId === socialRoom?.id && !e.archivedAt), [state.employees, socialRoom]);
  // Conversa particular com um funcionário (08/11): sessão própria, histórico carregado ao abrir, envio que não espera a fila.
  const [dm, setDm] = useState<DmState | null>(null);
  const loadChat = useCallback((id: string) => {
    if (!client || store.get().chatLoaded[id]) return;
    store.set(s => ({ ...s, chatLoaded: { ...s.chatLoaded, [id]: true } }));
    client.request<ChatItem[]>({ type: 'chat.history', sessionId: id }).then(items => {
      store.set(s => { const live = s.chat[id] ?? []; const merged = [...items]; for (const it of live) if (!merged.some(m => m.id === it.id)) merged.push(it); return { ...s, chat: { ...s.chat, [id]: merged } }; });
    }).catch(err => notify('error', `Histórico da conversa: ${(err as Error).message}`));
  }, [client, store, notify]);
  const openDm = useCallback((employeeId: string) => {
    if (!client) return;
    setDm({ employeeId, sessionId: null, error: null });
    client.request<Session>({ type: 'employee.dm.open', employeeId } as never, 60_000)
      .then(s => { setDm(d => (d && d.employeeId === employeeId ? { ...d, sessionId: s.id } : d)); loadChat(s.id); })
      .catch(err => setDm(d => (d && d.employeeId === employeeId ? { ...d, error: (err as Error).message } : d)));
  }, [client, loadChat]);
  // Falar com quem está trabalhando, sem interromper (09/11/2026): entra no próximo passo da tarefa; sem tarefa rodando, vai para a fila.
  const steerSession = useCallback(async (sessionId: string, text: string): Promise<boolean> => {
    if (!client) throw new Error('sem conexão com o serviço');
    const r = await client.request<{ delivered: boolean }>({ type: 'prompt.steer', clientId: crypto.randomUUID(), sessionId, text } as never, 60_000);
    return r.delivered;
  }, [client]);
  const sendDm = useCallback(async (text: string) => {
    if (!client || !dm?.sessionId) throw new Error('A conversa ainda não abriu.');
    await client.request<Task>({ type: 'prompt.send', clientId: crypto.randomUUID(), sessionId: dm.sessionId, text, attachments: [], mode: 'queue' } as never, 60_000);
  }, [client, dm]);
  // Perguntas e autorizações dos funcionários da sala Social Media: aparecem em "Esperando você" na tela Conteúdo.
  const socialPending = useMemo(() => {
    if (!socialRoom) return [];
    const sids = new Set(state.sessions.filter(s => s.roomId === socialRoom.id).map(s => s.id));
    return state.pending.filter(p => sids.has(p.sessionId));
  }, [state.pending, state.sessions, socialRoom]);
  const socialTasks = useMemo(() => (socialProfile ? socialAllTasks.filter(t => (t.profileId ?? null) === socialProfile.id) : socialAllTasks), [socialAllTasks, socialProfile]);
  const socialCounts = useMemo(() => ({ ...(state.content ? pieceCounts(state.content.items, state.tasks, socialProfile?.id ?? null) : boardCounts(socialTasks)), waiting: waitingForChefe(socialAllTasks).needsAnswer.length, social: readyCount(state.social), socialTotal: state.social?.accounts.length ?? 7 }), [socialTasks, socialAllTasks, state.social, state.content, state.tasks, socialProfile]);

  useEffect(() => { if (selectedId && !employee && !worker) setSelectedId(null); }, [selectedId, employee, worker]);
  useEffect(() => { if (!selectedRoomId && state.rooms.length) setSelectedRoomId(state.rooms[0].id); }, [state.rooms, selectedRoomId]);
  useEffect(() => { if (selectedMeetingId && !state.meetings.some(m => m.id === selectedMeetingId)) setSelectedMeetingId(null); }, [selectedMeetingId, state.meetings]);

  const selectWorker = useCallback((id: string, openPanel: boolean) => {
    setSelectedId(id);
    const w = store.get().workers.find(x => x.id === id);
    if (w) setSelectedRoomId(w.roomId);
    setRoomPanelOpen(false);
    setSocialPanel(null);
    if (openPanel) setPanelCollapsed(false);
  }, [store]);

  // ---------- histórico sob demanda ----------
  useEffect(() => {
    if (!client || !session || connection !== 'open') return;
    const id = session.id;
    if (!state.chatLoaded[id]) {
      store.set(s => ({ ...s, chatLoaded: { ...s.chatLoaded, [id]: true } }));
      client.request<ChatItem[]>({ type: 'chat.history', sessionId: id }).then(items => {
        store.set(s => { const live = s.chat[id] ?? []; const merged = [...items]; for (const it of live) if (!merged.some(m => m.id === it.id)) merged.push(it); return { ...s, chat: { ...s.chat, [id]: merged } }; });
      }).catch(err => notify('error', `Histórico do chat: ${(err as Error).message}`));
    }
    if (!state.eventsLoaded[id]) {
      store.set(s => ({ ...s, eventsLoaded: { ...s.eventsLoaded, [id]: true } }));
      client.request<{ seq: number; taskId: string | null; entry: LogEntry }[]>({ type: 'events.history', sessionId: id }).then(entries => {
        store.set(s => { const live = s.events[id] ?? []; const merged = [...entries]; for (const e of live) if (!merged.some(m => m.seq === e.seq)) merged.push(e); merged.sort((a, b) => a.seq - b.seq); return { ...s, events: { ...s.events, [id]: merged } }; });
      }).catch(err => notify('error', `Registro de atividade: ${(err as Error).message}`));
    }
  }, [client, session, connection, state.chatLoaded, state.eventsLoaded, store, notify]);

  // Contagem real da lixeira (para o selo da navegação).
  useEffect(() => {
    if (!client || connection !== 'open') return;
    client.request<TrashItem[]>({ type: 'trash.list' }).then(items => setTrashCount(items.length)).catch(() => setTrashCount(null));
  }, [client, connection, state.trashNonce]);

  // ---------- catálogo de skills (por projeto; '' = geral), agentes nativos, ausência, primeiro uso ----------
  const loadCatalog = useCallback((projectId: string | null, refresh = false) => {
    if (!client || connection !== 'open') return;
    const key = projectId ?? '';
    setCatalogs(c => ({ ...c, [key]: { catalog: c[key]?.catalog ?? null, loading: true, error: null } }));
    client.request<SkillCatalog>({ type: 'skills.list', projectId, refresh }, 30_000)
      .then(catalog => setCatalogs(c => ({ ...c, [key]: { catalog, loading: false, error: null } })))
      .catch(err => setCatalogs(c => ({ ...c, [key]: { catalog: c[key]?.catalog ?? null, loading: false, error: (err as Error).message } })));
  }, [client, connection]);
  useEffect(() => { loadCatalog(composerProjectId); }, [composerProjectId, loadCatalog]);
  useEffect(() => { if (view === 'skills') loadCatalog(skillsViewProjectId); }, [view, skillsViewProjectId, loadCatalog]);
  // Diálogo de contratação: catálogo geral (skills preferidas) e definições nativas de agente, lidos na hora de abrir.
  useEffect(() => {
    if (dialog.kind !== 'employee' || !client || connection !== 'open') return;
    loadCatalog(null);
    client.request<AgentCatalog>({ type: 'agents.list', projectId: null }, 30_000).then(a => setAgents(a.agents)).catch(err => notify('warn', `Agentes nativos: ${(err as Error).message}`));
  }, [dialog.kind, client, connection, loadCatalog, notify]);
  // skills.changed (skill adicionada, init novo com a lista): recarrega os catálogos já carregados.
  useEffect(() => {
    if (state.skillsNonce === skillsNonceSeen.current) return;
    skillsNonceSeen.current = state.skillsNonce;
    for (const key of Object.keys(catalogs)) loadCatalog(key || null, true);
  }, [state.skillsNonce]); // eslint-disable-line react-hooks/exhaustive-deps
  // Estado do serviço em segundo plano quando Ajustes abre (o cartão diz "não carregado" se o serviço não responder).
  useEffect(() => {
    if (dialog.kind !== 'settings' || !client || connection !== 'open') return;
    client.request<ServiceStatus>({ type: 'service.status' }, 15_000).then(s => store.set(st => ({ ...st, serviceStatus: s }))).catch(() => { /* versão do serviço sem controle em segundo plano: o cartão mostra o que sabe */ });
  }, [dialog.kind, client, connection, store]);
  // Nome da empresa (primeiro acesso): enquanto o servidor não tiver um nome gravado, a tela de boas-vindas cobre o escritório.
  const companyNamed = configuredCompanyName(state.settings) != null;
  const companyName = companyDisplayName(state.settings);
  const needsCompanyName = connection === 'open' && state.lastSnapshotAt != null && !companyNamed;
  const companyTitle = documentTitle(state.settings);
  useEffect(() => { document.title = companyTitle; }, [companyTitle]);
  const saveCompanyName = useCallback(async (name: string) => {
    if (!client) throw new Error('sem conexão com o serviço');
    // Só segue adiante com a resposta do servidor (gravado no SQLite); o aviso geral de configurações chega em seguida.
    const r = await client.request<{ companyName: string }>({ type: 'company.setName', name }, 20_000);
    store.set(s => ({ ...s, settings: { ...s.settings, companyName: r.companyName } }));
  }, [client, store]);
  // "Enquanto você esteve fora": uma vez por retrato completo, só quando a última interface conectada saiu há tempo suficiente.
  useEffect(() => {
    if (connection !== 'open' || !client || state.lastSnapshotAt == null || !companyNamed || awayChecked.current === state.lastSnapshotAt) return;
    awayChecked.current = state.lastSnapshotAt;
    const since = state.settings.lastSeenAt;
    if (!since || Date.now() - since < AWAY_MIN_MS) return;
    client.request<AwaySummary>({ type: 'away.summary', since }, 30_000)
      .then(s => { if (!awaySummaryIsEmpty(s)) setDialog(d => (d.kind === 'none' ? { kind: 'away', summary: s } : d)); })
      .catch(err => notify('warn', `Resumo da ausência: ${(err as Error).message}`));
  }, [connection, client, state.lastSnapshotAt, state.settings.lastSeenAt, notify, companyNamed]);
  // Primeiro uso: aparece até concluir/dispensar; se tudo já está pronto (HQ em uso), marca como feito sem perguntar.
  const onboardingReady = connection === 'open' && state.lastSnapshotAt != null && companyNamed && !state.settings.onboardingDone && !onboardingLater;
  const onboardingAllDone = useMemo(() => { const s = onboardingSteps(state.ai, state.projects, state.employees); return s.ai && s.project && s.employee; }, [state.ai, state.projects, state.employees]);
  useEffect(() => {
    if (onboardingReady && onboardingAllDone && client) { setOnboardingLater(true); safe(() => client.send({ type: 'settings.update', patch: { onboardingDone: true } })); }
  }, [onboardingReady, onboardingAllDone, client, safe]);
  const onboardingOpen = onboardingReady && !onboardingAllDone && dialog.kind === 'none';

  // Histórico da reunião selecionada, sob demanda. Reconectar zera meetingHistoryLoaded (store) e os pedidos feitos (aqui).
  useEffect(() => { meetingHistoryRequested.current.clear(); }, [state.lastSnapshotAt]);
  useEffect(() => {
    if (!client || !selectedMeetingId || connection !== 'open') return;
    const id = selectedMeetingId;
    if (state.meetingHistoryLoaded[id] || meetingHistoryRequested.current.has(id)) return;
    meetingHistoryRequested.current.add(id);
    client.request<MeetingHistory>({ type: 'meeting.history', meetingId: id }).then(h => {
      store.set(s => ({ ...s, meetingHistory: { ...s.meetingHistory, [id]: mergeMeetingHistory(h, s.meetingHistory[id]) }, meetingHistoryLoaded: { ...s.meetingHistoryLoaded, [id]: true } }));
    }).catch(err => { meetingHistoryRequested.current.delete(id); notify('error', `Histórico da reunião: ${(err as Error).message}`); });
  }, [client, selectedMeetingId, connection, state.meetingHistoryLoaded, store, notify]);

  // ---------- arquivos do projeto (aba Arquivos do painel: árvore + git) ----------
  const loadTree = useCallback((projectId: string, path?: string) => {
    if (!client) return;
    setFiles(f => ({ ...f, [projectId]: { tree: f[projectId]?.tree ?? null, gitStatus: f[projectId]?.gitStatus ?? null, loading: true } }));
    const treeP = client.request<FileNode>({ type: 'files.tree', projectId, path, depth: path ? 1 : 2 });
    const gitP = path ? Promise.resolve(undefined) : client.request<GitStatusEntry[] | null>({ type: 'git.status', projectId });
    Promise.all([treeP, gitP]).then(([node, git]) => {
      setFiles(f => {
        const cur = f[projectId] ?? { tree: null, gitStatus: null, loading: false };
        const tree = path && cur.tree ? mergeTree(cur.tree, node) : node;
        return { ...f, [projectId]: { tree, gitStatus: git === undefined ? cur.gitStatus : git, loading: false } };
      });
    }).catch(err => { setFiles(f => ({ ...f, [projectId]: { ...(f[projectId] ?? { tree: null, gitStatus: null }), loading: false } })); notify('error', `Arquivos: ${(err as Error).message}`); });
  }, [client, notify]);

  const doneSignature = sessionTasks.map(t => `${t.id}:${t.status}`).join(',');
  useEffect(() => {
    if (project && tab === 'files' && selectedId) loadTree(project.id);
  }, [project?.id, tab, doneSignature, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- cena ----------
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const restoredPosRef = useRef(false);
  const handlersRef = useRef({ onSelect: (_s: SceneSelection) => {}, onOpenWorker: (_id: string) => {}, onInteract: (_t: SceneInteractable) => {}, onEnterRoom: (_id: string | null) => {} });
  handlersRef.current = {
    onSelect: sel => {
      if (sel.kind === 'worker') selectWorker(sel.id, false);
      else if (sel.kind === 'room') { setSelectedRoomId(sel.id); setSelectedId(null); setSocialPanel(null); setRoomPanelOpen(true); }
      // 'none' (clique no chão) é andar, não limpa a seleção.
    },
    onOpenWorker: id => { selectWorker(id, true); setTab('chat'); },
    onInteract: t => {
      switch (t.kind) {
        case 'worker': selectWorker(t.id, true); setTab('chat'); break;
        case 'desk':
          if (t.workerId) { selectWorker(t.workerId, true); setTab('deliveries'); }
          else { setSelectedRoomId(t.roomId); setSelectedId(null); setRoomPanelOpen(true); }
          break;
        case 'cabinet': setCabinet({ roomId: t.roomId, projectId: null }); break;
        case 'shelf': setView('skills'); break;
        case 'computer': {
          const p = store.get().projects.find(x => x.roomId === t.roomId && !x.id.startsWith('ext:'));
          setCabinet({ roomId: t.roomId, projectId: p?.id ?? null });
          break;
        }
        case 'board': setSelectedRoomId(t.roomId); setSelectedId(null); setRoomPanelOpen(true); break;
        case 'reception': setView('team'); break;
        case 'meeting': setView('meetings'); if (liveMeeting) setSelectedMeetingId(liveMeeting.id); break;
      }
    },
    onEnterRoom: id => { setPlayerRoomId(id); if (id) setSelectedRoomId(id); },
  };

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const scene = createOfficeScene(canvas, {
      onSelect: sel => handlersRef.current.onSelect(sel),
      onOpenWorker: id => handlersRef.current.onOpenWorker(id),
      onInteract: t => handlersRef.current.onInteract(t),
      onInteractableChange: (_t, label) => setInteractHint(label),
      onEnterRoom: id => handlersRef.current.onEnterRoom(id),
      onCameraModeChange: m => setCameraMode(m),
      onPlayerMove: pos => savePlayerPos(pos),
    }, { reducedMotion: store.get().settings.reducedMotion, showLabels: true, inputEnabled: true });
    sceneRef.current = scene;
    const ro = new ResizeObserver(() => { scene.resize(); if (scene.getCameraMode() === 'overview') scene.fitAll(); });
    if (stageRef.current) ro.observe(stageRef.current);
    scene.resize();
    scene.setPlayer(PLAYER);
    // Abre na visão geral (planta inteira). Antes abria em "Explorar", que em telas baixas cortava a planta em cima ou embaixo.
    scene.fitAll();
    setSceneReady(true);
    return () => { ro.disconnect(); scene.destroy(); sceneRef.current = null; setSceneReady(false); };
  }, [store]);

  // Salas de trabalho ocupam os slots 0..5 na ordem do banco; a sala de Reuniões tem lugar fixo na planta (slot 6, mesa de reunião).
  const sceneRooms: SceneRoom[] = useMemo(() => {
    const work = state.rooms.filter(r => r.kind !== 'meeting');
    const meeting = state.rooms.find(r => r.kind === 'meeting');
    return [...work.map((r, i) => ({ id: r.id, name: r.name, kind: r.kind, color: r.color, slot: i })), ...(meeting ? [{ id: meeting.id, name: meeting.name, kind: meeting.kind, color: meeting.color, slot: 6 }] : [])];
  }, [state.rooms]);
  const sceneWorkers: SceneWorker[] = useMemo(() => state.workers.map(w => ({ id: w.id, roomId: w.roomId, name: w.name, role: w.role, phase: w.phase, detail: w.detail, appearance: w.appearance, deskIndex: w.deskIndex, controllable: w.controllable, observed: w.kind === 'observed', status: w.status })), [state.workers]);
  useEffect(() => {
    const scene = sceneRef.current; if (!scene) return;
    scene.setRooms(sceneRooms);
    // A posição salva só pode ser restaurada quando a planta existe (senão cairia no ponto seguro).
    if (!restoredPosRef.current && sceneRooms.length > 0) {
      restoredPosRef.current = true;
      const saved = loadPlayerPos();
      if (saved) scene.setPlayerPosition(saved);
      scene.fitAll();
    }
  }, [sceneRooms]);
  useEffect(() => { sceneRef.current?.setWorkers(sceneWorkers); }, [sceneWorkers]);

  // Sala Social Media isométrica: segundo canvas, desenhado só quando algo muda; pausado quando a visão geral ou uma vista está aberta.
  // Estúdio 3D (08/11): substitui a sala isométrica e a planta em pixel art. Se o WebGL falhar, a gestão continua.
  const isoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isoOverlayRef = useRef<HTMLDivElement | null>(null);
  const isoRef = useRef<Studio | null>(null);
  const isoTargetRef = useRef((_t: IsoTarget) => {});
  const [studioFail, setStudioFail] = useState<string | null>(null);
  const [quality, setQuality] = useState<Quality>(() => loadQuality());
  useEffect(() => {
    const canvas = isoCanvasRef.current, overlay = isoOverlayRef.current; if (!canvas || !overlay) return;
    let iso: Studio;
    try {
      iso = createStudio(canvas, overlay, { onInteract: t => isoTargetRef.current(t), onFail: r => setStudioFail(r) }, { quality: loadQuality() });
    } catch (err) {
      setStudioFail(String((err as Error)?.message ?? err));
      return;
    }
    isoRef.current = iso;
    (window as unknown as { __studio?: Studio }).__studio = iso;
    const ro = new ResizeObserver(() => iso.resize());
    if (stageRef.current) ro.observe(stageRef.current);
    iso.resize(); iso.setPlayer(PLAYER); iso.center();
    return () => { ro.disconnect(); iso.destroy(); isoRef.current = null; };
  }, []);
  useEffect(() => { isoRef.current?.setOptions({ quality }); saveQuality(quality); }, [quality]);
  // Cada funcionário da equipe de conteúdo senta na mesa do papel e da equipe dele (ilha do Tuco, ilha da Aurora, fileira
  // de pesquisa, pauta e revisão); quem não é da equipe fica com a mesa livre que sobrar.
  const socialWorkers = useMemo(() => {
    if (!socialRoom) return [];
    const seated = sceneWorkers.filter(w => w.roomId === socialRoom.id).map(w => {
      const e = state.employees.find(x => x.id === w.id);
      const seat = e ? seatFor(e.template, e.profileId) : null;
      return { w: seat === null ? w : { ...w, deskIndex: seat }, pinned: seat !== null };
    });
    return [...seated.filter(x => x.pinned), ...seated.filter(x => !x.pinned)].map(x => x.w);
  }, [sceneWorkers, socialRoom, state.employees]);
  const socialSeatPinned = useMemo(() => new Set(state.employees.filter(e => e.roomId === socialRoom?.id && seatFor(e.template, e.profileId) !== null).map(e => e.id)), [state.employees, socialRoom]);
  // Equipes (08/11): cada integrante tem assento na mesa redonda da equipe, na ordem do assento gravado no servidor
  // (desk_index único por equipe); especialistas de apoio ficam na fileira deles; sem equipe, na mesa avulsa "atribuir".
  const teamSeating = useMemo(() => {
    const seat = new Map<string, number>(); const counts: Record<TeamId, number> = { aurora: 0, 'tuco-dev': 0 };
    const social = state.employees.filter(e => e.roomId === socialRoom?.id && !e.archivedAt);
    for (const t of TEAMS) {
      const members = social.filter(e => teamOfEmployee(e) === t.id).sort((a, b) => a.deskIndex - b.deskIndex || a.createdAt - b.createdAt);
      members.forEach((e, i) => seat.set(e.id, (t.id === 'aurora' ? 100 : 200) + i));
      counts[t.id] = members.length;
    }
    return { seat, counts };
  }, [state.employees, socialRoom]);
  // O estúdio mostra a empresa inteira: a equipe de conteúdo na mesa do papel, o desenvolvimento nas mesas dele e
  // o resto na primeira mesa livre da ilha (decidida pelo motor).
  const studioWorkers = useMemo(() => {
    const kindOf = new Map(state.rooms.map(r => [r.id, r.kind]));
    const used = new Set<number>();
    const pinned = socialWorkers.map(w => { used.add(w.deskIndex); return w; });
    const pinnedIds = new Set(pinned.map(w => w.id));
    const rest = sceneWorkers.filter(w => !pinnedIds.has(w.id)).map(w => {
      const kind = kindOf.get(w.roomId);
      const pool = kind === 'dev' ? [8, 9] : kind === 'design' ? [7] : [];
      const desk = pool.find(d => !used.has(d));
      if (desk !== undefined) used.add(desk);
      return { ...w, deskIndex: desk ?? -1 };
    });
    const placed = pinned.map(w => {
      const team = teamSeating.seat.get(w.id);
      if (team !== undefined) return { ...w, deskIndex: team };
      const e = state.employees.find(x => x.id === w.id);
      const shared = e && teamOfEmployee(e) === 'apoio' ? seatFor(e.template, null) : null;
      return { ...w, deskIndex: shared != null && shared >= 4 ? shared : socialSeatPinned.has(w.id) ? w.deskIndex : -1 };
    });
    return [...placed, ...rest];
  }, [socialWorkers, sceneWorkers, state.rooms, socialSeatPinned, teamSeating, state.employees]);
  useEffect(() => { isoRef.current?.setWorkers(studioWorkers); }, [studioWorkers]);
  // Mesas das duas equipes: tamanho pelo número real de integrantes e resumo só com dados reais
  const teamSums = useMemo(() => Object.fromEntries(TEAMS.map(t => [t.id, teamSummary(t.id, { tasks: state.tasks, items: state.content?.items ?? [], pending: state.pending })])) as Record<TeamId, ReturnType<typeof teamSummary>>, [state.tasks, state.content?.items, state.pending]);
  useEffect(() => {
    isoRef.current?.setTeams(TEAMS.map(t => ({ id: t.id, label: t.label, channels: t.id === 'aurora' ? 'Instagram + Threads da Aurora' : 'Instagram do Tuco Dev', color: t.color, rug: t.id === 'aurora' ? '#fbe7c6' : '#ece8fb', seats: teamSeating.counts[t.id], summary: summaryText(teamSums[t.id]) })));
  }, [teamSeating, teamSums]);
  // Monitor do estúdio: só mostra render quando o servidor diz que está renderizando de verdade.
  useEffect(() => {
    const r = (state.content?.radar ?? []).find(x => x.video?.stage === 'renderizando');
    isoRef.current?.setStudioStatus(r ? `Renderizando: ${(r.subject || 'vídeo da referência').slice(0, 60)}` : null);
  }, [state.content?.radar]);
  // Eventos reais encenados na sala: quem produziu leva a peça ao revisor enquanto a revisão roda; entrega conferida pela
  // HQ e aprovada pelo revisor é apresentada na mesa do Chefe. Nada aqui inventa trabalho; a mesma ocorrência não repete.
  useEffect(() => {
    const st = isoRef.current; const c = state.content; if (!st || !c) return;
    const short = (t: string) => (t.length > 34 ? `${t.slice(0, 33).trimEnd()}…` : t);
    for (const i of c.items) {
      if (!i.ownerId || i.deletedAt) continue;
      const rt = i.reviewTaskId ? state.tasks.find(t => t.id === i.reviewTaskId) : null;
      if (rt && rt.status === 'running' && rt.employeeId && rt.employeeId !== i.ownerId) st.errand(i.ownerId, { to: { workerId: rt.employeeId }, text: `leva "${short(i.title)}" para a revisão`, ms: 9000, key: `rev:${rt.id}` });
      if (i.status === 'revisar' && i.review?.verdict === 'aprovar' && i.review.at && Date.now() - i.review.at < 10 * 60_000) st.errand(i.ownerId, { to: 'boss', text: `entrega pronta: ${short(i.title)}`, ms: 10000, key: `ent:${i.id}:${i.review.at}` });
    }
  }, [state.content, state.tasks]);
  // reunião: funcionários pelo id do cadastro (vão da mesa para a cadeira); gerentes de IA entram pela porta da sala
  const studioMeeting = useMemo(() => (sceneMeeting ? { ...sceneMeeting, actors: sceneMeeting.actors.map(a => { const p = liveMeeting?.participants.find(x => x.id === a.id); return { ...a, id: p?.employeeId ?? a.id }; }) } : null), [sceneMeeting, liveMeeting]);
  useEffect(() => { isoRef.current?.setMeeting(studioMeeting, liveMeeting?.title ?? null); }, [studioMeeting, liveMeeting?.title]);
  useEffect(() => {
    isoRef.current?.setSocials((state.social?.accounts ?? []).map(a => ({ label: a.label ?? a.slot, state: a.status === 'error' || a.status === 'expired' ? 'error' : a.status === 'manual' || a.status === 'needs_app' || a.status === 'not_connected' ? (a.declared?.confirmed ? 'configured' : 'off') : 'connected' })));
  }, [state.social]);
  const deskCountRef = useRef(0);
  useEffect(() => { isoRef.current?.setBoard({ ...socialCounts, desk: deskCountRef.current }); }, [socialCounts.queued, socialCounts.producing, socialCounts.review, socialCounts.ready, socialCounts.waiting, socialCounts.social, deskCountRef.current]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { isoRef.current?.setSelected(selectedId); }, [selectedId]);
  useEffect(() => { sceneRef.current?.setMeeting(sceneMeeting); }, [sceneMeeting]);
  useEffect(() => { sceneRef.current?.setOptions({ reducedMotion: state.settings.reducedMotion }); }, [state.settings.reducedMotion]);
  useEffect(() => { sceneRef.current?.select(selectedId ? { kind: 'worker', id: selectedId } : roomPanelOpen && selectedRoomId ? { kind: 'room', id: selectedRoomId } : { kind: 'none' }); }, [selectedId, selectedRoomId, roomPanelOpen]);

  // Teclado move o avatar só na vista do escritório, sem diálogo aberto e sem foco em texto.
  const inputEnabled = view === 'office' && dialog.kind === 'none' && !typing && !viewer;
  const planActive = roomMode === 'plan' && view === 'office';
  const socialActive = roomMode === 'social' && view === 'office';
  useEffect(() => { sceneRef.current?.setOptions({ inputEnabled: inputEnabled && roomMode === 'plan', paused: !planActive }); }, [inputEnabled, roomMode, planActive]);
  useEffect(() => { isoRef.current?.setOptions({ inputEnabled: inputEnabled && roomMode === 'social' && !roomNavOpen, paused: !socialActive, reducedMotion: state.settings.reducedMotion }); }, [inputEnabled, roomMode, roomNavOpen, socialActive, state.settings.reducedMotion]);
  useEffect(() => {
    const update = () => setTyping(isTypingTarget(document.activeElement));
    const later = () => { window.setTimeout(update, 0); };
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', later);
    return () => { document.removeEventListener('focusin', update); document.removeEventListener('focusout', later); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || dialog.kind !== 'none' || viewer) return;
      const target = e.target as Element | null;
      if (target?.closest?.('dialog')) return; // Esc de um diálogo (visualizador) fecha só o diálogo
      if (isTypingTarget(target) || target?.closest?.('.hq-view-host')) return; // a vista aberta (explorador) trata o próprio Esc
      if (selectedId) { setSelectedId(null); return; }
      if (socialPanel) { setSocialPanel(null); return; }
      if (roomPanelOpen) { setRoomPanelOpen(false); return; }
      if (view !== 'office') setView('office');
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [dialog.kind, selectedId, roomPanelOpen, view, socialPanel, viewer]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Atalho N (fora de campos de texto e sem diálogo): foco em "O que vamos fazer?".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'n' && e.key !== 'N') || e.ctrlKey || e.metaKey || e.altKey || dialog.kind !== 'none') return;
      if (isTypingTarget(e.target as Element | null)) return;
      e.preventDefault(); setComposerFocus(n => n + 1);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [dialog.kind]);

  // ---------- ações ----------
  const sendTo = useCallback((sessionId: string, text: string, attachments: OutgoingAttachment[], mode: SendMode) => {
    if (!client) return;
    if (mode === 'steer' && !attachments.length) { safe(() => client.request({ type: 'prompt.steer', clientId: crypto.randomUUID(), sessionId, text } as never)); return; }
    const m = mode === 'steer' ? 'queue' : mode;
    safe(() => client.request<Task>({ type: 'prompt.send', clientId: crypto.randomUUID(), sessionId, text, attachments: attachments.map(a => ({ name: a.name, mediaType: a.mediaType, dataBase64: a.dataBase64 })), mode: m }));
  }, [client, safe]);
  const send = useCallback((text: string, attachments: OutgoingAttachment[], mode: SendMode) => { if (session) sendTo(session.id, text, attachments, mode); }, [session, sendTo]);
  const openExternal = useCallback((target: 'folder' | 'file' | 'reveal' | 'url', value: string) => { if (client) safe(() => client.send({ type: 'open.external', target, value })); }, [client, safe]);
  // Visualizador da HQ: todo "Abrir" de entrega mostra o arquivo aqui dentro (imagem, vídeo, texto), conferido no servidor.
  const viewerApi: ViewerApi | null = useMemo(() => (client ? {
    view: (path: string) => client.request<FileView>({ type: 'file.view', path }, 30_000),
    open: (target, path) => openExternal(target, path),
    copy: async (text: string) => { try { await navigator.clipboard.writeText(text); return true; } catch { notify('error', 'Não deu para copiar: o navegador bloqueou a área de transferência.'); return false; } },
  } : null), [client, openExternal, notify]);
  const viewFile = useCallback((abs: string, title?: string) => setViewer({ title: title ?? (abs.split(/[\\/]/).pop() ?? abs), files: [abs] }), []);
  /** Abre a peça do calendário com tudo o que ela entregou de verdade (slides, Pin, vídeo, texto) e o texto exato do post. */
  const openPiece = useCallback(async (item: ContentItem, index = 0) => {
    if (!client) return;
    try {
      const r = await client.request<ContentItemFiles>({ type: 'content.item.files', id: item.id }, 30_000);
      const slot = item.slot ? SOCIAL_SLOTS.find(s => s.slot === item.slot)?.label ?? item.slot : 'sem conta';
      const who = item.ownerId ? state.employees.find(e => e.id === item.ownerId)?.name : null;
      const day = item.date ? item.date.split('-').reverse().slice(0, 2).join('/') : null;
      setViewer({ itemId: item.id, title: item.title, files: r.files.map(f => f.path), labels: r.files.map(f => f.name), index, text: r.text, missing: r.missing, meta: [slot, day ? `${day}${item.time ? ` ${item.time}` : ''}` : null, who ? `responsável: ${who}` : null, item.review ? `revisor: ${item.review.verdict}` : null].filter(Boolean).join(' · ') });
    } catch (err) { notify('error', `Não deu para abrir a peça: ${(err as Error).message}`); }
  }, [client, notify, state.employees]);
  const pieceText = useCallback(async (item: ContentItem) => {
    if (!client) return null;
    const r = await client.request<ContentItemFiles>({ type: 'content.item.files', id: item.id }, 30_000);
    return r.text;
  }, [client]);
  // Sala de Reuniões: mensagens com reqId esperam a resposta do servidor (a tela manda reqId: '' e o cliente preenche); as outras são só enviadas.
  const meetingDispatch = useCallback(async (msg: MeetingClientMessage): Promise<unknown> => {
    if (!client) throw new Error('sem conexão com o serviço do My Company AI');
    if ('reqId' in msg) return client.request(msg as unknown as Parameters<HqClient['request']>[0], 90_000);
    client.send(msg);
    return undefined;
  }, [client]);
  const openConversationDialog = useCallback((employeeId: string | null, roomId: string | null, projectId: string | null) => {
    const e = employeeId ? store.get().employees.find(x => x.id === employeeId) : null;
    const rid = e?.roomId ?? roomId ?? store.get().rooms[0]?.id;
    if (!rid) return;
    setDialog({ kind: 'session', roomId: rid, projectId, employeeId: e?.id ?? null });
  }, [store]);
  // Compositor único: task.run com clientId estável (idempotente no servidor).
  const runTask = useCallback(async (input: Omit<TaskRunInput, 'reqId'>): Promise<TaskRunResult> => {
    if (!client) throw new Error('sem conexão com o serviço do My Company AI');
    return client.request<TaskRunResult>({ type: 'task.run', ...input }, 90_000);
  }, [client]);
  // Abre a conversa de uma tarefa: torna-a ativa no funcionário e foca o painel de chat.
  const openConversation = useCallback((sessionId: string, employeeId: string | null) => {
    const st = store.get();
    const s = st.sessions.find(x => x.id === sessionId);
    const eid = employeeId ?? s?.employeeId ?? null;
    const e = eid ? st.employees.find(x => x.id === eid) : null;
    if (!e) { notify('warn', 'Essa conversa não pertence a um funcionário da HQ (ou ele foi arquivado).'); return; }
    if (e.activeSessionId !== sessionId && client) safe(() => client.send({ type: 'employee.setActiveSession', id: e.id, sessionId }));
    selectWorker(e.id, true); setTab('chat'); setView('office');
  }, [store, client, safe, notify, selectWorker]);
  // "Dar tarefa" / "Usar esta skill": preenchem o mesmo compositor, sem criar nada.
  const giveTask = useCallback((employeeId: string) => {
    const st = store.get();
    const e = st.employees.find(x => x.id === employeeId);
    const sess = e?.activeSessionId ? st.sessions.find(s => s.id === e.activeSessionId) : null;
    setComposerPrefill({ nonce: Date.now(), employeeId, projectId: sess?.projectId ?? null });
    setComposerFocus(n => n + 1);
  }, [store]);
  const useSkill = useCallback((skill: SkillInfo) => {
    setComposerPrefill({ nonce: Date.now(), skill: skill.invocation, projectId: skill.projectId ?? null });
    setComposerFocus(n => n + 1);
  }, []);
  const retryTask = useCallback((taskId: string) => {
    if (!client) return;
    safe(async () => { const t = await client.request<Task>({ type: 'task.retry', taskId }, 30_000); notify('info', `Nova tentativa (${t.attempt ?? 2}ª) criada: ${truncate(t.prompt, 70)}`); });
  }, [client, safe, notify]);
  const markVerified = useCallback((taskId: string) => { if (client) safe(() => client.send({ type: 'task.markVerified', taskId })); }, [client, safe]);
  const releaseTask = useCallback((taskId: string) => { if (client) safe(() => client.send({ type: 'task.release', taskId })); }, [client, safe]);
  const cancelQueued = useCallback((taskId: string) => { if (client) safe(() => client.send({ type: 'task.cancelQueued', taskId })); }, [client, safe]);
  const toggleFavorite = useCallback((id: string) => setFavorites(f => {
    const next = f.includes(id) ? f.filter(x => x !== id) : [...f, id];
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch { /* sem storage */ }
    return next;
  }), []);
  const attentionCount = useMemo(() => state.tasks.filter(t => t.review === 'to_verify' || (t.status === 'queued' && t.held)).length, [state.tasks]);
  const composerCatalog = catalogs[composerProjectId ?? ''];
  const skillsCatalog = catalogs[skillsViewProjectId ?? ''];
  const visibleProjects = useMemo(() => state.projects.filter(p => !p.id.startsWith('ext:')), [state.projects]);

  const archiveEmployee = useCallback((id: string) => {
    const e = store.get().employees.find(x => x.id === id); if (!client || !e) return;
    if (!window.confirm(`Arquivar ${e.name}? O personagem sai da sala e o processo atual (se houver) é encerrado. Conversas, tarefas e histórico ficam guardados; dá para restaurar depois.`)) return;
    safe(() => client.send({ type: 'employee.archive', id }));
    if (selectedId === id) setSelectedId(null);
  }, [client, safe, store, selectedId]);
  const interruptSessions = useCallback(async (ids: string[]) => {
    if (!client) return;
    for (const id of ids) { try { client.send({ type: 'session.interrupt', sessionId: id }); } catch { /* sem conexão: o explorador mostra o erro real */ } }
    await new Promise(r => setTimeout(r, 1500));
  }, [client]);

  const fsRoots: FsRoot[] = useMemo(() => [
    ...state.projects.filter(p => !p.id.startsWith('ext:')).map(p => ({ id: `project:${p.id}`, kind: 'project' as const, name: p.name, path: p.path, projectId: p.id })),
    ...state.folders.map(f => ({ id: `folder:${f.id}`, kind: 'folder' as const, name: f.name, path: f.path, folderId: f.id })),
  ], [state.projects, state.folders]);
  const fsApi = useMemo(() => (client ? createFsApi(client) : null), [client]);
  // Central de Redes: tudo passa pelo serviço (segredos e tokens ficam no cofre do Windows, nunca aqui).
  const hubApi: SocialHubApi | null = useMemo(() => {
    if (!client) return null;
    const req = <T,>(m: Record<string, unknown>, ms = 60_000) => client.request<T>(m as never, ms);
    return {
      connect: (slot: SocialSlotId) => req<{ url: string }>({ type: 'social.connect', slot }),
      check: (slot: SocialSlotId) => req({ type: 'social.check', slot }, 90_000),
      disconnect: (slot: SocialSlotId) => req({ type: 'social.disconnect', slot }),
      setProfiles: (slot: SocialSlotId, profileIds: string[]) => req({ type: 'social.setProfiles', slot, profileIds }),
      saveApp: (app: SocialAppId, clientId: string, clientSecret?: string) => req({ type: 'social.app.save', app, clientId, clientSecret }),
      clearApp: (app: SocialAppId) => req({ type: 'social.app.clear', app }),
      saveRedirect: (uri: string) => req({ type: 'social.redirect.save', uri }),
      checkRedirect: () => req({ type: 'social.redirect.check' }),
      publish: (slot: SocialSlotId, clientId: string, text: string, taskId?: string | null) => req<SocialPublishResult>({ type: 'social.publish', slot, clientId, text, taskId: taskId ?? null }, 120_000),
      declare: (slot: SocialSlotId, handle: string | null, profileUrl: string | null, confirmed: boolean, toCreate?: boolean) => req({ type: 'social.declare', slot, handle, profileUrl, confirmed, toCreate: toCreate ?? false }),
      browser: (action: 'connect' | 'verify' | 'show' | 'disconnect', slot: SocialSlotId) => req({ type: `social.browser.${action}`, slot }, 120_000),
      browserControl: (slot: SocialSlotId, take: boolean) => req({ type: 'social.browser.control', slot, take }),
      browserMode: (slot: SocialSlotId, mode: 'navegador' | 'api') => req({ type: 'social.browser.mode', slot, mode }),
      browserToken: (token: string | null) => req({ type: 'social.browser.token', token }),
      openUrl: (url: string) => openExternal('url', url),
      copy: async (text: string) => { try { await navigator.clipboard.writeText(text); return true; } catch { notify('error', 'Não deu para copiar: o navegador bloqueou a área de transferência.'); return false; } },
    };
  }, [client, openExternal, notify]);
  const socialAccounts = useMemo(() => state.social?.accounts ?? [], [state.social]);
  // Trabalho de conteúdo (Radar, Calendário, Resultados): tudo é pedido ao serviço, que valida e transmite o estado.
  const [boardTab, setBoardTab] = useState<BoardTab>('pecas');
  const [shareSignal, setShareSignal] = useState(0);
  // Pasta da sala de conteúdo (prévia dos slides lida pelo explorador, só dentro dela).
  const contentProjectRef = useRef<{ id: string; path: string } | null>(null);
  { const pid = state.content?.setup.projectId; const p = pid ? state.projects.find(x => x.id === pid) : null; contentProjectRef.current = p ? { id: p.id, path: p.path } : null; }
  const viewerPiece = viewer?.itemId ? state.content?.items.find(x => x.id === viewer.itemId) ?? null : null;
  const contentApi: ContentApi | null = useMemo(() => {
    if (!client) return null;
    const req = <T,>(m: Record<string, unknown>, ms = 60_000) => client.request<T>(m as never, ms);
    const toB64 = async (f: File) => { const buf = new Uint8Array(await f.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s); };
    return {
      setup: () => req({ type: 'content.setup' }, 120_000),
      radarRun: focus => req({ type: 'content.radar.run', focus }),
      radarDiscard: id => req({ type: 'content.radar.discard', id }),
      radarToItem: (id, slot) => req({ type: 'content.radar.toItem', id, slot }),
      weekPrepare: note => req({ type: 'content.week.prepare', note }),
      weekProduce: weekStart => req<{ produced: number; skipped: string[] }>({ type: 'content.week.produce', weekStart }, 120_000),
      image: async (abs: string) => {
        const proj = contentProjectRef.current;
        if (!fsApi || !proj) return null;
        const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '');
        const root = norm(proj.path); const file = norm(abs);
        if (!file.toLowerCase().startsWith(root.toLowerCase() + '\\')) return null;
        const res = await fsApi.read(`project:${proj.id}`, file.slice(root.length + 1).replace(/\\/g, '/'));
        return res.encoding === 'base64' ? `data:${res.mediaType};base64,${res.content}` : null;
      },
      itemUpdate: (id, patch) => req({ type: 'content.item.update', id, patch }),
      produce: (id, note) => req({ type: 'content.item.produce', id, note }),
      quickCreate: (text, slot, format) => req<{ itemId: string }>({ type: 'content.quick.create', text, slot, format }, 120_000),
      review: id => req({ type: 'content.item.review', id }),
      approve: (itemIds, from, to, note) => req({ type: 'content.approve', itemIds, from, to, note }),
      publish: (id, clientId) => req<PublishOutcome>({ type: 'content.item.publish', id, clientId }, 120_000),
      registerPost: (id, url) => req<{ ok: boolean; detail: string }>({ type: 'content.item.registerPost', id, url }, 60_000),
      resultAdd: result => req({ type: 'content.result.add', result }),
      importCsv: (csv, fileName) => req<{ imported: number; skipped: string[] }>({ type: 'content.result.importCsv', csv, fileName }),
      capture: async (file, itemId, slot) => req({ type: 'content.result.capture', name: file.name, mediaType: file.type, dataBase64: await toB64(file), itemId, slot }, 120_000),
      confirmResult: (id, value) => req({ type: 'content.result.confirm', id, value }),
      deleteResult: id => req({ type: 'content.result.delete', id }),
      analysisRun: () => req({ type: 'content.analysis.run' }),
      prepare: id => req({ type: 'content.item.prepare', id }),
      collect: () => req({ type: 'content.results.collect' }),
      destinationSave: (destination, confirm) => req({ type: 'content.destination.save', destination: { ...destination, confirm } }),
      openUrl: (url: string) => openExternal('url', url),
      openFile: (abs: string) => (/\.[a-z0-9]{1,5}$/i.test(abs) ? viewFile(abs) : openExternal('folder', abs)),
      openFolder: (abs: string) => openExternal('folder', abs),
      trash: ids => req<{ trashed: string[]; cancelled: string[] }>({ type: 'content.items.trash', ids }, 90_000),
      restore: ids => req({ type: 'content.items.restore', ids }),
      archive: (ids, archived) => req({ type: 'content.items.archive', ids, archived }),
      hidden: (key, kind, st, title, cancelTaskId) => req({ type: 'content.hidden.set', key, kind, state: st, title, cancelTaskId }, 90_000),
      requestCreate: r => req<{ requestId: string; produced: number; waiting: SocialSlotId[]; skipped: string[] }>({ type: 'content.request.create', ...r }, 120_000),
      focusSave: (activeSlots, sources) => req<{ paused: string[]; resumed: string[]; cancelled: string[] }>({ type: 'content.focus.save', activeSlots, sources }, 90_000),
      referenceAdd: async r => req<{ radarId: string; roundId: string | null }>({ type: 'content.reference.add', reference: { url: r.url, text: r.text, slot: r.slot, title: r.title, files: await Promise.all(r.files.map(async f => ({ name: f.name, mediaType: f.type, dataBase64: await toB64(f) }))) } }, 180_000),
      radarSelect: (id, slot) => req({ type: 'content.radar.select', id, slot, produce: true }, 90_000),
      learning: (id, decision, note) => req({ type: 'content.item.learning', id, decision, note }),
      rerender: id => req({ type: 'content.item.rerender', id }, 1_500_000),
      unapprove: ids => req({ type: 'content.items.unapprove', ids }),
      markPublished: (id, url) => req<{ ok: boolean; detail: string }>({ type: 'content.item.markPublished', id, url }, 60_000),
      videoAdd: async r => req<{ radarId: string; reused: boolean; mode: string }>({ type: 'content.video.add', ref: { url: r.url, liked: r.liked, mode: r.mode, instruction: r.instruction, slot: r.slot, sessionId: r.sessionId ?? null, profileId: r.profileId ?? null, extras: r.extras ?? null, file: r.file ? { name: r.file.name, mediaType: r.file.type || 'video/mp4', dataBase64: await toB64(r.file) } : null } }, 600_000),
      videoRetry: async (id, file) => req({ type: 'content.video.retry', id, file: file ? { name: file.name, mediaType: file.type || 'video/mp4', dataBase64: await toB64(file) } : null }, 600_000),
      videoProduce: (id, slot) => req({ type: 'content.video.produce', id, slot }, 120_000),
      openMeeting: (id: string) => { setView('meetings'); setSelectedMeetingId(id); },
      academyRetry: (studyId, exerciseId) => req({ type: 'content.academy.retry', studyId, exerciseId }, 120_000),
      managerAsk: (text, teams) => req<{ requestId: string }>({ type: 'content.manager.ask', text, ...(teams?.length ? { teams } : {}) }, 120_000),
      stepRetry: id => req({ type: 'content.item.step.retry', id }, 120_000),
      openAcademy: () => { setSelectedId(null); setRoomPanelOpen(false); setBoardTab('academia'); setSocialPanel('board'); },
      unmarkPublished: id => req({ type: 'content.item.unmarkPublished', id }),
      openPiece: (item, index) => void openPiece(item, index),
      pieceText: item => pieceText(item),
      copy: async (text: string) => { try { await navigator.clipboard.writeText(text); return true; } catch { notify('error', 'Não deu para copiar: o navegador bloqueou a área de transferência.'); return false; } },
    };
  }, [client, fsApi, openExternal, notify, viewFile, openPiece, pieceText]);
  // Conhecimento da equipe (10/11): ensinar, corrigir (versão nova), desativar, excluir e ver onde foi usado.
  const [knowledgeNonce, setKnowledgeNonce] = useState(0);
  const [knowledgeScope, setKnowledgeScope] = useState<string | null>(null);
  const openKnowledge = useCallback((scope: string | null = null) => { setKnowledgeScope(scope); setKnowledgeNonce(n => n + 1); setView('team'); }, []);
  const knowledgeApi: KnowledgeApi | null = useMemo(() => {
    if (!client) return null;
    const req = <T,>(m: Record<string, unknown>, ms = 60_000) => client.request<T>(m as never, ms);
    return {
      teach: (item: KnowledgeInput, clientId: string) => req<{ item: KnowledgeItem; similar: KnowledgeItem[]; duplicate: boolean }>({ type: 'knowledge.teach', clientId, item }),
      replace: (id, patch) => req({ type: 'knowledge.replace', id, patch }),
      setState: (id, st) => req({ type: 'knowledge.setState', id, state: st }),
      remove: id => req({ type: 'knowledge.delete', id }),
      uses: id => req<KnowledgeUse[]>({ type: 'knowledge.uses', id }),
      openFile: abs => viewFile(abs),
      openUrl: url => openExternal('url', url),
      openTask: taskId => { const t = store.get().tasks.find(x => x.id === taskId); if (!t) { notify('warn', 'Essa tarefa não está entre as recentes.'); return; } setView('office'); setSocialPanel(null); openConversation(t.sessionId, t.employeeId ?? null); },
    };
  }, [client, store, notify, viewFile, openExternal, openConversation]);
  const undoCaptured = useCallback((id: string) => {
    store.set(s => ({ ...s, knowledgeCaptured: null }));
    client?.request({ type: 'knowledge.undo', id } as never, 60_000).then(() => notify('info', 'Registro desfeito: a orientação não vale para os próximos pedidos.')).catch(err => notify('error', `Não deu para desfazer: ${(err as Error).message}`));
  }, [client, store, notify]);
  // "Gerente distribui": caminho padrão do campo de pedido na sala Social Media.
  const socialManager = useMemo(() => socialTeam.find(e => e.template === 'conteudo-coordenador') ?? null, [socialTeam]);
  const composerManager: ComposerManager | null = useMemo(() => {
    if (!client) return null;
    return {
      name: socialManager?.name ?? null,
      blocked: !contentFolderProject ? 'a pasta de conteúdo da sala (prepare em Conteúdo)' : !socialManager ? 'uma gerente na sala (contrate a coordenação) ou escolha quem executa' : null,
      ask: (text: string, teams: TeamId[]) => client.request({ type: 'content.manager.ask', text, ...(teams.length ? { teams } : {}) } as never, 120_000),
      teach: async (text: string, scope: KnowledgeScope) => {
        const r = await client.request<{ item: KnowledgeItem; duplicate: boolean }>({ type: 'knowledge.teach', clientId: `campo-${Date.now()}-${Math.random().toString(36).slice(2)}`, item: { kind: 'preferencia', scope, text, origin: 'chefe', originNote: 'Ensinado por você no campo de pedido' } } as never, 60_000);
        const st = store.get();
        return { scopeLabel: knowledgeScopeLabel(r.item.scope, { employees: st.employees, projects: st.projects }), duplicate: r.duplicate };
      },
      talk: async (text: string) => {
        if (!socialManager) throw new Error('A sala ainda não tem gerente: escolha com quem conversar no seletor.');
        const s = await client.request<Session>({ type: 'employee.dm.open', employeeId: socialManager.id } as never, 60_000);
        setDm({ employeeId: socialManager.id, sessionId: s.id, error: null }); loadChat(s.id);
        await client.request({ type: 'prompt.send', sessionId: s.id, clientId: `conversa-${Date.now()}-${Math.random().toString(36).slice(2)}`, text, mode: 'send' } as never, 90_000);
      },
      openDesk: () => { setView('office'); setSelectedId(null); setRoomPanelOpen(false); setSocialPanel('chefe'); },
    };
  }, [client, socialManager, contentFolderProject, store, loadChat]);
  // Mesa do Chefe (caixa de entrada): entregas persistidas, perguntas e bloqueios; a resposta volta ao funcionário da tarefa.
  const deskApi: DeskApi | null = useMemo(() => {
    if (!client) return null;
    const req = <T,>(m: Record<string, unknown>, ms = 60_000) => client.request<T>(m as never, ms);
    return {
      approve: id => req({ type: 'desk.approve', id }),
      adjust: (id, note, remember) => req({ type: 'desk.adjust', id, note, clientId: `adj-${id}`, ...(remember ? { remember } : {}) }, 120_000),
      knowledgeOf: taskId => usesOfTask(store.get().knowledge, taskId),
      seen: ids => req({ type: 'desk.seen', ids }),
      resolveNeed: id => req({ type: 'desk.need.resolve', id }),
      answer: (sessionId, requestId, answers) => safe(() => client.send({ type: 'question.answer', sessionId, requestId, answers })),
      permit: (sessionId, requestId, allow) => safe(() => client.send(allow ? { type: 'permission.respond', sessionId, requestId, behavior: 'allow' } : { type: 'permission.respond', sessionId, requestId, behavior: 'deny', message: 'Negado pelo Chefe na mesa.' })),
      openFile: abs => viewFile(abs),
      view: r => setViewer(r),
      hide: (key, st, title) => (client ? client.request({ type: 'content.hidden.set', key, kind: 'delivery', state: st, title, cancelTaskId: null } as never, 60_000) : Promise.reject(new Error('sem conexão'))),
      openUrl: url => openExternal('url', url),
      openTask: taskId => { const t = store.get().tasks.find(x => x.id === taskId); if (!t) { notify('warn', 'Essa tarefa não está entre as recentes.'); return; } setView('office'); setSocialPanel(null); openConversation(t.sessionId, t.employeeId ?? null); },
      image: async abs => {
        if (!fsApi) return null;
        const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        const proj = store.get().projects.find(p => norm(abs).startsWith(norm(p.path) + '\\'));
        if (!proj) return null;
        const rel = abs.replace(/\//g, '\\').slice(proj.path.replace(/\//g, '\\').replace(/\\+$/, '').length + 1).replace(/\\/g, '/');
        const res = await fsApi.read(`project:${proj.id}`, rel);
        return res.encoding === 'base64' ? `data:${res.mediaType};base64,${res.content}` : null;
      },
    };
  }, [client, fsApi, openExternal, notify, openConversation, viewFile]); // eslint-disable-line react-hooks/exhaustive-deps
  // Peças paradas (Bloqueios da Mesa): falhou, planejada num pedido sem ir para a produção, ou conta do pedido sem peça e sem pesquisa rodando.
  const stalled: StalledPiece[] = useMemo(() => {
    const c = state.content; if (!c) return [];
    const out: StalledPiece[] = [];
    for (const i of c.items) if (isActive(i) && i.status === 'falhou') out.push({ key: `falhou:${i.id}`, title: i.title, reason: i.nextStep ?? 'a produção falhou', next: 'Produzir de novo pela Mesa ou pelo Mural (o que já foi gravado continua na pasta)', open: () => void openPiece(i) });
    const researching = c.rounds.some(r => r.kind === 'radar' && r.status === 'aguardando');
    // Destinos fora do foco não viram bloqueio (antes Threads, LinkedIn, X e Pinterest apareciam como "conta sem peça").
    const paused = c.focus?.activeSlots ? SOCIAL_SLOTS.map(s => s.slot).filter(s => !c.focus.activeSlots!.includes(s)) : [];
    for (const r of activeRequests(c)) for (const row of requestProgress(r, c.items, state.tasks, paused).rows) {
      if (row.state === 'pendente' && row.item && row.item.status === 'planejada') out.push({ key: `pend:${row.item.id}`, title: `${row.label}: ${row.item.title}`, reason: `no pedido "${r.title}", planejada e sem produção`, next: row.item.material === 'gravar' || row.item.material === 'editar' ? `${row.item.material === 'gravar' ? 'gravar' : 'editar'} o material e então Produzir` : 'Produzir (Mural → Planejadas)', open: () => void openPiece(row.item!) });
      if (row.state === 'falta' && !researching) out.push({ key: `falta:${r.id}:${row.slot}`, title: `${row.label} no pedido "${r.title}"`, reason: 'conta sem peça e nenhuma pesquisa rodando', next: 'rodar o Radar (a pauta que ele achar vai sozinha para a produção) ou criar a peça no Calendário' });
    }
    return out;
  }, [state.content, state.tasks]); // eslint-disable-line react-hooks/exhaustive-deps
  const deskCounts = useMemo(() => deskItems(state.desk, state.pending, state.tasks, state.content?.hidden ?? [], stalled).counts, [state.desk, state.pending, state.tasks, state.content?.hidden, stalled]);
  useEffect(() => { deskCountRef.current = deskCounts.total; isoRef.current?.setBoard({ ...socialCounts, desk: deskCounts.total }); }, [deskCounts.total]); // eslint-disable-line react-hooks/exhaustive-deps
  // Referência de vídeo ("nesse estilo"): o mesmo caminho no campo "O que vamos criar?" e no topo da Mesa (09/11).
  const videoRefApi = useMemo<VideoRefComposerApi | null>(() => (contentApi ? {
    send: r => contentApi.videoAdd({ ...r, profileId: socialProfile?.id ?? null }),
    slots: (state.content?.focus?.activeSlots ?? SOCIAL_SLOTS.map(s => s.slot)).map(s => ({ id: s, label: SOCIAL_SLOTS.find(x => x.slot === s)?.label ?? s })),
    defaultSlot: socialProfile?.id === 'tuco-dev' ? 'instagram-tuco' : socialProfile?.id === 'aurora' ? 'instagram-aurora' : null,
    openDesk: () => openDeskRef.current(),
  } : null), [contentApi, socialProfile?.id, state.content?.focus?.activeSlots]);
  const openDeskRef = useRef<() => void>(() => {});
  const openDesk = useCallback(() => { setView(v => (v === 'conteudo' ? v : 'office')); setSelectedId(null); setRoomPanelOpen(false); setSocialPanel('chefe'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  openDeskRef.current = openDesk;
  // Peças de conteúdo (mural, mesa do Chefe, estúdio): prévia lida do disco real, abrir no Windows e copiar.
  const pieceApi: PieceApi = useMemo(() => ({
    accounts: socialAccounts, hub: hubApi,
    projects: state.projects,
    read: (projectId, rel) => (fsApi ? fsApi.read(`project:${projectId}`, rel) : Promise.reject(new Error('sem conexão com o serviço do My Company AI'))),
    openFile: abs => viewFile(abs),
    view: r => setViewer(r),
    pieceOf: t => pieceOfTask(state.content?.items ?? [], t),
    openPiece: (item, index) => void openPiece(item, index),
    copy: async text => {
      try { await navigator.clipboard.writeText(text); return true; }
      catch { notify('error', 'Não deu para copiar: o navegador bloqueou a área de transferência.'); return false; }
    },
  }), [state.projects, fsApi, openExternal, notify, socialAccounts, hubApi, viewFile, openPiece, state.content?.items]);
  // Estúdio de vídeo: a skill de vídeo da Aurora, se estiver instalada nesta máquina.
  const generalSkills = catalogs['']?.catalog?.skills ?? null;
  const videoSkill = useMemo(() => (generalSkills ?? composerCatalog?.catalog?.skills ?? []).find(s => s.invocation === VIDEO_SKILL && !s.disabled) ?? null, [generalSkills, composerCatalog]);
  useEffect(() => { if (socialPanel === 'studio' && !catalogs['']?.catalog && !catalogs['']?.loading) loadCatalog(null); }, [socialPanel]); // eslint-disable-line react-hooks/exhaustive-deps
  const startStudio = (s: StudioStart) => {
    const st = STUDIO_STARTS.find(x => x.id === s)!;
    setComposerPrefill({ nonce: Date.now(), text: st.text, ...(videoSkill ? { skill: videoSkill.invocation } : {}) });
  };
  // Seletor de arquivos da reunião: identidade estável (muda só quando as raízes ou a conexão mudam).
  const meetingFsRoots = useCallback(async () => fsRoots, [fsRoots]);
  const meetingFsList = useCallback((rootId: string, p: string) => (fsApi ? fsApi.list(rootId, p) : Promise.reject(new Error('sem conexão com o serviço do My Company AI'))), [fsApi]);

  const goSocial = useCallback(() => {
    setRoomMode('social'); setView('office'); setRoomPanelOpen(false);
    requestAnimationFrame(() => isoRef.current?.resize());
  }, []);
  const goPlan = useCallback((roomId: string | null) => {
    setRoomMode('social'); setSocialPanel(null); setView('office');
    requestAnimationFrame(() => {
      const st = isoRef.current; if (!st) return;
      st.resize();
      const room = roomId ? store.get().rooms.find(r => r.id === roomId) : null;
      if (room) { setSelectedRoomId(room.id); st.focusZone(zoneForKind(room.kind)); } else st.center();
    });
  }, [store]);
  const onIsoTarget = (t: IsoTarget) => {
    switch (t.kind) {
      case 'chefe-desk': setSelectedId(null); setRoomPanelOpen(false); setSocialPanel('chefe'); break;
      case 'board': setSelectedId(null); setRoomPanelOpen(false); setSocialPanel('board'); break;
      case 'worker': selectWorker(t.id, true); setTab('chat'); break;
      case 'desk':
        if (t.workerId) { selectWorker(t.workerId, true); setTab('chat'); }
        else setDialog({ kind: 'employee', employeeId: null, roomId: socialRoom?.id ?? selectedRoomId });
        break;
      case 'media-cabinet': {
        const p = socialRoom ? store.get().projects.find(x => x.roomId === socialRoom.id && !x.id.startsWith('ext:')) : null;
        if (p) openFilesAt(`project:${p.id}`);
        else { setView('files'); notify('info', 'A sala Social Media ainda não tem pasta de projeto: o explorador abriu nas pastas que já existem. Cadastre a pasta em Opções → Projeto, no campo do pedido.'); }
        break;
      }
      case 'meeting-table':
        setSelectedId(null); setSocialPanel(null);
        if (meetingRoom) { setSelectedRoomId(meetingRoom.id); setRoomPanelOpen(true); } else setView('meetings');
        break;
      case 'door': setRoomNavOpen(true); break;
      case 'studio': setSelectedId(null); setRoomPanelOpen(false); setSocialPanel('studio'); break;
      case 'socials': setSelectedId(null); setRoomPanelOpen(false); setSocialPanel('redes'); break;
      case 'team': setSelectedId(null); setRoomPanelOpen(false); setSocialPanel(null); setTeamPanel(t.team); break;
    }
  };
  isoTargetRef.current = onIsoTarget;
  const openSocialObject = (t: IsoTarget) => { goSocial(); onIsoTarget(t); };
  const roomNavItems = [
    { id: 'overview', label: 'Estúdio inteiro', hint: 'todas as áreas na tela', on: false },
    ...state.rooms.map(r => ({ id: r.id, label: r.name, hint: 'aproxima a área', color: r.color, on: false })),
  ];
  const homeMore = (k: HomeMore) => {
    setSelectedId(null); setRoomPanelOpen(false);
    if (k === 'sala') { setSocialPanel(null); setView('office'); goSocial(); return; }
    if (k === 'reunioes') { setView('meetings'); return; }
    if (k === 'mesa') { setSocialPanel('chefe'); return; }
    if (k === 'redes') { setSocialPanel('redes'); return; }
    setBoardTab(k === 'mural' ? 'pecas' : k); setSocialPanel('board');
  };
  const pickRoom = (id: string) => { setRoomNavOpen(false); goPlan(id === 'overview' ? null : id); };

  const quickActions: QuickAction[] = [
    { id: 'conteudo', label: 'Conteúdo (Instagram e TikTok)', hint: 'pedir, acompanhar, aprovar e marcar como postado', run: () => setView('conteudo') },
    { id: 'social', label: 'Sala Social Media', hint: 'abrir a sala isométrica', run: goSocial },
    { id: 'overview', label: 'Visão geral da empresa', hint: 'planta com todas as salas', run: () => goPlan(null) },
    { id: 'chefe-desk', label: 'Mesa do Chefe', hint: 'o que espera por você e entregas para revisar', run: () => openSocialObject({ kind: 'chefe-desk' }) },
    { id: 'board', label: 'Mural de conteúdo', hint: 'tarefas do perfil por estado real', run: () => openSocialObject({ kind: 'board' }) },
    { id: 'media', label: 'Armário de mídia', hint: 'arquivos da sala Social Media', run: () => openSocialObject({ kind: 'media-cabinet' }) },
    { id: 'redes', label: 'Central de Redes', hint: 'Instagram, Threads, TikTok e LinkedIn: conexões e capacidades', run: () => openSocialObject({ kind: 'socials' }) },
    { id: 'studio', label: 'Estúdio de vídeo', hint: 'roteiros, Reels e TikTok com a skill de vídeo', run: () => openSocialObject({ kind: 'studio' }) },
    { id: 'share-video', label: 'Compartilhar vídeo com a equipe', hint: 'link ou MP4/MOV para estudar, analisar ou fazer a nossa versão', run: () => { setSocialPanel(null); setView('conteudo'); setShareSignal(n => n + 1); } },
    { id: 'academia', label: 'Academia de Vídeo', hint: 'estudos, aulas, exercícios e técnicas aprendidas', run: () => homeMore('academia') },
    { id: 'meeting-table', label: 'Mesa de reunião', hint: 'reuniões e quem pode participar agora', run: () => openSocialObject({ kind: 'meeting-table' }) },
    { id: 'hire', label: 'Contratar funcionário', run: () => setDialog({ kind: 'employee', employeeId: null, roomId: roomMode === 'social' ? socialRoom?.id ?? selectedRoomId : selectedRoomId }) },
    { id: 'projects', label: 'Projetos', hint: 'pastas cadastradas', run: () => setView('projects') },
    { id: 'trash', label: 'Lixeira', hint: trashCount ? `${trashCount} item(ns)` : undefined, run: () => setView('trash') },
    { id: 'task', label: 'Nova tarefa', hint: 'foco em “O que vamos fazer?” (N)', run: () => { setView('office'); setComposerFocus(n => n + 1); } },
    { id: 'cabinet', label: 'Armário de projetos', hint: 'projetos, favoritos e arquivos de contexto', run: () => setCabinet({ roomId: null, projectId: null }) },
    { id: 'meetings', label: 'Reuniões', run: () => setView('meetings') },
    { id: 'desk', label: 'Minha mesa (entregas, perguntas e bloqueios)', run: () => openDesk() },
    { id: 'files', label: 'Arquivos', run: () => setView('files') },
    { id: 'skills', label: 'Skills', run: () => setView('skills') },
    { id: 'team', label: 'Equipe', run: () => setView('team') },
    { id: 'routines', label: 'Rotinas', run: () => setView('routines') },
    { id: 'away', label: 'Vou sair (modo ausente)', run: () => setDialog({ kind: 'absence' }) },
    { id: 'settings', label: 'Ajustes', run: () => setDialog({ kind: 'settings' }) },
    { id: 'company', label: 'Nome da empresa', hint: 'Ajustes → Empresa', run: () => setDialog({ kind: 'settings', tab: 'company' }) },
    { id: 'data', label: 'Dados e backup', hint: 'Ajustes → Dados', run: () => setDialog({ kind: 'settings', tab: 'data' }) },
  ];
  const searchProjectFiles = async (query: string): Promise<QuickFileHit[]> => {
    if (!fsApi) return [];
    const ps = state.projects.filter(p => !p.id.startsWith('ext:')).sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.lastUsedAt - a.lastUsedAt).slice(0, 5);
    const all = await Promise.all(ps.map(p => fsApi.search(`project:${p.id}`, query, 8).then(es => es.filter(e => e.type === 'file').map(e => ({ projectId: p.id, projectName: p.name, path: e.path, name: e.name }))).catch(() => [] as QuickFileHit[])));
    return all.flat().slice(0, 12);
  };
  const busy = Boolean(worker?.busy || session?.activity.turnActive);
  const disabledReason = !session ? (employee ? `${employee.name} não tem conversa aberta` : 'Selecione um funcionário') : !session.controllable ? 'Sessão observada: foi iniciada fora da HQ e só pode ser acompanhada' : session.status === 'archived' ? 'Conversa arquivada' : connection !== 'open' ? 'Sem conexão com o serviço' : state.serverInfo && state.serverInfo.authOk === false ? 'Claude Code sem login: rode `claude` no terminal e faça /login' : null;

  if (connection === 'unauthorized') return <Gate title="Token recusado" body={<><p>O token desta aba não bate com o do serviço em execução (ele muda quando a pasta de dados é recriada).</p><p>Feche esta aba e abra de novo pelo <code>start-hq.cmd</code> ou pelo endereço impresso no terminal.</p></>} />;

  const panelVisible = Boolean(selectedId && (employee || worker));
  // Na tela de Reuniões a conversa ocupa tudo: painéis laterais e o campo "O que vamos criar?" ficam escondidos (sem perder o rascunho).
  const sideAllowed = view !== 'meetings';
  // Painel lateral aberto no escritório: a câmera enquadra as duas mesas das equipes no espaço que sobrou; fechou, a empresa inteira.
  const sideOpen = view === 'office' && Boolean(panelVisible || socialPanel || teamPanel || roomPanelOpen);
  useEffect(() => { requestAnimationFrame(() => isoRef.current?.frame(sideOpen ? 'teams' : 'all')); }, [sideOpen]);
  const dialogEmployee = dialog.kind === 'employee' && dialog.employeeId ? state.employees.find(e => e.id === dialog.employeeId) ?? null : null;
  const dialogRoom = dialog.kind === 'session' ? state.rooms.find(r => r.id === dialog.roomId) ?? null : null;
  const dialogSessionEmployee = dialog.kind === 'session' && dialog.employeeId ? state.employees.find(e => e.id === dialog.employeeId) ?? null : null;

  return (
    <>
    {needsCompanyName && <CompanySetup hasData={state.employees.length > 0 || state.tasks.length > 0} onSave={saveCompanyName} />}
    <div className="hq-app" inert={needsCompanyName}>
      <TopBar
        companyName={companyName}
        desk={{ count: deskCounts.total }} onOpenDesk={openDesk}
        connection={connection} lastSnapshotAt={state.lastSnapshotAt} serverInfo={state.serverInfo} room={roomMode === 'social' ? socialRoom : room ?? playerRoom}
        onReconnect={() => client?.connect()}
        roomNav={{
          current: roomMode === 'social' ? socialRoom?.name ?? 'Social Media' : playerRoom ? `Visão geral · ${playerRoom.name}` : 'Visão geral da empresa',
          color: roomMode === 'social' ? socialRoom?.color : playerRoom?.color, items: roomNavItems, open: roomNavOpen, onOpenChange: setRoomNavOpen, onPick: pickRoom,
        }}
        profiles={roomMode === 'social' ? socialRoom?.profiles : undefined} profileId={socialProfile?.id ?? null} onProfile={setProfileId}
        onOpenSettings={() => setDialog({ kind: 'settings' })}
        // Contador "Redes: 7 cadastradas · 0 verificadas" saiu do topo (06/11, pedido do Chefe: menos coisa na tela); as Redes
        // continuam em Conteúdo > Mais > Redes.
        social={null}
        absence={state.lastSnapshotAt != null ? { enabled: Boolean(state.settings.absence?.enabled), projects: state.settings.absence?.allowedProjectIds.length ?? 0 } : null}
        onOpenAbsence={() => setDialog({ kind: 'absence' })}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenDirection={() => { const d = state.rooms.find(r => r.kind === 'direction'); goPlan(d?.id ?? null); }}
      />
      <div className="hq-app__main">
        <Nav
          view={view} onView={v => setView(v)} onOpenSettings={() => setDialog({ kind: 'settings' })}
          waiting={waitingCount} attention={attentionCount} trashCount={trashCount} meetingsActive={meetingsActive}
        />
        {/* A navegação ocupa a altura toda; o compositor fica só sob a área de trabalho (palco + painel). */}
        <div className="hq-app__work">
        <div className="hq-app__row">
        <main className={`hq-stage${connection !== 'open' ? ' hq-stage--dim' : ''}`} ref={stageRef} aria-label={`Escritório: ${companyName}`}>
          <div className="st-stage hq-stage__studio">
            <canvas ref={isoCanvasRef} className="hq-stage__canvas" tabIndex={0} aria-label="Estúdio Aurora em 3D: cada personagem é um funcionário real da HQ e só se move quando há trabalho de verdade. Os botões logo abaixo abrem os mesmos objetos pelo teclado." />
            <div ref={isoOverlayRef} className="st-overlay" />
            {studioFail && <div className="st-fallback"><div><strong>O escritório 3D não abriu neste computador.</strong><br />{studioFail}<br />A gestão continua funcionando: use Conteúdo, Equipe e a Mesa do Chefe no menu ao lado.</div></div>}
          </div>
          {roomMode === 'social' || roomMode === 'plan' ? (
            <>
              <div className="hq-stage__hud">
                <div className="hq-stage__where"><span>Social Media</span><strong title="Aurora e Tuco Dev são marcas fictícias de exemplo; não são contas reais">2 equipes de exemplo: Aurora e Tuco Dev</strong></div>
              </div>
              <div className="hq-iso__objects" role="toolbar" aria-label="Objetos da sala Social Media">
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => onIsoTarget({ kind: 'chefe-desk' })}>Mesa do Chefe</button>
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => onIsoTarget({ kind: 'team', team: 'aurora' })}>Mesa da Equipe Aurora</button>
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => onIsoTarget({ kind: 'team', team: 'tuco-dev' })}>Mesa da Equipe Tuco Dev</button>
                {socialWorkers.map(w => <button key={w.id} type="button" className="hq-btn hq-btn--sm" onClick={() => onIsoTarget({ kind: 'worker', id: w.id })}>Mesa de {w.name}</button>)}
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => onIsoTarget({ kind: 'board' })}>Mural de conteúdo</button>
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => onIsoTarget({ kind: 'media-cabinet' })}>Arquivo de entregas</button>
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => onIsoTarget({ kind: 'meeting-table' })}>Mesa de reunião</button>
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => onIsoTarget({ kind: 'studio' })}>Estúdio de vídeo</button>
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => onIsoTarget({ kind: 'socials' })}>Contas das redes ({socialSummary(state.social)})</button>
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => onIsoTarget({ kind: 'desk', deskIndex: -1, workerId: null })}>Contratar para uma mesa vazia</button>
              </div>
              <div className="hq-stage__tools">
                <div className="hq-stage__frames" role="group" aria-label="Enquadramento">
                  <button type="button" className="hq-btn hq-btn--sm" onClick={() => { isoRef.current?.frame('all'); isoCanvasRef.current?.focus(); }} title="O estúdio inteiro na tela">Ver empresa inteira</button>
                  <button type="button" className="hq-btn hq-btn--sm hq-btn--team-aurora" onClick={() => { isoRef.current?.frame('aurora'); }} title="Aproxima a mesa da Equipe Aurora">Focar Aurora</button>
                  <button type="button" className="hq-btn hq-btn--sm hq-btn--team-tuco" onClick={() => { isoRef.current?.frame('tuco'); }} title="Aproxima a mesa da Equipe Tuco Dev">Focar Tuco Dev</button>
                </div>
                <button type="button" className="hq-iconbtn" title="Aproximar" aria-label="Aproximar" onClick={() => isoRef.current?.zoomBy(1)}>+</button>
                <button type="button" className="hq-iconbtn" title="Afastar" aria-label="Afastar" onClick={() => isoRef.current?.zoomBy(-1)}>−</button>
                <label className="hq-stage__quality" title="Qualidade gráfica do escritório 3D (fica guardada neste computador)">
                  <span>Gráficos</span>
                  <select value={quality} onChange={e => setQuality(e.target.value as Quality)}>
                    <option value="alta">Alta</option>
                    <option value="equilibrada">Equilibrada</option>
                    <option value="economia">Economia</option>
                  </select>
                </label>
              </div>
              {studioWorkers.length === 0 && <div className="hq-stage__hint">Mesas vazias: clique numa mesa para contratar alguém.</div>}
            </>
          ) : (
            <>
              <div className="hq-stage__hud">
                <div className="hq-stage__where">{playerRoom ? <><span>Você está em</span><strong>{playerRoom.name}</strong></> : <span>Corredor</span>}{cameraMode === 'overview' && <span className="hq-dim">· visão geral</span>}</div>
                {interactHint && inputEnabled && <div className="hq-stage__interact"><span className="hq-stage__key">E</span>{interactHint}</div>}
              </div>
              <div className="hq-stage__tools">
                <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={goSocial} title="Volta para a sala Social Media">Voltar para Social Media</button>
                <button type="button" className={`hq-btn hq-btn--sm${cameraMode !== 'overview' ? ' hq-btn--on' : ''}`} onClick={() => { sceneRef.current?.followPlayer(); canvasRef.current?.focus(); }} title="Explorar: a câmera segue o avatar (WASD ou setas; clique no chão para andar)">Explorar</button>
                <button type="button" className={`hq-btn hq-btn--sm${cameraMode === 'overview' ? ' hq-btn--on' : ''}`} onClick={() => { sceneRef.current?.fitAll(); canvasRef.current?.focus(); }} title="Ver empresa: a planta inteira cabe na tela (Espaço alterna com Explorar)">Ver empresa</button>
                <button type="button" className="hq-iconbtn" title="Aproximar" aria-label="Aproximar" onClick={() => sceneRef.current?.zoomBy(1)}>+</button>
                <button type="button" className="hq-iconbtn" title="Afastar" aria-label="Afastar" onClick={() => sceneRef.current?.zoomBy(-1)}>−</button>
              </div>
              {sceneReady && cameraMode !== 'overview' && <Minimap scene={sceneRef.current} onLookAt={pos => sceneRef.current?.lookAt(pos)} />}
              {state.workers.length === 0 && <div className="hq-stage__hint">{'Nenhum funcionário ainda: contrate pela Equipe ou numa mesa vazia e escreva o pedido no campo de baixo.'}</div>}
            </>
          )}
          <ConnectionOverlay connection={connection} lastSnapshotAt={state.lastSnapshotAt} onReconnect={() => client?.connect()} />
          {dm && <DmPanel dm={dm} employees={state.employees} tasks={state.tasks} items={dm.sessionId ? state.chat[dm.sessionId] ?? [] : []} streaming={dm.sessionId ? state.streaming[dm.sessionId] ?? '' : ''} onSend={sendDm} onClose={() => setDm(null)} />}
          {view !== 'office' && (
            <div className="hq-view-host">
              {view === 'conteudo' && (
                <ContentHome
                  content={state.content} tasks={state.tasks} employees={state.employees} api={contentApi} profileId={socialProfile?.id ?? null} connected={connection === 'open'} onMore={homeMore} shareSignal={shareSignal} meetings={state.meetings}
                  team={socialTeam} onTalk={openDm} onSteer={steerSession}
                  roomTasks={socialAllTasks} pending={socialPending} sessions={state.sessions} desk={deskApi} manager={composerManager}
                  onResend={t => (client ? client.request<Task>({ type: 'prompt.send', clientId: crypto.randomUUID(), sessionId: t.sessionId, text: t.prompt, attachments: [], mode: 'queue' } as never) : Promise.reject(new Error('sem conexão com o serviço')))}
                />
              )}
              {view === 'team' && (
                <TeamView
                  employees={state.employees} workers={state.workers} rooms={state.rooms} sessions={state.sessions} projects={state.projects} selectedEmployeeId={employee?.id ?? null}
                  onOpen={id => { selectWorker(id, true); setView('office'); sceneRef.current?.focusWorker(id, true); }}
                  onEdit={id => setDialog({ kind: 'employee', employeeId: id, roomId: null })}
                  onArchive={archiveEmployee}
                  onUnarchive={id => client && safe(() => client.send({ type: 'employee.unarchive', id }))}
                  onNewConversation={id => openConversationDialog(id, null, null)}
                  onNew={roomId => setDialog({ kind: 'employee', employeeId: null, roomId: roomId ?? selectedRoomId })}
                  onGiveTask={giveTask}
                  onTeach={id => openKnowledge(`funcionario:${id}`)}
                  knowledgeNonce={knowledgeNonce}
                  knowledgePending={currentItems(state.knowledge).filter(i => i.state === 'proposto').length}
                  knowledge={<KnowledgeView key={`k-${knowledgeNonce}`} board={state.knowledge} employees={state.employees} projects={state.projects} tasks={state.tasks}
                    deliveries={state.desk?.deliveries ?? []} techniques={state.content?.academy?.techniques ?? []} api={knowledgeApi} initialScope={knowledgeScope} />}
                />
              )}
              {view === 'meetings' && (
                <MeetingsView
                  meetings={state.meetings} selectedId={selectedMeetingId}
                  history={selectedMeetingId && state.meetingHistoryLoaded[selectedMeetingId] ? state.meetingHistory[selectedMeetingId] ?? EMPTY_MEETING_HISTORY : null}
                  streaming={state.meetingStreaming}
                  employees={state.employees} projects={state.projects} rooms={state.rooms} ai={state.ai} settings={state.settings}
                  onSelect={id => setSelectedMeetingId(id)}
                  dispatch={meetingDispatch}
                  onOpenAiSettings={() => setDialog({ kind: 'settings', tab: 'ai' })}
                  fsRoots={meetingFsRoots}
                  fsList={meetingFsList}
                  tasks={state.tasks}
                  onOpenTask={taskId => deskApi?.openTask(taskId)}
                />
              )}
              {view === 'projects' && (
                <ProjectsView
                  projects={state.projects} rooms={state.rooms} sessions={state.sessions} employees={state.employees}
                  onAdd={roomId => setDialog({ kind: 'project', roomId })}
                  onOpenFiles={id => openFilesAt(`project:${id}`)}
                  onOpenExplorer={p => openExternal('folder', p)}
                  onMoveRoom={(id, roomId) => client && safe(() => client.send({ type: 'project.update', id, patch: { roomId } }))}
                  onRemove={id => { const p = state.projects.find(x => x.id === id); if (!client || !p) return; if (window.confirm(`Remover "${p.name}" da HQ?\n\nSó o cadastro é removido. A pasta ${p.path} e todos os arquivos continuam no disco.`)) safe(() => client.send({ type: 'project.delete', id })); }}
                  onNewConversation={id => { const p = state.projects.find(x => x.id === id); if (p) openConversationDialog(null, p.roomId, p.id); }}
                />
              )}
              {view === 'skills' && (
                <SkillsView
                  catalog={skillsCatalog?.catalog ?? null} loading={Boolean(skillsCatalog?.loading)} error={skillsCatalog?.error ?? null}
                  projects={state.projects} projectId={skillsViewProjectId} onProjectChange={setSkillsViewProjectId} onRefresh={() => loadCatalog(skillsViewProjectId, true)}
                  favorites={favorites} onToggleFavorite={toggleFavorite} onUseSkill={useSkill}
                  onReadSkill={path => (client ? client.request<SkillFileContent>({ type: 'skills.read', path }, 30_000) : Promise.reject(new Error('sem conexão com o serviço do My Company AI')))}
                  onAddLocal={() => setDialog({ kind: 'addSkill', projectId: skillsViewProjectId })}
                  onOpenExternal={(t, v) => openExternal(t, v)}
                />
              )}
              {view === 'files' && (fsApi ? (
                <FileExplorer key={filesOpenNonce} api={fsApi} roots={fsRoots} initialRootId={filesLoc.rootId} initialCwd={filesLoc.cwd} onLocationChange={(rootId, cwd) => setFilesLoc({ rootId: rootId ?? undefined, cwd })} connected={connection === 'open'} changeSignal={state.lastFsChange} onOpenExternal={(t, p) => openExternal(t, p)} onNotice={notify} onInterruptSessions={interruptSessions} />
              ) : <div className="hq-empty hq-empty--tall"><p>Conectando ao serviço…</p></div>)}
              {view === 'routines' && (
                <RoutinesView
                  routines={state.routines} employees={state.employees} projects={state.projects} tasks={state.tasks} connected={connection === 'open'}
                  onSave={async (input, id) => { if (!client) throw new Error('sem conexão com o serviço do My Company AI'); await client.request(id ? { type: 'routine.update', id, patch: input } : { type: 'routine.create', routine: input }, 30_000); }}
                  onToggle={async (id, enabled) => { if (!client) throw new Error('sem conexão com o serviço do My Company AI'); await client.request({ type: 'routine.update', id, patch: { enabled } }, 30_000); }}
                  onRunNow={async id => { if (!client) throw new Error('sem conexão com o serviço do My Company AI'); await client.request({ type: 'routine.runNow', id }, 60_000); notify('info', 'Rotina enviada: a tarefa entrou na fila.'); }}
                  onDelete={id => { if (client) safe(() => client.send({ type: 'routine.delete', id })); }}
                  onOpenEmployee={id => { selectWorker(id, true); setTab('chat'); setView('office'); sceneRef.current?.focusWorker(id, true); }}
                />
              )}
              {view === 'trash' && (fsApi ? <TrashView api={fsApi} connected={connection === 'open'} changeNonce={state.trashNonce} onNotice={notify} /> : <div className="hq-empty hq-empty--tall"><p>Conectando ao serviço…</p></div>)}
            </div>
          )}
        </main>
        {sideAllowed && panelVisible && (panelCollapsed ? (
          <div className="hq-panel-tab">
            <button type="button" className="hq-panel-tab__btn" onClick={() => setPanelCollapsed(false)} title="Expandir painel"><span className="hq-status-dot" style={{ background: workerStatusColor(worker?.status) }} />{employee?.name ?? worker?.name}</button>
          </div>
        ) : (
          <WorkerPanel
            worker={worker} session={session} employee={employee} conversations={conversations} tab={tab} onTab={setTab}
            onPrivateChat={employee ? () => openDm(employee.id) : undefined}
            onClose={() => setSelectedId(null)} onCollapse={() => setPanelCollapsed(true)}
            onCloseSession={() => session && client && safe(() => client.send({ type: 'session.close', sessionId: session.id }))}
            onResumeSession={() => session && client && safe(() => client.send({ type: 'session.resume', sessionId: session.id }))}
            onArchiveSession={() => { if (session && client && window.confirm('Arquivar esta conversa? O processo é encerrado e ela sai do seletor; o histórico fica guardado. O funcionário continua na sala.')) safe(() => client.send({ type: 'session.archive', sessionId: session.id })); }}
            onSelectConversation={id => employee && client && safe(() => client.send({ type: 'employee.setActiveSession', id: employee.id, sessionId: id || null }))}
            onNewConversation={() => employee && openConversationDialog(employee.id, null, project?.id ?? null)}
            onEditEmployee={() => employee && setDialog({ kind: 'employee', employeeId: employee.id, roomId: null })}
            onArchiveEmployee={() => employee && archiveEmployee(employee.id)}
            onGiveTask={employee ? () => giveTask(employee.id) : undefined}
            chat={{
              items: session ? state.chat[session.id] ?? [] : [], streamingText: session ? state.streaming[session.id] ?? '' : '', streamingAuthor: session?.provider ?? employee?.provider ?? 'claude', busy, pending: sessionPending,
              onAllow: (requestId, remember) => { const p = sessionPending.find(x => x.request.requestId === requestId); if (client && session) safe(() => client.send({ type: 'permission.respond', sessionId: session.id, requestId, behavior: 'allow', remember: remember ? p?.request.permissionSuggestions : undefined })); },
              onDeny: (requestId, message) => { if (client && session) safe(() => client.send({ type: 'permission.respond', sessionId: session.id, requestId, behavior: 'deny', message })); },
              onAnswer: (requestId, answers) => { if (client && session) safe(() => client.send({ type: 'question.answer', sessionId: session.id, requestId, answers })); },
              onOpenFile: p => openExternal('file', p),
            }}
            composer={{
              session, project, room, profiles: room?.profiles ?? [], profileId: session?.profileId ?? null,
              busy, queuedCount: session ? queued.filter(t => t.sessionId === session.id).length : 0, connected: connection === 'open', disabledReason,
              onSend: send,
              onInterrupt: () => session && client && safe(() => client.send({ type: 'session.interrupt', sessionId: session.id })),
              onProfileChange: profileId => session && client && safe(() => client.send({ type: 'session.setProfile', sessionId: session.id, profileId })),
              onModelChange: model => session && client && safe(() => client.send({ type: 'session.setModel', sessionId: session.id, model })),
              onPermissionModeChange: (mode: PermissionModeOption) => session && client && safe(() => client.send({ type: 'session.setPermissionMode', sessionId: session.id, mode })),
            }}
            timeline={{ entries: session ? state.events[session.id] ?? [] : [], activity: session?.activity ?? null, processState: session?.processState ?? null }}
            files={{
              project, tree: project ? files[project.id]?.tree ?? null : null, gitStatus: project ? files[project.id]?.gitStatus ?? null : null,
              touchedFiles: sessionTasks.flatMap(t => t.touchedFiles), loading: project ? Boolean(files[project.id]?.loading) : false,
              onLoadTree: path => { if (project) loadTree(project.id, path); },
              onReadFile: async p => { if (!client || !project) throw new Error('sem projeto'); return client.request<{ content: string; truncated: boolean; binary: boolean }>({ type: 'files.read', projectId: project.id, path: p }); },
              onDiff: async p => { if (!client || !project) return ''; return client.request<string>({ type: 'git.diff', projectId: project.id, path: p }); },
              onOpenExternal: openExternal,
            }}
            deliveries={{
              tasks: sessionTasks, project, previewUrl: project?.previewUrl ?? null, employees: state.employees,
              onRetry: retryTask, onMarkVerified: markVerified, onRelease: releaseTask, onCancelQueued: cancelQueued,
              onOpenExternal: openExternal,
              onSetPreviewUrl: url => { if (client && project) safe(() => client.send({ type: 'project.update', id: project.id, patch: { previewUrl: url } })); },
              onCheckPreview: async url => { if (!client) return { ok: false, error: 'sem conexão' }; return client.request<{ ok: boolean; status?: number; error?: string }>({ type: 'preview.check', url }); },
              onLocalPreview: async () => { if (!client || !project) return { error: 'sem conexão ou sem projeto' }; return client.request<{ url: string; entry: string } | { error: string }>({ type: 'preview.local', projectId: project.id }); },
            }}
            terminal={session ? <TerminalNote session={session} project={project} /> : undefined}
          />
        ))}
        {sideAllowed && !panelVisible && socialPanel === 'chefe' && (
          <ChefeDeskPanel
            summary={<DeskSummary tasks={state.tasks} since={state.settings.lastSeenAt ?? null} />}
            videoRef={videoRefApi}
            inbox={deskApi ? (g => <DeskInbox group={g} desk={state.desk} pending={state.pending} tasks={state.tasks} sessions={state.sessions} employees={state.employees} meetings={state.meetings} api={deskApi} hidden={state.content?.hidden ?? []} stalled={stalled} />) : undefined}
            deliveries={state.desk?.deliveries ?? []} allTasks={state.tasks}
            tasks={socialAllTasks} profileId={socialProfile?.id ?? null} employees={state.employees} profileName={socialProfile?.name ?? null} api={pieceApi}
            onClose={() => setSocialPanel(null)} onWrite={() => setComposerFocus(n => n + 1)}
            onOpen={t => openConversation(t.sessionId, t.employeeId ?? null)} onReviewed={markVerified}
            content={state.content} social={state.social} contentApi={contentApi} onBoard={tab => { setBoardTab(tab); setSocialPanel('board'); }}
          />
        )}
        {sideAllowed && !panelVisible && socialPanel === 'board' && (
          <ContentBoardPanel deliveries={state.desk?.deliveries ?? []}
            tasks={socialAllTasks} employees={state.employees} room={socialRoom} profileId={socialProfile?.id ?? null} api={pieceApi}
            onProfile={id => { if (id) setProfileId(id); }} onClose={() => setSocialPanel(null)}
            onOpen={t => openConversation(t.sessionId, t.employeeId ?? null)} onReady={markVerified}
            content={state.content} contentApi={contentApi} tab={boardTab} onTab={setBoardTab}
          />
        )}
        {sideAllowed && !panelVisible && socialPanel === 'redes' && (
          <aside className="hq-panel hq-panel--room hq-soc-panel hq-soc-panel--wide hq-hub-panel" aria-label="Central de Redes">
            <header className="hq-panel__head">
              <div className="hq-panel__who">
                <div className="hq-panel__names"><div className="hq-panel__name">Central de Redes<span className="hq-panel__role">{socialSummary(state.social)}</span></div></div>
                <button type="button" className="hq-iconbtn" onClick={() => setSocialPanel(null)} aria-label="Fechar painel">×</button>
              </div>
            </header>
            <div className="hq-panel__body hq-panel__body--scroll">
              {hubApi ? <SocialHub state={state.social} profiles={socialRoom?.profiles ?? []} api={hubApi} /> : <p className="hq-empty">Conectando ao serviço…</p>}
            </div>
          </aside>
        )}
        {sideAllowed && !panelVisible && !socialPanel && teamPanel && (
          <TeamPanel
            team={teamPanel} roomId={socialRoom?.id ?? null} employees={state.employees} tasks={state.tasks} items={state.content?.items ?? []}
            radar={state.content?.radar ?? []} pending={state.pending} onClose={() => setTeamPanel(null)}
            onNewTask={() => { setProfileId(teamPanel); setTeamPanel(null); setComposerFocus(n => n + 1); notify('info', `Pedido da ${teamDef(teamPanel).label}: o destino lista só os canais dela.`); }}
            onMeeting={async ({ agenda, employeeIds }) => {
              const emps = employeeIds.map(id => state.employees.find(e => e.id === id)).filter((e): e is NonNullable<typeof e> => Boolean(e));
              const res = await meetingDispatch({ type: 'meeting.create', reqId: '', title: `Reunião da ${teamDef(teamPanel).label}`, agenda, projectId: contentFolderProject?.id ?? null, mode: 'guided', participants: emps.map(e => ({ provider: e.provider ?? 'claude', employeeId: e.id })) }) as { meeting?: { id: string } } | undefined;
              if (!res?.meeting?.id) throw new Error('o servidor não devolveu a reunião criada');
              setTeamPanel(null); setView('meetings'); setSelectedMeetingId(res.meeting.id);
            }}
            onAddRef={async ({ url, slot, instruction }) => { if (!contentApi) throw new Error('sem conexão com o serviço'); await contentApi.videoAdd({ url, file: null, liked: null, mode: 'produzir', instruction, slot, profileId: teamPanel }); }}
            onOpenEmployee={id => { setTeamPanel(null); selectWorker(id, true); setTab('chat'); }}
            onOpenTask={id => { const t = state.tasks.find(x => x.id === id); if (t) openConversation(t.sessionId, t.employeeId ?? null); }}
            onOpenFolder={contentFolderProject ? () => { setTeamPanel(null); openFilesAt(`project:${contentFolderProject.id}`, `marcas/${teamPanel}`); } : undefined}
          />
        )}
        {sideAllowed && !panelVisible && socialPanel === 'studio' && (
          <StudioPanel
            tasks={socialTasks} employees={state.employees} api={pieceApi} skill={videoSkill} skillLoading={Boolean(catalogs['']?.loading)}
            onClose={() => setSocialPanel(null)} onStart={startStudio}
            onShareVideo={() => { setSocialPanel(null); setView('conteudo'); setShareSignal(n => n + 1); }} onAcademy={() => homeMore('academia')}
            onOpen={t => openConversation(t.sessionId, t.employeeId ?? null)} onReady={markVerified}
          />
        )}
        {sideAllowed && !panelVisible && !socialPanel && roomPanelOpen && selectedRoom && (
          <RoomPanel
            availability={selectedRoom.kind === 'meeting' ? meetingAvailability(state.ai) : undefined}
            room={selectedRoom} employees={state.employees} workers={state.workers} sessions={state.sessions} projects={state.projects} tasks={state.tasks}
            onClose={() => setRoomPanelOpen(false)}
            onOpenEmployee={id => { selectWorker(id, true); setTab('chat'); }}
            onNewEmployee={roomId => setDialog({ kind: 'employee', employeeId: null, roomId })}
            onNewConversation={(roomId, projectId) => openConversationDialog(null, roomId, projectId)}
            onAddProject={roomId => setDialog({ kind: 'project', roomId })}
            onEditRoom={roomId => setDialog({ kind: 'room', roomId })}
            onOpenFiles={id => openFilesAt(`project:${id}`)}
            onGiveTask={giveTask}
            meetings={state.meetings}
            onOpenMeetings={id => { setView('meetings'); if (id) setSelectedMeetingId(id); }}
          />
        )}
        </div>
      <div className="hq-composer-host" style={{ display: sideAllowed && view !== 'conteudo' ? 'contents' : 'none' }}>
      <TaskComposer
        employees={state.employees} workers={state.workers} projects={state.projects} rooms={state.rooms} sessions={state.sessions} tasks={state.tasks}
        skills={composerCatalog?.catalog?.skills ?? null} skillsLoading={Boolean(composerCatalog?.loading)} skillsError={composerCatalog?.error ?? null}
        favorites={favorites} ai={state.ai} settings={state.settings} connected={connection === 'open'}
        prefill={composerPrefill} focusNonce={composerFocus}
        onProjectChange={setComposerProjectId}
        onRun={runTask}
        title={roomMode === 'social' ? 'O que vamos criar?' : undefined}
        manager={roomMode === 'social' ? composerManager : null}
        videoRef={roomMode === 'social' ? videoRefApi : null}
        profileName={roomMode === 'social' && socialRoom && socialRoom.profiles.length > 0 ? socialProfile?.name ?? null : undefined}
        profileId={roomMode === 'social' ? socialProfile?.id ?? null : undefined}
        destinations={roomMode === 'social' ? destinationsFor(socialAccounts, socialProfile?.id ?? null).map(a => ({ id: a.slot, label: destinationLabel(a), state: destinationState(a) })) : undefined}
        roomId={roomMode === 'social' ? socialRoom?.id ?? null : null}
        lockedProject={roomMode === 'social' && contentFolderProject ? contentFolderProject : null}
        ready={state.lastSnapshotAt != null}
        onAddProject={() => setDialog({ kind: 'project', roomId: roomMode === 'social' ? socialRoom?.id ?? selectedRoomId : selectedRoomId })}
        onHire={() => setDialog({ kind: 'employee', employeeId: null, roomId: roomMode === 'social' ? socialRoom?.id ?? selectedRoomId : selectedRoomId })}
        onOpenConversation={openConversation}
        onOpenSkills={() => setView('skills')}
        onOpenConnections={() => setDialog({ kind: 'settings', tab: 'ai' })}
        fsList={meetingFsList}
      />
      </div>
        </div>
      </div>
      <StatusBar hint={view === 'office' && dialog.kind === 'none' ? 'Clique numa pessoa ou objeto para abrir · clique no chão para o Chefe andar · arraste para mover a câmera · roda do mouse aproxima · N novo pedido · Ctrl+K busca' : null} connected={connection === 'open'} serverInfo={state.serverInfo} activeCount={activeCount} dmRunning={dmRunning} queuedByTeam={TEAMS.map(t => [t.short, queued.filter(q => teamOfWork(q) === t.id).length] as const).filter(([, n]) => n > 0).map(([l, n]) => `${l} ${n}`).join(' · ') || null} meetingTurns={meetingTurns} queuedCount={queued.length} rateLimit={(rateLimitNotice(session?.activity.rateLimit) ? session?.activity.rateLimit : null) ?? state.sessions.find(s => rateLimitNotice(s.activity.rateLimit))?.activity.rateLimit} />

      <ProjectCabinet
        open={cabinet !== null} projects={state.projects} rooms={state.rooms} tasks={state.tasks}
        roomId={cabinet?.roomId ?? null} initialProjectId={cabinet?.projectId ?? null}
        fsList={meetingFsList}
        onClose={() => setCabinet(null)}
        onUseInTask={(projectId, contextFiles) => { setCabinet(null); setView('office'); setComposerPrefill({ nonce: Date.now(), projectId, contextFiles }); setComposerFocus(n => n + 1); }}
        onOpenFiles={id => { setCabinet(null); openFilesAt(`project:${id}`); }}
        onOpenFolder={p => openExternal('folder', p)}
        onUpdate={(id, patch) => { if (client) safe(() => client.send({ type: 'project.update', id, patch })); }}
        onAddProject={roomId => { setCabinet(null); setDialog({ kind: 'project', roomId: roomId ?? selectedRoomId }); }}
      />
      <QuickSearch
        open={searchOpen} projects={state.projects} employees={state.employees} skills={composerCatalog?.catalog?.skills ?? catalogs['']?.catalog?.skills ?? []}
        actions={quickActions}
        searchFiles={searchProjectFiles}
        onClose={() => setSearchOpen(false)}
        onOpenProject={id => setCabinet({ roomId: null, projectId: id })}
        onTaskInProject={id => { setView('office'); setComposerPrefill({ nonce: Date.now(), projectId: id }); setComposerFocus(n => n + 1); }}
        onUseFile={(hit: QuickFileHit) => { setView('office'); setComposerPrefill({ nonce: Date.now(), projectId: hit.projectId, contextFiles: [hit.path] }); setComposerFocus(n => n + 1); notify('info', `${hit.name} entrou como contexto da tarefa em ${hit.projectName}.`); }}
        onOpenEmployee={id => { selectWorker(id, true); setTab('chat'); setView('office'); sceneRef.current?.focusWorker(id, true); }}
        onUseSkill={useSkill}
      />
      {viewer && viewerApi && <FileViewer key={`${viewer.title}:${viewer.files.join('|')}:${viewer.index ?? 0}`} req={viewer} api={viewerApi} onClose={() => setViewer(null)} decide={viewerPiece && contentApi ? <PieceDecision item={viewerPiece} tasks={state.tasks} employees={state.employees} api={contentApi} /> : null} />}
      <NewSessionDialog
        open={dialog.kind === 'session'}
        room={dialogRoom}
        employee={dialogSessionEmployee}
        roomEmployees={dialogRoom ? state.employees.filter(e => !e.archivedAt && e.roomId === dialogRoom.id) : []}
        projects={state.projects.filter(p => !p.id.startsWith('ext:'))}
        defaultProjectId={dialog.kind === 'session' ? dialog.projectId : null}
        defaultModel={state.settings.defaultModel} defaultPermissionMode={state.settings.defaultPermissionMode}
        resumable={dialogSessionEmployee ? state.sessions.filter(s => s.employeeId === dialogSessionEmployee.id && s.id !== dialogSessionEmployee.activeSessionId && (s.status === 'paused' || s.status === 'lost' || s.status === 'new')) : []}
        onCreate={input => {
          if (!client || dialog.kind !== 'session') return;
          const roomId = dialog.roomId; setDialog({ kind: 'none' });
          safe(async () => {
            const s = await client.request<Session>({ type: 'session.create', roomId, projectId: input.projectId, employeeId: input.employeeId, name: input.name, model: input.model, permissionMode: input.permissionMode, profileId: input.profileId });
            if (s.employeeId) { selectWorker(s.employeeId, true); setTab('chat'); }
            setView('office');
          });
        }}
        onResume={id => { if (client && dialogSessionEmployee) { const eid = dialogSessionEmployee.id; safe(() => { client.send({ type: 'employee.setActiveSession', id: eid, sessionId: id }); client.send({ type: 'session.resume', sessionId: id }); }); selectWorker(eid, true); } setDialog({ kind: 'none' }); }}
        onAddProject={() => setDialog({ kind: 'project', roomId: dialog.kind === 'session' ? dialog.roomId : null })}
        onCancel={() => setDialog({ kind: 'none' })}
      />
      <AddProjectDialog
        open={dialog.kind === 'project'} rooms={state.rooms} defaultRoomId={dialog.kind === 'project' ? dialog.roomId : null}
        onCreate={async input => {
          if (!client) return { ok: false, error: 'sem conexão' };
          try {
            const p = await client.request<Project>({ type: 'project.create', name: input.name, path: input.path, roomId: input.roomId });
            setDialog({ kind: 'none' });
            // Pasta recém-cadastrada vira o projeto do compositor quando ele ainda não tinha um (não troca uma escolha feita).
            if (p?.id && !composerProjectId) setComposerPrefill({ nonce: Date.now(), projectId: p.id });
            return { ok: true };
          }
          catch (err) { return { ok: false, error: (err as Error).message }; }
        }}
        onCancel={() => setDialog({ kind: 'none' })}
      />
      <EmployeeDialog
        open={dialog.kind === 'employee'} employee={dialogEmployee} rooms={state.rooms}
        defaultRoomId={dialog.kind === 'employee' ? dialog.roomId ?? selectedRoomId : null}
        defaultModel={state.settings.defaultModel} defaultPermissionMode={state.settings.defaultPermissionMode}
        usedNames={state.employees.filter(e => !e.archivedAt).map(e => e.name)} ai={state.ai}
        templates={state.settings.roleTemplates} skills={catalogs['']?.catalog?.skills ?? []} agents={agents}
        onCreate={async (input: EmployeeInput) => {
          if (!client) return { ok: false, error: 'sem conexão' };
          try {
            const e = await client.request<Employee>({ type: 'employee.create', ...input });
            setDialog({ kind: 'none' }); selectWorker(e.id, true); setTab('chat'); setView('office');
            // Quem acabou de ser contratado vira o responsável no compositor (dá para trocar no seletor).
            setComposerPrefill({ nonce: Date.now(), employeeId: e.id });
            notify('info', `${e.name} contratado(a): está na sala ${state.rooms.find(r => r.id === e.roomId)?.name ?? ''}. Nenhum processo foi iniciado; escreva o pedido em “O que vamos fazer?”.`);
            return { ok: true };
          } catch (err) { return { ok: false, error: (err as Error).message }; }
        }}
        onSave={async (id, patch) => {
          if (!client) return { ok: false, error: 'sem conexão' };
          try { client.send({ type: 'employee.update', id, patch }); setDialog({ kind: 'none' }); return { ok: true }; }
          catch (err) { return { ok: false, error: (err as Error).message }; }
        }}
        onCancel={() => setDialog({ kind: 'none' })}
      />
      <RoomEditor open={dialog.kind === 'room'} room={dialog.kind === 'room' ? state.rooms.find(r => r.id === dialog.roomId) ?? null : null}
        onSave={patch => { if (client && dialog.kind === 'room') safe(() => client.send({ type: 'room.update', id: dialog.roomId, patch })); setDialog({ kind: 'none' }); }} onCancel={() => setDialog({ kind: 'none' })} />
      <SettingsDialog socialSection={hubApi ? <SocialHub state={state.social} profiles={socialRoom?.profiles ?? []} api={hubApi} /> : null} open={dialog.kind === 'settings'} initialTab={dialog.kind === 'settings' ? dialog.tab : undefined} settings={state.settings} serverInfo={state.serverInfo} ai={state.ai}
        onAiRefresh={async provider => { if (!client) throw new Error('sem conexão com o serviço do My Company AI'); await client.request({ type: 'ai.refresh', provider }, 60_000); }}
        onAiTest={(provider, model, effort) => (client ? client.request<AiTestResult>({ type: 'ai.test', provider, model, effort }, 150_000) : Promise.reject(new Error('sem conexão com o serviço do My Company AI')))}
        onAiLoginStart={provider => (client ? client.request<{ url: string | null; detail: string }>({ type: 'ai.login.start', provider }, 60_000) : Promise.reject(new Error('sem conexão com o serviço do My Company AI')))}
        onAiLoginCancel={provider => { if (client) safe(() => client.send({ type: 'ai.login.cancel', provider })); }}
        onOpenExternal={url => openExternal('url', url)}
        connection={connection} lastSnapshotAt={state.lastSnapshotAt} service={state.serviceStatus}
        onReconnect={() => client?.connect()}
        onRefreshService={async () => { if (!client) throw new Error('sem conexão com o serviço do My Company AI'); const s = await client.request<ServiceStatus>({ type: 'service.status' }, 15_000); store.set(st => ({ ...st, serviceStatus: s })); }}
        onServicePause={paused => { if (client) safe(() => client.send({ type: 'service.pause', paused })); }}
        onServiceAutostart={async enabled => { if (!client) throw new Error('sem conexão com o serviço do My Company AI'); const s = await client.request<ServiceStatus>({ type: 'service.autostart', enabled }, 60_000); store.set(st => ({ ...st, serviceStatus: s })); }}
        onServiceOpenLogs={() => { if (client) safe(() => client.send({ type: 'service.openLogs' })); }}
        onServiceShutdown={() => { if (client) safe(() => client.send({ type: 'service.shutdown' })); }}
        onDataInfo={() => (client ? client.request<DataInfo>({ type: 'service.dataInfo' }, 20_000) : Promise.reject(new Error('sem conexão com o serviço do My Company AI')))}
        onBackupNow={() => (client ? client.request<{ file: string; info: DataInfo }>({ type: 'service.backupNow' }, 120_000) : Promise.reject(new Error('sem conexão com o serviço do My Company AI')))}
        onCompanyName={saveCompanyName}
        onSave={patch => { if (client) safe(() => client.send({ type: 'settings.update', patch })); setDialog({ kind: 'none' }); }} onCancel={() => setDialog({ kind: 'none' })} />

      <AddSkillDialog
        open={dialog.kind === 'addSkill'} projects={visibleProjects} defaultProjectId={dialog.kind === 'addSkill' ? dialog.projectId : null}
        onInspect={path => (client ? client.request<SkillInspection>({ type: 'skills.inspectLocal', path }, 30_000) : Promise.reject(new Error('sem conexão com o serviço do My Company AI')))}
        onAdd={(path, scope, projectId) => (client ? client.request<SkillAddResult>({ type: 'skills.addLocal', path, scope, projectId }, 60_000) : Promise.reject(new Error('sem conexão com o serviço do My Company AI')))}
        onDone={r => { setDialog({ kind: 'none' }); notify('info', `Skill /${r.info.invocation} adicionada em ${r.destination}.`); loadCatalog(r.info.projectId ?? null, true); }}
        onCancel={() => setDialog({ kind: 'none' })}
      />
      <OnboardingDialog
        companyName={companyName}
        open={onboardingOpen} ai={state.ai} projects={state.projects} employees={state.employees}
        onOpenConnections={() => setDialog({ kind: 'settings', tab: 'ai' })}
        onAddProject={() => setDialog({ kind: 'project', roomId: selectedRoomId })}
        onHire={() => setDialog({ kind: 'employee', employeeId: null, roomId: selectedRoomId })}
        onFinish={() => { setOnboardingLater(true); if (client) safe(() => client.send({ type: 'settings.update', patch: { onboardingDone: true } })); }}
        onLater={() => setOnboardingLater(true)}
      />
      <AbsenceDialog
        open={dialog.kind === 'absence'} policy={state.settings.absence ?? DEFAULT_ABSENCE}
        projects={state.projects} employees={state.employees} tasks={state.tasks} routines={state.routines} defaultPermissionMode={state.settings.defaultPermissionMode}
        onSave={policy => { if (client) safe(() => client.send({ type: 'settings.update', patch: { absence: absencePatch(state.settings.absence ?? DEFAULT_ABSENCE, policy, Date.now()) } })); setDialog({ kind: 'none' }); }}
        onCancel={() => setDialog({ kind: 'none' })}
      />
      <AwayDialog
        open={dialog.kind === 'away'} summary={dialog.kind === 'away' ? dialog.summary : null}
        onOpenSession={sessionId => { setDialog({ kind: 'none' }); openConversation(sessionId, null); }}
        onOpenFile={p => openExternal('file', p)}
        onClose={() => setDialog({ kind: 'none' })}
      />

      {state.knowledgeCaptured && (
        <div className="hq-know-captured" role="status" aria-live="polite">
          <div><strong>Orientação registrada</strong> para {knowledgeScopeLabel(state.knowledgeCaptured.scope, { employees: state.employees, projects: state.projects })}: "{state.knowledgeCaptured.text.slice(0, 200)}"<span className="hq-dim"> · vale nos próximos pedidos</span></div>
          <div className="hq-actions">
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => undoCaptured(state.knowledgeCaptured!.id)}>Desfazer</button>
            <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => { store.set(s => ({ ...s, knowledgeCaptured: null })); openKnowledge(null); }}>Ver</button>
            <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => store.set(s => ({ ...s, knowledgeCaptured: null }))}>Ok</button>
          </div>
        </div>
      )}
      <Toasts notices={state.notices} onDismiss={dismissNotice} />
    </div>
    </>
  );
}

/** Resumo do trabalho desde a última visita: contadores das tarefas persistidas no servidor (nenhuma chamada de IA). */
function DeskSummary({ tasks, since }: { tasks: Task[]; since: number | null }) {
  const s = sinceLastVisit(tasks, since);
  const parts = [`${s.done} concluída${s.done === 1 ? '' : 's'}`, `${s.running} em execução`, `${s.queued} na fila`, ...(s.waiting ? [`${s.waiting} aguardando você ou dependência`] : []), ...(s.failed ? [`${s.failed} com falha`] : [])];
  return (
    <p className="hq-desk__summary" title="Contado nas tarefas gravadas no servidor (as 200 mais recentes)">
      <strong>{since ? `Desde sua última visita (${new Date(since).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})` : 'Trabalho da equipe'}:</strong> {parts.join(' · ')}
    </p>
  );
}

function TerminalNote({ session, project }: { session: Session; project: { path: string } | null }) {
  return (
    <div className="hq-terminal-note">
      <p>O terminal embutido não faz parte desta versão. A conversa é um processo real do Claude Code; para abri-la no terminal (com o mesmo histórico), use:</p>
      {session.claudeSessionId ? <code>cd "{project?.path ?? '.'}"{'\n'}claude --resume {session.claudeSessionId}</code> : <p className="hq-dim">Esta conversa ainda não iniciou o Claude Code (envie a primeira mensagem pelo chat).</p>}
      <p className="hq-dim">Enquanto a HQ estiver controlando a conversa, feche o processo aqui (Fechar processo) antes de retomar no terminal, para não haver dois processos no mesmo histórico.</p>
    </div>
  );
}

function Toasts({ notices, onDismiss }: { notices: Notice[]; onDismiss(id: number): void }) {
  // O prazo do aviso mais antigo só recomeça quando ELE muda, não a cada re-render do App (que acontece em toda mensagem do servidor).
  const oldest = notices[0]?.id;
  useEffect(() => {
    if (oldest == null) return;
    const t = window.setTimeout(() => onDismiss(oldest), 7000);
    return () => clearTimeout(t);
  }, [oldest, onDismiss]);
  if (!notices.length) return null;
  return (
    <div className="hq-toasts" aria-live="polite">
      {notices.map(n => (
        <div key={n.id} className={`hq-toast${n.level === 'warn' ? ' hq-toast--warn' : n.level === 'error' ? ' hq-toast--error' : ''}`} role={n.level === 'error' ? 'alert' : undefined}>
          <span className="hq-toast__text">{n.text}</span>
          {n.action && <button type="button" className="hq-linkbtn" onClick={() => { n.action?.run(); onDismiss(n.id); }}>{n.action.label}</button>}
          <button onClick={() => onDismiss(n.id)} aria-label="Fechar aviso">×</button>
        </div>
      ))}
    </div>
  );
}
