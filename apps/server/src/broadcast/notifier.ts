import type {
  BroadcastKind,
  BroadcastPayload,
  CandlePayload,
  DanmakuPayload,
  HistoryResetPayload,
  MarketEventPayload,
  TickPayload,
  UserEvent,
} from '@catpital/shared';
import type { PrismaClient } from '@prisma/client';
import type { Bus } from '../infra/bus.js';
import { wire } from '../lib/dec.js';
import type { WalletState } from '../trading/wallet.js';

/**
 * 统一出口：所有推给前端 / Discord Bot 的消息都经过这里。
 * 全服播报会先落库（Broadcast 表），再发到 ws 与 bot 两个 topic。
 */
export class Notifier {
  private names = new Map<string, string>();

  constructor(
    private readonly bus: Bus,
    private readonly db: PrismaClient,
  ) {}

  tick(d: TickPayload) {
    this.bus.publish('ws', { msg: { ch: `tick:${d.market}`, d } });
    void this.bus.setHash(`mkt:${d.market}:last`, { price: d.price, ts: String(d.ts) });
  }

  candle(d: CandlePayload) {
    this.bus.publish('ws', { msg: { ch: `kline:${d.market}:${d.interval}`, d } });
  }

  historyReset(d: HistoryResetPayload) {
    this.bus.publish('ws', { msg: { ch: `history:${d.market}`, d } });
  }

  marketEvent(d: MarketEventPayload) {
    this.bus.publish('ws', { msg: { ch: `event:${d.market}`, d } });
  }

  danmaku(d: DanmakuPayload) {
    this.bus.publish('ws', { msg: { ch: `danmaku:${d.market}`, d } });
    void this.bus.pushCapped(`danmaku:${d.market}`, JSON.stringify(d), 100);
  }

  user(userId: string, d: UserEvent) {
    this.bus.publish('ws', { userId, msg: { ch: 'user', d } });
  }

  wallet(userId: string, w: WalletState, generation?: number) {
    this.user(userId, { type: 'wallet', wallet: { balance: wire(w.balance), locked: wire(w.locked), generation } });
  }

  async displayName(userId: string): Promise<string> {
    const cached = this.names.get(userId);
    if (cached) return cached;
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { globalName: true, username: true } });
    const name = u?.globalName ?? u?.username ?? userId;
    this.names.set(userId, name);
    return name;
  }

  forgetName(userId: string) {
    this.names.delete(userId);
  }

  async broadcast(
    kind: BroadcastKind,
    i18nKey: string,
    vars: Record<string, string | number>,
    opts: { userId?: string; marketId?: string; market?: string; resumeId?: string } = {},
  ): Promise<BroadcastPayload> {
    const allVars = { ...vars };
    if (opts.userId && allVars.user === undefined) allVars.user = await this.displayName(opts.userId);
    const row = await this.db.broadcast.create({
      data: { kind, userId: opts.userId ?? null, marketId: opts.marketId ?? null, payload: { i18nKey, vars: allVars } },
    });
    const payload: BroadcastPayload = {
      id: row.id,
      kind,
      i18nKey,
      vars: allVars,
      userId: opts.userId,
      market: opts.market,
      ts: row.createdAt.getTime(),
    };
    this.bus.publish('ws', { msg: { ch: 'broadcast', d: payload } });
    this.bus.publish('bot', { broadcast: payload, resumeId: opts.resumeId });
    return payload;
  }
}
