import { BinanceFeed } from './binance.js';
import { AlphaVantageFeed, YahooFeed } from './polling.js';
import type { FeedOptions, LiveFeed } from './types.js';

type FeedFactory = (opts: FeedOptions) => LiveFeed;

const factories = new Map<string, FeedFactory>([
  ['binance', (o) => new BinanceFeed(o)],
  ['yahoo', (o) => new YahooFeed(o)],
  ['alphavantage', (o) => new AlphaVantageFeed({ ...o, apiKey: o.apiKey ?? process.env.ALPHAVANTAGE_API_KEY })],
]);

/** 扩展点：注册自定义适配器（如券商私有 API） */
export function registerFeed(key: string, factory: FeedFactory) {
  factories.set(key, factory);
}

export function createFeed(key: string, opts: FeedOptions): LiveFeed {
  const factory = factories.get(key);
  if (!factory) throw new Error(`Unknown live feed adapter: ${key}`);
  return factory(opts);
}
