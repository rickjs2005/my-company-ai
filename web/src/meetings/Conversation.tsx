// Conversa da reunião: falas em ordem, avisos discretos, turnos com falha na linha do tempo (com "Tentar de novo")
// e o texto parcial do turno em andamento. Markdown renderizado como no chat (marked + DOMPurify).
import { useEffect, useMemo, useRef } from 'react';
import type { MeetingMessage, MeetingParticipant, MeetingTurn } from '@milweb-hq/protocol';
import { Markdown } from '../panel/ChatView';
import { IconAlert, IconInfo, IconRefresh } from '../panel/icons';
import type { ConversationProps } from './types';
import { TURN_STATUS_LABELS, configChip, formatMeetingTime, participantInitial, providerRouteLabel, turnPhaseLabel } from './helpers';

type Entry =
  | { key: string; at: number; kind: 'message'; message: MeetingMessage }
  | { key: string; at: number; kind: 'failed'; turn: MeetingTurn }
  | { key: string; at: number; kind: 'live'; turn: MeetingTurn; order: number[] };

function buildTimeline(messages: MeetingMessage[], turns: MeetingTurn[]): Entry[] {
  const withMessage = new Set(messages.map(m => m.turnId).filter(Boolean));
  const out: Entry[] = messages.map(m => ({ key: `m:${m.id}`, at: m.ts, kind: 'message', message: m }));
  for (const t of turns) {
    if ((t.status === 'failed' || t.status === 'lost') && !withMessage.has(t.id) && !t.messageId) out.push({ key: `t:${t.id}`, at: t.finishedAt ?? t.startedAt ?? t.createdAt, kind: 'failed', turn: t });
    if (t.status === 'running' || t.status === 'queued') out.push({ key: `t:${t.id}`, at: Number.MAX_SAFE_INTEGER, kind: 'live', turn: t, order: [t.status === 'running' ? 0 : 1, t.order, t.createdAt] }); // ordem real da fila: a mesma do servidor ("Tentar de novo" vai para o fim)
  }
  return out.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.kind === 'live' && b.kind === 'live') for (let i = 0; i < a.order.length; i++) if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
    return a.key.localeCompare(b.key);
  });
}

function AuthorMeta({ p, name, provider, ts, children }: { p: MeetingParticipant | null; name: string; provider: MeetingMessage['provider']; ts: number | null; children?: React.ReactNode }) {
  const route = providerRouteLabel(provider ?? p?.provider ?? null);
  return (
    <div className="hq-meet-msg__meta">
      <span className={`hq-meet-avatar hq-meet-avatar--${p?.kind === 'chefe' ? 'chefe' : provider ?? p?.provider ?? 'ai'}`} aria-hidden="true">{p ? participantInitial(p) : name[0]?.toUpperCase() ?? '?'}</span>
      <strong>{name}</strong>
      {route && <span className="hq-dim">{route}</span>}
      {ts != null && <time className="hq-dim">{formatMeetingTime(ts)}</time>}
      {children}
    </div>
  );
}

export function Conversation({ meeting, history, streaming, onRetry }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(meeting.participants.map(p => [p.id, p])), [meeting.participants]);
  const entries = useMemo(() => (history ? buildTimeline(history.messages, history.turns) : []), [history]);
  const liveText = Object.values(streaming).join('').length;

  // Acompanha o fim da conversa quando chega fala nova ou texto parcial (só se já estava perto do fim).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (near) el.scrollTop = el.scrollHeight;
  }, [entries.length, liveText]);

  if (!history) return <div className="hq-meet-conv hq-empty hq-empty--tall"><p>Carregando o histórico da reunião…</p></div>;

  const targetsLabel = (m: MeetingMessage) => {
    if (!m.targets.length) return null;
    return m.targets.map(id => byId.get(id)?.name ?? 'participante removido').join(', ');
  };

  return (
    <div ref={scrollRef} className="hq-meet-conv" aria-live="polite">
      {entries.length === 0 && (
        <div className="hq-empty hq-empty--tall">
          <p>Nenhuma fala ainda.</p>
          <p className="hq-dim">{meeting.mode === 'debate' ? 'Clique em "Discutir a pauta" ou escreva abaixo para começar.' : 'Escreva abaixo: cada destinatário responde uma vez.'}</p>
        </div>
      )}
      {entries.map(e => {
        if (e.kind === 'message') {
          const m = e.message;
          const p = byId.get(m.participantId) ?? null;
          if (m.kind === 'notice') {
            return (
              <div key={e.key} className="hq-meet-notice">
                <IconInfo size={13} /> <span>{m.text}</span> <time className="hq-dim">{formatMeetingTime(m.ts)}</time>
              </div>
            );
          }
          const chip = configChip(m.config);
          const to = targetsLabel(m);
          return (
            <article key={e.key} className={`hq-meet-msg hq-meet-msg--${m.kind}${m.partial ? ' hq-meet-msg--partial' : ''}`}>
              <AuthorMeta p={p} name={m.authorName} provider={m.provider} ts={m.ts}>
                {meeting.mode === 'debate' && m.round != null && m.phase && <span className="hq-tag hq-tag--xs">rodada {m.round} · {turnPhaseLabel(m.phase)}</span>}
                {meeting.mode !== 'debate' && m.phase && m.phase !== 'reply' && <span className="hq-tag hq-tag--xs">{turnPhaseLabel(m.phase)}</span>}
                {chip && <span className="hq-chip" title="Configuração usada neste turno">{chip}</span>}
                {to && <span className="hq-dim">para {to}</span>}
                {m.partial && <span className="hq-tag hq-tag--xs hq-tag--warn">parcial (interrompida)</span>}
              </AuthorMeta>
              <div className={`hq-meet-bubble hq-meet-bubble--${m.kind}`}>
                {m.kind === 'chefe' ? <div className="hq-meet-bubble__plain">{m.text}</div> : <Markdown text={m.text} />}
              </div>
            </article>
          );
        }
        if (e.kind === 'failed') {
          const t = e.turn;
          const p = byId.get(t.participantId) ?? null;
          return (
            <article key={e.key} className="hq-meet-msg hq-meet-msg--failed">
              <AuthorMeta p={p} name={p?.name ?? 'participante removido'} provider={p?.provider ?? null} ts={e.at}>
                <span className="hq-tag hq-tag--xs hq-tag--danger">{TURN_STATUS_LABELS[t.status]}</span>
                {meeting.mode === 'debate' && <span className="hq-tag hq-tag--xs">rodada {t.round} · {turnPhaseLabel(t.phase)}</span>}
              </AuthorMeta>
              <div className="hq-meet-bubble hq-meet-bubble--failed">
                <IconAlert size={14} />
                <span>{t.error || (t.status === 'lost' ? 'O processo sumiu sem resposta.' : 'O turno falhou sem detalhe.')}</span>
                {meeting.status !== 'ended' && (
                  <button type="button" className="hq-btn hq-btn--sm" onClick={() => onRetry(t.id)}><IconRefresh size={12} /> Tentar de novo</button>
                )}
              </div>
            </article>
          );
        }
        const t = e.turn;
        const p = byId.get(t.participantId) ?? null;
        const text = streaming[t.id] ?? '';
        if (t.status === 'queued') {
          return (
            <div key={e.key} className="hq-meet-notice hq-meet-notice--queued">
              <span className="hq-status-dot" style={{ background: 'var(--info)' }} /> {p?.name ?? 'participante'} · na fila{meeting.mode === 'debate' ? ` · rodada ${t.round} · ${turnPhaseLabel(t.phase)}` : ''}
            </div>
          );
        }
        return (
          <article key={e.key} className="hq-meet-msg hq-meet-msg--speech hq-meet-msg--live">
            <AuthorMeta p={p} name={p?.name ?? 'participante'} provider={p?.provider ?? null} ts={null}>
              <span className="hq-meet-typing" aria-label="respondendo"><span /><span /><span /></span>
              <span className="hq-dim">respondendo…</span>
              {meeting.mode === 'debate' && <span className="hq-tag hq-tag--xs">rodada {t.round} · {turnPhaseLabel(t.phase)}</span>}
              {t.applied && <span className="hq-chip">{configChip(t.applied)}</span>}
            </AuthorMeta>
            <div className="hq-meet-bubble hq-meet-bubble--speech hq-meet-bubble--live">
              {text ? <Markdown text={text} /> : <span className="hq-dim">aguardando o primeiro trecho…</span>}
              <span className="hq-cursor" aria-hidden="true" />
            </div>
          </article>
        );
      })}
    </div>
  );
}
