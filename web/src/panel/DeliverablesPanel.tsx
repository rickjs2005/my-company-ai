// Aba Entregas: tarefas (mais recente primeiro), suas entregas reais e o preview embutido.
import { useEffect, useState } from 'react';
import type { Deliverable, Task } from '@milweb-hq/protocol';
import type { DeliverablesPanelProps, PreviewPaneProps } from './types';
import { basename, formatCost, formatDuration, formatTime, stepsLabel, taskStateLabel, truncate } from './helpers';
import { taskConfigLines } from '../shell/composerHelpers';
import { IconCheck, IconCopy, IconExternal, IconEye, IconFile, IconRefresh } from './icons';

/** Texto curto para a confirmação observada da skill (nunca presume ativação). */
const SKILL_CONFIRMATION: Record<string, string> = {
  pending: 'ativação ainda não confirmada',
  listed: 'confirmada pelo Claude Code',
  not_listed: 'NÃO apareceu na lista do Claude Code (pode ter virado texto comum)',
  unknown: 'entregue como texto (sem confirmação possível)',
};

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

const STATUS_CLS: Partial<Record<Task['status'], string>> = {
  running: 'hq-tag--info', queued: '', waiting_permission: 'hq-tag--warn', waiting_answer: 'hq-tag--warn',
  done: 'hq-tag--ok', error: 'hq-tag--danger', interrupted: 'hq-tag--warn', lost: 'hq-tag--danger',
};

const CHANGE_LABELS: Record<NonNullable<Deliverable['changeType']>, string> = { created: 'criado', modified: 'modificado', deleted: 'removido', unknown: '' };

export function PreviewPane({ url, onOpenTab }: PreviewPaneProps) {
  if (!url) return <div className="hq-preview hq-preview--empty">Nenhum preview definido. Informe a URL acima e clique em Verificar.</div>;
  return (
    <div className="hq-preview">
      <div className="hq-preview__bar">
        <span className="hq-mono hq-preview__url" title={url}>{url}</span>
        <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenTab(url)} title="Alguns sites bloqueiam a exibição dentro de iframe"><IconExternal size={12} /> Abrir em nova aba</button>
      </div>
      <iframe key={url} className="hq-preview__frame" src={url} title={`Preview de ${url}`} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
      <div className="hq-preview__hint">Se a área ficar em branco, o site pode estar bloqueando iframes; use "Abrir em nova aba".</div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); window.setTimeout(() => setDone(false), 1500); } catch { /* sem clipboard: nada a fazer */ }
  };
  return (
    <button type="button" className="hq-btn hq-btn--sm" onClick={copy} aria-label="Copiar texto">
      {done ? <IconCheck size={12} /> : <IconCopy size={12} />} {done ? 'Copiado' : 'Copiar'}
    </button>
  );
}

function DeliverableRow({ d, onOpenExternal, onPreview }: { d: Deliverable; onOpenExternal: DeliverablesPanelProps['onOpenExternal']; onPreview(url: string): void }) {
  const change = d.changeType ? CHANGE_LABELS[d.changeType] : '';
  if (d.kind === 'file' && d.path) {
    return (
      <li className="hq-deliv">
        <IconFile size={13} />
        <span className="hq-deliv__title" title={d.path}>{d.title || basename(d.path)}</span>
        {change && <span className="hq-tag hq-tag--xs">{change}</span>}
        <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenExternal('file', d.path!)}><IconExternal size={12} /> Abrir</button>
      </li>
    );
  }
  if (d.kind === 'url' && d.url) {
    return (
      <li className="hq-deliv">
        <IconExternal size={13} />
        <span className="hq-deliv__title hq-mono" title={d.url}>{d.title || d.url}</span>
        <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenExternal('url', d.url!)}><IconExternal size={12} /> Abrir</button>
        <button type="button" className="hq-btn hq-btn--sm" onClick={() => onPreview(d.url!)}><IconEye size={12} /> Ver no preview</button>
      </li>
    );
  }
  return (
    <li className="hq-deliv hq-deliv--text">
      <div className="hq-deliv__head">
        <span className="hq-deliv__title">{d.title || 'Texto'}</span>
        <CopyButton text={d.text ?? ''} />
      </div>
      <pre className="hq-mono hq-pre">{d.text ?? ''}</pre>
    </li>
  );
}

interface TaskCardProps {
  task: Task;
  employeeName: string | null;
  onOpenExternal: DeliverablesPanelProps['onOpenExternal'];
  onPreview(url: string): void;
  onRetry?: DeliverablesPanelProps['onRetry'];
  onMarkVerified?: DeliverablesPanelProps['onMarkVerified'];
  onRelease?: DeliverablesPanelProps['onRelease'];
  onCancelQueued?: DeliverablesPanelProps['onCancelQueued'];
}

function TaskCard({ task, employeeName, onOpenExternal, onPreview, onRetry, onMarkVerified, onRelease, onCancelQueued }: TaskCardProps) {
  const [full, setFull] = useState(false);
  const long = task.prompt.length > 140;
  const meta = [task.durationMs != null ? formatDuration(task.durationMs) : '', stepsLabel(task.numTurns), formatCost(task.costUsd)].filter(Boolean);
  const toVerify = task.review === 'to_verify';
  const failed = task.status === 'lost' || task.status === 'error' || task.status === 'interrupted';
  const retryable = Boolean(onRetry) && failed && !toVerify;
  const queued = task.status === 'queued';
  const tagCls = toVerify || (queued && task.held) ? 'hq-tag--warn' : STATUS_CLS[task.status];
  return (
    <article className={cx('hq-task', `hq-task--${task.status}`, toVerify && 'hq-task--verify')}>
      <header className="hq-task__head">
        <span className={cx('hq-tag', tagCls)}>{taskStateLabel(task)}</span>
        {task.plan && <span className="hq-tag hq-tag--xs hq-tag--info" title="Pedido enviado em modo plano: sem alterar arquivos">plano</span>}
        {task.provider === 'openai' && <span className="hq-tag hq-tag--xs" title="Executada pelo OpenAI via Codex (modo análise)">OpenAI</span>}
        <time className="hq-dim">{formatTime(task.createdAt)}</time>
        {meta.length > 0 && <span className="hq-dim hq-task__meta">{meta.join(' · ')}</span>}
      </header>
      {(employeeName || task.heldReason) && (
        <div className="hq-task__who hq-dim">
          {employeeName && <span>Responsável: <strong>{employeeName}</strong></span>}
          {task.heldReason && <span className="hq-task__held">{task.heldReason}</span>}
        </div>
      )}
      <p className="hq-task__prompt">
        {full || !long ? task.prompt : truncate(task.prompt, 140)}
        {long && <button type="button" className="hq-linkbtn" onClick={() => setFull(f => !f)}>{full ? 'menos' : 'mais'}</button>}
      </p>
      {task.skill && (
        <div className={cx('hq-task__skill', task.skill.confirmation === 'not_listed' && 'hq-task__skill--bad')} title={task.skill.evidence ?? ''}>
          Skill pedida: <span className="hq-mono">/{task.skill.requested}</span>
          {' · '}{task.skill.delivery === 'inject' ? 'entregue por texto' : 'invocação nativa'}
          {' · '}{SKILL_CONFIRMATION[task.skill.confirmation] ?? task.skill.confirmation}
        </div>
      )}
      {task.applied && (
        <div className="hq-task__applied" title={`Origem da configuração: ${task.applied.source}. Só é "confirmado" o que o Claude Code informa ao iniciar o processo.`}>
          {taskConfigLines(task).map(l => (
            <span key={l.item} className={cx('hq-cfgline', l.state === 'confirmado' ? 'hq-cfgline--ok' : l.state === 'padrão' ? 'hq-cfgline--dim' : 'hq-cfgline--warn')} title={l.detail}>
              {l.item}: <strong>{l.value}</strong> <em>({l.state})</em>
            </span>
          ))}
        </div>
      )}
      {task.contextFiles && task.contextFiles.length > 0 && (
        <div className="hq-task__ctx hq-dim">Contexto: {task.contextFiles.map(c => <span key={c} className="hq-mono hq-task__ctxfile">{c}</span>)}</div>
      )}
      {toVerify && (
        <div className="hq-notice hq-notice--warn">
          O processo caiu depois de a tarefa já ter alterado arquivos ou rodado comandos. Confira o resultado antes de reexecutar; nada foi presumido.
        </div>
      )}
      {task.resultText && <div className="hq-task__result">{truncate(task.resultText, 400)}</div>}
      {task.errors.length > 0 && <div className="hq-notice hq-notice--error">{task.errors[task.errors.length - 1]}</div>}
      {(toVerify || retryable || queued) && (
        <div className="hq-actions hq-task__actions">
          {toVerify && onMarkVerified && (
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => onMarkVerified(task.id)} title="Marca como conferida; depois dá para reexecutar">
              <IconCheck size={12} /> Marcar como conferida
            </button>
          )}
          {retryable && (
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => onRetry!(task.id)} title="Mesmo pedido, nova tentativa (a conversa é retomada)">
              <IconRefresh size={12} /> Reexecutar
            </button>
          )}
          {queued && task.held && onRelease && (
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => onRelease(task.id)} title="Autoriza a execução agora">Liberar</button>
          )}
          {queued && onCancelQueued && (
            <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => onCancelQueued(task.id)}>Tirar da fila</button>
          )}
        </div>
      )}
      {task.deliverables.length > 0 ? (
        <ul className="hq-deliv-list">
          {task.deliverables.map(d => <DeliverableRow key={d.id} d={d} onOpenExternal={onOpenExternal} onPreview={onPreview} />)}
        </ul>
      ) : (
        <div className="hq-dim hq-task__none">{task.status === 'done' ? 'Sem entregas registradas.' : 'Ainda sem entregas.'}</div>
      )}
      {task.touchedFiles.length > 0 && (
        <div className="hq-task__touched" title={task.touchedFiles.join('\n')}>{task.touchedFiles.length} arquivo(s) tocado(s)</div>
      )}
    </article>
  );
}

export function DeliverablesPanel(props: DeliverablesPanelProps) {
  const { tasks, project, previewUrl, onOpenExternal, onSetPreviewUrl, onCheckPreview, employees = [], onRetry, onMarkVerified, onRelease, onCancelQueued, onLocalPreview } = props;
  const [localErr, setLocalErr] = useState<string | null>(null);
  // Marco 1: prévia dos arquivos do projeto (site estático) num servidor da HQ em outra origem, só leitura.
  const openLocal = async () => {
    if (!onLocalPreview) return;
    setLocalErr(null);
    try { const r = await onLocalPreview(); if ('url' in r) { setUrl(r.url); onSetPreviewUrl(r.url); setCheck(null); } else setLocalErr(r.error); }
    catch (e) { setLocalErr(e instanceof Error ? e.message : String(e)); }
  };
  const nameOf = (id: string | null | undefined) => (id ? employees.find(e => e.id === id)?.name ?? null : null);
  const [url, setUrl] = useState(previewUrl ?? project?.previewUrl ?? '');
  const [check, setCheck] = useState<{ ok: boolean; status?: number; error?: string } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => { setUrl(previewUrl ?? project?.previewUrl ?? ''); setCheck(null); }, [previewUrl, project?.id, project?.previewUrl]);

  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt);

  const verify = async () => {
    const u = url.trim();
    if (!u) { onSetPreviewUrl(null); setCheck(null); return; }
    setChecking(true);
    try {
      const r = await onCheckPreview(u);
      setCheck(r);
      onSetPreviewUrl(u);
    } catch (e) {
      setCheck({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally { setChecking(false); }
  };

  const preview = (u: string) => { setUrl(u); onSetPreviewUrl(u); setCheck(null); };

  return (
    <div className="hq-deliveries">
      <section className="hq-previewbox" aria-label="Preview">
        <div className="hq-previewbox__row">
          <label className="sr-only" htmlFor="hq-preview-url">URL do preview</label>
          <input
            id="hq-preview-url" className="hq-input hq-mono" placeholder="http://127.0.0.1:3000" value={url}
            onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void verify(); }}
          />
          <button type="button" className="hq-btn" onClick={() => void verify()} disabled={checking}>
            <IconRefresh size={12} /> {checking ? 'Verificando…' : 'Verificar'}
          </button>
          {url.trim() && <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenExternal('url', url.trim())}><IconExternal size={12} /> Abrir em nova aba</button>}
          {onLocalPreview && project && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => void openLocal()} title="Abre os arquivos do projeto (index.html) numa prévia da HQ, só leitura, em outra origem">Prévia local do projeto</button>}
        </div>
        {localErr && <div className="hq-notice hq-notice--warn" role="status">{localErr}</div>}
        {check && (
          <div className={cx('hq-notice', check.ok ? 'hq-notice--ok' : 'hq-notice--warn')} role="status">
            {check.ok ? `Respondeu${check.status ? ` com HTTP ${check.status}` : ''}.` : `Não respondeu${check.status ? ` (HTTP ${check.status})` : ''}${check.error ? `: ${check.error}` : '.'}`}
          </div>
        )}
        <PreviewPane url={previewUrl} onOpenTab={u => onOpenExternal('url', u)} />
      </section>

      <section className="hq-tasks" aria-label="Tarefas e entregas">
        {sorted.length === 0 && <div className="hq-empty">Nenhuma tarefa nesta sessão ainda.</div>}
        {sorted.map(t => (
          <TaskCard
            key={t.id} task={t} employeeName={nameOf(t.employeeId)} onOpenExternal={onOpenExternal} onPreview={preview}
            onRetry={onRetry} onMarkVerified={onMarkVerified} onRelease={onRelease} onCancelQueued={onCancelQueued}
          />
        ))}
      </section>
    </div>
  );
}
