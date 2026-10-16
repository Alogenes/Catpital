import { D, type Decimal, ZERO, roundNeutral } from '../decimal.js';

// -----------------------------------------------------------------------------
// 【公式 4】防刷周期收益率（Modified Dietz）
//
//   R = (V1 − (V0 + F)) / (V0 + F_w) × 100%
//
//   V0    期初总净值（周期内新注册用户 V0 = 0，初始资金作为外部流计入 F）
//   V1    期末总净值
//   F     Σ f_i                         周期内外部净转入（充值+、提现−、破产抹债+、救济金+、管理员调整±）
//   F_w   Σ f_i · w_i                   时间加权外部净转入
//   w_i   (T1 − t_i) / (T1 − T0)        资金在周期内"在场"的时间占比，∈ [0, 1]
//
//   上榜资格（防小资金刷榜）：
//     V0 >= MIN_CAPITAL                 期初本金门槛（需求原文）
//     且 V0 + F_w >= MIN_CAPITAL        平均投入资本门槛（防"期初 0、期末临时充值"绕过）
//   分母 <= 0 时一律不上榜。
//
//   时间以毫秒整数（bigint）计算，权重本身用 Decimal，不经过浮点。
// -----------------------------------------------------------------------------

export interface ExternalFlow {
  amount: Decimal;
  at: Date;
}

export const flowWeight = (at: Date, start: Date, end: Date): Decimal => {
  const total = BigInt(end.getTime() - start.getTime());
  if (total <= 0n) throw new RangeError('period end must be after start');
  let remaining = BigInt(end.getTime() - at.getTime());
  if (remaining < 0n) remaining = 0n;
  if (remaining > total) remaining = total;
  return D(remaining).div(D(total));
};

export interface PeriodReturnInput {
  startNetWorth: Decimal;
  endNetWorth: Decimal;
  periodStart: Date;
  periodEnd: Date;
  flows: ExternalFlow[];
  minCapital: Decimal;
}

export interface PeriodReturnResult {
  netExternalFlow: Decimal;
  weightedExternalFlow: Decimal;
  denominator: Decimal;
  /** 百分比数值，如 12.5 表示 12.5%；不上榜时为 null */
  returnPct: Decimal | null;
  eligible: boolean;
}

export function periodReturn(input: PeriodReturnInput): PeriodReturnResult {
  const { startNetWorth: V0, endNetWorth: V1, periodStart, periodEnd, minCapital } = input;
  let F = ZERO;
  let Fw = ZERO;
  for (const f of input.flows) {
    F = F.plus(f.amount);
    Fw = Fw.plus(f.amount.mul(flowWeight(f.at, periodStart, periodEnd)));
  }
  const denominator = V0.plus(Fw);
  const eligible = V0.gte(minCapital) && denominator.gte(minCapital) && denominator.gt(0);
  const returnPct = eligible ? roundNeutral(V1.minus(V0.plus(F)).div(denominator).mul(100)) : null;
  return { netExternalFlow: F, weightedExternalFlow: Fw, denominator, returnPct, eligible };
}

/** 增量维护：每发生一笔外部资金流，在 LeaderboardPeriodStat 上累加的两个量 */
export function accumulateFlow(flow: ExternalFlow, periodStart: Date, periodEnd: Date) {
  return { net: flow.amount, weighted: flow.amount.mul(flowWeight(flow.at, periodStart, periodEnd)) };
}
