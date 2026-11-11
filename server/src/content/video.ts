// Vídeo pela equipe, no molde do carrossel: a criação escreve o video.json (sequência de cenas: o que aparece, o que acontece,
// o que fica claro e como a próxima continua) e a HQ renderiza com a composição CenasReel do projeto Remotion do Chefe. Depois
// a HQ confere o MP4 de verdade (ffprobe: abre, formato planejado, duração) e mede o movimento de cada cena comparando dois
// quadros dela. Roteiro não é vídeo; render falho, arquivo inexistente e áudio provisório viram pendência.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SCENE_TYPES = ['titulo', 'fase', 'codigo', 'diagrama', 'interface', 'revelacao', 'encerramento', 'captura'] as const;
export type SceneType = typeof SCENE_TYPES[number];

export interface VideoScene { id: string; tipo: SceneType; duracao: number; mostra: string; acao: string; informacao: string; transicao: string; arquivo?: string; fala?: string }
export interface VideoPlan {
  composicao: string;
  marca: 'tuco-dev' | 'aurora';
  titulo: string;
  largura: number; altura: number; fps: number;
  cenas: VideoScene[];
  audio: { trilha: string; sfx: boolean; voz: string | null; provisorio: boolean; observacao: string | null };
  duracao: number;
}

const str = (v: unknown, max = 600) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
/** Ação que só descreve zoom/imagem parada não é animação (pedido do Chefe, 03/11/2026). */
const STATIC_ACTION = /^(s[óo]\s+)?(zoom( lento| suave| cont[íi]nuo)?|imagem (parada|est[áa]tica)|est[áa]tic[ao]|sem movimento|ken burns)\.?$/i;

/** Valida o video.json. Problemas de direção (cena sem ação, só zoom) voltam como erro para a criação corrigir. */
export function parseVideoPlan(o: unknown): { ok: true; value: VideoPlan; warnings: string[] } | { ok: false; error: string } {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'video.json não é um objeto' };
  const x = o as Record<string, unknown>;
  const composicao = str(x.composicao, 60) ?? 'CenasReel';
  if (!/^[A-Za-z][A-Za-z0-9-]{1,59}$/.test(composicao)) return { ok: false, error: 'composicao inválida' };
  const marca = x.marca === 'aurora' ? 'aurora' : x.marca === 'tuco-dev' || x.marca === 'tuco' ? 'tuco-dev' : null;
  if (!marca) return { ok: false, error: 'marca deve ser "tuco-dev" ou "aurora"' };
  const titulo = str(x.titulo, 200); if (!titulo) return { ok: false, error: 'falta o titulo' };
  const fmt = (x.formato ?? {}) as Record<string, unknown>;
  const largura = typeof fmt.largura === 'number' ? fmt.largura : 1080; const altura = typeof fmt.altura === 'number' ? fmt.altura : 1920; const fps = typeof fmt.fps === 'number' ? fmt.fps : 30;
  const raw = Array.isArray(x.cenas) ? x.cenas : [];
  if (raw.length < 3) return { ok: false, error: 'são precisas pelo menos 3 cenas (sequência com começo, virada e fim)' };
  if (raw.length > 24) return { ok: false, error: 'cenas demais (máximo 24)' };
  const cenas: VideoScene[] = []; const warnings: string[] = []; const ids = new Set<string>();
  for (const [i, c] of raw.entries()) {
    const s = (c ?? {}) as Record<string, unknown>;
    const id = str(s.id, 40) ?? `cena-${i + 1}`;
    if (ids.has(id)) return { ok: false, error: `cena ${i + 1}: id repetido (${id})` }; ids.add(id);
    const tipo = SCENE_TYPES.includes(s.tipo as SceneType) ? s.tipo as SceneType : null;
    if (!tipo) return { ok: false, error: `cena ${i + 1} (${id}): tipo "${String(s.tipo)}" desconhecido (use ${SCENE_TYPES.join(', ')})` };
    const duracao = typeof s.duracao === 'number' ? s.duracao : NaN;
    if (!(duracao >= 0.8 && duracao <= 15)) return { ok: false, error: `cena ${i + 1} (${id}): duracao entre 0,8 e 15 s` };
    const mostra = str(s.mostra), acao = str(s.acao), informacao = str(s.informacao), transicao = str(s.transicao);
    const faltam = [!mostra && 'mostra', !acao && 'acao', !informacao && 'informacao', !transicao && i < raw.length - 1 && 'transicao'].filter(Boolean);
    if (faltam.length) return { ok: false, error: `cena ${i + 1} (${id}): falta ${faltam.join(', ')} (o que aparece, o que acontece, o que fica claro e como a próxima continua)` };
    if (STATIC_ACTION.test(acao!)) return { ok: false, error: `cena ${i + 1} (${id}): "${acao}" não é animação; cada conceito precisa de uma ação, transformação ou demonstração visual` };
    const arquivo = tipo === 'captura' ? str(s.arquivo, 300) : null;
    if (tipo === 'captura' && !arquivo) return { ok: false, error: `cena ${i + 1} (${id}): captura sem "arquivo" (o vídeo ou imagem de verdade, relativo à pasta da peça)` };
    if (arquivo && (path.isAbsolute(arquivo) || arquivo.split(/[\\/]/).includes('..'))) return { ok: false, error: `cena ${i + 1} (${id}): "arquivo" precisa ser relativo e ficar dentro da pasta da peça (veio ${arquivo})` };
    const fala = str(s.fala, 600);
    cenas.push({ id, tipo, duracao, mostra: mostra!, acao: acao!, informacao: informacao!, transicao: transicao ?? 'fim', ...(arquivo ? { arquivo } : {}), ...(fala ? { fala } : {}) });
  }
  const duracao = Math.round(cenas.reduce((a, c) => a + c.duracao, 0) * 100) / 100;
  if (duracao < 6 || duracao > 90) return { ok: false, error: `duração total de ${duracao} s fora do intervalo de 6 a 90 s` };
  const a = (x.audio ?? {}) as Record<string, unknown>;
  const audio = { trilha: str(a.trilha, 300) ?? 'nenhuma', sfx: a.sfx === true, voz: str(a.voz, 300), provisorio: a.provisorio === true, observacao: str(a.observacao, 600) };
  if (audio.trilha === 'nenhuma' && !audio.sfx && !audio.voz) warnings.push('vídeo sem trilha, efeitos ou voz');
  if (audio.voz === 'gerar' && !cenas.some(c => c.fala)) return { ok: false, error: 'audio.voz = "gerar" pede a "fala" (narração) de pelo menos uma cena' };
  return { ok: true, value: { composicao, marca, titulo, largura, altura, fps, cenas, audio, duracao }, warnings };
}

/** Arquivos das cenas "captura" que não existem na pasta da peça (relativos a ela). */
export function missingCaptures(folder: string, plan: VideoPlan): string[] {
  return [...new Set(plan.cenas.filter(c => c.tipo === 'captura' && c.arquivo).map(c => c.arquivo!))].filter(f => !fs.existsSync(path.join(folder, f)));
}

/** Data de modificação mais nova entre os arquivos das capturas (para saber se o MP4 ficou velho). */
export function newestCapture(folder: string, plan: VideoPlan): number {
  let t = 0;
  for (const c of plan.cenas) if (c.tipo === 'captura' && c.arquivo) { try { t = Math.max(t, fs.statSync(path.join(folder, c.arquivo)).mtimeMs); } catch { /* falta: tratado em missingCaptures */ } }
  return t;
}

export interface VideoProbe { ok: boolean; width: number | null; height: number | null; duration: number | null; vcodec: string | null; audio: boolean; error: string | null }

function runCmd(cmd: string, args: string[], o: { cwd?: string; timeoutMs: number; binary?: boolean }): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise(resolve => {
    let p: ReturnType<typeof spawn>;
    try { p = spawn(cmd, args, { cwd: o.cwd, windowsHide: true, shell: false }); } catch (e) { resolve({ code: -1, out: Buffer.alloc(0), err: (e as Error).message }); return; }
    const chunks: Buffer[] = []; let err = '';
    const t = setTimeout(() => { try { p.kill(); } catch { /* já saiu */ } err += `\n(tempo esgotado: ${Math.round(o.timeoutMs / 1000)} s)`; }, o.timeoutMs);
    p.stdout?.on('data', (d: Buffer) => chunks.push(d));
    p.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    p.on('error', e => { err += e.message; });
    p.on('close', code => { clearTimeout(t); resolve({ code, out: Buffer.concat(chunks), err }); });
  });
}

/** Abre o arquivo com o ffprobe: se não abre, não é vídeo entregue. */
export async function probeVideo(file: string, ffprobe = 'ffprobe'): Promise<VideoProbe> {
  if (!fs.existsSync(file)) return { ok: false, width: null, height: null, duration: null, vcodec: null, audio: false, error: 'arquivo não existe' };
  const r = await runCmd(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeoutMs: 30_000 });
  if (r.code !== 0) return { ok: false, width: null, height: null, duration: null, vcodec: null, audio: false, error: `o ffprobe não abriu o arquivo: ${r.err.trim().slice(0, 300) || `código ${r.code}`}` };
  try {
    const j = JSON.parse(r.out.toString()) as { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]; format?: { duration?: string } };
    const v = (j.streams ?? []).find(s => s.codec_type === 'video');
    const duration = j.format?.duration ? Number(j.format.duration) : null;
    if (!v) return { ok: false, width: null, height: null, duration, vcodec: null, audio: false, error: 'o arquivo não tem faixa de vídeo' };
    return { ok: true, width: v.width ?? null, height: v.height ?? null, duration, vcodec: v.codec_name ?? null, audio: (j.streams ?? []).some(s => s.codec_type === 'audio'), error: null };
  } catch (e) { return { ok: false, width: null, height: null, duration: null, vcodec: null, audio: false, error: `resposta do ffprobe ilegível: ${(e as Error).message}` }; }
}

/** Quadro pequeno em tons de cinza (64×114) no instante t, para comparar. */
async function grayFrame(file: string, t: number, ffmpeg: string): Promise<Buffer | null> {
  const r = await runCmd(ffmpeg, ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=64:114,format=gray', '-f', 'rawvideo', '-'], { timeoutMs: 30_000, binary: true });
  return r.code === 0 && r.out.length >= 64 * 114 ? r.out.subarray(0, 64 * 114) : null;
}

export interface SceneMotion { id: string; tipo: SceneType; start: number; motion: number | null; still: boolean }

/** Movimento de cada cena: diferença média entre os quadros a 25% e a 75% dela (0 = idêntico, 1 = tudo mudou). */
export async function sceneMotion(file: string, plan: VideoPlan, ffmpeg = 'ffmpeg'): Promise<SceneMotion[]> {
  const out: SceneMotion[] = []; let start = 0;
  for (const c of plan.cenas) {
    const a = await grayFrame(file, start + c.duracao * 0.25, ffmpeg);
    const b = await grayFrame(file, start + c.duracao * 0.75, ffmpeg);
    let motion: number | null = null;
    if (a && b) { let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); motion = sum / a.length / 255; }
    out.push({ id: c.id, tipo: c.tipo, start, motion, still: motion !== null && motion < 0.004 });
    start += c.duracao;
  }
  return out;
}

export interface SiteRecording { ok: boolean; error: string | null; recorded: { arquivo: string; segundos: number }[]; ms: number }

export interface VideoRenderer {
  /** Renderiza o video.json: MP4, capa e um quadro do meio de cada cena (para a revisão). */
  render(o: { planFile: string; out: string; cover: string; framesDir: string }): Promise<{ ok: boolean; error: string | null; ms: number }>;
  /** Grava os trechos do site listados no gravacoes.json da peça (só o que falta ou ficou velho). */
  record?(o: { file: string }): Promise<SiteRecording>;
  ffprobe: string;
  ffmpeg: string;
}

/** Renderizador com o projeto Remotion do Chefe (scripts/render-cenas.mjs). Ausente = a HQ não renderiza e diz isso. */
export function remotionRenderer(remotionDir: string, o: { node?: string; ffprobe?: string; ffmpeg?: string; timeoutMs?: number } = {}): VideoRenderer | null {
  const script = path.join(remotionDir, 'scripts', 'render-cenas.mjs');
  if (!fs.existsSync(remotionDir)) return null;
  return {
    ffprobe: o.ffprobe ?? 'ffprobe', ffmpeg: o.ffmpeg ?? 'ffmpeg',
    async render({ planFile, out, cover, framesDir }) {
      const t0 = Date.now();
      if (!fs.existsSync(script)) return { ok: false, error: `renderizador não encontrado: ${script}`, ms: 0 };
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const r = await runCmd(o.node ?? process.execPath, [script, planFile, out, '--cover', cover, '--frames', framesDir], { cwd: remotionDir, timeoutMs: o.timeoutMs ?? 20 * 60_000 });
      const ok = r.code === 0 && fs.existsSync(out);
      // O motivo vem da linha "render-cenas: ..." (e da lista de erros abaixo dela); os avisos de versão do Remotion não contam.
      const lines = r.err.split('\n').map(l => l.replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(Boolean);
      const own = lines.findIndex(l => l.startsWith('render-cenas:'));
      const noise = /@remotion\/|node_modules[\\/].*package\.json|On version|version mismatch|^-+$|breakages|To resolve|remotion versions|React context|Type errors and feature|Failed renders and unclear|Make sure your package|Remove the `\^`/i;
      const why = own >= 0 ? lines.slice(own, own + 6).map(l => l.replace(/^render-cenas:\s*/, '')) : lines.filter(l => !noise.test(l)).slice(-4);
      return { ok, error: ok ? null : `o render falhou (código ${r.code ?? 'interrompido'}): ${why.join(' | ').slice(0, 600) || 'sem mensagem (processo interrompido?)'}`, ms: Date.now() - t0 };
    },
    async record({ file }) {
      const t0 = Date.now();
      const rec = path.join(remotionDir, 'scripts', 'cenas', 'gravar-site.mjs');
      if (!fs.existsSync(rec)) return { ok: false, error: `gravador não encontrado: ${rec}`, recorded: [], ms: 0 };
      const r = await runCmd(o.node ?? process.execPath, [rec, file], { cwd: remotionDir, timeoutMs: 15 * 60_000 });
      const line = r.out.toString().split('\n').reverse().find(l => l.startsWith('RESULTADO '));
      try {
        const j = JSON.parse(line!.slice('RESULTADO '.length)) as { ok: boolean; gravados: { arquivo: string; segundos: number }[]; erros: string[] };
        return { ok: j.ok, error: j.ok ? null : j.erros.join('; ').slice(0, 800), recorded: j.gravados ?? [], ms: Date.now() - t0 };
      } catch { return { ok: false, error: `o gravador não respondeu (código ${r.code}): ${r.err.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`, recorded: [], ms: Date.now() - t0 }; }
    },
  };
}
