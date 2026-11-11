// Referência de vídeo no campo de pedido: ao colar um link de vídeo (ou arrastar/anexar um vídeo), aparece o cartão com
// "O que gostei" (opcional), o perfil e os dois caminhos. "Analisar com a equipe" não produz nem posta; "Analisar e
// produzir" segue para a produção com a direção recomendada. Uma instrução no texto ("quero um vídeo inspirado neste para o
// Tuco Dev") já deixa o segundo caminho como sugerido. Vários links no mesmo pedido ("igual a este", "pode ser este
// áudio", "neste estilo") viram UMA referência: o primeiro é a base e cada outro leva o papel que o texto deu a ele.
// O botão principal do campo (Executar / Ctrl+Enter) usa este mesmo caminho quando há link de vídeo: em 05/11 o pedido do
// Chefe com três links foi pelo envio comum, virou conversa com o pesquisador e voltou só com o roteiro.
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { SocialSlotId, VideoRefRole } from '@milweb-hq/protocol';

export type ExtraRole = Exclude<VideoRefRole, 'base'>;
export interface VideoRefSend { url: string | null; file: File | null; liked: string | null; mode: 'analise' | 'produzir' | 'estudo'; instruction: string | null; slot: SocialSlotId | null; extras: { url: string; role: ExtraRole; note: string | null }[] }
export interface VideoRefComposerApi {
  send(input: VideoRefSend): Promise<{ reused: boolean; mode: string }>;
  /** Destinos no foco (os únicos que recebem produção). */
  slots: { id: SocialSlotId; label: string }[];
  /** Destino sugerido pelo perfil escolhido no topo. */
  defaultSlot: SocialSlotId | null;
  /** Abre a Mesa (onde o cartão da referência acompanha o progresso). */
  openDesk(): void;
}
/** O botão principal do campo chama o envio deste painel. */
export interface VideoRefControl { go(): Promise<void> }

const LINK = /https?:\/\/[^\s<>"']+/gi;
/** Link de post com vídeo (Instagram, TikTok, YouTube, X, Reddit, Threads, Vimeo, Facebook). Link de artigo segue o envio comum. */
export const VIDEO_LINK = /(tiktok\.com\/|instagram\.com\/(reel|reels|p|tv)\/|youtube\.com\/(watch|shorts)|youtu\.be\/|(x|twitter)\.com\/[^/\s]+\/status\/|reddit\.com\/r\/[^/\s]+\/comments\/|v\.redd\.it\/|vimeo\.com\/\d|facebook\.com\/[^\s]*videos?\/|fb\.watch\/|threads\.(net|com)\/@[^/\s]+\/post\/)/i;
const clean = (u: string) => u.replace(/[).,;!?]+$/, '');

/** Primeiro link do texto e o resto como instrução. */
export function splitLink(text: string): { url: string | null; instruction: string | null } {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return { url: null, instruction: text.trim() || null };
  const url = clean(m[0]);
  const rest = text.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  return { url, instruction: rest || null };
}

/** Papel pelo que o Chefe escreveu junto do link ("pode ser esse áudio", "esse estilo o vídeo"). */
export function roleOf(note: string | null): ExtraRole {
  const t = (note ?? '').toLowerCase();
  // Fronteira por letra (inclui as acentuadas): o \b do JavaScript não vê o "á" de "áudio" como letra.
  if (/(?<!\p{L})([áa]udio|som|m[úu]sica|trilha|voz|sound)(?!\p{L})/u.test(t)) return 'audio';
  if (/(?<!\p{L})(estilo|edi[çc][ãa]o|visual|anima[çc][ãa]o|formato|jeito|style)(?!\p{L})/u.test(t)) return 'estilo';
  return 'referencia';
}

export interface ParsedLink { url: string; role: VideoRefRole; note: string | null }
/**
 * Todos os links de vídeo do texto, com o papel de cada um, e a instrução (o texto com cada link trocado por "[vídeo N]",
 * para a equipe saber de qual se fala). A nota de um link é o trecho curto logo depois dele (ou logo antes, se o de depois
 * for longo). A base é o primeiro link sem papel de áudio ou estilo.
 */
export function parseLinks(text: string): { links: ParsedLink[]; instruction: string | null } {
  const ms = [...text.matchAll(LINK)].map(m => ({ raw: m[0], url: clean(m[0]), start: m.index!, end: m.index! + m[0].length })).filter(m => VIDEO_LINK.test(m.url));
  if (!ms.length) return { links: [], instruction: text.trim() || null };
  const trim = (s: string) => s.replace(/^[\s.,;:!?)\-–]+|[\s.,;:!?(\-–]+$/g, '').trim();
  const raw = ms.map((m, i) => {
    const after = trim(text.slice(m.end, ms[i + 1]?.start ?? text.length));
    const before = trim(text.slice(ms[i - 1]?.end ?? 0, m.start));
    const note = after && after.length <= 80 ? after : before && before.length <= 80 ? before : null;
    return { url: m.url, note, role: roleOf(note) as VideoRefRole };
  });
  const base = Math.max(0, raw.findIndex(l => l.role === 'referencia'));
  raw[base] = { ...raw[base], role: 'base', note: null };
  const links = [raw[base], ...raw.filter((_, i) => i !== base)];
  if (links.length === 1) return { links, instruction: splitLink(text.replace(ms[0].raw, ms[0].url)).instruction };
  let instruction = text;
  for (const m of [...ms].reverse()) instruction = `${instruction.slice(0, m.start)} [vídeo ${links.findIndex(l => l.url === m.url) + 1}] ${instruction.slice(m.end)}`;
  return { links, instruction: instruction.replace(/\s+/g, ' ').trim() || null };
}

/** Instrução que pede produção ("quero um vídeo inspirado neste", "faz uma versão nossa"). Só o link fica na análise. */
export const PRODUCE_INTENT = /\b(quero|queria|faz(e|er)?|fa[çc]a|cria(r)?|produz(ir|a)?|monta(r)?|gera(r)?)\b.{0,40}\b(v[íi]deo|reel|vers[aã]o|pe[çc]a)\b|inspirad[oa] (n|ness)[eoa]/i;

/** "Estudem esse vídeo", "aprendam essa técnica": Academia de Vídeo (07/11). */
export const STUDY_INTENT = /(?<!\p{L})(estud(a|e|em|ar)|aprend(a|e|er|am)|ensin(a|e|ar)|trein(a|e|ar|em)|academia)(?!\p{L})/iu;

/** Há referência de vídeo no campo (link de vídeo ou arquivo) e o texto pede produção? Usado pelo botão principal. */
export function videoIntent(text: string, file: File | null): { active: boolean; produce: boolean } {
  const { links, instruction } = parseLinks(text);
  return { active: Boolean(file) || links.length > 0, produce: Boolean(instruction && PRODUCE_INTENT.test(instruction)) };
}

/** Destino pela instrução ("para o Tuco Dev"). */
export function slotFromText(text: string | null): SocialSlotId | null {
  const t = (text ?? '').toLowerCase();
  return /tuco/.test(t) ? 'instagram-tuco' : /threads/.test(t) ? 'threads' : /aurora/.test(t) ? 'instagram-aurora' : null;
}

const ROLE_OPTIONS: { id: VideoRefRole; label: string }[] = [
  { id: 'base', label: 'base (o que adaptar)' }, { id: 'audio', label: 'áudio' }, { id: 'estilo', label: 'estilo do vídeo' }, { id: 'referencia', label: 'outra referência' },
];

export function VideoRefComposer({ text, file, api, onDone, onClearFile, onPickFile, control, onPlainTask, plainLabel }: {
  text: string; file: File | null; api: VideoRefComposerApi; onDone(msg: string): void; onClearFile(): void; onPickFile(f: File): void;
  control?: MutableRefObject<VideoRefControl | null>;
  /** Mandar o texto como tarefa comum para o funcionário escolhido (sem o fluxo de referência). */
  onPlainTask?: (() => void) | null; plainLabel?: string | null;
}) {
  const parsed = parseLinks(text);
  const [liked, setLiked] = useState('');
  const [slot, setSlot] = useState<SocialSlotId | ''>('');
  const [roles, setRoles] = useState<Record<string, VideoRefRole>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement | null>(null);
  // Papel trocado pelo Chefe vale sobre o lido do texto; só uma base.
  const links: ParsedLink[] = parsed.links.map(l => ({ ...l, role: roles[l.url] ?? l.role }));
  const chosenBase = links.find(l => roles[l.url] === 'base') ?? links.find(l => l.role === 'base') ?? links.find(l => l.role === 'referencia') ?? links[0] ?? null;
  const ordered: ParsedLink[] = chosenBase ? [{ ...chosenBase, role: 'base' }, ...links.filter(l => l !== chosenBase).map(l => ({ ...l, role: (l.role === 'base' ? 'referencia' : l.role) as VideoRefRole }))] : [];
  const url = file ? null : chosenBase?.url ?? null;
  const extras = (file ? ordered : ordered.slice(1)).map(l => ({ url: l.url, role: (l.role === 'base' ? 'referencia' : l.role) as ExtraRole, note: l.note }));
  const instruction = parsed.instruction;
  const wantsStudy = Boolean(instruction && STUDY_INTENT.test(instruction));
  const wantsProduce = !wantsStudy && Boolean(instruction && PRODUCE_INTENT.test(instruction));
  const chosen = (slot || slotFromText(instruction) || api.defaultSlot) as SocialSlotId | null;
  const go = async (mode: 'analise' | 'produzir' | 'estudo') => {
    if (busy) return;
    setBusy(mode); setError(null);
    try {
      if (mode === 'produzir' && !chosen) throw new Error('Escolha o perfil da versão (Tuco Dev ou Aurora) no seletor ao lado e mande de novo.');
      const r = await api.send({ url, file, liked: liked.trim() || null, mode, instruction, slot: chosen, extras });
      setLiked(''); setRoles({});
      onDone(`${r.reused ? 'Essa referência já estava na Mesa: o mesmo cartão foi atualizado' : 'Referência recebida'}${extras.length ? ` com mais ${extras.length} vídeo(s) (${extras.map(x => ROLE_OPTIONS.find(o => o.id === x.role)!.label).join(', ')})` : ''}. ${r.mode === 'estudo' ? 'O Diretor de Vídeo estuda, dá a aula e passa os exercícios; o aprendizado fica na Academia de Vídeo.' : r.mode === 'produzir' ? 'A equipe analisa, discute e produz a versão; o resultado chega na Mesa.' : 'A equipe analisa e discute; produzir só se você mandar ("Produzir esta versão").'}`);
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  };
  useEffect(() => {
    if (!control) return;
    control.current = { go: () => go(wantsStudy ? 'estudo' : wantsProduce ? 'produzir' : 'analise') };
    return () => { control.current = null; };
  });
  if (!url && !file) {
    return (
      <div className="hq-vref hq-vref--idle">
        <button type="button" className="hq-linkbtn" onClick={() => pick.current?.click()}>Anexar vídeo de referência</button>
        <span className="hq-dim"> ou cole o link de um vídeo (Instagram, TikTok, X, Reddit…) no campo acima</span>
        <input ref={pick} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onPickFile(f); e.target.value = ''; }} />
      </div>
    );
  }
  return (
    <div className="hq-vref" role="group" aria-label="Referência de vídeo">
      {file && <p className="hq-vref__what"><strong>Referência de vídeo:</strong> {file.name} <button type="button" className="hq-linkbtn" onClick={onClearFile}>tirar</button></p>}
      {!file && ordered.length === 1 && <p className="hq-vref__what"><strong>Referência de vídeo:</strong> <span className="hq-vref__url" title={url!}>{url}</span></p>}
      {(file ? ordered.length > 0 : ordered.length > 1) && (
        <div className="hq-vref__links">
          <p className="hq-vref__what"><strong>{file ? 'Vídeo anexado + links' : `${ordered.length} vídeos no pedido`}:</strong> <span className="hq-dim">confira o papel de cada um</span></p>
          <ol className="hq-vref__list">
            {ordered.map((l, k) => (
              <li key={l.url}>
                <span className="hq-tag hq-tag--xs">vídeo {k + (file ? 2 : 1)}</span>{' '}
                <select className="hq-select hq-select--sm" value={file && l.role === 'base' ? 'referencia' : l.role} aria-label={`Papel do vídeo ${k + 1}`}
                  onChange={e => { const v = e.target.value as VideoRefRole; setRoles(r => { const next = { ...r }; if (v === 'base') for (const x of ordered) if (next[x.url] === 'base') next[x.url] = 'referencia'; next[l.url] = v; return next; }); }}>
                  {ROLE_OPTIONS.filter(o => !(file && o.id === 'base')).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>{' '}
                <span className="hq-vref__url" title={l.url}>{l.url}</span>
                {l.note && <span className="hq-dim"> · "{l.note}"</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="hq-vref__row">
        <input className="hq-input hq-input--sm" value={liked} onChange={e => setLiked(e.target.value)} placeholder="O que gostei neste vídeo (opcional): animação, humor, abertura, 00:12–00:18…" aria-label="O que gostei neste vídeo" />
        <select className={`hq-select hq-select--sm${wantsProduce && !chosen ? ' hq-select--need' : ''}`} value={slot || (chosen ?? '')} onChange={e => setSlot(e.target.value as SocialSlotId | '')} aria-label="Perfil da versão">
          <option value="">perfil: a equipe sugere</option>
          {api.slots.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
      <div className="hq-actions">
        <button type="button" className={`hq-btn hq-btn--sm${wantsStudy ? ' hq-btn--primary' : ''}`} disabled={busy !== null} onClick={() => void go('estudo')} title="O Diretor de Vídeo analisa, dá a aula, passa exercícios e guarda na Academia de Vídeo. Não vira post.">{busy === 'estudo' ? 'Enviando…' : 'Estudar a técnica'}</button>
        <button type="button" className={`hq-btn hq-btn--sm${wantsProduce || wantsStudy ? '' : ' hq-btn--primary'}`} disabled={busy !== null} onClick={() => void go('analise')} title="A equipe inspeciona, analisa e discute. Não produz nem posta.">{busy === 'analise' ? 'Enviando…' : 'Analisar com a equipe'}</button>
        <button type="button" className={`hq-btn hq-btn--sm${wantsProduce ? ' hq-btn--primary' : ''}`} disabled={busy !== null} onClick={() => void go('produzir')} title="Analisa, discute e produz a versão recomendada; o vídeo chega na Mesa para revisar (nada é publicado).">{busy === 'produzir' ? 'Enviando…' : 'Analisar e produzir'}</button>
        <button type="button" className="hq-linkbtn" onClick={api.openDesk}>ver na Mesa</button>
        {onPlainTask && <button type="button" className="hq-linkbtn" disabled={busy !== null} onClick={onPlainTask} title="Sem inspeção, reunião nem produção: só uma conversa com o funcionário escolhido">{plainLabel ?? 'mandar como conversa comum'}</button>}
      </div>
      {wantsProduce && <p className="hq-dim">O seu texto pede um vídeo: "Analisar e produzir" é o caminho (o Executar também segue por ele){chosen ? ` · perfil ${api.slots.find(s => s.id === chosen)?.label ?? chosen}` : ' · escolha o perfil'}.</p>}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
    </div>
  );
}
