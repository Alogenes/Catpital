import { type MarketEventPayload, NEWS_RETENTION_MS } from '@catpital/shared';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { fmt, fmtPct } from '../../lib/format';
import { useMarkets } from '../../stores/markets';

interface EventRow {
  id: string;
  headline: string;
  content: string;
  i18n: MarketEventPayload['i18n'];
  gapPercent: string;
  priceBefore: string | null;
  priceAfter: string | null;
  triggeredAt: number | null;
  durationSec: number;
}

/** 金融快讯：已触发的定时事件（未来事件不公开） */
export function NewsFeed({ market }: { market: string }) {
  const { t, i18n } = useTranslation();
  const news = useMarkets((s) => s.news);
  const setNews = useMarkets((s) => s.setNews);

  useEffect(() => {
    void api.get<EventRow[]>(`/markets/${market}/events`).then((rows) =>
      setNews(
        market,
        rows.map((r) => ({
          eventId: r.id,
          market,
          headline: r.headline,
          content: r.content,
          i18n: r.i18n,
          gapPercent: r.gapPercent,
          priceBefore: r.priceBefore ?? '0',
          priceAfter: r.priceAfter ?? '0',
          durationSec: r.durationSec,
          ts: r.triggeredAt ?? 0,
        })),
      ),
    );
  }, [market, setNews]);

  // 只显示 48 小时内的快讯（页面开着跨天时，过期的也会自动消失）
  const cutoff = Date.now() - NEWS_RETENTION_MS;
  const items = news.filter((n) => n.market === market && n.ts >= cutoff);
  if (!items.length) return <p className="py-6 text-center text-sm text-ink-500">📭 {t('market.noNews')}</p>;
  return (
    <ul className="space-y-2">
      {items.map((n) => {
        const loc = n.i18n[i18n.language];
        const up = !n.gapPercent.startsWith('-');
        return (
          <li key={n.eventId} className="rounded-2xl border border-ink-700/70 bg-ink-850/80 p-3">
            <div className="flex items-start justify-between gap-3">
              <h4 className="text-sm font-semibold">{loc?.headline ?? n.headline}</h4>
              <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-xs ${up ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>{fmtPct(n.gapPercent)}</span>
            </div>
            {(loc?.content ?? n.content) && <p className="mt-1 text-xs text-ink-400">{loc?.content ?? n.content}</p>}
            <p className="mt-1 font-mono text-[11px] text-ink-500">
              {new Date(n.ts).toLocaleString()} · {fmt(n.priceBefore)} → {fmt(n.priceAfter)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/** 左下 Bento 卡片：当前市场的金融快讯 */
export function NewsCard({ market, className = '' }: { market: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <section className={`bento flex min-h-0 flex-col p-3 ${className}`} data-testid="news-card">
      <h3 className="mb-2 px-1 text-sm font-extrabold">📰 {t('market.news')}</h3>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <NewsFeed market={market} />
      </div>
    </section>
  );
}
