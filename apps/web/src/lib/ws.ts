import type { ClientMessage, ServerMessage } from '@catpital/shared';
import { wsUrl } from './endpoints';

type Listener = (msg: ServerMessage) => void;
export type WsStatus = 'connecting' | 'open' | 'closed';

/**
 * 自动重连的 WS 客户端（经 /.proxy/ws）。
 * 重连后自动重新鉴权并恢复全部订阅；20s 心跳。
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private subs = new Set<string>();
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: WsStatus) => void>();
  private token: string | null = null;
  private retry = 500;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;

  connect(token: string) {
    this.token = token;
    this.closedByUser = false;
    this.open();
  }

  private setStatus(s: WsStatus) {
    for (const l of this.statusListeners) l(s);
  }

  private open() {
    this.setStatus('connecting');
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      this.setStatus('open');
      if (this.token) this.send({ op: 'auth', token: this.token });
      if (this.subs.size) this.send({ op: 'sub', ch: [...this.subs] });
      this.heartbeat = setInterval(() => this.send({ op: 'ping', ts: Date.now() }), 20_000);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.setStatus('closed');
      if (this.closedByUser) return;
      setTimeout(() => this.open(), this.retry);
      this.retry = Math.min(this.retry * 2, 15_000);
    };
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  subscribe(channels: string[]) {
    const fresh = channels.filter((c) => !this.subs.has(c));
    fresh.forEach((c) => this.subs.add(c));
    if (fresh.length) this.send({ op: 'sub', ch: fresh });
  }

  unsubscribe(channels: string[]) {
    channels.forEach((c) => this.subs.delete(c));
    this.send({ op: 'unsub', ch: channels });
  }

  danmaku(market: string, text: string) {
    this.send({ op: 'danmaku', market, text });
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  onStatus(l: (s: WsStatus) => void) {
    this.statusListeners.add(l);
    return () => void this.statusListeners.delete(l);
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}

export const realtime = new RealtimeClient();
