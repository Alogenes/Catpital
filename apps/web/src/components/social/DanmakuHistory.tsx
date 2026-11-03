import type { DanmakuPayload, ServerMessage } from '@catpital/shared';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { realtime } from '../../lib/ws';
import { useMarkets } from '../../stores/markets';
import { useSession } from '../../stores/session';
import { Avatar } from '../common/Avatar';
import { codeLabel } from '../layout/MarketTabs';

/** 侧栏显示的时间范围 */
export const DANMAKU_HISTORY_HOURS = 2;

/**
 * 📜 弹幕记录：从右侧滑出的毛玻璃侧栏，显示当前市场最近 2 小时的全部弹幕（旧的在上，新的在下，像聊天记录）。
 * 打开期间新弹幕实时追加并自动滚到底；点背景或按 Esc 关闭。
 */
export function DanmakuHistory({ market, open, onClose }: { market: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const me = useSession((s) => s.user?.id);
  const kind = useMarkets((s) => s.list.find((m) => m.code === market)?.kind);
  const [items, setItems] = useState<DanmakuPayload[] | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setItems(null);
    api
      .get<DanmakuPayload[]>(`/markets/${market}/danmaku?hours=${DANMAKU_HISTORY_HOURS}`)
      .then((list) => alive && setItems(list))
      .catch(() => alive && setItems([]));
    const off = realtime.on((msg: ServerMessage) => {
      if (!('ch' in msg) || msg.ch !== `danmaku:${market}`) return;
      const d = msg.d as DanmakuPayload;
      setItems((list) => (list ? [...list, d] : list));
    });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      off();
      window.removeEventListener('keydown', onKey);
    };
  }, [open, market, onClose]);

  // 新消息到达时滚到最底
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [items?.length]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.aside
            role="dialog"
            className="absolute bottom-0 right-0 top-0 flex w-[min(360px,92vw)] flex-col border-l-2 border-candy-grape/40 bg-ink-900/85 pt-[var(--safe-top)] shadow-[-12px_0_40px_-12px_rgba(167,123,255,0.45)] backdrop-blur-xl"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
            data-testid="danmaku-history"
          >
            <div className="flex items-center gap-2 border-b border-ink-700/70 px-4 py-3">
              <span className="text-xl">📜</span>
              <span className="mr-auto min-w-0 leading-tight">
                <span className="block font-black">{t('danmaku.history')}</span>
                <span className="block text-[11px] text-ink-400">
                  {codeLabel(market, kind)} · {t('danmaku.historyHint', { hours: DANMAKU_HISTORY_HOURS })}
                </span>
              </span>
              {items && <span className="rounded-full bg-candy-grape/20 px-2 py-0.5 font-mono text-xs font-black text-candy-grape">{items.length}</span>}
              <button type="button" className="chip" onClick={onClose} aria-label={t('settings.close')} data-testid="danmaku-history-close">
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3">
              {!items && (
                <div className="flex justify-center py-16">
                  <span className="h-8 w-8 animate-spin rounded-full border-4 border-ink-700 border-t-candy-grape" />
                </div>
              )}
              {items && items.length === 0 && <p className="py-16 text-center text-sm text-ink-400">{t('danmaku.historyEmpty', { hours: DANMAKU_HISTORY_HOURS })}</p>}
              <ol className="space-y-2" data-testid="danmaku-history-list">
                {items?.map((d, i) => {
                  const mine = d.userId === me;
                  return (
                    <li key={`${d.ts}-${d.userId}-${i}`} className="flex items-start gap-2">
                      <Avatar userId={d.userId} avatarHash={d.avatar} name={d.name} size={28} className="mt-0.5 h-7 w-7 shrink-0 rounded-full" />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-baseline gap-2 text-[11px]">
                          <span className={`truncate font-bold ${mine ? 'text-candy-sun' : 'text-candy-grape'}`}>{d.name}</span>
                          <span className="shrink-0 font-mono text-ink-500">{new Date(d.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </p>
                        <p
                          className={`mt-0.5 inline-block max-w-full break-words rounded-2xl rounded-tl-md px-3 py-1.5 text-sm ${
                            mine ? 'bg-candy-sun/15 text-ink-100' : 'bg-ink-800/90 text-ink-100'
                          }`}
                        >
                          {d.text}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div ref={bottom} />
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
