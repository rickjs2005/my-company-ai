// Compositor único "O que vamos fazer?": pedido → projeto → funcionário → skill (opcional) → Executar tarefa.
// Sempre visível na base da tela. O rascunho sobrevive à navegação (localStorage) e cada pedido tem um clientId
// estável: duplo clique, reconexão ou F5 nunca criam duas tarefas (o servidor devolve `duplicate: true`).
// "Dar tarefa" (funcionário) e "Usar esta skill" (área Skills) preenchem este mesmo compositor via `prefill`.
import { VideoRefComposer, videoIntent, type VideoRefComposerApi, type VideoRefControl } from './social/VideoRefComposer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiProviderStatus, EffortLevel, Employee, FsListResult, FsRoot, Project, Room, Session, Settings, SkillInfo, Task, TaskRunInput, TaskRunResult, Worker } from '@milweb-hq/protocol';
import { EFFORT_LABELS, REQUEST_INTENT_LABEL, detectDirective, isTeamId, readRequest } from '@milweb-hq/protocol';
import type { KnowledgeScope, TeamId } from '@milweb-hq/protocol';
import { PERMISSION_MODE_LABELS, PERMISSION_MODE_OPTIONS, modelOptionsFromCatalog, taskStateLabel, truncate, workerStatusColor, workerStatusLabel } from '../panel/helpers';
import { IconBolt, IconFile, IconSend, IconSettings, IconX } from '../panel/icons';
import { FilePickerDialog } from '../meetings/FilePickerDialog';
import { withDestination } from './social/socialHelpers';
import { effortsForModel } from '../settings/helpers';
import {
  DRAFT_KEY, EMPTY_OPTIONS, PROVIDER_SHORT, applyProjectLock, emptyDraft, missingItems, optionsSummary, parseDraft, serializeDraft, skillAvailability, skillOptionsFor, suggestEmployee, taskConfigLines,
  type ComposerDraft, type ComposerOptions,
} from './composerHelpers';

/** Pré-preenchimento vindo de fora (botões "Dar tarefa" / "Usar esta skill"). `nonce` muda a cada pedido. */
export interface ComposerPrefill { nonce: number; text?: string; skill?: string | null; employeeId?: string | null; projectId?: string | null; contextFiles?: string[]; destination?: string | null }

export interface TaskComposerProps {
  employees: Employee[];
  workers: Worker[];
  projects: Project[];
  rooms: Room[];
  sessions: Session[];
  tasks: Task[];
  /** Catálogo de skills do projeto escolhido (null = ainda não carregado). */
  skills: SkillInfo[] | null;
  skillsLoading: boolean;
  skillsError: string | null;
  favorites: string[];
  ai: AiProviderStatus[];
  settings: Settings;
  connected: boolean;
  prefill: ComposerPrefill | null;
  /** Muda quando o Chefe clica "Nova tarefa": o campo de texto recebe foco. */
  focusNonce: number;
  /** O App carrega o catálogo de skills do projeto escolhido. */
  onProjectChange(projectId: string | null): void;
  onRun(input: Omit<TaskRunInput, 'reqId'>): Promise<TaskRunResult>;
  onAddProject(): void;
  onHire(): void;
  onOpenConversation(sessionId: string, employeeId: string): void;
  onOpenSkills(): void;
  onOpenConnections(): void;
  /** Marco 1: lista uma pasta do projeto (seletor de arquivos de contexto). */
  fsList?(rootId: string, path: string): Promise<FsListResult>;
  /** Título do campo ("O que vamos criar?" na sala Social Media). */
  title?: string;
  /** Perfil editorial ativo (topo). undefined = a sala não tem perfis; null = nenhum escolhido. */
  profileName?: string | null;
  profileId?: string | null;
  /** Contas de destino do perfil (central de Redes). undefined = campo de destino escondido (fora da sala Social Media). */
  destinations?: { id: string; label: string; state: string }[];
  /** Sala onde o Chefe está: a sugestão de funcionário prefere quem trabalha nela. */
  roomId?: string | null;
  /** Dados do servidor já chegaram (retrato completo). Antes disso, escolhas salvas no rascunho não são descartadas. */
  ready?: boolean;
  /** Sala travada numa pasta: a sala Social Media trabalha sempre na pasta de conteúdo (o projeto não se escolhe aqui). */
  lockedProject?: { id: string; name: string } | null;
  /** Sala Social Media: link (ou vídeo arrastado) no campo vira referência de vídeo com os dois caminhos. */
  videoRef?: VideoRefComposerApi | null;
  /** Sala Social Media: "Gerente distribui" é o executor padrão (sem escolher funcionário, skill, modelo nem pasta). */
  manager?: ComposerManager | null;
}

/** Caminho padrão do pedido: a gerente da sala coordena. A leitura do texto decide se é produzir, ensinar, corrigir, conversar ou "o que depende de mim". */
export interface ComposerManager {
  /** Nome da gerente (null = a sala ainda não tem coordenador contratado). */
  name: string | null;
  /** Por que o caminho não está disponível agora (sala sem pasta, sem gerente). */
  blocked: string | null;
  ask(text: string, teams: TeamId[]): Promise<unknown>;
  teach(text: string, scope: KnowledgeScope): Promise<{ scopeLabel: string; duplicate: boolean }>;
  talk(text: string): Promise<void>;
  openDesk(): void;
}

const NEW_PROJECT = '__new__';
const HIRE = '__hire__';
const AUTO = '';
const MAX_TEXT_ROWS = 6;

function newId(): string { return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function loadDraft(): ComposerDraft { try { return parseDraft(localStorage.getItem(DRAFT_KEY), newId); } catch { return emptyDraft(newId()); } }
function saveDraft(d: ComposerDraft) { try { localStorage.setItem(DRAFT_KEY, serializeDraft(d)); } catch { /* sem storage: o rascunho vive só nesta aba */ } }

interface RunOutcome { result: TaskRunResult; at: number }

export function TaskComposer(props: TaskComposerProps) {
  const { employees, workers, projects, rooms, sessions, tasks, skills, skillsLoading, skillsError, favorites, ai, settings, connected, prefill, focusNonce } = props;
  const [draft, setDraft] = useState<ComposerDraft>(loadDraft);
  const [skillQuery, setSkillQuery] = useState('');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [pickingContext, setPickingContext] = useState(false);
  const [submitting, setSubmitting] = useState<null | 'run' | 'plan'>(null);
  const [error, setError] = useState<string | null>(null);
  const [refFile, setRefFile] = useState<File | null>(null);
  const [refNote, setRefNote] = useState<string | null>(null);
  const vrefCtl = useRef<VideoRefControl | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [managerMsg, setManagerMsg] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const lastPrefill = useRef<number>(-1);
  const lastProjectSent = useRef<string | null | undefined>(undefined);

  const update = useCallback((patch: Partial<ComposerDraft>) => setDraft(d => ({ ...d, ...patch })), []);
  useEffect(() => { saveDraft(draft); }, [draft]);

  const visibleProjects = useMemo(() => projects.filter(p => !p.id.startsWith('ext:')), [projects]);
  const activeEmployees = useMemo(() => employees.filter(e => !e.archivedAt), [employees]);
  const project = visibleProjects.find(p => p.id === draft.projectId) ?? null;
  const employee = activeEmployees.find(e => e.id === draft.employeeId) ?? null;
  const provider = employee?.provider ?? 'claude';
  const status = ai.find(s => s.provider === provider) ?? null;
  const worker = employee ? workers.find(w => w.id === employee.id) ?? null : null;

  // Projeto único: escolhe sozinho (é a única opção possível). Projeto que sumiu: limpa (só depois que os dados chegaram;
  // ao recarregar a página as listas começam vazias e o rascunho perdia o projeto e o funcionário escolhidos).
  const ready = props.ready !== false;
  useEffect(() => {
    if (!ready) return;
    if (draft.projectId && !visibleProjects.some(p => p.id === draft.projectId)) update({ projectId: null, contextFiles: [] });
    else if (!draft.projectId && visibleProjects.length === 1) update({ projectId: visibleProjects[0].id });
  }, [ready, draft.projectId, visibleProjects, update]);
  // Sala travada: entra com a pasta da sala e, ao sair, devolve o projeto que estava escolhido.
  const lockedId = props.lockedProject?.id ?? null;
  useEffect(() => {
    if (!ready) return;
    const patch = applyProjectLock(draft, lockedId, visibleProjects);
    if (patch) update(patch);
  }, [ready, lockedId, draft.projectId, visibleProjects, update]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ready && draft.employeeId && !activeEmployees.some(e => e.id === draft.employeeId)) update({ employeeId: null });
  }, [ready, draft.employeeId, activeEmployees, update]);
  // O App carrega o catálogo do projeto escolhido (uma vez por mudança).
  useEffect(() => {
    if (lastProjectSent.current === draft.projectId) return;
    lastProjectSent.current = draft.projectId;
    props.onProjectChange(draft.projectId);
  }, [draft.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pré-preenchimento externo: só os campos informados; texto só substitui quando o campo está vazio (não perde o que foi escrito).
  useEffect(() => {
    if (!prefill || prefill.nonce === lastPrefill.current) return;
    lastPrefill.current = prefill.nonce;
    setDraft(d => ({
      ...d,
      text: prefill.text && !d.text.trim() ? prefill.text : d.text,
      skill: prefill.skill !== undefined ? prefill.skill : d.skill,
      employeeId: prefill.employeeId !== undefined ? prefill.employeeId : d.employeeId,
      projectId: prefill.projectId !== undefined && prefill.projectId !== null ? prefill.projectId : d.projectId,
      contextFiles: prefill.contextFiles !== undefined ? prefill.contextFiles : (prefill.projectId && prefill.projectId !== d.projectId ? [] : d.contextFiles),
      destination: prefill.destination !== undefined ? prefill.destination : d.destination,
    }));
    setOutcome(null); setError(null);
    window.setTimeout(() => { const el = textRef.current; if (!el) return; el.focus(); const n = el.value.length; el.setSelectionRange(n, n); }, 0);
  }, [prefill]);
  useEffect(() => { if (focusNonce > 0) { textRef.current?.focus(); textRef.current?.select(); } }, [focusNonce]);

  // Altura do campo acompanha o texto (até MAX_TEXT_ROWS linhas).
  useEffect(() => {
    const el = textRef.current; if (!el) return;
    el.style.height = 'auto';
    const line = 20; const max = line * MAX_TEXT_ROWS + 16;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [draft.text]);

  useEffect(() => {
    if (!optionsOpen) return;
    const onDoc = (e: MouseEvent) => { if (optionsRef.current && !optionsRef.current.contains(e.target as Node)) setOptionsOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOptionsOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [optionsOpen]);

  const suggestion = useMemo(() => suggestEmployee({ employees, workers, project, rooms, skill: draft.skill, roomId: props.roomId ?? null }), [employees, workers, project, rooms, draft.skill, props.roomId]);
  const suggested = suggestion && suggestion.id !== draft.employeeId ? activeEmployees.find(e => e.id === suggestion.id) ?? null : null;

  const skillOptions = useMemo(() => (skills ? skillOptionsFor(skills, skillQuery, draft.projectId, favorites) : []), [skills, skillQuery, draft.projectId, favorites]);
  const chosenSkill = useMemo(() => (draft.skill && skills ? skills.find(s => s.invocation === draft.skill && !s.shadowedBy) ?? skills.find(s => s.invocation === draft.skill) ?? null : null), [draft.skill, skills]);
  const chosenAvailability = chosenSkill ? skillAvailability(chosenSkill, provider) : null;
  const skillUnknown = Boolean(draft.skill && skills && !chosenSkill);

  // "Gerente distribui": nenhum funcionário escolhido na sala que tem gerente. O pedido é lido (sem IA) para mostrar marca,
  // objetivo e entrega esperada antes de enfileirar, e só o dado essencial que falta vira pergunta.
  const managerMode = Boolean(props.manager) && !draft.employeeId;
  const reading = useMemo(() => readRequest(draft.text, { profileTeam: isTeamId(props.profileId) ? props.profileId : null, hasFile: Boolean(refFile) }), [draft.text, props.profileId, refFile]);
  const missing = useMemo(() => (managerMode
    ? [...(!draft.text.trim() ? ['o pedido (escreva o que vamos fazer)'] : reading.missing), ...(props.manager?.blocked && ['produzir', 'analisar'].includes(reading.intent) ? [props.manager.blocked] : [])]
    : missingItems(draft, employees, visibleProjects)), [managerMode, reading, props.manager, draft, employees, visibleProjects]);
  const providerBlocked = status && (!status.installed || status.authState !== 'ok')
    ? (!status.installed ? `${PROVIDER_SHORT[provider]} não está instalado nesta máquina.` : `${PROVIDER_SHORT[provider]} sem login: ${status.authDetail ?? 'conclua o login em Ajustes → Conexões.'}`)
    : null;
  const canSubmit = managerMode ? connected && missing.length === 0 && !submitting : connected && missing.length === 0 && !submitting && !providerBlocked && !(chosenAvailability && !chosenAvailability.ok) && !skillUnknown;

  // Link de vídeo no texto (ou vídeo anexado) na sala Social Media: o botão principal segue o fluxo de referência (inspeção,
  // análise, reunião e, se o texto pede, produção). A conversa comum continua possível pelo link do painel.
  const vref = props.videoRef ? videoIntent(draft.text, refFile) : { active: false, produce: false };
  const submit = async (plan: boolean, plain = false) => {
    setAttempted(true); setError(null);
    if (vref.active && !plan && !plain) { if (!submitting && vrefCtl.current) { setSubmitting('run'); try { await vrefCtl.current.go(); } finally { setSubmitting(null); } } return; }
    if (!canSubmit || submitting) return;
    if (managerMode && props.manager) {
      const m = props.manager; const text = draft.text.trim();
      setSubmitting('run'); setManagerMsg(null); setOutcome(null);
      try {
        if (reading.intent === 'status') { m.openDesk(); setManagerMsg('Minha mesa aberta: entregas para revisar, perguntas e bloqueios. Nada foi enfileirado.'); }
        else if (reading.intent === 'ensinar') {
          const d = detectDirective(text, { team: reading.teams.length === 1 ? reading.teams[0] : null, employees: activeEmployees.map(e => ({ id: e.id, name: e.name })) });
          const scope: KnowledgeScope = d?.scope ?? (reading.teams.length === 1 ? { type: 'equipe', id: reading.teams[0] } : { type: 'empresa', id: null });
          const r = await m.teach(d?.text ?? text, scope);
          setManagerMsg(r.duplicate ? 'Essa orientação já estava registrada: nada foi duplicado.' : `Ensinado: registrado em Equipe → Conhecimento da equipe para ${r.scopeLabel}. Vale a partir do próximo pedido; nada foi produzido nem publicado.`);
        }
        else if (reading.intent === 'conversar') { await m.talk(text); setManagerMsg(`Conversa aberta com ${m.name ?? 'a gerente'}: a resposta chega na conversa particular. Vira tarefa só se você pedir.`); }
        else { await m.ask(text, reading.teams); setManagerMsg(`Pedido com ${m.name ?? 'a gerente'}: ela distribui as etapas para a equipe (${reading.summary.marca}). A entrega chega na Minha mesa: ${reading.summary.entrega}.`); }
        setDraft(d => ({ ...d, text: '', contextFiles: [], clientId: newId() }));
        setAttempted(false);
      } catch (err) { setError((err as Error).message ?? String(err)); }
      finally { setSubmitting(null); }
      return;
    }
    setSubmitting(plan ? 'plan' : 'run');
    const current = draft;
    try {
      const result = await props.onRun({
        clientId: current.clientId, text: props.destinations ? withDestination(current.text.trim(), chosenDest?.label ?? null) : current.text.trim(), projectId: current.projectId!, employeeId: current.employeeId!,
        ...(props.destinations ? { destinationId: chosenDest?.id ?? null } : {}),
        ...(props.profileName !== undefined ? { profileId: props.profileId ?? null } : {}),
        skill: current.skill, plan,
        options: current.options.model || current.options.effort || current.options.permissionMode || current.options.ultracode ? { ...current.options } : undefined,
        contextFiles: current.contextFiles.length ? current.contextFiles : undefined,
      });
      setOutcome({ result, at: Date.now() });
      // Pedido aceito: novo clientId e texto limpo; projeto, funcionário, skill e opções ficam (escolhas lembradas).
      setDraft(d => ({ ...d, text: '', contextFiles: [], clientId: newId() }));
      setAttempted(false);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally { setSubmitting(null); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void submit(false); }
    else if (e.key === 'Escape') { (e.target as HTMLTextAreaElement).blur(); }
  };

  const setOption = <K extends keyof ComposerOptions>(k: K, v: ComposerOptions[K]) => update({ options: { ...draft.options, [k]: v } });
  const optionsCustom = Boolean(draft.options.model || draft.options.effort || draft.options.permissionMode || draft.options.ultracode);
  const modelOptions = useMemo(() => modelOptionsFromCatalog(status), [status]);
  const efforts: EffortLevel[] = useMemo(() => effortsForModel(status, draft.options.model ?? employee?.model ?? settings.ai?.[provider]?.model ?? null), [status, draft.options.model, employee?.model, settings.ai, provider]);
  // Ultracode (doc do Claude Code): só Claude, e indisponível em modelo sem o nível xhigh.
  const ultraBlock = provider !== 'claude' ? 'Ultracode é do Claude Code; este funcionário usa OpenAI.' : efforts.length > 0 && !efforts.includes('xhigh') ? 'O modelo escolhido não tem o nível xhigh, exigido pelo Ultracode.' : null;
  const effectiveModel = draft.options.model ?? employee?.model ?? settings.ai?.[provider]?.model ?? null;
  const effectiveEffort = draft.options.effort ?? employee?.effort ?? settings.ai?.[provider]?.effort ?? null;
  const chosenDest = props.destinations?.find(d => d.id === draft.destination) ?? null;
  const destOutside = Boolean(props.destinations && draft.destination && !chosenDest);
  const shortConfig = [effectiveModel ? (status?.models.find(m => m.id === effectiveModel)?.label ?? effectiveModel) : 'modelo padrão', effectiveEffort ? (EFFORT_LABELS[effectiveEffort] ?? effectiveEffort).toLowerCase() : 'esforço padrão', draft.options.ultracode ? 'Ultracode' : ''].filter(Boolean).join(' · ');
  const optionsSummaryShort = [draft.skill ? `/${draft.skill}` : '', draft.contextFiles.length ? `${draft.contextFiles.length} ref.` : '', chosenDest ? chosenDest.label.replace(/ \(@.*\)$/, '') : '', shortConfig].filter(Boolean).join(' · ');
  const projectRoot: FsRoot | null = project ? { id: `project:${project.id}`, kind: 'project', name: project.name, path: project.path, projectId: project.id } : null;

  const outcomeTask = outcome ? tasks.find(t => t.id === outcome.result.taskId) ?? null : null;
  const outcomeEmployee = outcome ? employees.find(e => e.id === outcome.result.employeeId) ?? null : null;
  const outcomeProject = outcome ? projects.find(p => p.id === outcome.result.projectId) ?? null : null;
  const outcomeSession = outcome ? sessions.find(s => s.id === outcome.result.sessionId) ?? null : null;

  return (
    <section className="hq-composer" role="region" aria-label="Nova tarefa"
      onDragOver={e => { if (props.videoRef && [...e.dataTransfer.items].some(i => i.type.startsWith('video/'))) e.preventDefault(); }}
      onDrop={e => { const f = [...e.dataTransfer.files].find(x => x.type.startsWith('video/')); if (props.videoRef && f) { e.preventDefault(); setRefFile(f); setRefNote(null); } }}>
      <div className="hq-composer__row hq-composer__row--text">
        <label className="hq-composer__title" htmlFor="hq-composer-text">{props.title ?? 'O que vamos fazer?'}</label>
        <textarea
          id="hq-composer-text" ref={textRef} className="hq-composer__text" rows={1} value={draft.text}
          placeholder={activeEmployees.length === 0 ? 'Escreva o pedido. Depois contrate o primeiro funcionário para executá-lo.' : 'Descreva o pedido em uma ou duas frases. Ctrl+Enter executa.'}
          onChange={e => { update({ text: e.target.value }); if (outcome) setOutcome(null); if (managerMsg) setManagerMsg(null); }} onKeyDown={onKeyDown}
          aria-describedby="hq-composer-help"
        />
        {/* Sempre à vista: quem executa, o perfil, as opções (resumo) e Executar. O resto fica dentro de Opções. */}
        <div className="hq-composer__actions">
          <label className="hq-composer__emp" title={employee ? `${employee.name}: ${workerStatusLabel(worker?.status)}${worker?.detail ? ` · ${worker.detail}` : ''}` : 'Quem executa'}>
            <span className="hq-status-dot" style={{ background: employee ? workerStatusColor(worker?.status) : 'var(--text-faint)' }} />
            <select className="hq-select hq-composer__empsel" value={draft.employeeId ?? ''} aria-label="Funcionário"
              onChange={e => { const v = e.target.value; if (v === HIRE) { props.onHire(); return; } update({ employeeId: v || null }); }}>
              <option value="">{props.manager ? `Gerente distribui${props.manager.name ? ` (${props.manager.name})` : ''}` : activeEmployees.length === 0 ? 'Contratar…' : 'Quem executa…'}</option>
              {activeEmployees.map(e => <option key={e.id} value={e.id}>{e.name} · {e.role} · {PROVIDER_SHORT[e.provider ?? 'claude']}</option>)}
              <option value={HIRE}>+ Contratar funcionário…</option>
            </select>
          </label>
          {props.profileName !== undefined && <span className="hq-chip hq-composer__profile" title="Perfil editorial desta tarefa: troque no topo da tela">Perfil: {props.profileName ?? 'nenhum'}</span>}
          <div className="hq-composer__options" ref={optionsRef}>
            <button type="button" className={`hq-btn hq-btn--sm${optionsCustom || draft.skill || draft.contextFiles.length ? ' hq-btn--on' : ''}`} onClick={() => setOptionsOpen(o => !o)} aria-haspopup="dialog" aria-expanded={optionsOpen} title="Projeto, skill, referências, destino, modelo, esforço, Ultracode e permissões" aria-label={`Opções: ${optionsSummaryShort}`}>
              <IconSettings size={12} /> <span className="hq-composer__cfg">{optionsSummaryShort}</span>
            </button>
            {optionsOpen && (
              <div className="hq-composer__popover hq-composer__popover--wide" role="dialog" aria-label="Opções da tarefa">
                <div className="hq-composer__popgrid">
                  {props.lockedProject ? (
                    <div className="hq-field"><span>Projeto (pasta dos materiais)</span>
                      <span className="hq-chip" title="A sala Social Media trabalha sempre na pasta de conteúdo. Para outro projeto, vá para a Visão geral da empresa.">{props.lockedProject.name} · fixo nesta sala</span>
                    </div>
                  ) : (
                  <label className="hq-field"><span>Projeto (pasta dos materiais)</span>
                    <select className="hq-select" value={draft.projectId ?? ''} aria-label="Projeto"
                      onChange={e => { const v = e.target.value; if (v === NEW_PROJECT) { props.onAddProject(); return; } update({ projectId: v || null, contextFiles: [] }); }}>
                      <option value="">{visibleProjects.length === 0 ? 'Nenhum projeto cadastrado' : 'Escolha o projeto…'}</option>
                      {visibleProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      <option value={NEW_PROJECT}>+ Cadastrar pasta…</option>
                    </select>
                  </label>
                  )}
                  <label className="hq-field"><span>Skill (manual de trabalho)</span>
                    <select className="hq-select" value={draft.skill ?? AUTO} aria-label="Skill (manual de trabalho)" onChange={e => update({ skill: e.target.value || null })}>
                      <option value={AUTO}>Automática (o funcionário decide)</option>
                      {draft.skill && !skillOptions.some(sk => sk.invocation === draft.skill) && <option value={draft.skill}>/{draft.skill}{skillUnknown ? ' (não encontrada)' : ''}</option>}
                      {skillOptions.map(sk => {
                        const av = skillAvailability(sk, provider);
                        return <option key={sk.id} value={sk.invocation} disabled={!av.ok} title={av.reason ?? sk.description}>{favorites.includes(sk.id) ? '★ ' : ''}/{sk.invocation}{!av.ok ? ' (indisponível)' : ''}{sk.kind === 'command' ? ' (comando)' : ''}</option>;
                      })}
                    </select>
                  </label>
                  {skills && skills.length > 8 && <input className="hq-input hq-composer__skillsearch" value={skillQuery} onChange={e => setSkillQuery(e.target.value)} placeholder="Filtrar skills…" aria-label="Filtrar skills pelo nome" />}
                  <div className="hq-composer__popline">
                    {chosenSkill ? <span className="hq-dim">{truncate(chosenSkill.description || 'sem descrição', 110)}</span> : <span className="hq-dim">{skillsLoading ? 'Lendo as skills instaladas…' : skillsError ? `Catálogo indisponível: ${skillsError}` : 'Skill é opcional.'}</span>}
                    <button type="button" className="hq-linkbtn" onClick={props.onOpenSkills}>Ver skills</button>
                  </div>
                  <div className="hq-field"><span>Referências (arquivos do projeto, sem cópia)</span>
                    <span className="hq-composer__context" aria-label="Arquivos de contexto">
                      {draft.contextFiles.map(cf => (
                        <span key={cf} className="hq-chip hq-composer__ctxchip" title={project ? `${project.path}\\${cf}` : cf}>
                          <IconFile size={11} /> {cf.split('/').pop()}
                          <button type="button" className="hq-composer__ctxx" aria-label={`Tirar ${cf} das referências`} onClick={() => update({ contextFiles: draft.contextFiles.filter(x => x !== cf) })}>×</button>
                        </span>
                      ))}
                      {project && props.fsList ? <button type="button" className="hq-linkbtn hq-composer__ctxadd" onClick={() => setPickingContext(true)}>+ anexar arquivo</button> : <span className="hq-dim">Escolha o projeto para anexar.</span>}
                    </span>
                  </div>
                  {props.destinations && (
                    <label className="hq-field"><span>Conta de destino (organiza o mural; publicar é sempre um clique seu depois)</span>
                      <select className="hq-select" value={chosenDest?.id ?? ''} onChange={e => update({ destination: e.target.value || null })}>
                        <option value="">Sem destino</option>
                        {props.destinations.map(d => <option key={d.id} value={d.id}>{d.label} · {d.state}</option>)}
                      </select>
                      {props.destinations.length === 0 && <span className="hq-field__hint">Nenhuma conta associada a este perfil: associe na central de Redes.</span>}
                    </label>
                  )}
                </div>
                <div className="hq-composer__popsep" />
                <label className="hq-field"><span>Modelo ({PROVIDER_SHORT[provider]})</span>
                  <select className="hq-select" value={draft.options.model ?? ''} onChange={e => setOption('model', e.target.value || null)}>
                    <option value="">Herdar (funcionário / padrão global)</option>
                    {modelOptions.filter(o => o.value).map(o => <option key={o.value!} value={o.value!}>{o.label}</option>)}
                  </select>
                </label>
                <label className="hq-field"><span>Esforço</span>
                  <select className="hq-select" value={draft.options.effort ?? ''} onChange={e => setOption('effort', (e.target.value || null) as EffortLevel | null)} disabled={efforts.length === 0}>
                    <option value="">{efforts.length === 0 ? 'Este modelo não aceita controle de esforço' : 'Herdar'}</option>
                    {efforts.map(l => <option key={l} value={l}>{EFFORT_LABELS[l] ?? l}</option>)}
                  </select>
                </label>
                <label className={`hq-check hq-composer__ultra${ultraBlock ? ' hq-composer__ultra--off' : ''}`} title={ultraBlock ?? undefined}>
                  <input type="checkbox" checked={draft.options.ultracode} disabled={Boolean(ultraBlock) && !draft.options.ultracode} onChange={e => setOption('ultracode', e.target.checked)} />
                  <span><strong>Ultracode</strong> <span className="hq-dim">(Claude Code)</span><br />
                    <span className="hq-dim">Divide tarefas grandes entre muitos subagentes. Não é nível de esforço: o esforço acima continua valendo. Gasta bem mais da assinatura.{ultraBlock ? ` ${ultraBlock}` : ''}</span></span>
                </label>
                <label className="hq-field"><span>Permissões</span>
                  <select className="hq-select" value={draft.options.permissionMode ?? ''} onChange={e => setOption('permissionMode', e.target.value || null)}>
                    <option value="">Herdar</option>
                    {PERMISSION_MODE_OPTIONS.map(m => <option key={m} value={m}>{PERMISSION_MODE_LABELS[m]}</option>)}
                  </select>
                </label>
                <div className="hq-composer__popfoot">
                  <span className="hq-dim">Em vigor: {optionsSummary({ options: draft.options, employee, settings, status })}</span>
                  {optionsCustom && <button type="button" className="hq-linkbtn" onClick={() => update({ options: { ...EMPTY_OPTIONS } })}>Limpar</button>}
                </div>
                <div className="hq-actions hq-composer__popactions">
                  <button type="button" className="hq-btn hq-btn--sm" disabled={!canSubmit} onClick={() => { setOptionsOpen(false); void submit(true); }} title="Pede um plano antes: a conversa entra em modo plano e nada é alterado">{submitting === 'plan' ? 'Enviando…' : 'Planejar antes'}</button>
                  <button type="button" className="hq-btn hq-btn--sm" onClick={() => setOptionsOpen(false)}>Pronto</button>
                </div>
              </div>
            )}
          </div>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--primary hq-composer__run" disabled={vref.active ? !connected || Boolean(submitting) : !canSubmit} onClick={() => void submit(false)} title={vref.active ? 'Referência de vídeo: a equipe inspeciona, analisa e discute; se o texto pede um vídeo, produz. Ctrl+Enter' : 'Cria a tarefa e executa (ou enfileira, se o funcionário estiver ocupado). Ctrl+Enter'}>
            {submitting === 'run' ? <><IconBolt size={13} /> Enviando…</> : <><IconSend size={13} /> {vref.active ? (vref.produce ? 'Analisar e produzir' : 'Analisar com a equipe') : 'Executar'}</>}
          </button>
        </div>
      </div>

      {props.videoRef && (
        <VideoRefComposer text={draft.text} file={refFile} api={props.videoRef} onPickFile={f => { setRefFile(f); setRefNote(null); }} onClearFile={() => setRefFile(null)}
          onDone={msg => { setRefNote(msg); setRefFile(null); update({ text: '' }); }} control={vrefCtl}
          onPlainTask={canSubmit && !refFile ? () => void submit(false, true) : null} plainLabel={employee ? `mandar como conversa comum para ${employee.name}` : null} />
      )}
      {refNote && <p className="hq-hub-ok hq-vref__done" role="status">{refNote}</p>}
      <div className="hq-composer__row hq-composer__row--info" id="hq-composer-help">
        {suggested && !draft.employeeId && (
          <button type="button" className="hq-composer__suggest" onClick={() => update({ employeeId: suggested.id })} title={`Sugestão: ${suggested.name}, porque ${suggestion!.reason}. Clique para aceitar; nada é escolhido sozinho.`}>
            <span className="hq-tag hq-tag--xs">Sugestão</span> <strong className="hq-composer__suggestname">{suggested.name}</strong> <span className="hq-dim hq-composer__suggestwhy">· {suggestion!.reason}</span>
          </button>
        )}
        {chosenAvailability && !chosenAvailability.ok && chosenSkill && <span className="hq-composer__bad">A skill /{chosenSkill.invocation} não dá para usar com {PROVIDER_SHORT[provider]}: {chosenAvailability.reason}</span>}
        {skillUnknown && <span className="hq-composer__bad">A skill /{draft.skill} não está no catálogo desta máquina{project ? ` para ${project.name}` : ''}. Escolha "Automática" ou outra skill.</span>}
        {!connected && <span className="hq-composer__bad">Sem conexão com o serviço da HQ: o pedido fica guardado aqui até reconectar.</span>}
        {connected && providerBlocked && <span className="hq-composer__bad">{providerBlocked} <button type="button" className="hq-linkbtn" onClick={props.onOpenConnections}>Abrir Conexões</button></span>}
        {connected && !providerBlocked && !vref.active && (attempted || draft.text.trim()) && missing.length > 0 && <span className="hq-composer__missing">Falta: {missing.join(' · ')}{!managerMode && missing.some(m => m.includes('projeto')) ? ' (o projeto fica em Opções)' : ''}.</span>}
        {managerMode && draft.text.trim() && !vref.active && (
          <span className="hq-composer__reading" title="Leitura do pedido feita pela HQ (sem IA). Para escolher quem executa, modelo ou skill, troque o executor ou abra Opções.">
            <strong>{REQUEST_INTENT_LABEL[reading.intent]}</strong> · Marca: {reading.summary.marca} · Entrega: {reading.summary.entrega}{reading.remember ? ' · a orientação fica registrada (com Desfazer)' : ''}
          </span>
        )}
        {managerMsg && <span className="hq-composer__ok" role="status">{managerMsg}</span>}
        {destOutside && <span className="hq-composer__missing">A conta de destino escolhida antes não é deste perfil: escolha outra em Opções (ou siga sem destino).</span>}
        {error && <span className="hq-composer__bad" role="alert">{error}</span>}
      </div>

      {outcome && (
        <div className={`hq-composer__result${outcome.result.duplicate ? ' hq-composer__result--dup' : ''}`} role="status">
          <div className="hq-composer__resulthead">
            <strong>{outcome.result.duplicate ? 'Esse pedido já existia' : 'Tarefa criada'}</strong>
            <span className={`hq-tag hq-tag--xs${outcomeTask ? (outcomeTask.status === 'running' ? ' hq-tag--info' : outcomeTask.status === 'done' ? ' hq-tag--ok' : outcomeTask.status === 'error' || outcomeTask.status === 'lost' ? ' hq-tag--danger' : '') : ''}`}>
              {outcomeTask ? taskStateLabel(outcomeTask) : outcome.result.status}
            </span>
            <button type="button" className="hq-iconbtn hq-composer__dismiss" onClick={() => setOutcome(null)} aria-label="Fechar"><IconX size={12} /></button>
          </div>
          <div className="hq-composer__resultbody hq-dim">
            Responsável: <strong>{outcomeEmployee?.name ?? '—'}</strong>{outcomeEmployee && <> ({PROVIDER_SHORT[outcomeEmployee.provider ?? 'claude']})</>} · Projeto: <strong>{outcomeProject?.name ?? '—'}</strong>
            {outcome.result.newSession ? ' · conversa nova aberta' : outcomeSession ? ` · na conversa "${outcomeSession.name}"` : ''}
            {outcome.result.duplicate && <> · mesma identificação de um pedido anterior: nada novo foi criado.</>}
            {outcome.result.queuePosition != null && <> · na fila (posição {outcome.result.queuePosition}){outcome.result.queueReason ? `: ${outcome.result.queueReason}` : ''}</>}
            {outcome.result.queuePosition == null && outcome.result.queueReason && <> · {outcome.result.queueReason}</>}
            {outcomeTask?.heldReason && <> · {outcomeTask.heldReason}</>}
          </div>
          {outcome.result.notes.length > 0 && <ul className="hq-composer__notes">{outcome.result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <div className="hq-composer__resultfoot">
            <span className="hq-composer__applied" title={`Origem: ${outcome.result.applied.source}. Só é "confirmado" o que o Claude Code informa ao iniciar.`}>
              {taskConfigLines(outcomeTask ?? { status: 'queued', provider, applied: outcome.result.applied, requested: null, evidence: null }).map(l => (
                <span key={l.item} className={`hq-cfgline hq-cfgline--${l.state === 'confirmado' ? 'ok' : l.state === 'padrão' ? 'dim' : 'warn'}`} title={l.detail}>
                  {l.item}: <strong>{l.value}</strong> <em>({l.state})</em>
                </span>
              ))}
              {outcomeTask?.contextFiles && outcomeTask.contextFiles.length > 0 && <span className="hq-cfgline hq-cfgline--dim">Contexto: <strong>{outcomeTask.contextFiles.length} arquivo(s)</strong></span>}
            </span>
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => props.onOpenConversation(outcome.result.sessionId, outcome.result.employeeId)}>Acompanhar</button>
          </div>
        </div>
      )}
      {projectRoot && props.fsList && (
        <FilePickerDialog
          open={pickingContext}
          title={`Arquivos de contexto · ${projectRoot.name}`}
          fsRoots={async () => [projectRoot]}
          fsList={props.fsList}
          onCancel={() => setPickingContext(false)}
          onPick={files => {
            setPickingContext(false);
            const rel = files.filter(x => x.rootId === projectRoot.id).map(x => x.relPath);
            update({ contextFiles: [...new Set([...draft.contextFiles, ...rel])].slice(0, 20) });
          }}
        />
      )}
    </section>
  );
}
