/**
 * 商店插画（内联 SVG，不请求外部资源）：
 *   Meuw Coin —— 带猫耳朵的金币
 *   Bolívar   —— 绿色钞票
 * CoinPile 按档位堆出越来越多的币 / 钞票，模仿抽卡游戏充值页的"越买越大堆"。
 */

export function MeuwCoin({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <radialGradient id="meuw-face" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#fff6c8" />
          <stop offset="0.45" stopColor="#ffd166" />
          <stop offset="1" stopColor="#e69a2e" />
        </radialGradient>
      </defs>
      <path d="M14 18 L18 4 L28 14 Z M50 18 L46 4 L36 14 Z" fill="#e69a2e" stroke="#b86f12" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="32" cy="36" r="24" fill="url(#meuw-face)" stroke="#b86f12" strokeWidth="3" />
      <circle cx="32" cy="36" r="18" fill="none" stroke="#fff3b0" strokeWidth="2" opacity="0.7" />
      <ellipse cx="24.5" cy="33" rx="2.6" ry="3.4" fill="#5b3a0a" />
      <ellipse cx="39.5" cy="33" rx="2.6" ry="3.4" fill="#5b3a0a" />
      <path d="M28.5 40.5 Q32 44 35.5 40.5" stroke="#5b3a0a" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <path d="M30.5 38.5 L33.5 38.5 L32 40 Z" fill="#ff8fab" />
      <path d="M12 38 L20 37 M12 42 L20 40 M52 38 L44 37 M52 42 L44 40" stroke="#b86f12" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Bolivar({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <rect x="4" y="16" width="56" height="32" rx="5" fill="#46b97a" stroke="#1f6e46" strokeWidth="3" />
      <rect x="9" y="21" width="46" height="22" rx="3" fill="none" stroke="#bff0d2" strokeWidth="1.6" opacity="0.8" />
      <circle cx="32" cy="32" r="9" fill="#bff0d2" stroke="#1f6e46" strokeWidth="2" />
      <text x="32" y="36.5" textAnchor="middle" fontSize="11" fontWeight="900" fill="#1f6e46" fontFamily="system-ui, sans-serif">
        Bs
      </text>
      <circle cx="14" cy="32" r="2.5" fill="#bff0d2" />
      <circle cx="50" cy="32" r="2.5" fill="#bff0d2" />
    </svg>
  );
}

/** 档位 1–6：堆出 1、3、5、7、9、12 枚 */
const PILE = [1, 3, 5, 7, 9, 12];
const SPOTS: Array<[number, number, number]> = [
  [0, 0, 1.25], [-34, 16, 0.85], [34, 16, 0.85], [-18, 30, 0.8], [18, 30, 0.8], [-52, 34, 0.7],
  [52, 34, 0.7], [0, 40, 0.75], [-36, 44, 0.65], [36, 44, 0.65], [-62, 48, 0.55], [62, 48, 0.55],
];

export function CoinPile({ tier, kind }: { tier: number; kind: 'meuw' | 'bolivar' }) {
  const count = PILE[Math.max(0, Math.min(PILE.length - 1, tier))]!;
  const Icon = kind === 'meuw' ? MeuwCoin : Bolivar;
  // 后面的（更小、更靠下）先画，主币最后画在最上层
  const spots = SPOTS.slice(0, count).map((s, i) => ({ s, i })).reverse();
  return (
    <div className="relative mx-auto h-24 w-44">
      {spots.map(({ s: [x, y, scale], i }) => (
        <span
          key={i}
          className="absolute left-1/2 top-2 drop-shadow-[0_3px_3px_rgba(31,40,80,0.35)]"
          style={{ transform: `translate(calc(-50% + ${x}px), ${y}px) scale(${scale}) rotate(${(i % 3) * 8 - 8}deg)` }}
        >
          <Icon size={52} />
        </span>
      ))}
    </div>
  );
}
