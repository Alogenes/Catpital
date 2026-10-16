import type { DanmakuPayload } from '@catpital/shared';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { LaneAllocator } from '../../lib/danmakuLanes';
import { useFeed } from '../../stores/feed';
import { useSession } from '../../stores/session';
import { useSettings } from '../../stores/settings';

const SPEED_PX_PER_S = 150;
const LANE_HEIGHT = 30;
const MAX_ON_SCREEN = 60;

interface Flying {
  key: number;
  item: DanmakuPayload;
  lane: number;
  delayMs: number;
  width: number;
}

/** 估算文本宽度（CJK 按全角，其它按半角），避免每条弹幕都做 DOM 测量 */
const estimateWidth = (text: string, name: string) =>
  [...`${name}: ${text}`].reduce((w, ch) => w + (/[\u0000-ÿ]/.test(ch) ? 8.5 : 16), 0) + 28;

let seq = 1;

/** 单条弹幕：挂载即起飞，动画结束（或被取消）立刻通知父组件把自己从 state 中删除 —— 播完即焚 */
const FlyingDanmaku = memo(function FlyingDanmaku({
  f,
  containerWidth,
  mine,
  onDone,
}: {
  f: Flying;
  containerWidth: number;
  mine: boolean;
  onDone: (key: number) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const anim = el.animate([{ transform: `translateX(${containerWidth}px)` }, { transform: `translateX(${-f.width}px)` }], {
      duration: ((containerWidth + f.width) / SPEED_PX_PER_S) * 1000,
      delay: f.delayMs,
      easing: 'linear',
      fill: 'both',
    });
    const done = () => onDone(f.key);
    anim.addEventListener('finish', done);
    anim.addEventListener('cancel', done);
    return () => {
      anim.removeEventListener('finish', done);
      anim.removeEventListener('cancel', done);
      anim.cancel();
    };
    // 起飞参数在挂载时确定，之后不再响应变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <span
      ref={ref}
      className={`absolute left-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.9)] ${
        mine ? 'border border-gold/70 bg-gold/15' : 'bg-black/25'
      }`}
      style={{ top: 8 + f.lane * LANE_HEIGHT, transform: `translateX(${containerWidth}px)` }}
    >
      <span className="mr-1 text-ink-300">{f.item.name}:</span>
      {f.item.text}
    </span>
  );
});

/**
 * 同股市弹幕层（纯实时流）：
 *   - 只渲染 bridge 闸门放行的实时弹幕（不回放历史）
 *   - 切换股市：清空在飞弹幕、待上屏队列与轨道占用
 *   - 每条弹幕飞完即从 state 删除，不可能重复出现
 */
export function DanmakuLayer({ market }: { market: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flying, setFlying] = useState<Flying[]>([]);
  const enabled = useSettings((s) => s.danmaku);
  const me = useSession((s) => s.user?.id);
  const lanes = useRef(new LaneAllocator(6));

  const remove = useCallback((key: number) => setFlying((list) => list.filter((x) => x.key !== key)), []);

  // 切换股市：全部清空
  useEffect(() => {
    setFlying([]);
    lanes.current = new LaneAllocator(6);
    useFeed.getState().clearDanmaku();
  }, [market]);

  useEffect(() => {
    if (!enabled) {
      setFlying([]);
      return;
    }
    const timer = setInterval(() => {
      const items = useFeed.getState().consumeDanmaku().filter((d) => d.market === market);
      if (!items.length || !ref.current) return;
      const height = ref.current.clientHeight;
      lanes.current.resize(Math.max(2, Math.floor((height * 0.6) / LANE_HEIGHT)));
      const now = performance.now();
      const added: Flying[] = [];
      for (const item of items) {
        const width = estimateWidth(item.text, item.name);
        const slot = lanes.current.allocate(now, (width / SPEED_PX_PER_S) * 1000);
        if (slot) added.push({ key: seq++, item, width, ...slot });
      }
      if (added.length) setFlying((f) => [...f, ...added].slice(-MAX_ON_SCREEN));
    }, 200);
    return () => clearInterval(timer);
  }, [enabled, market]);

  if (!enabled) return null;
  const width = ref.current?.clientWidth ?? 800;
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden data-testid="danmaku-layer">
      {flying.map((f) => (
        <FlyingDanmaku key={f.key} f={f} containerWidth={width} mine={f.item.userId === me} onDone={remove} />
      ))}
    </div>
  );
}
