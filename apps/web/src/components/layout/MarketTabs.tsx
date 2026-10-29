import { D } from '@catpital/shared';
import { useTranslation } from 'react-i18next';
import { decimalsOf, fmt, fmtPct } from '../../lib/format';
import { sound } from '../../lib/sound';
import { useMarkets } from '../../stores/markets';
import { useSession } from '../../stores/session';

/** 市场吉祥物（未知代码按类型兜底） */
const MASCOT: Record<string, string> = { MEOW: '🐱', WOOF: '🐶', FIH: '🐟', BTC: '🪙', EURUSD: '💶' };
export const mascotOf = (code: string, kind?: string) => MASCOT[code] ?? (kind === 'CRYPTO' ? '💎' : kind === 'FOREX' ? '💱' : '📈');
/** 展示用代码：外汇对加斜杠（EURUSD → EUR/USD）；接口、URL 里仍用不带斜杠的代码 */
export const codeLabel = (code: string, kind?: string) => (kind === 'FOREX' && code.length === 6 ? `${code.slice(0, 3)}/${code.slice(3)}` : code);

/** 市场切换卡片：吉祥物、最新价、涨跌幅、是否持仓 */
export function MarketTabs() {
  const { i18n } = useTranslation();
  const list = useMarkets((s) => s.list);
  const selected = useMarkets((s) => s.selected);
  const prices = useMarkets((s) => s.prices);
  const select = useMarkets((s) => s.select);
  const positions = useSession((s) => s.positions);

  return (
    <>
    {/* 手机端：横向滑动的小胶囊 */}
    <nav className="hide-scrollbar flex w-full min-w-0 shrink-0 flex-nowrap gap-1.5 overflow-x-auto overscroll-x-contain px-0.5 py-0.5 [touch-action:pan-x] md:hidden" data-testid="market-pills">
      {list.map((m) => {
        const price = prices[m.code]?.price ?? m.price;
        const change = D(price).minus(m.initialPrice).div(m.initialPrice);
        const active = m.code === selected;
        const closed = !m.open || m.status !== 'ACTIVE';
        return (
          <button
            key={m.code}
            onClick={() => {
              sound.play('click');
              select(m.code);
            }}
            className={`flex shrink-0 items-center gap-1 rounded-full border-2 px-2.5 py-1 text-xs font-extrabold ${
              active ? 'border-candy-grape bg-candy-grape/20 text-ink-100' : 'border-ink-700/70 bg-ink-900/85 text-ink-300'
            } ${closed ? 'opacity-60' : ''}`}
          >
            <span>{mascotOf(m.code, m.kind)}</span>
            {codeLabel(m.code, m.kind)}
            {positions[m.code] && <span className={`h-1.5 w-1.5 rounded-full ${positions[m.code]!.side === 'LONG' ? 'bg-up' : 'bg-down'}`} />}
            <span className={`font-mono text-[10px] ${change.gte(0) ? 'text-up' : 'text-down'}`}>{fmtPct(change, 1)}</span>
          </button>
        );
      })}
    </nav>
    <nav className="hide-scrollbar hidden min-w-0 max-w-full shrink flex-nowrap gap-2 overflow-x-auto overscroll-x-contain px-0.5 pb-1.5 pt-1 md:flex" data-testid="market-tabs">
      {list.map((m) => {
        const price = prices[m.code]?.price ?? m.price;
        const change = D(price).minus(m.initialPrice).div(m.initialPrice);
        const active = m.code === selected;
        const pos = positions[m.code];
        const closed = !m.open || m.status !== 'ACTIVE';
        return (
          <button
            key={m.code}
            onClick={() => {
              sound.play('click');
              select(m.code);
            }}
            className={`relative flex w-[136px] shrink-0 items-center gap-2 overflow-hidden rounded-2xl border-2 px-2.5 py-1.5 text-left transition-all ${
              active
                ? '-translate-y-0.5 border-candy-grape bg-candy-grape/15 shadow-[0_5px_0_0_#6b4bc4]'
                : 'border-ink-700/70 bg-ink-900/85 shadow-[0_4px_0_0_rgba(10,6,22,0.6)] hover:border-ink-500'
            } ${closed ? 'opacity-60' : ''}`}
          >
            <span className={`text-2xl ${active ? 'animate-bob' : ''}`}>{mascotOf(m.code, m.kind)}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 text-sm font-extrabold">
                {codeLabel(m.code, m.kind)}
                {pos && <span className={`h-2 w-2 rounded-full ${pos.side === 'LONG' ? 'bg-up' : 'bg-down'}`} title={pos.side} />}
                {closed && <span className="text-[10px]">💤</span>}
              </span>
              <span className="block truncate text-[10px] text-ink-400 [@media(max-height:760px)]:hidden">{m.nameI18n[i18n.language] ?? m.name}</span>
              <span className="flex items-baseline justify-between gap-1 font-mono text-[11px] tabular-nums">
                <span>{fmt(price, Math.min(decimalsOf(m.tickSize), 4))}</span>
                <span className={change.gte(0) ? 'text-up' : 'text-down'}>{fmtPct(change, 1)}</span>
              </span>
            </span>
          </button>
        );
      })}
    </nav>
    </>
  );
}
