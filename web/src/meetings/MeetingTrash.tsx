// Lixeira de reuniões (Marco 0): reunião excluída fica 30 dias com falas, quadro, contexto e ata, e volta com "Restaurar".
// A lista vem do servidor (meeting.trash) quando a seção é aberta; restaurar devolve a reunião à lista e a seleciona.
import { useCallback, useEffect, useState } from 'react';
import type { Meeting } from '@milweb-hq/protocol';
import type { MeetingDispatch } from './types';
import { formatMeetingTime } from './helpers';

export function MeetingTrash({ dispatch, onRestored, refreshKey }: { dispatch: MeetingDispatch; onRestored(id: string): void; refreshKey: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Meeting[] | null>(null);
  const [keepDays, setKeepDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await dispatch({ type: 'meeting.trash', reqId: '' }) as { meetings: Meeting[]; keepDays: number };
      setItems(r.meetings); setKeepDays(r.keepDays); setError(null);
    } catch (err) { setError((err as Error).message); }
  }, [dispatch]);
  // Contagem sempre visível (o rótulo diz quantas há); recarrega quando a lista de reuniões muda (excluiu/restaurou).
  useEffect(() => { void load(); }, [load, refreshKey]);

  const restore = async (id: string) => {
    setBusy(id);
    try { await dispatch({ type: 'meeting.restore', reqId: '', id }); await load(); onRestored(id); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  };

  const n = items?.length ?? 0;
  return (
    <div className="hq-meet-trash">
      <button type="button" className="hq-linkbtn hq-meet-trash__toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? '▾' : '▸'} Lixeira de reuniões{items ? ` (${n})` : ''}
      </button>
      {open && (
        <div className="hq-meet-trash__body">
          {error && <p className="hq-meet-trash__err" role="alert">{error}</p>}
          {items && n === 0 && <p className="hq-dim">Vazia. Reunião excluída fica aqui por {keepDays} dias.</p>}
          {items && n > 0 && (
            <ul className="hq-meet-trash__list">
              {items.map(m => {
                const goneAt = (m.deletedAt ?? 0) + keepDays * 86_400_000;
                return (
                  <li key={m.id} className="hq-meet-trash__item">
                    <span className="hq-meet-trash__text">
                      <strong>{m.title || 'Sem título'}</strong>
                      <span className="hq-dim">excluída {formatMeetingTime(m.deletedAt ?? 0)} · some em {new Date(goneAt).toLocaleDateString('pt-BR')}</span>
                    </span>
                    <button type="button" className="hq-btn hq-btn--sm" disabled={busy === m.id} onClick={() => void restore(m.id)}>{busy === m.id ? 'Restaurando…' : 'Restaurar'}</button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
