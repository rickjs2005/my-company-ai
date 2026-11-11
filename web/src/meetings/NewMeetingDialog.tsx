// Diálogo de nova reunião: título, pauta, projeto, modo, limite de rodadas e quem senta à mesa: os gerentes (Claude e
// ChatGPT) e/ou funcionários escolhidos por sala, com o estado REAL de cada provedor. Criar não inicia turno nenhum.
import { useEffect, useMemo, useState } from 'react';
import { MEETING_DEFAULT_ROUNDS, MEETING_MAX_AI_PARTICIPANTS, MEETING_MAX_ROUNDS, type AiProviderId, type Employee, type MeetingMode, type MeetingParticipantInput } from '@milweb-hq/protocol';
import { Field, Modal } from '../panel/dialogs/Modal';
import type { NewMeetingDialogProps } from './types';
import { MEETING_MODE_HINTS, MEETING_MODE_LABELS, errorMessage, providerName, providerRouteLabel, providerSummary } from './helpers';

const PROVIDERS: AiProviderId[] = ['claude', 'openai'];

export function NewMeetingDialog(props: NewMeetingDialogProps) {
  const { open, projects, employees, ai, rooms = [] } = props;
  const [title, setTitle] = useState('');
  const [agenda, setAgenda] = useState('');
  const [projectId, setProjectId] = useState('');
  const [mode, setMode] = useState<MeetingMode>('guided');
  const [roundLimit, setRoundLimit] = useState(MEETING_DEFAULT_ROUNDS);
  const [picked, setPicked] = useState<Record<AiProviderId, boolean>>({ claude: true, openai: true });
  const [team, setTeam] = useState<string[]>([]);
  const [synthKey, setSynthKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeEmployees = useMemo(() => employees.filter(e => !e.archivedAt).sort((a, b) => a.name.localeCompare(b.name)), [employees]);
  // Equipe agrupada pela sala de cada funcionário (ordem das salas no cadastro).
  const groups = useMemo(() => {
    const out: { id: string; name: string; people: Employee[] }[] = [];
    for (const e of activeEmployees) {
      let g = out.find(x => x.id === e.roomId);
      if (!g) { g = { id: e.roomId, name: rooms.find(r => r.id === e.roomId)?.name ?? 'Sem sala', people: [] }; out.push(g); }
      g.people.push(e);
    }
    const order = (id: string) => { const i = rooms.findIndex(r => r.id === id); return i < 0 ? 999 : i; };
    return out.sort((a, b) => order(a.id) - order(b.id));
  }, [activeEmployees, rooms]);

  useEffect(() => {
    if (!open) return;
    setTitle(''); setAgenda(''); setProjectId(''); setMode('guided'); setRoundLimit(MEETING_DEFAULT_ROUNDS);
    setPicked({ claude: true, openai: true }); setTeam([]); setSynthKey('');
    setBusy(false); setError(null);
  }, [open]);

  const participants: MeetingParticipantInput[] = [
    ...PROVIDERS.filter(p => picked[p]).map(p => ({ provider: p, employeeId: null })),
    ...team.map(id => activeEmployees.find(e => e.id === id)).filter((e): e is Employee => Boolean(e)).map(e => ({ provider: e.provider, employeeId: e.id })),
  ];
  const overLimit = participants.length > MEETING_MAX_AI_PARTICIPANTS;
  // Quem fecha a discussão: chave = id do funcionário ou o provedor do gerente. Sem escolha válida, o primeiro da lista.
  const keyOf = (p: MeetingParticipantInput) => p.employeeId ?? p.provider;
  const labelOf = (p: MeetingParticipantInput) => (p.employeeId ? activeEmployees.find(e => e.id === p.employeeId)?.name ?? '?' : providerName(p.provider));
  const synthIndex = Math.max(0, participants.findIndex(p => keyOf(p) === synthKey));
  const canCreate = title.trim().length > 0 && participants.length > 0 && !overLimit && !busy;

  // Quem entra pela equipe; o primeiro escolhido sugere o projeto da sala dele quando nenhum foi escolhido (a equipe lê a pasta).
  const setTeamPick = (ids: string[], on: boolean) => {
    setTeam(prev => {
      const next = on ? [...prev, ...ids.filter(id => !prev.includes(id))] : prev.filter(id => !ids.includes(id));
      if (on && !projectId && next.length) {
        const first = activeEmployees.find(e => e.id === next[0]);
        const own = first ? projects.filter(p => p.roomId === first.roomId && !p.id.startsWith('ext:')) : [];
        if (own.length === 1) setProjectId(own[0].id);
      }
      return next;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      await props.onCreate({ title: title.trim(), agenda: agenda.trim(), projectId: projectId || null, mode, roundLimit, participants, synthesisIndex: mode === 'debate' ? synthIndex : null });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Nova reunião" onCancel={props.onCancel} width={560}>
      <form className="hq-form" onSubmit={submit}>
        <Field label="Título">
          <input className="hq-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Ex.: Arquitetura do módulo de contratos" autoFocus required />
        </Field>
        <Field label="Pauta" hint="O que vai ser discutido. Entra no contexto de todo turno; dá para editar depois.">
          <textarea className="hq-input hq-textarea" value={agenda} onChange={e => setAgenda(e.target.value)} rows={4} placeholder="Pontos a discutir, dúvidas, restrições…" />
        </Field>
        <div className="hq-form__row">
          <Field label="Projeto">
            <select className="hq-input" value={projectId} onChange={e => setProjectId(e.target.value)}>
              <option value="">Sem projeto</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Limite de rodadas" hint={`Só no modo Discutir a pauta (1 a ${MEETING_MAX_ROUNDS}).`}>
            <input className="hq-input" type="number" min={1} max={MEETING_MAX_ROUNDS} value={roundLimit} disabled={mode !== 'debate'}
              onChange={e => setRoundLimit(Math.min(MEETING_MAX_ROUNDS, Math.max(1, Number(e.target.value) || 1)))} />
          </Field>
        </div>

        <fieldset className="hq-fieldset">
          <legend>Modo</legend>
          <div className="hq-meet-modes">
            {(['guided', 'debate'] as MeetingMode[]).map(m => (
              <label key={m} className={`hq-meet-mode${mode === m ? ' hq-meet-mode--on' : ''}`}>
                <input type="radio" name="meeting-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                <span>
                  <strong>{MEETING_MODE_LABELS[m]}</strong>
                  <span className="hq-dim">{MEETING_MODE_HINTS[m]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="hq-fieldset">
          <legend>Gerentes <span className="hq-dim">(você sempre está à mesa)</span></legend>
          <div className="hq-meet-pick">
            {PROVIDERS.map(p => {
              const st = ai.find(s => s.provider === p);
              const sum = providerSummary(st, p);
              return (
                <div key={p} className={`hq-meet-pick__row${sum.ok ? '' : ' hq-meet-pick__row--off'}`}>
                  <label className="hq-check">
                    <input type="checkbox" checked={picked[p]} onChange={e => setPicked(prev => ({ ...prev, [p]: e.target.checked }))} />
                    <span><strong>{providerName(p)}</strong> <span className="hq-dim">· {sum.text}</span></span>
                  </label>
                  <button type="button" className="hq-linkbtn" onClick={props.onOpenAiSettings}>Configurar</button>
                  {!sum.ok && sum.detail && <div className="hq-dim hq-meet-pick__detail">{sum.detail}</div>}
                  {!sum.ok && picked[p] && <div className="hq-notice hq-notice--warn">Pode entrar na reunião, mas não vai responder até o login/instalação estar em ordem.</div>}
                </div>
              );
            })}
          </div>
        </fieldset>

        {groups.length > 0 && (
          <fieldset className="hq-fieldset">
            <legend>Equipe <span className="hq-dim">(cada um fala com a própria função, instruções e motor)</span></legend>
            <div className="hq-meet-team">
              {groups.map(g => {
                const ids = g.people.map(e => e.id);
                const all = ids.every(id => team.includes(id));
                return (
                  <div key={g.id} className="hq-meet-team__room">
                    <div className="hq-meet-team__head">
                      <strong>{g.name}</strong>
                      <button type="button" className="hq-linkbtn" onClick={() => setTeamPick(ids, !all)}>{all ? 'Tirar a sala' : 'Toda a sala'}</button>
                    </div>
                    {g.people.map(e => {
                      const st = ai.find(s => s.provider === e.provider);
                      const sum = providerSummary(st, e.provider);
                      return (
                        <label key={e.id} className={`hq-check hq-meet-team__person${sum.ok ? '' : ' hq-meet-team__person--off'}`} title={sum.ok ? undefined : sum.text}>
                          <input type="checkbox" checked={team.includes(e.id)} onChange={ev => setTeamPick([e.id], ev.target.checked)} />
                          <span><strong>{e.name}</strong>{e.role ? <span className="hq-dim"> · {e.role}</span> : null} <span className="hq-dim">· {providerRouteLabel(e.provider)}{sum.ok ? '' : ' (indisponível agora)'}</span></span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
              <div className="hq-meet-team__foot">
                <button type="button" className="hq-linkbtn" onClick={() => setTeamPick(activeEmployees.map(e => e.id), true)}>Toda a equipe</button>
                {team.length > 0 && <button type="button" className="hq-linkbtn" onClick={() => setTeam([])}>Ninguém da equipe</button>}
                <span className="hq-dim">{participants.length} de {MEETING_MAX_AI_PARTICIPANTS} lugares · as falas saem uma por vez</span>
              </div>
            </div>
          </fieldset>
        )}
        {mode === 'debate' && participants.length > 1 && (
          <Field label="Quem faz a síntese" hint="Fecha a discussão com propostas, divergências, perguntas e próximas ações para você decidir.">
            <select className="hq-input" value={keyOf(participants[synthIndex])} onChange={e => setSynthKey(e.target.value)}>
              {participants.map(p => <option key={keyOf(p)} value={keyOf(p)}>{labelOf(p)}</option>)}
            </select>
          </Field>
        )}
        {participants.length === 0 && <div className="hq-notice hq-notice--warn">Escolha pelo menos um gerente ou alguém da equipe; sem ninguém a reunião seria um monólogo.</div>}
        {overLimit && <div className="hq-notice hq-notice--warn">A mesa comporta {MEETING_MAX_AI_PARTICIPANTS} participantes além de você. Tire {participants.length - MEETING_MAX_AI_PARTICIPANTS} para criar.</div>}

        {error && <div className="hq-notice hq-notice--error" role="alert">{error}</div>}
        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn" onClick={props.onCancel} disabled={busy}>Cancelar</button>
          <button type="submit" className="hq-btn hq-btn--primary" disabled={!canCreate}>{busy ? 'Criando…' : 'Criar reunião'}</button>
        </div>
      </form>
    </Modal>
  );
}
