// Foco da sala (destinos ativos × fontes de pesquisa) e leitura das referências do Radar da gringa. Dois controles separados:
// pesquisar no TikTok, no X ou no Reddit não libera produção, agendamento nem publicação nessas redes. O foco fica gravado no
// banco (social_config 'content.focus'), então vale depois de reiniciar a HQ ou retomar a fila.
import type { DatabaseSync } from 'node:sqlite';
import type { ContentFocus, RadarExample, RadarInspected, RadarItem, RadarKind, RadarMetric, ResearchSource, ResearchSourceState, SocialSlotId } from '@milweb-hq/protocol';
import { FOCUS_EXPANSION_RULE, FOCUS_REASON_DEFAULT, RESEARCH_SOURCES, isSocialSlot } from '@milweb-hq/protocol';

const KEY = 'content.focus';
const SOURCES = RESEARCH_SOURCES.map(s => s.source);
const isSource = (v: unknown): v is ResearchSource => typeof v === 'string' && (SOURCES as string[]).includes(v);

/** Estado inicial das fontes (ligadas, acesso ainda não verificado). */
export function defaultSources(): ResearchSourceState[] {
  return SOURCES.map(source => ({ source, enabled: true, access: 'nao_verificada', detail: null, at: null }));
}

export function readFocus(db: DatabaseSync): ContentFocus {
  const row = db.prepare('SELECT value FROM social_config WHERE key=?').get(KEY) as { value: string } | undefined;
  let raw: Partial<ContentFocus> = {};
  try { raw = row ? JSON.parse(row.value) as Partial<ContentFocus> : {}; } catch { raw = {}; }
  const active = Array.isArray(raw.activeSlots) ? raw.activeSlots.filter(isSocialSlot) : null;
  const byKey = new Map((Array.isArray(raw.sources) ? raw.sources : []).filter(s => isSource(s?.source)).map(s => [s.source, s]));
  return {
    activeSlots: active,
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : FOCUS_REASON_DEFAULT,
    sources: defaultSources().map(d => { const s = byKey.get(d.source); return s ? { source: d.source, enabled: s.enabled !== false, access: ['acessada', 'parcial', 'bloqueada'].includes(String(s.access)) ? s.access : 'nao_verificada', detail: typeof s.detail === 'string' ? s.detail : null, at: typeof s.at === 'number' ? s.at : null } : d; }),
    expansion: FOCUS_EXPANSION_RULE,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
  };
}

export function writeFocus(db: DatabaseSync, f: ContentFocus): void {
  const v = JSON.stringify({ activeSlots: f.activeSlots, reason: f.reason, sources: f.sources, updatedAt: f.updatedAt });
  db.prepare('INSERT INTO social_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, v);
}

/** Destino liberado para produção, agendamento e publicação. Sem foco definido, todos continuam liberados (como antes). */
export function slotActive(f: ContentFocus, slot: SocialSlotId | null | undefined): boolean {
  if (!slot) return false;
  return f.activeSlots === null || f.activeSlots.includes(slot);
}

/**
 * Chave do post para não duplicar: o id quando a URL tem um (Instagram /p/ e /reel/, TikTok /video/, X /status/, Reddit
 * /comments/), senão a URL sem protocolo, www, m., parâmetros de rastreio, âncora e barra final.
 */
export function postKey(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url.trim())) return null;
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|old|new|vm|vt)\./, '');
  const p = u.pathname;
  let m: RegExpMatchArray | null;
  if (/(^|\.)instagram\.com$/.test(host) && (m = p.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/))) return `instagram:${m[1]}`;
  if (/(^|\.)tiktok\.com$/.test(host) && (m = p.match(/\/(?:video|photo)\/(\d+)/))) return `tiktok:${m[1]}`;
  if (/(^|\.)(x|twitter)\.com$/.test(host) && (m = p.match(/\/status(?:es)?\/(\d+)/))) return `x:${m[1]}`;
  if (/(^|\.)threads\.(com|net)$/.test(host) && (m = p.match(/\/post\/([A-Za-z0-9_-]+)/))) return `threads:${m[1]}`;
  if (/(^|\.)reddit\.com$/.test(host) && (m = p.match(/\/comments\/([a-z0-9]+)/i))) return `reddit:${m[1].toLowerCase()}`;
  if (host === 'redd.it' && (m = p.match(/^\/([a-z0-9]+)/i))) return `reddit:${m[1].toLowerCase()}`;
  if (/(^|\.)youtube\.com$/.test(host) && (m = p.match(/\/shorts\/([A-Za-z0-9_-]+)/) ?? (u.searchParams.get('v') ? [p, u.searchParams.get('v')!] as unknown as RegExpMatchArray : null))) return `youtube:${m[1]}`;
  const keep = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|igsh|igshid|si|s|t|ref|fbclid|gclid|mibextid|is_from_webapp|sender_device|_r|xmt)/i.test(k)).sort();
  const q = keep.length ? `?${keep.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  return `${host}${p.replace(/\/+$/, '') || '/'}${q}`.toLowerCase();
}

/** Plataforma pela URL (quando o pesquisador não disse). */
export function platformOf(url: string | null | undefined): string | null {
  const k = postKey(url ?? null); if (!k) return null;
  const m = k.match(/^(instagram|tiktok|x|threads|reddit|youtube):/); if (m) return m[1];
  if (/^(instagram|tiktok|threads|reddit)\./.test(k) || /^(x|twitter)\.com/.test(k)) return k.startsWith('twitter') ? 'x' : k.split('.')[0];
  return 'web';
}

const txt = (v: unknown, max = 4000): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const INSPECTED: RadarInspected[] = ['captura', 'imagem', 'texto', 'video_parcial', 'video_sem_audio', 'video_completo_audio'];
const KINDS: RadarKind[] = ['chefe', 'achado', 'padrao', 'hipotese'];

export type ParsedOpportunity = Omit<RadarItem, 'id' | 'roundId' | 'createdAt' | 'status' | 'itemId' | 'seen' | 'updatedAt'>;

/**
 * Uma oportunidade do oportunidades.json (contrato antigo ou o do Radar da gringa). Campos novos têm prioridade; os antigos
 * (signals, interpretation, proposal) são preenchidos a partir deles quando vierem só os novos. Sem link só vale para
 * referência do Chefe (com arquivo ou texto). Métrica sem número fica com valor null (indisponível), nunca zero.
 */
export function parseOpportunity(x: Record<string, unknown>, opts: { allowNoUrl?: boolean } = {}): { ok: true; value: ParsedOpportunity } | { ok: false; error: string } {
  const sourceUrl = txt(x.sourceUrl, 800);
  const kind: RadarKind = KINDS.includes(x.kind as RadarKind) ? x.kind as RadarKind : 'achado';
  if (!sourceUrl && !(opts.allowNoUrl && kind === 'chefe')) return { ok: false, error: 'sem link da publicação (sourceUrl)' };
  if (sourceUrl && !/^(https?:\/\/|chefe:\/\/)/i.test(sourceUrl)) return { ok: false, error: `link inválido (${sourceUrl.slice(0, 60)})` };
  const subject = txt(x.subject, 300); if (!subject) return { ok: false, error: 'sem assunto (subject)' };
  const consultedAt = txt(x.consultedAt, 60); if (!consultedAt) return { ok: false, error: 'sem data e hora da coleta (consultedAt)' };
  const evidence = ['referencia', 'tendencia', 'hipotese', 'nao_verificado'].includes(String(x.evidence)) ? x.evidence as RadarItem['evidence'] : null;
  if (!evidence) return { ok: false, error: 'grau de evidência inválido (evidence)' };
  // Padrão exige vários exemplos de criadores distintos; sem isso fica como achado pontual (nunca "tendência" por um post).
  const examples: RadarExample[] = (Array.isArray(x.examples) ? x.examples : []).flatMap(e => {
    const o = (e ?? {}) as Record<string, unknown>; const url = txt(o.url, 800);
    return url && /^https?:\/\//i.test(url) ? [{ url, author: txt(o.author, 120), platform: txt(o.platform, 30), metrics: txt(o.metrics, 300), sameVideo: o.sameVideo === true }] : [];
  }).slice(0, 12);
  const authors = new Set([txt(x.author, 120), ...examples.filter(e => !e.sameVideo).map(e => e.author)].filter(Boolean).map(a => String(a).toLowerCase()));
  let finalKind = kind; let finalEvidence = evidence;
  if (kind === 'padrao' && authors.size < 2) { finalKind = 'achado'; if (finalEvidence === 'tendencia') finalEvidence = 'referencia'; }
  if (evidence === 'tendencia' && finalKind !== 'padrao') finalEvidence = 'referencia';
  const metrics: RadarMetric[] = (Array.isArray(x.metrics) ? x.metrics : []).flatMap(m => {
    const o = (m ?? {}) as Record<string, unknown>; const name = txt(o.name, 60); if (!name) return [];
    return [{ name, value: typeof o.value === 'number' && Number.isFinite(o.value) ? o.value : null, raw: txt(o.raw, 40) }];
  }).slice(0, 10);
  const popularity = txt(x.popularity, 1000);
  const signals = txt(x.signals) ?? [popularity, metrics.length ? metrics.map(m => `${m.name}: ${m.raw ?? m.value ?? 'indisponível'}`).join(', ') : null].filter(Boolean).join(' · ');
  const interpretation = txt(x.interpretation) ?? txt(x.whyInteresting) ?? txt(x.summaryPt);
  const proposal = txt(x.proposal) ?? txt(x.adaptation);
  if (!signals) return { ok: false, error: 'sem sinal observado (popularity, metrics ou signals)' };
  if (!interpretation) return { ok: false, error: 'sem leitura (whyInteresting, summaryPt ou interpretation)' };
  if (!proposal) return { ok: false, error: 'sem proposta de adaptação (adaptation ou proposal)' };
  const window = ['24-48h', '7d', '30d', 'duravel'].includes(String(x.window)) ? x.window as RadarItem['window'] : x.window === 'antiga' ? 'duravel' : null;
  const inspected = INSPECTED.includes(x.inspected as RadarInspected) ? x.inspected as RadarInspected : null;
  const url = sourceUrl ?? '';
  return {
    ok: true,
    value: {
      sourceUrl: url, sourceName: txt(x.sourceName, 200), author: txt(x.author, 200), publishedAt: txt(x.publishedAt, 60), consultedAt, subject, signals,
      evidence: finalEvidence, window, slot: isSocialSlot(x.slot) ? x.slot : null, interpretation, proposal,
      priority: typeof x.priority === 'number' && [1, 2, 3].includes(x.priority) ? x.priority : null, reason: txt(x.reason, 1000), material: txt(x.material, 1000), extraCost: txt(x.extraCost, 200),
      kind: finalKind, postKey: txt(x.postId, 80) && platformOf(url) && platformOf(url) !== 'web' ? `${platformOf(url)}:${txt(x.postId, 80)}` : postKey(url),
      platform: txt(x.platform, 30)?.toLowerCase() ?? platformOf(url), language: txt(x.language, 20), region: txt(x.region, 200), metrics, inspected,
      observed: txt(x.observed, 3000), summaryPt: txt(x.summaryPt, 2000), context: txt(x.context, 1500), popularityLimit: txt(x.popularityLimit, 800), examples,
      format: txt(x.format, 40), fit: txt(x.fit, 1000), opening: txt(x.opening, 600), effort: txt(x.effort, 20), audio: txt(x.audio, 600),
      files: (Array.isArray(x.files) ? x.files : []).filter((f): f is string => typeof f === 'string').slice(0, 12), note: txt(x.note, 2000), video: null,
    },
  };
}

/** Cobertura por fonte declarada na rodada (só as quatro fontes; o resto é ignorado). */
export function parseSources(v: unknown, at: number): ResearchSourceState[] {
  return (Array.isArray(v) ? v : []).flatMap(raw => {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (!isSource(o.source)) return [];
    const access = o.state === 'acessada' || o.state === 'parcial' || o.state === 'bloqueada' ? o.state : 'nao_verificada';
    const queries = Array.isArray(o.queries) ? o.queries.filter((q): q is string => typeof q === 'string').slice(0, 8) : [];
    const detail = [txt(o.detail, 800), queries.length ? `buscas: ${queries.join('; ')}` : null].filter(Boolean).join(' · ') || null;
    return [{ source: o.source, enabled: true, access, detail, at }];
  });
}
