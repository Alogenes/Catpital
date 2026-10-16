import { D } from '@catpital/shared';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { MarketInfo } from '../../lib/api';
import { decimalsOf, fmt, fmtPct } from '../../lib/format';
import { focusMarket } from '../../realtime/bridge';
import { useMarkets } from '../../stores/markets';
import { type ChartType, type Interval, useSettings } from '../../stores/settings';
import { DanmakuInput } from '../social/DanmakuInput';
import { DanmakuLayer } from './DanmakuLayer';
import { PriceChart } from './PriceChart';

const INTERVALS: Interval[] = ['M1', 'M5', 'M15', 'H1', 'D1'];
const TYPES: ChartType[] = ['candle', 'line', 'area'];

export function PriceTicker({ market }: { market: MarketInfo }) {
  const { t, i18n } = useTranslation();
  const p = useMarkets((s) => s.prices[market.code]);
  const price = p?.price ?? market.price;
  const dir = p && p.price !== p.prev ? (D(p.price).gt(p.prev) ? 'up' : 'down') : null;
  const change = D(price).minus(market.initialPrice).div(market.initialPrice);
  const name = market.nameI18n[i18n.language] ?? market.name;
  const badge =
    market.status === 'HALTED'
      ? ['bg-amber-500/15 text-amber-400', t('market.halted')]
      : market.open
        ? ['bg-up/15 text-up', t('market.open')]
        : ['bg-ink-700 text-ink-400', t('market.closed')];

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-lg font-bold tracking-wide">{market.code}</span>
      <span className="text-sm text-ink-400">{name}</span>
      <span
        key={p?.ts}
        className={`rounded px-1 font-mono text-2xl font-semibold tabular-nums ${dir === 'up' ? 'animate-flashUp text-up' : dir === 'down' ? 'animate-flashDown text-down' : ''}`}
        data-testid="last-price"
      >
        {fmt(price, decimalsOf(market.tickSize))}
      </span>
      <span className={`font-mono text-sm tabular-nums ${change.gte(0) ? 'text-up' : 'text-down'}`}>
        {fmtPct(change)} <span className="text-ink-500">{t('market.vsOpen')}</span>
      </span>
      <span className={`rounded px-1.5 py-0.5 text-xs ${badge[0]}`}>{badge[1]}</span>
      <span className="text-xs text-ink-500">{market.dataSource === 'LIVE_API' ? t('market.live') : t('market.sim')}</span>
    </div>
  );
}

export function ChartPanel({ market }: { market: MarketInfo }) {
  const { t } = useTranslation();
  const interval = useSettings((s) => s.interval);
  const chartType = useSettings((s) => s.chartType);
  const update = useSettings((s) => s.update);

  useEffect(() => {
    focusMarket(market.code, interval);
  }, [market.code, interval]);

  const tab = (active: boolean) =>
    `rounded px-2 py-1 text-xs transition-colors ${active ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'}`;

  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-ink-800 bg-ink-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-800 px-3 py-2">
        <PriceTicker market={market} />
        <div className="flex items-center gap-3">
          <div className="flex gap-0.5">
            {TYPES.map((ct) => (
              <button key={ct} className={tab(ct === chartType)} onClick={() => update({ chartType: ct })}>
                {t(`chart.${ct}`)}
              </button>
            ))}
          </div>
          <div className="flex gap-0.5">
            {INTERVALS.map((iv) => (
              <button key={iv} className={tab(iv === interval)} onClick={() => update({ interval: iv })}>
                {t(`chart.${iv}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="relative min-h-[280px] flex-1">
        <PriceChart market={market} interval={interval} chartType={chartType} />
        <DanmakuLayer market={market.code} />
      </div>
      <DanmakuInput market={market.code} />
    </section>
  );
}
