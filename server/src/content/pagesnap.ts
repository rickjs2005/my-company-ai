// Abre a página do post num Edge sem janela e sem conta (perfil limpo, nada da sessão do Chefe), espera carregar, guarda a
// captura e lê os metadados públicos (og:title, og:description, og:image). Diz se a página pediu login. Só leitura.
import { chromium } from 'playwright-core';
import type { PageSnapshot } from './videoref.js';

export async function pageSnapshot(url: string, png: string): Promise<PageSnapshot> {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, locale: 'pt-BR' });
    const page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3500);
    await page.screenshot({ path: png, fullPage: false });
    // Código que roda na página (texto, porque o servidor não tem os tipos do navegador).
    const meta = await page.evaluate(`(() => {
      const og = p => document.querySelector('meta[property="' + p + '"], meta[name="' + p + '"]')?.getAttribute('content') ?? null;
      const body = (document.body?.innerText ?? '').slice(0, 4000);
      return { title: og('og:title') ?? document.title ?? null, description: og('og:description'), image: og('og:image'), body };
    })()`) as { title: string | null; description: string | null; image: string | null; body: string };
    const loginWall = /(log in|sign up|entrar|cadastre-se|faça login|inicie sessão|prove your humanity|captcha)/i.test(meta.body) && !/video|vídeo/i.test(meta.title ?? '');
    return { ok: Boolean(res && res.status() < 400), title: meta.title, description: meta.description, image: meta.image, finalUrl: page.url(), loginWall, error: res && res.status() >= 400 ? `HTTP ${res.status()}` : null };
  } catch (e) {
    return { ok: false, title: null, description: null, image: null, finalUrl: null, loginWall: false, error: (e as Error).message.split('\n')[0] };
  } finally { await browser.close().catch(() => undefined); }
}
