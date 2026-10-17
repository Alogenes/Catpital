import { PrismaClient } from '@prisma/client';
import { BankruptcyService } from './bankruptcy/bankruptcyService.js';
import { AdminService } from './admin/adminService.js';
import { Notifier } from './broadcast/notifier.js';
import type { EconomyConfig } from './config/env.js';
import type { Bus } from './infra/bus.js';
import { EconomyService } from './economy/economyService.js';
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

export interface CoreOptions {
  db: PrismaClient;
  bus: Bus;
  economy: EconomyConfig;
  log: Logger;
  clock?: () => Date;
}

/**
 * 组合根：按依赖顺序装配全部核心服务（不含 HTTP / WS）。
 * main.ts 与集成测试共用，保证测试跑的就是生产装配。
 */
export function createCore({ db, bus, economy, log, clock = () => new Date() }: CoreOptions) {
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
  let baselineTimer: NodeJS.Timeout | null = null;

  return {
    db,
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
    /** 加载市场与风控索引（不启动定时器） */
    async init() {
      await markets.load();
      await risk.load();
      await events.restoreOverrides();
      await leaderboard.ensureBaselines();
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
