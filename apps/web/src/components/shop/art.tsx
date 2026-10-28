import { useId } from 'react';

/**
 * 商店插画（内联 SVG，不请求外部资源）：
 *   MeuwCoin  —— 3D 发光金币：有厚度的币边、浮雕猫脸、左上高光、外圈光晕
 *   Bolivar   —— 带厚度的绿色钞票
 *   CoinPile  —— 按档位堆出越来越高、越来越多的金币塔 / 钞票堆
 * 渐变 id 用 useId 生成，同一页面里画几十枚也不会互相串色。
 */

const GLOW_GOLD = 'drop-shadow(0 0 6px rgba(255,209,102,0.65)) drop-shadow(0 3px 2px rgba(10,6,22,0.6))';
const GLOW_GREEN = 'drop-shadow(0 0 5px rgba(61,220,151,0.45)) drop-shadow(0 3px 2px rgba(10,6,22,0.6))';

export function MeuwCoin({ size = 24, glow = true, className = '' }: { size?: number; glow?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} style={glow ? { filter: GLOW_GOLD } : undefined} aria-hidden>
      <defs>
        <radialGradient id={`f${id}`} cx="38%" cy="32%" r="75%">
          <stop offset="0" stopColor="#fffbe0" />
          <stop offset="0.35" stopColor="#ffe08a" />
          <stop offset="0.7" stopColor="#f5b52e" />
          <stop offset="1" stopColor="#c47a12" />
        </radialGradient>
        <linearGradient id={`e${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d48a18" />
          <stop offset="1" stopColor="#7a4806" />
        </linearGradient>
      </defs>
      {/* 币边（厚度） */}
      <ellipse cx="32" cy="36" rx="25" ry="25" fill={`url(#e${id})`} />
      {/* 币面 */}
      <circle cx="32" cy="31" r="25" fill={`url(#f${id})`} stroke="#a8650c" strokeWidth="1.5" />
      <circle cx="32" cy="31" r="19.5" fill="none" stroke="#fff3c4" strokeOpacity="0.7" strokeWidth="1.6" />
      <circle cx="32" cy="31" r="18" fill="none" stroke="#b9730f" strokeOpacity="0.45" strokeWidth="1" />
      {/* 浮雕猫脸 */}
      <path d="M21 25 L23.5 16.5 L29.5 22.5 Z M43 25 L40.5 16.5 L34.5 22.5 Z" fill="#d18c1d" stroke="#9c5d0b" strokeWidth="1" strokeLinejoin="round" />
      <ellipse cx="32" cy="32" rx="11.5" ry="9.5" fill="#e9a62c" stroke="#9c5d0b" strokeWidth="1" />
      <ellipse cx="27.8" cy="30.5" rx="1.6" ry="2.2" fill="#6b3d05" />
      <ellipse cx="36.2" cy="30.5" rx="1.6" ry="2.2" fill="#6b3d05" />
      <path d="M29.5 35 Q32 37.2 34.5 35" stroke="#6b3d05" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      {/* 高光 */}
      <ellipse cx="22" cy="18" rx="9" ry="4.5" fill="#ffffff" opacity="0.55" transform="rotate(-35 22 18)" />
      <path d="M50 9 L51.2 12.8 L55 14 L51.2 15.2 L50 19 L48.8 15.2 L45 14 L48.8 12.8 Z" fill="#fffdf2" opacity="0.95" />
    </svg>
  );
}

export function Bolivar({ size = 24, glow = true, className = '' }: { size?: number; glow?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} style={glow ? { filter: GLOW_GREEN } : undefined} aria-hidden>
      <defs>
        <linearGradient id={`b${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7be3ad" />
          <stop offset="0.55" stopColor="#3fb879" />
          <stop offset="1" stopColor="#23824f" />
        </linearGradient>
      </defs>
      <rect x="5" y="20" width="56" height="32" rx="5" fill="#1a5c39" />
      <rect x="3" y="16" width="56" height="32" rx="5" fill={`url(#b${id})`} stroke="#1f6e46" strokeWidth="2" />
      <rect x="8" y="21" width="46" height="22" rx="3" fill="none" stroke="#d6f7e4" strokeOpacity="0.75" strokeWidth="1.5" />
      <circle cx="31" cy="32" r="8.5" fill="#d6f7e4" stroke="#1f6e46" strokeWidth="1.6" />
      <text x="31" y="36" textAnchor="middle" fontSize="10" fontWeight="900" fill="#1f6e46" fontFamily="system-ui, sans-serif">
        Bs
      </text>
      <ellipse cx="17" cy="21" rx="9" ry="2.6" fill="#ffffff" opacity="0.45" />
    </svg>
  );
}

/** 侧视角的一摞金币（n 枚） */
function CoinStack({ n, width = 46 }: { n: number; width?: number }) {
  const id = useId().replace(/:/g, '');
  const layer = 5;
  const h = 16 + layer * (n - 1);
  return (
    <svg width={width} height={(h * width) / 46} viewBox={`0 0 46 ${h}`} style={{ filter: GLOW_GOLD }} aria-hidden>
      <defs>
        <linearGradient id={`s${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8a5208" />
          <stop offset="0.35" stopColor="#e6a52a" />
          <stop offset="0.6" stopColor="#ffd56b" />
          <stop offset="1" stopColor="#9a5d0a" />
        </linearGradient>
        <radialGradient id={`t${id}`} cx="40%" cy="35%" r="75%">
          <stop offset="0" stopColor="#fffbe0" />
          <stop offset="0.5" stopColor="#ffd56b" />
          <stop offset="1" stopColor="#d18c1d" />
        </radialGradient>
      </defs>
      {Array.from({ length: n }, (_, i) => {
        const y = h - 8 - i * layer;
        return (
          <g key={i}>
            <rect x="2" y={y} width="42" height={layer + 1} fill={`url(#s${id})`} />
            <ellipse cx="23" cy={y + layer + 1} rx="21" ry="6" fill={`url(#s${id})`} />
            <ellipse cx="23" cy={y} rx="21" ry="6" fill={`url(#t${id})`} stroke="#a8650c" strokeWidth="0.8" />
          </g>
        );
      })}
      <ellipse cx="17" cy="6.5" rx="7" ry="2" fill="#ffffff" opacity="0.6" />
    </svg>
  );
}

/** 档位 0–5：金币越来越多、塔越来越高 */
const COIN_LAYOUTS: Array<Array<{ kind: 'coin' | 'stack'; x: number; y: number; size: number; n?: number; r?: number }>> = [
  [{ kind: 'coin', x: 0, y: 0, size: 70 }],
  [{ kind: 'stack', x: -26, y: 10, size: 44, n: 3 }, { kind: 'coin', x: 18, y: 2, size: 58 }, { kind: 'coin', x: 44, y: 30, size: 34, r: 18 }],
  [{ kind: 'stack', x: -38, y: 2, size: 44, n: 6 }, { kind: 'stack', x: 38, y: 14, size: 40, n: 4 }, { kind: 'coin', x: 0, y: 6, size: 60 }],
  [{ kind: 'stack', x: -46, y: 0, size: 42, n: 8 }, { kind: 'stack', x: 46, y: 6, size: 42, n: 7 }, { kind: 'stack', x: 16, y: 22, size: 38, n: 4 }, { kind: 'coin', x: -10, y: 8, size: 56 }],
  [{ kind: 'stack', x: -52, y: 0, size: 40, n: 10 }, { kind: 'stack', x: -18, y: 6, size: 42, n: 8 }, { kind: 'stack', x: 50, y: 2, size: 40, n: 9 }, { kind: 'coin', x: 14, y: 10, size: 56 }, { kind: 'coin', x: 62, y: 38, size: 30, r: -20 }],
  [
    { kind: 'stack', x: -62, y: 4, size: 38, n: 10 }, { kind: 'stack', x: -30, y: -4, size: 42, n: 13 }, { kind: 'stack', x: 30, y: -2, size: 42, n: 12 },
    { kind: 'stack', x: 62, y: 6, size: 38, n: 9 }, { kind: 'coin', x: 0, y: 12, size: 58 }, { kind: 'coin', x: -46, y: 40, size: 30, r: 20 }, { kind: 'coin', x: 46, y: 42, size: 30, r: -15 },
  ],
];

export function CoinPile({ tier, kind }: { tier: number; kind: 'meuw' | 'bolivar' }) {
  const t = Math.max(0, Math.min(COIN_LAYOUTS.length - 1, tier));
  if (kind === 'bolivar') return <BillPile tier={t} />;
  return (
    <div className="relative isolate mx-auto h-28 w-48 origin-bottom scale-[0.7] md:scale-100">
      {COIN_LAYOUTS[t]!.map((c, i) => (
        <span
          key={i}
          className="absolute bottom-2 left-1/2"
          style={{ transform: `translate(calc(-50% + ${c.x}px), ${-c.y}px) rotate(${c.r ?? 0}deg)`, zIndex: Math.round(100 - c.y) }}
        >
          {c.kind === 'coin' ? <MeuwCoin size={c.size} /> : <CoinStack n={c.n!} width={c.size} />}
        </span>
      ))}
    </div>
  );
}

/** 钞票堆：档位越高，叠的钞票越多、扇形越开 */
function BillPile({ tier }: { tier: number }) {
  const count = [1, 3, 5, 7, 9, 12][tier]!;
  return (
    <div className="relative isolate mx-auto h-28 w-48 origin-bottom scale-[0.7] md:scale-100">
      {Array.from({ length: count }, (_, i) => {
        const spread = count === 1 ? 0 : (i / (count - 1) - 0.5) * Math.min(70, 14 * count);
        return (
          <span
            key={i}
            className="absolute bottom-3 left-1/2"
            style={{ transform: `translate(calc(-50% + ${spread * 0.9}px), ${-Math.abs(spread) * 0.15 - i * 1.5}px) rotate(${spread * 0.5}deg)` }}
          >
            <Bolivar size={tier === 0 ? 76 : 62} glow={i === count - 1} />
          </span>
        );
      })}
    </div>
  );
}
