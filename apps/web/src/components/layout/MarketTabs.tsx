import { D } from '@catpital/shared';
import { useTranslation } from 'react-i18next';
import { decimalsOf, fmt, fmtPct } from '../../lib/format';
import { sound } from '../../lib/sound';
import { useMarkets } from '../../stores/markets';
import { useSession } from '../../stores/session';

/** 市场切换条：最新价、涨跌幅、休市状态、是否持仓 */
export function MarketTabs() {
  const { i18n } = useTranslation();
  const list = useMarkets((s) => s.list);
  const selected = useMarkets((s) => s.selected);
  const prices = useMarkets((s) => s.prices);
  const select = useMarkets((s) => s.select);
  const positions = useSession((s) => s.positions);

  return (
    <nav className="flex gap-1.5 overflow-x-auto pb-1" data-testid="market-tabs">
      {list.map((m) => {
        const price = prices[m.code]?.price ?? m.price;
        const change = D(price).minus(m.initialPrice).div(m.initialPrice);
        const active = m.code === selected;
        const pos = positions[m.code];
        return (
          <button
            key={m.code}
            onClick={() => {
              sound.play('click');
              select(m.code);
            }}
            className={`relative flex min-w-[124px] shrink-0 flex-col rounded-lg border px-3 py-1.5 text-left transition-colors ${
              active ? 'border-accent/70 bg-accent/10' : 'border-ink-800 bg-ink-900 hover:border-ink-600'
            } ${!m.open || m.status !== 'ACTIVE' ? 'opacity-60' : ''}`}
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              {m.code}
              {pos && <span className={`h-1.5 w-1.5 rounded-full ${pos.side === 'LONG' ? 'bg-up' : 'bg-down'}`} />}
            </span>
            <span className="truncate text-[11px] text-ink-400">{m.nameI18n[i18n.language] ?? m.name}</span>
            <span className="flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums">
              <span>{fmt(price, decimalsOf(m.tickSize))}</span>
              <span className={change.gte(0) ? 'text-up' : 'text-down'}>{fmtPct(change)}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
