// "Compartilhar vídeo" (07/11/2026, pedido do Chefe): link do Instagram Reels, TikTok, YouTube/Shorts ou X, ou arquivo MP4/MOV,
// com o recado para a equipe. O Diretor de Vídeo recebe a tarefa; a HQ roda a skill Watch e mede o vídeo; o Diretor escreve o
// relatório (Video Analyzer); no modo estudo vem a aula, os exercícios e a Academia. Link protegido: a HQ avisa e pede o
// arquivo (não usa a conta do Chefe para baixar).
import { useRef, useState } from 'react';
import type { SocialSlotId, VideoRefMode } from '@milweb-hq/protocol';
import { SHARE_FILE_ACCEPT, SHARE_MODES, SHARE_PLATFORMS, checkShareFile, checkShareLink, suggestMode } from './academyBoard';
import type { ContentApi } from './ContentViews';

const SLOTS: { id: SocialSlotId; label: string }[] = [{ id: 'instagram-tuco', label: 'Tuco · Instagram' }, { id: 'instagram-aurora', label: 'Aurora · Instagram' }];

export function ShareVideo({ api, profileId, onClose, onAcademy }: { api: ContentApi; profileId: string | null; onClose(): void; onAcademy(): void }) {
  const [link, setLink] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [modePick, setModePick] = useState<VideoRefMode | null>(null);
  const [slot, setSlot] = useState<SocialSlotId>(profileId === 'aurora' ? 'instagram-aurora' : 'instagram-tuco');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const pick = useRef<HTMLInputElement | null>(null);
  const mode = modePick ?? suggestMode(text);
  const check = file ? null : link.trim() ? checkShareLink(link) : null;
  const fileError = file ? checkShareFile(file) : null;
  const ready = !busy && (file ? !fileError : Boolean(check?.ok));
  const send = async () => {
    if (!ready) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.videoAdd({ url: file ? null : link.trim(), file, liked: null, mode, instruction: text.trim() || null, slot: mode === 'produzir' ? slot : null, profileId });
      setMsg({ ok: true, text: r.reused
        ? `Esse vídeo já estava com a equipe: o mesmo cartão foi atualizado${r.mode === 'estudo' ? ' e virou estudo da Academia' : ''}.`
        : mode === 'estudo' ? 'Recebido. O Diretor de Vídeo vai assistir, preparar a aula e passar os exercícios. Acompanhe em "A equipe está fazendo" ou na Academia.'
          : mode === 'produzir' ? 'Recebido. O Diretor analisa e a edição produz a nossa versão; chega em "Esperando você".'
            : 'Recebido. O Diretor analisa e a equipe discute; o resultado chega em "Esperando você".' });
      setLink(''); setFile(null); setText(''); setModePick(null);
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  };
  return (
    <section className="hq-share" aria-label="Compartilhar vídeo com a equipe">
      <div className="hq-share__head">
        <strong>Compartilhar vídeo com a equipe</strong>
        <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={onClose}>Fechar</button>
      </div>
      <div className="hq-share__src">
        {file ? (
          <p className="hq-share__file"><span className="hq-tag hq-tag--xs">arquivo</span> {file.name} <span className="hq-dim">({(file.size / 1_000_000).toFixed(1)} MB)</span> <button type="button" className="hq-linkbtn" onClick={() => setFile(null)}>tirar</button></p>
        ) : (
          <input className="hq-input" value={link} onChange={e => setLink(e.target.value)} placeholder="Cole o link: Instagram Reels, TikTok, YouTube, Shorts ou X" aria-label="Link do vídeo" />
        )}
        <button type="button" className="hq-btn hq-btn--sm" onClick={() => pick.current?.click()}>{file ? 'Trocar arquivo' : 'Ou escolha um MP4/MOV'}</button>
        <input ref={pick} type="file" accept={SHARE_FILE_ACCEPT} hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { setFile(f); setMsg(null); } }} />
      </div>
      {check && !check.ok && <p className="hq-composer__bad">{check.error}</p>}
      {check?.ok && <p className="hq-dim">{check.warn ?? `${check.platform}: a HQ abre o vídeo, roda a Watch e entrega ao Diretor de Vídeo.`}</p>}
      {fileError && <p className="hq-composer__bad">{fileError}</p>}
      <textarea className="hq-input hq-share__text" rows={2} value={text} onChange={e => setText(e.target.value)}
        placeholder={'Recado para a equipe. Ex.: "Equipe, estudem esse vídeo. Quero que aprendam a fazer animações desse nível."'} aria-label="Recado para a equipe" />
      <div className="hq-home-pick" role="radiogroup" aria-label="O que a equipe faz com o vídeo">
        {SHARE_MODES.map(m => <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} title={m.hint} className={`hq-home-chip${mode === m.id ? ' is-on' : ''}`} onClick={() => setModePick(m.id)}>{m.label}</button>)}
      </div>
      {mode === 'produzir' && (
        <div className="hq-home-pick" role="radiogroup" aria-label="Conta da nossa versão">
          {SLOTS.map(s => <button key={s.id} type="button" role="radio" aria-checked={slot === s.id} className={`hq-home-chip${slot === s.id ? ' is-on' : ''}`} onClick={() => setSlot(s.id)}>{s.label}</button>)}
        </div>
      )}
      <p className="hq-home-ask__hint">{SHARE_MODES.find(m => m.id === mode)!.hint}</p>
      <div className="hq-actions">
        <button type="button" className="hq-btn hq-btn--primary" disabled={!ready} onClick={() => void send()}>{busy ? 'Enviando…' : 'Compartilhar com a equipe'}</button>
        <button type="button" className="hq-linkbtn" onClick={onAcademy}>abrir a Academia de Vídeo</button>
      </div>
      {msg && <p className={msg.ok ? 'hq-hub-ok' : 'hq-composer__bad'} role="status">{msg.text}</p>}
      <p className="hq-dim hq-share__foot">Aceita: {SHARE_PLATFORMS.map(p => p.label).join(', ')} e arquivos MP4 ou MOV. Post que pede login: a HQ avisa e você anexa o arquivo; ela não usa a sua conta para baixar.</p>
    </section>
  );
}
