// Academia de Vídeo (07/11/2026, pedido do Chefe: "Equipe, estudem esse vídeo. Quero que aprendam a fazer animações desse
// nível."). O Diretor de Vídeo grava o estudo (estudo.json), cada exercício grava o resultado (resultado.json) e a correção
// fecha o ciclo (correcao.json). A HQ confere esses arquivos, guarda no banco e escreve na pasta de conteúdo o que a equipe
// lê depois: academia/INDICE.md (curto, uma linha por técnica) e academia/tecnicas/<slug>.md (a ficha completa). Assim o
// aprendizado volta nas próximas tarefas sem encher o contexto: o índice é pequeno e cada um abre só a ficha que vai usar.
import fs from 'node:fs';
import path from 'node:path';
import type { AcademyStudy, AcademyTechnique, ContentRole, TechniqueCategory, TechniqueEvidence, TechniqueTool } from '@milweb-hq/protocol';
import { TECHNIQUE_CATEGORY_LABEL } from '@milweb-hq/protocol';

const txt = (v: unknown, max = 2000): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const list = (v: unknown, max: number, each = 400): string[] => (Array.isArray(v) ? v.map(x => txt(x, each)).filter((x): x is string => Boolean(x)).slice(0, max) : []);

export const CATEGORIES = Object.keys(TECHNIQUE_CATEGORY_LABEL) as TechniqueCategory[];
const TOOLS: TechniqueTool[] = ['remotion', 'ffmpeg', 'gsap', 'css', 'edicao', 'outro'];
/** Papéis que recebem exercício (o Diretor não faz o próprio exercício). */
export const EXERCISE_ROLES: ContentRole[] = ['video', 'criador', 'revisor', 'coordenador', 'pesquisador'];

export function techSlug(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export interface ParsedTechnique {
  slug: string; name: string; category: TechniqueCategory; evidence: TechniqueEvidence; at: string | null; howWeKnow: string | null;
  summary: string; how: { tool: TechniqueTool; text: string }[]; pitfalls: string[];
}
export interface ParsedExercise { title: string; role: ContentRole; profileId: string | null; techniques: string[]; instructions: string; deliverable: string }
export interface ParsedStudy { central: string | null; summary: string; recommended: string | null; techniques: ParsedTechnique[]; exercises: ParsedExercise[]; warnings: string[] }

/** Confere o estudo.json do Diretor. Técnica sem "evidencia" vira inferência (com aviso): na dúvida, não é fato. */
export function parseStudy(o: Record<string, unknown>): { ok: true; value: ParsedStudy } | { ok: false; error: string } {
  const warnings: string[] = [];
  const summary = txt(o.resumoLicao ?? o.licao ?? o.resumo, 600);
  if (!summary) return { ok: false, error: 'estudo.json sem "resumoLicao" (a lição em uma frase)' };
  const rawT = Array.isArray(o.tecnicas) ? o.tecnicas : [];
  if (!rawT.length) return { ok: false, error: 'estudo.json sem "tecnicas"' };
  const techniques: ParsedTechnique[] = []; const seen = new Set<string>();
  if (rawT.length > 16) warnings.push(`${rawT.length} técnicas: só as 16 primeiras entraram na biblioteca`);
  for (const [i, raw] of rawT.slice(0, 16).entries()) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const name = txt(t.nome ?? t.name, 120);
    if (!name) { warnings.push(`técnica ${i + 1} sem nome: ignorada`); continue; }
    const slug = techSlug(txt(t.slug, 60) ?? name);
    if (!slug || seen.has(slug)) { warnings.push(`técnica "${name}" repetida: ignorada`); continue; }
    seen.add(slug);
    const cat = techSlug(String(t.categoria ?? t.category ?? '')).replace(/-/g, '') as TechniqueCategory;
    const evidence: TechniqueEvidence = t.evidencia === 'observado' || t.evidence === 'observado' ? 'observado' : 'inferido';
    if (t.evidencia !== 'observado' && t.evidencia !== 'inferido') warnings.push(`"${name}": evidência não informada, registrada como inferência`);
    const how = (Array.isArray(t.comoFazer) ? t.comoFazer : []).flatMap(h => {
      const x = (h ?? {}) as Record<string, unknown>;
      const text = txt(x.passos ?? x.texto ?? x.como, 1500); if (!text) return [];
      const tool = TOOLS.includes(String(x.ferramenta ?? '').toLowerCase() as TechniqueTool) ? String(x.ferramenta).toLowerCase() as TechniqueTool : 'outro';
      return [{ tool, text }];
    }).slice(0, 6);
    techniques.push({
      slug, name, category: CATEGORIES.includes(cat) ? cat : 'outro', evidence, at: txt(t.onde ?? t.tempo, 80), howWeKnow: txt(t.comoSabemos ?? t.evidenciaTexto, 600),
      summary: txt(t.oQueE ?? t.resumo, 600) ?? name, how, pitfalls: list(t.armadilhas, 6),
    });
  }
  if (!techniques.length) return { ok: false, error: 'nenhuma técnica válida em estudo.json' };
  const rawE = Array.isArray(o.exercicios) ? o.exercicios : [];
  const exercises: ParsedExercise[] = [];
  for (const [i, raw] of rawE.slice(0, 6).entries()) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const title = txt(e.titulo, 160); const instructions = txt(e.instrucoes, 3000);
    if (!title || !instructions) { warnings.push(`exercício ${i + 1} sem título ou instruções: ignorado`); continue; }
    const role = EXERCISE_ROLES.includes(e.papel as ContentRole) ? e.papel as ContentRole : 'video';
    const profileId = e.equipe === 'tuco-dev' || e.equipe === 'aurora' ? e.equipe : null;
    const techs = list(e.tecnicas, 6, 60).map(techSlug).filter(s => seen.has(s));
    exercises.push({ title, role, profileId, techniques: techs, instructions, deliverable: txt(e.entrega, 400) ?? (role === 'video' ? 'video.json (a HQ renderiza o MP4)' : 'arquivo .md com o resultado') });
  }
  if (!exercises.length) return { ok: false, error: 'estudo.json sem exercícios válidos ("exercicios" com titulo, papel e instrucoes)' };
  return { ok: true, value: { central: txt(o.ideiaCentral, 600), summary, recommended: txt(o.recomendada, 1500), techniques, exercises, warnings } };
}

/** Une a técnica do estudo à que já existe na biblioteca (mesmo slug): soma a fonte, junta "como fazer" e armadilhas. */
export function mergeTechnique(prev: AcademyTechnique | null, t: ParsedTechnique, source: { studyId: string; title: string }): Omit<AcademyTechnique, 'id' | 'createdAt' | 'updatedAt'> {
  const sources = [...(prev?.sources ?? []).filter(s => s.studyId !== source.studyId), { studyId: source.studyId, title: source.title, at: t.at, evidence: t.evidence, note: t.howWeKnow }];
  const how = [...(prev?.how ?? [])];
  for (const h of t.how) if (!how.some(x => x.tool === h.tool && x.text === h.text)) how.push(h);
  return {
    slug: t.slug, name: prev?.name ?? t.name, category: prev?.category ?? t.category, summary: prev?.summary || t.summary, how: how.slice(-10), sources: sources.slice(-12),
    examples: prev?.examples ?? [], pitfalls: [...new Set([...(prev?.pitfalls ?? []), ...t.pitfalls])].slice(0, 12), file: prev?.file ?? null,
  };
}

/** Arquivo citado pelo funcionário: relativo à pasta do exercício ou absoluto dentro da pasta de conteúdo, e existente. */
function resolveFile(f: string, dir: string, root: string): string | null {
  const abs = path.isAbsolute(f) ? path.resolve(f) : path.resolve(dir, f);
  const inside = abs.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep);
  try { return inside && fs.statSync(abs).isFile() ? abs : null; } catch { return null; }
}

export interface ParsedResult { summary: string | null; files: string[]; missing: string[]; learned: string | null; doubts: string | null }
/** resultado.json de um exercício: o que fez, os arquivos (conferidos no disco), o que aprendeu e as dúvidas. */
export function parseExerciseResult(o: Record<string, unknown>, dir: string, root: string): { ok: true; value: ParsedResult } | { ok: false; error: string } {
  const summary = txt(o.resumo ?? o.oQueFiz, 1500);
  const cited = list(o.arquivos ?? o.files, 20, 500);
  const files: string[] = []; const missing: string[] = [];
  for (const f of cited) { const abs = resolveFile(f, dir, root); if (abs) files.push(abs); else missing.push(f); }
  if (!summary && !files.length) return { ok: false, error: 'resultado.json sem "resumo" nem arquivos' };
  return { ok: true, value: { summary, files, missing, learned: txt(o.aprendi, 1500), doubts: txt(o.duvidas, 1500) } };
}

export interface ParsedCorrection { summary: string | null; exercises: { id: string; verdict: 'ok' | 'ajustar'; note: string }[]; techniques: { slug: string; pitfalls: string[] }[] }
export function parseCorrection(o: Record<string, unknown>): { ok: true; value: ParsedCorrection } | { ok: false; error: string } {
  const exercises = (Array.isArray(o.exercicios) ? o.exercicios : []).flatMap(raw => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const id = txt(e.id, 20); const note = txt(e.comentario ?? e.nota, 1500);
    if (!id || !note) return [];
    return [{ id, verdict: e.veredito === 'ok' || e.veredito === 'aprovado' ? 'ok' as const : 'ajustar' as const, note }];
  });
  if (!exercises.length) return { ok: false, error: 'correcao.json sem "exercicios" (id, veredito, comentario)' };
  const techniques = (Array.isArray(o.tecnicas) ? o.tecnicas : []).flatMap(raw => {
    const t = (raw ?? {}) as Record<string, unknown>; const slug = txt(t.slug, 60);
    return slug ? [{ slug: techSlug(slug), pitfalls: list(t.armadilhas, 6) }] : [];
  });
  return { ok: true, value: { summary: txt(o.resumo, 1500), exercises, techniques } };
}

const rel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');
const TOOL_LABEL: Record<TechniqueTool, string> = { remotion: 'Remotion', ffmpeg: 'FFmpeg', gsap: 'GSAP', css: 'CSS', edicao: 'Edição', outro: 'Outro' };

/** Ficha da técnica (academia/tecnicas/<slug>.md). Reescrita pela HQ a cada mudança: é o registro, não um rascunho. */
export function writeTechniqueCard(root: string, t: AcademyTechnique, studies: AcademyStudy[]): string {
  const file = path.join(root, 'academia', 'tecnicas', `${t.slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const L = [`# ${t.name}`, '', `Categoria: ${TECHNIQUE_CATEGORY_LABEL[t.category]} · slug \`${t.slug}\` · ficha escrita pela HQ (não edite: ela é refeita a cada estudo)`, '', t.summary, ''];
  L.push('## Onde vimos', ...t.sources.map(s => {
    const st = studies.find(x => x.id === s.studyId);
    return `- ${s.evidence === 'observado' ? 'OBSERVADO' : 'INFERIDO (hipótese, não verificado)'} em "${s.title}"${s.at ? ` (${s.at})` : ''}${s.note ? `: ${s.note}` : ''}${st ? ` · estudo: \`${rel(root, st.folder)}\`` : ''}`;
  }), '');
  if (t.how.length) L.push('## Como fazer com as ferramentas da casa', ...t.how.map(h => `- **${TOOL_LABEL[h.tool]}:** ${h.text}`), '');
  if (t.pitfalls.length) L.push('## Erros a evitar', ...t.pitfalls.map(p => `- ${p}`), '');
  if (t.examples.length) {
    L.push('## Exercícios da equipe', ...t.examples.map(e => `- ${e.employee ?? 'equipe'}: ${e.verdict === 'ok' ? 'aprovado pelo Diretor' : e.verdict === 'ajustar' ? 'precisa de ajuste' : 'sem correção ainda'}${e.note ? ` · ${e.note}` : ''}${e.file ? ` · \`${rel(root, e.file)}\`` : ''}`), '');
  }
  fs.writeFileSync(file, L.join('\n'), 'utf8');
  return file;
}

/** Índice curto que vai para todo pedido de vídeo: uma linha por técnica (até 60) e os estudos recentes (até 12). */
export function writeAcademyIndex(root: string, techniques: AcademyTechnique[], studies: AcademyStudy[], now: number): string {
  const file = path.join(root, 'academia', 'INDICE.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const when = new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
  const L = [
    '# Academia de Vídeo · índice', '', `Escrito pela HQ em ${when}. Leia este índice antes de montar um vídeo e abra só a ficha da técnica que for usar (\`academia/tecnicas/<slug>.md\`). OBSERVADO = visto nos quadros ou nas medidas; INFERIDO = hipótese do Diretor. Cite no peca.md a técnica que aplicou.`, '',
    `## Técnicas (${techniques.length})`,
  ];
  const sorted = [...techniques].sort((a, b) => (b.examples.filter(e => e.verdict === 'ok').length - a.examples.filter(e => e.verdict === 'ok').length) || b.updatedAt - a.updatedAt);
  for (const t of sorted.slice(0, 60)) {
    const obs = t.sources.some(s => s.evidence === 'observado');
    const ok = t.examples.filter(e => e.verdict === 'ok').length;
    L.push(`- \`${t.slug}\` · ${t.name} (${TECHNIQUE_CATEGORY_LABEL[t.category]}, ${obs ? 'observado' : 'inferido'}${ok ? `, ${ok} exercício(s) aprovado(s)` : ''}): ${short(t.summary, 140)}`);
  }
  if (techniques.length > 60) L.push(`- … mais ${techniques.length - 60} técnica(s) em \`academia/tecnicas/\``);
  L.push('', '## Estudos recentes');
  for (const s of studies.slice(0, 12)) L.push(`- ${new Date(s.createdAt).toISOString().slice(0, 10)} · ${short(s.title, 80)}${s.summary ? ` · ${short(s.summary, 140)}` : ''} · \`${rel(root, s.folder)}\``);
  if (!studies.length) L.push('- nenhum ainda');
  fs.writeFileSync(file, L.join('\n') + '\n', 'utf8');
  return file;
}
