// Configurações em duas abas. "Geral": paralelismo, modelo e modo padrão, animações, som, sessão ociosa.
// "Conexões" (id 'ai'): serviço da HQ, estado real dos provedores (Claude via Claude Code, OpenAI via Codex) e padrões
// globais de modelo/esforço. Tudo é rascunho até Salvar; o patch só leva o que mudou (patch.ai quando as preferências
// de IA mudaram). As ações do cartão do serviço (pausar, autostart, logs, encerrar) são imediatas, não rascunho.
import { useEffect, useRef, useState } from 'react';
import type { AiSettings, PermissionModeOption, Settings } from '@milweb-hq/protocol';
import { DEFAULT_AI_SETTINGS } from '@milweb-hq/protocol';
import type { SettingsDialogProps } from '../types';
import { MODEL_OPTIONS, PERMISSION_MODE_LABELS, PERMISSION_MODE_OPTIONS, cleanClaudeVersion } from '../helpers';
import { AiSettingsPanel, aiSettingsProblems, sameAiSettings } from '../../settings/index';
import { Field, Modal } from './Modal';
import { DataPanel } from '../../settings/DataPanel';

type SettingsTab = 'general' | 'ai' | 'data';

const samePrefs = (a: AiSettings['claude'], b: AiSettings['claude']) => a.model === b.model && a.effort === b.effort;

function normalizeAi(ai: AiSettings | undefined): AiSettings {
  return {
    claude: { model: ai?.claude?.model ?? null, effort: ai?.claude?.effort ?? null },
    openai: { model: ai?.openai?.model ?? null, effort: ai?.openai?.effort ?? null },
  };
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { open, settings, serverInfo } = props;
  const [tab, setTab] = useState<SettingsTab>('general');
  const [form, setForm] = useState<Settings>(settings);
  const [ai, setAi] = useState<AiSettings>(() => normalizeAi(settings.ai ?? DEFAULT_AI_SETTINGS));

  // O rascunho parte das configurações do momento da abertura; um snapshot novo (reconexão) ou outra aba salvando não descarta o que está sendo editado.
  const latest = useRef(settings);
  latest.current = settings;
  const baseline = useRef(settings);
  useEffect(() => {
    if (open) { baseline.current = latest.current; setForm(latest.current); setAi(normalizeAi(latest.current.ai ?? DEFAULT_AI_SETTINGS)); }
  }, [open]);
  useEffect(() => { if (open) setTab(props.initialTab ?? 'general'); }, [open, props.initialTab]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm(f => ({ ...f, [k]: v }));

  const aiProblems = aiSettingsProblems(props.ai, ai);
  const canSave = aiProblems.length === 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) { setTab('ai'); return; }
    // Só o que mudou neste diálogo desde a abertura: o que outra aba salvou enquanto o Chefe editava não é desfeito.
    const base = baseline.current;
    const patch: Partial<Settings> = {};
    (Object.keys(form) as (keyof Settings)[]).forEach(k => {
      if (k === 'ai') return;
      if (form[k] !== base[k]) (patch as Record<string, unknown>)[k] = form[k];
    });
    const baseAi = normalizeAi(base.ai ?? DEFAULT_AI_SETTINGS);
    const latestAi = normalizeAi(settings.ai ?? DEFAULT_AI_SETTINGS);
    const mergedAi: AiSettings = {
      claude: samePrefs(ai.claude, baseAi.claude) ? latestAi.claude : ai.claude,
      openai: samePrefs(ai.openai, baseAi.openai) ? latestAi.openai : ai.openai,
    };
    if (!sameAiSettings(mergedAi, latestAi)) patch.ai = mergedAi;
    props.onSave(patch);
  };

  return (
    <Modal open={open} title="Configurações" onCancel={props.onCancel} width={640}>
      <form onSubmit={submit} className="hq-form">
        <div className="hq-tabs hq-settings__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'general'} className={`hq-tab${tab === 'general' ? ' hq-tab--on' : ''}`} onClick={() => setTab('general')}>Geral</button>
          <button type="button" role="tab" aria-selected={tab === 'ai'} className={`hq-tab${tab === 'ai' ? ' hq-tab--on' : ''}`} onClick={() => setTab('ai')}>
            Conexões{aiProblems.length > 0 && <span className="hq-tab__badge" aria-label="há um problema nesta aba">!</span>}
          </button>
          {props.onDataInfo && <button type="button" role="tab" aria-selected={tab === 'data'} className={`hq-tab${tab === 'data' ? ' hq-tab--on' : ''}`} onClick={() => setTab('data')}>Dados</button>}
        </div>

        {tab === 'data' && props.onDataInfo && <DataPanel load={props.onDataInfo} backupNow={props.onBackupNow} />}

        {tab === 'general' && (
          <>
            <Field label="Execuções em paralelo" hint="Quantas sessões podem trabalhar ao mesmo tempo. Com 8 GB de RAM, 1 é o seguro.">
              <input type="number" className="hq-input" min={1} max={8} value={form.maxParallel} onChange={e => set('maxParallel', Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
            </Field>
            <div className="hq-form__row">
              <Field label="Modelo padrão">
                <select className="hq-input" value={form.defaultModel ?? ''} onChange={e => set('defaultModel', e.target.value || null)}>
                  {MODEL_OPTIONS.map(o => <option key={o.value ?? 'default'} value={o.value ?? ''}>{o.label}</option>)}
                </select>
              </Field>
              <Field label="Modo de permissão padrão">
                <select className="hq-input" value={form.defaultPermissionMode} onChange={e => set('defaultPermissionMode', e.target.value as PermissionModeOption)}>
                  {PERMISSION_MODE_OPTIONS.map(m => <option key={m} value={m}>{PERMISSION_MODE_LABELS[m]}</option>)}
                </select>
              </Field>
            </div>
            <label className="hq-check">
              <input type="checkbox" checked={form.reducedMotion} onChange={e => set('reducedMotion', e.target.checked)} />
              <span>Reduzir animações <span className="hq-dim">(personagens trocam de lugar sem caminhar; menos efeitos)</span></span>
            </label>
            <label className="hq-check">
              <input type="checkbox" checked={form.soundEnabled} onChange={e => set('soundEnabled', e.target.checked)} />
              <span>Som ao pedir permissão ou concluir</span>
            </label>
            <Field label="Fechar sessão ociosa após (minutos)" hint="0 = nunca fechar sozinho.">
              <input type="number" className="hq-input" min={0} max={1440} value={form.idleCloseMinutes} onChange={e => set('idleCloseMinutes', Math.max(0, Number(e.target.value) || 0))} />
            </Field>
            <div className="hq-form__row">
              <Field label="Tempo máximo por tarefa (minutos)" hint="Passou disso, a HQ interrompe a execução. 0 = sem limite.">
                <input type="number" className="hq-input" min={0} max={1440} value={form.maxTaskMinutes} onChange={e => set('maxTaskMinutes', Math.max(0, Math.min(1440, Number(e.target.value) || 0)))} />
              </Field>
              <Field label="Tentativas automáticas por tarefa" hint="Depois de queda do serviço, limite de uso ou falta de rede. 1 = nunca repete sozinha.">
                <input type="number" className="hq-input" min={1} max={5} value={form.maxAttempts} onChange={e => set('maxAttempts', Math.max(1, Math.min(5, Number(e.target.value) || 1)))} />
              </Field>
            </div>
            {serverInfo && (
              <div className="hq-settings__info">
                <div><span className="hq-dim">Claude Code:</span> {cleanClaudeVersion(serverInfo.claudeVersion)} <span className="hq-mono hq-dim">{serverInfo.claudeExePath ?? ''}</span></div>
                <div><span className="hq-dim">Login:</span> {serverInfo.authOk === true ? 'ok' : serverInfo.authOk === false ? `falhou${serverInfo.authDetail ? ` (${serverInfo.authDetail})` : ''}` : 'não verificado'}</div>
                <div><span className="hq-dim">Dados:</span> <span className="hq-mono">{serverInfo.dataDir}</span></div>
              </div>
            )}
          </>
        )}

        {tab === 'ai' && (
          <AiSettingsPanel
            providers={props.ai}
            draft={ai}
            onChange={setAi}
            onRefresh={props.onAiRefresh}
            onTest={props.onAiTest}
            onLoginStart={props.onAiLoginStart}
            onLoginCancel={props.onAiLoginCancel}
            onOpenExternal={props.onOpenExternal}
            connection={props.connection}
            lastSnapshotAt={props.lastSnapshotAt}
            serverInfo={serverInfo}
            service={props.service}
            pauseNewTasks={props.service?.pauseNewTasks ?? settings.pauseNewTasks}
            onReconnect={props.onReconnect}
            onRefreshService={props.onRefreshService}
            onServicePause={props.onServicePause}
            onServiceAutostart={props.onServiceAutostart}
            onServiceOpenLogs={props.onServiceOpenLogs}
            onServiceShutdown={props.onServiceShutdown}
          />
        )}
        {tab === 'ai' && props.socialSection && (
          <section className="hq-settings__social" aria-label="Redes sociais">
            <h3 className="hq-label">Redes sociais</h3>
            {props.socialSection}
          </section>
        )}

        <div className="hq-actions hq-actions--end">
          <button type="button" className="hq-btn hq-btn--ghost" onClick={props.onCancel}>Cancelar</button>
          <button type="submit" className="hq-btn hq-btn--primary" disabled={!canSave} title={canSave ? undefined : aiProblems.join(' ')}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}
