import { D, type Decimal, type PositionView, applyFill } from '@catpital/shared';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../i18n';
import { ApiError, type MarketInfo, api } from '../../lib/api';
import { decimalsOf, fmt, parseDec, sanitizeDecimalInput } from '../../lib/format';
import {
  MARKET_PRICE_BUFFER,
  TIER_COLOR,
  budgetForPct,
  leveragePresets,
  leverageTier,
  sizeFromBudget,
} from '../../lib/orderSizing';
import { sound } from '../../lib/sound';
import { useFeed } from '../../stores/feed';
import { useMarkets } from '../../stores/markets';
import { useSession } from '../../stores/session';
import { useTradePreview } from '../../stores/tradePreview';

type Side = 'BUY' | 'SELL';

const toState = (p: PositionView | undefined) =>
  p ? { side: p.side, quantity: D(p.quantity), entryPrice: D(p.entryPrice), margin: D(p.margin) } : null;

const PCTS = [25, 50, 75, 100] as const;

/**
 * 快捷交易面板（面向新手）：
 *   做多 / 做空 → 拖杠杆 → 输入"投入本金" → 下单。
 *   默认市价逐仓；1x 即现货。限价单收在一个轻量开关里。止盈止损在持仓卡片上设置。
 */
export function OrderPanel({ market }: { market: MarketInfo }) {
  const { t } = useTranslation();
  const [side, setSide] = useState<Side>('BUY');
  const [lev, setLev] = useState(5);
  const [amount, setAmount] = useState('');
  const [limitOn, setLimitOn] = useState(false);
  const [limitPrice, setLimitPrice] = useState('');
  const [busy, setBusy] = useState(false);

  const balance = useSession((s) => s.balance);
  const position = useSession((s) => s.positions[market.code]);
  const last = useMarkets((s) => s.prices[market.code]?.price ?? market.price);
  const toast = useFeed((s) => s.toast);

  const maxLev = Math.max(1, D(market.maxLeverage).floor().toNumber());
  const leverage = Math.min(lev, maxLev);
  const tier = leverageTier(leverage);
  const tierColor = TIER_COLOR[tier];
  const priceDp = decimalsOf(market.tickSize);
  const available = D(balance);
  const budget = parseDec(amount);
  const limitPx = limitOn ? parseDec(limitPrice) : null;
  const refPrice: Decimal = limitPx ?? D(last);
  const feeRate = D(limitOn ? market.makerFeeRate : market.takerFeeRate);
  const risk = { maintenanceMarginRate: D(market.maintenanceMarginRate), tickSize: D(market.tickSize) };

  const sizing = useMemo(() => {
    if (!budget || budget.lte(0)) return null;
    const quantity = sizeFromBudget({
      budget,
      price: refPrice,
      leverage: D(leverage),
      feeRate,
      lotSize: D(market.lotSize),
      buffer: limitOn ? undefined : MARKET_PRICE_BUFFER,
    });
    if (quantity.lte(0)) return { quantity, fill: null };
    // 与后端同一份公式：合并/抵扣后的保证金、手续费、斩杀线
    const fill = applyFill(
      toState(position),
      { orderSide: side, quantity, price: refPrice, leverage: D(leverage), feeRate, reduceOnly: false },
      risk,
    );
    return { quantity, fill };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, refPrice.toFixed(), leverage, side, limitOn, position, market.code]);

  const notional = sizing?.fill ? sizing.quantity.mul(refPrice) : null;
  const liq = sizing?.fill?.position?.liquidationPrice ?? null;

  // 把预估斩杀线同步给 K 线图（1x 多单斩杀线为 0 → 不画）
  const previewLiq = liq && liq.gt(0) ? liq.toFixed() : null;
  useEffect(() => {
    useTradePreview.getState().set(market.code, previewLiq);
  }, [market.code, previewLiq]);
  useEffect(() => () => useTradePreview.getState().clear(), []);

  // ---- 按钮状态（与后端校验一致，提前告诉玩家为什么不能下单）----
  let blocker: string | null = null;
  if (market.status !== 'ACTIVE') blocker = t('error.marketHalted');
  else if (!limitOn && !market.open) blocker = t('error.marketClosed');
  else if (!budget || budget.lte(0)) blocker = t('order.enterAmount');
  else if (budget.gt(available)) blocker = t('error.insufficientFunds');
  else if (limitOn && !limitPx) blocker = t('order.enterPrice');
  else if (!sizing?.fill || !notional || notional.lt(market.minNotional)) blocker = t('order.tooSmall', { min: fmt(market.minNotional) });

  const pick = (pct: number) => {
    sound.play('click');
    const b = budgetForPct(available, pct);
    setAmount(b.gt(0) ? b.toFixed() : '');
  };

  const submit = async () => {
    if (blocker || !sizing?.fill) return;
    setBusy(true);
    sound.unlock();
    try {
      await api.post('/orders', {
        market: market.code,
        side,
        type: limitOn ? 'LIMIT' : 'MARKET',
        quantity: sizing.quantity.toFixed(),
        leverage: String(leverage),
        limitPrice: limitOn ? limitPrice : undefined,
        clientOrderId: crypto.randomUUID(),
      });
      setAmount('');
    } catch (e) {
      toast('error', errorText(e instanceof ApiError ? e.code : 'error.network'));
      sound.play('error');
    } finally {
      setBusy(false);
    }
  };

  const isLong = side === 'BUY';

  return (
    <section className="bento flex flex-col gap-2.5 p-3.5" data-testid="order-panel">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-extrabold">⚡ {t('order.title')}</h2>
        <span className="chip font-mono">{market.code}</span>
      </header>

      {/* 做多 / 做空 */}
      <div className="grid grid-cols-2 gap-2">
        {(['BUY', 'SELL'] as const).map((s) => {
          const active = side === s;
          const long = s === 'BUY';
          return (
            <button
              key={s}
              onClick={() => {
                sound.play('click');
                setSide(s);
              }}
              className={`arcade-btn flex flex-col items-center py-2 ${
                active
                  ? long
                    ? 'border-black/25 bg-up text-white shadow-[0_0_24px_-6px_rgb(var(--c-up))]'
                    : 'border-black/25 bg-down text-white shadow-[0_0_24px_-6px_rgb(var(--c-down))]'
                  : 'border-ink-950/60 bg-ink-800 text-ink-400 hover:text-ink-200'
              }`}
              data-testid={long ? 'side-long' : 'side-short'}
            >
              <span className="text-lg leading-none">{long ? '📈' : '📉'}</span>
              <span className="mt-1 text-sm">{t(long ? 'order.long' : 'order.short')}</span>
              <span className="text-[10px] font-semibold opacity-75">{t(long ? 'order.longHint' : 'order.shortHint')}</span>
            </button>
          );
        })}
      </div>

      {/* 杠杆：趣味档位 */}
      <div className="rounded-2xl bg-ink-850/80 px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-ink-400">{t('order.lev')}</span>
          <span className="flex items-center gap-2">
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-xs font-extrabold ${tier === 'degen' ? 'animate-wiggle' : ''}`}
              style={{ backgroundColor: `${tierColor}26`, color: tierColor }}
              data-testid="lev-tier"
            >
              {t(`order.tier.${tier}`)}
            </span>
            <span className="font-mono text-xl font-black tabular-nums" style={{ color: tierColor }}>
              {leverage}x
            </span>
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={maxLev}
          value={leverage}
          onChange={(e) => setLev(Number(e.target.value))}
          className="lev-slider w-full"
          style={{ ['--lev-color' as string]: tierColor, ['--lev-pct' as string]: `${maxLev > 1 ? ((leverage - 1) / (maxLev - 1)) * 100 : 100}%` }}
          data-testid="leverage"
        />
        <div className="mt-2 flex flex-wrap gap-1">
          {leveragePresets(maxLev).map((v) => (
            <button
              key={v}
              onClick={() => setLev(v)}
              className={`chip px-2 py-0.5 font-mono ${v === leverage ? 'border-transparent text-ink-950' : ''}`}
              style={v === leverage ? { backgroundColor: TIER_COLOR[leverageTier(v)] } : undefined}
            >
              {v}x
            </button>
          ))}
        </div>
      </div>

      {/* 投入本金 */}
      <div>
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="font-semibold text-ink-400">{t('order.amount')}</span>
          <span className={`font-mono ${available.lt(0) ? 'text-blood' : 'text-ink-400'}`}>
            {t('order.available')} {fmt(available)}
          </span>
        </div>
        <div className="flex items-center rounded-2xl border-2 border-ink-700 bg-ink-850 focus-within:border-candy-grape">
          <span className="pl-3 text-lg">🪙</span>
          <input
            inputMode="decimal"
            value={amount}
            placeholder="0.00"
            onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value, 2))}
            className="min-w-0 flex-1 bg-transparent px-2 py-2.5 font-mono text-lg font-bold tabular-nums outline-none placeholder:text-ink-600"
            data-testid="order-amount"
          />
          <span className="pr-3 text-[10px] text-ink-500">{t('order.amountHint')}</span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {PCTS.map((p) => (
            <button
              key={p}
              onClick={() => pick(p)}
              disabled={available.lte(0)}
              className={`arcade-btn py-1.5 text-xs ${
                p === 100
                  ? 'border-[#b8336e] bg-gradient-to-b from-candy-pink to-[#e0458a] text-white'
                  : 'border-ink-950/60 bg-ink-800 text-ink-200 hover:bg-ink-700'
              }`}
              data-testid={p === 100 ? 'all-in' : `pct-${p}`}
            >
              {p === 100 ? t('order.allIn') : `${p}%`}
            </button>
          ))}
        </div>
      </div>

      {/* 限价：轻量折叠开关 */}
      <div className="rounded-2xl border border-dashed border-ink-700 px-3 py-2">
        <button className="flex w-full items-center justify-between text-xs" onClick={() => setLimitOn((v) => !v)} data-testid="limit-toggle">
          <span className="font-semibold text-ink-300">
            🎯 {t('order.limit')} <span className="font-normal text-ink-500">· {t('order.limitHint')}</span>
          </span>
          <span className={`relative h-5 w-9 rounded-full transition-colors ${limitOn ? 'bg-candy-grape' : 'bg-ink-700'}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${limitOn ? 'left-[18px]' : 'left-0.5'}`} />
          </span>
        </button>
        <AnimatePresence initial={false}>
          {limitOn && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <input
                inputMode="decimal"
                value={limitPrice}
                placeholder={`${t('order.price')} · ${fmt(last, priceDp)}`}
                onChange={(e) => setLimitPrice(sanitizeDecimalInput(e.target.value, priceDp))}
                className="mt-2 w-full rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-sm outline-none focus:border-candy-grape"
                data-testid="limit-price"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 预览：只保留最关键的三项 */}
      <div className="grid gap-1.5">
        <PreviewCard icon="📦" label={t('order.positionSize')}>
          <span className="font-mono text-lg font-black tabular-nums text-ink-100" data-testid="preview-size">
            {notional ? fmt(notional) : '—'}
          </span>
          {sizing?.fill && (
            <span className="text-[10px] text-ink-500">
              {t('order.feeHint', { fee: fmt(sizing.fill.totalFee, 4), qty: fmt(sizing.quantity, decimalsOf(market.lotSize)) })}
            </span>
          )}
        </PreviewCard>
        <PreviewCard icon={liq && liq.isZero() ? '🛡️' : '💀'} label={t('order.liqPrice')} tone={liq && liq.isZero() ? 'safe' : 'danger'}>
          <span
            className={`font-mono text-lg font-black tabular-nums ${liq && liq.isZero() ? 'text-candy-mint' : 'bg-gradient-to-r from-blood to-candy-peach bg-clip-text text-transparent'}`}
            data-testid="preview-liq"
          >
            {liq ? (liq.isZero() ? t('order.noLiq') : fmt(liq, priceDp)) : '—'}
          </span>
        </PreviewCard>
        <PreviewCard icon="🎢" label={t('order.perPct')}>
          <span className="font-mono text-lg font-black tabular-nums text-candy-sun">{notional ? `±${fmt(notional.div(100))}` : '—'}</span>
          <span className="text-[10px] text-ink-500">{t('order.perPctHint', { pct: leverage })}</span>
        </PreviewCard>
      </div>

      {sizing?.fill && sizing.fill.closedQuantity.gt(0) && (
        <p className="rounded-xl bg-candy-sun/10 px-3 py-1.5 text-xs text-candy-sun">↩ {t('order.closing', { qty: fmt(sizing.fill.closedQuantity, decimalsOf(market.lotSize)) })}</p>
      )}
      {tier === 'degen' && <p className="rounded-xl bg-blood/10 px-3 py-1.5 text-xs text-blood">⚠ {t('order.highLevWarn')}</p>}

      <div className="sticky bottom-0 -mx-3.5 -mb-3.5 rounded-b-3xl bg-gradient-to-t from-ink-900 via-ink-900/95 to-transparent px-3.5 pb-3.5 pt-2">
      <button
        disabled={busy || Boolean(blocker)}
        onClick={() => void submit()}
        className={`arcade-btn w-full py-3 text-base text-white ${
          blocker ? 'border-ink-950/60 bg-ink-700' : isLong ? 'border-black/25 bg-up' : 'border-black/25 bg-down'
        }`}
        data-testid="submit-order"
      >
        {blocker ?? t(isLong ? 'order.submit.long' : 'order.submit.short', { code: market.code, lev: leverage })}
      </button>
      </div>
    </section>
  );
}

function PreviewCard({ icon, label, tone, children }: { icon: string; label: string; tone?: 'safe' | 'danger'; children: React.ReactNode }) {
  const border = tone === 'danger' ? 'border-blood/40 bg-blood/[0.07]' : tone === 'safe' ? 'border-candy-mint/40 bg-candy-mint/[0.07]' : 'border-ink-700 bg-ink-850/70';
  return (
    <div className={`flex items-center justify-between gap-2 rounded-2xl border px-3 py-1.5 ${border}`}>
      <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-300">
        <span className="text-base">{icon}</span>
        {label}
      </span>
      <span className="flex flex-col items-end leading-tight">{children}</span>
    </div>
  );
}
