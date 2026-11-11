// Diálogo de novo projeto: nome, caminho da pasta (digitado) e sala. Mostra o erro que o servidor devolver.
import { useEffect, useState } from 'react';
import type { AddProjectDialogProps } from '../types';
import { basename } from '../helpers';
import { Field, Modal } from './Modal';

export function AddProjectDialog(props: AddProjectDialogProps) {
  const { open, rooms, defaultRoomId } = props;
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [roomId, setRoomId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(''); setPath(''); setError(null); setBusy(false);
    setRoomId(defaultRoomId ?? rooms[0]?.id ?? '');
  }, [open, defaultRoomId, rooms]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (!p || !roomId) return;
    setBusy(true); setError(null);
    try {
      const r = await props.onCreate({ name: name.trim() || basename(p), path: p, roomId });
      if (!r.ok) setError(r.error ?? 'Não foi possível adicionar o projeto.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title="Adicionar projeto" onCancel={props.onCancel}>
      <form onSubmit={submit} className="hq-form">
        <Field label="Pasta do projeto" hint="Caminho local real; os arquivos ficam lá, sem cópias.">
          <input className="hq-input hq-mono" value={path} onChange={e => setPath(e.target.value)} placeholder="C:\Users\usuario\projetos\meu-site" required autoFocus />
        </Field>
        <Field label="Nome" hint="Se vazio, usa o nome da pasta.">
          <input className="hq-input" value={name} onChange={e => setName(e.target.value)} placeholder={basename(path) || 'Nome do projeto'} />
        </Field>
        <Field label="Sala">
          <select className="hq-input" value={roomId} onChange={e => setRoomId(e.target.value)} required>
            {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        {error && <div className="hq-notice hq-notice--error" role="alert">{error}</div>}
        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn hq-btn--ghost" onClick={props.onCancel}>Cancelar</button>
          <button type="submit" className="hq-btn hq-btn--primary" disabled={busy || !path.trim() || !roomId}>{busy ? 'Adicionando…' : 'Adicionar'}</button>
        </div>
      </form>
    </Modal>
  );
}
