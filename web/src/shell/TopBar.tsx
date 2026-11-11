// Cabeçalho discreto: MilWeb HQ, sala atual (navegador de salas), perfil editorial, ÚNICO indicador de conexão, busca e ajustes.
import { useEffect, useRef } from 'react';
import type { Project, Room, ServerInfo } from '@milweb-hq/protocol';
import type { ConnectionState } from '../state/client';
import { cleanClaudeVersion, formatClock } from '../panel/helpers';
import { IconSettings } from '../panel/icons';

export interface RoomNavItem { id: string; label: string; hint?: string; color?: string; on?: boolean }

export interface TopBarProps {
  connection: ConnectionState;
  lastSnapshotAt: number | null;
  serverInfo: ServerInfo | null;
  room: Room | null;
  project?: Project | null;
  onReconnect(): void;
  onOpenProjects?(): void;
  onOpenDirection(): void;
  /** Modo ausente (v4): estado salvo no servidor; o botão abre o diálogo. Ausente = sem botão. */
  absence?: { enabled: boolean; projects: number } | null;
  onOpenAbsence?(): void;
  /** Mesa do Chefe: itens novos na caixa de entrada (entregas, perguntas, bloqueios). Ausente = sem botão. */
  desk?: { count: number } | null;
  onOpenDesk?(): void;
  /** Marco 1: busca rápida (Ctrl+K). */
  onOpenSearch?(): void;
  /** Sala Social Media: navegador de salas (substitui o botão de projeto em foco). A porta da sala também abre este menu. */
  roomNav?: { current: string; color?: string; items: RoomNavItem[]; open: boolean; onOpenChange(open: boolean): void; onPick(id: string): void };
  /** Perfil editorial ativo (Aurora, Tuco Dev): vale para o mural, a mesa do Chefe e as tarefas novas. */
  profiles?: { id: string; name: string }[];
  profileId?: string | null;
  onProfile?(id: string): void;
  onOpenSettings?(): void;
  /** Destinos sociais prontos: conectados pela API ou com a conta confirmada (separado da conexão com o serviço da HQ). */
  social?: { connected: number; total: number; summary?: string } | null;
  onOpenSocial?(): void;
}

export function connectionLabel(c: ConnectionState, lastSnapshotAt: number | null): string {
  if (c === 'open') return 'HQ online';
  if (c === 'connecting') return 'Conectando…';
  if (c === 'unauthorized') return 'Token recusado';
  return lastSnapshotAt ? `Desconectado · último estado às ${formatClock(lastSnapshotAt)}` : 'Desconectado';
}

function RoomMenu({ nav }: { nav: NonNullable<TopBarProps['roomNav']> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!nav.open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) nav.onOpenChange(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); nav.onOpenChange(false); } };
    document.addEventListener('pointerdown', onDown); window.addEventListener('keydown', onKey, true);
    // foco no primeiro item quando o menu abre (também pela porta da sala)
    ref.current?.querySelector<HTMLButtonElement>('.hq-roomnav__item')?.focus();
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [nav.open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="hq-roomnav" ref={ref}>
      <button type="button" className="hq-roomnav__btn" aria-haspopup="menu" aria-expanded={nav.open} onClick={() => nav.onOpenChange(!nav.open)} title="Trocar de sala">
        <span className="hq-room__dot" style={{ ['--room' as string]: nav.color ?? 'var(--amber)' }} />
        <strong>{nav.current}</strong> <span className="hq-dim" aria-hidden="true">▾</span>
      </button>
      {nav.open && (
        <div className="hq-roomnav__menu" role="menu" aria-label="Salas">
          {nav.items.map(it => (
            <button key={it.id} type="button" role="menuitem" className={`hq-roomnav__item${it.on ? ' hq-roomnav__item--on' : ''}`} onClick={() => { nav.onOpenChange(false); nav.onPick(it.id); }}>
              <span className="hq-room__dot" style={{ ['--room' as string]: it.color ?? 'var(--text-faint)' }} />
              <span>{it.label}{it.hint && <span className="hq-dim hq-roomnav__hint">{it.hint}</span>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopBar({ connection, lastSnapshotAt, serverInfo, room, project, onReconnect, onOpenProjects, onOpenDirection, absence, onOpenAbsence, onOpenSearch, roomNav, profiles, profileId, onProfile, onOpenSettings, social, onOpenSocial, desk, onOpenDesk }: TopBarProps) {
  const on = connection === 'open';
  return (
    <header className="hq-top" role="banner">
      <div className="hq-top__brand"><span className="pixel hq-top__logo">MilWeb HQ</span></div>
      <div className="hq-top__context">
        {roomNav ? <RoomMenu nav={roomNav} /> : (
          <>
            {room && <span className="hq-chip hq-chip--room" style={{ ['--room' as string]: room.color, marginLeft: 0 }}>{room.name}</span>}
            {onOpenProjects && (
              <button type="button" className="hq-top__project" onClick={onOpenProjects} title={project ? project.path : 'Ver projetos'}>
                {project ? <><span className="hq-dim">Projeto</span> <strong>{project.name}</strong></> : <span className="hq-dim">Nenhum projeto em foco</span>}
              </button>
            )}
          </>
        )}
        {profiles && profiles.length > 0 && onProfile && (
          <label className="hq-top__profile" title="Perfil editorial: organiza o mural e a mesa do Chefe e vai junto com as tarefas novas">
            <span className="hq-dim">Perfil</span>
            <select className="hq-select" value={profileId ?? ''} onChange={e => onProfile(e.target.value)} aria-label="Perfil editorial">
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className={`hq-conn ${on ? 'hq-conn--on' : connection === 'connecting' ? 'hq-conn--wait' : 'hq-conn--off'}`} role="status" aria-live="polite" title={on ? `Serviço local v${serverInfo?.version ?? '?'} · Claude Code ${cleanClaudeVersion(serverInfo?.claudeVersion)}` : 'Sem conexão com o serviço local'}>
        <span className="hq-conn__dot" />
        <span>{connectionLabel(connection, lastSnapshotAt)}</span>
        {!on && connection !== 'connecting' && connection !== 'unauthorized' && <button type="button" className="hq-linkbtn" onClick={onReconnect}>Reconectar agora</button>}
      </div>
      {social && onOpenSocial && (
        <button type="button" className={`hq-top__social${social.connected === social.total ? ' hq-top__social--all' : ''}`} onClick={onOpenSocial} title="Central de Redes: cadastradas = contas informadas por você; verificadas = acesso validado com a identidade conferida">
          Redes: {social.summary ?? `${social.connected}/${social.total} verificadas`}
        </button>
      )}
      <span className="hq-top__spacer" />
      {onOpenSearch && <button type="button" className="hq-top__search" onClick={onOpenSearch} title="Projetos, arquivos, funcionários, skills, reuniões, lixeira e ações">Buscar… <kbd>Ctrl K</kbd></button>}
      {absence && onOpenAbsence && (
        <button type="button" className={`hq-top__away${absence.enabled ? ' hq-top__away--on' : ''}`} onClick={onOpenAbsence} aria-pressed={absence.enabled}
          title={absence.enabled ? `Modo ausente ligado: só continua o que você autorizou (${absence.projects} projeto(s)). Clique para ver ou desligar.` : 'Vou sair: escolha o que pode continuar sem você (Modo ausente)'}>
          {absence.enabled ? 'Modo ausente ligado' : 'Vou sair'}
        </button>
      )}
        {desk && onOpenDesk && (
          <button type="button" className={`hq-top__desk${desk.count ? ' hq-top__desk--on' : ''}`} onClick={onOpenDesk} title={desk.count ? `${desk.count} item(ns) na sua mesa: entregas novas, perguntas e bloqueios` : 'Sua mesa: entregas, perguntas e bloqueios'}>
            Mesa{desk.count > 0 && <span className="hq-top__desk-count">{desk.count}</span>}
          </button>
        )}
      {serverInfo && serverInfo.authOk === false && <span className="hq-tag hq-tag--danger" title={serverInfo.authDetail ?? ''}>Claude Code sem login</span>}
      {onOpenSettings && <button type="button" className="hq-iconbtn" onClick={onOpenSettings} aria-label="Ajustes" title="Ajustes: geral, conexões com IA e dados"><IconSettings size={16} /></button>}
      <button type="button" className="hq-top__me" onClick={onOpenDirection} title="Ir para a Diretoria (visão geral da empresa)">
        <span className="hq-avatar hq-avatar--me" aria-hidden="true" />
        <span><strong>Chefe</strong></span>
      </button>
    </header>
  );
}
