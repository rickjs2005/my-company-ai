// Ata da reunião: rascunho gerado ao encerrar, editável em Markdown, com prévia e "Criar tarefas" a partir do quadro.
import { useEffect, useState } from 'react';
import { Markdown } from '../panel/ChatView';
import type { MinutesEditorProps } from './types';
import { errorMessage, formatMeetingTime, proposeTaskItems } from './helpers';
import { CreateTasksDialog } from './CreateTasksDialog';

export function MinutesEditor({ meeting, history, employees, projects, rooms, dispatch, onNotice }: MinutesEditorProps) {
  const [text, setText] = useState(meeting.minutes?.text ?? '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [creating, setCreating] = useState(false);
  const ended = meeting.status === 'ended';
  const proposals = proposeTaskItems(history, meeting);
  const pendingCount = proposals.filter(p => p.status !== 'created').length;

  useEffect(() => { if (!dirty) setText(meeting.minutes?.text ?? ''); }, [meeting.minutes?.text, dirty]);
  useEffect(() => { setDirty(false); setText(meeting.minutes?.text ?? ''); }, [meeting.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      await dispatch({ type: 'meeting.minutes.save', reqId: '', meetingId: meeting.id, text });
      setDirty(false);
      onNotice({ level: 'ok', text: 'Ata salva.' });
    } catch (err) { onNotice({ level: 'error', text: errorMessage(err) }); } finally { setSaving(false); }
  };

  return (
    <div className="hq-meet-minutes">
      {!ended && (
        <div className="hq-empty">
          <p>A ata é gerada quando a reunião é encerrada.</p>
          <p className="hq-dim">Enquanto isso, o quadro guarda decisões, propostas e ações; dá para criar tarefas a partir das confirmadas.</p>
        </div>
      )}
      {ended && !meeting.minutes && (
        <div className="hq-notice hq-notice--warn">A reunião está encerrada, mas o servidor não enviou nenhum rascunho de ata. Escreva a sua abaixo e salve.</div>
      )}
      {ended && (
        <>
          <div className="hq-meet-minutes__head">
            {meeting.minutes && <span className="hq-dim">Gerada {formatMeetingTime(meeting.minutes.generatedAt)}{meeting.minutes.editedAt ? ` · editada ${formatMeetingTime(meeting.minutes.editedAt)}` : ''}</span>}
            {dirty && <span className="hq-tag hq-tag--xs hq-tag--warn">não salva</span>}
            <span className="hq-view__spacer" />
            <div className="hq-segment" role="tablist">
              <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'hq-segment__on' : ''} onClick={() => setPreview(false)}>Editar</button>
              <button type="button" role="tab" aria-selected={preview} className={preview ? 'hq-segment__on' : ''} onClick={() => setPreview(true)}>Prévia</button>
            </div>
          </div>
          {preview ? (
            <div className="hq-meet-minutes__preview">{text.trim() ? <Markdown text={text} /> : <span className="hq-dim">Ata vazia.</span>}</div>
          ) : (
            <textarea className="hq-input hq-textarea hq-meet-minutes__ta" value={text} rows={16} spellCheck={false}
              onChange={e => { setText(e.target.value); setDirty(true); }} placeholder="# Ata&#10;&#10;Decisões, descartados, próximas ações…" aria-label="Ata em Markdown" />
          )}
          <div className="hq-actions hq-actions--end">
            <button type="button" className="hq-btn hq-btn--primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar ata'}</button>
          </div>
        </>
      )}

      <section className="hq-meet-minutes__tasks">
        <h4 className="hq-meet-group__title">Tarefas a partir da reunião</h4>
        <p className="hq-dim">{proposals.length === 0 ? 'Nenhuma decisão ou ação confirmada ainda. Confirme no quadro para transformar em tarefa.' : `${pendingCount} por criar · ${proposals.length - pendingCount} já criada(s).`}</p>
        <button type="button" className="hq-btn" disabled={proposals.length === 0} onClick={() => setCreating(true)}>Criar tarefas</button>
      </section>

      <CreateTasksDialog open={creating} meeting={meeting} history={history} employees={employees} projects={projects} rooms={rooms} dispatch={dispatch} onClose={() => setCreating(false)} />
    </div>
  );
}
