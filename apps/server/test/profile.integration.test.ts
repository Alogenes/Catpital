import { D } from '@catpital/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type HttpEnv } from '../src/http/server.js';
import { TEST_MARKET, type Harness, createHarness } from './support/harness.js';

const A = '500000000000000001';
const B = '500000000000000002';
const C = '500000000000000003';
const BASE: HttpEnv = {
  API_BASE_PATH: '/api', WS_PATH: '/ws', JWT_SECRET: 'test-secret-123', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '',
  DEV_LOGIN: '0', NODE_ENV: 'test', DANMAKU_COOLDOWN_MS: 1000, ADMIN_PANEL_USERS: '',
};

let h: Harness;
let app: Awaited<ReturnType<typeof buildServer>>;
const auth = (sub = A) => ({ authorization: `Bearer ${app.jwt.sign({ sub })}` });

beforeAll(async () => {
  h = await createHarness([TEST_MARKET, { ...TEST_MARKET, code: 'OLD', name: 'Old Corp' }]);
  app = await buildServer(h.core, BASE);
  await h.user(A, 'alice');
  await h.user(B, 'bob');
  await h.user(C, 'carol');
  h.advance(1000);
  await h.core.leaderboard.ensureBaselines();
});
afterAll(async () => {
  await app.close();
  await h.close();
});

describe('leaderboard paging', () => {
  it('returns one page at a time with totals, and clamps a page past the end', async () => {
    h.core.leaderboard.invalidate();
    const first = await h.core.leaderboard.board('DAILY', 'NET_WORTH', A, 2, 1);
    expect([first.page, first.pageSize, first.total, first.totalPages, first.entries.map((e) => e.rank)]).toEqual([1, 2, 3, 2, [1, 2]]);
    const second = await h.core.leaderboard.board('DAILY', 'NET_WORTH', A, 2, 2);
    expect([second.page, second.entries.map((e) => e.rank)]).toEqual([2, [3]]);
    const past = (await app.inject({ method: 'GET', url: '/api/v1/leaderboard?board=NET_WORTH&limit=2&page=99' })).json();
    expect([past.page, past.entries.map((e: { rank: number }) => e.rank)]).toEqual([2, [3]]);
  });
});

describe('player profile', () => {
  it('scores the five dimensions from trades, lives and chat', async () => {
    // alice：10x 开多 → 涨了平仓（1 笔盈利），共 2 笔成交
    await h.core.orders.placeOrder(A, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(10), leverage: D(10) });
    await h.tick('110');
    await h.core.orders.closePosition(A, 'TEST');
    await h.db.life.updateMany({ where: { userId: A }, data: { danmakuCount: 10 } });

    const r = await app.inject({ method: 'GET', url: `/api/v1/users/${A}/profile`, headers: auth(B) });
    expect(r.statusCode).toBe(200);
    const p = r.json();
    expect(p.user).toMatchObject({ id: A, name: 'alice', generation: 1 });
    expect(p.raw).toMatchObject({ winRate: 1, closedTrades: 1, avgLeverage: 10, positions: 1, trades: 2, bankruptcies: 0, danmaku: 10 });
    // 胜率 100%；平均 10x = 50 分；注册不满一天按一天：日均 2 笔、10 条弹幕
    expect(p.scores).toMatchObject({ profitability: 100, risk: 50, activity: saturate(2, 10), chat: saturate(10, 10) });
    for (const v of Object.values(p.scores as Record<string, number>)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('shows zeros for a player who has done nothing yet, and 404 for an unknown id', async () => {
    const p = (await app.inject({ method: 'GET', url: `/api/v1/users/${B}/profile`, headers: auth() })).json();
    expect(p.raw).toMatchObject({ winRate: null, avgLeverage: null, trades: 0, danmaku: 0 });
    expect(p.scores).toMatchObject({ profitability: 0, risk: 0, activity: 0, chat: 0 });
    const missing = await app.inject({ method: 'GET', url: '/api/v1/users/999999999999999999/profile', headers: auth() });
    expect([missing.statusCode, missing.json().error]).toEqual([404, 'error.userNotFound']);
    expect((await app.inject({ method: 'GET', url: `/api/v1/users/${A}/profile` })).statusCode).toBe(401);
  });
});

describe('retiring a market', () => {
  it('cancels its orders, closes its positions at the last price, then delists it', async () => {
    await h.core.orders.placeOrder(C, { market: 'OLD', side: 'BUY', type: 'MARKET', quantity: D(10), leverage: D(5) });
    await h.core.orders.placeOrder(C, { market: 'OLD', side: 'BUY', type: 'LIMIT', quantity: D(5), leverage: D(5), limitPrice: D(90) });
    await h.tick('105', 'OLD');

    const r = await h.core.orders.retireMarket('OLD');
    expect(r).toMatchObject({ code: 'OLD', price: '105', cancelledOrders: 1, closedPositions: 1 });
    expect(await h.db.position.count({ where: { userId: C, status: 'OPEN' } })).toBe(0);
    expect(await h.db.order.count({ where: { userId: C, status: 'PENDING' } })).toBe(0);
    expect((await h.wallet(C)).locked).toBe('0');
    const inv = await h.assertLedgerInvariant(C);
    expect(inv.ledgerSum).toBe(inv.balance);
    expect((await h.db.market.findUniqueOrThrow({ where: { code: 'OLD' } })).status).toBe('DELISTED');

    // 下架后从目录里移除，再跑一次什么都不做
    await h.core.markets.unregister(r!.marketId);
    expect(await h.core.orders.retireMarket('OLD')).toBeNull();
  });
});

function saturate(x: number, half: number) {
  return Math.round((100 * x) / (x + half));
}
