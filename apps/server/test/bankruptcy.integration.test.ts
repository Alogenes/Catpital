import { D } from '@catpital/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BANKRUPTCY_COOLDOWN_MS } from '../src/bankruptcy/bankruptcyService.js';
import { buildServer, type HttpEnv } from '../src/http/server.js';
import { getActiveLife } from '../src/trading/lifeStats.js';
import { TradeError } from '../src/trading/types.js';
import { lockWallet, postLedger } from '../src/trading/wallet.js';
import { type Harness, createHarness } from './support/harness.js';

const P = '700000000000000201';
const BASE: HttpEnv = {
  API_BASE_PATH: '/api', WS_PATH: '/ws', JWT_SECRET: 'test-secret-123', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '',
  DEV_LOGIN: '0', NODE_ENV: 'test', DANMAKU_COOLDOWN_MS: 1000,
};
let h: Harness;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  h = await createHarness();
  app = await buildServer(h.core, BASE);
  await h.user(P, 'whale'); // 初始资金 10000
});
afterAll(async () => {
  await app.close();
  await h.close();
});

/** 模拟一笔兑换充值（与 SkylbotExchange 记的流水一致） */
async function topUp(amount: number) {
  await h.db.$transaction(async (tx) => {
    const w = await lockWallet(tx, P);
    const life = await getActiveLife(tx, P);
    await postLedger(tx, w, life.id, [{ type: 'EXTERNAL_DEPOSIT', amount: D(amount), memo: 'skylbot:in' }], h.clock());
  });
}

/** 开 100 倍多单，价格腰斩 → 斩杀并穿仓，玩家资不抵债 */
async function blowUp(quantity: number, from: string, to: string, holdMs: number) {
  await h.tick(from);
  const r = await h.core.orders.placeOrder(P, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(quantity), leverage: D(100) });
  expect(r.kind).toBe('filled');
  h.advance(holdMs);
  await h.tick(to);
  expect(await h.position(P)).toBeNull();
}

describe('死后成就', () => {
  it('collects the extra life data and awards the new titles', async () => {
    await topUp(50_000);
    // 充值 2 分钟后梭哈 100 倍，死扛 11 分钟直到穿仓
    h.advance(2 * 60_000);
    await blowUp(9000, '100', '50', 11 * 60_000);

    const resume = await h.core.bankruptcy.declare(P);
    // 优先级最高的三个：极速升天客、钻石手骨折、氪金战神（穿仓之王等排在后面被截掉）
    expect(resume.titles).toEqual(['title.rocketLaunch', 'title.diamondHandsBroken', 'title.rechargeWhale']);
    expect(resume.stats).toMatchObject({
      peakOrders24h: 1,
      maxLiquidatedLeverage: '100',
      totalTopUp: '50000',
      stubbornDeficits: 1,
      revengeTrades: 0,
      positionCount: 1,
      stopLossCount: 0,
      distinctMarkets: 1,
    });
    // 最后一次充值到破产隔了 13 分钟以上，不是"光速打工仔"
    expect((resume.stats as { secondsSinceTopUp: number }).secondsSinceTopUp).toBeGreaterThanOrEqual(13 * 60);
  });
});

describe('每天只能破产一次', () => {
  it('blocks a second bankruptcy within 24 hours and points to the exchange instead', async () => {
    const until = await h.core.bankruptcy.cooldownUntil(P);
    expect(until!.getTime() - h.clock().getTime()).toBe(BANKRUPTCY_COOLDOWN_MS);

    // 救济金 5000 又亏光
    await blowUp(2000, '50', '20', 60_000);
    expect(await h.core.bankruptcy.eligibility(P)).toBe(true);

    const err = await h.core.bankruptcy.declare(P).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TradeError);
    expect((err as TradeError).code).toBe('error.bankruptcyCooldown');

    const token = app.jwt.sign({ sub: P });
    const http = await app.inject({ method: 'POST', url: '/api/v1/bankruptcy', headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect([http.statusCode, http.json().error]).toEqual([429, 'error.bankruptcyCooldown']);
    const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } })).json();
    expect(me).toMatchObject({ bankruptcyAvailable: true, bankruptcyCooldownUntil: until!.getTime() });
  });

  it('allows the next bankruptcy once 24 hours have passed', async () => {
    h.setNow(new Date((await h.core.bankruptcy.cooldownUntil(P))!.getTime()));
    const resume = await h.core.bankruptcy.declare(P);
    expect(resume.generation).toBe(2);
    expect((await h.db.user.findUniqueOrThrow({ where: { id: P } })).generation).toBe(3);
  });
});
