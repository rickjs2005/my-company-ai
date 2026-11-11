// Área central de uma reunião: cabeçalho editável, botões conforme o status real, barra de participantes, conversa,
// compositor e a coluna da direita (Quadro, Contexto, Ata). Todo pedido vai pelo dispatch; erro vira aviso na tela.
import { useEffect, useMemo, useRef, useState } from 'react';
import { MEETING_MAX_ROUNDS, type MeetingMode, type MeetingTurn } from '@milweb-hq/protocol';
import { Modal } from '../panel/dialogs/Modal';
import { IconRefresh, IconStop, IconX } from '../panel/icons';
import type { MeetingNotice, MeetingPanelProps } from './types';
import { canAddRound, canDiscuss, errorMessage, formatMeetingTime, MEETING_MODE_LABELS, meetingStatusColor, meetingStatusLabel, newId, participantInitial, planOwnerOf, readMeetPref, writeMeetPref } from './helpers';
import { PlanView } from './PlanView';
import { ParticipantsBar } from './ParticipantsBar';
import { Conversation } from './Conversation';
import { MeetingComposer } from './MeetingComposer';
import { Board } from './Board';
import { ContextEditor } from './ContextEditor';
import { MinutesEditor } from './MinutesEditor';

type SideTab = 'board' | 'plan' | 'context' | 'minutes';
type Confirm = 'end' | 'delete' | null;
interface Shown extends MeetingNotice { id: number }

export function MeetingPanel(props: MeetingPanelProps) {
  const { meeting, history, streaming, employees, projects, rooms, ai, settings, dispatch, onOpenAiSettings, fsRoots, fsList, onDeleted, listOpen, onToggleList, tasks, onOpenTask } = props;
  const [tab, setTab] = useState<SideTab>('board');
  // A conversa é o centro da tela: quadro/contexto/ata e os detalhes da pauta abrem só quando o Chefe pedir (lembrado neste navegador).
  const [sideOpen, setSideOpen] = useState(() => readMeetPref('side', false));
  const [detailsOpen, setDetailsOpen] = useState(() => readMeetPref('details', false));
  const toggleSide = (want?: boolean) => setSideOpen(v => { const n = want ?? !v; writeMeetPref('side', n); return n; });
  const toggleDetails = () => setDetailsOpen(v => { writeMeetPref('details', !v); return !v; });
  const openTab = (t: SideTab) => { setTab(t); toggleSide(true); };
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Shown[]>([]);
  const seq = useRef(0);

  // Título e pauta editáveis no cabeçalho: seguem o servidor enquanto o campo não está em edição.
  const [title, setTitle] = useState(meeting.title);
  const [agenda, setAgenda] = useState(meeting.agenda);
  const editing = useRef<'title' | 'agenda' | null>(null);
  useEffect(() => { if (editing.current !== 'title') setTitle(meeting.title); }, [meeting.title]);
  useEffect(() => { if (editing.current !== 'agenda') setAgenda(meeting.agenda); }, [meeting.agenda]);

  const ended = meeting.status === 'ended';
  const hasActiveTurn = Boolean(meeting.activeTurnId);
  const projectById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const project = meeting.projectId ? projectById.get(meeting.projectId) ?? null : null;

  const notify = (n: MeetingNotice) => {
    const id = ++seq.current;
    setNotices(ns => [...ns.slice(-4), { ...n, id }]);
    if (n.level === 'ok' || n.level === 'info') window.setTimeout(() => setNotices(ns => ns.filter(x => x.id !== id)), 7000);
  };
  const dismiss = (id: number) => setNotices(ns => ns.filter(x => x.id !== id));
  const fail = (err: unknown) => notify({ level: 'error', text: errorMessage(err) });

  // Ao trocar de reunião o componente é remontado pelo host (key = meeting.id), então os avisos começam limpos.
  useEffect(() => { setNotices([]); setConfirm(null); setBusy(null); }, [meeting.id]);

  const update = (patch: UpdatePatch) => dispatchUpdate(dispatch, meeting.id, patch).catch(fail);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); } catch (err) { fail(err); } finally { setBusy(null); }
  };

  const discuss = () => run('discuss', async () => {
    const res = await dispatch({ type: 'meeting.discuss', reqId: '', meetingId: meeting.id, clientId: newId() }) as { turns?: MeetingTurn[] } | undefined;
    const n = res?.turns?.length ?? 0;
    if (n === 0) notify({ level: 'warn', text: 'O servidor não criou nenhum turno para a discussão.' });
  });
  const end = () => run('end', async () => {
    setConfirm(null);
    await dispatch({ type: 'meeting.end', reqId: '', meetingId: meeting.id });
    openTab('minutes');
    notify({ level: 'ok', text: 'Reunião encerrada. O rascunho da ata está na aba Ata.' });
  });
  // Encerrar e distribuir: o gerente responsável consolida o plano e a HQ distribui (idempotente no servidor).
  const distribute = () => run('distribute', async () => {
    setConfirm(null);
    await dispatch({ type: 'meeting.endAndDistribute', reqId: '', meetingId: meeting.id, clientId: newId() });
    openTab('plan');
  });
  const remove = () => run('delete', async () => {
    setConfirm(null);
    await dispatch({ type: 'meeting.delete', id: meeting.id });
    onDeleted();
  });

  const send = async (text: string, targets: string[], clientId: string) => {
    const res = await dispatch({ type: 'meeting.say', reqId: '', meetingId: meeting.id, clientId, text, targets }) as { turns?: MeetingTurn[] } | undefined;
    if ((res?.turns?.length ?? 0) === 0) notify({ level: 'warn', text: 'A fala foi registrada, mas o servidor não criou nenhum turno de resposta.' });
  };

  const saveTitle = () => {
    editing.current = null;
    const t = title.trim();
    if (!t) { setTitle(meeting.title); return; }
    if (t !== meeting.title) update({ title: t });
  };
  const saveAgenda = () => {
    editing.current = null;
    const a = agenda.trim();
    if (a !== meeting.agenda) update({ agenda: a });
  };

  const showDiscuss = meeting.mode === 'debate' && !ended;
  const boardCount = history ? history.decisions.filter(d => !d.dismissed).length : 0;
  const owner = planOwnerOf(meeting);
  const dist = meeting.distribution ?? null;
  const distLabel = !dist ? null : dist.state === 'planning' ? `consolidando o plano${owner ? ` (${owner.name})` : ''}…` : dist.state === 'waiting_manager' ? 'esperando um gerente voltar para consolidar' : dist.state === 'distributed' ? `plano v${dist.planVersion} distribuído` : `plano não lido: ${dist.error ?? 'erro'}`;
  const canDistribute = !dist || dist.state === 'failed';
  const away = meeting.participants.filter(p => p.kind === 'ai' && p.away);
  const rejoin = (participantId: string) => run(`rejoin:${participantId}`, () => dispatch({ type: 'meeting.participant.rejoin', meetingId: meeting.id, participantId }));
  const dismissAway = (participantId: string) => run(`remove:${participantId}`, () => dispatch({ type: 'meeting.participant.remove', meetingId: meeting.id, participantId }));
  const roundLabel = meeting.mode === 'debate' ? `rodada ${meeting.currentRound} de ${meeting.roundLimit}` : null;

  return (
    <section className="hq-meet-panel" aria-label={meeting.title || 'Reunião'}>
      <header className="hq-meet-head">
        <div className="hq-meet-head__row">
          {onToggleList && (
            <button type="button" className="hq-iconbtn hq-meet-head__list" onClick={onToggleList} aria-pressed={listOpen} title={listOpen ? 'Recolher a lista de reuniões' : 'Mostrar a lista de reuniões'} aria-label={listOpen ? 'Recolher a lista de reuniões' : 'Mostrar a lista de reuniões'}>
              <span aria-hidden="true">{listOpen ? '«' : '»'}</span>
            </button>
          )}
          <input
            className="hq-meet-head__title" value={title} disabled={ended} aria-label="Título da reunião" placeholder="Título da reunião"
            onFocus={() => { editing.current = 'title'; }} onChange={e => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') { setTitle(meeting.title); e.currentTarget.blur(); } }}
          />
          <span className="hq-meet-status hq-meet-status--lg" style={{ ['--st' as string]: meetingStatusColor(meeting.status) }}>{meetingStatusLabel(meeting.status)}</span>
          {roundLabel && <span className="hq-dim hq-meet-head__round">{roundLabel}</span>}
          {owner && <span className="hq-tag hq-tag--xs" title="Gerente responsável por consolidar o plano (troque na configuração do participante)">plano: {owner.name}</span>}
          {distLabel && <button type="button" className={`hq-meet-dist hq-meet-dist--${dist!.state}`} onClick={() => openTab('plan')} title="Ver o plano e as tarefas distribuídas">{distLabel}</button>}
          <div className="hq-meet-actions">
            {showDiscuss && (
              <button type="button" className="hq-btn hq-btn--primary hq-btn--sm" disabled={!canDiscuss(meeting) || busy === 'discuss'} onClick={discuss}
                title={canDiscuss(meeting) ? 'Opinião inicial, rodadas de revisão e síntese' : hasActiveTurn || meeting.queuedTurns > 0 ? 'Há turno em andamento ou na fila' : meeting.status === 'paused' ? 'Retome a reunião antes' : 'Nenhuma IA disponível para discutir'}>
                {busy === 'discuss' ? 'Iniciando…' : 'Discutir a pauta'}
              </button>
            )}
            {hasActiveTurn && !ended && (
              <button type="button" className="hq-btn hq-btn--warn hq-btn--sm" disabled={busy === 'interrupt'} onClick={() => run('interrupt', () => dispatch({ type: 'meeting.interrupt', meetingId: meeting.id }))}>
                <IconStop size={12} /> Interromper
              </button>
            )}
            {meeting.status === 'active' && (
              <button type="button" className="hq-btn hq-btn--sm" disabled={busy === 'pause'} onClick={() => run('pause', () => dispatch({ type: 'meeting.pause', meetingId: meeting.id }))}>Pausar</button>
            )}
            {meeting.status === 'paused' && (
              <button type="button" className="hq-btn hq-btn--sm" disabled={busy === 'resume'} onClick={() => run('resume', () => dispatch({ type: 'meeting.resume', meetingId: meeting.id }))}>Retomar</button>
            )}
            {meeting.mode === 'debate' && !ended && canAddRound(meeting, history) && (
              <button type="button" className="hq-btn hq-btn--sm" disabled={busy === 'round'} onClick={() => run('round', () => dispatch({ type: 'meeting.anotherRound', meetingId: meeting.id }))}
                title={`Mais uma rodada de revisão e nova síntese (teto: ${MEETING_MAX_ROUNDS})`}>
                <IconRefresh size={12} /> Mais uma rodada
              </button>
            )}
            {canDistribute && meeting.participants.some(p => p.kind === 'ai') && (
              <button type="button" className="hq-btn hq-btn--primary hq-btn--sm" onClick={distribute} disabled={Boolean(busy)}
                title={owner ? `${owner.name} consolida o plano a partir do que foi combinado com você; a HQ grava ata, plano e tarefas e põe na fila` : 'Nenhum gerente disponível agora: o pedido fica guardado até um voltar'}>
                {busy === 'distribute' ? 'Pedindo…' : 'Encerrar e distribuir tarefas'}
              </button>
            )}
            {!ended && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setConfirm('end')} disabled={Boolean(busy)} title="Encerra e gera a ata, sem distribuir tarefas">Só encerrar</button>}
            {ended && <button type="button" className="hq-btn hq-btn--sm" disabled={busy === 'reopen'} onClick={() => run('reopen', () => dispatch({ type: 'meeting.reopen', meetingId: meeting.id }))}>Reabrir</button>}
            <button type="button" className={`hq-btn hq-btn--sm${sideOpen ? ' hq-meet-toggle--on' : ''}`} aria-pressed={sideOpen} onClick={() => toggleSide()}
              title={sideOpen ? 'Fechar quadro, contexto e ata' : 'Abrir quadro, contexto e ata ao lado da conversa'}>
              Quadro{boardCount > 0 && <span className="hq-meet-count">{boardCount}</span>}
            </button>
          </div>
        </div>
        <div className="hq-meet-head__sub">
          <button type="button" className="hq-meet-head__agenda-peek" onClick={toggleDetails} aria-expanded={detailsOpen} title={detailsOpen ? 'Recolher pauta e detalhes' : 'Ver e editar a pauta, o projeto e o modo'}>
            <span className="hq-meet-fact__k">Pauta</span>
            <span className="hq-meet-head__agenda-text">{meeting.agenda.trim() || 'sem pauta (clique para escrever)'}</span>
            <span className="hq-dim">{detailsOpen ? 'recolher ▴' : 'detalhes ▾'}</span>
          </button>
        </div>
        {detailsOpen && (
          <div className="hq-meet-head__details">
            <textarea
              className="hq-meet-head__agenda" value={agenda} rows={3} disabled={ended} aria-label="Pauta" placeholder="Pauta: o que vai ser discutido (salva ao sair do campo)"
              onFocus={() => { editing.current = 'agenda'; }} onChange={e => setAgenda(e.target.value)} onBlur={saveAgenda}
            />
            <div className="hq-meet-facts">
              <label className="hq-meet-fact">
                <span className="hq-meet-fact__k">Projeto</span>
                <select className="hq-input hq-input--sm" value={meeting.projectId ?? ''} disabled={ended} aria-label="Projeto" onChange={e => update({ projectId: e.target.value || null })}>
                  <option value="">Sem projeto</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  {meeting.projectId && !project && <option value={meeting.projectId}>projeto removido</option>}
                </select>
              </label>
              <label className="hq-meet-fact">
                <span className="hq-meet-fact__k">Modo</span>
                <select className="hq-input hq-input--sm" value={meeting.mode} disabled={ended || hasActiveTurn || meeting.queuedTurns > 0} aria-label="Modo" title={hasActiveTurn ? 'Não dá para trocar o modo com um turno em andamento' : undefined}
                  onChange={e => update({ mode: e.target.value as MeetingMode })}>
                  {(Object.keys(MEETING_MODE_LABELS) as MeetingMode[]).map(m => <option key={m} value={m}>{MEETING_MODE_LABELS[m]}</option>)}
                </select>
              </label>
              {meeting.mode === 'debate' && (
                <label className="hq-meet-fact">
                  <span className="hq-meet-fact__k">Limite de rodadas</span>
                  <input className="hq-input hq-input--sm hq-meet-fact__num" type="number" min={1} max={MEETING_MAX_ROUNDS} value={meeting.roundLimit} disabled={ended} aria-label="Limite de rodadas"
                    onChange={e => { const v = Math.min(MEETING_MAX_ROUNDS, Math.max(1, Number(e.target.value) || 1)); if (v !== meeting.roundLimit) update({ roundLimit: v }); }} />
                </label>
              )}
              <span className="hq-meet-fact"><span className="hq-meet-fact__k">Contexto</span><span className="hq-meet-fact__v">versão {meeting.contextVersion}</span></span>
              {meeting.queuedTurns > 0 && <span className="hq-meet-fact"><span className="hq-meet-fact__k">Fila</span><span className="hq-meet-fact__v">{meeting.queuedTurns} turno{meeting.queuedTurns === 1 ? '' : 's'}</span></span>}
              <span className="hq-view__spacer" />
              <button type="button" className="hq-btn hq-btn--sm" onClick={() => openTab('context')}>Contexto da reunião</button>
              <button type="button" className="hq-btn hq-btn--danger hq-btn--sm" onClick={() => setConfirm('delete')} disabled={Boolean(busy)}>Excluir reunião</button>
            </div>
          </div>
        )}
      </header>

      <ParticipantsBar meeting={meeting} employees={employees} ai={ai} settings={settings}
        onUpdate={(participantId, patch) => dispatch({ type: 'meeting.participant.update', meetingId: meeting.id, participantId, patch }).catch(fail)}
        onAdd={participant => dispatch({ type: 'meeting.participant.add', reqId: '', meetingId: meeting.id, participant }).catch(fail)}
        onRemove={participantId => dispatch({ type: 'meeting.participant.remove', meetingId: meeting.id, participantId }).catch(fail)}
        onSetPlanOwner={participantId => update({ synthesisParticipantId: participantId })} />

      {notices.length > 0 && (
        <div className="hq-meet-notices">
          {notices.map(n => (
            <div key={n.id} className={`hq-notice hq-notice--${n.level}`} role={n.level === 'error' ? 'alert' : 'status'}>
              <span className="hq-meet-notices__text">{n.text}</span>
              <button type="button" className="hq-iconbtn hq-iconbtn--xs" aria-label="Fechar aviso" onClick={() => dismiss(n.id)}><IconX size={12} /></button>
            </div>
          ))}
        </div>
      )}

      {away.length > 0 && !ended && (
        <div className="hq-meet-away" role="status" aria-label="Participantes fora da reunião">
          {away.map(p => (
            <div key={p.id} className={`hq-meet-away__row${p.away!.asking ? ' hq-meet-away__row--ask' : ''}`}>
              <span className={`hq-meet-avatar hq-meet-avatar--${p.provider ?? 'ai'}`} aria-hidden="true">{participantInitial(p)}</span>
              <span className="hq-meet-away__text">
                <strong>{p.name}</strong> {p.away!.asking ? 'já pode voltar' : 'está fora da reunião'}: {p.away!.reason}
                {p.away!.until && !p.away!.asking && <span className="hq-dim"> · libera às {formatMeetingTime(p.away!.until)}</span>}
              </span>
              <button type="button" className={`hq-btn hq-btn--sm${p.away!.asking ? ' hq-btn--primary' : ''}`} disabled={busy === `rejoin:${p.id}`} onClick={() => rejoin(p.id)}
                title={p.away!.asking ? `Trazer ${p.name} de volta para a conversa` : `O motivo ainda não passou; se ${p.name} continuar sem poder responder, sai de novo no próximo turno`}>Chamar de volta</button>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy === `remove:${p.id}` || meeting.activeTurnId !== null} onClick={() => dismissAway(p.id)}>Tirar da reunião</button>
            </div>
          ))}
        </div>
      )}

      <div className={`hq-meet-body${sideOpen ? '' : ' hq-meet-body--solo'}`}>
        <div className="hq-meet-center">
          <Conversation meeting={meeting} history={history} streaming={streaming}
            onRetry={turnId => dispatch({ type: 'meeting.retryTurn', meetingId: meeting.id, turnId }).catch(fail)} />
          <MeetingComposer meeting={meeting} ai={ai} onSend={send} onOpenAiSettings={onOpenAiSettings}
            disabledReason={meeting.status === 'paused' ? 'Reunião pausada. Retome para falar com a mesa.' : null} />
        </div>

        {sideOpen && <aside className="hq-meet-side" aria-label="Quadro, contexto e ata">
          <div className="hq-tabs" role="tablist">
            <button type="button" className="hq-iconbtn hq-iconbtn--xs hq-meet-side__close" onClick={() => toggleSide(false)} aria-label="Fechar quadro, contexto e ata" title="Fechar"><IconX size={12} /></button>
            <button type="button" role="tab" aria-selected={tab === 'board'} className={`hq-tab${tab === 'board' ? ' hq-tab--on' : ''}`} onClick={() => setTab('board')}>
              Quadro{history && history.decisions.length > 0 && <span className="hq-dim">{history.decisions.filter(d => !d.dismissed).length}</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'plan'} className={`hq-tab${tab === 'plan' ? ' hq-tab--on' : ''}`} onClick={() => setTab('plan')}>
              Plano{history?.planTasks && history.planTasks.length > 0 && <span className="hq-dim">{history.planTasks.length}</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'context'} className={`hq-tab${tab === 'context' ? ' hq-tab--on' : ''}`} onClick={() => setTab('context')}>
              Contexto{history && history.context.length > 0 && <span className="hq-dim">{history.context.filter(c => c.enabled).length}</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'minutes'} className={`hq-tab${tab === 'minutes' ? ' hq-tab--on' : ''}`} onClick={() => setTab('minutes')}>
              Ata{ended && meeting.minutes && <span className="hq-status-dot" style={{ background: 'var(--ok)' }} />}
            </button>
          </div>
          <div className="hq-meet-side__body">
            {!history ? (
              <div className="hq-empty"><p>Carregando o histórico…</p></div>
            ) : tab === 'board' ? (
              <Board meeting={meeting} decisions={history.decisions} employees={employees} dispatch={dispatch} onNotice={notify} />
            ) : tab === 'plan' ? (
              <PlanView history={history} tasks={tasks ?? []} employees={employees} onOpenTask={onOpenTask} />
            ) : tab === 'context' ? (
              <ContextEditor meeting={meeting} items={history.context} dispatch={dispatch} onNotice={notify} fsRoots={fsRoots} fsList={fsList} />
            ) : (
              <MinutesEditor meeting={meeting} history={history} employees={employees} projects={projects} rooms={rooms} dispatch={dispatch} onNotice={notify} />
            )}
          </div>
        </aside>}
      </div>

      <Modal open={confirm === 'end'} title="Encerrar a reunião?" onCancel={() => setConfirm(null)} width={440}>
        <div className="hq-form">
          <p className="hq-meet-confirm">O servidor gera o rascunho da ata a partir das falas e do quadro. Dá para reabrir depois.</p>
          {hasActiveTurn && <div className="hq-notice hq-notice--warn">Há um turno em andamento: ele será interrompido e a fala fica registrada como parcial.</div>}
          <div className="hq-actions hq-actions--end">
            <button type="button" className="hq-btn" onClick={() => setConfirm(null)}>Cancelar</button>
            <button type="button" className="hq-btn hq-btn--primary" onClick={end}>Encerrar e gerar a ata</button>
          </div>
        </div>
      </Modal>

      <Modal open={confirm === 'delete'} title="Excluir a reunião?" onCancel={() => setConfirm(null)} width={440}>
        <div className="hq-form">
          <p className="hq-meet-confirm">Manda <strong>{meeting.title || 'esta reunião'}</strong> para a lixeira de reuniões, com falas, quadro, contexto e ata. Dá para restaurar por 30 dias (embaixo da lista). As tarefas já criadas continuam existindo.</p>
          <div className="hq-actions hq-actions--end">
            <button type="button" className="hq-btn" onClick={() => setConfirm(null)}>Cancelar</button>
            <button type="button" className="hq-btn hq-btn--danger" onClick={remove}>Mandar para a lixeira</button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

type UpdatePatch = Extract<Parameters<MeetingPanelProps['dispatch']>[0], { type: 'meeting.update' }>['patch'];
function dispatchUpdate(dispatch: MeetingPanelProps['dispatch'], id: string, patch: UpdatePatch) {
  return dispatch({ type: 'meeting.update', id, patch });
}
