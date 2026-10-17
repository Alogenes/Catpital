import { type Decimal, periodReturn } from '@catpital/shared';
import type { LeaderboardBoard, LeaderboardPeriod, PrismaClient } from '@prisma/client';
import cron, { type ScheduledTask } from 'node-cron';
import type { Notifier } from '../broadcast/notifier.js';
import { fromDb, toDb, wire } from '../lib/dec.js';
import { getActiveLife } from '../trading/lifeStats.js';
import { lockWallet, postLedger } from '../trading/wallet.js';
import type { LeaderboardService } from './leaderboardService.js';
import { PERIODS, type PeriodWindow, periodWindow } from './periods.js';

export interface SettlementConfig {
  minCapital: Decimal;
  rewards: Record<LeaderboardPeriod, Decimal>;
  /** 每个榜单写入快照的名次数 */
  snapshotSize?: number;
}

export interface Badge {
  key: string;
  period: LeaderboardPeriod;
  periodKey: string;
  board: LeaderboardBoard;
  at: number;
}

export interface SettlementResult {
  period: LeaderboardPeriod;
  periodKey: string;
  skipped: boolean;
  champions: Array<{ board: LeaderboardBoard; userId: string; value: string; reward: string }>;
}

type Logger = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/**
 * 榜单周期结算（UTC）：
 *   日榜 每天 00:00:05 · 周榜 每周一 00:00:10 · 月榜 每月 1 日 00:00:15
 *
 * 结算一个已结束的周期：
 *   1. 收益率 = Modified Dietz：期初净值 V0（基准行）、期末净值 V1（结算时刻净值）、
 *      外部资金流 = (基准时刻, 周期结束] 内 isExternal 流水（充值/提现/破产/奖金）→ 充值刷不了收益率
 *   2. 回写 LeaderboardPeriodStat（期末净值、收益率、是否达标、结算时间）
 *   3. 两个榜各写入前 N 名到 LeaderboardSnapshot
 *   4. 两个榜的第一名：发奖金（LEADERBOARD_REWARD，同样计入外部资金流）+ 限定称号 + 全服播报"本期股神"
 * 幂等：快照已存在则跳过，服务重启后会补结算错过的上一期。
 */
export class LeaderboardSettlement {
  private tasks: ScheduledTask[] = [];

  constructor(
    private readonly db: PrismaClient,
    private readonly leaderboard: LeaderboardService,
    private readonly notifier: Notifier,
    private readonly config: SettlementConfig,
    private readonly log: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start() {
    const run = (p: LeaderboardPeriod) => () =>
      void this.settle(p).catch((err) => this.log.error({ err, period: p }, 'leaderboard settlement failed'));
    this.tasks = [
      cron.schedule('5 0 0 * * *', run('DAILY'), { timezone: 'UTC', name: 'lb-daily', noOverlap: true }),
      cron.schedule('10 0 0 * * 1', run('WEEKLY'), { timezone: 'UTC', name: 'lb-weekly', noOverlap: true }),
      cron.schedule('15 0 0 1 * *', run('MONTHLY'), { timezone: 'UTC', name: 'lb-monthly', noOverlap: true }),
    ];
    // 补结算：停机期间错过的上一期
    void (async () => {
      for (const p of PERIODS) await run(p)();
    })();
  }

  stop() {
    for (const t of this.tasks) void t.stop();
    this.tasks = [];
  }

  /** 刚结束的那一期 */
  previousWindow(period: LeaderboardPeriod, now = this.clock()): PeriodWindow {
    const current = periodWindow(period, now);
    return periodWindow(period, new Date(current.start.getTime() - 1));
  }

  async settle(period: LeaderboardPeriod, window = this.previousWindow(period)): Promise<SettlementResult> {
    const { key, end } = window;
    const done = await this.db.leaderboardSnapshot.count({ where: { period, periodKey: key } });
    const stats = await this.db.leaderboardPeriodStat.findMany({ where: { period, periodKey: key } });
    if (done > 0 || stats.length === 0) return { period, periodKey: key, skipped: true, champions: [] };

    const now = this.clock();
    const nws = await this.leaderboard.netWorths();
    // 新周期的基准与上一期的期末净值在同一时刻采样，两期首尾衔接
    await this.leaderboard.ensureBaselines(nws);

    const earliest = stats.reduce((m, s) => (s.periodStart < m ? s.periodStart : m), end);
    const flows = await this.db.ledgerEntry.findMany({
      where: { isExternal: true, createdAt: { gt: earliest, lte: end } },
      select: { userId: true, amount: true, createdAt: true },
    });

    const rows = stats.map((s) => {
      const endNetWorth = nws.get(s.userId) ?? fromDb(s.startNetWorth);
      const periodEnd = end.getTime() > s.periodStart.getTime() ? end : new Date(s.periodStart.getTime() + 1);
      const r = periodReturn({
        startNetWorth: fromDb(s.startNetWorth),
        endNetWorth,
        periodStart: s.periodStart,
        periodEnd,
        flows: flows.filter((f) => f.userId === s.userId && f.createdAt > s.periodStart).map((f) => ({ amount: fromDb(f.amount), at: f.createdAt })),
        minCapital: this.config.minCapital,
      });
      return { stat: s, endNetWorth, returnPct: r.returnPct, eligible: r.eligible };
    });

    const size = this.config.snapshotSize ?? 10;
    const byReturn = rows
      .filter((r) => r.eligible && r.returnPct)
      .sort((a, b) => b.returnPct!.cmp(a.returnPct!) || a.stat.userId.localeCompare(b.stat.userId));
    const byWorth = [...rows].sort((a, b) => b.endNetWorth.cmp(a.endNetWorth) || a.stat.userId.localeCompare(b.stat.userId));

    await this.db.$transaction([
      ...rows.map((r) =>
        this.db.leaderboardPeriodStat.update({
          where: { id: r.stat.id },
          data: {
            endNetWorth: toDb(r.endNetWorth),
            returnPct: r.returnPct ? toDb(r.returnPct) : null,
            eligible: r.eligible,
            finalizedAt: now,
          },
        }),
      ),
      this.db.leaderboardSnapshot.createMany({
        data: [
          ...byReturn.slice(0, size).map((r, i) => ({ period, periodKey: key, board: 'RETURN_PCT' as const, rank: i + 1, userId: r.stat.userId, value: toDb(r.returnPct!) })),
          ...byWorth.slice(0, size).map((r, i) => ({ period, periodKey: key, board: 'NET_WORTH' as const, rank: i + 1, userId: r.stat.userId, value: toDb(r.endNetWorth) })),
        ],
        skipDuplicates: true,
      }),
    ]);

    // 第一名：收益率榜要求收益为正；富豪榜要求净值为正
    const champions: SettlementResult['champions'] = [];
    const topReturn = byReturn[0];
    if (topReturn && topReturn.returnPct!.gt(0)) champions.push({ board: 'RETURN_PCT', userId: topReturn.stat.userId, value: wire(topReturn.returnPct!), reward: '' });
    const topWorth = byWorth[0];
    if (topWorth && topWorth.endNetWorth.gt(0)) champions.push({ board: 'NET_WORTH', userId: topWorth.stat.userId, value: wire(topWorth.endNetWorth), reward: '' });

    const reward = this.config.rewards[period];
    // 奖金记账时间必须严格晚于新一期基准的采样时刻（流水按 createdAt > 基准时刻 计入外部资金流），
    // 否则同一毫秒入账的奖金会被下一期当成交易收益
    const payoutAt = new Date(now.getTime() + 1);
    for (const c of champions) {
      c.reward = wire(reward);
      await this.award(c.userId, period, key, c.board, reward, payoutAt);
      await this.notifier.broadcast(
        'CHAMPION',
        'broadcast.champion',
        { period, periodKey: key, board: c.board, value: c.value, reward: c.reward },
        { userId: c.userId },
      );
    }
    this.log.info({ period, periodKey: key, participants: rows.length, champions: champions.length }, 'leaderboard settled');
    return { period, periodKey: key, skipped: false, champions };
  }

  private async award(userId: string, period: LeaderboardPeriod, periodKey: string, board: LeaderboardBoard, reward: Decimal, now: Date) {
    const wallet = await this.db.$transaction(async (tx) => {
      let w = await lockWallet(tx, userId);
      const life = await getActiveLife(tx, userId);
      if (reward.gt(0)) {
        w = await postLedger(
          tx,
          w,
          life.id,
          [{ type: 'LEADERBOARD_REWARD', amount: reward, memo: `${period} ${periodKey} ${board} #1`, idempotencyKey: `lb:${period}:${periodKey}:${board}` }],
          now,
        );
      }
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { badges: true } });
      const badges = (Array.isArray(user.badges) ? user.badges : []) as unknown as Badge[];
      badges.push({ key: `badge.${period}.${board}`, period, periodKey, board, at: now.getTime() });
      await tx.user.update({ where: { id: userId }, data: { badges: badges as unknown as object[] } });
      return w;
    });
    this.notifier.wallet(userId, wallet);
  }
}
