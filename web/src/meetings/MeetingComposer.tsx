// Compositor da reunião: destino (Todos | Claude | ChatGPT | participante), @menções com autocomplete, Enter envia.
// clientId é gerado uma vez por envio e reutilizado se o envio falhar (o servidor desduplica por ele).
import { useEffect, useMemo, useRef, useState } from 'react';
import { IconSend } from '../panel/icons';
import type { MeetingComposerProps } from './types';
import { aiAvailability, errorMessage, mentionAtCursor, mentionSuggestions, newId, parseMentions, resolveTargets, type TargetSelectValue } from './helpers';

export function MeetingComposer(props: MeetingComposerProps) {
  const { meeting, ai, disabledReason, initialTarget = 'all' } = props;
  const [text, setText] = useState('');
  const [target, setTarget] = useState<TargetSelectValue>(initialTarget);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [hi, setHi] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const clientIdRef = useRef<string | null>(null);

  const ais = useMemo(() => meeting.participants.filter(p => p.kind === 'ai').sort((a, b) => a.order - b.order), [meeting.participants]);
  const avail = aiAvailability(meeting, ai);
  const ended = meeting.status === 'ended';
  const reason = disabledReason ?? (ended ? 'Reunião encerrada. Reabra para continuar a conversa.' : !avail.ok ? avail.reason : null);
  const disabled = Boolean(reason);
  const canSend = !disabled && !sending && text.trim().length > 0;

  useEffect(() => { setError(null); setText(''); clientIdRef.current = null; }, [meeting.id]);

  // Cresce até ~6 linhas; depois rola.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [text]);

  const mention = mentionAtCursor(text, cursor);
  const suggestions = mention ? mentionSuggestions(mention.query, ais) : [];
  const showSuggest = suggestions.length > 0 && !disabled;
  useEffect(() => { setHi(0); }, [mention?.query, mention?.start]);

  const pick = (name: string) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(cursor);
    const next = `${before}@${name} ${after}`;
    setText(next);
    const pos = before.length + name.length + 2;
    window.setTimeout(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(pos, pos); setCursor(pos); } }, 0);
  };

  const submit = async () => {
    if (!canSend) return;
    const body = text.trim();
    const mentions = parseMentions(body, meeting.participants);
    const targets = resolveTargets(target, mentions, meeting.participants);
    if (!clientIdRef.current) clientIdRef.current = newId();
    const clientId = clientIdRef.current;
    setSending(true); setError(null);
    try {
      await props.onSend(body, targets, clientId);
      clientIdRef.current = null;
      setText('');
    } catch (err) {
      // Mantém o texto e o mesmo clientId para o reenvio: o servidor não cria duas falas.
      setError(`Não foi enviado: ${errorMessage(err)}. Tente de novo (o mesmo envio será reaproveitado).`);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggest) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => (h + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => (h - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(suggestions[hi]?.name ?? suggestions[0].name); return; }
      if (e.key === 'Escape') { e.preventDefault(); setCursor(-1); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };

  const track = (el: HTMLTextAreaElement) => setCursor(el.selectionStart ?? el.value.length);

  return (
    <div className={`hq-meet-composer${disabled ? ' hq-meet-composer--off' : ''}`}>
      <div className="hq-meet-composer__box">
        <textarea
          ref={taRef} className="hq-composer__ta" rows={1} value={text} disabled={disabled}
          placeholder={disabled ? '' : 'Fale com a mesa (Enter envia · Shift+Enter quebra linha · @ menciona)'}
          aria-label="Mensagem para a reunião" title="Enter envia; Shift+Enter quebra linha; @ menciona um participante"
          onChange={e => { setText(e.target.value); track(e.target); }} onKeyDown={onKeyDown}
          onKeyUp={e => track(e.currentTarget)} onClick={e => track(e.currentTarget)}
        />
        {showSuggest && (
          <ul className="hq-meet-suggest" role="listbox" aria-label="Participantes">
            {suggestions.map((p, i) => (
              <li key={p.id} role="option" aria-selected={i === hi} className={i === hi ? 'hq-meet-suggest__on' : ''} onMouseDown={e => { e.preventDefault(); pick(p.name); }}>
                @{p.name} <span className="hq-dim">{p.provider === 'claude' ? 'via Claude Code' : 'via Codex'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="hq-meet-composer__bar">
        <label className="hq-select">
          <span className="sr-only">Destino</span>
          <select value={target} onChange={e => setTarget(e.target.value)} disabled={disabled} aria-label="Destino da mensagem">
            <option value="all">Todos</option>
            {ais.some(p => p.provider === 'claude' && !p.away) && <option value="claude">Claude</option>}
            {ais.some(p => p.provider === 'openai' && !p.away) && <option value="openai">ChatGPT</option>}
            {ais.filter(p => p.name !== 'Claude' && p.name !== 'ChatGPT' && !p.away).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <span className="hq-dim hq-meet-composer__hint">Enter envia · Shift+Enter quebra linha · @Nome menciona</span>
        <span className="hq-view__spacer" />
        <button type="button" className="hq-btn hq-btn--primary" disabled={!canSend} onClick={() => void submit()} aria-label="Enviar fala">
          <IconSend size={14} /> {sending ? 'Enviando…' : 'Enviar'}
        </button>
      </div>
      {reason && (
        <div className="hq-composer__note hq-composer__note--off" role="status">
          {reason}{!ended && !avail.ok && <> · <button type="button" className="hq-linkbtn" onClick={props.onOpenAiSettings}>abrir configurações de IA</button></>}
        </div>
      )}
      {error && <div className="hq-notice hq-notice--error" role="alert">{error}</div>}
    </div>
  );
}
