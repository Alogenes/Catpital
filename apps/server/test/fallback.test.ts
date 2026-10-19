import { D } from '@catpital/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecimalRng } from '../src/lib/random.js';
import { FallbackSource } from '../src/market/sources/FallbackSource.js';
import { LiveSource } from '../src/market/sources/LiveSource.js';
import { ProceduralSource } from '../src/market/sources/ProceduralSource.js';
import type { FeedQuote, LiveFeed } from '../src/market/sources/adapters/types.js';

/** 手动推送报价的假外部源 */
class FakeFeed implements LiveFeed {
  readonly key = 'fake';
  push: ((q: FeedQuote) => void) | null = null;
  async start(onQuote: (q: FeedQuote) => void) {
    this.push = onQuote;
  }
  async stop() {}
  quote(price: string) {
    this.push!({ price: D(price), volume: D('1'), ts: new Date() });
  }
}

const sim = (from: ReturnType<typeof D>) =>
  new ProceduralSource(
    { initialPrice: from, lastPrice: from, tickSize: D('0.01'), lotSize: D('0.0001'), tickIntervalMs: 1000 },
    {
      drift: D(0), volatility: D('0.8'), meanReversionSpeed: D(0), meanReversionTarget: null, jumpIntensity: D(0), jumpMean: D(0),
      jumpStdDev: D(0), baseVolume: D(1), volumeVolCoupling: D(1), timeScale: D(10), priceFloor: D('0.01'),
    },
    new DecimalRng('test'),
  );

const log = { info: vi.fn(), warn: vi.fn() };

function setup() {
  const feed = new FakeFeed();
  const live = new LiveSource(feed, { lastPrice: D('60000'), tickSize: D('0.01') }, () => {});
  const src = new FallbackSource(live, sim, D('0.01'), log, 'BTC', { startupTimeoutMs: 5_000, staleMs: 20_000, recoverMs: 30_000 });
  return { feed, src };
}

const t0 = new Date('2026-10-19T00:00:00Z').getTime();
const at = (ms: number) => {
  vi.setSystemTime(t0 + ms);
  return new Date(t0 + ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(t0);
  log.info.mockClear();
  log.warn.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('FallbackSource', () => {
  it('falls back to procedural prices when the feed never answers', async () => {
    const { src } = setup();
    await src.start();
    expect(src.sample(at(0))).toBeNull();
    expect(src.mode).toBe('live');
    const q = src.sample(at(5_000));
    expect(src.mode).toBe('fallback');
    expect(q).not.toBeNull();
    // 从最后一次已知价格起步，不会跳到别处
    expect(q!.price.minus('60000').abs().div('60000').lt('0.01')).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ market: 'BTC' }), expect.stringContaining('falling back'));
    // 降级期间每个 tick 都有价格
    for (let i = 1; i <= 10; i++) expect(src.sample(at(5_000 + i * 1000))).not.toBeNull();
  });

  it('falls back when a working feed goes silent, then blends back to the real price', async () => {
    const { feed, src } = setup();
    await src.start();
    feed.quote('61000');
    expect(src.sample(at(1_000))!.price.toFixed()).toBe('61000');

    // 断流 20 秒 → 降级，从 61000 起步
    const fb = src.sample(at(21_000))!;
    expect(src.mode).toBe('fallback');
    expect(fb.price.minus('61000').abs().lt('600')).toBe(true);

    // 外部源恢复（真实价 62000）：30 秒内线性过渡
    at(22_000);
    feed.quote('62000');
    const start = src.sample(at(22_000))!.price;
    at(37_000);
    feed.quote('62000');
    const mid = src.sample(at(37_000))!.price;
    expect(mid.minus('62000').abs().lt(start.minus('62000').abs().plus('1'))).toBe(true);
    at(52_000);
    feed.quote('62000');
    expect(src.sample(at(52_000))!.price.toFixed()).toBe('62000');
    expect(src.mode).toBe('live');
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ market: 'BTC' }), expect.stringContaining('recovered'));
  });

  it('applies scheduled event gaps in either mode', async () => {
    const { src } = setup();
    await src.start();
    src.sample(at(6_000));
    expect(src.mode).toBe('fallback');
    const before = src.current();
    const after = src.applyGap(D('-0.2'), at(6_500), 60);
    expect(after.div(before).toFixed(2)).toBe('0.80');
  });
});
