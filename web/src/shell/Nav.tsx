// Navegação lateral compacta: Conteúdo (a porta de entrada desde 05/11), Empresa, Equipe, Arquivos e Ajustes. O resto (Reuniões, Projetos, Rotinas, Skills, Lixeira)
// fica no Ctrl+K e nos objetos da sala; a vista continua existindo, só saiu do menu.
import type { ReactNode } from 'react';
import { IconFolder, IconSettings } from '../panel/icons';

export type MainView = 'conteudo' | 'office' | 'team' | 'meetings' | 'projects' | 'routines' | 'skills' | 'files' | 'trash';

export interface NavProps {
  view: MainView;
  onView(view: MainView): void;
  onOpenSettings(): void;
  /** Contadores reais: pendências esperando o Chefe e itens na lixeira (null = desconhecido). */
  waiting: number;
  trashCount: number | null;
  /** Reuniões em andamento (turno real de algum participante); 0 = nenhuma. */
  meetingsActive?: number;
  /** Tarefas "resultado a conferir" + em espera aguardando o Chefe (selo em Equipe junto com as permissões). */
  attention?: number;
}

const ITEMS: { id: MainView; label: string; icon: ReactNode; title: string; also?: MainView[] }[] = [
  { id: 'conteudo', label: 'Gestão', title: 'Gestão: pedidos, peças, responsáveis, filas e aprovações (os mesmos dados do escritório)', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M10 8.5v7l6-3.5z" /></svg> },
  { id: 'office', label: 'Escritório', title: 'Escritório 3D: a equipe trabalhando, a sua mesa, o mural, o arquivo e o estúdio', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 21V8l9-5 9 5v13" /><path d="M9 21v-6h6v6" /><path d="M7 11h2M15 11h2M7 15h2M15 15h2" /></svg> },
  { id: 'team', label: 'Equipe', title: 'Funcionários: identidade, sala e estado real', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.4" /><path d="M15.5 14.2c2.9.3 5 2.7 5 5.8" /></svg> },
  { id: 'files', label: 'Arquivos', title: 'Explorador de arquivos (disco real)', icon: <IconFolder size={18} />, also: ['trash'] },
];

export function Nav({ view, onView, onOpenSettings, waiting, trashCount, meetingsActive = 0, attention = 0 }: NavProps) {
  const teamBadge = waiting + attention;
  return (
    <nav className="hq-nav" aria-label="Navegação principal">
      <div className="hq-nav__brand" title="MilWeb HQ"><span className="pixel">HQ</span></div>
      <ul className="hq-nav__list">
        {ITEMS.map(it => {
          const on = view === it.id || Boolean(it.also?.includes(view));
          return (
            <li key={it.id}>
              <button type="button" className={`hq-nav__item${on ? ' hq-nav__item--on' : ''}`} onClick={() => onView(it.id)} aria-current={on ? 'page' : undefined} title={it.title}>
                <span className="hq-nav__icon">{it.icon}</span>
                <span className="hq-nav__label">{it.label}</span>
                {it.id === 'team' && teamBadge > 0 && <span className="hq-nav__badge" title={`${waiting} pedido(s) de permissão/pergunta esperando você${attention ? ` · ${attention} tarefa(s) para conferir ou liberar` : ''}`}>{teamBadge}</span>}
                {it.id === 'office' && meetingsActive > 0 && <span className="hq-nav__badge" title={`${meetingsActive} reunião(ões) em andamento (mesa de reunião ou Ctrl+K → Reuniões)`}>{meetingsActive}</span>}
                {it.id === 'files' && trashCount != null && trashCount > 0 && <span className="hq-nav__badge hq-nav__badge--dim" title={`${trashCount} item(ns) na lixeira da HQ (Ctrl+K → Lixeira)`}>{trashCount}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <span className="hq-nav__spacer" />
      <button type="button" className="hq-nav__item hq-nav__item--foot" onClick={onOpenSettings} title="Ajustes: geral, conexões com IA e dados"><span className="hq-nav__icon"><IconSettings size={18} /></span><span className="hq-nav__label">Ajustes</span></button>
    </nav>
  );
}
