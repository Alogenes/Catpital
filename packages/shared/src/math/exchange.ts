import { D, type Decimal, type DecimalInput, ONE, roundPayout } from '../decimal.js';

// -----------------------------------------------------------------------------
// Skylbot 兑换手续费：Bolívares ⇄ Meow Coin 汇率 1:1，双向收 1%
//
//   到账 = 支付 × (1 − 0.01)，多出的小数直接截断（截掉的部分也归入手续费）
//   IN   支付 bolívares → 到账 Meow Coin，只保留 2 位小数（与界面显示的余额精度一致）
//   OUT  支付 Meow Coin → 到账 bolívares，Skylbot 只支持整数
//
// 服务端结算和商店里的预览共用这一个函数，玩家看到的就是实际到账的数。
// -----------------------------------------------------------------------------

/** 兑换手续费率（双向）：1% */
export const EXCHANGE_FEE_RATE = D('0.01');
/** Catpital 端 Meow Coin 到账保留的小数位 */
export const MEOW_DECIMALS = 2;

export interface ExchangeQuote {
  /** 玩家支付的数量 */
  paid: Decimal;
  /** 扣完手续费、截断小数后实际到账 */
  received: Decimal;
  /** paid − received：手续费 + 截掉的小数 */
  fee: Decimal;
}

export function exchangeQuote(direction: 'IN' | 'OUT', amount: DecimalInput): ExchangeQuote {
  const paid = D(amount);
  // 向玩家支付的钱一律向 0 截断（roundPayout）
  const received = roundPayout(paid.mul(ONE.minus(EXCHANGE_FEE_RATE)), direction === 'IN' ? MEOW_DECIMALS : 0);
  return { paid, received, fee: paid.minus(received) };
}
