import { D, ONE, ZERO } from '@catpital/shared';
import { describe, expect, it } from 'vitest';
import { FALLBACK_TITLE, type ResumeStats, evaluateTitles } from '../src/bankruptcy/resumeGenerator.js';
import { KeyedQueue } from '../src/lib/keyedQueue.js';
import { parseLosslessJson } from '../src/lib/losslessJson.js';
import { DecimalRng } from '../src/lib/random.js';
import { isMarketOpen } from '../src/lib/tradingHours.js';
import { CandleAggregator } from '../src/market/candles/aggregator.js';
import { LiveSource } from '../src/market/sources/LiveSource.js';
import { ProceduralSource } from '../src/market/sources/ProceduralSource.js';
import type { FeedQuote, LiveFeed } from '../src/market/sources/adapters/types.js';
import { TriggerBook } from '../src/trading/risk/triggerBook.js';

describe('DecimalRng', () => {
  it('is deterministic per seed and stays in (0,1)', () => {
    const a = new DecimalRng('seed');
    const b = new DecimalRng('seed');
    for (let i = 0; i < 200; i++) {
      const u = a.uniform();
      expect(u.eq(b.uniform())).toBe(true);
      expect(u.gt(0) && u.lt(1)).toBe(true);
    }
  });

  it('normal samples have mean ≈ 0 and variance ≈ 1', () => {
    const rng = new DecimalRng(42);
    const n = 4000;
    let sum = ZERO;
    let sumSq = ZERO;
    for (let i = 0; i < n; i++) {
      const z = rng.normal();
      sum = sum.plus(z);
      sumSq = sumSq.plus(z.pow(2));
    }
    const mean = sum.div(n);
    const variance = sumSq.div(n).minus(mean.pow(2));
    expect(mean.abs().lt('0.06')).toBe(true);
    expect(variance.minus(1).abs().lt('0.08')).toBe(true);
  });
});

const spec = { initialPrice: D(100), lastPrice: D(100), tickSize: D('0.01'), lotSize: D('0.01'), tickIntervalMs: 1000 };
const params = {
  drift: ZERO,
  volatility: D('0.8'),
  meanReversionSpeed: ZERO,
  meanReversionTarget: null,
  jumpIntensity: ZERO,
  jumpMean: ZERO,
  jumpStdDev: ZERO,
  baseVolume: D(10),
  volumeVolCoupling: ONE,
  timeScale: D(3600),
  priceFloor: D('0.01'),
};

describe('ProceduralSource', () => {
  it('produces tick-aligned prices and lot-aligned volumes, reproducibly', () => {
    const a = new ProceduralSource(spec, params, new DecimalRng(7));
    const b = new ProceduralSource(spec, params, new DecimalRng(7));
    for (let i = 0; i < 300; i++) {
      const qa = a.sample();
      const qb = b.sample();
      expect(qa.price.eq(qb.price)).toBe(true);
      expect(qa.price.mod('0.01').isZero()).toBe(true);
      expect(qa.volume.mod('0.01').isZero()).toBe(true);
      expect(qa.price.gte('0.01')).toBe(true);
      expect(qa.volume.gt(0)).toBe(true);
    }
  });

  it('mean reversion pulls price back towards θ', () => {
    const src = new ProceduralSource(
      { ...spec, lastPrice: D(200) },
      { ...params, volatility: D('0.01'), meanReversionSpeed: D(5000) },
      new DecimalRng(1),
    );
    for (let i = 0; i < 200; i++) src.sample();
    expect(src.current().minus(100).abs().lt(5)).toBe(true);
  });

  it('never falls below the price floor even under huge negative jumps', () => {
    const src = new ProceduralSource(spec, { ...params, jumpIntensity: D('1e12'), jumpMean: D(-5), jumpStdDev: ZERO }, new DecimalRng(3));
    for (let i = 0; i < 20; i++) expect(src.sample().price.gte('0.01')).toBe(true);
  });

  it('applyGap jumps the price instantly', () => {
    const src = new ProceduralSource(spec, params, new DecimalRng(1));
    expect(src.applyGap(D('-0.3')).toFixed()).toBe('70');
    expect(src.applyGap(D('0.25')).toFixed()).toBe('87.5');
  });

  it('drift override shifts the trend', () => {
    const up = new ProceduralSource(spec, { ...params, volatility: D('0.0001') }, new DecimalRng(9));
    up.setOverrides({ driftOverride: D(50), volMultiplier: ONE });
    for (let i = 0; i < 100; i++) up.sample();
    expect(up.current().gt(100)).toBe(true);
  });
});

describe('LiveSource shock overlay', () => {
  it('applies event gap on top of the real price and decays linearly', async () => {
    let push: (q: FeedQuote) => void = () => {};
    const feed: LiveFeed = {
      key: 'fake',
      async start(onQuote) {
        push = onQuote;
      },
      async stop() {},
    };
    const src = new LiveSource(feed, { lastPrice: D(100), tickSize: D('0.01') }, () => {});
    await src.start();
    expect(src.sample(new Date(0))).toBeNull();
    push({ price: D(100), volume: D(2), ts: new Date(0) });
    expect(src.sample(new Date(0))!.price.toFixed()).toBe('100');

    expect(src.applyGap(D('-0.3'), new Date(0), 100).toFixed()).toBe('70');
    expect(src.sample(new Date(50_000))!.price.toFixed()).toBe('85'); // 一半衰减
    expect(src.sample(new Date(100_000))!.price.toFixed()).toBe('100'); // 完全恢复
    expect(src.sample(new Date(101_000))).toBeNull();
  });
});

describe('CandleAggregator', () => {
  it('aggregates OHLCV and closes candles across bucket boundaries', () => {
    const agg = new CandleAggregator(['M1', 'M5']);
    const t0 = Date.UTC(2026, 9, 16, 0, 0, 0);
    agg.update(D(10), D(1), t0);
    agg.update(D(12), D(2), t0 + 10_000);
    agg.update(D(9), D(3), t0 + 20_000);
    const { closed, updated } = agg.update(D(11), D(4), t0 + 60_000);
    expect(closed).toHaveLength(1);
    const c = closed[0]!;
    expect([c.interval, c.open.toFixed(), c.high.toFixed(), c.low.toFixed(), c.close.toFixed(), c.volume.toFixed()]).toEqual([
      'M1', '10', '12', '9', '9', '6',
    ]);
    const m5 = updated.find((u) => u.interval === 'M5')!;
    expect([m5.open.toFixed(), m5.high.toFixed(), m5.low.toFixed(), m5.close.toFixed(), m5.volume.toFixed()]).toEqual([
      '10', '12', '9', '11', '10',
    ]);
  });
});

describe('TriggerBook', () => {
  it('collects only crossed thresholds on each side', () => {
    const book = new TriggerBook();
    book.set('longLiq', 'below', D(90));
    book.set('longSl', 'below', D(95));
    book.set('shortLiq', 'above', D(110));
    book.set('longTp', 'above', D(120));
    expect(book.collect(D(100)).sort()).toEqual([]);
    expect(book.collect(D(94)).sort()).toEqual(['longSl']);
    expect(book.collect(D(89)).sort()).toEqual(['longLiq', 'longSl']);
    expect(book.collect(D(130)).sort()).toEqual(['longTp', 'shortLiq']);
    book.set('longSl', 'below', D(80)); // 修改阈值
    expect(book.collect(D(89)).sort()).toEqual(['longLiq']);
    book.delete('longLiq');
    expect(book.collect(D(1)).sort()).toEqual(['longSl']);
  });
});

describe('isMarketOpen', () => {
  const hours = {
    timezone: 'Asia/Shanghai',
    sessions: [
      { days: [1, 2, 3, 4, 5], open: '09:30', close: '11:30' },
      { days: [5], open: '22:00', close: '02:00' },
    ],
  };
  it('respects timezone, weekdays and overnight sessions', () => {
    expect(isMarketOpen(hours, new Date('2026-10-16T01:30:00Z'))).toBe(true); // 周五 09:30 CST
    expect(isMarketOpen(hours, new Date('2026-10-16T03:30:00Z'))).toBe(false); // 周五 11:30 CST 收盘
    expect(isMarketOpen(hours, new Date('2026-10-17T01:30:00Z'))).toBe(false); // 周六
    expect(isMarketOpen(hours, new Date('2026-10-16T17:00:00Z'))).toBe(true); // 周六 01:00 CST（周五夜盘）
    expect(isMarketOpen({ timezone: 'UTC', sessions: [] }, new Date())).toBe(true);
  });
});

describe('parseLosslessJson', () => {
  it('keeps numeric literals as exact strings', () => {
    const v = parseLosslessJson<{ a: string; b: { c: string[] } }>('{"a": 0.1000000000000000055511, "b": {"c": [12345678901234567890, 1e-7]}}');
    expect(v.a).toBe('0.1000000000000000055511');
    expect(v.b.c).toEqual(['12345678901234567890', '1e-7']);
  });
});

describe('KeyedQueue', () => {
  it('serialises per key and survives failures', async () => {
    const q = new KeyedQueue();
    const order: string[] = [];
    const slow = q.run('a', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('a1');
    });
    const failing = q.run('a', async () => {
      order.push('a2');
      throw new Error('boom');
    });
    const after = q.run('a', async () => order.push('a3'));
    const other = q.run('b', async () => order.push('b1'));
    await Promise.allSettled([slow, failing, after, other]);
    expect(order).toEqual(['b1', 'a1', 'a2', 'a3']);
  });
});

describe('evaluateTitles', () => {
  const base: ResumeStats = {
    generation: 1,
    survivedSeconds: 86_400,
    startingBalance: D(10000),
    finalBalance: D(-1),
    peakNetWorth: D(10000),
    troughNetWorth: D(-1),
    closedTradeCount: 5,
    winCount: 2,
    winRate: D('0.4'),
    liquidationCount: 1,
    deficitCount: 0,
    totalDeficit: ZERO,
    eventLiquidationCount: 0,
    totalFeesPaid: D(10),
    totalVolume: D(1000),
    totalRealizedPnl: D(-10000),
    bestTradeRoe: D('0.1'),
    bestTradePnl: D(10),
    worstLiquidationLoss: D(5000),
    avgLeverage: D(10),
    maxLeverageUsed: D(10),
    longShare: D('0.5'),
    avgHoldingSeconds: 600,
    danmakuCount: 0,
  };
  it('falls back to 韭菜', () => {
    expect(evaluateTitles(base)).toEqual([FALLBACK_TITLE]);
  });
  it('picks the top three by priority', () => {
    expect(
      evaluateTitles({ ...base, survivedSeconds: 30, avgLeverage: D(88), eventLiquidationCount: 2, deficitCount: 3, longShare: D(1) }),
    ).toEqual(['title.speedrun', 'title.deficitKing', 'title.eventVictim']);
  });
});
