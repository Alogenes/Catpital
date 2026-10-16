import type { Decimal, MarketRiskParams, PositionSide, PositionView } from '@catpital/shared';
import type { Market, Position } from '@prisma/client';
import { fromDb, fromDbOpt, wire, wireOpt } from '../lib/dec.js';

/** 引擎内存中的市场规格快照（避免每次下单查库） */
export interface MarketSnapshot extends MarketRiskParams {
  id: string;
  code: string;
  status: Market['status'];
  dataSource: Market['dataSource'];
  tradingHours: unknown;
  lotSize: Decimal;
  minNotional: Decimal;
  maxLeverage: Decimal;
  makerFeeRate: Decimal;
  takerFeeRate: Decimal;
  liquidationFeeRate: Decimal;
}

export function toMarketSnapshot(m: Market): MarketSnapshot {
  return {
    id: m.id,
    code: m.code,
    status: m.status,
    dataSource: m.dataSource,
    tradingHours: m.tradingHours,
    tickSize: fromDb(m.tickSize),
    lotSize: fromDb(m.lotSize),
    minNotional: fromDb(m.minNotional),
    maxLeverage: fromDb(m.maxLeverage),
    maintenanceMarginRate: fromDb(m.maintenanceMarginRate),
    makerFeeRate: fromDb(m.makerFeeRate),
    takerFeeRate: fromDb(m.takerFeeRate),
    liquidationFeeRate: fromDb(m.liquidationFeeRate),
  };
}

/** 风控引擎内存中的持仓镜像 */
export interface PositionEntry {
  id: string;
  userId: string;
  marketId: string;
  side: PositionSide;
  quantity: Decimal;
  entryPrice: Decimal;
  margin: Decimal;
  leverage: Decimal;
  liquidationPrice: Decimal;
  takeProfitPrice: Decimal | null;
  stopLossPrice: Decimal | null;
  version: number;
}

export function toPositionEntry(p: Position): PositionEntry {
  return {
    id: p.id,
    userId: p.userId,
    marketId: p.marketId,
    side: p.side,
    quantity: fromDb(p.quantity),
    entryPrice: fromDb(p.entryPrice),
    margin: fromDb(p.margin),
    leverage: fromDb(p.leverage),
    liquidationPrice: fromDb(p.liquidationPrice),
    takeProfitPrice: fromDbOpt(p.takeProfitPrice),
    stopLossPrice: fromDbOpt(p.stopLossPrice),
    version: p.version,
  };
}

export function toPositionView(p: Position, marketCode: string): PositionView {
  return {
    id: p.id,
    market: marketCode,
    side: p.side,
    quantity: wire(fromDb(p.quantity)),
    entryPrice: wire(fromDb(p.entryPrice)),
    margin: wire(fromDb(p.margin)),
    leverage: wire(fromDb(p.leverage)),
    liquidationPrice: wire(fromDb(p.liquidationPrice)),
    takeProfitPrice: wireOpt(fromDbOpt(p.takeProfitPrice)),
    stopLossPrice: wireOpt(fromDbOpt(p.stopLossPrice)),
    realizedPnl: wire(fromDb(p.realizedPnl)),
    openedAt: p.openedAt.getTime(),
  };
}

/** 业务错误：code 为前端 i18n key */
export class TradeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
  }
}
