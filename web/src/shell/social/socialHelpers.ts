// Sala Social Media (piloto): regras puras do mural, da mesa do Chefe e da disponibilidade da reunião. Tudo vem dos dados reais
// (tarefas, sessões, provedores); nada de "agendado" ou "publicado" sem integração e evidência.
import type { AiProviderStatus, ContentItem, Session, SocialAccount, Task } from '@milweb-hq/protocol';
import { relativeToProject } from '../ProjectCabinet';

/** Rede citada no marcador do pedido (tarefas antigas tinham só a rede; as novas guardam a conta em destinationId). */
export type Destination = 'instagram' | 'threads' | 'tiktok' | 'linkedin';

const TAG = /^\[Destino: [^\]]+\]\s*/i;
/** Rótulo legível de uma conta de destino (vai no pedido para o funcionário saber para onde escreve). */
export function destinationLabel(a: Pick<SocialAccount, 'label' | 'username'> & { declared?: SocialAccount['declared'] }): string {
  const handle = a.username ?? (a.declared?.confirmed ? a.declared.handle : null);
  return `${a.label}${handle ? ` (@${handle})` : ''}`;
}
/** O destino vai no começo do pedido ("[Destino: Instagram · Aurora (@aurora)]"): o funcionário lê; o mural usa o destinationId. */
export function withDestination(text: string, label: string | null): string {
  const clean = text.replace(TAG, '');
  if (!label) return clean;
  return `[Destino: ${label}] ${clean}`;
}
export function destinationOf(prompt: string): Destination | null {
  const m = /\[Destino: (Instagram|Threads|TikTok|LinkedIn)\b/i.exec(prompt);
  return m ? (m[1].toLowerCase() as Destination) : null;
}
/** Contas que aparecem como destino no perfil editorial escolhido (a associação é feita na central de Redes). */
export function destinationsFor(accounts: SocialAccount[], profileId: string | null): SocialAccount[] {
  return accounts.filter(a => !profileId || a.profileIds.includes(profileId));
}
/** Estado curto de um destino para menus e mural: conectado ou não, e se a HQ publica por ele. */
export function destinationState(a: SocialAccount): string {
  if (a.status === 'manual') return a.declared?.confirmed ? 'manual · você publica no site' : a.declared?.toCreate ? 'manual · conta a criar' : 'manual · conta a confirmar';
  if (a.status === 'needs_app' || a.status === 'not_connected') return a.declared?.confirmed ? 'não conectada · você publica no site' : 'não conectada';
  if (a.status === 'expired') return 'reconectar';
  if (a.status === 'error') return 'falha na verificação';
  return a.capabilities.publish.hqReady ? 'conectada · a HQ publica texto' : 'conectada · a HQ prepara, você posta';
}
/** Texto do pedido para mostrar: sem a invocação da skill, sem marcadores e sem a lista de contexto anexada pela HQ. */
export function displayPrompt(prompt: string): string {
  return prompt
    .replace(/\n\nArquivos de contexto escolhidos pelo Chefe[\s\S]*$/, '')
    .replace(/^\/[\w:.-]+\s+/, '')
    .replace(/\[Destino: [^\]]+\]\s*/i, '')
    .replace(/^\[Planejar antes\][^\n]*\n\n/, '')
    .trim();
}

export type BoardColumn = 'fila' | 'producao' | 'revisar' | 'revisado' | 'falhou';
export const BOARD_COLUMNS: { id: BoardColumn; label: string; hint: string }[] = [
  { id: 'fila', label: 'Na fila', hint: 'esperando a vez' },
  { id: 'producao', label: 'Em produção', hint: 'um funcionário está trabalhando ou esperando você' },
  { id: 'revisar', label: 'Para revisar', hint: 'conteúdo preparado; falta a sua revisão' },
  { id: 'revisado', label: 'Pronto para postar', hint: 'você aprovou; postar é com você, fora da HQ (nada foi publicado)' },
  { id: 'falhou', label: 'Falhou', hint: 'terminou com erro ou foi interrompido' },
];
export function columnOf(t: Task): BoardColumn {
  if (t.status === 'queued') return 'fila';
  if (t.status === 'running' || t.status === 'waiting_permission' || t.status === 'waiting_answer') return 'producao';
  if (t.status === 'done') return t.review === 'verified' ? 'revisado' : 'revisar';
  return 'falhou';
}

/** Tarefas da sala (pelas conversas dela) e, se houver, só do perfil editorial escolhido. Mais recentes primeiro. */
export function roomTasks(tasks: Task[], sessions: Session[], roomId: string | null, profileId: string | null): Task[] {
  if (!roomId) return [];
  const sids = new Set(sessions.filter(s => s.roomId === roomId).map(s => s.id));
  return tasks.filter(t => (sids.has(t.sessionId) || t.roomId === roomId) && (!profileId || (t.profileId ?? null) === profileId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function boardCounts(tasks: Task[]): { queued: number; producing: number; review: number; ready: number } {
  let queued = 0, producing = 0, review = 0, ready = 0;
  for (const t of tasks) { const c = columnOf(t); if (c === 'fila') queued++; else if (c === 'producao') producing++; else if (c === 'revisar') review++; else if (c === 'revisado') ready++; }
  return { queued, producing, review, ready };
}

// ---------------- peça de conteúdo: arquivos entregues, prévia e legenda ----------------
export type PieceKind = 'text' | 'image' | 'video' | 'other';
const EXT: Record<string, PieceKind> = {
  md: 'text', markdown: 'text', txt: 'text', csv: 'text', json: 'text', srt: 'text', vtt: 'text', html: 'text', yml: 'text', yaml: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', m4v: 'video', avi: 'video',
};
export function pieceKind(path: string): PieceKind { const m = /\.([a-z0-9]+)$/i.exec(path); return (m && EXT[m[1].toLowerCase()]) || 'other'; }

/** Arquivos da peça, relativos ao projeto: os entregues (criados/alterados) e, sem eles, os tocados. Texto e mídia primeiro. */
export function pieceFiles(t: Task, projectPath: string | null): { rel: string; abs: string; kind: PieceKind }[] {
  if (!projectPath) return [];
  const fromDeliv = (t.deliverables ?? []).filter(d => d.kind === 'file' && d.path && d.changeType !== 'deleted').map(d => d.path!);
  const src = fromDeliv.length ? fromDeliv : (t.touchedFiles ?? []);
  const seen = new Set<string>(); const out: { rel: string; abs: string; kind: PieceKind }[] = [];
  for (const abs of src) {
    const rel = relativeToProject(projectPath, abs); if (!rel) continue;
    const key = rel.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    out.push({ rel, abs, kind: pieceKind(rel) });
  }
  const rank: Record<PieceKind, number> = { text: 0, image: 1, video: 2, other: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** Legenda dentro do texto entregue: seção "Legenda"/"Caption"/"Texto do post" (título ou rótulo com dois-pontos) até o próximo título. */
export function captionOf(md: string): string | null {
  const lines = md.split(/\r?\n/);
  const isBreak = (l: string) => /^\s{0,3}#{1,6}\s/.test(l) || /^\s{0,3}(---|\*\*\*|___)\s*$/.test(l) || /^\s{0,3}\*\*[^*]+:\*\*\s*$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const plain = lines[i].replace(/\*\*|__/g, '').trim();
    const m = /^(#{1,6}\s*)?(legenda|caption|texto do post)\b([^:\n]*)(:?)\s*(.*)$/i.exec(plain);
    if (!m || (!m[1] && !m[4])) continue;
    const body: string[] = m[5] ? [m[5]] : [];
    for (let j = i + 1; j < lines.length && !isBreak(lines[j]); j++) body.push(lines[j]);
    const text = body.join('\n').trim();
    if (text) return text;
  }
  return null;
}

/** Peças de vídeo da sala (estúdio): pedidas com a skill de vídeo, com arquivo de vídeo entregue ou que falam de vídeo no pedido. */
export const VIDEO_SKILL = 'milweb-video-studio';
export function isVideoTask(t: Task): boolean {
  if (t.skill?.requested?.replace(/^\//, '') === VIDEO_SKILL) return true;
  if ((t.deliverables ?? []).some(d => d.path && pieceKind(d.path) === 'video')) return true;
  // \b não funciona com acento ("vídeo"): a fronteira é feita à mão
  return /(^|[^\p{L}])(v[ií]deos?|reels?|tiktok|shorts?|roteiros?)($|[^\p{L}])/iu.test(displayPrompt(t.prompt));
}

/** Mesa do Chefe: o que espera por ele agora (respostas a dar e entregas a revisar). */
export function waitingForChefe(tasks: Task[]): { needsAnswer: Task[]; toReview: Task[] } {
  return {
    needsAnswer: tasks.filter(t => t.status === 'waiting_permission' || t.status === 'waiting_answer'),
    toReview: tasks.filter(t => (t.status === 'done' && t.review !== 'verified') || t.review === 'to_verify'),
  };
}

/** Quem pode sentar à mesa de reunião agora, com o motivo honesto de cada estado. */
export function meetingAvailability(ai: AiProviderStatus[]): { name: string; ok: boolean; detail: string }[] {
  const name = (p: AiProviderStatus) => (p.provider === 'claude' ? 'Claude' : 'ChatGPT');
  return ai.map(p => {
    if (!p.installed) return { name: name(p), ok: false, detail: `${p.routeLabel ?? p.label} não instalado` };
    if (p.authState !== 'ok') return { name: name(p), ok: false, detail: 'sem login' };
    if (p.provider === 'openai' && !p.lastTest?.ok) return { name: name(p), ok: true, detail: 'login ok; resposta real pela HQ ainda não validada' };
    return { name: name(p), ok: true, detail: 'disponível' };
  });
}

/** Peça do calendário a que a tarefa pertence: a produção ou a revisão gravam na pasta da peça (marcas/<marca>/pecas/<slug>).
 *  Também vale para rodadas antigas (a peça guarda só a última tarefa). Null quando a tarefa não é de uma peça (Radar, avulsa). */
export function pieceOfTask(items: ContentItem[], t: Task): ContentItem | null {
  const byTask = items.find(i => i.taskId === t.id || i.reviewTaskId === t.id);
  if (byTask) return byTask;
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const files = [...(t.deliverables ?? []).filter(d => d.kind === 'file' && d.path).map(d => d.path!), ...(t.touchedFiles ?? [])].map(norm);
  if (!files.length) return null;
  return items.find(i => i.folder && i.status !== 'descartada' && files.some(f => f.startsWith(norm(i.folder!) + '\\'))) ?? null;
}
