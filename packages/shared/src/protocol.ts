/**
 * WebSocket 协议（前后端共享）。金额 / 价格 / 数量一律为字符串（Decimal.toFixed()）。
 *
 * 频道命名：
 *   tick:<CODE>              逐笔行情
 *   kline:<CODE>:<INTERVAL>  K 线更新（未收盘也推送，closed 标记收盘）
 *   danmaku:<CODE>           同股市弹幕
 *   event:<CODE>             该市场的金融快讯
 *   broadcast                全服播报
 *   user                     私有频道（自动订阅，鉴权后生效）
 */

export type CandleIntervalCode = 'M1' | 'M5' | 'M15' | 'H1' | 'D1';
export const CANDLE_INTERVALS: readonly CandleIntervalCode[] = ['M1', 'M5', 'M15', 'H1', 'D1'];
export const INTERVAL_MS: Record<CandleIntervalCode, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  H1: 3_600_000,
  D1: 86_400_000,
};

export interface TickPayload {
  market: string;
  price: string;
  volume: string;
  /** epoch ms */
  ts: number;
  /** 由定时事件强制产生的跳空 tick */
  gap?: boolean;
}

export interface CandlePayload {
  market: string;
  interval: CandleIntervalCode;
  /** epoch ms */
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closed: boolean;
}

export interface DanmakuPayload {
  market: string;
  userId: string;
  name: string;
  avatar: string | null;
  text: string;
  ts: number;
}

export interface MarketEventPayload {
  eventId: string;
  market: string;
  headline: string;
  content: string;
  i18n: Record<string, { headline?: string; content?: string }>;
  gapPercent: string;
  priceBefore: string;
  priceAfter: string;
  durationSec: number;
  ts: number;
}

export type BroadcastKind = 'BIG_WIN' | 'LIQUIDATION' | 'DEFICIT' | 'BANKRUPTCY' | 'MARKET_EVENT' | 'WHALE';

export interface BroadcastPayload {
  id: string;
  kind: BroadcastKind;
  /** 前端 i18n key，如 "broadcast.deficit" */
  i18nKey: string;
  vars: Record<string, string | number>;
  userId?: string;
  market?: string;
  ts: number;
}

export interface PositionView {
  id: string;
  market: string;
  side: 'LONG' | 'SHORT';
  quantity: string;
  entryPrice: string;
  margin: string;
  leverage: string;
  liquidationPrice: string;
  takeProfitPrice: string | null;
  stopLossPrice: string | null;
  realizedPnl: string;
  openedAt: number;
}

export interface WalletView {
  balance: string;
  locked: string;
  generation?: number;
}

export type UserEvent =
  | { type: 'wallet'; wallet: WalletView }
  | { type: 'position'; market: string; position: PositionView | null }
  | {
      type: 'order';
      orderId: string;
      market: string;
      status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED';
      source: 'USER' | 'TAKE_PROFIT' | 'STOP_LOSS' | 'LIQUIDATION';
      fillPrice?: string;
      realizedPnl?: string;
      realizedRoe?: string;
      reason?: string;
    }
  | {
      type: 'liquidated';
      market: string;
      positionId: string;
      executionPrice: string;
      liquidationPrice: string;
      deficit: string;
      totalLoss: string;
      balanceAfter: string;
    }
  | { type: 'bankruptcyAvailable'; available: boolean }
  | { type: 'resume'; resumeId: string };

export type ServerMessage =
  | { ch: `tick:${string}`; d: TickPayload }
  | { ch: `kline:${string}`; d: CandlePayload }
  | { ch: `danmaku:${string}`; d: DanmakuPayload }
  | { ch: `event:${string}`; d: MarketEventPayload }
  | { ch: 'broadcast'; d: BroadcastPayload }
  | { ch: 'user'; d: UserEvent }
  | { op: 'hello'; d: { serverTime: number } }
  | { op: 'authed'; d: { userId: string } }
  | { op: 'error'; d: { code: string } }
  | { op: 'pong'; d: { ts: number } };

export type ClientMessage =
  | { op: 'auth'; token: string }
  | { op: 'sub'; ch: string[] }
  | { op: 'unsub'; ch: string[] }
  | { op: 'danmaku'; market: string; text: string }
  | { op: 'ping'; ts: number };

export const DANMAKU_MAX_LENGTH = 60;
