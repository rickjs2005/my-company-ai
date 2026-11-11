// Tela Conteúdo (05/11; refeita em 06/11 a pedido do Chefe: "quero fazer pela sala, não pelo terminal"). Uma tela só para as
// três contas do foco (Tuco · Instagram, Aurora · Instagram, Aurora · Threads): o pedido numa linha, "Esperando você"
// com as peças E as perguntas da equipe (responde ali mesmo), "A equipe está fazendo" com todo o trabalho da sala (não só as
// peças), "Pronto para postar" e "Postado". O resto (Mesa, Mural, Calendário, Radar...) fica no menu "Mais". Nada é
// publicado sem o clique do Chefe.
import { suggestTeams } from './teamBoard';
import { useEffect, useMemo, useState } from 'react';
import type { AcademyStudy, ContentItem, ContentState, Employee, Meeting, PendingPermission, QuickFormat, RadarItem, Session, SocialSlotId, Task } from '@milweb-hq/protocol';
import { ACADEMY_EXERCISE_STATUS_LABEL, ACADEMY_STUDY_STATUS_LABEL, PIECE_STEP_LABEL, QUICK_SLOTS, SOCIAL_SLOTS, VIDEO_STAGE_LABEL, VIDEO_TASK_STATUS, VIDEO_TASK_STATUS_LABEL, quickFormatsFor, quickTitle } from '@milweb-hq/protocol';
import { REQUEST_INTENT_LABEL, detectDirective, isTeamId, readRequest } from '@milweb-hq/protocol';
import type { KnowledgeScope } from '@milweb-hq/protocol';
import type { ComposerManager } from '../TaskComposer';
import { ShareVideo } from './ShareVideo';
import { suggestMode } from './academyBoard';
import type { ContentApi } from './ContentViews';
import { PieceDecision, Thumb } from './PiecesBoard';
import { FORMAT_LABEL, HOME_COLUMNS, SLOT_LABEL, VIDEO_SLOTS, ago, focusMissing, hasVideoLink, homeBoard, looseWork, mainFiles, refTaskState, suggestFormat, suggestSlot, type HomeColumn, type LooseWork } from './homeBoard';
import { pieceColumn, runningScope } from './pieceBoard';
import { parseLinks, type ExtraRole } from './VideoRefComposer';
import { PipelineChips, PlansPanel, TeamNowStrip } from './TeamNow';
import { QuestionCard, describeInput, type DeskApi } from '../DeskInbox';

const slotName = (s: SocialSlotId | null) => (s ? SLOT_LABEL[s] ?? SOCIAL_SLOTS.find(x => x.slot === s)?.label ?? s : 'conta a definir');
const who = (employees: Employee[], id: string | null | undefined) => (id ? employees.find(e => e.id === id)?.name ?? 'a equipe' : 'a equipe');
const ddmm = (t: number) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export type HomeMore = 'mural' | 'calendario' | 'radar' | 'resultados' | 'mesa' | 'redes' | 'reunioes' | 'sala' | 'academia';
const MORE: { id: HomeMore; label: string; title: string }[] = [
  { id: 'mesa', label: 'Mesa', title: 'Perguntas, bloqueios e entregas de reunião' },
  { id: 'academia', label: 'Academia de Vídeo', title: 'Estudos, aulas, exercícios e as técnicas que a equipe aprendeu' },
  { id: 'mural', label: 'Mural completo', title: 'Todas as peças, de todas as redes, com filtros, lote, arquivo e lixeira' },
  { id: 'calendario', label: 'Calendário', title: 'Semana planejada pela coordenação' },
  { id: 'radar', label: 'Radar', title: 'Referências e tendências achadas pelo pesquisador' },
  { id: 'resultados', label: 'Resultados', title: 'Números das peças publicadas' },
  { id: 'redes', label: 'Redes', title: 'Contas e logins' },
  { id: 'reunioes', label: 'Reuniões', title: 'Reunião com a equipe e os gerentes' },
  { id: 'sala', label: 'Ver a sala', title: 'A sala Social Media em pixel art (mesas, mural, estúdio)' },
];

/** Estado da peça em palavras simples (quem está com ela e o que falta). */
export function plainStatus(i: ContentItem, tasks: Task[], employees: Employee[]): string {
  const step = i.status === 'planejada' ? i.pipeline?.steps.find(s => s.status === 'fazendo' || s.status === 'falhou') : null;
  if (step) return step.status === 'fazendo' ? `${PIECE_STEP_LABEL[step.key]} com ${step.employeeName ?? 'a equipe'}` : `A etapa ${PIECE_STEP_LABEL[step.key].toLowerCase()} não deu certo: ${step.error ?? 'veja o motivo'}`;
  const col = pieceColumn(i, tasks);
  if (col === 'fila') return 'Na fila da equipe';
  if (col === 'producao') {
    if (i.status === 'em_producao') return `${who(employees, i.ownerId)} está produzindo`;
    const t = tasks.find(x => x.id === i.reviewTaskId);
    return `${who(employees, t?.employeeId)} está revisando`;
  }
  if (col === 'planejada') return 'Planejada: falta mandar produzir';
  if (i.status === 'falhou') return `Não deu certo: ${i.nextStep ?? 'veja o motivo ao abrir'}`;
  if (i.status === 'parcial') return `Faltou parte da entrega: ${i.nextStep ?? 'veja ao abrir'}`;
  if (i.status === 'ajustar') return 'O revisor pediu ajuste: veja e decida';
  if (i.status === 'revisar') return i.review?.verdict === 'aprovar' ? 'Pronto. O revisor aprovou: falta você' : 'Pronto para você ver';
  if (i.status === 'publicada') return `Postado${i.publication ? ` em ${ddmm(i.publication.at)}` : ''}`;
  return i.date ? `Aprovado · para ${i.date.split('-').reverse().slice(0, 2).join('/')}` : 'Aprovado';
}

function PieceCard({ item, col, tasks, employees, api }: { item: ContentItem; col: HomeColumn; tasks: Task[]; employees: Employee[]; api: ContentApi }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Peça na linha de produção (etapa por fazer): a própria linha toca; "Tentar a etapa de novo" fica nos chips das etapas.
  const inLine = Boolean(item.pipeline?.steps.some(s => s.status !== 'feito'));
  const redo = !inLine && (item.status === 'planejada' || item.status === 'falhou' || item.status === 'parcial');
  const working = (() => { const s = runningScope(item, tasks); return s.running.length + s.queued.length > 0; })();
  const go = async () => { setBusy(true); setError(null); try { await api.produce(item.id, null); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  return (
    <li className={`hq-home-card hq-home-card--${col}${item.status === 'falhou' || item.status === 'parcial' ? ' hq-home-card--bad' : ''}`}>
      <div className="hq-home-card__top">
        <Thumb item={item} api={api} />
        <div className="hq-home-card__main">
          <span className={`hq-home-net hq-home-net--${item.slot}`}>{slotName(item.slot)} · {item.format || 'peça'}</span>
          <button type="button" className="hq-home-card__title" onClick={() => api.openPiece(item)} title="Abrir a peça">{item.title}</button>
          <span className="hq-home-card__state">{plainStatus(item, tasks, employees)}</span>
        </div>
      </div>
      {item.pipeline && item.status !== 'publicada' && <PipelineChips item={item} api={api} />}
      {(col === 'ver' || col === 'pronto' || col === 'postado') && !redo && <PieceDecision item={item} tasks={tasks} employees={employees} api={api} />}
      {redo && !working && (
        <div className="hq-actions">
          <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy} onClick={() => void go()}>{busy ? 'Enviando…' : item.status === 'planejada' ? 'Produzir agora' : 'Fazer de novo'}</button>
          {item.status !== 'planejada' && <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.openPiece(item)}>Abrir</button>}
        </div>
      )}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
    </li>
  );
}

/** Andamento do estudo em uma linha: quem está fazendo o quê ("Teo: em produção · Clara: entregue"). */
function studyLine(st: AcademyStudy | null): string | null {
  if (!st) return null;
  if (!st.exercises.length) return ACADEMY_STUDY_STATUS_LABEL[st.status];
  return `${ACADEMY_STUDY_STATUS_LABEL[st.status]} · ${st.exercises.map(e => `${e.employeeName ?? e.role}: ${ACADEMY_EXERCISE_STATUS_LABEL[e.status].toLowerCase()}${e.feedback ? (e.feedback.verdict === 'ok' ? ' (ok)' : ' (ajustar)') : ''}`).join(' · ')}`;
}

function RefCard({ r, col, api, onDetails, study, work, meetingBusy }: { r: RadarItem; col: HomeColumn; api: ContentApi; onDetails(): void; study?: AcademyStudy | null; work?: { status: 'fila' | 'rodando' | 'espera'; name: string } | null; meetingBusy?: boolean }) {
  const v = r.video!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<SocialSlotId>(v.slot && (VIDEO_SLOTS as readonly string[]).includes(v.slot) ? v.slot : 'instagram-tuco');
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const estudo = v.mode === 'estudo';
  // O que está acontecendo DE VERDADE (07/11: "porque ninguém está fazendo nada?": o cartão dizia "assistindo" com a tarefa na fila).
  const live = v.stage === 'recebida' || v.stage === 'inspecionando' ? 'A HQ está abrindo o vídeo (download e quadros)'
    : v.stage === 'analisando' && work?.status === 'fila' ? `Na fila de ${work.name}${meetingBusy ? ': espera a reunião em andamento terminar (a HQ faz uma coisa por vez)' : ': começa quando a tarefa anterior terminar'}`
      : v.stage === 'analisando' && work?.status === 'rodando' ? `${work.name} está ${estudo ? 'estudando' : 'analisando'} o vídeo agora`
        : v.stage === 'analisando' && work?.status === 'espera' ? `${work.name} espera uma resposta sua (veja em "Esperando você")`
          : v.stage === 'discussao' ? 'Em reunião com a equipe agora' : null;
  const stage = live ?? (estudo && study ? studyLine(study)! : VIDEO_STAGE_LABEL[v.stage]);
  const full = `${stage}${v.error ? `: ${v.error}` : ''}`;
  const simple = VIDEO_TASK_STATUS[v.stage];
  const short = full.length > 150 ? `${full.slice(0, 147).replace(/\s+\S*$/, '')}…` : full;
  return (
    <li className={`hq-home-card hq-home-card--${col} hq-home-card--ref${v.stage === 'bloqueada' ? ' hq-home-card--bad' : ''}`}>
      <div className="hq-home-card__main">
        <span className="hq-home-net">{estudo ? 'Estudo da Academia de Vídeo' : v.mode === 'produzir' ? `Versão própria de um vídeo · ${slotName(v.slot)}` : 'Vídeo compartilhado · análise'} · <span className={`hq-vstatus hq-vstatus--${simple}`}>{VIDEO_TASK_STATUS_LABEL[simple]}</span></span>
        <strong className="hq-home-card__title hq-home-card__title--static">{r.subject}</strong>
        <span className="hq-home-card__state" title={full !== short ? full : undefined}>{short}</span>
      </div>
      {col === 'ver' && (
        <div className="hq-actions">
          {v.stage === 'proposta' && (
            <>
              <select className="hq-input hq-input--sm" value={slot} onChange={e => setSlot(e.target.value as SocialSlotId)} aria-label="Conta">{VIDEO_SLOTS.map(s => <option key={s} value={s}>{SLOT_LABEL[s]}</option>)}</select>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy} onClick={() => void run(() => api.videoProduce(r.id, slot))}>{busy ? 'Enviando…' : 'Produzir'}</button>
            </>
          )}
          {v.stage === 'bloqueada' && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy} onClick={() => void run(() => api.videoRetry(r.id, null))}>{busy ? 'Enviando…' : 'Tentar de novo'}</button>}
          {estudo && api.openAcademy && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={api.openAcademy}>Ver na Academia</button>}
          {v.meetingId && api.openMeeting && <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.openMeeting!(v.meetingId!)}>Abrir a reunião</button>}
          <button type="button" className="hq-btn hq-btn--sm" onClick={onDetails}>Detalhes</button>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy} title="Tira este vídeo da lista (nada é apagado do disco)" onClick={() => void run(() => api.radarDiscard(r.id))}>Descartar</button>
        </div>
      )}
      {col === 'fazendo' && (estudo || (v.stage === 'discussao' && v.meetingId)) && (
        <div className="hq-actions">
          {v.stage === 'discussao' && v.meetingId && api.openMeeting && <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.openMeeting!(v.meetingId!)}>Ver a reunião</button>}
          {estudo && api.openAcademy && <button type="button" className="hq-btn hq-btn--sm" onClick={api.openAcademy}>Acompanhar na Academia</button>}
        </div>
      )}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
    </li>
  );
}

function Ask({ api, profileId, connected, manager }: { api: ContentApi; profileId: string | null; connected: boolean; manager?: ComposerManager | null }) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [slotPick, setSlotPick] = useState<SocialSlotId | null>(null);
  const [formatPick, setFormatPick] = useState<QuickFormat | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // "A equipe planeja" (padrão, 08/11): a gerente transforma o pedido em peças e a HQ toca as etapas. "Uma peça" = o caminho direto.
  const [direct, setDirect] = useState(false);
  // Pedido geral sem destino: para quem é (o Chefe confirma). Sugestão pelo texto; "as duas" vira peças separadas por equipe.
  const [teamsPick, setTeamsPick] = useState<('aurora' | 'tuco-dev')[] | null>(null);
  const teams = teamsPick ?? suggestTeams(text);
  const link = hasVideoLink(text);
  const slot = slotPick ?? suggestSlot(text, profileId);
  const formats = quickFormatsFor(slot);
  const format: QuickFormat = link ? 'video' : formatPick && formats.includes(formatPick) ? formatPick : suggestFormat(text, slot);
  const studyLink = link && suggestMode(text) === 'estudo';
  const linkToThreads = link && !studyLink && slot === 'threads';
  const ready = connected && text.trim().length >= 3 && !busy && !linkToThreads;
  const open = focused || text.length > 0;
  // Leitura do pedido (sem IA): produzir vai para a gerente; ensinar vira conhecimento; "o que depende de mim" abre a Mesa.
  const reading = readRequest(text, { profileTeam: teams.length === 1 ? teams[0] : isTeamId(profileId) ? profileId : null });
  const routed = !link && !direct && manager && ['status', 'ensinar', 'corrigir'].includes(reading.intent);
  const submit = async () => {
    if (!ready) return;
    setBusy(true); setMsg(null);
    try {
      if (routed && manager) {
        if (reading.intent === 'ensinar') {
          const d = detectDirective(text, { team: reading.teams.length === 1 ? reading.teams[0] : null });
          const scope: KnowledgeScope = d?.scope ?? (reading.teams.length === 1 ? { type: 'equipe', id: reading.teams[0] } : { type: 'empresa', id: null });
          const r = await manager.teach(d?.text ?? text.trim(), scope);
          setMsg({ ok: true, text: r.duplicate ? 'Essa orientação já estava registrada: nada foi duplicado.' : `Ensinado: registrado em Equipe → Conhecimento da equipe para ${r.scopeLabel}. Vale a partir do próximo pedido; nada foi produzido nem publicado.` });
        } else {
          manager.openDesk();
          setMsg({ ok: true, text: reading.intent === 'status' ? 'Minha mesa aberta: entregas para revisar, perguntas e bloqueios. Nada foi enfileirado.' : 'Para corrigir uma entrega, abra a entrega na Minha mesa e use "Pedir ajuste": a correção volta para quem fez, com a versão certa.' });
          if (reading.intent === 'corrigir') { setBusy(false); return; }
        }
      } else if (link) {
        const { links, instruction } = parseLinks(text);
        const extras = links.slice(1).map(l => ({ url: l.url, role: (l.role === 'base' ? 'referencia' : l.role) as ExtraRole, note: l.note }));
        // "Estudem esse vídeo" + link: vai para a Academia (o Diretor dá a aula e passa exercícios); o resto vira a nossa versão.
        const study = suggestMode(instruction ?? text) === 'estudo';
        const r = await api.videoAdd({ url: links[0].url, file: null, liked: null, mode: study ? 'estudo' : 'produzir', instruction: instruction ?? text.trim(), slot: study ? null : slot, profileId, extras });
        setMsg({ ok: true, text: r.reused ? 'Esse vídeo já estava aqui: o cartão dele foi atualizado com o seu pedido.' : study ? 'Recebido para estudo: o Diretor de Vídeo assiste, dá a aula e passa os exercícios. Acompanhe na Academia de Vídeo.' : `Recebido. A equipe vai assistir ${links.length > 1 ? 'os vídeos' : 'o vídeo'} e produzir a nossa versão para ${slotName(slot)}.` });
      } else if (!direct) {
        await api.managerAsk(text.trim(), teams);
        setMsg({ ok: true, text: 'Pedido com a gerente: ela planeja as peças (conta, formato, data e etapas) e a equipe toca a produção. Acompanhe em "Pedidos à equipe" e em "Equipe agora".' });
      } else {
        await api.quickCreate(text.trim(), slot, format);
        setMsg({ ok: true, text: `Pedido criado: "${quickTitle(text)}". Está com a equipe; aparece em "Esperando você" quando ficar pronto.` });
      }
      setText(''); setSlotPick(null); setFormatPick(null); setTeamsPick(null);
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  };
  const hint = linkToThreads
    ? 'Link de vídeo vira Reel: escolha uma conta do Instagram.'
    : studyLink
      ? 'Link de vídeo para estudar: o Diretor de Vídeo analisa, dá a aula, passa exercícios e guarda na Academia. Não vira post.'
      : link
      ? 'Link de vídeo: a equipe assiste e produz a nossa versão. Pode colar mais de um link e dizer "esse áudio", "esse estilo".'
      : routed
        ? `${REQUEST_INTENT_LABEL[reading.intent]}: ${reading.summary.entrega}.`
      : !direct
        ? 'A gerente planeja (conta, formato, data, pesquisa, roteiro, direção), a equipe produz, o Otto revisa e as peças chegam em "Esperando você". Você só aprova. Ctrl+Enter também envia.'
        : 'Uma peça direta: a criação produz o arquivo pronto, o revisor confere e a peça aparece em "Esperando você". Nada é publicado sem você. Ctrl+Enter também cria.';
  return (
    <form className={`hq-home-ask${open ? ' is-open' : ''}`} onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="hq-home-ask__line">
        <label className="sr-only" htmlFor="hq-home-text">O que você quer postar?</label>
        <textarea
          id="hq-home-text" className="hq-input hq-home-ask__text" rows={open ? 3 : 1} value={text} onChange={e => setText(e.target.value)}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}
          placeholder={open ? 'Ex.: Preparem os conteúdos de amanhã para os perfis prioritários.\nEx.: Reel educativo do Tuco explicando o que é uma API, com animação, narração e CTA para seguir.\nOu cole o link de um vídeo para a equipe fazer a nossa versão ou estudar.' : 'O que a equipe deve preparar?'}
        />
        <button type="submit" className="hq-btn hq-btn--primary hq-home-ask__go" disabled={!ready}>{busy ? 'Enviando…' : studyLink ? 'Mandar para a equipe estudar' : link ? 'Fazer a nossa versão' : direct ? 'Criar a peça' : 'Mandar para a equipe'}</button>
      </div>
      {!link && (
        <div className="hq-home-ask__row" role="radiogroup" aria-label="Como a equipe recebe o pedido">
          <button type="button" role="radio" aria-checked={!direct} className={`hq-home-chip${!direct ? ' is-on' : ''}`} onClick={() => setDirect(false)} title="A gerente planeja as peças e distribui as etapas">A equipe planeja e distribui</button>
          <button type="button" role="radio" aria-checked={direct} className={`hq-home-chip${direct ? ' is-on' : ''}`} onClick={() => setDirect(true)} title="Você escolhe a conta e o formato de uma peça só">Uma peça (você escolhe conta e formato)</button>
        </div>
      )}
      {!link && !direct && (
        <div className="hq-home-ask__row" role="radiogroup" aria-label="Para qual equipe">
          <span className="hq-dim">Para:</span>
          {([['aurora', 'Equipe Aurora'], ['tuco-dev', 'Equipe Tuco Dev'], ['ambas', 'As duas']] as const).map(([id, label]) => {
            const on = id === 'ambas' ? teams.length === 2 : teams.length === 1 && teams[0] === id;
            return <button key={id} type="button" role="radio" aria-checked={on} className={`hq-home-chip${on ? ' is-on' : ''}`} onClick={() => setTeamsPick(id === 'ambas' ? ['aurora', 'tuco-dev'] : [id])}>{label}</button>;
          })}
          {teams.length === 2 && <span className="hq-dim">cada equipe recebe as peças dela, com briefing e entrega próprios</span>}
        </div>
      )}
      {(link || direct) && <div className="hq-home-ask__row">
        <div className="hq-home-pick" role="radiogroup" aria-label="Onde vai ser postado">
          {QUICK_SLOTS.map(s => <button key={s} type="button" role="radio" aria-checked={slot === s} className={`hq-home-chip${slot === s ? ' is-on' : ''}`} onClick={() => setSlotPick(s)}>{SLOT_LABEL[s]}</button>)}
        </div>
        <span className="hq-home-pick__sep" aria-hidden="true" />
        <div className="hq-home-pick" role="radiogroup" aria-label="Formato">
          {formats.map(f => <button key={f} type="button" role="radio" aria-checked={format === f} disabled={link && f !== 'video'} className={`hq-home-chip${format === f ? ' is-on' : ''}`} onClick={() => setFormatPick(f)}>{FORMAT_LABEL[f]}</button>)}
        </div>
      </div>}
      {(open || msg || linkToThreads) && (
        <p className={msg ? (msg.ok ? 'hq-hub-ok' : 'hq-composer__bad') : linkToThreads ? 'hq-composer__bad' : 'hq-home-ask__hint'} role={msg ? 'status' : undefined}>{msg ? msg.text : hint}</p>
      )}
    </form>
  );
}

/** Trabalho avulso da equipe: quem, o quê, há quanto tempo (rodando ou na fila). */
function WorkCard({ w, employees }: { w: LooseWork; employees: Employee[] }) {
  const name = who(employees, w.task.employeeId);
  return (
    <li className="hq-home-card hq-home-card--fazendo hq-home-card--work">
      <div className="hq-home-card__main">
        <span className="hq-home-net">{name}</span>
        <strong className="hq-home-card__title hq-home-card__title--static" title={w.task.prompt.slice(0, 600)}>{w.label}</strong>
        <span className="hq-home-card__state">{w.state === 'fazendo' ? `${name} está fazendo · começou ${ago(w.since)}` : `Na fila de ${name} · pedido ${ago(w.since)}`}</span>
      </div>
    </li>
  );
}

/** Trabalho que parou (erro, queda, reinício): o Chefe pede de novo ou dispensa. */
function StoppedCard({ w, employees, api, onResend }: { w: LooseWork; employees: Employee[]; api: ContentApi; onResend(t: Task): Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const name = who(employees, w.task.employeeId);
  return (
    <li className="hq-home-card hq-home-card--ver hq-home-card--bad">
      <div className="hq-home-card__main">
        <span className="hq-home-net">{name} · parou {ago(w.since)}</span>
        <strong className="hq-home-card__title hq-home-card__title--static" title={w.task.prompt.slice(0, 600)}>{w.label}</strong>
        {w.reason && <span className="hq-home-card__state">{w.reason}</span>}
      </div>
      <div className="hq-actions">
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy} onClick={() => void run(() => onResend(w.task))}>{busy ? 'Enviando…' : 'Pedir de novo'}</button>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy} title="Tira o cartão daqui (nada é apagado)" onClick={() => void run(() => api.hidden(`task:${w.task.id}`, 'task', 'arquivada', w.label, null))}>Dispensar</button>
      </div>
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
    </li>
  );
}

/** Pedido direto que a equipe terminou: os arquivos principais para abrir, a conversa e "Visto" (tira daqui). */
function DeliveredCard({ w, employees, api, desk }: { w: LooseWork; employees: Employee[]; api: ContentApi; desk: DeskApi }) {
  const [busy, setBusy] = useState(false);
  const name = who(employees, w.task.employeeId);
  const files = mainFiles(w.files ?? []);
  const base = (f: string) => f.split(/[\\/]/).pop() ?? f;
  return (
    <li className="hq-home-card hq-home-card--ver hq-home-card--done">
      <div className="hq-home-card__main">
        <span className="hq-home-net">{name} · entregou {ago(w.since)}</span>
        <strong className="hq-home-card__title hq-home-card__title--static" title={w.task.prompt.slice(0, 600)}>{w.label}</strong>
        {files.length > 0
          ? <span className="hq-home-files">{files.map(f => <button key={f} type="button" className="hq-linkbtn" title={f} onClick={() => desk.openFile(f)}>{base(f)}</button>)}</span>
          : <span className="hq-home-card__state">Sem arquivo final: veja a resposta na conversa.</span>}
      </div>
      <div className="hq-actions">
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => desk.openTask(w.task.id)}>Abrir conversa</button>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" disabled={busy} title="Tira o cartão daqui (nada é apagado)" onClick={() => { setBusy(true); void api.hidden(`task:${w.task.id}`, 'task', 'arquivada', w.label, null).finally(() => setBusy(false)); }}>Visto</button>
      </div>
    </li>
  );
}

/** Pedido de autorização de um funcionário da sala (permitir uma vez ou negar, ali mesmo). */
function PermissionCard({ p, name, desk }: { p: PendingPermission; name: string; desk: DeskApi }) {
  return (
    <li className="hq-home-card hq-home-card--ver hq-home-card--ask">
      <div className="hq-home-card__main">
        <span className="hq-home-net">{name} pede autorização</span>
        <strong className="hq-home-card__title hq-home-card__title--static">{p.request.toolName}</strong>
        <pre className="hq-desk__pre">{describeInput(p.request.input)}</pre>
      </div>
      <div className="hq-actions">
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => desk.permit(p.sessionId, p.request.requestId, true)}>Permitir uma vez</button>
        <button type="button" className="hq-btn hq-btn--sm" onClick={() => desk.permit(p.sessionId, p.request.requestId, false)}>Negar</button>
      </div>
    </li>
  );
}

export interface ContentHomeProps {
  /** Leitura do pedido: ensinar vira conhecimento e "o que depende de mim" abre a Mesa (10/11). */
  manager?: ComposerManager | null;
  content: ContentState | null;
  tasks: Task[];
  employees: Employee[];
  api: ContentApi | null;
  profileId: string | null;
  connected: boolean;
  onMore(k: HomeMore): void;
  /** Tarefas da sala Social Media (inclusive as que não são peça: pedido direto, Radar, análise). */
  roomTasks?: Task[];
  /** Perguntas e pedidos de autorização dos funcionários da sala. */
  pending?: PendingPermission[];
  sessions?: Session[];
  desk?: DeskApi | null;
  /** "Pedir de novo": manda o mesmo pedido para a mesma conversa do funcionário. */
  onResend?(t: Task): Promise<unknown>;
  /** Muda a cada pedido de fora (Ctrl+K, Estúdio) para abrir o "Compartilhar vídeo". */
  shareSignal?: number;
  /** Reuniões (uma com turno rodando ocupa a vaga de execução: o cartão diz que a análise espera por ela). */
  meetings?: Meeting[];
  /** Abre a conversa particular com o funcionário (a janela fica no App, sobre qualquer tela). */
  onTalk?(employeeId: string): void;
  /** Funcionários da sala Social Media (para o "Equipe agora"). */
  team?: Employee[];
  /** Fala com quem está trabalhando, no meio da tarefa (true = entrou na tarefa; false = foi para a fila). */
  onSteer?(sessionId: string, text: string): Promise<boolean>;
}

export function ContentHome({ manager = null, content, tasks, employees, api, profileId, connected, onMore, roomTasks = [], pending = [], sessions = [], desk = null, onResend, shareSignal = 0, meetings = [], onTalk, team = [], onSteer }: ContentHomeProps) {
  const meetingBusy = meetings.some(m => m.activeTurnId || (m.status === 'active' && m.queuedTurns > 0));
  const board = useMemo(() => homeBoard(content, tasks), [content, tasks]);
  const work = useMemo(() => looseWork(roomTasks, content), [roomTasks, content]);
  const missing = focusMissing(content);
  const [focusBusy, setFocusBusy] = useState(false);
  const [focusMsg, setFocusMsg] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  useEffect(() => { if (shareSignal) setSharing(true); }, [shareSignal]);
  const empOfSession = (sid: string) => { const s = sessions.find(x => x.id === sid); return who(employees, s?.employeeId ?? null); };
  const questions = desk ? pending.filter(p => p.isQuestion) : [];
  const permissions = desk ? pending.filter(p => !p.isQuestion) : [];
  const stopped = api && onResend ? work.stopped : [];
  const delivered = api && desk ? work.delivered : [];
  const fixFocus = async () => {
    if (!api || !content) return;
    setFocusBusy(true); setFocusMsg(null);
    try {
      const next = [...new Set([...(content.focus.activeSlots ?? []), ...missing])];
      const r = await api.focusSave(next, content.focus.sources.map(s => ({ source: s.source, enabled: s.enabled })));
      setFocusMsg(`Pronto: ${missing.map(slotName).join(' e ')} ${missing.length > 1 ? 'liberadas' : 'liberada'}${r.paused.length ? `; ${r.paused.length} peça(s) de outras redes ficaram pausadas (nada foi apagado)` : ''}.`);
    } catch (err) { setFocusMsg((err as Error).message); } finally { setFocusBusy(false); }
  };
  const extra = (c: HomeColumn): number => (c === 'ver' ? questions.length + permissions.length + stopped.length + delivered.length : c === 'fazendo' ? work.doing.length : 0);
  return (
    <section className="hq-view hq-home" aria-label="Conteúdo">
      <header className="hq-home__head">
        <h2>Conteúdo</h2>
        <button type="button" className={`hq-btn hq-btn--sm${sharing ? '' : ' hq-btn--primary'} hq-home__share`} aria-expanded={sharing} onClick={() => setSharing(s => !s)} title="Link do Instagram, TikTok, YouTube, Shorts ou X, ou arquivo MP4/MOV, para a equipe estudar, analisar ou fazer a nossa versão">Compartilhar vídeo</button>
        <details className="hq-home__more">
          <summary className="hq-btn hq-btn--sm hq-btn--ghost">Mais ▾</summary>
          <div className="hq-home__menu" role="menu">
            {MORE.map(m => <button key={m.id} type="button" role="menuitem" className="hq-home__menu-item" onClick={e => { (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open'); onMore(m.id); }}><b>{m.label}</b><span>{m.title}</span></button>)}
          </div>
        </details>
      </header>
      {missing.length > 0 && content && (
        <div className="hq-home-banner" role="alert">
          <span>{missing.map(slotName).join(' e ')} {missing.length > 1 ? 'estão' : 'está'} fora do foco gravado, então a equipe não produz para {missing.length > 1 ? 'elas' : 'ela'}.</span>
          <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={focusBusy || !api} onClick={() => void fixFocus()}>{focusBusy ? 'Salvando…' : 'Liberar'}</button>
        </div>
      )}
      {focusMsg && <p className="hq-hub-ok" role="status">{focusMsg}</p>}
      {sharing && api && <ShareVideo api={api} profileId={profileId} onClose={() => setSharing(false)} onAcademy={() => onMore('academia')} />}
      {api ? <Ask api={api} profileId={profileId} connected={connected} manager={manager} /> : <p className="hq-empty">Conectando ao serviço…</p>}
      {onTalk && <TeamNowStrip employees={team} tasks={tasks} sessions={sessions} content={content} onTalk={onTalk} onSteer={onSteer} />}
      {api && <PlansPanel content={content} employees={employees} api={api} tasks={tasks} />}
      <div className="hq-home-cols">
        {HOME_COLUMNS.map(c => {
          const col = board.cols[c.id];
          const n = col.items.length + col.refs.length + extra(c.id);
          return (
            <section key={c.id} className={`hq-home-col hq-home-col--${c.id}`} aria-label={c.label}>
              <h3 className="hq-home-col__title">{c.label} <span className="hq-home-col__n">{n}</span></h3>
              <p className="hq-home-col__hint">{c.hint}</p>
              {n === 0 ? <p className="hq-home-col__empty">{c.empty}</p> : (
                <ul className="hq-home-list">
                  {c.id === 'ver' && desk && questions.map(q => <QuestionCard key={q.request.requestId} q={q} who={empOfSession(q.sessionId)} task={roomTasks.find(t => t.id === q.taskId) ?? null} api={desk} />)}
                  {c.id === 'ver' && desk && permissions.map(p => <PermissionCard key={p.request.requestId} p={p} name={empOfSession(p.sessionId)} desk={desk} />)}
                  {c.id === 'ver' && api && desk && delivered.map(w => <DeliveredCard key={w.task.id} w={w} employees={employees} api={api} desk={desk} />)}
                  {c.id === 'ver' && api && onResend && stopped.map(w => <StoppedCard key={w.task.id} w={w} employees={employees} api={api} onResend={onResend} />)}
                  {c.id === 'fazendo' && work.doing.map(w => <WorkCard key={w.task.id} w={w} employees={employees} />)}
                  {api && col.refs.map(r => {
                    const w = refTaskState(r, content, tasks);
                    return <RefCard key={r.id} r={r} col={c.id} api={api} onDetails={() => onMore('mesa')} study={r.video?.studyId ? content?.academy?.studies.find(s => s.id === r.video!.studyId) ?? null : null}
                      work={w ? { status: w.status, name: who(employees, w.employeeId) } : null} meetingBusy={meetingBusy} />;
                  })}
                  {api && col.items.map(i => <PieceCard key={i.id} item={i} col={c.id} tasks={tasks} employees={employees} api={api} />)}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {board.otherNetworks > 0 && <p className="hq-home__other hq-dim">{board.otherNetworks} peça(s) de outras redes (TikTok, LinkedIn, X, Pinterest) ficam no <button type="button" className="hq-linkbtn" onClick={() => onMore('mural')}>Mural completo</button>.</p>}
    </section>
  );
}
