import type { Decimal } from '@catpital/shared';
import type { PrismaClient } from '@prisma/client';
import { fromDb } from '../lib/dec.js';
import { bumpExtremes, computeNetWorth } from './lifeStats.js';

type Logger = { error: (obj: unknown, msg?: string) => void };

/**
 * 巅峰净值巡检：持仓浮盈也可能创下"巅峰总资产"，而这期间不一定有成交。
 * 每分钟对有持仓的用户按最新价计算一次净值，单调更新 Life.peak / trough。
 * 只读钱包、条件更新 Life，不加钱包锁，不阻塞交易。
 */
export class NetWorthSweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: PrismaClient,
    private readonly priceOf: (marketId: string) => Decimal | undefined,
    private readonly log: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start(intervalMs = 60_000) {
    this.timer = setInterval(() => void this.sweep().catch((err) => this.log.error({ err }, 'net worth sweep failed')), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    const now = this.clock();
    const holders = await this.db.position.findMany({ where: { status: 'OPEN' }, distinct: ['userId'], select: { userId: true, lifeId: true } });
    for (const { userId, lifeId } of holders) {
      const w = await this.db.wallet.findUnique({ where: { userId } });
      if (!w) continue;
      const nw = await computeNetWorth(this.db, { userId, balance: fromDb(w.balance), locked: fromDb(w.locked) }, this.priceOf);
      await bumpExtremes(this.db, lifeId, nw, now);
    }
  }
}
