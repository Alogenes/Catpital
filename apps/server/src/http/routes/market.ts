import { type DanmakuPayload, NEWS_RETENTION_MS, maxSafeLeverage } from '@catpital/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Core } from '../../app.js';
import { DANMAKU_HISTORY_CAP } from '../../broadcast/notifier.js';
import { fromDb, wire, wireOpt } from '../../lib/dec.js';
import { isMarketOpen } from '../../lib/tradingHours.js';
import { TradeError } from '../../trading/types.js';
import { candlesQuery } from '../schemas.js';

export const marketRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    app.get('/', async () => {
      const rows = await core.db.market.findMany({
        where: { status: { not: 'DELISTED' } },
        orderBy: { sortOrder: 'asc' },
        include: { engineConfig: true },
      });
      const now = new Date();
      return rows.map((m) => ({
        code: m.code,
        name: m.name,
        nameI18n: m.nameI18n,
        kind: m.kind,
        dataSource: m.dataSource,
        /** 外部行情市场：live = 真实报价，fallback = 外部源不可用、临时用程序随机行情；程序随机市场为 null */
        feed: core.markets.feedMode(m.id),
        status: m.status,
        open: isMarketOpen(m.tradingHours, now),
        tradingHours: m.tradingHours,
        price: wireOpt(core.markets.price(m.id)) ?? wire(fromDb(m.lastPrice)),
        initialPrice: wire(fromDb(m.initialPrice)),
        tickSize: wire(fromDb(m.tickSize)),
        lotSize: wire(fromDb(m.lotSize)),
        minNotional: wire(fromDb(m.minNotional)),
        maxLeverage: wire(fromDb(m.maxLeverage)),
        maintenanceMarginRate: wire(fromDb(m.maintenanceMarginRate)),
        makerFeeRate: wire(fromDb(m.makerFeeRate)),
        takerFeeRate: wire(fromDb(m.takerFeeRate)),
        liquidationFeeRate: wire(fromDb(m.liquidationFeeRate)),
        /** 设置里解锁后的杠杆上限（保证入场不即刻强平） */
        unlockMaxLeverage: maxSafeLeverage(fromDb(m.maintenanceMarginRate)),
        /** 大单冲击参数（外部行情市场为 null） */
        impact:
          m.dataSource === 'PROCEDURAL' && m.engineConfig && fromDb(m.engineConfig.impactCap).gt(0)
            ? {
                liquidity: wire(fromDb(m.engineConfig.impactLiquidity)),
                cap: wire(fromDb(m.engineConfig.impactCap)),
                exponent: wire(fromDb(m.engineConfig.impactExponent)),
              }
            : null,
      }));
    });

    app.get<{ Params: { code: string } }>('/:code/candles', async (req) => {
      const m = core.markets.byCode(req.params.code);
      if (!m) throw new TradeError('error.marketNotFound', 404);
      const q = candlesQuery.parse(req.query);
      const rows = await core.db.candle.findMany({
        where: { marketId: m.id, interval: q.interval, ...(q.before ? { openTime: { lt: new Date(q.before) } } : {}) },
        orderBy: { openTime: 'desc' },
        take: q.limit,
      });
      const candles = rows.reverse().map((c) => ({
        openTime: c.openTime.getTime(),
        open: wire(fromDb(c.open)),
        high: wire(fromDb(c.high)),
        low: wire(fromDb(c.low)),
        close: wire(fromDb(c.close)),
        volume: wire(fromDb(c.volume)),
      }));
      // 首屏：把内存中未收盘（可能尚未落库）的当前 K 线补到末尾
      if (!q.before) {
        const live = core.markets.engine(m.id)?.candles().find((c) => c.interval === q.interval);
        if (live) {
          const last = candles[candles.length - 1];
          const item = {
            openTime: live.openTime,
            open: wire(live.open),
            high: wire(live.high),
            low: wire(live.low),
            close: wire(live.close),
            volume: wire(live.volume),
          };
          if (last && last.openTime === live.openTime) candles[candles.length - 1] = item;
          else if (!last || last.openTime < live.openTime) candles.push(item);
        }
      }
      return { market: m.code, interval: q.interval, candles };
    });

    /** 最近 48 小时内已触发 / 进行中的金融快讯（未来事件不公开，防剧透） */
    app.get<{ Params: { code: string } }>('/:code/events', async (req) => {
      const m = core.markets.byCode(req.params.code);
      if (!m) throw new TradeError('error.marketNotFound', 404);
      const rows = await core.db.scheduledEvent.findMany({
        where: {
          marketId: m.id,
          status: { in: ['ACTIVE', 'COMPLETED'] },
          headline: { not: '' },
          triggeredAt: { gte: new Date(Date.now() - NEWS_RETENTION_MS) },
        },
        orderBy: { triggeredAt: 'desc' },
        take: 20,
      });
      return rows.map((e) => ({
        id: e.id,
        headline: e.headline,
        content: e.content,
        i18n: e.i18n,
        gapPercent: wire(fromDb(e.gapPercent)),
        priceBefore: e.priceBefore ? wire(fromDb(e.priceBefore)) : null,
        priceAfter: e.priceAfter ? wire(fromDb(e.priceAfter)) : null,
        status: e.status,
        triggeredAt: e.triggeredAt?.getTime() ?? null,
        durationSec: e.durationSec,
      }));
    });

    /**
     * 弹幕：默认最近 50 条（K 线上飘的那层用）；带 hours 时返回最近 hours 小时内的全部（弹幕历史侧栏用，最多 1 千条）。
     * 都按时间从旧到新。
     */
    app.get<{ Params: { code: string } }>('/:code/danmaku', async (req) => {
      const m = core.markets.byCode(req.params.code);
      if (!m) throw new TradeError('error.marketNotFound', 404);
      const { hours } = z.object({ hours: z.coerce.number().int().min(1).max(24).optional() }).parse(req.query);
      const raw = await core.bus.range(`danmaku:${m.code}`, hours ? DANMAKU_HISTORY_CAP : 50);
      const list = raw.map((r) => JSON.parse(r) as DanmakuPayload).reverse();
      if (!hours) return list;
      const since = core.clock().getTime() - hours * 3_600_000;
      return list.filter((d) => d.ts >= since);
    });
  };
