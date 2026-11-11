// Central de conexões sociais: os cinco destinos fixos, autorização pelo navegador (página HTTPS de retorno → HQ local),
// identidade confirmada na rede, capacidades (informadas × testadas), renovação, verificação ao iniciar e publicação de texto
// só quando o Chefe manda. Banco: identidade, estado e histórico. Cofre do Windows: segredos dos apps e tokens.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ServerMessage, SocialAccount, SocialAppId, SocialAppStatus, SocialCapabilities, SocialClientMessage, SocialDeclared, SocialPublishResult, SocialSlotDef, SocialSlotId, SocialState, SocialStatus } from '@milweb-hq/protocol';
import { SOCIAL_NETWORK_LABEL, SOCIAL_SLOTS, isSocialSlot, slotDef } from '@milweb-hq/protocol';
import { DEFAULT_HOSTS, PROVIDERS, SocialError, type AppCreds, type Hosts, type Identity, type ProviderEnv, type TokenSet } from './providers.js';
import type { Vault } from './vault.js';

export const DEFAULT_REDIRECT_URI = 'https://aurora.example/hq-retorno.html';
const STATE_TTL = 15 * 60_000;
const CHECK_EVERY = 6 * 3_600_000;
const DAY = 86_400_000;

export interface SocialDeps {
  db: DatabaseSync;
  vault: Vault;
  port: number;
  broadcast(m: ServerMessage): void;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
  /** Perfis editoriais existentes (para validar associações). */
  profileIds(): string[];
  audit?(e: { action: string; entity: string; entityId: string | null; title: string | null; origin: string; detail?: string | null }): void;
  fetch?: typeof fetch;
  hosts?: Partial<Hosts>;
  now?(): number;
}

interface Row {
  slot: string; network: string; remote_id: string | null; username: string | null; display_name: string | null; avatar: string | null; account_kind: string | null;
  profile_ids_json: string; scopes_json: string; status: string; status_detail: string | null; caps_json: string | null; connected_at: number | null;
  last_check_at: number | null; last_check_ok: number | null; last_error: string | null; token_expires_at: number | null; updated_at: number; declared_json?: string | null;
}
interface Pending { slot: SocialSlotId; expires: number; reconnectOf: string | null }
export interface CallbackResult { ok: boolean; title: string; message: string }

/** Destino manual (X, Pinterest nesta etapa): nada é autenticado pela HQ; publicar é no site oficial, com o link conferido depois. */
const manualCaps = (def: SocialSlotDef): SocialCapabilities => ({
  authenticated: { state: 'unavailable', detail: def.network === 'x' ? 'a API do X cobra por uso: a HQ não entra na conta (login fica com você no site)' : 'sem app aprovado do Pinterest nesta etapa: a HQ não entra na conta' },
  read: { state: 'unavailable', detail: 'a HQ não lê esta conta; resultados entram por CSV, captura ou digitados' },
  publish: { state: 'unavailable', detail: 'manual: a HQ prepara o pacote e abre o site oficial; você publica e cola o link para a HQ conferir' },
  schedule: { state: 'unknown', detail: 'agendamento só pelo próprio site, se a conta oferecer (não verificado pela HQ)' },
});

const unknownCaps = (): SocialCapabilities => ({
  authenticated: { state: 'unknown', detail: 'ainda não verificado' },
  read: { state: 'unknown', detail: 'ainda não verificado' },
  publish: { state: 'unknown', detail: 'ainda não verificado' },
  schedule: { state: 'unknown', detail: 'ainda não verificado' },
});

/** Navegador da HQ visto pela central (o broker é o dono das janelas; a central só mostra e repassa os pedidos do Chefe). */
export interface BrowserLike {
  view(slot: SocialSlotId): import('@milweb-hq/protocol').BrowserAccount;
  openInfo(): { slot: SocialSlotId; owner: string | null; manual: boolean; since: number } | null;
  profilesDir(): string;
  connect(slot: SocialSlotId): Promise<unknown>;
  verify(slot: SocialSlotId): Promise<unknown>;
  show(slot: SocialSlotId): Promise<unknown>;
  disconnect(slot: SocialSlotId): Promise<unknown>;
  control(slot: SocialSlotId, take: boolean): Promise<unknown>;
  setMode(slot: SocialSlotId, mode: 'navegador' | 'api'): void;
  mode?(): 'extensao' | 'perfil';
  engineLabel?(): string;
}

export class SocialService {
  private browser: BrowserLike | null = null;
  private extTokenSaved = false;
  /** Token da Playwright Extension (cofre). */
  async extensionToken(): Promise<string | null> { try { return await this.deps.vault.get('browser:extensionToken'); } catch { return null; } }
  async loadExtensionToken(): Promise<void> { this.extTokenSaved = Boolean(await this.extensionToken()); }
  private browserEngine = '';
  setBrowser(b: BrowserLike, engine: string): void { this.browser = b; this.browserEngine = engine; }
  /** Reenvia o estado (o navegador muda sozinho: login concluído, janela fechada, sessão expirada). */
  refresh(): void { this.push(); }
  private env: ProviderEnv;
  private pending = new Map<string, Pending>();
  private apps = new Map<SocialAppId, { clientId: string } | null>();
  private timer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private checking = new Set<SocialSlotId>();
  private lastCheckAll: number | null = null;
  private redirectCheck: SocialState['redirectCheck'] = { ok: null, detail: 'ainda não conferida', at: null };

  constructor(private deps: SocialDeps) {
    this.env = { fetch: deps.fetch ?? fetch, now: deps.now ?? Date.now, hosts: { ...DEFAULT_HOSTS, ...(deps.hosts ?? {}) } };
    const now = this.env.now();
    const ins = deps.db.prepare("INSERT OR IGNORE INTO social_accounts(slot, network, profile_ids_json, status, updated_at) VALUES (?,?,?,'not_connected',?)");
    for (const s of SOCIAL_SLOTS) ins.run(s.slot, s.network, JSON.stringify(s.defaultProfileIds), now);
  }

  /** Carrega do cofre quais apps estão configurados (só o client id fica em memória para a tela). */
  async init(): Promise<void> {
    void this.checkRedirect().catch(() => { /* fica registrado no estado */ });
    for (const app of Object.keys(PROVIDERS) as SocialAppId[]) {
      try { const raw = await this.deps.vault.get(`app:${app}`); this.apps.set(app, raw ? { clientId: (JSON.parse(raw) as AppCreds).clientId } : null); }
      catch (err) { this.apps.set(app, null); this.deps.log.warn(`cofre: não abriu o app ${app}`, err); }
    }
  }

  /** Revalida as contas ao iniciar (depois de alguns segundos) e a cada 6 h. */
  start(delayMs = 5000): void {
    this.startTimer = setTimeout(() => { this.checkAll('início do serviço').catch(err => this.deps.log.warn('verificação das redes falhou', err)); }, delayMs);
    this.timer = setInterval(() => { this.checkAll('verificação periódica').catch(err => this.deps.log.warn('verificação das redes falhou', err)); }, CHECK_EVERY);
    this.timer.unref?.(); this.startTimer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); if (this.startTimer) clearTimeout(this.startTimer); this.timer = null; this.startTimer = null; }

  redirectUri(): string {
    const r = this.deps.db.prepare("SELECT value FROM social_config WHERE key='redirectUri'").get() as { value: string } | undefined;
    return r?.value ?? DEFAULT_REDIRECT_URI;
  }

  // ------------------------------------------------------------------ estado para a interface
  state(): SocialState {
    const rows = this.deps.db.prepare('SELECT * FROM social_accounts').all() as unknown as Row[];
    const bySlot = new Map(rows.map(r => [r.slot, r]));
    const accounts = SOCIAL_SLOTS.map(def => this.view(bySlot.get(def.slot)!, def.label));
    const redirect = this.redirectUri();
    const apps: SocialAppStatus[] = (Object.keys(PROVIDERS) as SocialAppId[]).map(app => {
      const p = PROVIDERS[app]; const a = this.apps.get(app);
      return { app, label: p.appLabel, configured: Boolean(a), clientIdHint: a ? `${a.clientId.slice(0, 4)}…${a.clientId.slice(-3)}` : null, consoleUrl: p.consoleUrl, steps: p.steps(redirect) };
    });
    const b = this.browser;
    return { accounts, apps, redirectUri: redirect, redirectCheck: this.redirectCheck, vault: this.deps.vault.info(), checkedAt: this.lastCheckAll, ...(b ? { browser: { engine: b.engineLabel?.() ?? this.browserEngine, profilesDir: b.profilesDir(), open: b.openInfo(), mode: b.mode?.() ?? 'perfil', extensionUrl: 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm', tokenSaved: this.extTokenSaved } } : {}) };
  }

  private view(r: Row, label: string): SocialAccount {
    const v = this.viewBase(r, label);
    return this.browser ? { ...v, browser: this.browser.view(v.slot) } : v;
  }

  private viewBase(r: Row, label: string): SocialAccount {
    const slot = r.slot as SocialSlotId; const network = r.network as SocialAccount['network'];
    const def = slotDef(slot);
    const declared = r.declared_json ? JSON.parse(r.declared_json) as SocialDeclared : null;
    if (def.mode === 'manual') {
      const who = declared?.handle ? `@${declared.handle}` : null;
      return {
        slot, network, mode: 'manual', label, siteUrl: def.siteUrl, declared, remoteId: null, username: null, displayName: null, avatar: null, accountKind: null,
        profileIds: JSON.parse(r.profile_ids_json || '[]'), status: 'manual',
        statusDetail: declared?.toCreate ? 'conta a criar (você faz o cadastro no site oficial)' : who ? `${who}${declared?.confirmed ? ' confirmada por você' : ' a confirmar'}; publicação manual` : 'informe a conta (o @) para a HQ conferir os links publicados',
        capabilities: manualCaps(def), scopes: [], connectedAt: null, lastCheckAt: null, lastCheckOk: null, lastError: null, tokenExpiresAt: null,
        nextStep: declared?.toCreate ? (network === 'x' ? 'Crie a conta no site oficial do X seguindo o roteiro da central e depois informe o @.' : 'Crie a conta business gratuita no site do Pinterest e depois informe o @.') : !declared?.confirmed ? 'Informe e confirme o @ desta conta.' : null,
        lastPublish: null,
      };
    }
    const appReady = Boolean(this.apps.get(network as SocialAppId));
    let status = r.status as SocialStatus;
    if (!r.remote_id && !appReady) status = 'needs_app';
    else if (!r.remote_id) status = 'not_connected';
    const caps = r.caps_json ? JSON.parse(r.caps_json) as SocialCapabilities : unknownCaps();
    const last = this.deps.db.prepare("SELECT created_at, url, remote_post_id FROM social_posts WHERE slot=? AND status='published' ORDER BY created_at DESC LIMIT 1").get(slot) as { created_at: number; url: string | null; remote_post_id: string } | undefined;
    return {
      slot, network, mode: 'api', label, siteUrl: def.siteUrl, declared, remoteId: r.remote_id, username: r.username, displayName: r.display_name, avatar: r.avatar, accountKind: r.account_kind,
      profileIds: JSON.parse(r.profile_ids_json || '[]'), status,
      statusDetail: status === 'needs_app' ? `configure o app do ${SOCIAL_NETWORK_LABEL[network]} (passos no cartão do app) ou publique à mão pelo site` : status === 'not_connected' ? 'conta ainda não autorizada' : (r.status_detail ?? ''),
      capabilities: r.remote_id ? caps : unknownCaps(), scopes: JSON.parse(r.scopes_json || '[]'),
      connectedAt: r.connected_at, lastCheckAt: r.last_check_at, lastCheckOk: r.last_check_ok == null ? null : Boolean(r.last_check_ok), lastError: r.last_error,
      tokenExpiresAt: r.token_expires_at,
      nextStep: status === 'needs_app' ? `Abra "Apps de desenvolvedor" e configure o app do ${SOCIAL_NETWORK_LABEL[network]}.` : status === 'not_connected' ? 'Clique em Conectar e entre na conta certa no navegador.' : status === 'expired' ? 'Clique em Reconectar e entre de novo na mesma conta.' : (caps as SocialCapabilities & { nextStep?: string }).nextStep ?? null,
      lastPublish: last ? { at: last.created_at, url: last.url, remotePostId: last.remote_post_id } : null,
    };
  }
  private row(slot: SocialSlotId): Row { return this.deps.db.prepare('SELECT * FROM social_accounts WHERE slot=?').get(slot) as unknown as Row; }
  private push(): void { this.deps.broadcast({ kind: 'social.state', state: this.state() }); }

  // ------------------------------------------------------------------ mensagens da interface
  async handle(msg: SocialClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'social.state': return this.state();
      case 'social.app.save': return this.saveApp(msg.app, msg.clientId, msg.clientSecret);
      case 'social.app.clear': await this.deps.vault.delete(`app:${msg.app}`); this.apps.set(msg.app, null); this.push(); return this.state();
      case 'social.redirect.save': {
        const uri = msg.uri.trim();
        if (!/^https:\/\/[^\s#?]+$/i.test(uri)) throw new Error('O endereço de retorno precisa começar com https:// e não pode ter ? nem #.');
        this.deps.db.prepare("INSERT INTO social_config(key, value) VALUES ('redirectUri', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(uri);
        this.redirectCheck = { ok: null, detail: 'ainda não conferida', at: null };
        await this.checkRedirect();
        return this.state();
      }
      case 'social.redirect.check': await this.checkRedirect(); return this.state();
      case 'social.connect': return this.connect(msg.slot);
      case 'social.check': return this.check(msg.slot, 'pedido da tela');
      case 'social.disconnect': return this.disconnect(msg.slot);
      case 'social.setProfiles': return this.setProfiles(msg.slot, msg.profileIds);
      case 'social.declare': return this.declare(msg.slot, msg.handle, msg.profileUrl, msg.confirmed, msg.toCreate ?? false, 'chefe');
      case 'social.browser.token': {
        const t = msg.token?.trim() ?? '';
        if (t && !/^[A-Za-z0-9._-]{8,200}$/.test(t)) throw new Error('Token inválido: copie o token mostrado pela Playwright Extension.');
        if (t) await this.deps.vault.set('browser:extensionToken', t); else await this.deps.vault.delete('browser:extensionToken');
        this.extTokenSaved = Boolean(t);
        this.push();
        return this.state();
      }
      case 'social.browser.connect': case 'social.browser.verify': case 'social.browser.show': case 'social.browser.disconnect': case 'social.browser.control': case 'social.browser.mode': {
        if (!this.browser) throw new Error('o navegador da HQ não está disponível neste serviço');
        if (!isSocialSlot(msg.slot)) throw new Error('destino desconhecido');
        const d = this.row(msg.slot).declared_json;
        if (msg.type !== 'social.browser.mode' && msg.type !== 'social.browser.disconnect' && !d) throw new Error('Cadastre a conta (o @ ou o link) antes de conectar pelo navegador: a HQ confere a identidade com o cadastro.');
        if (msg.type === 'social.browser.connect') await this.browser.connect(msg.slot);
        else if (msg.type === 'social.browser.verify') await this.browser.verify(msg.slot);
        else if (msg.type === 'social.browser.show') await this.browser.show(msg.slot);
        else if (msg.type === 'social.browser.disconnect') { await this.browser.disconnect(msg.slot); this.deps.audit?.({ action: 'desconectar (navegador)', entity: 'conta social', entityId: msg.slot, title: slotDef(msg.slot).label, origin: 'interface', detail: 'perfil de navegador da HQ apagado; cadastro mantido' }); }
        else if (msg.type === 'social.browser.control') await this.browser.control(msg.slot, msg.take);
        else this.browser.setMode(msg.slot, msg.mode === 'api' ? 'api' : 'navegador');
        this.push();
        return this.state();
      }
      case 'social.publish': return this.publish(msg.slot, msg.clientId, msg.text, msg.taskId ?? null);
      default: throw new Error(`operação desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  async saveApp(app: SocialAppId, clientId: string, clientSecret?: string): Promise<SocialState> {
    if (!PROVIDERS[app]) throw new Error('rede desconhecida');
    const id = clientId.trim();
    if (!/^[A-Za-z0-9._-]{4,200}$/.test(id)) throw new Error(`${PROVIDERS[app].clientIdLabel} inválido: confira o valor copiado do painel de desenvolvedor.`);
    let secret = clientSecret?.trim() ?? '';
    if (!secret) {
      const cur = await this.deps.vault.get(`app:${app}`);
      if (!cur) throw new Error('Informe o segredo do app (Client secret / App secret).');
      secret = (JSON.parse(cur) as AppCreds).clientSecret;
    }
    if (secret.length < 8 || /\s/.test(secret)) throw new Error('Segredo do app inválido: confira o valor copiado.');
    await this.deps.vault.set(`app:${app}`, JSON.stringify({ clientId: id, clientSecret: secret } satisfies AppCreds));
    this.apps.set(app, { clientId: id });
    this.deps.log.info(`redes: app do ${SOCIAL_NETWORK_LABEL[app]} configurado (${id.slice(0, 4)}…)`);
    this.push();
    return this.state();
  }

  private async appCreds(app: SocialAppId): Promise<AppCreds> {
    const raw = await this.deps.vault.get(`app:${app}`);
    if (!raw) throw new Error(`O app do ${SOCIAL_NETWORK_LABEL[app]} ainda não foi configurado na HQ.`);
    return JSON.parse(raw) as AppCreds;
  }
  private async token(slot: SocialSlotId): Promise<TokenSet | null> { const raw = await this.deps.vault.get(`acct:${slot}`); return raw ? JSON.parse(raw) as TokenSet : null; }
  private async saveToken(slot: SocialSlotId, tok: TokenSet): Promise<void> { await this.deps.vault.set(`acct:${slot}`, JSON.stringify(tok)); }

  /** Confere se a página de retorno está no ar e é a da HQ (ela repassa para /social/oauth/callback). */
  async checkRedirect(): Promise<void> {
    const uri = this.redirectUri(); const now = this.env.now();
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await this.env.fetch(uri, { signal: ctrl.signal, redirect: 'follow' }); clearTimeout(t);
      const text = res.ok ? await res.text() : '';
      this.redirectCheck = res.ok && text.includes('/social/oauth/callback')
        ? { ok: true, detail: 'no ar e repassando para a HQ', at: now }
        : { ok: false, detail: res.ok ? 'o endereço responde, mas não é a página de retorno da HQ' : `não encontrada (HTTP ${res.status}): a página ainda não foi publicada`, at: now };
    } catch (err) {
      this.redirectCheck = { ok: false, detail: `sem resposta (${(err as Error).name === 'AbortError' ? 'tempo esgotado' : 'sem rede ou endereço inválido'})`, at: now };
    }
    this.push();
  }

  // ------------------------------------------------------------------ conectar (link de autorização) e retorno
  async connect(slot: SocialSlotId): Promise<{ url: string; redirectUri: string }> {
    if (!isSocialSlot(slot)) throw new Error('destino desconhecido');
    const def = SOCIAL_SLOTS.find(s => s.slot === slot)!;
    if (def.mode === 'manual') throw new Error(`${def.label} não conecta pela API nesta etapa: publique pelo site oficial e registre o link.`);
    const app = await this.appCreds(def.network as SocialAppId);
    const now = this.env.now();
    for (const [k, p] of this.pending) if (p.expires < now) this.pending.delete(k);
    // A porta vai no começo do state: a página de retorno sabe para onde devolver o código (o resto é aleatório).
    const state = `p${this.deps.port}-${randomBytes(18).toString('hex')}`;
    this.pending.set(state, { slot, expires: now + STATE_TTL, reconnectOf: this.row(slot).remote_id });
    const redirect = this.redirectUri();
    return { url: PROVIDERS[def.network as SocialAppId].authorizeUrl(this.env, app, redirect, state), redirectUri: redirect };
  }

  async handleCallback(params: URLSearchParams): Promise<CallbackResult> {
    const state = params.get('state') ?? '';
    const p = this.pending.get(state);
    if (!p || p.expires < this.env.now()) {
      return { ok: false, title: 'Autorização não reconhecida', message: 'Este retorno não corresponde a nenhum pedido de conexão recente da HQ (ou passou de 15 minutos). Volte para a HQ e clique em Conectar de novo.' };
    }
    this.pending.delete(state);
    const def = SOCIAL_SLOTS.find(s => s.slot === p.slot)!;
    const net = SOCIAL_NETWORK_LABEL[def.network];
    const err = params.get('error') ?? params.get('error_code');
    if (err) {
      const why = params.get('error_description') ?? params.get('error_reason') ?? err;
      this.deps.db.prepare('UPDATE social_accounts SET last_error=?, updated_at=? WHERE slot=?').run(`autorização recusada ou cancelada: ${why}`.slice(0, 300), this.env.now(), p.slot);
      this.push();
      return { ok: false, title: `${def.label}: autorização não concluída`, message: `O ${net} respondeu: ${why}. Nada foi alterado na HQ. Você pode tentar de novo pelo botão Conectar.` };
    }
    const code = params.get('code');
    if (!code) return { ok: false, title: 'Retorno sem código', message: `O ${net} voltou sem o código de autorização. Tente de novo pelo botão Conectar.` };
    try {
      const app = await this.appCreds(def.network as SocialAppId);
      const provider = PROVIDERS[def.network as SocialAppId];
      const tok = await provider.exchange(this.env, app, this.redirectUri(), code);
      const id = await provider.identity(this.env, tok);
      const who = id.username ? `@${id.username}` : id.displayName ?? id.remoteId;
      // Mesma conta em outro cartão: recusa (não duplica). Reconexão com outra conta: recusa (não substitui em silêncio).
      const other = this.deps.db.prepare('SELECT slot FROM social_accounts WHERE network=? AND remote_id=? AND slot<>?').get(def.network, id.remoteId, p.slot) as { slot: string } | undefined;
      if (other) {
        const otherLabel = SOCIAL_SLOTS.find(s => s.slot === other.slot)?.label ?? other.slot;
        return { ok: false, title: `${who} já está conectada`, message: `Essa conta já é o destino "${otherLabel}". Para conectar "${def.label}", saia dessa conta no ${net}, entre na outra e clique em Conectar de novo. Nada foi alterado.` };
      }
      if (p.reconnectOf && p.reconnectOf !== id.remoteId) {
        const cur = this.row(p.slot);
        return { ok: false, title: 'Conta diferente da que estava conectada', message: `Este cartão é ${cur.username ? '@' + cur.username : cur.display_name ?? cur.remote_id}, mas você autorizou ${who}. Para reconectar, entre na mesma conta. Para trocar de conta, desconecte o cartão primeiro. Nada foi alterado.` };
      }
      await this.saveToken(p.slot, tok);
      const now = this.env.now();
      const avatar = await this.avatar(id.avatarUrl);
      this.deps.db.prepare(`UPDATE social_accounts SET remote_id=?, username=?, display_name=?, avatar=?, account_kind=?, scopes_json=?, connected_at=COALESCE(CASE WHEN remote_id=? THEN connected_at END, ?), last_error=NULL, token_expires_at=?, updated_at=? WHERE slot=?`)
        .run(id.remoteId, id.username, id.displayName, avatar, id.accountKind, JSON.stringify(tok.scopes), id.remoteId, now, tok.expiresAt, now, p.slot);
      this.deps.audit?.({ action: p.reconnectOf ? 'reconectar' : 'conectar', entity: 'conta social', entityId: p.slot, title: `${def.label} ${who}`, origin: 'interface', detail: `ID ${id.remoteId}` });
      await this.evaluate(p.slot, tok, id);
      this.push();
      return { ok: true, title: `${def.label}: ${who} conectada`, message: `A HQ confirmou a conta na rede (ID ${id.remoteId}). Pode fechar esta aba: o cartão já mostra a identidade e as capacidades.` };
    } catch (e) {
      const m = (e as Error).message;
      this.deps.db.prepare('UPDATE social_accounts SET last_error=?, updated_at=? WHERE slot=?').run(m.slice(0, 300), this.env.now(), p.slot);
      this.push();
      return { ok: false, title: `${def.label}: a conexão falhou`, message: `${m}. Nada foi gravado. Confira o app de desenvolvedor e tente de novo.` };
    }
  }

  /** Baixa o avatar (pequeno) e guarda como data URL: os links das redes expiram. */
  private async avatar(url: string | null): Promise<string | null> {
    if (!url || !/^https:\/\//i.test(url)) return null;
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await this.env.fetch(url, { signal: ctrl.signal }); clearTimeout(t);
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/^image\/(jpeg|png|webp|gif)/.test(type)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length <= 200_000 ? `data:${type.split(';')[0]};base64,${buf.toString('base64')}` : null;
    } catch { return null; }
  }

  // ------------------------------------------------------------------ verificação (identidade + capacidades)
  /** Grava capacidades e estado a partir de uma identidade já confirmada. */
  private async evaluate(slot: SocialSlotId, tok: TokenSet, id: Identity): Promise<void> {
    const def = SOCIAL_SLOTS.find(s => s.slot === slot)!;
    const provider = PROVIDERS[def.network as SocialAppId];
    const now = this.env.now();
    const probe = await provider.probe(this.env, tok, id);
    const prev = this.row(slot);
    const prevCaps = prev.caps_json ? JSON.parse(prev.caps_json) as SocialCapabilities : null;
    // Publicação testada continua testada (com a data) enquanto a permissão existir; leitura testada nunca vira "publicação testada".
    const publish = prevCaps?.publish.state === 'tested' && probe.publish.state !== 'unavailable' ? { ...probe.publish, state: 'tested' as const, at: prevCaps.publish.at, detail: `publicação feita pela HQ em ${new Date(prevCaps.publish.at ?? now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. ${probe.publish.detail}` } : probe.publish;
    const caps = { authenticated: { state: 'tested', detail: `identidade confirmada na rede (ID ${id.remoteId})`, at: now }, read: probe.read, publish, schedule: probe.schedule, nextStep: probe.nextStep };
    const days = tok.expiresAt ? (tok.expiresAt - now) / DAY : null;
    const noRenew = def.network === 'linkedin' && !tok.refreshToken;
    const status: SocialStatus = days != null && days <= 0 ? 'expired' : noRenew && days != null && days <= 7 ? 'expiring' : 'connected';
    const detail = status === 'expiring' ? `o acesso vence em ${Math.max(0, Math.floor(days!))} dia(s) e o LinkedIn não renova sozinho: reconecte` : status === 'expired' ? 'acesso vencido: reconecte' : `verificada em ${new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
    this.deps.db.prepare('UPDATE social_accounts SET username=?, display_name=?, account_kind=?, status=?, status_detail=?, caps_json=?, last_check_at=?, last_check_ok=1, last_error=NULL, token_expires_at=?, updated_at=? WHERE slot=?')
      .run(id.username, id.displayName, id.accountKind, status, detail, JSON.stringify(caps), now, tok.expiresAt, now, slot);
  }

  async check(slot: SocialSlotId, why: string): Promise<SocialState> {
    if (!isSocialSlot(slot)) throw new Error('destino desconhecido');
    if (this.checking.has(slot)) return this.state();
    this.checking.add(slot);
    const def = SOCIAL_SLOTS.find(s => s.slot === slot)!;
    const now = this.env.now();
    try {
      const r = this.row(slot);
      let tok = await this.token(slot);
      if (!r.remote_id || !tok) return this.state();
      if (def.mode === 'manual') return this.state();
      const provider = PROVIDERS[def.network as SocialAppId];
      const app = await this.appCreds(def.network as SocialAppId);
      const renewed = await provider.maybeRefresh(this.env, app, tok);
      if (renewed) { tok = renewed; await this.saveToken(slot, tok); this.deps.log.info(`redes: acesso de ${def.label} renovado (${why})`); }
      const id = await provider.identity(this.env, tok);
      if (id.remoteId !== r.remote_id) {
        this.deps.db.prepare("UPDATE social_accounts SET status='error', status_detail=?, last_check_at=?, last_check_ok=0, last_error=?, updated_at=? WHERE slot=?")
          .run('a rede devolveu outra conta para este acesso: reconecte', now, `conta inesperada (ID ${id.remoteId})`, now, slot);
        return this.state();
      }
      const avatar = id.avatarUrl ? await this.avatar(id.avatarUrl) : null;
      if (avatar) this.deps.db.prepare('UPDATE social_accounts SET avatar=? WHERE slot=?').run(avatar, slot);
      await this.evaluate(slot, tok, id);
    } catch (e) {
      const err = e as Error;
      if (err instanceof SocialError && err.kind === 'network') {
        // Sem rede: nada se perde; o cartão mostra a falha e a próxima verificação tenta de novo.
        this.deps.db.prepare('UPDATE social_accounts SET last_check_at=?, last_check_ok=0, last_error=?, status_detail=?, updated_at=? WHERE slot=?')
          .run(now, err.message.slice(0, 300), 'última verificação sem resposta da rede; o acesso guardado continua valendo', now, slot);
      } else if (err instanceof SocialError && err.kind === 'auth') {
        this.deps.db.prepare("UPDATE social_accounts SET status='expired', status_detail=?, last_check_at=?, last_check_ok=0, last_error=?, updated_at=? WHERE slot=?")
          .run('acesso vencido ou revogado: reconecte', now, err.message.slice(0, 300), now, slot);
      } else {
        this.deps.db.prepare("UPDATE social_accounts SET status='error', status_detail=?, last_check_at=?, last_check_ok=0, last_error=?, updated_at=? WHERE slot=?")
          .run('a última verificação falhou; histórico e associações preservados', now, err.message.slice(0, 300), now, slot);
      }
      this.deps.log.warn(`redes: verificação de ${def.label} falhou (${why}): ${err.message}`);
    } finally {
      this.checking.delete(slot);
      this.push();
    }
    return this.state();
  }

  async checkAll(why: string): Promise<void> {
    const rows = this.deps.db.prepare('SELECT slot FROM social_accounts WHERE remote_id IS NOT NULL').all() as { slot: SocialSlotId }[];
    for (const r of rows) await this.check(r.slot, why);
    this.lastCheckAll = this.env.now();
    this.push();
  }

  async disconnect(slot: SocialSlotId): Promise<SocialState> {
    if (!isSocialSlot(slot)) throw new Error('destino desconhecido');
    const r = this.row(slot);
    await this.deps.vault.delete(`acct:${slot}`);
    this.deps.db.prepare("UPDATE social_accounts SET remote_id=NULL, username=NULL, display_name=NULL, avatar=NULL, account_kind=NULL, scopes_json='[]', status='not_connected', status_detail=NULL, caps_json=NULL, connected_at=NULL, last_check_at=NULL, last_check_ok=NULL, last_error=NULL, token_expires_at=NULL, updated_at=? WHERE slot=?")
      .run(this.env.now(), slot);
    this.deps.audit?.({ action: 'desconectar', entity: 'conta social', entityId: slot, title: `${SOCIAL_SLOTS.find(s => s.slot === slot)!.label}${r.username ? ' @' + r.username : ''}`, origin: 'interface', detail: r.remote_id ? `ID ${r.remote_id}; as publicações registradas continuam no histórico` : null });
    this.push();
    return this.state();
  }

  setProfiles(slot: SocialSlotId, profileIds: string[]): SocialState {
    if (!isSocialSlot(slot)) throw new Error('destino desconhecido');
    const known = new Set(this.deps.profileIds());
    const clean = [...new Set(profileIds.filter(p => known.has(p)))];
    this.deps.db.prepare('UPDATE social_accounts SET profile_ids_json=?, updated_at=? WHERE slot=?').run(JSON.stringify(clean), this.env.now(), slot);
    this.push();
    return this.state();
  }

  // ------------------------------------------------------------------ publicar (só quando o Chefe manda)
  async publish(slot: SocialSlotId, clientId: string, text: string, taskId: string | null): Promise<SocialPublishResult> {
    if (!isSocialSlot(slot)) throw new Error('destino desconhecido');
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(clientId)) throw new Error('identificador de envio inválido');
    const done = this.deps.db.prepare("SELECT remote_post_id, url, status FROM social_posts WHERE client_id=?").get(clientId) as { remote_post_id: string | null; url: string | null; status: string } | undefined;
    if (done?.status === 'published') return { slot, remotePostId: done.remote_post_id!, url: done.url, duplicate: true };
    if (done?.status === 'sending') throw new Error('Esta publicação já está sendo enviada.');
    const def = SOCIAL_SLOTS.find(s => s.slot === slot)!;
    if (def.mode === 'manual') throw new Error(`${def.label} não publica pela HQ nesta etapa: use o pacote manual e registre o link.`);
    const provider = PROVIDERS[def.network as SocialAppId];
    const body = text.trim();
    if (!body) throw new Error('Escreva o texto da publicação.');
    if (provider.maxText && [...body].length > provider.maxText) throw new Error(`O ${SOCIAL_NETWORK_LABEL[def.network]} aceita até ${provider.maxText} caracteres; o texto tem ${[...body].length}.`);
    const view = this.view(this.row(slot), def.label);
    if (!provider.publishText || !view.capabilities.publish.hqReady || (view.status !== 'connected' && view.status !== 'expiring')) {
      throw new Error(`Publicar em ${def.label} pela HQ não está disponível: ${view.capabilities.publish.detail || view.statusDetail}`);
    }
    const tok = await this.token(slot);
    if (!tok || !view.remoteId) throw new Error('Conta sem acesso guardado: reconecte.');
    const id: Identity = { remoteId: view.remoteId, username: view.username, displayName: view.displayName, avatarUrl: null, accountKind: view.accountKind };
    const rowId = done ? null : randomUUID();
    const now = this.env.now();
    if (rowId) this.deps.db.prepare("INSERT INTO social_posts(id, client_id, slot, remote_account_id, text, task_id, status, created_at) VALUES (?,?,?,?,?,?,'sending',?)").run(rowId, clientId, slot, view.remoteId, body, taskId, now);
    else this.deps.db.prepare("UPDATE social_posts SET status='sending', error=NULL WHERE client_id=?").run(clientId);
    try {
      const r = await provider.publishText(this.env, tok, id, body);
      this.deps.db.prepare("UPDATE social_posts SET status='published', remote_post_id=?, url=? WHERE client_id=?").run(r.remotePostId, r.url, clientId);
      const caps = JSON.parse(this.row(slot).caps_json ?? 'null') as SocialCapabilities | null;
      if (caps) { caps.publish = { ...caps.publish, state: 'tested', at: this.env.now(), detail: `publicação feita pela HQ a seu pedido em ${new Date(this.env.now()).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, hqReady: true }; this.deps.db.prepare('UPDATE social_accounts SET caps_json=? WHERE slot=?').run(JSON.stringify(caps), slot); }
      this.deps.audit?.({ action: 'publicar', entity: 'conta social', entityId: slot, title: `${def.label}${view.username ? ' @' + view.username : ''}`, origin: 'interface', detail: `post ${r.remotePostId}${taskId ? ` · tarefa ${taskId.slice(0, 8)}` : ''}` });
      this.push();
      return { slot, remotePostId: r.remotePostId, url: r.url, duplicate: false };
    } catch (e) {
      // Falha registrada: o mesmo clientId pode tentar de novo sem criar uma segunda linha (e sem duplicar se a rede publicou).
      this.deps.db.prepare("UPDATE social_posts SET status='failed', error=? WHERE client_id=?").run((e as Error).message.slice(0, 300), clientId);
      if (e instanceof SocialError && e.kind === 'auth') this.deps.db.prepare("UPDATE social_accounts SET status='expired', status_detail='acesso vencido ou revogado: reconecte' WHERE slot=?").run(slot);
      this.push();
      throw e;
    }
  }

  /** Para o mural: rótulo legível de um destino (ex.: "Instagram · Aurora (@aurora)"). */
  labelOf(slot: string): string | null {
    if (!isSocialSlot(slot)) return null;
    const r = this.row(slot); const def = SOCIAL_SLOTS.find(s => s.slot === slot)!;
    const declared = r.declared_json ? JSON.parse(r.declared_json) as SocialDeclared : null;
    const handle = r.username ?? declared?.handle ?? null;
    return `${def.label}${handle ? ` (@${handle})` : ''}`;
  }

  /** Conta informada (pelo Chefe, ou achada num material dele para confirmar). Não autentica; nunca troca a identidade da API. */
  declare(slot: SocialSlotId, handle: string | null, profileUrl: string | null, confirmed: boolean, toCreate: boolean, source: string): SocialState {
    if (!isSocialSlot(slot)) throw new Error('destino desconhecido');
    const h = handle?.trim().replace(/^@/, '') || null;
    if (h && !/^[A-Za-z0-9._-]{1,60}$/.test(h)) throw new Error('O @ tem caracteres inválidos: use só letras, números, ponto, hífen e sublinhado.');
    const url = profileUrl?.trim() || null;
    if (url && !/^https:\/\/[^\s]+$/i.test(url)) throw new Error('O link do perfil precisa começar com https://.');
    const value: SocialDeclared | null = !h && !url && !toCreate ? null : { handle: h, profileUrl: url, source, confirmed: Boolean(confirmed && (h || url)), toCreate: Boolean(toCreate && !h), at: this.env.now() };
    this.deps.db.prepare('UPDATE social_accounts SET declared_json=?, updated_at=? WHERE slot=?').run(value ? JSON.stringify(value) : null, this.env.now(), slot);
    this.push();
    return this.state();
  }

  /** Semeia uma conta achada num material do Chefe, só se o cartão ainda não tem nada informado (nunca sobrescreve). */
  seedDeclared(slot: SocialSlotId, d: Omit<SocialDeclared, 'at'>): boolean {
    const r = this.row(slot);
    if (r.declared_json) return false;
    this.deps.db.prepare('UPDATE social_accounts SET declared_json=?, updated_at=? WHERE slot=?').run(JSON.stringify({ ...d, at: this.env.now() }), this.env.now(), slot);
    this.push();
    return true;
  }

  /** Perfis editoriais propostos para um destino ainda sem associação (nunca sobrescreve uma escolha). */
  seedProfiles(slot: SocialSlotId, profileIds: string[]): boolean {
    const r = this.row(slot);
    if (JSON.parse(r.profile_ids_json || '[]').length) return false;
    this.setProfiles(slot, profileIds);
    return true;
  }

  account(slot: SocialSlotId): SocialAccount { return this.view(this.row(slot), slotDef(slot).label); }
}

/** Página mostrada no navegador depois do retorno (sem token, sem dados sensíveis). */
export function callbackPage(r: CallbackResult): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>MilWeb HQ · ${esc(r.title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#121014;color:#ece6dc;font:15px/1.5 system-ui,sans-serif}main{max-width:520px;margin:24px;padding:24px 26px;border-radius:12px;background:#1d1a20;border:1px solid ${r.ok ? '#3f6b41' : '#7a3b33'}}h1{margin:0 0 8px;font-size:18px;color:${r.ok ? '#7cc47f' : '#e36a5a'}}p{margin:0 0 10px}small{color:#9a9098}</style></head>
<body><main><h1>${esc(r.title)}</h1><p>${esc(r.message)}</p><small>MilWeb HQ · esta aba pode ser fechada.</small></main></body></html>`;
}

/**
 * Página de retorno publicada no domínio da Aurora (as redes exigem HTTPS e não aceitam localhost). Ela só repassa os
 * parâmetros do retorno para a HQ local (http://127.0.0.1:<porta>/social/oauth/callback). Não guarda nada, não carrega
 * nada de fora e não vê segredo: o código sozinho não vale sem o segredo do app, que fica no cofre da HQ.
 */
export function bouncePageHtml(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>MilWeb HQ · voltando</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#121014;color:#ece6dc;font:15px/1.5 system-ui,sans-serif}main{max-width:480px;margin:24px;padding:22px 24px;border-radius:12px;background:#1d1a20;border:1px solid #3a3036}a{color:#f0a830}</style>
</head>
<body>
<main>
<p><strong>Voltando para a MilWeb HQ…</strong></p>
<p id="m">Se nada acontecer, a HQ não está ligada neste computador. Ligue a HQ e use o link abaixo.</p>
<p><a id="l" href="#">Continuar na MilWeb HQ</a></p>
</main>
<script>
(function () {
  var q = location.search || '';
  var st = new URLSearchParams(q).get('state') || '';
  var m = /^p(\\d{2,5})-/.exec(st);
  var port = m ? m[1] : '4777';
  var target = 'http://127.0.0.1:' + port + '/social/oauth/callback' + q;
  document.getElementById('l').setAttribute('href', target);
  if (m) location.replace(target);
})();
</script>
</body>
</html>
`;
}
