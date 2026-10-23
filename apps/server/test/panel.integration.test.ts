import { D } from '@catpital/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type HttpEnv } from '../src/http/server.js';
import { seedMarkets } from '../src/seed/seedMarkets.js';
import { type Harness, TEST_MARKET, createHarness, flushMicrotasks } from './support/harness.js';

const BASE: HttpEnv = {
  API_BASE_PATH: '/api', WS_PATH: '/ws', JWT_SECRET: 'test-secret-123', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '',
  DEV_LOGIN: '0', NODE_ENV: 'test', DANMAKU_COOLDOWN_MS: 1000,
};
const BOSS = '626797305567248398'; // 硬编码的唯一管理员
const IMPOSTOR = '700000000000000002';
const PLAYER = '700000000000000003';
let h: Harness;
let on: Awaited<ReturnType<typeof buildServer>>;
let off: Awaited<ReturnType<typeof buildServer>>;
const auth = (app: typeof on, sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub })}` });

beforeAll(async () => {
  h = await createHarness();
  on = await buildServer(h.core, { ...BASE, ADMIN_PANEL_USERS: `${BOSS}:Boss, ${IMPOSTOR}:impostor` });
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

describe('市场定价', () => {
  it('sets the price instantly and liquidates through the normal risk path', async () => {
    const H = auth(on, BOSS);
    const SHORTER = '700000000000000004';
    await h.user(SHORTER, 'shorter');
    const m = h.core.markets.byCode('TEST')!;
    const p0 = h.core.markets.price(m.id)!;
    // 50x 空单：价格直接拉高 10% 必然被斩杀
    await h.core.orders.placeOrder(SHORTER, { market: 'TEST', side: 'SELL', type: 'MARKET', quantity: D(10), leverage: D(50) });
    const target = p0.mul('1.1').toDecimalPlaces(2).toFixed();

    const res = await on.inject({ method: 'POST', url: '/api/v1/panel/markets/test/price', headers: H, payload: { price: target } });
    expect(res.statusCode).toBe(200);
    // 测试用数据源没有均值回归，anchored = false；不是外部行情，不会回落
    expect(res.json()).toMatchObject({ code: 'TEST', after: target, anchored: false, revertsInSec: null });
    expect(h.core.markets.price(m.id)!.toFixed()).toBe(target);
    await flushMicrotasks();
    expect(await h.db.liquidation.count({ where: { userId: SHORTER } })).toBe(1);

    const list = (await on.inject({ method: 'GET', url: '/api/v1/panel/markets', headers: H })).json();
    expect(list.find((x: { code: string }) => x.code === 'TEST')).toMatchObject({ price: target, initialPrice: '100', anchor: '100' });

    const post = (code: string, price: string, headers = H) => on.inject({ method: 'POST', url: `/api/v1/panel/markets/${code}/price`, headers, payload: { price } });
    expect((await post('TEST', '0')).statusCode).toBe(400);
    expect((await post('NOPE', '10')).statusCode).toBe(404);
    expect((await post('TEST', '10', auth(on, IMPOSTOR))).statusCode).toBe(404);
  });

  it('keeps an anchor set from the panel when markets are re-seeded on restart', async () => {
    const m = h.core.markets.byCode('TEST')!;
    await h.db.marketEngineConfig.update({ where: { marketId: m.id }, data: { meanReversionTarget: '123' } });
    await seedMarkets(h.db, [TEST_MARKET]);
    const cfg = await h.db.marketEngineConfig.findUniqueOrThrow({ where: { marketId: m.id } });
    expect(cfg.meanReversionTarget?.toFixed()).toBe('123');
  });
});

describe('提前结束事件', () => {
  it('ends an active event immediately and restores the volatility', async () => {
    const H = auth(on, BOSS);
    // 先让前面测试留下的事件全部到期，否则波动倍数会和它们相乘
    h.setNow(new Date(Date.now() + 2 * 3600_000));
    await h.core.events.poll();
    // 再拨回现在：新事件的触发时间按真实时钟计算，超过 1 小时的"迟到"事件会被作废
    h.setNow(new Date(Date.now() + 60_000));
    const created = await on.inject({
      method: 'POST', url: '/api/v1/panel/events', headers: H,
      payload: { market: 'TEST', direction: 'UP', gapPct: '0', volMultiplier: '20', trend: '400', delaySec: 0, durationSec: 3600 },
    });
    const id = created.json().id as string;
    await h.core.events.poll();
    const m = h.core.markets.byCode('TEST')!;
    const during = await h.db.marketEngineConfig.findUniqueOrThrow({ where: { marketId: m.id } });
    expect(during.volMultiplier.toFixed()).toBe('20');

    expect((await on.inject({ method: 'DELETE', url: `/api/v1/panel/events/${id}`, headers: H })).statusCode).toBe(204);
    const ev = await h.db.scheduledEvent.findUniqueOrThrow({ where: { id } });
    expect(ev.status).toBe('COMPLETED');
    const after = await h.db.marketEngineConfig.findUniqueOrThrow({ where: { marketId: m.id } });
    expect([after.volMultiplier.toFixed(), after.driftOverride.toFixed()]).toEqual(['1', '0']);
    // 已结束的事件不能再结束一次
    expect((await on.inject({ method: 'DELETE', url: `/api/v1/panel/events/${id}`, headers: H })).statusCode).toBe(409);
  });
});

describe('市场历史', () => {
  const event = (marketId: string, status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED', triggeredAt: Date, headline: string) =>
    h.db.scheduledEvent.create({
      data: {
        marketId, status, triggerAt: triggeredAt, triggeredAt, headline, content: '', i18n: {},
        gapPercent: '0.1', driftAdjust: '0', volMultiplier: '1', durationSec: status === 'ACTIVE' ? 86_400 : 60, source: 'DASHBOARD',
      },
    });

  it('news only lists events triggered in the last 48 hours', async () => {
    const m = h.core.markets.byCode('TEST')!;
    await h.db.scheduledEvent.deleteMany({ where: { marketId: m.id } });
    await event(m.id, 'COMPLETED', new Date(Date.now() - 3 * 86_400_000), 'three days ago');
    await event(m.id, 'COMPLETED', new Date(Date.now() - 47 * 3_600_000), 'forty-seven hours ago');
    const rows = (await on.inject({ method: 'GET', url: '/api/v1/markets/TEST/events', headers: auth(on, PLAYER) })).json();
    expect(rows.map((r: { headline: string }) => r.headline)).toEqual(['forty-seven hours ago']);
  });

  it('clears candles and finished news, keeps running events, and tells clients', async () => {
    const H = auth(on, BOSS);
    const m = h.core.markets.byCode('TEST')!;
    await h.db.candle.createMany({
      data: [1, 2, 3].map((i) => ({ marketId: m.id, interval: 'M1' as const, openTime: new Date(Date.now() - i * 60_000), open: '1', high: '1', low: '1', close: '1', volume: '1' })),
    });
    await h.tick('101');
    expect(h.core.markets.engine(m.id)!.candles().length).toBeGreaterThan(0);
    const running = await event(m.id, 'ACTIVE', new Date(), 'still running');
    h.messages.length = 0;

    const res = await on.inject({ method: 'POST', url: '/api/v1/panel/markets/test/clear-history', headers: H, payload: { candles: true, news: true } });
    expect(res.statusCode).toBe(200);
    // 除了这里插入的 3 根，前面测试的 tick 也写过 K 线
    expect(res.json()).toMatchObject({ code: 'TEST', newsDeleted: 2 });
    expect(res.json().candlesDeleted).toBeGreaterThanOrEqual(3);
    expect(await h.db.candle.count({ where: { marketId: m.id } })).toBe(0);
    expect(h.core.markets.engine(m.id)!.candles()).toEqual([]);
    expect((await h.db.scheduledEvent.findMany({ where: { marketId: m.id } })).map((e) => e.id)).toEqual([running.id]);
    expect(h.messages.map((x) => x.msg)).toContainEqual({ ch: 'history:TEST', d: { market: 'TEST', candles: true, news: true } });

    // 下一个 tick 从现价重新开一根 K 线
    await h.tick('102');
    expect(h.core.markets.engine(m.id)!.candles().map((c) => c.open.toFixed())).toContain('102');

    expect((await on.inject({ method: 'POST', url: '/api/v1/panel/markets/TEST/clear-history', headers: H, payload: { candles: false, news: false } })).statusCode).toBe(400);
  });
});
