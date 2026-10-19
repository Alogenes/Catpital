import { D, type Decimal, ONE, dmax, dmin, roundToStep } from '@catpital/shared';
import type { LiveSource } from './LiveSource.js';
import type { PriceSource, Quote, SourceOverrides } from './PriceSource.js';
import type { ProceduralSource } from './ProceduralSource.js';

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

export type FeedMode = 'live' | 'fallback';

export interface FallbackOptions {
  /** 启动后这么久还没收到第一笔外部报价 → 降级 */
  startupTimeoutMs?: number;
  /** 外部报价断流超过这么久 → 降级 */
  staleMs?: number;
  /** 外部源恢复后，用这么长时间把模拟价平滑过渡回真实价 */
  recoverMs?: number;
}

/**
 * 外部行情 + 自动降级（熔断）：
 *   live      正常转发 LiveSource 的真实报价
 *   fallback  外部源超时 / 断流 / 限流时，从当前价起步改用程序随机行情（GBM + 跳跃），图表与交易照常
 *   恢复      外部源重新有报价后，在 recoverMs 内把输出价从模拟价线性过渡到真实价，再切回 live（不会瞬间跳空）
 * 整个过程中 sample() 永远有输出，前端不会因为外部 API 卡住而一直转圈。
 */
export class FallbackSource implements PriceSource {
  readonly kind = 'LIVE_API' as const;
  mode: FeedMode = 'live';
  private sim: ProceduralSource | null = null;
  private emitted: Decimal;
  private startedAt: number | null = null;
  private recoveringSince: number | null = null;
  private overrides: SourceOverrides | null = null;
  private readonly startupTimeoutMs: number;
  private readonly staleMs: number;
  private readonly recoverMs: number;

  constructor(
    private readonly live: LiveSource,
    /** 以给定价格为起点创建程序随机源 */
    private readonly makeSim: (from: Decimal) => ProceduralSource,
    private readonly tickSize: Decimal,
    private readonly log: Logger,
    private readonly label: string,
    opts: FallbackOptions = {},
  ) {
    this.emitted = live.current();
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 5_000;
    this.staleMs = opts.staleMs ?? 20_000;
    this.recoverMs = opts.recoverMs ?? 30_000;
  }

  async start() {
    this.startedAt = Date.now();
    // 外部源启动失败（缺 key、DNS 失败等）也不能阻塞引擎：记日志，交给 sample() 降级
    await Promise.race([
      this.live.start().catch((err) => this.log.warn({ err, market: this.label }, 'live feed failed to start')),
      new Promise((r) => setTimeout(r, this.startupTimeoutMs)),
    ]);
  }

  async stop() {
    await this.live.stop().catch(() => {});
  }

  current() {
    return this.emitted;
  }

  private liveFresh(nowMs: number) {
    const at = this.live.lastQuoteAt;
    return at !== null && nowMs - at < this.staleMs;
  }

  sample(now: Date): Quote | null {
    const nowMs = now.getTime();
    this.startedAt ??= nowMs;

    if (this.mode === 'live') {
      const silentTooLong = this.live.lastQuoteAt === null ? nowMs - this.startedAt >= this.startupTimeoutMs : !this.liveFresh(nowMs);
      if (!silentTooLong) {
        const q = this.live.sample(now);
        if (q) this.emitted = q.price;
        return q;
      }
      this.enterFallback(nowMs);
    }

    // fallback：先推进模拟价
    const simQuote = this.sim!.sample(now);
    const simPrice = simQuote?.price ?? this.sim!.current();
    if (!this.liveFresh(nowMs) || this.live.latestPrice() === null) {
      this.recoveringSince = null;
      this.emitted = simPrice;
      return simQuote ?? { price: simPrice, volume: D(0) };
    }

    // 外部源恢复：线性过渡到真实价
    this.recoveringSince ??= nowMs;
    const liveQuote = this.live.sample(now);
    const livePrice = liveQuote?.price ?? this.live.latestPrice()!;
    const w = dmin(ONE, D(nowMs - this.recoveringSince).div(this.recoverMs));
    const blended = simPrice.mul(ONE.minus(w)).plus(livePrice.mul(w));
    this.emitted = dmax(this.tickSize, roundToStep(blended, this.tickSize, 'nearest'));
    if (w.gte(1)) {
      this.mode = 'live';
      this.sim = null;
      this.recoveringSince = null;
      this.log.info({ market: this.label }, 'live feed recovered, back to real prices');
    }
    return { price: this.emitted, volume: liveQuote?.volume ?? simQuote?.volume ?? D(0) };
  }

  private enterFallback(nowMs: number) {
    this.mode = 'fallback';
    this.recoveringSince = null;
    this.sim = this.makeSim(this.emitted);
    if (this.overrides) this.sim.setOverrides(this.overrides);
    const lastAt = this.live.lastQuoteAt;
    this.log.warn(
      { market: this.label, silentMs: lastAt === null ? nowMs - (this.startedAt ?? nowMs) : nowMs - lastAt, from: this.emitted.toFixed() },
      'live feed unavailable, falling back to procedural prices',
    );
  }

  applyGap(gapPercent: Decimal, now: Date, durationSec: number): Decimal {
    this.emitted = this.mode === 'fallback' && this.sim ? this.sim.applyGap(gapPercent, now) : this.live.applyGap(gapPercent, now, durationSec);
    return this.emitted;
  }

  setOverrides(overrides: SourceOverrides) {
    this.overrides = overrides;
    this.sim?.setOverrides(overrides);
  }
}
