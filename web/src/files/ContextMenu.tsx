// Menu contextual (botão direito, tecla Menu, Shift+F10) com navegação por teclado.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem { label: string; shortcut?: string; onSelect?(): void; disabled?: boolean; danger?: boolean; separator?: boolean }

export function ContextMenu({ open, x, y, items, onClose }: { open: boolean; x: number; y: number; items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [focus, setFocus] = useState(0);
  const actionable = items.map((it, i) => ({ it, i })).filter(({ it }) => !it.separator && !it.disabled);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setPos({ left, top });
    setFocus(actionable[0]?.i ?? 0);
    ref.current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onScroll = () => onClose();
    window.addEventListener('mousedown', close); window.addEventListener('blur', onClose); window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('blur', onClose); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onClose); };
  }, [open, onClose]);

  if (!open) return null;

  const move = (dir: 1 | -1) => {
    if (!actionable.length) return;
    const idx = actionable.findIndex(a => a.i === focus);
    const next = actionable[(idx + dir + actionable.length) % actionable.length];
    setFocus(next.i);
  };

  return (
    <div ref={ref} className="hq-fx-menu" role="menu" tabIndex={-1} style={{ left: pos.left, top: pos.top }}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const it = items[focus]; if (it && !it.disabled && !it.separator) { onClose(); it.onSelect?.(); } }
      }}
      onContextMenu={e => e.preventDefault()}>
      {items.map((it, i) => it.separator
        ? <div key={i} className="hq-fx-menu__sep" role="separator" />
        : (
          <button key={i} type="button" role="menuitem" className={`hq-fx-menu__item${it.danger ? ' hq-fx-menu__item--danger' : ''}${focus === i ? ' hq-fx-menu__item--focus' : ''}`}
            disabled={it.disabled} onMouseEnter={() => !it.disabled && setFocus(i)} onClick={() => { onClose(); it.onSelect?.(); }} tabIndex={-1}>
            <span>{it.label}</span>
            {it.shortcut && <kbd className="hq-fx-menu__kbd">{it.shortcut}</kbd>}
          </button>
        ))}
    </div>
  );
}
