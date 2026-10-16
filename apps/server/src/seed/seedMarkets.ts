import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { tradingHoursSchema } from '../lib/tradingHours.js';

const dec = z.string().regex(/^-?\d+(\.\d+)?$/);

export const marketSeedSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{1,32}$/),
  name: z.string(),
  nameI18n: z.record(z.string()).default({}),
  kind: z.enum(['STOCK', 'CRYPTO']),
  dataSource: z.enum(['PROCEDURAL', 'LIVE_API']).default('PROCEDURAL'),
  status: z.enum(['ACTIVE', 'HALTED', 'DELISTED']).default('ACTIVE'),
  adapterKey: z.string().optional(),
  adapterSymbol: z.string().optional(),
  tradingHours: tradingHoursSchema,
  tickIntervalMs: z.number().int().min(100).default(1000),
  tickSize: dec,
  lotSize: dec,
  minNotional: dec,
  maxLeverage: dec,
  maintenanceMarginRate: dec,
  makerFeeRate: dec,
  takerFeeRate: dec,
  liquidationFeeRate: dec.default('0'),
  initialPrice: dec,
  sortOrder: z.number().int().default(0),
  engine: z
    .object({
      drift: dec.default('0'),
      volatility: dec,
      meanReversionSpeed: dec.default('0'),
      meanReversionTarget: dec.optional(),
      jumpIntensity: dec.default('0'),
      jumpMean: dec.default('0'),
      jumpStdDev: dec.default('0'),
      baseVolume: dec,
      volumeVolCoupling: dec.default('1'),
      timeScale: dec.default('1'),
      priceFloor: dec,
    })
    .optional(),
});
export type MarketSeed = z.infer<typeof marketSeedSchema>;

/** 幂等导入市场：已存在的市场只更新规格，不覆盖 lastPrice（避免重置行情） */
export async function seedMarkets(db: PrismaClient, raw: unknown) {
  const items = z.array(marketSeedSchema).parse(raw);
  for (const { engine, ...m } of items) {
    const spec = { ...m, adapterKey: m.adapterKey ?? null, adapterSymbol: m.adapterSymbol ?? null };
    const market = await db.market.upsert({
      where: { code: m.code },
      create: { ...spec, lastPrice: m.initialPrice },
      update: spec,
    });
    if (engine) {
      const cfg = { ...engine, meanReversionTarget: engine.meanReversionTarget ?? null };
      await db.marketEngineConfig.upsert({
        where: { marketId: market.id },
        create: { marketId: market.id, ...cfg },
        update: cfg,
      });
    }
  }
  return items.length;
}
