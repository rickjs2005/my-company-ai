// Editor de sala: nome, cor, instruções e (na sala de Social Media) perfis editoriais.
import { useEffect, useState } from 'react';
import type { EditorialProfile } from '@milweb-hq/protocol';
import type { RoomEditorProps } from '../types';
import { IconPlus, IconX } from '../icons';
import { Field, Modal } from './Modal';

const newId = () => `p-${Math.random().toString(36).slice(2, 8)}`;

export function RoomEditor(props: RoomEditorProps) {
  const { open, room } = props;
  const [name, setName] = useState('');
  const [color, setColor] = useState('#f0a830');
  const [instructions, setInstructions] = useState('');
  const [profiles, setProfiles] = useState<EditorialProfile[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(room?.name ?? '');
    setColor(room?.color ?? '#f0a830');
    setInstructions(room?.instructions ?? '');
    setProfiles(room?.profiles.map(p => ({ ...p })) ?? []);
  }, [open, room]);

  const updateProfile = (id: string, patch: Partial<EditorialProfile>) => setProfiles(ps => ps.map(p => (p.id === id ? { ...p, ...patch } : p)));
  const removeProfile = (id: string) => setProfiles(ps => ps.filter(p => p.id !== id));
  const addProfile = () => setProfiles(ps => [...ps, { id: newId(), name: '', instructions: '' }]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const patch: Parameters<RoomEditorProps['onSave']>[0] = { name: name.trim(), color, instructions };
    if (room?.kind === 'social') patch.profiles = profiles.filter(p => p.name.trim()).map(p => ({ ...p, name: p.name.trim() }));
    props.onSave(patch);
  };

  const validColor = /^#[0-9a-f]{6}$/i.test(color);

  return (
    <Modal open={open} title={room ? `Editar sala: ${room.name}` : 'Editar sala'} onCancel={props.onCancel} width={560}>
      <form onSubmit={submit} className="hq-form">
        <div className="hq-form__row">
          <Field label="Nome">
            <input className="hq-input" value={name} onChange={e => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Cor" hint={validColor ? undefined : 'Use o formato #rrggbb'}>
            <span className="hq-color">
              <input type="color" value={validColor ? color : '#f0a830'} onChange={e => setColor(e.target.value)} aria-label="Escolher cor" />
              <input className="hq-input hq-mono" value={color} onChange={e => setColor(e.target.value)} aria-label="Cor em hexadecimal" />
            </span>
          </Field>
        </div>
        <Field label="Instruções da sala" hint="Vão junto do sistema em toda sessão nova desta sala.">
          <textarea className="hq-input hq-textarea" rows={4} value={instructions} onChange={e => setInstructions(e.target.value)} />
        </Field>

        {room?.kind === 'social' && (
          <fieldset className="hq-fieldset">
            <legend>Perfis editoriais</legend>
            {profiles.length === 0 && <div className="hq-dim">Nenhum perfil. Cada perfil tem instruções próprias (ex.: Aurora, Tuco Dev).</div>}
            {profiles.map(p => (
              <div key={p.id} className="hq-profile">
                <div className="hq-profile__row">
                  <input className="hq-input" value={p.name} onChange={e => updateProfile(p.id, { name: e.target.value })} placeholder="Nome do perfil" aria-label="Nome do perfil" />
                  <button type="button" className="hq-iconbtn" onClick={() => removeProfile(p.id)} aria-label={`Remover perfil ${p.name || 'sem nome'}`}><IconX size={14} /></button>
                </div>
                <textarea className="hq-input hq-textarea" rows={2} value={p.instructions} onChange={e => updateProfile(p.id, { instructions: e.target.value })} placeholder="Instruções deste perfil" aria-label={`Instruções do perfil ${p.name || 'sem nome'}`} />
              </div>
            ))}
            <button type="button" className="hq-btn hq-btn--sm" onClick={addProfile}><IconPlus size={12} /> Adicionar perfil</button>
          </fieldset>
        )}

        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn hq-btn--ghost" onClick={props.onCancel}>Cancelar</button>
          <button type="submit" className="hq-btn hq-btn--primary" disabled={!name.trim() || !validColor}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}
