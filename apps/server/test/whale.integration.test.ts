import { D } from '@catpital/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, createHarness } from './support/harness.js';

const WHALE = '700000000000000001';
const SHRIMP = '700000000000000002';
const TIERED = '700000000000000003';
const NORMAL = '700000000000000004';

let h: Harness;
const fund = (userId: string, amount: string) => h.db.wallet.update({ where: { userId }, data: { balance: amount } });
const buy = (userId: string, quantity: number, leverage: number, extra: { type?: 'MARKET' | 'LIMIT'; limitPrice?: string } = {}) =>
  h.core.orders.placeOrder(userId, {
    market: 'TEST',
    side: 'BUY',
    type: extra.type ?? 'MARKET',
    quantity: D(quantity),
    leverage: D(leverage),
    limitPrice: extra.limitPrice ? D(extra.limitPrice) : undefined,
  });
const fillPrice = (r: Awaited<ReturnType<typeof buy>>) => r.order.fillPrice?.toString();

beforeAll(async () => {
  h = await createHarness(); // TEST：价格 100，最小价位 0.01，市场杠杆上限 100x
  for (const id of [WHALE, SHRIMP, TIERED, NORMAL]) await h.user(id);
  await fund(WHALE, '10000000');
  await fund(TIERED, '10000000');
});
afterAll(async () => {
  await h.close();
});

describe('大资金滑点', () => {
  it('leaves normal-sized orders at the market price', async () => {
    expect(fillPrice(await buy(SHRIMP, 100, 10))).toBe('100'); // 保证金 1000
  });

  it('fills a 600k-margin market order 0.2% worse, and the close pays it again', async () => {
    const r = await buy(WHALE, 6000, 1); // 名义 60 万、1x → 保证金 60 万 → 0.05% × 2² = 0.2%
    expect(fillPrice(r)).toBe('100.2');
    const close = await h.core.orders.closePosition(WHALE, 'TEST'); // 平仓按持仓保证金算，卖得更便宜
    expect(close.order.fillPrice?.toString()).toBe('99.8');
  });

  it('never fills a marketable limit order worse than its limit', async () => {
    const r = await buy(WHALE, 6000, 1, { type: 'LIMIT', limitPrice: '100.1' });
    expect([r.kind, fillPrice(r)]).toEqual(['filled', '100.1']);
    await h.core.orders.closePosition(WHALE, 'TEST');
  });
});

describe('分档杠杆', () => {
  it('caps leverage by the size of the whole position after the order', async () => {
    // 3 万 × 100 = 300 万名义价值 → 200–500 万档最高 50x
    await expect(buy(TIERED, 30_000, 100)).rejects.toMatchObject({ code: 'error.leverageTier' });
    expect((await buy(TIERED, 30_000, 50)).kind).toBe('filled');
    // 加仓后合计 600 万 → 500–1000 万档最高 20x
    await expect(buy(TIERED, 30_000, 50)).rejects.toMatchObject({ code: 'error.leverageTier' });
    expect((await buy(TIERED, 30_000, 20)).kind).toBe('filled');
    // 只减仓不受限
    expect((await h.core.orders.closePosition(TIERED, 'TEST', D(10_000))).kind).toBe('filled');
  });

  it('does not touch a normal 100x position', async () => {
    // 初始 1 万本金开 100x：9000 × 100 = 90 万名义价值（加手续费刚好够），第一档不额外限制，也没有滑点
    const r = await buy(NORMAL, 9_000, 100);
    expect([r.kind, fillPrice(r)]).toEqual(['filled', '100']);
  });
});
