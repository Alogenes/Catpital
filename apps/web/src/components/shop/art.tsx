import { useId } from 'react';

/**
 * 商店图标（内联 SVG，不请求外部资源）：
 *   MeowCoin  —— 3D 金币：有厚度的币边、浮雕猫脸、左上高光，可选外圈光晕
 *   Bolivar   —— 带厚度的绿色钞票
 * 渐变 id 用 useId 生成，同一页面里画多枚也不会互相串色。
 */

const GLOW_GOLD = 'drop-shadow(0 0 6px rgba(255,209,102,0.65)) drop-shadow(0 3px 2px rgba(10,6,22,0.6))';
const GLOW_GREEN = 'drop-shadow(0 0 5px rgba(61,220,151,0.45)) drop-shadow(0 3px 2px rgba(10,6,22,0.6))';

export function MeowCoin({ size = 24, glow = true, className = '' }: { size?: number; glow?: boolean; className?: string }) {
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
