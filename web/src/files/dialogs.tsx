// Diálogos do explorador: base em <dialog> nativo (foco preso, Esc fecha) + confirmações, destino, pasta extra e nomes.
import { useEffect, useId, useRef, useState } from 'react';
import type { FsConflictPolicy, FsEntry, FsInUse, FsRoot } from '@milweb-hq/protocol';
import type { FsApi } from './api';
import { FolderTree } from './FolderTree';
import { IconWarn, IconX } from './icons';
import { countLabel, absolutePath } from './helpers';

export interface DialogProps { open: boolean; title: string; onCancel(): void; width?: number; children: React.ReactNode; danger?: boolean }

export function Dialog({ open, title, onCancel, width = 460, children, danger }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // showModal() foca o primeiro elemento focável (o "X"); o foco útil é o campo ou o botão principal.
      const el = d.querySelector<HTMLElement>('[data-autofocus]') ?? d.querySelector<HTMLElement>('input, textarea, select');
      el?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`hq-fx-dialog${danger ? ' hq-fx-dialog--danger' : ''}`} style={{ width }} aria-labelledby={id}
      onCancel={e => { e.preventDefault(); onCancel(); }} onClick={e => { if (e.target === ref.current) onCancel(); }}>
      {open && (
        <div className="hq-fx-dialog__inner" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
          <header className="hq-fx-dialog__head">
            <h2 id={id} className="hq-fx-dialog__title">{title}</h2>
            <button type="button" className="hq-fx-iconbtn" onClick={onCancel} aria-label="Fechar"><IconX size={16} /></button>
          </header>
          <div className="hq-fx-dialog__body">{children}</div>
        </div>
      )}
    </dialog>
  );
}

// ---------------- confirmação genérica ----------------
export function ConfirmDialog({ open, title, text, confirmLabel, danger, busy, onConfirm, onCancel, children }: {
  open: boolean; title: string; text?: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm(): void; onCancel(): void; children?: React.ReactNode;
}) {
  return (
    <Dialog open={open} title={title} onCancel={onCancel} danger={danger}>
      {text && <p className="hq-fx-dialog__text">{text}</p>}
      {children}
      <div className="hq-fx-actions">
        <button type="button" className="hq-fx-btn" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="button" className={`hq-fx-btn ${danger ? 'hq-fx-btn--danger' : 'hq-fx-btn--primary'}`} onClick={onConfirm} disabled={busy} autoFocus data-autofocus>{busy ? 'Aguarde…' : confirmLabel}</button>
      </div>
    </Dialog>
  );
}

// ---------------- enviar para a lixeira (pasta não vazia ou seleção múltipla) ----------------
export function ConfirmTrashDialog({ open, items, rootPath, busy, onConfirm, onCancel }: {
  open: boolean; items: FsEntry[]; rootPath: string; busy?: boolean; onConfirm(): void; onCancel(): void;
}) {
  const n = items.length;
  return (
    <Dialog open={open} title={n === 1 ? 'Enviar pasta para a lixeira' : `Enviar ${n} itens para a lixeira`} onCancel={onCancel} width={520}>
      <p className="hq-fx-dialog__text">Os itens saem do lugar original e ficam na lixeira da HQ até você restaurar ou excluir de vez.</p>
      <ul className="hq-fx-itemlist">
        {items.map(it => (
          <li key={it.path}>
            <span className="hq-fx-itemlist__name">{it.name}</span>
            <span className="hq-fx-itemlist__meta">{it.type === 'dir' ? `pasta · ${countLabel(it.childCount)}` : it.type === 'symlink' ? 'link (não seguido)' : 'arquivo'}</span>
            <span className="hq-fx-itemlist__path hq-fx-mono">{absolutePath(rootPath, it.path)}</span>
          </li>
        ))}
      </ul>
      <div className="hq-fx-actions">
        <button type="button" className="hq-fx-btn" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="button" className="hq-fx-btn hq-fx-btn--danger" onClick={onConfirm} disabled={busy} autoFocus data-autofocus>{busy ? 'Enviando…' : 'Enviar para a lixeira'}</button>
      </div>
    </Dialog>
  );
}

// ---------------- execuções dependentes (erro in_use) ----------------
export function InUseDialog({ open, inUse, message, canInterrupt, busy, onProceed, onCancel }: {
  open: boolean; inUse: FsInUse[]; message: string; canInterrupt: boolean; busy?: boolean; onProceed(): void; onCancel(): void;
}) {
  const sessions = inUse.flatMap(u => u.sessions.map(s => ({ ...s, path: u.path })));
  return (
    <Dialog open={open} title="Execuções dependem deste caminho" onCancel={onCancel} width={540} danger>
      <p className="hq-fx-dialog__text"><IconWarn size={16} className="hq-fx-inline-icon" /> {message}</p>
      {sessions.length > 0 ? (
        <ul className="hq-fx-itemlist">
          {sessions.map(s => (
            <li key={s.sessionId}>
              <span className="hq-fx-itemlist__name">{s.employeeName}</span>
              <span className="hq-fx-itemlist__meta">
                {s.projectName} · {s.processAlive ? 'processo vivo' : 'sem processo'}{s.taskStatus ? ` · tarefa ${taskStatusLabel(s.taskStatus)}` : ''}
              </span>
              <span className="hq-fx-itemlist__path hq-fx-mono">{s.path || '(raiz)'}</span>
            </li>
          ))}
        </ul>
      ) : <p className="hq-fx-dim">Nenhuma execução listada; a confirmação é exigida mesmo assim.</p>}
      <div className="hq-fx-actions">
        <button type="button" className="hq-fx-btn" onClick={onCancel} disabled={busy} autoFocus data-autofocus>Cancelar</button>
        <button type="button" className="hq-fx-btn hq-fx-btn--danger" onClick={onProceed} disabled={busy}>
          {busy ? 'Aguarde…' : canInterrupt && sessions.length ? 'Interromper e continuar' : 'Continuar mesmo assim'}
        </button>
      </div>
    </Dialog>
  );
}

function taskStatusLabel(s: string): string {
  return ({ queued: 'na fila', running: 'em andamento', waiting_permission: 'aguardando permissão', waiting_answer: 'aguardando resposta' } as Record<string, string>)[s] ?? s;
}

// ---------------- escolher pasta de destino (copiar/mover) ----------------
export function PickDestinationDialog({ open, api, roots, title, confirmLabel, initialRootId, busy, onPick, onCancel }: {
  open: boolean; api: FsApi; roots: FsRoot[]; title: string; confirmLabel: string; initialRootId: string; busy?: boolean;
  onPick(rootId: string, path: string, policy: FsConflictPolicy): void; onCancel(): void;
}) {
  const [rootId, setRootId] = useState(initialRootId);
  const [path, setPath] = useState('');
  const [policy, setPolicy] = useState<FsConflictPolicy>('fail');
  useEffect(() => { if (open) { setRootId(initialRootId); setPath(''); setPolicy('fail'); } }, [open, initialRootId]);
  const root = roots.find(r => r.id === rootId) ?? null;
  return (
    <Dialog open={open} title={title} onCancel={onCancel} width={520}>
      <label className="hq-fx-field">
        <span className="hq-fx-field__label">Raiz</span>
        <select className="hq-fx-input" value={rootId} onChange={e => { setRootId(e.target.value); setPath(''); }}>
          {roots.map(r => <option key={r.id} value={r.id}>{r.kind === 'project' ? 'Projeto: ' : 'Pasta: '}{r.name}</option>)}
        </select>
      </label>
      <div className="hq-fx-picktree">
        {root && <FolderTree api={api} rootId={root.id} rootName={root.name} selectedPath={path} onSelect={setPath} changeKey={null} />}
      </div>
      <div className="hq-fx-dim hq-fx-mono hq-fx-dest">{root ? absolutePath(root.path, path) : ''}</div>
      <label className="hq-fx-field">
        <span className="hq-fx-field__label">Se o destino já tiver um item com o mesmo nome</span>
        <select className="hq-fx-input" value={policy} onChange={e => setPolicy(e.target.value as FsConflictPolicy)}>
          <option value="fail">Não fazer nada e avisar</option>
          <option value="rename">Guardar com outro nome ("nome (2)")</option>
          <option value="overwrite">Substituir o existente</option>
        </select>
      </label>
      <div className="hq-fx-actions">
        <button type="button" className="hq-fx-btn" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="button" className="hq-fx-btn hq-fx-btn--primary" onClick={() => root && onPick(root.id, path, policy)} disabled={busy || !root}>{busy ? 'Aguarde…' : confirmLabel}</button>
      </div>
    </Dialog>
  );
}

// ---------------- adicionar pasta extra ----------------
export function AddFolderDialog({ open, busy, error, onSubmit, onCancel }: { open: boolean; busy?: boolean; error: string | null; onSubmit(path: string, name: string): void; onCancel(): void }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  useEffect(() => { if (open) { setPath(''); setName(''); } }, [open]);
  return (
    <Dialog open={open} title="Adicionar pasta à HQ" onCancel={onCancel}>
      <form className="hq-fx-form" onSubmit={e => { e.preventDefault(); onSubmit(path.trim(), name.trim()); }}>
        <label className="hq-fx-field">
          <span className="hq-fx-field__label">Caminho da pasta</span>
          <input className="hq-fx-input hq-fx-mono" value={path} onChange={e => setPath(e.target.value)} placeholder="C:\Users\usuario\Documentos" autoFocus data-autofocus spellCheck={false} />
          <span className="hq-fx-field__hint">Só cadastro: nada é copiado. O servidor confere se a pasta existe e se já não está dentro de outra raiz.</span>
        </label>
        <label className="hq-fx-field">
          <span className="hq-fx-field__label">Nome (opcional)</span>
          <input className="hq-fx-input" value={name} onChange={e => setName(e.target.value)} placeholder="nome da pasta" />
        </label>
        {error && <p className="hq-fx-error" role="alert">{error}</p>}
        <div className="hq-fx-actions">
          <button type="button" className="hq-fx-btn" onClick={onCancel} disabled={busy}>Cancelar</button>
          <button type="submit" className="hq-fx-btn hq-fx-btn--primary" disabled={busy || !path.trim()}>{busy ? 'Verificando…' : 'Adicionar'}</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------- nome de item novo ----------------
export function NameDialog({ open, title, label, initial, busy, error, confirmLabel, onSubmit, onCancel }: {
  open: boolean; title: string; label: string; initial?: string; busy?: boolean; error: string | null; confirmLabel: string; onSubmit(name: string): void; onCancel(): void;
}) {
  const [name, setName] = useState(initial ?? '');
  useEffect(() => { if (open) setName(initial ?? ''); }, [open, initial]);
  return (
    <Dialog open={open} title={title} onCancel={onCancel}>
      <form className="hq-fx-form" onSubmit={e => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }}>
        <label className="hq-fx-field">
          <span className="hq-fx-field__label">{label}</span>
          <input className="hq-fx-input" value={name} onChange={e => setName(e.target.value)} autoFocus data-autofocus spellCheck={false} />
        </label>
        {error && <p className="hq-fx-error" role="alert">{error}</p>}
        <div className="hq-fx-actions">
          <button type="button" className="hq-fx-btn" onClick={onCancel} disabled={busy}>Cancelar</button>
          <button type="submit" className="hq-fx-btn hq-fx-btn--primary" disabled={busy || !name.trim()}>{busy ? 'Aguarde…' : confirmLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}
