import { D } from '@catpital/shared';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { fmt } from '../../lib/format';
import { useRollingNumber } from '../../lib/rolling';
import { useSession } from '../../stores/session';

type Tone = 'gain' | 'loss' | 'neutral';

interface Floater {
  id: number;
  tone: Tone;
  text: string;
}

/** 结算提示的有效期：wallet 事件紧随 order / liquidated 事件到达 */
const SETTLEMENT_WINDOW_MS = 2500;
const FLASH_MS = 900;

let seq = 1;

/**
 * 钱包胶囊：大号等宽数字 + 滚动插值 + 暴涨/暴跌动效。
 *   - mode="balance"：余额每次变化都给反馈。有平仓/强平结算提示时，飘字显示真实盈亏（逐仓下亏损平仓余额也会增加）；
 *                     否则显示余额差额（开仓扣保证金是中性灰，不震动）。
 *   - mode="netWorth"：持仓浮盈每秒都在变 → 平时只滚动数字；强平结算或单步变化 ≥ 30% 才飘字。
 */
export function WalletPill({
  icon,
  label,
  value,
  mode,
  badge,
  glow,
  danger,
  testId,
}: {
  icon: string;
  label: string;
  /** 已按 2 位小数取整的十进制字符串 */
  value: string;
  mode: 'balance' | 'netWorth';
  badge?: string;
  glow: 'sun' | 'grape';
  danger?: boolean;
  testId?: string;
}) {
  const display = useRollingNumber(value);
  const prev = useRef(value);
  const consumedSettlement = useRef(useSession.getState().settlement?.id ?? 0);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [flash, setFlash] = useState<{ tone: Tone; id: number } | null>(null);

  useEffect(() => {
    const before = D(prev.current);
    const after = D(value);
    prev.current = value;
    const delta = after.minus(before);
    if (delta.isZero()) return;

    let amount = delta;
    let tone: Tone;
    if (mode === 'balance') {
      const s = useSession.getState().settlement;
      const fresh = s && s.id !== consumedSettlement.current && Date.now() - s.at < SETTLEMENT_WINDOW_MS;
      if (fresh) {
        consumedSettlement.current = s.id;
        amount = D(s.amount);
        tone = amount.gte(0) ? 'gain' : 'loss';
      } else {
        if (delta.abs().lt('0.01')) return;
        tone = delta.gt(0) ? 'gain' : 'neutral';
      }
    } else {
      // 高杠杆小账户每个 tick 都可能让净值波动超过 10%，普通 tick 只滚数字；
      // 只有强平结算、或单步暴涨暴跌 ≥ 30%（事件跳空、破产救济）才给飘字和闪光。
      const s = useSession.getState().settlement;
      const liquidation =
        s && s.kind === 'liquidation' && s.id !== consumedSettlement.current && Date.now() - s.at < SETTLEMENT_WINDOW_MS;
      if (liquidation) consumedSettlement.current = s.id;
      const crash = delta.abs().gte(1) && delta.abs().gte(before.abs().mul('0.3'));
      if (!liquidation && !crash) return;
      tone = delta.gt(0) ? 'gain' : 'loss';
    }

    const id = seq++;
    const text = `${amount.gte(0) ? '▲ +' : '▼ '}${fmt(amount)}`;
    setFloaters((f) => [...f, { id, tone, text }].slice(-3));
    setFlash({ tone, id });
    setTimeout(() => setFloaters((f) => f.filter((x) => x.id !== id)), 1700);
    setTimeout(() => setFlash((cur) => (cur?.id === id ? null : cur)), FLASH_MS);
  }, [value, mode]);

  const glowCls =
    flash?.tone === 'gain'
      ? 'border-gold/80 shadow-[0_0_26px_-4px_rgba(255,209,102,0.85)]'
      : flash?.tone === 'loss'
        ? 'animate-jolt border-blood/80 shadow-[0_0_26px_-4px_rgba(255,59,92,0.9)]'
        : glow === 'sun'
          ? 'border-candy-sun/30 shadow-[0_0_18px_-8px_rgba(255,209,102,0.7)]'
          : 'border-candy-grape/35 shadow-[0_0_18px_-8px_rgba(167,123,255,0.8)]';
  const numberCls = danger
    ? 'text-blood'
    : flash?.tone === 'gain'
      ? 'text-gold brightness-125'
      : flash?.tone === 'loss'
        ? 'text-blood'
        : glow === 'sun'
          ? 'text-candy-sun'
          : 'text-ink-100';

  return (
    <div className={`relative flex min-w-0 items-center gap-1.5 rounded-xl border-2 bg-ink-950/75 py-1 pl-1 pr-2 md:gap-2.5 md:rounded-2xl md:py-1.5 md:pl-1.5 md:pr-3.5 transition-[border-color,box-shadow] duration-300 ${glowCls}`}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-sm md:h-10 md:w-10 md:rounded-xl md:text-2xl">{icon}</span>
      <div className="leading-none">
        <div className="mb-0.5 flex items-center gap-1 whitespace-nowrap text-[9px] font-bold text-ink-400 md:mb-1 md:text-[11px]">
          {label}
          {badge && <span className="rounded-full bg-blood px-1.5 py-px text-[9px] text-white">{badge}</span>}
        </div>
        <div className="flex items-center gap-1">
          <span className={`whitespace-nowrap text-right font-mono text-sm font-extrabold md:min-w-[7.5ch] md:text-2xl tabular-nums transition-colors duration-300 ${numberCls}`} data-testid={testId}>
            {fmt(display)}
          </span>
          <AnimatePresence>
            {flash && flash.tone !== 'neutral' && (
              <motion.span
                key={flash.id}
                initial={{ opacity: 0, y: flash.tone === 'gain' ? 6 : -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className={`text-sm font-black ${flash.tone === 'gain' ? 'text-gold' : 'text-blood'}`}
              >
                {flash.tone === 'gain' ? '▲' : '▼'}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* 浮动差额飘字：盈利向上飘，亏损向下坠 */}
      <div className="pointer-events-none absolute right-2 top-1/2 z-50">
        <AnimatePresence>
          {floaters.map((f) => (
            <motion.span
              key={f.id}
              initial={{ opacity: 0, y: 0, scale: 0.8 }}
              animate={{ opacity: [0, 1, 1, 0], y: f.tone === 'gain' ? -42 : 38, scale: 1 }}
              transition={{ duration: 1.6, ease: 'easeOut', times: [0, 0.15, 0.7, 1] }}
              className={`absolute right-0 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-sm font-black tabular-nums shadow-lg ${
                f.tone === 'gain'
                  ? 'bg-gold/20 text-gold [text-shadow:0_0_10px_rgba(255,209,102,0.8)]'
                  : f.tone === 'loss'
                    ? 'bg-blood/25 text-blood [text-shadow:0_0_10px_rgba(255,59,92,0.8)]'
                    : 'bg-ink-800/90 text-ink-300'
              }`}
              data-testid={`${testId}-floater`}
            >
              {f.text}
            </motion.span>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
