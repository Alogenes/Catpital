import { type Decimal, type PositionSide, dmax, netWorth } from '@catpital/shared';
import type { Life, Prisma } from '@prisma/client';
import { fromDb, fromDbOpt, toDb } from '../lib/dec.js';
import type { Tx, WalletState } from './wallet.js';

/**
 * 《人生履历》增量统计。每次成交 / 强平在同一事务里调用，
 * 破产时 Life 行即为完整履历，无需回扫流水。
 */
export interface FillStats {
  notional: Decimal;
  fee: Decimal;
  realizedPnl: Decimal;
  /** 平仓部分（closedQuantity > 0 时提供） */
  close?: { netPnl: Decimal; roe: Decimal | null };
  /** 开仓部分（openedQuantity > 0 时提供） */
  open?: { notional: Decimal; leverage: Decimal; side: PositionSide };
  /** 仓位被完全平掉时的持仓秒数 */
  heldSeconds?: number;
  liquidation?: { totalLoss: Decimal; deficit: Decimal; marketId: string };
}

export function lifeUpdateFromFill(life: Life, s: FillStats): Prisma.LifeUpdateInput {
  const data: Prisma.LifeUpdateInput = {
    totalVolume: toDb(fromDb(life.totalVolume).plus(s.notional)),
    totalFeesPaid: toDb(fromDb(life.totalFeesPaid).plus(s.fee)),
    totalRealizedPnl: toDb(fromDb(life.totalRealizedPnl).plus(s.realizedPnl)),
  };
  if (s.close) {
    data.closedTradeCount = { increment: 1 };
    if (s.close.netPnl.gt(0)) data.winCount = { increment: 1 };
    else data.lossCount = { increment: 1 };
    const bestRoe = fromDbOpt(life.bestTradeRoe);
    if (s.close.roe && (!bestRoe || s.close.roe.gt(bestRoe))) data.bestTradeRoe = toDb(s.close.roe);
    const bestPnl = fromDbOpt(life.bestTradePnl);
    if (!bestPnl || s.close.netPnl.gt(bestPnl)) data.bestTradePnl = toDb(s.close.netPnl);
  }
  if (s.open) {
    data.openCount = { increment: 1 };
    data.maxLeverageUsed = toDb(dmax(fromDb(life.maxLeverageUsed), s.open.leverage));
    data.leverageVolumeSum = toDb(fromDb(life.leverageVolumeSum).plus(s.open.leverage.mul(s.open.notional)));
    if (s.open.side === 'LONG') data.longVolume = toDb(fromDb(life.longVolume).plus(s.open.notional));
    else data.shortVolume = toDb(fromDb(life.shortVolume).plus(s.open.notional));
  }
  if (s.heldSeconds !== undefined) data.totalHoldingSeconds = { increment: BigInt(Math.max(0, Math.floor(s.heldSeconds))) };
  if (s.liquidation) {
    data.liquidationCount = { increment: 1 };
    if (s.liquidation.deficit.gt(0)) {
      data.deficitCount = { increment: 1 };
      data.totalDeficit = toDb(fromDb(life.totalDeficit).plus(s.liquidation.deficit));
    }
    const worst = fromDbOpt(life.worstLiquidationLoss);
    if (!worst || s.liquidation.totalLoss.gt(worst)) {
      data.worstLiquidationLoss = toDb(s.liquidation.totalLoss);
      data.worstLiquidationMarketId = s.liquidation.marketId;
    }
  }
  return data;
}

/** 当前净值：B + B_locked + Σ(M + uPnL)，各市场价格取自引擎内存 */
export async function computeNetWorth(
  tx: Tx,
  wallet: WalletState,
  priceOf: (marketId: string) => Decimal | undefined,
): Promise<Decimal> {
  const positions = await tx.position.findMany({ where: { userId: wallet.userId, status: 'OPEN' } });
  return netWorth({
    balance: wallet.balance,
    locked: wallet.locked,
    positions: positions.map((p) => ({
      side: p.side,
      quantity: fromDb(p.quantity),
      entryPrice: fromDb(p.entryPrice),
      margin: fromDb(p.margin),
      markPrice: priceOf(p.marketId) ?? fromDb(p.entryPrice),
    })),
  });
}

/**
 * 刷新巅峰 / 谷底净值。用条件更新（WHERE peak < nw）实现单调，
 * 与后台净值巡检并发写入时不会互相覆盖。
 */
export async function bumpExtremes(tx: Tx, lifeId: string, nw: Decimal, now: Date) {
  const v = toDb(nw);
  await tx.life.updateMany({ where: { id: lifeId, peakNetWorth: { lt: v } }, data: { peakNetWorth: v, peakNetWorthAt: now } });
  await tx.life.updateMany({ where: { id: lifeId, troughNetWorth: { gt: v } }, data: { troughNetWorth: v } });
}

export async function getActiveLife(tx: Tx, userId: string): Promise<Life> {
  const life = await tx.life.findFirst({ where: { userId, status: 'ACTIVE' } });
  if (!life) throw new Error(`no active life for ${userId}`);
  return life;
}
