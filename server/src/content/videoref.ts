// Inspeção de uma referência de vídeo enviada pelo Chefe, com ferramentas locais e gratuitas (nada pago, nenhum login
// contornado): o Edge sem janela abre o post (captura e metadados da página), o yt-dlp lê os metadados públicos e baixa a
// mídia pública para análise interna (sem cookies: post que exige login fica bloqueado), o FFmpeg mede os cortes, tira
// quadros com a marcação de tempo em folhas e mede o som (volume e silêncios), e o whisper.cpp transcreve a fala.
// O nível de inspeção diz só o que as ferramentas permitiram verificar: quadros isolados não provam fluidez, transcrição
// não prova música, efeitos nem mixagem. Nada aqui é publicado nem enviado a terceiros.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findWatch, runWatch, type WatchRun, type WatchTool } from './watchskill.js';

/** Nível real da inspeção (do menor para o maior). 'audiovisual' nunca é atribuído sozinho: exige ouvir, o que a HQ não faz. */
export type InspectionLevel = 'bloqueada' | 'pagina' | 'trechos' | 'video_sem_audio' | 'video_transcricao' | 'audiovisual';
export const INSPECTION_LEVEL_LABEL: Record<InspectionLevel, string> = {
  bloqueada: 'sem acesso', pagina: 'página e miniatura', trechos: 'trechos visuais', video_sem_audio: 'vídeo inteiro em quadros, sem áudio analisado',
  video_transcricao: 'vídeo inteiro em quadros + transcrição da fala', audiovisual: 'análise audiovisual completa',
};

export interface VideoTools {
  ytdlp: string | null;
  ffmpeg: string;
  ffprobe: string;
  /** whisper.cpp (main.exe) e o modelo .bin; null = sem transcrição. */
  whisper: { exe: string; model: string } | null;
  /** Fonte para a marcação de tempo nas folhas. */
  font: string | null;
  /** Abre a página do post num navegador sem janela (captura e metadados). null = não disponível. */
  page?: ((url: string, png: string) => Promise<PageSnapshot>) | null;
  /** Skill Watch instalada (plugin watch@claude-video). null/ausente = a HQ não roda a Watch e diz isso nos limites. */
  watch?: WatchTool | null;
}

export interface PageSnapshot { ok: boolean; title: string | null; description: string | null; image: string | null; finalUrl: string | null; loginWall: boolean; error: string | null }

export interface VideoMeta { id: string | null; title: string | null; author: string | null; authorId: string | null; description: string | null; duration: number | null; uploadDate: string | null; thumbnail: string | null; webpageUrl: string | null; platform: string | null; metrics: { name: string; value: number }[] }

export interface Inspection {
  at: string;
  level: InspectionLevel;
  /** Uma linha honesta do que foi possível e do que não foi. */
  summary: string;
  url: string | null;
  meta: VideoMeta | null;
  page: PageSnapshot | null;
  /** O post baixado é o mesmo do link (id do post igual). null = não deu para conferir. */
  sameMedia: boolean | null;
  media: { file: string; duration: number; width: number; height: number; fps: number | null; audio: boolean } | null;
  /** Instantes de corte medidos (s) e a duração de cada plano. */
  cuts: number[];
  shots: { start: number; end: number; duration: number }[];
  /** Folhas de quadros (PNG) com a marcação de tempo em cada quadro; o intervalo entre quadros. */
  sheets: string[];
  frameStep: number | null;
  thumbnail: string | null;
  pageShot: string | null;
  audio: { present: boolean; loudnessLufs: number | null; silences: { start: number; end: number }[] } | null;
  transcript: { lang: string | null; segments: { start: number; end: number; text: string }[]; file: string } | null;
  /** O que a HQ não conseguiu fazer e por quê (vai para a tela e para a análise). */
  limits: string[];
  /** Bloqueio com a ação útil (Abrir para login, Tentar novamente, Anexar vídeo). */
  blocked: { reason: string; actions: ('login' | 'tentar' | 'anexar')[] } | null;
  /** Skill Watch rodada sobre a referência (quadros por cena com o tempo, legenda nativa). null = não rodou. */
  watch?: (WatchRun & { source: 'link' | 'arquivo'; version: string | null }) | null;
}

function run(cmd: string, args: string[], o: { timeoutMs: number; cwd?: string }): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(resolve => {
    let p: ReturnType<typeof spawn>;
    try { p = spawn(cmd, args, { cwd: o.cwd, windowsHide: true, shell: false }); } catch (e) { resolve({ code: -1, out: '', err: (e as Error).message }); return; }
    let out = ''; let err = '';
    const t = setTimeout(() => { try { p.kill(); } catch { /* já saiu */ } err += `\n(tempo esgotado: ${Math.round(o.timeoutMs / 1000)} s)`; }, o.timeoutMs);
    p.stdout?.on('data', (d: Buffer) => { out += d.toString(); if (out.length > 4_000_000) out = out.slice(-4_000_000); });
    p.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-200_000); });
    p.on('error', e => { err += e.message; });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Classifica o erro do yt-dlp num motivo legível e na ação útil. */
export function classifyFetchError(err: string): { reason: string; actions: ('login' | 'tentar' | 'anexar')[] } {
  const e = err.toLowerCase();
  if (/login|log in|sign in|cookies|private|rate-limit reached or login required|requires authentication/.test(e)) return { reason: 'a rede pede login para mostrar este post (a HQ não usa a sua conta para baixar)', actions: ['login', 'anexar'] };
  if (/404|not found|unavailable|removed|does not exist|no video/.test(e)) return { reason: 'o post não foi encontrado (removido, privado ou link errado)', actions: ['tentar', 'anexar'] };
  if (/429|too many|rate/.test(e)) return { reason: 'a rede limitou o acesso por excesso de pedidos; tente de novo mais tarde', actions: ['tentar', 'anexar'] };
  if (/unsupported url|no suitable/.test(e)) return { reason: 'este site não é suportado pela ferramenta local de vídeo', actions: ['anexar'] };
  if (/timed out|tempo esgotado|getaddrinfo|network|connection/.test(e)) return { reason: 'sem resposta da rede (conexão ou tempo esgotado)', actions: ['tentar', 'anexar'] };
  return { reason: `a ferramenta de vídeo não conseguiu ler o post (${err.trim().split('\n').pop()?.slice(0, 160) ?? 'erro desconhecido'})`, actions: ['tentar', 'anexar'] };
}

/** Metadados públicos do post (yt-dlp, sem download e sem cookies). */
export async function fetchMeta(url: string, tools: VideoTools): Promise<{ ok: true; meta: VideoMeta } | { ok: false; error: string }> {
  if (!tools.ytdlp) return { ok: false, error: 'yt-dlp não encontrado neste computador' };
  const r = await run(tools.ytdlp, ['--dump-single-json', '--no-warnings', '--skip-download', '--no-playlist', url], { timeoutMs: 90_000 });
  if (r.code !== 0) return { ok: false, error: r.err || `yt-dlp saiu com código ${r.code}` };
  try {
    const j = JSON.parse(r.out) as Record<string, unknown>;
    const metrics = ([['visualizações', j.view_count], ['curtidas', j.like_count], ['comentários', j.comment_count], ['compartilhamentos', j.repost_count]] as const)
      .flatMap(([name, v]) => (num(v) != null ? [{ name, value: num(v)! }] : []));
    const up = str(j.upload_date);
    return {
      ok: true,
      meta: {
        id: str(j.id), title: str(j.title), author: str(j.uploader) ?? str(j.channel) ?? str(j.creator), authorId: str(j.uploader_id) ?? str(j.channel_id), description: str(j.description),
        duration: num(j.duration), uploadDate: up && /^\d{8}$/.test(up) ? `${up.slice(0, 4)}-${up.slice(4, 6)}-${up.slice(6, 8)}` : null, thumbnail: str(j.thumbnail),
        webpageUrl: str(j.webpage_url), platform: str(j.extractor_key)?.toLowerCase() ?? null, metrics,
      },
    };
  } catch (e) { return { ok: false, error: `resposta do yt-dlp ilegível: ${(e as Error).message}` }; }
}

/** Baixa a mídia pública para a pasta da referência (uso interno de análise; nunca republicada). */
/** Tempo-limite de um passo: o de sempre para Reels, proporcional à duração em vídeo longo (07/11: tutorial de 30 min). */
export const scaled = (baseMs: number, duration: number | null | undefined, perSecondMs: number) => Math.max(baseMs, Math.round((duration ?? 0) * perSecondMs));
/** Acima disso o vídeo é "longo": a HQ baixa em 720p e deixa a legenda do YouTube (pela Watch) no lugar do whisper.cpp. */
export const LONG_VIDEO_S = 300;

export async function downloadMedia(url: string, dir: string, tools: VideoTools, duration: number | null = null): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
  if (!tools.ytdlp) return { ok: false, error: 'yt-dlp não encontrado neste computador' };
  const out = path.join(dir, 'original.%(ext)s');
  const h = duration && duration > LONG_VIDEO_S ? 720 : 1280;
  const r = await run(tools.ytdlp, ['--no-warnings', '--no-playlist', '--no-part', '-f', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`, '--merge-output-format', 'mp4', '--ffmpeg-location', path.dirname(tools.ffmpeg) === '.' ? tools.ffmpeg : path.dirname(tools.ffmpeg), '-o', out, url], { timeoutMs: scaled(240_000, duration, 400) });
  const file = fs.readdirSync(dir).filter(f => /^original\.(mp4|mkv|webm|mov)$/i.test(f)).map(f => path.join(dir, f))[0];
  if (r.code !== 0 || !file) return { ok: false, error: r.err || `yt-dlp saiu com código ${r.code}` };
  return { ok: true, file };
}

export async function probeMedia(file: string, tools: VideoTools): Promise<Inspection['media'] | null> {
  const r = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeoutMs: 30_000 });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.out) as { streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string }[]; format?: { duration?: string } };
    const v = (j.streams ?? []).find(s => s.codec_type === 'video'); if (!v) return null;
    const [a, b] = (v.avg_frame_rate ?? '').split('/').map(Number);
    return { file, duration: Number(j.format?.duration ?? 0), width: v.width ?? 0, height: v.height ?? 0, fps: a && b ? Math.round((a / b) * 100) / 100 : null, audio: (j.streams ?? []).some(s => s.codec_type === 'audio') };
  } catch { return null; }
}

/** Cortes medidos pela mudança de cena do FFmpeg (limiar 0,3). */
export async function detectCuts(file: string, tools: VideoTools, duration: number): Promise<{ cuts: number[]; shots: Inspection['shots'] }> {
  // Vídeo longo: mede em 320 px (o corte é o mesmo; a detecção fica dezenas de vezes mais rápida).
  const vf = duration > LONG_VIDEO_S ? "scale=320:-2,select='gt(scene,0.3)',showinfo" : "select='gt(scene,0.3)',showinfo";
  const r = await run(tools.ffmpeg, ['-hide_banner', '-i', file, '-an', '-filter:v', vf, '-f', 'null', '-'], { timeoutMs: scaled(180_000, duration, 300) });
  const cuts = [...r.err.matchAll(/pts_time:([\d.]+)/g)].map(m => Math.round(Number(m[1]) * 100) / 100).filter(t => t > 0.15 && t < duration - 0.15);
  const marks = [0, ...cuts, duration];
  const shots = marks.slice(0, -1).map((s, i) => ({ start: s, end: marks[i + 1], duration: Math.round((marks[i + 1] - s) * 100) / 100 }));
  return { cuts, shots };
}

/** Folhas de quadros (4×3) com a marcação de tempo em cada quadro, cobrindo o vídeo inteiro. */
export async function contactSheets(file: string, dir: string, tools: VideoTools, duration: number): Promise<{ sheets: string[]; step: number }> {
  // Reels: um quadro a cada 0,5 a 3 s. Vídeo longo: uns 120 quadros no total (10 folhas), para não afogar a análise.
  const step = duration > 108 ? Math.ceil(duration / 120) : Math.min(3, Math.max(0.5, Math.round((duration / 36) * 2) / 2 || 0.5));
  for (const f of fs.readdirSync(dir).filter(n => /^folha-\d+\.png$/.test(n))) fs.rmSync(path.join(dir, f));
  const font = tools.font ? `fontfile='${tools.font.replace(/\\/g, '/').replace(':', '\\:')}':` : '';
  const vf = `fps=1/${step},scale=320:-2,drawtext=${font}text='%{pts\\:hms}':x=8:y=8:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4,tile=4x3:padding=6:margin=6:color=0x202020`;
  await run(tools.ffmpeg, ['-v', 'error', '-y', '-i', file, '-an', '-vf', vf, '-fps_mode', 'vfr', path.join(dir, 'folha-%02d.png')], { timeoutMs: scaled(180_000, duration, 200) });
  const sheets = fs.readdirSync(dir).filter(n => /^folha-\d+\.png$/.test(n)).sort().map(n => path.join(dir, n));
  return { sheets, step };
}

/** Volume integrado (LUFS) e trechos de silêncio; WAV 16 kHz para a transcrição. */
export async function audioMeasures(file: string, dir: string, tools: VideoTools, duration: number | null = null): Promise<{ wav: string | null; loudness: number | null; silences: { start: number; end: number }[] }> {
  const wav = path.join(dir, 'audio-16k.wav');
  const x = await run(tools.ffmpeg, ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav], { timeoutMs: scaled(120_000, duration, 100) });
  if (x.code !== 0 || !fs.existsSync(wav)) return { wav: null, loudness: null, silences: [] };
  const l = await run(tools.ffmpeg, ['-hide_banner', '-i', wav, '-af', 'ebur128', '-f', 'null', '-'], { timeoutMs: scaled(120_000, duration, 100) });
  const lm = [...l.err.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  const s = await run(tools.ffmpeg, ['-hide_banner', '-i', wav, '-af', 'silencedetect=n=-40dB:d=0.5', '-f', 'null', '-'], { timeoutMs: scaled(120_000, duration, 100) });
  const starts = [...s.err.matchAll(/silence_start: ([\d.]+)/g)].map(m => Number(m[1]));
  const ends = [...s.err.matchAll(/silence_end: ([\d.]+)/g)].map(m => Number(m[1]));
  return { wav, loudness: lm ? Number(lm[1]) : null, silences: starts.map((st, i) => ({ start: Math.round(st * 100) / 100, end: Math.round((ends[i] ?? st) * 100) / 100 })) };
}

const toSec = (t: string) => { const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : 0; };

/** Transcrição local com o whisper.cpp (idioma automático). Sem fala, volta vazia. */
export async function transcribe(wav: string, dir: string, tools: VideoTools, duration: number | null = null): Promise<Inspection['transcript']> {
  if (!tools.whisper) return null;
  const base = path.join(dir, 'transcricao');
  const r = await run(tools.whisper.exe, ['-m', tools.whisper.model, '-f', wav, '-l', 'auto', '-oj', '-of', base, '-np'], { timeoutMs: scaled(600_000, duration, 2_000) });
  const file = `${base}.json`;
  if (r.code !== 0 || !fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { result?: { language?: string }; transcription?: { timestamps?: { from: string; to: string }; text?: string }[] };
    const segments = (j.transcription ?? []).map(s => ({ start: toSec(s.timestamps?.from ?? ''), end: toSec(s.timestamps?.to ?? ''), text: (s.text ?? '').trim() }))
      .filter(s => s.text && !/^\[.*\]$|^\(.*\)$/.test(s.text));
    return { lang: j.result?.language ?? null, segments, file };
  } catch { return null; }
}

/** Áudio de um link marcado como "áudio" no pedido, em AAC, para a HQ misturar no vídeo com o tempo que a criação marcar. */
export async function extractAudio(file: string, dir: string, tools: VideoTools): Promise<string | null> {
  const out = path.join(dir, 'audio.m4a');
  const r = await run(tools.ffmpeg, ['-v', 'error', '-y', '-i', file, '-vn', '-c:a', 'aac', '-b:a', '192k', out], { timeoutMs: 120_000 });
  return r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1000 ? out : null;
}

/** Pedido da criação para misturar o áudio da referência (audio-referencia.json na pasta da peça). */
export interface AudioMixPlan { arquivo: string; entraEm: number; inicio: number; fim: number | null; volume: number }

/** Lê e confere o audio-referencia.json: arquivo existente, tempos e volume dentro do possível. */
export function parseAudioMix(raw: unknown, baseDir: string): { ok: true; value: AudioMixPlan } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'audio-referencia.json precisa ser um objeto' };
  const o = raw as Record<string, unknown>;
  const arq = str(o.arquivo);
  if (!arq) return { ok: false, error: '"arquivo" (o áudio da referência) é obrigatório' };
  const abs = path.isAbsolute(arq) ? arq : path.join(baseDir, arq);
  if (!fs.existsSync(abs)) return { ok: false, error: `áudio não encontrado: ${abs}` };
  const entraEm = num(o.entraEm) ?? 0; const inicio = num(o.inicio) ?? 0; const fim = num(o.fim); const volume = num(o.volume) ?? 1;
  if (entraEm < 0 || inicio < 0) return { ok: false, error: '"entraEm" e "inicio" não podem ser negativos' };
  if (fim != null && fim <= inicio) return { ok: false, error: '"fim" precisa ser depois de "inicio"' };
  if (volume <= 0 || volume > 2) return { ok: false, error: '"volume" fica entre 0,1 e 2' };
  return { ok: true, value: { arquivo: abs, entraEm, inicio, fim, volume } };
}

/** Mistura o trecho do áudio da referência no vídeo (sem mexer na imagem): soma ao som que o vídeo já tem, ou vira o som dele. */
export async function mixReferenceAudio(o: { video: string; out: string; plan: AudioMixPlan; tools: Pick<VideoTools, 'ffmpeg' | 'ffprobe'> }): Promise<{ ok: true; duration: number } | { ok: false; error: string }> {
  const tools = o.tools as VideoTools;
  const media = await probeMedia(o.video, tools);
  if (!media) return { ok: false, error: 'o vídeo renderizado não abriu no ffprobe' };
  const p = o.plan; const ms = Math.round(p.entraEm * 1000);
  const cut = ['-ss', String(p.inicio), ...(p.fim != null ? ['-t', String(Math.round((p.fim - p.inicio) * 1000) / 1000)] : [])];
  const ref = `[1:a]asetpts=PTS-STARTPTS,volume=${p.volume},adelay=${ms}:all=1`;
  const graph = media.audio ? `${ref}[r];[0:a][r]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]` : `${ref},apad[a]`;
  const tmp = `${o.out}.tmp.mp4`;
  const r = await run(tools.ffmpeg, ['-v', 'error', '-y', '-i', o.video, ...cut, '-i', p.arquivo, '-filter_complex', graph, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(media.duration), '-movflags', '+faststart', tmp], { timeoutMs: 180_000 });
  if (r.code !== 0 || !fs.existsSync(tmp)) { try { fs.rmSync(tmp, { force: true }); } catch { /* nada */ } return { ok: false, error: `ffmpeg: ${r.err.trim().split('\n').pop() ?? 'falhou'}` }; }
  fs.renameSync(tmp, o.out);
  const done = await probeMedia(o.out, tools);
  if (!done?.audio) return { ok: false, error: 'o vídeo misturado saiu sem faixa de áudio' };
  return { ok: true, duration: done.duration };
}

/** Inspeção completa. `file` = vídeo anexado pelo Chefe (dispensa o download). Reaproveita o que já existe na pasta. */
export async function inspectVideo(o: { url: string | null; file: string | null; dir: string; tools: VideoTools; now?: () => Date }): Promise<Inspection> {
  const { dir, tools } = o; fs.mkdirSync(dir, { recursive: true });
  const limits: string[] = [];
  let meta: VideoMeta | null = null; let page: PageSnapshot | null = null; let pageShot: string | null = null; let metaError: string | null = null;
  if (o.url) {
    if (tools.page) {
      pageShot = path.join(dir, 'pagina.png');
      try { page = await tools.page(o.url, pageShot); } catch (e) { page = { ok: false, title: null, description: null, image: null, finalUrl: null, loginWall: false, error: (e as Error).message }; }
      if (!page.ok || !fs.existsSync(pageShot)) pageShot = null;
      if (page.loginWall) limits.push('a página do post mostrou um pedido de login no navegador sem conta');
    } else limits.push('navegador sem janela indisponível: a página do post não foi aberta');
    const m = await fetchMeta(o.url, tools);
    if (m.ok) meta = m.meta; else { metaError = m.error; limits.push(`metadados do post: ${classifyFetchError(m.error).reason}`); }
  }
  let file = o.file && fs.existsSync(o.file) ? o.file : (fs.readdirSync(dir).filter(f => /^original\.(mp4|mkv|webm|mov)$/i.test(f)).map(f => path.join(dir, f))[0] ?? null);
  let dlError: string | null = null;
  const long = Boolean(meta?.duration && meta.duration > LONG_VIDEO_S);
  // Vídeo longo com a Watch instalada: um download só (o da Watch, em 720p, que também traz a legenda); a HQ mede esse arquivo.
  if (!file && o.url && !(long && tools.watch)) { const d = await downloadMedia(o.url, dir, tools, meta?.duration ?? null); if (d.ok) file = d.file; else dlError = d.error; }
  // Skill Watch: assiste pelo link quando pode haver legenda nativa (YouTube) ou quando a HQ não conseguiu baixar; senão, pelo
  // arquivo já baixado (sem baixar de novo). Se a Watch conseguiu o vídeo e a HQ não, a HQ mede o vídeo que a Watch baixou.
  let watch: Inspection['watch'] = null;
  if (tools.watch) {
    const byLink = Boolean(o.url && (!file || /youtu\.?be/i.test(o.url)));
    const source = byLink ? o.url! : file;
    if (source) {
      const timeoutMs = scaled(6 * 60_000, meta?.duration, 600);
      let w = await runWatch({ tool: tools.watch, source, dir, timeoutMs });
      let via: 'link' | 'arquivo' = byLink ? 'link' : 'arquivo';
      if (!w.ok && byLink && file) { w = await runWatch({ tool: tools.watch, source: file, dir, timeoutMs }); via = 'arquivo'; }
      watch = { ...w, source: via, version: tools.watch.version };
      if (!w.ok) limits.push(`skill Watch: ${w.error ?? 'não assistiu'}`);
      if (!file && w.localMedia && fs.existsSync(w.localMedia)) { file = w.localMedia; dlError = null; }
      // A Watch não conseguiu o vídeo longo: a HQ tenta o próprio download (720p).
      if (!file && o.url && long) { const d = await downloadMedia(o.url, dir, tools, meta?.duration ?? null); if (d.ok) file = d.file; else dlError = d.error; }
    } else limits.push('skill Watch: sem link nem arquivo para assistir');
  } else limits.push('skill Watch não instalada nesta máquina: só os quadros e as medidas da HQ');
  let thumbnail: string | null = null;
  if (meta?.thumbnail && /^https:\/\//.test(meta.thumbnail)) {
    try { const res = await fetch(meta.thumbnail); if (res.ok) { const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > 200) { thumbnail = path.join(dir, 'miniatura.jpg'); fs.writeFileSync(thumbnail, buf); } } } catch { /* miniatura é opcional */ }
  }
  const media = file ? await probeMedia(file, tools) : null;
  if (file && !media) limits.push('o arquivo de vídeo não abriu no ffprobe');
  // Mesma mídia do link: o id do post baixado bate com o id na URL (quando a URL tem um).
  const urlId = o.url?.match(/\/(?:video|reel|reels|p|status|comments)\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
  const sameMedia = o.url && media && meta?.id && urlId ? meta.id === urlId : o.file ? null : null;
  let cuts: number[] = []; let shots: Inspection['shots'] = []; let sheets: string[] = []; let frameStep: number | null = null;
  let audio: Inspection['audio'] = null; let transcript: Inspection['transcript'] = null;
  if (media) {
    ({ cuts, shots } = await detectCuts(media.file, tools, media.duration));
    const cs = await contactSheets(media.file, dir, tools, media.duration); sheets = cs.sheets; frameStep = cs.step;
    if (!sheets.length) limits.push('as folhas de quadros não foram geradas');
    if (media.audio) {
      const a = await audioMeasures(media.file, dir, tools, media.duration);
      audio = { present: true, loudnessLufs: a.loudness, silences: a.silences };
      // Vídeo longo com legenda (pela Watch): a legenda é a transcrição; o whisper.cpp levaria dezenas de minutos na CPU.
      const captions = Boolean(watch?.ok && watch.transcript && /captions/i.test(watch.transcript));
      if (a.wav && media.duration > LONG_VIDEO_S && captions) limits.push(`fala: legenda do YouTube lida pela Watch (${watch!.transcript}); o whisper.cpp não rodou num vídeo de ${Math.round(media.duration / 60)} min`);
      else if (a.wav) { transcript = await transcribe(a.wav, dir, tools, media.duration); if (!transcript) limits.push(tools.whisper ? 'a transcrição local falhou' : 'transcrição indisponível (whisper.cpp não encontrado)'); }
      // Vídeo longo: o WAV de 16 kHz (dezenas de MB) só servia para medir e transcrever; não fica na pasta de conteúdo.
      if (a.wav && media.duration > LONG_VIDEO_S) { try { fs.rmSync(a.wav, { force: true }); } catch { /* fica */ } }
      limits.push('música, efeitos sonoros e mixagem não foram ouvidos: só volume, silêncios e a transcrição automática da fala');
    } else { audio = { present: false, loudnessLufs: null, silences: [] }; limits.push('o arquivo não tem faixa de áudio'); }
    limits.push(`quadros a cada ${frameStep} s: mostram composição, texto e mudanças, não provam a fluidez do movimento entre eles`);
  }
  const captioned = Boolean(watch?.ok && watch.transcript && /captions/i.test(watch.transcript));
  const speech = Boolean(transcript?.segments.length) || captioned;
  const level: InspectionLevel = media && sheets.length ? (speech ? 'video_transcricao' : 'video_sem_audio') : (page?.ok || meta) ? 'pagina' : 'bloqueada';
  const blocked = level === 'bloqueada' || (level === 'pagina' && o.url) ? classifyFetchError(dlError ?? metaError ?? page?.error ?? 'sem acesso') : null;
  if (dlError && !media) limits.push(`vídeo não baixado: ${classifyFetchError(dlError).reason}`);
  const summary = level === 'bloqueada' ? `Sem acesso ao post: ${blocked!.reason}.`
    : level === 'pagina' ? `Só a página${thumbnail ? ' e a miniatura' : ''}: o vídeo não foi obtido (${blocked?.reason ?? 'motivo desconhecido'}).`
      : `Vídeo inteiro (${media!.duration.toFixed(1)} s, ${media!.width}×${media!.height}) em ${sheets.length} folha(s) de quadros a cada ${frameStep} s, ${cuts.length} corte(s) medido(s)${media!.audio ? `, áudio presente${audio?.loudnessLufs != null ? ` (${audio.loudnessLufs} LUFS)` : ''}${transcript?.segments.length ? `, ${transcript.segments.length} trecho(s) de fala transcritos` : captioned ? ', fala pela legenda do YouTube (Watch)' : ', sem fala reconhecida'}` : ', sem áudio'}.`;
  const insp: Inspection = {
    at: (o.now?.() ?? new Date()).toISOString(), level, summary, url: o.url, meta, page, sameMedia, media, cuts, shots, sheets, frameStep, thumbnail, pageShot, audio, transcript, limits, blocked, watch,
  };
  fs.writeFileSync(path.join(dir, 'inspecao.json'), JSON.stringify(insp, null, 2), 'utf8');
  return insp;
}

/** Ferramentas encontradas neste computador (no PATH ou nos lugares já usados pelo Chefe). */
export function findTools(home: string, which: (cmd: string) => string | null): VideoTools {
  const whisperDir = path.join(home, 'projetos', 'remotion-video', '.whisper');
  const exe = path.join(whisperDir, 'main.exe'); const model = path.join(whisperDir, 'ggml-medium.bin');
  const font = ['C:\\Windows\\Fonts\\arialbd.ttf', 'C:\\Windows\\Fonts\\arial.ttf'].find(f => fs.existsSync(f)) ?? null;
  return {
    ytdlp: which('yt-dlp'), ffmpeg: which('ffmpeg') ?? 'ffmpeg', ffprobe: which('ffprobe') ?? 'ffprobe',
    whisper: fs.existsSync(exe) && fs.existsSync(model) ? { exe, model } : null, font, watch: findWatch(path.join(home, '.claude'), which),
  };
}

/** Texto curto com os tempos (para o pedido do pesquisador e a reunião). */
export const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/** Evidências medidas pela HQ, em texto (vai para o pesquisador, para a reunião e para a produção). Só o que foi medido. */
export function evidenceMarkdown(i: Inspection): string {
  const L: string[] = ['# Evidências medidas pela HQ', '', `Consulta: ${i.at}${i.url ? ` · link: ${i.url}` : ' · vídeo anexado pelo Chefe'}`, `Nível da inspeção: ${INSPECTION_LEVEL_LABEL[i.level]}.`, '', i.summary, ''];
  if (i.meta) {
    L.push('## Post', `- Título/legenda: ${i.meta.title ?? 'indisponível'}`, `- Autor: ${i.meta.author ?? 'indisponível'}${i.meta.authorId ? ` (${i.meta.authorId})` : ''}`,
      `- Plataforma: ${i.meta.platform ?? 'indisponível'} · publicado em ${i.meta.uploadDate ?? 'data indisponível'}`,
      `- Métricas públicas na consulta: ${i.meta.metrics.length ? i.meta.metrics.map(m => `${m.name} ${m.value.toLocaleString('pt-BR')}`).join(', ') : 'indisponíveis'} (números acumulados; não provam crescimento atual)`,
      `- Mesma mídia do link: ${i.sameMedia === true ? 'sim (id do post confere)' : i.sameMedia === false ? 'NÃO confere' : 'não conferido'}`, '');
  }
  if (i.media) {
    L.push('## Vídeo', `- Duração ${i.media.duration.toFixed(1)} s · ${i.media.width}×${i.media.height}${i.media.fps ? ` · ${i.media.fps} fps` : ''} · ${i.media.audio ? 'com faixa de áudio' : 'sem áudio'}`);
    L.push(`- Cortes medidos (mudança de cena do FFmpeg): ${i.cuts.length ? i.cuts.map(fmtTime).join(', ') : 'nenhum (um plano contínuo ou mudanças suaves)'}`);
    L.push(`- Planos: ${i.shots.map(s => `${fmtTime(s.start)}–${fmtTime(s.end)} (${s.duration.toFixed(1)} s)`).join('; ')}`);
    L.push(`- Folhas de quadros: ${i.sheets.length} (um quadro a cada ${i.frameStep} s, com a marcação de tempo no canto)`, '');
  }
  if (i.audio?.present) {
    L.push('## Som (medido, não ouvido)', `- Volume integrado: ${i.audio.loudnessLufs ?? 'não medido'} LUFS`,
      `- Silêncios (abaixo de −40 dB por 0,5 s ou mais): ${i.audio.silences.length ? i.audio.silences.map(s => `${fmtTime(s.start)}–${fmtTime(s.end)}`).join(', ') : 'nenhum'}`,
      `- Transcrição automática (whisper.cpp, idioma ${i.transcript?.lang ?? '?'}): ${i.transcript?.segments.length ? '' : 'nenhuma fala reconhecida (pode haver música, efeitos ou fala inaudível: não verificado)'}`);
    for (const s of i.transcript?.segments ?? []) L.push(`  - ${fmtTime(s.start)}–${fmtTime(s.end)}: ${s.text}`);
    L.push('');
  }
  if (i.watch) {
    L.push('## Skill Watch (quadros por cena)', i.watch.ok
      ? `- ${i.watch.frames.length} quadro(s) escolhidos pela Watch${i.watch.version ? ` ${i.watch.version}` : ''} (motor local, pelo ${i.watch.source}), com o tempo no vídeo: ${i.watch.frames.map(f => f.t).join(', ')}`
      : `- não assistiu: ${i.watch.error ?? 'motivo desconhecido'}`);
    if (i.watch.transcript) L.push(`- Transcrição segundo a Watch: ${i.watch.transcript}`);
    if (i.watch.report) L.push(`- Relatório completo: \`${i.watch.report}\``);
    L.push('');
  }
  L.push('## Limites desta inspeção', ...i.limits.map(l => `- ${l}`));
  return L.join('\n') + '\n';
}
