import { type Decimal, ONE, ZERO, dmax, dmin, roundToStep } from '../decimal.js';
import type { OrderSide } from './position.js';

// -----------------------------------------------------------------------------
// 大单冲击（Price Impact）—— 仅程序随机市场
//
//   冲击比例    p = min((名义价值 / 流动性池) ^ k, cap) × s     s：买 +1 / 卖 −1
//              k < 1（默认 0.8）时冲击随单量次线性增长：小单几乎无感，巨鲸才明显撼动价格
//   本单成交价  P_fill = P × (1 + p/2)       ← 大单"吃"掉一路挂单，均价落在冲击中点
//   成交后价格  P'     = P × (1 + p)
//
//   成交价取中点而不是冲击前价格：否则"买入拉盘 → 立刻卖出"就能白赚 p，
//   取中点后一买一卖的往返 ≈ 0 收益，再扣两次手续费必亏，杜绝自拉自砸套利。
// -----------------------------------------------------------------------------

export interface ImpactParams {
  /** 流动性池：名义价值达到该值时冲击 100%（再被 cap 截断）；0 = 关闭冲击 */
  liquidity: Decimal;
  /** 单笔冲击上限，如 0.01 = ±1% */
  cap: Decimal;
  /** 非线性指数 k（缺省 1 = 线性） */
  exponent?: Decimal;
}

export interface ImpactQuote {
  /** 带符号冲击比例 */
  pct: Decimal;
  fillPrice: Decimal;
  newPrice: Decimal;
}

export function impactPct(notional: Decimal, side: OrderSide, p: ImpactParams): Decimal {
  if (p.liquidity.lte(0) || p.cap.lte(0) || notional.lte(0)) return ZERO;
  const ratio = notional.div(p.liquidity);
  const k = p.exponent && p.exponent.gt(0) ? p.exponent : ONE;
  const raw = dmin(k.eq(ONE) ? ratio : ratio.pow(k), p.cap);
  return side === 'BUY' ? raw : raw.neg();
}

export function impactQuote(price: Decimal, notional: Decimal, side: OrderSide, p: ImpactParams, tickSize: Decimal): ImpactQuote {
  const pct = impactPct(notional, side, p);
  const q = (k: Decimal) => dmax(tickSize, roundToStep(price.mul(k), tickSize, 'nearest'));
  return { pct, fillPrice: q(ONE.plus(pct.div(2))), newPrice: q(ONE.plus(pct)) };
}

// -----------------------------------------------------------------------------
// 解锁杠杆上限：初始保证金率 1/L 必须严格大于维持保证金率 mmr，
// 否则开仓瞬间就在斩杀线上（例如 mmr 0.5% 时 200x → 入场即强平）。
//   L_max = min(cap, ceil(1/mmr) − 1)
// -----------------------------------------------------------------------------
export const UNLOCKED_LEVERAGE_CAP = 200;

export function maxSafeLeverage(maintenanceMarginRate: Decimal, cap = UNLOCKED_LEVERAGE_CAP): number {
  if (maintenanceMarginRate.lte(0)) return cap;
  const limit = ONE.div(maintenanceMarginRate).ceil().minus(1);
  return Math.max(1, Math.min(cap, limit.toNumber()));
}

