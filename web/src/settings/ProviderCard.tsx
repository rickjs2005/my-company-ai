// Cartão de um provedor de IA (Claude via Claude Code, OpenAI via Codex) na aba "Conexões".
// Mostra só o que o servidor verificou de fato: instalação, versão, login (sem credenciais), catálogo com origem e data,
// e em que passo a conexão está (login ok não é "pronto": pronto exige uma resposta real no teste).
// Escolhas de modelo/esforço são um rascunho (prefs) que o diálogo grava ao Salvar; nada é enviado a cada clique de select.
// A interface nunca pede token nem cookie: o login é sempre o fluxo oficial de cada CLI.
import { useEffect, useState } from 'react';
import type { AiProviderId, AiProviderPrefs, AiProviderStatus, AiTestResult, EffortLevel } from '@milweb-hq/protocol';
import { isEffortLevel } from '@milweb-hq/protocol';
import { formatDuration } from '../panel/helpers';
import {
  AUTH_TONES, authStateLabel, checkedAtText, connectionSteps, effortLabel, effortsForModel, findModel, formatCatalogAt, formatTimeOfDay,
  isEffortUnavailable, isNewerVersion, loginIssue, maskEmail, modelOptionText, pendingValidation, providerTitle, sortedModelOptions,
} from './helpers';

export interface ProviderCardProps {
  status: AiProviderStatus;
  /** Rascunho de modelo/esforço deste provedor (o diálogo guarda e grava ao Salvar). */
  prefs: AiProviderPrefs;
  onChange(prefs: AiProviderPrefs): void;
  onRefresh?(provider: AiProviderId): Promise<void>;
  onTest?(provider: AiProviderId, model: string | null, effort: EffortLevel | null): Promise<AiTestResult>;
  onLoginStart?(provider: AiProviderId): Promise<{ url: string | null; detail: string }>;
  onLoginCancel?(provider: AiProviderId): void;
  onOpenExternal?(url: string): void;
}

const UNAVAILABLE = '__unavailable__';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ProviderCard(props: ProviderCardProps) {
  const { status, prefs } = props;
  const [refreshing, setRefreshing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginLocal, setLoginLocal] = useState<{ url: string | null; detail: string } | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Quando o servidor confirma o login, o fluxo local deixa de fazer sentido.
  useEffect(() => { if (status.authState === 'ok') { setLoginLocal(null); setLoginError(null); } }, [status.authState]);
  // O servidor encerrou o fluxo com erro (falha, expiração): a URL local deixa de valer e o botão "Entrar" volta para tentar de novo.
  useEffect(() => { if (status.authState === 'error' && !status.login) setLoginLocal(null); }, [status.authState, status.login]);

  const model = findModel(status, prefs.model);
  const modelKnown = prefs.model == null || model != null;
  const efforts = effortsForModel(status, prefs.model);
  const noEffortForModel = model != null && model.efforts.length === 0;
  const effortUnavailable = isEffortUnavailable(status, prefs.model, prefs.effort);
  const busy = status.busy || refreshing || testing;
  const outdated = isNewerVersion(status.version, status.latestKnownVersion);
  const tone = AUTH_TONES[status.authState];
  const login = status.login;
  const loginUrl = login?.url ?? loginLocal?.url ?? null;
  const loginDetail = login?.detail ?? loginLocal?.detail ?? null;
  // Um teste com resposta nesta sessão vale como validação mesmo antes do ai.status do servidor chegar com lastTest.
  const effective: AiProviderStatus = testResult ? { ...status, lastTest: testResult } : status;
  const steps = connectionSteps(effective);
  const pending = pendingValidation(effective);
  const issue = loginIssue(status);
  // "Entrar" fica disponível sem login, com erro de verificação ou depois de um fluxo cancelado/expirado — para tentar de novo.
  const canStartLogin = status.provider === 'openai' && Boolean(props.onLoginStart) && !loginUrl && !login?.inProgress
    && (status.authState === 'missing' || status.authState === 'error');

  const refresh = async () => {
    if (!props.onRefresh || busy) return;
    setRefreshing(true); setRefreshError(null);
    try { await props.onRefresh(status.provider); }
    catch (err) { setRefreshError(errorText(err)); }
    finally { setRefreshing(false); }
  };

  const test = async () => {
    if (!props.onTest || busy) return;
    setTesting(true); setTestError(null); setTestResult(null);
    try { setTestResult(await props.onTest(status.provider, prefs.model, prefs.effort)); }
    catch (err) { setTestError(errorText(err)); }
    finally { setTesting(false); }
  };

  const startLogin = async () => {
    if (!props.onLoginStart || loginBusy) return;
    setLoginBusy(true); setLoginError(null);
    try { setLoginLocal(await props.onLoginStart(status.provider)); }
    catch (err) { setLoginError(errorText(err)); }
    finally { setLoginBusy(false); }
  };

  const cancelLogin = () => {
    props.onLoginCancel?.(status.provider);
    setLoginLocal(null); setLoginError(null);
  };

  const onModelChange = (value: string) => {
    const next = value || null;
    // Sem substituição silenciosa: o esforço fica como está e, se não existir no modelo novo, a interface avisa.
    props.onChange({ model: next, effort: prefs.effort });
  };

  const onEffortChange = (value: string) => {
    if (value === UNAVAILABLE) return;
    props.onChange({ model: prefs.model, effort: isEffortLevel(value) ? value : null });
  };

  const effortSelectDisabled = noEffortForModel && !effortUnavailable;

  return (
    <section className="hq-ai-card" aria-label={`Provedor ${status.label}`}>
      <header className="hq-ai-card__head">
        <div className="hq-ai-card__title">
          <h3>{providerTitle(status)}</h3>
          <span className="hq-ai-card__route">{status.routeLabel}</span>
        </div>
        <div className="hq-ai-card__badges">
          <span className={`hq-ai-auth hq-ai-auth--${tone}`}>{authStateLabel(status)}</span>
          {pending && <span className="hq-ai-auth hq-ai-auth--warn" title="login confirmado, mas ainda sem resposta real nesta conexão">pendente de validação</span>}
        </div>
      </header>

      <ol className="hq-ai-steps" aria-label="Passos da conexão">
        {steps.steps.map((label, i) => {
          const state = i < steps.current ? 'done' : i === steps.current ? 'current' : 'todo';
          return (
            <li key={label} className={`hq-ai-steps__item hq-ai-steps__item--${state}${i === steps.current ? ` hq-ai-steps__item--${steps.tone}` : ''}`} aria-current={i === steps.current ? 'step' : undefined}>
              <span className="hq-ai-steps__dot" aria-hidden="true">{i < steps.current ? '✓' : i + 1}</span>
              <span className="hq-ai-steps__label">{label}</span>
            </li>
          );
        })}
      </ol>
      <div className={`hq-ai-steps__note hq-ai-steps__note--${steps.tone}`} role="status">{steps.note}</div>
      {status.provider === 'openai' && (
        <p className="hq-ai-note hq-ai-plain">Não importa conversas, memórias nem GPTs do ChatGPT; só usa a conta para o Codex responder.</p>
      )}

      <dl className="hq-ai-facts">
        <dt>Instalação</dt>
        <dd>
          {status.installed ? (
            <>
              <span className="hq-ai-ok">instalado</span>
              {status.version && <> · versão <span className="hq-mono">{status.version}</span></>}
              {status.exePath && <div className="hq-mono hq-dim hq-ai-path" title={status.exePath}>{status.exePath}</div>}
              {outdated && status.latestKnownVersion && (
                <div className="hq-ai-note">existe a versão {status.latestKnownVersion}; a HQ não atualiza nada sozinha.</div>
              )}
            </>
          ) : (
            <span className="hq-ai-danger">não instalado</span>
          )}
        </dd>
        <dt>Login</dt>
        <dd>
          {status.authState === 'ok' && <span className="hq-ai-ok">{status.authMethod ? maskEmail(status.authMethod) : 'ok'}</span>}
          {status.authState === 'unknown' && <span className="hq-dim">não verificado{status.authDetail ? ` · ${maskEmail(status.authDetail)}` : ''}</span>}
          {(status.authState === 'missing' || status.authState === 'error') && (
            <div className="hq-ai-login">
              {status.authState === 'error'
                ? <span className="hq-ai-warn">erro ao verificar o login{issue ? `: ${issue}` : ''}</span>
                : <span className="hq-ai-danger">sem login</span>}
              {status.authState === 'missing' && status.authDetail && <div className="hq-dim">{maskEmail(status.authDetail)}</div>}
              {status.authState === 'missing' && issue && <div className="hq-ai-warn">{issue} — tente entrar de novo.</div>}
              {status.provider === 'claude' && (
                <div className="hq-dim">rode <code className="hq-mono">claude</code> no terminal e faça <code className="hq-mono">/login</code></div>
              )}
              {canStartLogin && (
                <button type="button" className="hq-btn hq-btn--sm" onClick={startLogin} disabled={loginBusy}>
                  {loginBusy ? 'Preparando login…' : 'Entrar no ChatGPT (Codex)'}
                </button>
              )}
              {(loginUrl || login?.inProgress) && (
                <div className="hq-ai-login__flow">
                  {login?.inProgress && <div className="hq-ai-login__wait"><span className="hq-spinner" aria-hidden="true" /> aguardando o login no navegador…</div>}
                  {loginDetail && <div className="hq-dim">{maskEmail(loginDetail)}</div>}
                  {loginUrl && <div className="hq-mono hq-ai-login__url" title={loginUrl}>{loginUrl}</div>}
                  <div className="hq-actions">
                    {loginUrl && props.onOpenExternal && (
                      <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => props.onOpenExternal?.(loginUrl)}>Abrir no navegador</button>
                    )}
                    <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={cancelLogin}>Cancelar</button>
                  </div>
                </div>
              )}
              {loginError && <div className="hq-ai-danger">não foi possível iniciar o login: {loginError}</div>}
            </div>
          )}
        </dd>
      </dl>

      <div className="hq-form__row">
        <label className="hq-field">
          <span className="hq-field__label">Modelo</span>
          <select className="hq-input" value={prefs.model ?? ''} onChange={e => onModelChange(e.target.value)}>
            <option value="">Padrão do provedor</option>
            {sortedModelOptions(status).map(m => <option key={m.id} value={m.id}>{modelOptionText(m)}</option>)}
            {!modelKnown && prefs.model && <option value={prefs.model}>{prefs.model} · fora do catálogo atual</option>}
          </select>
          {model && (
            <span className="hq-field__hint">
              id: <span className="hq-mono">{model.alias ? `${model.id} (alias do CLI${model.resolvesTo ? ` → ${model.resolvesTo}` : ''})` : model.id}</span>
              {model.note ? ` · ${model.note}` : ''}
            </span>
          )}
          {!modelKnown && <span className="hq-field__hint hq-ai-warn">este id não está no catálogo atual; o provedor pode recusar.</span>}
          <span className="hq-field__hint">
            {status.models.length === 0 ? 'catálogo ainda não carregado' : `catálogo: ${status.catalogSource} · ${formatCatalogAt(status.catalogAt)}`} · {checkedAtText(status.checkedAt)}
          </span>
        </label>
        <label className="hq-field">
          <span className="hq-field__label">Esforço</span>
          <select className="hq-input" value={effortUnavailable ? UNAVAILABLE : prefs.effort ?? ''} onChange={e => onEffortChange(e.target.value)} disabled={effortSelectDisabled}
            aria-invalid={effortUnavailable || undefined} data-invalid={effortUnavailable ? 'true' : undefined}>
            {effortUnavailable && <option value={UNAVAILABLE}>{effortLabel(prefs.effort)} (indisponível para este modelo)</option>}
            {prefs.effort && !effortUnavailable && !efforts.includes(prefs.effort) && <option value={prefs.effort}>{effortLabel(prefs.effort)} · não verificado para este modelo</option>}
            <option value="">{prefs.model ? 'Padrão do modelo' : 'Padrão do provedor'}{model?.defaultEffort ? ` (${effortLabel(model.defaultEffort)})` : ''}</option>
            {efforts.map(e => <option key={e} value={e}>{effortLabel(e)}</option>)}
          </select>
          {noEffortForModel && <span className="hq-field__hint">este modelo não aceita controle de esforço no CLI</span>}
          {effortUnavailable && <span className="hq-field__hint hq-ai-danger">escolha outro nível (ou o padrão) para poder salvar.</span>}
          {!noEffortForModel && !prefs.model && status.models.length > 0 && efforts.length === 0 && (
            <span className="hq-field__hint">os modelos deste provedor não têm níveis em comum; escolha um modelo para ver os níveis dele.</span>
          )}
          {!modelKnown && <span className="hq-field__hint">níveis não verificados para um modelo fora do catálogo.</span>}
        </label>
      </div>

      <div className="hq-actions hq-ai-card__actions">
        <button type="button" className="hq-btn hq-btn--sm" onClick={refresh} disabled={busy || !props.onRefresh}>
          {refreshing || status.busy ? <span className="hq-spinner" aria-hidden="true" /> : null}
          {refreshing ? 'Atualizando…' : 'Atualizar opções'}
        </button>
        <button type="button" className="hq-btn hq-btn--sm" onClick={test} disabled={busy || !props.onTest}>
          {testing ? <span className="hq-spinner" aria-hidden="true" /> : null}
          {testing ? 'Testando…' : 'Testar conexão'}
        </button>
        <span className="hq-dim hq-ai-card__hint">o provedor é avisado de que é um teste</span>
      </div>

      {refreshError && <div className="hq-notice hq-notice--error" role="alert">não foi possível atualizar as opções: {refreshError}</div>}
      {testError && <div className="hq-notice hq-notice--error" role="alert">teste falhou: {testError}</div>}
      {testResult && <TestLine result={testResult} prefix={null} />}
      {!testResult && status.lastTest && <TestLine result={status.lastTest} prefix="último teste" />}
    </section>
  );
}

function TestLine({ result, prefix }: { result: AiTestResult; prefix: string | null }) {
  const time = formatTimeOfDay(result.at);
  return (
    <div className={`hq-ai-test hq-ai-test--${result.ok ? 'ok' : 'fail'}`} role="status">
      {prefix && <span className="hq-dim">{prefix}{time ? ` (${time})` : ''}: </span>}
      <strong>{result.ok ? 'ok' : 'falha'}</strong>
      {' · modelo '}<span className="hq-mono">{result.resolvedModel ?? result.model ?? 'padrão'}</span>
      {result.effort ? <> · esforço {effortLabel(result.effort)}</> : null}
      {result.durationMs != null ? <> · {formatDuration(result.durationMs)}</> : null}
      {result.detail ? <> · {maskEmail(result.detail)}</> : null}
    </div>
  );
}
