import { type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SkylbotClient } from '../src/economy/skylbotClient.js';
import { SkylbotExchange } from '../src/economy/skylbotExchange.js';
import { buildServer, type HttpEnv } from '../src/http/server.js';
import { type Harness, createHarness } from './support/harness.js';

const USER = '700000000000000101';
const BOSS = '626797305567248398';
const BASE: HttpEnv = {
  API_BASE_PATH: '/api', WS_PATH: '/ws', JWT_SECRET: 'test-secret-123', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '',
  DEV_LOGIN: '0', NODE_ENV: 'test', DANMAKU_COOLDOWN_MS: 1000, ADMIN_PANEL_USERS: `${BOSS}:boss`,
};

/**
 * 与 Skylbot main.py 行为一致的假服务：没有鉴权、没有幂等号，每个请求都会真的动钱。
 * fault：
 *   drop      照常改余额，但不回包（超时）
 *   down      不处理，直接 500
 *   dropBlind 照常改余额、不回包，之后的余额查询也失败（结果无法确认）
 *   dropRace  照常改余额、不回包，同时玩家在 Skylbot 里又花了 7 块（余额对不上）
 */
class FakeSkylbot {
  balances = new Map<string, bigint>();
  moves = 0;
  fault: null | 'drop' | 'down' | 'dropBlind' | 'dropRace' = null;
  blindBalance = false;
  server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => this.handle(req.method!, req.url!, raw, res));
  });

  private handle(method: string, path: string, raw: string, res: ServerResponse) {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const bal = path.match(/^\/api\/balance\/(\d+)$/);
    if (method === 'GET' && bal) {
      if (this.blindBalance) return send(500, { error: 'Error interno del servidor' });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(String(this.balances.get(bal[1]!) ?? 0n));
    }
    const move = path.match(/^\/api\/balance\/(withdraw|deposit)$/);
    if (method !== 'POST' || !move) return send(404, { error: 'not found' });
    if (this.fault === 'down') return send(500, { error: 'Error interno del servidor' });
    // 用正则取 user_id，确认 Catpital 发来的是完整精度的整数（不是被 JS 截断的浮点数）
    const id = raw.match(/"user_id":\s*(\d+)/)?.[1];
    const amount = JSON.parse(raw).amount as number;
    if (!id || amount == null) return send(400, { error: 'Faltan datos (user_id o amount)' });
    if (amount <= 0) return send(400, { error: 'La cantidad debe ser mayor a 0' });
    let balance = this.balances.get(id) ?? 0n;
    if (move[1] === 'withdraw') {
      if (balance < BigInt(amount)) return send(400, { error: 'Saldo insuficiente' });
      balance -= BigInt(amount);
    } else balance += BigInt(amount);
    this.balances.set(id, balance);
    this.moves++;
    if (this.fault === 'dropRace') this.balances.set(id, balance - 7n);
    if (this.fault === 'dropBlind') this.blindBalance = true;
    if (this.fault) return res.destroy();
    return send(200, { nuevo_balance: Number(balance), status: 'ok' });
  }
}

let h: Harness;
let fake: FakeSkylbot;
let url: string;
let app: Awaited<ReturnType<typeof buildServer>>;
const silent = { info: () => {}, warn: () => {}, error: (o: unknown) => console.error(o) };
const auth = (sub = USER) => ({ authorization: `Bearer ${app.jwt.sign({ sub })}` });
const meuw = async () => Number((await h.wallet(USER)).balance);
const bolivares = () => Number(fake.balances.get(USER) ?? 0n);
const exchange = (direction: 'in' | 'out', amount: unknown) =>
  app.inject({ method: 'POST', url: `/api/v1/exchange/${direction}`, headers: auth(), payload: { amount } });
const lastRecord = () => h.db.currencyExchange.findFirstOrThrow({ where: { userId: USER }, orderBy: { createdAt: 'desc' } });

beforeAll(async () => {
  h = await createHarness();
  fake = new FakeSkylbot();
  await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  app = await buildServer(h.core, BASE);
  await h.user(USER, 'trader'); // 初始资金 10000
  await h.user(BOSS, 'boss');
});
afterAll(async () => {
  await app.close();
  await new Promise((r) => fake.server.close(r));
  await h.close();
});
beforeEach(() => {
  fake.fault = null;
  fake.blindBalance = false;
  h.core.exchange = new SkylbotExchange(h.db, h.core.notifier, new SkylbotClient({ url, timeoutMs: 1000 }), silent, h.clock);
});

describe('兑换关闭时', () => {
  it('reports disabled and refuses to move money', async () => {
    h.core.exchange = new SkylbotExchange(h.db, h.core.notifier, null, silent, h.clock);
    const state = (await app.inject({ method: 'GET', url: '/api/v1/exchange', headers: auth() })).json();
    expect(state).toMatchObject({ enabled: false, bolivares: null });
    const r = await exchange('in', 100);
    expect([r.statusCode, r.json().error]).toEqual([503, 'error.exchangeDisabled']);
  });
});

describe('Bolívares → Meuw Coin', () => {
  it('moves money 1:1 on both sides, with the full-precision Discord id', async () => {
    fake.balances.set(USER, 5000n);
    const before = await meuw();
    const r = await exchange('in', '1200');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ direction: 'IN', status: 'COMPLETED', amount: '1200', bolivares: 3800 });
    expect(await meuw()).toBe(before + 1200);
    expect(bolivares()).toBe(3800);
    const entry = await h.db.ledgerEntry.findFirstOrThrow({ where: { userId: USER, memo: 'skylbot:in' } });
    expect([entry.type, entry.isExternal]).toEqual(['EXTERNAL_DEPOSIT', true]);
  });

  it('refuses up front when the player does not have enough bolívares', async () => {
    fake.balances.set(USER, 50n);
    const [before, moves] = [await meuw(), fake.moves];
    const r = await exchange('in', 100);
    expect([r.statusCode, r.json().error]).toEqual([409, 'error.exchangeInsufficient']);
    expect([await meuw(), bolivares(), fake.moves]).toEqual([before, 50, moves]);
  });

  it('confirms a lost response by re-reading the balance, without sending the request again', async () => {
    fake.balances.set(USER, 1000n);
    const [before, moves] = [await meuw(), fake.moves];
    fake.fault = 'drop';
    const r = await exchange('in', 400);
    expect(r.json()).toMatchObject({ status: 'COMPLETED', bolivares: 600 });
    expect(await meuw()).toBe(before + 400);
    expect(fake.moves - moves).toBe(1); // 绝不重发
  });

  it('fails cleanly when Skylbot errors before touching the balance', async () => {
    fake.balances.set(USER, 1000n);
    const before = await meuw();
    fake.fault = 'down';
    const r = await exchange('in', 400);
    expect([r.statusCode, r.json().error]).toEqual([503, 'error.exchangeUnavailable']);
    expect([await meuw(), bolivares()]).toEqual([before, 1000]);
    expect((await lastRecord()).status).toBe('FAILED');
  });

  it('parks an unverifiable top-up for the admin, who can then credit it', async () => {
    fake.balances.set(USER, 1000n);
    const before = await meuw();
    fake.fault = 'dropBlind';
    const r = await exchange('in', 300);
    expect([r.statusCode, r.json().status]).toEqual([202, 'PENDING']);
    expect(await meuw()).toBe(before); // 不确定时先不入账
    expect(bolivares()).toBe(700);

    const boss = auth(BOSS);
    const pending = (await app.inject({ method: 'GET', url: '/api/v1/panel/exchanges/pending', headers: boss })).json();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ userId: USER, direction: 'IN', amount: '300', name: 'trader' });
    const resolved = await app.inject({ method: 'POST', url: `/api/v1/panel/exchanges/${pending[0].id}/resolve`, headers: boss, payload: { applied: true } });
    expect(resolved.json()).toEqual({ id: pending[0].id, status: 'COMPLETED' });
    expect(await meuw()).toBe(before + 300);
    // 不能处理两次
    const again = await app.inject({ method: 'POST', url: `/api/v1/panel/exchanges/${pending[0].id}/resolve`, headers: boss, payload: { applied: true } });
    expect(again.statusCode).toBe(409);
    expect(await meuw()).toBe(before + 300);
    // 普通玩家看不到这个接口
    expect((await app.inject({ method: 'GET', url: '/api/v1/panel/exchanges/pending', headers: auth() })).statusCode).toBe(404);
  });
});

describe('Meuw Coin → Bolívares', () => {
  it('moves money 1:1 and only from the available balance', async () => {
    fake.balances.set(USER, 0n);
    const before = await meuw();
    const r = await exchange('out', 500);
    expect(r.json()).toMatchObject({ direction: 'OUT', status: 'COMPLETED', bolivares: 500 });
    expect([await meuw(), bolivares()]).toEqual([before - 500, 500]);

    const tooMuch = await exchange('out', before * 10);
    expect([tooMuch.statusCode, tooMuch.json().error]).toEqual([409, 'error.insufficientFunds']);
    expect(bolivares()).toBe(500);
  });

  it('refunds the coins when Skylbot fails before paying', async () => {
    fake.balances.set(USER, 0n);
    const before = await meuw();
    fake.fault = 'down';
    const r = await exchange('out', 250);
    expect([r.statusCode, r.json().error]).toEqual([503, 'error.exchangeUnavailable']);
    expect([await meuw(), bolivares()]).toEqual([before, 0]);
    const inv = await h.assertLedgerInvariant(USER);
    expect(inv.ledgerSum).toBe(inv.balance);
  });

  it('parks a cash-out whose balance no longer adds up, and the admin can refund it', async () => {
    fake.balances.set(USER, 100n);
    const before = await meuw();
    fake.fault = 'dropRace';
    const r = await exchange('out', 200);
    expect([r.statusCode, r.json().status]).toEqual([202, 'PENDING']);
    expect(await meuw()).toBe(before - 200); // 已扣，等核对

    const boss = auth(BOSS);
    const [pending] = (await app.inject({ method: 'GET', url: '/api/v1/panel/exchanges/pending', headers: boss })).json();
    await app.inject({ method: 'POST', url: `/api/v1/panel/exchanges/${pending.id}/resolve`, headers: boss, payload: { applied: false } });
    expect(await meuw()).toBe(before);
    expect((await h.db.currencyExchange.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('FAILED');
  });
});

describe('Skylbot 连不上', () => {
  it('refuses before moving anything', async () => {
    h.core.exchange = new SkylbotExchange(h.db, h.core.notifier, new SkylbotClient({ url: 'http://127.0.0.1:9', timeoutMs: 500 }), silent, h.clock);
    const before = await meuw();
    for (const d of ['in', 'out'] as const) {
      const r = await exchange(d, 10);
      expect([r.statusCode, r.json().error]).toEqual([503, 'error.exchangeUnavailable']);
    }
    expect(await meuw()).toBe(before);
    const state = (await app.inject({ method: 'GET', url: '/api/v1/exchange', headers: auth() })).json();
    expect(state).toMatchObject({ enabled: true, bolivares: null });
  });
});

describe('数据库没迁移', () => {
  it('reports exchangeNotMigrated instead of an internal error, for a stale client or a missing table', async () => {
    const missingTable = new Prisma.PrismaClientKnownRequestError('table does not exist', { code: 'P2021', clientVersion: 'test' });
    const tableless = {
      stale: undefined,
      unmigrated: { findFirst: () => Promise.reject(missingTable) },
    };
    for (const table of Object.values(tableless)) {
      const db = new Proxy(h.db, { get: (t, k) => (k === 'currencyExchange' ? table : Reflect.get(t, k)) });
      h.core.exchange = new SkylbotExchange(db, h.core.notifier, new SkylbotClient({ url, timeoutMs: 1000 }), silent, h.clock);
      const before = await meuw();
      const state = await app.inject({ method: 'GET', url: '/api/v1/exchange', headers: auth() });
      expect([state.statusCode, state.json().error]).toEqual([503, 'error.exchangeNotMigrated']);
      for (const d of ['in', 'out'] as const) {
        const r = await exchange(d, 10);
        expect([r.statusCode, r.json().error]).toEqual([503, 'error.exchangeNotMigrated']);
      }
      expect(await meuw()).toBe(before);
    }
  });
});

describe('参数校验', () => {
  it('only accepts whole positive amounts', async () => {
    for (const bad of ['1.5', 0, -3, 'abc', 1.5, 20_000_000]) expect((await exchange('in', bad)).statusCode).toBe(400);
  });
});
