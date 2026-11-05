import { describe, expect, it } from 'vitest';
import { D, effectiveLeverageCap, maxLeverageForBudget, slippedPrice, tierLeverageCap, whaleSlippage } from '../src/index.js';

describe('分档杠杆', () => {
  it('bigger positions get a lower leverage cap; the first tier keeps the market cap', () => {
    expect([tierLeverageCap(D(1_000_000)), tierLeverageCap(D(1_000_001)), tierLeverageCap(D(3_000_000)), tierLeverageCap(D(15_000_000)), tierLeverageCap(D(80_000_000))]).toEqual([
      null, 100, 50, 10, 2,
    ]);
    expect(effectiveLeverageCap(200, D(900_000))).toBe(200); // 解锁后小仓位可到 200x
    expect(effectiveLeverageCap(20, D(3_000_000))).toBe(20); // 市场上限更低时用市场上限
  });

  it('finds the highest leverage a budget can use', () => {
    expect(maxLeverageForBudget(100, D(10_000))).toBe(100); // 普通玩家 1 万 × 100x = 100 万，不受影响
    expect(maxLeverageForBudget(200, D(5_000))).toBe(200); // 救济金 5000 解锁后 200x
    expect(maxLeverageForBudget(200, D(10_000))).toBe(100);
    expect(maxLeverageForBudget(100, D(100_000))).toBe(50); // 100 万 × 50 = 500 万
    expect(maxLeverageForBudget(20, D(1_460_000))).toBe(10); // 146 万本金在 FIH 最多 10x
  });
});

describe('大资金滑点', () => {
  it('is negligible for normal players and grows with the square of margin', () => {
    expect(whaleSlippage(D(10_000)).lt('0.000001')).toBe(true);
    expect(whaleSlippage(D(300_000)).toFixed()).toBe('0.0005');
    expect(whaleSlippage(D(600_000)).toFixed()).toBe('0.002');
    expect(whaleSlippage(D(10_000_000)).toFixed()).toBe('0.03'); // 封顶 3%
  });

  it('makes buys dearer and sells cheaper, rounds to the tick and respects a limit price', () => {
    const tick = D('0.01');
    expect(slippedPrice(D(100), 'BUY', D('0.002'), tick).toFixed()).toBe('100.2');
    expect(slippedPrice(D(100), 'SELL', D('0.002'), tick).toFixed()).toBe('99.8');
    expect(slippedPrice(D(100), 'BUY', D('0.00000006'), tick).toFixed()).toBe('100'); // 小单舍入后为 0
    expect(slippedPrice(D(100), 'BUY', D('0.002'), tick, D('100.1')).toFixed()).toBe('100.1'); // 不超过限价
  });
});
