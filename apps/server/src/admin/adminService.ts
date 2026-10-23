import { type Decimal, ZERO, netWorth } from '@catpital/shared';
import type { Position, PrismaClient } from '@prisma/client';
import type { Notifier } from '../broadcast/notifier.js';
import { fromDb, toDb, wire } from '../lib/dec.js';
import type { MarketRegistry } from '../market/marketRegistry.js';
import { getActiveLife } from '../trading/lifeStats.js';
import type { RiskEngine } from '../trading/risk/riskEngine.js';
import { TradeError, toPositionView } from '../trading/types.js';
import { lockWallet, postLedger } from '../trading/wallet.js';
import type { UserService } from '../users/userService.js';

/** 外部行情市场（BTC）无法真正改价：改价是一层冲击，这么久之后回到真实价格 */
const LIVE_PRICE_OVERRIDE_SEC = 600;

/**
 * 管理面板的用户管理。资金调整一律记 ADMIN_ADJUST 流水（外部资金流），
 * 所以加钱 / 扣钱不会影响收益率榜，只影响富豪榜。
 */
export class AdminService {
  constructor(
    private readonly db: PrismaClient,
    private readonly users: UserService,
    private readonly markets: MarketRegistry,
    private readonly risk: RiskEngine,
    private readonly notifier: Notifier,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** 管理面板的市场列表：现价、初始价、均值回归锚点与力度（看得出这个市场会不会被拉回去） */
  async listMarkets() {
    const rows = await this.db.market.findMany({ orderBy: { sortOrder: 'asc' }, include: { engineConfig: true } });
    return rows.map((m) => ({
      code: m.code,
      name: m.name,
      nameI18n: m.nameI18n,
      dataSource: m.dataSource,
      status: m.status,
      tickSize: wire(fromDb(m.tickSize)),
      price: wire(this.markets.price(m.id) ?? fromDb(m.lastPrice)),
      initialPrice: wire(fromDb(m.initialPrice)),
      anchor: m.engineConfig ? wire(fromDb(m.engineConfig.meanReversionTarget ?? m.initialPrice)) : null,
      reversionSpeed: m.engineConfig ? wire(fromDb(m.engineConfig.meanReversionSpeed)) : null,
      feed: this.markets.feedMode(m.id),
    }));
  }

  /**
   * 直接定价。anchor = true 时（仅程序随机市场）同时把均值回归锚点改成新价格并写库，
   * 重启后仍然生效（种子数据不会覆盖已设置的锚点）。外部行情市场的改价 10 分钟内回落到真实价。
   */
  async setMarketPrice(code: string, price: Decimal, anchor: boolean) {
    const snap = this.markets.byCode(code);
    const engine = snap && this.markets.engine(snap.id);
    if (!snap || !engine) throw new TradeError('error.marketNotFound', 404);
    if (price.lt(snap.tickSize)) throw new TradeError('error.invalidPrice', 400);
    const live = this.markets.feedMode(snap.id) !== null;
    const [before, after] = await engine.setPrice(price, live ? LIVE_PRICE_OVERRIDE_SEC : 0);
    let anchored = false;
    if (anchor && engine.setAnchor(after)) {
      await this.db.marketEngineConfig.update({ where: { marketId: snap.id }, data: { meanReversionTarget: toDb(after) } });
      anchored = true;
    }
    return { code: snap.code, before: wire(before), after: wire(after), anchored, revertsInSec: live ? LIVE_PRICE_OVERRIDE_SEC : null };
  }

  /**
   * 清除市场历史：
   *   candles → 删除全部 K 线（图表从现价重新开始画）
   *   news    → 删除已结束 / 已取消的事件（快讯里不再出现）；进行中和待触发的事件还在影响行情，保留
   * 在线玩家会收到 history:<市场> 消息，自动重新加载图表 / 清空快讯。
   */
  async clearMarketHistory(code: string, what: { candles: boolean; news: boolean }) {
    const snap = this.markets.byCode(code);
    const engine = snap && this.markets.engine(snap.id);
    if (!snap || !engine) throw new TradeError('error.marketNotFound', 404);
    const candlesDeleted = what.candles ? await engine.clearCandles() : 0;
    const newsDeleted = what.news
      ? (await this.db.scheduledEvent.deleteMany({ where: { marketId: snap.id, status: { in: ['COMPLETED', 'CANCELLED'] } } })).count
      : 0;
    this.notifier.historyReset({ market: snap.code, candles: what.candles, news: what.news });
    return { code: snap.code, candlesDeleted, newsDeleted };
  }

  private netWorthOf(balance: Decimal, locked: Decimal, positions: Position[]) {
    return netWorth({
      balance,
      locked,
      positions: positions.map((p) => ({
        side: p.side,
        quantity: fromDb(p.quantity),
        entryPrice: fromDb(p.entryPrice),
        margin: fromDb(p.margin),
        markPrice: this.markets.price(p.marketId) ?? fromDb(p.entryPrice),
      })),
    });
  }

  async listUsers(q: string, limit = 50) {
    const rows = await this.db.user.findMany({
      where: q
        ? { OR: [{ id: { contains: q } }, { username: { contains: q, mode: 'insensitive' } }, { globalName: { contains: q, mode: 'insensitive' } }] }
        : {},
      orderBy: { lastSeenAt: 'desc' },
      take: limit,
      include: { wallet: true, positions: { where: { status: 'OPEN' } } },
    });
    return rows.map((u) => {
      const balance = u.wallet ? fromDb(u.wallet.balance) : ZERO;
      const locked = u.wallet ? fromDb(u.wallet.locked) : ZERO;
      return {
        id: u.id,
        username: u.username,
        globalName: u.globalName,
        generation: u.generation,
        isAdmin: u.isAdmin,
        balance: wire(balance),
        netWorth: wire(this.netWorthOf(balance, locked, u.positions)),
        openPositions: u.positions.length,
        lastSeenAt: u.lastSeenAt.getTime(),
      };
    });
  }

  async getUser(id: string) {
    const u = await this.db.user.findUnique({
      where: { id },
      include: {
        wallet: true,
        positions: { where: { status: 'OPEN' }, include: { market: { select: { code: true } } } },
        orders: { where: { status: 'PENDING' }, include: { market: { select: { code: true } } } },
        ledger: { orderBy: { id: 'desc' }, take: 30 },
      },
    });
    if (!u || !u.wallet) throw new TradeError('error.userNotFound', 404);
    const balance = fromDb(u.wallet.balance);
    const locked = fromDb(u.wallet.locked);
    return {
      id: u.id,
      username: u.username,
      globalName: u.globalName,
      generation: u.generation,
      isAdmin: u.isAdmin,
      createdAt: u.createdAt.getTime(),
      lastSeenAt: u.lastSeenAt.getTime(),
      wallet: { balance: wire(balance), locked: wire(locked), netWorth: wire(this.netWorthOf(balance, locked, u.positions)) },
      positions: u.positions.map((p) => ({ ...toPositionView(p, p.market.code), markPrice: wire(this.markets.price(p.marketId) ?? fromDb(p.entryPrice)) })),
      orders: u.orders.map((o) => ({
        id: o.id,
        market: o.market.code,
        side: o.side,
        type: o.type,
        quantity: wire(fromDb(o.quantity)),
        limitPrice: o.limitPrice ? wire(fromDb(o.limitPrice)) : null,
        leverage: wire(fromDb(o.leverage)),
      })),
      ledger: u.ledger.map((l) => ({
        id: l.id.toString(),
        type: l.type,
        amount: wire(fromDb(l.amount)),
        balanceAfter: wire(fromDb(l.balanceAfter)),
        memo: l.memo,
        at: l.createdAt.getTime(),
      })),
    };
  }

  async createUser(input: { id: string; username: string; balance?: Decimal }, adminId: string) {
    const exists = await this.db.user.findUnique({ where: { id: input.id }, select: { id: true } });
    if (exists) throw new TradeError('error.userExists', 409);
    await this.users.ensureUser({ id: input.id, username: input.username });
    if (input.balance) await this.adjustBalance(input.id, { setTo: input.balance }, adminId, 'panel:create');
    return this.getUser(input.id);
  }

  /** delta：加减；setTo：直接设为某个余额（记录差额） */
  async adjustBalance(userId: string, change: { delta?: Decimal; setTo?: Decimal }, adminId: string, memo?: string) {
    const now = this.clock();
    const wallet = await this.db.$transaction(async (tx) => {
      const w = await lockWallet(tx, userId).catch(() => {
        throw new TradeError('error.userNotFound', 404);
      });
      const amount = change.setTo ? change.setTo.minus(w.balance) : change.delta;
      if (!amount || amount.isZero()) return w;
      const life = await getActiveLife(tx, userId);
      return postLedger(tx, w, life.id, [{ type: 'ADMIN_ADJUST', amount, memo: memo ? `${memo} by ${adminId}` : `panel by ${adminId}` }], now);
    });
    this.notifier.wallet(userId, wallet);
    return { balance: wire(wallet.balance), locked: wire(wallet.locked) };
  }

  /** 删除玩家：先把持仓和挂单从风控索引里摘掉，再级联删除全部数据 */
  async deleteUser(userId: string) {
    const [positions, orders] = await Promise.all([
      this.db.position.findMany({ where: { userId, status: 'OPEN' }, select: { id: true, marketId: true } }),
      this.db.order.findMany({ where: { userId, status: 'PENDING' }, select: { id: true, marketId: true } }),
    ]);
    for (const p of positions) this.risk.untrackPosition(p.id, p.marketId);
    for (const o of orders) this.risk.untrackOrder(o.id, o.marketId);
    const { count } = await this.db.user.deleteMany({ where: { id: userId } });
    if (!count) throw new TradeError('error.userNotFound', 404);
  }
}
