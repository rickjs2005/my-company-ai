// "Encerrar e distribuir tarefas": o gerente responsável escreve o plano consolidado em JSON; o servidor valida (só funcionário
// existente, projeto cadastrado, conta conhecida, dependências entre chaves do próprio plano) e transforma cada item numa tarefa
// real da fila. Decisão é só o que o Chefe confirmou; o resto vira pendência. Nada aqui chama provedor: são textos e validação.
import type { Employee, MeetingDecision, MeetingParticipant, MeetingPlan, PlanPriority, PlanTaskSpec, Project, Room } from '@milweb-hq/protocol';
import { SOCIAL_SLOTS, isSocialSlot } from '@milweb-hq/protocol';

/** Instrução inequívoca do Chefe no chat para encerrar e executar o plano (ex.: "pode encerrar e distribuir as tarefas"). */
export function isDistributeCommand(text: string): boolean {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/\b(nao|nunca|ainda nao|espera|aguarde)\b[^.!?]{0,30}\b(encerr|distribu|execut)/.test(t)) return false;
  return /\b(encerr\w*|finaliz\w*|fech\w*)\b[^.!?]{0,60}\b(distribu\w*|execut\w*|coloc\w* (em|na) (pratica|fila)|manda\w* (para|pra) (a )?equipe)\b/.test(t)
    || /\bdistribu\w*\b[^.!?]{0,40}\b(tarefas|plano|trabalho)\b[^.!?]{0,40}\b(encerr\w*|finaliz\w*)\b/.test(t);
}

export interface PlanBriefInput {
  me: MeetingParticipant;
  employees: Employee[];
  rooms: Room[];
  projects: Project[];
  decisions: MeetingDecision[];
  /** Gerente que estava responsável e saiu (passagem registrada). */
  handoffFrom: { name: string; reason: string } | null;
  /** Falas parciais (interrompidas ou cortadas pelo limite): nunca viram decisão. */
  partialFrom: string[];
  defaultProjectId: string | null;
}

/** Pedido do turno de consolidação: o plano sai num bloco ```json com o formato exato abaixo. */
export function planBrief(i: PlanBriefInput): string {
  const roomName = (id: string) => i.rooms.find(r => r.id === id)?.name ?? 'sala';
  const team = i.employees.filter(e => !e.archivedAt).map(e => `- ${e.name} · ${e.role || 'sem função'} · sala ${roomName(e.roomId)} · ${e.provider === 'openai' ? 'Codex' : 'Claude Code'}${e.skills?.length ? ` · skills: ${e.skills.slice(0, 8).join(', ')}` : ''}`).join('\n') || '- (nenhum funcionário cadastrado)';
  const projects = i.projects.map(p => `- ${p.name} (${p.path})`).join('\n') || '- (nenhum projeto cadastrado)';
  const confirmed = i.decisions.filter(d => d.confirmed && !d.dismissed).map(d => `- ${d.text}`).join('\n') || '- (nenhuma decisão confirmada pelo Chefe no quadro)';
  const open = i.decisions.filter(d => !d.confirmed && !d.dismissed && d.kind !== 'decision').map(d => `- [${d.kind}] ${d.text}`).join('\n') || '- (nada em aberto no quadro)';
  return [
    i.handoffFrom ? `Você assumiu a consolidação no lugar de ${i.handoffFrom.name}, que saiu da reunião (${i.handoffFrom.reason}). As falas e contribuições dele continuam valendo como estão no histórico acima.` : '',
    i.partialFrom.length ? `Atenção: ${i.partialFrom.join(', ')} deixou fala PARCIAL (interrompida ou cortada pelo limite). Use como contexto, nunca como decisão concluída.` : '',
    'O Chefe pediu para ENCERRAR A REUNIÃO E DISTRIBUIR AS TAREFAS. Consolide um único plano a partir do que foi combinado COM o Chefe.',
    '',
    'Regras:',
    '- Decisão é só o que o Chefe decidiu (quadro confirmado ou instrução dele na conversa). Concordância entre as IAs não é decisão: o que não foi decidido vai em "pending".',
    '- Uma tarefa por entrega concreta, só do que foi combinado. Atribua apenas a funcionários da lista abaixo, pelo nome exato, de acordo com a função e as skills. Se ninguém da equipe for apto, NÃO invente: escreva em "needs".',
    '- Cada funcionário mantém as próprias skills, instruções, modelo e esforço: não mude a configuração deles.',
    '- "dependsOn" usa as chaves de outras tarefas deste plano. Tarefa que depende de resposta do Chefe vai em "pending", não em "tasks".',
    '- Prazo só quando foi definido na reunião; se for sugestão sua, marque "deadlineProposed": true.',
    '- Nada de publicar, agendar ou falar com terceiros: publicação segue as aprovações do Chefe, fora deste plano.',
    '',
    'Funcionários existentes:', team,
    '', 'Projetos/pastas cadastrados:', projects,
    '', `Contas sociais (campo "slot"): ${SOCIAL_SLOTS.map(s => `${s.slot} (${s.label})`).join(', ')}`,
    '', 'Decisões confirmadas pelo Chefe:', confirmed,
    '', 'Ainda em aberto no quadro:', open,
    '',
    'Responda com um resumo curto em português e, no fim, UM bloco ```json exatamente neste formato:',
    '```json',
    JSON.stringify({
      summary: 'o que foi combinado, em 2 ou 3 frases',
      decisions: ['decisão do Chefe'],
      pending: ['proposta ou pergunta ainda sem decisão do Chefe'],
      needs: ['trabalho sem ninguém apto na equipe'],
      tasks: [{ key: 't1', title: 'título curto', objective: 'para que serve', assignee: 'Nome do funcionário', project: 'Nome do projeto', slot: 'threads ou null', context: 'o que ele precisa saber da reunião', references: ['caminho ou URL'], skill: 'nome da skill ou null', deliverable: 'arquivo/resultado esperado e onde salvar', criteria: ['critério de conclusão verificável'], priority: 'alta | media | baixa', dependsOn: [], deadline: null, deadlineProposed: false }],
    }, null, 2),
    '```',
  ].filter(l => l !== '').join('\n');
}

const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v: unknown, max: number, each: number): string[] => (Array.isArray(v) ? v.flatMap(x => { const t = s(x, each); return t ? [t] : []; }).slice(0, max) : []);
const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

export type ParsedPlan = Pick<MeetingPlan, 'summary' | 'decisions' | 'pending' | 'needs' | 'tasks'>;

/** Lê o último bloco ```json da fala do gerente e valida contra a equipe e os projetos reais. */
export function parsePlan(text: string, ctx: { employees: Employee[]; projects: Project[]; defaultProjectId: string | null }): { ok: true; plan: ParsedPlan; warnings: string[] } | { ok: false; error: string } {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1]);
  const raw = blocks.length ? blocks[blocks.length - 1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return { ok: false, error: 'o plano não veio num bloco JSON válido' }; }
  if (!o || typeof o !== 'object' || !Array.isArray(o.tasks)) return { ok: false, error: 'o plano não tem a lista "tasks"' };
  const warnings: string[] = [];
  const needs = arr(o.needs, 20, 400);
  const active = ctx.employees.filter(e => !e.archivedAt);
  const tasks: PlanTaskSpec[] = [];
  const seen = new Set<string>();
  for (const [idx, r] of (o.tasks as unknown[]).slice(0, 30).entries()) {
    const x = (r ?? {}) as Record<string, unknown>;
    const title = s(x.title, 160);
    if (!title) { warnings.push(`tarefa ${idx + 1} sem título (ignorada)`); continue; }
    let key = s(x.key, 40).replace(/[^\w.-]/g, '') || `t${idx + 1}`;
    while (seen.has(key)) key = `${key}b`;
    seen.add(key);
    const who = s(x.assignee, 80);
    const emp = who ? active.find(e => norm(e.name) === norm(who)) ?? null : null;
    if (!emp) needs.push(`"${title}": ${who ? `${who} não está na equipe` : 'sem responsável'}; ninguém apto foi atribuído`);
    const projName = s(x.project, 160);
    const proj = projName ? ctx.projects.find(p => norm(p.name) === norm(projName) || norm(p.path) === norm(projName)) ?? null : null;
    const projectId = proj?.id ?? ctx.defaultProjectId ?? (emp ? ctx.projects.find(p => p.roomId === emp.roomId)?.id ?? null : null);
    const slotRaw = s(x.slot, 40);
    const slot = slotRaw && isSocialSlot(slotRaw) ? slotRaw : null;
    if (slotRaw && slotRaw !== 'null' && !slot) warnings.push(`"${title}": conta "${slotRaw}" desconhecida (ficou sem conta)`);
    const priority: PlanPriority = x.priority === 'alta' || x.priority === 'baixa' ? x.priority : 'media';
    const deadline = s(x.deadline, 40) || null;
    tasks.push({
      key, title, objective: s(x.objective, 600), employeeId: emp?.id ?? null, employeeName: emp?.name ?? (who || null), projectId, slot,
      context: s(x.context, 3000), references: arr(x.references, 15, 400), skill: s(x.skill, 80) || null, deliverable: s(x.deliverable, 600),
      criteria: arr(x.criteria, 10, 300), priority, dependsOn: arr(x.dependsOn, 10, 40), deadline, deadlineProposed: deadline ? x.deadlineProposed !== false : false,
    });
  }
  // Dependência só entre chaves do próprio plano e sem ciclo.
  const keys = new Set(tasks.map(t => t.key));
  for (const t of tasks) {
    const bad = t.dependsOn.filter(d => !keys.has(d) || d === t.key);
    if (bad.length) { warnings.push(`"${t.title}": dependência desconhecida (${bad.join(', ')}) removida`); t.dependsOn = t.dependsOn.filter(d => keys.has(d) && d !== t.key); }
  }
  const byKey = new Map(tasks.map(t => [t.key, t]));
  const cyclic = (k: string, path: Set<string>): boolean => { if (path.has(k)) return true; path.add(k); const r = (byKey.get(k)?.dependsOn ?? []).some(d => cyclic(d, path)); path.delete(k); return r; };
  for (const t of tasks) if (cyclic(t.key, new Set())) { warnings.push(`"${t.title}": dependências em ciclo removidas`); t.dependsOn = []; }
  if (!tasks.length && !needs.length) return { ok: false, error: 'o plano não tem nenhuma tarefa' };
  return { ok: true, plan: { summary: s(o.summary, 1500), decisions: arr(o.decisions, 30, 600), pending: arr(o.pending, 30, 600), needs, tasks }, warnings };
}

const PRIORITY_LABEL: Record<PlanPriority, string> = { alta: 'alta', media: 'média', baixa: 'baixa' };

/** Texto da tarefa real que o funcionário recebe (tudo o que ele precisa, sem depender da reunião). */
export function planTaskText(i: { spec: PlanTaskSpec; meetingTitle: string; planVersion: number; employee: Employee; project: Project; slotLabel: string | null; depTitles: string[] }): string {
  const t = i.spec;
  return [
    `[Tarefa distribuída na reunião "${i.meetingTitle}" do My Company AI · plano v${i.planVersion} · item ${t.key}]`,
    t.title,
    '',
    `Objetivo: ${t.objective || t.title}`,
    `Responsável: ${i.employee.name}`,
    `Projeto/pasta: ${i.project.name} (${i.project.path})`,
    i.slotLabel ? `Conta social: ${i.slotLabel} (\`${t.slot}\`)` : '',
    `Prioridade: ${PRIORITY_LABEL[t.priority]}`,
    t.deadline ? `Prazo: ${t.deadline}${t.deadlineProposed ? ' (proposto pelo gerente, não decidido pelo Chefe)' : ''}` : '',
    i.depTitles.length ? `Depende de (já concluídas antes de você começar): ${i.depTitles.join('; ')}` : '',
    '',
    `Contexto da reunião: ${t.context || '(sem contexto adicional)'}`,
    t.references.length ? `Referências: ${t.references.join(' ; ')}` : '',
    `Entrega esperada: ${t.deliverable || 'descreva o resultado e onde salvou'}`,
    t.criteria.length ? `Critérios de conclusão:\n${t.criteria.map(c => `- ${c}`).join('\n')}` : '',
    '',
    'Como trabalhar:',
    '- Salve o resultado dentro da pasta do projeto. Se refizer algo, não apague a versão anterior: salve a nova ao lado (ex.: sufixo -v2).',
    '- Se precisar de uma decisão do Chefe, pergunte (ferramenta de pergunta) em vez de supor. Não publique, não agende e não envie nada a terceiros.',
    '- Ao terminar, responda com: um resumo curto do que entregou; os caminhos dos arquivos (um por linha, começando com "Arquivo: "); e cada critério no formato "- [x] critério" (atendido) ou "- [ ] critério: o que falta".',
  ].filter(l => l !== '').join('\n');
}

/** Seção do plano na ata (o que foi distribuído, a quem, e o que ficou pendente). */
export function renderPlanSection(plan: MeetingPlan, assignees: Map<string, string>): string {
  const lines = [`## Plano consolidado (v${plan.version}, por ${plan.authorName})`, '', plan.summary || '(sem resumo)', ''];
  if (plan.decisions.length) lines.push('### Decisões do Chefe', ...plan.decisions.map(d => `- ${d}`), '');
  if (plan.tasks.length) lines.push('### Tarefas distribuídas', ...plan.tasks.map(t => `- [${t.key}] ${t.title} → ${assignees.get(t.key) ?? t.employeeName ?? 'sem responsável'}${t.dependsOn.length ? ` (depois de ${t.dependsOn.join(', ')})` : ''}`), '');
  if (plan.pending.length) lines.push('### Pendências (sem decisão do Chefe)', ...plan.pending.map(p => `- ${p}`), '');
  if (plan.needs.length) lines.push('### Falta alguém apto', ...plan.needs.map(n => `- ${n}`), '');
  return lines.join('\n');
}
