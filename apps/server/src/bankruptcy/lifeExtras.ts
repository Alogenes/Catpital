import { type Decimal, ZERO, dmax } from '@catpital/shared';
import { fromDb } from '../lib/dec.js';
import type { Tx } from '../trading/wallet.js';

/**
 * 破产结算时额外统计的"这一世"行为数据，用来评定更有节目效果的死后称号。
 * 都是破产那一刻从库里现算的（Life 表里只有增量维护的基础统计）。
 */
export interface LifeExtras {
  /** 任意连续 24 小时内主动下单最多的次数（止盈止损、强平单不算） */
  peakOrders24h: number;
  /** 被强平的仓位里用过的最高杠杆 */
  maxLiquidatedLeverage: Decimal | null;
  /** 最后一次兑换充值到破产隔了多少秒；这一世没充值过为 null */
  secondsSinceTopUp: number | null;
  /** 这一世兑换充值的总额 */
  totalTopUp: Decimal;
  /** 死扛到穿仓：持仓 10 分钟以上、最后被强平且穿仓的次数 */
  stubbornDeficits: number;
  /** 被强平后 60 秒内又下单的次数（上头了） */
  revengeTrades: number;
  /** 追加保证金的次数 */
  marginAdds: number;
  /** 开过的仓位数 / 设过止损的仓位数 / 交易过的市场数 */
  positionCount: number;
  stopLossCount: number;
  distinctMarkets: number;
}

export const NO_EXTRAS: LifeExtras = {
  peakOrders24h: 0,
  maxLiquidatedLeverage: null,
  secondsSinceTopUp: null,
  totalTopUp: ZERO,
  stubbornDeficits: 0,
  revengeTrades: 0,
  marginAdds: 0,
  positionCount: 0,
  stopLossCount: 0,
  distinctMarkets: 0,
};

const DAY_MS = 86_400_000;
const STUBBORN_HOLD_MS = 10 * 60_000;
const REVENGE_WINDOW_MS = 60_000;

export async function collectLifeExtras(tx: Tx, lifeId: string, endedAt: Date): Promise<LifeExtras> {
  const [orders, liquidations, positions, topUps, marginAdds] = await Promise.all([
    tx.order.findMany({ where: { lifeId, source: 'USER' }, select: { createdAt: true }, orderBy: { createdAt: 'asc' } }),
    tx.liquidation.findMany({
      where: { lifeId },
      select: { leverage: true, deficit: true, createdAt: true, position: { select: { openedAt: true } } },
    }),
    tx.position.findMany({ where: { lifeId }, select: { marketId: true, stopLossPrice: true } }),
    // 充值：兑换 / 外部接口入账（破产救济、初始资金是别的流水类型；兑回失败的退款不算充值）
    tx.ledgerEntry.findMany({
      where: { lifeId, type: 'EXTERNAL_DEPOSIT', OR: [{ memo: null }, { memo: { not: 'skylbot:refund' } }] },
      select: { amount: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    tx.ledgerEntry.count({ where: { lifeId, type: 'MARGIN_ADD' } }),
  ]);

  const orderTimes = orders.map((o) => o.createdAt.getTime());
  const lastTopUp = topUps.at(-1);

  return {
    peakOrders24h: peakInWindow(orderTimes, DAY_MS),
    maxLiquidatedLeverage: liquidations.reduce<Decimal | null>((max, l) => (max ? dmax(max, fromDb(l.leverage)) : fromDb(l.leverage)), null),
    secondsSinceTopUp: lastTopUp ? Math.max(0, Math.floor((endedAt.getTime() - lastTopUp.createdAt.getTime()) / 1000)) : null,
    totalTopUp: topUps.reduce((sum, e) => sum.plus(fromDb(e.amount)), ZERO),
    stubbornDeficits: liquidations.filter(
      (l) => fromDb(l.deficit).gt(0) && l.createdAt.getTime() - l.position.openedAt.getTime() >= STUBBORN_HOLD_MS,
    ).length,
    revengeTrades: liquidations.filter((l) => {
      const t = l.createdAt.getTime();
      return orderTimes.some((o) => o > t && o <= t + REVENGE_WINDOW_MS);
    }).length,
    marginAdds,
    positionCount: positions.length,
    stopLossCount: positions.filter((p) => p.stopLossPrice !== null).length,
    distinctMarkets: new Set(positions.map((p) => p.marketId)).size,
  };
}

/** 有序时间戳里，任意长度为 windowMs 的窗口最多包含几个点（双指针） */
export function peakInWindow(sortedTimes: number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < sortedTimes.length; end++) {
    while (sortedTimes[end]! - sortedTimes[start]! >= windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}
