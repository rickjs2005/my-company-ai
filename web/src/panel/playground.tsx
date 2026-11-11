// Playground do painel (http://127.0.0.1:5175/panel.html): monta Sidebar + WorkerPanel com dados de exemplo.
// SÓ demonstração: nada aqui fala com servidor. O aviso MOCK_BANNER fica sempre visível.
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FileNode, PermissionModeOption, Session, Settings } from '@milweb-hq/protocol';
import { DEFAULT_SETTINGS } from '@milweb-hq/protocol';
import { MOCK_BANNER, sampleChat, samplePending, sampleProjects, sampleRooms, sampleSessions, sampleTasks, sampleWorkers } from '../mock/sample';
import {
  AddProjectDialog, NewSessionDialog, RoomEditor, SettingsDialog, Sidebar, StatusBar, WorkerPanel,
  type PanelTab, type TimelineEntry,
} from './index';
import '../styles/base.css';
import '../styles/panel.css';

const T0 = Date.now() - 5 * 60_000;

// Registro de exemplo (mesma forma dos LogEntry reais do claude-bridge).
const demoEntries: TimelineEntry[] = [
  { seq: 1, taskId: 't-0', entry: { ts: T0, kind: 'prompt', summary: 'Inicie o projeto com Vite' } },
  { seq: 2, taskId: 't-0', entry: { ts: T0 + 3000, kind: 'tool_start', summary: 'Executando: Create Vite project', toolUseId: 'tu-1', data: { name: 'Bash' } } },
  { seq: 3, taskId: 't-0', entry: { ts: T0 + 21000, kind: 'tool_end', summary: 'Executando: Create Vite project — concluído', ok: true, toolUseId: 'tu-1', data: { name: 'Bash' } } },
  { seq: 4, taskId: 't-0', entry: { ts: T0 + 22000, kind: 'text', summary: 'Projeto criado com Vite + React. Rode pnpm dev para abrir.' } },
  { seq: 5, taskId: 't-0', entry: { ts: T0 + 48000, kind: 'result', summary: 'Resposta pronta em 48 s (9 passos)', ok: true } },
  { seq: 6, taskId: 't-1', entry: { ts: T0 + 120000, kind: 'prompt', summary: 'Crie uma landing page para uma agência de turismo' } },
  { seq: 7, taskId: 't-1', entry: { ts: T0 + 123000, kind: 'tool_start', summary: 'Lendo package.json', toolUseId: 'tu-0', data: { name: 'Read' } } },
  { seq: 8, taskId: 't-1', entry: { ts: T0 + 124000, kind: 'tool_end', summary: 'Lendo package.json — concluído', ok: true, toolUseId: 'tu-0', data: { name: 'Read' } } },
  { seq: 9, taskId: 't-1', entry: { ts: T0 + 130000, kind: 'tool_start', summary: 'Executando: npm run lint', toolUseId: 'tu-9', data: { name: 'Bash' } } },
  { seq: 10, taskId: 't-1', entry: { ts: T0 + 131000, kind: 'tool_end', summary: 'Executando: npm run lint — falhou', ok: false, toolUseId: 'tu-9', data: { name: 'Bash' } } },
  { seq: 11, taskId: 't-1', entry: { ts: T0 + 140000, kind: 'interrupt', summary: 'Interrupção pedida pelo Chefe' } },
  { seq: 12, taskId: 't-1', entry: { ts: T0 + 150000, kind: 'rate_limit', summary: 'Limite de uso reportado pelo Claude: allowed_warning', ok: false } },
  { seq: 13, taskId: 't-1', entry: { ts: T0 + 160000, kind: 'tool_start', summary: 'Escrevendo index.html', toolUseId: 'tu-2', data: { name: 'Write' } } },
  { seq: 14, taskId: 't-1', entry: { ts: T0 + 161000, kind: 'permission', summary: 'Permissão pedida: Executando: pnpm install' } },
];

const demoTree: FileNode = {
  name: 'exemplo-turismo', path: 'C:\\Users\\usuario\\projetos\\exemplo-turismo', type: 'dir', children: [
    { name: 'src', path: 'C:\\Users\\usuario\\projetos\\exemplo-turismo\\src', type: 'dir' },
    { name: 'index.html', path: 'C:\\Users\\usuario\\projetos\\exemplo-turismo\\index.html', type: 'file', size: 1820 },
    { name: 'package.json', path: 'C:\\Users\\usuario\\projetos\\exemplo-turismo\\package.json', type: 'file', size: 540 },
    { name: 'vite.config.ts', path: 'C:\\Users\\usuario\\projetos\\exemplo-turismo\\vite.config.ts', type: 'file', size: 310 },
  ],
};

const demoDiff = `diff --git a/index.html b/index.html
--- a/index.html
+++ b/index.html
@@ -1,5 +1,7 @@
 <!doctype html>
 <html lang="pt-BR">
-  <head><title>Vite</title></head>
+  <head>
+    <title>Agência de Turismo</title>
+  </head>
   <body><div id="root"></div></body>
 </html>`;

type Dialog = 'none' | 'session' | 'project' | 'room' | 'settings';

function Playground() {
  const [busy, setBusy] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(true);
  const [showPending, setShowPending] = useState(true);
  const [tab, setTab] = useState<PanelTab>('chat');
  const [sessionId, setSessionId] = useState<string>('s-1');
  const [roomId, setRoomId] = useState<string>('r-dev');
  const [dialog, setDialog] = useState<Dialog>('none');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tree, setTree] = useState<FileNode | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [queued, setQueued] = useState(1);

  const note = (s: string) => setLog(l => [`${new Date().toLocaleTimeString('pt-BR')} ${s}`, ...l].slice(0, 6));

  const session: Session | null = sampleSessions.find(s => s.id === sessionId) ?? null;
  const worker = sampleWorkers.find(w => w.sessionId === sessionId) ?? null;
  const project = session ? sampleProjects.find(p => p.id === session.projectId) ?? null : null;
  const room = session ? sampleRooms.find(r => r.id === session.roomId) ?? null : null;
  const pending = showPending && session ? samplePending.filter(p => p.sessionId === session.id) : [];
  const activity = session ? { ...session.activity, turnActive: busy, activeTools: busy ? [{ toolUseId: 'tu-2', name: 'Write', input: {}, summary: 'Escrevendo index.html', startedAt: Date.now() - 42_000, parentToolUseId: null }] : [] } : null;

  const streamingText = streaming ? 'Estou montando a seção **hero** com a chamada principal e o botão de contato. Em seguida:\n\n- grade de destinos\n- depoimentos\n- rodapé com WhatsApp' : '';

  const loadTree = (path?: string) => {
    setTreeLoading(true);
    window.setTimeout(() => {
      setTreeLoading(false);
      if (!path || !tree) { setTree(demoTree); return; }
      const fill = (n: FileNode): FileNode => n.path === path && n.type === 'dir'
        ? { ...n, children: [{ name: 'App.tsx', path: `${path}\\App.tsx`, type: 'file', size: 900 }, { name: 'main.tsx', path: `${path}\\main.tsx`, type: 'file', size: 300 }] }
        : { ...n, children: n.children?.map(fill) };
      setTree(fill(tree));
    }, 300);
  };

  const tasks = useMemo(() => sampleTasks.filter(t => t.sessionId === sessionId), [sessionId]);

  return (
    <div className="hq-app">
      <div className="hq-mockbanner" role="alert">{MOCK_BANNER}</div>
      <div className="hq-app__main">
        <Sidebar
          rooms={sampleRooms} projects={sampleProjects} sessions={sampleSessions} workers={sampleWorkers}
          selectedRoomId={roomId} selectedSessionId={sessionId} connected={connected}
          serverInfo={{ version: '0.1.0', claudeExePath: 'C:\\Users\\usuario\\.local\\bin\\claude.exe', claudeVersion: '2.1.314', authOk: true, apiKeyInEnv: false, dataDir: 'C:\\Users\\usuario\\.milweb-hq', maxParallel: settings.maxParallel, startedAt: T0 }}
          onSelectRoom={id => { setRoomId(id); note(`sala ${id}`); }}
          onSelectSession={id => { setSessionId(id); const s = sampleSessions.find(x => x.id === id); if (s) setRoomId(s.roomId); note(`sessão ${id}`); }}
          onNewSession={(rid) => { setRoomId(rid); setDialog('session'); }}
          onAddProject={(rid) => { setRoomId(rid); setDialog('project'); }}
          onEditRoom={(rid) => { setRoomId(rid); setDialog('room'); }}
          onOpenSettings={() => setDialog('settings')}
        />
        <main className="hq-stage" aria-label="Área da cena (fora deste playground)">
          <div className="hq-stage__placeholder">
            <span className="pixel">cena do escritório</span>
            <p className="hq-dim">A cena 2D é outra frente. Aqui só o painel e a casca.</p>
          </div>
          <div className="hq-playground">
            <strong>Controles do playground</strong>
            <label><input type="checkbox" checked={busy} onChange={e => setBusy(e.target.checked)} /> ocupado (busy)</label>
            <label><input type="checkbox" checked={streaming} onChange={e => setStreaming(e.target.checked)} /> texto em andamento (streaming)</label>
            <label><input type="checkbox" checked={connected} onChange={e => setConnected(e.target.checked)} /> conectado</label>
            <label><input type="checkbox" checked={showPending} onChange={e => setShowPending(e.target.checked)} /> pendências (permissão + pergunta)</label>
            <label>fila: <input type="number" min={0} value={queued} onChange={e => setQueued(Number(e.target.value) || 0)} style={{ width: 56 }} /></label>
            <div className="hq-playground__log" aria-live="polite">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
          </div>
        </main>
        <WorkerPanel
          worker={worker} session={session} tab={tab} onTab={setTab}
          onClose={() => note('fechar painel')} onCloseSession={() => note('fechar sessão')} onResumeSession={() => note('retomar sessão')} onArchiveSession={() => note('arquivar sessão')}
          chat={{
            items: sampleChat, streamingText, busy, pending,
            onAllow: (id, remember) => note(`permitir ${id}${remember ? ' (lembrar)' : ''}`),
            onDeny: (id, msg) => note(`negar ${id}${msg ? `: ${msg}` : ''}`),
            onAnswer: (id, answers) => note(`responder ${id}: ${JSON.stringify(answers)}`),
            onOpenFile: p => note(`abrir ${p}`),
          }}
          composer={{
            session, project, room, profiles: room?.profiles ?? [], profileId: room?.profiles[0]?.id ?? null,
            busy, queuedCount: queued, connected,
            onSend: (text, atts, mode) => { note(`${mode}: "${text}" +${atts.length} anexo(s)`); if (mode === 'queue') setQueued(q => q + 1); },
            onInterrupt: () => { note('interromper'); setBusy(false); },
            onProfileChange: id => note(`perfil ${id}`), onModelChange: m => note(`modelo ${m}`), onPermissionModeChange: (m: PermissionModeOption) => note(`modo ${m}`),
          }}
          timeline={{ entries: session ? demoEntries : [], activity, processState: session?.processState ?? null }}
          files={{
            project, tree, gitStatus: [{ path: 'index.html', status: ' M' }, { path: 'src/App.tsx', status: '??' }], touchedFiles: tasks.flatMap(t => t.touchedFiles), loading: treeLoading,
            onLoadTree: loadTree,
            onReadFile: async p => ({ content: `// conteúdo de exemplo de ${p}\nexport const demo = true;\n`, truncated: p.endsWith('.html'), binary: false }),
            onDiff: async () => demoDiff,
            onOpenExternal: (t, v) => note(`abrir ${t}: ${v}`),
          }}
          deliveries={{
            tasks, project, previewUrl,
            onOpenExternal: (t, v) => note(`abrir ${t}: ${v}`),
            onSetPreviewUrl: u => { setPreviewUrl(u); note(`preview ${u}`); },
            onCheckPreview: async u => ({ ok: u.includes('127.0.0.1'), status: u.includes('127.0.0.1') ? 200 : undefined, error: u.includes('127.0.0.1') ? undefined : 'sem resposta (demonstração)' }),
          }}
        />
      </div>
      <StatusBar
        connected={connected}
        serverInfo={{ version: '0.1.0', claudeExePath: null, claudeVersion: '2.1.314', authOk: true, apiKeyInEnv: false, dataDir: '', maxParallel: settings.maxParallel, startedAt: T0 }}
        activeCount={busy ? 1 : 0} queuedCount={queued}
        rateLimit={{ status: 'allowed_warning', utilization: 0.82, resetsAt: Math.floor(Date.now() / 1000) + 3600 }}
      />

      <NewSessionDialog
        open={dialog === 'session'} room={sampleRooms.find(r => r.id === roomId) ?? null} projects={sampleProjects}
        defaultProjectId={null} defaultModel={settings.defaultModel} defaultPermissionMode={settings.defaultPermissionMode}
        resumable={sampleSessions.filter(s => s.status === 'paused')}
        onCreate={i => { note(`criar sessão ${JSON.stringify(i)}`); setDialog('none'); }}
        onResume={id => { note(`retomar ${id}`); setDialog('none'); }}
        onAddProject={() => setDialog('project')} onCancel={() => setDialog('none')}
      />
      <AddProjectDialog
        open={dialog === 'project'} rooms={sampleRooms} defaultRoomId={roomId}
        onCreate={async i => { note(`projeto ${JSON.stringify(i)}`); if (!/^[a-z]:\\/i.test(i.path)) return { ok: false, error: 'Pasta não encontrada (demonstração: use um caminho C:\\...)' }; setDialog('none'); return { ok: true }; }}
        onCancel={() => setDialog('none')}
      />
      <RoomEditor open={dialog === 'room'} room={sampleRooms.find(r => r.id === roomId) ?? null} onSave={p => { note(`salvar sala ${JSON.stringify(p).slice(0, 80)}`); setDialog('none'); }} onCancel={() => setDialog('none')} />
      <SettingsDialog open={dialog === 'settings'} settings={settings} serverInfo={null} onSave={p => { setSettings(s => ({ ...s, ...p })); note(`configurações ${JSON.stringify(p)}`); setDialog('none'); }} onCancel={() => setDialog('none')} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Playground />
  </React.StrictMode>,
);
