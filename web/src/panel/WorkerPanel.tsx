// Painel lateral do funcionário: identidade (nome, função), seletor de conversas, projeto alvo, abas e conteúdo.
// Redimensionável pela borda esquerda; recolhível numa faixa estreita.
import { useCallback, useRef, useState } from 'react';
import type { PanelTab, WorkerPanelProps } from './types';
import { ActivityTimeline } from './ActivityTimeline';
import { ChatView } from './ChatView';
import { Composer } from './Composer';
import { DeliverablesPanel } from './DeliverablesPanel';
import { FilesPanel } from './FilesPanel';
import { EFFORT_LABELS } from '@milweb-hq/protocol';
import { PERMISSION_MODE_LABELS, basename, modelLabel, phaseColor, phaseLabel, sessionStatusLabel, workerStatusColor, workerStatusLabel } from './helpers';
import { IconChevron, IconEdit, IconEye, IconX } from './icons';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

const MIN_W = 440, MAX_W = 760, DEFAULT_W = 500;

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'activity', label: 'Atividade' },
  { id: 'files', label: 'Arquivos' },
  { id: 'deliveries', label: 'Tarefas' },
  { id: 'terminal', label: 'Terminal' },
];

const STATUS_CLS = { new: 'hq-tag--info', active: 'hq-tag--ok', paused: '', observed: 'hq-tag--amber', lost: 'hq-tag--danger', archived: '' } as const;

export function WorkerPanel(props: WorkerPanelProps) {
  const { worker, session, employee, conversations = [], tab, onTab } = props;
  const [width, setWidth] = useState(DEFAULT_W);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: e.clientX, startW: width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [width]);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setWidth(Math.min(MAX_W, Math.max(MIN_W, d.startW + (d.startX - e.clientX))));
  }, []);
  const onPointerUp = useCallback(() => { dragRef.current = null; }, []);

  const project = props.composer.project;
  const pendingCount = props.chat.pending.length;
  const status = session?.status ?? null;
  const observed = session ? !session.controllable : false;
  const name = employee?.name ?? worker?.name ?? session?.name ?? 'Nenhum funcionário';
  const role = employee?.role ?? worker?.role ?? (observed ? 'Sessão externa' : '');

  return (
    <aside className="hq-panel" style={{ width }} aria-label={`Painel de ${name}`}>
      <div
        className="hq-panel__grip" role="separator" aria-orientation="vertical" aria-label="Redimensionar painel" tabIndex={0}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onKeyDown={e => { if (e.key === 'ArrowLeft') setWidth(w => Math.min(MAX_W, w + 20)); if (e.key === 'ArrowRight') setWidth(w => Math.max(MIN_W, w - 20)); }}
      />

      <header className="hq-panel__head">
        <div className="hq-panel__who">
          <span className="hq-panel__phase" style={{ background: worker ? workerStatusColor(worker.status) : phaseColor(null) }} title={workerStatusLabel(worker?.status)} />
          <div className="hq-panel__names">
            <div className="hq-panel__name">
              {name}
              {role && <span className="hq-panel__role">{role}</span>}
              {observed && <IconEye size={14} title="Sessão observada" className="hq-panel__eye" />}
            </div>
            {/* Linha de status como no WhatsApp ("digitando…"): o que ele está fazendo agora; o projeto fica em "Mais". */}
            <div className="hq-panel__project" title={project ? `${project.name} · ${project.path}` : ''}>
              {worker && session ? <span style={{ color: phaseColor(worker.phase) }}>{phaseLabel(worker.phase)}{worker.detail && worker.detail !== phaseLabel(worker.phase) ? ` · ${worker.detail}` : ''}</span>
                : project ? <><span className="hq-dim">Projeto</span> <strong>{project.name}</strong></> : <span className="hq-dim">Sem projeto (abra uma conversa para escolher)</span>}
            </div>
          </div>
          {employee && props.onEditEmployee && <button type="button" className="hq-iconbtn hq-iconbtn--xs" onClick={props.onEditEmployee} aria-label={`Editar ${employee.name}`} title="Editar ou transferir"><IconEdit size={13} /></button>}
          {props.onCollapse && <button type="button" className="hq-iconbtn" onClick={props.onCollapse} aria-label="Recolher painel" title="Recolher painel"><IconChevron size={14} open={false} /></button>}
          <button type="button" className="hq-iconbtn" onClick={props.onClose} aria-label="Fechar painel" title="Fechar painel"><IconX size={16} /></button>
        </div>

        <details className="hq-panel__more">
          <summary>
            <span className="hq-label">Mais</span>
            <span className="hq-dim hq-panel__moresum">conversa, configuração e processo{session ? ` · ${sessionStatusLabel(session.status)}` : ''}</span>
          </summary>
        {project && <div className="hq-panel__project hq-panel__project--more" title={project.path}><span className="hq-dim">Projeto</span> <strong>{project.name}</strong> <span className="hq-mono hq-dim">{basename(project.path)}</span></div>}
        {employee && (
          <div className="hq-panel__convs">
            <label className="hq-select hq-select--grow">
              <span className="sr-only">Conversa</span>
              <select value={employee.activeSessionId ?? ''} onChange={e => props.onSelectConversation?.(e.target.value)} aria-label="Conversa ativa" disabled={!props.onSelectConversation}>
                {!employee.activeSessionId && <option value="">Sem conversa aberta</option>}
                {conversations.map(s => <option key={s.id} value={s.id}>{s.name} · {sessionStatusLabel(s.status)}</option>)}
              </select>
            </label>
            {props.onGiveTask && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={props.onGiveTask} title="Preenche o pedido na base da tela com este funcionário">Dar tarefa</button>}
            {props.onPrivateChat && <button type="button" className="hq-btn hq-btn--sm" onClick={props.onPrivateChat} title="Conversa só entre vocês dois: não vai para o mural nem para a fila de tarefas">Conversa particular</button>}
            {props.onNewConversation && <button type="button" className="hq-btn hq-btn--sm" onClick={props.onNewConversation} title="Abre outra conversa deste funcionário (as anteriores ficam guardadas)">Nova conversa</button>}
          </div>
        )}

        {employee && (
          // Configuração do funcionário num só lugar (vale para conversas novas; a conversa aberta mostra o que está em uso).
          <details className="hq-panel__config">
            <summary>
              <span className="hq-label">Configuração</span>
              <span className="hq-dim hq-panel__configsum">{employee.provider === 'openai' ? 'OpenAI (Codex)' : 'Claude'} · {employee.model ? modelLabel(employee.model) : 'modelo padrão'} · esforço {employee.effort ? EFFORT_LABELS[employee.effort] ?? employee.effort : 'padrão'}</span>
            </summary>
            <dl className="hq-panel__configgrid">
              <dt>Função</dt><dd>{employee.role || <span className="hq-dim">sem função</span>}</dd>
              <dt>Provedor</dt><dd>{employee.provider === 'openai' ? 'OpenAI (Codex)' : 'Claude (Claude Code)'}</dd>
              <dt>Modelo</dt><dd>{employee.model ? modelLabel(employee.model) : <span className="hq-dim">padrão global</span>}</dd>
              <dt>Esforço</dt><dd>{employee.effort ? EFFORT_LABELS[employee.effort] ?? employee.effort : <span className="hq-dim">padrão</span>}</dd>
              <dt>Skills</dt><dd>{employee.skills.length ? employee.skills.map(sk => <span key={sk} className="hq-chip hq-chip--xs">/{sk}</span>) : <span className="hq-dim">nenhuma preferida (escolha por tarefa)</span>}</dd>
              <dt>Permissões</dt><dd>{PERMISSION_MODE_LABELS[employee.permissionMode] ?? employee.permissionMode}</dd>
              {props.composer.profiles.length > 0 && <><dt>Perfil</dt><dd>{props.composer.profiles.find(p => p.id === employee.profileId)?.name ?? <span className="hq-dim">nenhum padrão</span>}</dd></>}
              <dt>Acessos</dt><dd>{employee.access?.mcp === 'inherit' ? 'herda os servidores MCP da sua conta' : 'nenhum servidor MCP'} · GitHub, git push e Vercel bloqueados</dd>
            </dl>
            {props.onEditEmployee && <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm" onClick={props.onEditEmployee}><IconEdit size={12} /> Editar</button><span className="hq-dim hq-panel__confignote">Mudanças valem para conversas novas.</span></div>}
          </details>
        )}

        <div className="hq-panel__session">
          {session ? (
            <>
              <span className={cx('hq-tag', STATUS_CLS[session.status])}>{sessionStatusLabel(session.status)}</span>
              <span className="hq-dim hq-panel__model">{modelLabel(session.model)}</span>
              {worker && <span className="hq-panel__detail" style={{ color: phaseColor(worker.phase) }}>{phaseLabel(worker.phase)}{worker.detail && worker.detail !== phaseLabel(worker.phase) ? ` · ${worker.detail}` : ''}</span>}
              {session.lastError && <span className="hq-tag hq-tag--danger" title={session.lastError}>erro</span>}
            </>
          ) : <span className="hq-dim">{employee ? 'Este funcionário está disponível: nenhuma conversa aberta, nenhum processo rodando.' : 'Selecione um funcionário.'}</span>}
          {employee && (
            <span className="hq-tag hq-tag--xs" title={`Acessos: ${employee.access?.mcp === 'inherit' ? 'herda todos os servidores MCP da sua conta' : 'nenhum servidor MCP'}. GitHub, git push e Vercel bloqueados (sem credenciais e com regra de negação). Editar o funcionário para mudar.`}>
              {employee.access?.mcp === 'inherit' ? 'MCP herdado' : 'sem MCP'} · integrações bloqueadas
            </span>
          )}
          <span className="hq-panel__spacer" />
          {session && session.controllable && status === 'active' && (
            <button type="button" className="hq-btn hq-btn--sm hq-btn--danger" onClick={props.onCloseSession} title="Encerra o processo; a conversa pode ser retomada depois">Fechar processo</button>
          )}
          {session && session.controllable && (status === 'paused' || status === 'lost' || status === 'new') && (
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={props.onResumeSession}>{status === 'new' ? 'Iniciar' : 'Retomar'}</button>
          )}
          {session && status !== 'archived' && status !== 'active' && session.controllable && (
            <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={props.onArchiveSession} title="Guarda a conversa; o funcionário continua na sala">Arquivar conversa</button>
          )}
          {!session && employee && props.onNewConversation && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={props.onNewConversation}>Abrir conversa</button>}
        </div>
        </details>
      </header>

      <div className="hq-tabs" role="tablist" aria-label="Seções do painel">
        {TABS.map(t => (
          <button
            key={t.id} type="button" role="tab" id={`hq-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`hq-tabpanel-${t.id}`}
            className={cx('hq-tab', tab === t.id && 'hq-tab--on')} onClick={() => onTab(t.id)}
          >
            {t.label}
            {t.id === 'chat' && pendingCount > 0 && <span className="hq-tab__badge" title="Pendências esperando você">{pendingCount}</span>}
          </button>
        ))}
      </div>

      <div className="hq-panel__body" role="tabpanel" id={`hq-tabpanel-${tab}`} aria-labelledby={`hq-tab-${tab}`}>
        {tab === 'chat' && (
          <div className="hq-chatwrap">
            {session ? <ChatView {...props.chat} /> : (
              <div className="hq-empty hq-empty--tall">
                <p>{employee ? `${employee.name} ainda não tem conversa aberta.` : 'Sem conversa.'}</p>
                <p className="hq-dim">Abrir uma conversa escolhe o projeto (pasta real) e só inicia o Claude Code na primeira mensagem.</p>
                {employee && props.onNewConversation && <button type="button" className="hq-btn hq-btn--primary" onClick={props.onNewConversation}>Abrir conversa</button>}
              </div>
            )}
            <Composer {...props.composer} />
          </div>
        )}
        {tab === 'activity' && <ActivityTimeline {...props.timeline} />}
        {tab === 'files' && <FilesPanel {...props.files} />}
        {tab === 'deliveries' && <DeliverablesPanel {...props.deliveries} />}
        {tab === 'terminal' && (props.terminal ?? (
          <div className="hq-empty hq-empty--tall">
            <p>Terminal integrado não faz parte desta versão.</p>
            <p className="hq-dim">A aba Atividade mostra cada comando executado e o resultado.</p>
          </div>
        ))}
      </div>
    </aside>
  );
}
