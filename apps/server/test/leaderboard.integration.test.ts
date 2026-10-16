import { D } from '@catpital/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodWindow } from '../src/leaderboard/periods.js';
import { type Harness, createHarness } from './support/harness.js';

describe('periodWindow (UTC)', () => {
  it('daily / weekly (ISO) / monthly keys and bounds', () => {
    const now = new Date('2026-10-16T13:45:00Z'); // 周五
    expect(periodWindow('DAILY', now)).toMatchObject({ key: '2026-10-16', start: new Date('2026-10-16T00:00:00Z'), end: new Date('2026-10-17T00:00:00Z') });
    expect(periodWindow('WEEKLY', now)).toMatchObject({ key: '2026-W42', start: new Date('2026-10-12T00:00:00Z'), end: new Date('2026-10-19T00:00:00Z') });
    expect(periodWindow('MONTHLY', now)).toMatchObject({ key: '2026-10', start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') });
  });
  it('ISO week year boundaries', () => {
    expect(periodWindow('WEEKLY', new Date('2027-01-01T00:00:00Z')).key).toBe('2026-W53');
    expect(periodWindow('WEEKLY', new Date('2026-01-01T00:00:00Z')).key).toBe('2026-W01');
    expect(periodWindow('WEEKLY', new Date('2026-10-18T23:59:59Z')).key).toBe('2026-W42'); // 周日仍属本周
  });
});

const A = '400000000000000001';
const B = '400000000000000002';
const C = '400000000000000003';
const D_ = '400000000000000004';
let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  await h.user(A, 'alice');
  await h.user(B, 'bob');
  await h.user(C, 'carol');
  h.advance(1000);
  await h.core.leaderboard.ensureBaselines(); // 期初净值 V0 = 10000
});
afterAll(async () => {
  await h.close();
});

describe('live leaderboard', () => {
  it('ranks profit, flat and bankrupt players without counting relief funds as profit', async () => {
    // A：10x 多 10 股 100 → 110 平仓，余额 10097.9
    await h.core.orders.placeOrder(A, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(10), leverage: D(10) });
    await h.tick('110');
    await h.core.orders.closePosition(A, 'TEST');
    // C：100x 多 900 股 @110，跳到 70 被斩杀穿仓 → 破产领 5000 救济金
    await h.core.orders.placeOrder(C, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(900), leverage: D(100) });
    await h.tick('70');
    await h.core.bankruptcy.declare(C);
    h.advance(60_000);
    h.core.leaderboard.invalidate();

    const rich = await h.core.leaderboard.board('WEEKLY', 'NET_WORTH', A);
    expect(rich.entries.map((e) => [e.name, e.value])).toEqual([
      ['alice', '10097.9'],
      ['bob', '10000'],
      ['carol', '5000'],
    ]);
    expect(rich.me).toEqual({ rank: 1, value: '10097.9', eligible: true });

    const ret = await h.core.leaderboard.board('WEEKLY', 'RETURN_PCT', C);
    expect(ret.entries.map((e) => e.name)).toEqual(['alice', 'bob', 'carol']);
    expect(ret.entries[0]!.value).toBe('0.979'); // (10097.9 − 10000) / 10000
    expect(ret.entries[1]!.value).toBe('0');
    // 抹债 + 救济金是外部资金流：carol 从 1 万到 5 千，收益率必须为负，而不是"领救济金暴涨"
    expect(D(ret.entries[2]!.value).lt(0)).toBe(true);
    expect(ret.me?.rank).toBe(3);
  });

  it('a player who joins mid-period starts at 0% (initial grant is not counted as profit)', async () => {
    await h.user(D_, 'dave');
    h.advance(1000);
    h.core.leaderboard.invalidate();
    const ret = await h.core.leaderboard.board('DAILY', 'RETURN_PCT', D_);
    const dave = ret.entries.find((e) => e.userId === D_);
    expect(dave?.value).toBe('0');
  });

  it('serves the board over HTTP without auth', async () => {
    const { buildServer } = await import('../src/http/server.js');
    const app = await buildServer(h.core, {
      API_BASE_PATH: '/api',
      WS_PATH: '/ws',
      JWT_SECRET: 'test-secret-123',
      DISCORD_CLIENT_ID: '',
      DISCORD_CLIENT_SECRET: '',
      DEV_LOGIN: '0',
      NODE_ENV: 'test',
      DANMAKU_COOLDOWN_MS: 1000,
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/leaderboard?period=MONTHLY&board=NET_WORTH&limit=2' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ period: 'MONTHLY', periodKey: '2026-10', board: 'NET_WORTH', me: null, minCapital: '1000' });
    expect(body.entries).toHaveLength(2);
    await app.close();
  });
});
