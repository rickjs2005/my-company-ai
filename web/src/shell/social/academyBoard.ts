// Regras puras do "Compartilhar vídeo" e da Academia de Vídeo (07/11/2026), separadas para teste.
import type { AcademyStudy, AcademyTechnique, TechniqueCategory, VideoRefMode } from '@milweb-hq/protocol';

/** Plataformas aceitas pelo "Compartilhar vídeo" (pedido do Chefe): Reels, TikTok, YouTube e Shorts, X. Arquivo: MP4 e MOV. */
export const SHARE_PLATFORMS: { id: string; label: string; re: RegExp }[] = [
  { id: 'instagram', label: 'Instagram Reels', re: /^https?:\/\/(www\.)?instagram\.com\/(reels?|p|tv)\/[\w-]+/i },
  { id: 'tiktok', label: 'TikTok', re: /^https?:\/\/((www|vm|vt|m)\.)?tiktok\.com\//i },
  { id: 'shorts', label: 'YouTube Shorts', re: /^https?:\/\/(www\.|m\.)?youtube\.com\/shorts\/[\w-]+/i },
  { id: 'youtube', label: 'YouTube', re: /^https?:\/\/((www\.|m\.)?youtube\.com\/watch\?[^\s]*v=[\w-]+|youtu\.be\/[\w-]+)/i },
  { id: 'x', label: 'X', re: /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^/\s]+\/status\/\d+/i },
];
export const SHARE_FILE_TYPES = ['video/mp4', 'video/quicktime'];
export const SHARE_FILE_ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov';

export type ShareCheck = { ok: true; platform: string; warn: string | null } | { ok: false; error: string };

/** Confere o link colado: plataforma conhecida, outro site (a HQ tenta, com aviso) ou texto que não é link. */
export function checkShareLink(raw: string): ShareCheck {
  const url = raw.trim();
  if (!url) return { ok: false, error: 'Cole o link do vídeo ou escolha um arquivo MP4 ou MOV.' };
  if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: 'O link precisa começar com http:// ou https://.' };
  const p = SHARE_PLATFORMS.find(x => x.re.test(url));
  if (p) return { ok: true, platform: p.label, warn: p.id === 'instagram' || p.id === 'x' ? `${p.label} costuma pedir login para vídeo; se a HQ não conseguir abrir, ela avisa e você anexa o arquivo.` : null };
  return { ok: true, platform: 'outro site', warn: 'Este site não está na lista (Instagram, TikTok, YouTube, Shorts e X). A HQ tenta abrir; se não der, anexe o arquivo.' };
}

/** Arquivo escolhido: só MP4 e MOV (até 300 MB, o limite do servidor). */
export function checkShareFile(f: { name: string; type: string; size: number }): string | null {
  const ext = /\.(mp4|mov)$/i.test(f.name);
  if (!SHARE_FILE_TYPES.includes(f.type) && !ext) return 'Use um arquivo MP4 ou MOV.';
  if (f.size > 300_000_000) return 'Vídeo maior que 300 MB: corte o trecho que interessa e mande de novo.';
  return null;
}

/** "Estudem", "aprendam", "ensina": estudo na Academia; "quero um vídeo", "faz a nossa versão": produzir; só o link: analisar. */
const STUDY = /(?<!\p{L})(estud(a|e|em|ar)|aprend(a|e|er|am)|ensin(a|e|ar)|trein(a|e|ar|em)|academia)(?!\p{L})/iu;
const PRODUCE = /\b(quero|queria|faz(e|er)?|fa[çc]a|cria(r)?|produz(ir|a)?|monta(r)?|gera(r)?)\b.{0,40}\b(v[íi]deo|reel|vers[aã]o|pe[çc]a)\b|inspirad[oa] (n|ness)[eoa]/i;
export function suggestMode(text: string): VideoRefMode {
  return STUDY.test(text) ? 'estudo' : PRODUCE.test(text) ? 'produzir' : 'analise';
}

export const SHARE_MODES: { id: VideoRefMode; label: string; hint: string }[] = [
  { id: 'estudo', label: 'Estudar a técnica', hint: 'O Diretor de Vídeo analisa, dá a aula, passa exercícios e guarda o aprendizado na Academia. Não vira post.' },
  { id: 'analise', label: 'Analisar com a equipe', hint: 'O Diretor analisa e a equipe discute como adaptar. Produzir só se você mandar.' },
  { id: 'produzir', label: 'Fazer a nossa versão', hint: 'Analisa e já produz o Reel para a conta escolhida. Chega em "Esperando você".' },
];

/** Progresso do estudo em números (exercícios entregues, aprovados). */
export function studyProgress(st: AcademyStudy): { total: number; done: number; failed: number; ok: number; adjust: number; running: number } {
  const ex = st.exercises;
  return {
    total: ex.length, done: ex.filter(e => e.status === 'concluido').length, failed: ex.filter(e => e.status === 'falhou').length, running: ex.filter(e => e.status === 'em_producao').length,
    ok: ex.filter(e => e.feedback?.verdict === 'ok').length, adjust: ex.filter(e => e.feedback?.verdict === 'ajustar').length,
  };
}

/** Filtro da biblioteca: texto (nome, slug, resumo) e categoria. Observadas e com exercício aprovado primeiro. */
export function filterTechniques(list: AcademyTechnique[], q: string, cat: TechniqueCategory | ''): AcademyTechnique[] {
  const t = q.trim().toLowerCase();
  const score = (x: AcademyTechnique) => (x.sources.some(s => s.evidence === 'observado') ? 2 : 0) + (x.examples.some(e => e.verdict === 'ok') ? 1 : 0);
  return list
    .filter(x => (!cat || x.category === cat) && (!t || `${x.name} ${x.slug} ${x.summary}`.toLowerCase().includes(t)))
    .sort((a, b) => score(b) - score(a) || b.updatedAt - a.updatedAt);
}
