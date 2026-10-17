import { D, periodReturn } from '@catpital/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret, sign } from '../src/economy/hmac.js';
import { buildServer } from '../src/http/server.js';
import { fromDb } from '../src/lib/dec.js';
import { type Harness, createHarness } from './support/harness.js';

const MASTER = 'a'.repeat(64);
const SECRET = 'test-client-secret';
const P = '/api/v1/economy';
const ALICE = '600000000000000001';
let h: Harness;
let app: Awaited<ReturnType<typeof buildServer>>;
let clientId: string;
let readOnlyId: string;

beforeAll(async () => {
  h = await createHarness();
  await h.db.$executeRawUnsafe('TRUNCATE "external_transfers", "api_nonces", "api_clients" CASCADE');
  clientId = (await h.db.apiClient.create({
    data: { name: 'signin-bot', scopes: ['transfer:deposit', 'transfer:withdraw'], secretEnc: encryptSecret(Buffer.from(MASTER, 'hex'), SECRET) },
  })).id;
  readOnlyId = (await h.db.apiClient.create({
    data: { name: 'deposit-only', scopes: ['transfer:deposit'], secretEnc: encryptSecret(Buffer.from(MASTER, 'hex'), SECRET) },
  })).id;
  app = await buildServer(h.core, {
    API_BASE_PATH: '/api', WS_PATH: '/ws', JWT_SECRET: 'test-secret-123', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '',
    DEV_LOGIN: '0', NODE_ENV: 'test', DANMAKU_COOLDOWN_MS: 1000, API_SECRET_KEY: MASTER, HMAC_MAX_SKEW_SECONDS: 300,
  });
  await h.user(ALICE, 'alice');
});
afterAll(async () => {
  await app.close();
  await h.close();
});

let nonceSeq = 0;
function call(direction: 'deposit' | 'withdraw', body: object, opts: { client?: string; secret?: string; ts?: number; nonce?: string; tamper?: boolean } = {}) {
  const payload = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? `nonce-${Date.now()}-${nonceSeq++}-abcdef`;
  const url = `${P}/${direction}`;
  const signature = sign(opts.secret ?? SECRET, ts, nonce, 'POST', url, payload);
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-catpital-client': opts.client ?? clientId,
      'x-catpital-timestamp': ts,
      'x-catpital-nonce': nonce,
      'x-catpital-signature': signature,
    },
    payload: opts.tamper ? payload.replace('"10"', '"10000"') : payload,
  });
}

describe('HMAC 鉴权', () => {
  it('rejects missing, wrong, stale, tampered, replayed and out-of-scope requests', async () => {
    const body = { userId: ALICE, amount: '10', externalRef: 'auth-1' };
    expect((await app.inject({ method: 'POST', url: `${P}/deposit`, payload: body })).json().error).toBe('error.missingSignature');
    expect((await call('deposit', body, { secret: 'wrong' })).json().error).toBe('error.badSignature');
    expect((await call('deposit', body, { ts: Math.floor(Date.now() / 1000) - 3600 })).json().error).toBe('error.staleTimestamp');
    expect((await call('deposit', body, { tamper: true })).json().error).toBe('error.badSignature');
    expect((await call('deposit', body, { client: 'nope' })).json().error).toBe('error.unknownClient');
    const ok = await call('deposit', body, { nonce: 'fixed-nonce-0000000001' });
    expect(ok.statusCode).toBe(200);
    expect((await call('deposit', { ...body, externalRef: 'auth-2' }, { nonce: 'fixed-nonce-0000000001' })).json().error).toBe('error.replayedNonce');
    const scoped = await call('withdraw', { ...body, externalRef: 'auth-3' }, { client: readOnlyId });
    expect([scoped.statusCode, scoped.json().error]).toEqual([403, 'error.forbidden']);
  });
});

describe('充值 / 提现', () => {
  it('deposits are idempotent per externalRef and flagged as external flows', async () => {
    const before = fromDb((await h.db.wallet.findUniqueOrThrow({ where: { userId: ALICE } })).balance);
    const first = (await call('deposit', { userId: ALICE, amount: '250.5', externalRef: 'dep-1' })).json();
    const again = (await call('deposit', { userId: ALICE, amount: '250.5', externalRef: 'dep-1' })).json();
    expect(first).toMatchObject({ direction: 'DEPOSIT', amount: '250.5', duplicate: false });
    expect(again).toMatchObject({ transferId: first.transferId, duplicate: true });
    expect(first.balanceAfter).toBe(before.plus('250.5').toFixed());
    const entry = await h.db.ledgerEntry.findFirstOrThrow({ where: { idempotencyKey: `ext:${clientId}:dep-1` } });
    expect([entry.type, entry.isExternal]).toEqual(['EXTERNAL_DEPOSIT', true]);
  });

  it('auto-creates a player who has never logged in', async () => {
    const r = (await call('deposit', { userId: '600000000000000099', amount: '5', externalRef: 'dep-new' })).json();
    expect(r.balanceAfter).toBe('10005'); // 初始资金 10000 + 5
    const u = await h.db.user.findUniqueOrThrow({ where: { id: '600000000000000099' } });
    expect(u.username).toBe('player-0099');
  });

  it('withdrawals only touch available balance, never margin, never below zero', async () => {
    // 开一笔 10x 仓位：保证金 100 + 手续费 1 被划出可用余额
    await h.core.orders.placeOrder(ALICE, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(10), leverage: D(10) });
    const available = fromDb((await h.db.wallet.findUniqueOrThrow({ where: { userId: ALICE } })).balance);
    const tooMuch = await call('withdraw', { userId: ALICE, amount: available.plus('0.01').toFixed(), externalRef: 'wd-1' });
    expect([tooMuch.statusCode, tooMuch.json().error]).toEqual([409, 'error.insufficientFunds']);
    const ok = (await call('withdraw', { userId: ALICE, amount: available.toFixed(), externalRef: 'wd-2' })).json();
    expect(ok.balanceAfter).toBe('0');
    expect(await h.position(ALICE)).not.toBeNull(); // 持仓与保证金不受影响
  });

  it('rejects reusing an externalRef for the opposite direction', async () => {
    const r = await call('withdraw', { userId: ALICE, amount: '1', externalRef: 'dep-1' });
    expect([r.statusCode, r.json().error]).toEqual([409, 'error.externalRefConflict']);
  });

  it('rejects float amounts and unknown users on withdraw', async () => {
    expect((await call('deposit', { userId: ALICE, amount: 1.5, externalRef: 'x1' })).json().error).toBe('error.validation');
    expect((await call('withdraw', { userId: '600000000000000777', amount: '1', externalRef: 'x2' })).json().error).toBe('error.userNotFound');
  });

  it('a deposit mid-period does not count as profit on the return board', () => {
    // 期初 10,000，中途充值 10,000 后净值 20,000 → 收益率 0%，而不是 +100%
    const r = periodReturn({
      startNetWorth: D(10000),
      endNetWorth: D(20000),
      periodStart: new Date('2026-10-16T00:00:00Z'),
      periodEnd: new Date('2026-10-17T00:00:00Z'),
      flows: [{ amount: D(10000), at: new Date('2026-10-16T12:00:00Z') }],
      minCapital: D(1000),
    });
    expect(r.returnPct?.toFixed()).toBe('0');
  });
});
