import { D, type Decimal, type PositionView, ZERO, applyFill, maxOpenQuantity, roundToStep } from '@catpital/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../i18n';
import { ApiError, type MarketInfo, api } from '../../lib/api';
import { decimalsOf, fmt, parseDec, sanitizeDecimalInput } from '../../lib/format';
import { sound } from '../../lib/sound';
import { useFeed } from '../../stores/feed';
import { useMarkets } from '../../stores/markets';
import { useSession } from '../../stores/session';

type Mode = 'spot' | 'lev';
type Action = 'buy' | 'sell' | 'long' | 'short';

const toState = (p: PositionView | undefined) =>
  p ? { side: p.side, quantity: D(p.quantity), entryPrice: D(p.entryPrice), margin: D(p.margin) } : null;

function Field({ label, value, onChange, suffix, placeholder, testId }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: React.ReactNode;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-ink-400">{label}</span>
      <div className="flex items-center rounded-md border border-ink-700 bg-ink-850 focus-within:border-accent">
        <input
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(sanitizeDecimalInput(e.target.value))}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm tabular-nums outline-none placeholder:text-ink-600"
          data-testid={testId}
        />
        {suffix && <span className="pr-3 text-xs text-ink-500">{suffix}</span>}
      </div>
    </label>
  );
}

export function OrderPanel({ market }: { market: MarketInfo }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('lev');
  const [action, setAction] = useState<Action>('long');
  const [type, setType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [qty, setQty] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [lev, setLev] = useState(10);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [busy, setBusy] = useState(false);

  const balance = useSession((s) => s.balance);
  const position = useSession((s) => s.positions[market.code]);
  const last = useMarkets((s) => s.prices[market.code]?.price ?? market.price);
  const toast = useFeed((s) => s.toast);

  const maxLev = D(market.maxLeverage).toNumber();
  const isSpot = mode === 'spot';
  const side = action === 'buy' || action === 'long' ? 'BUY' : 'SELL';
  const reduceOnly = action === 'sell';
  const leverage = isSpot ? D(1) : D(lev);
  const priceDp = decimalsOf(market.tickSize);
  const qtyDp = decimalsOf(market.lotSize);
  const refPrice: Decimal = type === 'LIMIT' ? (parseDec(limitPrice) ?? D(last)) : D(last);
  const feeRate = D(type === 'LIMIT' ? market.makerFeeRate : market.takerFeeRate);
  const risk = { maintenanceMarginRate: D(market.maintenanceMarginRate), tickSize: D(market.tickSize) };

  const maxQty = useMemo(() => {
    if (reduceOnly) return position?.side === 'LONG' ? D(position.quantity) : ZERO;
    return maxOpenQuantity(D(balance), refPrice, leverage, feeRate, D(market.lotSize));
  }, [reduceOnly, position, balance, refPrice, leverage, feeRate, market.lotSize]);

  // 与后端同一份公式：预估保证金、手续费、斩杀线
  const preview = useMemo(() => {
    const q = parseDec(qty);
    if (!q || q.lte(0) || refPrice.lte(0)) return null;
    try {
      return applyFill(toState(position), { orderSide: side, quantity: q, price: refPrice, leverage, feeRate, reduceOnly }, risk);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty, refPrice, side, leverage, feeRate, reduceOnly, position, market.code]);

  const setPct = (pct: number) => {
    setQty(roundToStep(maxQty.mul(pct).div(100), D(market.lotSize), 'down').toFixed(qtyDp));
  };

  const submit = async () => {
    const q = parseDec(qty);
    if (!q) return;
    setBusy(true);
    sound.unlock();
    try {
      await api.post('/orders', {
        market: market.code,
        side,
        type,
        quantity: q.toFixed(),
        leverage: leverage.toFixed(),
        limitPrice: type === 'LIMIT' ? limitPrice : undefined,
        reduceOnly,
        clientOrderId: crypto.randomUUID(),
        takeProfitPrice: !reduceOnly && tp ? tp : undefined,
        stopLossPrice: !reduceOnly && sl ? sl : undefined,
      });
      setTp('');
      setSl('');
    } catch (e) {
      toast('error', errorText(e instanceof ApiError ? e.code : 'error.network'));
      sound.play('error');
    } finally {
      setBusy(false);
    }
  };

  const actions: Action[] = isSpot ? ['buy', 'sell'] : ['long', 'short'];
  // 与后端同一校验：平仓收益先抵扣，剩余可用资金需覆盖新开部分的保证金 + 手续费
  const insufficient = Boolean(preview && preview.requiredFunds.gt(D(balance).plus(preview.closeSettlement)));
  const disabled = busy || !preview || insufficient || market.status !== 'ACTIVE' || (type === 'MARKET' && !market.open);
  const buyish = side === 'BUY';

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-ink-800 bg-ink-900 p-3" data-testid="order-panel">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-ink-850 p-1 text-sm">
        {(['spot', 'lev'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setAction(m === 'spot' ? 'buy' : 'long');
            }}
            className={`rounded-md py-1.5 ${mode === m ? 'bg-ink-700 font-medium' : 'text-ink-400'}`}
          >
            {t(m === 'spot' ? 'order.spot' : 'order.leverage')}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {actions.map((a) => {
          const isBuy = a === 'buy' || a === 'long';
          const active = action === a;
          return (
            <button
              key={a}
              onClick={() => setAction(a)}
              className={`rounded-md py-2 text-sm font-semibold transition-colors ${
                active ? (isBuy ? 'bg-up text-white' : 'bg-down text-white') : 'bg-ink-850 text-ink-400 hover:text-ink-200'
              }`}
            >
              {t(`order.${a}`)}
            </button>
          );
        })}
      </div>

      <div className="flex gap-3 text-sm">
        {(['MARKET', 'LIMIT'] as const).map((ty) => (
          <button key={ty} onClick={() => setType(ty)} className={type === ty ? 'font-medium text-ink-100' : 'text-ink-500'}>
            {t(ty === 'MARKET' ? 'order.market' : 'order.limit')}
          </button>
        ))}
      </div>

      {type === 'LIMIT' && <Field label={t('order.price')} value={limitPrice} onChange={setLimitPrice} placeholder={fmt(last, priceDp)} testId="limit-price" />}

      <Field
        label={t('order.quantity')}
        value={qty}
        onChange={setQty}
        testId="order-qty"
        suffix={
          <button className="text-accent" onClick={() => setPct(100)}>
            {t('order.max')} {fmt(maxQty, qtyDp)}
          </button>
        }
      />
      <div className="grid grid-cols-4 gap-1">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} onClick={() => setPct(p)} className="rounded bg-ink-850 py-1 text-xs text-ink-400 hover:bg-ink-800 hover:text-ink-200">
            {p}%
          </button>
        ))}
      </div>

      {!isSpot && (
        <div>
          <div className="mb-1 flex justify-between text-xs">
            <span className="text-ink-400">{t('order.lev')}</span>
            <span className={`font-mono font-semibold ${lev >= 50 ? 'text-blood' : lev >= 20 ? 'text-amber-400' : 'text-ink-100'}`}>{lev}x</span>
          </div>
          <input
            type="range"
            min={1}
            max={maxLev}
            value={lev}
            onChange={(e) => setLev(Number(e.target.value))}
            className="w-full accent-accent"
            data-testid="leverage"
          />
          <div className="flex justify-between text-[10px] text-ink-500">
            {[1, Math.round(maxLev / 4), Math.round(maxLev / 2), maxLev].map((v) => (
              <button key={v} onClick={() => setLev(v)}>
                {v}x
              </button>
            ))}
          </div>
        </div>
      )}

      {!reduceOnly && (
        <div className="grid grid-cols-2 gap-2">
          <Field label={`${t('order.tp')} (${t('order.optional')})`} value={tp} onChange={setTp} />
          <Field label={`${t('order.sl')} (${t('order.optional')})`} value={sl} onChange={setSl} />
        </div>
      )}
      {reduceOnly && <p className="text-xs text-ink-500">{t('order.sellHint')}</p>}

      <dl className="space-y-1 rounded-lg bg-ink-850 p-2.5 text-xs">
        <Row label={t('order.available')} value={fmt(balance)} danger={D(balance).lt(0)} />
        <Row label={t('order.notional')} value={preview ? fmt(D(qty || '0').mul(refPrice)) : '—'} />
        <Row label={t('order.margin')} value={preview ? fmt(preview.openMargin) : '—'} danger={insufficient} />
        <Row label={t('order.fee')} value={preview ? fmt(preview.totalFee, 4) : '—'} />
        {!reduceOnly && (
          <Row
            label={t('order.liqPrice')}
            value={
              preview?.position
                ? preview.position.liquidationPrice.gt(0)
                  ? fmt(preview.position.liquidationPrice, priceDp)
                  : t('order.noLiq')
                : '—'
            }
            danger
          />
        )}
        {preview && preview.closedQuantity.gt(0) && !reduceOnly && (
          <p className="pt-1 text-amber-400">{t('order.closing', { qty: fmt(preview.closedQuantity, qtyDp) })}</p>
        )}
      </dl>

      {!isSpot && lev >= 20 && <p className="rounded-md bg-blood/10 px-2 py-1.5 text-xs text-blood">⚠ {t('order.highLevWarn')}</p>}

      <button
        disabled={disabled}
        onClick={() => void submit()}
        className={`rounded-lg py-2.5 text-sm font-bold text-white shadow-lg transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
          buyish ? 'bg-up shadow-up/20' : 'bg-down shadow-down/20'
        }`}
        data-testid="submit-order"
      >
        {insufficient ? t('error.insufficientFunds') : t(`order.submit.${action}`, { code: market.code })}
      </button>
    </section>
  );
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-500">{label}</dt>
      <dd className={`font-mono tabular-nums ${danger ? 'text-blood' : 'text-ink-200'}`}>{value}</dd>
    </div>
  );
}
