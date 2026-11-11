// HTTP mínimo: serve o frontend compilado (web/dist) e um /api/health. Nada de segredo passa por aqui.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

/** Rotas extras ligadas depois que os serviços sobem (ex.: retorno do login das redes). Devolve true quando tratou. */
export type HttpHook = (url: URL, req: http.IncomingMessage, res: http.ServerResponse) => boolean;

export function createHttpServer(cfg: Config, health: () => Record<string, unknown>, hooks: HttpHook[] = []): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${cfg.host}:${cfg.port}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    for (const hook of hooks) if (hook(url, req, res)) return;
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ...health() }));
      return;
    }
    if (!cfg.webDist) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>MilWeb HQ</title><body style="font-family:sans-serif;background:#121014;color:#ece6dc;padding:40px"><h1>MilWeb HQ</h1><p>O frontend ainda não foi compilado (<code>pnpm --filter @milweb-hq/web build</code>). Em desenvolvimento, abra o Vite em <a href="http://127.0.0.1:5173" style="color:#f0a830">http://127.0.0.1:5173</a>.</p></body>');
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(cfg.webDist, '.' + rel);
    if (!file.startsWith(cfg.webDist)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(cfg.webDist, 'index.html'); // SPA
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
}
