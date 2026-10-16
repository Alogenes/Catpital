import { D } from '@catpital/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromDb } from '../src/lib/dec.js';
import { type Harness, TEST_MARKET, createHarness } from './support/harness.js';

// 流动性池 1,000,000、单笔上限 ±1%：名义价值 10,000 的单子正好打满 1%
const IMPACT_MARKET = {
  ...TEST_MARKET,
  code: 'PUMP',
  name: 'Pump Corp',
  engine: { ...TEST_MARKET.engine, impactLiquidity: '1000000', impactCap: '0.01', impactVolBoost: '2', impactDecaySec: 20 },
};

const WHALE = '500000000000000001';
const VICTIM = '500000000000000002';
const SHRIMP = '500000000000000003';
let h: Harness;
const s = (v: { toString(): string }) => fromDb(v.toString()).toFixed();
const price = () => h.core.markets.price(h.core.markets.byCode('PUMP')!.id)!.toFixed();

beforeAll(async () => {
  h = await createHarness([TEST_MARKET, IMPACT_MARKET]);
  await h.user(WHALE, 'whale');
  await h.user(VICTIM, 'victim');
  await h.user(SHRIMP, 'shrimp');
});
afterAll(async () => {
  await h.close();
});

describe('大单冲击', () => {
  it('a big buy fills at the impact midpoint and pumps the price', async () => {
    const r = await h.core.orders.placeOrder(WHALE, { market: 'PUMP', side: 'BUY', type: 'MARKET', quantity: D(100), leverage: D(10) });
    expect(r.kind).toBe('filled');
    expect(s(r.order.fillPrice!)).toBe('100.5');
    expect(price()).toBe('101');
    const whale = h.botMessages.find((m) => m.broadcast.kind === 'WHALE');
    expect(whale?.broadcast).toMatchObject({ i18nKey: 'broadcast.whalePump', vars: { market: 'PUMP', pct: '1', user: 'whale' } });
  });

  it('dumping right back is a losing round trip (no self-pump arbitrage)', async () => {
    const r = await h.core.orders.closePosition(WHALE, 'PUMP');
    expect(r.kind).toBe('filled');
    expect(D(s(r.order.realizedPnl!)).lt(0)).toBe(true);
    expect(price()).toBe('99.99');
    const dumps = h.botMessages.filter((m) => m.broadcast.i18nKey === 'broadcast.whaleDump');
    expect(dumps).toHaveLength(1);
  });

  it('a whale dump can liquidate someone else’s high-leverage long', async () => {
    await h.core.orders.placeOrder(VICTIM, { market: 'PUMP', side: 'BUY', type: 'MARKET', quantity: D('0.1'), leverage: D(100) });
    const p = (await h.position(VICTIM, 'PUMP'))!;
    expect(D(s(p.liquidationPrice)).gt(D(price()).mul('0.99'))).toBe(true); // 斩杀线在 1% 以内
    await h.core.orders.placeOrder(WHALE, { market: 'PUMP', side: 'SELL', type: 'MARKET', quantity: D(100), leverage: D(10) });
    expect(await h.position(VICTIM, 'PUMP')).toBeNull();
    expect(await h.db.liquidation.count({ where: { userId: VICTIM } })).toBe(1);
  });

  it('small orders barely move the price and are not broadcast', async () => {
    const before = price();
    const count = h.botMessages.filter((m) => m.broadcast.kind === 'WHALE').length;
    await h.core.orders.placeOrder(SHRIMP, { market: 'PUMP', side: 'BUY', type: 'MARKET', quantity: D('0.1'), leverage: D(1) });
    expect(D(price()).minus(before).abs().lte('0.01')).toBe(true);
    expect(h.botMessages.filter((m) => m.broadcast.kind === 'WHALE')).toHaveLength(count);
  });

  it('markets without impact config are unaffected', async () => {
    const r = await h.core.orders.placeOrder(SHRIMP, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(100), leverage: D(10) });
    expect(s(r.order.fillPrice!)).toBe('100');
    expect(h.core.markets.price(h.core.markets.byCode('TEST')!.id)!.toFixed()).toBe('100');
  });
});

describe('解锁杠杆', () => {
  const order = (lev: number) =>
    h.core.orders.placeOrder(SHRIMP, { market: 'TEST', side: 'SELL', type: 'MARKET', quantity: D('0.1'), leverage: D(lev) });

  it('above the market cap requires the settings unlock', async () => {
    await expect(order(150)).rejects.toMatchObject({ code: 'error.invalidLeverage' });
    await h.core.users.updateSettings(SHRIMP, { degenUnlock: true });
    const r = await order(150);
    expect(r.kind).not.toBe('duplicate');
  });

  it('never allows a leverage that would be liquidated on entry', async () => {
    // TEST 市场 mmr 0.5% → 安全上限 199x
    await expect(order(200)).rejects.toMatchObject({ code: 'error.invalidLeverage' });
    await h.core.users.updateSettings(SHRIMP, { degenUnlock: false });
    await expect(order(150)).rejects.toMatchObject({ code: 'error.invalidLeverage' });
  });
});
