import { z } from 'zod';

/**
 * 交易时段配置（存储于 Market.tradingHours）：
 *   { timezone: "Asia/Shanghai", sessions: [{ days: [1,2,3,4,5], open: "09:30", close: "11:30" }, ...] }
 * days 采用 ISO 星期：1 = 周一 … 7 = 周日。sessions 为空 = 7x24。
 * close 小于 open 表示跨午夜（如 22:00 → 02:00），此时 days 指开盘那一天。
 */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const tradingHoursSchema = z.object({
  timezone: z.string().default('UTC'),
  sessions: z
    .array(z.object({ days: z.array(z.number().int().min(1).max(7)).min(1), open: hhmm, close: hhmm }))
    .default([]),
});
export type TradingHours = z.infer<typeof tradingHoursSchema>;

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(now: Date, timeZone: string) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return { day: WEEKDAY[parts.weekday!]!, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export function isMarketOpen(raw: unknown, now: Date): boolean {
  const hours = tradingHoursSchema.parse(raw ?? {});
  if (hours.sessions.length === 0) return true;
  const { day, minutes } = localParts(now, hours.timezone);
  const prevDay = day === 1 ? 7 : day - 1;
  return hours.sessions.some((s) => {
    const open = toMinutes(s.open);
    const close = toMinutes(s.close);
    if (open < close) return s.days.includes(day) && minutes >= open && minutes < close;
    // 跨午夜：开盘当天 [open, 24:00) 或 次日 [00:00, close)
    return (s.days.includes(day) && minutes >= open) || (s.days.includes(prevDay) && minutes < close);
  });
}
