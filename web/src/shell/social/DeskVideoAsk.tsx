// "Quero um vídeo nesse estilo" direto na Mesa (09/11/2026, Chefe: "só chegar na mesa, entrega um vídeo e fala quero um vídeo
// nesse estilo aqui"). Cola o link (ou solta o arquivo), escreve o que quer e a equipe analisa e produz a versão; o cartão da
// referência aparece logo abaixo, na própria Mesa. Usa o mesmo caminho do campo "O que vamos criar?" (content.video.add).
import { useRef, useState } from 'react';
import type { SocialSlotId } from '@milweb-hq/protocol';
import { parseLinks, slotFromText, type ExtraRole, type VideoRefComposerApi } from './VideoRefComposer';

export function DeskVideoAsk({ api }: { api: VideoRefComposerApi }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [slot, setSlot] = useState<SocialSlotId | ''>('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement | null>(null);

  const parsed = parseLinks(text);
  const base = parsed.links.find(l => l.role === 'base') ?? parsed.links.find(l => l.role === 'referencia') ?? parsed.links[0] ?? null;
  const url = file ? null : base?.url ?? null;
  const extras = parsed.links.filter(l => file || l !== base).map(l => ({ url: l.url, role: (l.role === 'base' ? 'referencia' : l.role) as ExtraRole, note: l.note }));
  const chosen = (slot || slotFromText(parsed.instruction) || api.defaultSlot) as SocialSlotId | null;
  const ready = Boolean(url || file);

  const send = async () => {
    if (!ready || busy) return;
    if (!chosen) { setNote({ ok: false, text: 'Escolha para qual conta é a versão.' }); return; }
    setBusy(true); setNote(null);
    try {
      const instruction = parsed.instruction ?? 'Quero um vídeo nesse estilo.';
      const r = await api.send({ url, file, liked: null, mode: 'produzir', instruction, slot: chosen, extras });
      setText(''); setFile(null);
      setNote({ ok: true, text: `${r.reused ? 'Essa referência já estava aqui: o cartão foi atualizado.' : 'Recebido.'} A equipe baixa, analisa e produz a versão; o andamento aparece logo abaixo e o vídeo chega nas Entregas.` });
    } catch (err) { setNote({ ok: false, text: (err as Error).message }); }
    finally { setBusy(false); }
  };

  const takeFile = (f: File | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('video/')) { setNote({ ok: false, text: `"${f.name}" não é vídeo.` }); return; }
    setFile(f); setNote(null);
  };

  return (
    <section
      className={['hq-desk-ask', over ? 'hq-desk-ask--over' : ''].join(' ')}
      aria-label="Pedir um vídeo nesse estilo"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); takeFile(e.dataTransfer.files?.[0]); }}
    >
      <h3 className="hq-label">Quero um vídeo nesse estilo</h3>
      <textarea
        className="hq-input hq-desk-ask__text" rows={2} value={text} onChange={e => setText(e.target.value)} maxLength={4000}
        placeholder="Cole o link do vídeo (TikTok, Reels, YouTube) e diga o que você quer. Ex.: quero um desses sobre o Ultron, sem narração."
        aria-label="Link do vídeo e o que você quer"
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
      />
      <div className="hq-desk-ask__row">
        <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => pick.current?.click()}>{file ? `Arquivo: ${file.name}` : 'Ou escolha o arquivo'}</button>
        {file && <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => setFile(null)} aria-label="Tirar o arquivo">×</button>}
        <input ref={pick} type="file" accept="video/*" hidden onChange={e => { takeFile(e.target.files?.[0]); e.target.value = ''; }} />
        <label className="hq-select">
          <span className="sr-only">Conta da versão</span>
          <select value={slot || chosen || ''} onChange={e => setSlot(e.target.value as SocialSlotId)} aria-label="Conta da versão">
            <option value="" disabled>Conta…</option>
            {api.slots.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--primary" disabled={!ready || busy} onClick={() => void send()}>{busy ? 'Enviando…' : 'Fazer nesse estilo'}</button>
      </div>
      {!ready && text.trim() && <p className="hq-dim hq-desk-ask__hint">Falta o link do vídeo (ou o arquivo).</p>}
      {extras.length > 0 && <p className="hq-dim hq-desk-ask__hint">Mais {extras.length} vídeo(s) entram como apoio ({extras.map(x => (x.role === 'audio' ? 'áudio' : x.role === 'estilo' ? 'estilo' : 'referência')).join(', ')}).</p>}
      {note && <p className={note.ok ? 'hq-desk-ask__ok' : 'hq-desk-ask__err'} role="status">{note.text}</p>}
    </section>
  );
}
