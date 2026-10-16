import type { LeaderboardPeriod } from '@prisma/client';

export interface PeriodWindow {
  period: LeaderboardPeriod;
  /** "2026-10-16" | "2026-W42" | "2026-10" */
  key: string;
  start: Date;
  end: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 榜单周期（UTC）：日榜 = 自然日；周榜 = ISO 周（周一 00:00 起）；月榜 = 自然月。
 * 时区固定 UTC，阶段四做周期结算时可改为可配置。
 */
export function periodWindow(period: LeaderboardPeriod, now: Date): PeriodWindow {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === 'DAILY') {
    const start = new Date(Date.UTC(y, m, d));
    return { period, key: `${y}-${pad(m + 1)}-${pad(d)}`, start, end: new Date(start.getTime() + 86_400_000) };
  }
  if (period === 'MONTHLY') {
    return { period, key: `${y}-${pad(m + 1)}`, start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
  }
  // ISO 周：周一为一周开始；ISO 年取"本周周四"所在的年份
  const isoDow = (now.getUTCDay() + 6) % 7; // 0 = 周一
  const start = new Date(Date.UTC(y, m, d - isoDow));
  const thursday = new Date(start.getTime() + 3 * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000);
  const week = Math.round((start.getTime() - week1Monday.getTime()) / (7 * 86_400_000)) + 1;
  return { period, key: `${isoYear}-W${pad(week)}`, start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

export const PERIODS: LeaderboardPeriod[] = ['DAILY', 'WEEKLY', 'MONTHLY'];
