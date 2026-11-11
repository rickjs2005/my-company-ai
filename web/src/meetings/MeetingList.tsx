// Coluna esquerda: lista de reuniões com status real, projeto, participantes por ícone e data da última mudança.
import { useMemo } from 'react';
import type { MeetingParticipant } from '@milweb-hq/protocol';
import { IconPlus } from '../panel/icons';
import type { MeetingListProps } from './types';
import { formatMeetingTime, meetingStatusColor, meetingStatusLabel, participantInitial, providerRouteLabel } from './helpers';

export function ParticipantIcons({ participants, size = 'sm' }: { participants: MeetingParticipant[]; size?: 'sm' | 'md' }) {
  const sorted = [...participants].sort((a, b) => a.order - b.order);
  return (
    <span className={`hq-meet-avatars hq-meet-avatars--${size}`} aria-label={sorted.map(p => p.name).join(', ')}>
      {sorted.map(p => (
        <span
          key={p.id}
          className={`hq-meet-avatar hq-meet-avatar--${p.kind === 'chefe' ? 'chefe' : p.provider ?? 'ai'}`}
          title={`${p.name}${p.provider ? ` · ${providerRouteLabel(p.provider)}` : ''}`}
        >
          {participantInitial(p)}
        </span>
      ))}
    </span>
  );
}

export function MeetingList({ meetings, selectedId, projects, onSelect, onNew, footer }: MeetingListProps) {
  const projectById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const sorted = useMemo(() => [...meetings].sort((a, b) => {
    const live = (m: typeof a) => (m.status === 'active' ? 0 : m.status === 'paused' ? 1 : m.status === 'draft' ? 2 : 3);
    return live(a) - live(b) || b.updatedAt - a.updatedAt;
  }), [meetings]);

  return (
    <aside className="hq-meet-list" aria-label="Reuniões">
      <header className="hq-meet-list__head">
        <h2>Reuniões</h2>
        <span className="hq-dim">{meetings.length}</span>
        <span className="hq-view__spacer" />
        <button type="button" className="hq-btn hq-btn--primary hq-btn--sm" onClick={onNew}><IconPlus size={12} /> Nova reunião</button>
      </header>
      {sorted.length === 0 ? (
        <div className="hq-empty">
          <p>Nenhuma reunião ainda.</p>
          <p className="hq-dim">Crie a primeira: escolha a pauta e quem senta à mesa (Claude, ChatGPT ou os dois).</p>
        </div>
      ) : (
        <ul className="hq-meet-list__items">
          {sorted.map(m => {
            const project = m.projectId ? projectById.get(m.projectId) : null;
            const sel = m.id === selectedId;
            return (
              <li key={m.id}>
                <button type="button" className={`hq-meet-item${sel ? ' hq-meet-item--sel' : ''}`} onClick={() => onSelect(m.id)} aria-current={sel ? 'true' : undefined}>
                  <span className="hq-meet-item__top">
                    <span className="hq-meet-item__title">{m.title || 'Sem título'}</span>
                    <span className="hq-meet-status" style={{ ['--st' as string]: meetingStatusColor(m.status) }}>{meetingStatusLabel(m.status)}</span>
                  </span>
                  <span className="hq-meet-item__meta">
                    <ParticipantIcons participants={m.participants} />
                    <span className="hq-dim hq-meet-item__project">{project ? project.name : m.projectId ? 'projeto removido' : 'sem projeto'}</span>
                    <span className="hq-dim hq-meet-item__time">{formatMeetingTime(m.updatedAt)}</span>
                  </span>
                  {m.activeTurnId && <span className="hq-meet-item__live"><span className="hq-pulse" /> turno em andamento</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {footer}
    </aside>
  );
}
