import { describe, expect, it } from 'vitest';
import { exchangeQuote } from '../src/index.js';

const q = (d: 'IN' | 'OUT', n: string) => {
  const r = exchangeQuote(d, n);
  return [r.received.toFixed(), r.fee.toFixed()];
};

describe('exchangeQuote：双向 1% 手续费，小数直接截断', () => {
  it('IN 到账 Meow Coin 保留 2 位小数', () => {
    expect(q('IN', '1000')).toEqual(['990', '10']);
    expect(q('IN', '1234')).toEqual(['1221.66', '12.34']);
    expect(q('IN', '1')).toEqual(['0.99', '0.01']); // 0.99
  });

  it('OUT 到账 bolívares 只取整数', () => {
    expect(q('OUT', '1000')).toEqual(['990', '10']);
    expect(q('OUT', '100001')).toEqual(['99000', '1001']); // 99000.99 → 99000
    expect(q('OUT', '2')).toEqual(['1', '1']); // 1.98 → 1
    expect(q('OUT', '1')).toEqual(['0', '1']); // 太小，到账 0，由调用方拒绝
  });
});
