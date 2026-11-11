// Skills: catálogo das skills do Claude Code descobertas pelo servidor (pessoais, do projeto, de plugin, sincronizadas,
// embutidas). Mostra só o que a varredura e o último init confirmaram: "verificada" só quando apareceu na lista do
// Claude Code; nada aqui executa skill nem copia arquivo (isso é do diálogo "Adicionar skill local", via servidor).
import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { AiProviderId, Project, SkillCatalog, SkillFileContent, SkillInfo, SkillSource } from '@milweb-hq/protocol';
import { EFFORT_LABELS } from '@milweb-hq/protocol';
import { basename } from '../panel/helpers';
import { IconChevron, IconExternal, IconFolder, IconPlus, IconRefresh } from '../panel/icons';
import { formatCatalogAt } from '../settings/helpers';
import {
  SKILL_PROVIDER_LABELS, SKILL_PROVIDER_ORDER, SOURCE_LABELS, SOURCE_ORDER, dirname, filterSkills, providerSupportLabel,
  skillAvailabilitySummary, skillExampleRequest, skillSummary, skillUseBlockReason, sortSkills,
} from './skillsHelpers';
import type { SkillAvailabilityFilter, SkillProviderFilter, SkillTone } from './skillsHelpers';
import '../styles/skills.css';

export interface SkillsViewProps {
  /** Catálogo do projeto selecionado; null = ainda não carregado. */
  catalog: SkillCatalog | null;
  loading: boolean;
  error: string | null;
  projects: Project[];
  /** O catálogo é por projeto; null = geral (sem projeto). */
  projectId: string | null;
  onProjectChange(id: string | null): void;
  /** Força nova varredura no servidor. */
  onRefresh(): void;
  /** Ids de skills favoritas (ordem da lista: favoritas primeiro). */
  favorites: string[];
  onToggleFavorite(id: string): void;
  /** "Usar esta skill": o App pré-preenche o compositor de tarefa. */
  onUseSkill(skill: SkillInfo): void;
  /** SKILL.md bruto para o painel técnico (carregado sob demanda, ao clicar em "Ver conteúdo"). */
  onReadSkill(path: string): Promise<SkillFileContent>;
  /** Abre o diálogo "Adicionar skill local" (o App é dono do estado do diálogo). */
  onAddLocal(): void;
  onOpenExternal(target: 'folder' | 'file', value: string): void;
}

type DocState = { state: 'loading' } | { state: 'ok'; content: string } | { state: 'error'; error: string };

const TONE_TAG: Record<SkillTone, string> = { ok: 'hq-tag--ok', warn: 'hq-tag--warn', danger: 'hq-tag--danger', muted: '' };
const OVERRIDE_LABELS: Record<SkillInfo['override'], string> = {
  on: 'on (ativa)', 'name-only': 'name-only (só o nome vai ao contexto)', 'user-invocable-only': 'user-invocable-only (só você invoca)', off: 'off (desativada)',
};

function errorText(err: unknown): string { return err instanceof Error ? err.message : String(err); }

/** Estrela de favorito (inline, para não mexer em panel/icons.tsx). */
function StarIcon({ filled, size = 14 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

export function SkillsView(props: SkillsViewProps) {
  const { catalog, loading, error, favorites, projectId } = props;
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SkillSource | 'all'>('all');
  const [provider, setProvider] = useState<SkillProviderFilter>('all');
  const [availability, setAvailability] = useState<SkillAvailabilityFilter>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showShadowed, setShowShadowed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const [rootsOpen, setRootsOpen] = useState(false);
  const [docs, setDocs] = useState<Record<string, DocState>>({});

  const realProjects = useMemo(() => props.projects.filter(p => !p.id.startsWith('ext:')).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [props.projects]);
  const projectById = useMemo(() => new Map(realProjects.map(p => [p.id, p])), [realProjects]);
  const skills = catalog?.skills ?? [];

  const visible = useMemo(
    () => sortSkills(filterSkills(skills, { query, source, provider, availability, favoritesOnly, favorites, projectId, includeShadowed: showShadowed }), favorites),
    [skills, query, source, provider, availability, favoritesOnly, favorites, projectId, showShadowed],
  );
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  // Seleção derivada: a skill clicada se ainda estiver visível; senão a primeira da lista; senão nada.
  const selected = useMemo(() => visible.find(s => s.id === selectedId) ?? visible[0] ?? null, [visible, selectedId]);

  const readDoc = async (path: string) => {
    setDocs(d => ({ ...d, [path]: { state: 'loading' } }));
    try {
      const file = await props.onReadSkill(path);
      setDocs(d => ({ ...d, [path]: { state: 'ok', content: file.content } }));
    } catch (err) {
      setDocs(d => ({ ...d, [path]: { state: 'error', error: errorText(err) } }));
    }
  };

  /** Setas para cima/baixo andam pela lista; Enter/Espaço selecionam (comportamento nativo do botão). */
  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.hq-skills-item'));
    const i = items.findIndex(el => el === document.activeElement);
    if (i < 0) return;
    const next = items[e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0)];
    if (next) { next.focus(); e.preventDefault(); }
  };

  const total = skills.length;
  const shadowedCount = skills.filter(s => s.shadowedBy != null).length;
  const warnings = catalog?.warnings ?? [];

  return (
    <section className="hq-view hq-skills" aria-label="Skills">
      <header className="hq-view__head">
        <h2>Skills</h2>
        {catalog && (
          <span className="hq-dim">
            {visible.length === total ? `${total} skill${total === 1 ? '' : 's'}` : `${visible.length} de ${total} skills`}
            {shadowedCount > 0 && !showShadowed ? ` · ${shadowedCount} sombreada${shadowedCount === 1 ? '' : 's'} oculta${shadowedCount === 1 ? '' : 's'}` : ''}
            {' · varredura: '}{formatCatalogAt(catalog.scannedAt)}
          </span>
        )}
        {loading && <span className="hq-dim">atualizando…</span>}
        <span className="hq-view__spacer" />
        <select className="hq-input hq-input--sm" value={projectId ?? ''} onChange={e => props.onProjectChange(e.target.value || null)} aria-label="Projeto do catálogo" title="As skills de projeto dependem da pasta escolhida">
          <option value="">Geral (sem projeto)</option>
          {realProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button type="button" className="hq-btn hq-btn--sm" onClick={props.onRefresh} disabled={loading} title="Varre as pastas de novo"><IconRefresh size={12} /> Atualizar</button>
        <button type="button" className="hq-btn hq-btn--primary hq-btn--sm" onClick={props.onAddLocal}><IconPlus size={12} /> Adicionar skill local</button>
      </header>

      <p className="hq-view__note hq-skills__intro">Skill é um manual de trabalho que o funcionário segue. Escolha uma aqui ou deixe em Automática na tarefa.</p>

      <div className="hq-skills-bar" role="search">
        <input className="hq-input hq-input--sm hq-skills-bar__search" type="search" placeholder="Buscar skill…" title="Procura no nome, na descrição e em quando usar" value={query} onChange={e => setQuery(e.target.value)} aria-label="Buscar skill pelo nome, descrição ou quando usar" />
        <select className="hq-input hq-input--sm" value={source} onChange={e => setSource(e.target.value as SkillSource | 'all')} aria-label="Origem">
          <option value="all">Origem: todas</option>
          {SOURCE_ORDER.map(s => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
        </select>
        <select className="hq-input hq-input--sm" value={provider} onChange={e => setProvider(e.target.value as SkillProviderFilter)} aria-label="Provedor">
          <option value="all">Provedor: todos</option>
          <option value="claude">Claude</option>
          <option value="openai">OpenAI</option>
        </select>
        <select className="hq-input hq-input--sm" value={availability} onChange={e => setAvailability(e.target.value as SkillAvailabilityFilter)} aria-label="Disponibilidade">
          <option value="all">Disponibilidade: todas</option>
          <option value="available">Disponíveis</option>
          <option value="unavailable">Indisponíveis</option>
        </select>
        <span className="hq-skills-bar__sep" aria-hidden="true" />
        <label className="hq-check"><input type="checkbox" checked={favoritesOnly} onChange={e => setFavoritesOnly(e.target.checked)} /> Só favoritas</label>
        <label className="hq-check" title="Sombreada = outra skill com o mesmo nome tem prioridade; o Claude Code carrega a outra"><input type="checkbox" checked={showShadowed} onChange={e => setShowShadowed(e.target.checked)} /> Mostrar sombreadas</label>
      </div>

      {error && (
        <div className="hq-notice hq-notice--error" role="alert">
          <span>Não foi possível ler as skills: {error}</span>
          <span className="hq-view__spacer" />
          <button type="button" className="hq-btn hq-btn--sm" onClick={props.onRefresh} disabled={loading}><IconRefresh size={12} /> Atualizar</button>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="hq-skills-fold">
          <button type="button" className="hq-skills-fold__head" onClick={() => setWarningsOpen(o => !o)} aria-expanded={warningsOpen}>
            <IconChevron size={12} open={warningsOpen} /> Avisos da varredura <span className="hq-dim">({warnings.length})</span>
          </button>
          {warningsOpen && (
            <div className="hq-skills-fold__body">
              {warnings.map((w, i) => <div key={i} className="hq-notice hq-notice--warn">{w}</div>)}
            </div>
          )}
        </div>
      )}

      {!catalog ? (
        <div className="hq-empty hq-empty--tall">
          {loading ? <p>Lendo as skills instaladas…</p> : (
            <>
              <p>Catálogo ainda não carregado.</p>
              {!error && <button type="button" className="hq-btn" onClick={props.onRefresh}><IconRefresh size={12} /> Atualizar</button>}
            </>
          )}
        </div>
      ) : total === 0 ? (
        <div className="hq-empty hq-empty--tall">
          <p>Nenhuma skill encontrada nas pastas varridas.</p>
          <p className="hq-dim">Adicione uma pasta com SKILL.md ou confira as raízes em "Detalhes técnicos da varredura".</p>
          <button type="button" className="hq-btn hq-btn--primary" onClick={props.onAddLocal}><IconPlus size={12} /> Adicionar skill local</button>
        </div>
      ) : (
        <div className="hq-skills-body">
          <ul className="hq-skills-list" aria-label="Lista de skills" onKeyDown={onListKeyDown}>
            {visible.length === 0 ? (
              <li className="hq-empty">Nenhuma skill combina com os filtros.</li>
            ) : visible.map(s => {
              const fav = favSet.has(s.id);
              const avail = skillAvailabilitySummary(s);
              const sel = selected?.id === s.id;
              return (
                <li key={s.id} className="hq-skills-row">
                  <button
                    type="button"
                    className={['hq-skills-item', sel && 'hq-skills-item--sel', (s.disabled || s.shadowedBy) && 'hq-skills-item--off'].filter(Boolean).join(' ')}
                    onClick={() => setSelectedId(s.id)} aria-pressed={sel} aria-label={`${s.name}: ${avail.text}`}
                  >
                    <span className="hq-skills-item__top">
                      <span className="hq-skills-item__name">{s.name}</span>
                      <span className="hq-skills-item__inv">/{s.invocation}</span>
                    </span>
                    {s.description && <p className="hq-skills-item__desc">{skillSummary(s, 140)}</p>}
                    <span className="hq-skills-item__tags">
                      <span className="hq-tag hq-tag--xs">{SOURCE_LABELS[s.source]}</span>
                      {s.kind === 'command' && <span className="hq-tag hq-tag--xs hq-tag--info">comando</span>}
                      {SKILL_PROVIDER_ORDER.map(p => <ProviderTag key={p} provider={p} skill={s} />)}
                      <span className={`hq-tag hq-tag--xs ${TONE_TAG[avail.tone]}`}>{avail.text}</span>
                    </span>
                  </button>
                  <button
                    type="button" className="hq-iconbtn hq-iconbtn--xs hq-skills-star" onClick={() => props.onToggleFavorite(s.id)} aria-pressed={fav}
                    aria-label={fav ? `Remover ${s.name} dos favoritos` : `Favoritar ${s.name}`} title={fav ? 'Remover dos favoritos' : 'Favoritar'}
                  >
                    <StarIcon filled={fav} />
                  </button>
                </li>
              );
            })}
          </ul>

          {selected ? (
            <SkillDetails
              skill={selected} favorite={favSet.has(selected.id)} doc={selected.path ? docs[selected.path] ?? null : null}
              projectName={selected.projectId ? projectById.get(selected.projectId)?.name ?? null : null}
              onUse={() => props.onUseSkill(selected)} onToggleFavorite={() => props.onToggleFavorite(selected.id)}
              onRead={() => { if (selected.path) void readDoc(selected.path); }} onOpenExternal={props.onOpenExternal}
            />
          ) : (
            <aside className="hq-skills-detail hq-skills-detail--empty"><div className="hq-empty">Selecione uma skill na lista para ver os detalhes.</div></aside>
          )}
        </div>
      )}

      {catalog && (
        <div className="hq-skills-fold">
          <button type="button" className="hq-skills-fold__head" onClick={() => setRootsOpen(o => !o)} aria-expanded={rootsOpen}>
            <IconChevron size={12} open={rootsOpen} /> Detalhes técnicos da varredura <span className="hq-dim">({catalog.roots.length} raiz{catalog.roots.length === 1 ? '' : 'es'})</span>
          </button>
          {rootsOpen && (
            <div className="hq-skills-fold__body">
              <ul className="hq-skills-roots">
                {catalog.roots.map((r, i) => (
                  <li key={`${r.source}:${r.path}:${i}`}>
                    <span className="hq-tag hq-tag--xs">{SOURCE_LABELS[r.source]}</span>
                    <span className="hq-mono">{r.path}</span>
                    {r.projectId && <span className="hq-dim">· {projectById.get(r.projectId)?.name ?? r.projectId}</span>}
                    {!r.exists && <span className="hq-tag hq-tag--xs hq-tag--warn">não existe</span>}
                  </li>
                ))}
                {catalog.roots.length === 0 && <li className="hq-dim">Nenhuma raiz informada pela varredura.</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ProviderTag({ provider, skill }: { provider: AiProviderId; skill: SkillInfo }) {
  const support = skill.providers[provider];
  if (!support) return null;
  const cls = support.mode === 'native' ? 'hq-tag--ok' : support.mode === 'inject' ? 'hq-tag--amber' : '';
  return <span className={`hq-tag hq-tag--xs ${cls}`} title={support.detail}>{SKILL_PROVIDER_LABELS[provider]}: {providerSupportLabel(support)}</span>;
}

interface SkillDetailsProps {
  skill: SkillInfo;
  favorite: boolean;
  doc: DocState | null;
  projectName: string | null;
  onUse(): void;
  onToggleFavorite(): void;
  onRead(): void;
  onOpenExternal(target: 'folder' | 'file', value: string): void;
}

function SkillDetails({ skill, favorite, doc, projectName, onUse, onToggleFavorite, onRead, onOpenExternal }: SkillDetailsProps) {
  const [techOpen, setTechOpen] = useState(false);
  const avail = skillAvailabilitySummary(skill);
  const block = skillUseBlockReason(skill);
  const hasInput = Boolean(skill.argumentHint) || skill.arguments.length > 0;

  return (
    <aside className="hq-skills-detail" aria-label={`Detalhes de ${skill.name}`}>
      <header className="hq-skills-detail__head">
        <h3>{skill.name}</h3>
        <span className="hq-mono hq-skills-detail__inv">/{skill.invocation}</span>
        <div className="hq-skills-detail__tags">
          <span className="hq-tag">{SOURCE_LABELS[skill.source]}</span>
          {skill.kind === 'command' && <span className="hq-tag hq-tag--info">comando</span>}
          {skill.plugin && <span className="hq-tag" title="Plugin de origem">{skill.plugin}</span>}
          {projectName && <span className="hq-tag" title="Projeto da HQ a que a skill pertence">{projectName}</span>}
        </div>
      </header>

      {skill.description ? <p className="hq-skills-detail__desc">{skill.description}</p> : <p className="hq-skills-detail__desc hq-dim">Sem descrição no SKILL.md.</p>}

      <div className="hq-skills-sec">
        <span className="hq-skills-sec__k">Quando usar</span>
        {skill.whenToUse ? <p>{skill.whenToUse}</p> : <p className="hq-dim">Não informado (sem when_to_use no SKILL.md; vale a descrição acima).</p>}
      </div>

      <div className="hq-skills-sec">
        <span className="hq-skills-sec__k">O que ela espera receber</span>
        {hasInput ? (
          <>
            {skill.argumentHint && <p><span className="hq-mono">{skill.argumentHint}</span></p>}
            {skill.arguments.length > 0 && <p className="hq-dim">Argumentos nomeados: {skill.arguments.map(a => <span key={a} className="hq-chip">{a}</span>)}</p>}
          </>
        ) : <p className="hq-dim">nenhuma entrada específica</p>}
      </div>

      <div className="hq-skills-sec">
        <span className="hq-skills-sec__k">Exemplo de pedido</span>
        <code className="hq-skills-example">{skillExampleRequest(skill)}</code>
      </div>

      <div className="hq-skills-sec">
        <span className="hq-skills-sec__k">Disponibilidade</span>
        <div className="hq-skills-avail">
          <div className="hq-skills-avail__line"><span className={`hq-tag ${TONE_TAG[avail.tone]}`}>{avail.text}</span></div>
          {SKILL_PROVIDER_ORDER.map(p => {
            const support = skill.providers[p];
            if (!support) return null;
            return (
              <div key={p} className="hq-skills-avail__line">
                <ProviderTag provider={p} skill={skill} />
                <span className="hq-dim">{support.detail}</span>
              </div>
            );
          })}
          {skill.shadowedBy && <div className="hq-notice hq-notice--warn">Sombreada por <span className="hq-mono">{skill.shadowedBy}</span>: o Claude Code carrega a outra skill com este nome.</div>}
        </div>
      </div>

      {skill.problems.length > 0 && (
        <div className="hq-skills-sec">
          <span className="hq-skills-sec__k">Problemas encontrados no SKILL.md</span>
          {skill.problems.map((p, i) => <div key={i} className="hq-notice hq-notice--warn">{p}</div>)}
        </div>
      )}

      {skill.hasShellInjection && (
        <div className="hq-notice hq-notice--warn" role="note">Esta skill tem comandos de shell embutidos que o Claude Code executa ao ativá-la; a HQ não executou nada ao catalogar.</div>
      )}

      <div className="hq-actions hq-skills-detail__actions">
        <button type="button" className="hq-btn hq-btn--primary" onClick={onUse} disabled={block != null} title={block ?? 'Abre a tarefa com esta skill já escolhida'}>Usar esta skill</button>
        <button type="button" className={`hq-btn ${favorite ? 'hq-btn--on' : ''}`} onClick={onToggleFavorite} aria-pressed={favorite}>
          <StarIcon filled={favorite} size={13} /> {favorite ? 'Favorita' : 'Favoritar'}
        </button>
        {block && <span className="hq-dim" style={{ fontSize: 12 }}>{block}</span>}
      </div>

      <div className="hq-skills-fold">
        <button type="button" className="hq-skills-fold__head" onClick={() => setTechOpen(o => !o)} aria-expanded={techOpen}>
          <IconChevron size={12} open={techOpen} /> Detalhes técnicos
        </button>
        {techOpen && (
          <div className="hq-skills-fold__body">
            <dl className="hq-skills-facts">
              <dt>Origem</dt><dd>{SOURCE_LABELS[skill.source]}{skill.kind === 'command' ? ' · arquivo de comandos/ (formato legado)' : ''}</dd>
              <dt>Caminho</dt>
              <dd>
                {skill.path ? (
                  <div className="hq-skills-path">
                    <span className="hq-mono" title={skill.path}>{skill.path}</span>
                    <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenExternal('folder', dirname(skill.path!))} title={dirname(skill.path)}><IconFolder size={12} /> Abrir pasta</button>
                    <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => onOpenExternal('file', skill.path!)} title={`Abrir ${basename(skill.path)}`}><IconExternal size={12} /> Abrir arquivo</button>
                  </div>
                ) : <span className="hq-dim">sem arquivo local conhecido (embutida no Claude Code)</span>}
              </dd>
              <dt>Plugin</dt><dd>{skill.plugin ? <span className="hq-mono">{skill.plugin}</span> : <span className="hq-dim">—</span>}</dd>
              <dt>skillOverrides</dt><dd><span className="hq-mono">{OVERRIDE_LABELS[skill.override]}</span></dd>
              <dt>Invocação pelo modelo</dt><dd>{skill.modelInvocable ? 'sim' : 'não (disable-model-invocation: true — só você chama)'}</dd>
              <dt>Invocação por você</dt><dd>{skill.userInvocable ? 'sim (aparece no menu /)' : 'não (user-invocable: false — só o Claude usa)'}</dd>
              <dt>Ferramentas permitidas</dt><dd>{skill.allowedTools.length > 0 ? skill.allowedTools.map(t => <span key={t} className="hq-chip">{t}</span>) : <span className="hq-dim">não declaradas (allowed-tools ausente)</span>}</dd>
              <dt>Modelo</dt><dd>{skill.model ? <span className="hq-mono">{skill.model}</span> : <span className="hq-dim">não declarado</span>}</dd>
              <dt>Esforço</dt><dd>{skill.effort ? EFFORT_LABELS[skill.effort] : <span className="hq-dim">não declarado</span>}</dd>
              <dt>Contexto</dt><dd>{skill.forks ? 'subagente (context: fork)' : 'conversa atual'}</dd>
              <dt>Verificação</dt>
              <dd>
                {skill.verified
                  ? <>{skill.verified.listed ? 'listada' : 'não listada'} no init do Claude Code em {formatCatalogAt(skill.verified.at)}</>
                  : <span className="hq-dim">nenhum init neste projeto ainda</span>}
              </dd>
              <dt>Id no catálogo</dt><dd><span className="hq-mono">{skill.id}</span></dd>
            </dl>

            {skill.path && (
              <div className="hq-skills-sec">
                <div className="hq-actions" style={{ marginTop: 0 }}>
                  <button type="button" className="hq-btn hq-btn--sm" onClick={onRead} disabled={doc?.state === 'loading'}>
                    {doc?.state === 'loading' ? 'Lendo…' : doc?.state === 'ok' ? 'Recarregar conteúdo' : 'Ver conteúdo'}
                  </button>
                  <span className="hq-dim" style={{ fontSize: 11.5 }}>Mostra o SKILL.md como está no disco. Nada é executado.</span>
                </div>
                {doc?.state === 'error' && <div className="hq-notice hq-notice--error" role="alert">não foi possível ler o arquivo: {doc.error}</div>}
                {doc?.state === 'ok' && <pre className="hq-pre">{doc.content || '(arquivo vazio)'}</pre>}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
