import type { MarketEventPayload, MarketStatusCode } from '@catpital/shared';
import { create } from 'zustand';
import type { MarketInfo } from '../lib/api';

export interface PriceState {
  price: string;
  /** 上一次价格，用于涨跌闪烁 */
  prev: string;
  ts: number;
}

interface MarketsStore {
  list: MarketInfo[];
  selected: string | null;
  prices: Record<string, PriceState>;
  news: MarketEventPayload[];
  setList(list: MarketInfo[]): void;
  select(code: string): void;
  setPrice(code: string, price: string, ts: number): void;
  setStatus(code: string, status: MarketStatusCode): void;
  pushNews(e: MarketEventPayload): void;
  setNews(code: string, items: MarketEventPayload[]): void;
}

export const useMarkets = create<MarketsStore>()((set) => ({
  list: [],
  selected: null,
  prices: {},
  news: [],
  setList(list) {
    set((s) => ({
      list,
      selected: s.selected ?? list.find((m) => m.status === 'ACTIVE')?.code ?? list[0]?.code ?? null,
      prices: Object.fromEntries(list.map((m) => [m.code, s.prices[m.code] ?? { price: m.price, prev: m.price, ts: 0 }])),
    }));
  },
  select(code) {
    set({ selected: code });
  },
  setPrice(code, price, ts) {
    set((s) => {
      const cur = s.prices[code];
      if (cur && cur.ts > ts) return s;
      return { prices: { ...s.prices, [code]: { price, prev: cur?.price ?? price, ts } } };
    });
  },
  setStatus(code, status) {
    set((s) => ({ list: s.list.map((m) => (m.code === code ? { ...m, status } : m)) }));
  },
  pushNews(e) {
    set((s) => ({ news: [e, ...s.news.filter((n) => n.eventId !== e.eventId)].slice(0, 50) }));
  },
  setNews(code, items) {
    set((s) => ({ news: [...items, ...s.news.filter((n) => n.market !== code)].sort((a, b) => b.ts - a.ts).slice(0, 50) }));
  },
}));

export const useSelectedMarket = () =>
  useMarkets((s) => s.list.find((m) => m.code === s.selected) ?? null);
