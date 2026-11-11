// Carrossel pronto para postar: o funcionário descreve os slides em carrossel.json (texto, tipo de slide, fonte) e a HQ desenha
// as imagens 1080×1350 na identidade da marca, com o Edge instalado (sem rede, sem conta, sem o funcionário rodar comando).
// Tuco Dev: papel marfim, tinta e tijolo (Fraunces, IBM Plex), a mesma direção do vídeo da Binance e do carrossel de 02/11/2026.
// Aurora: fundo quase preto, Marfim e Brasa, Inter 700-800, assinatura com aurora.example (references/brand.md da skill de vídeo).
// O texto é sempre do funcionário; a HQ só diagrama. Texto longo demais encolhe até 60% e, se ainda não couber, vira erro.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PngRenderer } from './render.js';

export const CAROUSEL_W = 1080;
export const CAROUSEL_H = 1350;
export const CAROUSEL_MIN_SLIDES = 2;
export const CAROUSEL_MAX_SLIDES = 10;
export const SLIDE_TYPES = ['capa', 'texto', 'imagem', 'lista', 'passos', 'comparacao', 'codigo', 'destaque', 'fechamento'] as const;
export type SlideType = typeof SLIDE_TYPES[number];
export type CarouselBrand = 'tuco-dev' | 'aurora';

export interface SlideItem { titulo: string; detalhe: string | null }
export interface Slide {
  tipo: SlideType;
  kicker: string | null;
  titulo: string;
  /** Palavra ou trecho do título em destaque (cor da marca); na capa vira a segunda linha grande. */
  destaque: string | null;
  texto: string | null;
  itens: SlideItem[];
  colunas: { titulo: string; itens: string[] }[];
  codigo: string | null;
  carimbo: string | null;
  cta: string | null;
  fonte: string | null;
  nota: string | null;
  /** Captura ou foto real (caminho relativo à pasta da peça, ou dentro da pasta de conteúdo). Prova de trabalho real (Aurora). */
  imagem: string | null;
  /** Rótulo pequeno da imagem (ex.: "site no ar, versão celular"). */
  imagemLegenda: string | null;
}
export interface Carousel { marca: CarouselBrand | null; slides: Slide[] }

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n/g, '\n').trim();
  return t ? t.slice(0, max) : null;
};

/** Valida o carrossel.json do funcionário. Erros em português, apontando o slide. */
export function parseCarousel(raw: unknown): { ok: true; value: Carousel } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'carrossel.json precisa ser um objeto com "slides"' };
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.slides) ? o.slides : null;
  if (!list) return { ok: false, error: 'carrossel.json sem a lista "slides"' };
  if (list.length < CAROUSEL_MIN_SLIDES || list.length > CAROUSEL_MAX_SLIDES) return { ok: false, error: `o carrossel precisa de ${CAROUSEL_MIN_SLIDES} a ${CAROUSEL_MAX_SLIDES} slides (veio ${list.length})` };
  const slides: Slide[] = [];
  for (const [i, r] of list.entries()) {
    const x = (r ?? {}) as Record<string, unknown>;
    const tipo = (SLIDE_TYPES as readonly string[]).includes(String(x.tipo)) ? x.tipo as SlideType : null;
    if (!tipo) return { ok: false, error: `slide ${i + 1}: tipo "${String(x.tipo)}" desconhecido (use ${SLIDE_TYPES.join(', ')})` };
    const titulo = str(x.titulo, 160);
    if (!titulo) return { ok: false, error: `slide ${i + 1}: falta o "titulo"` };
    const itens = Array.isArray(x.itens) ? x.itens.slice(0, 6).flatMap(it => {
      if (typeof it === 'string') { const t = str(it, 140); return t ? [{ titulo: t, detalhe: null }] : []; }
      const y = (it ?? {}) as Record<string, unknown>; const t = str(y.titulo, 140);
      return t ? [{ titulo: t, detalhe: str(y.detalhe, 220) }] : [];
    }) : [];
    const colunas = Array.isArray(x.colunas) ? x.colunas.slice(0, 2).flatMap(c => {
      const y = (c ?? {}) as Record<string, unknown>; const t = str(y.titulo, 60);
      const its = Array.isArray(y.itens) ? y.itens.flatMap(v => { const s = str(v, 120); return s ? [s] : []; }).slice(0, 5) : [];
      return t ? [{ titulo: t, itens: its }] : [];
    }) : [];
    const codigo = typeof x.codigo === 'string' && x.codigo.trim() ? x.codigo.replace(/\r\n/g, '\n').replace(/\t/g, '  ').split('\n').slice(0, 14).map(l => l.slice(0, 48)).join('\n') : null;
    if ((tipo === 'lista' || tipo === 'passos') && itens.length < 2) return { ok: false, error: `slide ${i + 1} (${tipo}): use de 2 a 6 "itens"` };
    if (tipo === 'comparacao' && colunas.length !== 2) return { ok: false, error: `slide ${i + 1} (comparacao): precisa de 2 "colunas" com titulo e itens` };
    if (tipo === 'codigo' && !codigo) return { ok: false, error: `slide ${i + 1} (codigo): falta o "codigo"` };
    const imagem = str(x.imagem, 400);
    if (tipo === 'imagem' && !imagem) return { ok: false, error: `slide ${i + 1} (imagem): falta o caminho em "imagem"` };
    if (imagem && !/\.(png|jpe?g|webp|gif)$/i.test(imagem)) return { ok: false, error: `slide ${i + 1}: "imagem" precisa ser .png, .jpg, .webp ou .gif` };
    slides.push({ tipo, titulo, itens, colunas, codigo, kicker: str(x.kicker, 60), destaque: str(x.destaque, 80), texto: str(x.texto, 420), carimbo: str(x.carimbo, 40), cta: str(x.cta, 80), fonte: str(x.fonte, 240), nota: str(x.nota, 120), imagem, imagemLegenda: str(x.imagemLegenda ?? x.imagem_legenda, 80) });
  }
  const marca = o.marca === 'tuco-dev' || o.marca === 'tuco' ? 'tuco-dev' : o.marca === 'aurora' ? 'aurora' : null;
  return { ok: true, value: { marca, slides } };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Título com o trecho em destaque marcado (sem diferenciar maiúsculas); o resto escapado. */
function marked(title: string, hl: string | null): string {
  if (!hl) return esc(title);
  const at = title.toLowerCase().indexOf(hl.toLowerCase());
  if (at < 0) return esc(title);
  return `${esc(title.slice(0, at))}<em class="hl">${esc(title.slice(at, at + hl.length))}</em>${esc(title.slice(at + hl.length))}`;
}
const para = (t: string) => esc(t).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

interface Ctx { n: number; total: number; brand: CarouselBrand; fonts: string; mascot: string | null; image: string | null }

/** Moldura da imagem real: janela de navegador (Aurora) ou foto colada com fita (Tuco). */
function figure(c: Ctx, legend: string | null, big: boolean): string {
  if (!c.image) return '';
  const h = big ? 640 : 470;
  if (c.brand === 'aurora') return `<figure class="shot" style="--h:${h}px"><div class="shot__bar"><i></i><i></i><i></i>${legend ? `<span>${esc(legend)}</span>` : ''}</div><img src="${c.image}"></figure>`;
  return `<figure class="shot" style="--h:${h}px"><div class="tape tape--shot"></div><img src="${c.image}">${legend ? `<figcaption>${esc(legend)}</figcaption>` : ''}</figure>`;
}

function fontFaces(dir: string): string {
  const u = (f: string) => pathToFileURL(path.join(dir, f)).href;
  return `
@font-face { font-family: 'Fraunces'; src: url('${u('Fraunces.ttf')}'); font-weight: 100 900; font-style: normal; }
@font-face { font-family: 'Fraunces'; src: url('${u('Fraunces-Italic.ttf')}'); font-weight: 100 900; font-style: italic; }
@font-face { font-family: 'IBM Plex Sans'; src: url('${u('IBMPlexSans.ttf')}'); font-weight: 100 700; }
@font-face { font-family: 'IBM Plex Mono'; src: url('${u('IBMPlexMono-Regular.ttf')}'); font-weight: 400; }
@font-face { font-family: 'IBM Plex Mono'; src: url('${u('IBMPlexMono-Medium.ttf')}'); font-weight: 500; }
@font-face { font-family: 'Inter'; src: url('${u('Inter.ttf')}'); font-weight: 100 900; }`;
}

// Tamanhos em px multiplicados por --s (o ajuste encolhe tudo junto quando o texto não cabe).
const BASE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${CAROUSEL_W}px; height: ${CAROUSEL_H}px; overflow: hidden; }
body { --s: 1; position: relative; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
.top { position: absolute; left: 90px; right: 90px; top: 66px; display: flex; justify-content: space-between; align-items: center; font-size: 24px; letter-spacing: .08em; text-transform: uppercase; }
.content { position: absolute; left: 90px; right: 90px; top: 150px; bottom: 140px; display: flex; flex-direction: column; justify-content: center; overflow: hidden; }
.content.top-al { justify-content: flex-start; }
.content.center { justify-content: center; }
.foot { position: absolute; left: 90px; right: 90px; bottom: 58px; font-size: 21px; line-height: 1.35; }
h1 { font-size: calc(var(--s) * 84px); line-height: 1.06; letter-spacing: -0.01em; }
h1.big { font-size: calc(var(--s) * 98px); }
.sub { font-size: calc(var(--s) * 34px); line-height: 1.38; margin-top: calc(var(--s) * 26px); }
.sub p + p { margin-top: calc(var(--s) * 18px); }
.items { display: flex; flex-direction: column; gap: calc(var(--s) * 40px); margin-top: calc(var(--s) * 54px); }
.item { display: flex; gap: 24px; align-items: flex-start; }
.item .t { font-size: calc(var(--s) * 50px); line-height: 1.12; }
.item .d { font-size: calc(var(--s) * 30px); line-height: 1.35; margin-top: 6px; }
.steps { display: flex; flex-direction: column; margin-top: calc(var(--s) * 44px); }
.step { padding: calc(var(--s) * 22px) 30px; display: flex; gap: 26px; align-items: center; }
.step .num { flex: none; width: calc(var(--s) * 64px); height: calc(var(--s) * 64px); display: flex; align-items: center; justify-content: center; font-size: calc(var(--s) * 30px); font-weight: 600; }
.step .t { font-size: calc(var(--s) * 42px); line-height: 1.15; }
.step .d { font-size: calc(var(--s) * 27px); line-height: 1.3; margin-top: 4px; }
.arrow { height: calc(var(--s) * 44px); display: flex; justify-content: center; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-top: calc(var(--s) * 50px); }
.col { padding: 30px; }
.col h2 { font-size: calc(var(--s) * 44px); line-height: 1.1; margin-bottom: 22px; }
.col li { list-style: none; font-size: calc(var(--s) * 30px); line-height: 1.3; padding: 12px 0; }
.code { margin-top: calc(var(--s) * 44px); padding: calc(var(--s) * 34px) 38px; font-family: 'IBM Plex Mono', Consolas, monospace; font-size: calc(var(--s) * 34px); line-height: 1.5; white-space: pre; }
.code .ln { opacity: .38; display: inline-block; width: 2.2ch; }
.stamp { display: inline-block; margin-top: calc(var(--s) * 60px); padding: 18px 34px; transform: rotate(-4deg); font-size: calc(var(--s) * 46px); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; align-self: flex-start; }
.mascot { position: absolute; object-fit: contain; }
.shot { position: relative; margin-top: calc(var(--s) * 34px); flex: none; }
/* Largura toda e proporção da captura; captura alta (página inteira) é cortada embaixo, nunca dos lados. */
.shot img { display: block; width: 100%; height: auto; max-height: calc(var(--s) * var(--h)); object-fit: cover; object-position: top center; }
`;

const TUCO_CSS = `
body { background: #F2ECDD; color: #22201C; font-family: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif;
  background-image: repeating-linear-gradient(180deg, transparent 0 61px, rgba(34,32,28,.07) 61px 62px), radial-gradient(circle at 18% 12%, rgba(255,255,255,.55), transparent 55%), radial-gradient(circle at 85% 90%, rgba(182,64,45,.06), transparent 50%); }
body::before { content: ''; position: absolute; left: 62px; top: 0; bottom: 0; width: 2px; background: rgba(182,64,45,.28); }
.top { font-family: 'IBM Plex Mono', Consolas, monospace; font-weight: 500; }
.top .n { font-weight: 400; color: rgba(34,32,28,.62); }
h1 { font-family: 'Fraunces', Georgia, serif; font-weight: 640; font-variation-settings: 'SOFT' 30, 'opsz' 144; }
.hl { color: #B6402D; font-style: italic; font-weight: 560; }
.capa-hl { display: block; font-family: 'Fraunces', Georgia, serif; font-style: italic; font-weight: 520; color: #B6402D; font-size: calc(var(--s) * 112px); line-height: 1.04; margin-top: 6px; }
.sub { color: rgba(34,32,28,.72); }
.sub b, .sub strong { color: #22201C; }
.item .bullet { flex: none; width: 18px; height: 18px; margin-top: calc(var(--s) * 20px); background: #B6402D; transform: rotate(45deg); }
.item .t { font-family: 'Fraunces', Georgia, serif; font-weight: 520; }
.item .d { color: rgba(34,32,28,.66); }
.step { border: 3px solid #22201C; background: #FBF8F0; }
.step .num { border: 3px solid #B6402D; color: #B6402D; border-radius: 50%; font-family: 'IBM Plex Mono', monospace; }
.step .t { font-family: 'Fraunces', Georgia, serif; font-weight: 520; }
.step .d { color: rgba(34,32,28,.66); }
.arrow svg path { stroke: #B6402D; }
.col { border: 3px solid #22201C; background: #FBF8F0; }
.col:last-child { background: rgba(182,64,45,.10); }
.col h2 { font-family: 'Fraunces', Georgia, serif; font-weight: 600; }
.col li { border-top: 2px dashed rgba(34,32,28,.22); }
.code { background: #FBF8F0; border: 3px solid #22201C; box-shadow: 10px 10px 0 rgba(34,32,28,.12); color: #22201C; }
.stamp { border: 6px double #B6402D; color: #B6402D; font-family: 'IBM Plex Mono', monospace; }
.foot { font-family: 'IBM Plex Mono', Consolas, monospace; color: rgba(34,32,28,.62); }
.mascot { filter: drop-shadow(8px 10px 0 rgba(34,32,28,.12)); }
.shot { width: calc(100% - 40px); margin-left: 20px; background: #FBF8F0; padding: 14px 14px 0; border: 1px solid rgba(34,32,28,.14); box-shadow: 10px 12px 0 rgba(34,32,28,.10); transform: rotate(-1deg); }
.shot figcaption { font-family: 'IBM Plex Mono', monospace; font-size: 20px; color: rgba(34,32,28,.62); padding: 10px 2px 12px; }
.shot:not(:has(figcaption)) { padding-bottom: 14px; }
.tape--shot { left: 50%; top: -18px; margin-left: -75px; transform: rotate(-3deg); z-index: 2; }
.tape { position: absolute; width: 150px; height: 40px; background: rgba(233,225,206,.85); border: 1px solid rgba(34,32,28,.08); transform: rotate(-8deg); }
.sign { font-family: 'Fraunces', Georgia, serif; font-weight: 700; font-size: calc(var(--s) * 70px); }
.cta { margin-top: 18px; font-family: 'IBM Plex Mono', monospace; font-weight: 500; font-size: calc(var(--s) * 28px); color: #B6402D; }
`;

const AURORA_CSS = `
body { background: #04060c; color: #F2EDE2; font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
  background-image: radial-gradient(circle at 88% 8%, rgba(232,114,44,.16), transparent 42%), radial-gradient(circle at 10% 100%, rgba(232,114,44,.08), transparent 45%); }
.top { font-weight: 700; color: #E8722C; letter-spacing: .14em; font-size: 22px; }
.top .n { color: rgba(242,237,226,.5); font-weight: 600; }
h1 { font-weight: 800; letter-spacing: -0.025em; }
.hl { color: #E8722C; font-style: normal; }
.capa-hl { display: block; font-weight: 800; color: #E8722C; font-size: calc(var(--s) * 104px); line-height: 1.02; letter-spacing: -0.03em; margin-top: 8px; }
.sub { color: rgba(242,237,226,.74); font-weight: 450; }
.sub b, .sub strong { color: #F2EDE2; }
.item .bullet { flex: none; width: 14px; height: 14px; margin-top: calc(var(--s) * 20px); border-radius: 50%; background: #E8722C; }
.item .t { font-weight: 700; letter-spacing: -0.01em; }
.item .d { color: rgba(242,237,226,.62); }
.step { border: 2px solid rgba(242,237,226,.16); background: rgba(242,237,226,.04); border-radius: 18px; }
.step .num { background: #E8722C; color: #04060c; border-radius: 50%; font-weight: 800; }
.step .t { font-weight: 700; }
.step .d { color: rgba(242,237,226,.62); }
.arrow svg path { stroke: #E8722C; }
.col { border: 2px solid rgba(242,237,226,.16); border-radius: 18px; background: rgba(242,237,226,.04); }
.col:last-child { border-color: rgba(232,114,44,.6); background: rgba(232,114,44,.08); }
.col h2 { font-weight: 800; }
.col li { border-top: 1px solid rgba(242,237,226,.12); }
.code { background: #0b0f19; border: 2px solid rgba(242,237,226,.14); border-radius: 18px; color: #F2EDE2; }
.shot { border-radius: 16px; overflow: hidden; border: 2px solid rgba(242,237,226,.16); background: #0b0f19; box-shadow: 0 24px 60px rgba(0,0,0,.45); }
.shot__bar { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; background: #141a28; }
.shot__bar i { width: 12px; height: 12px; border-radius: 50%; background: rgba(242,237,226,.22); }
.shot__bar i:first-child { background: #E8722C; }
.shot__bar span { margin-left: 12px; font-size: 18px; font-weight: 600; color: rgba(242,237,226,.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stamp { border: 4px solid #E8722C; color: #E8722C; border-radius: 12px; }
.foot { color: rgba(242,237,226,.5); font-weight: 500; }
.sign { font-weight: 800; font-size: calc(var(--s) * 64px); letter-spacing: -0.02em; }
.site { margin-top: 18px; font-weight: 800; font-size: calc(var(--s) * 44px); color: #E8722C; }
.cta { margin-top: 26px; font-weight: 700; font-size: calc(var(--s) * 34px); }
`;

// Ajusta tudo junto (--s, de 130% para baixo) até o conteúdo caber; marca no <body> quando nem a 60% coube (a HQ lê e devolve como erro).
const FIT_JS = `
(async () => {
  try { await document.fonts.ready; } catch {}
  const box = document.querySelector('.content');
  // Começa grande (slide com pouco texto ocupa a página) e encolhe até caber na altura e na largura.
  let s = 1.3;
  document.body.style.setProperty('--s', String(s));
  const over = () => box && (box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1);
  while (over() && s > 0.6) { s = Math.round((s - 0.03) * 100) / 100; document.body.style.setProperty('--s', String(s)); }
  if (over()) document.title = 'NAO_COUBE';
  else document.title = 'OK ' + s;
})();`;

function slideBody(sl: Slide, c: Ctx): string {
  const goj = c.brand === 'tuco-dev';
  const kicker = sl.kicker ?? (goj ? 'Tuco Dev' : 'Aurora');
  const top = `<div class="top"><span>${esc(kicker)}</span><span class="n">${c.n}/${c.total}</span></div>`;
  const foot = sl.fonte ? `<div class="foot">${esc(/^fonte/i.test(sl.fonte) ? sl.fonte : `Fonte: ${sl.fonte}`)}</div>` : sl.nota ? `<div class="foot">${esc(sl.nota)}</div>` : '';
  const sub = sl.texto ? `<div class="sub">${para(sl.texto)}</div>` : '';
  const arrowSvg = `<div class="arrow"><svg width="40" height="44" viewBox="0 0 40 44"><path d="M20 4 L20 38 M8 27 L20 40 L32 27" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
  switch (sl.tipo) {
    case 'capa': {
      const hlSeparate = sl.destaque && !sl.titulo.toLowerCase().includes(sl.destaque.toLowerCase());
      const mascot = c.mascot && goj ? `<div class="tape" style="left:700px;top:${CAROUSEL_H - 545}px"></div><img class="mascot" src="${c.mascot}" style="right:80px;bottom:110px;width:330px;height:400px;transform:rotate(3deg)">` : '';
      const box = c.mascot && goj ? 'bottom:540px;' : '';
      return `${top}<div class="content top-al" style="${box}"><h1 class="big">${hlSeparate ? esc(sl.titulo) : marked(sl.titulo, sl.destaque)}${hlSeparate ? `<span class="capa-hl">${esc(sl.destaque!)}</span>` : ''}</h1>${box ? '' : figure(c, sl.imagemLegenda, false)}${sub}${sl.cta ? `<div class="cta">${esc(sl.cta)}</div>` : `<div class="cta">${goj ? 'arrasta para o lado →' : 'arrasta para o lado →'}</div>`}</div>${mascot}${foot}`;
    }
    case 'texto':
      return `${top}<div class="content"><h1>${marked(sl.titulo, sl.destaque)}</h1>${figure(c, sl.imagemLegenda, false)}${sub}</div>${foot}`;
    case 'imagem':
      return `${top}<div class="content"><h1>${marked(sl.titulo, sl.destaque)}</h1>${figure(c, sl.imagemLegenda, true)}${sub}</div>${foot}`;
    case 'lista':
      return `${top}<div class="content"><h1>${marked(sl.titulo, sl.destaque)}</h1>${sub}<div class="items">${sl.itens.map(it => `<div class="item"><div class="bullet"></div><div><div class="t">${esc(it.titulo)}</div>${it.detalhe ? `<div class="d">${esc(it.detalhe)}</div>` : ''}</div></div>`).join('')}</div></div>${foot}`;
    case 'passos':
      return `${top}<div class="content"><h1>${marked(sl.titulo, sl.destaque)}</h1>${sub}<div class="steps">${sl.itens.map((it, i) => `${i ? arrowSvg : ''}<div class="step"><div class="num">${i + 1}</div><div><div class="t">${esc(it.titulo)}</div>${it.detalhe ? `<div class="d">${esc(it.detalhe)}</div>` : ''}</div></div>`).join('')}</div></div>${foot}`;
    case 'comparacao':
      return `${top}<div class="content"><h1>${marked(sl.titulo, sl.destaque)}</h1>${sub}<div class="cols">${sl.colunas.map(col => `<div class="col"><h2>${esc(col.titulo)}</h2><ul>${col.itens.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div></div>${foot}`;
    case 'codigo': {
      const lines = sl.codigo!.split('\n').map((l, i) => `<span class="ln">${i + 1}</span> ${esc(l)}`).join('\n');
      return `${top}<div class="content"><h1>${marked(sl.titulo, sl.destaque)}</h1><div class="code">${lines}</div>${sub}</div>${foot}`;
    }
    case 'destaque':
      return `${top}<div class="content center"><h1 class="big">${marked(sl.titulo, sl.destaque)}</h1>${figure(c, sl.imagemLegenda, false)}${sl.carimbo ? `<div class="stamp">${esc(sl.carimbo)}</div>` : ''}${sub}</div>${foot}`;
    case 'fechamento': {
      if (goj) {
        const mascot = c.mascot ? `<img class="mascot" src="${c.mascot}" style="left:90px;bottom:170px;width:300px;height:350px;transform:rotate(-3deg)">` : '';
        return `${top}<div class="content top-al" style="bottom:${c.mascot ? 560 : 140}px"><h1>${marked(sl.titulo, sl.destaque)}</h1>${sub}</div>${mascot}<div style="position:absolute;left:${c.mascot ? 440 : 90}px;right:90px;bottom:${c.mascot ? 240 : 170}px"><div class="sign">Tuco Dev</div><div class="cta">${esc(sl.cta ?? 'salva e manda para quem precisa ver')}</div></div>${foot}`;
      }
      return `${top}<div class="content center"><h1 class="big">${marked(sl.titulo, sl.destaque)}</h1>${sub}<div class="site">aurora.example</div><div class="cta">${esc(sl.cta ?? 'Fala comigo.')}</div></div>${foot}`;
    }
  }
}

export function carouselSlideHtml(carousel: Carousel, index: number, opts: { brand: CarouselBrand; fontsDir: string; mascotFile: string | null; imageFile?: string | null }): string {
  const sl = carousel.slides[index];
  const ctx: Ctx = { n: index + 1, total: carousel.slides.length, brand: opts.brand, fonts: opts.fontsDir, mascot: opts.mascotFile && fs.existsSync(opts.mascotFile) ? pathToFileURL(opts.mascotFile).href : null, image: opts.imageFile ? pathToFileURL(opts.imageFile).href : null };
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>render</title><style>${fontFaces(opts.fontsDir)}${BASE_CSS}${opts.brand === 'tuco-dev' ? TUCO_CSS : AURORA_CSS}</style></head><body>${slideBody(sl, ctx)}<script>${FIT_JS}</script></body></html>`;
}

/** Desenha uma lista de páginas HTML em PNG e devolve o título final de cada uma ("OK 0.92" ou "NAO_COUBE"). */
export type SlideRenderer = (jobs: { html: string; png: string }[], width: number, height: number) => Promise<(string | null)[]>;

/** Um Edge sem janela para todos os slides (playwright-core, já usado pelo modo navegador). Sem rede: só arquivos locais. */
export const edgeSlideRenderer: SlideRenderer = async (jobs, width, height) => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-extensions', '--no-first-run'] });
  try {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, offline: true });
    const page = await ctx.newPage();
    const titles: (string | null)[] = [];
    for (const j of jobs) {
      await page.goto(pathToFileURL(j.html).href, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForFunction('document.title !== "render"', undefined, { timeout: 10_000 }).catch(() => undefined);
      titles.push(await page.title().catch(() => null));
      await page.screenshot({ path: j.png, clip: { x: 0, y: 0, width, height } });
    }
    return titles;
  } finally { await browser.close().catch(() => undefined); }
};

/**
 * Desenha todos os slides em <pasta da peça>/slides/01.png… (apaga os PNGs numerados antigos antes). Devolve os arquivos gerados
 * e os problemas (slide que não coube nem encolhido, Edge que falhou). O HTML de cada slide fica numa pasta temporária.
 */
/** Caminho da imagem do slide: relativo à pasta da peça ou absoluto, sempre dentro da pasta de conteúdo (root) e existente. */
export function resolveSlideImage(ref: string, folder: string, root: string): { ok: true; file: string } | { ok: false; error: string } {
  const file = path.resolve(folder, ref);
  const inside = (p: string, base: string) => { const r = path.relative(path.resolve(base), p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (!inside(file, root)) return { ok: false, error: `a imagem "${ref}" está fora da pasta de conteúdo; copie para a pasta da peça (material/)` };
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, error: `a imagem "${ref}" não existe` };
  return { ok: true, file };
}

export async function renderCarousel(o: { folder: string; carousel: Carousel; brand: CarouselBrand; render: SlideRenderer; fontsDir: string; mascotFile: string | null; root?: string }): Promise<{ files: string[]; errors: string[] }> {
  const outDir = path.join(o.folder, 'slides');
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (/^\d{2}\.png$/.test(f)) fs.rmSync(path.join(outDir, f), { force: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-carrossel-'));
  const errors: string[] = [];
  try {
    const jobs = o.carousel.slides.map((sl, i) => {
      const nn = String(i + 1).padStart(2, '0');
      const html = path.join(tmp, `${nn}.html`);
      let imageFile: string | null = null;
      if (sl.imagem) {
        const r = resolveSlideImage(sl.imagem, o.folder, o.root ?? o.folder);
        if (r.ok) imageFile = r.file; else errors.push(`slide ${i + 1}: ${r.error}`);
      }
      fs.writeFileSync(html, carouselSlideHtml(o.carousel, i, { brand: o.brand, fontsDir: o.fontsDir, mascotFile: o.mascotFile, imageFile }), 'utf8');
      return { html, png: path.join(outDir, `${nn}.png`) };
    });
    let titles: (string | null)[] = [];
    try { titles = await o.render(jobs, CAROUSEL_W, CAROUSEL_H); }
    catch (err) { errors.push(`o Edge não conseguiu desenhar os slides: ${(err as Error).message}`); }
    titles.forEach((t, i) => { if (t === 'NAO_COUBE') errors.push(`slide ${i + 1}: o texto não coube nem com a letra reduzida a 60%; encurte o título ou o texto`); });
    const files = jobs.map(j => j.png).filter(f => fs.existsSync(f));
    if (!errors.length && files.length !== jobs.length) errors.push(`só ${files.length} de ${jobs.length} slides foram gerados`);
    return { files, errors };
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporário */ } }
}
