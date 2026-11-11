// Mesa do Chefe: cada tarefa distribuída que termina vira uma ENTREGA persistida (com versão), e "Pedir ajustes" devolve ao mesmo
// responsável criando a próxima versão sem apagar a anterior. Aprovar uma entrega não publica nada. Perguntas e pedidos de
// permissão continuam vindo do gerenciador (pendingPermissions); bloqueios do plano ficam em desk_needs.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DeskCheck, DeskClientMessage, DeskCriterion, DeskDelivery, DeskNeed, DeskState, ServerMessage, Task, TaskRunInput, TaskRunResult } from '@milweb-hq/protocol';
import type { Store } from '../store.js';
import type { MeetingStore } from '../meetings/store.js';

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(v: unknown, d: T): T => { try { return v == null ? d : JSON.parse(String(v)) as T; } catch { return d; } };
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

export interface DeskManagerLike {
  on(event: 'task_finished', fn: (taskId: string) => void): unknown;
  runTask(input: TaskRunInput, extra?: { origin?: Task['origin']; meetingId?: string | null }): Promise<TaskRunResult>;
}

export interface DeskDeps {
  db: DatabaseSync;
  store: Store;
  meetings: MeetingStore;
  manager: DeskManagerLike;
  broadcast(m: ServerMessage): void;
  log?: { info(m: string): void; warn(m: string, e?: unknown): void };
  now?: () => number;
}

/** "- [x] critério" / "- [ ] critério: o que falta" na resposta do funcionário, casados com os critérios do plano. */
export function readCriteria(text: string, expected: string[]): DeskCriterion[] {
  const marks = [...text.matchAll(/^\s*[-*]\s*\[([ xX✓])\]\s*(.+)$/gm)].map(m => ({ ok: m[1].trim() !== '', line: m[2].trim() }));
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const out: DeskCriterion[] = expected.map(c => {
    const nc = norm(c).slice(0, 40);
    const hit = marks.find(mk => norm(mk.line).startsWith(nc) || norm(mk.line).includes(nc));
    if (!hit) return { text: c, ok: null, note: null };
    const rest = hit.line.slice(Math.min(hit.line.length, c.length)).replace(/^[\s:–-]+/, '').trim();
    return { text: c, ok: hit.ok, note: rest || null };
  });
  // Critérios que o funcionário listou e o plano não tinha (ex.: ajuste avulso) entram como estão.
  for (const mk of marks) if (!out.some(o => mk.line.toLowerCase().includes(o.text.toLowerCase().slice(0, 30)))) out.push({ text: mk.line.slice(0, 300), ok: mk.ok, note: null });
  return out.slice(0, 20);
}

/** Arquivos reais citados ("Arquivo: caminho") ou tocados pela tarefa, e links. Só entra arquivo que existe. */
export function readOutputs(task: Task, projectPath: string | null): { files: string[]; links: string[] } {
  const text = task.resultText ?? '';
  const cited = [...text.matchAll(/^\s*(?:[-*]\s*)?Arquivo:\s*`?([^`\n]+?)`?\s*$/gim)].map(m => m[1].trim());
  const files = [...new Set([...cited, ...task.touchedFiles].map(f => (path.isAbsolute(f) || !projectPath ? f : path.join(projectPath, f))))]
    .filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }).slice(0, 30);
  const links = [...new Set([...text.matchAll(/https?:\/\/[^\s)<>"'`]+/g)].map(m => m[0].replace(/[.,;:]+$/, '')))].slice(0, 15);
  return { files, links };
}

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const nrm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * O que a HQ consegue conferir sozinha numa entrega (existência, tamanho e tipo dos arquivos, coerência com o formato pedido)
 * e o que continua dependendo do Chefe. Processo terminado sem erro não basta: pedido de vídeo sem arquivo de vídeo é marcado.
 */
export function deliveryChecks(request: string, files: string[], summary: string): DeskCheck[] {
  const out: DeskCheck[] = [];
  const sized = files.map(f => { try { return { f, size: fs.statSync(f).size }; } catch { return { f, size: -1 }; } });
  const empty = sized.filter(x => x.size <= 0);
  const hasText = summary.trim().length > 0;
  if (!files.length) out.push({ label: 'Arquivos da entrega', ok: hasText ? null : false, detail: hasText ? 'nenhum arquivo foi salvo: a entrega é só o texto da resposta' : 'nenhum arquivo e nenhum texto: nada foi entregue' });
  else out.push({ label: 'Arquivos da entrega', ok: empty.length === 0, detail: empty.length ? `arquivo vazio ou ilegível: ${empty.map(x => path.basename(x.f)).join(', ')}` : `${files.length} arquivo(s) existem no disco` });
  const n = nrm(request);
  const wantsVideo = /\b(video|reel|reels|shorts|animacao)\b/.test(n) && !/\broteiro\b/.test(n);
  const videos = sized.filter(x => VIDEO_EXT.test(x.f) && x.size > 0);
  if (wantsVideo) out.push({ label: 'Vídeo reproduzível', ok: videos.length > 0, detail: videos.length ? `${videos.map(x => `${path.basename(x.f)} (${(x.size / 1048576).toFixed(1)} MB)`).join(', ')}; a HQ não assistiu: reprodução, áudio e ritmo dependem de você` : 'o pedido era de vídeo e nenhum arquivo de vídeo foi entregue (roteiro é entrega de roteiro)' });
  if (/\bcarrossel\b/.test(n)) { const imgs = sized.filter(x => IMAGE_EXT.test(x.f) && x.size > 0); out.push({ label: 'Imagens do carrossel', ok: imgs.length > 0, detail: imgs.length ? `${imgs.length} imagem(ns) exportada(s); texto legível e composição dependem de você` : 'o pedido era de carrossel e nenhuma imagem foi entregue' }); }
  out.push({ label: 'Qualidade editorial', ok: null, detail: 'coerência com a marca, fatos e gosto: depende da sua avaliação' });
  return out;
}

export class DeskService {
  private readonly now: () => number;
  constructor(private readonly deps: DeskDeps) {
    this.now = deps.now ?? Date.now;
    deps.manager.on('task_finished', (taskId: string) => { try { if (this.onTaskFinished(taskId)) this.push(); } catch (err) { deps.log?.warn('mesa do Chefe: entrega não registrada', err); } });
  }

  state(): DeskState {
    const deliveries = (this.deps.db.prepare('SELECT * FROM desk_deliveries ORDER BY created_at DESC LIMIT 200').all() as Row[]).map(r => this.rowToDelivery(r));
    const needs = (this.deps.db.prepare('SELECT * FROM desk_needs WHERE resolved_at IS NULL OR resolved_at > ? ORDER BY created_at DESC LIMIT 100').all(this.now() - 7 * 86_400_000) as Row[]).map(r => this.rowToNeed(r));
    return { deliveries, needs };
  }
  private push(): void { this.deps.broadcast({ kind: 'desk.state', state: this.state() }); }

  async handle(msg: DeskClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'desk.state': return this.state();
      case 'desk.seen': {
        const ids = (msg.ids ?? []).slice(0, 200);
        for (const id of ids) this.deps.db.prepare("UPDATE desk_deliveries SET seen_at = COALESCE(seen_at, ?), status = CASE WHEN status = 'nova' THEN 'vista' ELSE status END WHERE id = ?").run(this.now(), id);
        this.push(); return this.state();
      }
      case 'desk.approve': {
        const d = this.get(msg.id); if (!d) throw new Error('entrega não encontrada');
        if (d.status === 'ajustes') throw new Error('esta versão voltou para ajustes; aprove a versão nova quando chegar');
        this.deps.db.prepare("UPDATE desk_deliveries SET status = 'aprovada', decided_at = ?, seen_at = COALESCE(seen_at, ?) WHERE id = ?").run(this.now(), this.now(), d.id);
        this.deps.log?.info(`mesa: entrega "${d.title}" v${d.version} aprovada pelo Chefe (nada publicado)`);
        this.push(); return this.state();
      }
      case 'desk.adjust': return this.adjust(msg.id, msg.note);
      case 'desk.need.resolve': {
        this.deps.db.prepare('UPDATE desk_needs SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(this.now(), msg.id);
        this.push(); return this.state();
      }
      default: throw new Error(`operação desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  /** Bloqueio vindo do plano (ninguém apto, tarefa que não entrou na fila). O mesmo texto da mesma reunião não repete. */
  addNeed(i: { meetingId: string | null; planTaskId: string | null; text: string }): void {
    const r = this.deps.db.prepare('INSERT OR IGNORE INTO desk_needs(id, meeting_id, plan_task_id, text, created_at) VALUES (?,?,?,?,?)').run(randomUUID(), i.meetingId, i.planTaskId, i.text.slice(0, 600), this.now());
    if (Number(r.changes) > 0) this.push();
  }

  /**
   * Tarefa terminou: se for de um plano de reunião (ou um ajuste pedido na mesa) e concluída, vira entrega. Idempotente pelo
   * índice único da tarefa (reinício, evento repetido). Devolve true quando criou.
   */
  onTaskFinished(taskId: string): boolean {
    const t = this.deps.store.getTask(taskId);
    if (!t || t.status !== 'done') return false;
    if (this.deps.db.prepare('SELECT 1 FROM desk_deliveries WHERE task_id = ?').get(taskId)) return false;
    const rec = this.deps.meetings.findPlanTaskByTask(taskId);
    const parentRow = this.deps.db.prepare('SELECT * FROM desk_deliveries WHERE adjust_task_id = ?').get(taskId) as Row | undefined;
    const parent = parentRow ? this.rowToDelivery(parentRow) : null;
    // Pedido direto do Chefe pelo campo (10/11): a tarefa acompanhada, ou a retentativa dela, vira entrega na Mesa.
    const watched = rec || parent ? null : this.watchedRequest(t);
    if (!rec && !parent && watched == null) return false;
    const meetingId = rec?.meetingId ?? parent?.meetingId ?? null;
    const project = this.deps.store.getProject(t.projectId);
    const out = readOutputs(t, project?.path ?? null);
    const criteria = readCriteria(t.resultText ?? '', rec?.spec.criteria ?? parent?.criteria.map(c => c.text) ?? []);
    const id = randomUUID();
    const request = parent?.request ?? watched ?? (rec ? [rec.spec.title, ...(rec.spec.criteria ?? [])].join(' ') : '');
    const summary = (t.resultText ?? '').trim().slice(0, 4000);
    const title = rec?.spec.title ?? parent?.title ?? (watched ? watched.replace(/\s+/g, ' ').slice(0, 90) : 'Entrega');
    this.deps.db.prepare(`INSERT OR IGNORE INTO desk_deliveries(id, task_id, root_task_id, version, meeting_id, plan_task_id, employee_id, title, slot, profile_id, summary, files_json, links_json, criteria_json, status, created_at, checks_json, source, request)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, taskId, parent?.rootTaskId ?? taskId, (parent?.version ?? 0) + 1, meetingId, rec?.id ?? parent?.planTaskId ?? null, t.employeeId ?? null,
      title, rec?.spec.slot ?? parent?.slot ?? t.destinationId ?? null, t.profileId ?? parent?.profileId ?? null, summary, j(out.files), j(out.links), j(criteria), 'nova', this.now(),
      j(deliveryChecks(request, out.files, summary)), parent ? 'ajuste' : rec ? 'reuniao' : 'pedido', request ? request.slice(0, 2000) : null);
    this.deps.log?.info(`mesa: entrega "${title}" v${(parent?.version ?? 0) + 1} de ${this.deps.store.getEmployee(t.employeeId ?? '')?.name ?? '?'}`);
    return true;
  }

  /** Acompanha um pedido direto do Chefe (campo "O que vamos criar?"): quando a tarefa terminar, vira entrega na Mesa. */
  watch(taskId: string, request: string): void {
    this.deps.db.prepare('INSERT OR IGNORE INTO desk_watch(task_id, request, created_at) VALUES (?,?,?)').run(taskId, request.slice(0, 2000), this.now());
  }
  /** O pedido acompanhado desta tarefa ou de quem ela retenta/continua (limite de uso, reinício). */
  private watchedRequest(t: Task): string | null {
    let cur: Task | null = t;
    for (let i = 0; cur && i < 8; i++) {
      const r = this.deps.db.prepare('SELECT request FROM desk_watch WHERE task_id = ?').get(cur.id) as { request: string } | undefined;
      if (r) return r.request;
      cur = cur.retryOf ? this.deps.store.getTask(cur.retryOf) : null;
    }
    return null;
  }

  /** Depois de um reinício: tarefas que terminaram com a HQ desligada (ou antes do evento) viram entrega. */
  recover(): void {
    let n = 0;
    const done = this.deps.store.listTasksByStatus(['done']);
    for (const t of done) if (t.origin === 'meeting' || this.deps.db.prepare('SELECT 1 FROM desk_deliveries WHERE adjust_task_id = ?').get(t.id) || this.watchedRequest(t) != null) { if (this.onTaskFinished(t.id)) n++; }
    if (n) { this.deps.log?.info(`mesa: ${n} entrega(s) recuperada(s) ao iniciar`); this.push(); }
  }

  /** Volta ao mesmo responsável, na mesma conversa do projeto, com a observação do Chefe; a versão atual fica guardada. */
  private async adjust(id: string, noteRaw: string): Promise<DeskState> {
    const d = this.get(id); if (!d) throw new Error('entrega não encontrada');
    const note = (noteRaw ?? '').trim().slice(0, 3000);
    if (!note) throw new Error('escreva o que ajustar');
    if (d.adjustTaskId) return this.state(); // clique repetido: o ajuste já está na fila
    const t = this.deps.store.getTask(d.taskId); if (!t) throw new Error('a tarefa desta entrega não existe mais');
    if (!t.employeeId) throw new Error('a entrega não tem responsável');
    const files = d.files.length ? `\nArquivos da versão ${d.version}: ${d.files.join(' ; ')}` : '';
    const text = [
      `[Ajuste pedido pelo Chefe na mesa · "${d.title}" · versão ${d.version} → ${d.version + 1}]`,
      `Observação do Chefe: ${note}`,
      files,
      '',
      'Refaça a entrega considerando só a observação. NÃO apague a versão anterior: salve a nova ao lado (ex.: sufixo -v' + (d.version + 1) + ').',
      'Não publique nem envie nada. Ao terminar, responda com um resumo curto do que mudou, os caminhos ("Arquivo: caminho", um por linha) e os critérios no formato "- [x] critério" ou "- [ ] critério: o que falta".',
      d.criteria.length ? `Critérios: ${d.criteria.map(c => c.text).join(' | ')}` : '',
    ].filter(l => l !== '').join('\n');
    const res = await this.deps.manager.runTask({ reqId: 'desk-adjust', clientId: `desk:adjust:${d.id}`, text, projectId: t.projectId, employeeId: t.employeeId, skill: null, plan: false, destinationId: d.slot ?? undefined, ...(t.profileId ? { profileId: t.profileId } : {}) }, { origin: 'chat', meetingId: d.meetingId });
    // O índice único em adjust_task_id impede duas versões do mesmo pedido.
    this.deps.db.prepare("UPDATE desk_deliveries SET status = 'ajustes', note = ?, adjust_task_id = ?, decided_at = ?, seen_at = COALESCE(seen_at, ?) WHERE id = ? AND adjust_task_id IS NULL").run(note, res.taskId, this.now(), this.now(), d.id);
    this.deps.log?.info(`mesa: ajuste de "${d.title}" v${d.version} devolvido a ${this.deps.store.getEmployee(t.employeeId)?.name ?? '?'}`);
    this.push();
    return this.state();
  }

  private get(id: string): DeskDelivery | null {
    const r = this.deps.db.prepare('SELECT * FROM desk_deliveries WHERE id = ?').get(id) as Row | undefined;
    return r ? this.rowToDelivery(r) : null;
  }

  private rowToDelivery(r: Row): DeskDelivery {
    const meetingId = str(r.meeting_id);
    return {
      id: String(r.id), taskId: String(r.task_id), rootTaskId: String(r.root_task_id), version: Number(r.version), meetingId,
      meetingTitle: meetingId ? this.deps.meetings.getMeeting(meetingId)?.title ?? null : null, planTaskId: str(r.plan_task_id), employeeId: str(r.employee_id),
      title: String(r.title), slot: str(r.slot) as DeskDelivery['slot'], profileId: str(r.profile_id), summary: String(r.summary ?? ''),
      files: pj<string[]>(r.files_json, []), links: pj<string[]>(r.links_json, []), criteria: pj<DeskCriterion[]>(r.criteria_json, []),
      checks: pj<DeskCheck[]>(r.checks_json, []), source: (str(r.source) as DeskDelivery['source']) ?? (meetingId ? 'reuniao' : 'ajuste'), request: str(r.request),
      status: r.status as DeskDelivery['status'], note: str(r.note), adjustTaskId: str(r.adjust_task_id), createdAt: Number(r.created_at), seenAt: num(r.seen_at), decidedAt: num(r.decided_at),
    };
  }
  private rowToNeed(r: Row): DeskNeed {
    const meetingId = str(r.meeting_id);
    return { id: String(r.id), meetingId, meetingTitle: meetingId ? this.deps.meetings.getMeeting(meetingId)?.title ?? null : null, planTaskId: str(r.plan_task_id), text: String(r.text), createdAt: Number(r.created_at), resolvedAt: num(r.resolved_at) };
  }
}
