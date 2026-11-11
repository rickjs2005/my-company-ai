// Primeiro uso: três passos (conectar IA, cadastrar projeto, contratar funcionário). O progresso é lido do estado real
// (provedores, projetos, funcionários), nunca de um checklist fictício. Cada passo abre a tela certa; "Concluir" grava
// settings.onboardingDone para não aparecer de novo.
import type { AiProviderStatus, Employee, Project } from '@milweb-hq/protocol';
import { Modal } from '../panel/dialogs/Modal';
import { IconCheck } from '../panel/icons';

export interface OnboardingDialogProps {
  open: boolean;
  ai: AiProviderStatus[];
  projects: Project[];
  employees: Employee[];
  onOpenConnections(): void;
  onAddProject(): void;
  onHire(): void;
  /** Grava onboardingDone = true (não mostra mais). */
  onFinish(): void;
  /** Esconde só nesta sessão. */
  onLater(): void;
}

export function onboardingSteps(ai: AiProviderStatus[], projects: Project[], employees: Employee[]): { ai: boolean; project: boolean; employee: boolean } {
  return {
    ai: ai.some(s => s.installed && s.authState === 'ok'),
    project: projects.some(p => !p.id.startsWith('ext:')),
    employee: employees.some(e => !e.archivedAt),
  };
}

export function OnboardingDialog(props: OnboardingDialogProps) {
  const done = onboardingSteps(props.ai, props.projects, props.employees);
  const all = done.ai && done.project && done.employee;
  const connected = props.ai.filter(s => s.installed && s.authState === 'ok').map(s => s.label);
  const steps: { key: keyof typeof done; title: string; detail: string; action: string; run(): void }[] = [
    { key: 'ai', title: 'Conectar uma IA', detail: done.ai ? `Conectado: ${connected.join(' e ')}.` : 'Claude (Claude Code) ou OpenAI (ChatGPT via Codex). Sem IA conectada, as tarefas ficam na fila.', action: 'Abrir Conexões', run: props.onOpenConnections },
    { key: 'project', title: 'Cadastrar um projeto', detail: done.project ? `${props.projects.filter(p => !p.id.startsWith('ext:')).length} projeto(s) cadastrado(s).` : 'Uma pasta real do seu computador. É nela que o funcionário vai trabalhar.', action: 'Cadastrar pasta', run: props.onAddProject },
    { key: 'employee', title: 'Contratar o primeiro funcionário', detail: done.employee ? `${props.employees.filter(e => !e.archivedAt).length} funcionário(s) na empresa.` : 'Um perfil persistente (nome, função, sala, provedor). Contratar não inicia nenhum processo.', action: 'Contratar funcionário', run: props.onHire },
  ];
  return (
    <Modal open={props.open} title="Bem-vindo à MilWeb HQ" onCancel={props.onLater} width={560}>
      <p className="hq-dim" style={{ marginTop: 0 }}>Três passos para a empresa funcionar. O andamento abaixo vem do estado real da HQ; cada botão abre a tela certa sem perder o que você já escreveu.</p>
      <ol className="hq-onboard">
        {steps.map((s, i) => (
          <li key={s.key} className={`hq-onboard__step${done[s.key] ? ' hq-onboard__step--done' : ''}`}>
            <span className="hq-onboard__num" aria-hidden="true">{done[s.key] ? <IconCheck size={13} /> : i + 1}</span>
            <div className="hq-onboard__body">
              <strong>{s.title}</strong>
              <span className="hq-dim">{s.detail}</span>
            </div>
            <button type="button" className={`hq-btn hq-btn--sm${done[s.key] ? ' hq-btn--ghost' : ' hq-btn--primary'}`} onClick={s.run}>{s.action}</button>
          </li>
        ))}
      </ol>
      <p className="hq-dim" style={{ fontSize: 12.5 }}>Depois disso, escreva o pedido em <strong>“O que vamos fazer?”</strong> (base da tela), escolha projeto e funcionário e clique em <strong>Executar tarefa</strong>.</p>
      <div className="hq-actions hq-actions--end">
        <button type="button" className="hq-btn" onClick={props.onLater}>Fazer depois</button>
        <button type="button" className={`hq-btn${all ? ' hq-btn--primary' : ''}`} onClick={props.onFinish} title={all ? 'Tudo pronto: não mostrar de novo' : 'Não mostrar de novo (dá para fazer os passos pelas telas normais)'}>{all ? 'Concluir' : 'Não mostrar de novo'}</button>
      </div>
    </Modal>
  );
}
