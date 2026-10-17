import { D } from '@catpital/shared';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { MarketInfo } from '../../lib/api';
import { decimalsOf, fmt, fmtPct } from '../../lib/format';
import { focusMarket } from '../../realtime/bridge';
import { useMarkets } from '../../stores/markets';
import { type ChartType, type Interval, useSettings } from '../../stores/settings';
import { mascotOf } from '../layout/MarketTabs';
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
      ? ['bg-candy-sun/15 text-candy-sun', `⏸ ${t('market.halted')}`]
      : market.open
        ? ['bg-candy-mint/15 text-candy-mint', `● ${t('market.open')}`]
        : ['bg-ink-700 text-ink-400', `💤 ${t('market.closed')}`];

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:gap-x-3">
      <span className="flex items-center gap-1.5">
        <span className="text-xl md:text-2xl">{mascotOf(market.code, market.kind)}</span>
        <span className="leading-tight">
          <span className="block text-base font-black tracking-wide">{market.code}</span>
          <span className="hidden text-[11px] text-ink-400 md:block">{name}</span>
        </span>
      </span>
      <span
        key={p?.ts}
        className={`rounded-xl px-1 font-mono text-xl font-black tabular-nums md:px-1.5 md:text-2xl ${dir === 'up' ? 'animate-flashUp text-up' : dir === 'down' ? 'animate-flashDown text-down' : ''}`}
        data-testid="last-price"
      >
        {fmt(price, decimalsOf(market.tickSize))}
      </span>
      <span className={`rounded-full px-2 py-0.5 font-mono text-xs font-bold tabular-nums ${change.gte(0) ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
        {fmtPct(change)}
      </span>
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${badge[0]}`}>{badge[1]}</span>
      <span className="hidden text-[11px] text-ink-500 xl:inline">{market.dataSource === 'LIVE_API' ? `📡 ${t('market.live')}` : `🎲 ${t('market.sim')}`}</span>
    </div>
  );
}

export function ChartPanel({ market, className = '' }: { market: MarketInfo; className?: string }) {
  const { t } = useTranslation();
  const interval = useSettings((s) => s.interval);
  const chartType = useSettings((s) => s.chartType);
  const update = useSettings((s) => s.update);

  useEffect(() => {
    focusMarket(market.code, interval);
  }, [market.code, interval]);

  const tab = (active: boolean) =>
    `whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold transition-colors md:px-2.5 md:py-1 md:text-xs ${active ? 'bg-candy-grape text-white shadow-[0_2px_0_0_#6b4bc4]' : 'text-ink-400 hover:text-ink-100'}`;

  return (
    <section className={`bento flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-1.5 px-2.5 pb-1 pt-2 md:gap-2 md:px-4 md:pt-3">
        <PriceTicker market={market} />
        <div className="flex w-full items-center gap-1.5 overflow-x-auto [scrollbar-width:none] md:w-auto md:flex-wrap md:gap-2 md:overflow-visible [&::-webkit-scrollbar]:hidden">
          <div className="flex shrink-0 gap-0.5 rounded-full bg-ink-850 p-0.5">
            {TYPES.map((ct) => (
              <button key={ct} className={tab(ct === chartType)} onClick={() => update({ chartType: ct })}>
                {t(`chart.${ct}`)}
              </button>
            ))}
          </div>
          <div className="flex shrink-0 gap-0.5 rounded-full bg-ink-850 p-0.5">
            {INTERVALS.map((iv) => (
              <button key={iv} className={tab(iv === interval)} onClick={() => update({ interval: iv })}>
                {t(`chart.${iv}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="relative min-h-[240px] flex-1 lg:min-h-[140px]">
        <PriceChart market={market} interval={interval} chartType={chartType} />
        <DanmakuLayer market={market.code} />
      </div>
      {/* 弹幕栏与图表底部无缝衔接（同底色、无分割线） */}
      <DanmakuInput market={market.code} />
    </section>
  );
}
