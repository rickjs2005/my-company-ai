// Equipes permanentes da sala Social Media (Chefe, 08/11/2026): a equipe é o perfil editorial que já existia nos cadastros
// (employee.profileId, task.profileId, item.profileId). Nada novo no banco: o vínculo é reaproveitado.
// Aurora atende Instagram Aurora + Threads Aurora; Tuco Dev atende o Instagram Tuco Dev. Coordenação, pesquisa, revisão e
// direção de vídeo são especialistas compartilhados ("apoio"): atendem as duas, e a tarefa diz de qual equipe é o trabalho.
import type { SocialSlotId } from './social.js';

export type TeamId = 'aurora' | 'tuco-dev';

export interface TeamDef {
  id: TeamId;
  label: string;
  short: string;
  /** Canais (contas) que a equipe atende. */
  slots: SocialSlotId[];
  color: string;
  focus: string;
}

export const TEAMS: TeamDef[] = [
  { id: 'aurora', label: 'Equipe Aurora', short: 'Aurora', slots: ['instagram-aurora', 'threads'], color: '#f0a830', focus: 'Trabalho, projetos, bastidores e prospecção' },
  { id: 'tuco-dev', label: 'Equipe Tuco Dev', short: 'Tuco Dev', slots: ['instagram-tuco'], color: '#8b7fe8', focus: 'Conteúdo educativo, explicações e temas de tecnologia' },
];

/** Nome do canal como o Chefe fala ("Threads Aurora", não só "Threads"). */
export const CHANNEL_LABEL: Partial<Record<SocialSlotId, string>> = {
  'instagram-aurora': 'Instagram Aurora',
  threads: 'Threads Aurora',
  'instagram-tuco': 'Instagram Tuco Dev',
};

/** Papéis que atendem as duas equipes (ficam na mesa de apoio, não numa equipe). */
export const SHARED_TEMPLATES = ['conteudo-coordenador', 'conteudo-pesquisador', 'conteudo-revisor', 'conteudo-diretor-video'];

export function isTeamId(v: unknown): v is TeamId { return v === 'aurora' || v === 'tuco-dev'; }
export function teamDef(id: TeamId): TeamDef { return TEAMS.find(t => t.id === id)!; }
/** Equipe dona de um canal; null = canal fora das duas equipes (TikTok, LinkedIn…). */
export function teamOfSlot(slot: string | null | undefined): TeamId | null {
  if (!slot) return null;
  return TEAMS.find(t => (t.slots as string[]).includes(slot))?.id ?? null;
}
/** Equipe de um funcionário: o perfil dele; sem perfil, especialista de apoio (pelo papel) ou sem equipe (atribuir). */
export function teamOfEmployee(e: { profileId?: string | null; template?: string | null }): TeamId | 'apoio' | null {
  if (isTeamId(e.profileId)) return e.profileId;
  if (e.template && SHARED_TEMPLATES.includes(e.template)) return 'apoio';
  return null;
}
/** Equipe de uma tarefa, peça ou referência: o perfil gravado; sem perfil, a equipe do canal. */
export function teamOfWork(w: { profileId?: string | null; destinationId?: string | null; slot?: string | null }): TeamId | null {
  if (isTeamId(w.profileId)) return w.profileId;
  return teamOfSlot(w.destinationId ?? w.slot ?? null);
}
/** Rótulo curto "Equipe · canal" para cartões (Mesa do Chefe, painéis). */
export function teamChannelLabel(w: { profileId?: string | null; destinationId?: string | null; slot?: string | null }): string | null {
  const team = teamOfWork(w);
  const slot = (w.destinationId ?? w.slot ?? null) as SocialSlotId | null;
  const channel = slot ? CHANNEL_LABEL[slot] ?? null : null;
  if (!team && !channel) return null;
  return [team ? teamDef(team).short : null, channel].filter(Boolean).join(' · ');
}
