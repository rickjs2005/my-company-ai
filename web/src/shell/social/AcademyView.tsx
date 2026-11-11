// Academia de Vídeo (07/11/2026): os estudos que o Chefe pediu ("estudem esse vídeo") com o progresso real (Diretor estudando,
// aula, exercícios, correção), os arquivos de cada etapa, os exercícios por pessoa com o resultado e a correção, o histórico
// e a biblioteca de técnicas (observado × inferido) que a equipe lê antes de montar um vídeo.
import { useState } from 'react';
import type { AcademyStudy, AcademyTechnique, ContentState, TechniqueCategory } from '@milweb-hq/protocol';
import { ACADEMY_EXERCISE_STATUS_LABEL, ACADEMY_STUDY_STATUS_LABEL, TECHNIQUE_CATEGORY_LABEL, TECHNIQUE_EVIDENCE_LABEL } from '@milweb-hq/protocol';
import { filterTechniques, studyProgress } from './academyBoard';
import type { ContentApi } from './ContentViews';

const when = (t: number) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const base = (f: string) => f.split(/[\\/]/).pop() ?? f;

function FileBtn({ api, file, label }: { api: ContentApi; file: string | null | undefined; label: string }) {
  return file ? <button type="button" className="hq-linkbtn" title={file} onClick={() => api.openFile(file)}>{label}</button> : null;
}

export function StudyCard({ st, content, api }: { st: AcademyStudy; content: ContentState; api: ContentApi }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (k: string, fn: () => Promise<unknown>) => { setBusy(k); setError(null); try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(null); } };
  const p = studyProgress(st);
  const techs = st.techniques.map(t => ({ ...t, info: content.academy?.techniques.find(x => x.slug === t.slug) ?? null }));
  const ref = content.radar.find(r => r.id === st.radarId);
  return (
    <li className={`hq-acad-study hq-acad-study--${st.status}`}>
      <div className="hq-ct-card__head">
        <span className={`hq-tag hq-tag--xs hq-acad-st hq-acad-st--${st.status}`}>{ACADEMY_STUDY_STATUS_LABEL[st.status]}</span>
        {p.total > 0 && <span className="hq-dim">exercícios: {p.done} de {p.total} entregues{p.failed ? ` · ${p.failed} não deram certo` : ''}{p.ok + p.adjust ? ` · correção: ${p.ok} ok, ${p.adjust} ajustar` : ''}</span>}
        <span className="hq-dim">pedido em {when(st.createdAt)}</span>
      </div>
      <strong className="hq-ct-card__title">{ref?.subject ?? st.title}</strong>
      <p className="hq-ct-meta">
        {st.url ? <button type="button" className="hq-linkbtn" onClick={() => api.openUrl(st.url!)} title={st.url}>ver o vídeo original</button> : <span>vídeo anexado</span>}
        {st.request && <span> · você escreveu: "{st.request}"</span>}
      </p>
      {st.summary && <p><span className="hq-dim">Lição: </span>{st.summary}</p>}
      <div className="hq-actions hq-acad-files">
        <FileBtn api={api} file={st.analysis} label="análise (Video Analyzer)" />
        <FileBtn api={api} file={st.lesson} label="lição" />
        <FileBtn api={api} file={st.lessonSynthesis} label="síntese da aula" />
        <FileBtn api={api} file={st.feedback} label="correção" />
        <FileBtn api={api} file={ref?.video?.inspection?.watch?.report} label="relatório da Watch" />
        {st.meetingId && <button type="button" className="hq-linkbtn" onClick={() => api.openMeeting?.(st.meetingId!)}>abrir a aula (reunião)</button>}
      </div>
      {techs.length > 0 && (
        <ul className="hq-acad-chips" aria-label="Técnicas do estudo">
          {techs.map(t => (
            <li key={t.slug} className={`hq-acad-chip hq-acad-chip--${t.evidence}`} title={t.info?.summary ?? t.slug}>
              <button type="button" className="hq-linkbtn" disabled={!t.info?.file} onClick={() => t.info?.file && api.openFile(t.info.file)}>{t.info?.name ?? t.slug}</button>
              <span className="hq-dim"> · {t.evidence === 'observado' ? 'observado' : 'inferido'}</span>
            </li>
          ))}
        </ul>
      )}
      {st.exercises.length > 0 && (
        <ol className="hq-acad-ex" aria-label="Exercícios">
          {st.exercises.map(e => (
            <li key={e.id} className={`hq-acad-ex__item hq-acad-ex__item--${e.status}`}>
              <div><strong>{e.employeeName ?? e.role}</strong> · {e.title} <span className={`hq-tag hq-tag--xs hq-acad-exst--${e.status}`}>{ACADEMY_EXERCISE_STATUS_LABEL[e.status]}</span>
                {e.feedback && <span className={`hq-tag hq-tag--xs hq-acad-verdict--${e.feedback.verdict}`}>{e.feedback.verdict === 'ok' ? 'aprovado pelo Diretor' : 'ajustar'}</span>}</div>
              <p className="hq-dim">Entrega: {e.deliverable}</p>
              {e.result && (
                <div className="hq-acad-ex__res">
                  {e.result.summary && (e.result.summary.length > 240
                    ? <details><summary>{e.result.summary.slice(0, 220).replace(/\s+\S*$/, '')}… <span className="hq-dim">ver tudo</span></summary><p>{e.result.summary}</p></details>
                    : <p>{e.result.summary}</p>)}
                  {e.result.files.length > 0 && <p className="hq-home-files">{e.result.files.map(f => <button key={f} type="button" className="hq-linkbtn" title={f} onClick={() => api.openFile(f)}>{base(f)}</button>)}</p>}
                  {e.result.render && <p className="hq-dim">Vídeo: {e.result.render === 'renderizando' ? 'a HQ está renderizando…' : e.result.render}</p>}
                  {(e.result.learned || e.result.doubts) && <details><summary className="hq-dim">o que aprendeu e dúvidas</summary>{e.result.learned && <p>Aprendi: {e.result.learned}</p>}{e.result.doubts && <p>Dúvidas: {e.result.doubts}</p>}</details>}
                </div>
              )}
              {e.feedback && <p><span className="hq-dim">Correção: </span>{e.feedback.note}</p>}
              {e.error && <p className="hq-composer__bad">{e.error}</p>}
              {e.status === 'falhou' && <button type="button" className="hq-btn hq-btn--sm" disabled={busy !== null} onClick={() => void run(e.id, () => api.academyRetry(st.id, e.id))}>{busy === e.id ? 'Enviando…' : 'Pedir de novo'}</button>}
            </li>
          ))}
        </ol>
      )}
      {st.status === 'bloqueado' && (
        <div className="hq-vcard__block" role="alert">
          <p><strong>Parado:</strong> {st.error ?? 'veja o histórico'}</p>
          <div className="hq-actions"><button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={busy !== null} onClick={() => void run('st', () => api.academyRetry(st.id, null))}>{busy === 'st' ? 'Enviando…' : 'Tentar de novo'}</button></div>
        </div>
      )}
      {st.history.length > 0 && (
        <details className="hq-acad-hist">
          <summary className="hq-dim">Histórico ({st.history.length})</summary>
          <ol>{st.history.slice().reverse().map((h, k) => <li key={k}><span className="hq-dim">{when(h.at)}</span>{h.who ? ` · ${h.who}` : ''} · {h.text}</li>)}</ol>
        </details>
      )}
      {error && <p className="hq-composer__bad" role="alert">{error}</p>}
    </li>
  );
}

function TechniqueRow({ t, api }: { t: AcademyTechnique; api: ContentApi }) {
  const obs = t.sources.some(s => s.evidence === 'observado');
  const ok = t.examples.filter(e => e.verdict === 'ok').length;
  return (
    <li className="hq-acad-tech">
      <div className="hq-ct-card__head">
        <span className="hq-tag hq-tag--xs">{TECHNIQUE_CATEGORY_LABEL[t.category]}</span>
        <span className={`hq-tag hq-tag--xs hq-acad-chip--${obs ? 'observado' : 'inferido'}`}>{TECHNIQUE_EVIDENCE_LABEL[obs ? 'observado' : 'inferido']}</span>
        <span className="hq-dim">{t.sources.length} estudo(s){t.examples.length ? ` · ${t.examples.length} exercício(s)${ok ? `, ${ok} aprovado(s)` : ''}` : ''}</span>
      </div>
      <strong>{t.name}</strong> <code className="hq-dim">{t.slug}</code>
      <p>{t.summary}</p>
      {t.how.length > 0 && <p className="hq-dim">Como fazer: {t.how.map(h => h.tool).join(', ')}</p>}
      <div className="hq-actions"><FileBtn api={api} file={t.file} label="abrir a ficha" /></div>
    </li>
  );
}

export function AcademyView({ content, api, onShare }: { content: ContentState; api: ContentApi; onShare?(): void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<TechniqueCategory | ''>('');
  const ac = content.academy;
  if (!ac) return <p className="hq-empty">Este servidor ainda não tem a Academia de Vídeo: reinicie a HQ.</p>;
  const techs = filterTechniques(ac.techniques, q, cat);
  return (
    <div className="hq-acad">
      <section className="hq-section">
        <h3 className="hq-label">Estudos ({ac.studies.length})</h3>
        <p className="hq-dim">Compartilhe um vídeo escrevendo, por exemplo, "Equipe, estudem esse vídeo": o Diretor de Vídeo analisa, dá a aula, passa exercícios e corrige. O que fica aprendido vai para as fichas abaixo e para <FileBtn api={api} file={ac.index} label="academia/INDICE.md" />{ac.index ? '' : 'academia/INDICE.md (criado no primeiro estudo)'}, que a equipe lê antes de montar qualquer vídeo.</p>
        {onShare && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={onShare}>Compartilhar vídeo</button>}
        {ac.studies.length === 0 ? <p className="hq-empty">Nenhum estudo ainda.</p> : <ul className="hq-acad-list">{ac.studies.map(st => <StudyCard key={st.id} st={st} content={content} api={api} />)}</ul>}
      </section>
      <section className="hq-section">
        <h3 className="hq-label">Técnicas aprendidas ({ac.techniques.length})</h3>
        <div className="hq-actions">
          <input className="hq-input hq-input--sm" value={q} onChange={e => setQ(e.target.value)} placeholder="Procurar técnica" aria-label="Procurar técnica" />
          <select className="hq-select hq-select--sm" value={cat} onChange={e => setCat(e.target.value as TechniqueCategory | '')} aria-label="Categoria">
            <option value="">todas as categorias</option>
            {(Object.keys(TECHNIQUE_CATEGORY_LABEL) as TechniqueCategory[]).map(c => <option key={c} value={c}>{TECHNIQUE_CATEGORY_LABEL[c]}</option>)}
          </select>
        </div>
        {techs.length === 0 ? <p className="hq-empty">{ac.techniques.length ? 'Nenhuma técnica com esse filtro.' : 'A biblioteca começa no primeiro estudo.'}</p> : <ul className="hq-acad-techs">{techs.map(t => <TechniqueRow key={t.id} t={t} api={api} />)}</ul>}
      </section>
    </div>
  );
}
