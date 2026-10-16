import { D } from '@catpital/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, TEST_MARKET, createHarness } from './support/harness.js';

const U = '200000000000000001';
let h: Harness;

beforeAll(async () => {
  h = await createHarness([
    TEST_MARKET,
    { ...TEST_MARKET, code: 'TEST2', name: 'Test Two' },
    { ...TEST_MARKET, code: 'TEST3', name: 'Test Three' },
  ]);
  await h.user(U);
});
afterAll(async () => {
  await h.close();
});

describe('并发防双花', () => {
  it('parallel orders across markets never overspend the shared wallet', async () => {
    // 每单 3 @ 100、1x：保证金 300 + 手续费 0.3 = 300.3；10000 / 300.3 → 最多 33 单
    const markets = ['TEST', 'TEST2', 'TEST3'];
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, i) =>
        h.core.orders.placeOrder(U, { market: markets[i % 3]!, side: 'BUY', type: 'MARKET', quantity: D(3), leverage: D(1) }),
      ),
    );
    const kinds = results.map((r) => (r.status === 'fulfilled' ? r.value.kind : 'error'));
    expect(kinds.filter((k) => k === 'error')).toHaveLength(0);
    expect(kinds.filter((k) => k === 'filled')).toHaveLength(33);
    expect(kinds.filter((k) => k === 'rejected')).toHaveLength(27);

    expect(await h.wallet(U)).toEqual({ balance: '90.1', locked: '0' });
    const { ledgerSum, balance } = await h.assertLedgerInvariant(U);
    expect(ledgerSum).toBe(balance);

    // 每个市场仍然只有一个合并后的净持仓
    const open = await h.db.position.findMany({ where: { userId: U, status: 'OPEN' } });
    expect(open).toHaveLength(3);
    const totalQty = open.reduce((acc, p) => acc.plus(p.quantity.toString()), D(0));
    expect(totalQty.toFixed()).toBe('99');
  });

  it('a liquidation racing with an add-margin request is serialised per market', async () => {
    // 新开 100x 空单，同时：价格穿越斩杀线 + 追加保证金
    const V = '200000000000000002';
    await h.user(V);
    await h.core.orders.placeOrder(V, { market: 'TEST', side: 'SELL', type: 'MARKET', quantity: D(10), leverage: D(100) });
    const [, addResult] = await Promise.allSettled([h.tick('101'), h.core.orders.addMargin(V, 'TEST', D(50))]);
    // tick 先入队 → 先被强平 → 追加保证金因无持仓而失败（而不是把钱加到已平仓位上）
    expect(addResult.status).toBe('rejected');
    expect(await h.db.liquidation.count({ where: { userId: V } })).toBe(1);
    const { ledgerSum, balance } = await h.assertLedgerInvariant(V);
    expect(ledgerSum).toBe(balance);
  });
});
