// Diálogo de funcionário: contratar, editar e transferir de sala. A identidade (nome, função, aparência, instruções,
// provedor, skills preferidas, vínculo com agente nativo) é persistente no servidor; abrir uma conversa é outra ação
// (o diálogo não inicia processo nenhum nem verifica login: só mostra o estado real do provedor que já foi apurado).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentDefinition, AiProviderId, AiProviderStatus, Employee, EmployeeAccess, EmployeeAgentRef, EffortLevel, PermissionModeOption, RoleTemplate, Room, SkillInfo } from '@milweb-hq/protocol';
import { EFFORT_ORDER, isEffortLevel } from '@milweb-hq/protocol';
import { Field, Modal } from '../panel/dialogs/Modal';
import { modelOptionsFromCatalog, PERMISSION_MODE_LABELS, PERMISSION_MODE_OPTIONS, ROOM_KIND_ROLES, truncate } from '../panel/helpers';
import { effortLabel, effortsForModel, findModel, formatCatalogAt, isEffortUnavailable } from '../settings/helpers';
import { AGENT_SOURCE_LABELS, agentToProfile, applyTemplate, filterSkillOptions, missingSkillsText, PROVIDER_OPTIONS, providerReadiness, skillAvailability } from './employeeHelpers';
import '../styles/employee.css';

export interface EmployeeInput {
  roomId: string;
  name: string;
  role: string;
  appearance: Employee['appearance'];
  instructions: string;
  profileId: string | null;
  model: string | null;
  /** Esforço (--effort) das conversas novas; null = usar padrão global/do modelo. */
  effort: EffortLevel | null;
  permissionMode: PermissionModeOption;
  /** Provedor que executa as conversas: Claude (Claude Code) ou OpenAI (Codex). */
  provider: AiProviderId;
  /** Skills preferidas (invocações do catálogo); sugeridas na hora de dar a tarefa, nenhuma é ativada sozinha. */
  skills: string[];
  /** Vínculo com a definição nativa de agente importada (null = perfil criado na HQ). */
  agent: EmployeeAgentRef | null;
  /** Modelo de papel usado na contratação (id do RoleTemplate) ou null. */
  template: string | null;
  /** Marco 0: o que o funcionário herda da conta do Chefe (MCP). Integrações ficam bloqueadas para todos. */
  access: EmployeeAccess;
}

export interface EmployeeDialogProps {
  open: boolean;
  /** null = criar; funcionário = editar/transferir. */
  employee: Employee | null;
  rooms: Room[];
  defaultRoomId: string | null;
  defaultModel: string | null;
  defaultPermissionMode: PermissionModeOption;
  /** Nomes já usados (para avisar antes de enviar; o servidor valida de novo). */
  usedNames: string[];
  /** Estado real dos provedores; o campo de modelo usa o catálogo do provedor escolhido (fallback: MODEL_OPTIONS só para o Claude). */
  ai?: AiProviderStatus[];
  /** Modelos de papel (settings.roleTemplates). Vazio = a linha "Modelo de papel" não aparece. */
  templates?: RoleTemplate[];
  /** Catálogo de skills da máquina (pode estar vazio enquanto carrega). */
  skills?: SkillInfo[];
  /** Definições nativas de agente descobertas em .claude/agents e plugins (pode estar vazio). */
  agents?: AgentDefinition[];
  onCreate(input: EmployeeInput): Promise<{ ok: boolean; error?: string }>;
  onSave(id: string, patch: Partial<EmployeeInput>): Promise<{ ok: boolean; error?: string }>;
  onCancel(): void;
}

const SKIN = ['Clara', 'Morena clara', 'Morena', 'Escura'];
const HAIR = ['Preto', 'Castanho', 'Loiro', 'Ruivo'];
const SHIRT = ['Âmbar', 'Azul', 'Verde', 'Vinho'];

// Padrões estáveis para as props opcionais (um `[]` novo a cada render invalidaria os useMemo).
const NO_TEMPLATES: RoleTemplate[] = [];
const NO_SKILLS: SkillInfo[] = [];
const NO_AGENTS: AgentDefinition[] = [];
const DEFAULT_ONLY_MODEL: { value: string | null; label: string }[] = [{ value: null, label: 'Padrão do provedor' }];

function randomAppearance(): Employee['appearance'] {
  const r = () => Math.floor(Math.random() * 4);
  return { skin: r(), hair: r(), shirt: r() };
}

export function EmployeeDialog(props: EmployeeDialogProps) {
  const { open, employee, rooms, defaultRoomId, defaultModel, defaultPermissionMode, usedNames, templates = NO_TEMPLATES, skills: skillCatalog = NO_SKILLS, agents = NO_AGENTS } = props;
  const editing = Boolean(employee);
  const sortedRooms = useMemo(() => [...rooms].sort((a, b) => a.order - b.order), [rooms]);
  const [roomId, setRoomId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [roleTouched, setRoleTouched] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<EffortLevel | null>(null);
  const [perm, setPerm] = useState<PermissionModeOption>('default');
  const [appearance, setAppearance] = useState<Employee['appearance']>({ skin: 0, hair: 0, shirt: 0 });
  const [provider, setProvider] = useState<AiProviderId>('claude');
  const [skills, setSkills] = useState<string[]>([]);
  const [agent, setAgent] = useState<EmployeeAgentRef | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const [mcp, setMcp] = useState<EmployeeAccess['mcp']>('none');
  // Apoio da interface (não é salvo): busca do seletor de skills, avisos do último modelo/agente aplicado, troca de provedor.
  const [skillQuery, setSkillQuery] = useState('');
  const [templateMissing, setTemplateMissing] = useState<string[]>([]);
  const [agentMissing, setAgentMissing] = useState<string[]>([]);
  const [agentProblems, setAgentProblems] = useState<string[]>([]);
  const [providerSwitched, setProviderSwitched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Valores de partida lidos só na abertura (ou ao trocar de funcionário): um snapshot novo ou o avatar entrando em outra sala não reinicia o formulário.
  const initial = useRef({ employee, defaultRoomId, defaultModel, defaultPermissionMode, sortedRooms });
  initial.current = { employee, defaultRoomId, defaultModel, defaultPermissionMode, sortedRooms };
  const employeeId = employee?.id ?? null;
  useEffect(() => {
    if (!open) return;
    const { employee, defaultRoomId, defaultModel, defaultPermissionMode, sortedRooms } = initial.current;
    setError(null); setBusy(false);
    setSkillQuery(''); setTemplateMissing([]); setAgentMissing([]); setAgentProblems([]); setProviderSwitched(false);
    if (employee) {
      setRoomId(employee.roomId); setName(employee.name); setRole(employee.role); setRoleTouched(true);
      setInstructions(employee.instructions); setProfileId(employee.profileId); setModel(employee.model); setEffort(employee.effort ?? null); setPerm(employee.permissionMode); setAppearance(employee.appearance);
      // Registros antigos (anteriores ao protocolo v4) podem não ter os campos novos; os padrões abaixo são os mesmos do servidor.
      setProvider(employee.provider ?? 'claude'); setSkills(employee.skills ?? []); setAgent(employee.agent ?? null); setTemplate(employee.template ?? null);
      setMcp(employee.access?.mcp === 'inherit' ? 'inherit' : 'none');
    } else {
      const rid = defaultRoomId ?? sortedRooms[0]?.id ?? '';
      setRoomId(rid); setName(''); setRole(''); setRoleTouched(false); setInstructions(''); setProfileId(null);
      setModel(defaultModel); setEffort(null); setPerm(defaultPermissionMode); setAppearance(randomAppearance());
      setProvider('claude'); setSkills([]); setAgent(null); setTemplate(null); setMcp('none');
    }
  }, [open, employeeId]);

  const room = sortedRooms.find(r => r.id === roomId) ?? null;
  const suggestedRole = room ? ROOM_KIND_ROLES[room.kind] ?? room.name : '';
  const effectiveRole = roleTouched && role.trim() ? role.trim() : suggestedRole;
  const nameTaken = !editing && name.trim() !== '' && usedNames.some(n => n.toLowerCase() === name.trim().toLowerCase());
  const movingRoom = editing && employee && employee.roomId !== roomId;
  const templateName = template ? templates.find(t => t.id === template)?.name ?? template : null;

  // Provedor escolhido: catálogo de modelos e esforço vêm do status REAL dele. Sem catálogo do Codex não inventamos lista.
  const status = props.ai?.find(p => p.provider === provider) ?? null;
  const providerTool = provider === 'openai' ? 'Codex' : 'Claude Code';
  const hasCatalog = status != null && status.models.length > 0;
  const modelOptions = useMemo(() => (provider === 'openai' && !hasCatalog ? DEFAULT_ONLY_MODEL : modelOptionsFromCatalog(status)), [provider, hasCatalog, status]);
  const readiness = providerReadiness(provider, props.ai);
  // Esforço: só o que o catálogo do provedor confirma para o modelo escolhido. Sem catálogo (ou modelo fora dele), não dá para verificar.
  const modelInCatalog = status != null && (model == null || findModel(status, model) != null);
  const catalogModel = findModel(status, model);
  const efforts = modelInCatalog ? effortsForModel(status, model) : [];
  const noEffortForModel = catalogModel != null && catalogModel.efforts.length === 0;
  const effortUnavailable = isEffortUnavailable(status, model, effort);
  // Sem catálogo, a lista completa aparece com o aviso de que os níveis não foram verificados (o CLI pode recusar).
  const effortOptions: EffortLevel[] = modelInCatalog ? efforts : EFFORT_ORDER;
  const modelHint = providerSwitched ? 'modelo e esforço voltaram ao padrão: o catálogo de cada provedor é diferente.'
    : !status ? `catálogo do ${providerTool} não carregado; ${provider === 'openai' ? 'só o padrão do provedor.' : 'lista fixa, não verificada.'}`
      : !hasCatalog ? `o ${providerTool} não informou modelos; só o padrão do provedor.`
        : catalogModel?.note ?? undefined;

  const skillOptions = useMemo(() => filterSkillOptions(skillCatalog, skillQuery, provider), [skillCatalog, skillQuery, provider]);

  useEffect(() => { if (room && profileId && !room.profiles.some(p => p.id === profileId)) setProfileId(null); }, [room, profileId]);

  const changeProvider = (next: AiProviderId) => {
    if (next === provider) return;
    setProvider(next); setModel(null); setEffort(null); setProviderSwitched(true);
  };

  const toggleSkill = (invocation: string) => setSkills(s => (s.includes(invocation) ? s.filter(x => x !== invocation) : [...s, invocation]));

  const pickTemplate = (t: RoleTemplate) => {
    const r = applyTemplate(t, sortedRooms, skillCatalog);
    if (r.roomId) setRoomId(r.roomId);
    setRole(r.role); setRoleTouched(r.role !== '');
    setInstructions(r.instructions);
    setSkills(r.skills); setTemplateMissing(r.missingSkills);
    if (r.permissionMode) setPerm(r.permissionMode);
    setTemplate(t.id);
  };
  const clearTemplate = () => { setTemplate(null); setTemplateMissing([]); };

  const importAgent = (id: string) => {
    const def = agents.find(a => a.id === id);
    if (!def) return;
    const p = agentToProfile(def, skillCatalog, PERMISSION_MODE_OPTIONS);
    if (!name.trim()) setName(p.name);
    if (p.role) { setRole(p.role); setRoleTouched(true); }
    setInstructions(p.instructions);
    if (p.model) setModel(p.model);
    if (p.effort) setEffort(p.effort);
    if (p.permissionMode) setPerm(p.permissionMode);
    if (p.skills.length) setSkills(s => Array.from(new Set([...s, ...p.skills])));
    setAgentMissing(p.missingSkills); setAgentProblems(def.problems);
    setAgent(p.ref);
  };
  const removeAgentLink = () => { setAgent(null); setAgentMissing([]); setAgentProblems([]); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId || busy || nameTaken || effortUnavailable) return;
    setBusy(true); setError(null);
    try {
      const input: EmployeeInput = {
        roomId, name: name.trim(), role: effectiveRole, appearance, instructions: instructions.trim(), profileId, model, effort, permissionMode: perm,
        provider, skills, agent, template, access: { mcp },
      };
      const r = employee ? await props.onSave(employee.id, input) : await props.onCreate(input);
      if (!r.ok) setError(r.error ?? 'Não foi possível salvar o funcionário.');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={employee ? `Editar ${employee.name}` : 'Contratar funcionário'} onCancel={props.onCancel} width={640}>
      <form onSubmit={submit} className="hq-form">
        {!editing && templates.length > 0 && (
          <div className="hq-emp-templates" role="group" aria-label="Modelo de papel">
            <span className="hq-field__label">Modelo de papel</span>
            <div className="hq-emp-templates__chips">
              {templates.map(t => (
                <button key={t.id} type="button" className={`hq-btn hq-btn--sm${template === t.id ? ' hq-btn--on' : ''}`} aria-pressed={template === t.id} onClick={() => pickTemplate(t)}>{t.name}</button>
              ))}
              <button type="button" className={`hq-btn hq-btn--sm${template === null ? ' hq-btn--on' : ''}`} aria-pressed={template === null} onClick={clearTemplate}>Personalizado</button>
            </div>
            <span className="hq-field__hint">
              {templateName ? `Baseado em ${templateName}; todos os campos continuam editáveis.` : 'Um modelo preenche função, sala, instruções, skills e permissão; depois você ajusta o que quiser.'}
            </span>
            {templateMissing.length > 0 && <span className="hq-field__hint hq-emp-missing">{missingSkillsText(templateMissing)}</span>}
          </div>
        )}
        <div className="hq-form__row">
          <Field label="Nome" hint={editing ? undefined : 'Se vazio, a HQ sorteia um nome livre.'}>
            <input className="hq-input" value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Theo" autoFocus maxLength={40} />
          </Field>
          <Field label="Sala" hint={movingRoom ? 'Transferir troca a mesa; a conversa atual continua.' : undefined}>
            <select className="hq-input" value={roomId} onChange={e => setRoomId(e.target.value)} required>
              {sortedRooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
        </div>
        {nameTaken && <div className="hq-notice hq-notice--warn" role="alert">Já existe um funcionário chamado {name.trim()}.</div>}
        <Field label="Função" hint={`Aparece no crachá e no system prompt das conversas novas.${editing && templateName ? ` Baseado em ${templateName}.` : ''}`}>
          <input className="hq-input" value={roleTouched ? role : suggestedRole} onChange={e => { setRole(e.target.value); setRoleTouched(true); }} placeholder={suggestedRole} maxLength={60} />
        </Field>
        <Field label="Provedor" hint="Funcionário OpenAI roda em modo análise do Codex (lê e responde, sem alterar arquivos nem rodar comandos).">
          <select className="hq-input" value={provider} onChange={e => changeProvider(e.target.value as AiProviderId)}>
            {PROVIDER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <span className={`hq-emp-ready hq-emp-ready--${readiness.tone}`} role="status">{readiness.text}</span>
        </Field>
        <Field label="Importar agente nativo" hint="Definições de .claude/agents (usuário, projeto, plugins). Importar copia nome, função, prompt, modelo, permissão e skills para este perfil; o arquivo continua sendo a fonte.">
          <select className="hq-input" value="" onChange={e => importAgent(e.target.value)} disabled={agents.length === 0}>
            <option value="">{agents.length === 0 ? 'Nenhuma definição de agente encontrada nesta máquina' : agent ? 'Importar outra definição…' : 'Escolher uma definição…'}</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>
                {a.name} · {AGENT_SOURCE_LABELS[a.source]}{a.plugin ? ` · ${a.plugin}` : ''}{a.problems.length > 0 ? ' · com problemas' : ''}
              </option>
            ))}
          </select>
        </Field>
        {agent && (
          <div className="hq-emp-agent" role="region" aria-label={`Vínculo com o agente ${agent.name}`}>
            <div className="hq-emp-agent__head">
              <strong>Vínculo: {agent.name}</strong>
              <span className="hq-tag hq-tag--xs">{AGENT_SOURCE_LABELS[agent.source]}</span>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={removeAgentLink}>Remover vínculo</button>
            </div>
            <div className="hq-emp-agent__path">{agent.path}</div>
            <div>Ferramentas restritas: {agent.tools ? agent.tools.join(', ') : 'sem restrição'}</div>
            <div className="hq-dim">Importado em {formatCatalogAt(agent.importedAt)}. Remover o vínculo mantém o texto já preenchido.</div>
            {agent.unsupported.length > 0 && (
              <div>
                <div className="hq-emp-agent__sub">O que a HQ não consegue aplicar</div>
                <ul>{agent.unsupported.map(u => <li key={u.field}><code>{u.field}</code>: {u.reason}</li>)}</ul>
              </div>
            )}
          </div>
        )}
        {agentMissing.length > 0 && <div className="hq-notice hq-notice--warn">Skills citadas pelo agente: {missingSkillsText(agentMissing)}</div>}
        {agentProblems.length > 0 && (
          <div className="hq-notice hq-notice--warn" role="alert">
            <div>Problemas na definição importada:<ul>{agentProblems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>
          </div>
        )}
        <Field label="Instruções de atuação" hint="Entram no início de cada conversa NOVA deste funcionário (o Claude Code não aceita mudar numa conversa já aberta).">
          <textarea className="hq-input hq-textarea" value={instructions} onChange={e => setInstructions(e.target.value)} rows={4} placeholder="Ex.: Você cuida do frontend. Prefira CSS puro; pergunte antes de instalar dependências." />
        </Field>
        <div className="hq-form__row">
          <Field label="Modelo padrão" hint={modelHint}>
            <select className="hq-input" value={model ?? ''} onChange={e => { setModel(e.target.value || null); setProviderSwitched(false); }}>
              {modelOptions.map(o => <option key={o.value ?? 'default'} value={o.value ?? ''}>{o.label}</option>)}
              {model && !modelOptions.some(o => o.value === model) && <option value={model}>{model} · {status ? 'fora do catálogo atual' : 'não verificado'}</option>}
            </select>
          </Field>
          <Field label="Esforço" hint={
            noEffortForModel ? 'este modelo não aceita controle de esforço no CLI'
              : effortUnavailable ? 'escolha outro nível (ou o padrão) para poder salvar.'
                : !modelInCatalog ? 'níveis não verificados (sem catálogo ou modelo fora dele).'
                  : 'null = usar padrão global/do modelo. Vale só em conversas novas.'
          }>
            <select className="hq-input" value={effortUnavailable ? '__unavailable__' : effort ?? ''} disabled={noEffortForModel && !effortUnavailable}
              data-invalid={effortUnavailable ? 'true' : undefined} aria-invalid={effortUnavailable || undefined}
              onChange={e => { if (e.target.value !== '__unavailable__') setEffort(isEffortLevel(e.target.value) ? e.target.value : null); }}>
              {effortUnavailable && <option value="__unavailable__">{effortLabel(effort)} (indisponível para este modelo)</option>}
              <option value="">Usar padrão global/do modelo</option>
              {effortOptions.map(l => <option key={l} value={l}>{effortLabel(l)}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Modo de permissão padrão">
          <select className="hq-input" value={perm} onChange={e => setPerm(e.target.value as PermissionModeOption)}>
            {PERMISSION_MODE_OPTIONS.map(m => <option key={m} value={m}>{PERMISSION_MODE_LABELS[m]}</option>)}
          </select>
        </Field>
        <fieldset className="hq-fieldset hq-emp-skills">
          <legend>Skills preferidas</legend>
          <p className="hq-field__hint hq-emp-skills__hint">Skill é um manual de trabalho. As preferidas aparecem como sugestão na hora de dar a tarefa; nenhuma é ativada sozinha.</p>
          {skills.length > 0 && (
            <div className="hq-emp-chips" aria-label="Skills selecionadas">
              {skills.map(inv => {
                const info = skillCatalog.find(s => s.invocation === inv) ?? null;
                const av = info ? skillAvailability(info, provider) : { available: false, mode: 'unavailable' as const, detail: 'não está no catálogo desta máquina' };
                return (
                  <span key={inv} className="hq-chip hq-emp-chip" title={av.available ? undefined : av.detail}>
                    {inv}
                    {!av.available && <span className="hq-tag hq-tag--xs">indisponível</span>}
                    <button type="button" className="hq-emp-chip__x" onClick={() => toggleSkill(inv)} aria-label={`Remover ${inv}`}>×</button>
                  </span>
                );
              })}
            </div>
          )}
          <input className="hq-input" value={skillQuery} onChange={e => setSkillQuery(e.target.value)} placeholder="Buscar por invocação, nome ou descrição" aria-label="Buscar skill" disabled={skillCatalog.length === 0} />
          <div className="hq-emp-skilllist">
            {skillCatalog.length === 0 ? <div className="hq-emp-empty">Catálogo de skills ainda não carregado nesta sessão.</div>
              : skillOptions.length === 0 ? <div className="hq-emp-empty">Nenhuma skill corresponde a “{skillQuery.trim()}”.</div>
                : skillOptions.map(o => {
                  const checked = skills.includes(o.skill.invocation);
                  return (
                    <label key={o.skill.id} className="hq-check hq-emp-skill" data-unavailable={o.available ? undefined : 'true'} title={o.available ? undefined : o.detail}>
                      <input type="checkbox" checked={checked} disabled={!o.available && !checked} onChange={() => toggleSkill(o.skill.invocation)} />
                      <span className="hq-emp-skill__main">
                        <span className="hq-emp-skill__name">{o.skill.invocation}{o.skill.name && o.skill.name !== o.skill.invocation ? <span className="hq-dim"> · {o.skill.name}</span> : null}</span>
                        {o.skill.description && <span className="hq-emp-skill__desc">{truncate(o.skill.description, 110)}</span>}
                      </span>
                      {!o.available ? <span className="hq-tag hq-tag--xs">indisponível</span>
                        : o.mode === 'inject' ? <span className="hq-tag hq-tag--xs hq-tag--info" title={o.detail}>por texto</span> : null}
                    </label>
                  );
                })}
          </div>
        </fieldset>
        <fieldset className="hq-fieldset hq-emp-access">
          <legend>Acessos</legend>
          <p className="hq-field__hint">O que este funcionário herda da sua conta. Vale para o terminal e para os servidores MCP; muda a partir do próximo turno.</p>
          <label className="hq-check"><input type="radio" name="hq-emp-mcp" checked={mcp === 'none'} onChange={() => setMcp('none')} /> <span><strong>Sem servidores MCP</strong> <span className="hq-dim">(recomendado)</span></span></label>
          <label className="hq-check"><input type="radio" name="hq-emp-mcp" checked={mcp === 'inherit'} onChange={() => setMcp('inherit')} /> <span><strong>Herdar todos os MCPs da sua conta</strong> <span className="hq-dim">(conectores do claude.ai, plugins e MCPs locais; só se a tarefa precisar)</span></span></label>
          <ul className="hq-emp-access__fixed">
            <li><strong>GitHub, git push e Vercel:</strong> bloqueados para todos os funcionários (sem credenciais no ambiente e com regra de negação no Claude Code). A liberação controlada chega com a Central de Conexões.</li>
            <li><strong>Terminal:</strong> comandos locais na pasta do projeto, com as permissões de sempre.</li>
          </ul>
        </fieldset>
        {room && room.profiles.length > 0 && (
          <Field label="Equipe" hint="A equipe dá o assento na mesa dela e o contexto das tarefas. Trocar não apaga conversas nem histórico. Sem equipe: especialista que atende as duas (coordenação, pesquisa, revisão, direção de vídeo) ou alguém ainda sem equipe.">
            <select className="hq-input" value={profileId ?? ''} onChange={e => setProfileId(e.target.value || null)}>
              <option value="">Sem equipe (apoio às duas ou a atribuir)</option>
              {room.profiles.map(p => <option key={p.id} value={p.id}>{p.id === 'aurora' ? 'Equipe Aurora (Instagram + Threads)' : p.id === 'tuco-dev' ? 'Equipe Tuco Dev (Instagram)' : p.name}</option>)}
            </select>
          </Field>
        )}
        <fieldset className="hq-fieldset">
          <legend>Aparência</legend>
          <div className="hq-form__row hq-form__row--3">
            <Field label="Pele"><select className="hq-input" value={appearance.skin} onChange={e => setAppearance(a => ({ ...a, skin: Number(e.target.value) }))}>{SKIN.map((l, i) => <option key={i} value={i}>{l}</option>)}</select></Field>
            <Field label="Cabelo"><select className="hq-input" value={appearance.hair} onChange={e => setAppearance(a => ({ ...a, hair: Number(e.target.value) }))}>{HAIR.map((l, i) => <option key={i} value={i}>{l}</option>)}</select></Field>
            <Field label="Camisa"><select className="hq-input" value={appearance.shirt} onChange={e => setAppearance(a => ({ ...a, shirt: Number(e.target.value) }))}>{SHIRT.map((l, i) => <option key={i} value={i}>{l}</option>)}</select></Field>
          </div>
          <button type="button" className="hq-linkbtn" onClick={() => setAppearance(randomAppearance())}>Sortear aparência</button>
        </fieldset>
        {error && <div className="hq-notice hq-notice--error" role="alert">{error}</div>}
        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn hq-btn--ghost" onClick={props.onCancel}>Cancelar</button>
          <button type="submit" className="hq-btn hq-btn--primary" disabled={busy || !roomId || nameTaken || effortUnavailable}>{busy ? 'Salvando…' : employee ? 'Salvar' : 'Contratar'}</button>
        </div>
      </form>
    </Modal>
  );
}
