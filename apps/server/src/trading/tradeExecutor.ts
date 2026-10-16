import {
  type Decimal,
  type FillResult,
  type LiquidationSettlement,
  type OrderSide,
  ZERO,
  applyFill,
  dmax,
  notional,
  settleLiquidation,
} from '@catpital/shared';
import type { Liquidation, Order, OrderSource, Position, Prisma, PrismaClient } from '@prisma/client';
import { fromDb, toDb, toDbOpt } from '../lib/dec.js';
import { bumpExtremes, computeNetWorth, getActiveLife, lifeUpdateFromFill } from './lifeStats.js';
import type { MarketSnapshot } from './types.js';
import { type LedgerLine, type Tx, type WalletState, lockWallet, postLedger } from './wallet.js';

export interface FillRequest {
  userId: string;
  market: MarketSnapshot;
  side: OrderSide;
  quantity: Decimal;
  price: Decimal;
  leverage: Decimal;
  reduceOnly: boolean;
  liquidity: 'MAKER' | 'TAKER';
  source: OrderSource;
  now: Date;
  clientOrderId?: string;
  /** 成交一张已挂出的限价单 */
  pendingOrderId?: string;
  /** 新开仓位时一并设置的止盈止损（同向加仓时若提供则覆盖） */
  takeProfitPrice?: Decimal | null;
  stopLossPrice?: Decimal | null;
  /** 用户主动单校验最小名义价值；TP/SL 平仓单不校验 */
  enforceMinNotional: boolean;
}

export interface FillOutcome {
  status: 'FILLED' | 'REJECTED';
  reason?: string;
  order: Order;
  fill?: FillResult;
  /** 本次被完全平掉（含翻仓）的旧仓位 */
  closedPosition: Position | null;
  /** 成交后的当前持仓 */
  position: Position | null;
  wallet: WalletState;
}

export interface LiquidationOutcome {
  liquidation: Liquidation;
  position: Position;
  order: Order;
  settlement: LiquidationSettlement;
  wallet: WalletState;
  openPositionCount: number;
  pendingOrderCount: number;
}

type PriceOf = (marketId: string) => Decimal | undefined;

/**
 * 交易执行器：所有改变持仓 / 余额的操作都在这里以单个数据库事务完成。
 * 调用方（OrderService / RiskEngine）负责：按市场串行排队、更新内存风控索引、推送通知。
 *
 * 事务内固定加锁顺序：Wallet 行（FOR UPDATE）→ Position → Order → Life，杜绝死锁。
 */
export class TradeExecutor {
  constructor(
    private readonly db: PrismaClient,
    private readonly priceOf: PriceOf,
  ) {}

  async executeFill(req: FillRequest): Promise<FillOutcome> {
    return this.db.$transaction(async (tx) => {
      let wallet = await lockWallet(tx, req.userId);
      const life = await getActiveLife(tx, req.userId);
      const openKey = `${req.userId}:${req.market.id}`;
      const pos = await tx.position.findUnique({ where: { openKey } });
      const pending = req.pendingOrderId ? await tx.order.findUnique({ where: { id: req.pendingOrderId } }) : null;
      if (req.pendingOrderId && (!pending || pending.status !== 'PENDING')) {
        throw new Error(`order ${req.pendingOrderId} is not pending`);
      }
      const unlock = pending ? fromDb(pending.lockedAmount) : ZERO;
      const feeRate = req.liquidity === 'MAKER' ? req.market.makerFeeRate : req.market.takerFeeRate;

      const reject = async (reason: string): Promise<FillOutcome> => {
        if (pending) {
          wallet = await postLedger(tx, wallet, life.id, [
            { type: 'ORDER_UNLOCK', amount: unlock, marketId: req.market.id, orderId: pending.id },
          ], req.now);
        }
        const order = pending
          ? await tx.order.update({ where: { id: pending.id }, data: { status: 'REJECTED', rejectReason: reason, lockedAmount: '0' } })
          : await tx.order.create({ data: this.orderBase(req, life.id, 'REJECTED', reason) });
        return { status: 'REJECTED', reason, order, closedPosition: null, position: pos, wallet };
      };

      // ---- 1. 纯函数计算（合并 / 抵扣 / 翻仓）----
      if (req.reduceOnly && (!pos || pos.side === (req.side === 'BUY' ? 'LONG' : 'SHORT'))) {
        return reject('error.nothingToReduce');
      }
      const state = pos
        ? { side: pos.side, quantity: fromDb(pos.quantity), entryPrice: fromDb(pos.entryPrice), margin: fromDb(pos.margin) }
        : null;
      const fill = applyFill(
        state,
        { orderSide: req.side, quantity: req.quantity, price: req.price, leverage: req.leverage, feeRate, reduceOnly: req.reduceOnly },
        req.market,
      );

      // ---- 2. 资金与规格校验 ----
      if (fill.openedQuantity.gt(0)) {
        if (req.enforceMinNotional && notional(fill.openedQuantity, req.price).lt(req.market.minNotional)) {
          return reject('error.belowMinNotional');
        }
        // 负债玩家：平仓收益先抵债，抵完仍不足则不允许开新仓
        const available = wallet.balance.plus(unlock).plus(fill.closeSettlement);
        if (available.lt(fill.requiredFunds)) return reject('error.insufficientFunds');
      }

      // ---- 3. 记账 ----
      const orderId = pending?.id ?? undefined;
      const lines: LedgerLine[] = [
        { type: 'ORDER_UNLOCK', amount: unlock, marketId: req.market.id, orderId },
        { type: 'MARGIN_RELEASE', amount: fill.releasedMargin, marketId: req.market.id, positionId: pos?.id, orderId },
        { type: 'REALIZED_PNL', amount: fill.realizedPnl, marketId: req.market.id, positionId: pos?.id, orderId },
        { type: 'TRADING_FEE', amount: fill.totalFee.neg(), marketId: req.market.id, orderId },
        { type: 'MARGIN_LOCK', amount: fill.openMargin.neg(), marketId: req.market.id, orderId },
      ];

      // ---- 4. 持仓落库 ----
      const next = fill.position;
      const continuing = Boolean(pos && next && next.side === pos.side);
      let closedPosition: Position | null = null;
      let position: Position | null = null;
      let heldSeconds: number | undefined;

      if (pos && continuing && next) {
        const isAdd = fill.openedQuantity.gt(0);
        position = await tx.position.update({
          where: { id: pos.id, version: pos.version },
          data: {
            quantity: toDb(next.quantity),
            entryPrice: toDb(next.entryPrice),
            margin: toDb(next.margin),
            leverage: toDb(next.leverage),
            liquidationPrice: toDb(next.liquidationPrice),
            realizedPnl: toDb(fromDb(pos.realizedPnl).plus(fill.realizedPnl)),
            feesPaid: toDb(fromDb(pos.feesPaid).plus(fill.totalFee)),
            peakQuantity: toDb(dmax(fromDb(pos.peakQuantity), next.quantity)),
            ...(isAdd && req.takeProfitPrice !== undefined ? { takeProfitPrice: toDbOpt(req.takeProfitPrice) } : {}),
            ...(isAdd && req.stopLossPrice !== undefined ? { stopLossPrice: toDbOpt(req.stopLossPrice) } : {}),
            version: { increment: 1 },
          },
        });
      } else {
        if (pos) {
          heldSeconds = (req.now.getTime() - pos.openedAt.getTime()) / 1000;
          closedPosition = await tx.position.update({
            where: { id: pos.id, version: pos.version },
            data: {
              status: 'CLOSED',
              openKey: null,
              exitPrice: toDb(req.price),
              closedAt: req.now,
              realizedPnl: toDb(fromDb(pos.realizedPnl).plus(fill.realizedPnl)),
              feesPaid: toDb(fromDb(pos.feesPaid).plus(fill.closeFee)),
              version: { increment: 1 },
            },
          });
        }
        if (next) {
          position = await tx.position.create({
            data: {
              userId: req.userId,
              marketId: req.market.id,
              lifeId: life.id,
              openKey,
              side: next.side,
              quantity: toDb(next.quantity),
              entryPrice: toDb(next.entryPrice),
              margin: toDb(next.margin),
              leverage: toDb(next.leverage),
              liquidationPrice: toDb(next.liquidationPrice),
              takeProfitPrice: toDbOpt(req.takeProfitPrice ?? null),
              stopLossPrice: toDbOpt(req.stopLossPrice ?? null),
              feesPaid: toDb(fill.openFee),
              peakQuantity: toDb(next.quantity),
              openedAt: req.now,
            },
          });
        }
      }

      // ---- 5. 订单 ----
      const orderData = {
        status: 'FILLED' as const,
        positionId: position?.id ?? closedPosition?.id ?? null,
        fillPrice: toDb(req.price),
        closedQuantity: toDb(fill.closedQuantity),
        openedQuantity: toDb(fill.openedQuantity),
        liquidity: req.liquidity,
        feeRate: toDb(feeRate),
        fee: toDb(fill.totalFee),
        realizedPnl: fill.closedQuantity.gt(0) ? toDb(fill.realizedPnl.minus(fill.closeFee)) : null,
        realizedRoe: toDbOpt(fill.realizedRoe),
        lockedAmount: '0',
        filledAt: req.now,
      };
      const order = pending
        ? await tx.order.update({ where: { id: pending.id }, data: orderData })
        : await tx.order.create({ data: { ...this.orderBase(req, life.id, 'FILLED'), ...orderData } });
      for (const l of lines) l.orderId = order.id;

      wallet = await postLedger(tx, wallet, life.id, lines.map((l) => ({ ...l, positionId: l.positionId ?? position?.id })), req.now);

      // ---- 6. 人生履历统计 + 巅峰净值 ----
      const nw = await computeNetWorth(tx, wallet, this.priceOf);
      await tx.life.update({
        where: { id: life.id },
        data: lifeUpdateFromFill(life, {
            notional: notional(fill.closedQuantity.plus(fill.openedQuantity), req.price),
            fee: fill.totalFee,
            realizedPnl: fill.realizedPnl,
            close: fill.closedQuantity.gt(0) ? { netPnl: fill.realizedPnl.minus(fill.closeFee), roe: fill.realizedRoe } : undefined,
            open: fill.openedQuantity.gt(0)
              ? { notional: notional(fill.openedQuantity, req.price), leverage: req.leverage, side: next!.side }
              : undefined,
            heldSeconds,
        }),
      });
      await bumpExtremes(tx, life.id, nw, req.now);

      return { status: 'FILLED', order, fill, closedPosition, position, wallet };
    });
  }

  /**
   * 强平（斩杀）。无穿仓保护：以触发时刻真实最新价成交，
   * 结算额 S = M + PnL − Fee 为负时，D = −S 直接从可用余额倒扣，余额可为负。
   */
  async liquidate(
    positionId: string,
    executionPrice: Decimal,
    market: MarketSnapshot,
    now: Date,
    scheduledEventId?: string,
  ): Promise<LiquidationOutcome | null> {
    return this.db.$transaction(async (tx) => {
      const peek = await tx.position.findUnique({ where: { id: positionId }, select: { userId: true } });
      if (!peek) return null;
      let wallet = await lockWallet(tx, peek.userId);
      const pos = await tx.position.findUnique({ where: { id: positionId } });
      if (!pos || pos.status !== 'OPEN') return null;
      const life = await getActiveLife(tx, pos.userId);

      const state = { side: pos.side, quantity: fromDb(pos.quantity), entryPrice: fromDb(pos.entryPrice), margin: fromDb(pos.margin) };
      const feeRate = market.takerFeeRate.plus(market.liquidationFeeRate);
      const s = settleLiquidation(state, executionPrice, feeRate, wallet.balance);

      const order = await tx.order.create({
        data: {
          userId: pos.userId,
          marketId: pos.marketId,
          lifeId: life.id,
          positionId: pos.id,
          side: pos.side === 'LONG' ? 'SELL' : 'BUY',
          type: 'MARKET',
          source: 'LIQUIDATION',
          status: 'FILLED',
          reduceOnly: true,
          leverage: pos.leverage,
          quantity: pos.quantity,
          fillPrice: toDb(executionPrice),
          closedQuantity: pos.quantity,
          liquidity: 'TAKER',
          feeRate: toDb(feeRate),
          fee: toDb(s.fee),
          realizedPnl: toDb(s.realizedPnl.minus(s.fee)),
          realizedRoe: toDb(s.realizedPnl.minus(s.fee).div(state.margin)),
          filledAt: now,
        },
      });

      // 流水拆分：REALIZED_PNL 为保证金可覆盖部分，LIQUIDATION_DEFICIT 为超出保证金、从本金倒扣部分
      const ref = { marketId: pos.marketId, positionId: pos.id, orderId: order.id };
      const lines: LedgerLine[] = [
        { type: 'MARGIN_RELEASE', amount: state.margin, ...ref },
        { type: 'TRADING_FEE', amount: s.fee.neg(), ...ref },
      ];
      if (s.deficit.gt(0)) {
        lines.push({ type: 'REALIZED_PNL', amount: s.realizedPnl.plus(s.deficit), ...ref });
        lines.push({ type: 'LIQUIDATION_DEFICIT', amount: s.deficit.neg(), memo: 'no-negative-balance-protection: off', ...ref });
      } else {
        lines.push({ type: 'REALIZED_PNL', amount: s.realizedPnl, ...ref });
      }
      wallet = await postLedger(tx, wallet, life.id, lines, now);
      if (!wallet.balance.eq(s.balanceAfter)) throw new Error('invariant violated: liquidation balance mismatch');

      const position = await tx.position.update({
        where: { id: pos.id, version: pos.version },
        data: {
          status: 'LIQUIDATED',
          openKey: null,
          exitPrice: toDb(executionPrice),
          closedAt: now,
          realizedPnl: toDb(fromDb(pos.realizedPnl).plus(s.realizedPnl)),
          feesPaid: toDb(fromDb(pos.feesPaid).plus(s.fee)),
          version: { increment: 1 },
        },
      });

      const liquidation = await tx.liquidation.create({
        data: {
          positionId: pos.id,
          userId: pos.userId,
          marketId: pos.marketId,
          lifeId: life.id,
          side: pos.side,
          quantity: pos.quantity,
          entryPrice: pos.entryPrice,
          margin: pos.margin,
          leverage: pos.leverage,
          liquidationPrice: pos.liquidationPrice,
          executionPrice: toDb(executionPrice),
          realizedPnl: toDb(s.realizedPnl),
          fee: toDb(s.fee),
          settlement: toDb(s.settlement),
          deficit: toDb(s.deficit),
          totalLoss: toDb(s.totalLoss),
          balanceBefore: toDb(s.balanceBefore),
          balanceAfter: toDb(s.balanceAfter),
          scheduledEventId: scheduledEventId ?? null,
          createdAt: now,
        },
      });

      const nw = await computeNetWorth(tx, wallet, this.priceOf);
      await tx.life.update({
        where: { id: life.id },
        data: lifeUpdateFromFill(life, {
            notional: notional(state.quantity, executionPrice),
            fee: s.fee,
            realizedPnl: s.realizedPnl,
            close: { netPnl: s.realizedPnl.minus(s.fee), roe: s.realizedPnl.minus(s.fee).div(state.margin) },
            heldSeconds: (now.getTime() - pos.openedAt.getTime()) / 1000,
            liquidation: { totalLoss: s.totalLoss, deficit: s.deficit, marketId: pos.marketId },
        }),
      });
      await bumpExtremes(tx, life.id, nw, now);

      const [openPositionCount, pendingOrderCount] = await Promise.all([
        tx.position.count({ where: { userId: pos.userId, status: 'OPEN' } }),
        tx.order.count({ where: { userId: pos.userId, status: 'PENDING' } }),
      ]);

      return { liquidation, position, order, settlement: s, wallet, openPositionCount, pendingOrderCount };
    });
  }

  private orderBase(req: FillRequest, lifeId: string, status: 'FILLED' | 'REJECTED', reason?: string) {
    return {
      userId: req.userId,
      marketId: req.market.id,
      lifeId,
      clientOrderId: req.clientOrderId ?? null,
      side: req.side,
      type: 'MARKET' as const,
      source: req.source,
      status,
      reduceOnly: req.reduceOnly,
      leverage: toDb(req.leverage),
      quantity: toDb(req.quantity),
      rejectReason: reason ?? null,
      createdAt: req.now,
    } satisfies Prisma.OrderUncheckedCreateInput;
  }
}

export type { Tx };
