// Cartão "Serviço da HQ" da aba Conexões: a conexão desta aba com o processo local, fatos do serviço (versão, pid, porta,
// pasta de dados, log, modo de início, máquina) e ações reais: iniciar com o Windows, pausar novas tarefas, abrir logs,
// atualizar e encerrar. Nada aqui presume: sem `service` os fatos ficam "—" e os controles desligados. Estar conectado
// à HQ não quer dizer que os provedores estão prontos — isso é assunto dos cartões seguintes.
import { useState } from 'react';
import type { ServerInfo, ServiceStatus } from '@milweb-hq/protocol';
import {
  CONNECTION_TONES, batteryLabel, formatCatalogAt, formatUptime, launchModeLabel, networkLabel, serviceConnectionLabel,
  type ServiceConnection,
} from './helpers';

export interface ServiceCardProps {
  connection: ServiceConnection;
  /** Momento do último snapshot completo recebido (null = nenhum ainda). */
  lastSnapshotAt: number | null;
  /** Dados informados na conexão (fallback de versão e pasta de dados enquanto service.status não chegou). */
  serverInfo: ServerInfo | null;
  /** Resposta de service.status; null = ainda não carregado. */
  service: ServiceStatus | null;
  /** Pausa de novas tarefas em vigor (Settings.pauseNewTasks ou service.pauseNewTasks). */
  pauseNewTasks: boolean;
  onReconnect?(): void;
  onRefreshService?(): Promise<void>;
  onPause?(paused: boolean): void;
  onAutostart?(enabled: boolean): Promise<void>;
  onOpenLogs?(): void;
  onShutdown?(): void;
}

const UNAVAILABLE_TITLE = 'indisponível nesta versão do serviço';
const SHUTDOWN_CONFIRM =
  'Encerrar o serviço do My Company AI?\n\n' +
  'Os processos do Claude Code e do Codex abertos pela HQ são fechados de forma ordenada. ' +
  'As conversas ficam salvas e podem ser retomadas quando o serviço voltar. Esta aba vai perder a conexão.';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ServiceCard(props: ServiceCardProps) {
  const { connection, lastSnapshotAt, serverInfo, service, pauseNewTasks } = props;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);

  const tone = CONNECTION_TONES[connection];
  const version = service?.version ?? serverInfo?.version ?? null;
  const dataDir = service?.dataDir ?? serverInfo?.dataDir ?? null;
  const startedAt = service?.startedAt ?? serverInfo?.startedAt ?? null;
  const autostart = service?.autostart ?? null;
  const autostartEnabled = Boolean(service && autostart?.supported && props.onAutostart) && !autostartBusy;

  const refresh = async () => {
    if (!props.onRefreshService || refreshing) return;
    setRefreshing(true); setRefreshError(null);
    try { await props.onRefreshService(); }
    catch (err) { setRefreshError(errorText(err)); }
    finally { setRefreshing(false); }
  };

  const toggleAutostart = async (enabled: boolean) => {
    if (!props.onAutostart || autostartBusy) return;
    setAutostartBusy(true); setAutostartError(null);
    try { await props.onAutostart(enabled); }
    catch (err) { setAutostartError(errorText(err)); }
    finally { setAutostartBusy(false); }
  };

  const shutdown = () => {
    if (!props.onShutdown) return;
    if (window.confirm(SHUTDOWN_CONFIRM)) props.onShutdown();
  };

  return (
    <section className="hq-ai-card hq-svc" aria-label="Serviço da HQ">
      <header className="hq-ai-card__head">
        <div className="hq-ai-card__title">
          <h3>Serviço da HQ</h3>
          <span className="hq-ai-card__route">processo local que fala com o Claude Code e o Codex</span>
        </div>
        <span className={`hq-ai-auth hq-ai-auth--${tone}`} role="status">{serviceConnectionLabel(connection, lastSnapshotAt)}</span>
      </header>

      <p className="hq-svc__honest">Conectado à HQ não quer dizer que os provedores estão prontos: veja os cartões abaixo.</p>

      {connection === 'closed' && (
        <div className="hq-notice hq-notice--warn" role="status">
          <span>sem conexão com o serviço: os dados abaixo são os últimos recebidos.</span>
          {props.onReconnect && <button type="button" className="hq-btn hq-btn--sm" onClick={props.onReconnect}>Reconectar</button>}
        </div>
      )}
      {connection === 'unauthorized' && (
        <div className="hq-notice hq-notice--error" role="alert">o token desta aba não bate com o do serviço em execução; abra a HQ de novo pelo start-hq.cmd.</div>
      )}
      {!service && (
        <div className="hq-notice hq-notice--info" role="status">
          estado do serviço ainda não carregado{serverInfo ? ' — versão e pasta de dados vêm do que foi informado na conexão.' : '.'}
        </div>
      )}

      <dl className="hq-ai-facts hq-svc__facts">
        <dt>Versão</dt>
        <dd>{version ? <span className="hq-mono">{version}</span> : '—'}</dd>
        <dt>Processo</dt>
        <dd>
          {service ? <>pid <span className="hq-mono">{service.pid}</span> · porta <span className="hq-mono">{service.port}</span></> : <span className="hq-dim">pid e porta ainda não informados</span>}
          {startedAt != null && <> · iniciado em {formatCatalogAt(startedAt)}</>}
        </dd>
        <dt>Início</dt>
        <dd>{service ? launchModeLabel(service.launchMode) : <span className="hq-dim">—</span>}</dd>
        <dt>Dados</dt>
        <dd>{dataDir ? <span className="hq-mono hq-ai-path" title={dataDir}>{dataDir}</span> : '—'}</dd>
        <dt>Log</dt>
        <dd>{service ? <span className="hq-mono hq-ai-path" title={service.logFile}>{service.logFile}</span> : '—'}</dd>
        <dt>Máquina</dt>
        <dd>
          {service ? (
            <>
              <span className="hq-mono">{service.machine.hostname}</span> · ligada há {formatUptime(service.machine.uptimeSec)} · {batteryLabel(service.machine.onBattery)} · {networkLabel(service.machine.networkOnline)}
            </>
          ) : <span className="hq-dim">—</span>}
        </dd>
        {service?.providerHolds && service.providerHolds.length > 0 && (
          <>
            <dt>Fila</dt>
            <dd>{service.providerHolds.map(h => <div key={h.provider} className="hq-ai-danger">{h.reason}</div>)}</dd>
          </>
        )}
      </dl>

      <div className="hq-svc__controls">
        <label className="hq-check hq-svc__check" title={!service ? 'estado do serviço ainda não carregado' : autostart && !autostart.supported ? (autostart.detail ?? 'não suportado nesta máquina') : !props.onAutostart ? UNAVAILABLE_TITLE : undefined}>
          <input
            type="checkbox"
            checked={autostart?.registered === true}
            disabled={!autostartEnabled}
            onChange={e => void toggleAutostart(e.target.checked)}
          />
          <span>
            Iniciar com o Windows
            {autostartBusy && <> <span className="hq-spinner" aria-hidden="true" /></>}
            {autostart && (
              <span className="hq-dim hq-svc__check-hint">
                {!autostart.supported ? ' (não suportado nesta máquina)' : autostart.registered == null ? ' (registro não verificado)' : autostart.registered ? ` (tarefa "${autostart.taskName}" registrada)` : ' (não registrado)'}
              </span>
            )}
          </span>
        </label>
        {autostart?.detail && <div className="hq-svc__detail hq-dim">{autostart.detail}</div>}
        {autostartError && <div className="hq-ai-danger hq-svc__detail">não foi possível alterar o início com o Windows: {autostartError}</div>}

        <label className="hq-check hq-svc__check" title={!props.onPause ? UNAVAILABLE_TITLE : undefined}>
          <input type="checkbox" checked={pauseNewTasks} disabled={!props.onPause} onChange={e => props.onPause?.(e.target.checked)} />
          <span>Pausar novas tarefas <span className="hq-dim">— o que está rodando termina; a fila espera</span></span>
        </label>
      </div>

      <div className="hq-actions hq-ai-card__actions">
        <button type="button" className="hq-btn hq-btn--sm" onClick={props.onOpenLogs} disabled={!props.onOpenLogs} title={props.onOpenLogs ? undefined : UNAVAILABLE_TITLE}>Abrir logs</button>
        <button type="button" className="hq-btn hq-btn--sm" onClick={refresh} disabled={!props.onRefreshService || refreshing} title={props.onRefreshService ? undefined : UNAVAILABLE_TITLE}>
          {refreshing ? <span className="hq-spinner" aria-hidden="true" /> : null}
          {refreshing ? 'Atualizando…' : 'Atualizar'}
        </button>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--danger hq-svc__shutdown" onClick={shutdown} disabled={!props.onShutdown} title={props.onShutdown ? undefined : UNAVAILABLE_TITLE}>Encerrar HQ</button>
        {service && <span className="hq-dim hq-ai-card__hint">estado verificado em {formatCatalogAt(service.checkedAt)}</span>}
      </div>

      {refreshError && <div className="hq-notice hq-notice--error" role="alert">não foi possível atualizar o estado do serviço: {refreshError}</div>}
    </section>
  );
}
