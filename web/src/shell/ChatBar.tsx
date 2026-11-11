// Barra de chat inferior, sempre acessível: "Conversar com <funcionário> ▾" + campo de texto.
// Enviar aqui = o mesmo prompt.send do painel (mesma conversa ativa do funcionário). Sem conversa ativa, pede para abrir uma.
import { useEffect, useRef, useState } from 'react';
import type { Employee, Session, Worker } from '@milweb-hq/protocol';
import { workerStatusColor, workerStatusLabel } from '../panel/helpers';
import { IconSend } from '../panel/icons';

export interface ChatBarProps {
  employees: Employee[];
  workers: Worker[];
  sessions: Session[];
  /** Funcionário em foco (o mesmo do painel). */
  employeeId: string | null;
  connected: boolean;
  disabledReason: string | null;
  busy: boolean;
  onPickEmployee(id: string): void;
  onSend(text: string, mode: 'send' | 'queue'): void;
  onOpenPanel(): void;
  onNewConversation(employeeId: string): void;
}

export function ChatBar(props: ChatBarProps) {
  const { employees, workers, sessions, employeeId, connected, disabledReason, busy } = props;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = employees.filter(e => !e.archivedAt);
  const employee = active.find(e => e.id === employeeId) ?? null;
  const worker = employee ? workers.find(w => w.id === employee.id) ?? null : null;
  const session = employee?.activeSessionId ? sessions.find(s => s.id === employee.activeSessionId) ?? null : null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const reason = !connected ? 'Sem conexão com o serviço' : !employee ? 'Escolha um funcionário' : !session ? `${employee.name} não tem conversa aberta` : disabledReason;
  const disabled = Boolean(reason);

  const submit = (mode: 'send' | 'queue') => {
    const t = text.trim();
    if (!t || disabled) return;
    props.onSend(t, mode);
    setText('');
  };

  return (
    <div className="hq-chatbar" role="region" aria-label="Conversar com um funcionário">
      <div className="hq-chatbar__who" ref={menuRef}>
        <button type="button" className="hq-chatbar__pick" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open} title="Escolher com quem conversar">
          {employee ? <><span className="hq-status-dot" style={{ background: workerStatusColor(worker?.status) }} /> Conversar com <strong>{employee.name}</strong></> : <span>Conversar com…</span>}
          <span className="hq-chatbar__caret" aria-hidden="true">▾</span>
        </button>
        {open && (
          <ul className="hq-menu hq-menu--up" role="listbox" aria-label="Funcionários">
            {active.length === 0 && <li className="hq-menu__empty">Nenhum funcionário. Contrate um em “+ Funcionário”.</li>}
            {active.map(e => {
              const w = workers.find(x => x.id === e.id);
              return (
                <li key={e.id} role="option" aria-selected={e.id === employeeId}>
                  <button type="button" className={`hq-menu__item${e.id === employeeId ? ' hq-menu__item--on' : ''}`} onClick={() => { props.onPickEmployee(e.id); setOpen(false); }}>
                    <span className="hq-status-dot" style={{ background: workerStatusColor(w?.status) }} />
                    <span className="hq-menu__text"><strong>{e.name}</strong> <span className="hq-dim">· {e.role}</span><span className="hq-dim hq-menu__sub">{workerStatusLabel(w?.status)}{w?.detail && w.status !== 'idle' ? ` · ${w.detail}` : ''}</span></span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <input
        className="hq-chatbar__input" value={text} disabled={disabled} onChange={e => setText(e.target.value)}
        placeholder={reason ?? (busy ? `${employee?.name} está ocupado: Enter enfileira` : `Pedido para ${employee?.name} (Enter envia)`)}
        aria-label="Mensagem rápida" onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit(busy ? 'queue' : 'send'); } }}
      />
      {employee && !session && connected && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => props.onNewConversation(employee.id)}>Abrir conversa</button>}
      {employee && session && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={disabled || !text.trim()} onClick={() => submit(busy ? 'queue' : 'send')} aria-label={busy ? 'Enfileirar' : 'Enviar'}><IconSend size={13} /> {busy ? 'Enfileirar' : 'Enviar'}</button>}
      <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={props.onOpenPanel} disabled={!employee} title="Abrir o painel completo (chat, atividade, arquivos, entregas)">Painel</button>
    </div>
  );
}
