import {
  type Decimal,
  type OrderSide,
  ONE,
  addMargin as addMarginCalc,
  applyFill,
  sideOfOrder,
  validateTpSl,
} from '@catpital/shared';
import type { Order, PrismaClient } from '@prisma/client';
import type { Notifier } from '../broadcast/notifier.js';
import { fromDb, fromDbOpt, toDb, toDbOpt } from '../lib/dec.js';
import type { KeyedQueue } from '../lib/keyedQueue.js';
import { isMarketOpen } from '../lib/tradingHours.js';
import { getActiveLife } from './lifeStats.js';
import type { RiskEngine } from './risk/riskEngine.js';
import type { FillOutcome, TradeExecutor } from './tradeExecutor.js';
import { type MarketSnapshot, TradeError, toPositionView } from './types.js';
import { lockWallet, postLedger } from './wallet.js';

export interface MarketDirectory {
  get(marketId: string): MarketSnapshot | undefined;
  byCode(code: string): MarketSnapshot | undefined;
  price(marketId: string): Decimal | undefined;
}

export interface PlaceOrderInput {
  market: string;
  side: OrderSide;
  type: 'MARKET' | 'LIMIT';
  quantity: Decimal;
  leverage: Decimal;
  limitPrice?: Decimal;
  reduceOnly?: boolean;
  clientOrderId?: string;
  takeProfitPrice?: Decimal | null;
  stopLossPrice?: Decimal | null;
}

export type PlaceOrderResult =
  | { kind: 'filled' | 'rejected'; order: Order; reason?: string }
  | { kind: 'resting'; order: Order }
  | { kind: 'duplicate'; order: Order };

const isMultipleOf = (v: Decimal, step: Decimal) => v.mod(step).isZero();

/**
 * 面向用户的交易入口。所有操作都进入对应市场的串行队列，
 * 与该市场的 tick / 强平 / 事件跳空严格串行，杜绝"边被强平边加保证金"之类的竞态。
 */
export class OrderService {
  constructor(
    private readonly db: PrismaClient,
    private readonly markets: MarketDirectory,
    private readonly queue: KeyedQueue,
    private readonly executor: TradeExecutor,
    private readonly risk: RiskEngine,
    private readonly notifier: Notifier,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private market(code: string) {
    const m = this.markets.byCode(code);
    if (!m || m.status === 'DELISTED') throw new TradeError('error.marketNotFound', 404);
    return m;
  }

  private lastPrice(m: MarketSnapshot) {
    const p = this.markets.price(m.id);
    if (!p) throw new TradeError('error.noPrice', 409);
    return p;
  }

  private validate(m: MarketSnapshot, input: PlaceOrderInput, refPrice: Decimal) {
    if (m.status !== 'ACTIVE') throw new TradeError('error.marketHalted');
    if (input.quantity.lte(0) || !isMultipleOf(input.quantity, m.lotSize)) throw new TradeError('error.invalidQuantity');
    if (input.leverage.lt(ONE) || input.leverage.gt(m.maxLeverage)) throw new TradeError('error.invalidLeverage');
    if (input.type === 'LIMIT') {
      if (!input.limitPrice || input.limitPrice.lte(0) || !isMultipleOf(input.limitPrice, m.tickSize)) {
        throw new TradeError('error.invalidPrice');
      }
    }
    const side = sideOfOrder(input.side);
    for (const p of [input.takeProfitPrice, input.stopLossPrice]) {
      if (p && (p.lte(0) || !isMultipleOf(p, m.tickSize))) throw new TradeError('error.invalidPrice');
    }
    // 斩杀线要成交后才知道，这里只校验方向（多：TP > 参考价 > SL；空相反）
    const long = side === 'LONG';
    const tp = input.takeProfitPrice;
    const sl = input.stopLossPrice;
    if (tp && (long ? tp.lte(refPrice) : tp.gte(refPrice))) throw new TradeError('error.tpWrongSide');
    if (sl && (long ? sl.gte(refPrice) : sl.lte(refPrice))) throw new TradeError('error.slWrongSide');
  }

  async placeOrder(userId: string, input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const m = this.market(input.market);
    if (input.clientOrderId) {
      const dup = await this.db.order.findUnique({ where: { userId_clientOrderId: { userId, clientOrderId: input.clientOrderId } } });
      if (dup) return { kind: 'duplicate', order: dup };
    }
    const last = this.lastPrice(m);
    this.validate(m, input, input.type === 'LIMIT' ? input.limitPrice! : last);

    return this.queue.run(m.id, async () => {
      const now = this.clock();
      const open = isMarketOpen(m.tradingHours, now);
      const price = this.lastPrice(m);
      const marketable =
        input.type === 'MARKET' ||
        (input.side === 'BUY' ? input.limitPrice!.gte(price) : input.limitPrice!.lte(price));

      if (marketable) {
        if (!open) throw new TradeError('error.marketClosed');
        const out = await this.executor.executeFill({
          userId,
          market: m,
          side: input.side,
          quantity: input.quantity,
          price,
          leverage: input.leverage,
          reduceOnly: input.reduceOnly ?? false,
          liquidity: 'TAKER',
          source: 'USER',
          now,
          clientOrderId: input.clientOrderId,
          takeProfitPrice: input.takeProfitPrice,
          stopLossPrice: input.stopLossPrice,
          enforceMinNotional: true,
        });
        await this.risk.afterFill(out, m);
        return this.toResult(out);
      }
      const order = await this.restLimitOrder(userId, m, input, now);
      this.risk.trackLimitOrder(order);
      return { kind: 'resting' as const, order };
    });
  }

  private toResult(out: FillOutcome): PlaceOrderResult {
    return out.status === 'FILLED'
      ? { kind: 'filled', order: out.order }
      : { kind: 'rejected', order: out.order, reason: out.reason };
  }

  /** 挂限价单：按挂单价、Maker 费率预估开仓部分所需资金并冻结 */
  private async restLimitOrder(userId: string, m: MarketSnapshot, input: PlaceOrderInput, now: Date) {
    const limitPrice = input.limitPrice!;
    const result = await this.db.$transaction(async (tx) => {
      let wallet = await lockWallet(tx, userId);
      const life = await getActiveLife(tx, userId);
      const pos = await tx.position.findUnique({ where: { openKey: `${userId}:${m.id}` } });
      if (input.reduceOnly && (!pos || pos.side === sideOfOrder(input.side))) throw new TradeError('error.nothingToReduce');
      const est = applyFill(
        pos ? { side: pos.side, quantity: fromDb(pos.quantity), entryPrice: fromDb(pos.entryPrice), margin: fromDb(pos.margin) } : null,
        { orderSide: input.side, quantity: input.quantity, price: limitPrice, leverage: input.leverage, feeRate: m.makerFeeRate, reduceOnly: input.reduceOnly ?? false },
        m,
      );
      if (est.openedQuantity.gt(0) && est.openedQuantity.mul(limitPrice).lt(m.minNotional)) throw new TradeError('error.belowMinNotional');
      // 冻结不计入平仓部分的预期收益（成交时价格/持仓可能已变化，保守处理）
      const lock = est.requiredFunds;
      if (lock.gt(0) && wallet.balance.lt(lock)) throw new TradeError('error.insufficientFunds');

      const created = await tx.order.create({
        data: {
          userId,
          marketId: m.id,
          lifeId: life.id,
          clientOrderId: input.clientOrderId ?? null,
          side: input.side,
          type: 'LIMIT',
          source: 'USER',
          status: 'PENDING',
          reduceOnly: input.reduceOnly ?? false,
          leverage: toDb(input.leverage),
          quantity: toDb(input.quantity),
          limitPrice: toDb(limitPrice),
          lockedAmount: toDb(lock),
          takeProfitPrice: toDbOpt(input.takeProfitPrice ?? null),
          stopLossPrice: toDbOpt(input.stopLossPrice ?? null),
          createdAt: now,
        },
      });
      wallet = await postLedger(tx, wallet, life.id, [
        { type: 'ORDER_LOCK', amount: lock.neg(), marketId: m.id, orderId: created.id },
      ]);
      return { created, wallet };
    });
    this.notifier.wallet(userId, result.wallet);
    const order = result.created;
    this.notifier.user(userId, { type: 'order', orderId: order.id, market: m.code, status: 'PENDING', source: 'USER' });
    return order;
  }

  async cancelOrder(userId: string, orderId: string) {
    const existing = await this.db.order.findUnique({ where: { id: orderId } });
    if (!existing || existing.userId !== userId) throw new TradeError('error.orderNotFound', 404);
    const m = this.markets.get(existing.marketId);
    if (!m) throw new TradeError('error.marketNotFound', 404);
    return this.queue.run(m.id, async () => {
      const { order, wallet } = await this.db.$transaction(async (tx) => {
        let wallet = await lockWallet(tx, userId);
        const o = await tx.order.findUnique({ where: { id: orderId } });
        if (!o || o.status !== 'PENDING') throw new TradeError('error.orderNotPending', 409);
        wallet = await postLedger(tx, wallet, o.lifeId, [
          { type: 'ORDER_UNLOCK', amount: fromDb(o.lockedAmount), marketId: o.marketId, orderId: o.id },
        ]);
        const order = await tx.order.update({ where: { id: o.id }, data: { status: 'CANCELLED', lockedAmount: '0' } });
        return { order, wallet };
      });
      this.notifier.wallet(userId, wallet);
      this.risk.untrackOrder(order.id, order.marketId);
      this.notifier.user(userId, { type: 'order', orderId: order.id, market: m.code, status: 'CANCELLED', source: 'USER' });
      return order;
    });
  }

  /** 市价平仓（全部或部分） */
  async closePosition(userId: string, marketCode: string, quantity?: Decimal) {
    const m = this.market(marketCode);
    const pos = await this.db.position.findUnique({ where: { openKey: `${userId}:${m.id}` } });
    if (!pos) throw new TradeError('error.noPosition', 404);
    const qty = quantity ?? fromDb(pos.quantity);
    return this.placeOrder(userId, {
      market: marketCode,
      side: pos.side === 'LONG' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: qty,
      leverage: ONE, // 只减仓单不开新仓，杠杆无意义
      reduceOnly: true,
    });
  }

  /** 设置 / 修改 / 清除止盈止损（undefined = 不变，null = 清除） */
  async setTpSl(userId: string, marketCode: string, tp: Decimal | null | undefined, sl: Decimal | null | undefined) {
    const m = this.market(marketCode);
    return this.queue.run(m.id, async () => {
      const pos = await this.db.position.findUnique({ where: { openKey: `${userId}:${m.id}` } });
      if (!pos) throw new TradeError('error.noPosition', 404);
      const effTp = tp === undefined ? fromDbOpt(pos.takeProfitPrice) : tp;
      const effSl = sl === undefined ? fromDbOpt(pos.stopLossPrice) : sl;
      for (const p of [effTp, effSl]) if (p && !isMultipleOf(p, m.tickSize)) throw new TradeError('error.invalidPrice');
      const code = validateTpSl(pos.side, this.lastPrice(m), fromDb(pos.liquidationPrice), effTp, effSl);
      if (code?.startsWith('error.')) throw new TradeError(code);
      const updated = await this.db.position.update({
        where: { id: pos.id, version: pos.version },
        data: { takeProfitPrice: toDbOpt(effTp), stopLossPrice: toDbOpt(effSl), version: { increment: 1 } },
      });
      this.risk.trackPosition(updated);
      this.notifier.user(userId, { type: 'position', market: m.code, position: toPositionView(updated, m.code) });
      return { position: updated, warning: code ?? undefined };
    });
  }

  /** 追加逐仓保证金：降低有效杠杆，斩杀线远离现价 */
  async addMargin(userId: string, marketCode: string, amount: Decimal) {
    const m = this.market(marketCode);
    if (amount.lte(0) || amount.decimalPlaces() > 8) throw new TradeError('error.invalidAmount');
    return this.queue.run(m.id, async () => {
      const result = await this.db.$transaction(async (tx) => {
        let wallet = await lockWallet(tx, userId);
        const pos = await tx.position.findUnique({ where: { openKey: `${userId}:${m.id}` } });
        if (!pos) throw new TradeError('error.noPosition', 404);
        if (wallet.balance.lt(amount)) throw new TradeError('error.insufficientFunds');
        const next = addMarginCalc(
          { side: pos.side, quantity: fromDb(pos.quantity), entryPrice: fromDb(pos.entryPrice), margin: fromDb(pos.margin) },
          amount,
          m,
        );
        wallet = await postLedger(tx, wallet, pos.lifeId, [
          { type: 'MARGIN_ADD', amount: amount.neg(), marketId: m.id, positionId: pos.id },
        ]);
        const position = await tx.position.update({
          where: { id: pos.id, version: pos.version },
          data: {
            margin: toDb(next.margin),
            leverage: toDb(next.leverage),
            liquidationPrice: toDb(next.liquidationPrice),
            addedMargin: toDb(fromDb(pos.addedMargin).plus(amount)),
            version: { increment: 1 },
          },
        });
        return { wallet, position };
      });
      this.risk.trackPosition(result.position);
      this.notifier.wallet(userId, result.wallet);
      this.notifier.user(userId, { type: 'position', market: m.code, position: toPositionView(result.position, m.code) });
      return result.position;
    });
  }
}
