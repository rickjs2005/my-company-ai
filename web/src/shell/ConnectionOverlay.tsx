// Cobertura do palco quando o serviço cai: a cena fica esmaecida com o último estado conhecido, nunca "viva".
import type { ConnectionState } from '../state/client';
import { formatClock } from '../panel/helpers';

export interface ConnectionOverlayProps {
  connection: ConnectionState;
  lastSnapshotAt: number | null;
  onReconnect(): void;
}

export function ConnectionOverlay({ connection, lastSnapshotAt, onReconnect }: ConnectionOverlayProps) {
  if (connection === 'open') return null;
  const connecting = connection === 'connecting';
  return (
    <div className="hq-offline" role="alert" aria-live="assertive">
      <div className="hq-offline__card">
        <p className="hq-offline__title">{connecting ? 'Conectando ao serviço local…' : 'Serviço desconectado'}</p>
        {lastSnapshotAt ? <p className="hq-dim">Mostrando o último estado conhecido, das {formatClock(lastSnapshotAt)}. Nenhum funcionário está sendo controlado até reconectar.</p> : <p className="hq-dim">Ainda não recebi nenhum estado do serviço.</p>}
        {!connecting && (
          <>
            <p className="hq-dim">A reconexão é automática. Se a janela do <code>start-hq.cmd</code> foi fechada, abra o atalho de novo: as conversas ficam retomáveis.</p>
            <button type="button" className="hq-btn hq-btn--primary" onClick={onReconnect}>Reconectar agora</button>
          </>
        )}
      </div>
    </div>
  );
}
