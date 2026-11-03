import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type HttpEnv } from '../src/http/server.js';
import { TEST_MARKET, type Harness, createHarness } from './support/harness.js';

const A = '600000000000000001';
const B = '600000000000000002';
const BASE: HttpEnv = {
  API_BASE_PATH: '/api', WS_PATH: '/ws', JWT_SECRET: 'test-secret-123', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '',
  DEV_LOGIN: '0', NODE_ENV: 'test', DANMAKU_COOLDOWN_MS: 1000, ADMIN_PANEL_USERS: '',
};

let h: Harness;
let app: Awaited<ReturnType<typeof buildServer>>;
const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub })}` });
const HOUR = 3_600_000;

beforeAll(async () => {
  h = await createHarness([TEST_MARKET]);
  app = await buildServer(h.core, BASE);
  await h.user(A, 'alice');
  await h.user(B, 'bob');
});
afterAll(async () => {
  await app.close();
  await h.close();
});

describe('24-hour feed reactions', () => {
  it('counts one vote per player, shows recent voters, lets them switch or undo, and pushes updates', async () => {
    const b = await h.core.notifier.broadcast('BIG_WIN', 'broadcast.bigWin', { pnl: '1000', market: 'TEST' }, { userId: A });
    const vote = (user: string, value: number) => app.inject({ method: 'POST', url: `/api/v1/broadcasts/${b.id}/reaction`, headers: auth(user), payload: { value } });

    const fresh = (await app.inject({ method: 'GET', url: '/api/v1/broadcasts/feed', headers: auth(B) })).json();
    expect(fresh[0]).toMatchObject({ id: b.id, kind: 'BIG_WIN', reactions: { up: 0, down: 0, users: [], mine: 0 } });

    await vote(A, 1);
    h.advance(1000);
    const r = (await vote(B, -1)).json();
    expect(r).toMatchObject({ up: 1, down: 1, mine: -1 });
    expect(r.users.map((u: { name: string; value: number }) => [u.name, u.value])).toEqual([['bob', -1], ['alice', 1]]); // 最新在前

    // 改票、撤回
    expect((await vote(B, 1)).json()).toMatchObject({ up: 2, down: 0, mine: 1 });
    expect((await vote(A, 0)).json()).toMatchObject({ up: 1, down: 0, mine: 0 });

    const pushed = h.messages.filter((m) => 'ch' in m.msg && m.msg.ch === 'reactions');
    expect(pushed.length).toBe(4);
    expect(pushed.at(-1)!.msg).toMatchObject({ ch: 'reactions', d: { broadcastId: b.id, up: 1, down: 0 } });

    const mine = (await app.inject({ method: 'GET', url: '/api/v1/broadcasts/feed', headers: auth(B) })).json();
    expect(mine[0].reactions).toMatchObject({ up: 1, down: 0, mine: 1 });

    // 只给 24 小时内的（播报时间由数据库打戳，这里直接改成 25 小时前）
    await h.db.broadcast.updateMany({ data: { createdAt: new Date(h.clock().getTime() - 25 * HOUR) } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/broadcasts/feed' })).json()).toEqual([]);
  });

  it('rejects bad votes, unknown reports and anonymous voters', async () => {
    const b = await h.core.notifier.broadcast('BIG_WIN', 'broadcast.bigWin', { pnl: '1', market: 'TEST' }, { userId: A });
    const bad = await app.inject({ method: 'POST', url: `/api/v1/broadcasts/${b.id}/reaction`, headers: auth(A), payload: { value: 2 } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/v1/broadcasts/nope/reaction', headers: auth(A), payload: { value: 1 } });
    expect([missing.statusCode, missing.json().error]).toEqual([404, 'error.broadcastNotFound']);
    expect((await app.inject({ method: 'POST', url: `/api/v1/broadcasts/${b.id}/reaction`, payload: { value: 1 } })).statusCode).toBe(401);
  });
});

describe('danmaku history', () => {
  it('returns every message from the last N hours, oldest first', async () => {
    const now = h.clock().getTime();
    for (const [text, ago] of [['old', 3 * HOUR], ['recent', HOUR], ['latest', 60_000]] as const) {
      h.core.notifier.danmaku({ market: 'TEST', userId: A, name: 'alice', avatar: null, text, ts: now - ago });
    }
    await new Promise((r) => setTimeout(r, 10));
    const recent = (await app.inject({ method: 'GET', url: '/api/v1/markets/TEST/danmaku?hours=2' })).json();
    expect(recent.map((d: { text: string }) => d.text)).toEqual(['recent', 'latest']);
    const layer = (await app.inject({ method: 'GET', url: '/api/v1/markets/TEST/danmaku' })).json();
    expect(layer.map((d: { text: string }) => d.text)).toEqual(['old', 'recent', 'latest']);
  });
});

describe('market picks setting', () => {
  it('saves 1–5 market codes and rejects anything outside that', async () => {
    const put = (markets: unknown) => app.inject({ method: 'PUT', url: '/api/v1/me/settings', headers: auth(A), payload: { markets } });
    const ok = await put(['TEST', 'BTC']);
    expect([ok.statusCode, ok.json().settings.markets]).toEqual([200, ['TEST', 'BTC']]);
    expect((await put([])).statusCode).toBe(400);
    expect((await put(['A', 'B', 'C', 'D', 'E', 'F'])).statusCode).toBe(400);
    expect((await put(['bad code'])).statusCode).toBe(400);
  });
});
