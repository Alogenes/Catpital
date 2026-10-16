import { type CandlePayload, D, type ServerMessage, type UserEvent } from '@catpital/shared';
import i18n, { errorText } from '../i18n';
import { type OrderView, type ResumeView, api } from '../lib/api';
import { fmt, fmtSigned } from '../lib/format';
import { sound } from '../lib/sound';
import { realtime } from '../lib/ws';
import { useFeed } from '../stores/feed';
import { useMarkets } from '../stores/markets';
import { useSession } from '../stores/session';
import { useSettings } from '../stores/settings';

// ---------------------------------------------------------------------------
// K 线高频更新不走 React 状态：图表组件直接订阅这个轻量事件总线
// ---------------------------------------------------------------------------
type CandleListener = (c: CandlePayload) => void;
const candleListeners = new Map<string, Set<CandleListener>>();

export function onCandle(market: string, interval: string, l: CandleListener) {
  const key = `${market}:${interval}`;
  let set = candleListeners.get(key);
  if (!set) candleListeners.set(key, (set = new Set()));
  set.add(l);
  return () => void set!.delete(l);
}

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);

let focused: string[] = [];

/** 切换当前看盘市场/周期：订阅 K 线、弹幕、快讯频道 */
export function focusMarket(code: string, interval: string) {
  const next = [`kline:${code}:${interval}`, `danmaku:${code}`, `event:${code}`];
  const drop = focused.filter((c) => !next.includes(c));
  if (drop.length) realtime.unsubscribe(drop);
  realtime.subscribe(next);
  focused = next;
}

export function startRealtime(token: string) {
  realtime.on(handle);
  realtime.connect(token);
  const codes = useMarkets.getState().list.map((m) => m.code);
  realtime.subscribe(['broadcast', ...codes.map((c) => `tick:${c}`)]);
}

async function refreshPendingOrders() {
  const orders = await api.get<OrderView[]>('/orders?status=PENDING');
  useSession.setState({ orders });
}

function handle(msg: ServerMessage) {
  if ('op' in msg) {
    if (msg.op === 'error' && msg.d.code.startsWith('error.danmaku')) useFeed.getState().toast('error', errorText(msg.d.code));
    return;
  }
  const ch = msg.ch;
  if (ch.startsWith('tick:')) {
    const d = (msg as { d: { market: string; price: string; ts: number } }).d;
    useMarkets.getState().setPrice(d.market, d.price, d.ts);
  } else if (ch.startsWith('kline:')) {
    const d = (msg as { d: CandlePayload }).d;
    candleListeners.get(`${d.market}:${d.interval}`)?.forEach((l) => l(d));
  } else if (ch.startsWith('danmaku:')) {
    if (useSettings.getState().danmaku) useFeed.getState().pushDanmaku((msg as Extract<ServerMessage, { ch: `danmaku:${string}` }>).d);
  } else if (ch.startsWith('event:')) {
    useMarkets.getState().pushNews((msg as Extract<ServerMessage, { ch: `event:${string}` }>).d);
  } else if (ch === 'broadcast') {
    const b = (msg as Extract<ServerMessage, { ch: 'broadcast' }>).d;
    useFeed.getState().pushBanner(b);
    const me = useSession.getState().user?.id;
    if (b.kind === 'MARKET_EVENT') sound.play('event');
    if (b.kind === 'BIG_WIN' && b.userId === me) {
      if (useSettings.getState().vfx) useFeed.getState().triggerFx('bigWin', String(b.vars.pnl ?? ''));
      sound.play('bigWin');
    }
  } else if (ch === 'user') {
    void handleUser((msg as Extract<ServerMessage, { ch: 'user' }>).d);
  }
}

async function handleUser(e: UserEvent) {
  const session = useSession.getState();
  const feed = useFeed.getState();
  const vfx = useSettings.getState().vfx;
  switch (e.type) {
    case 'wallet':
      session.setWallet(e.wallet.balance, e.wallet.locked, e.wallet.generation);
      return;
    case 'position':
      session.setPosition(e.market, e.position);
      return;
    case 'bankruptcyAvailable':
      session.setBankruptcyAvailable(e.available);
      return;
    case 'order': {
      if (e.status === 'PENDING') {
        await refreshPendingOrders();
        feed.toast('info', t('toast.resting'));
        return;
      }
      session.removeOrder(e.orderId);
      if (e.status === 'REJECTED') {
        feed.toast('error', errorText(e.reason ?? 'error.unknown'));
        sound.play('error');
      } else if (e.status === 'CANCELLED') {
        feed.toast('info', t('toast.cancelled'));
      } else if (e.status === 'FILLED' && e.source !== 'LIQUIDATION') {
        const vars = { code: e.market, price: fmt(e.fillPrice), pnl: fmtSigned(e.realizedPnl) };
        if (e.source === 'TAKE_PROFIT') {
          feed.toast('success', t('toast.tpHit', vars));
          sound.play('win');
        } else if (e.source === 'STOP_LOSS') {
          feed.toast('error', t('toast.slHit', vars));
          sound.play('error');
        } else {
          feed.toast('success', t('toast.filled', vars));
          sound.play(e.realizedPnl && D(e.realizedPnl).gt(0) ? 'win' : 'fill');
        }
      }
      return;
    }
    case 'liquidated': {
      const isDeficit = D(e.deficit).gt(0);
      feed.toast('danger', t('toast.liquidated', { code: e.market, price: fmt(e.executionPrice), loss: fmt(e.totalLoss) }));
      if (isDeficit) feed.toast('danger', t('toast.deficit', { deficit: fmt(e.deficit), balance: fmt(e.balanceAfter) }));
      if (vfx) feed.triggerFx(isDeficit ? 'deficit' : 'liquidated', fmt(isDeficit ? e.deficit : e.totalLoss));
      sound.play('liquidation');
      return;
    }
    case 'resume': {
      const r = await api.get<ResumeView>(`/resumes/${e.resumeId}`);
      session.showResume(r);
      if (vfx) feed.triggerFx('bankrupt');
      sound.play('bankrupt');
      return;
    }
  }
}
