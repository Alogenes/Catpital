import { PrismaClient } from '@prisma/client';
import { BankruptcyService } from './bankruptcy/bankruptcyService.js';
import { Notifier } from './broadcast/notifier.js';
import type { EconomyConfig } from './config/env.js';
import type { Bus } from './infra/bus.js';
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
    /** 加载市场与风控索引（不启动定时器） */
    async init() {
      await markets.load();
      await risk.load();
      await events.restoreOverrides();
    },
    /** 启动行情 tick、事件轮询、净值巡检 */
    async startEngines() {
      await markets.startAll();
      events.start();
      sweeper.start();
    },
    async shutdown() {
      events.stop();
      sweeper.stop();
      await markets.stopAll();
      await queue.drain();
    },
  };
}

export type Core = ReturnType<typeof createCore>;
