// Adaptadores das redes pelas APIs oficiais (conferidas em 01/11/2026):
// - Instagram API com login do Instagram (graph.instagram.com), contas profissionais;
// - Threads API (graph.threads.com);
// - TikTok Login Kit + Content Posting API (open.tiktokapis.com); app sem auditoria só posta como privado (SELF_ONLY);
// - LinkedIn Sign In (OpenID) + Share on LinkedIn (perfil pessoal); página exige a Community Management API (aprovação).
// Erros nunca carregam tokens: as mensagens são montadas aqui, sem a URL chamada.
import type { SocialApiNetwork, SocialCapability } from '@milweb-hq/protocol';

export interface AppCreds { clientId: string; clientSecret: string }
export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: number | null;
  refreshExpiresAt?: number | null;
  scopes: string[];
  userId?: string | null;
  obtainedAt: number;
}
export interface Identity { remoteId: string; username: string | null; displayName: string | null; avatarUrl: string | null; accountKind: string | null }
export interface Probe { read: SocialCapability; publish: SocialCapability; schedule: SocialCapability; nextStep: string | null }

export const DEFAULT_HOSTS = {
  instagramAuth: 'https://www.instagram.com', instagramApi: 'https://api.instagram.com', instagramGraph: 'https://graph.instagram.com',
  threadsAuth: 'https://threads.com', threadsGraph: 'https://graph.threads.com',
  tiktokAuth: 'https://www.tiktok.com', tiktokApi: 'https://open.tiktokapis.com',
  linkedinAuth: 'https://www.linkedin.com', linkedinApi: 'https://api.linkedin.com',
};
export type Hosts = typeof DEFAULT_HOSTS;
export interface ProviderEnv { fetch: typeof fetch; now(): number; hosts: Hosts }

const IG_V = 'v26.0';
const TH_V = 'v1.0';
const DAY = 86_400_000;

/** Falha classificada: 'auth' = acesso vencido/revogado (reconectar); 'network' = sem rede (tentar de novo); 'api' = resposta inesperada. */
export class SocialError extends Error {
  constructor(public kind: 'auth' | 'network' | 'api' | 'permission', message: string) { super(message); }
}

/** IDs da Meta passam de 2^53: números longos viram texto antes do JSON.parse (senão o ID chegaria errado). */
export function parseJsonKeepingIds(text: string): unknown {
  return JSON.parse(text.replace(/(:\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
}

async function call(env: ProviderEnv, what: string, url: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20_000);
  let res: Response;
  try { res = await env.fetch(url, { ...init, signal: ctrl.signal }); }
  catch (err) { throw new SocialError('network', `${what}: sem resposta da rede (${(err as Error).name === 'AbortError' ? 'tempo esgotado' : 'conexão falhou'})`); }
  finally { clearTimeout(t); }
  const text = await res.text();
  let body: any = null;
  try { body = text ? parseJsonKeepingIds(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    const e = body?.error;
    const msg = (typeof e === 'object' ? e?.message ?? e?.error_user_msg : null) ?? body?.error_description ?? body?.message ?? (typeof e === 'string' ? e : null) ?? `HTTP ${res.status}`;
    const code = typeof e === 'object' ? e?.code : null;
    const kind: SocialError['kind'] = res.status === 401 || code === 190 || /invalid[_ ]?(token|grant)|expired|access_token/i.test(String(msg)) ? 'auth' : res.status === 403 || code === 10 || code === 200 ? 'permission' : 'api';
    throw new SocialError(kind, `${what}: ${String(msg).slice(0, 200)}`);
  }
  return { status: res.status, body, headers: res.headers };
}
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const scopesOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,\s]+/) : []).map(s => s.trim()).filter(Boolean);
const cap = (state: SocialCapability['state'], detail: string, extra: Partial<SocialCapability> = {}): SocialCapability => ({ state, detail, ...extra });
const NO_SCHEDULE = (net: string) => cap('unavailable', `a API do ${net} não agenda publicações; a HQ ainda não tem agendamento próprio`);

export interface Provider {
  network: SocialApiNetwork;
  appLabel: string;
  consoleUrl: string;
  clientIdLabel: string;
  scopes: string[];
  steps(redirectUri: string): string[];
  authorizeUrl(env: ProviderEnv, app: AppCreds, redirectUri: string, state: string): string;
  exchange(env: ProviderEnv, app: AppCreds, redirectUri: string, code: string): Promise<TokenSet>;
  /** Renova quando está perto de vencer e a rede permite; devolve null quando não precisa ou não dá. */
  maybeRefresh(env: ProviderEnv, app: AppCreds, tok: TokenSet): Promise<TokenSet | null>;
  identity(env: ProviderEnv, tok: TokenSet): Promise<Identity>;
  probe(env: ProviderEnv, tok: TokenSet, id: Identity): Promise<Probe>;
  publishText?(env: ProviderEnv, tok: TokenSet, id: Identity, text: string): Promise<{ remotePostId: string; url: string | null }>;
  maxText?: number;
}

// ---------------------------------------------------------------- Instagram
const IG_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
const instagram: Provider = {
  network: 'instagram', appLabel: 'Instagram (app da Meta)', consoleUrl: 'https://developers.facebook.com/apps/', clientIdLabel: 'Instagram App ID', scopes: IG_SCOPES,
  steps: r => [
    'Em developers.facebook.com, crie um app do tipo Business (ou abra o seu) e adicione o produto Instagram → "API setup with Instagram login".',
    `Em "Business login settings", cadastre o endereço de retorno: ${r}`,
    'Em Funções do app → Testadores do Instagram, adicione as duas contas (Aurora e Tuco Dev). Aceite cada convite no Instagram: Configurações → Apps e sites → Convites de testador.',
    'As duas contas precisam ser profissionais (Empresa ou Criador de conteúdo).',
    'Copie o "Instagram App ID" e o "Instagram App Secret" para os campos abaixo.',
  ],
  authorizeUrl: (env, app, r, state) => `${env.hosts.instagramAuth}/oauth/authorize?${q({ client_id: app.clientId, redirect_uri: r, response_type: 'code', scope: IG_SCOPES.join(','), state, force_reauth: 'true' })}`,
  async exchange(env, app, r, code) {
    const short = await call(env, 'Instagram (troca do código)', `${env.hosts.instagramApi}/oauth/access_token`, form({ client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'authorization_code', redirect_uri: r, code }));
    const s = Array.isArray(short.body?.data) ? short.body.data[0] : short.body;
    if (!s?.access_token) throw new SocialError('api', 'Instagram: a troca do código não devolveu acesso');
    const long = await call(env, 'Instagram (acesso de 60 dias)', `${env.hosts.instagramGraph}/access_token?${q({ grant_type: 'ig_exchange_token', client_secret: app.clientSecret, access_token: s.access_token })}`);
    const now = env.now();
    return { accessToken: long.body.access_token, expiresAt: long.body.expires_in ? now + Number(long.body.expires_in) * 1000 : null, scopes: scopesOf(s.permissions).length ? scopesOf(s.permissions) : [], userId: s.user_id != null ? String(s.user_id) : null, obtainedAt: now };
  },
  async maybeRefresh(env, _app, tok) {
    const now = env.now();
    if (!tok.expiresAt || now - tok.obtainedAt < DAY || tok.expiresAt - now > 20 * DAY) return null;
    if (tok.expiresAt <= now) throw new SocialError('auth', 'Instagram: o acesso venceu; reconecte a conta');
    const r = await call(env, 'Instagram (renovação)', `${env.hosts.instagramGraph}/refresh_access_token?${q({ grant_type: 'ig_refresh_token', access_token: tok.accessToken })}`);
    return { ...tok, accessToken: r.body.access_token, expiresAt: now + Number(r.body.expires_in ?? 5_184_000) * 1000, obtainedAt: now };
  },
  async identity(env, tok) {
    const r = await call(env, 'Instagram (identidade)', `${env.hosts.instagramGraph}/${IG_V}/me?${q({ fields: 'user_id,username,name,account_type,profile_picture_url', access_token: tok.accessToken })}`);
    const b = r.body ?? {};
    const remoteId = String(b.user_id ?? b.id ?? tok.userId ?? '');
    if (!remoteId) throw new SocialError('api', 'Instagram: a conta não informou o ID');
    return { remoteId, username: b.username ?? null, displayName: b.name ?? null, avatarUrl: b.profile_picture_url ?? null, accountKind: b.account_type ?? null };
  },
  async probe(env, tok, id) {
    let read: SocialCapability;
    try { const r = await call(env, 'Instagram (leitura)', `${env.hosts.instagramGraph}/${IG_V}/me/media?${q({ fields: 'id', limit: '1', access_token: tok.accessToken })}`); read = cap('tested', `leitura das publicações funcionou (${(r.body?.data ?? []).length ? 'há publicações' : 'nenhuma publicação ainda'})`, { at: env.now() }); }
    catch (err) { if (err instanceof SocialError && err.kind === 'network') throw err; read = cap('unavailable', `a leitura falhou: ${(err as Error).message}`); }
    let publish: SocialCapability; let nextStep: string | null = null;
    try {
      const r = await call(env, 'Instagram (cota de publicação)', `${env.hosts.instagramGraph}/${IG_V}/${id.remoteId}/content_publishing_limit?${q({ fields: 'quota_usage,config', access_token: tok.accessToken })}`);
      const d = r.body?.data?.[0] ?? {};
      const total = d.config?.quota_total ?? 100;
      publish = cap('reported', `permissão de publicar concedida (cota usada ${d.quota_usage ?? 0} de ${total} em 24 h). A HQ ainda não publica no Instagram: a rede exige a imagem ou o vídeo num endereço público`, { hqReady: false });
    } catch (err) {
      if (err instanceof SocialError && err.kind === 'network') throw err;
      publish = cap('unavailable', `sem permissão de publicar: ${(err as Error).message}`);
      nextStep = 'Reconecte e aceite a permissão de publicar conteúdo (instagram_business_content_publish).';
    }
    if (id.accountKind && !/business|creator/i.test(id.accountKind)) nextStep = 'Mude a conta para profissional (Empresa ou Criador) no app do Instagram e reconecte.';
    return { read, publish, schedule: NO_SCHEDULE('Instagram'), nextStep };
  },
};

// ---------------------------------------------------------------- Threads
const TH_SCOPES = ['threads_basic', 'threads_content_publish'];
const threads: Provider = {
  network: 'threads', appLabel: 'Threads (app da Meta)', consoleUrl: 'https://developers.facebook.com/apps/', clientIdLabel: 'Threads App ID', scopes: TH_SCOPES, maxText: 500,
  steps: r => [
    'No app da Meta (o mesmo ou um novo), adicione o caso de uso "Access the Threads API" com as permissões threads_basic e threads_content_publish.',
    `Em configurações do caso de uso, cadastre o endereço de retorno: ${r}`,
    'Em Funções do app → Testadores do Threads, adicione sua conta. Aceite no Threads: Configurações → Conta → Permissões de sites.',
    'Copie o "Threads App ID" e o "Threads App Secret" (são diferentes dos do app principal) para os campos abaixo.',
  ],
  authorizeUrl: (env, app, r, state) => `${env.hosts.threadsAuth}/oauth/authorize?${q({ client_id: app.clientId, redirect_uri: r, scope: TH_SCOPES.join(','), response_type: 'code', state })}`,
  async exchange(env, app, r, code) {
    const short = await call(env, 'Threads (troca do código)', `${env.hosts.threadsGraph}/oauth/access_token`, form({ client_id: app.clientId, client_secret: app.clientSecret, code, grant_type: 'authorization_code', redirect_uri: r }));
    if (!short.body?.access_token) throw new SocialError('api', 'Threads: a troca do código não devolveu acesso');
    const long = await call(env, 'Threads (acesso de 60 dias)', `${env.hosts.threadsGraph}/access_token?${q({ grant_type: 'th_exchange_token', client_secret: app.clientSecret, access_token: short.body.access_token })}`);
    const now = env.now();
    return { accessToken: long.body.access_token, expiresAt: long.body.expires_in ? now + Number(long.body.expires_in) * 1000 : null, scopes: [...TH_SCOPES], userId: short.body.user_id != null ? String(short.body.user_id) : null, obtainedAt: now };
  },
  async maybeRefresh(env, _app, tok) {
    const now = env.now();
    if (!tok.expiresAt || now - tok.obtainedAt < DAY || tok.expiresAt - now > 20 * DAY) return null;
    if (tok.expiresAt <= now) throw new SocialError('auth', 'Threads: o acesso venceu; reconecte a conta');
    const r = await call(env, 'Threads (renovação)', `${env.hosts.threadsGraph}/refresh_access_token?${q({ grant_type: 'th_refresh_token', access_token: tok.accessToken })}`);
    return { ...tok, accessToken: r.body.access_token, expiresAt: now + Number(r.body.expires_in ?? 5_184_000) * 1000, obtainedAt: now };
  },
  async identity(env, tok) {
    const r = await call(env, 'Threads (identidade)', `${env.hosts.threadsGraph}/${TH_V}/me?${q({ fields: 'id,username,name,threads_profile_picture_url', access_token: tok.accessToken })}`);
    const b = r.body ?? {};
    const remoteId = String(b.id ?? tok.userId ?? '');
    if (!remoteId) throw new SocialError('api', 'Threads: a conta não informou o ID');
    return { remoteId, username: b.username ?? null, displayName: b.name ?? null, avatarUrl: b.threads_profile_picture_url ?? null, accountKind: 'perfil do Threads' };
  },
  async probe(env, tok) {
    let read: SocialCapability;
    try { await call(env, 'Threads (leitura)', `${env.hosts.threadsGraph}/${TH_V}/me/threads?${q({ fields: 'id', limit: '1', access_token: tok.accessToken })}`); read = cap('tested', 'leitura das publicações funcionou', { at: env.now() }); }
    catch (err) { if (err instanceof SocialError && err.kind === 'network') throw err; read = cap('unavailable', `a leitura falhou: ${(err as Error).message}`); }
    let publish: SocialCapability; let nextStep: string | null = null;
    try {
      const r = await call(env, 'Threads (cota de publicação)', `${env.hosts.threadsGraph}/${TH_V}/me/threads_publishing_limit?${q({ fields: 'quota_usage,config', access_token: tok.accessToken })}`);
      const d = r.body?.data?.[0] ?? {};
      publish = cap('reported', `permissão de publicar concedida (cota usada ${d.quota_usage ?? 0} de ${d.config?.quota_total ?? 250} em 24 h). A HQ publica texto quando você mandar`, { hqReady: true });
    } catch (err) {
      if (err instanceof SocialError && err.kind === 'network') throw err;
      publish = cap('unavailable', `sem permissão de publicar: ${(err as Error).message}`);
      nextStep = 'Reconecte e aceite a permissão threads_content_publish (sua conta precisa ser testadora do app).';
    }
    return { read, publish, schedule: NO_SCHEDULE('Threads'), nextStep };
  },
  async publishText(env, tok, _id, text) {
    const c = await call(env, 'Threads (preparar texto)', `${env.hosts.threadsGraph}/${TH_V}/me/threads`, form({ media_type: 'TEXT', text, access_token: tok.accessToken }));
    if (!c.body?.id) throw new SocialError('api', 'Threads: o contêiner do texto não foi criado');
    const p = await call(env, 'Threads (publicar)', `${env.hosts.threadsGraph}/${TH_V}/me/threads_publish`, form({ creation_id: String(c.body.id), access_token: tok.accessToken }));
    const postId = String(p.body?.id ?? '');
    if (!postId) throw new SocialError('api', 'Threads: a publicação não devolveu o ID');
    let url: string | null = null;
    try { const l = await call(env, 'Threads (link)', `${env.hosts.threadsGraph}/${TH_V}/${postId}?${q({ fields: 'permalink', access_token: tok.accessToken })}`); url = l.body?.permalink ?? null; } catch { /* sem link: a publicação existe pelo ID */ }
    return { remotePostId: postId, url };
  },
};

// ---------------------------------------------------------------- TikTok
const TT_SCOPES = ['user.info.basic', 'user.info.profile', 'video.publish', 'video.upload'];
const tiktok: Provider = {
  network: 'tiktok', appLabel: 'TikTok (app de desenvolvedor)', consoleUrl: 'https://developers.tiktok.com/apps/', clientIdLabel: 'Client key', scopes: TT_SCOPES,
  steps: r => [
    'Em developers.tiktok.com, crie um app e adicione os produtos Login Kit e Content Posting API (ative "Direct Post").',
    'Escopos: user.info.basic, user.info.profile, video.publish e video.upload.',
    `Em Login Kit → Web, cadastre o endereço de retorno: ${r}`,
    'No modo Sandbox, adicione sua conta do TikTok como usuário de teste e aceite.',
    'Sem auditoria do TikTok, posts feitos por app saem como privados (só você vê), e a conta precisa estar privada na hora. A auditoria recusa ferramentas para as próprias contas.',
    'Copie o "Client key" e o "Client secret" para os campos abaixo.',
  ],
  authorizeUrl: (env, app, r, state) => `${env.hosts.tiktokAuth}/v2/auth/authorize/?${q({ client_key: app.clientId, response_type: 'code', scope: TT_SCOPES.join(','), redirect_uri: r, state })}`,
  async exchange(env, app, r, code) {
    const t = await call(env, 'TikTok (troca do código)', `${env.hosts.tiktokApi}/v2/oauth/token/`, form({ client_key: app.clientId, client_secret: app.clientSecret, code, grant_type: 'authorization_code', redirect_uri: r }));
    const b = t.body ?? {};
    if (!b.access_token) throw new SocialError('api', `TikTok: a troca do código não devolveu acesso${b.error_description ? ` (${b.error_description})` : ''}`);
    const now = env.now();
    return { accessToken: b.access_token, refreshToken: b.refresh_token ?? null, expiresAt: now + Number(b.expires_in ?? 86_400) * 1000, refreshExpiresAt: b.refresh_expires_in ? now + Number(b.refresh_expires_in) * 1000 : null, scopes: scopesOf(b.scope), userId: b.open_id ?? null, obtainedAt: now };
  },
  async maybeRefresh(env, app, tok) {
    const now = env.now();
    if (!tok.expiresAt || tok.expiresAt - now > 10 * 60_000) return null;
    if (!tok.refreshToken || (tok.refreshExpiresAt && tok.refreshExpiresAt <= now)) throw new SocialError('auth', 'TikTok: o acesso venceu e não dá para renovar; reconecte a conta');
    const t = await call(env, 'TikTok (renovação)', `${env.hosts.tiktokApi}/v2/oauth/token/`, form({ client_key: app.clientId, client_secret: app.clientSecret, grant_type: 'refresh_token', refresh_token: tok.refreshToken }));
    const b = t.body ?? {};
    if (!b.access_token) throw new SocialError('auth', 'TikTok: a renovação foi recusada; reconecte a conta');
    return { ...tok, accessToken: b.access_token, refreshToken: b.refresh_token ?? tok.refreshToken, expiresAt: now + Number(b.expires_in ?? 86_400) * 1000, refreshExpiresAt: b.refresh_expires_in ? now + Number(b.refresh_expires_in) * 1000 : tok.refreshExpiresAt, scopes: b.scope ? scopesOf(b.scope) : tok.scopes, obtainedAt: now };
  },
  async identity(env, tok) {
    const fields = ['open_id', 'union_id', 'avatar_url', 'display_name', ...(tok.scopes.includes('user.info.profile') ? ['username'] : [])];
    const r = await call(env, 'TikTok (identidade)', `${env.hosts.tiktokApi}/v2/user/info/?${q({ fields: fields.join(',') })}`, { headers: { Authorization: `Bearer ${tok.accessToken}` } });
    if (r.body?.error?.code && r.body.error.code !== 'ok') throw new SocialError('api', `TikTok (identidade): ${r.body.error.message ?? r.body.error.code}`);
    const u = r.body?.data?.user ?? {};
    const remoteId = String(u.open_id ?? tok.userId ?? '');
    if (!remoteId) throw new SocialError('api', 'TikTok: a conta não informou o ID');
    return { remoteId, username: u.username ?? null, displayName: u.display_name ?? null, avatarUrl: u.avatar_url ?? null, accountKind: 'conta do TikTok' };
  },
  async probe(env, tok) {
    const read = cap('unavailable', 'ler os vídeos exige a permissão video.list (produto Display API); a HQ ainda não pede essa permissão');
    if (!tok.scopes.includes('video.publish')) return { read, publish: cap('unavailable', 'a permissão video.publish não foi concedida'), schedule: NO_SCHEDULE('TikTok'), nextStep: 'Adicione a Content Posting API (Direct Post) ao app e reconecte aceitando video.publish.' };
    try {
      const r = await call(env, 'TikTok (dados para postar)', `${env.hosts.tiktokApi}/v2/post/publish/creator_info/query/`, { method: 'POST', headers: { Authorization: `Bearer ${tok.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: '{}' });
      if (r.body?.error?.code && r.body.error.code !== 'ok') throw new SocialError('permission', r.body.error.message ?? r.body.error.code);
      const opts: string[] = r.body?.data?.privacy_level_options ?? [];
      const onlyPrivate = opts.length > 0 && opts.every(o => o === 'SELF_ONLY');
      const publish = cap('reported', onlyPrivate
        ? 'o TikTok permite postar só como privado (app sem auditoria; a conta precisa estar privada). A HQ ainda não envia vídeo ao TikTok'
        : `o TikTok informa as opções de privacidade: ${opts.join(', ') || 'nenhuma'}. A HQ ainda não envia vídeo ao TikTok`, { hqReady: false });
      return { read, publish, schedule: NO_SCHEDULE('TikTok'), nextStep: null };
    } catch (err) {
      if (err instanceof SocialError && err.kind === 'network') throw err;
      return { read, publish: cap('unavailable', `o TikTok recusou a consulta para postar: ${(err as Error).message}`), schedule: NO_SCHEDULE('TikTok'), nextStep: 'Confira no app do TikTok se a Content Posting API (Direct Post) está ativa e se sua conta é usuária de teste do Sandbox.' };
    }
  },
};

// ---------------------------------------------------------------- LinkedIn
const LI_SCOPES = ['openid', 'profile', 'w_member_social'];
const linkedin: Provider = {
  network: 'linkedin', appLabel: 'LinkedIn (app de desenvolvedor)', consoleUrl: 'https://www.linkedin.com/developers/apps', clientIdLabel: 'Client ID', scopes: LI_SCOPES, maxText: 3000,
  steps: r => [
    'Em linkedin.com/developers, crie um app. O LinkedIn exige uma Página associada: use a da Aurora e confirme o app como administrador da página.',
    'Em Products, adicione "Sign In with LinkedIn using OpenID Connect" e "Share on LinkedIn" (liberados sem análise).',
    `Em Auth, cadastre o endereço de retorno: ${r}`,
    'Copie o "Client ID" e o "Client Secret" para os campos abaixo.',
    'Este caminho publica no seu perfil pessoal. Publicar como Página exige a Community Management API, que a LinkedIn só aprova para empresa registrada.',
    'O acesso do LinkedIn vale 60 dias e não renova sozinho para apps desse tipo: a HQ avisa antes de vencer.',
  ],
  authorizeUrl: (env, app, r, state) => `${env.hosts.linkedinAuth}/oauth/v2/authorization?${q({ response_type: 'code', client_id: app.clientId, redirect_uri: r, state, scope: LI_SCOPES.join(' ') })}`,
  async exchange(env, app, r, code) {
    const t = await call(env, 'LinkedIn (troca do código)', `${env.hosts.linkedinAuth}/oauth/v2/accessToken`, form({ grant_type: 'authorization_code', code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: r }));
    const b = t.body ?? {};
    if (!b.access_token) throw new SocialError('api', 'LinkedIn: a troca do código não devolveu acesso');
    const now = env.now();
    return { accessToken: b.access_token, refreshToken: b.refresh_token ?? null, expiresAt: now + Number(b.expires_in ?? 5_184_000) * 1000, refreshExpiresAt: b.refresh_token_expires_in ? now + Number(b.refresh_token_expires_in) * 1000 : null, scopes: scopesOf(b.scope).length ? scopesOf(b.scope) : [...LI_SCOPES], obtainedAt: now };
  },
  async maybeRefresh(env, app, tok) {
    const now = env.now();
    if (!tok.expiresAt || tok.expiresAt - now > 7 * DAY || !tok.refreshToken) {
      if (tok.expiresAt && tok.expiresAt <= now) throw new SocialError('auth', 'LinkedIn: o acesso de 60 dias venceu; reconecte a conta');
      return null;
    }
    const t = await call(env, 'LinkedIn (renovação)', `${env.hosts.linkedinAuth}/oauth/v2/accessToken`, form({ grant_type: 'refresh_token', refresh_token: tok.refreshToken, client_id: app.clientId, client_secret: app.clientSecret }));
    return { ...tok, accessToken: t.body.access_token, refreshToken: t.body.refresh_token ?? tok.refreshToken, expiresAt: now + Number(t.body.expires_in ?? 5_184_000) * 1000, obtainedAt: now };
  },
  async identity(env, tok) {
    const r = await call(env, 'LinkedIn (identidade)', `${env.hosts.linkedinApi}/v2/userinfo`, { headers: { Authorization: `Bearer ${tok.accessToken}` } });
    const b = r.body ?? {};
    if (!b.sub) throw new SocialError('api', 'LinkedIn: a conta não informou o ID');
    return { remoteId: String(b.sub), username: null, displayName: b.name ?? null, avatarUrl: b.picture ?? null, accountKind: 'perfil pessoal' };
  },
  async probe(env, tok) {
    const read = cap('unavailable', 'ler publicações exige uma permissão restrita do LinkedIn (r_member_social), não liberada para este tipo de app');
    const publish = tok.scopes.includes('w_member_social')
      ? cap('reported', 'permissão de publicar no seu perfil concedida (Share on LinkedIn). A HQ publica texto quando você mandar', { hqReady: true })
      : cap('unavailable', 'a permissão w_member_social não foi concedida');
    const days = tok.expiresAt ? Math.floor((tok.expiresAt - env.now()) / DAY) : null;
    return { read, publish, schedule: NO_SCHEDULE('LinkedIn'), nextStep: !tok.scopes.includes('w_member_social') ? 'Adicione o produto "Share on LinkedIn" ao app e reconecte.' : days != null && days <= 7 ? `O acesso vence em ${Math.max(0, days)} dia(s): reconecte para renovar.` : null };
  },
  async publishText(env, tok, id, text) {
    const author = `urn:li:person:${id.remoteId}`;
    const body = { author, lifecycleState: 'PUBLISHED', specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text }, shareMediaCategory: 'NONE' } }, visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' } };
    const r = await call(env, 'LinkedIn (publicar)', `${env.hosts.linkedinApi}/v2/ugcPosts`, { method: 'POST', headers: { Authorization: `Bearer ${tok.accessToken}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' }, body: JSON.stringify(body) });
    const urn = String(r.headers.get('x-restli-id') ?? r.body?.id ?? '');
    if (!urn) throw new SocialError('api', 'LinkedIn: a publicação não devolveu o ID');
    return { remotePostId: urn, url: `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/` };
  },
};

export const PROVIDERS: Record<SocialApiNetwork, Provider> = { instagram, threads, tiktok, linkedin };
