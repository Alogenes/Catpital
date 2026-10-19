import { CANDLE_INTERVALS, D, type Decimal, INTERVAL_MS, ZERO } from '@catpital/shared';
import type { Market, MarketEngineConfig, PrismaClient } from '@prisma/client';
import type { Notifier } from '../broadcast/notifier.js';
import { fromDb, fromDbOpt } from '../lib/dec.js';
import type { KeyedQueue } from '../lib/keyedQueue.js';
import { DecimalRng } from '../lib/random.js';
import type { RiskEngine } from '../trading/risk/riskEngine.js';
import { type MarketSnapshot, toMarketSnapshot } from '../trading/types.js';
import { CandleAggregator, type CandleState, bucketStart } from './candles/aggregator.js';
import { MarketEngine } from './marketEngine.js';
import { FallbackSource } from './sources/FallbackSource.js';
import { LiveSource } from './sources/LiveSource.js';
import type { PriceSource } from './sources/PriceSource.js';
import { ProceduralSource } from './sources/ProceduralSource.js';
import { createFeed } from './sources/adapters/registry.js';

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export function buildProceduralSource(m: Market, cfg: MarketEngineConfig, seed: string | number) {
  return new ProceduralSource(
    {
      initialPrice: fromDb(m.initialPrice),
      lastPrice: fromDb(m.lastPrice),
      tickSize: fromDb(m.tickSize),
      lotSize: fromDb(m.lotSize),
      tickIntervalMs: m.tickIntervalMs,
    },
    {
      drift: fromDb(cfg.drift),
      volatility: fromDb(cfg.volatility),
      meanReversionSpeed: fromDb(cfg.meanReversionSpeed),
      meanReversionTarget: fromDbOpt(cfg.meanReversionTarget),
      jumpIntensity: fromDb(cfg.jumpIntensity),
      jumpMean: fromDb(cfg.jumpMean),
      jumpStdDev: fromDb(cfg.jumpStdDev),
      baseVolume: fromDb(cfg.baseVolume),
      volumeVolCoupling: fromDb(cfg.volumeVolCoupling),
      timeScale: fromDb(cfg.timeScale),
      priceFloor: fromDb(cfg.priceFloor),
    },
    new DecimalRng(seed),
  );
}

/**
 * 外部行情市场断流时的程序随机参数（未在种子里配置 engine 时使用）：
 * 年化波动 80%、时间加速 10 倍、偶发小跳跃，不做均值回归（从断流时的价格自然游走）。
 */
function fallbackSimFor(m: Market, cfg: MarketEngineConfig | null) {
  return (from: Decimal) =>
    new ProceduralSource(
      { initialPrice: from, lastPrice: from, tickSize: fromDb(m.tickSize), lotSize: fromDb(m.lotSize), tickIntervalMs: m.tickIntervalMs },
      cfg
        ? {
            drift: fromDb(cfg.drift),
            volatility: fromDb(cfg.volatility),
            meanReversionSpeed: ZERO,
            meanReversionTarget: null,
            jumpIntensity: fromDb(cfg.jumpIntensity),
            jumpMean: fromDb(cfg.jumpMean),
            jumpStdDev: fromDb(cfg.jumpStdDev),
            baseVolume: fromDb(cfg.baseVolume),
            volumeVolCoupling: fromDb(cfg.volumeVolCoupling),
            timeScale: fromDb(cfg.timeScale),
            priceFloor: fromDb(cfg.priceFloor),
          }
        : {
            drift: ZERO,
            volatility: D('0.8'),
            meanReversionSpeed: ZERO,
            meanReversionTarget: null,
            jumpIntensity: D('50'),
            jumpMean: ZERO,
            jumpStdDev: D('0.01'),
            baseVolume: D('1'),
            volumeVolCoupling: D('1'),
            timeScale: D('10'),
            priceFloor: fromDb(m.tickSize),
          },
      new DecimalRng(`${m.code}:fallback:${Date.now()}`),
    );
}

/**
 * 所有市场的注册表：市场规格快照 + 行情引擎实例。
 * 同时实现 RiskEngine / OrderService 需要的 MarketLookup / MarketDirectory 接口。
 */
export class MarketRegistry {
  private snapshots = new Map<string, MarketSnapshot>();
  private codes = new Map<string, string>();
  private engines = new Map<string, MarketEngine>();
  private risk: RiskEngine | null = null;

  constructor(
    private readonly db: PrismaClient,
    private readonly queue: KeyedQueue,
    private readonly notifier: Notifier,
    private readonly log: Logger,
    private readonly clock?: () => Date,
  ) {}

  /** RiskEngine 依赖 MarketRegistry 作为查询接口，故延后注入 */
  attachRisk(risk: RiskEngine) {
    this.risk = risk;
  }

  get(marketId: string) {
    return this.snapshots.get(marketId);
  }

  byCode(code: string) {
    const id = this.codes.get(code.toUpperCase());
    return id ? this.snapshots.get(id) : undefined;
  }

  price(marketId: string): Decimal | undefined {
    return this.engines.get(marketId)?.price();
  }

  /** 外部行情市场当前是真实报价还是降级模拟；程序随机市场为 null */
  feedMode(marketId: string): 'live' | 'fallback' | null {
    return this.engines.get(marketId)?.feedMode() ?? null;
  }

  engine(marketId: string) {
    return this.engines.get(marketId);
  }

  list() {
    return [...this.snapshots.values()];
  }

  async load() {
    const markets = await this.db.market.findMany({
      where: { status: { not: 'DELISTED' } },
      include: { engineConfig: true },
      orderBy: { sortOrder: 'asc' },
    });
    for (const m of markets) {
      try {
        await this.register(m, m.engineConfig);
      } catch (err) {
        this.log.error({ err, market: m.code }, 'failed to register market');
      }
    }
  }

  /** sourceOverride：测试中注入可手动控制价格的数据源 */
  async register(m: Market, cfg: MarketEngineConfig | null, sourceOverride?: PriceSource) {
    if (!this.risk) throw new Error('attachRisk() must be called before load()');
    const snapshot = toMarketSnapshot(m);
    this.snapshots.set(m.id, snapshot);
    this.codes.set(m.code.toUpperCase(), m.id);

    let source: PriceSource;
    if (sourceOverride) {
      source = sourceOverride;
    } else if (m.dataSource === 'PROCEDURAL') {
      if (!cfg) throw new Error(`market ${m.code} has no engine config`);
      source = buildProceduralSource(m, cfg, `${m.code}:${Date.now()}`);
    } else {
      if (!m.adapterKey || !m.adapterSymbol) throw new Error(`market ${m.code} missing adapter config`);
      const feed = createFeed(m.adapterKey, { symbol: m.adapterSymbol });
      const live = new LiveSource(feed, { lastPrice: fromDb(m.lastPrice), tickSize: fromDb(m.tickSize) }, (err) =>
        this.log.warn({ err: err instanceof Error ? err.message : String(err), market: m.code }, 'live feed error'),
      );
      // 外部 API 超时 / 断流 / 限流时自动降级为程序随机行情，恢复后平滑切回
      source = new FallbackSource(live, fallbackSimFor(m, cfg), fromDb(m.tickSize), this.log, m.code);
    }

    const aggregator = new CandleAggregator(CANDLE_INTERVALS, await this.restoreCandles(m.id));
    const engine = new MarketEngine(snapshot, m.tickIntervalMs, source, aggregator, {
      db: this.db,
      queue: this.queue,
      notifier: this.notifier,
      risk: this.risk,
      log: this.log,
      clock: this.clock,
    }, cfg && m.dataSource === 'PROCEDURAL'
      ? {
          liquidity: fromDb(cfg.impactLiquidity),
          cap: fromDb(cfg.impactCap),
          exponent: fromDb(cfg.impactExponent),
          volBoost: fromDb(cfg.impactVolBoost),
          decaySec: cfg.impactDecaySec,
        }
      : undefined);
    this.engines.set(m.id, engine);
    return engine;
  }

  /** 重启后恢复"当前周期"未收盘的 K 线，避免同一根 K 线被拆成两根 */
  private async restoreCandles(marketId: string): Promise<CandleState[]> {
    const now = (this.clock?.() ?? new Date()).getTime();
    const out: CandleState[] = [];
    for (const interval of CANDLE_INTERVALS) {
      const start = bucketStart(now, interval);
      const c = await this.db.candle.findUnique({
        where: { marketId_interval_openTime: { marketId, interval, openTime: new Date(start) } },
      });
      if (c && now - start < INTERVAL_MS[interval]) {
        out.push({
          interval,
          openTime: start,
          open: fromDb(c.open),
          high: fromDb(c.high),
          low: fromDb(c.low),
          close: fromDb(c.close),
          volume: fromDb(c.volume),
          tradeCount: c.tradeCount,
        });
      }
    }
    return out;
  }

  /** 后台修改了市场参数（费率、杠杆上限、状态等）后刷新快照 */
  async refresh(marketId: string) {
    const m = await this.db.market.findUnique({ where: { id: marketId } });
    if (!m) return;
    const snap = toMarketSnapshot(m);
    this.snapshots.set(m.id, snap);
    const engine = this.engines.get(m.id);
    if (engine) engine.market = snap;
  }

  async startAll() {
    for (const [id, e] of this.engines) {
      try {
        await e.start();
      } catch (err) {
        this.log.error({ err, market: this.snapshots.get(id)?.code }, 'failed to start market engine');
      }
    }
  }

  async stopAll() {
    await Promise.all([...this.engines.values()].map((e) => e.stop()));
  }
}
