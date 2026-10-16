import type { BroadcastPayload, DanmakuPayload } from '@catpital/shared';
import { create } from 'zustand';

export type FxKind = 'bigWin' | 'liquidated' | 'deficit' | 'bankrupt';

export interface FxEvent {
  id: number;
  kind: FxKind;
  /** 例如损失金额、收益率，用于特效文案 */
  detail?: string;
}

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error' | 'danger';
  text: string;
}

interface FeedStore {
  banners: BroadcastPayload[];
  /** 最近的全服播报（跑马灯用，新的在前） */
  history: BroadcastPayload[];
  setHistory(list: BroadcastPayload[]): void;
  fx: FxEvent | null;
  toasts: Toast[];
  danmaku: DanmakuPayload[];
  pushBanner(b: BroadcastPayload): void;
  shiftBanner(): void;
  triggerFx(kind: FxKind, detail?: string): void;
  clearFx(id: number): void;
  toast(tone: Toast['tone'], text: string): void;
  dismissToast(id: number): void;
  pushDanmaku(d: DanmakuPayload): void;
  consumeDanmaku(): DanmakuPayload[];
  /** 切换股市时清空尚未上屏的弹幕队列 */
  clearDanmaku(): void;
}

let seq = 1;

export const useFeed = create<FeedStore>()((set, get) => ({
  banners: [],
  history: [],
  fx: null,
  toasts: [],
  danmaku: [],
  setHistory(list) {
    set({ history: list.slice(0, 20) });
  },
  pushBanner(b) {
    set((s) => ({
      banners: s.banners.some((x) => x.id === b.id) ? s.banners : [...s.banners, b].slice(-20),
      history: s.history.some((x) => x.id === b.id) ? s.history : [b, ...s.history].slice(0, 20),
    }));
  },
  shiftBanner() {
    set((s) => ({ banners: s.banners.slice(1) }));
  },
  triggerFx(kind, detail) {
    // 破产 > 斩杀/穿仓 > 暴富：低优先级特效不打断高优先级
    const rank: Record<FxKind, number> = { bigWin: 1, liquidated: 2, deficit: 3, bankrupt: 4 };
    const cur = get().fx;
    if (cur && rank[cur.kind] > rank[kind]) return;
    set({ fx: { id: seq++, kind, detail } });
  },
  clearFx(id) {
    set((s) => (s.fx?.id === id ? { fx: null } : s));
  },
  toast(tone, text) {
    const id = seq++;
    set((s) => ({ toasts: [...s.toasts, { id, tone, text }].slice(-4) }));
    setTimeout(() => get().dismissToast(id), tone === 'danger' ? 7000 : 3500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  pushDanmaku(d) {
    set((s) => ({ danmaku: [...s.danmaku, d].slice(-50) }));
  },
  consumeDanmaku() {
    const items = get().danmaku;
    if (items.length) set({ danmaku: [] });
    return items;
  },
  clearDanmaku() {
    set({ danmaku: [] });
  },
}));
