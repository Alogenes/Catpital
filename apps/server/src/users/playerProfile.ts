import type { PrismaClient } from '@prisma/client';
import { TradeError } from '../trading/types.js';

/**
 * 玩家主页的五维雷达图（排行榜里点头像打开）。只用库里已有的累计数据，按全部轮回统计：
 *   profitability 盈利能力：胜率（盈利平仓笔数 / 平仓笔数）
 *   risk          风险偏好：开过的仓位的平均杠杆
 *   activity      活跃度：  日均成交笔数（玩家自己下的单，不含止盈止损 / 强平）
 *   survival      生存力：  每一世的平均存活时间（从没破产过就按当前这一世已经活了多久）
 *   chat          话痨度：  日均弹幕条数
 * 每一维换算成 0–100 分：胜率直接用百分比，其它用饱和曲线 100·x / (x + k)，x = k 时 50 分，越往上越难涨，没有硬顶。
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** x = half 时得 50 分 */
const saturate = (x: number, half: number) => (x <= 0 ? 0 : Math.round((100 * x) / (x + half)));
const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;

export interface PlayerProfile {
  user: { id: string; name: string; avatarHash: string | null; generation: number; joinedAt: number };
  /** 0–100 分 */
  scores: { profitability: number; risk: number; activity: number; survival: number; chat: number };
  /** 换算前的原始数据，展示在雷达图旁边 */
  raw: {
    /** 胜率 0–1；没平过仓为 null */
    winRate: number | null;
    closedTrades: number;
    /** 平均杠杆；没开过仓为 null */
    avgLeverage: number | null;
    positions: number;
    tradesPerDay: number;
    trades: number;
    survivalHours: number;
    bankruptcies: number;
    danmakuPerDay: number;
    danmaku: number;
  };
}

export async function playerProfile(db: PrismaClient, userId: string, now: Date): Promise<PlayerProfile> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, globalName: true, avatarHash: true, generation: true, createdAt: true },
  });
  if (!user) throw new TradeError('error.userNotFound', 404);

  const [lives, leverage, trades] = await Promise.all([
    db.life.findMany({ where: { userId }, select: { startedAt: true, endedAt: true, closedTradeCount: true, winCount: true, danmakuCount: true } }),
    db.position.aggregate({ where: { userId }, _avg: { leverage: true }, _count: { _all: true } }),
    db.order.count({ where: { userId, source: 'USER', status: 'FILLED' } }),
  ]);

  // 注册不满一天按一天算，避免刚进来的新人日均数据虚高
  const days = Math.max(1, (now.getTime() - user.createdAt.getTime()) / DAY_MS);
  const closedTrades = lives.reduce((n, l) => n + l.closedTradeCount, 0);
  const wins = lives.reduce((n, l) => n + l.winCount, 0);
  const danmaku = lives.reduce((n, l) => n + l.danmakuCount, 0);
  const ended = lives.filter((l) => l.endedAt);
  const spans = (ended.length ? ended : lives).map((l) => ((l.endedAt ?? now).getTime() - l.startedAt.getTime()) / HOUR_MS);
  const survivalHours = spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : 0;

  const winRate = closedTrades ? wins / closedTrades : null;
  const avgLeverage = leverage._avg.leverage ? Number(leverage._avg.leverage) : null;
  const tradesPerDay = trades / days;
  const danmakuPerDay = danmaku / days;

  return {
    user: { id: user.id, name: user.globalName ?? user.username, avatarHash: user.avatarHash, generation: user.generation, joinedAt: user.createdAt.getTime() },
    scores: {
      profitability: winRate === null ? 0 : Math.round(winRate * 100),
      // 1x 不加杠杆 = 0 分，10x = 50 分，100x ≈ 92 分
      risk: avgLeverage === null ? 0 : saturate(avgLeverage - 1, 9),
      activity: saturate(tradesPerDay, 10),
      // 平均活 3 天 = 50 分
      survival: saturate(survivalHours, 72),
      chat: saturate(danmakuPerDay, 10),
    },
    raw: {
      winRate: winRate === null ? null : round(winRate, 4),
      closedTrades,
      avgLeverage: avgLeverage === null ? null : round(avgLeverage, 2),
      positions: leverage._count._all,
      tradesPerDay: round(tradesPerDay, 2),
      trades,
      survivalHours: round(survivalHours, 1),
      bankruptcies: ended.length,
      danmakuPerDay: round(danmakuPerDay, 2),
      danmaku,
    },
  };
}
