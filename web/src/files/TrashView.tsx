// Lixeira da HQ: lista o que foi apagado pela interface, restaura (com outro nome em caso de conflito),
// exclui definitivamente com confirmação explícita e esvazia tudo.
import { useCallback, useEffect, useState } from 'react';
import type { TrashItem } from '@milweb-hq/protocol';
import type { FsApi } from './api';
import { ConfirmDialog } from './dialogs';
import { FileIcon, IconRefresh, IconRestore, IconTrash } from './icons';
import { countLabel, errorText, fileKind, formatDate, formatSize } from './helpers';

export interface TrashViewProps {
  api: FsApi;
  connected: boolean;
  /** Muda a cada trash.changed do servidor: recarrega a lista. */
  changeNonce: number;
  onNotice(level: 'info' | 'warn' | 'error', text: string): void;
}

type Dialog = { kind: 'delete'; item: TrashItem } | { kind: 'empty' } | { kind: 'restore-rename'; item: TrashItem; message: string } | null;

export function TrashView({ api, connected, changeNonce, onNotice }: TrashViewProps) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setItems(await api.trashList()); setError(null); }
    catch (err) { setError(errorText(err)); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load, changeNonce]);

  const restore = async (item: TrashItem, rename = false) => {
    setBusyId(item.id);
    try {
      const r = await api.trashRestore(item.id, rename ? 'rename' : 'fail');
      onNotice('info', `Restaurado: ${r.restoredTo}`);
      setDialog(null); void load();
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'exists' && !rename) setDialog({ kind: 'restore-rename', item, message: errorText(err) });
      else { onNotice('error', `Não foi possível restaurar ${item.name}: ${errorText(err)}`); if (e.code === 'not_found') void load(); }
    } finally { setBusyId(null); }
  };

  const remove = async (item: TrashItem) => {
    setDialogBusy(true);
    try { await api.trashDelete(item.id); onNotice('info', `Excluído definitivamente: ${item.name}`); setDialog(null); void load(); }
    catch (err) { onNotice('error', `Não foi possível excluir ${item.name}: ${errorText(err)}`); setDialog(null); void load(); }
    finally { setDialogBusy(false); }
  };

  const empty = async () => {
    setDialogBusy(true);
    try { await api.trashEmpty(); onNotice('info', 'Lixeira esvaziada'); }
    catch (err) { onNotice('error', errorText(err)); }
    finally { setDialogBusy(false); setDialog(null); void load(); }
  };

  const totalSize = items.reduce((s, it) => s + (it.size ?? 0), 0);
  const uncounted = items.filter(it => it.size == null).length;

  return (
    <div className="hq-fx hq-fx-trash">
      <div className="hq-fx-toolbar">
        <IconTrash size={16} className="hq-fx-dim" />
        <strong>Lixeira da HQ</strong>
        <span className="hq-fx-dim">{items.length === 0 ? 'vazia' : `${items.length} ${items.length === 1 ? 'item' : 'itens'}${totalSize ? ` · ${formatSize(totalSize)}` : ''}${uncounted ? ` (${uncounted} sem tamanho contado)` : ''}`}</span>
        <span className="hq-fx-grow" />
        <button type="button" className="hq-fx-iconbtn" onClick={() => load()} title="Atualizar" aria-label="Atualizar"><IconRefresh size={15} /></button>
        <button type="button" className="hq-fx-btn hq-fx-btn--sm hq-fx-btn--danger" disabled={!items.length || !connected} onClick={() => setDialog({ kind: 'empty' })}>Esvaziar lixeira</button>
      </div>
      {!connected && <div className="hq-fx-offline" role="status">Sem conexão com o serviço: a lista pode estar desatualizada e as ações ficam desligadas.</div>}
      {error && <div className="hq-fx-error hq-fx-list__msg" role="alert">{error}</div>}
      <div className="hq-fx-trashlist" role="list">
        {!error && !loading && items.length === 0 && <div className="hq-fx-emptystate"><p>A lixeira está vazia.</p><p className="hq-fx-dim">O que você enviar para a lixeira pelo explorador aparece aqui, com origem, e pode ser restaurado.</p></div>}
        {items.map(it => (
          <div key={it.id} className="hq-fx-trashrow" role="listitem">
            <FileIcon kind={fileKind({ name: it.name, type: it.kind })} size={18} />
            <div className="hq-fx-trashrow__main">
              <div className="hq-fx-trashrow__name">{it.name} <span className="hq-fx-tag">{it.kind === 'dir' ? 'pasta' : 'arquivo'}</span></div>
              <div className="hq-fx-trashrow__origin hq-fx-mono" title={it.originPath}>{it.originPath}</div>
              <div className="hq-fx-trashrow__meta">
                {it.kind === 'dir' ? `${countLabel(it.count)}${it.size != null ? ` · ${formatSize(it.size)}` : ''}` : it.size != null ? formatSize(it.size) : 'tamanho não contado'}
                {' · '}apagado em {formatDate(it.deletedAt)}
                {it.rootId ? '' : ' · raiz desconhecida'}
              </div>
            </div>
            <div className="hq-fx-trashrow__actions">
              <button type="button" className="hq-fx-btn hq-fx-btn--sm" disabled={busyId === it.id || !connected} onClick={() => restore(it)} title="Volta para o caminho original"><IconRestore size={13} /> Restaurar</button>
              <button type="button" className="hq-fx-btn hq-fx-btn--sm hq-fx-btn--danger" disabled={busyId === it.id || !connected} onClick={() => setDialog({ kind: 'delete', item: it })}>Excluir definitivamente</button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog open={dialog?.kind === 'delete'} title="Excluir definitivamente" confirmLabel="Excluir de vez" danger busy={dialogBusy}
        text={dialog?.kind === 'delete' ? `"${dialog.item.name}" será apagado do disco e não poderá mais ser restaurado.` : ''}
        onConfirm={() => { if (dialog?.kind === 'delete') void remove(dialog.item); }} onCancel={() => setDialog(null)} />
      <ConfirmDialog open={dialog?.kind === 'empty'} title="Esvaziar lixeira" confirmLabel={`Excluir ${items.length} ${items.length === 1 ? 'item' : 'itens'} de vez`} danger busy={dialogBusy}
        text="Tudo que está na lixeira será apagado do disco. Isso não pode ser desfeito."
        onConfirm={() => void empty()} onCancel={() => setDialog(null)} />
      <ConfirmDialog open={dialog?.kind === 'restore-rename'} title="Já existe um item no lugar original" confirmLabel="Restaurar com outro nome" busy={busyId != null}
        text={dialog?.kind === 'restore-rename' ? `${dialog.message}. A HQ não substitui o item existente; o restaurado recebe o sufixo "(restaurado)".` : ''}
        onConfirm={() => { if (dialog?.kind === 'restore-rename') void restore(dialog.item, true); }} onCancel={() => setDialog(null)} />
    </div>
  );
}
