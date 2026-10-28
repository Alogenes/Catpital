import { D, type Decimal, ZERO, roundNeutral } from '@catpital/shared';
import type { Life } from '@prisma/client';
import { fromDb, fromDbOpt } from '../lib/dec.js';
import { type LifeExtras, NO_EXTRAS } from './lifeExtras.js';

export interface ResumeStats extends LifeExtras {
  generation: number;
  survivedSeconds: number;
  startingBalance: Decimal;
  finalBalance: Decimal;
  peakNetWorth: Decimal;
  troughNetWorth: Decimal;
  closedTradeCount: number;
  winCount: number;
  winRate: Decimal;
  liquidationCount: number;
  deficitCount: number;
  totalDeficit: Decimal;
  eventLiquidationCount: number;
  totalFeesPaid: Decimal;
  totalVolume: Decimal;
  totalRealizedPnl: Decimal;
  bestTradeRoe: Decimal | null;
  bestTradePnl: Decimal | null;
  worstLiquidationLoss: Decimal | null;
  avgLeverage: Decimal;
  maxLeverageUsed: Decimal;
  longShare: Decimal;
  avgHoldingSeconds: number;
  danmakuCount: number;
}

export function statsFromLife(
  life: Life,
  finalBalance: Decimal,
  endedAt: Date,
  eventLiquidationCount: number,
  extras: LifeExtras = NO_EXTRAS,
): ResumeStats {
  const closed = life.closedTradeCount;
  const longVol = fromDb(life.longVolume);
  const shortVol = fromDb(life.shortVolume);
  const openVol = longVol.plus(shortVol);
  return {
    ...extras,
    generation: life.generation,
    survivedSeconds: Math.max(0, Math.floor((endedAt.getTime() - life.startedAt.getTime()) / 1000)),
    startingBalance: fromDb(life.startingBalance),
    finalBalance,
    peakNetWorth: fromDb(life.peakNetWorth),
    troughNetWorth: fromDb(life.troughNetWorth),
    closedTradeCount: closed,
    winCount: life.winCount,
    winRate: closed > 0 ? roundNeutral(D(life.winCount).div(closed)) : ZERO,
    liquidationCount: life.liquidationCount,
    deficitCount: life.deficitCount,
    totalDeficit: fromDb(life.totalDeficit),
    eventLiquidationCount,
    totalFeesPaid: fromDb(life.totalFeesPaid),
    totalVolume: fromDb(life.totalVolume),
    totalRealizedPnl: fromDb(life.totalRealizedPnl),
    bestTradeRoe: fromDbOpt(life.bestTradeRoe),
    bestTradePnl: fromDbOpt(life.bestTradePnl),
    worstLiquidationLoss: fromDbOpt(life.worstLiquidationLoss),
    avgLeverage: openVol.gt(0) ? roundNeutral(fromDb(life.leverageVolumeSum).div(openVol)) : ZERO,
    maxLeverageUsed: fromDb(life.maxLeverageUsed),
    longShare: openVol.gt(0) ? roundNeutral(longVol.div(openVol)) : ZERO,
    avgHoldingSeconds: closed > 0 ? Number(life.totalHoldingSeconds / BigInt(closed)) : 0,
    danmakuCount: life.danmakuCount,
  };
}

interface TitleRule {
  key: string;
  test: (s: ResumeStats) => boolean;
}

/**
 * 趣味称号评定：按优先级从高到低匹配，最多取 3 个；一个都不匹配时为"韭菜"。
 * 返回 i18n key，文案由前端语言包 / Bot 渲染。
 */
const TITLE_RULES: TitleRule[] = [
  { key: 'title.didNothing', test: (s) => s.closedTradeCount === 0 && s.liquidationCount === 0 },
  // ⚡ 秒游天地：复活 3 分钟内又破产
  { key: 'title.lightningTour', test: (s) => s.survivedSeconds < 180 },
  // 光速打工仔：兑换充值后不到 10 分钟就亏光
  { key: 'title.rechargeSpeedrun', test: (s) => s.secondsSinceTopUp !== null && s.secondsSinceTopUp < 600 },
  { key: 'title.speedrun', test: (s) => s.survivedSeconds >= 180 && s.survivedSeconds < 600 },
  // 🤡 永动机韭菜：24 小时内下单超过 50 次依然破产
  { key: 'title.perpetualLeek', test: (s) => s.peakOrders24h > 50 },
  // 🚀 极速升天客：开 100 倍以上杠杆被强平
  { key: 'title.rocketLaunch', test: (s) => s.maxLiquidatedLeverage !== null && s.maxLiquidatedLeverage.gte(100) },
  // 💎 钻石手骨折：拿着亏损的仓位死扛 10 分钟以上，直到穿仓
  { key: 'title.diamondHandsBroken', test: (s) => s.stubbornDeficits >= 1 },
  // 💳 氪金战神：这一世充值 5 万以上还是破产
  { key: 'title.rechargeWhale', test: (s) => s.totalTopUp.gte(50_000) },
  // 😤 上头赌徒：3 次以上被强平后 1 分钟内又下单
  { key: 'title.revengeTrader', test: (s) => s.revengeTrades >= 3 },
  { key: 'title.deficitKing', test: (s) => s.deficitCount >= 3 || s.totalDeficit.gte(s.startingBalance) },
  { key: 'title.eventVictim', test: (s) => s.eventLiquidationCount >= 1 },
  { key: 'title.leverageManiac', test: (s) => s.avgLeverage.gte(50) },
  // 🩹 补仓接盘侠：追加保证金 5 次以上，最后还是被强平
  { key: 'title.marginDonor', test: (s) => s.marginAdds >= 5 && s.liquidationCount >= 1 },
  // 🩲 裸奔勇士：开了 10 个以上仓位从不设止损，被强平 3 次以上
  { key: 'title.nakedTrader', test: (s) => s.positionCount >= 10 && s.stopLossCount === 0 && s.liquidationCount >= 3 },
  { key: 'title.oneHitWonder', test: (s) => s.bestTradeRoe !== null && s.bestTradeRoe.gte(5) },
  { key: 'title.peakThenAbyss', test: (s) => s.peakNetWorth.gte(s.startingBalance.mul(3)) },
  { key: 'title.feeDonor', test: (s) => s.totalFeesPaid.gte(s.startingBalance.mul(D('0.3'))) },
  { key: 'title.scalper', test: (s) => s.closedTradeCount >= 30 && s.avgHoldingSeconds < 120 },
  { key: 'title.diamondHands', test: (s) => s.closedTradeCount > 0 && s.avgHoldingSeconds >= 86_400 },
  { key: 'title.winningLoser', test: (s) => s.closedTradeCount >= 10 && s.winRate.gte(D('0.7')) },
  { key: 'title.coinFlipper', test: (s) => s.closedTradeCount >= 20 && s.winRate.gte(D('0.45')) && s.winRate.lte(D('0.55')) },
  // 💘 一生只爱一只股：开了 15 个以上仓位，全在同一个市场
  { key: 'title.loyalist', test: (s) => s.positionCount >= 15 && s.distinctMarkets === 1 },
  { key: 'title.permaBull', test: (s) => s.totalVolume.gt(0) && s.longShare.gte(D('0.8')) },
  { key: 'title.permaBear', test: (s) => s.totalVolume.gt(0) && s.longShare.lte(D('0.2')) },
  { key: 'title.immortal', test: (s) => s.survivedSeconds >= 30 * 86_400 },
  { key: 'title.keyboardWarrior', test: (s) => s.danmakuCount >= 100 },
];

export const FALLBACK_TITLE = 'title.leek';

export function evaluateTitles(stats: ResumeStats, max = 3): string[] {
  const titles = TITLE_RULES.filter((r) => r.test(stats)).map((r) => r.key).slice(0, max);
  return titles.length ? titles : [FALLBACK_TITLE];
}

/** 序列化为可 JSON 存储 / 传输的快照（Decimal → string） */
export function serializeStats(s: ResumeStats): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(s)) {
    out[k] = v === null ? null : typeof v === 'number' ? v : (v as Decimal).toFixed();
  }
  return out;
}
