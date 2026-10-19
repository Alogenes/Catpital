import { type Decimal, type ImpactQuote, type OrderSide, ZERO, impactQuote } from '@catpital/shared';
import type { PrismaClient } from '@prisma/client';
import type { Notifier } from '../broadcast/notifier.js';
import { toDb, wire } from '../lib/dec.js';
import type { KeyedQueue } from '../lib/keyedQueue.js';
import { isMarketOpen } from '../lib/tradingHours.js';
import type { PriceContext, RiskEngine } from '../trading/risk/riskEngine.js';
import type { MarketSnapshot } from '../trading/types.js';
import { type CandleAggregator, type CandleState } from './candles/aggregator.js';
import type { PriceSource, SourceOverrides } from './sources/PriceSource.js';

const CANDLE_FLUSH_MS = 10_000;
const LAST_PRICE_FLUSH_MS = 5_000;

export interface ImpactConfig {
  liquidity: Decimal;
  cap: Decimal;
  exponent: Decimal;
  volBoost: Decimal;
  decaySec: number;
}

type Logger = { error: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };

/**
 * 单个市场的行情 Actor。
 * 每个 tick 在该市场的串行队列中依次执行：采样 → K 线聚合 → 推送 → 风控（强平/TP/SL/限价单）。
 * 上一个 tick 尚未处理完时跳过本次（不会无限堆积）。
 */
export class MarketEngine {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private dirtyCandles = new Map<string, CandleState>();
  private lastCandleFlush = 0;
  private lastPriceFlush = 0;

  constructor(
    public market: MarketSnapshot,
    private readonly tickIntervalMs: number,
    private readonly source: PriceSource,
    private readonly aggregator: CandleAggregator,
    private readonly deps: {
      db: PrismaClient;
      queue: KeyedQueue;
      notifier: Notifier;
      risk: RiskEngine;
      log: Logger;
      clock?: () => Date;
    },
    /** 大单冲击参数；未配置或 cap = 0 时不产生冲击（外部行情市场永远不冲击） */
    private readonly impact?: ImpactConfig,
  ) {}

  /** 冲击报价（不改变任何状态）：返回 null 表示该市场不受玩家大单影响 */
  impactQuote(notional: Decimal, side: OrderSide): ImpactQuote | null {
    const cfg = this.impact;
    if (!cfg || this.source.kind !== 'PROCEDURAL' || cfg.cap.lte(0) || cfg.liquidity.lte(0)) return null;
    const q = impactQuote(this.source.current(), notional, side, cfg, this.market.tickSize);
    return q.pct.isZero() ? null : q;
  }

  /**
   * 落实冲击：价格跳到冲击后价格（随后 decaySec 秒内线性回落到趋势线）、短暂放大波动率，并立刻按新价格跑一遍 K 线与风控
   * （大户砸盘可以把别人的多单打爆）。必须在本市场串行队列内调用（成交之后）。
   */
  async commitImpact(q: ImpactQuote, volume: Decimal): Promise<Decimal> {
    const now = this.now();
    const decayMs = (this.impact?.decaySec ?? 25) * 1000;
    const after = this.source.applyImpact ? this.source.applyImpact(q.pct, decayMs, now) : this.source.applyGap(q.pct, now, 0);
    if (this.impact && this.impact.volBoost.gt(1)) this.source.boostVolatility?.(this.impact.volBoost, this.impact.decaySec * 1000, now);
    await this.processPrice(after, volume, now, {});
    return after;
  }

  private now() {
    return this.deps.clock?.() ?? new Date();
  }

  price(): Decimal {
    return this.source.current();
  }

  feedMode(): 'live' | 'fallback' | null {
    return this.source.kind === 'LIVE_API' ? ((this.source as { mode?: 'live' | 'fallback' }).mode ?? 'live') : null;
  }

  candles() {
    return this.aggregator.snapshot();
  }

  async start() {
    await this.source.start();
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.deps.queue
        .run(this.market.id, () => this.tick(this.now()))
        .catch((err) => this.deps.log.error({ err, market: this.market.code }, 'tick failed'))
        .finally(() => {
          this.busy = false;
        });
    }, this.tickIntervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.deps.queue.drain(this.market.id);
    await this.source.stop();
    await this.flush(true);
  }

  /** 推进一步行情（测试中可直接调用；生产由定时器在队列中调用） */
  async tick(now: Date) {
    if (this.market.status === 'DELISTED') return;
    if (!isMarketOpen(this.market.tradingHours, now)) return;
    const q = this.source.sample(now);
    if (!q) return;
    await this.processPrice(q.price, q.volume, now, {});
  }

  private async processPrice(price: Decimal, volume: Decimal, now: Date, ctx: PriceContext & { gap?: boolean }) {
    const ts = now.getTime();
    const { updated, closed } = this.aggregator.update(price, volume, ts);
    this.deps.notifier.tick({ market: this.market.code, price: wire(price), volume: wire(volume), ts, gap: ctx.gap });
    for (const c of closed) this.deps.notifier.candle(this.toPayload(c, true));
    for (const c of updated) {
      this.deps.notifier.candle(this.toPayload(c, false));
      this.dirtyCandles.set(`${c.interval}:${c.openTime}`, c);
    }
    if (closed.length) await this.persistCandles(closed);

    await this.deps.risk.onPrice(this.market.id, price, now, ctx);
    await this.flush(false);
  }

  /**
   * 定时金融事件：瞬间跳空并立即以跳空价跑一遍风控（触发的强平会标记 scheduledEventId）。
   * 必须在本市场队列中执行。返回 [跳空前价格, 跳空后价格]。
   */
  async applyGap(gapPercent: Decimal, durationSec: number, scheduledEventId: string): Promise<[Decimal, Decimal]> {
    return this.deps.queue.run(this.market.id, async () => {
      const now = this.now();
      const before = this.source.current();
      const after = this.source.applyGap(gapPercent, now, durationSec);
      await this.processPrice(after, ZERO, now, { scheduledEventId, gap: true });
      return [before, after];
    });
  }

  setOverrides(o: SourceOverrides) {
    this.source.setOverrides(o);
  }

  private toPayload(c: CandleState, closed: boolean) {
    return {
      market: this.market.code,
      interval: c.interval,
      openTime: c.openTime,
      open: wire(c.open),
      high: wire(c.high),
      low: wire(c.low),
      close: wire(c.close),
      volume: wire(c.volume),
      closed,
    };
  }

  private async persistCandles(candles: CandleState[]) {
    const { db } = this.deps;
    await db.$transaction(
      candles.map((c) => {
        const data = {
          open: toDb(c.open),
          high: toDb(c.high),
          low: toDb(c.low),
          close: toDb(c.close),
          volume: toDb(c.volume),
          tradeCount: c.tradeCount,
        };
        return db.candle.upsert({
          where: { marketId_interval_openTime: { marketId: this.market.id, interval: c.interval, openTime: new Date(c.openTime) } },
          create: { marketId: this.market.id, interval: c.interval, openTime: new Date(c.openTime), ...data },
          update: data,
        });
      }),
    );
    for (const c of candles) this.dirtyCandles.delete(`${c.interval}:${c.openTime}`);
  }

  private async flush(force: boolean) {
    const nowMs = Date.now();
    try {
      if (force || nowMs - this.lastCandleFlush >= CANDLE_FLUSH_MS) {
        this.lastCandleFlush = nowMs;
        if (this.dirtyCandles.size) await this.persistCandles([...this.dirtyCandles.values()]);
      }
      if (force || nowMs - this.lastPriceFlush >= LAST_PRICE_FLUSH_MS) {
        this.lastPriceFlush = nowMs;
        await this.deps.db.market.update({
          where: { id: this.market.id },
          data: { lastPrice: toDb(this.source.current()), lastTickAt: this.now() },
        });
      }
    } catch (err) {
      this.deps.log.warn({ err, market: this.market.code }, 'flush failed');
    }
  }
}
