import { D, type Decimal, ONE, ZERO } from '@catpital/shared';
import { PrismaClient } from '@prisma/client';
import { inject } from 'vitest';
import { createCore } from '../../src/app.js';
import type { EconomyConfig } from '../../src/config/env.js';
import { MemoryBus, type TopicMap } from '../../src/infra/bus.js';
import type { PriceSource, Quote } from '../../src/market/sources/PriceSource.js';
import { seedMarkets } from '../../src/seed/seedMarkets.js';
import { fromDb } from '../../src/lib/dec.js';

/** 测试用数据源：价格完全由测试代码控制 */
export class ManualSource implements PriceSource {
  readonly kind = 'PROCEDURAL' as const;
  private next: Decimal | null = null;
  constructor(private price: Decimal) {}
  async start() {}
  async stop() {}
  set(p: Decimal | string) {
    this.next = D(p);
  }
  sample(): Quote | null {
    if (!this.next) return null;
    this.price = this.next;
    this.next = null;
    return { price: this.price, volume: ONE };
  }
  current() {
    return this.price;
  }
  applyGap(gap: Decimal) {
    this.price = this.price.mul(ONE.plus(gap)).toDecimalPlaces(2);
    return this.price;
  }
  setOverrides() {}
}

export const TEST_ECONOMY: EconomyConfig = {
  INITIAL_GRANT: D(10000),
  BANKRUPTCY_RELIEF: D(5000),
  BANKRUPTCY_DUST_THRESHOLD: ZERO,
  BIG_WIN_ROE_THRESHOLD: D(1),
  BIG_WIN_PNL_THRESHOLD: D(10000),
  DEFICIT_BROADCAST_THRESHOLD: ZERO,
  LEADERBOARD_MIN_CAPITAL: D(1000),
};

export const TEST_MARKET = {
  code: 'TEST',
  name: 'Test Corp',
  kind: 'STOCK',
  dataSource: 'PROCEDURAL',
  tradingHours: { timezone: 'UTC', sessions: [] },
  tickIntervalMs: 1000,
  tickSize: '0.01',
  lotSize: '0.01',
  minNotional: '1',
  maxLeverage: '100',
  maintenanceMarginRate: '0.005',
  makerFeeRate: '0.0005',
  takerFeeRate: '0.001',
  liquidationFeeRate: '0',
  initialPrice: '100',
  engine: { volatility: '0.5', baseVolume: '10', priceFloor: '0.01' },
};

const TABLES = [
  'leaderboard_period_stats',
  'ledger_entries',
  'liquidations',
  'orders',
  'positions',
  'bankruptcy_resumes',
  'lives',
  'wallets',
  'scheduled_events',
  'candles',
  'broadcasts',
  'market_engine_configs',
  'markets',
  'users',
];

export async function createHarness(markets: unknown[] = [TEST_MARKET]) {
  const db = new PrismaClient({ datasources: { db: { url: inject('databaseUrl') } } });
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await seedMarkets(db, markets);

  const bus = new MemoryBus();
  const messages: Array<TopicMap['ws']> = [];
  const botMessages: Array<TopicMap['bot']> = [];
  bus.subscribe('ws', (m) => messages.push(m));
  bus.subscribe('bot', (m) => botMessages.push(m));

  let now = new Date('2026-10-16T00:00:00Z');
  const clock = () => now;
  const silent = { info: () => {}, warn: () => {}, error: (o: unknown) => console.error(o) };
  const core = createCore({ db, bus, economy: TEST_ECONOMY, log: silent, clock });

  // 手动注册市场并注入可控数据源
  const sources = new Map<string, ManualSource>();
  core.markets.attachRisk(core.risk);
  for (const m of await db.market.findMany({ include: { engineConfig: true } })) {
    const src = new ManualSource(fromDb(m.lastPrice));
    sources.set(m.code, src);
    await core.markets.register(m, m.engineConfig, src);
  }
  await core.risk.load();

  const market = (code = 'TEST') => core.markets.byCode(code)!;

  return {
    db,
    bus,
    core,
    messages,
    botMessages,
    clock,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    setNow(d: Date) {
      now = d;
    },
    /** 设定新价格并跑一个 tick（含风控） */
    async tick(price: string, code = 'TEST') {
      sources.get(code)!.set(price);
      now = new Date(now.getTime() + 1000);
      const engine = core.markets.engine(market(code).id)!;
      await core.queue.run(market(code).id, () => engine.tick(now));
      await flushMicrotasks();
    },
    async user(id: string, name = `user${id}`) {
      return core.users.ensureUser({ id, username: name });
    },
    async wallet(userId: string) {
      const w = await db.wallet.findUniqueOrThrow({ where: { userId } });
      return { balance: fromDb(w.balance).toFixed(), locked: fromDb(w.locked).toFixed() };
    },
    async position(userId: string, code = 'TEST') {
      return db.position.findUnique({ where: { openKey: `${userId}:${market(code).id}` } });
    },
    /** 账本不变量：Σ 流水金额 == 可用余额（冻结通过 LOCK/UNLOCK 流水在两边搬运） */
    async assertLedgerInvariant(userId: string) {
      const entries = await db.ledgerEntry.findMany({ where: { userId } });
      const sum = entries.reduce((acc, e) => acc.plus(fromDb(e.amount)), ZERO);
      const w = await db.wallet.findUniqueOrThrow({ where: { userId } });
      return { ledgerSum: sum.toFixed(), balance: fromDb(w.balance).toFixed() };
    },
    async close() {
      await core.shutdown();
      await db.$disconnect();
    },
  };
}

export const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));
export type Harness = Awaited<ReturnType<typeof createHarness>>;
