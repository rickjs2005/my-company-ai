// Conhecimento da equipe: orientações persistidas no banco da HQ (não é treinamento de modelo). Cada tarefa recebe, no próprio
// pedido, só o que vale para a equipe, o projeto, a função e o funcionário dela; a versão usada fica registrada. Alterar um
// item cria a versão seguinte e a anterior deixa de ser recuperada. Nada aqui chama IA: recuperar é uma consulta ao banco.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { detectDirective, isTeamId, teamDef, teamOfSlot, KNOWLEDGE_KIND_LABEL } from '@milweb-hq/protocol';
import type { KnowledgeBoard, KnowledgeClientMessage, KnowledgeEvidence, KnowledgeInput, KnowledgeItem, KnowledgeKind, KnowledgeScope, KnowledgeUse, ServerMessage, Task, TeamId } from '@milweb-hq/protocol';
import type { Store } from '../store.js';

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(v: unknown, d: T): T => { try { return v == null ? d : JSON.parse(String(v)) as T; } catch { return d; } };
const str = (v: unknown) => (v == null ? null : String(v));
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const KINDS: KnowledgeKind[] = ['preferencia', 'fato', 'procedimento', 'exemplo', 'sugestao'];
const SCOPES = ['empresa', 'equipe', 'projeto', 'funcao', 'funcionario'];
const STOP = new Set('para como mais menos esta este essa esse isso aqui onde quando sobre entre depois antes muito pouco cada todo toda todos todas fazer faca sempre nunca deve devem pode podem ser estar com sem uma umas uns dos das nos nas pelo pela que nao sim tem ter foi sao seu sua seus suas meu minha chefe equipe tarefa pedido arquivo arquivos'.split(' '));
/** Palavras que carregam assunto (para casar procedimento, fato e exemplo com o pedido). */
export function keywords(text: string): Set<string> {
  return new Set(norm(text).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w)));
}
function overlap(a: Set<string>, b: Set<string>): number { let n = 0; for (const w of a) if (b.has(w)) n++; return n; }

/** Limites do que vai no pedido: recuperar tudo a cada chamada custaria contexto sem melhorar a entrega. */
const MAX_ITEMS = 12;
const MAX_CHARS = 2600;
const SPECIFICITY: Record<string, number> = { funcionario: 5, funcao: 4, projeto: 3, equipe: 2, empresa: 1 };
const KIND_ORDER: Record<KnowledgeKind, number> = { preferencia: 0, procedimento: 1, fato: 2, exemplo: 3, sugestao: 4 };

export interface KnowledgeDeps {
  db: DatabaseSync;
  store: Store;
  broadcast(m: ServerMessage): void;
  log?: { info(m: string): void; warn(m: string, e?: unknown): void };
  now?: () => number;
}

export interface RetrieveContext { teams: TeamId[]; projectId: string | null; employeeId: string | null; template: string | null; text: string }

export class KnowledgeService {
  private readonly now: () => number;
  constructor(private readonly deps: KnowledgeDeps) { this.now = deps.now ?? Date.now; }

  // ---------------------------------------------------------------- leitura
  board(): KnowledgeBoard {
    const counts = new Map<string, { n: number; last: number }>();
    for (const r of this.deps.db.prepare('SELECT knowledge_id, COUNT(*) AS n, MAX(at) AS last FROM knowledge_uses GROUP BY knowledge_id').all() as Row[]) counts.set(String(r.knowledge_id), { n: Number(r.n), last: Number(r.last) });
    const items = (this.deps.db.prepare('SELECT * FROM knowledge_items ORDER BY updated_at DESC LIMIT 600').all() as Row[]).map(r => this.rowToItem(r, counts));
    return { items, recentUses: this.usesWhere('1=1', [], 300) };
  }
  private push(): void { this.deps.broadcast({ kind: 'knowledge.state', state: this.board() }); }
  get(id: string): KnowledgeItem | null {
    const r = this.deps.db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToItem(r) : null;
  }
  uses(id: string): KnowledgeUse[] {
    const it = this.get(id); if (!it) return [];
    return this.usesWhere('chain_id = ?', [it.chainId], 200);
  }
  usesOfTask(taskId: string): KnowledgeUse[] { return this.usesWhere('task_id = ?', [taskId], 50); }
  private usesWhere(where: string, args: (string | number)[], limit: number): KnowledgeUse[] {
    return (this.deps.db.prepare(`SELECT * FROM knowledge_uses WHERE ${where} ORDER BY at DESC LIMIT ?`).all(...args, limit) as Row[]).map(r => {
      const t = this.deps.store.getTask(String(r.task_id));
      const shown = t ? this.deps.store.getChatItem('user:' + t.id) : null;
      const title = (shown && shown.kind === 'user' ? shown.text : t?.prompt ?? '(tarefa removida)').replace(/\s+/g, ' ').slice(0, 140);
      return { knowledgeId: String(r.knowledge_id), chainId: String(r.chain_id), version: Number(r.version), title: String(r.title), kind: r.kind as KnowledgeKind, taskId: String(r.task_id), taskTitle: title, employeeId: t?.employeeId ?? null, profileId: t?.profileId ?? null, at: Number(r.at) };
    });
  }

  // ---------------------------------------------------------------- mensagens
  async handle(msg: KnowledgeClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'knowledge.state': return this.board();
      case 'knowledge.teach': { const r = this.teach(msg.item, msg.clientId); return { ...this.board(), item: r.item, similar: r.similar, duplicate: r.duplicate }; }
      case 'knowledge.replace': { const item = this.replace(msg.id, msg.patch); return { ...this.board(), item }; }
      case 'knowledge.setState': { this.setState(msg.id, msg.state); return this.board(); }
      case 'knowledge.delete': { this.remove(msg.id); return this.board(); }
      case 'knowledge.undo': { this.undo(msg.id); return this.board(); }
      case 'knowledge.uses': return this.uses(msg.id);
      case 'knowledge.preview': {
        const e = msg.employeeId ? this.deps.store.getEmployee(msg.employeeId) : null;
        const teams: TeamId[] = isTeamId(msg.profileId) ? [msg.profileId] : e && isTeamId(e.profileId) ? [e.profileId] : [];
        return this.retrieve({ teams, projectId: msg.projectId, employeeId: msg.employeeId, template: e?.template ?? null, text: msg.text });
      }
      default: throw new Error(`operação desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  // ---------------------------------------------------------------- escrita
  private checkScope(s: KnowledgeScope): KnowledgeScope {
    if (!s || !SCOPES.includes(s.type)) throw new Error('Escolha o alcance: empresa, equipe, projeto, função ou funcionário.');
    if (s.type === 'empresa') return { type: 'empresa', id: null };
    const id = String(s.id ?? '').trim();
    if (!id) throw new Error('Escolha para quem vale (qual equipe, projeto, função ou funcionário).');
    if (s.type === 'equipe' && !isTeamId(id)) throw new Error('Essa equipe não existe: escolha Aurora ou Tuco Dev.');
    if (s.type === 'projeto' && !this.deps.store.getProject(id)) throw new Error('Esse projeto não existe mais na HQ.');
    if (s.type === 'funcionario' && !this.deps.store.getEmployee(id)) throw new Error('Esse funcionário não existe mais.');
    return { type: s.type, id };
  }

  /** Itens ativos parecidos no mesmo alcance e natureza: a tela mostra as versões para o Chefe decidir (substituir ou manter as duas). */
  similar(scope: KnowledgeScope, kind: KnowledgeKind, text: string, exceptChain?: string): KnowledgeItem[] {
    const words = keywords(text); if (words.size < 2) return [];
    return this.activeIn([scope]).filter(i => i.kind === kind && i.chainId !== exceptChain).filter(i => {
      const w = keywords(`${i.title} ${i.text}`); const n = overlap(words, w);
      return n >= 2 && n / Math.min(words.size, w.size) >= 0.5;
    }).slice(0, 4);
  }

  teach(input: KnowledgeInput, clientId?: string | null): { item: KnowledgeItem; similar: KnowledgeItem[]; duplicate: boolean } {
    if (clientId) {
      const dup = this.deps.db.prepare('SELECT * FROM knowledge_items WHERE client_id = ?').get(clientId) as Row | undefined;
      if (dup) return { item: this.rowToItem(dup), similar: [], duplicate: true };
    }
    const text = String(input?.text ?? '').trim().slice(0, 6000);
    if (text.length < 4) throw new Error('Escreva a orientação (uma frase basta).');
    if (!KINDS.includes(input.kind)) throw new Error('Escolha o tipo: preferência, fato, procedimento, exemplo ou sugestão.');
    const scope = this.checkScope(input.scope);
    const origin = input.origin ?? 'chefe';
    // Conclusão que não veio do Chefe nunca nasce valendo: fica proposta até ele ativar.
    const state = origin === 'referencia' || origin === 'equipe' ? (input.state === 'ativo' ? 'ativo' : 'proposto') : input.state ?? 'ativo';
    const similar = this.similar(scope, input.kind, text);
    const same = similar.find(i => norm(i.text).replace(/\s+/g, ' ') === norm(text).replace(/\s+/g, ' '));
    if (same) return { item: same, similar: [], duplicate: true };
    const id = randomUUID(); const now = this.now();
    const title = (String(input.title ?? '').trim() || text.replace(/\s+/g, ' ')).slice(0, 120);
    const evidence = (input.evidence ?? []).filter(e => e && typeof e.ref === 'string' && e.ref.trim()).slice(0, 12).map(e => ({ kind: e.kind, ref: e.ref.trim().slice(0, 500), label: e.label ? String(e.label).slice(0, 200) : null }));
    this.deps.db.prepare(`INSERT INTO knowledge_items(id, chain_id, version, kind, scope_type, scope_id, title, text, state, origin, origin_note, evidence_json, client_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, id, 1, input.kind, scope.type, scope.id, title, text, state, origin, input.originNote ? String(input.originNote).slice(0, 800) : null, j(evidence), clientId ?? null, now, now);
    this.deps.log?.info(`conhecimento: "${title.slice(0, 60)}" registrado (${input.kind}, ${this.scopeLabel(scope)}, ${state}, origem ${origin})`);
    this.push();
    return { item: this.get(id)!, similar, duplicate: false };
  }

  /** Corrigir ou substituir: a versão nova passa a valer; a anterior fica no histórico e deixa de ser recuperada. */
  replace(id: string, patch: { title?: string; text?: string; kind?: KnowledgeKind; scope?: KnowledgeScope }): KnowledgeItem {
    const cur = this.get(id); if (!cur) throw new Error('ensinamento não encontrado');
    if (cur.state === 'substituido') throw new Error('Esta versão já foi substituída: altere a versão atual.');
    const text = (patch.text ?? cur.text).trim().slice(0, 6000);
    if (text.length < 4) throw new Error('Escreva a orientação (uma frase basta).');
    const kind = patch.kind && KINDS.includes(patch.kind) ? patch.kind : cur.kind;
    const scope = patch.scope ? this.checkScope(patch.scope) : cur.scope;
    const title = (patch.title?.trim() || (patch.text ? text.replace(/\s+/g, ' ') : cur.title)).slice(0, 120);
    const nid = randomUUID(); const now = this.now();
    this.deps.db.exec('BEGIN');
    try {
      // Ao corrigir um proposto, o Chefe está assumindo o texto: a versão nova nasce ativa.
      this.deps.db.prepare(`INSERT INTO knowledge_items(id, chain_id, version, kind, scope_type, scope_id, title, text, state, origin, origin_note, evidence_json, supersedes_id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(nid, cur.chainId, cur.version + 1, kind, scope.type, scope.id, title, text, 'ativo', cur.origin, cur.originNote, j(cur.evidence), cur.id, now, now);
      this.deps.db.prepare("UPDATE knowledge_items SET state = 'substituido', superseded_by_id = ?, updated_at = ? WHERE id = ?").run(nid, now, cur.id);
      this.deps.db.exec('COMMIT');
    } catch (err) { this.deps.db.exec('ROLLBACK'); throw err; }
    this.deps.log?.info(`conhecimento: "${cur.title.slice(0, 60)}" v${cur.version} substituído pela v${cur.version + 1}`);
    this.push();
    return this.get(nid)!;
  }

  setState(id: string, state: 'ativo' | 'desativado'): void {
    const cur = this.get(id); if (!cur) throw new Error('ensinamento não encontrado');
    if (cur.state === 'substituido') throw new Error('Versão substituída fica só no histórico: ative ou desative a versão atual.');
    if (state !== 'ativo' && state !== 'desativado') throw new Error('estado inválido');
    this.deps.db.prepare('UPDATE knowledge_items SET state = ?, updated_at = ? WHERE id = ?').run(state, this.now(), id);
    this.deps.log?.info(`conhecimento: "${cur.title.slice(0, 60)}" v${cur.version} → ${state}`);
    this.push();
  }

  /** Exclui o ensinamento inteiro (todas as versões e o registro de uso). */
  remove(id: string): void {
    const cur = this.get(id); if (!cur) return;
    this.deps.db.prepare('DELETE FROM knowledge_uses WHERE chain_id = ?').run(cur.chainId);
    this.deps.db.prepare('DELETE FROM knowledge_items WHERE chain_id = ?').run(cur.chainId);
    this.deps.log?.info(`conhecimento: "${cur.title.slice(0, 60)}" excluído (todas as versões)`);
    this.push();
  }

  /** Desfazer o registro automático: some se ainda é a primeira versão; se já foi usado em tarefa, fica desativado (o histórico de uso continua verdadeiro). */
  undo(id: string): void {
    const cur = this.get(id); if (!cur) return;
    if (cur.version === 1 && cur.uses === 0 && !cur.supersededById) { this.remove(id); return; }
    this.setState(cur.supersededById ?? id, 'desativado');
  }

  /**
   * Frase do Chefe com orientação explícita para os próximos trabalhos: registra como preferência ativa no escopo indicado e
   * avisa a tela (resumo com Desfazer). Correção pontual não passa por aqui (detectDirective devolve null).
   */
  captureFromChefe(textRaw: string, ctx: { team?: TeamId | null; taskId?: string | null; where: string; test?: boolean }): KnowledgeItem | null {
    try {
      const d = detectDirective(textRaw, { team: ctx.team ?? null, employees: this.deps.store.listActiveEmployees().map(e => ({ id: e.id, name: e.name })) });
      if (!d) return null;
      const r = this.teach({ kind: 'preferencia', scope: d.scope, title: d.title, text: d.text, origin: ctx.test ? 'teste' : 'chefe', originNote: `Frase sua ${ctx.where}: "${textRaw.trim().replace(/\s+/g, ' ').slice(0, 400)}"`, evidence: ctx.taskId ? [{ kind: 'tarefa', ref: ctx.taskId, label: 'pedido em que você disse isso' }] : [] });
      if (r.duplicate) return null;
      this.deps.broadcast({ kind: 'knowledge.captured', item: r.item });
      return r.item;
    } catch (err) { this.deps.log?.warn('conhecimento: orientação do pedido não registrada', err); return null; }
  }

  /** Conclusão de um estudo de referência: entra como PROPOSTA (não vale até o Chefe ativar). A mesma chave não repete. */
  propose(key: string, input: KnowledgeInput): KnowledgeItem | null {
    try { const r = this.teach({ ...input, origin: input.origin ?? 'referencia', state: 'proposto' }, `auto:${key}`); return r.duplicate ? null : r.item; }
    catch (err) { this.deps.log?.warn(`conhecimento: proposta "${key}" não registrada`, err); return null; }
  }

  // ---------------------------------------------------------------- recuperação
  private activeIn(scopes: KnowledgeScope[]): KnowledgeItem[] {
    const out: KnowledgeItem[] = [];
    for (const s of scopes) {
      const rows = s.type === 'empresa'
        ? this.deps.db.prepare("SELECT * FROM knowledge_items WHERE state = 'ativo' AND scope_type = 'empresa'").all() as Row[]
        : this.deps.db.prepare("SELECT * FROM knowledge_items WHERE state = 'ativo' AND scope_type = ? AND scope_id = ?").all(s.type, s.id) as Row[];
      for (const r of rows) out.push(this.rowToItem(r));
    }
    return out;
  }

  /** Só o que é pertinente: empresa + equipe(s) do trabalho + projeto + função + funcionário. Substituído, desativado e proposto ficam de fora. */
  retrieve(ctx: RetrieveContext): KnowledgeItem[] {
    const scopes: KnowledgeScope[] = [{ type: 'empresa', id: null }, ...ctx.teams.map(t => ({ type: 'equipe' as const, id: t }))];
    if (ctx.projectId) scopes.push({ type: 'projeto', id: ctx.projectId });
    if (ctx.template) scopes.push({ type: 'funcao', id: ctx.template });
    if (ctx.employeeId) scopes.push({ type: 'funcionario', id: ctx.employeeId });
    const words = keywords(ctx.text.slice(0, 4000));
    const scored = this.activeIn(scopes).map(i => ({ i, hit: overlap(words, keywords(`${i.title} ${i.text}`)) }))
      // Preferência e alcance específico (função, funcionário, projeto) entram sempre; fato, procedimento, exemplo e sugestão
      // de alcance amplo só quando o assunto do pedido bate.
      .filter(x => x.i.kind === 'preferencia' || SPECIFICITY[x.i.scope.type] >= 3 || x.hit >= 1)
      // Cabe pouco no pedido: primeiro o alcance específico e o que bate com o assunto; preferência genérica completa o espaço.
      .map(x => ({ ...x, score: (SPECIFICITY[x.i.scope.type] >= 3 ? 100 : 0) + Math.min(x.hit, 5) * 10 + SPECIFICITY[x.i.scope.type] * 2 + (x.i.kind === 'preferencia' ? 3 : 0) }))
      .sort((a, b) => b.score - a.score || b.i.updatedAt - a.i.updatedAt);
    const out: KnowledgeItem[] = []; let chars = 0;
    for (const { i } of scored) {
      const cost = Math.min(i.text.length, 700) + 60;
      if (out.length >= MAX_ITEMS || chars + cost > MAX_CHARS) break;
      out.push(i); chars += cost;
    }
    out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || SPECIFICITY[b.scope.type] - SPECIFICITY[a.scope.type]);
    return out;
  }

  /** Equipe(s) de uma tarefa: o perfil gravado, o canal de destino, a equipe do funcionário; sem nada disso, as citadas no pedido. */
  teamsOfTask(t: Task): TeamId[] {
    if (isTeamId(t.profileId)) return [t.profileId];
    const bySlot = teamOfSlot(t.destinationId ?? null); if (bySlot) return [bySlot];
    const e = t.employeeId ? this.deps.store.getEmployee(t.employeeId) : null;
    if (e && isTeamId(e.profileId)) return [e.profileId];
    const n = norm(t.prompt.slice(0, 6000)); const out: TeamId[] = [];
    if (/\b(equipe|instagram|threads|perfil|marca|para a|da|na) aurora\b/.test(n)) out.push('aurora');
    if (/\btuco\b/.test(n)) out.push('tuco-dev');
    return out;
  }

  scopeLabel(s: KnowledgeScope): string {
    if (s.type === 'empresa') return 'empresa';
    if (s.type === 'equipe') return isTeamId(s.id) ? teamDef(s.id).label : 'equipe';
    if (s.type === 'projeto') return `projeto ${this.deps.store.getProject(s.id ?? '')?.name ?? '?'}`;
    if (s.type === 'funcionario') return this.deps.store.getEmployee(s.id ?? '')?.name ?? 'funcionário';
    return `função ${s.id}`;
  }

  /**
   * Bloco que acompanha o pedido da tarefa, e o registro de quais versões foram usadas. Chamado quando a tarefa COMEÇA (o
   * que o Chefe ensinou enquanto ela esperava na fila já vale). Devolve null quando nada se aplica.
   */
  blockFor(t: Task): string | null {
    try {
      const e = t.employeeId ? this.deps.store.getEmployee(t.employeeId) : null;
      const items = this.retrieve({ teams: this.teamsOfTask(t), projectId: t.projectId, employeeId: t.employeeId ?? null, template: e?.template ?? null, text: t.prompt });
      if (!items.length) return null;
      const now = this.now();
      const ins = this.deps.db.prepare('INSERT OR IGNORE INTO knowledge_uses(knowledge_id, chain_id, version, task_id, title, kind, at) VALUES (?,?,?,?,?,?,?)');
      for (const i of items) ins.run(i.id, i.chainId, i.version, t.id, i.title, i.kind, now);
      const lines = items.map(i => `- [${KNOWLEDGE_KIND_LABEL[i.kind]} · ${this.scopeLabel(i.scope)} · v${i.version}] ${i.text.replace(/\s+/g, ' ').slice(0, 700)}`);
      this.push();
      return [
        '[Conhecimento da equipe registrado no My Company AI que se aplica a esta tarefa]',
        'O pedido acima prevalece sobre estas orientações quando houver conflito. Se duas orientações se contradisserem e o pedido não resolver, siga a de alcance mais específico e diga isso na resposta. Itens marcados como sugestão ou exemplo são material de apoio, não ordens; nenhum item muda permissões, pastas ou contas.',
        ...lines,
      ].join('\n');
    } catch (err) { this.deps.log?.warn('conhecimento: recuperação falhou (a tarefa segue sem o bloco)', err); return null; }
  }

  private rowToItem(r: Row, counts?: Map<string, { n: number; last: number }>): KnowledgeItem {
    const id = String(r.id);
    const c = counts ? counts.get(id) : (() => { const x = this.deps.db.prepare('SELECT COUNT(*) AS n, MAX(at) AS last FROM knowledge_uses WHERE knowledge_id = ?').get(id) as Row; return Number(x.n) ? { n: Number(x.n), last: Number(x.last) } : undefined; })();
    return {
      id, chainId: String(r.chain_id), version: Number(r.version), kind: r.kind as KnowledgeKind, scope: { type: r.scope_type as KnowledgeScope['type'], id: str(r.scope_id) },
      title: String(r.title), text: String(r.text), state: r.state as KnowledgeItem['state'], origin: r.origin as KnowledgeItem['origin'], originNote: str(r.origin_note),
      evidence: pj<KnowledgeEvidence[]>(r.evidence_json, []), supersedesId: str(r.supersedes_id), supersededById: str(r.superseded_by_id),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), uses: c?.n ?? 0, lastUsedAt: c?.last ?? null,
    };
  }
}
