import { D, type Decimal, ZERO } from '@catpital/shared';
import { parseLosslessJson } from '../../../lib/losslessJson.js';
import type { FeedOptions, FeedQuote, LiveFeed } from './types.js';

/** 轮询型适配器基类：子类只需实现 fetchQuote() */
abstract class PollingFeed implements LiveFeed {
  abstract readonly key: string;
  private timer: NodeJS.Timeout | null = null;
  protected readonly fetchImpl: typeof fetch;

  constructor(protected readonly opts: FeedOptions, private readonly defaultIntervalMs: number) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  protected abstract fetchQuote(): Promise<FeedQuote | null>;

  async start(onQuote: (q: FeedQuote) => void, onError: (err: unknown) => void) {
    const poll = async () => {
      try {
        const q = await this.fetchQuote();
        if (q) onQuote(q);
      } catch (err) {
        onError(err);
      }
    };
    await poll();
    this.timer = setInterval(poll, this.opts.pollIntervalMs ?? this.defaultIntervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  protected async getJson<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: { 'User-Agent': 'catpital/0.1' } });
    if (!res.ok) throw new Error(`${this.key} HTTP ${res.status}`);
    return parseLosslessJson<T>(await res.text());
  }
}

/**
 * Yahoo Finance 非官方 chart 接口（无需 key，适合美股/港股/A 股代码如 AAPL、0700.HK、600519.SS）。
 * 数字字段经无损解析保留原文字符串。成交量取 regularMarketVolume 的增量。
 */
export class YahooFeed extends PollingFeed {
  readonly key = 'yahoo';
  private lastCumVolume: Decimal | null = null;

  constructor(opts: FeedOptions) {
    super(opts, 5_000);
  }

  protected async fetchQuote(): Promise<FeedQuote | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(this.opts.symbol)}?interval=1m&range=1d`;
    type Resp = {
      chart: { result: Array<{ meta: { regularMarketPrice?: string; regularMarketVolume?: string; regularMarketTime?: string } }> | null };
    };
    const body = await this.getJson<Resp>(url);
    const meta = body.chart.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    let volume = ZERO;
    if (meta.regularMarketVolume) {
      const cum = D(meta.regularMarketVolume);
      if (this.lastCumVolume && cum.gte(this.lastCumVolume)) volume = cum.minus(this.lastCumVolume);
      this.lastCumVolume = cum;
    }
    const ts = meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000) : new Date();
    return { price: D(meta.regularMarketPrice), volume, ts };
  }
}

/**
 * AlphaVantage GLOBAL_QUOTE。免费额度很低（约 25 次/天），默认 1 小时轮询一次，
 * 建议仅用于低频展示型市场或付费 key 配合更短的 pollIntervalMs。
 */
export class AlphaVantageFeed extends PollingFeed {
  readonly key = 'alphavantage';

  constructor(opts: FeedOptions) {
    super(opts, 3_600_000);
    if (!opts.apiKey) throw new Error('AlphaVantage requires apiKey');
  }

  protected async fetchQuote(): Promise<FeedQuote | null> {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(this.opts.symbol)}&apikey=${this.opts.apiKey}`;
    const body = await this.getJson<{ 'Global Quote'?: Record<string, string> }>(url);
    const q = body['Global Quote'];
    const price = q?.['05. price'];
    if (!price) return null;
    return { price: D(price), volume: ZERO, ts: new Date() };
  }
}
