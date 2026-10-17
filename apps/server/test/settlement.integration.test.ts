import { D } from '@catpital/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromDb } from '../src/lib/dec.js';
import { type Harness, createHarness } from './support/harness.js';

const TRADER = '700000000000000001'; // 正常赚钱
const HODLER = '700000000000000002'; // 什么都不做
const WHALE = '700000000000000003'; // 中途外部充值 100 万（想刷榜）
const BROKE = '700000000000000004'; // 爆仓破产领救济金
let h: Harness;
const s = (v: { toString(): string }) => fromDb(v.toString()).toFixed();

beforeAll(async () => {
  h = await createHarness(); // 时钟：2026-10-16T00:00:00Z
  for (const [id, name] of [[TRADER, 'trader'], [HODLER, 'hodler'], [WHALE, 'whale'], [BROKE, 'broke']]) await h.user(id!, name!);
  h.advance(1000);
  await h.core.leaderboard.ensureBaselines();

  // 交易员：10x 多 10 股 100 → 110 平仓，赚 97.9
  await h.core.orders.placeOrder(TRADER, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(10), leverage: D(10) });
  await h.tick('110');
  await h.core.orders.closePosition(TRADER, 'TEST');
  // 巨鲸：外部充值 1,000,000（EXTERNAL_DEPOSIT）
  const client = await h.db.apiClient.create({ data: { name: 'bank', scopes: ['transfer:deposit'], secretEnc: 'x' } });
  await h.core.bank.deposit({ clientId: client.id, userId: WHALE, amount: D(1_000_000), externalRef: 'whale-1' });
  // 破产者：100x 爆仓穿仓 → 破产领 5000
  await h.core.orders.placeOrder(BROKE, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(900), leverage: D(100) });
  await h.tick('70');
  await h.core.bankruptcy.declare(BROKE);

  h.setNow(new Date('2026-10-17T00:00:05Z')); // 日榜结算时刻
});
afterAll(async () => {
  await h.close();
});

describe('日榜结算', () => {
  it('ranks by anti-gaming return %, pays rewards and grants badges to both champions', async () => {
    const r = await h.core.settlement.settle('DAILY');
    expect(r).toMatchObject({ period: 'DAILY', periodKey: '2026-10-16', skipped: false });

    const returnBoard = await h.db.leaderboardSnapshot.findMany({ where: { periodKey: '2026-10-16', board: 'RETURN_PCT' }, orderBy: { rank: 'asc' } });
    // 交易员 +0.979% 第一；巨鲸充值 100 万但收益率 0%（被当作外部资金流剔除）；破产者为负
    expect(returnBoard.map((x) => x.userId)).toEqual([TRADER, HODLER, WHALE, BROKE]);
    expect(s(returnBoard[0]!.value)).toBe('0.979');
    expect(s(returnBoard[2]!.value)).toBe('0');

    const worthBoard = await h.db.leaderboardSnapshot.findMany({ where: { periodKey: '2026-10-16', board: 'NET_WORTH' }, orderBy: { rank: 'asc' } });
    expect(worthBoard[0]!.userId).toBe(WHALE); // 富豪榜就是比谁钱多，充值也算

    expect(r.champions.map((c) => [c.board, c.userId, c.reward])).toEqual([
      ['RETURN_PCT', TRADER, '1000'],
      ['NET_WORTH', WHALE, '1000'],
    ]);
    expect((await h.wallet(TRADER)).balance).toBe('11097.9');
    const reward = await h.db.ledgerEntry.findFirstOrThrow({ where: { userId: TRADER, type: 'LEADERBOARD_REWARD' } });
    expect(reward.isExternal).toBe(true); // 奖金不算交易收益，不会让下一期收益率虚高

    const trader = await h.db.user.findUniqueOrThrow({ where: { id: TRADER } });
    expect(trader.badges).toEqual([expect.objectContaining({ key: 'badge.DAILY.RETURN_PCT', periodKey: '2026-10-16' })]);

    const stat = await h.db.leaderboardPeriodStat.findFirstOrThrow({ where: { userId: TRADER, period: 'DAILY', periodKey: '2026-10-16' } });
    expect([s(stat.returnPct!), stat.eligible, stat.finalizedAt !== null]).toEqual(['0.979', true, true]);

    const champs = h.botMessages.filter((m) => m.broadcast.kind === 'CHAMPION');
    expect(champs.map((m) => m.broadcast.vars.board)).toEqual(['RETURN_PCT', 'NET_WORTH']);
  });

  it('is idempotent and opens the next period with fresh baselines', async () => {
    const again = await h.core.settlement.settle('DAILY');
    expect(again.skipped).toBe(true);
    expect(await h.db.ledgerEntry.count({ where: { type: 'LEADERBOARD_REWARD' } })).toBe(2);
    // 新一期的期初在发奖前采样（10097.9），奖金作为新一期的外部资金流 → 不会算进下一期收益率
    const next = await h.db.leaderboardPeriodStat.findFirstOrThrow({ where: { userId: TRADER, period: 'DAILY', periodKey: '2026-10-17' } });
    expect(s(next.startNetWorth)).toBe('10097.9');
    h.advance(60_000);
    h.core.leaderboard.invalidate();
    const live = await h.core.leaderboard.board('DAILY', 'RETURN_PCT', TRADER);
    expect(live.entries.find((e) => e.userId === TRADER)?.value).toBe('0');
  });

  it('weekly / monthly windows are not due yet', () => {
    expect(h.core.settlement.previousWindow('WEEKLY').key).toBe('2026-W41');
    expect(h.core.settlement.previousWindow('MONTHLY').key).toBe('2026-09');
  });
});
