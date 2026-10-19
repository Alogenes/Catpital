import { D } from '@catpital/shared';
import { parseLosslessJson } from '../../../lib/losslessJson.js';
import type { FeedOptions, FeedQuote, LiveFeed } from './types.js';

/**
 * Binance 现货逐笔成交推送（aggTrade）。价格与数量在 Binance 消息中本身就是字符串。
 * 断线后指数退避重连（1s → 30s）。
 */
export class BinanceFeed implements LiveFeed {
  readonly key = 'binance';
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 1000;
  private timer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: FeedOptions) {}

  async start(onQuote: (q: FeedQuote) => void, onError: (err: unknown) => void) {
    this.stopped = false;
    this.connect(onQuote, onError);
  }

  private connect(onQuote: (q: FeedQuote) => void, onError: (err: unknown) => void) {
    const url = `wss://stream.binance.com:9443/ws/${this.opts.symbol.toLowerCase()}@aggTrade`;
    const ws = new WebSocket(url);
    this.ws = ws;
    // 5 秒内握手不成功（被墙 / 地区限制 / 网络卡住）就主动断开，走下面的退避重连
    this.connectTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        onError(new Error('binance connect timeout'));
        ws.close();
      }
    }, 5_000);
    ws.onopen = () => {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.retryMs = 1000;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = parseLosslessJson<{ p: string; q: string; T: string }>(String(ev.data));
        onQuote({ price: D(msg.p), volume: D(msg.q), ts: new Date(Number(msg.T)) });
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
