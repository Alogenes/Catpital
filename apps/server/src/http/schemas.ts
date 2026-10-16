import { D } from '@catpital/shared';
import { z } from 'zod';

/** 金额/价格/数量：只接受十进制字符串（最多 8 位小数），绝不接受 JSON number */
export const decimalStr = z
  .string()
  .regex(/^\d+(\.\d{1,8})?$/, 'expected a positive decimal string with at most 8 decimal places')
  .transform((v) => D(v));

export const placeOrderBody = z.object({
  market: z.string().min(1).max(32),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
  quantity: decimalStr,
  leverage: decimalStr.default('1'),
  limitPrice: decimalStr.optional(),
  reduceOnly: z.boolean().default(false),
  clientOrderId: z.string().min(1).max(64).optional(),
  takeProfitPrice: decimalStr.nullish(),
  stopLossPrice: decimalStr.nullish(),
});

export const closeBody = z.object({ quantity: decimalStr.optional() });

/** undefined = 不修改；null = 清除 */
export const tpslBody = z.object({
  takeProfitPrice: decimalStr.nullable().optional(),
  stopLossPrice: decimalStr.nullable().optional(),
});

export const marginBody = z.object({ amount: decimalStr });

export const candlesQuery = z.object({
  interval: z.enum(['M1', 'M5', 'M15', 'H1', 'D1']).default('M1'),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
  /** epoch ms，分页：返回该时间之前的 K 线 */
  before: z.coerce.number().int().optional(),
});
