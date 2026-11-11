// Montagem dos textos enviados aos participantes de IA e leitura das respostas estruturadas. Só texto público:
// pauta, contexto da reunião, falas de todos e quadro. Nada de raciocínio privado de um modelo vai para o outro.
import type { Employee, Meeting, MeetingContextItem, MeetingDecision, MeetingMessage, MeetingParticipant, Project, Room, TurnPhase } from '@milweb-hq/protocol';

export const PHASE_LABELS: Record<TurnPhase, string> = { reply: 'resposta', opinion: 'opinião inicial', revision: 'revisão', synthesis: 'síntese', plan: 'plano consolidado' };

export const PROVIDER_ROUTE: Record<string, string> = { claude: 'via Claude Code', openai: 'via Codex' };

export function participantLabel(p: MeetingParticipant, employees?: Employee[]): string {
  if (p.kind === 'chefe') return 'Chefe';
  const role = p.employeeId ? employees?.find(e => e.id === p.employeeId)?.role?.trim() : null;
  return `${p.name}${role ? `, ${role}` : ''} (${PROVIDER_ROUTE[p.provider ?? ''] ?? p.provider ?? 'IA'})`;
}

export function buildSystemPrompt(meeting: Meeting, me: MeetingParticipant, employee: Employee | null, room: Room | null): string {
  const others = meeting.participants.filter(p => p.id !== me.id).map(p => participantLabel(p)).join(', ');
  const crowd = meeting.participants.filter(p => p.kind === 'ai').length > 2;
  const parts = [
    `Você é ${me.name}, participante de uma reunião da MilWeb HQ, a empresa virtual do Chefe (fundador da Aurora, agência de sites e sistemas). Os outros participantes são: ${others || 'ninguém'}. Quem decide é o Chefe; você opina, discorda quando tiver motivo e aponta riscos. Concordância entre modelos não é aprovação de nada.`,
    'Regras: responda em português do Brasil, de forma direta e organizada, sem rodeios e sem repetir o que já foi dito. Você está em modo análise: não execute comandos, não altere arquivos e não finja ter feito algo. Se precisar ler um arquivo do projeto para opinar, pode ler. Se não souber, diga que não sabe. Nunca invente dados da empresa.',
    'Formato: texto corrido com no máximo alguns parágrafos ou uma lista curta. Comece cada fala pelo ponto principal. Quando quiser propor algo para o quadro, use linhas começando com "Proposta:", "Divergência:", "Pergunta:" ou "Ação:".',
  ];
  if (crowd) parts.push('A mesa tem vários participantes: fale do ponto de vista da sua função, seja breve e não repita o que outro participante já disse; se concordar, diga em uma linha e acrescente só o que for novo.');
  if (employee) {
    parts.push(me.employeeId === employee.id && me.name.startsWith(employee.name)
      ? `Você está à mesa como ${employee.name}${employee.role ? ` (${employee.role})` : ''}, da equipe da MilWeb HQ.`
      : `Nesta reunião você representa o funcionário ${employee.name}${employee.role ? ` (${employee.role})` : ''} da MilWeb HQ.`);
    if (employee.instructions?.trim()) parts.push(`Instruções de atuação de ${employee.name}:\n${employee.instructions.trim()}`);
  }
  if (room?.instructions?.trim()) parts.push(`Instruções da sala de Reuniões:\n${room.instructions.trim()}`);
  return parts.join('\n\n');
}

export interface ContextPackageInput {
  meeting: Meeting;
  project: Project | null;
  messages: MeetingMessage[];
  decisions: MeetingDecision[];
  context: MeetingContextItem[];
  /** Conteúdo lido no servidor para os itens de contexto de arquivo (por id). */
  fileContents: Map<string, { text: string; truncated: boolean; error?: string }>;
  company: { rooms: Room[]; projects: Project[]; employees: Employee[] } | null;
  /** Para mostrar a função de cada funcionário à mesa. */
  employees?: Employee[];
}

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function buildContextPackage(input: ContextPackageInput): string {
  const { meeting } = input;
  const out: string[] = [];
  out.push(`# Reunião: ${meeting.title}`);
  out.push(`Modo: ${meeting.mode === 'debate' ? 'Discutir a pauta (rodadas de opinião, revisão e síntese)' : 'Conversa guiada pelo Chefe'}. Versão do contexto: ${meeting.contextVersion}.`);
  out.push(`## Pauta\n${meeting.agenda.trim() || '(sem pauta escrita)'}`);
  out.push(`## Projeto\n${input.project ? `${input.project.name} (pasta ${input.project.path})` : 'nenhum projeto vinculado'}`);
  const parts = meeting.participants.map(p => `- ${participantLabel(p, input.employees)}${p.kind === 'ai' ? ` · modelo ${p.useGlobal ? 'padrão global' : (p.model ?? 'padrão')}` : ''}`);
  out.push(`## Participantes\n${parts.join('\n')}`);
  if (input.company) {
    const c = input.company;
    const rooms = c.rooms.map(r => `- ${r.name}`).join('\n');
    const projects = c.projects.slice(0, 40).map(p => `- ${p.name} (${p.path})`).join('\n');
    const emps = c.employees.filter(e => !e.archivedAt).map(e => `- ${e.name}${e.role ? `, ${e.role}` : ''} (sala ${c.rooms.find(r => r.id === e.roomId)?.name ?? '?'})`).join('\n');
    out.push(`## Contexto da empresa (MilWeb HQ)\nSalas:\n${rooms || '-'}\n\nProjetos cadastrados:\n${projects || '-'}\n\nFuncionários:\n${emps || '- nenhum'}`);
  }
  const ctx = input.context.filter(c => c.enabled);
  if (ctx.length) {
    const blocks = ctx.map(c => {
      if (c.kind === 'note') return `### Nota: ${c.label}\n${(c.text ?? '').trim()}`;
      const f = input.fileContents.get(c.id);
      if (!f) return `### Arquivo: ${c.label} (${c.path})\n(não lido)`;
      if (f.error) return `### Arquivo: ${c.label} (${c.path})\n(não foi possível ler: ${f.error})`;
      return `### Arquivo: ${c.label} (${c.path})${f.truncated ? ' · truncado' : ''}\n\`\`\`\n${f.text}\n\`\`\``;
    });
    out.push(`## Contexto da reunião\n${blocks.join('\n\n')}`);
  }
  const confirmed = input.decisions.filter(d => d.confirmed && !d.dismissed);
  const board = input.decisions.filter(d => !d.confirmed && !d.dismissed);
  if (confirmed.length) out.push(`## Decisões já confirmadas pelo Chefe\n${confirmed.map(d => `- ${d.text}`).join('\n')}`);
  if (board.length) out.push(`## Quadro (ainda não confirmado pelo Chefe)\n${board.map(d => `- [${d.kind}] ${d.text}`).join('\n')}`);
  const conv = input.messages.filter(m => m.kind !== 'notice');
  out.push(`## Conversa até agora (${conv.length} fala${conv.length === 1 ? '' : 's'})\n${conv.length ? conv.map(m => `[${fmtTime(m.ts)}] ${m.authorName}${m.provider ? ` (${PROVIDER_ROUTE[m.provider] ?? m.provider})` : ''}${m.partial ? ' (fala interrompida, parcial)' : ''}${m.targets.length ? ` → para: ${m.targets.map(t => meeting.participants.find(p => p.id === t)?.name ?? t).join(', ')}` : ''}:\n${m.text.trim()}`).join('\n\n') : '(ninguém falou ainda)'}`);
  return out.join('\n\n');
}

export interface TurnTextInput {
  phase: TurnPhase;
  round: number;
  roundLimit: number;
  me: MeetingParticipant;
  /** Última fala do Chefe dirigida a este participante (fase reply). */
  chefeMessage: MeetingMessage | null;
  contextPackage: string;
  others: MeetingParticipant[];
  /** Turno de consolidação ('plan'): pedido com equipe, projetos, decisões e o formato do plano. */
  planBrief?: string;
}

export function buildTurnText(input: TurnTextInput): string {
  const { phase, me } = input;
  const head = `${input.contextPackage}\n\n---\n\n## Seu turno agora (${me.name}, ${PHASE_LABELS[phase]}${input.round ? `, rodada ${input.round} de ${input.roundLimit}` : ''})`;
  switch (phase) {
    case 'reply':
      return `${head}\nO Chefe falou com você (a fala está no fim da conversa acima${input.chefeMessage ? `, às ${fmtTime(input.chefeMessage.ts)}` : ''}). Responda diretamente a ela, considerando tudo o que já foi dito na reunião. Se o Chefe corrigiu algo, acate a correção daqui em diante.`;
    case 'opinion':
      return `${head}\nDê sua opinião inicial sobre a pauta: o que você recomenda, por quê, principais riscos e o que precisaria ser decidido. Não espere os outros: esta é a primeira rodada.`;
    case 'revision':
      return `${head}\nRevise sua posição à luz das falas REAIS dos outros participantes (${input.others.map(o => o.name).join(', ') || 'ninguém'}) acima. Diga explicitamente: em que você concorda, em que discorda e por quê, e que perguntas ficam abertas. Não repita sua opinião anterior; avance.`;
    case 'synthesis':
      return `${head}\nFaça a síntese da discussão para o Chefe decidir. Use EXATAMENTE estas seções, com itens em lista:\n## Propostas\n## Divergências\n## Perguntas abertas\n## Próximas ações\nEm "Próximas ações", quando fizer sentido, comece o item com o nome do responsável sugerido entre colchetes, ex.: "- [Léo] ajustar o formulário". Não decida nada pelo Chefe: o quadro é para ele confirmar.`;
    case 'plan':
      return `${head}
${input.planBrief ?? ''}`;
  }
}

export interface ParsedSynthesis { proposals: string[]; divergences: string[]; questions: string[]; actions: { text: string; assignee: string | null }[] }

/** Lê a síntese pelas seções pedidas (tolerante a variações de título e marcadores). */
export function parseSynthesis(text: string): ParsedSynthesis {
  const out: ParsedSynthesis = { proposals: [], divergences: [], questions: [], actions: [] };
  let section: keyof ParsedSynthesis | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.replace(/^#+\s*/, '').replace(/[:*_]+$/g, '').trim().toLowerCase();
    if (/^#/.test(line) || /^(propostas?|diverg[êe]ncias?|perguntas( abertas)?|pr[óo]ximas a[çc][õo]es|a[çc][õo]es)\s*:?$/i.test(line.replace(/[*_]/g, ''))) {
      if (/^propost/.test(heading)) { section = 'proposals'; continue; }
      if (/^diverg/.test(heading)) { section = 'divergences'; continue; }
      if (/^pergunt/.test(heading)) { section = 'questions'; continue; }
      if (/a[çc][õo]es/.test(heading)) { section = 'actions'; continue; }
      section = null; continue;
    }
    if (!section) continue;
    const item = line.replace(/^([-*•]|\d+[.)])\s*/, '').trim();
    if (!item) continue;
    if (section === 'actions') {
      const m = item.match(/^\[([^\]]+)\]\s*(.+)$/);
      out.actions.push(m ? { text: m[2].trim(), assignee: m[1].trim() } : { text: item, assignee: null });
    } else out[section].push(item);
  }
  return out;
}

/** Fala do Chefe que confirma uma decisão: "Decisão: …", "Decidido: …", "Fica decidido …". */
export function chefeDecisionText(text: string): string | null {
  const m = text.trim().match(/^(?:decis[ãa]o|decidido|fica decidido)\s*[:,\-–—]?\s*(.+)$/is);
  const t = m?.[1]?.trim();
  return t ? t : null;
}

/** Menções @Nome no texto (nome do participante, sem diferenciar maiúsculas; aceita @ChatGPT, @Claude, @Léo). */
export function parseMentions(text: string, participants: MeetingParticipant[]): string[] {
  const ids: string[] = [];
  for (const p of participants) {
    if (p.kind !== 'ai') continue;
    const name = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|\\s)@${name}(?=$|[\\s,.;:!?])`, 'iu').test(text)) ids.push(p.id);
  }
  return ids;
}

export interface MinutesInput {
  meeting: Meeting;
  project: Project | null;
  messages: MeetingMessage[];
  decisions: MeetingDecision[];
  employees: Employee[];
}

export function renderMinutes(input: MinutesInput): string {
  const { meeting } = input;
  const date = new Date(meeting.endedAt ?? Date.now()).toLocaleString('pt-BR');
  const emp = (id: string | null) => input.employees.find(e => e.id === id)?.name ?? null;
  const by = (kind: MeetingDecision['kind'], confirmed?: boolean) => input.decisions.filter(d => d.kind === kind && !d.dismissed && (confirmed === undefined || d.confirmed === confirmed));
  const lines: string[] = [];
  lines.push(`# Ata: ${meeting.title}`);
  lines.push(`Data: ${date}  \nModo: ${meeting.mode === 'debate' ? 'Discutir a pauta' : 'Conversa guiada'}  \nProjeto: ${input.project?.name ?? 'nenhum'}  \nParticipantes: ${meeting.participants.map(p => participantLabel(p, input.employees)).join(', ')}`);
  lines.push(`## Pauta\n${meeting.agenda.trim() || '(sem pauta escrita)'}`);
  const decided = by('decision', true);
  lines.push(`## Decisões confirmadas pelo Chefe\n${decided.length ? decided.map(d => `- ${d.text}`).join('\n') : '- nenhuma decisão confirmada'}`);
  const pending = input.decisions.filter(d => !d.confirmed && !d.dismissed && d.kind !== 'action');
  if (pending.length) lines.push(`## Propostas e pontos em aberto (não confirmados)\n${pending.map(d => `- [${d.kind === 'proposal' ? 'proposta' : d.kind === 'divergence' ? 'divergência' : d.kind === 'question' ? 'pergunta' : 'decisão proposta'}] ${d.text}`).join('\n')}`);
  const dismissed = input.decisions.filter(d => d.dismissed);
  if (dismissed.length) lines.push(`## Alternativas descartadas\n${dismissed.map(d => `- ${d.text}`).join('\n')}`);
  const actions = by('action');
  lines.push(`## Próximas ações\n${actions.length ? actions.map(a => `- ${a.text}${emp(a.assigneeEmployeeId) ? ` (responsável: ${emp(a.assigneeEmployeeId)})` : ''}${a.confirmed ? '' : ' · a confirmar'}`).join('\n') : '- nenhuma'}`);
  const conv = input.messages.filter(m => m.kind !== 'notice');
  lines.push(`## Resumo da conversa\n${conv.length ? conv.map(m => `- **${m.authorName}** (${fmtTime(m.ts)}${m.config?.model ? `, ${m.config.resolvedModel ?? m.config.model}${m.config.effort ? ' · ' + m.config.effort : ''}` : ''}${m.partial ? ', parcial' : ''}): ${m.text.trim().split(/\r?\n/)[0].slice(0, 200)}`).join('\n') : '- sem falas'}`);
  return lines.join('\n\n') + '\n';
}
