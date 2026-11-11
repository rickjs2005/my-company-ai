// Cartão da referência de vídeo (Mesa e Radar): progresso real (recebida → abrindo o vídeo → em análise → em discussão →
// proposta → em produção → renderizando → para revisar), o nível de inspeção com os limites, o bloqueio com a ação útil
// (Abrir para login, Tentar novamente, Anexar vídeo), a análise, a reunião vinculada e as produções que saíram dela.
// Referência não conta como publicação pronta.
import { useEffect, useRef, useState } from 'react';
import type { ContentItem, ContentState, RadarItem, SocialSlotId, VideoRefStage } from '@milweb-hq/protocol';
import { ACADEMY_STUDY_STATUS_LABEL, CONTENT_ITEM_STATUS_LABEL, SOCIAL_SLOTS, VIDEO_LEVEL_LABEL, VIDEO_MODE_LABEL, VIDEO_ROLE_LABEL, VIDEO_STAGE_LABEL, VIDEO_TASK_STATUS, VIDEO_TASK_STATUS_LABEL } from '@milweb-hq/protocol';
import type { ContentApi } from './ContentViews';

const STEPS: VideoRefStage[] = ['recebida', 'inspecionando', 'analisando', 'discussao', 'proposta', 'producao', 'renderizando', 'revisar'];
const STUDY_STEPS: VideoRefStage[] = ['recebida', 'inspecionando', 'analisando', 'aula', 'exercicios', 'concluida'];
const when = (t: number) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const slotLabel = (s: SocialSlotId | null) => (s ? SOCIAL_SLOTS.find(x => x.slot === s)?.label ?? s : 'a definir');

/** Referências de vídeo ativas (as descartadas saem), da mais recente para a mais antiga. Na Mesa, a que só tem peça na lixeira também sai. */
export function videoRefs(c: ContentState | null, o: { hideTrashed?: boolean } = {}): RadarItem[] {
  return (c?.radar ?? []).filter(r => r.video && r.status !== 'descartada' && !(o.hideTrashed && r.video.stage === 'lixeira')).sort((a, b) => (b.video!.updatedAt ?? 0) - (a.video!.updatedAt ?? 0));
}

function Thumb({ r, api }: { r: RadarItem; api: ContentApi }) {
  const [src, setSrc] = useState<string | null>(null);
  const pic = r.video?.inspection?.thumbnail ?? r.video?.inspection?.sheets[0] ?? null;
  useEffect(() => { let alive = true; if (pic) void api.image(pic).then(s => { if (alive) setSrc(s); }).catch(() => undefined); else setSrc(null); return () => { alive = false; }; }, [pic]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="hq-vcard__thumb">{src ? <img src={src} alt="" /> : <span>▶</span>}</div>;
}

export function VideoRefCard({ r, content, api, onOpenMeeting }: { r: RadarItem; content: ContentState; api: ContentApi; onOpenMeeting?(id: string): void }) {
  const v = r.video!;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<SocialSlotId | ''>(v.slot ?? '');
  const pick = useRef<HTMLInputElement | null>(null);
  const run = async (k: string, fn: () => Promise<unknown>) => { setBusy(k); setError(null); try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(null); } };
  const ins = v.inspection;
  const url = r.sourceUrl.startsWith('chefe://') ? null : r.sourceUrl;
  const items = v.itemIds.map(id => content.items.find(i => i.id === id)).filter((i): i is ContentItem => Boolean(i));
  const active = content.focus?.activeSlots ?? SOCIAL_SLOTS.map(s => s.slot);
  // Analisar e produzir vai direto da análise para a produção (05/11): sem as etapas de discussão e proposta.
  const steps = v.mode === 'estudo' ? STUDY_STEPS : v.mode === 'produzir' ? STEPS.filter(s => s !== 'discussao' && s !== 'proposta') : STEPS;
  const study = v.studyId ? content.academy?.studies.find(s => s.id === v.studyId) ?? null : null;
  const simple = VIDEO_TASK_STATUS[v.stage];
  const step = steps.indexOf(v.stage);
  // Peça na lixeira não volta por aqui (em 05/11 um clique neste botão recriou o Reel que o Chefe tinha jogado fora).
  const canProduce = v.mode !== 'estudo' && v.stage !== 'lixeira' && (v.stage === 'proposta' || (v.synthesis && !items.some(i => !i.deletedAt))) && !busy;
  const extras = v.extras ?? [];
  return (
    <li className={`hq-vcard hq-vcard--${v.stage}`}>
      <Thumb r={r} api={api} />
      <div className="hq-vcard__body">
        <div className="hq-ct-card__head">
          <span className={`hq-tag hq-tag--xs hq-vcard__stage hq-vcard__stage--${v.stage}`}>{VIDEO_STAGE_LABEL[v.stage]}</span>
          {VIDEO_TASK_STATUS_LABEL[simple] !== VIDEO_STAGE_LABEL[v.stage] && <span className={`hq-tag hq-tag--xs hq-vstatus hq-vstatus--${simple}`}>{VIDEO_TASK_STATUS_LABEL[simple]}</span>}
          <span className="hq-tag hq-tag--xs">{VIDEO_MODE_LABEL[v.mode]}</span>
          {v.mode !== 'estudo' && <span className="hq-dim">perfil: {slotLabel(v.slot)}</span>}
        </div>
        <strong className="hq-ct-card__title">{r.subject}</strong>
        <p className="hq-ct-meta">
          {url ? <button type="button" className="hq-linkbtn" onClick={() => api.openUrl(url)} title={url}>{ins?.platform ?? r.sourceName ?? 'link'}</button> : <span>vídeo anexado</span>}
          {r.author ? ` · ${r.author}` : ''}{ins?.publishedAt ? ` · publicado ${ins.publishedAt}` : ''}{ins?.duration ? ` · ${ins.duration.toFixed(0)} s` : ''} · enviado {new Date(r.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </p>
        <ol className="hq-vcard__steps" aria-label="Progresso">{steps.map((s, k) => <li key={s} className={k < step ? 'is-done' : k === step ? 'is-now' : ''}>{VIDEO_STAGE_LABEL[s]}</li>)}</ol>
        {v.liked && <p><span className="hq-dim">Você gostou de: </span>{v.liked}</p>}
        {ins && (
          <details className="hq-vcard__insp">
            <summary><span className="hq-dim">Inspeção: </span>{VIDEO_LEVEL_LABEL[ins.level]}{ins.sameMedia === true ? ' · mídia confere com o link' : ''}</summary>
            <p className="hq-dim">{ins.summary}</p>
            <ul className="hq-ct-list">{ins.limits.map((l, k) => <li key={k}>{l}</li>)}</ul>
            {ins.watch && <p className="hq-dim">Skill Watch{ins.watch.version ? ` ${ins.watch.version}` : ''}: {ins.watch.ok ? `${ins.watch.frames.length} quadro(s) por cena, pelo ${ins.watch.source}${ins.watch.transcript && !/^none/i.test(ins.watch.transcript) ? ` · transcrição ${ins.watch.transcript}` : ' · sem legenda nativa'}` : `não assistiu (${ins.watch.error ?? '?'})`}</p>}
            <div className="hq-actions">
              {ins.watch?.report && <button type="button" className="hq-linkbtn" onClick={() => api.openFile(ins.watch!.report!)}>relatório da Watch</button>}
              {ins.watch?.ok && ins.watch.frames[0] && <button type="button" className="hq-linkbtn" onClick={() => api.openFile(ins.watch!.frames[0].file)}>quadros da Watch</button>}
              {ins.sheets.length > 0 && <button type="button" className="hq-linkbtn" onClick={() => api.openFile(ins.sheets[0])}>ver os quadros</button>}
              <button type="button" className="hq-linkbtn" onClick={() => api.openFile(`${v.dir}\\evidencias.md`)}>evidências medidas</button>
            </div>
          </details>
        )}
        {extras.length > 0 && (
          <ul className="hq-ct-list hq-vcard__extras" aria-label="Outros vídeos do pedido">
            {extras.map((x, k) => (
              <li key={x.dir}>
                <span className="hq-tag hq-tag--xs">vídeo {k + 2} · {VIDEO_ROLE_LABEL[x.role]}</span>{' '}
                <button type="button" className="hq-linkbtn" onClick={() => api.openUrl(x.url)} title={x.url}>{x.author ?? new URL(x.url).hostname.replace(/^www./, '')}</button>
                {x.note ? <span className="hq-dim"> · "{x.note}"</span> : null}
                <span className="hq-dim"> · {x.error ? `não abriu: ${x.error}` : x.level ? `${VIDEO_LEVEL_LABEL[x.level]}${x.duration ? `, ${x.duration.toFixed(0)} s` : ''}${x.audioFile ? ', áudio extraído' : ''}` : 'abrindo…'}</span>
                {x.sheets.length > 0 && <> · <button type="button" className="hq-linkbtn" onClick={() => api.openFile(x.sheets[0])}>quadros</button></>}
              </li>
            ))}
          </ul>
        )}
        {v.stage === 'lixeira' && <p className="hq-dim">A peça que saiu desta referência está na lixeira, e nada é refeito por aqui. Para recuperá-la, restaure pela Lixeira; para outra versão, cole o link de novo pedindo o vídeo.</p>}
        {/* "Bloqueada" que vem da PEÇA (entrega parcial ou falha), não do vídeo: o problema é a entrega, e anexar ou logar
            não resolve (05/11: o vídeo da pedra estava pronto e o cartão dizia "sem acesso ao vídeo"). */}
        {v.stage === 'bloqueada' && items.some(i => !i.deletedAt && (i.status === 'parcial' || i.status === 'falhou')) && (() => {
          const bad = items.find(i => !i.deletedAt && (i.status === 'parcial' || i.status === 'falhou'))!;
          return (
            <div className="hq-vcard__block" role="alert">
              <p><strong>{bad.status === 'falhou' ? 'A produção falhou' : 'A peça ficou com pendência'}:</strong> {bad.nextStep ?? 'veja ao abrir a peça'}</p>
              <div className="hq-actions">
                <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => api.openPiece(bad)}>Abrir a peça</button>
              </div>
            </div>
          );
        })()}
        {v.stage === 'bloqueada' && !items.some(i => !i.deletedAt && (i.status === 'parcial' || i.status === 'falhou')) && (
          <div className="hq-vcard__block" role="alert">
            <p><strong>Bloqueada:</strong> {v.error ?? ins?.blocked?.reason ?? 'sem acesso ao vídeo'}</p>
            <div className="hq-actions">
              {url && (ins?.blocked?.actions ?? ['login']).includes('login') && <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.openUrl(url)} title="Abre o post no seu navegador; depois de entrar na conta, anexe o vídeo ou tente de novo">Abrir para login</button>}
              <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} onClick={() => void run('retry', () => api.videoRetry(r.id, null))}>{busy === 'retry' ? 'Tentando…' : 'Tentar novamente'}</button>
              <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null} onClick={() => pick.current?.click()}>{busy === 'attach' ? 'Enviando…' : 'Anexar vídeo'}</button>
              <input ref={pick} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run('attach', () => api.videoRetry(r.id, f)); }} />
            </div>
          </div>
        )}
        {v.analysis && (
          <div className="hq-vcard__analysis">
            {v.analysis.central && <p><span className="hq-dim">Ideia central: </span>{v.analysis.central}</p>}
            {v.analysis.recommended && <p><span className="hq-dim">{v.mode === 'estudo' ? 'Lição' : `Recomendação ${v.analysis.by ? `de ${v.analysis.by}` : 'do pesquisador'}`}: </span>{v.analysis.recommended}</p>}
            <div className="hq-actions">
              {v.analysis.md && <button type="button" className="hq-linkbtn" onClick={() => api.openFile(v.analysis!.md!)}>ler a análise</button>}
              {v.analysis.direction && <button type="button" className="hq-linkbtn" onClick={() => api.openFile(v.analysis!.direction!)}>roteiro e storyboard</button>}
            </div>
          </div>
        )}
        {v.meetingId && <p className="hq-dim">Reunião: {v.synthesis ? `síntese de ${v.synthesis.author}` : 'discussão em andamento'}{onOpenMeeting && <> · <button type="button" className="hq-linkbtn" onClick={() => onOpenMeeting(v.meetingId!)}>abrir a reunião</button></>}</p>}
        {v.synthesis && <details className="hq-vcard__synth"><summary>Direção decidida (síntese)</summary><pre className="hq-soc-preview">{v.synthesis.text}</pre></details>}
        {canProduce && (
          <div className="hq-actions">
            <select className="hq-select hq-select--sm" value={slot} onChange={e => setSlot(e.target.value as SocialSlotId | '')} aria-label="Perfil da versão">
              <option value="">escolha o perfil</option>
              {active.map(s => <option key={s} value={s}>{slotLabel(s)}</option>)}
            </select>
            <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null || !slot} onClick={() => void run('prod', () => api.videoProduce(r.id, slot || null))}>{busy === 'prod' ? 'Mandando…' : 'Produzir esta versão'}</button>
          </div>
        )}
        {items.length > 0 && (
          <ul className="hq-ct-list">{items.map(i => <li key={i.id}>{slotLabel(i.slot)}: {i.deletedAt ? 'na lixeira' : CONTENT_ITEM_STATUS_LABEL[i.status]} · <button type="button" className="hq-linkbtn" onClick={() => api.openPiece(i)}>{i.title.slice(0, 60)}</button></li>)}</ul>
        )}
        {study && (
          <div className="hq-vcard__analysis">
            <p><span className="hq-dim">Academia: </span>{ACADEMY_STUDY_STATUS_LABEL[study.status]}{study.exercises.length ? ` · ${study.exercises.filter(e => e.status === 'concluido').length} de ${study.exercises.length} exercício(s) entregue(s)` : ''}</p>
            {api.openAcademy && <button type="button" className="hq-linkbtn" onClick={api.openAcademy}>abrir na Academia</button>}
          </div>
        )}
        {(v.events?.length ?? 0) > 0 && (
          <details className="hq-acad-hist">
            <summary className="hq-dim">Histórico ({v.events!.length})</summary>
            <ol>{v.events!.slice().reverse().map((h, k) => <li key={k}><span className="hq-dim">{when(h.at)}</span>{h.who ? ` · ${h.who}` : ''} · {h.text}</li>)}</ol>
          </details>
        )}
        {v.error && v.stage !== 'bloqueada' && <p className="hq-dim">{v.error}</p>}
        {error && <p className="hq-composer__bad" role="alert">{error}</p>}
      </div>
    </li>
  );
}

export function VideoRefList({ content, api, onOpenMeeting, limit, hideTrashed }: { content: ContentState; api: ContentApi; onOpenMeeting?(id: string): void; limit?: number; hideTrashed?: boolean }) {
  const refs = videoRefs(content, { hideTrashed }).slice(0, limit ?? 20);
  if (!refs.length) return null;
  return (
    <section className="hq-section">
      <h3 className="hq-label">Referências de vídeo ({refs.length})</h3>
      <ul className="hq-vcard__list">{refs.map(r => <VideoRefCard key={r.id} r={r} content={content} api={api} onOpenMeeting={onOpenMeeting} />)}</ul>
    </section>
  );
}
