// Ajustes → Dados (Marco 0): qual banco esta tela está usando, quanto há nele, o último backup e as exclusões recentes.
// Restaurar é com a HQ desligada (o comando aparece aqui, pronto para copiar), porque trocar o banco com o serviço ligado
// arriscaria perder o que estivesse sendo gravado.
import { useCallback, useEffect, useState } from 'react';
import type { DataInfo } from '@milweb-hq/protocol';
import { formatBytes } from '../panel/helpers';

function when(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

export function DataPanel({ load, backupNow }: { load(): Promise<DataInfo>; backupNow?(): Promise<{ file: string; info: DataInfo }> }) {
  const [info, setInfo] = useState<DataInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setInfo(await load()); setError(null); } catch (err) { setError((err as Error).message); }
  }, [load]);
  useEffect(() => { void refresh(); }, [refresh]);

  const doBackup = async () => {
    if (!backupNow) return;
    setBusy(true); setDone(null);
    try { const r = await backupNow(); setInfo(r.info); setDone(r.file); setError(null); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  if (error && !info) return <div className="hq-notice hq-notice--error" role="alert">Não foi possível ler os dados: {error}</div>;
  if (!info) return <p className="hq-dim">Lendo o banco…</p>;
  const restoreCmd = info.lastBackup ? `node server\\restore.mjs "${info.lastBackup.file}" --yes` : null;
  return (
    <div className="hq-data">
      <section className="hq-data__block">
        <h3 className="hq-label">Banco em uso</h3>
        <div className="hq-settings__info">
          <div><span className="hq-dim">Arquivo:</span> <span className="hq-mono">{info.dbFile}</span></div>
          <div><span className="hq-dim">Versão do esquema:</span> {info.schemaVersion} · <span className="hq-dim">tamanho:</span> {formatBytes(info.sizeBytes)}</div>
        </div>
        <ul className="hq-data__counts">
          {Object.entries(info.counts).map(([k, v]) => <li key={k}><strong>{v}</strong> <span className="hq-dim">{k}</span></li>)}
        </ul>
      </section>

      <section className="hq-data__block">
        <h3 className="hq-label">Backups</h3>
        <p className="hq-field__hint">Um backup automático por dia (ficam os 7 mais recentes), mais um antes de cada atualização do banco. Ficam em <span className="hq-mono">{info.dataDir}\backups</span>.</p>
        <div className="hq-settings__info">
          <div><span className="hq-dim">Último:</span> {info.lastBackup ? <>{when(info.lastBackup.at)} ({info.lastBackup.kind}) · <span className="hq-mono">{info.lastBackup.file.split(/[\\/]/).pop()}</span></> : 'nenhum ainda'}</div>
          <div><span className="hq-dim">Guardados:</span> {info.backupsKept}</div>
        </div>
        <div className="hq-actions">
          {backupNow && <button type="button" className="hq-btn hq-btn--sm" disabled={busy} onClick={() => void doBackup()}>{busy ? 'Copiando…' : 'Fazer backup agora'}</button>}
          <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={() => void refresh()}>Atualizar</button>
        </div>
        {done && <p className="hq-data__ok" role="status">Backup feito: <span className="hq-mono">{done}</span></p>}
        {restoreCmd && (
          <details className="hq-data__restore">
            <summary>Como restaurar um backup</summary>
            <ol>
              <li>Encerre a HQ (Ajustes → Conexões → Encerrar HQ).</li>
              <li>Na pasta da MilWeb HQ, rode o comando abaixo. Ele confere o backup (integridade e relações entre conversas, tarefas e reuniões) e guarda o banco atual antes de trocar.</li>
              <li>Abra a HQ de novo pelo <span className="hq-mono">start-hq.cmd</span>.</li>
            </ol>
            <code className="hq-data__cmd">{restoreCmd}</code>
          </details>
        )}
      </section>

      <section className="hq-data__block">
        <h3 className="hq-label">Exclusões e restaurações recentes</h3>
        {info.recentAudit.length === 0 ? <p className="hq-dim">Nada excluído pela HQ até agora.</p> : (
          <ul className="hq-data__audit">
            {info.recentAudit.map(a => (
              <li key={a.id}>
                <span className="hq-dim">{when(a.at)}</span> · <strong>{a.action}</strong> {a.entity}{a.title ? <> “{a.title}”</> : null}
                <span className="hq-dim"> · origem: {a.origin}{a.detail ? ` · ${a.detail}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <div className="hq-notice hq-notice--error" role="alert">{error}</div>}
    </div>
  );
}
