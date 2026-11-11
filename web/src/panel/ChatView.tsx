// Aba Chat: histórico da sessão, texto em andamento, cartões de ferramenta, permissão e pergunta.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, ChatItem, PendingPermission, QuestionSpec } from '@milweb-hq/protocol';
import type { ChatViewProps } from './types';
import {
  authorLabel, formatBytes, formatCost, formatDuration, formatTime, permissionHighlight, renderMarkdown, resultSummaryLabel, stepsLabel, taskStatusLabel,
  toolIconKind, TOOL_KIND_LABELS,
} from './helpers';
import { IconAlert, IconChevron, IconDown, IconImage, IconInfo, IconQuestion, IconShield, ToolIcon } from './icons';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/** O protocolo guarda só nome/caminho; o App pode anexar dataBase64 quando tiver a imagem em memória. */
type AttachmentView = Attachment & { dataBase64?: string };

// ---------------- Markdown ----------------

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    if (a && a.href) { e.preventDefault(); window.open(a.href, '_blank', 'noopener,noreferrer'); }
  };
  return <div className={cx('hq-md', className)} dangerouslySetInnerHTML={{ __html: html }} onClick={onClick} />;
}

// ---------------- Itens ----------------

function AttachmentChips({ attachments }: { attachments: AttachmentView[] }) {
  if (!attachments.length) return null;
  return (
    <div className="hq-attachments">
      {attachments.map((a, i) => (
        a.dataBase64 && a.mediaType.startsWith('image/')
          ? <img key={i} className="hq-attachment-thumb" src={`data:${a.mediaType};base64,${a.dataBase64}`} alt={a.name} title={`${a.name} (${formatBytes(a.sizeBytes)})`} />
          : <span key={i} className="hq-chip" title={formatBytes(a.sizeBytes)}><IconImage size={12} /> {a.name}</span>
      ))}
    </div>
  );
}

function UserMessage({ item }: { item: Extract<ChatItem, { kind: 'user' }> }) {
  return (
    <div className="hq-msg hq-msg--user">
      <div className="hq-msg__meta"><span>Você{item.steer ? <span className="hq-dim"> · no meio da tarefa</span> : null}</span><time>{formatTime(item.ts)}</time></div>
      <div className="hq-bubble hq-bubble--user">{item.text}</div>
      <AttachmentChips attachments={item.attachments} />
    </div>
  );
}

function AssistantMessage({ item }: { item: Extract<ChatItem, { kind: 'assistant' }> }) {
  return (
    <div className={cx('hq-msg hq-msg--assistant', item.author === 'openai' && 'hq-msg--openai')}>
      <div className="hq-msg__meta"><span className={item.author === 'openai' ? 'hq-author hq-author--openai' : 'hq-author'}>{authorLabel(item.author)}</span><time>{formatTime(item.ts)}</time></div>
      <div className="hq-bubble hq-bubble--assistant"><Markdown text={item.text} /></div>
    </div>
  );
}

function StreamingMessage({ text, author }: { text: string; author?: 'claude' | 'openai' }) {
  return (
    <div className={cx('hq-msg hq-msg--assistant', author === 'openai' && 'hq-msg--openai')} aria-live="polite">
      <div className="hq-msg__meta"><span className={author === 'openai' ? 'hq-author hq-author--openai' : 'hq-author'}>{authorLabel(author)}</span><span className="hq-dim">escrevendo…</span></div>
      <div className="hq-bubble hq-bubble--assistant hq-bubble--streaming">
        <Markdown text={text} />
        <span className="hq-cursor" aria-hidden="true" />
      </div>
    </div>
  );
}

function ToolCard({ item, onOpenFile }: { item: Extract<ChatItem, { kind: 'tool' }>; onOpenFile?: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const kind = toolIconKind(item.name);
  const filePath = typeof item.input.file_path === 'string' ? item.input.file_path : null;
  return (
    <div className={cx('hq-tool', item.isError && 'hq-tool--error', !item.done && 'hq-tool--running')}>
      <button
        type="button" className="hq-tool__head" onClick={() => setOpen(o => !o)} aria-expanded={open}
        aria-label={`${open ? 'Recolher' : 'Expandir'} detalhes de ${item.name}: ${item.summary}`}
      >
        <span className="hq-tool__icon" title={TOOL_KIND_LABELS[kind]}><ToolIcon kind={kind} size={14} /></span>
        <span className="hq-tool__summary">{item.summary}</span>
        {!item.done && <span className="hq-pulse" title="Em andamento" />}
        {item.isError && <span className="hq-tag hq-tag--danger">erro</span>}
        <span className="hq-tool__name">{item.name}</span>
        <IconChevron size={14} open={open} />
      </button>
      {open && (
        <div className="hq-tool__body">
          <div className="hq-label">Entrada</div>
          <pre className="hq-mono hq-pre">{JSON.stringify(item.input, null, 2)}</pre>
          {item.output !== undefined && (
            <>
              <div className="hq-label">Saída</div>
              <pre className={cx('hq-mono hq-pre', item.isError && 'hq-pre--error')}>{item.output || '(vazia)'}</pre>
            </>
          )}
          {filePath && onOpenFile && (
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => onOpenFile(filePath)}>Abrir arquivo</button>
          )}
        </div>
      )}
    </div>
  );
}

function PermissionCard({ pending, onAllow, onDeny }: { pending: PendingPermission; onAllow: ChatViewProps['onAllow']; onDeny: ChatViewProps['onDeny'] }) {
  const r = pending.request;
  const highlight = permissionHighlight(r.toolName, r.input);
  const canRemember = (r.permissionSuggestions?.length ?? 0) > 0;
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState('');
  const reason = r.decisionReason || r.description || r.title;
  return (
    <div className="hq-card hq-card--permission" role="group" aria-label={`Pedido de permissão: ${r.displayName ?? r.toolName}`}>
      <div className="hq-card__head">
        <IconShield size={16} />
        <span className="hq-card__title">Pedido de permissão</span>
        <span className="hq-tag hq-tag--warn">{r.displayName ?? r.toolName}</span>
      </div>
      {highlight && <code className="hq-highlight">{highlight}</code>}
      {!highlight && Object.keys(r.input).length > 0 && (
        <pre className="hq-mono hq-pre">{JSON.stringify(r.input, null, 2)}</pre>
      )}
      {reason && <p className="hq-card__reason">{reason}</p>}
      {r.blockedPath && <p className="hq-card__reason">Caminho bloqueado: <code>{r.blockedPath}</code></p>}
      {!denying ? (
        <div className="hq-actions">
          <button type="button" className="hq-btn hq-btn--primary" onClick={() => onAllow(r.requestId, false)}>Permitir</button>
          {canRemember && (
            <button type="button" className="hq-btn" onClick={() => onAllow(r.requestId, true)} title="Aplica a regra sugerida pelo Claude Code">Permitir e lembrar</button>
          )}
          <button type="button" className="hq-btn hq-btn--danger" onClick={() => setDenying(true)}>Negar</button>
        </div>
      ) : (
        <div className="hq-deny">
          <label className="hq-label" htmlFor={`deny-${r.requestId}`}>Mensagem para o Claude (opcional)</label>
          <input
            id={`deny-${r.requestId}`} className="hq-input" value={message} onChange={e => setMessage(e.target.value)}
            placeholder="Ex.: use pnpm em vez de npm" autoFocus
            onKeyDown={e => { if (e.key === 'Enter') onDeny(r.requestId, message.trim() || undefined); if (e.key === 'Escape') setDenying(false); }}
          />
          <div className="hq-actions">
            <button type="button" className="hq-btn hq-btn--danger" onClick={() => onDeny(r.requestId, message.trim() || undefined)}>Confirmar negação</button>
            <button type="button" className="hq-btn hq-btn--ghost" onClick={() => setDenying(false)}>Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionCard({ pending, onAnswer }: { pending: PendingPermission; onAnswer: ChatViewProps['onAnswer'] }) {
  const questions: QuestionSpec[] = pending.questions ?? [];
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: QuestionSpec, label: string) => {
    setChosen(prev => {
      const cur = prev[q.question] ?? [];
      if (q.multiSelect) return { ...prev, [q.question]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] };
      return { ...prev, [q.question]: [label] };
    });
  };
  const answerFor = (q: QuestionSpec) => (other[q.question]?.trim()) || (chosen[q.question] ?? []).join(', ');
  const complete = questions.length > 0 && questions.every(q => answerFor(q).length > 0);
  const submit = () => {
    if (!complete) return;
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = answerFor(q);
    onAnswer(pending.request.requestId, answers);
  };
  const id = pending.request.requestId;
  return (
    <div className="hq-card hq-card--question" role="group" aria-label="Pergunta do Claude">
      <div className="hq-card__head">
        <IconQuestion size={16} />
        <span className="hq-card__title">O Claude quer saber</span>
      </div>
      {questions.map((q, qi) => {
        const name = `${id}-q${qi}`;
        return (
          <fieldset key={qi} className="hq-fieldset">
            <legend>{q.header ? <span className="hq-tag">{q.header}</span> : null} {q.question}</legend>
            <div className="hq-options">
              {q.options.map((o, oi) => {
                const selected = (chosen[q.question] ?? []).includes(o.label);
                return (
                  <label key={oi} className={cx('hq-option', selected && 'hq-option--on')}>
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'} name={name} checked={selected}
                      onChange={() => toggle(q, o.label)}
                    />
                    <span className="hq-option__label">{o.label}</span>
                    {o.description && <span className="hq-option__desc">{o.description}</span>}
                  </label>
                );
              })}
            </div>
            <input
              className="hq-input" placeholder="Outra resposta" aria-label={`Outra resposta para: ${q.question}`}
              value={other[q.question] ?? ''} onChange={e => setOther(p => ({ ...p, [q.question]: e.target.value }))}
            />
          </fieldset>
        );
      })}
      <div className="hq-actions">
        <button type="button" className="hq-btn hq-btn--primary" disabled={!complete} onClick={submit}>Responder</button>
      </div>
    </div>
  );
}

function ResolvedPermission({ item }: { item: Extract<ChatItem, { kind: 'permission' }> }) {
  const ok = item.decision === 'allow';
  return (
    <div className={cx('hq-line', ok ? 'hq-line--ok' : 'hq-line--danger')}>
      <IconShield size={13} />
      <span>{ok ? 'Permissão concedida' : 'Permissão negada'}: {item.summary}</span>
      {item.message && <span className="hq-dim">— {item.message}</span>}
    </div>
  );
}

function ResolvedQuestion({ item }: { item: Extract<ChatItem, { kind: 'question' }> }) {
  return (
    <div className="hq-line hq-line--info">
      <IconQuestion size={13} />
      <span>
        {item.questions.map((q, i) => (
          <span key={i} className="hq-qa">{q.question} <strong>{item.answers?.[q.question] ?? '(sem resposta)'}</strong></span>
        ))}
      </span>
    </div>
  );
}

function ResultLine({ item }: { item: Extract<ChatItem, { kind: 'result' }> }) {
  const bad = item.status === 'error' || item.status === 'lost';
  const parts = [formatDuration(item.durationMs), stepsLabel(item.numTurns), formatCost(item.costUsd)].filter(Boolean);
  return (
    <div className={cx('hq-result', bad && 'hq-result--error', item.status === 'interrupted' && 'hq-result--warn')}>
      <span className="hq-result__status">{taskStatusLabel(item.status)}</span>
      <span className="hq-result__summary">{resultSummaryLabel(item.summary)}</span>
      {parts.length > 0 && <span className="hq-result__meta">{parts.join(' · ')}</span>}
    </div>
  );
}

function Notice({ item }: { item: Extract<ChatItem, { kind: 'notice' }> }) {
  return (
    <div className={cx('hq-notice', `hq-notice--${item.level}`)} role={item.level === 'error' ? 'alert' : 'status'}>
      {item.level === 'info' ? <IconInfo size={14} /> : <IconAlert size={14} />}
      <span>{item.text}</span>
    </div>
  );
}

// ---------------- Lista ----------------

export function ChatView(props: ChatViewProps) {
  const { items, streamingText, streamingAuthor, busy, pending, onAllow, onDeny, onAnswer, onOpenFile } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  const pendingIds = useMemo(() => new Set(pending.map(p => p.request.requestId)), [pending]);
  const sortedPending = useMemo(() => [...pending].sort((a, b) => a.request.receivedAt - b.request.receivedAt), [pending]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
  };

  // Acompanha o fim enquanto o usuário não rolou para cima.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [items, streamingText, pending, following]);

  const jumpToEnd = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setFollowing(true);
  };

  const showWorking = busy && !streamingText && sortedPending.length === 0;

  return (
    <div className="hq-chat">
      <div className="hq-chat__scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-label="Conversa com o funcionário">
        {items.length === 0 && !streamingText && sortedPending.length === 0 && (
          <div className="hq-empty">Nenhuma mensagem ainda. Escreva o pedido abaixo.</div>
        )}
        {items.map(item => {
          switch (item.kind) {
            case 'user': return <UserMessage key={item.id} item={item} />;
            case 'assistant': return <AssistantMessage key={item.id} item={item} />;
            case 'tool': return <ToolCard key={item.id} item={item} onOpenFile={onOpenFile} />;
            case 'permission':
              if (!item.decision && pendingIds.has(item.requestId)) return null; // o cartão pendente vem de `pending`
              return item.decision ? <ResolvedPermission key={item.id} item={item} /> : null;
            case 'question':
              if (!item.answers && pendingIds.has(item.requestId)) return null;
              return item.answers ? <ResolvedQuestion key={item.id} item={item} /> : null;
            case 'result': return <ResultLine key={item.id} item={item} />;
            case 'notice': return <Notice key={item.id} item={item} />;
            default: return null;
          }
        })}
        {streamingText && <StreamingMessage text={streamingText} author={streamingAuthor} />}
        {sortedPending.map(p => (
          p.isQuestion
            ? <QuestionCard key={p.request.requestId} pending={p} onAnswer={onAnswer} />
            : <PermissionCard key={p.request.requestId} pending={p} onAllow={onAllow} onDeny={onDeny} />
        ))}
        {showWorking && (
          <div className="hq-working" aria-live="polite"><span className="hq-pulse" /> Trabalhando…</div>
        )}
      </div>
      {!following && (
        <button type="button" className="hq-jump" onClick={jumpToEnd} aria-label="Ir para o fim da conversa">
          <IconDown size={14} /> Ir para o fim
        </button>
      )}
    </div>
  );
}
