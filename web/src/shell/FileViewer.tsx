// Visualizador da HQ: abre o resultado na própria tela (slides, Pin, vídeo, texto) com Copiar, Abrir no Windows e Mostrar
// na pasta. Antes, "Abrir" chamava o Explorador com o arquivo só selecionado na pasta, e a janela costumava surgir atrás do
// navegador. Cada arquivo é conferido no servidor: caminho citado que não existe aparece como faltando, nunca como entrega.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { FileView } from '@milweb-hq/protocol';
import { Modal } from '../panel/dialogs/Modal';
import { MdLite, isMarkdown } from './social/MdLite';
import { captionOf } from './social/socialHelpers';

export interface ViewerApi {
  view(path: string): Promise<FileView>;
  /** file = programa padrão do Windows; reveal = Explorador com o arquivo selecionado. */
  open(target: 'file' | 'reveal', path: string): void;
  copy(text: string): Promise<boolean>;
}

/** O que abrir: lista de arquivos (a ordem de uso) e, quando houver, o texto exato a publicar. */
export interface ViewerRequest {
  title: string;
  files: string[];
  index?: number;
  /** Texto do post (entrega.json) ou da resposta. */
  text?: string | null;
  /** Caminhos citados que não existem no disco. */
  missing?: string[];
  /** Linha de contexto (conta, data, responsável). */
  meta?: string | null;
  /** Peça de conteúdo aberta: a decisão (aprovar, já publiquei, ajustes) aparece no próprio visualizador. */
  itemId?: string | null;
  /** Nome mostrado de cada arquivo (ex.: "versão anterior 2026-11-04-1355.mp4"); ausente = nome do arquivo. */
  labels?: string[];
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function FileViewer({ req, api, onClose, decide }: { req: ViewerRequest; api: ViewerApi; onClose(): void; decide?: ReactNode }) {
  const [i, setI] = useState(() => Math.min(Math.max(req.index ?? 0, 0), Math.max(req.files.length - 1, 0)));
  const [cur, setCur] = useState<{ path: string; state: 'loading' | 'ok' | 'error'; view?: FileView; error?: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const file = req.files[i] ?? null;
  useEffect(() => {
    if (!file) { setCur(null); return; }
    let alive = true;
    setCur({ path: file, state: 'loading' });
    api.view(file)
      .then(view => { if (alive) setCur({ path: file, state: 'ok', view }); })
      .catch(err => { if (alive) setCur({ path: file, state: 'error', error: String((err as Error).message ?? err) }); });
    return () => { alive = false; };
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = useCallback((d: number) => setI(x => Math.min(Math.max(x + d, 0), req.files.length - 1)), [req.files.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);
  const copy = async (what: string, value: string) => { if (await api.copy(value)) { setCopied(what); window.setTimeout(() => setCopied(c => (c === what ? null : c)), 1800); } };
  const v = cur?.state === 'ok' && cur.path === file ? cur.view! : null;
  const caption = req.text ?? null;
  const fileCaption = v?.text && !caption ? captionOf(v.text) : null;

  return (
    <Modal open title={req.title} onCancel={onClose} width={1040}>
      <div className="hq-viewer">
        {req.meta && <p className="hq-dim hq-viewer__meta">{req.meta}</p>}
        {decide}
        {req.files.length > 1 && (
          <div className="hq-viewer__files" role="tablist" aria-label="Arquivos da entrega">
            {req.files.map((f, k) => (
              <button key={f} type="button" role="tab" aria-selected={k === i} className={`hq-chip hq-chip--xs${k === i ? ' hq-soc-chip--on' : ''}`} onClick={() => setI(k)} title={f}>{req.labels?.[k] ?? base(f)}</button>
            ))}
          </div>
        )}
        <div className="hq-viewer__stage">
          {!file ? <p className="hq-empty">Nenhum arquivo existente nesta entrega{caption ? '; o texto do post está abaixo.' : '.'}</p>
            : cur?.state === 'error' && cur.path === file ? <p className="hq-composer__bad" role="alert">Não deu para abrir {base(file)}: {cur.error}</p>
              // Sem a prévia deste arquivo ainda (carregando ou trocando de arquivo): nunca mostra o anterior.
              : !v ? <p className="hq-dim">Abrindo {base(file)}…</p>
                : v!.kind === 'image' && v!.url ? <img className="hq-viewer__img" src={v!.url} alt={v!.name} />
                  : v!.kind === 'video' && v!.url ? <video key={v!.url} className="hq-viewer__video" src={v!.url} controls preload="metadata" />
                    : v!.kind === 'audio' && v!.url ? <audio key={v!.url} src={v!.url} controls preload="metadata" />
                      : v!.kind === 'pdf' && v!.url ? <iframe className="hq-viewer__pdf" src={v!.url} title={v!.name} />
                        : v!.kind === 'text' ? (isMarkdown(v!.name) ? <MdLite text={v!.text ?? ''} className="hq-viewer__text" /> : <pre className="hq-soc-preview hq-viewer__text">{v!.text}</pre>)
                          : <p className="hq-dim">{v!.name} não tem prévia aqui dentro. Use "Abrir no programa do Windows".</p>}
        </div>
        {v && <p className="hq-dim hq-viewer__info">{v.name} · {size(v.size)}{v.truncated ? ' · arquivo grande: a prévia mostra só o começo' : ''}{req.files.length > 1 ? ` · ${i + 1} de ${req.files.length}` : ''}</p>}
        {caption && (
          <details className="hq-viewer__caption" open>
            <summary className="hq-label">Texto do post</summary>
            <pre className="hq-soc-preview">{caption}</pre>
          </details>
        )}
        {req.missing && req.missing.length > 0 && (
          <div className="hq-hub-warn" role="status">
            <strong>Citado na entrega, mas não existe no disco:</strong>
            <ul className="hq-ct-list">{req.missing.map(m => <li key={m}>{m}</li>)}</ul>
          </div>
        )}
        <div className="hq-actions hq-viewer__actions">
          {req.files.length > 1 && <button type="button" className="hq-btn hq-btn--sm" disabled={i === 0} onClick={() => go(-1)} aria-label="Arquivo anterior">‹ Anterior</button>}
          {req.files.length > 1 && <button type="button" className="hq-btn hq-btn--sm" disabled={i >= req.files.length - 1} onClick={() => go(1)} aria-label="Próximo arquivo">Próximo ›</button>}
          {caption && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => void copy('post', caption)}>Copiar texto do post</button>}
          {fileCaption && <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" onClick={() => void copy('legenda', fileCaption)}>Copiar legenda</button>}
          {v?.text && <button type="button" className="hq-btn hq-btn--sm" onClick={() => void copy('arquivo', v.text!)}>Copiar este texto</button>}
          {v && <button type="button" className="hq-btn hq-btn--sm" onClick={() => api.open('file', v.path)} title="Abre no programa padrão do Windows (a janela pode surgir atrás do navegador: olhe a barra de tarefas)">Abrir no programa do Windows</button>}
          {file && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => api.open('reveal', file)} title="Abre o Explorador com o arquivo selecionado">Mostrar na pasta</button>}
          {copied && <span className="hq-soc-copied" role="status">{copied === 'post' ? 'Texto do post copiado' : copied === 'legenda' ? 'Legenda copiada' : 'Texto copiado'}</span>}
        </div>
      </div>
    </Modal>
  );
}
