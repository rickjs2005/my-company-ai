// "Adicionar skill local": valida uma pasta de skill (SKILL.md) no servidor SEM copiar nada, mostra o que seria copiado
// e o manual bruto para o Chefe ler, e só então copia para ~/.claude/skills/<nome> (pessoal) ou <projeto>/.claude/skills/<nome>.
// Nada é executado em nenhuma etapa; comandos de shell embutidos são só avisados.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Project, SkillAddResult, SkillInspection } from '@milweb-hq/protocol';
import { Field, Modal } from '../panel/dialogs/Modal';
import { formatBytes } from '../panel/helpers';
import '../styles/skills.css';

export interface AddSkillDialogProps {
  open: boolean;
  projects: Project[];
  defaultProjectId: string | null;
  /** Valida a pasta (ou o SKILL.md) sem copiar nada. */
  onInspect(path: string): Promise<SkillInspection>;
  /** Copia a skill validada para o destino escolhido. */
  onAdd(path: string, scope: 'personal' | 'project', projectId: string | null): Promise<SkillAddResult>;
  onDone(result: SkillAddResult): void;
  onCancel(): void;
}

type Scope = 'personal' | 'project';

function errorText(err: unknown): string { return err instanceof Error ? err.message : String(err); }

export function AddSkillDialog(props: AddSkillDialogProps) {
  const { open, defaultProjectId } = props;
  const [path, setPath] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<SkillInspection | null>(null);
  const [scope, setScope] = useState<Scope>(defaultProjectId ? 'project' : 'personal');
  const [projectId, setProjectId] = useState<string | null>(defaultProjectId);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const realProjects = props.projects.filter(p => !p.id.startsWith('ext:'));

  // Abriu de novo: começa do zero (caminho, prévia, erros e escopo). Só reage a `open`: o projeto padrão é lido na abertura
  // e não zera o formulário se mudar enquanto o diálogo está aberto.
  useEffect(() => {
    if (!open) return;
    setPath(''); setInspecting(false); setInspectError(null); setInspection(null);
    setScope(defaultProjectId ? 'project' : 'personal'); setProjectId(defaultProjectId);
    setAdding(false); setAddError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const inspect = async (e?: FormEvent) => {
    e?.preventDefault();
    const p = path.trim();
    if (!p || inspecting) return;
    setInspecting(true); setInspectError(null); setInspection(null); setAddError(null);
    try { setInspection(await props.onInspect(p)); }
    catch (err) { setInspectError(errorText(err)); }
    finally { setInspecting(false); }
  };

  const effectiveProjectId = scope === 'project' ? (projectId && realProjects.some(p => p.id === projectId) ? projectId : realProjects[0]?.id ?? null) : null;
  const canAdd = inspection?.ok === true && !adding && (scope === 'personal' || effectiveProjectId != null);

  const add = async () => {
    if (!inspection || !canAdd) return;
    setAdding(true); setAddError(null);
    try {
      const result = await props.onAdd(inspection.sourceDir, scope, effectiveProjectId);
      props.onDone(result);
    } catch (err) {
      setAddError(errorText(err));
    } finally {
      setAdding(false);
    }
  };

  const projectName = effectiveProjectId ? realProjects.find(p => p.id === effectiveProjectId)?.name ?? null : null;
  const destinationHint = inspection
    ? scope === 'personal'
      ? `Será copiada para ~/.claude/skills/${inspection.name || '<nome>'} (vale em todos os projetos).`
      : projectName
        ? `Será copiada para a pasta do projeto ${projectName}, em .claude/skills/${inspection.name || '<nome>'}.`
        : 'Escolha um projeto para saber o destino.'
    : null;

  return (
    <Modal open={open} title="Adicionar skill local" onCancel={props.onCancel} width={640}>
      <div className="hq-skills-add">
        <form className="hq-skills-add__row" onSubmit={inspect}>
          <Field label="Pasta da skill (a que contém o SKILL.md)" hint="Pode ser a pasta ou o caminho do próprio SKILL.md. Nesta etapa nada é copiado nem executado.">
            <input className="hq-input hq-mono" value={path} onChange={e => setPath(e.target.value)} placeholder="C:\caminho\da\minha-skill" autoFocus disabled={inspecting} />
          </Field>
          <button type="submit" className="hq-btn" disabled={!path.trim() || inspecting}>{inspecting ? 'Validando…' : 'Validar'}</button>
        </form>

        {inspectError && <div className="hq-notice hq-notice--error" role="alert">não foi possível validar: {inspectError}</div>}

        {inspection && (
          <>
            <div className="hq-skills-add__summary">
              <h3>{inspection.name || <span className="hq-dim">(sem nome no frontmatter)</span>}</h3>
              {inspection.description ? <p style={{ margin: 0, fontSize: 13 }}>{inspection.description}</p> : <p className="hq-dim" style={{ margin: 0 }}>Sem descrição.</p>}
              <div className="hq-dim" style={{ fontSize: 12 }}>Pasta de origem: <span className="hq-mono">{inspection.sourceDir}</span></div>
              <div style={{ fontSize: 12.5 }}>
                <strong>{inspection.files.length} arquivo{inspection.files.length === 1 ? '' : 's'}</strong> a copiar{inspection.totalBytes > 0 ? ` · ${formatBytes(inspection.totalBytes)}` : ''}
              </div>
              {inspection.files.length > 0 && (
                <ul className="hq-skills-add__files">
                  {inspection.files.map(f => <li key={f} className="hq-mono">{f}</li>)}
                </ul>
              )}
              {inspection.problems.map((p, i) => (
                <div key={i} className={`hq-notice ${inspection.ok ? 'hq-notice--warn' : 'hq-notice--error'}`}>{p}</div>
              ))}
              {!inspection.ok && inspection.problems.length === 0 && <div className="hq-notice hq-notice--error">A pasta não passou na validação, sem detalhe informado pelo servidor.</div>}
              {inspection.hasShellInjection && (
                <div className="hq-notice hq-notice--warn" role="note">Esta skill tem comandos de shell embutidos que o Claude Code executa ao ativá-la. A HQ não executou nada ao validar e não vai executar ao copiar.</div>
              )}
            </div>

            <div className="hq-field">
              <span className="hq-field__label">Leia o manual antes de adicionar</span>
              <pre className="hq-pre">{inspection.content || '(SKILL.md vazio)'}</pre>
            </div>

            <fieldset className="hq-fieldset hq-skills-add__scope">
              <legend>Onde guardar</legend>
              <label className="hq-check">
                <input type="radio" name="skill-scope" value="personal" checked={scope === 'personal'} onChange={() => setScope('personal')} />
                Pessoal (vale em todos os projetos)
              </label>
              <label className="hq-check">
                <input type="radio" name="skill-scope" value="project" checked={scope === 'project'} onChange={() => setScope('project')} disabled={realProjects.length === 0} />
                Deste projeto{realProjects.length === 0 ? <span className="hq-dim"> (nenhum projeto cadastrado)</span> : null}
              </label>
              {scope === 'project' && realProjects.length > 0 && (
                <select className="hq-input" value={effectiveProjectId ?? ''} onChange={e => setProjectId(e.target.value || null)} aria-label="Projeto de destino">
                  {realProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              {destinationHint && <span className="hq-field__hint">{destinationHint}</span>}
            </fieldset>

            {addError && <div className="hq-notice hq-notice--error" role="alert">não foi possível adicionar: {addError}</div>}
          </>
        )}

        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn hq-btn--ghost" onClick={props.onCancel} disabled={adding}>Cancelar</button>
          <button type="button" className="hq-btn hq-btn--primary" onClick={add} disabled={!canAdd}
            title={!inspection ? 'Valide a pasta primeiro' : !inspection.ok ? 'A validação encontrou problemas; corrija a skill e valide de novo' : undefined}>
            {adding ? 'Adicionando…' : 'Adicionar'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
