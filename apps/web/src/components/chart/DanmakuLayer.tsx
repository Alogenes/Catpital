import type { DanmakuPayload } from '@catpital/shared';
import { useEffect, useRef, useState } from 'react';
import { LaneAllocator } from '../../lib/danmakuLanes';
import { useFeed } from '../../stores/feed';
import { useSession } from '../../stores/session';
import { useSettings } from '../../stores/settings';

const SPEED_PX_PER_S = 150;
const LANE_HEIGHT = 30;

interface Flying {
  key: string;
  item: DanmakuPayload;
  lane: number;
  delayMs: number;
  width: number;
}

/** 估算文本宽度（CJK 按全角，其它按半角），避免每条弹幕都做 DOM 测量 */
const estimateWidth = (text: string) => [...text].reduce((w, ch) => w + (/[\u0000-ÿ]/.test(ch) ? 8.5 : 16), 0) + 28;

/** 同股市弹幕：在 K 线图上方从右向左飘过（Web Animations API，60fps 合成层动画） */
export function DanmakuLayer({ market }: { market: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flying, setFlying] = useState<Flying[]>([]);
  const enabled = useSettings((s) => s.danmaku);
  const me = useSession((s) => s.user?.id);
  const lanes = useRef(new LaneAllocator(6));

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      const items = useFeed.getState().consumeDanmaku().filter((d) => d.market === market);
      if (!items.length || !ref.current) return;
      const height = ref.current.clientHeight;
      lanes.current.resize(Math.max(2, Math.floor((height * 0.6) / LANE_HEIGHT)));
      const now = performance.now();
      const added: Flying[] = [];
      for (const item of items) {
        const width = estimateWidth(item.text);
        const slot = lanes.current.allocate(now, (width / SPEED_PX_PER_S) * 1000);
        if (slot) added.push({ key: `${item.userId}-${item.ts}-${Math.random()}`, item, width, ...slot });
      }
      if (added.length) setFlying((f) => [...f, ...added].slice(-80));
    }, 200);
    return () => clearInterval(timer);
  }, [enabled, market]);

  useEffect(() => setFlying([]), [market]);

  if (!enabled) return null;
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden>
      {flying.map((f) => (
        <span
          key={f.key}
          ref={(el) => {
            if (!el || el.dataset.started) return;
            el.dataset.started = '1';
            const w = ref.current?.clientWidth ?? 800;
            const distance = w + f.width;
            const anim = el.animate([{ transform: `translateX(${w}px)` }, { transform: `translateX(${-f.width}px)` }], {
              duration: (distance / SPEED_PX_PER_S) * 1000,
              delay: f.delayMs,
              easing: 'linear',
              fill: 'both',
            });
            anim.onfinish = () => setFlying((list) => list.filter((x) => x.key !== f.key));
          }}
          className={`absolute left-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.9)] ${
            f.item.userId === me ? 'border border-gold/70 bg-gold/15' : 'bg-black/25'
          }`}
          style={{ top: 8 + f.lane * LANE_HEIGHT }}
        >
          <span className="mr-1 text-ink-300">{f.item.name}:</span>
          {f.item.text}
        </span>
      ))}
    </div>
  );
}
