import { describe, expect, it } from 'vitest';
import {
  D,
  addMargin,
  applyFill,
  bankruptcySettlement,
  canDeclareBankruptcy,
  checkTrigger,
  impactPct,
  impactQuote,
  maxSafeLeverage,
  liquidationPrice,
  netWorth,
  periodReturn,
  settleLiquidation,
} from '../src/index.js';

const risk = { maintenanceMarginRate: D('0.005'), tickSize: D('0.01') };
const s = (v: { toFixed(): string }) => v.toFixed();

describe('decimal guard', () => {
  it('rejects non-integer JS numbers', () => {
    expect(() => D(0.1)).toThrow(TypeError);
    expect(s(D('0.1').plus(D('0.2')))).toBe('0.3');
  });
});

describe('公式 2：逐仓强平斩杀线', () => {
  it('long 10x', () => {
    expect(s(liquidationPrice({ side: 'LONG', quantity: D(1), entryPrice: D(100), margin: D(10) }, risk))).toBe('90.46');
  });
  it('short 10x', () => {
    expect(s(liquidationPrice({ side: 'SHORT', quantity: D(1), entryPrice: D(100), margin: D(10) }, risk))).toBe('109.45');
  });
  it('1x long never liquidates', () => {
    expect(s(liquidationPrice({ side: 'LONG', quantity: D(1), entryPrice: D(100), margin: D(100) }, risk))).toBe('0');
  });
  it('add margin lowers long liquidation price', () => {
    const p = addMargin({ side: 'LONG', quantity: D(1), entryPrice: D(100), margin: D(10) }, D(10), risk);
    expect(s(p.leverage)).toBe('5');
    expect(s(p.liquidationPrice)).toBe('80.41');
  });
});

describe('公式 1：同股市仓位合并 / 反向抵扣', () => {
  it('same-side merge uses weighted average entry and sums margin', () => {
    const r = applyFill(
      { side: 'LONG', quantity: D(1), entryPrice: D(100), margin: D(10) },
      { orderSide: 'BUY', quantity: D(1), price: D(120), leverage: D(5), feeRate: D(0), reduceOnly: false },
      risk,
    );
    expect(s(r.position!.quantity)).toBe('2');
    expect(s(r.position!.entryPrice)).toBe('110');
    expect(s(r.position!.margin)).toBe('34');
    expect(s(r.position!.leverage)).toBe('6.47058824');
    expect(s(r.position!.liquidationPrice)).toBe('93.47');
    expect(s(r.walletDelta)).toBe('-24');
  });

  it('opposite fill closes first, then flips with remainder', () => {
    const r = applyFill(
      { side: 'LONG', quantity: D(2), entryPrice: D(110), margin: D(34) },
      { orderSide: 'SELL', quantity: D(3), price: D(130), leverage: D(10), feeRate: D('0.001'), reduceOnly: false },
      risk,
    );
    expect(s(r.closedQuantity)).toBe('2');
    expect(s(r.realizedPnl)).toBe('40');
    expect(s(r.releasedMargin)).toBe('34');
    expect(s(r.closeFee)).toBe('0.26');
    expect(s(r.realizedRoe!)).toBe('1.16882353');
    expect(r.flipped).toBe(true);
    expect(r.position!.side).toBe('SHORT');
    expect(s(r.position!.margin)).toBe('13');
    expect(s(r.walletDelta)).toBe('60.61');
  });

  it('reduceOnly never opens the opposite side', () => {
    const r = applyFill(
      { side: 'LONG', quantity: D(1), entryPrice: D(100), margin: D(100) },
      { orderSide: 'SELL', quantity: D(5), price: D(90), leverage: D(1), feeRate: D(0), reduceOnly: true },
      risk,
    );
    expect(r.position).toBeNull();
    expect(s(r.walletDelta)).toBe('90');
  });
});

describe('公式 3：无穿仓保护强平结算', () => {
  it('gap through liquidation line debits deficit from balance (can go negative)', () => {
    const r = settleLiquidation(
      { side: 'LONG', quantity: D(1), entryPrice: D(100), margin: D(1) },
      D(70),
      D('0.001'),
      D(5),
    );
    expect(s(r.settlement)).toBe('-29.07');
    expect(s(r.deficit)).toBe('29.07');
    expect(s(r.totalLoss)).toBe('30.07');
    expect(s(r.balanceAfter)).toBe('-24.07');
  });

  it('liquidation at the line returns residual margin, no deficit', () => {
    const r = settleLiquidation({ side: 'LONG', quantity: D(1), entryPrice: D(100), margin: D(10) }, D('90.46'), D(0), D(0));
    expect(s(r.deficit)).toBe('0');
    expect(s(r.settlement)).toBe('0.46');
    expect(s(r.totalLoss)).toBe('9.54');
  });

  it('trigger priority: liquidation > stop loss > take profit', () => {
    const pos = {
      side: 'LONG' as const,
      quantity: D(1),
      entryPrice: D(100),
      margin: D(10),
      liquidationPrice: D('90.46'),
      stopLossPrice: D(92),
      takeProfitPrice: D(120),
    };
    expect(checkTrigger(pos, D(85))).toBe('LIQUIDATION');
    expect(checkTrigger(pos, D(91))).toBe('STOP_LOSS');
    expect(checkTrigger(pos, D(121))).toBe('TAKE_PROFIT');
    expect(checkTrigger(pos, D(100))).toBeNull();
  });
});

describe('净值与破产', () => {
  it('net worth adds isolated margin back', () => {
    const nw = netWorth({
      balance: D(-50),
      locked: D(0),
      positions: [{ side: 'SHORT', quantity: D(2), entryPrice: D(100), margin: D(20), markPrice: D(95) }],
    });
    expect(s(nw)).toBe('-20');
  });
  it('bankruptcy clears debt and grants relief', () => {
    expect(canDeclareBankruptcy({ balance: D(-24), openPositionCount: 0, pendingOrderCount: 0, dustThreshold: D(0) })).toBe(true);
    expect(canDeclareBankruptcy({ balance: D(-24), openPositionCount: 1, pendingOrderCount: 0, dustThreshold: D(0) })).toBe(false);
    const b = bankruptcySettlement(D('-24.07'), D(5000));
    expect(s(b.debtWrittenOff)).toBe('24.07');
    expect(s(b.balanceAfter)).toBe('5000');
    expect(s(b.externalFlow)).toBe('5024.07');
  });
});

describe('公式 4：防刷收益率 (Modified Dietz)', () => {
  const start = new Date('2026-10-16T00:00:00Z');
  const end = new Date('2026-10-17T00:00:00Z');

  it('mid-period deposit is time-weighted', () => {
    const r = periodReturn({
      startNetWorth: D(1000),
      endNetWorth: D(1300),
      periodStart: start,
      periodEnd: end,
      flows: [{ amount: D(200), at: new Date('2026-10-16T12:00:00Z') }],
      minCapital: D(1000),
    });
    expect(s(r.weightedExternalFlow)).toBe('100');
    expect(s(r.returnPct!)).toBe('9.09090909');
  });

  it('bankruptcy relief does not count as profit', () => {
    const r = periodReturn({
      startNetWorth: D(1000),
      endNetWorth: D(5000),
      periodStart: start,
      periodEnd: end,
      flows: [{ amount: D(5500), at: new Date('2026-10-16T18:00:00Z') }],
      minCapital: D(1000),
    });
    expect(s(r.returnPct!)).toBe('-63.15789474');
  });

  it('small accounts are ineligible', () => {
    const r = periodReturn({
      startNetWorth: D(500),
      endNetWorth: D(5000),
      periodStart: start,
      periodEnd: end,
      flows: [],
      minCapital: D(1000),
    });
    expect(r.eligible).toBe(false);
    expect(r.returnPct).toBeNull();
  });
});

describe('大单冲击 & 解锁杠杆', () => {
  const p = { liquidity: D(1_000_000), cap: D('0.01') };
  it('linear impact, capped, signed by side', () => {
    expect(impactPct(D(5000), 'BUY', p).toFixed()).toBe('0.005');
    expect(impactPct(D(5000), 'SELL', p).toFixed()).toBe('-0.005');
    expect(impactPct(D(50_000), 'BUY', p).toFixed()).toBe('0.01');
    expect(impactPct(D(50_000), 'BUY', { liquidity: D(0), cap: D('0.01') }).toFixed()).toBe('0');
  });
  it('fills at the midpoint, price moves the full impact', () => {
    const q = impactQuote(D(100), D(10_000), 'BUY', p, D('0.01'));
    expect([q.fillPrice.toFixed(), q.newPrice.toFixed()]).toEqual(['100.5', '101']);
    const s = impactQuote(D(100), D(10_000), 'SELL', p, D('0.01'));
    expect([s.fillPrice.toFixed(), s.newPrice.toFixed()]).toEqual(['99.5', '99']);
  });
  it('pump-and-dump round trip is never profitable', () => {
    // 买 100 股 @100 → 价格 101；立刻卖 100 股 @101 → 成交 100.495，价格回到 99.99
    const buy = impactQuote(D(100), D(10_000), 'BUY', p, D('0.001'));
    const sell = impactQuote(buy.newPrice, buy.newPrice.mul(100), 'SELL', p, D('0.001'));
    expect(sell.fillPrice.lte(buy.fillPrice)).toBe(true);
  });
  it('max safe leverage stays below instant liquidation', () => {
    expect(maxSafeLeverage(D('0.005'))).toBe(199);
    expect(maxSafeLeverage(D('0.004'))).toBe(200);
    expect(maxSafeLeverage(D('0.01'))).toBe(99);
    // 199x 的斩杀线必须低于入场价
    const liq = liquidationPrice({ side: 'LONG', quantity: D(1), entryPrice: D(100), margin: D(100).div(199) }, { maintenanceMarginRate: D('0.005'), tickSize: D('0.0001') });
    expect(liq.lt(100)).toBe(true);
  });
});
