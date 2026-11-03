import { D, ZERO } from '@catpital/shared';
import WebSocket from 'ws';
import { parseLosslessJson } from '../../../lib/losslessJson.js';
import type { FeedOptions, FeedQuote, LiveFeed } from './types.js';

type FinnhubMsg =
  | { type: 'trade'; data: Array<{ p: string; v?: string; t: string; s: string }> }
  | { type: 'ping' }
  | { type: 'error'; msg?: string };

/**
 * Finnhub WebSocket 实时报价（免费 key 即可，外汇用 OANDA:EUR_USD 这类代码，约每秒一笔）。
 * 外汇的 v 恒为 0。数字经无损解析保留原文字符串。断线后指数退避重连（1s → 30s）。
 */
export class FinnhubFeed implements LiveFeed {
  readonly key = 'finnhub';
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 1000;
  private timer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: FeedOptions) {
    if (!opts.apiKey) throw new Error('Finnhub requires apiKey (FINNHUB_API_KEY)');
  }

  async start(onQuote: (q: FeedQuote) => void, onError: (err: unknown) => void) {
    this.stopped = false;
    this.connect(onQuote, onError);
  }

  private connect(onQuote: (q: FeedQuote) => void, onError: (err: unknown) => void) {
    const ws = new WebSocket(`wss://ws.finnhub.io?token=${encodeURIComponent(this.opts.apiKey!)}`);
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        onError(new Error('finnhub connect timeout'));
        ws.close();
      }
    }, 5_000);
    ws.onopen = () => {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.retryMs = 1000;
      ws.send(JSON.stringify({ type: 'subscribe', symbol: this.opts.symbol }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = parseLosslessJson<FinnhubMsg>(String(ev.data));
        if (msg.type === 'error') return onError(new Error(`finnhub: ${msg.msg ?? 'unknown error'}`));
        if (msg.type !== 'trade') return;
        // 一条消息可能打包多笔：价格取最新一笔，成交量累加
        const trades = msg.data.filter((d) => d.s === this.opts.symbol);
        const last = trades.at(-1);
        if (!last) return;
        const volume = trades.reduce((acc, d) => (d.v ? acc.plus(D(d.v)) : acc), ZERO);
        onQuote({ price: D(last.p), volume, ts: new Date(Number(last.t)) });
      } catch (err) {
        onError(err);
      }
    };
    ws.onerror = (ev) => onError(ev);
    ws.onclose = () => {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(onQuote, onError), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
    };
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
