import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type HttpEnv } from '../src/http/server.js';
import { type Harness, createHarness } from './support/harness.js';

const BASE: HttpEnv = {
  API_BASE_PATH: '/api', WS_PATH: '/ws', JWT_SECRET: 'test-secret-123', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '',
  DEV_LOGIN: '0', NODE_ENV: 'test', DANMAKU_COOLDOWN_MS: 1000,
};
const BOSS = '700000000000000001';
const IMPOSTOR = '700000000000000002';
const PLAYER = '700000000000000003';
let h: Harness;
let on: Awaited<ReturnType<typeof buildServer>>;
let off: Awaited<ReturnType<typeof buildServer>>;
const auth = (app: typeof on, sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub })}` });

beforeAll(async () => {
  h = await createHarness();
  on = await buildServer(h.core, { ...BASE, ADMIN_PANEL_USERS: `${BOSS}:Boss, ${IMPOSTOR}:someone-else` });
  off = await buildServer(h.core, BASE);
  await h.user(BOSS, 'boss');
  await h.user(IMPOSTOR, 'impostor');
});
afterAll(async () => {
  await on.close();
  await off.close();
  await h.close();
});

describe('访问控制', () => {
  it('is indistinguishable from a missing route when disabled or not whitelisted', async () => {
    const missing = await off.inject({ method: 'GET', url: '/api/v1/definitely-not-here', headers: auth(off, BOSS) });
    for (const [app, sub] of [[off, BOSS], [on, IMPOSTOR], [on, PLAYER]] as const) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/panel/users', headers: auth(app, sub) });
      expect(res.statusCode).toBe(404);
      expect(Object.keys(res.json())).toEqual(Object.keys(missing.json()));
    }
    const anon = await on.inject({ method: 'GET', url: '/api/v1/panel/users' });
    expect(anon.statusCode).toBe(404);

    expect((await off.inject({ method: 'GET', url: '/api/v1/me', headers: auth(off, BOSS) })).json().user).not.toHaveProperty('panel');
    expect((await on.inject({ method: 'GET', url: '/api/v1/me', headers: auth(on, IMPOSTOR) })).json().user).not.toHaveProperty('panel');
    expect((await on.inject({ method: 'GET', url: '/api/v1/me', headers: auth(on, BOSS) })).json().user.panel).toBe(true);
  });
});

describe('用户管理', () => {
  it('creates, funds, inspects and deletes a player', async () => {
    const H = auth(on, BOSS);
    const created = await on.inject({ method: 'POST', url: '/api/v1/panel/users', headers: H, payload: { id: PLAYER, username: 'newbie', balance: '500' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().wallet.balance).toBe('500');
    expect((await on.inject({ method: 'POST', url: '/api/v1/panel/users', headers: H, payload: { id: PLAYER, username: 'x' } })).statusCode).toBe(409);

    const add = await on.inject({ method: 'POST', url: `/api/v1/panel/users/${PLAYER}/balance`, headers: H, payload: { mode: 'add', amount: '-120.5', memo: 'fine' } });
    expect(add.json().balance).toBe('379.5');
    const set = await on.inject({ method: 'POST', url: `/api/v1/panel/users/${PLAYER}/balance`, headers: H, payload: { mode: 'set', amount: '1000000' } });
    expect(set.json().balance).toBe('1000000');
    const inv = await h.assertLedgerInvariant(PLAYER);
    expect(inv.ledgerSum).toBe(inv.balance);

    const detail = (await on.inject({ method: 'GET', url: `/api/v1/panel/users/${PLAYER}`, headers: H })).json();
    expect(detail.ledger.filter((l: { type: string }) => l.type === 'ADMIN_ADJUST')).toHaveLength(3);
    const list = (await on.inject({ method: 'GET', url: '/api/v1/panel/users?q=newb', headers: H })).json();
    expect(list.map((u: { id: string }) => u.id)).toEqual([PLAYER]);

    expect((await on.inject({ method: 'DELETE', url: `/api/v1/panel/users/${BOSS}`, headers: H })).statusCode).toBe(403);
    expect((await on.inject({ method: 'DELETE', url: `/api/v1/panel/users/${PLAYER}`, headers: H })).statusCode).toBe(204);
    expect(await h.db.user.findUnique({ where: { id: PLAYER } })).toBeNull();
  });
});

describe('事件', () => {
  it('fires a headline-less event silently and a titled one loudly', async () => {
    const H = auth(on, BOSS);
    h.setNow(new Date(Date.now() + 5_000));
    const before = h.core.markets.price(h.core.markets.byCode('TEST')!.id)!;
    const silent = await on.inject({
      method: 'POST', url: '/api/v1/panel/events', headers: H,
      payload: { market: 'test', direction: 'DOWN', gapPct: '20', volMultiplier: '3', trend: '5', delaySec: 0, durationSec: 60 },
    });
    expect(silent.statusCode).toBe(201);
    await h.core.events.poll();
    const after = h.core.markets.price(h.core.markets.byCode('TEST')!.id)!;
    expect(after.div(before).toFixed(2)).toBe('0.80');
    expect(await h.db.broadcast.count({ where: { kind: 'MARKET_EVENT' } })).toBe(0);
    const ev = await h.db.scheduledEvent.findUniqueOrThrow({ where: { id: silent.json().id } });
    expect(ev.driftAdjust.toFixed()).toBe('-5');

    const news = await on.inject({ method: 'GET', url: '/api/v1/markets/TEST/events', headers: H });
    expect(news.json()).toHaveLength(0);

    await on.inject({
      method: 'POST', url: '/api/v1/panel/events', headers: H,
      payload: { market: 'TEST', direction: 'UP', gapPct: '10', volMultiplier: '1', delaySec: 0, durationSec: 0, headline: 'Catnip shortage' },
    });
    await h.core.events.poll();
    expect(await h.db.broadcast.count({ where: { kind: 'MARKET_EVENT' } })).toBe(1);

    const bad = await on.inject({
      method: 'POST', url: '/api/v1/panel/events', headers: H,
      payload: { market: 'TEST', direction: 'DOWN', gapPct: '100', volMultiplier: '1', delaySec: 0, durationSec: 0 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
