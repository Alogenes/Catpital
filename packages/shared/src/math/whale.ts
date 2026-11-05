import { D, type Decimal, ONE, ZERO, dmax, dmin, roundToStep } from '../decimal.js';
import type { OrderSide } from './position.js';

// -----------------------------------------------------------------------------
// 防巨鲸：分档杠杆 + 大资金滑点（服务端校验 / 成交与下单面板预览共用）
//
// 1) 分档杠杆：仓位越大，最高杠杆越低（与真实交易所的杠杆分档同理）。
//    按这一单成交后整个仓位的名义价值查表，和市场自己的杠杆上限（解锁后最高 200x）取较小值。
//    第一档不额外限制，所以解锁的超高杠杆只对小仓位（≤ 100 万名义价值，约 5000 本金开 200x）有效；
//    普通玩家 1–2 万本金开 100x 完全不受影响。
//
// 2) 大资金滑点：按这一单涉及的仓位保证金 M（已有持仓保证金 + 这一单新开的保证金）计算，
//      s = 0.05% × (M / 30 万)²，最多 3%
//    30 万 ≈ 0.05%、60 万 ≈ 0.2%、100 万 ≈ 0.56%、约 232 万封顶 3%；1 万本金只有 0.00006%，
//    四舍五入到最小价位后为 0。只让成交价变差，不推动行情；限价单按挂单价成交、强平不加滑点。
//    分档杠杆逼大仓位多押保证金，滑点再按保证金收"规模成本"，两者配合，大户没法靠超高杠杆无限滚雪球。
// -----------------------------------------------------------------------------

export interface LeverageTier {
  /** 名义价值上限（含）；null = 最后一档 */
  upTo: Decimal | null;
  /** 这一档的最高杠杆；null = 不额外限制（用市场上限） */
  maxLeverage: number | null;
}

export const LEVERAGE_TIERS: readonly LeverageTier[] = [
  { upTo: D(1_000_000), maxLeverage: null },
  { upTo: D(2_000_000), maxLeverage: 100 },
  { upTo: D(5_000_000), maxLeverage: 50 },
  { upTo: D(10_000_000), maxLeverage: 20 },
  { upTo: D(20_000_000), maxLeverage: 10 },
  { upTo: D(50_000_000), maxLeverage: 5 },
  { upTo: null, maxLeverage: 2 },
];

/** 名义价值所在档位的杠杆上限；null = 不额外限制 */
export function tierLeverageCap(notional: Decimal): number | null {
  const tier = LEVERAGE_TIERS.find((t) => t.upTo === null || notional.lte(t.upTo))!;
  return tier.maxLeverage;
}

/** 实际可用的最高杠杆 = min(市场上限, 分档上限) */
export function effectiveLeverageCap(marketCap: number, notional: Decimal): number {
  const tier = tierLeverageCap(notional);
  return tier === null ? marketCap : Math.min(marketCap, tier);
}

/**
 * 下单面板用：给定已有同向仓位名义价值和这一单的投入本金，最高能开多少倍。
 * 名义价值 ≈ 已有 + 本金 × 杠杆，从市场上限往下找第一个不超过所在档位上限的杠杆。
 */
export function maxLeverageForBudget(marketCap: number, budget: Decimal, existingNotional: Decimal = ZERO): number {
  for (let lev = marketCap; lev > 1; lev--) {
    if (lev <= effectiveLeverageCap(marketCap, existingNotional.plus(budget.mul(lev)))) return lev;
  }
  return 1;
}

export const WHALE_SLIPPAGE_REF_MARGIN = D(300_000);
export const WHALE_SLIPPAGE_REF_PCT = D('0.0005');
export const WHALE_SLIPPAGE_CAP = D('0.03');

/** 大资金滑点比例（正数，如 0.002 = 0.2%）；margin = 这一单涉及的仓位保证金 */
export function whaleSlippage(margin: Decimal): Decimal {
  if (margin.lte(0)) return ZERO;
  const ratio = margin.div(WHALE_SLIPPAGE_REF_MARGIN);
  return dmin(WHALE_SLIPPAGE_REF_PCT.mul(ratio.mul(ratio)), WHALE_SLIPPAGE_CAP);
}

/**
 * 把滑点加到成交价上：买得更贵、卖得更便宜，按最小价位四舍五入（极小的滑点舍入后为 0）。
 * worstPrice：可成交限价单的限价，滑点后的价格不会比它更差。
 */
export function slippedPrice(price: Decimal, side: OrderSide, slippage: Decimal, tickSize: Decimal, worstPrice?: Decimal | null): Decimal {
  if (slippage.lte(0)) return price;
  const k = side === 'BUY' ? ONE.plus(slippage) : ONE.minus(slippage);
  let p = dmax(tickSize, roundToStep(price.mul(k), tickSize, 'nearest'));
  if (worstPrice) p = side === 'BUY' ? dmin(p, dmax(price, worstPrice)) : dmax(p, dmin(price, worstPrice));
  return p;
}
