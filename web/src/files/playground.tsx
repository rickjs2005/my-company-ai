// Playground do explorador e da lixeira (http://127.0.0.1:5175/files.html) com FsApi EM MEMÓRIA.
// SÓ demonstração: nada aqui fala com o servidor nem toca o disco. O banner amarelo fica sempre visível.
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FsRoot } from '@milweb-hq/protocol';
import { FileExplorer, TrashView } from './index';
import { createMockFsApi } from './mockApi';
import '../styles/base.css';
import '../styles/files.css';

const BANNER = 'DEMONSTRAÇÃO: explorador com dados de exemplo em memória. Nenhum arquivo real é lido ou alterado.';

function Playground() {
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [trashNonce, setTrashNonce] = useState(0);
  const [connected, setConnected] = useState(true);
  const [tab, setTab] = useState<'files' | 'trash'>('files');
  const [log, setLog] = useState<string[]>([]);
  const [signal, setSignal] = useState<{ rootId: string; paths: string[]; nonce: number } | null>(null);
  const api = useMemo(() => createMockFsApi(setRoots, () => setTrashNonce(n => n + 1)), []);
  if (roots.length === 0 && api.state.roots.length) setRoots(api.state.roots);

  const note = (s: string) => setLog(l => [`${new Date().toLocaleTimeString('pt-BR')} ${s}`, ...l].slice(0, 8));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ background: 'var(--warn)', color: '#1a1408', fontWeight: 600, fontSize: 12, textAlign: 'center', padding: '4px 8px' }} role="alert">{BANNER}</div>
      <div style={{ display: 'flex', gap: 8, padding: '6px 10px', alignItems: 'center', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', fontSize: 12, flexWrap: 'wrap' }}>
        <button type="button" className={`hq-fx-btn hq-fx-btn--sm${tab === 'files' ? ' hq-fx-btn--primary' : ''}`} onClick={() => setTab('files')}>Arquivos</button>
        <button type="button" className={`hq-fx-btn hq-fx-btn--sm${tab === 'trash' ? ' hq-fx-btn--primary' : ''}`} onClick={() => setTab('trash')} data-testid="tab-trash">Lixeira</button>
        <span style={{ width: 1, height: 16, background: 'var(--border-strong)' }} />
        <label><input type="checkbox" checked={connected} onChange={e => setConnected(e.target.checked)} /> conectado</label>
        <label><input type="checkbox" checked={api.state.sessionsAlive} onChange={e => { api.state.sessionsAlive = e.target.checked; note(`sessão viva: ${e.target.checked}`); }} /> sessão viva em "cliente-site" (in_use)</label>
        <button type="button" className="hq-fx-btn hq-fx-btn--sm" onClick={() => { api.bumpExternal('notas.md'); note('notas.md mudou "fora" da HQ'); }} data-testid="bump">Simular mudança externa em notas.md</button>
        <button type="button" className="hq-fx-btn hq-fx-btn--sm" onClick={() => setSignal({ rootId: 'project:p1', paths: ['notas.md'], nonce: Date.now() })} data-testid="signal">Emitir fs.changed (notas.md)</button>
        <span style={{ flex: 1 }} />
        <span className="hq-fx-mono" style={{ color: 'var(--text-faint)' }}>{log[0] ?? ''}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'files' ? (
          <FileExplorer api={api} roots={roots} initialRootId="project:p1" connected={connected} changeSignal={signal}
            onOpenExternal={(t, p) => note(`abrir ${t}: ${p}`)} onNotice={(l, t) => note(`[${l}] ${t}`)}
            onInterruptSessions={async ids => { note(`interromper sessões: ${ids.join(', ')}`); api.state.sessionsAlive = false; }} />
        ) : (
          <TrashView api={api} connected={connected} changeNonce={trashNonce} onNotice={(l, t) => note(`[${l}] ${t}`)} />
        )}
      </div>
      <div className="hq-fx-mono" style={{ borderTop: '1px solid var(--border)', padding: '4px 10px', fontSize: 11, color: 'var(--text-dim)', maxHeight: 72, overflow: 'auto' }} aria-live="polite" data-testid="log">
        {log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Playground />);
