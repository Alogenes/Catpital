import { AnimatePresence, motion, useAnimationControls } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sound } from '../../lib/sound';
import { useFeed } from '../../stores/feed';
import { useSettings } from '../../stores/settings';

const TAPS_REQUIRED = 3;
/** 两次点击间隔超过该时间就从头再来，防止误触累计 */
const TAP_RESET_MS = 2500;

/**
 * 🔒 解除杠杆限制：连点 3 下才能解锁。
 *   每一下：锁头剧烈抖动 + 警告文案升级 + 进度点亮
 *   第三下：锁头炸开、粉色闪光、音效，最大杠杆提升到 200x
 * 已解锁时一键重新上锁。
 */
export function DegenUnlock() {
  const { t } = useTranslation();
  const unlocked = useSettings((s) => s.degenUnlock);
  const update = useSettings((s) => s.update);
  const [taps, setTaps] = useState(0);
  const [burst, setBurst] = useState(false);
  const lock = useAnimationControls();
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const tap = async () => {
    sound.unlock();
    const next = taps + 1;
    clearTimeout(resetTimer.current);
    if (next < TAPS_REQUIRED) {
      setTaps(next);
      sound.play('error');
      resetTimer.current = setTimeout(() => setTaps(0), TAP_RESET_MS);
      // 越往后抖得越狠
      const amp = 4 + next * 4;
      await lock.start({ x: [0, -amp, amp, -amp, amp, 0], rotate: [0, -8 * next, 8 * next, -6 * next, 0], transition: { duration: 0.45 } });
      return;
    }
    setTaps(TAPS_REQUIRED);
    setBurst(true);
    sound.play('bigWin');
    await lock.start({ scale: [1, 1.5, 0], rotate: [0, -25, 200], opacity: [1, 1, 0], transition: { duration: 0.6 } });
    update({ degenUnlock: true });
    useFeed.getState().toast('danger', t('settings.degen.unlockedToast'));
    setTaps(0);
    setTimeout(() => setBurst(false), 900);
    lock.set({ scale: 1, rotate: 0, opacity: 1, x: 0 });
  };

  if (unlocked) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-2xl border-2 border-candy-pink/60 bg-candy-pink/10 px-3 py-2.5" data-testid="degen-unlocked">
        <span className="flex items-center gap-2">
          <span className="animate-wiggle text-xl">🔓</span>
          <span className="leading-tight">
            <span className="block text-sm font-extrabold text-candy-pink">{t('settings.degen.unlocked')}</span>
            <span className="block text-[11px] text-ink-400">{t('settings.degen.unlockedHint')}</span>
          </span>
        </span>
        <button className="chip shrink-0" onClick={() => update({ degenUnlock: false })} data-testid="degen-relock">
          🔒 {t('settings.degen.relock')}
        </button>
      </div>
    );
  }

  const warnKey = taps === 0 ? 'settings.degen.hint' : taps === 1 ? 'settings.degen.warn1' : 'settings.degen.warn2';
  return (
    <button
      type="button"
      onClick={() => void tap()}
      className={`relative flex w-full items-center gap-3 overflow-hidden rounded-2xl border-2 px-3 py-2.5 text-left transition-colors ${
        taps === 0 ? 'border-ink-700 bg-ink-850' : taps === 1 ? 'border-candy-sun/70 bg-candy-sun/10' : 'border-blood/80 bg-blood/15'
      }`}
      data-testid="degen-unlock"
    >
      <motion.span animate={lock} className="text-2xl">
        🔒
      </motion.span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-sm font-extrabold">{t('settings.degen.title')}</span>
        <AnimatePresence mode="wait">
          <motion.span
            key={warnKey}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className={`block text-[11px] ${taps === 0 ? 'text-ink-400' : taps === 1 ? 'text-candy-sun' : 'text-blood'}`}
          >
            {t(warnKey)}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="flex shrink-0 gap-1">
        {Array.from({ length: TAPS_REQUIRED }, (_, i) => (
          <span key={i} className={`h-2.5 w-2.5 rounded-full transition-colors ${i < taps ? 'bg-blood shadow-[0_0_8px_#ff3b5c]' : 'bg-ink-700'}`} />
        ))}
      </span>
      {/* 解锁瞬间的粉色冲击波 */}
      <AnimatePresence>
        {burst && (
          <motion.span
            className="pointer-events-none absolute inset-0 rounded-2xl bg-candy-pink"
            initial={{ opacity: 0.8, scale: 0.6 }}
            animate={{ opacity: 0, scale: 1.4 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8 }}
          />
        )}
      </AnimatePresence>
    </button>
  );
}
