// Barra inferior fina: versão do Claude Code, execuções ativas/fila, atalhos da vista e aviso de limite de uso (só enquanto vale).
import { useEffect, useState } from 'react';
import type { StatusBarProps } from './types';
import { IconAlert, IconImage } from './icons';
import { cleanClaudeVersion, rateLimitNotice } from './helpers';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

// O indicador de conexão fica só no cabeçalho (um único lugar); aqui `connected` só esmaece os números.
export function StatusBar({ connected, serverInfo, activeCount, meetingTurns = 0, queuedCount, rateLimit, attachments, hint, dmRunning = 0, queuedByTeam = null }: StatusBarProps) {
  // Relógio de 30 s: o aviso de limite some sozinho quando passa o horário de liberação.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t); }, []);
  const limit = rateLimitNotice(rateLimit, now);
  return (
    <footer className={cx('hq-status', !connected && 'hq-status--stale')} role="contentinfo">
      <span title={serverInfo?.claudeExePath ?? ''}>Claude Code {cleanClaudeVersion(serverInfo?.claudeVersion)}</span>
      {serverInfo && serverInfo.authOk === false && <span className="hq-tag hq-tag--danger" title={serverInfo.authDetail ?? ''}>sem login</span>}
      {serverInfo?.apiKeyInEnv && <span className="hq-tag hq-tag--warn" title="ANTHROPIC_API_KEY presente no ambiente: o servidor remove para não cobrar na API">chave na env</span>}
      <span className="hq-status__sep" />
      <span title="Execuções que contam no limite da fila agora (tarefas e turnos de reunião) e o máximo configurado em Ajustes → Geral; conversa particular não entra na fila">Em execução: {activeCount + meetingTurns}{serverInfo ? ` de ${Math.max(1, serverInfo.maxParallel)}` : ''}{meetingTurns > 0 ? ' · reunião' : ''}{dmRunning > 0 ? ` · +${dmRunning} conversa particular` : ''}</span>
      <span className="hq-status__sep" />
      <span title={queuedCount && meetingTurns && !activeCount ? 'A fila anda quando o turno da reunião terminar' : undefined}>Fila: {queuedCount}{queuedByTeam ? ` (${queuedByTeam})` : ''}{queuedCount > 0 && meetingTurns > 0 && !activeCount ? ' (espera a reunião)' : ''}</span>
      {attachments && attachments.length > 0 && (
        <>
          <span className="hq-status__sep" />
          <span title={attachments.map(a => a.name).join(', ')}><IconImage size={12} /> {attachments.length} anexo(s)</span>
        </>
      )}
      <span className="hq-status__spacer" />
      {hint && !limit && <span className="hq-status__hint">{hint}</span>}
      {limit && (
        <span className="hq-status__limit" role="alert" title={limit.title}>
          <IconAlert size={13} /> {limit.text}
        </span>
      )}
      <span className="hq-dim">HQ {serverInfo?.version ?? '—'}</span>
    </footer>
  );
}
