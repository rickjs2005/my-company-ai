// Aba "Conexões" das Configurações: cartão do serviço da HQ, um cartão por provedor (Claude via Claude Code, OpenAI via
// Codex) e o rodapé de precedência. O rascunho (draft) é do diálogo pai, que grava patch.ai ao Salvar.
// Sem `providers`, a aba diz que o estado não chegou; sem `connection`, o cartão do serviço não é mostrado (o App ainda
// não informou a conexão) — nunca um estado inventado.
import type { AiProviderId, AiProviderStatus, AiSettings, AiTestResult, EffortLevel, ServerInfo, ServiceStatus } from '@milweb-hq/protocol';
import { ProviderCard } from './ProviderCard';
import { ServiceCard } from './ServiceCard';
import { PROVIDER_LABELS, PROVIDER_ORDER, aiSettingsProblems, type ServiceConnection } from './helpers';
import '../styles/settings.css';

export interface AiSettingsPanelProps {
  /** Estado real dos provedores (Snapshot.ai / ai.status). undefined = ainda não carregado. */
  providers?: AiProviderStatus[];
  draft: AiSettings;
  onChange(draft: AiSettings): void;
  onRefresh?(provider: AiProviderId): Promise<void>;
  onTest?(provider: AiProviderId, model: string | null, effort: EffortLevel | null): Promise<AiTestResult>;
  onLoginStart?(provider: AiProviderId): Promise<{ url: string | null; detail: string }>;
  onLoginCancel?(provider: AiProviderId): void;
  onOpenExternal?(url: string): void;
  // Cartão "Serviço da HQ" (todas opcionais; o cartão só aparece quando `connection` é informada).
  /** Estado da conexão desta aba com o serviço. */
  connection?: ServiceConnection;
  lastSnapshotAt?: number | null;
  serverInfo?: ServerInfo | null;
  /** Resposta de service.status; null = ainda não carregado. */
  service?: ServiceStatus | null;
  /** Pausa de novas tarefas em vigor (padrão: false só quando nem Settings nem o serviço informaram). */
  pauseNewTasks?: boolean;
  onReconnect?(): void;
  onRefreshService?(): Promise<void>;
  onServicePause?(paused: boolean): void;
  onServiceAutostart?(enabled: boolean): Promise<void>;
  onServiceOpenLogs?(): void;
  onServiceShutdown?(): void;
}

export function AiSettingsPanel(props: AiSettingsPanelProps) {
  const { providers, draft } = props;
  const problems = aiSettingsProblems(providers, draft);

  return (
    <div className="hq-ai">
      {props.connection && (
        <ServiceCard
          connection={props.connection}
          lastSnapshotAt={props.lastSnapshotAt ?? null}
          serverInfo={props.serverInfo ?? null}
          service={props.service ?? null}
          pauseNewTasks={props.pauseNewTasks ?? false}
          onReconnect={props.onReconnect}
          onRefreshService={props.onRefreshService}
          onPause={props.onServicePause}
          onAutostart={props.onServiceAutostart}
          onOpenLogs={props.onServiceOpenLogs}
          onShutdown={props.onServiceShutdown}
        />
      )}
      {!providers && (
        <div className="hq-notice hq-notice--info">estado dos provedores ainda não carregado. As preferências abaixo ficam guardadas, mas sem catálogo os modelos e níveis não puderam ser verificados.</div>
      )}
      {PROVIDER_ORDER.map(id => {
        const status = providers?.find(p => p.provider === id) ?? null;
        if (!status) {
          return (
            <section key={id} className="hq-ai-card hq-ai-card--empty" aria-label={`Provedor ${PROVIDER_LABELS[id]}`}>
              <header className="hq-ai-card__head"><div className="hq-ai-card__title"><h3>{PROVIDER_LABELS[id]}</h3></div><span className="hq-ai-auth hq-ai-auth--muted">não verificado</span></header>
              <p className="hq-dim">
                {providers ? 'o servidor não informou este provedor.' : 'aguardando o estado do servidor.'}
                {draft[id].model || draft[id].effort ? ` Preferência guardada: modelo ${draft[id].model ?? 'padrão'}, esforço ${draft[id].effort ?? 'padrão'}.` : ''}
              </p>
            </section>
          );
        }
        return (
          <ProviderCard
            key={id}
            status={status}
            prefs={draft[id]}
            onChange={prefs => props.onChange({ ...draft, [id]: prefs })}
            onRefresh={props.onRefresh}
            onTest={props.onTest}
            onLoginStart={props.onLoginStart}
            onLoginCancel={props.onLoginCancel}
            onOpenExternal={props.onOpenExternal}
          />
        );
      })}
      {problems.length > 0 && (
        <div className="hq-notice hq-notice--error" role="alert">
          <div>{problems.map(p => <div key={p}>{p}</div>)}</div>
        </div>
      )}
      <p className="hq-ai__footer">
        Precedência: participante na reunião &gt; funcionário &gt; padrão global &gt; padrão do provedor. Alterações valem a partir do próximo turno.
      </p>
    </div>
  );
}
