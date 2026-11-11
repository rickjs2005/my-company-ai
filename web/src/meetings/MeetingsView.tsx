// Tela da sala de Reuniões: lista à esquerda, painel da reunião selecionada (ou estado vazio) e o diálogo de criação.
// Componente puro: tudo entra por props; o host (App) liga ao store e ao WebSocket.
import { useState } from 'react';
import type { Meeting } from '@milweb-hq/protocol';
import { IconPlus } from '../panel/icons';
import type { MeetingsViewProps, NewMeetingInput } from './types';
import { MeetingList } from './MeetingList';
import { MeetingPanel } from './MeetingPanel';
import { NewMeetingDialog } from './NewMeetingDialog';
import { MeetingTrash } from './MeetingTrash';
import { readMeetPref, writeMeetPref } from './helpers';
import '../styles/meetings.css';

export function MeetingsView(props: MeetingsViewProps) {
  const { meetings, selectedId, history, streaming, employees, projects, rooms, ai, settings, onSelect, dispatch, onOpenAiSettings, fsRoots, fsList, tasks, onOpenTask } = props;
  const [creating, setCreating] = useState(false);
  const selected = selectedId ? meetings.find(m => m.id === selectedId) ?? null : null;
  // A lista pode ser recolhida para a conversa ocupar a largura toda (só com uma reunião aberta).
  const [listOpen, setListOpen] = useState(() => readMeetPref('list', true));
  const toggleList = () => setListOpen(v => { writeMeetPref('list', !v); return !v; });
  const showList = listOpen || !selected;

  const create = async (input: NewMeetingInput) => {
    const res = await dispatch({
      type: 'meeting.create', reqId: '', title: input.title, agenda: input.agenda, projectId: input.projectId, mode: input.mode,
      roundLimit: input.roundLimit, participants: input.participants,
    }) as { meeting?: Meeting } | undefined;
    if (!res?.meeting?.id) throw new Error('o servidor não devolveu a reunião criada');
    // Síntese escolhida no diálogo: o participante criado com o mesmo funcionário (ou o gerente do mesmo provedor).
    const want = input.synthesisIndex != null ? input.participants[input.synthesisIndex] : null;
    const synth = want ? res.meeting.participants.find(p => p.kind === 'ai' && (want.employeeId ? p.employeeId === want.employeeId : p.provider === want.provider && !p.employeeId)) : null;
    if (synth) await dispatch({ type: 'meeting.update', id: res.meeting.id, patch: { synthesisParticipantId: synth.id } }).catch(() => undefined);
    setCreating(false);
    onSelect(res.meeting.id);
  };

  return (
    <section className={`hq-meet${showList ? '' : ' hq-meet--nolist'}`} aria-label="Reuniões">
      {showList && <MeetingList meetings={meetings} selectedId={selectedId} projects={projects} onSelect={onSelect} onNew={() => setCreating(true)}
        footer={<MeetingTrash dispatch={dispatch} onRestored={id => onSelect(id)} refreshKey={meetings.length} />} />}

      {selected ? (
        <MeetingPanel
          key={selected.id} meeting={selected} history={history} streaming={streaming}
          employees={employees} projects={projects} rooms={rooms} ai={ai} settings={settings}
          dispatch={dispatch} onOpenAiSettings={onOpenAiSettings} fsRoots={fsRoots} fsList={fsList}
          onDeleted={() => onSelect(null)}
          listOpen={showList} onToggleList={toggleList} tasks={tasks} onOpenTask={onOpenTask}
        />
      ) : (
        <div className="hq-meet-blank">
          <div className="hq-empty hq-empty--tall">
            {meetings.length === 0 ? (
              <>
                <p>Nenhuma reunião ainda.</p>
                <p className="hq-dim">Você, os gerentes Claude (via Claude Code) e ChatGPT (via Codex) e quem você chamar da equipe discutem uma pauta. Só o que estiver no contexto e nas falas públicas vai para os modelos.</p>
                <button type="button" className="hq-btn hq-btn--primary" onClick={() => setCreating(true)}><IconPlus size={12} /> Nova reunião</button>
              </>
            ) : selectedId ? (
              <>
                <p>Reunião não encontrada.</p>
                <p className="hq-dim">Ela pode ter sido excluída. Escolha outra na lista à esquerda.</p>
              </>
            ) : (
              <>
                <p>Escolha uma reunião à esquerda.</p>
                <p className="hq-dim">Ou crie uma nova para começar.</p>
              </>
            )}
          </div>
        </div>
      )}

      <NewMeetingDialog open={creating} projects={projects} employees={employees} rooms={rooms} ai={ai} onCreate={create} onCancel={() => setCreating(false)} onOpenAiSettings={onOpenAiSettings} />
    </section>
  );
}
