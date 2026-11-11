// Contexto da reunião: pauta, itens (arquivos do explorador e notas livres) com toggle, contexto da empresa e versão.
// Salva a lista inteira com meeting.context.set; nada vai para os modelos além do que está aqui e das falas públicas.
import { useEffect, useMemo, useState } from 'react';
import type { MeetingContextItem } from '@milweb-hq/protocol';
import { IconFile, IconPlus, IconX } from '../panel/icons';
import type { ContextEditorProps } from './types';
import { errorMessage, newId } from './helpers';
import { FilePickerDialog } from './FilePickerDialog';

export function ContextEditor({ meeting, items, dispatch, onNotice, fsRoots, fsList }: ContextEditorProps) {
  const [draft, setDraft] = useState<MeetingContextItem[]>(items);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [agenda, setAgenda] = useState(meeting.agenda);
  const [picking, setPicking] = useState(false);
  const ended = meeting.status === 'ended';

  // Segue o servidor enquanto não há edição local pendente.
  useEffect(() => { if (!dirty) setDraft(items); }, [items, dirty]);
  useEffect(() => { setAgenda(meeting.agenda); }, [meeting.id, meeting.agenda]);
  useEffect(() => { setDirty(false); setDraft(items); /* troca de reunião */ }, [meeting.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (err: unknown) => onNotice({ level: 'error', text: errorMessage(err) });
  const edit = (fn: (list: MeetingContextItem[]) => MeetingContextItem[]) => { setDraft(fn); setDirty(true); };

  const save = async () => {
    setSaving(true);
    try {
      await dispatch({ type: 'meeting.context.set', reqId: '', meetingId: meeting.id, items: draft.map(i => ({ ...i, label: i.label.trim() || (i.kind === 'file' ? i.path ?? 'arquivo' : 'nota') })) });
      setDirty(false);
      onNotice({ level: 'ok', text: 'Contexto salvo. Vale a partir do próximo turno.' });
    } catch (err) { fail(err); } finally { setSaving(false); }
  };

  const saveAgenda = () => {
    const a = agenda.trim();
    if (a === meeting.agenda) return;
    dispatch({ type: 'meeting.update', id: meeting.id, patch: { agenda: a } }).catch(fail);
  };

  const files = useMemo(() => draft.filter(i => i.kind === 'file'), [draft]);
  const notes = useMemo(() => draft.filter(i => i.kind === 'note'), [draft]);

  return (
    <div className="hq-meet-ctx">
      <div className="hq-notice hq-notice--info">Sem raciocínio privado: só o que está aqui e as falas públicas vão para os modelos.</div>
      <div className="hq-meet-ctx__ver hq-dim">Versão atual do contexto: <strong>{meeting.contextVersion}</strong>{dirty && <span className="hq-tag hq-tag--xs hq-tag--warn">alterações não salvas</span>}</div>

      <label className="hq-field">
        <span className="hq-field__label">Pauta</span>
        <textarea className="hq-input hq-textarea" value={agenda} rows={4} disabled={ended} onChange={e => setAgenda(e.target.value)} onBlur={saveAgenda} />
        <span className="hq-field__hint">Salva ao sair do campo (meeting.update) e sobe a versão do contexto.</span>
      </label>

      <label className="hq-check">
        <input type="checkbox" checked={meeting.companyContext} disabled={ended} onChange={e => dispatch({ type: 'meeting.update', id: meeting.id, patch: { companyContext: e.target.checked } }).catch(fail)} />
        <span>Incluir contexto da empresa <span className="hq-dim">(salas, projetos, funcionários)</span></span>
      </label>

      <section className="hq-meet-ctx__group">
        <h4 className="hq-meet-group__title">Arquivos do explorador <span className="hq-dim">{files.length}</span></h4>
        {files.length === 0 && <div className="hq-dim hq-meet-group__empty">Nenhum arquivo. O servidor lê o caminho real a cada turno; nada é copiado.</div>}
        {files.map(i => (
          <div key={i.id} className={`hq-meet-ctx__item${i.enabled ? '' : ' hq-meet-ctx__item--off'}`}>
            <input type="checkbox" checked={i.enabled} disabled={ended} aria-label={`Incluir ${i.label}`} onChange={e => edit(l => l.map(x => x.id === i.id ? { ...x, enabled: e.target.checked } : x))} />
            <IconFile size={13} />
            <span className="hq-meet-ctx__label" title={i.path ?? ''}>{i.label}<span className="hq-dim hq-mono hq-meet-ctx__path">{i.path}</span></span>
            {!ended && <button type="button" className="hq-iconbtn hq-iconbtn--xs" aria-label={`Remover ${i.label}`} onClick={() => edit(l => l.filter(x => x.id !== i.id))}><IconX size={12} /></button>}
          </div>
        ))}
        {!ended && <button type="button" className="hq-btn hq-btn--sm" onClick={() => setPicking(true)}><IconPlus size={12} /> Adicionar arquivos</button>}
      </section>

      <section className="hq-meet-ctx__group">
        <h4 className="hq-meet-group__title">Notas livres <span className="hq-dim">{notes.length}</span></h4>
        {notes.length === 0 && <div className="hq-dim hq-meet-group__empty">Nenhuma nota.</div>}
        {notes.map(i => (
          <div key={i.id} className={`hq-meet-ctx__note${i.enabled ? '' : ' hq-meet-ctx__item--off'}`}>
            <div className="hq-meet-ctx__noteHead">
              <input type="checkbox" checked={i.enabled} disabled={ended} aria-label={`Incluir ${i.label}`} onChange={e => edit(l => l.map(x => x.id === i.id ? { ...x, enabled: e.target.checked } : x))} />
              <input className="hq-input hq-input--sm hq-meet-ctx__noteLabel" value={i.label} disabled={ended} placeholder="Título da nota" onChange={e => edit(l => l.map(x => x.id === i.id ? { ...x, label: e.target.value } : x))} />
              {!ended && <button type="button" className="hq-iconbtn hq-iconbtn--xs" aria-label="Remover nota" onClick={() => edit(l => l.filter(x => x.id !== i.id))}><IconX size={12} /></button>}
            </div>
            <textarea className="hq-input hq-textarea" value={i.text ?? ''} rows={3} disabled={ended} placeholder="Texto que vai para os modelos" onChange={e => edit(l => l.map(x => x.id === i.id ? { ...x, text: e.target.value } : x))} />
          </div>
        ))}
        {!ended && <button type="button" className="hq-btn hq-btn--sm" onClick={() => edit(l => [...l, { id: newId(), kind: 'note', label: '', path: null, text: '', enabled: true }])}><IconPlus size={12} /> Nova nota</button>}
      </section>

      {!ended && (
        <div className="hq-actions hq-actions--end hq-meet-ctx__save">
          {dirty && <button type="button" className="hq-btn hq-btn--ghost" disabled={saving} onClick={() => { setDraft(items); setDirty(false); }}>Desfazer</button>}
          <button type="button" className="hq-btn hq-btn--primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar contexto'}</button>
        </div>
      )}

      <FilePickerDialog open={picking} fsRoots={fsRoots} fsList={fsList} onCancel={() => setPicking(false)}
        onPick={picked => {
          setPicking(false);
          edit(l => {
            const have = new Set(l.filter(x => x.kind === 'file').map(x => x.path));
            const add = picked.filter(f => !have.has(f.absPath)).map<MeetingContextItem>(f => ({ id: newId(), kind: 'file', label: f.name, path: f.absPath, text: null, enabled: true }));
            return [...l, ...add];
          });
        }} />
    </div>
  );
}
