import { D } from '@catpital/shared';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { fmt, sanitizeDecimalInput } from '../../lib/format';
import { errorText } from '../../i18n';
import { useMarkets } from '../../stores/markets';
import { useFeed } from '../../stores/feed';
import { Modal } from '../common/Modal';

/**
 * 临时管理面板（只对后端 ADMIN_PANEL_USERS 白名单里的人可见；按需懒加载）。
 *   - 事件：方向、跳空幅度、波动放大、趋势强度、延迟、持续时间；标题留空 = 静默事件
 *   - 用户：搜索、新建、改余额、看持仓 / 挂单 / 流水、强平 / 撤单、设管理员、删除
 */

interface PanelEvent {
  id: string;
  market: string;
  triggerAt: number;
  headline: string;
  gapPercent: string;
  driftAdjust: string;
  volMultiplier: string;
  durationSec: number;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  priceBefore: string | null;
  priceAfter: string | null;
}

interface PanelUserRow {
  id: string;
  username: string;
  globalName: string | null;
  generation: number;
  isAdmin: boolean;
  balance: string;
  netWorth: string;
  openPositions: number;
}

interface PanelUserDetail extends Omit<PanelUserRow, 'balance' | 'netWorth' | 'openPositions'> {
  createdAt: number;
  lastSeenAt: number;
  wallet: { balance: string; locked: string; netWorth: string };
  positions: Array<{ id: string; market: string; side: 'LONG' | 'SHORT'; quantity: string; entryPrice: string; leverage: string; margin: string; liquidationPrice: string; markPrice: string }>;
  orders: Array<{ id: string; market: string; side: string; type: string; quantity: string; limitPrice: string | null; leverage: string }>;
  ledger: Array<{ id: string; type: string; amount: string; balanceAfter: string; memo: string | null; at: number }>;
}

const input = 'w-full rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-sm outline-none focus:border-candy-grape';
const label = 'mb-1 block text-[11px] font-bold uppercase tracking-wide text-ink-400';
const btn = 'arcade-btn border-ink-950/60 px-3 py-1.5 text-sm font-bold disabled:opacity-40';
const chipBtn = (on: boolean) => `rounded-full px-3 py-1 text-xs font-bold ${on ? 'bg-candy-grape text-ink-950' : 'bg-ink-800 text-ink-300 hover:bg-ink-700'}`;

function useNotify() {
  const toast = useFeed((s) => s.toast);
  return useCallback((err: unknown) => toast('error', errorText((err as { code?: string }).code ?? 'error.unknown')), [toast]);
}

export default function AdminPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'events' | 'markets' | 'users' | 'exchanges'>('events');
  return (
    <Modal open={open} onClose={onClose} className="!max-w-3xl">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink-800 bg-ink-900 px-5 py-3">
        <span className="text-lg font-black">🛠 {t('panel.title')}</span>
        <div className="ml-3 flex gap-1.5">
          <button className={chipBtn(tab === 'events')} onClick={() => setTab('events')} data-testid="panel-tab-events">
            📰 {t('panel.tabs.events')}
          </button>
          <button className={chipBtn(tab === 'markets')} onClick={() => setTab('markets')} data-testid="panel-tab-markets">
            📈 {t('panel.tabs.markets')}
          </button>
          <button className={chipBtn(tab === 'users')} onClick={() => setTab('users')} data-testid="panel-tab-users">
            👥 {t('panel.tabs.users')}
          </button>
          <button className={chipBtn(tab === 'exchanges')} onClick={() => setTab('exchanges')} data-testid="panel-tab-exchanges">
            💱 {t('panel.tabs.exchanges')}
          </button>
        </div>
        <button className="ml-auto text-ink-400 hover:text-ink-100" onClick={onClose} aria-label={t('settings.close')}>
          ✕
        </button>
      </div>
      <div className="p-5">{tab === 'events' ? <EventsTab /> : tab === 'markets' ? <MarketsTab /> : tab === 'exchanges' ? <ExchangesTab /> : <UsersTab />}</div>
    </Modal>
  );
}

// =============================================================================
// Skylbot 兑换核对：超时且余额对不上、系统无法自动判断的兑换
// =============================================================================

interface PendingExchange {
  id: string;
  userId: string;
  name: string;
  direction: 'IN' | 'OUT';
  amount: string;
  error: string | null;
  createdAt: number;
}

function ExchangesTab() {
  const { t } = useTranslation();
  const notify = useNotify();
  const toast = useFeed((s) => s.toast);
  const [rows, setRows] = useState<PendingExchange[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = useCallback(() => api.get<PendingExchange[]>('/panel/exchanges/pending').then(setRows).catch(notify), [notify]);
  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (id: string, applied: boolean) => {
    const key = `${id}:${applied}`;
    if (confirm !== key) return setConfirm(key);
    try {
      await api.post(`/panel/exchanges/${id}/resolve`, { applied });
      toast('success', t('panel.exchange.done'));
    } catch (err) {
      notify(err);
    } finally {
      setConfirm(null);
      void load();
    }
  };

  return (
    <div className="space-y-3" data-testid="panel-exchanges">
      <p className="rounded-xl bg-candy-sky/10 px-3 py-2 text-xs text-candy-sky">ℹ {t('panel.exchange.hint')}</p>
      {rows && rows.length === 0 && <p className="text-sm text-ink-400">{t('panel.exchange.none')}</p>}
      {rows?.map((r) => (
        <div key={r.id} className="rounded-2xl border border-ink-700 p-3 text-sm" data-testid={`panel-exchange-${r.id}`}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-bold">{r.name}</span>
            <span className="font-mono text-[11px] text-ink-500">{r.userId}</span>
            <span className="ml-auto font-mono text-base font-black">{fmt(r.amount, 0)}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-400">
            <span>{t(r.direction === 'IN' ? 'panel.exchange.in' : 'panel.exchange.out')}</span>
            <span className="font-mono">{new Date(r.createdAt).toLocaleString()}</span>
            {r.error && <span className="font-mono text-ink-500">{r.error}</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className={`${btn} ${confirm === `${r.id}:true` ? 'bg-candy-mint text-ink-950' : 'bg-ink-800 text-candy-mint'}`} onClick={() => void resolve(r.id, true)} onBlur={() => setConfirm(null)}>
              ✓ {confirm === `${r.id}:true` ? t('panel.exchange.confirm') : t('panel.exchange.applied')}
            </button>
            <button className={`${btn} ${confirm === `${r.id}:false` ? 'bg-blood text-white' : 'bg-ink-800 text-blood'}`} onClick={() => void resolve(r.id, false)} onBlur={() => setConfirm(null)}>
              ✕ {confirm === `${r.id}:false` ? t('panel.exchange.confirm') : t('panel.exchange.notApplied')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// 市场定价
// =============================================================================

interface PanelMarket {
  code: string;
  name: string;
  nameI18n: Record<string, string>;
  dataSource: 'PROCEDURAL' | 'LIVE_API';
  status: string;
  tickSize: string;
  price: string;
  initialPrice: string;
  /** 均值回归锚点（程序随机市场；外部行情为 null） */
  anchor: string | null;
  reversionSpeed: string | null;
  feed: 'live' | 'fallback' | null;
}

function MarketsTab() {
  const { t } = useTranslation();
  const notify = useNotify();
  const [rows, setRows] = useState<PanelMarket[]>([]);
  const load = useCallback(() => api.get<PanelMarket[]>('/panel/markets').then(setRows).catch(notify), [notify]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3" data-testid="panel-markets">
      <p className="rounded-xl bg-candy-sun/10 px-3 py-2 text-xs text-candy-sun">⚠ {t('panel.market.warning')}</p>
      {rows.map((m) => (
        <MarketPriceRow key={m.code} m={m} onDone={() => void load()} />
      ))}
    </div>
  );
}

function MarketPriceRow({ m, onDone }: { m: PanelMarket; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const toast = useFeed((s) => s.toast);
  // 现价用实时行情（WS 推送），拿不到时用接口返回值
  const live = useMarkets((s) => s.prices[m.code]?.price) ?? m.price;
  const [price, setPrice] = useState('');
  const [anchor, setAnchor] = useState(true);
  const [busy, setBusy] = useState(false);
  const dp = m.tickSize.includes('.') ? m.tickSize.split('.')[1]!.length : 0;
  const procedural = m.dataSource === 'PROCEDURAL';
  const noReversion = procedural && m.reversionSpeed !== null && D(m.reversionSpeed).isZero();
  const target = price && D(price).gt(0) ? D(price) : null;
  const change = target ? target.div(live).minus(1).mul(100) : null;

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await api.post<{ before: string; after: string; anchored: boolean }>(`/panel/markets/${m.code}/price`, { price, anchor: procedural && anchor });
      toast('success', t('panel.market.done', { code: m.code, before: r.before, after: r.after }));
      setPrice('');
      onDone();
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-ink-700 p-3" data-testid={`panel-market-${m.code}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-black">{m.code}</span>
        <span className="text-xs text-ink-400">{m.nameI18n[i18n.language] ?? m.name}</span>
        <span className="ml-auto font-mono text-lg font-black tabular-nums">{fmt(live, dp)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] text-ink-500">
        <span>
          {t('panel.market.initial')} {fmt(m.initialPrice, dp)}
        </span>
        {m.anchor && (
          <span>
            ⚓ {t('panel.market.anchor')} {fmt(m.anchor, dp)}
          </span>
        )}
        {!procedural && <span className="text-candy-sky">📡 {t('panel.market.liveNote')}</span>}
        {noReversion && <span className="text-candy-sun">↘ {t('panel.market.noReversion')}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          className={`${input} w-40 font-mono`}
          inputMode="decimal"
          value={price}
          placeholder={fmt(live, dp)}
          onChange={(e) => setPrice(sanitizeDecimalInput(e.target.value, dp))}
          data-testid={`panel-price-${m.code}`}
        />
        <button className={chipBtn(false)} onClick={() => setPrice(D(m.initialPrice).toFixed(dp))}>
          ↺ {t('panel.market.toInitial')}
        </button>
        {change && (
          <span className={`font-mono text-xs font-bold ${change.gte(0) ? 'text-candy-mint' : 'text-blood'}`}>
            {change.gt(0) ? '+' : ''}
            {change.toFixed(2)}%
          </span>
        )}
        <button className={`${btn} ml-auto bg-candy-grape text-ink-950`} disabled={!target || busy} onClick={() => void submit()} data-testid={`panel-price-submit-${m.code}`}>
          {t('panel.market.apply')}
        </button>
      </div>
      {/* 没有均值回归的市场（κ = 0）改锚点没有意义，不显示 */}
      {procedural && !noReversion && (
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-ink-300">
          <input type="checkbox" checked={anchor} onChange={(e) => setAnchor(e.target.checked)} className="accent-candy-grape" />
          {t('panel.market.anchorToggle')}
        </label>
      )}
      <ClearHistory code={m.code} />
    </div>
  );
}

/** 清除市场历史：K 线 / 快讯，二次点击确认 */
function ClearHistory({ code }: { code: string }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const toast = useFeed((s) => s.toast);
  const [candles, setCandles] = useState(true);
  const [news, setNews] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!confirm) return setConfirm(true);
    setBusy(true);
    try {
      const r = await api.post<{ candlesDeleted: number; newsDeleted: number }>(`/panel/markets/${code}/clear-history`, { candles, news });
      toast('success', t('panel.market.cleared', { code, candles: r.candlesDeleted, news: r.newsDeleted }));
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-ink-800 pt-2 text-xs text-ink-300">
      <span className="font-bold text-ink-400">🧹 {t('panel.market.clearTitle')}</span>
      <label className="flex cursor-pointer items-center gap-1">
        <input type="checkbox" checked={candles} onChange={(e) => setCandles(e.target.checked)} className="accent-candy-grape" />
        {t('panel.market.clearCandles')}
      </label>
      <label className="flex cursor-pointer items-center gap-1">
        <input type="checkbox" checked={news} onChange={(e) => setNews(e.target.checked)} className="accent-candy-grape" />
        {t('panel.market.clearNews')}
      </label>
      <button
        className={`${btn} ml-auto ${confirm ? 'bg-blood text-white' : 'bg-ink-800 text-blood'}`}
        disabled={busy || (!candles && !news)}
        onClick={() => void run()}
        onBlur={() => setConfirm(false)}
        data-testid={`panel-clear-${code}`}
      >
        {confirm ? t('panel.market.clearConfirm') : t('panel.market.clear')}
      </button>
    </div>
  );
}

// =============================================================================
// 事件
// =============================================================================

const GAP_PRESETS = ['0', '5', '15', '30', '50'];
const VOL_PRESETS = ['1', '2', '5', '10', '20'];
const TREND_PRESETS = [
  ['0', 'none'],
  ['20', 'weak'],
  ['100', 'medium'],
  ['400', 'strong'],
] as const;
const DELAY_PRESETS = [0, 30, 300, 3600];
const DURATION_PRESETS = [60, 300, 900, 3600];
/** 预设时长的紧凑写法：30s / 5m / 1h */
const short = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}h` : sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`);

function EventsTab() {
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const toast = useFeed((s) => s.toast);
  const markets = useMarkets((s) => s.list);
  const [market, setMarket] = useState(markets.find((m) => m.status === 'ACTIVE')?.code ?? markets[0]?.code ?? '');
  const [direction, setDirection] = useState<'UP' | 'DOWN'>('DOWN');
  const [gapPct, setGapPct] = useState('15');
  const [vol, setVol] = useState('2');
  const [trend, setTrend] = useState('20');
  const [delay, setDelay] = useState(0);
  const [duration, setDuration] = useState(300);
  const [headline, setHeadline] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<PanelEvent[]>([]);

  const load = useCallback(() => api.get<PanelEvent[]>('/panel/events').then(setEvents).catch(notify), [notify]);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const gapInvalid = !gapPct || (direction === 'DOWN' && D(gapPct).gte(100));
  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/panel/events', {
        market, direction, gapPct, volMultiplier: vol, trend, delaySec: delay, durationSec: duration, headline, content,
      });
      toast('success', t('panel.event.created'));
      setHeadline('');
      setContent('');
      await load();
    } catch (err) {
      notify(err);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (id: string) => {
    await api.del(`/panel/events/${id}`).catch(notify);
    await load();
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <span className={label}>{t('panel.event.market')}</span>
          <select className={input} value={market} onChange={(e) => setMarket(e.target.value)} data-testid="panel-event-market">
            {markets.map((m) => (
              <option key={m.code} value={m.code}>
                {m.code} · {m.nameI18n[i18n.language] ?? m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className={label}>{t('panel.event.direction')}</span>
          <div className="flex gap-2">
            <button className={`${btn} flex-1 ${direction === 'UP' ? 'bg-candy-mint text-ink-950' : 'bg-ink-800'}`} onClick={() => setDirection('UP')} data-testid="panel-event-up">
              📈 {t('panel.event.up')}
            </button>
            <button className={`${btn} flex-1 ${direction === 'DOWN' ? 'bg-blood text-white' : 'bg-ink-800'}`} onClick={() => setDirection('DOWN')} data-testid="panel-event-down">
              📉 {t('panel.event.down')}
            </button>
          </div>
        </div>

        <div>
          <span className={label}>{t('panel.event.gap')}</span>
          <div className="flex items-center gap-2">
            <input className={`${input} w-24`} value={gapPct} inputMode="decimal" onChange={(e) => setGapPct(sanitizeDecimalInput(e.target.value, 2))} data-testid="panel-event-gap" />
            <span className="text-sm text-ink-400">%</span>
            <div className="flex flex-wrap gap-1">
              {GAP_PRESETS.map((g) => (
                <button key={g} className={chipBtn(gapPct === g)} onClick={() => setGapPct(g)}>
                  {g}%
                </button>
              ))}
            </div>
          </div>
          {gapInvalid && <p className="mt-1 text-xs text-blood">{t('panel.event.gapInvalid')}</p>}
        </div>
        <div>
          <span className={label}>{t('panel.event.vol')}</span>
          <div className="flex flex-wrap gap-1">
            {VOL_PRESETS.map((v) => (
              <button key={v} className={chipBtn(vol === v)} onClick={() => setVol(v)}>
                ×{v}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className={label}>{t('panel.event.trend')}</span>
          <div className="flex flex-wrap gap-1">
            {TREND_PRESETS.map(([v, k]) => (
              <button key={v} className={chipBtn(trend === v)} onClick={() => setTrend(v)}>
                {t(`panel.event.trendLevel.${k}`)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className={label}>{t('panel.event.delay')}</span>
          <div className="flex flex-wrap gap-1">
            {DELAY_PRESETS.map((d) => (
              <button key={d} className={chipBtn(delay === d)} onClick={() => setDelay(d)}>
                {d === 0 ? t('panel.event.now') : short(d)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className={label}>{t('panel.event.duration')}</span>
          <div className="flex flex-wrap gap-1">
            {DURATION_PRESETS.map((d) => (
              <button key={d} className={chipBtn(duration === d)} onClick={() => setDuration(d)}>
                {short(d)}
              </button>
            ))}
          </div>
        </div>

        <div className="md:col-span-2">
          <span className={label}>{t('panel.event.headline')}</span>
          <input className={input} value={headline} maxLength={200} placeholder={t('panel.event.headlinePlaceholder')} onChange={(e) => setHeadline(e.target.value)} data-testid="panel-event-headline" />
          <p className="mt-1 text-xs text-ink-400">{headline.trim() ? t('panel.event.loud') : t('panel.event.silent')}</p>
        </div>
        {headline.trim() && (
          <div className="md:col-span-2">
            <span className={label}>{t('panel.event.content')}</span>
            <textarea className={`${input} h-20 resize-none`} value={content} maxLength={2000} onChange={(e) => setContent(e.target.value)} />
          </div>
        )}
      </div>

      <button
        className={`${btn} w-full py-2.5 ${direction === 'UP' ? 'bg-candy-mint text-ink-950' : 'bg-blood text-white'}`}
        disabled={busy || gapInvalid || !market}
        onClick={() => void submit()}
        data-testid="panel-event-submit"
      >
        {t('panel.event.submit', {
          market,
          gap: `${direction === 'UP' ? '+' : '-'}${gapPct || 0}%`,
          when: delay === 0 ? t('panel.event.now') : short(delay),
        })}
      </button>

      <div>
        <h3 className="mb-2 text-sm font-black">{t('panel.event.recent')}</h3>
        {events.length === 0 ? (
          <p className="text-sm text-ink-400">{t('panel.empty')}</p>
        ) : (
          <ul className="space-y-1.5" data-testid="panel-event-list">
            {events.map((e) => (
              <li key={e.id} className="flex items-center gap-2 rounded-xl bg-ink-850 px-3 py-2 text-xs">
                <span className={`chip ${e.status === 'PENDING' ? 'text-candy-sun' : e.status === 'ACTIVE' ? 'text-candy-mint' : 'text-ink-400'}`}>
                  {t(`panel.status.${e.status}`)}
                </span>
                <span className="font-mono font-bold">{e.market}</span>
                <span className={`font-mono ${D(e.gapPercent).gte(0) ? 'text-candy-mint' : 'text-blood'}`}>
                  {D(e.gapPercent).gt(0) ? '+' : ''}
                  {D(e.gapPercent).mul(100).toFixed(1)}%
                </span>
                <span className="text-ink-400">×{e.volMultiplier}</span>
                <span className="min-w-0 flex-1 truncate">{e.headline || <em className="text-ink-500">{t('panel.event.silentTag')}</em>}</span>
                <span className="shrink-0 text-ink-500">{new Date(e.triggerAt).toLocaleTimeString()}</span>
                {(e.status === 'PENDING' || e.status === 'ACTIVE') && (
                  <button className="shrink-0 text-blood hover:underline" onClick={() => void cancel(e.id)} data-testid={`panel-event-stop-${e.id}`}>
                    {e.status === 'PENDING' ? t('panel.event.cancel') : t('panel.event.endNow')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// 用户
// =============================================================================

function UsersTab() {
  const { t } = useTranslation();
  const notify = useNotify();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PanelUserRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    (query: string) => api.get<PanelUserRow[]>(`/panel/users?q=${encodeURIComponent(query)}`).then(setRows).catch(notify),
    [notify],
  );
  useEffect(() => {
    const id = setTimeout(() => void load(q), 250);
    return () => clearTimeout(id);
  }, [q, load]);

  if (selected) {
    return (
      <UserDetail
        id={selected}
        onBack={() => {
          setSelected(null);
          void load(q);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input className={input} value={q} placeholder={t('panel.user.search')} onChange={(e) => setQ(e.target.value)} data-testid="panel-user-search" />
        <button className={`${btn} shrink-0 bg-candy-grape text-ink-950`} onClick={() => setCreating((v) => !v)} data-testid="panel-user-new">
          ＋ {t('panel.user.create')}
        </button>
      </div>
      {creating && (
        <CreateUser
          onDone={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-ink-400">{t('panel.empty')}</p>
      ) : (
        <ul className="divide-y divide-ink-800 overflow-hidden rounded-2xl bg-ink-850" data-testid="panel-user-list">
          {rows.map((u) => (
            <li key={u.id}>
              <button className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-ink-800" onClick={() => setSelected(u.id)}>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">
                    {u.globalName ?? u.username} {u.isAdmin && <span className="chip ml-1 text-candy-sun">admin</span>}
                  </div>
                  <div className="truncate font-mono text-[11px] text-ink-500">
                    @{u.username} · {u.id} · {t('wallet.generation', { n: u.generation })}
                  </div>
                </div>
                <div className="text-right font-mono text-xs">
                  <div className={D(u.balance).lt(0) ? 'text-blood' : ''}>🪙 {fmt(u.balance)}</div>
                  <div className="text-ink-400">💰 {fmt(u.netWorth)}</div>
                </div>
                <span className="chip shrink-0">📈 {u.openPositions}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateUser({ onDone }: { onDone: (id: string) => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const [id, setId] = useState('');
  const [username, setUsername] = useState('');
  const [balance, setBalance] = useState('');
  const valid = /^\d{5,25}$/.test(id) && username.trim().length > 0;
  const submit = async () => {
    try {
      await api.post('/panel/users', { id, username: username.trim(), ...(balance ? { balance } : {}) });
      onDone(id);
    } catch (err) {
      notify(err);
    }
  };
  return (
    <div className="grid gap-3 rounded-2xl border border-ink-700 p-3 md:grid-cols-[1fr_1fr_8rem_auto]">
      <input className={input} placeholder={t('panel.user.uid')} value={id} inputMode="numeric" onChange={(e) => setId(e.target.value.replace(/\D/g, ''))} data-testid="panel-create-id" />
      <input className={input} placeholder={t('panel.user.username')} value={username} maxLength={32} onChange={(e) => setUsername(e.target.value)} data-testid="panel-create-name" />
      <input className={input} placeholder={t('panel.user.initialBalance')} value={balance} inputMode="decimal" onChange={(e) => setBalance(sanitizeDecimalInput(e.target.value, 2))} />
      <button className={`${btn} bg-candy-mint text-ink-950`} disabled={!valid} onClick={() => void submit()} data-testid="panel-create-submit">
        {t('panel.user.createSubmit')}
      </button>
    </div>
  );
}

function UserDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const toast = useFeed((s) => s.toast);
  const [u, setU] = useState<PanelUserDetail | null>(null);
  const [mode, setMode] = useState<'add' | 'set'>('add');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => api.get<PanelUserDetail>(`/panel/users/${id}`).then(setU).catch(notify), [id, notify]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast('success', ok);
      await load();
    } catch (err) {
      notify(err);
    }
  };

  if (!u) return <p className="text-sm text-ink-400">…</p>;
  const amountValid = amount !== '' && amount !== '-' && (mode === 'add' ? !D(amount).isZero() : D(amount).gte(0));

  return (
    <div className="space-y-4" data-testid="panel-user-detail">
      <button className="text-sm text-ink-400 hover:text-ink-100" onClick={onBack}>
        ← {t('panel.user.back')}
      </button>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-black">{u.globalName ?? u.username}</div>
          <div className="font-mono text-xs text-ink-500">
            @{u.username} · {u.id} · {t('wallet.generation', { n: u.generation })}
          </div>
        </div>
        <div className="flex gap-2 font-mono text-sm">
          <span className="chip">🪙 {fmt(u.wallet.balance)}</span>
          <span className="chip">🔒 {fmt(u.wallet.locked)}</span>
          <span className="chip">💰 {fmt(u.wallet.netWorth)}</span>
        </div>
      </div>

      {/* 资金 */}
      <section className="rounded-2xl border border-ink-700 p-3">
        <h3 className="mb-2 text-sm font-black">{t('panel.user.funds')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button className={chipBtn(mode === 'add')} onClick={() => setMode('add')}>
            ± {t('panel.user.add')}
          </button>
          <button className={chipBtn(mode === 'set')} onClick={() => setMode('set')}>
            = {t('panel.user.set')}
          </button>
          <input
            className={`${input} w-36 font-mono`}
            value={amount}
            inputMode="decimal"
            placeholder={mode === 'add' ? '+1000 / -500' : '10000'}
            onChange={(e) => {
              const raw = e.target.value;
              const neg = mode === 'add' && raw.startsWith('-');
              setAmount((neg ? '-' : '') + sanitizeDecimalInput(raw.replace(/^[-+]/, ''), 2));
            }}
            data-testid="panel-funds-amount"
          />
          <input className={`${input} min-w-0 flex-1`} value={memo} maxLength={120} placeholder={t('panel.user.memo')} onChange={(e) => setMemo(e.target.value)} />
          <button
            className={`${btn} bg-candy-sun text-ink-950`}
            disabled={!amountValid}
            onClick={() =>
              void run(async () => {
                await api.post(`/panel/users/${u.id}/balance`, { mode, amount, ...(memo ? { memo } : {}) });
                setAmount('');
                setMemo('');
              }, t('panel.user.fundsDone'))
            }
            data-testid="panel-funds-submit"
          >
            {t('panel.user.apply')}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-500">{t('panel.user.fundsHint')}</p>
      </section>

      {/* 持仓 */}
      <section>
        <h3 className="mb-2 text-sm font-black">
          {t('position.title')} ({u.positions.length})
        </h3>
        {u.positions.length === 0 ? (
          <p className="text-sm text-ink-400">{t('panel.empty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {u.positions.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-ink-850 px-3 py-2 font-mono text-xs">
                <span className={`font-bold ${p.side === 'LONG' ? 'text-candy-mint' : 'text-blood'}`}>
                  {p.market} {t(`position.${p.side}`)} {D(p.leverage).toFixed(0)}x
                </span>
                <span>
                  {t('position.qty')} {p.quantity}
                </span>
                <span>
                  {t('position.entry')} {p.entryPrice}
                </span>
                <span>
                  {t('position.mark')} {D(p.markPrice).toFixed(4)}
                </span>
                <span>
                  {t('position.margin')} {fmt(p.margin)}
                </span>
                <span className="text-blood">
                  {t('position.liq')} {p.liquidationPrice}
                </span>
                <button className="ml-auto font-sans font-bold text-candy-sun hover:underline" onClick={() => void run(() => api.post(`/panel/users/${u.id}/positions/${p.market}/close`))}>
                  {t('position.close')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 挂单 */}
      {u.orders.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-black">
            {t('orders.title')} ({u.orders.length})
          </h3>
          <ul className="space-y-1.5">
            {u.orders.map((o) => (
              <li key={o.id} className="flex items-center gap-2 rounded-xl bg-ink-850 px-3 py-2 font-mono text-xs">
                <span className="font-bold">
                  {o.market} {o.side} {o.type}
                </span>
                <span>{o.quantity}</span>
                {o.limitPrice && <span>@ {o.limitPrice}</span>}
                <button className="ml-auto font-sans font-bold text-blood hover:underline" onClick={() => void run(() => api.del(`/panel/users/${u.id}/orders/${o.id}`))}>
                  {t('orders.cancel')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 流水 */}
      <section>
        <h3 className="mb-2 text-sm font-black">{t('panel.user.ledger')}</h3>
        <div className="max-h-48 overflow-y-auto rounded-xl bg-ink-850">
          <table className="w-full font-mono text-[11px]">
            <tbody>
              {u.ledger.map((l) => (
                <tr key={l.id} className="border-b border-ink-800 last:border-0">
                  <td className="px-2 py-1 text-ink-500">{new Date(l.at).toLocaleString()}</td>
                  <td className="px-2 py-1">{l.type}</td>
                  <td className={`px-2 py-1 text-right ${D(l.amount).lt(0) ? 'text-blood' : 'text-candy-mint'}`}>{fmt(l.amount)}</td>
                  <td className="px-2 py-1 text-right text-ink-400">{fmt(l.balanceAfter)}</td>
                  <td className="max-w-[10rem] truncate px-2 py-1 text-ink-500">{l.memo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 危险操作 */}
      <section className="flex flex-wrap items-center gap-2 border-t border-ink-800 pt-4">
        <button
          className={`${btn} ml-auto ${confirmDelete ? 'bg-blood text-white' : 'bg-ink-800 text-blood'}`}
          onClick={() => {
            if (!confirmDelete) return setConfirmDelete(true);
            void api
              .del(`/panel/users/${u.id}`)
              .then(() => {
                toast('success', t('panel.user.deleted'));
                onBack();
              })
              .catch(notify);
          }}
          onBlur={() => setConfirmDelete(false)}
          data-testid="panel-user-delete"
        >
          🗑 {confirmDelete ? t('panel.user.deleteConfirm') : t('panel.user.delete')}
        </button>
      </section>
    </div>
  );
}
