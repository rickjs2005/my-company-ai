// Barra de participantes: nome, rota real, estado real (vem do servidor) e chip de modelo/esforço com a origem.
// O popover de configuração manda meeting.participant.update; a mudança só vale a partir do próximo turno.
// "Chamar" traz um gerente ou alguém da equipe para a mesa no meio da reunião; "Tirar da reunião" pula os turnos dele na fila.
import { useEffect, useMemo, useRef, useState } from 'react';
import { EFFORT_LABELS, MEETING_MAX_AI_PARTICIPANTS, type EffortLevel, type MeetingParticipant } from '@milweb-hq/protocol';
import { IconPlus, IconSettings } from '../panel/icons';
import type { ParticipantsBarProps } from './types';
import { isManager, modelOptionLabel, participantConfig, participantInitial, participantStateColor, participantStateLabel, planOwnerOf, providerName, providerRouteLabel, sortedModels } from './helpers';

export function ParticipantsBar({ meeting, employees, ai, settings, onUpdate, onAdd, onRemove, onSetPlanOwner }: ParticipantsBarProps) {
  const owner = planOwnerOf(meeting);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const aiCount = meeting.participants.filter(p => p.kind === 'ai').length;
  const sorted = useMemo(() => [...meeting.participants].sort((a, b) => a.order - b.order), [meeting.participants]);
  return (
    <div className="hq-meet-parts" role="list" aria-label="Participantes">
      {sorted.map(p => {
        const cfg = p.kind === 'ai' ? participantConfig(p, employees, ai, settings) : null;
        const emp = p.employeeId ? employees.find(e => e.id === p.employeeId) : null;
        return (
          <div key={p.id} className={`hq-meet-part hq-meet-part--${p.state}`} role="listitem"
            title={[p.kind === 'ai' ? `${p.name} ${providerRouteLabel(p.provider)}${emp ? ` · representa ${emp.name}` : ''}` : 'Chefe', cfg ? `${cfg.chip} (${cfg.source})` : null, p.stateDetail].filter(Boolean).join('\n')}>
            <span className={`hq-meet-avatar hq-meet-avatar--${p.kind === 'chefe' ? 'chefe' : p.provider ?? 'ai'}`} aria-hidden="true">{participantInitial(p)}</span>
            <span className="hq-meet-part__text">
              <strong className="hq-meet-part__name">{p.name}</strong>
              {isManager(p) && <span className={`hq-meet-part__role${owner?.id === p.id ? ' hq-meet-part__role--owner' : ''}`} title={owner?.id === p.id ? 'Gerente responsável por consolidar o plano' : 'Gerente'}>{owner?.id === p.id ? 'gerente · plano' : 'gerente'}</span>}
              <span className="hq-meet-part__state">
                <span className="hq-status-dot" style={{ background: participantStateColor(p.state) }} />
                {participantStateLabel(p.state)}
                {p.state === 'responding' && <span className="hq-pulse" aria-hidden="true" />}
              </span>
            </span>
            {p.kind === 'ai' && (
              <button type="button" className={`hq-iconbtn hq-iconbtn--xs${openId === p.id ? ' hq-meet-part__gear--on' : ''}`} aria-label={`Configurar ${p.name}`} title="Modelo e esforço nesta reunião"
                aria-expanded={openId === p.id} onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                <IconSettings size={14} />
              </button>
            )}
            {openId === p.id && p.kind === 'ai' && (
              <ParticipantConfigPopover participant={p} ai={ai} employees={employees} onUpdate={onUpdate} onRemove={onRemove && meeting.activeTurnId === null ? () => onRemove(p.id) : undefined} onClose={() => setOpenId(null)}
                onPlanOwner={onSetPlanOwner && isManager(p) && owner?.id !== p.id && !p.away ? () => { onSetPlanOwner(p.id); setOpenId(null); } : undefined} />
            )}
          </div>
        );
      })}
      {onAdd && meeting.status !== 'ended' && (
        <div className="hq-meet-part hq-meet-part--add">
          <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={aiCount >= MEETING_MAX_AI_PARTICIPANTS} aria-expanded={adding}
            title={aiCount >= MEETING_MAX_AI_PARTICIPANTS ? `A mesa já tem ${MEETING_MAX_AI_PARTICIPANTS} participantes além de você` : 'Chamar um gerente ou alguém da equipe para esta reunião'}
            onClick={() => setAdding(!adding)}><IconPlus size={12} /> Chamar</button>
          {adding && <AddParticipantPopover meeting={meeting} employees={employees} onAdd={input => { onAdd(input); setAdding(false); }} onClose={() => setAdding(false)} />}
        </div>
      )}
    </div>
  );
}

/** Quem ainda não está à mesa: gerentes ausentes e funcionários ativos. Entra a partir da próxima fala ou rodada. */
function AddParticipantPopover({ meeting, employees, onAdd, onClose }: { meeting: ParticipantsBarProps['meeting']; employees: ParticipantsBarProps['employees']; onAdd(input: { provider: 'claude' | 'openai'; employeeId: string | null }): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.hq-meet-part--add')) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const managers = (['claude', 'openai'] as const).filter(pr => !meeting.participants.some(p => p.kind === 'ai' && p.provider === pr && !p.employeeId));
  const people = employees.filter(e => !e.archivedAt && !meeting.participants.some(p => p.employeeId === e.id)).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div ref={ref} className="hq-meet-pop hq-meet-pop--add" role="dialog" aria-label="Chamar para a reunião">
      {managers.length === 0 && people.length === 0 && <div className="hq-dim">Todo mundo já está à mesa.</div>}
      {managers.map(pr => (
        <button key={pr} type="button" className="hq-meet-picker__row" onClick={() => onAdd({ provider: pr, employeeId: null })}>
          <span><strong>{providerName(pr)}</strong> <span className="hq-dim">· gerente {providerRouteLabel(pr)}</span></span>
        </button>
      ))}
      {people.map(e => (
        <button key={e.id} type="button" className="hq-meet-picker__row" onClick={() => onAdd({ provider: e.provider, employeeId: e.id })}>
          <span><strong>{e.name}</strong>{e.role ? <span className="hq-dim"> · {e.role}</span> : null} <span className="hq-dim">· {providerRouteLabel(e.provider)}</span></span>
        </button>
      ))}
      <div className="hq-dim hq-meet-pop__note">Quem chega lê a pauta e tudo o que já foi dito; fala a partir da próxima pergunta ou rodada.</div>
    </div>
  );
}

function ParticipantConfigPopover({ participant: p, ai, employees, onUpdate, onRemove, onClose, onPlanOwner }: {
  participant: MeetingParticipant; ai: ParticipantsBarProps['ai']; employees: ParticipantsBarProps['employees'];
  onUpdate: ParticipantsBarProps['onUpdate']; onRemove?: () => void; onClose(): void; onPlanOwner?: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const status = ai.find(s => s.provider === p.provider);
  const models = useMemo(() => sortedModels(status), [status]);
  const [useGlobal, setUseGlobal] = useState(p.useGlobal);
  const [model, setModel] = useState<string>(p.model ?? '');
  const [effort, setEffort] = useState<string>(p.effort ?? '');
  const [employeeId, setEmployeeId] = useState<string>(p.employeeId ?? '');
  useEffect(() => { setUseGlobal(p.useGlobal); setModel(p.model ?? ''); setEffort(p.effort ?? ''); setEmployeeId(p.employeeId ?? ''); }, [p.useGlobal, p.model, p.effort, p.employeeId]);

  // Fecha ao clicar fora ou com Esc.
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const selected = models.find(m => m.id === model) ?? null;
  const efforts: EffortLevel[] = selected ? selected.efforts : [];
  const effortOk = !effort || efforts.includes(effort as EffortLevel);
  const activeEmployees = employees.filter(e => !e.archivedAt);

  const apply = () => {
    const patch: Parameters<ParticipantsBarProps['onUpdate']>[1] = { useGlobal, employeeId: employeeId || null };
    if (!useGlobal) { patch.model = model || null; patch.effort = effortOk && effort ? (effort as EffortLevel) : null; }
    onUpdate(p.id, patch);
    onClose();
  };

  return (
    <div ref={ref} className="hq-meet-pop" role="dialog" aria-label={`Configuração de ${p.name}`}>
      <div className="hq-segment" role="tablist">
        <button type="button" role="tab" aria-selected={useGlobal} className={useGlobal ? 'hq-segment__on' : ''} onClick={() => setUseGlobal(true)}>Usar padrão global</button>
        <button type="button" role="tab" aria-selected={!useGlobal} className={!useGlobal ? 'hq-segment__on' : ''} onClick={() => setUseGlobal(false)}>Personalizar nesta reunião</button>
      </div>
      {!status && <div className="hq-notice hq-notice--warn">O servidor ainda não informou o catálogo deste provedor.</div>}
      {!useGlobal && (
        <>
          <label className="hq-field">
            <span className="hq-field__label">Modelo</span>
            <select className="hq-input" value={model} onChange={e => { setModel(e.target.value); setEffort(''); }}>
              <option value="">Padrão do provedor</option>
              {models.map(m => <option key={m.id} value={m.id}>{modelOptionLabel(m)}</option>)}
            </select>
            {status && models.length === 0 && <span className="hq-field__hint">Nenhum modelo listado ({status.catalogSource || 'catálogo vazio'}).</span>}
            {status && models.length > 0 && <span className="hq-field__hint">Lista: {status.catalogSource}</span>}
          </label>
          <label className="hq-field">
            <span className="hq-field__label">Esforço</span>
            {selected && efforts.length === 0 ? (
              <span className="hq-dim">este modelo não aceita controle de esforço</span>
            ) : (
              <select className="hq-input" value={effort} onChange={e => setEffort(e.target.value)} disabled={!selected}>
                <option value="">{selected ? `Padrão do modelo${selected.defaultEffort ? ` (${EFFORT_LABELS[selected.defaultEffort]})` : ''}` : 'Escolha um modelo antes'}</option>
                {efforts.map(l => <option key={l} value={l}>{EFFORT_LABELS[l]}</option>)}
              </select>
            )}
          </label>
        </>
      )}
      {activeEmployees.length > 0 && (
        <label className="hq-field">
          <span className="hq-field__label">Representa o funcionário</span>
          <select className="hq-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
            <option value="">Ninguém</option>
            {activeEmployees.map(e => <option key={e.id} value={e.id}>{e.name} · {e.role}</option>)}
          </select>
        </label>
      )}
      <div className="hq-dim hq-meet-pop__note">Alterações valem a partir do próximo turno.</div>
      {onPlanOwner && <button type="button" className="hq-btn hq-btn--sm" onClick={onPlanOwner}>Tornar responsável pelo plano</button>}
      {onRemove && (
        <div className="hq-actions">
          {!leaving
            ? <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setLeaving(true)}>Tirar da reunião</button>
            : <button type="button" className="hq-btn hq-btn--sm hq-btn--danger" onClick={() => { onRemove(); onClose(); }}>Confirmar: {p.name} sai da mesa</button>}
        </div>
      )}
      <div className="hq-actions hq-actions--end">
        <button type="button" className="hq-btn hq-btn--sm" onClick={onClose}>Cancelar</button>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={apply}>Aplicar</button>
      </div>
    </div>
  );
}
