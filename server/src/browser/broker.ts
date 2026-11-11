// Navegador da HQ: o ÚNICO componente que abre o navegador, escolhe a conta, controla o acesso e devolve eventos à tarefa.
// Dois motores:
// - 'extensao' (padrão, pedido do Chefe em 02/11/2026): o Edge que o Chefe já usa, com os logins dele, pela extensão oficial do
//   Playwright (Playwright Extension). A HQ trabalha numa aba própria e nunca fecha o navegador nem as abas dele.
// - 'perfil': um perfil persistente por conta (id do cartão) em %LOCALAPPDATA%\MilWebHQ\browser-profiles\<id>: sessões separadas
//   (os dois Instagrams nunca dividem cookies) e fora do repositório, do banco, dos prompts e dos logs.
// - Uma janela por vez (notebook de 8 GB), aberta sob demanda e fechada quando ociosa; a sessão fica no perfil.
// - O login é sempre do Chefe, na janela visível: CAPTCHA, 2FA e verificações das redes ficam com ele (nada é contornado).
// - Identidade lida na interface do site antes de agir; publicar só passa pela porta de publicação (aprovação, conta,
//   texto e destino conferidos, intenção gravada antes do clique, "resultado a verificar" quando não há confirmação).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import type { DatabaseSync } from 'node:sqlite';
import type { BrowserAccount, BrowserCap, BrowserCapKey, BrowserState, SocialAccount, SocialNetwork, SocialSlotId } from '@milweb-hq/protocol';
import { BROWSER_CAP_LABEL, SOCIAL_POST_HOSTS, SOCIAL_SLOTS, isSocialSlot, slotDef } from '@milweb-hq/protocol';
import { NETWORKS, sameAccount, type NetworkDef } from './networks.js';

export const BROWSER_ENGINE = 'playwright-core 1.64.1 + Microsoft Edge instalado (channel msedge)';
export const EXTENSION_INSTALL_URL = 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm';

/** Conecta ao Edge do Chefe pela Playwright Extension (relay oficial do playwright-core; versão fixada 1.64.1). */
export async function attachEdgeExtension(workspaceDir: string, token: string | null): Promise<Browser> {
  if (token) process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token; else delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  const core = createRequire(import.meta.url)('playwright-core/lib/coreBundle') as { tools: { createBrowserWithInfo(config: unknown, client: unknown, cli: unknown, bind: unknown): Promise<{ browser: Browser }> } };
  const config = { extension: true, browser: { browserName: 'chromium', isolated: false, launchOptions: { channel: 'msedge', headless: false }, contextOptions: {} }, timeouts: {} };
  const info = await core.tools.createBrowserWithInfo(config, { clientName: 'MilWeb HQ' }, { browser: 'msedge' }, { title: 'MilWeb HQ', workspaceDir });
  return info.browser;
}
const CAP_KEYS: BrowserCapKey[] = ['pesquisar', 'ler_metricas', 'preparar', 'publicar', 'agendar'];
/** Nome de botão que publica ou agenda: só a porta de publicação pode acioná-lo. */
export const FINAL_ACTION = /^\s*(publicar|postar|compartilhar|share|post|publish|tweet|agendar|schedule|enviar|send|pin it|salvar e publicar|publicar agora|post all|postar tudo)\b/i;
const SNAPSHOT_MAX = 15_000;

/**
 * Pesquisa de tendências (pedido do Chefe, 06/11/2026): ler X, Reddit, Instagram e Threads direto no Edge dele, numa aba
 * própria da HQ, sem abrir conta nem conferir @. A conferência de identidade continua valendo para preparar, publicar e
 * ler métricas; para LER a rede ela só atrapalhava (o Radar rodava com as fontes "bloqueadas" sem nem abrir o navegador).
 */
export const RESEARCH_SITES: Record<string, string> = { 'x.com': 'X', 'twitter.com': 'X', 'reddit.com': 'Reddit', 'instagram.com': 'Instagram', 'threads.com': 'Threads', 'threads.net': 'Threads' };
/** Na pesquisa nada interage com a rede: curtir, seguir, repostar, responder, salvar, compartilhar, votar, entrar... */
export const RESEARCH_BLOCKED = /\b(curtir|descurtir|curtido|like|liked|unlike|seguir|seguindo|deixar de seguir|follow|following|unfollow|repost|repostar|retweet|unretweet|responder|reply|comentar|comment|salvar|salvo|save|saved|bookmark|guardar|compartilhar|share|enviar|send|mensagem|message|participar|join|joined|upvote|downvote|votar|vote|denunciar|report|bloquear|block|silenciar|mute|award|assinar|subscribe)\b/i;
const RESEARCH_TESTID = /(like|retweet|reply|bookmark|follow|share|vote|join|subscribe|award)/i;
/** Página de login: a rede não está logada no Edge do Chefe (a HQ não entra em conta). */
const LOGIN_WALL = /\/(i\/flow\/login|login|accounts\/login|signin|account\/login)(\/|$)/i;

export class BrowserError extends Error {}

/** O que a porta de publicação precisa da sala de conteúdo (aprovação, peça, registro da intenção e do resultado). */
export interface ContentGate {
  folder(): string | null;
  publishGate(itemId: string, slot: SocialSlotId): { ok: true; text: string; title: string | null; files: string[]; destinationUrl: string | null } | { ok: false; reason: string };
  openAttempt(itemId: string): { clientId: string; status: string } | null;
  browserIntent(itemId: string, slot: SocialSlotId, mode: 'publicar' | 'agendar', when: string | null): string;
  browserClicked(itemId: string, clientId: string, signal: string): void;
  browserUncertain(itemId: string, clientId: string, reason: string): void;
  browserNotFound(itemId: string, evidence: string): void;
  browserPublished(itemId: string, url: string | null, detail: string, mode: 'publicar' | 'agendar'): void;
  browserResult(r: { slot: SocialSlotId; itemId: string | null; postUrl: string | null; metric: string; value: number | null; unit: string | null; periodStart: string | null; periodEnd: string | null; denominator: string | null; evidencePath: string | null; note: string | null }): void;
}

export interface BrokerDeps {
  db: DatabaseSync;
  profilesRoot: string;
  account(slot: SocialSlotId): SocialAccount;
  content: ContentGate;
  /** Aviso na conversa da tarefa (linha do tempo do funcionário). */
  notify(sessionId: string, level: 'info' | 'warn' | 'error', text: string): void;
  sessionLabel(sessionId: string): string;
  onChange(): void;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
  networks?: Partial<Record<SocialNetwork, NetworkDef>>;
  /** 'extensao' = Edge do Chefe pela extensão oficial (padrão); 'perfil' = perfil persistente próprio da HQ por conta. */
  engine?: 'extensao' | 'perfil';
  /** Conexão com o Edge do Chefe (padrão: attachEdgeExtension). Testes injetam outra. */
  attach?: () => Promise<Browser>;
  /** Token de pareamento da extensão (cofre). Sem ele, cada conexão pede para o Chefe aprovar na aba da extensão. */
  extensionToken?: () => Promise<string | null>;
  headless?: boolean;
  channel?: string;
  /** Sites liberados para a pesquisa (padrão RESEARCH_SITES). Testes injetam o site falso. */
  researchSites?: Record<string, string>;
  idleMs?: number;
  loginWatchMs?: number;
  now?(): number;
}

interface Row {
  slot: string; mode: string; state: string; detail: string | null; detected_handle: string | null; detected_name: string | null; detected_at: number | null;
  verified_at: number | null; last_check_at: number | null; last_error: string | null; caps_json: string; updated_at: number;
}

interface Cur {
  slot: SocialSlotId; ctx: BrowserContext; page: Page; owner: string | null; manual: boolean; needsReread: boolean; since: number; lastUse: number;
  verifiedAt: number | null; etapa: string | null;
}

/** Aba de pesquisa: independente da conta aberta, uma só, de um funcionário por vez. */
interface Res { page: Page; owner: string | null; lastUse: number }

const blankCaps = (): Record<BrowserCapKey, BrowserCap> => Object.fromEntries(CAP_KEYS.map(k => [k, { state: 'nao_testada', detail: 'ainda não testada pela HQ', at: null }])) as Record<BrowserCapKey, BrowserCap>;
const norm = (t: string) => t.replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
const words = (t: string, n: number) => norm(t).split(' ').filter(Boolean).slice(0, n).join(' ');

export class BrowserBroker {
  private cur: Cur | null = null;
  private res: Res | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private tokens = new Map<string, string>(); // token -> sessionId
  private ext: { browser: Browser; ctx: BrowserContext } | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private loginWatch: NodeJS.Timeout | null = null;
  private now: () => number;

  constructor(private deps: BrokerDeps) {
    this.now = deps.now ?? Date.now;
    const ins = deps.db.prepare("INSERT OR IGNORE INTO browser_accounts(slot, mode, state, caps_json, updated_at) VALUES (?, 'navegador', 'cadastrada', ?, ?)");
    for (const s of SOCIAL_SLOTS) ins.run(s.slot, JSON.stringify(blankCaps()), this.now());
    fs.mkdirSync(deps.profilesRoot, { recursive: true });
  }

  private net(slot: SocialSlotId): NetworkDef { const n = slotDef(slot).network; return this.deps.networks?.[n] ?? NETWORKS[n]; }
  private row(slot: SocialSlotId): Row { return this.deps.db.prepare('SELECT * FROM browser_accounts WHERE slot=?').get(slot) as unknown as Row; }
  private save(slot: SocialSlotId, p: Partial<{ state: BrowserState; detail: string | null; detected_handle: string | null; detected_name: string | null; detected_at: number | null; verified_at: number | null; last_check_at: number | null; last_error: string | null; mode: string }>): void {
    const cur = this.row(slot); const x = { ...cur, ...p };
    this.deps.db.prepare('UPDATE browser_accounts SET mode=?, state=?, detail=?, detected_handle=?, detected_name=?, detected_at=?, verified_at=?, last_check_at=?, last_error=?, updated_at=? WHERE slot=?')
      .run(x.mode, x.state, x.detail, x.detected_handle, x.detected_name, x.detected_at, x.verified_at, x.last_check_at, x.last_error, this.now(), slot);
    this.deps.onChange();
  }
  setCap(slot: SocialSlotId, key: BrowserCapKey, state: BrowserCap['state'], detail: string): void {
    const caps = { ...blankCaps(), ...JSON.parse(this.row(slot).caps_json || '{}') } as Record<BrowserCapKey, BrowserCap>;
    // Testada continua testada (com a data) até alguém marcar indisponível com motivo; "não testada" nunca apaga um teste.
    if (state === 'nao_testada' && caps[key].state === 'testada') return;
    caps[key] = { state, detail, at: state === 'testada' ? this.now() : caps[key].at };
    this.deps.db.prepare('UPDATE browser_accounts SET caps_json=?, updated_at=? WHERE slot=?').run(JSON.stringify(caps), this.now(), slot);
    this.deps.onChange();
  }

  view(slot: SocialSlotId): BrowserAccount {
    const r = this.row(slot);
    const open = this.cur?.slot === slot;
    return {
      mode: r.mode === 'api' ? 'api' : 'navegador', state: r.state as BrowserState, detail: r.detail ?? '', detectedHandle: r.detected_handle, detectedName: r.detected_name,
      detectedAt: r.detected_at, verifiedAt: r.verified_at, lastCheckAt: r.last_check_at, lastError: r.last_error,
      caps: { ...blankCaps(), ...JSON.parse(r.caps_json || '{}') }, open,
      owner: open ? (this.cur!.owner === 'login' ? 'login do Chefe' : this.cur!.owner === 'chefe' ? 'Chefe' : this.cur!.owner ? this.deps.sessionLabel(this.cur!.owner) : null) : null,
      manual: open ? this.cur!.manual : false,
    };
  }
  openInfo(): { slot: SocialSlotId; owner: string | null; manual: boolean; since: number } | null {
    return this.cur ? { slot: this.cur.slot, owner: this.view(this.cur.slot).owner, manual: this.cur.manual, since: this.cur.since } : null;
  }
  profilesDir(): string { return this.deps.profilesRoot; }
  mode(): 'extensao' | 'perfil' { return this.engine(); }
  setMode(slot: SocialSlotId, mode: 'navegador' | 'api'): void { this.save(slot, { mode }); }

  // ------------------------------------------------------------------ fila única de operações
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async launch(slot: SocialSlotId, owner: string | null): Promise<Cur> {
    if (this.cur?.slot === slot) { if (owner) this.cur.owner = owner; this.cur.lastUse = this.now(); return this.cur; }
    if (this.cur) {
      if (this.cur.manual) throw new BrowserError(`O Chefe está no controle da janela de ${slotDef(this.cur.slot).label}. Espere ele devolver ou siga com o que não depende do navegador.`);
      const other = this.cur.owner && owner && this.cur.owner !== owner && this.cur.owner !== 'chefe';
      if (other && this.cur.owner === 'login') throw new BrowserError(`A janela de ${slotDef(this.cur.slot).label} está esperando o login do Chefe. Siga com o que não depende do navegador.`);
      if (other && this.now() - this.cur.lastUse < 90_000) throw new BrowserError(`O navegador está com ${this.deps.sessionLabel(this.cur.owner!)} (${slotDef(this.cur.slot).label}). Uma operação de navegador por vez: tente de novo em alguns minutos e siga com o resto.`);
      await this.closeCur('troca de conta');
    }
    if (this.engine() === 'extensao') {
      const ext = await this.edge();
      // Uma aba própria da HQ no Edge do Chefe; as abas dele não são tocadas.
      const page = await ext.ctx.newPage();
      const cur: Cur = { slot, ctx: ext.ctx, page, owner, manual: false, needsReread: false, since: this.now(), lastUse: this.now(), verifiedAt: null, etapa: null };
      page.on('close', () => { if (this.cur?.page === page) { this.cur = null; this.deps.onChange(); } });
      this.cur = cur;
      this.armIdle();
      this.deps.log.info(`navegador: aba da HQ aberta no Edge do Chefe para ${slot}`);
      this.deps.onChange();
      return cur;
    }
    const dir = path.join(this.deps.profilesRoot, slot);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(dir, {
      channel: this.deps.channel ?? 'msedge', headless: this.deps.headless ?? false, viewport: { width: 1280, height: 860 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const page = ctx.pages()[0] ?? await ctx.newPage();
    const cur: Cur = { slot, ctx, page, owner, manual: false, needsReread: false, since: this.now(), lastUse: this.now(), verifiedAt: null, etapa: null };
    ctx.on('close', () => { if (this.cur?.ctx === ctx) { this.cur = null; this.deps.onChange(); } });
    this.cur = cur;
    this.armIdle();
    this.deps.log.info(`navegador: perfil de ${slot} aberto${owner ? ` (${owner === 'login' ? 'login' : owner === 'chefe' ? 'Chefe' : this.deps.sessionLabel(owner)})` : ''}`);
    this.deps.onChange();
    return cur;
  }

  private engine(): 'extensao' | 'perfil' { return this.deps.engine ?? 'perfil'; }
  engineLabel(): string { return this.engine() === 'extensao' ? 'seu Edge (logins que você já usa) pela Playwright Extension · playwright-core 1.64.1' : BROWSER_ENGINE; }

  /** Conexão com o Edge do Chefe (reaproveitada enquanto a extensão estiver ligada). */
  private async edge(): Promise<{ browser: Browser; ctx: BrowserContext }> {
    if (this.ext && this.ext.browser.isConnected()) return this.ext;
    let browser: Browser;
    try {
      const attach = this.deps.attach ?? (async () => attachEdgeExtension(this.deps.profilesRoot, (await this.deps.extensionToken?.()) ?? null));
      browser = await Promise.race([attach(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), 120_000))]);
    } catch (err) {
      const m = (err as Error).message;
      if (/Extension not found|extension did not connect|not installed/i.test(m)) throw new BrowserError(`A Playwright Extension não está instalada (ou não conectou) no seu Edge. Instale em ${EXTENSION_INSTALL_URL} e deixe o Edge aberto.`);
      if (/tempo esgotado/.test(m)) throw new BrowserError('O Edge não confirmou a conexão em 2 minutos: aprove a conexão na aba da Playwright Extension que abriu no seu Edge.');
      throw new BrowserError(`Não consegui conectar ao seu Edge: ${m.slice(0, 200)}`);
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new BrowserError('A extensão conectou, mas o Edge não expôs nenhuma janela.');
    browser.on('disconnected', () => { this.ext = null; this.res = null; if (this.cur) { this.cur = null; this.deps.onChange(); } });
    this.ext = { browser, ctx };
    return this.ext;
  }

  private async closeCur(why: string): Promise<void> {
    const c = this.cur; if (!c) return;
    this.cur = null;
    if (this.loginWatch && why !== 'login concluído') { clearInterval(this.loginWatch); this.loginWatch = null; }
    if (this.engine() === 'extensao') {
      try { await c.page.close(); } catch { /* aba já fechada */ }
      this.deps.log.info(`navegador: aba da HQ fechada (${why}); o Edge do Chefe continua como estava`);
      this.deps.onChange();
      return;
    }
    try { await c.ctx.close(); } catch { /* já fechado pelo Chefe */ }
    this.deps.log.info(`navegador: perfil de ${c.slot} fechado (${why}); a sessão continua guardada no perfil`);
    this.deps.onChange();
  }

  private armIdle(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      const r = this.res;
      if (r && this.now() - r.lastUse > (this.deps.idleMs ?? 180_000)) void this.exclusive(() => this.closeResearch('ociosa'));
      const c = this.cur; if (!c) return;
      if (c.manual || c.owner === 'login') return;
      if (this.now() - c.lastUse > (this.deps.idleMs ?? 180_000)) void this.exclusive(() => this.closeCur('ociosa'));
    }, 15_000);
    this.idleTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer); this.idleTimer = null;
    if (this.loginWatch) clearInterval(this.loginWatch); this.loginWatch = null;
    await this.closeResearch('encerramento da HQ');
    await this.closeCur('encerramento da HQ');
  }

  /** Quando a tarefa de um funcionário termina, a janela fica livre para outro (fecha sozinha se ficar ociosa). */
  release(sessionId: string): void {
    if (this.res?.owner === sessionId) this.res.owner = null;
    if (this.cur?.owner === sessionId) { this.cur.owner = null; this.deps.onChange(); }
  }

  // ------------------------------------------------------------------ pesquisa (só leitura, sem conta)
  private researchSites(): Record<string, string> { return this.deps.researchSites ?? RESEARCH_SITES; }

  /** Nome da rede liberada para pesquisa, ou null se o endereço estiver fora delas. */
  researchSite(raw: string): string | null {
    let u: URL; try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const h = u.hostname.toLowerCase();
    for (const [d, label] of Object.entries(this.researchSites())) if (h === d || h.endsWith('.' + d)) return label;
    return null;
  }

  private async researchTab(sessionId: string): Promise<Res> {
    if (this.engine() !== 'extensao') throw new BrowserError('A pesquisa pelo navegador usa o Edge do Chefe (motor "seu Edge"); com o motor de perfis ela não está disponível. Siga com WebSearch/WebFetch.');
    const r = this.res;
    if (r && !r.page.isClosed()) {
      if (r.owner && r.owner !== sessionId && this.now() - r.lastUse < 90_000) throw new BrowserError(`A aba de pesquisa está com ${this.deps.sessionLabel(r.owner)}. Tente de novo em alguns minutos e siga com o resto.`);
      r.owner = sessionId; r.lastUse = this.now();
      return r;
    }
    const ext = await this.edge();
    const page = await ext.ctx.newPage();
    const res: Res = { page, owner: sessionId, lastUse: this.now() };
    page.on('close', () => { if (this.res?.page === page) this.res = null; });
    this.res = res;
    this.armIdle();
    this.deps.log.info('navegador: aba de pesquisa aberta no Edge do Chefe');
    return res;
  }

  private ownResearch(sessionId: string): Res {
    const r = this.res;
    if (!r || r.page.isClosed() || (r.owner && r.owner !== sessionId)) throw new BrowserError('Nenhuma pesquisa aberta para você: use pesquisar com a URL primeiro.');
    r.owner = sessionId; r.lastUse = this.now();
    return r;
  }

  private async closeResearch(why: string): Promise<void> {
    const r = this.res; if (!r) return;
    this.res = null;
    try { await r.page.close(); } catch { /* aba já fechada */ }
    this.deps.log.info(`navegador: aba de pesquisa fechada (${why}); o Edge do Chefe continua como estava`);
  }

  /** Espera a página da rede montar (o conteúdo chega por script): texto com tamanho estável, no máximo 12 s. */
  private async settleResearch(page: Page): Promise<void> {
    const start = Date.now(); let last = -1;
    while (Date.now() - start < 12_000) {
      const n = await page.locator('body').innerText({ timeout: 2000 }).then(t => t.length, () => 0);
      // Feed carregado (texto estável e longo) ou página curta que já parou de mudar há alguns segundos.
      if (n === last && (n > 200 || (n > 0 && Date.now() - start > 2500))) return;
      last = n; await page.waitForTimeout(700);
    }
  }

  private async researchRead(page: Page, limite: unknown): Promise<string> {
    const site = this.researchSite(page.url()) ?? 'fora da pesquisa';
    const where = `Pesquisa · ${site}: ${page.url()} · ${await page.title().catch(() => '')}`;
    let p = ''; try { p = new URL(page.url()).pathname; } catch { /* about:blank */ }
    if (LOGIN_WALL.test(p)) return `${where}\n\nA página pediu login: o Edge do Chefe não está logado em ${site}. Registre essa fonte como bloqueada com esta mensagem e siga com as outras (a HQ não entra em conta).`;
    const lim = typeof limite === 'number' ? Math.min(Math.max(limite, 1000), 30_000) : SNAPSHOT_MAX;
    let text = await this.researchText(page);
    // Página pega no meio do carregamento (aconteceu com o Reddit na prova real): espera e lê de novo uma vez.
    if (text.trim().length < 300) { await page.waitForTimeout(2500); await this.settleResearch(page); text = await this.researchText(page); }
    if (text.trim().length < 300) text = await this.snapshot(page, lim);
    return `${where}\n\n${text.length > lim ? `${text.slice(0, lim)}\n… (cortado em ${lim} caracteres; use "rolar" ou abra a publicação)` : text}`;
  }

  /** As redes gastam milhares de caracteres com menu e barra lateral: a leitura começa pelo conteúdo principal (<main>). */
  private async researchText(page: Page): Promise<string> {
    const main = page.locator('main').first();
    const useMain = (await main.count().catch(() => 0)) > 0 && (await main.innerText({ timeout: 2000 }).then(t => t.length, () => 0)) > 200;
    const loc = useMain ? main : page.locator('body');
    const raw = await loc.ariaSnapshot({ timeout: 15_000 }).catch(async () => loc.innerText({ timeout: 5000 }).catch(() => ''));
    // Endereços de imagem e de rastreio com centenas de caracteres não dizem nada ao funcionário: encurtados.
    return raw.replace(/\S{160,}/g, s => `${s.slice(0, 80)}…`);
  }

  private async research(sessionId: string, tool: string, a: Record<string, unknown>): Promise<string> {
    if (tool === 'pesquisar') {
      const url = typeof a.url === 'string' && a.url.trim() ? a.url.trim() : null;
      if (url && !this.researchSite(url)) throw new BrowserError(`A pesquisa pelo navegador abre só ${[...new Set(Object.values(this.researchSites()))].join(', ')}. Para outros sites, use WebSearch/WebFetch.`);
      if (!url && (!this.res || this.res.page.isClosed())) throw new BrowserError('Diga a URL da primeira página da pesquisa.');
      const r = url ? await this.researchTab(sessionId) : this.ownResearch(sessionId);
      if (url) { await r.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); await this.settleResearch(r.page); }
      const vezes = Math.min(Math.max(Math.round(Number(a.rolar ?? 0)) || 0, 0), 10);
      for (let i = 0; i < vezes; i++) { await r.page.evaluate(() => { const w = globalThis as unknown as { scrollBy(x: number, y: number): void; innerHeight: number }; w.scrollBy(0, Math.round(w.innerHeight * 1.8)); }).catch(() => undefined); await r.page.waitForTimeout(1000); }
      r.lastUse = this.now();
      return this.researchRead(r.page, a.limite);
    }
    const r = this.ownResearch(sessionId);
    const t = (a.alvo && typeof a.alvo === 'object' ? a.alvo : {}) as Record<string, unknown>;
    if (tool === 'pesquisar_capturar') {
      const root = this.deps.content.folder(); if (!root) throw new BrowserError('A pasta de conteúdo não está configurada.');
      const stamp = new Date(this.now()).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(/[: ]/g, '-');
      const name = String(a.nome ?? 'referencia').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'referencia';
      const file = path.join(root, 'radar', 'capturas', `${stamp}-${name}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (Object.keys(t).length) { const { loc, desc } = this.locator(r.page, t); await (await this.single(loc, desc)).screenshot({ path: file, timeout: 20_000 }); }
      else await r.page.screenshot({ path: file, fullPage: false, timeout: 20_000 });
      return `Captura salva: ${file}`;
    }
    // pesquisar_clicar: abrir publicação, expandir texto, trocar de aba da página. Nada que interaja com a rede.
    if (!Object.keys(t).length) throw new BrowserError('Diga o alvo (papel + nome, como aparecem na leitura da página).');
    const { loc, desc } = this.locator(r.page, t);
    const el = await this.single(loc, desc);
    const aria = (await el.getAttribute('aria-label').catch(() => null)) ?? '';
    const testid = (await el.getAttribute('data-testid').catch(() => null)) ?? '';
    const inner = (await el.innerText({ timeout: 2000 }).catch(() => '')).trim().slice(0, 60);
    const named = String(t.nome ?? t.texto ?? '');
    if ([named, aria, inner].some(s => RESEARCH_BLOCKED.test(s) || FINAL_ACTION.test(s)) || RESEARCH_TESTID.test(testid)) {
      throw new BrowserError(`Pesquisa é só leitura: "${(aria || inner || named || testid).slice(0, 40)}" interage com a rede (curtir, seguir, repostar, responder, salvar, compartilhar, votar). Abra a publicação pelo link dela ou siga lendo.`);
    }
    const popup = r.page.waitForEvent('popup', { timeout: 2500 }).catch(() => null);
    await el.click({ timeout: 15_000 });
    const pop = await popup;
    if (pop) {
      const target = pop.url();
      await pop.close().catch(() => undefined);
      if (!this.researchSite(target)) return `O link abria fora das redes da pesquisa (${target}); não abri. Para ler esse endereço, use WebFetch.`;
      await r.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    await r.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await this.settleResearch(r.page);
    if (!this.researchSite(r.page.url())) {
      const fora = r.page.url();
      await r.page.goBack({ timeout: 15_000 }).catch(() => undefined);
      return `O clique levou para fora das redes da pesquisa (${fora}); voltei. Para ler esse endereço, use WebFetch.`;
    }
    return this.researchRead(r.page, a.limite ?? 8000);
  }

  // ------------------------------------------------------------------ ações da Central de Redes (Chefe)
  connect(slot: SocialSlotId): Promise<BrowserAccount> {
    if (this.engine() === 'extensao') {
      // No Edge do Chefe não há login novo: a conta é a que ele já usa. Conectar = abrir a aba da HQ e conferir a identidade.
      return this.exclusive(async () => {
        await this.launch(slot, 'chefe');
        const r = await this.verifyNow(slot, null);
        if (!r.ok && this.row(slot).state === 'aguardando_login') this.save(slot, { detail: 'o seu Edge não está logado nesta conta: entre nela no próprio Edge e clique em Verificar conta' });
        if (this.cur?.slot === slot) { this.cur.owner = null; this.cur.lastUse = this.now(); }
        return this.view(slot);
      });
    }
    return this.exclusive(async () => {
      const c = await this.launch(slot, 'login');
      await c.page.goto(this.net(slot).loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
      await c.page.bringToFront().catch(() => undefined);
      this.save(slot, { state: 'aguardando_login', detail: 'janela aberta: entre na conta direto no site (verificações, CAPTCHA e dois fatores são com você)', last_error: null });
      this.watchLogin(slot);
      return this.view(slot);
    });
  }

  /** Observa os cookies de sessão do perfil (só a presença) e confere a identidade numa aba nova, sem atrapalhar o login. */
  private watchLogin(slot: SocialSlotId): void {
    if (this.loginWatch) clearInterval(this.loginWatch);
    const until = this.now() + (this.deps.loginWatchMs ?? 15 * 60_000);
    let checking = false;
    this.loginWatch = setInterval(() => {
      if (checking) return;
      const c = this.cur;
      if (!c || c.slot !== slot) { clearInterval(this.loginWatch!); this.loginWatch = null; return; }
      if (this.now() > until) {
        clearInterval(this.loginWatch!); this.loginWatch = null;
        this.save(slot, { state: 'aguardando_login', detail: 'o login não foi concluído em 15 minutos: clique em Conectar pelo navegador de novo' });
        c.owner = null;
        return;
      }
      checking = true;
      void (async () => {
        try {
          const net = this.net(slot);
          const cookies = await c.ctx.cookies(net.cookieUrls);
          if (!cookies.some(k => net.authCookies.includes(k.name) && k.value)) return;
          clearInterval(this.loginWatch!); this.loginWatch = null;
          await this.exclusive(() => this.verifyNow(slot, null));
          if (this.cur?.slot === slot) { this.cur.owner = null; this.cur.lastUse = this.now(); }
        } catch (err) { this.deps.log.warn(`navegador: conferência do login de ${slot} falhou`, err); }
        finally { checking = false; }
      })();
    }, 3000);
    this.loginWatch.unref?.();
  }

  verify(slot: SocialSlotId): Promise<BrowserAccount> { return this.exclusive(async () => { await this.launch(slot, this.cur?.slot === slot ? this.cur.owner : 'chefe'); await this.verifyNow(slot, null); if (this.cur?.owner === 'chefe') this.cur.owner = null; return this.view(slot); }); }

  /** Lê a identidade numa aba nova do perfil desta conta e compara com o cadastro. */
  private async verifyNow(slot: SocialSlotId, sessionId: string | null): Promise<{ ok: boolean; text: string }> {
    const c = this.cur; if (!c || c.slot !== slot) throw new BrowserError('janela da conta não está aberta');
    const net = this.net(slot); const acc = this.deps.account(slot); const prev = this.row(slot);
    const declared = acc.declared;
    const tab = await c.ctx.newPage();
    let id: Awaited<ReturnType<NetworkDef['identity']>>;
    try { id = await net.identity(tab); } catch (err) { id = { loggedIn: false, handle: null, name: null, evidence: `falha ao ler a página: ${(err as Error).message.slice(0, 160)}` }; }
    finally { await tab.close().catch(() => undefined); }
    const now = this.now();
    if (!id.loggedIn) {
      const st: BrowserState = prev.verified_at ? 'sessao_expirada' : 'aguardando_login';
      const where = this.engine() === 'extensao' ? 'o seu Edge' : 'o perfil da HQ';
      this.save(slot, { state: st, detail: st === 'sessao_expirada' ? `a sessão desta conta expirou n${where === 'o seu Edge' ? 'o seu Edge: entre de novo nela no Edge' : 'o perfil da HQ: clique em Reconectar e entre de novo na mesma conta'}` : `${where} não está logado nesta conta`, last_check_at: now, last_error: id.evidence });
      c.verifiedAt = null;
      if (this.engine() === 'extensao') return { ok: false, text: `${acc.label}: o Edge do Chefe não está logado nesta conta agora (${id.evidence}). Para só ler a rede, use pesquisar (não precisa de conta). Siga com o que não depende desta conta.` };
      return { ok: false, text: `${acc.label}: ${st === 'sessao_expirada' ? 'sessão expirada' : 'sem login no perfil da HQ'} (${id.evidence}). O Chefe precisa entrar pela Central de Redes; siga com o que não depende desta conta.` };
    }
    if (!id.handle) {
      this.save(slot, { state: 'aguardando_intervencao', detail: `logada, mas a HQ não conseguiu ler o @ na página (${id.evidence}); abra "Mostrar navegador" e confira`, last_check_at: now, last_error: id.evidence });
      c.verifiedAt = null;
      return { ok: false, text: `${acc.label}: logada, mas a identidade não foi lida (${id.evidence}). Nenhuma ação que publique foi liberada.` };
    }
    if (!sameAccount(slotDef(slot).network, id.handle, declared?.handle ?? null, declared?.profileUrl ?? null)) {
      this.save(slot, { state: 'erro', detail: `a janela está na conta @${id.handle}, mas o cadastro é ${declared?.handle ? '@' + declared.handle : declared?.profileUrl ?? 'vazio'}: nenhuma ação foi feita`, detected_handle: id.handle, detected_name: id.name, detected_at: now, last_check_at: now, last_error: 'identidade diferente do cadastro' });
      c.verifiedAt = null;
      if (sessionId) this.deps.notify(sessionId, 'error', `Navegador · ${acc.label}: identidade @${id.handle} diferente do cadastro. Ação interrompida.`);
      return { ok: false, text: `${acc.label}: a conta logada é @${id.handle}, diferente do cadastro. Ação interrompida; o Chefe precisa reconectar na conta certa.` };
    }
    this.save(slot, { state: 'verificada', detail: `identidade @${id.handle} lida na interface do site (${id.evidence})`, detected_handle: id.handle, detected_name: id.name, detected_at: now, verified_at: now, last_check_at: now, last_error: null });
    c.verifiedAt = now;
    return { ok: true, text: `${acc.label}: identidade @${id.handle} conferida na interface (${id.evidence}).` };
  }

  show(slot: SocialSlotId): Promise<BrowserAccount> {
    return this.exclusive(async () => { const c = await this.launch(slot, this.cur?.slot === slot ? this.cur.owner : null); await c.page.bringToFront().catch(() => undefined); c.lastUse = this.now(); return this.view(slot); });
  }

  control(slot: SocialSlotId, take: boolean): Promise<BrowserAccount> {
    if (!take) {
      if (this.cur?.slot === slot) {
        this.cur.manual = false; this.cur.needsReread = true; this.cur.lastUse = this.now(); this.cur.verifiedAt = null;
        if (this.row(slot).state === 'verificada') this.save(slot, { detail: 'controle devolvido: o funcionário relê a página e confere a identidade antes de continuar' });
      }
      return Promise.resolve(this.view(slot));
    }
    return this.exclusive(async () => {
      if (take) {
        const c = this.cur?.slot === slot ? this.cur : await this.launch(slot, 'chefe');
        c.manual = true; await c.page.bringToFront().catch(() => undefined);
        this.save(slot, { detail: 'controle com o Chefe: os comandos automáticos desta janela estão pausados' });
      } else if (this.cur?.slot === slot) {
        this.cur.manual = false; this.cur.needsReread = true; this.cur.lastUse = this.now(); this.cur.verifiedAt = null;
        const st = this.row(slot).state;
        this.save(slot, { detail: st === 'verificada' ? 'controle devolvido: o funcionário relê a página e confere a identidade antes de continuar' : this.row(slot).detail });
      }
      return this.view(slot);
    });
  }

  disconnect(slot: SocialSlotId): Promise<BrowserAccount> {
    return this.exclusive(async () => {
      if (this.cur?.slot === slot) await this.closeCur('desconectar da HQ');
      // Motor extensão: nada a apagar (a sessão é a do Edge do Chefe, que a HQ não toca). Motor perfil: apaga o perfil da HQ.
      const dir = path.join(this.deps.profilesRoot, slot);
      if (this.engine() === 'perfil') fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      this.save(slot, { state: 'cadastrada', detail: 'perfil de navegador da HQ apagado; o cadastro da conta continua', detected_handle: null, detected_name: null, detected_at: null, verified_at: null, last_error: null });
      return this.view(slot);
    });
  }

  // ------------------------------------------------------------------ ferramentas dos funcionários (via MCP da HQ)
  issueToken(sessionId: string): string {
    for (const [t, s] of this.tokens) if (s === sessionId) return t;
    const t = randomBytes(24).toString('hex'); this.tokens.set(t, sessionId); return t;
  }
  sessionForToken(token: string): string | null { return this.tokens.get(token) ?? null; }

  /** Espera o Chefe devolver o controle (até 10 min). Depois disso, a próxima ação exige reler a página. */
  private async waitManual(c: Cur): Promise<void> {
    const until = this.now() + 10 * 60_000;
    while (c.manual && this.cur === c) {
      if (this.now() > until) throw new BrowserError('O Chefe continua no controle da janela. Siga com o que não depende desta conta e tente depois.');
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  private locator(page: Page, a: Record<string, unknown>): { loc: Locator; desc: string } {
    const exact = a.exato === true;
    let loc: Locator; let desc: string;
    if (typeof a.papel === 'string') { loc = page.getByRole(a.papel as Parameters<Page['getByRole']>[0], typeof a.nome === 'string' ? { name: a.nome, exact } : {}); desc = `${a.papel} "${a.nome ?? ''}"`; }
    else if (typeof a.rotulo === 'string') { loc = page.getByLabel(a.rotulo, { exact }); desc = `campo "${a.rotulo}"`; }
    else if (typeof a.placeholder === 'string') { loc = page.getByPlaceholder(a.placeholder, { exact }); desc = `campo "${a.placeholder}"`; }
    else if (typeof a.texto === 'string') { loc = page.getByText(a.texto, { exact }); desc = `texto "${a.texto}"`; }
    else if (typeof a.testid === 'string') { loc = page.getByTestId(a.testid); desc = `testid ${a.testid}`; }
    else throw new BrowserError('Diga o alvo: papel + nome (preferido), rotulo, placeholder, texto ou testid.');
    if (typeof a.indice === 'number') loc = loc.nth(a.indice);
    return { loc, desc };
  }

  private async single(loc: Locator, desc: string): Promise<Locator> {
    await loc.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
    const n = await loc.count();
    if (n === 0) throw new BrowserError(`Não achei ${desc} na página. Leia a página (ler_pagina) e use o nome exato.`);
    if (n > 1) throw new BrowserError(`Há ${n} elementos para ${desc}. Seja mais específico ou use "indice".`);
    return loc;
  }

  private insideContent(file: string): string {
    const root = this.deps.content.folder(); if (!root) throw new BrowserError('A pasta de conteúdo não está configurada.');
    const abs = path.resolve(root, file);
    if (!abs.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) throw new BrowserError(`Só arquivos da pasta de conteúdo podem ser anexados ou gravados (${file}).`);
    return abs;
  }

  private async snapshot(page: Page, limit = SNAPSHOT_MAX): Promise<string> {
    const aria = await page.locator('body').ariaSnapshot({ timeout: 15_000 }).catch(async () => (await page.locator('body').innerText().catch(() => '')).slice(0, limit));
    return aria.length > limit ? `${aria.slice(0, limit)}\n… (cortado em ${limit} caracteres)` : aria;
  }

  async call(sessionId: string, tool: string, args: Record<string, unknown>): Promise<string> {
    // A aba de pesquisa é outra: o Chefe no controle da janela de uma conta não segura a pesquisa.
    if (tool.startsWith('pesquisar')) return this.exclusive(() => this.research(sessionId, tool, args));
    if (this.cur?.manual && (this.cur.owner === sessionId || this.cur.owner === null || tool === 'abrir_conta')) await this.waitManual(this.cur);
    return this.exclusive(() => this.callNow(sessionId, tool, args));
  }

  private requireCur(sessionId: string, a: Record<string, unknown>): Cur {
    const c = this.cur;
    if (!c || (c.owner !== sessionId && c.owner !== null)) throw new BrowserError('Nenhuma conta aberta para você: use abrir_conta primeiro.');
    if (typeof a.conta === 'string' && a.conta !== c.slot) throw new BrowserError(`A janela aberta é ${c.slot}, não ${a.conta}. Use abrir_conta para trocar.`);
    c.owner = sessionId; c.lastUse = this.now();
    return c;
  }

  private async callNow(sessionId: string, tool: string, a: Record<string, unknown>): Promise<string> {
    const who = this.deps.sessionLabel(sessionId);
    if (this.cur && this.cur.owner === sessionId && this.cur.manual) throw new BrowserError('O Chefe assumiu o controle da janela agora: tente de novo depois que ele devolver.');
    switch (tool) {
      case 'contas': {
        return SOCIAL_SLOTS.map(s => {
          const acc = this.deps.account(s.slot); const v = this.view(s.slot);
          const caps = CAP_KEYS.map(k => `${BROWSER_CAP_LABEL[k]}: ${v.caps[k].state}`).join('; ');
          return `- ${s.slot} (${s.label}): cadastro ${acc.declared?.handle ? '@' + acc.declared.handle : acc.declared?.profileUrl ?? 'vazio'} · perfil ${acc.profileIds.join(', ') || 'sem perfil'} · modo ${v.mode} · estado ${v.state}${v.detail ? ` (${v.detail})` : ''} · ${caps}`;
        }).join('\n');
      }
      case 'abrir_conta': {
        const slot = a.conta; if (!isSocialSlot(slot)) throw new BrowserError('Conta desconhecida: use um id de contas (ex.: instagram-aurora).');
        const v = this.view(slot);
        if (v.mode !== 'navegador') throw new BrowserError(`${slot} está no modo API, não no navegador.`);
        // Motor "seu Edge": o login é o do Edge do Chefe, então a HQ confere na hora em vez de confiar no estado gravado
        // (que podia nunca ter sido conferido, ou ser de antes de o Chefe entrar ou trocar de conta no próprio Edge).
        const edge = this.engine() === 'extensao';
        if (!edge && (v.state === 'cadastrada' || v.state === 'aguardando_login' || v.state === 'sessao_expirada')) {
          this.deps.notify(sessionId, 'warn', `Navegador · ${slotDef(slot).label}: precisa do login do Chefe (${v.state}). ${who} segue com o que não depende desta conta.`);
          return `${slotDef(slot).label} precisa do login do Chefe no perfil da HQ (estado: ${v.state}). Para só ler a rede, use pesquisar. Siga com o que não depende desta conta; a Mesa do Chefe já mostra a pendência.`;
        }
        // Identidade diferente do cadastro: no motor de perfis, nenhuma ação até o Chefe reconectar na conta certa.
        if (!edge && v.state === 'erro' && v.detectedHandle) throw new BrowserError(`${slotDef(slot).label}: ${v.detail} (identidade diferente do cadastro)`);
        const c = await this.launch(slot, sessionId);
        if (c.manual) throw new BrowserError('O Chefe está no controle desta janela: tente de novo depois que ele devolver.');
        c.etapa = typeof a.etapa === 'string' ? a.etapa : null;
        if (!c.verifiedAt || this.now() - c.verifiedAt > 10 * 60_000) {
          const r = await this.verifyNow(slot, sessionId);
          if (!r.ok && this.row(slot).state === 'erro') throw new BrowserError(r.text);
          if (!r.ok) { this.deps.notify(sessionId, 'warn', `Navegador · ${r.text}`); return r.text; }
          this.deps.notify(sessionId, 'info', `Navegador · ${r.text}`);
        }
        if (typeof a.url === 'string' && /^https?:\/\//i.test(a.url)) await c.page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        c.needsReread = false;
        return `Conta aberta: ${slotDef(slot).label} (@${this.row(slot).detected_handle}). Página: ${c.page.url()} · ${await c.page.title().catch(() => '')}\n\n${await this.snapshot(c.page, 6000)}`;
      }
      case 'conferir_identidade': {
        const c = this.requireCur(sessionId, a);
        return (await this.verifyNow(c.slot, sessionId)).text;
      }
      case 'navegar': {
        const c = this.requireCur(sessionId, a);
        if (typeof a.url !== 'string' || !/^https?:\/\//i.test(a.url)) throw new BrowserError('URL precisa começar com http(s)://');
        await c.page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        c.needsReread = false;
        return `Página: ${c.page.url()} · ${await c.page.title().catch(() => '')}\n\n${await this.snapshot(c.page, 8000)}`;
      }
      case 'ler_pagina': {
        const c = this.requireCur(sessionId, a);
        const text = await this.snapshot(c.page, typeof a.limite === 'number' ? Math.min(Math.max(a.limite, 1000), 30_000) : SNAPSHOT_MAX);
        c.needsReread = false;
        if (a.etapa === 'pesquisar' || c.etapa === 'pesquisar') this.setCap(c.slot, 'pesquisar', 'testada', `página lida pela HQ (${new URL(c.page.url()).hostname})`);
        return `Página: ${c.page.url()} · ${await c.page.title().catch(() => '')}\n\n${text}`;
      }
      case 'clicar': case 'preencher': case 'teclar': case 'anexar': {
        const c = this.requireCur(sessionId, a);
        if (c.needsReread) throw new BrowserError('O Chefe mexeu na janela: leia a página (ler_pagina) e confira a identidade antes de continuar.');
        if (tool === 'teclar') { if (typeof a.tecla !== 'string') throw new BrowserError('Diga a tecla (ex.: Enter, Escape).'); await c.page.keyboard.press(a.tecla); return `Tecla ${a.tecla}. Página: ${c.page.url()}`; }
        const { loc, desc } = this.locator(c.page, (a.alvo && typeof a.alvo === 'object' ? a.alvo : a) as Record<string, unknown>);
        if (tool === 'clicar') {
          const name = String((a.alvo as Record<string, unknown> | undefined)?.nome ?? a.nome ?? a.texto ?? '');
          if (FINAL_ACTION.test(name)) throw new BrowserError(`"${name}" publica ou agenda: use a ferramenta publicar (ela confere a aprovação, a conta, o texto e grava a intenção antes do clique).`);
          const el = await this.single(loc, desc);
          const label = (await el.getAttribute('aria-label').catch(() => null)) ?? (await el.innerText({ timeout: 2000 }).catch(() => '')) ?? '';
          if (FINAL_ACTION.test(label)) throw new BrowserError(`O elemento "${label.trim().slice(0, 40)}" publica ou agenda: use a ferramenta publicar.`);
          await el.click({ timeout: 15_000 });
          await c.page.waitForLoadState('domcontentloaded').catch(() => undefined);
          return `Cliquei em ${desc}. Página: ${c.page.url()}`;
        }
        if (tool === 'preencher') {
          if (typeof a.texto_campo !== 'string') throw new BrowserError('Diga o texto (texto_campo).');
          const el = await this.single(loc, desc);
          await el.fill(a.texto_campo, { timeout: 15_000 }).catch(async () => { await el.click(); await c.page.keyboard.insertText(String(a.texto_campo)); });
          return `Preenchi ${desc} (${[...String(a.texto_campo)].length} caracteres).`;
        }
        const files = (Array.isArray(a.arquivos) ? a.arquivos : []).map(f => this.insideContent(String(f)));
        if (!files.length) throw new BrowserError('Diga os arquivos (caminhos dentro da pasta de conteúdo).');
        for (const f of files) if (!fs.existsSync(f)) throw new BrowserError(`Arquivo não encontrado: ${f}`);
        if (a.alvo) {
          const el = await this.single(loc, desc);
          const [chooser] = await Promise.all([c.page.waitForEvent('filechooser', { timeout: 20_000 }), el.click()]);
          await chooser.setFiles(files);
        } else {
          const input = c.page.locator('input[type=file]');
          if (!(await input.count())) throw new BrowserError('Nenhum campo de arquivo na página: diga o botão que abre a escolha de arquivo (alvo).');
          await input.first().setInputFiles(files);
        }
        return `Anexei ${files.length} arquivo(s): ${files.map(f => path.basename(f)).join(', ')}. Confira a prévia (ler_pagina ou capturar_tela).`;
      }
      case 'esperar_texto': {
        const c = this.requireCur(sessionId, a);
        if (typeof a.texto !== 'string') throw new BrowserError('Diga o texto.');
        const ms = Math.min(Math.max(Number(a.segundos ?? 20), 1), 60) * 1000;
        const ok = await c.page.getByText(a.texto).first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
        return ok ? `Apareceu: "${a.texto}".` : `Não apareceu em ${ms / 1000} s: "${a.texto}".`;
      }
      case 'capturar_tela': {
        const c = this.requireCur(sessionId, a);
        const root = this.deps.content.folder(); if (!root) throw new BrowserError('A pasta de conteúdo não está configurada.');
        const stamp = new Date(this.now()).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(/[: ]/g, '-');
        const name = String(a.nome ?? 'tela').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'tela';
        const file = path.join(root, 'navegador', 'capturas', c.slot, `${stamp}-${name}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await c.page.screenshot({ path: file, fullPage: false });
        return `Captura salva: ${file}`;
      }
      case 'publicar': return this.publish(sessionId, a);
      case 'verificar_publicacao': return this.verifyPublication(sessionId, a);
      case 'registrar_resultado': {
        const slot = a.conta; if (!isSocialSlot(slot)) throw new BrowserError('Conta desconhecida.');
        if (typeof a.metrica !== 'string' || !a.metrica.trim()) throw new BrowserError('Diga a métrica com o nome exato que a rede mostra.');
        const value = a.valor == null || a.valor === '' ? null : Number(a.valor);
        if (value != null && !Number.isFinite(value)) throw new BrowserError('Valor inválido (use null se a rede não mostrar).');
        const evidence = typeof a.evidencia === 'string' ? this.insideContent(a.evidencia) : null;
        this.deps.content.browserResult({ slot, itemId: typeof a.itemId === 'string' ? a.itemId : null, postUrl: typeof a.url === 'string' ? a.url : null, metric: a.metrica.trim().slice(0, 120), value, unit: typeof a.unidade === 'string' ? a.unidade : null, periodStart: typeof a.periodo_inicio === 'string' ? a.periodo_inicio : null, periodEnd: typeof a.periodo_fim === 'string' ? a.periodo_fim : null, denominator: typeof a.denominador === 'string' ? a.denominador : null, evidencePath: evidence, note: typeof a.observacao === 'string' ? a.observacao.slice(0, 600) : null });
        if (value != null) this.setCap(slot, 'ler_metricas', 'testada', `"${a.metrica}" lida na interface${evidence ? ' (com captura)' : ''}`);
        return `Registrado: ${a.metrica} = ${value ?? 'não coletado'} (${slot}).`;
      }
      case 'registrar_capacidade': {
        const slot = a.conta; const key = a.capacidade as BrowserCapKey;
        if (!isSocialSlot(slot) || !CAP_KEYS.includes(key)) throw new BrowserError('Conta ou capacidade desconhecida.');
        if (a.estado !== 'indisponivel' && !(a.estado === 'testada' && (key === 'pesquisar' || key === 'preparar' || key === 'ler_metricas'))) throw new BrowserError('Publicar e agendar só ficam "testada" pela porta de publicação, com o post conferido. Aqui: "indisponivel" (com o motivo) ou "testada" para pesquisar, preparar e ler_metricas.');
        this.setCap(slot, key, a.estado, String(a.detalhe ?? '').slice(0, 300) || (a.estado === 'indisponivel' ? 'indisponível nesta conta' : 'testada'));
        return `Capacidade ${BROWSER_CAP_LABEL[key]} de ${slot}: ${a.estado}.`;
      }
      case 'fechar': {
        if (this.res && (this.res.owner === sessionId || this.res.owner === null)) await this.closeResearch(`fechada por ${who}`);
        if (this.cur && (this.cur.owner === sessionId || this.cur.owner === null) && !this.cur.manual) await this.closeCur(`fechada por ${who}`);
        return 'Navegador fechado (a sessão continua guardada no perfil).';
      }
      default: throw new BrowserError(`ferramenta desconhecida: ${tool}`);
    }
  }

  /** Porta de publicação: aprovação registrada, conta conferida, texto no editor, intenção gravada ANTES do clique final. */
  private async publish(sessionId: string, a: Record<string, unknown>): Promise<string> {
    const c = this.requireCur(sessionId, a);
    if (c.needsReread) throw new BrowserError('O Chefe mexeu na janela: leia a página e confira a identidade antes de publicar.');
    if (typeof a.itemId !== 'string') throw new BrowserError('Diga a peça (itemId).');
    const mode = a.modo === 'agendar' ? 'agendar' : 'publicar';
    const gate = this.deps.content.publishGate(a.itemId, c.slot);
    if (!gate.ok) throw new BrowserError(`Publicação bloqueada: ${gate.reason}`);
    const prev = this.deps.content.openAttempt(a.itemId);
    if (prev) throw new BrowserError(`Há um envio anterior desta peça sem confirmação (${prev.status}). Confira o perfil primeiro (verificar_publicacao com a URL, ou nao_encontrado: true com uma captura) antes de tentar de novo.`);
    const idOk = await this.verifyNow(c.slot, sessionId);
    if (!idOk.ok) throw new BrowserError(idOk.text);
    const want = words(gate.text, 8);
    // Texto visível + o que está DENTRO dos campos e editores (textarea, input, contenteditable): é ali que a peça fica.
    type El = { value?: unknown; innerText?: string };
    const body = norm(await c.page.locator('body').evaluate((b: El & { querySelectorAll(s: string): ArrayLike<El> }) => {
      const fields = Array.from(b.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]'))
        .map(e => (typeof e.value === 'string' ? e.value : e.innerText) ?? '');
      return `${fields.join(' ')} ${b.innerText ?? ''}`;
    }).catch(() => ''));
    if (want && !body.includes(want)) throw new BrowserError(`O texto da peça não aparece no editor (esperado o começo "${want}"). Preencha o texto exato da entrega e confira a prévia.`);
    const { loc, desc } = this.locator(c.page, (a.alvo && typeof a.alvo === 'object' ? a.alvo : {}) as Record<string, unknown>);
    const el = await this.single(loc, desc);
    const label = ((await el.getAttribute('aria-label').catch(() => null)) ?? (await el.innerText({ timeout: 2000 }).catch(() => '')) ?? '').trim();
    if (!FINAL_ACTION.test(label) && !FINAL_ACTION.test(String((a.alvo as Record<string, unknown>)?.nome ?? ''))) throw new BrowserError(`O alvo "${label.slice(0, 40)}" não parece o botão final de publicar/agendar.`);
    const when = typeof a.quando === 'string' ? a.quando : null;
    const clientId = this.deps.content.browserIntent(a.itemId, c.slot, mode, when);
    this.deps.notify(sessionId, 'info', `Navegador · ${slotDef(c.slot).label}: intenção de ${mode} gravada (${clientId}); clicando em "${label.slice(0, 30)}".`);
    const before = c.page.url();
    try {
      await el.click({ timeout: 15_000 });
    } catch (err) {
      this.deps.content.browserUncertain(a.itemId, clientId, `o clique falhou ou não respondeu: ${(err as Error).message.slice(0, 160)}`);
      throw new BrowserError('O clique final não respondeu: a peça ficou "resultado a verificar". Confira o perfil antes de qualquer nova tentativa.');
    }
    const signal = await this.waitOutcome(c.page, before, el);
    if (!signal) {
      this.deps.content.browserUncertain(a.itemId, clientId, 'cliquei, mas a página não confirmou em 25 s');
      this.deps.notify(sessionId, 'warn', `Navegador · ${slotDef(c.slot).label}: clique feito sem confirmação; peça marcada "resultado a verificar".`);
      return 'Cliquei, mas a página não confirmou em 25 s. A peça ficou "resultado a verificar": abra o perfil, procure o post e use verificar_publicacao (com a URL) ou nao_encontrado: true. Não clique de novo.';
    }
    this.deps.content.browserClicked(a.itemId, clientId, signal);
    return `Clique confirmado pela página (${signal}). Agora confira o post no perfil e use verificar_publicacao com a URL.`;
  }

  private async waitOutcome(page: Page, before: string, el: Locator): Promise<string | null> {
    const until = this.now() + 25_000;
    while (this.now() < until) {
      if (page.url() !== before) return `a página mudou para ${page.url()}`;
      const toast = await page.getByText(/(publicad[oa]|postad[oa]|compartilhad[oa]|agendad[oa]|enviad[oa]|your post was sent|post(ed)?\b.*(shared|sent)|was published|scheduled)/i).first().textContent({ timeout: 500 }).catch(() => null);
      if (toast) return `a página mostrou "${toast.trim().slice(0, 60)}"`;
      if (!(await el.isVisible().catch(() => false))) return 'o editor fechou depois do clique';
      await page.waitForTimeout(500);
    }
    return null;
  }

  private async verifyPublication(sessionId: string, a: Record<string, unknown>): Promise<string> {
    const c = this.requireCur(sessionId, a);
    if (typeof a.itemId !== 'string') throw new BrowserError('Diga a peça (itemId).');
    const mode = a.modo === 'agendar' ? 'agendar' : 'publicar';
    if (a.nao_encontrado === true) {
      const ev = typeof a.evidencia === 'string' ? this.insideContent(a.evidencia) : null;
      if (!ev) throw new BrowserError('Para dizer que o post não existe, anexe a captura do perfil (evidencia), feita com capturar_tela.');
      this.deps.content.browserNotFound(a.itemId, ev);
      return 'Registrado: o post não apareceu no perfil (com captura). A peça volta para "aprovada" e pode ser enviada de novo.';
    }
    const gate = this.deps.content.publishGate(a.itemId, c.slot);
    const text = gate.ok ? gate.text : null;
    if (mode === 'agendar') {
      // Agendamento nativo: a evidência é a lista de agendados do próprio site, aberta agora.
      const body = norm(await c.page.locator('body').innerText({ timeout: 10_000 }).catch(() => ''));
      if (!text || !body.includes(words(text, 8))) return 'Não encontrei a peça na página atual. Abra a lista de posts agendados do site e chame de novo.';
      this.deps.content.browserPublished(a.itemId, typeof a.url === 'string' ? a.url : null, `agendamento conferido na lista do site (${c.page.url()})`, 'agendar');
      this.setCap(c.slot, 'agendar', 'testada', 'agendamento nativo conferido na lista do site');
      return 'Agendamento conferido na lista do site e registrado.';
    }
    if (typeof a.url !== 'string') throw new BrowserError('Diga a URL do post (abra o perfil e copie o link do post).');
    let u: URL; try { u = new URL(a.url); } catch { throw new BrowserError('URL inválida.'); }
    const hosts = SOCIAL_POST_HOSTS[slotDef(c.slot).network];
    if (!hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) throw new BrowserError(`A URL não é da rede desta conta (${u.hostname}).`);
    const tab = await c.ctx.newPage();
    try {
      await tab.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const until = this.now() + 15_000; let found = false;
      const want = text ? words(text, 8) : '';
      while (this.now() < until && !found) { found = Boolean(want) && norm(await tab.locator('body').innerText().catch(() => '')).includes(want); if (!found) await tab.waitForTimeout(500); }
      if (!found) return `Abri ${u.href} na conta logada, mas não encontrei o começo do texto da peça. A peça continua pendente.`;
      this.deps.content.browserPublished(a.itemId, u.href, `post aberto na conta logada (@${this.row(c.slot).detected_handle}) e o texto confere`, 'publicar');
      this.setCap(c.slot, 'publicar', 'testada', `post publicado e conferido pela HQ (${u.href})`);
      this.deps.notify(sessionId, 'info', `Navegador · ${slotDef(c.slot).label}: publicação conferida em ${u.href}.`);
      return `Publicação conferida e registrada: ${u.href}`;
    } finally { await tab.close().catch(() => undefined); }
  }
}
