// Caixa de envio: textarea que cresce, anexos de imagem (botão, colar, arrastar), seletores e ações de fila/interrupção.
import { useEffect, useRef, useState } from 'react';
import type { PermissionModeOption } from '@milweb-hq/protocol';
import type { ComposerProps, OutgoingAttachment, SendMode } from './types';
import { basename, formatBytes, MODEL_OPTIONS, PERMISSION_MODE_LABELS, PERMISSION_MODE_OPTIONS, sessionStatusLabel } from './helpers';
import { IconPaperclip, IconSend, IconStop, IconX } from './icons';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => {
      const s = String(fr.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.readAsDataURL(file);
  });
}

export function Composer(props: ComposerProps) {
  const { session, project, room, profiles, profileId, busy, queuedCount, connected, disabledReason } = props;
  const [text, setText] = useState('');
  const [files, setFiles] = useState<OutgoingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  // Modelo, permissões e perfil ficam recolhidos: o campo de escrever é o que importa no dia a dia (10/11/2026).
  const [showOpts, setShowOpts] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);

  const reason = !connected
    ? 'Desconectado do servidor'
    : disabledReason ?? (!session ? 'Selecione uma sessão' : !session.controllable ? 'Sessão apenas observada: não aceita pedidos daqui' : null);
  const disabled = Boolean(reason);
  const hasContent = text.trim().length > 0 || files.length > 0;
  const canSend = !disabled && hasContent;

  // A textarea cresce até ~6 linhas; depois rola.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const submit = (mode: SendMode) => {
    if (!canSend || sendingRef.current) return; // guarda contra duplo envio (Enter + clique)
    sendingRef.current = true;
    props.onSend(text.trim(), files, mode);
    setText('');
    setFiles([]);
    setWarning(null);
    window.setTimeout(() => { sendingRef.current = false; }, 0);
  };

  const addFiles = async (list: ArrayLike<File> | null | undefined) => {
    if (!list) return;
    const next: OutgoingAttachment[] = [];
    for (const f of Array.from(list)) {
      if (!f.type.startsWith('image/')) { setWarning(`"${f.name}" ignorado: só imagens são aceitas.`); continue; }
      if (f.size > MAX_IMAGE_BYTES) { setWarning(`"${f.name}" ignorado: acima de ${formatBytes(MAX_IMAGE_BYTES)}.`); continue; }
      try {
        next.push({ name: f.name || `imagem-${Date.now()}.png`, mediaType: f.type, dataBase64: await readAsBase64(f), sizeBytes: f.size });
      } catch {
        setWarning(`Não consegui ler "${f.name}".`);
      }
    }
    if (next.length) setFiles(prev => [...prev, ...next]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // Com o funcionário trabalhando, Enter fala com ele no meio da tarefa (o servidor enfileira se o turno já acabou).
      submit(busy ? (files.length ? 'queue' : 'steer') : 'send');
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgs = items.filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter((f): f is File => Boolean(f));
    if (imgs.length) { e.preventDefault(); void addFiles(imgs); }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer?.files);
  };

  const removeFile = (idx: number) => setFiles(prev => prev.filter((_, i) => i !== idx));

  // Projeto · pasta · sessão, sempre visível antes do envio (o caminho completo fica no title).
  const sessionLabel = session ? `${session.name} (${sessionStatusLabel(session.status)})` : 'sem sessão';
  const contextLine = [project?.name ?? 'Sem projeto', project ? basename(project.path) : '—', sessionLabel];
  const contextTitle = [project?.name ?? 'Sem projeto', project?.path ?? '—', sessionLabel].join(' · ');

  return (
    <div
      className={['hq-composer', dragging && 'hq-composer--drag', disabled && 'hq-composer--disabled'].filter(Boolean).join(' ')}
      onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="hq-composer__context" title={contextTitle}>
        <span className="hq-composer__ctx-item hq-strong">{contextLine[0]}</span>
        <span className="hq-composer__sep">·</span>
        <span className="hq-composer__ctx-item hq-mono">{contextLine[1]}</span>
        <span className="hq-composer__sep">·</span>
        <span className="hq-composer__ctx-item">{contextLine[2]}</span>
        {room && <span className="hq-chip hq-chip--room" style={{ ['--room' as string]: room.color }}>{room.name}</span>}
      </div>

      {files.length > 0 && (
        <div className="hq-attachments hq-attachments--composer">
          {files.map((f, i) => (
            <span key={i} className="hq-thumb">
              <img src={`data:${f.mediaType};base64,${f.dataBase64}`} alt={f.name} />
              <button type="button" className="hq-thumb__rm" onClick={() => removeFile(i)} aria-label={`Remover ${f.name}`}><IconX size={12} /></button>
            </span>
          ))}
        </div>
      )}

      <div className="hq-composer__box">
        <textarea
          ref={taRef} className="hq-composer__ta" rows={1} value={text} disabled={disabled}
          placeholder={disabled ? reason ?? '' : busy ? 'Fale com ele no meio da tarefa (Enter envia)' : 'Mensagem (Enter envia)'}
          aria-label="Mensagem para o funcionário" title="Enter envia; Shift+Enter quebra linha"
          onChange={e => setText(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste}
        />
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => { void addFiles(e.target.files); e.target.value = ''; }} />
        <button type="button" className="hq-iconbtn" disabled={disabled} onClick={() => fileRef.current?.click()} aria-label="Anexar imagem" title="Anexar imagem (ou cole / arraste)">
          <IconPaperclip size={16} />
        </button>
        {busy ? (
          <button type="button" className="hq-composer__send" disabled={!canSend || files.length > 0} onClick={() => submit('steer')} aria-label="Falar agora" title="Entra no próximo passo da tarefa em andamento, sem interromper (imagens vão pela fila)"><IconSend size={16} /></button>
        ) : (
          <button type="button" className="hq-composer__send" disabled={!canSend} onClick={() => submit('send')} aria-label="Enviar pedido" title="Enviar (Enter)"><IconSend size={16} /></button>
        )}
      </div>

      <div className="hq-composer__bar">
        {busy && (
          <div className="hq-composer__alt">
            <button type="button" className="hq-linkbtn" disabled={!canSend} onClick={() => submit('queue')} title="Envia quando o turno atual terminar">Enfileirar</button>
            <button type="button" className="hq-linkbtn" disabled={!canSend} onClick={() => submit('interrupt')} title="Interrompe o turno atual e envia este pedido">Interromper e enviar</button>
            <button type="button" className="hq-linkbtn hq-composer__stop" disabled={disabled} onClick={props.onInterrupt} aria-label="Interromper o turno atual"><IconStop size={12} /> Interromper</button>
          </div>
        )}
        {queuedCount > 0 && <span className="hq-tag hq-tag--amber hq-tag--xs" title="Pedidos esperando a vez">Fila: {queuedCount}</span>}
        <button type="button" className="hq-linkbtn hq-composer__optsbtn" aria-expanded={showOpts} onClick={() => setShowOpts(v => !v)}>{showOpts ? 'Ocultar opções' : 'Opções'}</button>
      </div>
      {showOpts && (
      <div className="hq-composer__bar">
        <div className="hq-composer__selects">
          <label className="hq-select">
            <span className="sr-only">Modelo</span>
            <select value={session?.model ?? ''} disabled={!session || !session.controllable} onChange={e => props.onModelChange(e.target.value || null)} aria-label="Modelo">
              {MODEL_OPTIONS.map(o => <option key={o.value ?? 'default'} value={o.value ?? ''}>{o.label}</option>)}
            </select>
          </label>
          <label className="hq-select">
            <span className="sr-only">Modo de permissão</span>
            <select value={session?.permissionMode ?? 'default'} disabled={!session || !session.controllable} onChange={e => props.onPermissionModeChange(e.target.value as PermissionModeOption)} aria-label="Modo de permissão">
              {PERMISSION_MODE_OPTIONS.map(m => <option key={m} value={m}>{PERMISSION_MODE_LABELS[m]}</option>)}
            </select>
          </label>
          {profiles.length > 0 && (
            <label className="hq-select">
              <span className="sr-only">Perfil editorial</span>
              <select value={profileId ?? ''} onChange={e => props.onProfileChange(e.target.value || null)} aria-label="Perfil editorial">
                <option value="">Sem perfil</option>
                {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>
      )}

      {(reason || warning) && (
        <div className={['hq-composer__note', reason ? 'hq-composer__note--off' : ''].join(' ')} role="status">{reason ?? warning}</div>
      )}
      {dragging && <div className="hq-composer__drop" aria-hidden="true">Solte a imagem para anexar</div>}
    </div>
  );
}
