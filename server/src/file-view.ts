// Visualizador da HQ: abre o resultado dentro da própria tela (imagem, vídeo, texto) em vez de mandar o Chefe procurar a pasta.
// Só arquivos de pastas de projeto cadastradas (a mesma regra da prévia local) e nunca a pasta de dados da HQ. Um caminho
// citado por um funcionário só vira prévia se o arquivo existir de verdade.
import fs from 'node:fs';
import path from 'node:path';
import type { FileView, FileViewKind } from '@milweb-hq/protocol';

const KIND: Record<string, FileViewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio',
  md: 'text', markdown: 'text', txt: 'text', csv: 'text', json: 'text', srt: 'text', vtt: 'text', html: 'text', yml: 'text', yaml: 'text',
  pdf: 'pdf',
};
const MAX_TEXT = 512 * 1024;

export function viewKind(p: string): FileViewKind {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return (m && KIND[m[1].toLowerCase()]) || 'other';
}

export interface FileUrlSource { fileUrl(abs: string): Promise<{ url: string; real: string }> }

export async function viewFile(abs: string, preview: FileUrlSource | undefined): Promise<FileView> {
  if (typeof abs !== 'string' || !abs.trim() || !path.isAbsolute(abs)) throw new Error('caminho inválido');
  const p = path.normalize(abs.trim());
  if (!fs.existsSync(p)) throw new Error(`o arquivo não existe: ${p}`);
  if (!preview) throw new Error('o visualizador não está disponível neste serviço');
  // fileUrl valida: arquivo (não pasta), dentro de um projeto cadastrado e fora dos dados da HQ.
  const { url, real } = await preview.fileUrl(p);
  const st = fs.statSync(real);
  const kind = viewKind(real);
  let text: string | null = null; let truncated = false;
  if (kind === 'text') {
    const len = Math.min(st.size, MAX_TEXT);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(real, 'r');
    try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8'); truncated = st.size > MAX_TEXT;
  }
  return { path: p, name: path.basename(p), kind, size: st.size, mtime: st.mtimeMs, url: kind === 'text' ? null : url, text, truncated };
}
