import { motion } from 'framer-motion';

/**
 * 五维雷达图（纯 SVG，不引图表库）：4 圈网格 + 轴线，数据多边形用荧光紫半透明填充、青色描边点。
 * axes 按顺时针排列，第一条朝正上方；score 取 0–100。
 */

const R = 78;
// 标签离顶点留一点距离；左右两侧的标签向外延伸，viewBox 两边留足宽度给较长的英文 / 西语名称
const LABEL_R = R + 16;
const GRID = [0.25, 0.5, 0.75, 1];
const GRAPE = '#a77bff';
const SKY = '#6ec8ff';
const LINE = '#3a2e60';

const point = (i: number, n: number, r: number) => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  return [Math.cos(a) * r, Math.sin(a) * r] as const;
};
const ring = (n: number, r: number) =>
  Array.from({ length: n }, (_, i) => point(i, n, r).map((v) => v.toFixed(1)).join(',')).join(' ');

export function RadarChart({ axes }: { axes: Array<{ label: string; icon: string; score: number }> }) {
  const n = axes.length;
  const shape = axes.map((a, i) => point(i, n, (R * Math.max(0, Math.min(100, a.score))) / 100));

  return (
    <svg viewBox="-190 -118 380 240" className="mx-auto w-full max-w-[360px] select-none" role="img" data-testid="profile-radar">
      <defs>
        <radialGradient id="radar-fill">
          <stop offset="0" stopColor={SKY} stopOpacity="0.45" />
          <stop offset="1" stopColor={GRAPE} stopOpacity="0.35" />
        </radialGradient>
        <filter id="radar-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 网格：四圈五边形 + 五条轴 */}
      {GRID.map((g) => (
        <polygon key={g} points={ring(n, R * g)} fill={g === 1 ? 'rgba(36,27,63,0.6)' : 'none'} stroke={LINE} strokeWidth="1" />
      ))}
      {axes.map((_, i) => {
        const [x, y] = point(i, n, R);
        return <line key={i} x1="0" y1="0" x2={x} y2={y} stroke={LINE} strokeWidth="1" />;
      })}

      {/* 数据：从中心长出来 */}
      <motion.g initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 140, damping: 16 }}>
        <polygon
          points={shape.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
          fill="url(#radar-fill)"
          stroke={GRAPE}
          strokeWidth="2.5"
          strokeLinejoin="round"
          filter="url(#radar-glow)"
        />
        {shape.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3.5" fill={SKY} stroke="#130e24" strokeWidth="1.5" />
        ))}
      </motion.g>

      {/* 轴标签：图标 + 名称 + 分数 */}
      {axes.map((a, i) => {
        const [x, y] = point(i, n, LABEL_R);
        const anchor = Math.abs(x) < 8 ? 'middle' : x > 0 ? 'start' : 'end';
        // 正上方的标签整体上移一行，分数不压在顶点上
        const top = y < -R * 0.9 ? -14 : 0;
        return (
          <text key={a.label} x={x} y={y + top} textAnchor={anchor} dominantBaseline="middle" fontSize="11.5" fontWeight="800" fill="#e2dbf7">
            <tspan>
              {a.icon} {a.label}
            </tspan>
            <tspan x={x} dy="14" fontSize="12" fontFamily="ui-monospace, monospace" fill={SKY}>
              {a.score}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}
