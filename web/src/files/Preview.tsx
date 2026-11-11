// Preview/editor do item selecionado: texto em <textarea> monoespaçada com Salvar e conflito de mtime; imagens por data URL
// (SVG só como <img>, nunca como documento); binário/grande só informações + "Abrir no programa padrão".
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FsEntry, FsReadResult } from '@milweb-hq/protocol';
import type { FsApi } from './api';
import { absolutePath, countLabel, errorText, fileKind, formatDate, formatSize } from './helpers';
import { FileIcon, IconExternal, IconSave, IconWarn } from './icons';

export interface PreviewProps {
  api: FsApi;
  rootId: string;
  rootPath: string;
  entry: FsEntry | null;
  connected: boolean;
  /** Mudança no disco relatada pelo servidor (recarrega se não houver alterações não salvas). */
  reloadNonce: number;
  onOpenExternal(target: 'folder' | 'file', absPath: string): void;
  onNotice(level: 'info' | 'warn' | 'error', text: string): void;
  onDirtyChange(path: string | null, dirty: boolean): void;
}

type Loaded = { kind: 'text'; data: FsReadResult } | { kind: 'image'; data: FsReadResult } | { kind: 'none'; data: FsReadResult };

export function Preview({ api, rootId, rootPath, entry, connected, reloadNonce, onOpenExternal, onNotice, onDirtyChange }: PreviewProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const path = entry?.type === 'file' ? entry.path : null;

  const load = useCallback(async (p: string) => {
    setLoading(true); setError(null); setConflict(null);
    try {
      const r = await api.read(rootId, p);
      const kind: Loaded['kind'] = r.encoding === 'utf8' ? 'text' : r.encoding === 'base64' && r.mediaType.startsWith('image/') ? 'image' : 'none';
      setLoaded({ kind, data: r });
      if (kind === 'text') { setText(r.content); }
      setDirty(false); dirtyRef.current = false;
    } catch (err) { setLoaded(null); setError(errorText(err)); }
    finally { setLoading(false); }
  }, [api, rootId]);

  useEffect(() => {
    setLoaded(null); setError(null); setDirty(false); dirtyRef.current = false; setConflict(null);
    if (path) void load(path);
  }, [path, load]);

  useEffect(() => { if (path && !dirtyRef.current && reloadNonce > 0) void load(path); }, [reloadNonce, path, load]);

  useEffect(() => { onDirtyChange(path, dirty); }, [path, dirty, onDirtyChange]);

  const save = async (overwrite = false) => {
    if (!path || !loaded || loaded.kind !== 'text') return;
    setSaving(true);
    try {
      const w = await api.write(rootId, path, text, overwrite ? null : loaded.data.mtime);
      setLoaded({ kind: 'text', data: { ...loaded.data, mtime: w.mtime, size: w.size, content: text, truncated: false } });
      setDirty(false); dirtyRef.current = false; setConflict(null);
      onNotice('info', `Salvo: ${entry?.name}`);
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'conflict') setConflict(errorText(err));
      else onNotice('error', `Não foi possível salvar: ${errorText(err)}`);
    } finally { setSaving(false); }
  };

  if (!entry) return <div className="hq-fx-preview hq-fx-preview--empty"><p>Selecione um arquivo para ver o conteúdo.</p><p className="hq-fx-dim">Setas navegam, Enter abre, F2 renomeia, Delete envia para a lixeira.</p></div>;

  const abs = absolutePath(rootPath, entry.path);
  const head = (
    <header className="hq-fx-preview__head">
      <FileIcon kind={fileKind(entry)} size={16} />
      <span className="hq-fx-preview__name" title={abs}>{entry.name}</span>
      {dirty && <span className="hq-fx-tag hq-fx-tag--warn" title="Alterações ainda não gravadas no disco">não salvo</span>}
      <span className="hq-fx-preview__meta">{entry.type === 'dir' ? countLabel(entry.childCount) : formatSize(entry.size)}{entry.mtime ? ` · ${formatDate(entry.mtime)}` : ''}</span>
      <button type="button" className="hq-fx-iconbtn" title={entry.type === 'dir' ? 'Abrir pasta no Explorer' : 'Abrir no programa padrão'} onClick={() => onOpenExternal(entry.type === 'dir' ? 'folder' : 'file', abs)}><IconExternal size={15} /></button>
    </header>
  );

  if (entry.type !== 'file') {
    return (
      <div className="hq-fx-preview">{head}
        <div className="hq-fx-preview__info">
          <p>{entry.type === 'dir' ? 'Pasta' : entry.type === 'symlink' ? 'Link simbólico ou junction. A HQ não segue links: o conteúdo não é lido nem apagado por aqui.' : 'Item especial do sistema.'}</p>
          <p className="hq-fx-mono hq-fx-dim">{abs}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="hq-fx-preview" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); if (dirty && !saving) void save(); } }}>
      {head}
      {loading && !loaded && <div className="hq-fx-preview__info hq-fx-dim">Carregando…</div>}
      {error && <div className="hq-fx-error" role="alert">{error}</div>}
      {loaded?.kind === 'text' && (
        <>
          {loaded.data.truncated && <div className="hq-fx-notice hq-fx-notice--warn"><IconWarn size={14} /> Arquivo maior que 512 KB: só o início foi carregado e a edição está desligada. Abra no programa padrão para editar.</div>}
          {conflict && (
            <div className="hq-fx-notice hq-fx-notice--error" role="alert">
              <IconWarn size={14} /> <span>{conflict}</span>
              <button type="button" className="hq-fx-btn hq-fx-btn--sm" onClick={() => path && load(path)}>Recarregar do disco</button>
              <button type="button" className="hq-fx-btn hq-fx-btn--sm hq-fx-btn--danger" onClick={() => save(true)}>Gravar por cima</button>
            </div>
          )}
          <textarea className="hq-fx-editor" value={text} spellCheck={false} readOnly={loaded.data.truncated}
            onChange={e => { setText(e.target.value); if (!dirty) { setDirty(true); dirtyRef.current = true; } }}
            aria-label={`Conteúdo de ${entry.name}`} />
          <footer className="hq-fx-preview__foot">
            <span className="hq-fx-dim">{loaded.data.mediaType} · {text.length.toLocaleString('pt-BR')} caracteres</span>
            <span className="hq-fx-grow" />
            {dirty && <button type="button" className="hq-fx-btn hq-fx-btn--sm" onClick={() => { setText(loaded.data.content); setDirty(false); dirtyRef.current = false; }} disabled={saving}>Descartar</button>}
            <button type="button" className="hq-fx-btn hq-fx-btn--sm hq-fx-btn--primary" onClick={() => save()} disabled={!dirty || saving || !connected || loaded.data.truncated} title="Ctrl+S"><IconSave size={14} /> {saving ? 'Salvando…' : 'Salvar'}</button>
          </footer>
        </>
      )}
      {loaded?.kind === 'image' && (
        <div className="hq-fx-preview__image">
          <img src={`data:${loaded.data.mediaType};base64,${loaded.data.content}`} alt={entry.name} />
          <p className="hq-fx-dim">{loaded.data.mediaType} · {formatSize(loaded.data.size)}</p>
        </div>
      )}
      {loaded?.kind === 'none' && (
        <div className="hq-fx-preview__info">
          <p>{loaded.data.binary ? 'Arquivo binário' : 'Arquivo grande'}: sem preview na HQ.</p>
          <p className="hq-fx-dim">{loaded.data.mediaType} · {formatSize(loaded.data.size)} · {formatDate(loaded.data.mtime)}</p>
          <p className="hq-fx-mono hq-fx-dim">{abs}</p>
          <button type="button" className="hq-fx-btn" onClick={() => onOpenExternal('file', abs)}><IconExternal size={14} /> Abrir no programa padrão</button>
        </div>
      )}
    </div>
  );
}
