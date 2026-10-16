import { D, type PositionView, roundToStep, unrealizedPnl } from '@catpital/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { decimalsOf, fmt, fmtPct, fmtSigned, parseDec, sanitizeDecimalInput } from '../../lib/format';
import { useFeed } from '../../stores/feed';
import { useMarkets } from '../../stores/markets';
import { useSession } from '../../stores/session';

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

  return (
    <div className={`rounded-lg border p-3 ${danger ? 'border-blood/60 bg-blood/5' : 'border-ink-800 bg-ink-850'}`} data-testid={`position-${p.market}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs font-bold text-white ${p.side === 'LONG' ? 'bg-up' : 'bg-down'}`}>{t(`position.${p.side}`)}</span>
          <span className="font-semibold">{p.market}</span>
          <span className="rounded bg-ink-700 px-1.5 text-xs font-mono">{fmt(p.leverage, 2)}x</span>
        </div>
        <div className={`text-right font-mono tabular-nums ${upnl.gte(0) ? 'text-up' : 'text-down'}`}>
          <div className="text-base font-semibold">{fmtSigned(upnl)}</div>
          <div className="text-xs">{fmtPct(roe)}</div>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-xs sm:grid-cols-6">
        <Cell label={t('position.qty')} value={fmt(p.quantity, market ? decimalsOf(market.lotSize) : 2)} />
        <Cell label={t('position.entry')} value={fmt(p.entryPrice, dp)} />
        <Cell label={t('position.mark')} value={fmt(last, dp)} />
        <Cell label={t('position.liq')} value={liq.gt(0) ? fmt(liq, dp) : '—'} className="text-blood" />
        <Cell label={t('position.margin')} value={fmt(p.margin)} />
        <Cell label={`${t('chart.tp')}/${t('chart.sl')}`} value={`${p.takeProfitPrice ? fmt(p.takeProfitPrice, dp) : '—'} / ${p.stopLossPrice ? fmt(p.stopLossPrice, dp) : '—'}`} />
      </dl>
      {distance && (
        <div className="mt-2 h-1 overflow-hidden rounded bg-ink-700" title={t('position.distance', { pct: fmtPct(distance, 2, false) })}>
          <div className={`h-full ${danger ? 'bg-blood' : 'bg-amber-400/70'}`} style={{ width: `${Math.max(2, 100 - Math.min(100, distance.mul(1000).toNumber()))}%` }} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <Btn onClick={() => void act(() => api.post(`/positions/${p.market}/close`))} tone="primary" testId={`close-${p.market}`}>
          {t('position.close')}
        </Btn>
        {half.gt(0) && <Btn onClick={() => void act(() => api.post(`/positions/${p.market}/close`, { quantity: half.toFixed() }))}>{t('position.closeHalf')}</Btn>}
        <Btn onClick={() => setPanel(panel === 'margin' ? null : 'margin')}>{t('position.addMargin')}</Btn>
        <Btn onClick={() => setPanel(panel === 'tpsl' ? null : 'tpsl')}>{t('position.tpsl')}</Btn>
      </div>
      {panel === 'margin' && (
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
      {panel === 'tpsl' && (
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.patch(`/positions/${p.market}/tpsl`, { takeProfitPrice: tp || null, stopLossPrice: sl || null }), t('toast.saved')).then(() => setPanel(null));
          }}
        >
          <Input value={tp} onChange={setTp} placeholder={t('order.tp')} />
          <Input value={sl} onChange={setSl} placeholder={t('order.sl')} />
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
    className={`rounded-md px-2.5 py-1 ${tone === 'primary' ? 'bg-ink-600 text-ink-100 hover:bg-ink-500' : 'bg-ink-800 text-ink-300 hover:bg-ink-700'}`}
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
    className="w-28 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-xs outline-none focus:border-accent"
  />
);

export function PositionsPanel() {
  const { t } = useTranslation();
  const byMarket = useSession((s) => s.positions);
  const positions = Object.values(byMarket);
  if (!positions.length) return <p className="py-6 text-center text-sm text-ink-500">{t('position.empty')}</p>;
  return (
    <div className="grid gap-2 xl:grid-cols-2">
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
