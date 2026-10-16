import type { BroadcastPayload } from '@catpital/shared';
import { useTranslation } from 'react-i18next';
import { useFeed } from '../../stores/feed';
import { useBroadcastText } from './BroadcastBanner';

const KIND_STYLE: Record<BroadcastPayload['kind'], string> = {
  BIG_WIN: 'text-candy-sun',
  LIQUIDATION: 'text-candy-peach',
  DEFICIT: 'text-blood',
  BANKRUPTCY: 'text-ink-300',
  MARKET_EVENT: 'text-candy-sky',
};

/** 顶部右侧：全服战报 + 金融快讯 跑马灯，悬停暂停 */
export function LiveTicker() {
  const { t } = useTranslation();
  const history = useFeed((s) => s.history);
  const text = useBroadcastText();

  const items = history.map((b) => ({ id: b.id, kind: b.kind, text: text(b), ts: b.ts }));
  // 速度恒定：总字数越多，一圈越久
  const chars = items.reduce((n, i) => n + i.text.length, 0);
  const duration = Math.max(25, chars * 0.32);

  return (
    <section className="bento flex min-w-0 flex-1 items-center gap-3 overflow-hidden px-3 py-2" data-testid="live-ticker">
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-candy-pink/15 px-2.5 py-1 text-xs font-extrabold text-candy-pink">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-candy-pink opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-candy-pink" />
        </span>
        {t('ticker.title')}
      </span>
      <div className="relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_4%,black_96%,transparent)]">
        {items.length === 0 ? (
          <p className="truncate text-sm text-ink-500">{t('ticker.empty')}</p>
        ) : (
          <div className="marquee-track flex w-max animate-marquee gap-10" style={{ ['--marquee-duration' as string]: `${duration}s` }}>
            {[0, 1].map((copy) => (
              <div key={copy} className="flex shrink-0 gap-10" aria-hidden={copy === 1}>
                {items.map((i) => (
                  <span key={`${copy}-${i.id}`} className={`whitespace-nowrap text-sm font-semibold ${KIND_STYLE[i.kind]}`}>
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
