// Preparação da pasta de conteúdo: copia o kit (sem sobrescrever nada que já exista), cria a estrutura por marca e peça,
// gera o inventário dos originais (por caminho, sem mover nada) e o resumo dos destinos que a equipe lê.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ContentDestination, SocialAccount, SocialSlotId } from '@milweb-hq/protocol';
import { SOCIAL_SLOTS } from '@milweb-hq/protocol';

// Uma pasta por equipe (08/11): peças, referências e material de cada uma ficam separados (marcas/aurora e marcas/tuco-dev).
export const CONTENT_DIRS = ['marcas/aurora/pecas', 'marcas/aurora/referencias', 'marcas/aurora/material', 'marcas/tuco-dev/pecas', 'marcas/tuco-dev/referencias', 'marcas/tuco-dev/material', 'radar/entrada', 'calendario', 'resultados/evidencias', 'referencias', 'equipe'];

/** Matriz inicial do Chefe (02/11/2026), proposta editável. Público e pilares são propostas da HQ até ele revisar. */
export const DEFAULT_DESTINATIONS: Omit<ContentDestination, 'updatedAt'>[] = [
  { slot: 'instagram-aurora', objective: 'Atrair interessados em sites e landing pages', audience: 'Donos de pequenas e médias empresas que decidem contratar um site ou landing page (Brasil)', language: 'pt-BR', pillars: ['Projetos reais do portfólio', 'Processo de criação', 'Demonstrações de funcionalidades'], content: 'Projetos, processo e demonstrações', indicator: 'Visitas ao portfólio e contatos qualificados', state: 'proposta' },
  { slot: 'instagram-tuco', objective: 'Construir autoridade e comunidade tech', audience: 'Pessoas curiosas por tecnologia e desenvolvedores iniciantes (Brasil)', language: 'pt-BR', pillars: ['Explicar sem complicar', 'Experiências com código e IA', 'Segurança e notícias explicadas'], content: 'Explicações, experiências e investigação acessível', indicator: 'Compartilhamentos, salvamentos e seguidores interessados', state: 'proposta' },
  { slot: 'threads', objective: 'Conversas e relacionamento da marca à qual a conta pertence', audience: 'Seguidores da marca dona da conta (a confirmar qual)', language: 'pt-BR', pillars: ['Bastidores', 'Perguntas com contexto', 'Opinião técnica explicada'], content: 'Bastidores e perguntas com contexto', indicator: 'Respostas relevantes e visitas ao perfil', state: 'proposta' },
  { slot: 'tiktok', objective: 'Descoberta e personalidade do Tuco Dev (hipótese inicial)', audience: 'Público jovem curioso por tecnologia (Brasil)', language: 'pt-BR', pillars: ['Demonstrações', 'Humor dev', 'Explicações visuais'], content: 'Demonstrações, humor dev e explicações visuais', indicator: 'Retenção (quando disponível), compartilhamentos e interesse pelo perfil', state: 'proposta' },
  { slot: 'linkedin', objective: 'Reputação profissional e oportunidades', audience: 'Empresários, agências e recrutadores', language: 'pt-BR', pillars: ['Cases reais', 'Decisões de desenvolvimento', 'Aprendizados'], content: 'Cases reais, decisões de desenvolvimento e aprendizados', indicator: 'Conversas profissionais e contatos', state: 'proposta' },
  { slot: 'x', objective: 'Público internacional interessado em tecnologia', audience: 'Developers and tech-curious people worldwide', language: 'en', pillars: ['Security alerts', 'Developer tools and releases', 'Verified tech news'], content: 'Notícias verificadas, ferramentas dev, atualizações e alertas úteis', indicator: 'Seguidores relevantes, respostas e cliques quando disponíveis', state: 'proposta' },
  { slot: 'pinterest', objective: 'Levar interessados aos projetos da Aurora', audience: 'Quem procura referência de web design e landing pages', language: 'a confirmar (pt-BR ou en)', pillars: ['Web Design', 'Landing Pages', 'UI Details'], content: 'Pins de sites, interfaces e detalhes visuais', indicator: 'Cliques de saída e salvamentos', state: 'proposta' },
];

const MANIFEST = path.join('equipe', '.kit-manifest.json');
const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Copia o kit para a pasta. Arquivo novo é criado; arquivo do kit que o Chefe não alterou (hash igual ao que a HQ gravou)
 *  é atualizado para a versão nova; arquivo alterado por ele fica como está (e é listado em `kept`). */
export function copyKit(kitDir: string, folder: string): string[] & { updated?: string[]; kept?: string[] } {
  const created: string[] & { updated?: string[]; kept?: string[] } = [];
  const updated: string[] = []; const kept: string[] = [];
  const manFile = path.join(folder, MANIFEST);
  let manifest: Record<string, string> = {};
  try { manifest = JSON.parse(fs.readFileSync(manFile, 'utf8')) as Record<string, string>; } catch { manifest = {}; }
  const walk = (rel: string) => {
    const src = path.join(kitDir, rel);
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const r = path.join(rel, ent.name);
      if (ent.isDirectory()) { fs.mkdirSync(path.join(folder, r), { recursive: true }); walk(r); continue; }
      const key = r.split(path.sep).join('/');
      const dst = path.join(folder, r);
      const next = fs.readFileSync(path.join(kitDir, r));
      if (!fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, next); manifest[key] = sha(next); created.push(r); continue;
      }
      const cur = fs.readFileSync(dst);
      if (sha(cur) === sha(next)) { manifest[key] = sha(next); continue; }
      if (manifest[key] && manifest[key] === sha(cur)) { fs.writeFileSync(dst, next); manifest[key] = sha(next); updated.push(r); continue; }
      kept.push(r);
    }
  };
  walk('');
  for (const d of CONTENT_DIRS) fs.mkdirSync(path.join(folder, d), { recursive: true });
  fs.writeFileSync(manFile, JSON.stringify(manifest, null, 1), 'utf8');
  created.updated = updated; created.kept = kept;
  return created;
}

export interface MirrorSource { label: string; from: string; to: string; exts: RegExp; depth: number; dirFilter?: RegExp; sub?: string; skip?: RegExp }

/** Referências que a equipe lê, copiadas para dentro da pasta (os funcionários só leem a própria pasta sem pedir autorização). */
export function defaultMirrors(home: string): MirrorSource[] {
  const proj = path.join(home, 'projetos');
  return [
    { label: 'Skill milweb-video-studio (referências)', from: path.join(home, '.claude', 'skills', 'milweb-video-studio', 'references'), to: 'milweb-video-studio', exts: /\.md$/i, depth: 2 },
    { label: 'Estudo Instagram e Threads (30/10/2026)', from: path.join(proj, 'estudo-instagram-threads'), to: 'estudo-instagram-threads', exts: /\.(md|csv)$/i, depth: 1, skip: /^CLAUDE\.md$/i },
    { label: 'Textos dos episódios do Tuco Dev', from: proj, to: 'tuco', exts: /\.(md|srt)$/i, depth: 1, dirFilter: /^tuco-/i, sub: 'entrega' },
    { label: 'Capturas do portfólio (site aurora.example)', from: path.join(proj, 'aurora', 'public', 'shots'), to: 'portfolio-shots', exts: /\.(webp|png|jpe?g)$/i, depth: 2 },
    { label: 'Textos dos projetos do portfólio (código do site)', from: path.join(proj, 'aurora', 'src', 'lib'), to: 'portfolio-textos', exts: /^content-projects-\d+\.ts$/i, depth: 1 },
    { label: 'Composição de vídeo CenasReel: esquema do video.json e exemplo (remotion-video)', from: path.join(proj, 'remotion-video', 'src', 'cenas'), to: 'cenas', exts: /^(schema\.ts|apps-mudaram\.json)$/i, depth: 2 },
  ];
}

/** Atualiza referencias/espelho/ a partir dos originais (copia só o que mudou). Os originais nunca são alterados. */
export function writeMirrors(folder: string, sources: MirrorSource[], now = Date.now()): { copied: number; files: number } {
  const base = path.join(folder, 'referencias', 'espelho');
  let copied = 0; let files = 0;
  const lines = ['# Espelho de referências (gerado pelo My Company AI, não edite aqui)', '', `Atualizado em ${new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. Cópias de leitura dos originais abaixo; para mudar algo, mude o original.`, ''];
  const copyTree = (src: string, dst: string, s: MirrorSource, left: number) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const a = path.join(src, e.name); const b = path.join(dst, e.name);
      if (e.isDirectory()) { if (left > 1 && !e.name.startsWith('.') && e.name !== 'node_modules') copyTree(a, b, s, left - 1); continue; }
      if (!s.exts.test(e.name) || s.skip?.test(e.name)) continue;
      files++;
      try {
        const st = fs.statSync(a); const dt = fs.existsSync(b) ? fs.statSync(b) : null;
        if (dt && dt.size === st.size && dt.mtimeMs >= st.mtimeMs) continue;
        fs.mkdirSync(dst, { recursive: true }); fs.copyFileSync(a, b); copied++;
      } catch { /* arquivo preso: fica para a próxima atualização */ }
    }
  };
  for (const s of sources) {
    const target = path.join(base, s.to);
    if (s.dirFilter) {
      let dirs: string[] = [];
      try { dirs = fs.readdirSync(s.from, { withFileTypes: true }).filter(e => e.isDirectory() && s.dirFilter!.test(e.name)).map(e => e.name); } catch { dirs = []; }
      for (const d of dirs) copyTree(path.join(s.from, d, s.sub ?? ''), path.join(target, d), s, s.depth);
    } else copyTree(s.from, target, s, s.depth);
    lines.push(`- \`referencias/espelho/${s.to}/\`: ${s.label} (original: \`${s.from}${s.dirFilter ? path.sep + '<pasta>' + path.sep + (s.sub ?? '') : ''}\`)`);
  }
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'LEIA-ME.md'), lines.join('\n') + '\n', 'utf8');
  return { copied, files };
}

/** Resumo dos sete destinos que a equipe lê antes de qualquer tarefa (arquivo da HQ, regenerado). */
export function writeDestinations(folder: string, dests: ContentDestination[], accounts: SocialAccount[], profileName: (id: string) => string, focus?: { activeSlots: SocialSlotId[] | null; reason: string; expansion: string } | null): string {
  const file = path.join(folder, 'equipe', 'destinos.md');
  const byslot = new Map(dests.map(d => [d.slot, d]));
  const lines = [
    '# Destinos (gerado pelo My Company AI, não edite aqui)',
    '',
    'Fonte: Central de Redes e Calendário → Destinos. "Proposta" = matriz inicial ainda não revista pelo Chefe.',
    '',
    ...(focus?.activeSlots ? [`**${focus.reason}.** Destinos ativos (produção, agendamento e publicação): ${focus.activeSlots.map(s => `\`${s}\``).join(', ')}. Os outros estão PAUSADOS: não proponha nem produza para eles (contas e históricos ficam).`, '', focus.expansion, ''] : []),
  ];
  for (const def of SOCIAL_SLOTS) {
    const d = byslot.get(def.slot); const a = accounts.find(x => x.slot === def.slot);
    const handle = a?.username ? `@${a.username} (confirmada pela API)` : a?.declared?.handle ? `@${a.declared.handle} (${a.declared.confirmed ? 'confirmada pelo Chefe' : `a confirmar; achada em ${a.declared.source}`})` : a?.declared?.toCreate ? 'conta a criar' : 'não informada';
    const paused = Boolean(focus?.activeSlots && !focus.activeSlots.includes(def.slot));
    lines.push(`## ${def.label} (\`${def.slot}\`)${focus?.activeSlots ? (paused ? ' · PAUSADO' : ' · ATIVO') : ''}`, '');
    if (paused) lines.push(`- Estado: pausado pelo foco (${focus!.reason}); pode ser fonte de pesquisa, nunca destino.`);
    lines.push(`- Conta: ${handle}`);
    lines.push(`- Perfil editorial: ${a?.profileIds.length ? a.profileIds.map(profileName).join(', ') : 'não associado (a confirmar)'}`);
    lines.push(`- Publicação: ${def.mode === 'manual' ? 'manual pelo site oficial' : a?.status === 'connected' ? 'conta conectada pela API' : 'manual até a conta ser conectada'}`);
    if (d) {
      lines.push(`- Objetivo (${d.state}): ${d.objective}`, `- Público: ${d.audience}`, `- Idioma: ${d.language}`, `- Pilares: ${d.pillars.join('; ')}`, `- Conteúdo: ${d.content}`, `- Indicador principal: ${d.indicator}`);
    }
    lines.push('');
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

export interface OriginSource { label: string; dir: string; dirFilter?: RegExp; sub?: string; exts: RegExp; depth: number }

/** Fontes padrão dos originais do Chefe nesta máquina (só leitura). */
export function defaultOrigins(home: string): OriginSource[] {
  const proj = path.join(home, 'projetos');
  return [
    { label: 'Capturas do portfólio (site aurora.example)', dir: path.join(proj, 'aurora', 'public', 'shots'), exts: /\.(webp|png|jpe?g)$/i, depth: 2 },
    { label: 'Episódios entregues do Tuco Dev', dir: proj, dirFilter: /^tuco-/i, sub: 'entrega', exts: /\.(mp4|srt|md)$/i, depth: 1 },
    { label: 'Vídeos do Chefe (pasta Vídeos)', dir: path.join(home, 'Videos'), exts: /\.(mp4|mov|mkv)$/i, depth: 2 },
    { label: 'Renders do remotion-video', dir: path.join(proj, 'remotion-video', 'out'), exts: /\.(mp4|png)$/i, depth: 1 },
  ];
}

const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

function listFiles(dir: string, exts: RegExp, depth: number, cap = 300): { file: string; size: number; mtime: number }[] {
  const out: { file: string; size: number; mtime: number }[] = [];
  const walk = (d: string, left: number) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= cap) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (left > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') walk(p, left - 1); continue; }
      if (!exts.test(e.name)) continue;
      try { const st = fs.statSync(p); out.push({ file: p, size: st.size, mtime: st.mtimeMs }); } catch { /* sumiu no meio */ }
    }
  };
  walk(dir, depth - 1);
  return out;
}

/** Projetos do portfólio (slug, título, situação) lidos do código do site, com a URL pública da página do projeto. */
export function portfolioProjects(siteDir: string): { slug: string; title: string; status: string | null; url: string }[] {
  const lib = path.join(siteDir, 'src', 'lib');
  let files: string[] = [];
  try { files = fs.readdirSync(lib).filter(f => /^content-projects-\d+\.ts$/.test(f)); } catch { return []; }
  const out: { slug: string; title: string; status: string | null; url: string }[] = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(lib, f), 'utf8');
    for (const m of src.matchAll(/slug:\s*"([a-z0-9-]+)",[\s\S]*?title:\s*"([^"]+)"[\s\S]*?status:\s*\{\s*pt:\s*"([^"]+)"/g)) {
      out.push({ slug: m[1], title: m[2], status: m[3], url: `https://aurora.example/projetos/${m[1]}` });
    }
  }
  return out;
}

/** Gera referencias/originais.md: o que existe, onde está e quanto pesa. Nada é copiado nem movido. */
export function writeInventory(folder: string, sources: OriginSource[], siteDir: string | null, now = Date.now()): { file: string; count: number } {
  const lines = ['# Originais (inventário gerado pelo My Company AI, não edite aqui)', '', `Gerado em ${new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. Os arquivos continuam onde estão; use o caminho.`, ''];
  let count = 0;
  for (const s of sources) {
    const dirs = s.dirFilter
      ? (() => { try { return fs.readdirSync(s.dir, { withFileTypes: true }).filter(e => e.isDirectory() && s.dirFilter!.test(e.name)).map(e => path.join(s.dir, e.name, s.sub ?? '')); } catch { return []; } })()
      : [s.dir];
    const files = dirs.flatMap(d => listFiles(d, s.exts, s.depth));
    lines.push(`## ${s.label}`, '');
    if (!files.length) { lines.push(`Nada encontrado em \`${s.dir}\`.`, ''); continue; }
    for (const f of files.sort((a, b) => a.file.localeCompare(b.file))) lines.push(`- \`${f.file}\` · ${fmtSize(f.size)} · ${new Date(f.mtime).toISOString().slice(0, 10)}`);
    lines.push('');
    count += files.length;
  }
  if (siteDir) {
    const projects = portfolioProjects(siteDir);
    lines.push('## Páginas de projeto no portfólio (destino real para Pins e cases)', '', 'A situação vem do próprio site ("Projeto autoral" = demo/conceito, não é cliente). Confira a URL antes de usar.', '');
    for (const p of projects) lines.push(`- ${p.title} · ${p.status ?? 'situação não informada'} · ${p.url}`);
    lines.push('');
    count += projects.length;
  }
  const file = path.join(folder, 'referencias', 'originais.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { file, count };
}

/** Pasta da marca de uma peça (perfil editorial do item ou o padrão do destino). */
export function brandFolder(profileId: string | null, slot: SocialSlotId | null): 'aurora' | 'tuco-dev' {
  if (profileId === 'tuco-dev') return 'tuco-dev';
  if (profileId === 'aurora') return 'aurora';
  return slot === 'instagram-tuco' || slot === 'tiktok' || slot === 'x' ? 'tuco-dev' : 'aurora';
}

export function slugify(t: string, max = 40): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'peca';
}
