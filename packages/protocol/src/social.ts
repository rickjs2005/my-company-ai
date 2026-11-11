// Contas sociais do Chefe: sete destinos. Cinco têm API oficial gratuita (Instagram Aurora, Instagram Tuco Dev, Threads,
// TikTok, LinkedIn); X e Pinterest são manuais nesta etapa (a API do X cobra por uso; o Pinterest exige app aprovado): a HQ
// prepara o pacote, abre o site oficial e registra a publicação pelo link conferido.
// Credenciais (segredos dos apps e tokens) ficam só no backend, no cofre do Windows; a interface recebe identidade, estado e
// capacidades. Capacidade "informada" (o provedor diz que pode) é diferente de "testada" (a HQ fez a operação de verdade).

export type SocialNetwork = 'instagram' | 'threads' | 'tiktok' | 'linkedin' | 'x' | 'pinterest';
/** Redes com conexão pela API oficial gratuita (app de desenvolvedor + login pelo navegador). */
export type SocialApiNetwork = 'instagram' | 'threads' | 'tiktok' | 'linkedin';
/** Os sete destinos fixos. O id do cartão é estável; a conta remota (remoteId) é a que a rede devolveu na autorização. */
export type SocialSlotId = 'instagram-aurora' | 'instagram-tuco' | 'threads' | 'tiktok' | 'linkedin' | 'x' | 'pinterest';

/** 'api' = conecta pela API oficial; 'manual' = sem API gratuita nesta etapa (pacote pronto + site oficial + link conferido). */
export type SocialSlotMode = 'api' | 'manual';
export interface SocialSlotDef { slot: SocialSlotId; network: SocialNetwork; label: string; defaultProfileIds: string[]; mode: SocialSlotMode; siteUrl: string }
export const SOCIAL_SLOTS: SocialSlotDef[] = [
  { slot: 'instagram-aurora', network: 'instagram', label: 'Instagram · Aurora', defaultProfileIds: ['aurora'], mode: 'api', siteUrl: 'https://www.instagram.com/' },
  { slot: 'instagram-tuco', network: 'instagram', label: 'Instagram · Tuco Dev', defaultProfileIds: ['tuco-dev'], mode: 'api', siteUrl: 'https://www.instagram.com/' },
  { slot: 'threads', network: 'threads', label: 'Threads', defaultProfileIds: [], mode: 'api', siteUrl: 'https://www.threads.com/' },
  { slot: 'tiktok', network: 'tiktok', label: 'TikTok', defaultProfileIds: [], mode: 'api', siteUrl: 'https://www.tiktok.com/upload' },
  { slot: 'linkedin', network: 'linkedin', label: 'LinkedIn', defaultProfileIds: [], mode: 'api', siteUrl: 'https://www.linkedin.com/feed/' },
  { slot: 'x', network: 'x', label: 'X · inglês', defaultProfileIds: ['tuco-dev'], mode: 'manual', siteUrl: 'https://x.com/compose/post' },
  { slot: 'pinterest', network: 'pinterest', label: 'Pinterest', defaultProfileIds: ['aurora'], mode: 'manual', siteUrl: 'https://www.pinterest.com/pin-builder/' },
];
export const SOCIAL_NETWORK_LABEL: Record<SocialNetwork, string> = { instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', linkedin: 'LinkedIn', x: 'X', pinterest: 'Pinterest' };
/** Domínios em que um link de publicação de cada rede é aceito (registro de publicação manual). */
export const SOCIAL_POST_HOSTS: Record<SocialNetwork, string[]> = {
  instagram: ['instagram.com'], threads: ['threads.com', 'threads.net'], tiktok: ['tiktok.com'], linkedin: ['linkedin.com'], x: ['x.com', 'twitter.com'], pinterest: ['pinterest.com', 'pin.it', 'br.pinterest.com'],
};
export function isSocialSlot(v: unknown): v is SocialSlotId { return typeof v === 'string' && SOCIAL_SLOTS.some(s => s.slot === v); }
export function slotDef(slot: SocialSlotId): SocialSlotDef { return SOCIAL_SLOTS.find(s => s.slot === slot)!; }

/**
 * Estado de cada capacidade:
 * - 'tested': a HQ executou a operação com sucesso (ex.: leu publicações; publicou de verdade quando o Chefe mandou);
 * - 'reported': a rede concedeu a permissão / informou que pode, mas a HQ ainda não executou;
 * - 'unavailable': não existe nesta conexão (com o motivo e o próximo passo);
 * - 'unknown': ainda não verificado.
 */
export type SocialCapState = 'tested' | 'reported' | 'unavailable' | 'unknown';
export interface SocialCapability {
  state: SocialCapState;
  detail: string;
  /** Quando a HQ testou (só para 'tested'). */
  at?: number | null;
  /** A HQ consegue disparar esta ação agora (ex.: publicar texto no Threads). Ação só aparece habilitada com true. */
  hqReady?: boolean;
}
export interface SocialCapabilities { authenticated: SocialCapability; read: SocialCapability; publish: SocialCapability; schedule: SocialCapability }

export type SocialStatus =
  | 'needs_app'      // o app de desenvolvedor desta rede ainda não foi configurado na HQ
  | 'not_connected'  // app pronto, conta ainda não autorizada (ou desconectada)
  | 'connected'
  | 'expiring'       // conectada, mas o acesso vence em poucos dias e esta rede não renova sozinha (LinkedIn)
  | 'expired'        // acesso vencido ou revogado: precisa reconectar
  | 'error'          // a última verificação falhou por outro motivo (rede fora, resposta inesperada); histórico preservado
  | 'manual';        // destino sem API nesta etapa (X, Pinterest): a HQ prepara, o Chefe publica no site e a HQ confere o link

/** Conta informada pelo Chefe (ou achada num material dele e ainda a confirmar). Nunca inventada; diferente da identidade da API. */
export interface SocialDeclared {
  handle: string | null;
  profileUrl: string | null;
  /** De onde veio: 'chefe' (digitado na central) ou o material onde foi achado (ex.: 'site aurora.example'). */
  source: string;
  /** O Chefe confirmou que é a conta certa deste destino. */
  confirmed: boolean;
  /** A conta ainda não existe (ex.: X em inglês a criar). */
  toCreate: boolean;
  at: number;
}

// ---------------- Modo navegador (Playwright, perfis persistentes da HQ) ----------------

/** Estado da conta operada pelo navegador da HQ (perfil próprio por conta; login feito pelo Chefe na janela). */
export type BrowserState = 'cadastrada' | 'aguardando_login' | 'verificada' | 'sessao_expirada' | 'aguardando_intervencao' | 'erro';
export const BROWSER_STATE_LABEL: Record<BrowserState, string> = {
  cadastrada: 'Cadastrada', aguardando_login: 'Aguardando login', verificada: 'Autenticada e verificada', sessao_expirada: 'Sessão expirada',
  aguardando_intervencao: 'Aguardando intervenção', erro: 'Erro',
};
export type BrowserCapKey = 'pesquisar' | 'ler_metricas' | 'preparar' | 'publicar' | 'agendar';
export const BROWSER_CAP_LABEL: Record<BrowserCapKey, string> = { pesquisar: 'Pesquisar', ler_metricas: 'Ler métricas', preparar: 'Preparar publicação', publicar: 'Publicar', agendar: 'Agendar' };
export interface BrowserCap { state: 'testada' | 'nao_testada' | 'indisponivel'; detail: string; at: number | null }

export interface BrowserAccount {
  /** 'navegador' = operada pela interface do site com o perfil da HQ; 'api' = app de desenvolvedor (rota antiga, preservada). */
  mode: 'navegador' | 'api';
  state: BrowserState;
  detail: string;
  /** Identidade lida na interface do site com o perfil da HQ (nunca do link público). */
  detectedHandle: string | null;
  detectedName: string | null;
  detectedAt: number | null;
  /** Momento em que a identidade lida bateu com o cadastro. */
  verifiedAt: number | null;
  lastCheckAt: number | null;
  lastError: string | null;
  caps: Record<BrowserCapKey, BrowserCap>;
  /** Janela desta conta aberta agora, quem está operando e se o Chefe assumiu o controle. */
  open: boolean;
  owner: string | null;
  manual: boolean;
}

export interface SocialAccount {
  slot: SocialSlotId;
  network: SocialNetwork;
  mode: SocialSlotMode;
  label: string;
  /** Endereço oficial para publicar à mão (abre no navegador do Chefe). */
  siteUrl: string;
  declared: SocialDeclared | null;
  /** ID da conta na rede (Instagram user_id, Threads user id, TikTok open_id, LinkedIn sub). Nunca inventado. */
  remoteId: string | null;
  username: string | null;
  displayName: string | null;
  /** Avatar baixado pelo backend (data URL pequena), para não depender de links que expiram. */
  avatar: string | null;
  /** Tipo informado pela rede (ex.: Business, Media_Creator, perfil pessoal). */
  accountKind: string | null;
  /** Perfis editoriais que usam esta conta como destino (filtra os destinos mostrados). */
  profileIds: string[];
  status: SocialStatus;
  statusDetail: string;
  capabilities: SocialCapabilities;
  scopes: string[];
  connectedAt: number | null;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
  tokenExpiresAt: number | null;
  /** O próximo passo concreto quando falta algo (permissão, app, login). */
  nextStep: string | null;
  lastPublish: { at: number; url: string | null; remotePostId: string } | null;
  /** Modo navegador (ausente em serviços antigos). */
  browser?: BrowserAccount;
}

export type SocialAppId = SocialApiNetwork;
export interface SocialAppStatus {
  app: SocialAppId;
  label: string;
  configured: boolean;
  /** Começo do client id/key (para conferir qual app está salvo); o segredo nunca volta para a interface. */
  clientIdHint: string | null;
  consoleUrl: string;
  steps: string[];
}

export interface SocialState {
  accounts: SocialAccount[];
  apps: SocialAppStatus[];
  /** Página HTTPS de retorno do login (as redes não aceitam localhost); ela repassa o código para a HQ local. */
  redirectUri: string;
  /** A página de retorno respondeu e é a da HQ? null = ainda não conferido. */
  redirectCheck: { ok: boolean | null; detail: string; at: number | null };
  vault: { kind: 'dpapi' | 'memory'; ok: boolean; detail: string };
  checkedAt: number | null;
  /** Navegador da HQ: motor, pasta dos perfis e a janela aberta agora (uma por vez). */
  browser?: { engine: string; profilesDir: string; open: { slot: SocialSlotId; owner: string | null; manual: boolean; since: number } | null; mode?: 'extensao' | 'perfil'; extensionUrl?: string; tokenSaved?: boolean };
}

export interface SocialPublishResult { slot: SocialSlotId; remotePostId: string; url: string | null; duplicate: boolean }

export type SocialClientMessage =
  | { type: 'social.state'; reqId: string }
  | { type: 'social.app.save'; reqId: string; app: SocialAppId; clientId: string; clientSecret?: string }
  | { type: 'social.app.clear'; reqId: string; app: SocialAppId }
  | { type: 'social.redirect.save'; reqId: string; uri: string }
  | { type: 'social.redirect.check'; reqId: string }
  /** Devolve a URL de autorização; a interface abre no navegador (o Chefe entra na conta da rede). */
  | { type: 'social.connect'; reqId: string; slot: SocialSlotId }
  | { type: 'social.check'; reqId: string; slot: SocialSlotId }
  | { type: 'social.disconnect'; reqId: string; slot: SocialSlotId }
  | { type: 'social.setProfiles'; reqId: string; slot: SocialSlotId; profileIds: string[] }
  /** Conta informada pelo Chefe (@ e link), confirmação ou "ainda vou criar". Não autentica nada. */
  | { type: 'social.declare'; reqId: string; slot: SocialSlotId; handle: string | null; profileUrl: string | null; confirmed: boolean; toCreate?: boolean }
  /** Modo navegador: abre a janela visível no login da rede (o Chefe entra e faz as verificações). */
  | { type: 'social.browser.connect'; reqId: string; slot: SocialSlotId }
  /** Lê a identidade na interface do site e compara com o cadastro. */
  | { type: 'social.browser.verify'; reqId: string; slot: SocialSlotId }
  | { type: 'social.browser.show'; reqId: string; slot: SocialSlotId }
  /** Apaga o perfil de navegador da HQ desta conta (sessão); o cadastro continua. */
  | { type: 'social.browser.disconnect'; reqId: string; slot: SocialSlotId }
  /** Assumir controle (pausa os comandos automáticos) ou devolver ao funcionário (relê a página antes de continuar). */
  | { type: 'social.browser.control'; reqId: string; slot: SocialSlotId; take: boolean }
  | { type: 'social.browser.mode'; reqId: string; slot: SocialSlotId; mode: 'navegador' | 'api' }
  /** Token de pareamento da Playwright Extension (vai para o cofre do Windows; nunca volta para a tela). null apaga. */
  | { type: 'social.browser.token'; reqId: string; token: string | null }
  /** Publica texto quando o Chefe manda (confirmação na tela). clientId torna o envio idempotente. */
  | { type: 'social.publish'; reqId: string; slot: SocialSlotId; clientId: string; text: string; taskId?: string | null };

export type SocialServerMessage = { kind: 'social.state'; state: SocialState };
