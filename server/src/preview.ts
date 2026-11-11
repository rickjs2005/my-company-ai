// Prévia local de projeto (Marco 1): serve os arquivos estáticos da pasta do projeto para conferir a entrega no navegador.
// Roda num servidor SEPARADO, em porta aleatória de 127.0.0.1: é outra origem, então os scripts do site não alcançam o
// token da HQ (guardado na aba da HQ). Cada projeto tem uma chave imprevisível na URL. Só leitura; nada é gravado.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Project } from '@milweb-hq/protocol';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.srt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};
/** Onde costuma estar a página inicial de um site estático. */
const ENTRY_CANDIDATES = ['index.html', 'public/index.html', 'dist/index.html', 'src/index.html', 'docs/index.html'];

export function previewKey(secret: string, projectId: string): string {
  return createHash('sha256').update(`preview:${secret}:${projectId}`).digest('hex').slice(0, 24);
}

function inside(root: string, p: string): boolean {
  const r = root.toLowerCase(); const x = p.toLowerCase();
  return x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

export interface PreviewDeps {
  secret: string;
  listProjects(): Project[];
  /** Pastas que nunca são servidas (dados da HQ: token, banco). */
  blockedDirs: string[];
  log?: { info(m: string): void; warn(m: string, e?: unknown): void };
}

export class PreviewServer {
  private server: http.Server | null = null;
  private port = 0;
  constructor(private readonly d: PreviewDeps) {}

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    this.d.log?.info(`prévia local de projetos em http://127.0.0.1:${this.port} (outra origem, só leitura)`);
    return this.port;
  }

  async stop(): Promise<void> {
    const s = this.server; this.server = null;
    if (s) await new Promise<void>(r => s.close(() => r()));
  }

  /** URL da prévia do projeto (página inicial encontrada) ou o motivo de não haver. */
  async urlFor(project: Project): Promise<{ url: string; entry: string } | { error: string }> {
    let root: string;
    try { root = fs.realpathSync(project.path); } catch { return { error: `a pasta do projeto não existe: ${project.path}` }; }
    const entry = ENTRY_CANDIDATES.find(c => { try { return fs.statSync(path.join(root, c)).isFile(); } catch { return false; } });
    if (!entry) return { error: 'não achei uma página inicial (index.html) na pasta do projeto. Para sites com servidor de desenvolvimento, use a URL dele no campo de prévia.' };
    const port = await this.start();
    return { url: `http://127.0.0.1:${port}/${previewKey(this.d.secret, project.id)}/${entry}`, entry };
  }

  /** URL de um arquivo de qualquer projeto cadastrado (visualizador da HQ: imagem, vídeo, PDF). Erro com o motivo real:
   *  arquivo inexistente, pasta, dados da HQ ou fora das pastas cadastradas. */
  async fileUrl(abs: string): Promise<{ url: string; real: string; projectId: string }> {
    let real: string;
    try { real = fs.realpathSync(abs); } catch { throw new Error(`o arquivo não existe: ${abs}`); }
    if (!fs.statSync(real).isFile()) throw new Error(`não é um arquivo (é uma pasta): ${abs}`);
    if (this.d.blockedDirs.some(b => inside(path.resolve(b), real))) throw new Error('arquivo da pasta de dados da HQ: não é mostrado');
    for (const p of this.d.listProjects()) {
      let root: string;
      try { root = fs.realpathSync(p.path); } catch { continue; }
      if (!inside(root, real)) continue;
      const port = await this.start();
      const rel = path.relative(root, real).split(path.sep).map(encodeURIComponent).join('/');
      return { url: `http://127.0.0.1:${port}/${previewKey(this.d.secret, p.id)}/${rel}`, real, projectId: p.id };
    }
    throw new Error('o arquivo está fora das pastas de projeto cadastradas na HQ');
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const fail = (code: number, text: string) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'só leitura');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = /^\/([a-f0-9]{24})(\/.*)?$/.exec(url.pathname);
    if (!m) return fail(404, 'prévia não encontrada');
    const project = this.d.listProjects().find(p => previewKey(this.d.secret, p.id) === m[1]);
    if (!project) return fail(404, 'prévia não encontrada (projeto removido da HQ?)');
    let root: string;
    try { root = fs.realpathSync(project.path); } catch { return fail(404, 'a pasta do projeto não existe'); }
    let rel: string;
    try { rel = decodeURIComponent(m[2] ?? '/'); } catch { return fail(400, 'caminho inválido'); }
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(root, '.' + rel);
    let real: string;
    try { real = fs.realpathSync(file); } catch { return fail(404, `arquivo não encontrado: ${rel}`); }
    // Nada fora da pasta do projeto (nem por "..", link ou junction) e nada da pasta de dados da HQ.
    if (!inside(root, real) || this.d.blockedDirs.some(b => inside(path.resolve(b), real))) return fail(403, 'fora da pasta do projeto');
    if (fs.statSync(real).isDirectory()) { file = path.join(real, 'index.html'); try { real = fs.realpathSync(file); } catch { return fail(404, 'pasta sem index.html'); } }
    const ext = path.extname(real).toLowerCase();
    const size = fs.statSync(real).size;
    const head = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    // Pedido parcial (o vídeo pede pedaços para começar logo e para pular): 206 com o trecho pedido.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(real, { start, end }).on('error', () => res.destroy()).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, 'Content-Length': String(size) });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
  }
}
