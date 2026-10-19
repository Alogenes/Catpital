import { D, type Decimal, ONE, ZERO, dmax, roundToStep } from '@catpital/shared';
import type { FeedQuote, LiveFeed } from './adapters/types.js';
import type { PriceSource, Quote, SourceOverrides } from './PriceSource.js';

interface Shock {
  /** 冲击倍数 f0 = 1 + gap */
  factor: Decimal;
  startedAt: number;
  durationMs: number;
}

/**
 * 外部 API 行情源：把 LiveFeed 的推送转换为引擎可采样的 Quote。
 *
 * 真实行情无法被"改价"，因此定时事件以"冲击叠加层"实现：
 *   输出价 = 真实价 × Π f_i(t)
 *   f_i(t) = 1 + (f0 − 1) · max(0, 1 − (t − t0) / duration)    —— 跳空后线性衰减回真实价
 * driftOverride 对外部源无意义（真实趋势由市场决定），被忽略；
 * volMultiplier 也被忽略。
 */
export class LiveSource implements PriceSource {
  readonly kind = 'LIVE_API' as const;
  private latest: FeedQuote | null = null;
  private pendingVolume = ZERO;
  private emitted: Decimal;
  private dirty = false;
  private shocks: Shock[] = [];
  /** 最近一次收到推送的本地时间（毫秒）；从未收到为 null。FallbackSource 据此判断外部源是否健康 */
  lastQuoteAt: number | null = null;

  constructor(
    private readonly feed: LiveFeed,
    private readonly spec: { lastPrice: Decimal; tickSize: Decimal },
    private readonly onError: (err: unknown) => void,
  ) {
    this.emitted = spec.lastPrice;
  }

  async start() {
    await this.feed.start((q) => {
      this.latest = q;
      this.lastQuoteAt = Date.now();
      this.pendingVolume = this.pendingVolume.plus(q.volume);
      this.dirty = true;
    }, this.onError);
  }

  async stop() {
    await this.feed.stop();
  }

  current() {
    return this.emitted;
  }

  setOverrides(_: SourceOverrides) {}

  /** 最近一次外部报价（不含事件冲击层）；从未收到为 null */
  latestPrice(): Decimal | null {
    return this.latest?.price ?? null;
  }

  private shockFactor(nowMs: number) {
    this.shocks = this.shocks.filter((s) => nowMs - s.startedAt < s.durationMs);
    return this.shocks.reduce((acc, s) => {
      const remaining = dmax(ZERO, ONE.minus(D(nowMs - s.startedAt).div(D(s.durationMs))));
      return acc.mul(ONE.plus(s.factor.minus(ONE).mul(remaining)));
    }, ONE);
  }

  sample(now: Date): Quote | null {
    // 有冲击层时即使无新推送也要输出（冲击在衰减）
    if (!this.latest || (!this.dirty && this.shocks.length === 0)) return null;
    const raw = this.latest.price.mul(this.shockFactor(now.getTime()));
    const price = dmax(this.spec.tickSize, roundToStep(raw, this.spec.tickSize, 'nearest'));
    const volume = this.pendingVolume;
    this.pendingVolume = ZERO;
    this.dirty = false;
    this.emitted = price;
    return { price, volume };
  }

  applyGap(gapPercent: Decimal, now: Date, durationSec: number): Decimal {
    this.shocks.push({ factor: ONE.plus(gapPercent), startedAt: now.getTime(), durationMs: Math.max(1, durationSec) * 1000 });
    const base = this.latest?.price ?? this.emitted;
    this.emitted = dmax(this.spec.tickSize, roundToStep(base.mul(this.shockFactor(now.getTime())), this.spec.tickSize, 'nearest'));
    return this.emitted;
  }
}
