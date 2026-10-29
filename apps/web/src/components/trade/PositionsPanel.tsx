import { D, type PositionView, roundToStep, unrealizedPnl } from '@catpital/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { decimalsOf, fmt, fmtPct, fmtSigned, parseDec, sanitizeDecimalInput } from '../../lib/format';
import { useFeed } from '../../stores/feed';
import { useMarkets } from '../../stores/markets';
import { useSession } from '../../stores/session';
import { codeLabel, mascotOf } from '../layout/MarketTabs';

async function act(fn: () => Promise<unknown>, okText?: string) {
  try {
    const res = (await fn()) as { warning?: string } | undefined;
    if (res?.warning) useFeed.getState().toast('info', errorText(res.warning));
    else if (okText) useFeed.getState().toast('success', okText);
  } catch (e) {
    useFeed.getState().toast('error', errorText(e instanceof ApiError ? e.code : 'error.network'));
  }
}

function PositionRow({ p }: { p: PositionView }) {
  const { t } = useTranslation();
  const market = useMarkets((s) => s.list.find((m) => m.code === p.market));
  const last = useMarkets((s) => s.prices[p.market]?.price ?? p.entryPrice);
  const [panel, setPanel] = useState<null | 'margin' | 'tpsl'>(null);
  const [amount, setAmount] = useState('');
  const [tp, setTp] = useState(p.takeProfitPrice ?? '');
  const [sl, setSl] = useState(p.stopLossPrice ?? '');
  const dp = market ? decimalsOf(market.tickSize) : 2;

  const state = { side: p.side, quantity: D(p.quantity), entryPrice: D(p.entryPrice), margin: D(p.margin) };
  const upnl = unrealizedPnl(state, D(last));
  const roe = upnl.div(p.margin);
  const liq = D(p.liquidationPrice);
  const distance = liq.gt(0) ? D(last).minus(liq).abs().div(last) : null;
  const danger = distance !== null && distance.lt('0.03');
  const half = market ? roundToStep(D(p.quantity).div(2), D(market.lotSize), 'down') : D(0);
  /** 市场暂停交易：持仓冻结，平仓 / 追加保证金 / 改止盈止损都不可用 */
  const frozen = market?.status === 'HALTED';

  return (
    <div
      className={`rounded-2xl border-2 p-3 ${danger ? 'border-blood/70 bg-blood/[0.08] shadow-[0_0_18px_-4px_#ff3b5c]' : 'border-ink-700/70 bg-ink-850/80'}`}
      data-testid={`position-${p.market}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xl">{mascotOf(p.market, market?.kind)}</span>
          <span className="font-extrabold">{codeLabel(p.market, market?.kind)}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold text-white ${p.side === 'LONG' ? 'bg-up' : 'bg-down'}`}>
            {p.side === 'LONG' ? '📈' : '📉'} {t(`position.${p.side}`)}
          </span>
          <span className="rounded-full bg-ink-700 px-2 py-0.5 font-mono text-[11px] font-bold">{fmt(p.leverage, 1)}x</span>
        </div>
        <div className={`text-right font-mono tabular-nums ${upnl.gte(0) ? 'text-up' : 'text-down'}`}>
          <div className="text-lg font-black leading-tight">{fmtSigned(upnl)}</div>
          <div className="text-xs font-bold">{fmtPct(roe)}</div>
        </div>
      </div>
      {/* 固定 3 列：卡片宽度取决于所在栏而不是视口，sm:grid-cols-6 在侧栏里放不下 */}
      <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
        <Cell label={t('position.qty')} value={fmt(p.quantity, market ? decimalsOf(market.lotSize) : 2)} />
        <Cell label={t('position.entry')} value={fmt(p.entryPrice, dp)} />
        <Cell label={t('position.mark')} value={fmt(last, dp)} />
        <Cell label={`💀 ${t('position.liq')}`} value={liq.gt(0) ? fmt(liq, dp) : '🛡️'} className="text-blood" />
        <Cell label={t('position.margin')} value={fmt(p.margin)} />
        <Cell label={`${t('chart.tp')}/${t('chart.sl')}`} value={`${p.takeProfitPrice ? fmt(p.takeProfitPrice, dp) : '—'} / ${p.stopLossPrice ? fmt(p.stopLossPrice, dp) : '—'}`} />
      </dl>
      {distance && (
        <div className="mt-2 h-1 overflow-hidden rounded bg-ink-700" title={t('position.distance', { pct: fmtPct(distance, 2, false) })}>
          <div className={`h-full ${danger ? 'bg-blood' : 'bg-amber-400/70'}`} style={{ width: `${Math.max(2, 100 - Math.min(100, distance.mul(1000).toNumber()))}%` }} />
        </div>
      )}
      {frozen ? (
        <p className="mt-2 rounded-xl bg-candy-sun/10 px-3 py-1.5 text-xs font-bold text-candy-sun" data-testid={`frozen-${p.market}`}>
          ⏸ {t('position.frozen')}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          <Btn onClick={() => void act(() => api.post(`/positions/${p.market}/close`))} tone="primary" testId={`close-${p.market}`}>
            {t('position.close')}
          </Btn>
          {half.gt(0) && <Btn onClick={() => void act(() => api.post(`/positions/${p.market}/close`, { quantity: half.toFixed() }))}>{t('position.closeHalf')}</Btn>}
          <Btn onClick={() => setPanel(panel === 'margin' ? null : 'margin')}>{t('position.addMargin')}</Btn>
          <Btn onClick={() => setPanel(panel === 'tpsl' ? null : 'tpsl')}>{t('position.tpsl')}</Btn>
        </div>
      )}
      {!frozen && panel === 'margin' && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!parseDec(amount)) return;
            void act(() => api.post(`/positions/${p.market}/margin`, { amount }), t('toast.marginAdded')).then(() => {
              setAmount('');
              setPanel(null);
            });
          }}
        >
          <Input value={amount} onChange={setAmount} placeholder={t('position.amount')} />
          <Btn type="submit" tone="primary">{t('position.add')}</Btn>
        </form>
      )}
      {!frozen && panel === 'tpsl' && (
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.patch(`/positions/${p.market}/tpsl`, { takeProfitPrice: tp || null, stopLossPrice: sl || null }), t('toast.saved')).then(() => setPanel(null));
          }}
        >
          <Input value={tp} onChange={setTp} placeholder={t('chart.tp')} />
          <Input value={sl} onChange={setSl} placeholder={t('chart.sl')} />
          <Btn type="submit" tone="primary">{t('position.save')}</Btn>
          <Btn
            onClick={() => {
              setTp('');
              setSl('');
            }}
          >
            {t('position.clear')}
          </Btn>
        </form>
      )}
    </div>
  );
}

const Cell = ({ label, value, className = '' }: { label: string; value: string; className?: string }) => (
  <div>
    <dt className="text-ink-500">{label}</dt>
    <dd className={`font-mono tabular-nums text-ink-200 ${className}`}>{value}</dd>
  </div>
);

const Btn = ({ children, onClick, tone, type = 'button', testId }: { children: React.ReactNode; onClick?: () => void; tone?: 'primary'; type?: 'button' | 'submit'; testId?: string }) => (
  <button
    type={type}
    onClick={onClick}
    data-testid={testId}
    className={`rounded-full px-3 py-1 font-bold transition-colors ${tone === 'primary' ? 'bg-candy-grape text-white shadow-[0_2px_0_0_#6b4bc4] hover:brightness-110' : 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100'}`}
  >
    {children}
  </button>
);

const Input = ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) => (
  <input
    inputMode="decimal"
    value={value}
    placeholder={placeholder}
    onChange={(e) => onChange(sanitizeDecimalInput(e.target.value))}
    className="w-28 rounded-full border border-ink-700 bg-ink-900 px-3 py-1 font-mono text-xs outline-none focus:border-candy-grape"
  />
);

export function PositionsPanel() {
  const { t } = useTranslation();
  const byMarket = useSession((s) => s.positions);
  const positions = Object.values(byMarket);
  if (!positions.length) return <p className="py-6 text-center text-sm text-ink-500">{t('position.empty')}</p>;
  return (
    // 一行一个仓位：卡片放在窄侧栏里，按视口宽度分多列会把卡片挤扁、数字叠在一起
    <div className="grid gap-2">
      {positions.map((p) => (
        <PositionRow key={p.id} p={p} />
      ))}
    </div>
  );
}

export function OrdersPanel() {
  const { t } = useTranslation();
  const orders = useSession((s) => s.orders);
  if (!orders.length) return <p className="py-6 text-center text-sm text-ink-500">{t('orders.empty')}</p>;
  return (
    <ul className="divide-y divide-ink-800 text-sm">
      {orders.map((o) => (
        <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="flex items-center gap-2">
            <span className={o.side === 'BUY' ? 'text-up' : 'text-down'}>{o.side}</span>
            <span className="font-semibold">{o.market}</span>
            <span className="font-mono text-xs text-ink-400">
              {fmt(o.quantity, 4)} @ {fmt(o.limitPrice)} · {fmt(o.leverage, 0)}x
            </span>
          </span>
          <span className="flex items-center gap-3">
            {o.lockedAmount && <span className="text-xs text-ink-500">{t('orders.locked', { amount: fmt(o.lockedAmount) })}</span>}
            <button className="rounded bg-ink-800 px-2 py-1 text-xs hover:bg-ink-700" onClick={() => void act(() => api.del(`/orders/${o.id}`))}>
              {t('orders.cancel')}
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 左下 Bento 卡片：持仓 / 挂单 两个页签，内容区独立滚动 */
export function PositionsCard({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'positions' | 'orders'>('positions');
  const positionCount = Object.keys(useSession((s) => s.positions)).length;
  const orderCount = useSession((s) => s.orders.length);
  const tabCls = (active: boolean) =>
    `flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold transition-colors ${active ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'}`;
  return (
    <section className={`bento flex min-h-0 flex-col p-3 ${className}`} data-testid="positions-card">
      <div className="mb-2 flex items-center gap-1">
        <button className={tabCls(tab === 'positions')} onClick={() => setTab('positions')}>
          💼 {t('position.title')}
          {positionCount > 0 && <span className="rounded-full bg-candy-grape px-1.5 text-[10px] text-white">{positionCount}</span>}
        </button>
        <button className={tabCls(tab === 'orders')} onClick={() => setTab('orders')}>
          🎯 {t('orders.title')}
          {orderCount > 0 && <span className="rounded-full bg-candy-sky px-1.5 text-[10px] text-ink-950">{orderCount}</span>}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">{tab === 'positions' ? <PositionsPanel /> : <OrdersPanel />}</div>
    </section>
  );
}
