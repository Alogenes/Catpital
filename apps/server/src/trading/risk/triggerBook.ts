import type { Decimal } from '@catpital/shared';

/**
 * 价格触发索引：按阈值升序保存 (threshold, key)。
 *   - `below` 侧：最新价 <= 阈值 时触发（多仓斩杀/止损、空仓止盈、买入限价单）
 *   - `above` 侧：最新价 >= 阈值 时触发（空仓斩杀/止损、多仓止盈、卖出限价单）
 * collect() 只扫描越线的部分，复杂度 O(log n + k)，不做全表扫描。
 */
interface Entry {
  threshold: Decimal;
  key: string;
}

class SortedSide {
  private entries: Entry[] = [];

  private lowerBound(threshold: Decimal) {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.entries[mid]!.threshold.lt(threshold)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  insert(threshold: Decimal, key: string) {
    this.entries.splice(this.lowerBound(threshold), 0, { threshold, key });
  }

  remove(threshold: Decimal, key: string) {
    let i = this.lowerBound(threshold);
    while (i < this.entries.length && this.entries[i]!.threshold.eq(threshold)) {
      if (this.entries[i]!.key === key) {
        this.entries.splice(i, 1);
        return;
      }
      i++;
    }
  }

  /** threshold >= price 的全部 key（从尾部向前扫） */
  atOrAbove(price: Decimal, out: string[]) {
    for (let i = this.entries.length - 1; i >= 0 && this.entries[i]!.threshold.gte(price); i--) out.push(this.entries[i]!.key);
  }

  /** threshold <= price 的全部 key（从头部向后扫） */
  atOrBelow(price: Decimal, out: string[]) {
    for (let i = 0; i < this.entries.length && this.entries[i]!.threshold.lte(price); i++) out.push(this.entries[i]!.key);
  }

  get size() {
    return this.entries.length;
  }
}

export type TriggerSide = 'below' | 'above';

export class TriggerBook {
  private below = new SortedSide();
  private above = new SortedSide();
  private index = new Map<string, { side: TriggerSide; threshold: Decimal }>();

  set(key: string, side: TriggerSide, threshold: Decimal) {
    this.delete(key);
    (side === 'below' ? this.below : this.above).insert(threshold, key);
    this.index.set(key, { side, threshold });
  }

  delete(key: string) {
    const cur = this.index.get(key);
    if (!cur) return;
    (cur.side === 'below' ? this.below : this.above).remove(cur.threshold, key);
    this.index.delete(key);
  }

  /** 返回在该价格上越线的全部 key（不移除，由执行方处理后再更新索引） */
  collect(price: Decimal): string[] {
    const out: string[] = [];
    this.below.atOrAbove(price, out);
    this.above.atOrBelow(price, out);
    return out;
  }

  has(key: string) {
    return this.index.has(key);
  }

  get size() {
    return this.index.size;
  }
}
