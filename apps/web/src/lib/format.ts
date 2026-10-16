import { D, Decimal } from '@catpital/shared';

type Num = Decimal | string | null | undefined;

const toDec = (v: Num): Decimal | null => {
  if (v === null || v === undefined || v === '') return null;
  try {
    return typeof v === 'string' ? D(v) : v;
  } catch {
    return null;
  }
};

/** 千分位分组（纯字符串处理，不经过浮点） */
function group(intPart: string) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 金额/价格格式化：固定小数位，千分位 */
export function fmt(v: Num, dp = 2): string {
  const d = toDec(v);
  if (!d) return '—';
  // 展示用四舍五入（引擎内部计算用的是银行家舍入）
  const s = d.toFixed(dp, Decimal.ROUND_HALF_UP);
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  return `${neg ? '-' : ''}${group(i!)}${f ? `.${f}` : ''}`;
}

/** 带符号：+12.34 / -5.00 */
export function fmtSigned(v: Num, dp = 2): string {
  const d = toDec(v);
  if (!d) return '—';
  return d.gt(0) ? `+${fmt(d, dp)}` : fmt(d, dp);
}

/** 比率 → 百分比：0.1234 → +12.34% */
export function fmtPct(ratio: Num, dp = 2, signed = true): string {
  const d = toDec(ratio);
  if (!d) return '—';
  const p = d.mul(100);
  return `${signed ? fmtSigned(p, dp) : fmt(p, dp)}%`;
}

/** 根据 tickSize 推断价格小数位：0.0001 → 4 */
export function decimalsOf(step: string): number {
  return D(step).decimalPlaces();
}

/** 大额缩写：12,345,678 → 12.35M（仅用于展示） */
export function fmtCompact(v: Num): string {
  const d = toDec(v);
  if (!d) return '—';
  const abs = d.abs();
  const units: Array<[string, string]> = [
    ['1000000000', 'B'],
    ['1000000', 'M'],
    ['1000', 'K'],
  ];
  for (const [n, u] of units) if (abs.gte(n)) return `${fmt(d.div(n), 2)}${u}`;
  return fmt(d, 2);
}

/** 存活时长：秒 → 3d 4h / 12m 30s */
export function fmtDuration(seconds: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d) return t('duration.dh', { d, h });
  if (h) return t('duration.hm', { h, m });
  if (m) return t('duration.ms', { m, s });
  return t('duration.s', { s });
}

/** 输入框清洗：只保留数字和一个小数点，限制小数位 */
export function sanitizeDecimalInput(raw: string, maxDp = 8): string {
  let s = raw.replace(/[^\d.]/g, '');
  const firstDot = s.indexOf('.');
  if (firstDot >= 0) s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
  const [i, f] = s.split('.');
  return f !== undefined ? `${i}.${f.slice(0, maxDp)}` : i!;
}

/** 安全解析用户输入；非法或空返回 null */
export function parseDec(s: string): Decimal | null {
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return D(s);
}
