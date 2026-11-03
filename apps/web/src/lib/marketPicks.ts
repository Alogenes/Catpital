import type { MarketInfo } from './api';

/** 顶部行情栏最多 / 最少显示几个市场 */
export const MAX_PICKED_MARKETS = 5;
export const MIN_PICKED_MARKETS = 1;

/**
 * 顶部行情栏要显示的市场：按玩家在「📊 市场」里选的顺序。
 * 没选过、或者选的市场都已经下架了，就退回默认的前 5 个（按后台排序）。
 */
export function visibleMarkets(list: MarketInfo[], picked: string[] | null | undefined): MarketInfo[] {
  if (picked?.length) {
    const byCode = new Map(list.map((m) => [m.code, m]));
    const out = picked.map((c) => byCode.get(c)).filter((m): m is MarketInfo => Boolean(m));
    if (out.length) return out.slice(0, MAX_PICKED_MARKETS);
  }
  return list.slice(0, MAX_PICKED_MARKETS);
}
