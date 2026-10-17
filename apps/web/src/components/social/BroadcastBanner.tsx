import type { BroadcastPayload } from '@catpital/shared';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { fmt } from '../../lib/format';
import { useFeed } from '../../stores/feed';

const STYLE: Record<BroadcastPayload['kind'], string> = {
  BIG_WIN: 'from-amber-500/90 via-yellow-400/90 to-amber-500/90 text-ink-950 shadow-amber-400/40',
  LIQUIDATION: 'from-rose-900/95 via-red-700/95 to-rose-900/95 text-white shadow-red-700/40',
  DEFICIT: 'from-black via-blood to-black text-white shadow-blood/60 ring-1 ring-blood',
  BANKRUPTCY: 'from-zinc-900 via-zinc-700 to-zinc-900 text-zinc-100 shadow-black/60 grayscale',
  MARKET_EVENT: 'from-indigo-900/95 via-accent/90 to-indigo-900/95 text-white shadow-accent/40',
  WHALE: 'from-sky-900/95 via-candy-sky/90 to-sky-900/95 text-ink-950 shadow-candy-sky/40',
  CHAMPION: 'from-amber-600/95 via-gold to-amber-600/95 text-ink-950 shadow-gold/50 ring-1 ring-gold',
};

// 金额类变量统一两位小数；价格保持服务端原样（已按 tickSize 取整，WOOF 等低价币需要 4 位）
const NUMERIC = new Set(['pnl', 'roe', 'totalLoss', 'deficit', 'balanceAfter', 'peakNetWorth', 'debtWrittenOff']);

/** 渲染播报文案：金额变量格式化；破产称号 key 翻译成名称 */
export function useBroadcastText() {
  const { t } = useTranslation();
  return (b: BroadcastPayload) => {
    const vars: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(b.vars)) vars[k] = NUMERIC.has(k) && typeof v === 'string' ? fmt(v) : v;
    if (typeof b.vars.title === 'string') vars.titleText = t(`${b.vars.title}.name`);
    return t(b.i18nKey, vars);
  };
}

/** 顶部全服播报：队列轮播，每条 5 秒；穿仓/破产停留更久 */
export function BroadcastBanner() {
  const current = useFeed((s) => s.banners[0]);
  const shift = useFeed((s) => s.shiftBanner);
  const text = useBroadcastText();

  useEffect(() => {
    if (!current) return;
    const ms = current.kind === 'DEFICIT' || current.kind === 'BANKRUPTCY' ? 7000 : 5000;
    const timer = setTimeout(shift, ms);
    return () => clearTimeout(timer);
  }, [current, shift]);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-40 flex justify-center px-3">
      <AnimatePresence mode="wait">
        {current && (
          <motion.div
            key={current.id}
            initial={{ y: -60, opacity: 0, scale: 0.95 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            className={`pointer-events-auto max-w-2xl rounded-full bg-gradient-to-r px-5 py-2 text-center text-sm font-semibold shadow-xl ${STYLE[current.kind]} ${
              current.kind === 'DEFICIT' ? 'animate-pulse' : ''
            }`}
            onClick={shift}
            data-testid="broadcast-banner"
          >
            {text(current)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
