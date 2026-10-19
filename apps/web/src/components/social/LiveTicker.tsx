import type { BroadcastPayload } from '@catpital/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeed } from '../../stores/feed';
import { useBroadcastText } from './BroadcastBanner';

const KIND_STYLE: Record<BroadcastPayload['kind'], string> = {
  BIG_WIN: 'text-candy-sun',
  LIQUIDATION: 'text-candy-peach',
  DEFICIT: 'text-blood',
  BANKRUPTCY: 'text-ink-300',
  MARKET_EVENT: 'text-candy-sky',
  WHALE: 'text-candy-sky font-black',
  CHAMPION: 'text-gold font-black',
};

/** 超过这个时间的战报不再上跑马灯 */
const MAX_AGE_MS = 60 * 60 * 1000;
/** 同时滚动的条数上限（只保留最新的几条，避免一圈太长、新消息要等很久才出现） */
const MAX_ITEMS = 8;

/** 顶部右侧：全服战报 + 金融快讯 跑马灯，悬停暂停。新的在最前，出现新战报时从头滚动 */
export function LiveTicker() {
  const { t } = useTranslation();
  const history = useFeed((s) => s.history);
  const text = useBroadcastText();

  // 定时刷新"现在"，让过期的战报自己退场
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const items = history
    .filter((b) => now - b.ts <= MAX_AGE_MS)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ITEMS)
    .map((b) => ({ id: b.id, kind: b.kind, text: text(b), ts: b.ts }));
  // 速度恒定：总字数越多，一圈越久
  const chars = items.reduce((n, i) => n + i.text.length, 0);
  const duration = Math.max(25, chars * 0.32);

  return (
    <section className="bento flex h-[30px] w-full min-w-0 shrink-0 items-center md:w-auto md:flex-1 lg:min-w-[280px] gap-2 overflow-hidden rounded-2xl px-2 py-0 md:h-auto md:gap-3 md:rounded-3xl md:px-3 md:py-2" data-testid="live-ticker">
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-candy-pink/15 px-1.5 py-0.5 text-[10px] font-extrabold text-candy-pink md:px-2.5 md:py-1 md:text-xs">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-candy-pink opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-candy-pink" />
        </span>
        <span className="hidden md:inline">{t('ticker.title')}</span>
      </span>
      <div className="relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_4%,black_96%,transparent)]">
        {items.length === 0 ? (
          <p className="truncate text-xs text-ink-500 md:text-sm">{t('ticker.empty')}</p>
        ) : (
          // key 跟随最新一条：新战报到达时动画重新开始，最新消息立刻从头出现
          <div key={items[0]?.id} className="marquee-track flex w-max animate-marquee gap-10" style={{ ['--marquee-duration' as string]: `${duration}s` }}>
            {[0, 1].map((copy) => (
              <div key={copy} className="flex shrink-0 gap-10" aria-hidden={copy === 1}>
                {items.map((i) => (
                  <span key={`${copy}-${i.id}`} className={`whitespace-nowrap text-xs font-semibold md:text-sm ${KIND_STYLE[i.kind]}`}>
                    {i.text}
                    <span className="ml-2 text-[10px] font-normal text-ink-500">
                      {new Date(i.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
