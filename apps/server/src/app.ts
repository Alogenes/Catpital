import { PrismaClient } from '@prisma/client';
import { BankruptcyService } from './bankruptcy/bankruptcyService.js';
import { AdminService } from './admin/adminService.js';
import { Notifier } from './broadcast/notifier.js';
import type { EconomyConfig } from './config/env.js';
import type { Bus } from './infra/bus.js';
import { EconomyService } from './economy/economyService.js';
import { SkylbotClient, type SkylbotConfig } from './economy/skylbotClient.js';
import { SkylbotExchange } from './economy/skylbotExchange.js';
import { LeaderboardService } from './leaderboard/leaderboardService.js';
import { LeaderboardSettlement } from './leaderboard/settlement.js';
import { KeyedQueue } from './lib/keyedQueue.js';
import { EventScheduler } from './market/events/eventScheduler.js';
import { MarketRegistry } from './market/marketRegistry.js';
import { NetWorthSweeper } from './trading/netWorthSweeper.js';
import { OrderService } from './trading/orderService.js';
import { RiskEngine } from './trading/risk/riskEngine.js';
import { TradeExecutor } from './trading/tradeExecutor.js';
import { UserService } from './users/userService.js';

export type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/** 已下架的市场：启动时平掉残留持仓、退回挂单后标记 DELISTED（NVDA 已换成 EURUSD） */
export const RETIRED_MARKETS = ['NVDA'];

export interface CoreOptions {
  db: PrismaClient;
  bus: Bus;
  economy: EconomyConfig;
  log: Logger;
  clock?: () => Date;
  /** 与 Skylbot 的货币兑换；不传 = 关闭 */
  skylbot?: SkylbotConfig | SkylbotClient | null;
}

/**
 * 组合根：按依赖顺序装配全部核心服务（不含 HTTP / WS）。
 * main.ts 与集成测试共用，保证测试跑的就是生产装配。
 */
export function createCore({ db, bus, economy, log, clock = () => new Date(), skylbot = null }: CoreOptions) {
  const queue = new KeyedQueue();
  const notifier = new Notifier(bus, db);
  const markets = new MarketRegistry(db, queue, notifier, log, clock);
  const priceOf = (id: string) => markets.price(id);
  const executor = new TradeExecutor(db, priceOf);
  const risk = new RiskEngine(db, executor, markets, notifier, economy, log);
  markets.attachRisk(risk);
  const orders = new OrderService(db, markets, queue, executor, risk, notifier, clock);
  const events = new EventScheduler(db, markets, notifier, log, clock);
  const bankruptcy = new BankruptcyService(db, notifier, economy, clock);
  const users = new UserService(db, economy, clock);
  const sweeper = new NetWorthSweeper(db, priceOf, log, clock);
  const leaderboard = new LeaderboardService(db, priceOf, economy.LEADERBOARD_MIN_CAPITAL, clock);
  /** 外部货币划转（跨 Bot 充值 / 提现） */
  const bank = new EconomyService(db, users, notifier, clock);
  /** 榜单周期结算（cron；由 main.ts 按 LEADERBOARD_SETTLEMENT 决定是否启动） */
  const settlement = new LeaderboardSettlement(
    db,
    leaderboard,
    notifier,
    {
      minCapital: economy.LEADERBOARD_MIN_CAPITAL,
      rewards: { DAILY: economy.LEADERBOARD_REWARD_DAILY, WEEKLY: economy.LEADERBOARD_REWARD_WEEKLY, MONTHLY: economy.LEADERBOARD_REWARD_MONTHLY },
    },
    log,
    clock,
  );
  /** 临时管理面板：用户管理 */
  const admin = new AdminService(db, users, markets, risk, notifier, clock);
  /** Skylbot bolívares ⇄ Meow Coin 兑换 */
  const exchange = new SkylbotExchange(
    db,
    notifier,
    skylbot instanceof SkylbotClient ? skylbot : skylbot ? new SkylbotClient(skylbot) : null,
    log,
    clock,
  );
  let baselineTimer: NodeJS.Timeout | null = null;

  return {
    db,
    /** 统一时钟：测试里可控，HTTP 路由取“现在”也用它 */
    clock,
    bus,
    economy,
    queue,
    notifier,
    markets,
    executor,
    risk,
    orders,
    events,
    bankruptcy,
    users,
    sweeper,
    leaderboard,
    bank,
    settlement,
    admin,
    exchange,
    /** 加载市场与风控索引（不启动定时器） */
    async init() {
      await markets.load();
      await risk.load();
      for (const code of RETIRED_MARKETS) {
        const retired = await orders.retireMarket(code);
        if (!retired) continue;
        await markets.unregister(retired.marketId);
        log.info(retired, 'market retired');
      }
      await events.restoreOverrides();
      await leaderboard.ensureBaselines();
      await exchange.selfCheck();
    },
    /** 启动行情 tick、事件轮询、净值巡检 */
    async startEngines() {
      await markets.startAll();
      events.start();
      sweeper.start();
      // 每分钟补齐榜单周期基准（跨日/周/月时自动为新周期建基准）
      baselineTimer = setInterval(
        () => void leaderboard.ensureBaselines().catch((err) => log.error({ err }, 'leaderboard baseline failed')),
        60_000,
      );
    },
    async shutdown() {
      events.stop();
      sweeper.stop();
      if (baselineTimer) clearInterval(baselineTimer);
      settlement.stop();
      await markets.stopAll();
      await queue.drain();
    },
  };
}

export type Core = ReturnType<typeof createCore>;
