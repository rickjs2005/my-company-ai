// Busca rápida (Ctrl+K, Marco 1): projetos, arquivos dos projetos, funcionários, skills e ações num lugar só. Andar pela
// empresa é opcional: tudo o que é frequente abre por aqui. Arquivo escolhido vira contexto da tarefa (por referência).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Employee, Project, SkillInfo } from '@milweb-hq/protocol';

export type QuickAction = { id: string; label: string; hint?: string; run(): void };
export interface QuickFileHit { projectId: string; projectName: string; path: string; name: string }

export interface QuickSearchProps {
  open: boolean;
  projects: Project[];
  employees: Employee[];
  skills: SkillInfo[];
  actions: QuickAction[];
  searchFiles(query: string): Promise<QuickFileHit[]>;
  onOpenProject(id: string): void;
  onTaskInProject(id: string): void;
  onUseFile(hit: QuickFileHit): void;
  onOpenEmployee(id: string): void;
  onUseSkill(skill: SkillInfo): void;
  onClose(): void;
}

interface Item { key: string; group: string; label: string; sub?: string; run(): void }

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function QuickSearch(props: QuickSearchProps) {
  const { open, projects, employees, skills, actions } = props;
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [files, setFiles] = useState<QuickFileHit[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef(props.searchFiles); searchRef.current = props.searchFiles;

  useEffect(() => {
    const d = dialogRef.current; if (!d) return;
    if (open && !d.open) { d.showModal(); setQ(''); setIdx(0); setFiles([]); window.setTimeout(() => inputRef.current?.focus(), 0); }
    else if (!open && d.open) d.close();
  }, [open]);

  // Arquivos: busca no servidor (nome, dentro das pastas dos projetos) a partir de 2 letras, com pequena espera ao digitar.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) { setFiles([]); return; }
    let alive = true; setSearching(true);
    const t = window.setTimeout(() => {
      searchRef.current(term).then(r => { if (alive) setFiles(r); }).catch(() => { if (alive) setFiles([]); }).finally(() => { if (alive) setSearching(false); });
    }, 220);
    return () => { alive = false; window.clearTimeout(t); };
  }, [q, open]);

  const items: Item[] = useMemo(() => {
    const t = norm(q.trim());
    const match = (...parts: (string | null | undefined)[]) => !t || parts.some(p => p && norm(p).includes(t));
    const out: Item[] = [];
    for (const p of projects.filter(x => !x.id.startsWith('ext:') && match(x.name, x.client)).sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.lastUsedAt - a.lastUsedAt).slice(0, 6)) {
      out.push({ key: `p:${p.id}`, group: 'Projetos', label: `${p.favorite ? '★ ' : ''}${p.name}`, sub: [p.client, 'Enter abre o armário'].filter(Boolean).join(' · '), run: () => props.onOpenProject(p.id) });
      if (t) out.push({ key: `pt:${p.id}`, group: 'Projetos', label: `Nova tarefa em ${p.name}`, sub: 'leva o projeto para “O que vamos fazer?”', run: () => props.onTaskInProject(p.id) });
    }
    for (const f of files.slice(0, 8)) out.push({ key: `f:${f.projectId}:${f.path}`, group: 'Arquivos', label: f.name, sub: `${f.projectName} · ${f.path} · Enter usa como contexto da tarefa`, run: () => props.onUseFile(f) });
    for (const e of employees.filter(x => !x.archivedAt && match(x.name, x.role)).slice(0, 5)) out.push({ key: `e:${e.id}`, group: 'Funcionários', label: e.name, sub: e.role, run: () => props.onOpenEmployee(e.id) });
    if (t) for (const s of skills.filter(x => !x.shadowedBy && match(x.invocation, x.name, x.description)).slice(0, 5)) out.push({ key: `s:${s.id}`, group: 'Skills', label: `/${s.invocation}`, sub: (s.description || '').slice(0, 90), run: () => props.onUseSkill(s) });
    for (const a of actions.filter(x => match(x.label, x.hint))) out.push({ key: `a:${a.id}`, group: 'Ações', label: a.label, sub: a.hint, run: a.run });
    return out;
  }, [q, projects, employees, skills, actions, files]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (idx >= items.length) setIdx(Math.max(0, items.length - 1)); }, [items.length, idx]);
  const choose = (it: Item | undefined) => { if (!it) return; props.onClose(); it.run(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[idx]); }
  };

  let lastGroup = '';
  return (
    <dialog ref={dialogRef} className="hq-dialog hq-qs" aria-label="Busca rápida" onCancel={e => { e.preventDefault(); props.onClose(); }} onClick={e => { if (e.target === dialogRef.current) props.onClose(); }}>
      {open && (
        <div className="hq-qs__inner">
          <input ref={inputRef} className="hq-input hq-qs__input" value={q} onChange={e => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKey}
            placeholder="Buscar projeto, arquivo, funcionário, skill ou ação…" aria-label="Buscar" aria-controls="hq-qs-list" />
          <ul id="hq-qs-list" className="hq-qs__list" role="listbox">
            {items.length === 0 && <li className="hq-qs__empty">{searching ? 'Procurando arquivos…' : 'Nada encontrado.'}</li>}
            {items.map((it, i) => {
              const header = it.group !== lastGroup ? (lastGroup = it.group) : null;
              return (
                <li key={it.key} role="presentation">
                  {header && <div className="hq-qs__group">{header}{header === 'Arquivos' && searching ? ' · procurando…' : ''}</div>}
                  <button type="button" role="option" aria-selected={i === idx} className={`hq-qs__item${i === idx ? ' hq-qs__item--on' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => choose(it)}>
                    <span className="hq-qs__label">{it.label}</span>
                    {it.sub && <span className="hq-qs__sub">{it.sub}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="hq-qs__foot">↑↓ escolhe · Enter abre · Esc fecha</div>
        </div>
      )}
    </dialog>
  );
}
