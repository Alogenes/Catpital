import { D, type Decimal } from '@catpital/shared';

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * 管理员命令的延迟参数："30" / "30s" / "5m" / "1h30m" / "2d"（纯数字按秒）。
 * 范围 1 秒 ~ 30 天，非法返回 null。
 */
export function parseDelay(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(s)) return inRange(Number(s) * 1000);
  const re = /(\d+)([smhd])/g;
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * UNIT_MS[m[2]!]!;
    consumed += m[0].length;
  }
  return consumed === s.length && consumed > 0 ? inRange(total) : null;
}

const inRange = (ms: number) => (ms >= 1000 && ms <= 30 * 86_400_000 ? ms : null);

/**
 * 跳空幅度："-30%" / "+50%" / "50%" 按百分比；"-0.3" / "0.25"（不带 %，绝对值 < 1）按比例。
 * 返回比例（-0.3），必须在 (-1, +10] 之间（价格不能归零）。
 */
export function parseJump(input: string): Decimal | null {
  const s = input.trim().replace(/\s+/g, '').replace('％', '%');
  const m = /^([+-]?)(\d+(?:\.\d+)?)(%?)$/.exec(s);
  if (!m) return null;
  let v = D(m[2]!);
  if (m[3] === '%') v = v.div(100);
  else if (v.gte(1)) return null; // "30" 这类不带 % 的整数语义不明，拒绝
  if (m[1] === '-') v = v.neg();
  return v.gt(-1) && v.lte(10) && !v.isZero() ? v : null;
}
