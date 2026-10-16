import { create } from 'zustand';

/**
 * 下单面板 → K 线图：玩家输入本金/拖杠杆时的"预览斩杀线"。
 * liq 为 null 表示不画（未输入金额、1x 多单无斩杀等）。
 */
interface TradePreview {
  market: string | null;
  liq: string | null;
  set(market: string, liq: string | null): void;
  clear(): void;
}

export const useTradePreview = create<TradePreview>()((set, get) => ({
  market: null,
  liq: null,
  set(market, liq) {
    const cur = get();
    if (cur.market === market && cur.liq === liq) return;
    set({ market, liq });
  },
  clear() {
    if (get().liq !== null) set({ market: null, liq: null });
  },
}));
