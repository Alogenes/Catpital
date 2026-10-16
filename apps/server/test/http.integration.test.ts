import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildServer } from '../src/http/server.js';
import { type Harness, createHarness } from './support/harness.js';

let h: Harness;
let app: Awaited<ReturnType<typeof buildServer>>;
let token: string;
const P = '/api/v1';

beforeAll(async () => {
  h = await createHarness();
  app = await buildServer(h.core, {
    API_BASE_PATH: '/api',
    WS_PATH: '/ws',
    JWT_SECRET: 'test-secret-123',
    DISCORD_CLIENT_ID: '',
    DISCORD_CLIENT_SECRET: '',
    DEV_LOGIN: '1',
    NODE_ENV: 'test',
    DANMAKU_COOLDOWN_MS: 1000,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const res = await app.inject({ method: 'POST', url: `${P}/auth/dev`, payload: { userId: '300000000000000001', username: 'dave' } });
  token = res.json().token;
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe('REST API', () => {
  it('rejects unauthenticated access', async () => {
    const res = await app.inject({ method: 'GET', url: `${P}/me` });
    expect(res.statusCode).toBe(401);
  });

  it('lists markets with decimal strings', async () => {
    const res = await app.inject({ method: 'GET', url: `${P}/markets` });
    const [m] = res.json();
    expect(m).toMatchObject({ code: 'TEST', price: '100', tickSize: '0.01', takerFeeRate: '0.001', open: true });
  });

  it('rejects JSON numbers for amounts', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${P}/orders`,
      headers: auth(),
      payload: { market: 'TEST', side: 'BUY', quantity: 1.5, leverage: '10' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('error.validation');
  });

  it('places an order idempotently and shows it in /me', async () => {
    const body = { market: 'TEST', side: 'BUY', quantity: '2', leverage: '20', clientOrderId: 'abc-1', takeProfitPrice: '120', stopLossPrice: '95' };
    const first = await app.inject({ method: 'POST', url: `${P}/orders`, headers: auth(), payload: body });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: `${P}/orders`, headers: auth(), payload: body });
    expect(again.json()).toMatchObject({ result: 'duplicate', order: { id: first.json().order.id } });

    const me = (await app.inject({ method: 'GET', url: `${P}/me`, headers: auth() })).json();
    expect(me.wallet).toMatchObject({ balance: '9989.8', locked: '0', netWorth: '9999.8' });
    expect(me.positions[0]).toMatchObject({ market: 'TEST', side: 'LONG', quantity: '2', margin: '10', takeProfitPrice: '120', stopLossPrice: '95' });
    expect(me.bankruptcyAvailable).toBe(false);
  });

  it('maps domain errors to i18n codes', async () => {
    const res = await app.inject({ method: 'PATCH', url: `${P}/positions/TEST/tpsl`, headers: auth(), payload: { takeProfitPrice: '90' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('error.tpWrongSide');
  });

  it('admin routes require admin', async () => {
    const res = await app.inject({ method: 'GET', url: `${P}/admin/events`, headers: auth() });
    expect(res.statusCode).toBe(403);
  });

  it('serves candles including the live in-memory candle', async () => {
    await h.tick('101');
    const res = await app.inject({ method: 'GET', url: `${P}/markets/TEST/candles?interval=M1` });
    const { candles } = res.json();
    expect(candles.at(-1)).toMatchObject({ close: '101' });
  });
});

describe('WebSocket gateway', () => {
  it('auths, subscribes, receives ticks, private events and danmaku', async () => {
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    const waitFor = async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`timeout; inbox=${JSON.stringify(inbox)}`);
    };

    ws.send(JSON.stringify({ op: 'auth', token }));
    await waitFor((m) => m.op === 'authed');
    ws.send(JSON.stringify({ op: 'sub', ch: ['tick:TEST', 'danmaku:TEST', 'broadcast', 'secret:nope'] }));
    await waitFor((m) => m.ch === 'tick:TEST' && m.d.price === '101'); // 订阅快照

    await h.tick('102.5');
    await waitFor((m) => m.ch === 'tick:TEST' && m.d.price === '102.5');

    await h.core.orders.closePosition('300000000000000001', 'TEST');
    await waitFor((m) => m.ch === 'user' && m.d.type === 'position' && m.d.position === null);

    ws.send(JSON.stringify({ op: 'danmaku', market: 'TEST', text: '  冲\u0000冲   冲！ ' }));
    const dm = await waitFor((m) => m.ch === 'danmaku:TEST');
    expect(dm.d).toMatchObject({ text: '冲冲 冲！', name: 'dave' });
    ws.send(JSON.stringify({ op: 'danmaku', market: 'TEST', text: 'spam' }));
    await waitFor((m) => m.op === 'error' && m.d.code === 'error.danmakuCooldown');
    ws.close();
  });
});
