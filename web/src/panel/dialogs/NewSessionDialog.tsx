// Diálogo de nova conversa: funcionário (fixo ou escolhido na sala), projeto, nome, modelo, modo e perfil;
// ou retomar uma conversa pausada. Criar não inicia processo: o Claude Code só sobe na primeira mensagem.
import { useEffect, useMemo, useState } from 'react';
import type { PermissionModeOption } from '@milweb-hq/protocol';
import type { NewSessionDialogProps } from '../types';
import { MODEL_OPTIONS, PERMISSION_MODE_LABELS, PERMISSION_MODE_OPTIONS, sessionStatusLabel } from '../helpers';
import { Field, Modal } from './Modal';

export function NewSessionDialog(props: NewSessionDialogProps) {
  const { open, room, projects, employee, roomEmployees = [], defaultProjectId, defaultModel, defaultPermissionMode, resumable } = props;
  const roomProjects = useMemo(() => (room ? projects.filter(p => p.roomId === room.id) : projects), [projects, room]);
  const otherProjects = useMemo(() => (room ? projects.filter(p => p.roomId !== room.id) : []), [projects, room]);
  const [mode, setMode] = useState<'new' | 'resume'>('new');
  const [employeeId, setEmployeeId] = useState<string>('');
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState<string | null>(defaultModel);
  const [perm, setPerm] = useState<PermissionModeOption>(defaultPermissionMode);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [resumeId, setResumeId] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('new');
    setEmployeeId(employee?.id ?? roomEmployees[0]?.id ?? '');
    setProjectId(defaultProjectId ?? roomProjects[0]?.id ?? otherProjects[0]?.id ?? '');
    setName('');
    setModel(employee?.model ?? defaultModel);
    setPerm(employee?.permissionMode ?? defaultPermissionMode);
    setProfileId(employee?.profileId ?? room?.profiles[0]?.id ?? null);
    setResumeId(resumable[0]?.id ?? '');
  }, [open, employee, roomEmployees, defaultProjectId, defaultModel, defaultPermissionMode, room, roomProjects, otherProjects, resumable]);

  const canCreate = projectId !== '';
  const who = employee ?? roomEmployees.find(e => e.id === employeeId) ?? null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'resume') { if (resumeId) props.onResume(resumeId); return; }
    if (!canCreate) return;
    props.onCreate({ projectId, employeeId: who?.id ?? null, name: name.trim() || `Conversa ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`, model, permissionMode: perm, profileId });
  };

  const title = employee ? `Nova conversa de ${employee.name}` : room ? `Nova conversa em ${room.name}` : 'Nova conversa';

  return (
    <Modal open={open} title={title} onCancel={props.onCancel}>
      <form onSubmit={submit} className="hq-form">
        {resumable.length > 0 && (
          <div className="hq-segment" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'new'} className={mode === 'new' ? 'hq-segment__on' : ''} onClick={() => setMode('new')}>Nova</button>
            <button type="button" role="tab" aria-selected={mode === 'resume'} className={mode === 'resume' ? 'hq-segment__on' : ''} onClick={() => setMode('resume')}>Retomar pausada ({resumable.length})</button>
          </div>
        )}
        {mode === 'new' ? (
          <>
            {!employee && (
              <Field label="Funcionário" hint={roomEmployees.length === 0 ? 'A sala ainda não tem ninguém: um funcionário novo é contratado com nome sorteado.' : 'Ou contrate um novo (nome sorteado).'}>
                <select className="hq-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
                  {roomEmployees.map(e => <option key={e.id} value={e.id}>{e.name} · {e.role}{e.activeSessionId ? ' (já tem conversa aberta)' : ''}</option>)}
                  <option value="">Novo funcionário</option>
                </select>
              </Field>
            )}
            {who?.activeSessionId && <div className="hq-notice hq-notice--info">{who.name} já tem uma conversa aberta. A nova vira a conversa ativa; a anterior fica guardada no seletor do painel.</div>}
            <Field label="Projeto" hint={roomProjects.length === 0 && otherProjects.length === 0 ? 'Nenhum projeto cadastrado ainda.' : 'Pasta real onde o funcionário vai trabalhar.'}>
              <select className="hq-input" value={projectId} onChange={e => setProjectId(e.target.value)} required>
                {roomProjects.length === 0 && otherProjects.length === 0 && <option value="">— nenhum —</option>}
                {roomProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                {otherProjects.length > 0 && <optgroup label="Projetos de outras salas">{otherProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
              </select>
            </Field>
            <button type="button" className="hq-linkbtn" onClick={props.onAddProject}>+ Adicionar projeto</button>
            <Field label="Nome da conversa" hint="Aparece no seletor e no --name do Claude Code.">
              <input className="hq-input" value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Landing turismo" />
            </Field>
            <div className="hq-form__row">
              <Field label="Modelo">
                <select className="hq-input" value={model ?? ''} onChange={e => setModel(e.target.value || null)}>
                  {MODEL_OPTIONS.map(o => <option key={o.value ?? 'default'} value={o.value ?? ''}>{o.label}</option>)}
                </select>
              </Field>
              <Field label="Modo de permissão">
                <select className="hq-input" value={perm} onChange={e => setPerm(e.target.value as PermissionModeOption)}>
                  {PERMISSION_MODE_OPTIONS.map(m => <option key={m} value={m}>{PERMISSION_MODE_LABELS[m]}</option>)}
                </select>
              </Field>
            </div>
            {room && room.profiles.length > 0 && (
              <Field label="Perfil editorial" hint="Vale para esta conversa desde a primeira mensagem.">
                <select className="hq-input" value={profileId ?? ''} onChange={e => setProfileId(e.target.value || null)}>
                  <option value="">Sem perfil</option>
                  {room.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            )}
          </>
        ) : (
          <Field label="Conversa pausada" hint="Vira a conversa ativa do funcionário e continua com o mesmo histórico (--resume).">
            <select className="hq-input" value={resumeId} onChange={e => setResumeId(e.target.value)}>
              {resumable.map(s => <option key={s.id} value={s.id}>{s.name} · {sessionStatusLabel(s.status)}</option>)}
            </select>
          </Field>
        )}
        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn hq-btn--ghost" onClick={props.onCancel}>Cancelar</button>
          <button type="submit" className="hq-btn hq-btn--primary" disabled={mode === 'new' ? !canCreate : !resumeId}>{mode === 'new' ? 'Abrir conversa' : 'Retomar'}</button>
        </div>
      </form>
    </Modal>
  );
}
