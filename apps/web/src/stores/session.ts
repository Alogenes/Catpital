import type { PositionView } from '@catpital/shared';
import { create } from 'zustand';
import type { OrderView, ResumeView } from '../lib/api';

export interface MeUser {
  id: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  isAdmin: boolean;
  generation: number;
  settings: Record<string, unknown>;
}

export interface MeResponse {
  user: MeUser;
  wallet: { balance: string; locked: string; netWorth: string };
  life: { generation: number; startedAt: number; peakNetWorth: string } | null;
  positions: PositionView[];
  orders: OrderView[];
  bankruptcyAvailable: boolean;
}

interface SessionStore {
  status: 'idle' | 'authenticating' | 'ready' | 'error';
  error: string | null;
  embedded: boolean;
  user: MeUser | null;
  balance: string;
  locked: string;
  generation: number;
  /** 按市场代码索引的持仓 */
  positions: Record<string, PositionView>;
  orders: OrderView[];
  bankruptcyAvailable: boolean;
  /** 要展示的履历（破产后弹出） */
  resume: ResumeView | null;

  setStatus(status: SessionStore['status'], error?: string | null): void;
  hydrate(me: MeResponse, embedded: boolean): void;
  setWallet(balance: string, locked: string, generation?: number): void;
  setPosition(market: string, p: PositionView | null): void;
  upsertOrder(o: OrderView): void;
  removeOrder(id: string): void;
  setBankruptcyAvailable(v: boolean): void;
  showResume(r: ResumeView | null): void;
}

export const useSession = create<SessionStore>()((set) => ({
  status: 'idle',
  error: null,
  embedded: false,
  user: null,
  balance: '0',
  locked: '0',
  generation: 1,
  positions: {},
  orders: [],
  bankruptcyAvailable: false,
  resume: null,

  setStatus(status, error = null) {
    set({ status, error });
  },
  hydrate(me, embedded) {
    set({
      status: 'ready',
      embedded,
      user: me.user,
      balance: me.wallet.balance,
      locked: me.wallet.locked,
      generation: me.user.generation,
      positions: Object.fromEntries(me.positions.map((p) => [p.market, p])),
      orders: me.orders,
      bankruptcyAvailable: me.bankruptcyAvailable,
    });
  },
  setWallet(balance, locked, generation) {
    set((s) => ({ balance, locked, generation: generation ?? s.generation }));
  },
  setPosition(market, p) {
    set((s) => {
      const positions = { ...s.positions };
      if (p) positions[market] = p;
      else delete positions[market];
      return { positions };
    });
  },
  upsertOrder(o) {
    set((s) => ({ orders: [o, ...s.orders.filter((x) => x.id !== o.id)] }));
  },
  removeOrder(id) {
    set((s) => ({ orders: s.orders.filter((o) => o.id !== id) }));
  },
  setBankruptcyAvailable(v) {
    set({ bankruptcyAvailable: v });
  },
  showResume(r) {
    set({ resume: r });
  },
}));
