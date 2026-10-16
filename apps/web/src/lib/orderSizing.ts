import { D, Decimal, type ImpactParams, ONE, ZERO, impactPct, maxOpenQuantity } from '@catpital/shared';

/**
 * "按投入本金下单"：玩家输入愿意花的钱（保证金 + 手续费），由这里换算成合约数量。
 * 数量向下对齐 lotSize，保证 保证金 + 手续费 ≤ 投入本金 —— 梭哈永远不会"余额不足"。
 */

/** 市价单滑点缓冲：按略高于最新价估算，避免下单到成交之间价格上跳导致资金不够 */
export const MARKET_PRICE_BUFFER = D('0.003');

export function sizeFromBudget(args: {
  budget: Decimal;
  price: Decimal;
  leverage: Decimal;
  feeRate: Decimal;
  lotSize: Decimal;
  buffer?: Decimal;
  /** 大单冲击参数：成交价会偏离到冲击中点，需要把这部分滑点也算进去 */
  impact?: ImpactParams | null;
}): Decimal {
  const { budget, price, leverage, feeRate, lotSize, buffer = ZERO, impact } = args;
  if (budget.lte(0) || price.lte(0)) return ZERO;
  const size = (slip: Decimal) => maxOpenQuantity(budget, price.mul(ONE.plus(slip)), leverage, feeRate, lotSize);
  const q0 = size(buffer);
  if (!impact || q0.isZero()) return q0;
  // 先按无冲击估一个数量，再按该数量的冲击中点重算：数量只会变小 → 冲击只会更小 → 结果安全
  const halfImpact = impactPct(q0.mul(price), 'BUY', impact).div(2);
  return size(buffer.plus(halfImpact));
}

/** 25% / 50% / 75% / 梭哈：按可用余额的比例，向下取到 0.01 */
export function budgetForPct(available: Decimal | string, pct: number): Decimal {
  const a = D(available);
  if (a.lte(0)) return ZERO;
  return a.mul(pct).div(100).toDecimalPlaces(2, Decimal.ROUND_DOWN);
}

export type LeverageTier = 'safe' | 'spicy' | 'degen';

/** 1–5x 稳健 · 6–49x 刺激 · 50x+ 赌狗 */
export function leverageTier(lev: number): LeverageTier {
  if (lev <= 5) return 'safe';
  if (lev < 50) return 'spicy';
  return 'degen';
}

export const TIER_COLOR: Record<LeverageTier, string> = {
  safe: '#3ddc97',
  spicy: '#ffd166',
  degen: '#ff4fa3',
};

/** 杠杆快捷档位：常用档 ∩ [1, 最大杠杆]，并保证最大值本身在列表里 */
export function leveragePresets(max: number): number[] {
  const presets = [1, 5, 10, 25, 50, 100, 150, 200].filter((v) => v <= max);
  if (!presets.includes(max)) presets.push(max);
  return presets;
}
