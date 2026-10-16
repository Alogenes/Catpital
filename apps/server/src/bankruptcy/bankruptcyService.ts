import { bankruptcySettlement, canDeclareBankruptcy } from '@catpital/shared';
import type { BankruptcyResume, PrismaClient } from '@prisma/client';
import type { Notifier } from '../broadcast/notifier.js';
import type { EconomyConfig } from '../config/env.js';
import { fromDb, toDb, toDbOpt, wire } from '../lib/dec.js';
import { getActiveLife } from '../trading/lifeStats.js';
import { TradeError } from '../trading/types.js';
import { lockWallet, postLedger } from '../trading/wallet.js';
import { evaluateTitles, serializeStats, statsFromLife } from './resumeGenerator.js';

/**
 * 个人破产清算：
 *   1. 校验：无持仓、无挂单、余额 <= dust
 *   2. 汇总"这一世"的 Life 统计 → 生成《股市人生履历》+ 称号
 *   3. 旧世代记账：抹平负债（+W）/ 没收 dust（−dust）→ 余额归零，Life 结束
 *   4. 新世代：generation + 1，发放救济金（+R）
 *   抹债与救济金均为"外部资金流"，不会被收益率榜单当作盈利。
 */
export class BankruptcyService {
  constructor(
    private readonly db: PrismaClient,
    private readonly notifier: Notifier,
    private readonly economy: EconomyConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async eligibility(userId: string) {
    const [wallet, open, pending] = await Promise.all([
      this.db.wallet.findUniqueOrThrow({ where: { userId } }),
      this.db.position.count({ where: { userId, status: 'OPEN' } }),
      this.db.order.count({ where: { userId, status: 'PENDING' } }),
    ]);
    return canDeclareBankruptcy({
      balance: fromDb(wallet.balance),
      openPositionCount: open,
      pendingOrderCount: pending,
      dustThreshold: this.economy.BANKRUPTCY_DUST_THRESHOLD,
    });
  }

  async declare(userId: string): Promise<BankruptcyResume> {
    const now = this.clock();
    const result = await this.db.$transaction(async (tx) => {
      let wallet = await lockWallet(tx, userId);
      const [open, pending] = await Promise.all([
        tx.position.count({ where: { userId, status: 'OPEN' } }),
        tx.order.count({ where: { userId, status: 'PENDING' } }),
      ]);
      const eligible = canDeclareBankruptcy({
        balance: wallet.balance,
        openPositionCount: open,
        pendingOrderCount: pending,
        dustThreshold: this.economy.BANKRUPTCY_DUST_THRESHOLD,
      });
      if (!eligible) throw new TradeError('error.bankruptcyNotEligible', 409);

      const life = await getActiveLife(tx, userId);
      const settle = bankruptcySettlement(wallet.balance, this.economy.BANKRUPTCY_RELIEF);
      const eventLiquidations = await tx.liquidation.count({ where: { lifeId: life.id, scheduledEventId: { not: null } } });
      const stats = statsFromLife(life, wallet.balance, now, eventLiquidations);
      const titles = evaluateTitles(stats);

      // ---- 旧世代：抹债 / 没收 dust → 余额归零 ----
      wallet = await postLedger(tx, wallet, life.id, [
        { type: 'BANKRUPTCY_WRITE_OFF', amount: settle.debtWrittenOff, memo: 'debt written off' },
        { type: 'BANKRUPTCY_WRITE_OFF', amount: settle.dustForfeited.neg(), memo: 'dust forfeited' },
      ], now);
      await tx.life.update({ where: { id: life.id }, data: { status: 'ENDED', endedAt: now } });

      const resume = await tx.bankruptcyResume.create({
        data: {
          userId,
          lifeId: life.id,
          generation: life.generation,
          startedAt: life.startedAt,
          endedAt: now,
          survivedSeconds: BigInt(stats.survivedSeconds),
          startingBalance: toDb(stats.startingBalance),
          peakNetWorth: toDb(stats.peakNetWorth),
          finalBalance: toDb(stats.finalBalance),
          debtWrittenOff: toDb(settle.debtWrittenOff),
          reliefGranted: toDb(settle.reliefGranted),
          bestTradeRoe: toDbOpt(stats.bestTradeRoe),
          bestTradePnl: toDbOpt(stats.bestTradePnl),
          worstLiquidationLoss: toDbOpt(stats.worstLiquidationLoss),
          totalFeesPaid: toDb(stats.totalFeesPaid),
          totalVolume: toDb(stats.totalVolume),
          winRate: toDb(stats.winRate),
          closedTradeCount: stats.closedTradeCount,
          liquidationCount: stats.liquidationCount,
          deficitCount: stats.deficitCount,
          avgLeverage: toDb(stats.avgLeverage),
          maxLeverageUsed: toDb(stats.maxLeverageUsed),
          titles,
          stats: serializeStats(stats),
          createdAt: now,
        },
      });

      // ---- 新世代：救济金 ----
      const relief = toDb(settle.reliefGranted);
      const newLife = await tx.life.create({
        data: {
          userId,
          generation: life.generation + 1,
          startingBalance: relief,
          peakNetWorth: relief,
          troughNetWorth: relief,
          startedAt: now,
          peakNetWorthAt: now,
        },
      });
      wallet = await postLedger(tx, wallet, newLife.id, [
        { type: 'BANKRUPTCY_RELIEF', amount: settle.reliefGranted, memo: `generation ${newLife.generation}` },
      ], now);
      await tx.user.update({ where: { id: userId }, data: { generation: newLife.generation } });
      return { resume, wallet, generation: newLife.generation, stats, titles };
    });

    this.notifier.wallet(userId, result.wallet, result.generation);
    this.notifier.user(userId, { type: 'bankruptcyAvailable', available: false });
    this.notifier.user(userId, { type: 'resume', resumeId: result.resume.id });
    await this.notifier.broadcast(
      'BANKRUPTCY',
      'broadcast.bankruptcy',
      {
        generation: result.resume.generation,
        survivedSeconds: result.stats.survivedSeconds,
        peakNetWorth: wire(result.stats.peakNetWorth),
        debtWrittenOff: wire(fromDb(result.resume.debtWrittenOff)),
        title: result.titles[0]!,
      },
      { userId, resumeId: result.resume.id },
    );
    return result.resume;
  }
}
