import { D } from '@catpital/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromDb } from '../src/lib/dec.js';
import { TradeError } from '../src/trading/types.js';
import { type Harness, createHarness } from './support/harness.js';

const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';

let h: Harness;
const s = (v: { toString(): string }) => fromDb(v.toString()).toFixed();

beforeAll(async () => {
  h = await createHarness();
  await h.user(A, 'alice');
  await h.user(B, 'bob');
  await h.user(C, 'carol');
});
afterAll(async () => {
  await h.close();
});

describe('玩家 A：合并 → 止损 → 100x 被事件跳空斩杀穿仓 → 破产', () => {
  it('onboarding grants initial balance', async () => {
    expect(await h.wallet(A)).toEqual({ balance: '10000', locked: '0' });
    const life = await h.db.life.findFirstOrThrow({ where: { userId: A } });
    expect(life.generation).toBe(1);
  });

  it('opens a 10x long', async () => {
    const r = await h.core.orders.placeOrder(A, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(10), leverage: D(10) });
    expect(r.kind).toBe('filled');
    const p = (await h.position(A))!;
    expect([s(p.quantity), s(p.entryPrice), s(p.margin), s(p.liquidationPrice)]).toEqual(['10', '100', '100', '90.46']);
    expect((await h.wallet(A)).balance).toBe('9899');
  });

  it('merges a same-side add at a different price and leverage', async () => {
    await h.tick('110');
    await h.core.orders.placeOrder(A, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(10), leverage: D(5) });
    const p = (await h.position(A))!;
    expect([s(p.quantity), s(p.entryPrice), s(p.margin), s(p.leverage), s(p.liquidationPrice)]).toEqual([
      '20', '105', '320', '6.5625', '89.45',
    ]);
    expect((await h.wallet(A)).balance).toBe('9677.9');
    // 巅峰净值：9677.9 + 320 + (110 − 105)·20
    const life = await h.db.life.findFirstOrThrow({ where: { userId: A, status: 'ACTIVE' } });
    expect(s(life.peakNetWorth)).toBe('10097.9');
  });

  it('stop loss fires at the real last price', async () => {
    await h.core.orders.setTpSl(A, 'TEST', D(130), D(95));
    await h.tick('96');
    expect(await h.position(A)).not.toBeNull();
    await h.tick('94');
    expect(await h.position(A)).toBeNull();
    const o = await h.db.order.findFirstOrThrow({ where: { userId: A, source: 'STOP_LOSS' } });
    expect([s(o.fillPrice!), s(o.realizedPnl!), s(o.realizedRoe!)]).toEqual(['94', '-221.88', '-0.693375']);
    expect((await h.wallet(A)).balance).toBe('9776.02');
  });

  it('scheduled event gaps -30% through a 100x liquidation line; deficit is debited into negative balance', async () => {
    await h.tick('100');
    await h.core.orders.placeOrder(A, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(900), leverage: D(100) });
    const p = (await h.position(A))!;
    expect(s(p.liquidationPrice)).toBe('99.5');
    expect((await h.wallet(A)).balance).toBe('8786.02');

    const ev = await h.core.events.create(
      {
        market: 'TEST',
        triggerAt: new Date(h.clock().getTime() + 5000),
        headline: 'Test Corp fraud',
        content: '',
        i18n: {},
        gapPercent: '-0.30',
        driftAdjust: '-2',
        volMultiplier: '2.5',
        durationSec: 60,
      },
      'ADMIN_COMMAND',
    );
    await h.core.events.poll();
    expect((await h.db.scheduledEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('PENDING');

    h.advance(5000);
    await h.core.events.poll();

    const fired = await h.db.scheduledEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect([fired.status, s(fired.priceBefore!), s(fired.priceAfter!)]).toEqual(['ACTIVE', '100', '70']);
    const cfg = await h.db.marketEngineConfig.findFirstOrThrow();
    expect([s(cfg.driftOverride), s(cfg.volMultiplier)]).toEqual(['-2', '2.5']);

    const liq = await h.db.liquidation.findFirstOrThrow({ where: { userId: A } });
    expect([s(liq.liquidationPrice), s(liq.executionPrice), s(liq.settlement), s(liq.deficit), s(liq.totalLoss), s(liq.balanceAfter)]).toEqual([
      '99.5', '70', '-26163', '26163', '27063', '-17376.98',
    ]);
    expect(liq.scheduledEventId).toBe(ev.id);
    expect((await h.wallet(A)).balance).toBe('-17376.98');

    const deficitEntry = await h.db.ledgerEntry.findFirstOrThrow({ where: { userId: A, type: 'LIQUIDATION_DEFICIT' } });
    expect(s(deficitEntry.amount)).toBe('-26163');

    const kinds = h.botMessages.map((m) => m.broadcast.kind);
    expect(kinds).toContain('MARKET_EVENT');
    expect(kinds).toContain('DEFICIT');
    const userEvents = h.messages.filter((m) => m.userId === A).map((m) => ('d' in m.msg ? (m.msg.d as { type?: string }).type : null));
    expect(userEvents).toContain('liquidated');
    expect(userEvents).toContain('bankruptcyAvailable');
  });

  it('event expires and engine overrides are restored', async () => {
    h.advance(61_000);
    await h.core.events.poll();
    const cfg = await h.db.marketEngineConfig.findFirstOrThrow();
    expect([s(cfg.driftOverride), s(cfg.volMultiplier)]).toEqual(['0', '1']);
  });

  it('indebted player cannot open new positions', async () => {
    const r = await h.core.orders.placeOrder(A, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(1), leverage: D(10) });
    expect(r.kind).toBe('rejected');
    expect(r.kind === 'rejected' && r.reason).toBe('error.insufficientFunds');
  });

  it('declares bankruptcy: debt written off, relief granted, resume generated', async () => {
    const resume = await h.core.bankruptcy.declare(A);
    expect([s(resume.finalBalance), s(resume.debtWrittenOff), s(resume.reliefGranted), s(resume.peakNetWorth), s(resume.worstLiquidationLoss!)]).toEqual([
      '-17376.98', '17376.98', '5000', '10097.9', '27063',
    ]);
    expect(resume.closedTradeCount).toBe(2);
    expect(resume.liquidationCount).toBe(1);
    expect(resume.deficitCount).toBe(1);
    expect(s(resume.winRate)).toBe('0');
    expect(resume.titles).toEqual(['title.speedrun', 'title.deficitKing', 'title.eventVictim']);

    expect(await h.wallet(A)).toEqual({ balance: '5000', locked: '0' });
    const user = await h.db.user.findUniqueOrThrow({ where: { id: A } });
    expect(user.generation).toBe(2);
    const lives = await h.db.life.findMany({ where: { userId: A }, orderBy: { generation: 'asc' } });
    expect(lives.map((l) => [l.generation, l.status])).toEqual([[1, 'ENDED'], [2, 'ACTIVE']]);

    const external = await h.db.ledgerEntry.findMany({ where: { userId: A, isExternal: true }, orderBy: { id: 'asc' } });
    expect(external.map((e) => [e.type, s(e.amount)])).toEqual([
      ['INITIAL_GRANT', '10000'],
      ['BANKRUPTCY_WRITE_OFF', '17376.98'],
      ['BANKRUPTCY_RELIEF', '5000'],
    ]);
    expect(h.botMessages.some((m) => m.broadcast.kind === 'BANKRUPTCY' && m.resumeId === resume.id)).toBe(true);
  });

  it('cannot declare bankruptcy twice', async () => {
    await expect(h.core.bankruptcy.declare(A)).rejects.toBeInstanceOf(TradeError);
  });
});

describe('玩家 B：限价单 / 翻仓 / 追加保证金 / 部分平仓 / 空单止盈', () => {
  it('rests a limit buy with frozen funds and fills as maker when crossed', async () => {
    // 当前价 70
    const r = await h.core.orders.placeOrder(B, { market: 'TEST', side: 'BUY', type: 'LIMIT', quantity: D(1), leverage: D(10), limitPrice: D(65) });
    expect(r.kind).toBe('resting');
    expect(await h.wallet(B)).toEqual({ balance: '9993.4675', locked: '6.5325' });

    await h.tick('66');
    expect(await h.position(B)).toBeNull();
    await h.tick('64');
    const p = (await h.position(B))!;
    expect([p.side, s(p.entryPrice), s(p.margin)]).toEqual(['LONG', '65', '6.5']);
    const o = await h.db.order.findUniqueOrThrow({ where: { id: r.order.id } });
    expect([o.status, o.liquidity, s(o.fee)]).toEqual(['FILLED', 'MAKER', '0.0325']);
    expect(await h.wallet(B)).toEqual({ balance: '9993.4675', locked: '0' });
  });

  it('cancels a resting order and unlocks funds', async () => {
    const r = await h.core.orders.placeOrder(B, { market: 'TEST', side: 'BUY', type: 'LIMIT', quantity: D(1), leverage: D(10), limitPrice: D(50) });
    expect((await h.wallet(B)).locked).toBe('5.025');
    await h.core.orders.cancelOrder(B, r.order.id);
    expect(await h.wallet(B)).toEqual({ balance: '9993.4675', locked: '0' });
  });

  it('opposite order closes first then flips into a short', async () => {
    await h.tick('70');
    const r = await h.core.orders.placeOrder(B, { market: 'TEST', side: 'SELL', type: 'MARKET', quantity: D(3), leverage: D(10) });
    expect([s(r.order.closedQuantity), s(r.order.openedQuantity)]).toEqual(['1', '2']);
    const p = (await h.position(B))!;
    expect([p.side, s(p.quantity), s(p.entryPrice), s(p.margin), s(p.liquidationPrice)]).toEqual(['SHORT', '2', '70', '14', '76.61']);
    expect((await h.wallet(B)).balance).toBe('9990.7575');
  });

  it('adds isolated margin, pushing the short liquidation line up', async () => {
    await h.core.orders.addMargin(B, 'TEST', D(14));
    const p = (await h.position(B))!;
    expect([s(p.margin), s(p.leverage), s(p.liquidationPrice), s(p.addedMargin)]).toEqual(['28', '5', '83.58', '14']);
    expect((await h.wallet(B)).balance).toBe('9976.7575');
  });

  it('partially closes', async () => {
    await h.core.orders.closePosition(B, 'TEST', D(1));
    const p = (await h.position(B))!;
    expect([s(p.quantity), s(p.margin), s(p.liquidationPrice)]).toEqual(['1', '14', '83.58']);
    expect((await h.wallet(B)).balance).toBe('9990.6875');
  });

  it('rejects TP on the wrong side and fires a valid short TP', async () => {
    await expect(h.core.orders.setTpSl(B, 'TEST', D(75), undefined)).rejects.toMatchObject({ code: 'error.tpWrongSide' });
    await h.core.orders.setTpSl(B, 'TEST', D(60), undefined);
    await h.tick('59');
    expect(await h.position(B)).toBeNull();
    const o = await h.db.order.findFirstOrThrow({ where: { userId: B, source: 'TAKE_PROFIT' } });
    expect([s(o.fillPrice!), s(o.realizedPnl!)]).toEqual(['59', '10.941']);
    expect((await h.wallet(B)).balance).toBe('10015.6285');
  });

  it('reduce-only with nothing to reduce is rejected', async () => {
    const r = await h.core.orders.placeOrder(B, { market: 'TEST', side: 'SELL', type: 'MARKET', quantity: D(1), leverage: D(1), reduceOnly: true });
    expect(r.kind === 'rejected' && r.reason).toBe('error.nothingToReduce');
  });
});

describe('玩家 C：高光止盈播报与参数校验', () => {
  it('broadcasts BIG_WIN when ROE ≥ 100%', async () => {
    await h.core.orders.placeOrder(C, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(10), leverage: D(100) });
    await h.tick('60');
    await h.core.orders.closePosition(C, 'TEST');
    const win = h.botMessages.find((m) => m.broadcast.kind === 'BIG_WIN');
    expect(win?.broadcast.vars).toMatchObject({ market: 'TEST', pnl: '9.4', user: 'carol' });
  });

  it('validates quantity, leverage and min notional', async () => {
    const place = (q: string, lev: string) =>
      h.core.orders.placeOrder(C, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(q), leverage: D(lev) });
    await expect(place('0.001', '1')).rejects.toMatchObject({ code: 'error.invalidQuantity' });
    await expect(place('1', '101')).rejects.toMatchObject({ code: 'error.invalidLeverage' });
    const tiny = await place('0.01', '1');
    expect(tiny.kind === 'rejected' && tiny.reason).toBe('error.belowMinNotional');
  });
});

describe('账本不变量', () => {
  it('Σ ledger amounts equals wallet balance for every user', async () => {
    for (const u of [A, B, C]) {
      const { ledgerSum, balance } = await h.assertLedgerInvariant(u);
      expect(ledgerSum).toBe(balance);
    }
  });

  it('K-lines were persisted for closed buckets', async () => {
    h.advance(120_000);
    await h.tick('61');
    const count = await h.db.candle.count({ where: { interval: 'M1' } });
    expect(count).toBeGreaterThan(0);
  });
});
