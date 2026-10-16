import type { Decimal } from '@catpital/shared';

export interface FeedQuote {
  price: Decimal;
  /** 自上次回调以来的成交量增量；无法获取时为 0 */
  volume: Decimal;
  ts: Date;
}

/**
 * 外部行情适配器标准接口。新增数据源只需实现本接口并在 registry 中注册，
 * 引擎、风控、K 线聚合无需任何改动。
 */
export interface LiveFeed {
  readonly key: string;
  start(onQuote: (q: FeedQuote) => void, onError: (err: unknown) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface FeedOptions {
  symbol: string;
  /** 轮询型适配器的轮询间隔 */
  pollIntervalMs?: number;
  apiKey?: string;
  /** 注入 fetch / WebSocket，便于测试 */
  fetchImpl?: typeof fetch;
}
