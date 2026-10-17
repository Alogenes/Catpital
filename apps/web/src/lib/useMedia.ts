import { useEffect, useState } from 'react';

/** 订阅 CSS 媒体查询（窗口尺寸 / Discord 手机端切换横竖屏时实时更新） */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** 与 Tailwind 的 md 断点一致：≥ 768px 为桌面/平板布局，否则为手机布局 */
export const useIsDesktop = () => useMediaQuery('(min-width: 768px)');
