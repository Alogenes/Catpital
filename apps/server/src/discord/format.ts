import { D, Decimal } from '@catpital/shared';

/** 千分位 + 固定小数（纯 Decimal，展示用四舍五入） */
export function money(v: Decimal | string | number, dp = 2): string {
  const d = typeof v === 'number' ? D(Math.trunc(v)) : D(v);
  const s = d.toFixed(dp, Decimal.ROUND_HALF_UP);
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  return `${neg ? '-' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}

export const signed = (v: Decimal | string, dp = 2) => {
  const d = D(v);
  return d.gt(0) ? `+${money(d, dp)}` : money(d, dp);
};

/** 百分数值（如 "12.5" 表示 12.5%）→ "+12.50%" */
export const pct = (v: Decimal | string, dp = 2) => `${signed(v, dp)}%`;

export function duration(seconds: number, locale: 'zh-CN' | 'en-US'): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (locale === 'zh-CN') return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : m ? `${m} 分 ${s} 秒` : `${s} 秒`;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

/** Discord 时间戳标记：在每个用户本地时区渲染 */
export const discordTime = (ms: number, style: 'R' | 'f' | 'F' | 't' | 'T' = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;
