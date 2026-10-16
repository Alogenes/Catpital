import { D, type Decimal } from '@catpital/shared';
import { useEffect, useRef, useState } from 'react';

/** easeOutCubic：先快后慢，"哗啦"一下滚到位 */
export const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;

/**
 * 数字滚动插值（仅用于展示）：value = from + (to − from) × ease(t)。
 * 进度 t 是动画时钟（JS number），先转成 6 位小数字符串再进入 Decimal，金额本身全程不经过浮点。
 */
export function interpolate(from: Decimal, to: Decimal, t: number, dp = 2): Decimal {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const k = D(easeOutCubic(t).toFixed(6));
  return from.plus(to.minus(from).mul(k)).toDecimalPlaces(dp);
}

/**
 * 值稳定 settleMs 后才输出（去抖）。
 * 用于总净值：持仓事件与钱包事件先后到达的几十毫秒里，净值会短暂"多算/少算一份保证金"，
 * 不加去抖就会出现 ▲+87 紧接 ▼-87 的假动效。
 */
export function useSettledValue<T>(value: T, settleMs = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), settleMs);
    return () => clearTimeout(timer);
  }, [value, settleMs]);
  return settled;
}

/** 目标值变化时，在 durationMs 内从"当前显示值"平滑滚动到新值（中途再次变化会从当前位置接着滚） */
export function useRollingNumber(target: string, durationMs = 700, dp = 2): string {
  const [display, setDisplay] = useState(target);
  const shown = useRef(target);

  useEffect(() => {
    const from = D(shown.current);
    const to = D(target);
    if (from.eq(to)) return;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = (now - start) / durationMs;
      const v = interpolate(from, to, p, dp).toFixed();
      shown.current = v;
      setDisplay(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, dp]);

  return display;
}
