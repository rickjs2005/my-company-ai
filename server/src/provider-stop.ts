// Paradas do provedor que não são culpa da tarefa: limite de uso da assinatura e falta de conexão com a API.
// Formatos observados no Claude Code 2.1.316 (banco real da HQ, 31/10 e 01/11/2026):
// - limite: evento `rate_limit_event` com status "rejected" e resetsAt (segundos), mensagem do assistente com `error: "rate_limit"`
//   e texto "You've hit your 5-hour limit · resets 12:40am (America/Sao_Paulo)", depois `result` com is_error e terminal_reason "api_error";
// - rede: mensagem do assistente com `error: "server_error"` e texto "API Error: Can't reach the API server — check your internet
//   or DNS (ENOTFOUND)", depois o mesmo `result` de erro.
// Nesses casos a fila do provedor é suspensa (até o horário informado ou com espera crescente) em vez de queimar tarefas.
import { tzOffsetMs } from './time.js';

export type ProviderStop =
  | { kind: 'usage_limit'; until: number; label: string; text: string }
  | { kind: 'network'; text: string };

export interface ProviderStopInput {
  isError: boolean;
  terminalReason?: string | null;
  resultText: string;
  errors: string[];
  /** Campo `error` da última mensagem do assistente neste turno (ex.: 'rate_limit', 'server_error'). */
  apiError?: string | null;
  /** Último rate_limit_event do processo. */
  rateLimit?: { status?: string; resetsAt?: number; type?: string } | null;
  now: number;
}

const USAGE_RE = /hit your .{0,40}limit|usage limit|limite de uso/i;
const NETWORK_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Can't reach the API|Unable to connect to API|fetch failed|socket hang up|Overloaded|\b529\b/i;
/** Espera entre tentativas quando a API não responde (min): cresce a cada falha seguida e para em 15 min. */
export const NETWORK_BACKOFF_MIN = [1, 2, 5, 10, 15];
/** Sem horário informado pelo provedor, tenta de novo depois deste tempo (min); a tentativa que ainda bater no limite custa um turno vazio. */
const USAGE_FALLBACK_MIN = 30;

export function classifyProviderStop(i: ProviderStopInput): ProviderStop | null {
  if (!i.isError) return null;
  if (i.terminalReason === 'aborted_streaming' || i.terminalReason === 'aborted_tools') return null;
  const text = [i.resultText, ...i.errors].filter(Boolean).join(' · ').trim();
  const rl = i.rateLimit && i.rateLimit.status === 'rejected' && typeof i.rateLimit.resetsAt === 'number' && i.rateLimit.resetsAt * 1000 > i.now ? i.rateLimit : null;
  if (i.apiError === 'rate_limit' || rl || USAGE_RE.test(text)) {
    const until = rl ? rl.resetsAt! * 1000 : parseResetTime(text, i.now) ?? i.now + USAGE_FALLBACK_MIN * 60_000;
    const type = rl?.type ?? (/5-hour/i.test(text) ? 'five_hour' : /weekly|7-day|seven/i.test(text) ? 'seven_day' : null);
    const label = type === 'five_hour' ? 'limite de uso de 5 h' : type === 'seven_day' || type === 'seven_day_opus' ? 'limite de uso semanal' : 'limite de uso';
    return { kind: 'usage_limit', until, label, text: text || label };
  }
  if (NETWORK_RE.test(text)) return { kind: 'network', text };
  return null;
}

/** "resets 12:40am (America/Sao_Paulo)" → próximo instante com esse horário naquele fuso (null se não der para ler). */
export function parseResetTime(text: string, now: number): number | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? 0); const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const tz = m[4] ?? 'America/Sao_Paulo';
  let offsetMs: number;
  try { offsetMs = tzOffsetMs(tz, now); } catch { return null; }
  // Data "de parede" no fuso, agora; candidato hoje às h:min nesse fuso; se já passou, amanhã.
  const wall = new Date(now + offsetMs);
  let candidate = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), h, min) - offsetMs;
  if (candidate <= now) candidate += 24 * 3600_000;
  return candidate;
}

export { formatBrt } from './time.js';
