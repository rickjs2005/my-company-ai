// Central de Redes: os sete destinos (Instagram Aurora, Instagram Tuco Dev, Threads, TikTok, LinkedIn pela API oficial;
// X e Pinterest manuais nesta etapa), cada um com a conta informada pelo Chefe e/ou confirmada pela rede, perfil editorial,
// estado, capacidades (testada × informada × indisponível) e ações.
// Aparece no painel da sala (objeto "Redes") e em Ajustes → Conexões. A interface nunca recebe segredo nem token.
import { useState } from 'react';
import type { BrowserCapKey, EditorialProfile, SocialAccount, SocialAppId, SocialAppStatus, SocialCapability, SocialPublishResult, SocialSlotId, SocialState } from '@milweb-hq/protocol';
import { BROWSER_CAP_LABEL, BROWSER_STATE_LABEL, SOCIAL_NETWORK_LABEL } from '@milweb-hq/protocol';
import { Modal } from '../../panel/dialogs/Modal';

export interface SocialHubApi {
  connect(slot: SocialSlotId): Promise<{ url: string }>;
  check(slot: SocialSlotId): Promise<unknown>;
  disconnect(slot: SocialSlotId): Promise<unknown>;
  setProfiles(slot: SocialSlotId, profileIds: string[]): Promise<unknown>;
  saveApp(app: SocialAppId, clientId: string, clientSecret?: string): Promise<unknown>;
  clearApp(app: SocialAppId): Promise<unknown>;
  saveRedirect(uri: string): Promise<unknown>;
  checkRedirect(): Promise<unknown>;
  publish(slot: SocialSlotId, clientId: string, text: string, taskId?: string | null): Promise<SocialPublishResult>;
  declare(slot: SocialSlotId, handle: string | null, profileUrl: string | null, confirmed: boolean, toCreate?: boolean): Promise<unknown>;
  browser(action: 'connect' | 'verify' | 'show' | 'disconnect', slot: SocialSlotId): Promise<unknown>;
  browserControl(slot: SocialSlotId, take: boolean): Promise<unknown>;
  browserMode(slot: SocialSlotId, mode: 'navegador' | 'api'): Promise<unknown>;
  browserToken(token: string | null): Promise<unknown>;
  openUrl(url: string): void;
  copy(text: string): Promise<boolean>;
}

const NET_TAG: Record<string, { short: string; color: string }> = {
  instagram: { short: 'IG', color: '#b5486a' }, threads: { short: 'TH', color: '#5a5f6b' }, tiktok: { short: 'TT', color: '#2a9d9f' }, linkedin: { short: 'IN', color: '#2f6aa8' },
  x: { short: 'X', color: '#3b3f46' }, pinterest: { short: 'PI', color: '#b33a3a' },
};
const STATUS: Record<SocialAccount['status'], { label: string; cls: string }> = {
  connected: { label: 'Conectada', cls: 'ok' }, expiring: { label: 'Vence em breve', cls: 'warn' }, expired: { label: 'Reconectar', cls: 'bad' },
  error: { label: 'Falha na verificação', cls: 'bad' }, not_connected: { label: 'Não conectada', cls: 'off' }, needs_app: { label: 'Falta o app', cls: 'off' },
  manual: { label: 'Manual', cls: 'off' },
};
const CAP_LABEL: Record<SocialCapability['state'], string> = { tested: 'testada pela HQ', reported: 'informada pela rede', unavailable: 'indisponível', unknown: 'não verificada' };
const when = (t: number | null | undefined) => (t ? new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const connectedCount = (s: SocialState | null) => (s ? s.accounts.filter(a => a.status === 'connected' || a.status === 'expiring').length : 0);
/** Cadastrada = conta informada e confirmada por você. Verificada = acesso validado: login do navegador da HQ com a identidade
 *  conferida na interface do site, ou conexão pela API. São contagens diferentes (cadastro não é acesso). */
export const isRegistered = (a: SocialAccount) => Boolean(a.declared?.confirmed) || Boolean(a.remoteId);
export const isVerified = (a: SocialAccount) => (a.browser?.mode === 'navegador' ? a.browser.state === 'verificada' : a.status === 'connected' || a.status === 'expiring');
export const isReady = isVerified;
export const readyCount = (s: SocialState | null) => (s ? s.accounts.filter(isVerified).length : 0);
export const registeredCount = (s: SocialState | null) => (s ? s.accounts.filter(isRegistered).length : 0);
export const socialSummary = (s: SocialState | null) => (s ? `${registeredCount(s)} cadastradas · ${readyCount(s)} verificadas` : '');
export const accountName = (a: SocialAccount) => (a.username ? `@${a.username}` : a.declared?.handle ? `@${a.declared.handle}` : a.displayName ?? null);
const noEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') e.preventDefault(); };
/** Texto pronto para a publicação de teste: o Chefe lê, ajusta e dispara. */
export const testPostText = (a: SocialAccount) => `Teste de conexão: esta publicação foi feita pelo My Company AI para conferir a integração com o ${SOCIAL_NETWORK_LABEL[a.network]}. Pode ignorar.`;

function Cap({ name, cap }: { name: string; cap: SocialCapability }) {
  return (
    <li className={`hq-hub-cap hq-hub-cap--${cap.state}`}>
      <span className="hq-hub-cap__name">{name}</span>
      <span className="hq-hub-cap__state">{CAP_LABEL[cap.state]}{cap.state === 'tested' && cap.at ? ` · ${when(cap.at)}` : ''}</span>
      <span className="hq-hub-cap__detail">{cap.detail}</span>
    </li>
  );
}

/** Confirmação de publicação: mostra destino e texto; nada sai sem o clique em "Publicar agora". */
export function PublishDialog({ account, initialText, taskId, api, onClose, maxChars }: { account: SocialAccount; initialText: string; taskId?: string | null; api: SocialHubApi; onClose(): void; maxChars: number }) {
  const [text, setText] = useState(initialText);
  const [clientId] = useState(() => `pub-${crypto.randomUUID()}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SocialPublishResult | null>(null);
  const n = [...text.trim()].length;
  const go = async () => {
    setBusy(true); setError(null);
    try { setDone(await api.publish(account.slot, clientId, text, taskId ?? null)); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Publicar em ${account.label}`} onCancel={onClose} width={520}>
      <div className="hq-hub-pub">
        <p className="hq-hub-pub__dest"><strong>Destino:</strong> {account.label} · {accountName(account) ?? 'conta'} <span className="hq-dim">(ID {account.remoteId})</span></p>
        {done ? (
          <div className="hq-hub-pub__done" role="status">
            <p><strong>{done.duplicate ? 'Esta publicação já tinha sido feita.' : 'Publicado.'}</strong> ID na rede: <code>{done.remotePostId}</code></p>
            {done.url && <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.openUrl(done.url!)}>Abrir a publicação</button>}
          </div>
        ) : (
          <>
            <label className="hq-field"><span>Texto (você pode ajustar antes de publicar)</span>
              <textarea className="hq-input hq-hub-pub__text" rows={6} value={text} onChange={e => setText(e.target.value)} disabled={busy} />
            </label>
            <p className={`hq-field__hint${n > maxChars ? ' hq-composer__bad' : ''}`}>{n} de {maxChars} caracteres. A publicação é pública e acontece na hora em que você clicar.</p>
          </>
        )}
        {error && <p className="hq-composer__bad" role="alert">{error}</p>}
        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn hq-btn--ghost" onClick={onClose}>{done ? 'Fechar' : 'Cancelar'}</button>
          {!done && <button type="button" className="hq-btn hq-btn--primary" disabled={busy || n === 0 || n > maxChars} onClick={() => void go()}>{busy ? 'Publicando…' : 'Publicar agora'}</button>}
        </div>
      </div>
    </Modal>
  );
}

function AccountCard({ a, profiles, api, app, onPublish }: { a: SocialAccount; profiles: EditorialProfile[]; api: SocialHubApi; app: SocialAppStatus | undefined; onPublish(a: SocialAccount): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const tag = NET_TAG[a.network];
  const st = STATUS[a.status];
  const has = Boolean(a.remoteId);
  const run = async (what: string, fn: () => Promise<unknown>) => { setBusy(what); setError(null); try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(null); } };
  const connect = () => {
    // A janela abre já no clique (bloqueadores de pop-up); o endereço chega do servidor logo depois.
    const w = window.open('about:blank', '_blank');
    void run('connect', async () => {
      try {
        const { url } = await api.connect(a.slot);
        if (w) { w.opener = null; w.location.href = url; } else setLink(url);
      } catch (err) { w?.close(); throw err; }
    });
  };
  const days = a.tokenExpiresAt ? Math.floor((a.tokenExpiresAt - Date.now()) / 86_400_000) : null;
  const toggleProfile = (id: string) => void run('profile', () => api.setProfiles(a.slot, a.profileIds.includes(id) ? a.profileIds.filter(x => x !== id) : [...a.profileIds, id]));
  return (
    <li className={`hq-hub-acct hq-hub-acct--${st.cls}`}>
      <div className="hq-hub-acct__head">
        {a.avatar ? <img className="hq-hub-acct__avatar" src={a.avatar} alt="" /> : <span className="hq-hub-acct__tag" style={{ background: tag.color }} aria-hidden="true">{tag.short}</span>}
        <div className="hq-hub-acct__who">
          <strong>{a.label}</strong>
          {has ? (
            <span className="hq-hub-acct__id">
              {a.username ? <span className="hq-hub-acct__user">@{a.username}</span> : null}
              {a.displayName && <span>{a.displayName}</span>}
              <span className="hq-dim">{a.accountKind ? `${a.accountKind} · ` : ''}ID {a.remoteId}</span>
            </span>
          ) : <span className="hq-dim">{a.statusDetail}</span>}
        </div>
        <span className={`hq-hub-pill hq-hub-pill--${st.cls}`}>{st.label}</span>
      </div>

      <Declared a={a} api={api} />
      {a.network === 'x' && <XGuide a={a} api={api} />}
      {a.network === 'pinterest' && <PinterestGuide a={a} api={api} />}
      {!has && (
        <div className="hq-hub-acct__profiles" role="group" aria-label={`Perfis que usam ${a.label}`}>
          <span className="hq-dim">Perfil:</span>
          {profiles.map(p => (
            <button key={p.id} type="button" className={`hq-chip hq-chip--xs hq-hub-chip${a.profileIds.includes(p.id) ? ' hq-hub-chip--on' : ''}`} aria-pressed={a.profileIds.includes(p.id)} disabled={busy !== null} onClick={() => toggleProfile(p.id)}>{p.name}</button>
          ))}
          {a.profileIds.length === 0 && <span className="hq-hub-warn">a confirmar: a qual marca esta conta pertence?</span>}
        </div>
      )}
      {!has && a.mode === 'manual' && (
        <ul className="hq-hub-caps" aria-label="Capacidades">
          <Cap name="Conta autenticada" cap={a.capabilities.authenticated} />
          <Cap name="Leitura" cap={a.capabilities.read} />
          <Cap name="Publicação" cap={a.capabilities.publish} />
          <Cap name="Agendamento" cap={a.capabilities.schedule} />
        </ul>
      )}
      {has && (
        <>
          <div className="hq-hub-acct__profiles" role="group" aria-label={`Perfis que usam ${a.label}`}>
            <span className="hq-dim">Perfil:</span>
            {profiles.map(p => (
              <button key={p.id} type="button" className={`hq-chip hq-chip--xs hq-hub-chip${a.profileIds.includes(p.id) ? ' hq-hub-chip--on' : ''}`} aria-pressed={a.profileIds.includes(p.id)} disabled={busy !== null} onClick={() => toggleProfile(p.id)}>{p.name}</button>
            ))}
            {a.profileIds.length === 0 && <span className="hq-hub-warn">escolha um perfil para esta conta aparecer como destino</span>}
          </div>
          <ul className="hq-hub-caps" aria-label="Capacidades">
            <Cap name="Conta autenticada" cap={a.capabilities.authenticated} />
            <Cap name="Leitura" cap={a.capabilities.read} />
            <Cap name="Publicação" cap={a.capabilities.publish} />
            <Cap name="Agendamento" cap={a.capabilities.schedule} />
          </ul>
          <p className="hq-hub-acct__meta">
            Última verificação: {when(a.lastCheckAt)}{a.lastCheckOk === false ? ' (falhou)' : a.lastCheckOk ? ' (ok)' : ''}
            {days != null && ` · acesso vale mais ${Math.max(0, days)} dia(s)`}
            {a.lastPublish && <> · última publicação pela HQ: {when(a.lastPublish.at)}{a.lastPublish.url && <> (<button type="button" className="hq-linkbtn" onClick={() => api.openUrl(a.lastPublish!.url!)}>abrir</button>)</>}</>}
          </p>
          {a.status !== 'connected' && a.statusDetail && <p className="hq-hub-acct__detail">{a.statusDetail}</p>}
        </>
      )}
      {a.lastError && <p className="hq-hub-acct__error">{a.lastError}</p>}
      {a.nextStep && <p className="hq-hub-acct__next"><strong>Próximo passo:</strong> {a.nextStep}</p>}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      {link && <p className="hq-field__hint">O navegador bloqueou a janela. <button type="button" className="hq-linkbtn" onClick={() => { api.openUrl(link); setLink(null); }}>Abrir a autorização</button></p>}

      <div className="hq-actions hq-hub-acct__actions">
        {a.mode === 'manual' && <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.openUrl(a.siteUrl)} title="Abre o site oficial no seu navegador (o login é seu)">Abrir o site</button>}
        {!has && a.mode === 'api' && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={a.status === 'needs_app' || busy !== null} title={a.status === 'needs_app' ? `Configure antes o app: ${app?.label ?? ''}` : 'Abre a autorização da rede no navegador'} onClick={connect}>{busy === 'connect' ? 'Abrindo…' : 'Conectar'}</button>}
        {has && <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} onClick={() => void run('check', () => api.check(a.slot))}>{busy === 'check' ? 'Testando…' : 'Testar conexão'}</button>}
        {has && <button type="button" className={`hq-btn hq-btn--sm${a.status === 'expired' || a.status === 'expiring' ? ' hq-btn--primary' : ''}`} disabled={busy !== null} title="Entre de novo na MESMA conta; outra conta é recusada" onClick={connect}>Reconectar</button>}
        {has && a.capabilities.publish.hqReady && (a.status === 'connected' || a.status === 'expiring') && <button type="button" className="hq-btn hq-btn--sm" onClick={() => onPublish(a)} title="Abre o texto de teste para você conferir e disparar">Preparar publicação de teste</button>}
        {has && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy !== null} onClick={() => { if (window.confirm(`Desconectar ${a.label}${accountName(a) ? ` (${accountName(a)})` : ''}? A HQ apaga o acesso guardado. O histórico de publicações continua. A autorização ainda aparece no app da rede, onde você pode removê-la.`)) void run('disconnect', () => api.disconnect(a.slot)); }}>Desconectar</button>}
      </div>
    </li>
  );
}

function AppCard({ app, api, highlight }: { app: SocialAppStatus; api: SocialHubApi; highlight: boolean }) {
  const [open, setOpen] = useState(highlight && !app.configured);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try { await api.saveApp(app.app, clientId || '', secret || undefined); setSecret(''); setClientId(''); setSaved(true); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <li className={`hq-hub-app${highlight ? ' hq-hub-app--next' : ''}`}>
      <button type="button" className="hq-hub-app__head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <strong>{app.label}</strong>
        <span className={`hq-hub-pill hq-hub-pill--${app.configured ? 'ok' : 'off'}`}>{app.configured ? `configurado (${app.clientIdHint})` : 'não configurado'}</span>
      </button>
      {open && (
        <div className="hq-hub-app__body">
          <ol className="hq-hub-steps">{app.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          <button type="button" className="hq-linkbtn" onClick={() => api.openUrl(app.consoleUrl)}>Abrir o painel de desenvolvedor</button>
          <div className="hq-hub-app__form">
            <label className="hq-field"><span>{app.app === 'tiktok' ? 'Client key' : app.app === 'linkedin' ? 'Client ID' : `${SOCIAL_NETWORK_LABEL[app.app]} App ID`}{app.configured ? ' (deixe vazio para manter)' : ''}</span>
              <input className="hq-input" value={clientId} onChange={e => setClientId(e.target.value)} onKeyDown={noEnter} autoComplete="off" spellCheck={false} placeholder={app.configured ? app.clientIdHint ?? '' : ''} />
            </label>
            <label className="hq-field"><span>Segredo do app{app.configured ? ' (deixe vazio para manter)' : ''}</span>
              <input className="hq-input" type="password" value={secret} onChange={e => setSecret(e.target.value)} onKeyDown={noEnter} autoComplete="new-password" spellCheck={false} />
            </label>
            <p className="hq-field__hint">O segredo vai direto para o cofre do Windows no serviço da HQ e nunca volta para esta tela.</p>
            {error && <p className="hq-composer__bad" role="alert">{error}</p>}
            {saved && <p className="hq-hub-ok" role="status">App salvo no cofre.</p>}
            <div className="hq-actions">
              <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy || (!clientId && !app.configured) || (!app.configured && !secret)} onClick={() => { if (!clientId && app.configured) setError(`Informe o ${app.app === 'tiktok' ? 'Client key' : 'App ID'} de novo para trocar o segredo.`); else void save(); }}>{busy ? 'Salvando…' : 'Salvar no cofre'}</button>
              {app.configured && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => { if (window.confirm(`Apagar o app do ${SOCIAL_NETWORK_LABEL[app.app]} do cofre? As contas desta rede deixam de conseguir conectar e renovar até você configurar de novo.`)) void api.clearApp(app.app); }}>Apagar do cofre</button>}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

/** Conta informada (o @ que você usa ou que a HQ achou num material seu, a confirmar). Nunca autentica nada. */
function Declared({ a, api }: { a: SocialAccount; api: SocialHubApi }) {
  const d = a.declared;
  const [edit, setEdit] = useState(false);
  const [handle, setHandle] = useState(d?.handle ?? '');
  const [url, setUrl] = useState(d?.profileUrl ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async (confirmed: boolean, toCreate = false) => {
    setError(null);
    try { await api.declare(a.slot, toCreate ? null : handle.trim() || null, toCreate ? null : url.trim() || null, confirmed, toCreate); setEdit(false); } catch (err) { setError((err as Error).message); }
  };
  if (a.remoteId && !d) return null;
  return (
    <div className="hq-hub-declared">
      {!edit && d && (
        <p>
          <span className="hq-dim">Conta informada: </span>
          {d.toCreate ? <strong>ainda a criar</strong> : <strong>{d.handle ? '@' + d.handle : d.profileUrl}</strong>}
          {!d.toCreate && <span className={d.confirmed ? 'hq-hub-ok' : 'hq-hub-warn'}>{d.confirmed ? ' · confirmada por você' : ` · a confirmar (achada em ${d.source})`}</span>}
          {a.remoteId && a.username && d.handle && a.username.toLowerCase() !== d.handle.toLowerCase() && <span className="hq-composer__bad"> · diferente da conta conectada (@{a.username})</span>}
        </p>
      )}
      {!edit && !d && <p className="hq-dim">Nenhuma conta informada para este destino.</p>}
      {edit && (
        <div className="hq-hub-declared__form">
          <label className="hq-field"><span>@ da conta</span><input className="hq-input" value={handle} onChange={e => setHandle(e.target.value)} onKeyDown={noEnter} placeholder="sem o @" spellCheck={false} /></label>
          <label className="hq-field"><span>Link do perfil (opcional)</span><input className="hq-input" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={noEnter} placeholder="https://..." spellCheck={false} /></label>
        </div>
      )}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      <div className="hq-actions">
        {!edit && d && !d.confirmed && !d.toCreate && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => void api.declare(a.slot, d.handle, d.profileUrl, true).catch(err => setError((err as Error).message))}>É esta mesma</button>}
        {!edit && <button type="button" className="hq-btn hq-btn--sm" onClick={() => setEdit(true)}>{d ? 'Corrigir' : 'Informar a conta'}</button>}
        {!edit && (a.network === 'x' || a.network === 'pinterest') && !d?.toCreate && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => void save(false, true)}>Ainda não tenho</button>}
        {edit && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={!handle.trim() && !url.trim()} onClick={() => void save(true)}>Salvar e confirmar</button>}
        {edit && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => { setEdit(false); setError(null); }}>Cancelar</button>}
      </div>
    </div>
  );
}

/** Roteiro para criar a conta do X no site oficial: o cadastro, o login e as verificações são do Chefe. */
export const X_GUIDE = {
  names: ['Tuco Dev', 'Tuco Dev · Tech Updates'],
  handles: ['tucoexemplo', 'tuco_dev', 'tucoexemplo_en', 'tucotech'],
  bio: 'Tech updates, developer tools & security alerts. Verified sources. Practical takeaways. By Tuco Dev.',
  intro: "Hi, I'm Tuco Dev. Here I post short, verified tech updates: developer tools, releases and security alerts, each with the original source and what it means in practice. No hype, no fake urgency.",
  introPt: 'Oi, eu sou o Tuco Dev. Aqui eu posto atualizações curtas e verificadas de tecnologia: ferramentas de desenvolvimento, lançamentos e alertas de segurança, cada uma com a fonte original e o que muda na prática. Sem exagero e sem urgência falsa.',
};

function XGuide({ a, api }: { a: SocialAccount; api: SocialHubApi }) {
  const [open, setOpen] = useState(Boolean(a.declared?.toCreate));
  if (a.declared?.confirmed) return null;
  return (
    <div className="hq-hub-guide">
      <button type="button" className="hq-linkbtn" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? '▾' : '▸'} Roteiro para criar a conta do X (em inglês)</button>
      {open && (
        <div className="hq-hub-guide__body">
          <ol className="hq-hub-steps">
            <li>Abra o cadastro no site oficial e preencha nome, e-mail ou telefone e data de nascimento. Os dados pessoais, o código de verificação e a senha são seus; a HQ não vê nada disso.</li>
            <li>Nome sugerido: <strong>{X_GUIDE.names.join(' ou ')}</strong>.</li>
            <li>Opções de @ (a disponibilidade só o X confirma no cadastro): {X_GUIDE.handles.map(h => <code key={h}>@{h}</code>).reduce((p, c, i) => (i ? [...p, ' · ', c] : [c]), [] as React.ReactNode[])}.</li>
            <li>Bio: <q>{X_GUIDE.bio}</q> <button type="button" className="hq-linkbtn" onClick={() => void api.copy(X_GUIDE.bio)}>copiar</button></li>
            <li>Foto e capa: use as imagens preparadas a partir do mascote do Tuco Dev em <code>marcas/tuco-dev/x-conta/</code> na pasta de conteúdo (sem deformar o mascote).</li>
            <li>Primeiro post (apresentação): <q>{X_GUIDE.intro}</q> <button type="button" className="hq-linkbtn" onClick={() => void api.copy(X_GUIDE.intro)}>copiar</button><br /><span className="hq-dim">Tradução para você revisar (não publicar): {X_GUIDE.introPt}</span></li>
            <li>Depois do cadastro, clique em "Corrigir" acima e informe o @ escolhido.</li>
          </ol>
          <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.openUrl('https://x.com/i/flow/signup')}>Abrir o cadastro do X</button>
          <p className="hq-field__hint">A API do X cobra por uso: a HQ não compra créditos e não depende dela. Os posts ficam prontos e você publica pelo site.</p>
        </div>
      )}
    </div>
  );
}

function PinterestGuide({ a, api }: { a: SocialAccount; api: SocialHubApi }) {
  const [open, setOpen] = useState(!a.declared);
  if (a.declared?.confirmed) return null;
  return (
    <div className="hq-hub-guide">
      <button type="button" className="hq-linkbtn" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? '▾' : '▸'} Conta business do Pinterest</button>
      {open && (
        <div className="hq-hub-guide__body">
          <ol className="hq-hub-steps">
            <li>Primeiro: você já tem conta no Pinterest? Se tiver, informe o @ acima (pode converter para business sem custo nas configurações da conta).</li>
            <li>Se não tiver, crie uma conta business gratuita pelo site oficial. O cadastro e o login são seus.</li>
            <li>Pastas sugeridas, ligadas ao portfólio: <strong>Web Design</strong>, <strong>Landing Pages</strong>, <strong>UI Details</strong> (editáveis).</li>
            <li>Idioma: a confirmar com o público escolhido (português ou inglês). O portfólio tem páginas nos dois.</li>
            <li>Cada Pin sai da HQ com imagem própria (desktop e mobile), título, descrição e a URL real do projeto.</li>
          </ol>
          <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.openUrl('https://www.pinterest.com/business/create/')}>Abrir o cadastro business</button>
        </div>
      )}
    </div>
  );
}

const BSTATE_CLS: Record<string, string> = { cadastrada: 'off', aguardando_login: 'warn', verificada: 'ok', sessao_expirada: 'bad', aguardando_intervencao: 'warn', erro: 'bad' };
const CAP_STATE: Record<string, string> = { testada: 'testada', nao_testada: 'não testada', indisponivel: 'indisponível' };

/** Seu Edge pela Playwright Extension: instalação (uma vez) e o token de pareamento (cofre), para a equipe conectar sem pedir. */
function EdgeSetup({ state, api }: { state: SocialState; api: SocialHubApi }) {
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const b = state.browser!;
  return (
    <section className="hq-hub__section">
      <h3 className="hq-label">Seu Edge</h3>
      <p className="hq-field__hint">A sala usa o Edge que você já usa, com os logins que já estão nele. A equipe trabalha numa aba própria e nunca fecha o seu navegador nem as suas abas. Para isso, o Edge precisa da extensão oficial do Playwright (uma vez).</p>
      <div className="hq-actions">
        <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.openUrl(b.extensionUrl!)}>Instalar a Playwright Extension</button>
      </div>
      <label className="hq-field"><span>Token da extensão {b.tokenSaved ? '(salvo no cofre; deixe vazio para manter)' : '(opcional: sem ele, cada conexão pede sua aprovação na aba da extensão)'}</span>
        <input className="hq-input" type="password" value={token} onChange={e => setToken(e.target.value)} onKeyDown={noEnter} autoComplete="off" spellCheck={false} />
      </label>
      <div className="hq-actions">
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={!token.trim()} onClick={() => void api.browserToken(token.trim()).then(() => { setToken(''); setMsg('Token salvo no cofre do Windows.'); }).catch(err => setMsg((err as Error).message))}>Salvar token</button>
        {b.tokenSaved && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => void api.browserToken(null).then(() => setMsg('Token apagado.'))}>Apagar token</button>}
      </div>
      {msg && <p className="hq-field__hint" role="status">{msg}</p>}
    </section>
  );
}

/** Conta operada pelo navegador da HQ (perfil próprio, login feito por você na janela). Sem App ID nem segredo. */
function BrowserCard({ a, profiles, api, edge }: { a: SocialAccount; profiles: EditorialProfile[]; api: SocialHubApi; edge: boolean }) {
  const b = a.browser!;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: string, fn: () => Promise<unknown>) => { setBusy(what); setError(null); try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(null); } };
  const tag = NET_TAG[a.network];
  const toggleProfile = (id: string) => void run('profile', () => api.setProfiles(a.slot, a.profileIds.includes(id) ? a.profileIds.filter(x => x !== id) : [...a.profileIds, id]));
  const registered = a.declared?.handle ? `@${a.declared.handle}` : a.declared?.profileUrl ?? 'sem cadastro';
  return (
    <li className={`hq-hub-acct hq-hub-acct--${BSTATE_CLS[b.state] ?? 'off'}`}>
      <div className="hq-hub-acct__head">
        <span className="hq-hub-acct__tag" style={{ background: tag.color }} aria-hidden="true">{tag.short}</span>
        <div className="hq-hub-acct__who">
          <strong>{a.label}</strong>
          <span className="hq-hub-acct__id">
            <span className="hq-dim">Cadastro:</span> <span className="hq-hub-acct__user">{registered}</span>
            <span className="hq-dim">· Detectada: {b.detectedHandle ? `@${b.detectedHandle}` : 'ainda não lida'}</span>
            <span className="hq-dim">· Modo Navegador{edge ? ' (seu Edge)' : ' (perfil da HQ)'}</span>
          </span>
        </div>
        <span className={`hq-hub-pill hq-hub-pill--${BSTATE_CLS[b.state] ?? 'off'}`}>{BROWSER_STATE_LABEL[b.state]}</span>
      </div>
      <div className="hq-hub-acct__profiles" role="group" aria-label={`Perfis que usam ${a.label}`}>
        <span className="hq-dim">Perfil:</span>
        {profiles.map(p => <button key={p.id} type="button" className={`hq-chip hq-chip--xs hq-hub-chip${a.profileIds.includes(p.id) ? ' hq-hub-chip--on' : ''}`} aria-pressed={a.profileIds.includes(p.id)} disabled={busy !== null} onClick={() => toggleProfile(p.id)}>{p.name}</button>)}
      </div>
      {b.detail && <p className="hq-hub-acct__detail">{b.detail}</p>}
      <ul className="hq-hub-caps" aria-label="Capacidades no navegador">
        {(Object.keys(BROWSER_CAP_LABEL) as BrowserCapKey[]).map(k => (
          <li key={k} className={`hq-hub-cap hq-hub-cap--${b.caps[k].state === 'testada' ? 'tested' : b.caps[k].state === 'indisponivel' ? 'unavailable' : 'unknown'}`}>
            <span className="hq-hub-cap__name">{BROWSER_CAP_LABEL[k]}</span>
            <span className="hq-hub-cap__state">{CAP_STATE[b.caps[k].state]}{b.caps[k].at ? ` · ${when(b.caps[k].at)}` : ''}</span>
            <span className="hq-hub-cap__detail">{b.caps[k].detail}</span>
          </li>
        ))}
      </ul>
      <p className="hq-hub-acct__meta">Última verificação: {when(b.lastCheckAt)}{b.verifiedAt ? ` · identidade conferida ${when(b.verifiedAt)}` : ''}{b.open ? ` · janela aberta${b.owner ? ` com ${b.owner}` : ''}${b.manual ? ' (controle com você)' : ''}` : ''}</p>
      {b.lastError && b.state !== 'verificada' && <p className="hq-hub-acct__error">{b.lastError}</p>}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      <div className="hq-actions hq-hub-acct__actions">
        {(b.state === 'cadastrada' || b.state === 'aguardando_login') && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null || !a.declared?.confirmed} title={edge ? 'Abre uma aba da HQ no seu Edge e confere a conta que você já usa' : 'Abre a janela da HQ no login da rede; você entra direto no site'} onClick={() => void run('connect', () => api.browser('connect', a.slot))}>{busy === 'connect' ? 'Abrindo…' : edge ? 'Conectar pelo meu Edge' : 'Conectar pelo navegador'}</button>}
        {!edge && (b.state === 'sessao_expirada' || b.state === 'erro' || b.state === 'verificada' || b.state === 'aguardando_intervencao') && <button type="button" className={`hq-btn hq-btn--sm${b.state === 'sessao_expirada' || b.state === 'erro' ? ' hq-btn--primary' : ''}`} disabled={busy !== null} title="Abre o login de novo nesta conta (só esta)" onClick={() => void run('connect', () => api.browser('connect', a.slot))}>Reconectar</button>}
        {b.state !== 'cadastrada' && <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} title="Lê a conta logada na interface do site e compara com o cadastro" onClick={() => void run('verify', () => api.browser('verify', a.slot))}>{busy === 'verify' ? 'Verificando…' : 'Verificar conta'}</button>}
        <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} onClick={() => void run('show', () => api.browser('show', a.slot))}>Mostrar navegador</button>
        {b.open && !b.manual && <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} title="Pausa os comandos automáticos desta janela para você operar" onClick={() => void run('take', () => api.browserControl(a.slot, true))}>Assumir controle</button>}
        {b.open && b.manual && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null} title="O funcionário relê a página antes de continuar" onClick={() => void run('give', () => api.browserControl(a.slot, false))}>Devolver ao funcionário</button>}
        {b.state !== 'cadastrada' && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy !== null} onClick={() => { if (window.confirm(edge ? `Desconectar ${a.label} da HQ? A equipe deixa de usar esta conta até você verificar de novo. Seu Edge e o login dele não são tocados.` : `Desconectar ${a.label} da HQ? A HQ apaga o perfil de navegador desta conta (a sessão salva). O cadastro e o histórico continuam; seu navegador normal não é tocado.`)) void run('disconnect', () => api.browser('disconnect', a.slot)); }}>Desconectar da HQ</button>}
      </div>
      {!a.declared?.confirmed && <p className="hq-hub-warn">Cadastre e confirme a conta antes de conectar: a HQ compara a conta logada com o cadastro.</p>}
    </li>
  );
}

/** A ordem do que depende do Chefe: página de retorno → app → contas, uma rede por vez. */
export function nextHubStep(s: SocialState): { text: string; app?: SocialAppId } | null {
  const browser = s.accounts.filter(a => a.browser?.mode === 'navegador');
  if (browser.length) {
    const fix = browser.find(a => a.browser!.state === 'erro' || a.browser!.state === 'sessao_expirada' || a.browser!.state === 'aguardando_intervencao');
    if (fix) return { text: `${fix.label}: ${BROWSER_STATE_LABEL[fix.browser!.state]}. ${fix.browser!.detail}` };
    const todo = browser.find(a => a.browser!.state !== 'verificada');
    return todo ? { text: `Conectar pelo navegador: ${todo.label} (a janela abre no login do site; você entra e a HQ confere a identidade).` } : null;
  }
  if (s.redirectCheck.ok === false) return { text: 'Publicar a página de retorno no site da Aurora (peça para a HQ publicar; sem ela nenhuma rede consegue devolver o login).' };
  const order: SocialAppId[] = ['instagram', 'threads', 'tiktok', 'linkedin'];
  for (const app of order) {
    const conf = s.apps.find(a => a.app === app)?.configured;
    const accts = s.accounts.filter(a => a.network === app);
    if (!conf) return { text: `Configurar o app do ${SOCIAL_NETWORK_LABEL[app]} (passos no cartão abaixo).`, app };
    const pending = accts.find(a => !a.remoteId);
    if (pending) return { text: `Conectar ${pending.label}: clique em Conectar e entre na conta certa no navegador.` };
    const toFix = accts.find(a => a.status === 'expired' || a.status === 'error');
    if (toFix) return { text: `Reconectar ${toFix.label} (${toFix.statusDetail}).` };
    const noProfile = accts.find(a => a.profileIds.length === 0);
    if (noProfile) return { text: `Escolher o perfil de ${noProfile.label} (Aurora, Tuco Dev ou os dois).` };
  }
  return null;
}

export function SocialHub({ state, profiles, api }: { state: SocialState | null; profiles: EditorialProfile[]; api: SocialHubApi }) {
  const [publishing, setPublishing] = useState<SocialAccount | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [uriErr, setUriErr] = useState<string | null>(null);
  if (!state) return <p className="hq-empty">A central de Redes não está disponível neste serviço da HQ.</p>;
  const n = connectedCount(state);
  const next = nextHubStep(state);
  const rc = state.redirectCheck;
  return (
    <div className="hq-hub">
      <p className="hq-hub__summary"><strong>Redes: {socialSummary(state)}</strong>{n ? ` · ${n} pela API` : ''} · <span className={state.vault.ok ? 'hq-dim' : 'hq-composer__bad'}>{state.vault.detail}</span></p>
      <p className="hq-field__hint">Cadastrada = conta informada e confirmada por você. Verificada = a HQ entrou pelo navegador (perfil próprio da conta) e leu a identidade na interface do site. Uma autenticação não comprova pesquisa, métricas, publicação nem agendamento: cada capacidade aparece separada.</p>
      {state.browser?.mode === 'extensao' && <EdgeSetup state={state} api={api} />}
      {state.browser && <p className="hq-dim">Navegador da HQ: {state.browser.engine} · perfis em <code>{state.browser.profilesDir}</code> · {state.browser.open ? `janela aberta: ${state.accounts.find(x => x.slot === state.browser!.open!.slot)?.label}${state.browser.open.owner ? ` com ${state.browser.open.owner}` : ''}` : 'nenhuma janela aberta'}</p>}
      {next && <p className="hq-hub__next"><strong>Próximo passo:</strong> {next.text}</p>}

      <section className="hq-hub__section">
        <h3 className="hq-label">Página de retorno do login</h3>
        <p className="hq-field__hint">As redes só devolvem o login para um endereço HTTPS público (não aceitam localhost). Esta página do site da Aurora repassa o código para a HQ neste computador; ela não guarda nada e o código sozinho não vale sem o segredo do app.</p>
        <div className="hq-hub-redirect">
          {uri === null ? <code className="hq-hub-redirect__uri">{state.redirectUri}</code>
            : <input className="hq-input" value={uri} onChange={e => setUri(e.target.value)} onKeyDown={noEnter} aria-label="Endereço de retorno" />}
          {uri === null ? (
            <>
              <button type="button" className="hq-btn hq-btn--sm" onClick={() => void api.copy(state.redirectUri)}>Copiar</button>
              <button type="button" className="hq-btn hq-btn--sm" onClick={() => void api.checkRedirect()}>Conferir</button>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setUri(state.redirectUri)}>Trocar</button>
            </>
          ) : (
            <>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => { setUriErr(null); api.saveRedirect(uri).then(() => setUri(null)).catch(err => setUriErr((err as Error).message)); }}>Salvar</button>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => { setUri(null); setUriErr(null); }}>Cancelar</button>
            </>
          )}
        </div>
        <p className={`hq-hub-redirect__state hq-hub-redirect__state--${rc.ok === true ? 'ok' : rc.ok === false ? 'bad' : 'off'}`}>{rc.ok === true ? '✓ ' : ''}{rc.detail}{rc.at ? ` · conferida ${when(rc.at)}` : ''}</p>
        {uriErr && <p className="hq-composer__bad" role="alert">{uriErr}</p>}
      </section>

      <section className="hq-hub__section">
        <h3 className="hq-label">Contas</h3>
        <ul className="hq-hub-accts">
          {state.accounts.map(a => a.browser?.mode === 'navegador' ? <BrowserCard key={a.slot} a={a} profiles={profiles} api={api} edge={state.browser?.mode === 'extensao'} /> : <AccountCard key={a.slot} a={a} profiles={profiles} api={api} app={state.apps.find(x => x.app === a.network)} onPublish={setPublishing} />)}
        </ul>
      </section>

      {state.accounts.some(a => a.browser?.mode !== 'navegador') && <section className="hq-hub__section">
        <h3 className="hq-label">Apps de desenvolvedor</h3>
        <p className="hq-field__hint">Cada rede exige um app seu no painel de desenvolvedor. Siga os passos de cada cartão; o segredo fica no cofre do Windows.</p>
        <ul className="hq-hub-apps">
          {state.apps.map(app => <AppCard key={app.app} app={app} api={api} highlight={next?.app === app.app} />)}
        </ul>
      </section>}

      {publishing && <PublishDialog account={publishing} initialText={testPostText(publishing)} api={api} onClose={() => setPublishing(null)} maxChars={publishing.network === 'threads' ? 500 : 3000} />}
    </div>
  );
}
