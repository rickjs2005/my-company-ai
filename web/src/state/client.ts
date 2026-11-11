// Cliente WebSocket do frontend: token na primeira mensagem (hello), reconexão com recuo, pedidos com resposta (reqId).
// Nunca grava o token em log; ele vive só na sessionStorage desta aba (vem do #token= na URL de abertura).
import type { ClientMessage, ServerMessage } from '@milweb-hq/protocol';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'unauthorized';

type ReqMessage = Extract<ClientMessage, { reqId: string }>;
type ReqInput = ReqMessage extends infer M ? (M extends { reqId: string } ? Omit<M, 'reqId'> : never) : never;

interface PendingReq { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }

const TOKEN_KEY = 'milweb-hq.token';

/** Erro de um pedido com resposta: `code` e `data` vêm do servidor quando o erro é estruturado (ex.: 'in_use'). */
export class RequestError extends Error {
  constructor(message: string, readonly code?: string, readonly data?: unknown) { super(message); this.name = 'RequestError'; }
}

export function readToken(): string | null {
  const m = /[#&]token=([a-f0-9]+)/i.exec(window.location.hash);
  if (m) {
    try { sessionStorage.setItem(TOKEN_KEY, m[1]); } catch { /* sem storage */ }
    // Tira o token da barra de endereço (não fica no histórico nem em prints).
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignorar */ }
    return m[1];
  }
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export class HqClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingReq>();
  private seq = 0;
  private retry = 0;
  private closedByUser = false;
  private reconnectTimer: number | null = null;
  state: ConnectionState = 'closed';
  onMessage: (m: ServerMessage) => void = () => {};
  onState: (s: ConnectionState) => void = () => {};

  constructor(private token: string, private url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`) {}

  connect(): void {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', token: this.token } satisfies ClientMessage)); };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
      if (msg.kind === 'snapshot' && this.state !== 'open') { this.retry = 0; this.setState('open'); }
      if (msg.kind === 'error' && msg.message === 'token inválido') { this.setState('unauthorized'); this.closedByUser = true; }
      if (msg.kind === 'reply') {
        const p = this.pending.get(msg.reqId);
        if (p) {
          this.pending.delete(msg.reqId); clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.data);
          else { const e = new RequestError(msg.error, msg.code, msg.data); p.reject(e); }
        }
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('conexão perdida')); }
      this.pending.clear();
      if (this.state !== 'unauthorized') this.setState('closed');
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose cuida da reconexão */ };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.retry, 5));
    this.retry++;
    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer != null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
  }

  private setState(s: ConnectionState) { if (s !== this.state) { this.state = s; this.onState(s); } }

  /** Mensagem sem resposta (fire-and-forget). Lança se não houver conexão. */
  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('sem conexão com o serviço do My Company AI');
    this.ws.send(JSON.stringify(msg));
  }

  /** Pedido com resposta (reply com reqId). */
  request<T = unknown>(msg: ReqInput, timeoutMs = 60_000): Promise<T> {
    const reqId = `${Date.now().toString(36)}-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(reqId); reject(new Error('o serviço não respondeu a tempo')); }, timeoutMs);
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
      try { this.send({ ...msg, reqId } as ClientMessage); } catch (err) { clearTimeout(timer); this.pending.delete(reqId); reject(err as Error); }
    });
  }
}
