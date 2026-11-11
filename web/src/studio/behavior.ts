// O que cada funcionário deve estar fazendo na cena, a partir do estado REAL que vem do servidor.
// Função pura: nada aqui inventa trabalho. Sem execução real, o personagem fica disponível ou em pausa, sem digitar.
import type { SceneWorker } from '../scene/types';
import { bubbleFor } from '../scene/iso/socialRoom';
import type { Activity } from './character';
import type { ScreenMode } from './props';

export type PlaceKey = `desk:${number}` | 'boss' | `meeting:${number}` | `visit:${number}`;

export interface Desired {
  place: PlaceKey;
  /** Atividade quando já está no lugar (na mesa: digitar, pensar ou sentar; no Chefe: apresentar). */
  activity: Activity;
  mood: 'neutral' | 'happy' | 'focus' | 'worried';
  bubble: { text: string; tone: 'work' | 'wait' | 'queue' | 'error' } | null;
  screen: ScreenMode;
  /** Motivo curto para a ida até o chefe (aparece no balão de atendimento). */
  bossReason: string | null;
}

const TYPING = new Set(['responding', 'writing', 'executing']);
const THINKING = new Set(['thinking', 'reading', 'delegating']);

export function desiredFor(w: SceneWorker, deskIndex: number, meeting: { seat: number; speaking: boolean } | null): Desired {
  const bubble = bubbleFor(w);
  const first = w.name.split(' ')[0];
  const base: Desired = { place: `desk:${deskIndex}`, activity: 'sit', mood: 'neutral', bubble, screen: { kind: 'idle', name: first }, bossReason: null };
  if (w.observed) return { ...base, bubble: null, screen: { kind: 'idle', name: first } };
  if (meeting) {
    return { ...base, place: `meeting:${meeting.seat}`, activity: meeting.speaking ? 'sitTalk' : 'sitListen', mood: 'neutral', bubble: meeting.speaking ? { text: 'falando na reunião', tone: 'work' } : null, screen: { kind: 'idle', name: first } };
  }
  const waiting = w.status === 'waiting_answer' || w.phase === 'waiting_answer';
  const permission = w.status === 'waiting_permission' || w.phase === 'waiting_permission';
  if (waiting || permission) {
    const reason = permission ? 'precisa da sua permissão' : 'tem uma pergunta para você';
    return { ...base, place: 'boss', activity: 'present', mood: permission ? 'worried' : 'neutral', bubble: { text: reason, tone: 'wait' }, screen: { kind: 'work', name: first, text: reason, tone: 'wait' }, bossReason: reason };
  }
  if (w.status === 'error' || w.phase === 'error') {
    return { ...base, activity: 'think', mood: 'worried', screen: { kind: 'work', name: first, text: (w.detail || 'parou com erro').slice(0, 90), tone: 'error' } };
  }
  if (w.status === 'paused') {
    return { ...base, activity: 'sit', bubble: { text: 'em pausa (limite)', tone: 'queue' }, screen: { kind: 'work', name: first, text: 'em pausa: limite do provedor', tone: 'queue' } };
  }
  if (w.status === 'queued') {
    return { ...base, activity: 'sit', screen: { kind: 'work', name: first, text: 'na fila', tone: 'queue' } };
  }
  const phase = String(w.phase);
  const detail = (w.detail || '').trim();
  if (TYPING.has(phase)) return { ...base, activity: 'type', mood: 'focus', screen: phase === 'executing' ? { kind: 'code', name: first, text: detail || 'rodando comando' } : { kind: 'work', name: first, text: detail || 'escrevendo', tone: 'work' } };
  if (THINKING.has(phase)) return { ...base, activity: 'think', mood: 'focus', screen: { kind: 'work', name: first, text: detail || 'pensando', tone: 'work' } };
  if (w.status === 'running') return { ...base, activity: 'type', mood: 'focus', screen: { kind: 'work', name: first, text: detail || 'trabalhando', tone: 'work' } };
  return base;
}

/** Ordem da fila do chefe: quem pediu primeiro fica no ponto de atendimento; os outros esperam nos lugares de fila. */
export function bossQueue(order: string[], wanting: Set<string>): string[] {
  const kept = order.filter(id => wanting.has(id));
  for (const id of wanting) if (!kept.includes(id)) kept.push(id);
  return kept;
}
