import { type BroadcastPayload, type FeedItem, REACTION_AVATARS, type ReactionSummary } from '@catpital/shared';
import type { Broadcast, PrismaClient } from '@prisma/client';
import { TradeError } from '../trading/types.js';
import type { Notifier } from './notifier.js';

type Vote = 1 | -1 | 0;
type Summary = ReactionSummary & { mine: Vote };

/** 24 小时动态一次最多返回的条数 */
export const FEED_MAX_ITEMS = 300;

/** 播报行 → 前端载荷；market 取当前市场目录里的代码（市场已下架就不带） */
export function broadcastView(r: Broadcast, codeOf: (marketId: string) => string | undefined): BroadcastPayload {
  const p = r.payload as { i18nKey: string; vars: Record<string, string | number> };
  return {
    id: r.id,
    kind: r.kind,
    i18nKey: p.i18nKey,
    vars: p.vars,
    userId: r.userId ?? undefined,
    market: r.marketId ? codeOf(r.marketId) : undefined,
    ts: r.createdAt.getTime(),
  };
}

/**
 * 全服播报的 👍 / 👎：每人每条一票，再点同一个撤回、点另一个改票。
 * 每次投票后把最新汇总推到 reactions 频道，开着 24 小时动态的人实时看到计数和头像变化。
 */
export class BroadcastReactions {
  constructor(
    private readonly db: PrismaClient,
    private readonly notifier: Notifier,
  ) {}

  /** 最近 hours 小时的播报（新的在前），带评价汇总和查看者自己的票 */
  async feed(hours: number, viewerId: string | undefined, codeOf: (marketId: string) => string | undefined, now: Date): Promise<FeedItem[]> {
    const rows = await this.db.broadcast.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - hours * 3_600_000) } },
      orderBy: { createdAt: 'desc' },
      take: FEED_MAX_ITEMS,
    });
    const sums = await this.summaries(
      rows.map((r) => r.id),
      viewerId,
    );
    return rows.map((r) => ({ ...broadcastView(r, codeOf), reactions: sums.get(r.id)! }));
  }

  /** 投票：1 = 👍，-1 = 👎，0 = 撤回。返回最新汇总 */
  async react(broadcastId: string, userId: string, value: Vote): Promise<Summary> {
    const exists = await this.db.broadcast.findUnique({ where: { id: broadcastId }, select: { id: true } });
    if (!exists) throw new TradeError('error.broadcastNotFound', 404);
    if (value === 0) {
      await this.db.broadcastReaction.deleteMany({ where: { broadcastId, userId } });
    } else {
      await this.db.broadcastReaction.upsert({
        where: { broadcastId_userId: { broadcastId, userId } },
        create: { broadcastId, userId, value },
        update: { value },
      });
    }
    const summary = (await this.summaries([broadcastId], userId)).get(broadcastId)!;
    const { mine: _mine, ...pub } = summary;
    this.notifier.reactions({ broadcastId, ...pub });
    return summary;
  }

  /** 计数 + 最近评价过的人（最新在前）+ 查看者自己的票 */
  private async summaries(ids: string[], viewerId?: string): Promise<Map<string, Summary>> {
    const out = new Map<string, Summary>(ids.map((id) => [id, { up: 0, down: 0, users: [], mine: 0 }]));
    if (!ids.length) return out;
    const rows = await this.db.broadcastReaction.findMany({
      where: { broadcastId: { in: ids } },
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { username: true, globalName: true, avatarHash: true } } },
    });
    for (const r of rows) {
      const s = out.get(r.broadcastId)!;
      const value = r.value > 0 ? 1 : -1;
      if (value === 1) s.up++;
      else s.down++;
      if (s.users.length < REACTION_AVATARS) s.users.push({ id: r.userId, name: r.user.globalName ?? r.user.username, avatarHash: r.user.avatarHash, value });
      if (r.userId === viewerId) s.mine = value;
    }
    return out;
  }
}
