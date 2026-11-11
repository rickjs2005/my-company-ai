// Base dos diálogos: <dialog> nativo (foco preso, Esc fecha, clique no fundo fecha).
import { useEffect, useRef } from 'react';
import { IconX } from '../icons';

export interface ModalProps {
  open: boolean;
  title: string;
  onCancel(): void;
  width?: number;
  children: React.ReactNode;
}

export function Modal({ open, title, onCancel, width = 480, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useRef(`hq-dlg-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref} className="hq-dialog" style={{ width }} aria-labelledby={id.current}
      onCancel={e => { e.preventDefault(); onCancel(); }}
      onClick={e => { if (e.target === ref.current) onCancel(); }}
    >
      {open && (
        <div className="hq-dialog__inner" onClick={e => e.stopPropagation()}>
          <header className="hq-dialog__head">
            <h2 id={id.current} className="hq-dialog__title">{title}</h2>
            <button type="button" className="hq-iconbtn" onClick={onCancel} aria-label="Fechar diálogo"><IconX size={16} /></button>
          </header>
          <div className="hq-dialog__body">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="hq-field">
      <span className="hq-field__label">{label}</span>
      {children}
      {hint && <span className="hq-field__hint">{hint}</span>}
    </label>
  );
}
