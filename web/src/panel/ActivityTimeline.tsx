// Aba Atividade: o que está acontecendo agora e o registro fiel dos eventos, agrupado por tarefa.
import { useEffect, useState } from 'react';
import type { LogKind } from './helpers';
import type { ActivityTimelineProps, TimelineEntry } from './types';
import { currentTurnStart, formatDuration, formatTime, groupTimeline, LOG_KIND_LABELS, phaseColor, phaseLabel, processStateLabel } from './helpers';
import {
  IconAlert, IconBolt, IconCheck, IconClock, IconDelegate, IconExec, IconFlag, IconInfo, IconQuestion, IconRead, IconShield, IconStop, IconTool, IconUser, IconWrite,
} from './icons';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

function KindIcon({ kind, name }: { kind: LogKind; name?: string }) {
  switch (kind) {
    case 'prompt': return <IconUser size={13} />;
    case 'text': return <IconWrite size={13} />;
    case 'tool_start':
    case 'tool_end':
      if (name === 'Bash' || name === 'PowerShell') return <IconExec size={13} />;
      if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return <IconWrite size={13} />;
      if (name === 'Read' || name === 'Grep' || name === 'Glob') return <IconRead size={13} />;
      return <IconTool size={13} />;
    case 'permission':
    case 'permission_decision': return <IconShield size={13} />;
    case 'question': return <IconQuestion size={13} />;
    case 'task_start':
    case 'task_end': return <IconDelegate size={13} />;
    case 'result': return <IconFlag size={13} />;
    case 'error': return <IconAlert size={13} />;
    case 'interrupt': return <IconStop size={13} />;
    case 'rate_limit': return <IconBolt size={13} />;
    case 'compact': return <IconClock size={13} />;
    default: return <IconInfo size={13} />;
  }
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function Entry({ e }: { e: TimelineEntry }) {
  const { entry } = e;
  const name = typeof entry.data?.name === 'string' ? entry.data.name : undefined;
  const highlighted = entry.kind === 'interrupt' || entry.kind === 'rate_limit';
  const bad = entry.ok === false || entry.kind === 'error';
  return (
    <li className={cx('hq-tl__item', highlighted && 'hq-tl__item--hl', bad && 'hq-tl__item--bad', entry.ok === true && 'hq-tl__item--ok')}>
      <span className="hq-tl__icon" title={LOG_KIND_LABELS[entry.kind] ?? entry.kind}><KindIcon kind={entry.kind} name={name} /></span>
      <span className="hq-tl__text">{entry.summary}</span>
      {entry.ok === true && <IconCheck size={12} className="hq-tl__ok" />}
      {bad && <IconAlert size={12} className="hq-tl__bad" />}
      <time className="hq-tl__time">{formatTime(entry.ts)}</time>
    </li>
  );
}

export function ActivityTimeline({ entries, activity, processState }: ActivityTimelineProps) {
  const turnActive = Boolean(activity?.turnActive);
  const now = useNow(turnActive);
  const turnStart = currentTurnStart(entries);
  const elapsed = turnActive && turnStart != null && turnStart > 1e9 ? formatDuration(now - turnStart) : null;
  const tool = activity?.activeTools[activity.activeTools.length - 1];
  const toolElapsed = tool && tool.startedAt > 1e9 ? formatDuration(now - tool.startedAt) : null;
  const groups = groupTimeline(entries);
  const phase = activity?.phase ?? null;

  return (
    <div className="hq-timeline">
      <section className="hq-now" aria-label="Estado atual">
        <div className="hq-now__row">
          <span className="hq-now__dot" style={{ background: phaseColor(phase) }} />
          <span className="hq-now__label">agora</span>
          <span className="hq-now__phase" style={{ color: phaseColor(phase) }}>{phaseLabel(phase)}</span>
          {elapsed && <span className="hq-now__elapsed" title="Tempo desde o pedido"><IconClock size={12} /> {elapsed}</span>}
        </div>
        <div className="hq-now__detail">{activity?.detail ?? 'Nenhuma sessão selecionada'}</div>
        <div className="hq-now__meta">
          <span>Processo: {processStateLabel(processState)}</span>
          {tool && <span>Ferramenta: {tool.name}{toolElapsed ? ` (${toolElapsed})` : ''}</span>}
          {activity && activity.activeTasks.length > 0 && <span>{activity.activeTasks.length} tarefa(s) em andamento</span>}
          {activity?.rateLimit && activity.rateLimit.status && activity.rateLimit.status !== 'allowed' && (
            <span className="hq-tag hq-tag--danger">Limite de uso: {activity.rateLimit.status}</span>
          )}
        </div>
      </section>

      {groups.length === 0 ? (
        <div className="hq-empty">Nenhum evento registrado ainda.</div>
      ) : (
        <div className="hq-tl">
          {groups.map((g, gi) => (
            <section key={`${g.taskId ?? 'none'}-${gi}`} className="hq-tl__group">
              <h4 className="hq-tl__head">
                {g.taskId ? <>Tarefa <code className="hq-mono">{g.taskId.slice(0, 8)}</code></> : 'Sem tarefa'}
                <span className="hq-dim"> · {g.entries.length} evento(s)</span>
              </h4>
              <ul className="hq-tl__list">
                {g.entries.map(e => <Entry key={e.seq} e={e} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
