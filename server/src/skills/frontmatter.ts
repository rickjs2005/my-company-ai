// Leitura TEXTUAL do frontmatter de SKILL.md e de agentes (.md). Subconjunto de YAML suficiente para o que o Claude Code
// aceita nesses arquivos: `chave: valor`, strings com aspas, blocos `>`/`|`, listas inline `[a, b]`, listas `- item` e mapas
// aninhados em qualquer profundidade (ex.: `metadata:`/`retrieval:` dos plugins). NUNCA executa nada: comandos embutidos
// (!`cmd`) só são detectados e sinalizados.

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  /** true quando o arquivo começa com `---` (mesmo que o bloco esteja malformado). */
  present: boolean;
  problems: string[];
}

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/;
/** Sintaxe de injeção dinâmica do Claude Code: o conteúdo de !`comando` é executado quando a skill é ativada. */
const SHELL_INJECTION_RE = /!`[^`\n]+`/;

export function hasShellInjection(body: string): boolean { return SHELL_INJECTION_RE.test(body); }

function unquote(v: string): unknown {
  const s = v.trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) return s.slice(1, -1).replace(/\\"/g, '"');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  // comentário de fim de linha (" # ...") só fora de aspas
  const hash = s.indexOf(' #');
  return hash > 0 ? s.slice(0, hash).trim() : s;
}

function splitInlineList(s: string): unknown[] {
  const inner = s.trim().slice(1, -1);
  const out: string[] = [];
  let cur = ''; let quote: string | null = null;
  for (const ch of inner) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(x => unquote(x)).filter(x => x !== '');
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === '' || line.trim().startsWith('#');

class Parser {
  readonly problems: string[] = [];
  constructor(private readonly lines: string[]) {}

  /** Linhas filhas de `index` (mais indentadas que `indent`), devolvendo também onde o bloco termina. */
  private children(from: number, indent: number): { block: string[]; next: number } {
    const block: string[] = []; let i = from;
    while (i < this.lines.length) {
      const l = this.lines[i];
      if (isBlank(l)) { block.push(''); i++; continue; }
      if (indentOf(l) <= indent) break;
      block.push(l); i++;
    }
    while (block.length && block[block.length - 1] === '') block.pop();
    return { block, next: i };
  }

  private scalar(raw: string): unknown {
    const v = raw.trim();
    if (v.startsWith('[') && v.endsWith(']')) return splitInlineList(v);
    if (v.startsWith('{') && v.endsWith('}')) { this.problems.push('mapa inline `{...}` no frontmatter não é interpretado pela HQ'); return v; }
    return unquote(v);
  }

  private blockScalar(indicator: string, block: string[]): string {
    const minIndent = Math.min(...block.filter(l => l.trim()).map(indentOf), Infinity);
    const stripped = block.map(l => (l.trim() ? l.slice(minIndent === Infinity ? 0 : minIndent) : ''));
    if (indicator.startsWith('|')) return stripped.join('\n');
    return stripped.reduce((acc, l) => (l === '' ? acc + '\n' : acc ? (acc.endsWith('\n') ? acc + l : acc + ' ' + l) : l), '').trim();
  }

  /** Interpreta um bloco (linhas já recortadas) como lista ou mapa, conforme a primeira linha útil. */
  private node(block: string[]): unknown {
    const first = block.find(l => !isBlank(l));
    if (first === undefined) return '';
    const base = indentOf(first);
    if (first.trim().startsWith('- ') || first.trim() === '-') return this.list(block, base);
    return this.mapping(block, base);
  }

  private list(block: string[], base: number): unknown[] {
    const out: unknown[] = []; let i = 0;
    const sub = new Parser(block);
    while (i < block.length) {
      const l = block[i];
      if (isBlank(l)) { i++; continue; }
      if (indentOf(l) !== base || !(l.trim().startsWith('- ') || l.trim() === '-')) { this.problems.push(`linha de lista não reconhecida: "${l.trim().slice(0, 60)}"`); i++; continue; }
      const rest = l.trim().slice(1).trim();
      const { block: kids, next } = sub.children(i + 1, base);
      if (rest === '') out.push(kids.length ? this.node(kids) : '');
      else if (KEY_RE.test(rest) && !/^["']/.test(rest) && !rest.startsWith('http')) {
        // item que é um mapa ("- name: x" seguido de linhas mais indentadas)
        const own = ' '.repeat(base + 2) + rest;
        out.push(this.mapping([own, ...kids], base + 2));
      } else out.push(this.scalar(rest));
      i = next;
    }
    this.problems.push(...sub.problems);
    return out;
  }

  private mapping(block: string[], base: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {}; let i = 0;
    const sub = new Parser(block);
    while (i < block.length) {
      const l = block[i];
      if (isBlank(l)) { i++; continue; }
      if (indentOf(l) !== base) { this.problems.push(`indentação inesperada no frontmatter: "${l.trim().slice(0, 60)}"`); i++; continue; }
      const m = KEY_RE.exec(l.trim());
      if (!m) { this.problems.push(`linha de frontmatter não reconhecida: "${l.trim().slice(0, 60)}"`); i++; continue; }
      const key = m[1]; const raw = (m[2] ?? '').trim();
      const { block: kids, next } = sub.children(i + 1, base);
      if (raw === '') obj[key] = kids.length ? this.node(kids) : '';
      else if (/^[>|][-+]?$/.test(raw)) obj[key] = this.blockScalar(raw, kids);
      else { obj[key] = this.scalar(raw); if (kids.length) this.problems.push(`linhas indentadas depois de "${key}: ${raw.slice(0, 30)}" foram ignoradas`); }
      i = next;
    }
    this.problems.push(...sub.problems);
    return obj;
  }

  parse(): Record<string, unknown> { return this.mapping(this.lines, this.lines.find(l => !isBlank(l)) ? indentOf(this.lines.find(l => !isBlank(l))!) : 0); }
}

/** Separa frontmatter e corpo. Sem `---` na primeira linha: data vazio, body = texto inteiro. */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '');
  const lines = src.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { data: {}, body: src, present: false, problems: [] };
  let end = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === '---' || lines[i].trim() === '...') { end = i; break; } }
  if (end < 0) return { data: {}, body: src, present: true, problems: ['frontmatter sem fechamento `---`'] };
  const parser = new Parser(lines.slice(1, end));
  const data = parser.parse();
  return { data, body: lines.slice(end + 1).join('\n'), present: true, problems: parser.problems };
}

export function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

export function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (s === 'true' || s === 'yes') return true; if (s === 'false' || s === 'no') return false; }
  return null;
}

/** Lista de nomes: aceita array ou string separada por vírgulas/espaços (como `tools: Read, Grep` nos agentes). */
export function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  return [];
}
