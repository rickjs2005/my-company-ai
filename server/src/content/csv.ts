// CSV simples de resultados (cabeçalho em português ou inglês). Valor vazio = "não coletado" (nunca zero, nunca estimado).
import type { ContentResult, SocialSlotId } from '@milweb-hq/protocol';
import { isSocialSlot } from '@milweb-hq/protocol';

/** RFC 4180 básico: vírgula ou ponto e vírgula, aspas duplas, quebras de linha dentro de aspas. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  date: ['data_publicacao', 'data', 'published', 'date', 'publicacao'],
  slot: ['conta', 'destino', 'account', 'slot'],
  url: ['url', 'link', 'post_url'],
  metric: ['metrica', 'métrica', 'metric'],
  value: ['valor', 'value'],
  unit: ['unidade', 'unit'],
  start: ['periodo_inicio', 'período_início', 'inicio', 'period_start', 'start'],
  end: ['periodo_fim', 'período_fim', 'fim', 'period_end', 'end'],
  age: ['idade_horas', 'age_hours', 'idade'],
  denominator: ['denominador', 'denominator'],
  hypothesis: ['hipotese', 'hipótese', 'hypothesis'],
  note: ['observacao', 'observação', 'nota', 'note'],
};

const key = (h: string) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_');

/** Número em formato brasileiro ou internacional ("1.234,5", "1,234.5", "12%"). Vazio ou ilegível = null. */
export function parseNumber(v: string): number | null {
  let t = v.trim().replace(/%$/, '').replace(/\s/g, '');
  if (!t || /^(-|n\/?a|nd|não coletado|nao coletado)$/i.test(t)) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type CsvResult = Omit<ContentResult, 'id' | 'collectedAt'>;

export function csvToResults(text: string, evidencePath: string | null): { rows: CsvResult[]; skipped: string[] } {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], skipped: ['o arquivo não tem linhas de dados (só cabeçalho ou vazio)'] };
  const header = table[0].map(key);
  const col = (name: keyof typeof ALIASES) => { const al = ALIASES[name].map(key); return header.findIndex(h => al.includes(h)); };
  const idx = Object.fromEntries(Object.keys(ALIASES).map(k => [k, col(k as keyof typeof ALIASES)])) as Record<keyof typeof ALIASES, number>;
  if (idx.metric < 0) return { rows: [], skipped: ['falta a coluna "metrica" (nome exato da métrica como a rede chama)'] };
  const rows: CsvResult[] = []; const skipped: string[] = [];
  table.slice(1).forEach((r, i) => {
    const get = (k: keyof typeof ALIASES) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
    const metric = get('metric');
    if (!metric) { skipped.push(`linha ${i + 2}: sem métrica`); return; }
    const slotRaw = get('slot');
    const slot: SocialSlotId | null = isSocialSlot(slotRaw) ? slotRaw : null;
    if (slotRaw && !slot) { skipped.push(`linha ${i + 2}: conta "${slotRaw}" desconhecida (use instagram-aurora, instagram-tuco, threads, tiktok, linkedin, x ou pinterest)`); return; }
    const url = get('url');
    rows.push({
      itemId: null, slot, postUrl: /^https?:\/\//i.test(url) ? url : null, metric: metric.slice(0, 120), value: parseNumber(get('value')), unit: get('unit') || null,
      periodStart: get('start') || get('date') || null, periodEnd: get('end') || null, ageHours: parseNumber(get('age')), denominator: get('denominator') || null,
      source: 'csv', evidencePath, uncertain: false, hypothesis: get('hypothesis') || null, note: get('note') || null,
    });
  });
  return { rows, skipped };
}
