// Testes dos helpers puros do painel (rodam em Node, sem DOM: o markdown cai no fallbackSanitize).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basename, currentTurnStart, fallbackSanitize, formatBytes, formatCost, formatDuration, formatTime, groupTimeline,
  modelLabel, normalizePath, permissionHighlight, phaseColor, phaseLabel, plainExcerpt, processStateLabel, renderMarkdown,
  sessionStatusLabel, taskStatusLabel, toolIconKind, truncate, PHASE_LABELS, LOG_KIND_LABELS,
  cleanClaudeVersion, rateLimitNotice, resultSummaryLabel, stepsLabel,
} from '../src/panel/helpers';
import type { TimelineEntry } from '../src/panel/types';

// ---------------- Markdown seguro ----------------

test('renderMarkdown converte markdown e remove script', () => {
  const html = renderMarkdown('Projeto criado com **Vite**.<script>alert(1)</script> Rode `pnpm dev`.');
  assert.match(html, /<strong>Vite<\/strong>/);
  assert.match(html, /<code>pnpm dev<\/code>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /alert\(1\)/);
});

test('renderMarkdown remove handlers inline, iframes e links javascript:', () => {
  const html = renderMarkdown('<a href="javascript:alert(1)" onclick="x()">clique</a><iframe src="https://x"></iframe><img src="x" onerror="alert(1)">');
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /onerror/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<iframe/i);
});

test('renderMarkdown abre links em nova aba sem vazar o opener', () => {
  const html = renderMarkdown('Veja [o site](https://aurora.example).');
  assert.match(html, /<a[^>]*href="https:\/\/aurora.example"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('renderMarkdown aceita texto vazio ou indefinido', () => {
  assert.equal(renderMarkdown('').trim(), '');
  assert.equal(renderMarkdown(undefined as unknown as string).trim(), '');
});

test('fallbackSanitize limpa tags perigosas e preserva o conteúdo normal', () => {
  const out = fallbackSanitize('<p>ok</p><style>body{}</style><form><input></form><a href="https://a.b">x</a>');
  assert.equal(out.includes('<p>ok</p>'), true);
  assert.doesNotMatch(out, /<style|<form|<input/i);
  assert.match(out, /<a target="_blank" rel="noopener noreferrer" href="https:\/\/a\.b">x<\/a>/);
});

test('plainExcerpt tira a marcação e limita o tamanho', () => {
  assert.equal(plainExcerpt('**Olá** `mundo` # título'), 'Olá mundo título');
  assert.equal(plainExcerpt('a'.repeat(200), 20).length, 20);
});

// ---------------- Rótulos em português ----------------

test('phaseLabel cobre todas as fases e tem fallback', () => {
  assert.equal(phaseLabel('writing'), 'Escrevendo');
  assert.equal(phaseLabel('waiting_permission'), 'Aguardando permissão');
  assert.equal(phaseLabel('disconnected'), 'Desconectado');
  assert.equal(phaseLabel(null), 'Sem sessão');
  for (const label of Object.values(PHASE_LABELS)) assert.equal(typeof label, 'string');
});

test('phaseColor devolve cor para cada fase e para ausência de fase', () => {
  assert.equal(phaseColor('done'), 'var(--ok)');
  assert.equal(phaseColor('error'), 'var(--danger)');
  assert.equal(phaseColor(undefined), 'var(--text-faint)');
});

test('rótulos de sessão, tarefa, processo e modelo', () => {
  assert.equal(sessionStatusLabel('active'), 'Ativo');
  assert.equal(sessionStatusLabel('observed'), 'Observado');
  assert.equal(sessionStatusLabel('lost'), 'Perdido');
  assert.equal(taskStatusLabel('interrupted'), 'Interrompida');
  assert.equal(processStateLabel('requires_action'), 'Precisa de você');
  assert.equal(processStateLabel(null), 'Sem processo');
  assert.equal(modelLabel(null), 'Padrão do Claude Code');
  assert.equal(modelLabel('opus'), 'Opus');
  assert.equal(modelLabel('claude-x'), 'claude-x');
  assert.equal(LOG_KIND_LABELS.rate_limit, 'Limite de uso');
});

// ---------------- Formatação ----------------

test('formatDuration em segundos, minutos e horas', () => {
  assert.equal(formatDuration(0), '< 1 s');
  assert.equal(formatDuration(48_000), '48 s');
  assert.equal(formatDuration(72_000), '1 min 12 s');
  assert.equal(formatDuration(120_000), '2 min');
  assert.equal(formatDuration(2 * 3_600_000 + 5 * 60_000), '2 h 05 min');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(-5), '—');
});

test('formatTime ignora timestamps de exemplo', () => {
  assert.equal(formatTime(1), '—');
  assert.equal(formatTime(null), '—');
  assert.match(formatTime(Date.now()), /^\d{2}:\d{2}:\d{2}$/);
});

test('formatCost e formatBytes usam vírgula decimal', () => {
  assert.equal(formatCost(0.12), 'custo estimado US$ 0,12');
  assert.equal(formatCost(null), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2,0 MB');
});

test('aviso de limite: em português, some quando a liberação já passou e mostra a data se não for hoje', () => {
  const now = new Date(2026, 10, 1, 15, 20).getTime();
  const at = (d: number, h: number, m: number) => Math.floor(new Date(2026, 10, d, h, m).getTime() / 1000); // o CLI manda em segundos
  // o caso do print: limite de 00:40 de hoje, visto às 15:20 → já venceu, nada a avisar
  assert.equal(rateLimitNotice({ status: 'rejected', utilization: 1, resetsAt: at(1, 0, 40) }, now), null);
  const hoje = rateLimitNotice({ status: 'rejected', utilization: 1, resetsAt: at(1, 18, 5), type: 'five_hour' }, now)!;
  assert.equal(hoje.text, 'Limite de 5 h do Claude esgotado (100%) · libera às 18:05');
  assert.ok(!hoje.text.includes('rejected'));
  assert.equal(rateLimitNotice({ status: 'allowed_warning', utilization: 0.9, resetsAt: at(3, 9, 0), type: 'seven_day' }, now)!.text, 'Limite semanal do Claude perto do fim (90%) · libera em 03/11 às 09:00');
  assert.equal(rateLimitNotice({ status: 'allowed' }, now), null);
  assert.equal(rateLimitNotice(null, now), null);
});

test('textos de resultado: versão sem "(Claude Code)", subtipo técnico traduzido e plural de passos', () => {
  assert.equal(cleanClaudeVersion('2.1.316 (Claude Code)'), '2.1.316');
  assert.equal(cleanClaudeVersion(null), '—');
  assert.equal(resultSummaryLabel('Terminou com erro (success)'), 'Terminou com erro na resposta da API');
  assert.equal(resultSummaryLabel('Resposta pronta em 3 s · 1 passo'), 'Resposta pronta em 3 s · 1 passo');
  assert.equal(stepsLabel(1), '1 passo');
  assert.equal(stepsLabel(4), '4 passos');
  assert.equal(stepsLabel(null), '');
});

test('basename, normalizePath e truncate lidam com caminhos do Windows', () => {
  assert.equal(basename('C:\\Users\\usuario\\projetos\\site\\index.html'), 'index.html');
  assert.equal(basename('C:\\Users\\usuario\\projetos\\site\\'), 'site');
  assert.equal(basename('/home/x/app.ts'), 'app.ts');
  assert.equal(basename(null), '');
  assert.equal(normalizePath('C:\\Users\\Chefe\\Site\\'), 'c:/users/chefe/site');
  assert.equal(truncate('  muito   espaço  aqui ', 10), 'muito esp…');
  assert.equal(truncate('curto', 10), 'curto');
});

// ---------------- Ferramentas ----------------

test('toolIconKind classifica as ferramentas reais do Claude Code', () => {
  assert.equal(toolIconKind('Read'), 'read');
  assert.equal(toolIconKind('Edit'), 'write');
  assert.equal(toolIconKind('Bash'), 'exec');
  assert.equal(toolIconKind('Agent'), 'delegate');
  assert.equal(toolIconKind('WebFetch'), 'web');
  assert.equal(toolIconKind('AskUserQuestion'), 'question');
  assert.equal(toolIconKind('mcp__playwright__browser_click'), 'other');
});

test('permissionHighlight escolhe o trecho certo por ferramenta', () => {
  assert.equal(permissionHighlight('Bash', { command: 'pnpm install', description: 'x' }), 'pnpm install');
  assert.equal(permissionHighlight('Write', { file_path: 'C:\\a\\b.ts', content: '...' }), 'C:\\a\\b.ts');
  assert.equal(permissionHighlight('WebFetch', { url: 'https://x.y' }), 'https://x.y');
  assert.equal(permissionHighlight('Grep', { pattern: 'foo' }), 'foo');
  assert.equal(permissionHighlight('mcp__x__y', { path: '/p' }), '/p');
  assert.equal(permissionHighlight('mcp__x__y', { other: 1 }), '');
});

// ---------------- Linha do tempo ----------------

const entries: TimelineEntry[] = [
  { seq: 1, taskId: 't-0', entry: { ts: 1_700_000_000_000, kind: 'prompt', summary: 'a' } },
  { seq: 2, taskId: 't-0', entry: { ts: 1_700_000_001_000, kind: 'tool_start', summary: 'b' } },
  { seq: 3, taskId: null, entry: { ts: 1_700_000_002_000, kind: 'notice', summary: 'c' } },
  { seq: 4, taskId: 't-1', entry: { ts: 1_700_000_003_000, kind: 'prompt', summary: 'd' } },
  { seq: 5, taskId: 't-1', entry: { ts: 1_700_000_004_000, kind: 'result', summary: 'e', ok: true } },
];

test('groupTimeline agrupa entradas consecutivas por tarefa, na ordem', () => {
  const groups = groupTimeline(entries);
  assert.deepEqual(groups.map(g => g.taskId), ['t-0', null, 't-1']);
  assert.deepEqual(groups.map(g => g.entries.length), [2, 1, 2]);
  assert.deepEqual(groups[2].entries.map(e => e.seq), [4, 5]);
  assert.deepEqual(groupTimeline([]), []);
});

test('currentTurnStart acha o último pedido', () => {
  assert.equal(currentTurnStart(entries), 1_700_000_003_000);
  assert.equal(currentTurnStart(entries.slice(0, 3)), 1_700_000_000_000);
  assert.equal(currentTurnStart([entries[2]]), null);
});
