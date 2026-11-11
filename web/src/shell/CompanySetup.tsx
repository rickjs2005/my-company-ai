// Nome da empresa: a tela do primeiro acesso (antes do escritório) e o campo de Ajustes → Empresa.
// O nome é validado aqui e de novo no servidor (company.setName) e só vale depois que o servidor confirma a gravação
// no SQLite; nada fica só no navegador. O nome é sempre mostrado como texto.
import { useEffect, useId, useRef, useState } from 'react';
import { checkCompanyName, COMPANY_NAME_MAX, PRODUCT_NAME } from '@milweb-hq/protocol';

/** Estado do envio do nome; `submit` ignora cliques repetidos enquanto o servidor não responde. */
export function useCompanyNameForm(initial: string, save: (name: string) => Promise<void>) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const submit = async () => {
    if (busy.current) return;
    const check = checkCompanyName(value);
    if (!check.ok) { setError(check.error); setSavedName(null); return; }
    busy.current = true; setSaving(true); setError(null); setSavedName(null);
    try {
      await save(check.name);
      if (alive.current) { setValue(check.name); setSavedName(check.name); }
    } catch (err) {
      if (alive.current) setError(`Não foi possível salvar o nome: ${(err as Error).message || 'sem resposta do serviço'}. Tente de novo.`);
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const change = (v: string) => { setValue(v); if (error) setError(null); if (savedName) setSavedName(null); };
  return { value, change, saving, error, savedName, submit };
}

export interface CompanySetupProps {
  /** Instalação que já tinha equipe, tarefas ou projetos antes de existir o nome da empresa. */
  hasData: boolean;
  /** Grava no servidor; resolve só depois da confirmação. */
  onSave(name: string): Promise<void>;
}

/** Primeiro acesso: cobre a tela até a empresa ter nome. */
export function CompanySetup({ hasData, onSave }: CompanySetupProps) {
  const form = useCompanyNameForm('', onSave);
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    // As teclas ficam nesta tela: os atalhos do escritório (N, Ctrl+K, Esc) não agem por baixo dela.
    <div className="hq-company" role="dialog" aria-modal="true" aria-labelledby={`${inputId}-title`} onKeyDown={e => e.stopPropagation()}>
      <form className="hq-company__card" noValidate onSubmit={e => { e.preventDefault(); void form.submit(); }}>
        <span className="pixel hq-company__product">{PRODUCT_NAME}</span>
        <h1 id={`${inputId}-title`}>Como se chama sua empresa?</h1>
        <p id={helpId} className="hq-company__help">Monte sua empresa de social media com uma equipe de agentes de IA.</p>
        {hasData && <p className="hq-company__note">Esta instalação já tem equipe e trabalhos. Nada disso muda: falta só dar um nome à empresa.</p>}
        <label className="hq-field__label" htmlFor={inputId}>Nome da empresa</label>
        <input
          id={inputId} ref={inputRef} className="hq-input hq-company__input" type="text" autoComplete="organization" spellCheck={false}
          placeholder="Ex.: Aurora Social" maxLength={COMPANY_NAME_MAX * 2} value={form.value} disabled={form.saving}
          aria-describedby={form.error ? `${helpId} ${errorId}` : helpId} aria-invalid={form.error ? true : undefined}
          onChange={e => form.change(e.target.value)}
        />
        <div className="hq-company__status" aria-live="polite">
          {form.error && <span id={errorId} className="hq-company__error" role="alert">{form.error}</span>}
          {form.saving && <span className="hq-dim">Salvando…</span>}
        </div>
        <button type="submit" className="hq-btn hq-btn--primary hq-company__go" disabled={form.saving}>{form.saving ? 'Salvando…' : 'Criar minha empresa'}</button>
        <p className="hq-company__foot">Dá para trocar depois em Ajustes → Empresa.</p>
      </form>
    </div>
  );
}

export interface CompanyPanelProps {
  /** Nome em vigor (null = ainda não escolhido). */
  current: string | null;
  onSave(name: string): Promise<void>;
}

/** Ajustes → Empresa: editar o nome sem reinstalar. Salva na hora, com botão próprio (não depende do "Salvar" do diálogo). */
export function CompanyPanel({ current, onSave }: CompanyPanelProps) {
  const form = useCompanyNameForm(current ?? '', onSave);
  const inputId = useId();
  const hintId = useId();
  const unchanged = form.value.trim() === (current ?? '');
  return (
    <div className="hq-company-panel">
      <label className="hq-field__label" htmlFor={inputId}>Nome da empresa</label>
      <div className="hq-company-panel__row">
        <input
          id={inputId} className="hq-input" type="text" autoComplete="organization" spellCheck={false} placeholder="Ex.: Aurora Social"
          maxLength={COMPANY_NAME_MAX * 2} value={form.value} disabled={form.saving} aria-describedby={hintId} aria-invalid={form.error ? true : undefined}
          onChange={e => form.change(e.target.value)}
          // Enter salva só o nome; sem isto, o Enter enviaria o formulário inteiro de Ajustes.
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (!unchanged) void form.submit(); } }}
        />
        <button type="button" className="hq-btn hq-btn--primary" disabled={form.saving || unchanged} onClick={() => void form.submit()}>{form.saving ? 'Salvando…' : 'Salvar nome'}</button>
      </div>
      <div className="hq-company__status" aria-live="polite">
        {form.error && <span className="hq-company__error" role="alert">{form.error}</span>}
        {form.savedName && !form.error && <span className="hq-company__ok">Nome salvo: {form.savedName}</span>}
      </div>
      <p id={hintId} className="hq-field__hint">
        É o nome da sua empresa: aparece no topo, no título da aba e no contexto dos próximos trabalhos dos agentes.
        Perfis editoriais, equipes, contas sociais, entregas e conversas já feitas não são renomeados.
        O nome do aplicativo continua sendo {PRODUCT_NAME}.
      </p>
    </div>
  );
}
