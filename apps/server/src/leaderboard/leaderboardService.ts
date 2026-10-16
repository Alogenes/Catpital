import { type Decimal, ZERO, netWorth, periodReturn } from '@catpital/shared';
import type { LeaderboardBoard, LeaderboardPeriod, PrismaClient } from '@prisma/client';
import { fromDb, toDb, wire } from '../lib/dec.js';
import { PERIODS, periodWindow } from './periods.js';

export interface BoardEntry {
  rank: number;
  userId: string;
  name: string;
  avatarHash: string | null;
  generation: number;
  /** NET_WORTH：总净值；RETURN_PCT：百分比数值（12.5 = 12.5%） */
  value: string;
}

export interface BoardResult {
  period: LeaderboardPeriod;
  periodKey: string;
  board: LeaderboardBoard;
  periodEnd: number;
  minCapital: string;
  entries: BoardEntry[];
  /** 查看者自己的名次（不在前 N 名时也返回）；收益率榜不满足门槛时 rank = null */
  me: { rank: number | null; value: string | null; eligible: boolean } | null;
  updatedAt: number;
}

const CACHE_MS = 5000;

/** 缓存的计算结果：完整排名 + 不满足收益率榜门槛的用户 */
interface Computed {
  result: BoardResult;
  ineligible: Set<string>;
}

/**
 * 实时榜单（当前周期）：
 *   - 富豪榜：总净值 = 余额 + 冻结 + Σ(逐仓保证金 + 浮动盈亏)，按引擎最新价实时计算
 *   - 收益率榜：Modified Dietz（见 packages/shared/src/math/returns.ts）
 *       期初净值 V0 = 本周期首次被巡检到时的净值（基准行 LeaderboardPeriodStat）
 *       外部资金流 = 基准时刻之后的 isExternal 流水（初始资金、充提、破产抹债与救济金）
 *       → 破产救济金不会被当成收益，小资金（V0 < 门槛）不上榜
 *   周期结束时的定格快照与 Discord 播报在阶段四实现。
 */
export class LeaderboardService {
  private cache = new Map<string, { at: number; computed: Computed }>();

  constructor(
    private readonly db: PrismaClient,
    private readonly priceOf: (marketId: string) => Decimal | undefined,
    private readonly minCapital: Decimal,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** 全体用户当前净值（批量查询） */
  async netWorths(): Promise<Map<string, Decimal>> {
    const [wallets, positions] = await Promise.all([
      this.db.wallet.findMany({ select: { userId: true, balance: true, locked: true } }),
      this.db.position.findMany({ where: { status: 'OPEN' } }),
    ]);
    const byUser = new Map<string, typeof positions>();
    for (const p of positions) {
      const list = byUser.get(p.userId) ?? [];
      list.push(p);
      byUser.set(p.userId, list);
    }
    const out = new Map<string, Decimal>();
    for (const w of wallets) {
      out.set(
        w.userId,
        netWorth({
          balance: fromDb(w.balance),
          locked: fromDb(w.locked),
          positions: (byUser.get(w.userId) ?? []).map((p) => ({
            side: p.side,
            quantity: fromDb(p.quantity),
            entryPrice: fromDb(p.entryPrice),
            margin: fromDb(p.margin),
            markPrice: this.priceOf(p.marketId) ?? fromDb(p.entryPrice),
          })),
        }),
      );
    }
    return out;
  }

  /**
   * 为当前日/周/月周期补齐每个用户的基准行（只建不改）。
   * 由净值巡检每分钟调用；用户在周期中途首次出现时，以出现时刻为测量起点。
   */
  async ensureBaselines(nws?: Map<string, Decimal>) {
    const now = this.clock();
    const all = nws ?? (await this.netWorths());
    for (const period of PERIODS) {
      const w = periodWindow(period, now);
      const existing = await this.db.leaderboardPeriodStat.findMany({ where: { period, periodKey: w.key }, select: { userId: true } });
      const have = new Set(existing.map((e) => e.userId));
      const data = [...all.entries()]
        .filter(([userId]) => !have.has(userId))
        .map(([userId, nw]) => ({
          userId,
          period,
          periodKey: w.key,
          periodStart: now,
          periodEnd: w.end,
          startNetWorth: toDb(nw),
          eligible: nw.gte(this.minCapital),
        }));
      if (data.length) await this.db.leaderboardPeriodStat.createMany({ data, skipDuplicates: true });
    }
  }

  async board(period: LeaderboardPeriod, board: LeaderboardBoard, viewerId?: string, limit = 20): Promise<BoardResult> {
    const cacheKey = `${period}:${board}`;
    const hit = this.cache.get(cacheKey);
    let computed = hit && this.clock().getTime() - hit.at < CACHE_MS ? hit.computed : null;
    if (!computed) {
      computed = await this.compute(period, board);
      this.cache.set(cacheKey, { at: this.clock().getTime(), computed });
    }
    return this.withViewer(computed, viewerId, limit);
  }

  /** 清空缓存（测试用） */
  invalidate() {
    this.cache.clear();
  }

  private async compute(period: LeaderboardPeriod, board: LeaderboardBoard): Promise<Computed> {
    const now = this.clock();
    const w = periodWindow(period, now);
    const nws = await this.netWorths();
    await this.ensureBaselines(nws);

    let ranked: Array<{ userId: string; value: Decimal }> = [];
    const ineligible = new Set<string>();
    if (board === 'NET_WORTH') {
      ranked = [...nws.entries()].map(([userId, value]) => ({ userId, value }));
    } else {
      const stats = await this.db.leaderboardPeriodStat.findMany({ where: { period, periodKey: w.key } });
      const earliest = stats.reduce((m, s) => (s.periodStart < m ? s.periodStart : m), now);
      const flows = await this.db.ledgerEntry.findMany({
        where: { isExternal: true, createdAt: { gt: earliest, lte: now } },
        select: { userId: true, amount: true, createdAt: true },
      });
      for (const s of stats) {
        const end = now.getTime() > s.periodStart.getTime() ? now : new Date(s.periodStart.getTime() + 1);
        const r = periodReturn({
          startNetWorth: fromDb(s.startNetWorth),
          endNetWorth: nws.get(s.userId) ?? ZERO,
          periodStart: s.periodStart,
          periodEnd: end,
          flows: flows
            .filter((f) => f.userId === s.userId && f.createdAt > s.periodStart)
            .map((f) => ({ amount: fromDb(f.amount), at: f.createdAt })),
          minCapital: this.minCapital,
        });
        if (r.eligible && r.returnPct) ranked.push({ userId: s.userId, value: r.returnPct });
        else ineligible.add(s.userId);
      }
    }
    ranked.sort((a, b) => b.value.cmp(a.value) || a.userId.localeCompare(b.userId));

    const users = await this.db.user.findMany({
      where: { id: { in: ranked.map((r) => r.userId) } },
      select: { id: true, username: true, globalName: true, avatarHash: true, generation: true },
    });
    const info = new Map(users.map((u) => [u.id, u]));
    const entries: BoardEntry[] = ranked.map((r, i) => {
      const u = info.get(r.userId);
      return {
        rank: i + 1,
        userId: r.userId,
        name: u?.globalName ?? u?.username ?? r.userId,
        avatarHash: u?.avatarHash ?? null,
        generation: u?.generation ?? 1,
        value: wire(r.value.toDecimalPlaces(board === 'RETURN_PCT' ? 4 : 2)),
      };
    });
    return {
      result: {
        period,
        periodKey: w.key,
        board,
        periodEnd: w.end.getTime(),
        minCapital: wire(this.minCapital),
        entries,
        me: null,
        updatedAt: now.getTime(),
      },
      ineligible,
    };
  }

  private withViewer({ result: base, ineligible }: Computed, viewerId: string | undefined, limit: number): BoardResult {
    const mine = viewerId ? base.entries.find((e) => e.userId === viewerId) : undefined;
    return {
      ...base,
      entries: base.entries.slice(0, limit),
      me: viewerId
        ? mine
          ? { rank: mine.rank, value: mine.value, eligible: true }
          : { rank: null, value: null, eligible: !ineligible.has(viewerId) }
        : null,
    };
  }
}
