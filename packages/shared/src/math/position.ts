import {
  type Decimal,
  ONE,
  ZERO,
  dmax,
  dmin,
  roundCharge,
  roundNeutral,
  roundPayout,
  roundSigned,
  roundToStep,
} from '../decimal.js';

/**
 * 线性合约（以平台货币计价）逐仓模型。
 *
 * 符号约定：
 *   Q   持仓数量 (> 0)          E   加权开仓均价         M   逐仓保证金
 *   L   杠杆                    P   成交价/最新价        s   方向：多 = +1，空 = −1
 *   mmr 维持保证金率            fr  手续费率
 *
 *   名义价值        N    = Q · P
 *   初始保证金      IM   = Q · P / L                         （ROUND_UP）
 *   手续费          Fee  = Q · P · fr                         （ROUND_UP）
 *   未实现盈亏      uPnL = s · (P − E) · Q
 *   仓位权益        Eq   = M + uPnL
 *   有效杠杆        L*   = Q · E / M
 */

export type PositionSide = 'LONG' | 'SHORT';
export type OrderSide = 'BUY' | 'SELL';

export interface PositionState {
  side: PositionSide;
  quantity: Decimal;
  entryPrice: Decimal;
  margin: Decimal;
}

export interface MarketRiskParams {
  maintenanceMarginRate: Decimal;
  tickSize: Decimal;
}

export const dir = (side: PositionSide): Decimal => (side === 'LONG' ? ONE : ONE.neg());
export const sideOfOrder = (side: OrderSide): PositionSide => (side === 'BUY' ? 'LONG' : 'SHORT');

export const notional = (qty: Decimal, price: Decimal) => qty.mul(price);

export const initialMargin = (qty: Decimal, price: Decimal, leverage: Decimal) =>
  roundCharge(qty.mul(price).div(leverage));

export const tradingFee = (qty: Decimal, price: Decimal, feeRate: Decimal) =>
  roundCharge(qty.mul(price).mul(feeRate));

export const unrealizedPnl = (pos: PositionState, mark: Decimal) =>
  dir(pos.side).mul(mark.minus(pos.entryPrice)).mul(pos.quantity);

export const positionEquity = (pos: PositionState, mark: Decimal) => pos.margin.plus(unrealizedPnl(pos, mark));

export const effectiveLeverage = (pos: PositionState) =>
  roundNeutral(pos.quantity.mul(pos.entryPrice).div(pos.margin));

// -----------------------------------------------------------------------------
// 【公式 2】逐仓强平斩杀线
//
//   触发条件：仓位权益 <= 维持保证金
//             M + s·(P − E)·Q  <=  mmr · P · Q
//
//   多仓 (s = +1)：M + (P − E)Q = mmr·P·Q
//                  ⇒  P_liq = (E·Q − M) / (Q · (1 − mmr))
//   空仓 (s = −1)：M − (P − E)Q = mmr·P·Q
//                  ⇒  P_liq = (E·Q + M) / (Q · (1 + mmr))
//
//   舍入：多仓向上取整到 tickSize、空仓向下取整（都使斩杀线略提前，对平台保守）；
//         多仓结果 <= 0 时记为 0（如 1x 现货：E·Q − M = 0，永不强平）。
// -----------------------------------------------------------------------------
export function liquidationPrice(pos: PositionState, risk: MarketRiskParams): Decimal {
  const { quantity: Q, entryPrice: E, margin: M } = pos;
  const mmr = risk.maintenanceMarginRate;
  if (pos.side === 'LONG') {
    const raw = E.mul(Q).minus(M).div(Q.mul(ONE.minus(mmr)));
    return raw.lte(0) ? ZERO : roundToStep(raw, risk.tickSize, 'up');
  }
  const raw = E.mul(Q).plus(M).div(Q.mul(ONE.plus(mmr)));
  return roundToStep(raw, risk.tickSize, 'down');
}

export function isLiquidatable(side: PositionSide, liqPrice: Decimal, last: Decimal): boolean {
  return side === 'LONG' ? liqPrice.gt(0) && last.lte(liqPrice) : last.gte(liqPrice);
}

// -----------------------------------------------------------------------------
// TP / SL 触发（同一 tick 内优先级：强平 > 止损 > 止盈）
// 均以"触发时刻真实最新价"成交，跳空时存在滑点。
// -----------------------------------------------------------------------------
export type TriggerKind = 'LIQUIDATION' | 'STOP_LOSS' | 'TAKE_PROFIT';

export function checkTrigger(
  pos: PositionState & { liquidationPrice: Decimal; takeProfitPrice?: Decimal | null; stopLossPrice?: Decimal | null },
  last: Decimal,
): TriggerKind | null {
  if (isLiquidatable(pos.side, pos.liquidationPrice, last)) return 'LIQUIDATION';
  const long = pos.side === 'LONG';
  if (pos.stopLossPrice && (long ? last.lte(pos.stopLossPrice) : last.gte(pos.stopLossPrice))) return 'STOP_LOSS';
  if (pos.takeProfitPrice && (long ? last.gte(pos.takeProfitPrice) : last.lte(pos.takeProfitPrice)))
    return 'TAKE_PROFIT';
  return null;
}

/** 设置 TP/SL 时的合法性校验，返回错误 i18n key；null 表示合法 */
export function validateTpSl(
  side: PositionSide,
  last: Decimal,
  liqPrice: Decimal,
  tp?: Decimal | null,
  sl?: Decimal | null,
): string | null {
  const long = side === 'LONG';
  if (tp && (long ? tp.lte(last) : tp.gte(last))) return 'error.tpWrongSide';
  if (sl && (long ? sl.gte(last) : sl.lte(last))) return 'error.slWrongSide';
  // 止损线越过斩杀线则永远先被斩杀 —— 允许设置但前端需警告，这里仅给出提示码
  if (sl && (long ? sl.lte(liqPrice) : sl.gte(liqPrice))) return 'warn.slBeyondLiquidation';
  return null;
}

// -----------------------------------------------------------------------------
// 【公式 1】同股市仓位合并 + 反向抵扣 —— 单笔成交对净持仓的作用（纯函数）
//
// 同向加仓（成交 q @ P，下单杠杆 L）：
//   Q' = Q + q
//   E' = (Q·E + q·P) / (Q + q)
//   M' = M + q·P / L
//   L* = Q'·E' / M'，并以 (Q', E', M') 重算 P_liq
//
// 反向成交 q：
//   平仓量 c = min(q, Q)
//   已实现盈亏 PnL_c = s · (P − E) · c
//   释放保证金 M_c   = M · c / Q              （按比例；全平时 = M，避免尾差）
//   剩余仓位：Q − c，E 不变，M − M_c，重算 P_liq
//   若 q > Q 且非 reduceOnly：剩余 r = q − Q 以下单杠杆反向开新仓
//
// 钱包变动（全部带符号累加到可用余额）：
//   ΔB = (M_c + PnL_c − Fee_close) − (IM_open + Fee_open)
// 平仓部分结算额 S_c = M_c + PnL_c − Fee_close 可能为负 → 即穿仓，规则与强平一致（见 settlement.ts）
// -----------------------------------------------------------------------------

export interface FillInput {
  orderSide: OrderSide;
  quantity: Decimal;
  price: Decimal;
  leverage: Decimal;
  feeRate: Decimal;
  reduceOnly: boolean;
}

export interface FillResult {
  /** 成交后的持仓；null = 已完全平仓 */
  position: (PositionState & { liquidationPrice: Decimal; leverage: Decimal }) | null;
  closedQuantity: Decimal;
  openedQuantity: Decimal;
  /** 被平掉部分 */
  realizedPnl: Decimal;
  releasedMargin: Decimal;
  closeFee: Decimal;
  /** 平仓结算额 S_c = M_c + PnL_c − Fee_close（可为负） */
  closeSettlement: Decimal;
  /** 平仓 ROE = S_c 相对 M_c 的净收益率 = (PnL_c − Fee_close) / M_c */
  realizedRoe: Decimal | null;
  /** 新开/加仓部分 */
  openMargin: Decimal;
  openFee: Decimal;
  /** 总手续费与钱包净变动 ΔB */
  totalFee: Decimal;
  walletDelta: Decimal;
  /** 开仓需要的可用资金（下单前校验：可用余额 >= requiredFunds） */
  requiredFunds: Decimal;
  /** 该笔成交是否使仓位翻转方向 */
  flipped: boolean;
}

export function applyFill(current: PositionState | null, fill: FillInput, risk: MarketRiskParams): FillResult {
  const { quantity: q, price: P, leverage: L, feeRate } = fill;
  if (q.lte(0)) throw new RangeError('quantity must be > 0');
  if (P.lte(0)) throw new RangeError('price must be > 0');
  if (L.lt(1)) throw new RangeError('leverage must be >= 1');

  const fillSide = sideOfOrder(fill.orderSide);
  let closedQuantity = ZERO;
  let realizedPnl = ZERO;
  let releasedMargin = ZERO;
  let closeFee = ZERO;
  let remaining = q;
  let base: PositionState | null = current;

  // ---- 反向：先抵扣平仓 ----
  if (current && current.side !== fillSide) {
    const c = dmin(q, current.quantity);
    closedQuantity = c;
    realizedPnl = roundSigned(dir(current.side).mul(P.minus(current.entryPrice)).mul(c));
    const full = c.eq(current.quantity);
    releasedMargin = full ? current.margin : roundPayout(current.margin.mul(c).div(current.quantity));
    closeFee = tradingFee(c, P, feeRate);
    remaining = q.minus(c);
    base = full
      ? null
      : { ...current, quantity: current.quantity.minus(c), margin: current.margin.minus(releasedMargin) };
  }

  if (fill.reduceOnly) {
    if (!current || current.side === fillSide) throw new RangeError('reduceOnly order has nothing to reduce');
    remaining = ZERO; // 只减仓：超出部分丢弃
  }

  // ---- 同向加仓 / 新开仓 ----
  let openMargin = ZERO;
  let openFee = ZERO;
  let openedQuantity = ZERO;
  let next: PositionState | null = base;
  if (remaining.gt(0)) {
    openedQuantity = remaining;
    openMargin = initialMargin(remaining, P, L);
    openFee = tradingFee(remaining, P, feeRate);
    if (base && base.side === fillSide) {
      const Qn = base.quantity.plus(remaining);
      next = {
        side: fillSide,
        quantity: Qn,
        entryPrice: roundNeutral(base.quantity.mul(base.entryPrice).plus(remaining.mul(P)).div(Qn)),
        margin: base.margin.plus(openMargin),
      };
    } else {
      next = { side: fillSide, quantity: remaining, entryPrice: P, margin: openMargin };
    }
  }

  const closeSettlement = releasedMargin.plus(realizedPnl).minus(closeFee);
  const totalFee = closeFee.plus(openFee);
  const walletDelta = closeSettlement.minus(openMargin).minus(openFee);

  return {
    position: next
      ? { ...next, leverage: effectiveLeverage(next), liquidationPrice: liquidationPrice(next, risk) }
      : null,
    closedQuantity,
    openedQuantity,
    realizedPnl,
    releasedMargin,
    closeFee,
    closeSettlement,
    realizedRoe: releasedMargin.gt(0) ? roundNeutral(realizedPnl.minus(closeFee).div(releasedMargin)) : null,
    openMargin,
    openFee,
    totalFee,
    walletDelta,
    requiredFunds: openMargin.plus(openFee),
    flipped: Boolean(current && next && current.side !== next.side),
  };
}

// -----------------------------------------------------------------------------
// 追加保证金：M' = M + ΔM，L* = Q·E/M'，重算 P_liq（多仓斩杀线下移 / 空仓上移）
// -----------------------------------------------------------------------------
export function addMargin(pos: PositionState, amount: Decimal, risk: MarketRiskParams) {
  if (amount.lte(0)) throw new RangeError('amount must be > 0');
  const next: PositionState = { ...pos, margin: pos.margin.plus(amount) };
  return { ...next, leverage: effectiveLeverage(next), liquidationPrice: liquidationPrice(next, risk) };
}

/** 最大可开数量（给前端下单面板预估）：q = B / (P/L + P·fr)，向下对齐 lotSize */
export function maxOpenQuantity(available: Decimal, price: Decimal, leverage: Decimal, feeRate: Decimal, lotSize: Decimal) {
  if (available.lte(0)) return ZERO;
  const perUnit = price.div(leverage).plus(price.mul(feeRate));
  return dmax(ZERO, roundToStep(available.div(perUnit), lotSize, 'down'));
}

