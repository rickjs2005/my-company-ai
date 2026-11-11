// Horário de parede num fuso (a HQ usa America/Sao_Paulo para rotinas, avisos de limite e resumos). Só Intl, sem dependências.

export const HQ_TZ = 'America/Sao_Paulo';

/** Diferença (ms) entre o horário de parede no fuso e o UTC no instante `at` (Brasília hoje: -3 h). */
export function tzOffsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Instante (ms) do horário h:min no dia de parede de `ref` + `dayOffset` dias, no fuso (confere o deslocamento no próprio alvo). */
export function wallTimeToUtc(timeZone: string, ref: number, dayOffset: number, h: number, min: number): number {
  const off = tzOffsetMs(timeZone, ref);
  const wall = new Date(ref + off);
  const naive = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + dayOffset, h, min);
  const guess = naive - off;
  return naive - tzOffsetMs(timeZone, guess);
}

/** Dia da semana de parede (0 = domingo) no fuso. */
export function wallDay(timeZone: string, at: number): number {
  return new Date(at + tzOffsetMs(timeZone, at)).getUTCDay();
}

/** Horário curto em Brasília ("00:40", ou "01/11 00:40" quando não é o dia de `now`). */
export function formatBrt(ts: number, now: number): string {
  const day = (t: number) => new Intl.DateTimeFormat('pt-BR', { timeZone: HQ_TZ, day: '2-digit', month: '2-digit' }).format(new Date(t));
  const hm = new Intl.DateTimeFormat('pt-BR', { timeZone: HQ_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
  return day(ts) === day(now) ? hm : `${day(ts)} ${hm}`;
}
