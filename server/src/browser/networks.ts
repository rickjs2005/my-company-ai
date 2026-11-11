// Como cada rede é operada pela interface do site: onde entrar, onde fica a conta logada e como ler a identidade na própria
// página (link "Perfil" da navegação, redirecionamento de /in/me no LinkedIn). Nada de endpoint privado: só páginas que o
// Chefe também vê. Os seletores preferem papel e nome acessível; o atributo de teste só entra como reserva documentada.
import type { Page } from 'playwright-core';
import type { SocialNetwork } from '@milweb-hq/protocol';

export interface Identity { loggedIn: boolean; handle: string | null; name: string | null; evidence: string }

export interface NetworkDef {
  network: SocialNetwork;
  /** Onde o Chefe faz o primeiro login. */
  loginUrl: string;
  /** Página da conta logada usada para ler a identidade. */
  homeUrl: string;
  /** Domínios dos cookies de sessão e os nomes que indicam conta logada (só presença; o valor nunca é lido nem guardado). */
  cookieUrls: string[];
  authCookies: string[];
  /** Agendamento nativo no site: 'sim' conhecido, 'nao' conhecido, 'desconhecido' até ser testado na conta. */
  scheduleNative: 'sim' | 'nao' | 'desconhecido';
  identity(page: Page): Promise<Identity>;
}

const PROFILE_NAME = /^(perfil|profile|seu perfil|your profile)$/i;
const LOGIN_TEXT = /^(entrar|log ?in|fazer login|sign in|iniciar sessão)$/i;

/** Espera, por no máximo `ms`, até a página mostrar a conta (link de perfil) ou o convite de login. Condição, não tempo fixo. */
async function settle(page: Page, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const profile = await page.getByRole('link', { name: PROFILE_NAME }).count().catch(() => 0);
    const login = await page.getByRole('button', { name: LOGIN_TEXT }).count().catch(() => 0) + await page.getByRole('link', { name: LOGIN_TEXT }).count().catch(() => 0);
    if (profile > 0 || login > 0) return;
    await page.waitForTimeout(400);
  }
}

/** Lê o @ do link "Perfil" da navegação lateral/superior. `re` extrai o @ do href. */
async function fromProfileLink(page: Page, re: RegExp): Promise<{ handle: string | null; evidence: string }> {
  const links = page.getByRole('link', { name: PROFILE_NAME });
  const n = await links.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const href = await links.nth(i).getAttribute('href').catch(() => null);
    const m = href ? re.exec(href) : null;
    if (m) return { handle: m[1], evidence: `link "Perfil" da navegação aponta para ${href}` };
  }
  // Diagnóstico honesto: onde a página estava e quais links de navegação ela mostrava (sem conteúdo do feed).
  const url = page.url(); const title = await page.title().catch(() => '');
  const navNames = await page.getByRole('navigation').getByRole('link').evaluateAll(ls => ls.slice(0, 12).map(l => (l.getAttribute('aria-label') || (l as { textContent: string | null }).textContent || '').trim().slice(0, 30))).catch(() => [] as string[]);
  return { handle: null, evidence: `${n ? `link "Perfil" encontrado sem @ legível (${n})` : 'link "Perfil" não encontrado'} em ${url} ("${title.slice(0, 60)}"); links da navegação: ${navNames.filter(Boolean).join(' | ') || 'nenhum'}` };
}

async function loginVisible(page: Page, urlRe: RegExp): Promise<boolean> {
  if (urlRe.test(page.url())) return true;
  const btn = await page.getByRole('button', { name: LOGIN_TEXT }).count().catch(() => 0);
  const lnk = await page.getByRole('link', { name: LOGIN_TEXT }).count().catch(() => 0);
  return btn + lnk > 0;
}

async function gotoHome(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page);
}

export const NETWORKS: Record<SocialNetwork, NetworkDef> = {
  instagram: {
    network: 'instagram', loginUrl: 'https://www.instagram.com/accounts/login/', homeUrl: 'https://www.instagram.com/',
    cookieUrls: ['https://www.instagram.com'], authCookies: ['sessionid'], scheduleNative: 'desconhecido',
    async identity(page) {
      await gotoHome(page, this.homeUrl);
      const p = await fromProfileLink(page, /^\/([A-Za-z0-9._]+)\/?$/);
      if (p.handle) return { loggedIn: true, handle: p.handle, name: null, evidence: p.evidence };
      // Reserva: a foto de perfil da navegação traz o @ no texto alternativo ("Foto do perfil de x" / "x's profile picture").
      const alts = await page.locator('img[alt]').evaluateAll(imgs => imgs.map(i => i.getAttribute('alt') ?? '')).catch(() => [] as string[]);
      for (const a of alts) {
        const m = /(?:foto do perfil de|profile picture of)\s+@?([A-Za-z0-9._]+)/i.exec(a) ?? /^([A-Za-z0-9._]+)'s profile picture$/i.exec(a);
        if (m) return { loggedIn: true, handle: m[1], name: null, evidence: `foto de perfil da navegação: "${a}"` };
      }
      return { loggedIn: !(await loginVisible(page, /\/accounts\/login/)), handle: null, name: null, evidence: p.evidence };
    },
  },
  threads: {
    network: 'threads', loginUrl: 'https://www.threads.com/login', homeUrl: 'https://www.threads.com/',
    cookieUrls: ['https://www.threads.com', 'https://www.threads.net'], authCookies: ['sessionid'], scheduleNative: 'desconhecido',
    async identity(page) {
      await gotoHome(page, this.homeUrl);
      const p = await fromProfileLink(page, /^(?:https:\/\/www\.threads\.(?:com|net))?\/@([A-Za-z0-9._]+)\/?$/);
      return { loggedIn: Boolean(p.handle) || !(await loginVisible(page, /\/login/)), handle: p.handle, name: null, evidence: p.evidence };
    },
  },
  tiktok: {
    network: 'tiktok', loginUrl: 'https://www.tiktok.com/login', homeUrl: 'https://www.tiktok.com/',
    cookieUrls: ['https://www.tiktok.com'], authCookies: ['sessionid', 'sid_tt'], scheduleNative: 'desconhecido',
    async identity(page) {
      await gotoHome(page, this.homeUrl);
      const p = await fromProfileLink(page, /^(?:https:\/\/www\.tiktok\.com)?\/@([A-Za-z0-9._]+)\/?(?:\?.*)?$/);
      return { loggedIn: Boolean(p.handle) || !(await loginVisible(page, /\/login/)), handle: p.handle, name: null, evidence: p.evidence };
    },
  },
  linkedin: {
    network: 'linkedin', loginUrl: 'https://www.linkedin.com/login', homeUrl: 'https://www.linkedin.com/in/me/',
    cookieUrls: ['https://www.linkedin.com'], authCookies: ['li_at'], scheduleNative: 'desconhecido',
    async identity(page) {
      // /in/me/ é o atalho do próprio LinkedIn para o perfil de quem está logado: o redirecionamento revela o endereço.
      await page.goto(this.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const until = Date.now() + 15_000;
      while (Date.now() < until && /\/in\/me\/?$/.test(new URL(page.url()).pathname)) await page.waitForTimeout(400);
      const u = new URL(page.url());
      if (/\/(login|authwall|checkpoint|uas\/login)/.test(u.pathname)) return { loggedIn: false, handle: null, name: null, evidence: `redirecionou para ${u.pathname}` };
      const m = /^\/in\/([^/]+)\/?$/.exec(u.pathname);
      const name = m ? await page.getByRole('heading', { level: 1 }).first().textContent({ timeout: 8_000 }).catch(() => null) : null;
      return { loggedIn: Boolean(m), handle: m ? decodeURIComponent(m[1]) : null, name: name?.trim() || null, evidence: m ? `/in/me/ levou a ${u.pathname}` : `endereço inesperado ${u.pathname}` };
    },
  },
  x: {
    network: 'x', loginUrl: 'https://x.com/i/flow/login', homeUrl: 'https://x.com/home',
    cookieUrls: ['https://x.com'], authCookies: ['auth_token'], scheduleNative: 'desconhecido',
    async identity(page) {
      await gotoHome(page, this.homeUrl);
      if (/\/i\/flow\/login|\/login/.test(page.url())) return { loggedIn: false, handle: null, name: null, evidence: `redirecionou para ${new URL(page.url()).pathname}` };
      const p = await fromProfileLink(page, /^\/([A-Za-z0-9_]{1,15})\/?$/);
      if (p.handle) return { loggedIn: true, handle: p.handle, name: null, evidence: p.evidence };
      // Reserva documentada: o próprio X marca o link do perfil da barra lateral com data-testid.
      const href = await page.locator('a[data-testid="AppTabBar_Profile_Link"]').getAttribute('href', { timeout: 5_000 }).catch(() => null);
      const m = href ? /^\/([A-Za-z0-9_]{1,15})$/.exec(href) : null;
      return { loggedIn: Boolean(m), handle: m ? m[1] : null, name: null, evidence: m ? `link do perfil da barra lateral aponta para ${href}` : p.evidence };
    },
  },
  pinterest: {
    network: 'pinterest', loginUrl: 'https://www.pinterest.com/login/', homeUrl: 'https://www.pinterest.com/',
    cookieUrls: ['https://www.pinterest.com', 'https://br.pinterest.com'], authCookies: ['_auth'], scheduleNative: 'desconhecido',
    async identity(page) {
      await gotoHome(page, this.homeUrl);
      const p = await fromProfileLink(page, /^(?:https:\/\/(?:br\.|www\.)?pinterest\.com)?\/([A-Za-z0-9_.-]+)\/?$/);
      if (p.handle && !/^(ideas|today|search|pin-builder|business|settings)$/i.test(p.handle)) return { loggedIn: true, handle: p.handle, name: null, evidence: p.evidence };
      return { loggedIn: !(await loginVisible(page, /\/login/)), handle: null, name: null, evidence: p.evidence };
    },
  },
};

/** Compara a identidade lida com o cadastro (sem @, sem diferença de caixa). LinkedIn compara o endereço /in/<slug>. */
export function sameAccount(network: SocialNetwork, detected: string | null, declaredHandle: string | null, declaredUrl: string | null): boolean {
  if (!detected) return false;
  const d = detected.replace(/^@/, '').toLowerCase();
  if (declaredHandle && declaredHandle.replace(/^@/, '').toLowerCase() === d) return true;
  if (declaredUrl) {
    try {
      const u = new URL(declaredUrl);
      const seg = network === 'linkedin' ? /\/in\/([^/]+)/.exec(u.pathname)?.[1] : u.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '');
      if (seg && decodeURIComponent(seg).toLowerCase() === d) return true;
    } catch { /* link inválido no cadastro */ }
  }
  return false;
}
