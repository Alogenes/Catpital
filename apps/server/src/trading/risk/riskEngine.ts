import { type Decimal, type OrderSide, checkTrigger, toWire } from '@catpital/shared';
import type { Order, Position, PrismaClient } from '@prisma/client';
import type { EconomyConfig } from '../../config/env.js';
import type { Notifier } from '../../broadcast/notifier.js';
import { fromDb, fromDbOpt, wire } from '../../lib/dec.js';
import type { FillOutcome, LiquidationOutcome, TradeExecutor } from '../tradeExecutor.js';
import { type MarketSnapshot, type PositionEntry, toPositionEntry, toPositionView } from '../types.js';
import { TriggerBook } from './triggerBook.js';

export interface MarketLookup {
  get(marketId: string): MarketSnapshot | undefined;
  price(marketId: string): Decimal | undefined;
}

interface LimitEntry {
  id: string;
  userId: string;
  marketId: string;
  side: OrderSide;
  quantity: Decimal;
  limitPrice: Decimal;
  leverage: Decimal;
  reduceOnly: boolean;
  takeProfitPrice: Decimal | null;
  stopLossPrice: Decimal | null;
}

export interface PriceContext {
  scheduledEventId?: string;
}

type Logger = { error: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };

/**
 * 风控引擎：维护每个市场的触发索引，每个 tick 由 MarketEngine 在该市场的串行队列中调用 onPrice()。
 *
 * 同一 tick 内处理顺序：
 *   1. 持仓触发 —— 每个仓位按 强平 > 止损 > 止盈 取最高优先级的一项执行（checkTrigger）
 *   2. 限价挂单撮合（以挂单价、Maker 费率成交）
 * 所有成交价均为触发时刻真实最新价（限价单除外）。
 */
export class RiskEngine {
  private books = new Map<string, TriggerBook>();
  private positions = new Map<string, PositionEntry>();
  private limits = new Map<string, LimitEntry>();

  constructor(
    private readonly db: PrismaClient,
    private readonly executor: TradeExecutor,
    private readonly markets: MarketLookup,
    private readonly notifier: Notifier,
    private readonly economy: EconomyConfig,
    private readonly log: Logger,
  ) {}

  private book(marketId: string) {
    let b = this.books.get(marketId);
    if (!b) {
      b = new TriggerBook();
      this.books.set(marketId, b);
    }
    return b;
  }

  /** 启动时从数据库加载全部 OPEN 持仓与 PENDING 限价单 */
  async load() {
    const [positions, orders] = await Promise.all([
      this.db.position.findMany({ where: { status: 'OPEN' } }),
      this.db.order.findMany({ where: { status: 'PENDING', type: 'LIMIT' } }),
    ]);
    for (const p of positions) this.trackPosition(p);
    for (const o of orders) this.trackLimitOrder(o);
    this.log.info({ positions: positions.length, limitOrders: orders.length }, 'risk engine loaded');
  }

  // ---------------------------------------------------------------------------
  // 索引维护
  // ---------------------------------------------------------------------------

  trackPosition(p: Position) {
    if (p.status !== 'OPEN') return this.untrackPosition(p.id, p.marketId);
    const e = toPositionEntry(p);
    this.positions.set(e.id, e);
    const book = this.book(e.marketId);
    const long = e.side === 'LONG';
    if (long && e.liquidationPrice.lte(0)) book.delete(`${e.id}:LIQ`);
    else book.set(`${e.id}:LIQ`, long ? 'below' : 'above', e.liquidationPrice);
    if (e.stopLossPrice) book.set(`${e.id}:SL`, long ? 'below' : 'above', e.stopLossPrice);
    else book.delete(`${e.id}:SL`);
    if (e.takeProfitPrice) book.set(`${e.id}:TP`, long ? 'above' : 'below', e.takeProfitPrice);
    else book.delete(`${e.id}:TP`);
  }

  untrackPosition(positionId: string, marketId: string) {
    this.positions.delete(positionId);
    const book = this.book(marketId);
    for (const k of ['LIQ', 'SL', 'TP']) book.delete(`${positionId}:${k}`);
  }

  trackLimitOrder(o: Order) {
    if (o.status !== 'PENDING' || o.type !== 'LIMIT' || !o.limitPrice) return this.untrackOrder(o.id, o.marketId);
    const e: LimitEntry = {
      id: o.id,
      userId: o.userId,
      marketId: o.marketId,
      side: o.side,
      quantity: fromDb(o.quantity),
      limitPrice: fromDb(o.limitPrice),
      leverage: fromDb(o.leverage),
      reduceOnly: o.reduceOnly,
      takeProfitPrice: fromDbOpt(o.takeProfitPrice),
      stopLossPrice: fromDbOpt(o.stopLossPrice),
    };
    this.limits.set(o.id, e);
    this.book(o.marketId).set(`order:${o.id}`, e.side === 'BUY' ? 'below' : 'above', e.limitPrice);
  }

  untrackOrder(orderId: string, marketId: string) {
    this.limits.delete(orderId);
    this.book(marketId).delete(`order:${orderId}`);
  }

  getPosition(positionId: string) {
    return this.positions.get(positionId);
  }

  stats() {
    return { positions: this.positions.size, limitOrders: this.limits.size };
  }

  // ---------------------------------------------------------------------------
  // 每 tick 调用（已处于该市场串行队列中）
  // ---------------------------------------------------------------------------

  async onPrice(marketId: string, price: Decimal, now: Date, ctx: PriceContext = {}) {
    const market = this.markets.get(marketId);
    if (!market) return;
    const keys = this.book(marketId).collect(price);
    if (keys.length === 0) return;

    const positionIds = new Set<string>();
    const orderIds: string[] = [];
    for (const k of keys) {
      if (k.startsWith('order:')) orderIds.push(k.slice(6));
      else positionIds.add(k.slice(0, k.lastIndexOf(':')));
    }

    for (const id of positionIds) {
      const entry = this.positions.get(id);
      if (!entry) continue;
      const kind = checkTrigger(entry, price);
      try {
        if (kind === 'LIQUIDATION') {
          const out = await this.executor.liquidate(id, price, market, now, ctx.scheduledEventId);
          if (out) await this.afterLiquidation(out, market);
          else this.untrackPosition(id, marketId);
        } else if (kind === 'STOP_LOSS' || kind === 'TAKE_PROFIT') {
          const out = await this.executor.executeFill({
            userId: entry.userId,
            market,
            side: entry.side === 'LONG' ? 'SELL' : 'BUY',
            quantity: entry.quantity,
            price,
            leverage: entry.leverage,
            reduceOnly: true,
            liquidity: 'TAKER',
            source: kind,
            now,
            enforceMinNotional: false,
          });
          await this.afterFill(out, market);
        }
      } catch (err) {
        this.log.error({ err, positionId: id, kind }, 'risk execution failed; will retry next tick');
      }
    }

    for (const id of orderIds) {
      const o = this.limits.get(id);
      if (!o) continue;
      try {
        const out = await this.executor.executeFill({
          userId: o.userId,
          market,
          side: o.side,
          quantity: o.quantity,
          price: o.limitPrice,
          leverage: o.leverage,
          reduceOnly: o.reduceOnly,
          liquidity: 'MAKER',
          source: 'USER',
          now,
          pendingOrderId: o.id,
          takeProfitPrice: o.takeProfitPrice,
          stopLossPrice: o.stopLossPrice,
          enforceMinNotional: false,
        });
        await this.afterFill(out, market);
      } catch (err) {
        this.log.error({ err, orderId: id }, 'limit order execution failed; untracked');
        this.untrackOrder(id, marketId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 成交后处理：同步索引 + 推送 + 播报
  // ---------------------------------------------------------------------------

  async afterFill(out: FillOutcome, market: MarketSnapshot) {
    const { order } = out;
    if (order.type === 'LIMIT') this.untrackOrder(order.id, market.id);
    if (out.closedPosition) this.untrackPosition(out.closedPosition.id, market.id);
    if (out.position) this.trackPosition(out.position);

    const userId = order.userId;
    this.notifier.user(userId, {
      type: 'order',
      orderId: order.id,
      market: market.code,
      status: order.status,
      source: order.source,
      fillPrice: order.fillPrice ? wire(fromDb(order.fillPrice)) : undefined,
      realizedPnl: order.realizedPnl ? wire(fromDb(order.realizedPnl)) : undefined,
      realizedRoe: order.realizedRoe ? wire(fromDb(order.realizedRoe)) : undefined,
      reason: out.reason,
    });
    if (out.status !== 'FILLED' || !out.fill) {
      if (order.type === 'LIMIT') this.notifier.wallet(userId, out.wallet);
      return;
    }
    this.notifier.user(userId, {
      type: 'position',
      market: market.code,
      position: out.position ? toPositionView(out.position, market.code) : null,
    });
    this.notifier.wallet(userId, out.wallet);

    const f = out.fill;
    if (f.closedQuantity.gt(0)) {
      const netPnl = f.realizedPnl.minus(f.closeFee);
      const roe = f.realizedRoe;
      if (netPnl.gt(0) && ((roe && roe.gte(this.economy.BIG_WIN_ROE_THRESHOLD)) || netPnl.gte(this.economy.BIG_WIN_PNL_THRESHOLD))) {
        await this.notifier.broadcast(
          'BIG_WIN',
          'broadcast.bigWin',
          { market: market.code, pnl: toWire(netPnl), roe: roe ? toWire(roe.mul(100)) : '0', source: order.source },
          { userId, marketId: market.id, market: market.code },
        );
      }
      if (!out.position && out.wallet.balance.lte(this.economy.BANKRUPTCY_DUST_THRESHOLD)) {
        await this.checkBankruptcyAvailable(userId);
      }
    }
  }

  async afterLiquidation(out: LiquidationOutcome, market: MarketSnapshot) {
    const { liquidation: l, settlement: s } = out;
    this.untrackPosition(out.position.id, market.id);
    this.notifier.user(l.userId, {
      type: 'liquidated',
      market: market.code,
      positionId: l.positionId,
      executionPrice: wire(s.executionPrice),
      liquidationPrice: wire(fromDb(l.liquidationPrice)),
      deficit: wire(s.deficit),
      totalLoss: wire(s.totalLoss),
      balanceAfter: wire(s.balanceAfter),
    });
    this.notifier.user(l.userId, { type: 'position', market: market.code, position: null });
    this.notifier.wallet(l.userId, out.wallet);

    const isDeficit = s.deficit.gt(0) && s.deficit.gte(this.economy.DEFICIT_BROADCAST_THRESHOLD);
    await this.notifier.broadcast(
      isDeficit ? 'DEFICIT' : 'LIQUIDATION',
      isDeficit ? 'broadcast.deficit' : 'broadcast.liquidation',
      {
        market: market.code,
        side: l.side,
        leverage: wire(fromDb(l.leverage)),
        liquidationPrice: wire(fromDb(l.liquidationPrice)),
        executionPrice: wire(s.executionPrice),
        totalLoss: wire(s.totalLoss),
        deficit: wire(s.deficit),
        balanceAfter: wire(s.balanceAfter),
      },
      { userId: l.userId, marketId: market.id, market: market.code },
    );

    if (
      out.openPositionCount === 0 &&
      out.pendingOrderCount === 0 &&
      out.wallet.balance.lte(this.economy.BANKRUPTCY_DUST_THRESHOLD)
    ) {
      this.notifier.user(l.userId, { type: 'bankruptcyAvailable', available: true });
    }
  }

  private async checkBankruptcyAvailable(userId: string) {
    const [open, pending] = await Promise.all([
      this.db.position.count({ where: { userId, status: 'OPEN' } }),
      this.db.order.count({ where: { userId, status: 'PENDING' } }),
    ]);
    if (open === 0 && pending === 0) this.notifier.user(userId, { type: 'bankruptcyAvailable', available: true });
  }
}
