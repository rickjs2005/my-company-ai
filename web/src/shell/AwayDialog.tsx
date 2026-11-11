// "Enquanto você esteve fora": resumo real do que aconteceu sem interface conectada (away.summary do servidor).
// Cada item leva ao lugar exato (conversa, arquivo). Nada aqui é estimado: só eventos registrados.
import type { AwaySummary } from '@milweb-hq/protocol';
import { Modal } from '../panel/dialogs/Modal';
import { basename, formatTime } from '../panel/helpers';
import { IconExternal, IconFile } from '../panel/icons';

export interface AwayDialogProps {
  open: boolean;
  summary: AwaySummary | null;
  onOpenSession(sessionId: string, taskId: string | null): void;
  onOpenFile(path: string): void;
  onClose(): void;
}

export function awaySummaryIsEmpty(s: AwaySummary): boolean {
  return s.done.length + s.failed.length + s.waiting.length + s.toVerify.length + s.queued.length + s.filesProduced.length + s.routinesRun.length === 0;
}

function period(s: AwaySummary): string {
  const since = new Date(s.since); const until = new Date(s.until);
  const sameDay = since.toDateString() === until.toDateString();
  const d = (x: Date) => x.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return sameDay ? `${d(since)}, ${formatTime(s.since)} → ${formatTime(s.until)}` : `${d(since)} ${formatTime(s.since)} → ${d(until)} ${formatTime(s.until)}`;
}

export function AwayDialog({ open, summary, onOpenSession, onOpenFile, onClose }: AwayDialogProps) {
  if (!summary) return null;
  const empty = awaySummaryIsEmpty(summary);
  const Section = ({ title, count, children }: { title: string; count: number; children: React.ReactNode }) => (count === 0 ? null : (
    <section className="hq-away__section">
      <h3 className="hq-away__title">{title} <span className="hq-tag hq-tag--xs">{count}</span></h3>
      <ul className="hq-away__list">{children}</ul>
    </section>
  ));
  return (
    <Modal open={open} title="Enquanto você esteve fora" onCancel={onClose} width={680}>
      <p className="hq-dim" style={{ marginTop: 0 }}>Período: {period(summary)}. Só eventos registrados pelo serviço; sem estimativas.</p>
      {empty && <div className="hq-empty">Nada aconteceu neste período: nenhuma tarefa terminou, falhou ou ficou esperando você.</div>}
      <Section title="Concluídas" count={summary.done.length}>
        {summary.done.map(t => (
          <li key={t.taskId} className="hq-away__item">
            <span className="hq-tag hq-tag--xs hq-tag--ok">feita</span>
            <span className="hq-away__text"><strong>{t.title}</strong><span className="hq-dim"> · {t.employee} · {t.project} · {formatTime(t.finishedAt)}{t.files ? ` · ${t.files} arquivo(s)` : ''}</span></span>
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenSession(t.sessionId, t.taskId)}>Abrir</button>
          </li>
        ))}
      </Section>
      <Section title="Esperando você" count={summary.waiting.length}>
        {summary.waiting.map((w, i) => (
          <li key={`${w.sessionId}-${i}`} className="hq-away__item">
            <span className="hq-tag hq-tag--xs hq-tag--warn">{w.kind === 'permission' ? 'permissão' : 'pergunta'}</span>
            <span className="hq-away__text"><strong>{w.summary}</strong><span className="hq-dim"> · {w.employee} · {w.project}</span></span>
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => onOpenSession(w.sessionId, w.taskId)}>Responder</button>
          </li>
        ))}
      </Section>
      <Section title="Resultado a conferir" count={summary.toVerify.length}>
        {summary.toVerify.map(t => (
          <li key={t.taskId} className="hq-away__item">
            <span className="hq-tag hq-tag--xs hq-tag--warn">conferir</span>
            <span className="hq-away__text"><strong>{t.title}</strong><span className="hq-dim"> · {t.employee} · {t.project} · {t.note}</span></span>
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenSession(t.sessionId, t.taskId)}>Abrir</button>
          </li>
        ))}
      </Section>
      <Section title="Falhas" count={summary.failed.length}>
        {summary.failed.map(t => (
          <li key={t.taskId} className="hq-away__item">
            <span className="hq-tag hq-tag--xs hq-tag--danger">{t.status}</span>
            <span className="hq-away__text"><strong>{t.title}</strong><span className="hq-dim"> · {t.employee} · {t.project}{t.error ? ` · ${t.error}` : ''}</span></span>
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenSession(t.sessionId, t.taskId)}>Abrir</button>
          </li>
        ))}
      </Section>
      <Section title="Próximo trabalho (na fila)" count={summary.queued.length}>
        {summary.queued.map(t => (
          <li key={t.taskId} className="hq-away__item">
            <span className={`hq-tag hq-tag--xs${t.held ? ' hq-tag--warn' : ''}`}>{t.held ? 'aguardando Chefe' : 'na fila'}</span>
            <span className="hq-away__text"><strong>{t.title}</strong><span className="hq-dim"> · {t.employee} · {t.project}{t.heldReason ? ` · ${t.heldReason}` : ''}</span></span>
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenSession(t.sessionId, t.taskId)}>Abrir</button>
          </li>
        ))}
      </Section>
      <Section title="Arquivos produzidos" count={summary.filesProduced.length}>
        {summary.filesProduced.map((f, i) => (
          <li key={`${f.path}-${i}`} className="hq-away__item">
            <IconFile size={13} />
            <span className="hq-away__text" title={f.path}><strong>{basename(f.path)}</strong><span className="hq-dim"> · {f.changeType} · {f.path}</span></span>
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenFile(f.path)}><IconExternal size={12} /> Abrir</button>
          </li>
        ))}
      </Section>
      <Section title="Rotinas executadas" count={summary.routinesRun.length}>
        {summary.routinesRun.map((r, i) => (
          <li key={`${r.taskId}-${i}`} className="hq-away__item">
            <span className="hq-tag hq-tag--xs">rotina</span>
            <span className="hq-away__text"><strong>{r.title}</strong><span className="hq-dim"> · {formatTime(r.at)}</span></span>
          </li>
        ))}
      </Section>
      <div className="hq-actions hq-actions--end"><button type="button" className="hq-btn hq-btn--primary" onClick={onClose}>Entendi</button></div>
    </Modal>
  );
}
