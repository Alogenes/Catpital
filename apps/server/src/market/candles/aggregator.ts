import { type CandleIntervalCode, CANDLE_INTERVALS, type Decimal, INTERVAL_MS } from '@catpital/shared';

export interface CandleState {
  interval: CandleIntervalCode;
  openTime: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  tradeCount: number;
}

/** UTC 对齐的周期起点（1D 按 UTC 自然日） */
export const bucketStart = (ts: number, interval: CandleIntervalCode) => ts - (ts % INTERVAL_MS[interval]);

/**
 * Tick → 多周期 OHLCV 实时聚合（纯内存、纯函数式更新）。
 * 每个 tick 返回：本次被更新的未收盘 K 线 + 因跨周期而收盘的 K 线。
 * 持久化与推送由 MarketEngine 负责。
 */
export class CandleAggregator {
  private current = new Map<CandleIntervalCode, CandleState>();

  constructor(
    private readonly intervals: readonly CandleIntervalCode[] = CANDLE_INTERVALS,
    restored: CandleState[] = [],
  ) {
    for (const c of restored) this.current.set(c.interval, c);
  }

  update(price: Decimal, volume: Decimal, ts: number): { updated: CandleState[]; closed: CandleState[] } {
    const updated: CandleState[] = [];
    const closed: CandleState[] = [];
    for (const interval of this.intervals) {
      const start = bucketStart(ts, interval);
      const cur = this.current.get(interval);
      let next: CandleState;
      if (!cur || cur.openTime !== start) {
        if (cur && cur.openTime < start) closed.push(cur);
        if (cur && cur.openTime > start) continue; // 迟到的 tick（时钟回拨），丢弃
        next = { interval, openTime: start, open: price, high: price, low: price, close: price, volume, tradeCount: 1 };
      } else {
        next = {
          ...cur,
          high: price.gt(cur.high) ? price : cur.high,
          low: price.lt(cur.low) ? price : cur.low,
          close: price,
          volume: cur.volume.plus(volume),
          tradeCount: cur.tradeCount + 1,
        };
      }
      this.current.set(interval, next);
      updated.push(next);
    }
    return { updated, closed };
  }

  /** 清空所有未收盘 K 线（管理员清除历史后，下一个 tick 从现价重新开一根） */
  reset() {
    this.current.clear();
  }

  snapshot(): CandleState[] {
    return [...this.current.values()];
  }

  get(interval: CandleIntervalCode) {
    return this.current.get(interval);
  }
}
