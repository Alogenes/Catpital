import DecimalBase from 'decimal.js';

/**
 * 全项目唯一的 Decimal 构造入口。
 *
 * - 独立 clone，不污染其它库对全局 Decimal 的配置
 * - 运算精度 40 位有效数字，远高于 NUMERIC(36, 8) 的存储精度，中间结果不丢精度
 * - 只在"落库/展示/与外部交互"时按规则舍入到 8 位小数（见下方 round* 系列）
 */
export const Decimal = DecimalBase.clone({
  precision: 40,
  rounding: DecimalBase.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Decimal = InstanceType<typeof Decimal>;

/** 数据库 NUMERIC(36, 8) 的小数位 */
export const STORAGE_SCALE = 8;

export type DecimalInput = Decimal | DecimalBase | string | bigint | number;

/**
 * 安全构造。允许的 number 仅限"安全整数"（如杠杆 10、常量 1），
 * 任何带小数的 JS number 一律拒绝 —— 二进制浮点从源头禁止进入金额计算。
 */
export function D(value: DecimalInput): Decimal {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`[decimal] 禁止使用非整数 JS number 构造金额: ${value}，请传入字符串`);
    }
    return new Decimal(value);
  }
  if (typeof value === 'bigint') return new Decimal(value.toString());
  if (value instanceof Decimal) return value;
  // Prisma.Decimal 或其它 decimal.js 实例：经字符串转换，保证进入本 clone 的配置
  return new Decimal(value.toString());
}

export const ZERO = D(0);
export const ONE = D(1);

/**
 * 舍入方向规则（"对平台保守、对玩家可预期"）：
 * - 向玩家收取的钱（手续费、所需保证金）       → ROUND_UP（远离 0）
 * - 向玩家支付的钱（释放保证金、盈利）         → ROUND_DOWN（趋向 0）
 * - 带符号结算额（盈亏可正可负）               → ROUND_FLOOR（对玩家不利方向）
 * - 中性展示值（收益率、均价）                 → ROUND_HALF_EVEN
 */
export const roundCharge = (v: Decimal, dp = STORAGE_SCALE) => v.toDecimalPlaces(dp, Decimal.ROUND_UP);
export const roundPayout = (v: Decimal, dp = STORAGE_SCALE) => v.toDecimalPlaces(dp, Decimal.ROUND_DOWN);
export const roundSigned = (v: Decimal, dp = STORAGE_SCALE) => v.toDecimalPlaces(dp, Decimal.ROUND_FLOOR);
export const roundNeutral = (v: Decimal, dp = STORAGE_SCALE) => v.toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN);

/** 按步长（tickSize / lotSize）对齐 */
export function roundToStep(
  value: Decimal,
  step: Decimal,
  mode: 'up' | 'down' | 'nearest' = 'nearest',
): Decimal {
  if (step.lte(0)) throw new RangeError('[decimal] step 必须 > 0');
  const units = value.div(step);
  const rounded =
    mode === 'up' ? units.ceil() : mode === 'down' ? units.floor() : units.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
  return rounded.mul(step);
}

export const dmax = (a: Decimal, b: Decimal) => (a.gte(b) ? a : b);
export const dmin = (a: Decimal, b: Decimal) => (a.lte(b) ? a : b);

/** 序列化：JSON / WebSocket / Redis 中金额一律以字符串传输 */
export const toWire = (v: Decimal) => roundNeutral(v).toFixed();
