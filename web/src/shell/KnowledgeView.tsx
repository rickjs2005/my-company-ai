// Conhecimento da equipe (área da Equipe): o Chefe ensina uma orientação, escolhe para quem vale, vê de onde cada item veio,
// corrige/substitui/desativa/exclui e confere em quais tarefas foi usado. É memória persistente da HQ entregue no pedido de
// cada tarefa; não é treinamento do modelo. Sugestão extraída de referência fica "proposta" até ele ativar.
import { useMemo, useState } from 'react';
import { KNOWLEDGE_KIND_LABEL, KNOWLEDGE_ORIGIN_LABEL, KNOWLEDGE_STATE_LABEL } from '@milweb-hq/protocol';
import type { AcademyTechnique, DeskDelivery, Employee, KnowledgeBoard, KnowledgeEvidence, KnowledgeInput, KnowledgeItem, KnowledgeKind, KnowledgeScope, KnowledgeUse, Project, Task } from '@milweb-hq/protocol';
import { demonstrated, filterItems, parseScopeKey, scopeKey, scopeLabel, scopeOptions, tabCounts, usesOf, versionsOf, type KnowledgeTab } from './knowledgeBoard';

export interface KnowledgeApi {
  teach(item: KnowledgeInput, clientId: string): Promise<{ item: KnowledgeItem; similar: KnowledgeItem[]; duplicate: boolean }>;
  replace(id: string, patch: { title?: string; text?: string; kind?: KnowledgeKind; scope?: KnowledgeScope }): Promise<unknown>;
  setState(id: string, state: 'ativo' | 'desativado'): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  uses(id: string): Promise<KnowledgeUse[]>;
  openFile(abs: string): void;
  openUrl(url: string): void;
  openTask(taskId: string): void;
}

export interface KnowledgeViewProps {
  board: KnowledgeBoard | null;
  employees: Employee[];
  projects: Project[];
  tasks: Task[];
  deliveries: DeskDelivery[];
  techniques: AcademyTechnique[];
  api: KnowledgeApi | null;
  /** Abre já filtrado (ex.: "Ensinar" no painel de um funcionário). */
  initialScope?: string | null;
}

const KINDS: KnowledgeKind[] = ['preferencia', 'procedimento', 'fato', 'exemplo', 'sugestao'];
const when = (t: number) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const TAB_LABEL: Record<KnowledgeTab, string> = { vigentes: 'Em uso', propostos: 'Propostos', historico: 'Desativados' };

export function KnowledgeView(props: KnowledgeViewProps) {
  const { board, employees, projects, api } = props;
  const ctx = useMemo(() => ({ employees, projects }), [employees, projects]);
  const options = useMemo(() => scopeOptions(employees, projects), [employees, projects]);
  const [tab, setTab] = useState<KnowledgeTab>('vigentes');
  const [scope, setScope] = useState(props.initialScope ?? '');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<{ text: string; kind: KnowledgeKind; scope: string; ref: string; clientId: string }>({ text: '', kind: 'preferencia', scope: props.initialScope || 'empresa', ref: '', clientId: newId() });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [similar, setSimilar] = useState<{ created: KnowledgeItem; others: KnowledgeItem[] } | null>(null);
  const counts = tabCounts(board);
  const items = filterItems(board, { tab, scope, query });
  const people = useMemo(() => demonstrated(employees, board, props.deliveries, props.techniques, props.tasks), [employees, board, props.deliveries, props.techniques, props.tasks]);

  const teach = async () => {
    if (!api || !draft.text.trim() || busy) return;
    setBusy(true); setMsg(null); setSimilar(null);
    const ref = draft.ref.trim();
    const evidence: KnowledgeEvidence[] = ref ? [{ kind: /^https?:\/\//i.test(ref) ? 'link' : 'arquivo', ref, label: null }] : [];
    try {
      const r = await api.teach({ kind: draft.kind, scope: parseScopeKey(draft.scope), text: draft.text.trim(), evidence, origin: 'chefe' }, draft.clientId);
      if (r.duplicate) setMsg({ ok: true, text: 'Essa orientação já estava registrada: nada foi duplicado.' });
      else {
        setMsg({ ok: true, text: `Registrado para ${scopeLabel(r.item.scope, ctx)}. Vale a partir do próximo pedido.` });
        if (r.similar.length) setSimilar({ created: r.item, others: r.similar });
      }
      setDraft(d => ({ ...d, text: '', ref: '', clientId: newId() }));
      setTab('vigentes');
    } catch (err) { setMsg({ ok: false, text: String((err as Error).message ?? err) }); }
    finally { setBusy(false); }
  };

  return (
    <div className="hq-know">
      <p className="hq-dim hq-know__lead">
        Memória da empresa guardada na HQ: cada tarefa recebe só o que vale para a equipe, o projeto, a função e a pessoa dela, e registra a versão usada.
        Não é treinamento do modelo. O pedido do momento sempre prevalece sobre o que está aqui.
      </p>

      <section className="hq-know__teach" aria-label="Ensinar">
        <textarea className="hq-input" rows={2} value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })}
          placeholder={'Ensine uma orientação. Ex.: "Nos vídeos do Tuco, comece direto no assunto."'} aria-label="Orientação" disabled={!api} />
        <div className="hq-know__row">
          <label className="hq-field hq-field--inline"><span>Tipo</span>
            <select className="hq-select" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as KnowledgeKind })}>{KINDS.map(k => <option key={k} value={k}>{KNOWLEDGE_KIND_LABEL[k]}</option>)}</select>
          </label>
          <label className="hq-field hq-field--inline"><span>Vale para</span>
            <ScopeSelect value={draft.scope} options={options} onChange={v => setDraft({ ...draft, scope: v })} />
          </label>
          <label className="hq-field hq-field--inline hq-know__ref"><span>Referência (opcional)</span>
            <input className="hq-input" value={draft.ref} onChange={e => setDraft({ ...draft, ref: e.target.value })} placeholder="link ou caminho do arquivo que mostra isso" />
          </label>
          <button type="button" className="hq-btn hq-btn--primary" disabled={!api || !draft.text.trim() || busy} onClick={() => void teach()}>{busy ? 'Registrando…' : 'Ensinar'}</button>
        </div>
        {msg && <p className={msg.ok ? 'hq-know__ok' : 'hq-composer__bad'} role="status">{msg.text}</p>}
        {similar && (
          <div className="hq-know__conflict" role="alert">
            <strong>Já existe orientação parecida no mesmo alcance.</strong> Decida qual vale:
            {similar.others.map(o => (
              <div key={o.id} className="hq-know__conflictrow">
                <span>"{o.text.slice(0, 220)}" <span className="hq-dim">v{o.version} · {when(o.updatedAt)}</span></span>
                <button type="button" className="hq-btn hq-btn--sm" onClick={() => { void api?.setState(o.id, 'desativado').then(() => setSimilar(s => (s ? { ...s, others: s.others.filter(x => x.id !== o.id) } : s))); }}>Desativar a antiga</button>
              </div>
            ))}
            <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setSimilar(null)}>Manter as duas</button>
          </div>
        )}
      </section>

      <div className="hq-know__filters">
        <div role="tablist" className="hq-know__tabs">
          {(Object.keys(TAB_LABEL) as KnowledgeTab[]).map(t => <button key={t} type="button" role="tab" aria-selected={tab === t} className={`hq-home-chip${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>{TAB_LABEL[t]} ({counts[t]})</button>)}
        </div>
        <ScopeSelect value={scope} options={options} onChange={setScope} allLabel="Todos os alcances" />
        <input className="hq-input hq-know__search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar no conhecimento" aria-label="Buscar no conhecimento" />
      </div>

      {items.length === 0 ? (
        <p className="hq-empty">{tab === 'vigentes' ? 'Nada registrado neste filtro. Ensine acima, ou escreva num pedido "lembre disso para o Tuco".' : tab === 'propostos' ? 'Nenhuma proposta esperando você. Técnicas extraídas de referências aparecem aqui antes de valer.' : 'Nada desativado.'}</p>
      ) : (
        <ul className="hq-know__list">{items.map(i => <ItemCard key={i.id} item={i} board={board} ctx={ctx} options={options} api={api} />)}</ul>
      )}

      <section className="hq-know__people" aria-label="O que cada pessoa já demonstrou">
        <h3>O que cada pessoa já demonstrou</h3>
        <p className="hq-dim">Só registros reais. Skill instalada não conta como domínio; sem registro, a coluna fica em branco.</p>
        <table className="hq-table">
          <thead><tr><th>Pessoa</th><th>Equipe</th><th title="Orientações ativas que acompanham os pedidos dela">Orientação registrada</th><th title="Tarefas em que recebeu conhecimento registrado">Aplicada em tarefas</th><th title="Exercícios da Academia de Vídeo">Exercício produzido</th><th title="Exercícios que o Diretor de Vídeo validou">Validado tecnicamente</th><th title="Entregas dela aprovadas por você na Minha mesa">Aprovado por você</th></tr></thead>
          <tbody>{people.map(p => (
            <tr key={p.employee.id}>
              <td><strong>{p.employee.name}</strong><span className="hq-dim hq-table__sub">{p.employee.role}</span></td>
              <td>{p.team}</td><td>{p.guidance || '—'}</td><td>{p.applied || '—'}</td><td>{p.exercises || '—'}</td><td>{p.validated || '—'}</td>
              <td>{p.delivered ? `${p.approved} de ${p.delivered} entrega(s)` : '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
    </div>
  );
}

function ScopeSelect({ value, options, onChange, allLabel }: { value: string; options: { key: string; label: string; group: string }[]; onChange(v: string): void; allLabel?: string }) {
  const groups = [...new Set(options.map(o => o.group))];
  return (
    <select className="hq-select" value={value} onChange={e => onChange(e.target.value)} aria-label="Alcance">
      {allLabel && <option value="">{allLabel}</option>}
      {groups.map(g => <optgroup key={g} label={g}>{options.filter(o => o.group === g).map(o => <option key={o.key} value={o.key}>{o.label}</option>)}</optgroup>)}
    </select>
  );
}

function ItemCard({ item, board, ctx, options, api }: { item: KnowledgeItem; board: KnowledgeBoard | null; ctx: { employees: Employee[]; projects: Project[] }; options: { key: string; label: string; group: string }[]; api: KnowledgeApi | null }) {
  const [edit, setEdit] = useState<{ text: string; kind: KnowledgeKind; scope: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allUses, setAllUses] = useState<KnowledgeUse[] | null>(null);
  const uses = allUses ?? usesOf(board, item);
  const older = versionsOf(board, item);
  const totalUses = item.uses + older.reduce((n, o) => n + o.uses, 0);
  const run = async (fn: () => Promise<unknown>) => { if (!api) return false; setBusy(true); setError(null); try { await fn(); return true; } catch (err) { setError(String((err as Error).message ?? err)); return false; } finally { setBusy(false); } };
  return (
    <li className={`hq-know__card hq-know__card--${item.state}`}>
      <div className="hq-know__head">
        <span className={`hq-tag hq-tag--xs hq-know__kind hq-know__kind--${item.kind}`}>{KNOWLEDGE_KIND_LABEL[item.kind]}</span>
        <span className="hq-tag hq-tag--xs">{scopeLabel(item.scope, ctx)}</span>
        <span className="hq-tag hq-tag--xs">v{item.version}</span>
        <span className={`hq-know__st hq-know__st--${item.state}`}>{KNOWLEDGE_STATE_LABEL[item.state]}</span>
        <span className="hq-dim hq-know__when">{when(item.createdAt)}</span>
      </div>
      {edit ? (
        <div className="hq-know__edit">
          <textarea className="hq-input" rows={3} value={edit.text} onChange={e => setEdit({ ...edit, text: e.target.value })} aria-label="Nova versão do texto" />
          <div className="hq-know__row">
            <select className="hq-select" value={edit.kind} onChange={e => setEdit({ ...edit, kind: e.target.value as KnowledgeKind })} aria-label="Tipo">{KINDS.map(k => <option key={k} value={k}>{KNOWLEDGE_KIND_LABEL[k]}</option>)}</select>
            <ScopeSelect value={edit.scope} options={options} onChange={v => setEdit({ ...edit, scope: v })} />
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy || !edit.text.trim()} onClick={() => void run(() => api!.replace(item.id, { text: edit.text.trim(), kind: edit.kind, scope: parseScopeKey(edit.scope) })).then(ok => { if (ok) setEdit(null); })}>Salvar como v{item.version + 1}</button>
            <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setEdit(null)}>Cancelar</button>
          </div>
          <p className="hq-dim">A v{item.version} fica no histórico e deixa de acompanhar os pedidos.</p>
        </div>
      ) : <p className="hq-know__text">{item.text}</p>}
      <p className="hq-dim hq-know__origin">Origem: {KNOWLEDGE_ORIGIN_LABEL[item.origin]}{item.originNote ? ` · ${item.originNote}` : ''}</p>
      {item.evidence.length > 0 && (
        <ul className="hq-know__ev" aria-label="Evidência">{item.evidence.map((e, k) => (
          <li key={k}>
            {e.kind === 'arquivo' ? <button type="button" className="hq-linkbtn" title={e.ref} onClick={() => api?.openFile(e.ref)}>{e.label ?? e.ref.split(/[\\/]/).pop()}</button>
              : e.kind === 'link' ? <button type="button" className="hq-linkbtn" title={e.ref} onClick={() => api?.openUrl(e.ref)}>{e.label ?? e.ref.replace(/^https?:\/\//, '').slice(0, 60)}</button>
              : e.kind === 'tarefa' ? <button type="button" className="hq-linkbtn" onClick={() => api?.openTask(e.ref)}>{e.label ?? 'tarefa de origem'}</button>
              : <span>{e.kind}: {e.label ?? e.ref.slice(0, 8)}</span>}
          </li>
        ))}</ul>
      )}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      {!edit && (
        <div className="hq-actions">
          {item.state === 'proposto' && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy} title="Passa a acompanhar os pedidos do alcance" onClick={() => void run(() => api!.setState(item.id, 'ativo'))}>Ativar</button>}
          <button type="button" className="hq-btn hq-btn--sm" disabled={busy || !api} onClick={() => setEdit({ text: item.text, kind: item.kind, scope: scopeKey(item.scope) })}>{item.state === 'proposto' ? 'Corrigir e ativar' : 'Corrigir ou substituir'}</button>
          {item.state === 'ativo' && <button type="button" className="hq-btn hq-btn--sm" disabled={busy} title="Para de acompanhar os pedidos; o histórico fica" onClick={() => void run(() => api!.setState(item.id, 'desativado'))}>Desativar</button>}
          {item.state === 'desativado' && <button type="button" className="hq-btn hq-btn--sm" disabled={busy} onClick={() => void run(() => api!.setState(item.id, 'ativo'))}>Reativar</button>}
          {confirmDel
            ? <><button type="button" className="hq-btn hq-btn--sm hq-btn--danger" disabled={busy} onClick={() => void run(() => api!.remove(item.id))}>Excluir todas as versões</button><button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setConfirmDel(false)}>Cancelar</button></>
            : <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy || !api} onClick={() => setConfirmDel(true)}>Excluir</button>}
        </div>
      )}
      <details className="hq-know__uses" onToggle={e => { if ((e.target as HTMLDetailsElement).open && api && !allUses) void api.uses(item.id).then(setAllUses).catch(() => undefined); }}>
        <summary className="hq-dim">{totalUses === 0 ? 'Ainda não foi usado em nenhuma tarefa' : `Usado em ${totalUses} tarefa(s)`}{older.length ? ` · ${older.length} versão(ões) anterior(es)` : ''}</summary>
        {uses.length > 0 && <ul>{uses.map(u => <li key={u.taskId + u.knowledgeId}><button type="button" className="hq-linkbtn" onClick={() => api?.openTask(u.taskId)}>{u.taskTitle || 'tarefa'}</button> <span className="hq-dim">· v{u.version} · {ctx.employees.find(e => e.id === u.employeeId)?.name ?? '—'} · {when(u.at)}</span></li>)}</ul>}
        {older.length > 0 && <ul className="hq-know__older">{older.map(o => <li key={o.id}><span className="hq-dim">v{o.version} · {KNOWLEDGE_STATE_LABEL[o.state]} · {when(o.createdAt)} · {scopeLabel(o.scope, ctx)}:</span> {o.text}</li>)}</ul>}
      </details>
    </li>
  );
}
