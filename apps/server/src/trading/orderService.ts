import {
  D,
  type Decimal,
  type ImpactQuote,
  maxSafeLeverage,
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
  /** 大单冲击（仅程序随机市场的引擎实现） */
  engine?(marketId: string): ImpactEngine | undefined;
}

export interface ImpactEngine {
  impactQuote(notional: Decimal, side: OrderSide): ImpactQuote | null;
  commitImpact(q: ImpactQuote, volume: Decimal): Promise<Decimal>;
}

/** 冲击 ≥ 0.5% 时全服播报「大户拉盘 / 砸盘」 */
const WHALE_BROADCAST_PCT = D('0.005');

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

  /** 暂停交易时持仓冻结：不能改止盈止损、不能追加保证金（开平仓在 validate 里拦截） */
  private assertTradable(m: MarketSnapshot) {
    // 取最新快照：排在暂停操作之后执行的请求也要被拦住
    if ((this.markets.get(m.id) ?? m).status !== 'ACTIVE') throw new TradeError('error.marketHalted');
  }

  private lastPrice(m: MarketSnapshot) {
    const p = this.markets.price(m.id);
    if (!p) throw new TradeError('error.noPrice', 409);
    return p;
  }

  /**
   * 杠杆上限：默认为市场配置；玩家在设置里解锁后提升到 min(200, 安全上限)。
   * 安全上限保证 1/L > 维持保证金率，否则开仓瞬间就在斩杀线上。
   */
  private async leverageCap(userId: string, m: MarketSnapshot, requested: Decimal): Promise<Decimal> {
    if (requested.lte(m.maxLeverage)) return m.maxLeverage;
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { settings: true } });
    const unlocked = Boolean((user?.settings as { degenUnlock?: boolean } | null)?.degenUnlock);
    return unlocked ? D(maxSafeLeverage(m.maintenanceMarginRate)) : m.maxLeverage;
  }

  private validate(m: MarketSnapshot, input: PlaceOrderInput, refPrice: Decimal, maxLeverage: Decimal) {
    if (m.status !== 'ACTIVE') throw new TradeError('error.marketHalted');
    if (input.quantity.lte(0) || !isMultipleOf(input.quantity, m.lotSize)) throw new TradeError('error.invalidQuantity');
    if (input.leverage.lt(ONE) || input.leverage.gt(maxLeverage)) throw new TradeError('error.invalidLeverage');
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
    this.validate(m, input, input.type === 'LIMIT' ? input.limitPrice! : last, await this.leverageCap(userId, m, input.leverage));

    return this.queue.run(m.id, async () => {
      this.assertTradable(m);
      const now = this.clock();
      const open = isMarketOpen(m.tradingHours, now);
      const price = this.lastPrice(m);
      const marketable =
        input.type === 'MARKET' ||
        (input.side === 'BUY' ? input.limitPrice!.gte(price) : input.limitPrice!.lte(price));

      if (marketable) {
        if (!open) throw new TradeError('error.marketClosed');
        // 大单冲击：成交价落在冲击中点；可成交的限价单若中点越过限价，则不产生冲击
        const engine = this.markets.engine?.(m.id);
        let quote = engine?.impactQuote(input.quantity.mul(price), input.side) ?? null;
        if (
          quote &&
          input.type === 'LIMIT' &&
          (input.side === 'BUY' ? quote.fillPrice.gt(input.limitPrice!) : quote.fillPrice.lt(input.limitPrice!))
        ) {
          quote = null;
        }
        const out = await this.executor.executeFill({
          userId,
          market: m,
          side: input.side,
          quantity: input.quantity,
          price: quote?.fillPrice ?? price,
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
        // 只有玩家自己的市价成交会推动价格；TP/SL/强平不产生冲击，避免无限连锁
        if (out.status === 'FILLED' && quote && engine) {
          const filledQty = out.fill!.closedQuantity.plus(out.fill!.openedQuantity);
          const after = await engine.commitImpact(quote, filledQty);
          if (quote.pct.abs().gte(WHALE_BROADCAST_PCT)) {
            const pump = quote.pct.gt(0);
            await this.notifier.broadcast(
              'WHALE',
              pump ? 'broadcast.whalePump' : 'broadcast.whaleDump',
              {
                market: m.code,
                pct: quote.pct.mul(100).toDecimalPlaces(2).toFixed(),
                priceBefore: price.toFixed(),
                priceAfter: after.toFixed(),
              },
              { userId, marketId: m.id, market: m.code },
            );
          }
        }
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
      ], now);
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
        ], this.clock());
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

  /**
   * 下架市场（系统操作，如 NVDA 换成 EUR/USD）：撤掉全部挂单退回冻结资金，全部持仓按最新价平仓，最后标记 DELISTED。
   * 不受交易时段 / 暂停限制。幂等：市场已下架（启动时不会加载）就返回 null。
   */
  async retireMarket(code: string) {
    const m = this.markets.byCode(code);
    if (!m) return null;
    const pending = await this.db.order.findMany({ where: { marketId: m.id, status: 'PENDING' }, select: { id: true, userId: true } });
    for (const o of pending) await this.cancelOrder(o.userId, o.id);
    return this.queue.run(m.id, async () => {
      const now = this.clock();
      const price = this.markets.price(m.id) ?? fromDb((await this.db.market.findUniqueOrThrow({ where: { id: m.id } })).lastPrice);
      const positions = await this.db.position.findMany({ where: { marketId: m.id, status: 'OPEN' } });
      for (const pos of positions) {
        const out = await this.executor.executeFill({
          userId: pos.userId,
          market: m,
          side: pos.side === 'LONG' ? 'SELL' : 'BUY',
          quantity: fromDb(pos.quantity),
          price,
          leverage: ONE,
          reduceOnly: true,
          liquidity: 'TAKER',
          source: 'USER',
          now,
          enforceMinNotional: false,
        });
        await this.risk.afterFill(out, m);
      }
      await this.db.market.update({ where: { id: m.id }, data: { status: 'DELISTED' } });
      return { marketId: m.id, code: m.code, price: price.toFixed(), cancelledOrders: pending.length, closedPositions: positions.length };
    });
  }

  /** 设置 / 修改 / 清除止盈止损（undefined = 不变，null = 清除） */
  async setTpSl(userId: string, marketCode: string, tp: Decimal | null | undefined, sl: Decimal | null | undefined) {
    const m = this.market(marketCode);
    return this.queue.run(m.id, async () => {
      this.assertTradable(m);
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
      this.assertTradable(m);
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
        ], this.clock());
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
