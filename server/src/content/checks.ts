// Verificações automáticas: o que a HQ consegue conferir sozinha numa entrega (arquivos, tamanho do texto pela regra da rede,
// links respondendo, Pin renderizado) e a conferência de um post publicado à mão (oEmbed público quando a rede oferece).
// Cada verificação diz exatamente o que foi medido; o que a HQ não consegue conferir fica dito como tal.
import fs from 'node:fs';
import path from 'node:path';
import type { ContentCheck, ContentItem, SocialNetwork, SocialSlotId } from '@milweb-hq/protocol';
import { SOCIAL_POST_HOSTS, slotDef } from '@milweb-hq/protocol';

export const SLOT_SKILL: Record<SocialSlotId, string> = {
  'instagram-aurora': 'rede-instagram', 'instagram-tuco': 'rede-instagram', threads: 'rede-threads', tiktok: 'rede-tiktok',
  linkedin: 'rede-linkedin', x: 'rede-x', pinterest: 'rede-pinterest',
};

export interface Entrega {
  itemId: string | null;
  network: SocialNetwork | null;
  files: string[];
  text: string;
  title: string | null;
  description: string | null;
  board: string | null;
  destinationUrl: string | null;
  translation: string | null;
  sources: { url: string; what: string }[];
  needs: string[];
  nextStep: string | null;
}

const str = (v: unknown, max = 20_000): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const NETWORKS: SocialNetwork[] = ['instagram', 'threads', 'tiktok', 'linkedin', 'x', 'pinterest'];

export function parseEntrega(raw: unknown): { ok: true; value: Entrega } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'entrega.json não é um objeto JSON' };
  const o = raw as Record<string, unknown>;
  const text = str(o.text);
  if (!text) return { ok: false, error: 'entrega.json sem "text" (o texto exato a publicar)' };
  const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string' && Boolean(f.trim())).slice(0, 40) : [];
  const sources = Array.isArray(o.sources) ? o.sources.flatMap(x => {
    if (typeof x === 'string' && /^https?:\/\//i.test(x)) return [{ url: x.trim(), what: '' }];
    if (x && typeof x === 'object' && typeof (x as { url?: unknown }).url === 'string' && /^https?:\/\//i.test((x as { url: string }).url)) return [{ url: (x as { url: string }).url.trim(), what: str((x as { what?: unknown }).what, 400) ?? '' }];
    return [];
  }).slice(0, 30) : [];
  const network = NETWORKS.includes(o.network as SocialNetwork) ? o.network as SocialNetwork : null;
  return {
    ok: true,
    value: {
      itemId: str(o.itemId, 80), network, files, text, title: str(o.title, 400), description: str(o.description, 4000), board: str(o.board, 200),
      destinationUrl: str(o.destinationUrl, 600), translation: str(o.translation), sources,
      needs: Array.isArray(o.needs) ? o.needs.filter((x): x is string => typeof x === 'string').map(x => x.slice(0, 300)).slice(0, 20) : [],
      nextStep: str(o.nextStep, 600),
    },
  };
}

/** Contagem do X: cada link vale 23 caracteres (encurtador t.co); o resto conta por caractere. Aproximação documentada:
 *  a regra oficial dá peso 2 a alguns alfabetos (CJK), irrelevante para notas em inglês. */
export function xLength(text: string): number {
  let n = 0;
  const parts = text.split(/(https?:\/\/\S+)/gi);
  for (const p of parts) n += /^https?:\/\//i.test(p) ? 23 : [...p].length;
  return n;
}

/** Limites de texto que a HQ confere por rede (fonte de cada número no comentário). */
export function textLimit(network: SocialNetwork): { max: number; label: string; count(t: string): number } | null {
  switch (network) {
    case 'x': return { max: 280, label: 'até 280 na contagem do X (link = 23)', count: xLength };
    case 'threads': return { max: 500, label: 'até 500 caracteres (limite da API do Threads)', count: t => [...t].length };
    case 'linkedin': return { max: 3000, label: 'até 3.000 caracteres (limite usado na publicação de texto)', count: t => [...t].length };
    case 'instagram': return { max: 2200, label: 'até 2.200 caracteres na legenda (reconfirmar no app)', count: t => [...t].length };
    case 'pinterest': return { max: 800, label: 'descrição até 800 caracteres (página oficial)', count: t => [...t].length };
    default: return null;
  }
}

export type Fetcher = typeof fetch;

async function probeUrl(f: Fetcher, url: string, timeoutMs = 10_000): Promise<{ ok: boolean; status: number | null; finalUrl: string | null; error: string | null }> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await f(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'MilWebHQ/1.0 (conferencia de links)', accept: 'text/html,application/json;q=0.9,*/*;q=0.8' } });
    clearTimeout(t);
    try { await res.body?.cancel(); } catch { /* corpo não interessa */ }
    return { ok: res.status < 400, status: res.status, finalUrl: res.url || url, error: null };
  } catch (err) {
    return { ok: false, status: null, finalUrl: null, error: (err as Error).name === 'AbortError' ? 'tempo esgotado' : 'sem resposta' };
  }
}

/** Largura e altura de um PNG (cabeçalho IHDR). */
export function pngSize(file: string): { w: number; h: number } | null {
  try {
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(24); fs.readSync(fd, b, 0, 24, 0); fs.closeSync(fd);
    if (b.toString('ascii', 1, 4) !== 'PNG') return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch { return null; }
}

export async function checkPiece(item: ContentItem, e: Entrega, folder: string, f: Fetcher, root: string | null = null): Promise<ContentCheck[]> {
  const out: ContentCheck[] = [];
  const network = item.slot ? slotDef(item.slot).network : e.network;
  // Arquivos citados na entrega existem?
  // Caminho relativo à pasta da peça ou à pasta de conteúdo (imagens reaproveitadas de outra peça), ou absoluto.
  const missing = e.files.filter(x => !(path.isAbsolute(x) ? [x] : [path.join(folder, x), root ? path.join(root, x) : null]).some(t => t && fs.existsSync(t)));
  out.push({ name: 'Arquivos da entrega', ok: e.files.length > 0 && missing.length === 0, detail: e.files.length === 0 ? 'a entrega não lista arquivos' : missing.length ? `faltam: ${missing.join(', ')}` : `${e.files.length} arquivo(s) encontrados` });
  // Tamanho do texto pela regra da rede.
  if (network) {
    const lim = textLimit(network);
    const body = network === 'pinterest' ? (e.description ?? e.text) : e.text;
    if (lim) { const c = lim.count(body); out.push({ name: 'Tamanho do texto', ok: c <= lim.max, detail: `${c} de ${lim.label}` }); }
    if (network === 'pinterest') {
      const tl = e.title ? [...e.title].length : 0;
      out.push({ name: 'Título do Pin', ok: tl > 0 && tl <= 100, detail: e.title ? `${tl} de até 100 caracteres` : 'sem título' });
      const png = path.join(folder, 'pin.png'); const size = pngSize(png);
      out.push({ name: 'Imagem do Pin', ok: Boolean(size), detail: size ? `pin.png ${size.w}×${size.h}${size.w * 3 === size.h * 2 ? ' (2:3)' : ' (fora de 2:3)'}` : 'pin.png não gerado' });
      if (e.destinationUrl) {
        const p = await probeUrl(f, e.destinationUrl);
        const own = /^https:\/\/(www\.)?aurora.example\//i.test(e.destinationUrl);
        out.push({ name: 'URL de destino', ok: p.ok && own, detail: `${e.destinationUrl}: ${p.status ? `HTTP ${p.status}` : p.error}${own ? '' : ' (fora do domínio da Aurora)'}` });
      } else out.push({ name: 'URL de destino', ok: false, detail: 'sem URL de destino' });
    }
    if (network === 'x') out.push({ name: 'Tradução para revisão', ok: Boolean(e.translation), detail: e.translation ? 'presente (não publicar)' : 'falta a tradução em português' });
  }
  // Fontes respondem? (algumas bloqueiam robôs; isso fica dito, não vira "fonte falsa").
  if (e.sources.length) {
    const res = await Promise.all(e.sources.slice(0, 8).map(async s => ({ s, p: await probeUrl(f, s.url) })));
    const bad = res.filter(r => !r.p.ok);
    out.push({ name: 'Fontes respondem', ok: bad.length === 0, detail: bad.length ? `${res.length - bad.length}/${res.length}; sem resposta ou bloqueadas: ${bad.map(b => `${b.s.url} (${b.p.status ? 'HTTP ' + b.p.status : b.p.error})`).join('; ')}` : `${res.length}/${res.length} responderam` });
  } else if (network === 'x' && /nota|not[íi]cia|news|alerta|alert|release|atualiza/i.test(`${item.format} ${item.title}`)) out.push({ name: 'Fonte de origem', ok: false, detail: 'nota de notícia do X sem fonte de origem' });
  return out;
}

const stripHtml = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const norm = (t: string) => t.replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();

/** Confere um post publicado à mão. 'provedor' fica para a API; aqui é 'link' (encontrado) ou falha com o motivo. */
export async function verifyPost(network: SocialNetwork, url: string, expected: string | null, f: Fetcher): Promise<{ ok: boolean; detail: string }> {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return { ok: false, detail: 'link inválido' }; }
  if (u.protocol !== 'https:') return { ok: false, detail: 'o link precisa começar com https://' };
  const hosts = SOCIAL_POST_HOSTS[network];
  if (!hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return { ok: false, detail: `o link não é do ${network === 'x' ? 'X' : network} (${u.hostname})` };
  const oembed = network === 'x' ? `https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(u.href)}`
    : network === 'tiktok' ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(u.href)}`
      : null;
  if (oembed) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12_000);
      const res = await f(oembed, { signal: ctrl.signal, headers: { accept: 'application/json' } }); clearTimeout(t);
      if (res.status === 404 || res.status === 400) return { ok: false, detail: `a rede não encontrou este post (oEmbed HTTP ${res.status}); confira o link ou se o post é público` };
      if (!res.ok) return { ok: false, detail: `conferência pelo oEmbed falhou (HTTP ${res.status}); tente de novo mais tarde` };
      const j = await res.json() as { html?: string; title?: string; author_name?: string };
      const got = norm(stripHtml(j.html ?? '') + ' ' + (j.title ?? ''));
      const want = expected ? norm(expected).split(' ').slice(0, 8).join(' ') : '';
      const match = want ? got.includes(want) : null;
      const who = j.author_name ? ` de ${j.author_name}` : '';
      if (match === false) return { ok: false, detail: `post${who} encontrado, mas o texto não confere com a peça aprovada (início esperado: "${want}")` };
      return { ok: true, detail: `post${who} encontrado pelo oEmbed público${match ? '; o início do texto confere com a peça' : ''}` };
    } catch (err) {
      return { ok: false, detail: `sem resposta da conferência (${(err as Error).name === 'AbortError' ? 'tempo esgotado' : 'rede'}); a publicação fica pendente` };
    }
  }
  const p = await probeUrl(f, u.href);
  if (!p.ok) return { ok: false, detail: `o link não respondeu (${p.status ? `HTTP ${p.status}` : p.error}); a publicação fica pendente` };
  const final = p.finalUrl ? new URL(p.finalUrl) : u;
  if (/login|accounts\/login|authwall|checkpoint/i.test(final.pathname)) return { ok: true, detail: `o link existe no domínio da rede, mas a página pede login: o conteúdo não foi conferido pela HQ` };
  return { ok: true, detail: `o link respondeu HTTP ${p.status} no domínio da rede; o conteúdo não foi conferido (a rede não oferece conferência pública)` };
}
