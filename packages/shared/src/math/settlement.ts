import { type Decimal, ZERO, dmax, roundSigned } from '../decimal.js';
import { type PositionState, dir, tradingFee } from './position.js';

// -----------------------------------------------------------------------------
// 【公式 3】无穿仓保护的强平结算 —— 穿仓部分从总本金（可用余额）倒扣
//
//   执行价          P_x   = 触发时刻真实最新价（跳空时可能远远越过 P_liq）
//   已实现盈亏      PnL_x = s · (P_x − E) · Q
//   强平手续费      Fee_x = Q · P_x · (takerFeeRate + liquidationFeeRate)     （照收，可计入负债）
//   结算额          S     = M + PnL_x − Fee_x                                   （可为负）
//   穿仓额          D     = max(0, −S)
//   余额            B'    = B + S                    ⇔  S >= 0 时退还残余保证金；S < 0 时 B' = B − D
//   战役总亏损      Loss  = M − max(S, 0) + D        （= −S 当 S < 0；= M − S 当 S >= 0）
//
//   注意：开仓时 M 已从余额划出，因此这里是把 S 整体"加回"余额；
//         B' 可以为负，并且没有任何下限保护（巨额负债）。
// -----------------------------------------------------------------------------

export interface LiquidationSettlement {
  executionPrice: Decimal;
  realizedPnl: Decimal;
  fee: Decimal;
  settlement: Decimal;
  deficit: Decimal;
  totalLoss: Decimal;
  balanceBefore: Decimal;
  balanceAfter: Decimal;
}

export function settleLiquidation(
  pos: PositionState,
  executionPrice: Decimal,
  feeRate: Decimal,
  balanceBefore: Decimal,
): LiquidationSettlement {
  const realizedPnl = roundSigned(dir(pos.side).mul(executionPrice.minus(pos.entryPrice)).mul(pos.quantity));
  const fee = tradingFee(pos.quantity, executionPrice, feeRate);
  const settlement = pos.margin.plus(realizedPnl).minus(fee);
  const deficit = dmax(ZERO, settlement.neg());
  const totalLoss = pos.margin.minus(dmax(settlement, ZERO)).plus(deficit);
  return {
    executionPrice,
    realizedPnl,
    fee,
    settlement,
    deficit,
    totalLoss,
    balanceBefore,
    balanceAfter: balanceBefore.plus(settlement),
  };
}

// -----------------------------------------------------------------------------
// 总净值与个人破产
//
//   持仓净值      PV_i = M_i + uPnL_i(P_last)
//   总净值        NW   = B + B_locked + Σ PV_i
//
//   说明：需求原文"可用余额 + 持仓未实现盈亏"，但本系统开仓时保证金已从余额划出，
//         若不把 M_i 加回会低估净值，因此按上式计算（与富豪榜口径一致）。
//
//   破产资格：NW <= dust 且 无 OPEN 持仓 且 无 PENDING 挂单
//            （无持仓无挂单时 NW = B，即 B <= dust；dust 默认 0）
//   破产清算：抹债 W = max(0, −B)；救济 R；B' = B + W + R = R（当 B <= 0）
//            W 与 R 均作为"外部资金流"计入收益率公式，防止破产刷收益率。
// -----------------------------------------------------------------------------

export interface NetWorthInput {
  balance: Decimal;
  locked: Decimal;
  positions: Array<PositionState & { markPrice: Decimal }>;
}

export function netWorth({ balance, locked, positions }: NetWorthInput): Decimal {
  return positions.reduce(
    (acc, p) => acc.plus(p.margin).plus(dir(p.side).mul(p.markPrice.minus(p.entryPrice)).mul(p.quantity)),
    balance.plus(locked),
  );
}

export function canDeclareBankruptcy(input: {
  balance: Decimal;
  openPositionCount: number;
  pendingOrderCount: number;
  dustThreshold: Decimal;
}): boolean {
  return input.openPositionCount === 0 && input.pendingOrderCount === 0 && input.balance.lte(input.dustThreshold);
}

export function bankruptcySettlement(balance: Decimal, relief: Decimal) {
  const debtWrittenOff = dmax(ZERO, balance.neg());
  /** 余额为微小正数（dust）时直接清零再发救济 */
  const dustForfeited = dmax(ZERO, balance);
  return {
    debtWrittenOff,
    dustForfeited,
    reliefGranted: relief,
    balanceAfter: relief,
    /** 计入外部资金流的净额 = W − dust + R */
    externalFlow: debtWrittenOff.minus(dustForfeited).plus(relief),
  };
}
