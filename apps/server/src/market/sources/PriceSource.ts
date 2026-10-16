import type { Decimal } from '@catpital/shared';

export interface Quote {
  price: Decimal;
  volume: Decimal;
}

/** 由定时事件写入的运行时覆盖（多个活跃事件已在上层合成：漂移相加、波动率相乘） */
export interface SourceOverrides {
  driftOverride: Decimal;
  volMultiplier: Decimal;
}

/**
 * 行情数据源（Strategy Pattern）。
 * MarketEngine 按 Market.tickIntervalMs 定时调用 sample()：
 *   - 程序随机源：每次推进一步随机过程
 *   - 外部 API 源：返回最近一次推送/轮询到的报价（叠加事件冲击），无新数据返回 null
 */
export interface PriceSource {
  readonly kind: 'PROCEDURAL' | 'LIVE_API';
  start(): Promise<void>;
  stop(): Promise<void>;
  sample(now: Date): Quote | null;
  /** 当前（最近一次输出的）价格 */
  current(): Decimal;
  /**
   * 定时事件瞬间跳空：price' = price × (1 + gapPercent)，返回跳空后价格。
   * durationSec 仅对外部源有意义（冲击随时间线性衰减回真实价格）。
   */
  applyGap(gapPercent: Decimal, now: Date, durationSec: number): Decimal;
  setOverrides(overrides: SourceOverrides): void;
}
