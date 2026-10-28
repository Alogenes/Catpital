import { D, type Decimal } from '@catpital/shared';
import { Prisma, type CurrencyExchange, type PrismaClient } from '@prisma/client';
import type { Notifier } from '../broadcast/notifier.js';
import { fromDb, toDb, wire } from '../lib/dec.js';
import { KeyedQueue } from '../lib/keyedQueue.js';
import { getActiveLife } from '../trading/lifeStats.js';
import { TradeError } from '../trading/types.js';
import { lockWallet, postLedger } from '../trading/wallet.js';
import { type SkylbotClient, SkylbotError } from './skylbotClient.js';

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/** 单笔兑换上限 */
export const EXCHANGE_MAX_AMOUNT = 10_000_000;

export interface ExchangeResult {
  id: string;
  direction: 'IN' | 'OUT';
  amount: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  /** 兑换后的 Meuw Coin 可用余额 */
  balance: string;
  /** 兑换后的 bolívares 余额（结果待核对时为 null） */
  bolivares: number | null;
}

/**
 * Skylbot 的 bolívares ⇄ Catpital 的 Meuw Coin，1:1，由 Catpital 发起，调用 Skylbot 已有的
 * /api/balance/withdraw 与 /api/balance/deposit。
 *
 *   IN（充值）：先让 Skylbot 扣 bolívares，成功后再给 Catpital 记 EXTERNAL_DEPOSIT
 *   OUT（兑回）：先在 Catpital 扣 Meuw Coin（EXTERNAL_WITHDRAW），再让 Skylbot 加 bolívares；
 *                Skylbot 明确拒绝时把 Meuw Coin 退回
 *
 * Skylbot 的接口没有幂等号，重发一次就会再动一次钱，所以绝不自动重试。
 * 超时 / 5xx 时回读一次 Skylbot 余额：正好变动了这笔金额 → 视为成功；完全没变 → 视为失败；
 * 其它情况（玩家同时在 Skylbot 里花钱、或者读不到余额）→ 保持 PENDING，由管理员在面板里核对处理。
 * 两边的流水都标记为外部资金流，不影响收益率榜。
 */
export class SkylbotExchange {
  private readonly perUser = new KeyedQueue();

  constructor(
    private readonly db: PrismaClient,
    private readonly notifier: Notifier,
    private readonly client: SkylbotClient | null,
    private readonly log: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get enabled() {
    return this.client !== null;
  }

  /** 兑换表确认可用后就不再探测 */
  private tableReady = false;

  /**
   * 兑换表可用性：迁移没跑（P2021 表不存在）或 Prisma Client 没重新生成（没有 currencyExchange 模型）时
   * 抛 error.exchangeNotMigrated，而不是笼统的 error.internal。只缓存成功，补跑迁移后无需重启即可恢复。
   */
  private async ensureTable() {
    if (this.tableReady) return;
    if (!(this.db as Partial<PrismaClient>).currencyExchange) throw new TradeError('error.exchangeNotMigrated', 503);
    try {
      await this.db.currencyExchange.findFirst({ select: { id: true } });
      this.tableReady = true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2021' || err.code === 'P2022')) {
        throw new TradeError('error.exchangeNotMigrated', 503);
      }
      throw err;
    }
  }

  /** 启动自检：配置了 Skylbot 但兑换表不可用时打一条明确的错误日志（不阻止启动） */
  async selfCheck() {
    if (!this.enabled) return;
    await this.ensureTable().catch((err: unknown) => {
      if (err instanceof TradeError) {
        this.log.error(
          {},
          'currency exchange table missing: restart with `pnpm dev:server` (it regenerates the Prisma Client and migrates on start), or against your own database run `pnpm --filter @catpital/server prisma:generate` and `pnpm --filter @catpital/server prisma:migrate:deploy`, then restart',
        );
      } else {
        this.log.warn({ err: (err as Error).message }, 'currency exchange self-check failed');
      }
    });
  }

  private remote() {
    if (!this.client) throw new TradeError('error.exchangeDisabled', 503);
    return this.client;
  }

  /** 玩家在 Skylbot 的 bolívares；Skylbot 连不上时返回 null */
  async bolivares(userId: string): Promise<number | null> {
    return this.remote()
      .balance(userId)
      .catch((err) => {
        this.log.warn({ err: (err as Error).message }, 'skylbot balance unavailable');
        return null;
      });
  }

  async history(userId: string, limit = 10) {
    await this.ensureTable();
    const rows = await this.db.currencyExchange.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      amount: wire(fromDb(r.amount)),
      status: r.status,
      error: r.error,
      createdAt: r.createdAt.getTime(),
    }));
  }

  /** Bolívares → Meuw Coin */
  exchangeIn(userId: string, amount: number): Promise<ExchangeResult> {
    const client = this.remote();
    return this.perUser.run(userId, async () => {
      await this.ensureTable();
      const before = await this.balanceOrThrow(client, userId);
      if (before < amount) throw new TradeError('error.exchangeInsufficient', 409);
      const rec = await this.db.currencyExchange.create({ data: { userId, direction: 'IN', amount: toDb(D(amount)), createdAt: this.clock() } });
      let after: number;
      try {
        after = await client.withdraw(userId, amount);
      } catch (err) {
        const outcome = await this.verify(client, rec, err, before, before - amount);
        if (outcome === 'unknown') return this.pending(rec, err);
        if (outcome === 'not_applied') return this.fail(rec, err);
        after = before - amount;
      }
      const balance = await this.credit(rec, `skylbot:${rec.id}:in`, 'skylbot:in');
      await this.finish(rec.id, 'COMPLETED', { remoteBalance: after });
      return this.result(rec, 'COMPLETED', balance, after);
    });
  }

  /** Meuw Coin → Bolívares */
  exchangeOut(userId: string, amount: number): Promise<ExchangeResult> {
    const client = this.remote();
    return this.perUser.run(userId, async () => {
      await this.ensureTable();
      // 先确认 Skylbot 在线，免得扣了 Meuw Coin 才发现送不出去
      const before = await this.balanceOrThrow(client, userId);
      const now = this.clock();
      // 只能动用可用余额，挂单冻结和逐仓保证金不可兑
      const { rec, wallet } = await this.db.$transaction(async (tx) => {
        const w = await lockWallet(tx, userId);
        if (w.balance.lt(amount)) throw new TradeError('error.insufficientFunds', 409);
        const created = await tx.currencyExchange.create({ data: { userId, direction: 'OUT', amount: toDb(D(amount)), createdAt: now } });
        const life = await getActiveLife(tx, userId);
        const after = await postLedger(
          tx,
          w,
          life.id,
          [{ type: 'EXTERNAL_WITHDRAW', amount: D(amount).neg(), memo: 'skylbot:out', idempotencyKey: `skylbot:${created.id}:out` }],
          now,
        );
        return { rec: created, wallet: after };
      });
      this.notifier.wallet(userId, wallet);
      let after: number;
      try {
        after = await client.deposit(userId, amount);
      } catch (err) {
        const outcome = await this.verify(client, rec, err, before, before + amount);
        if (outcome === 'unknown') return this.pending(rec, err);
        if (outcome === 'not_applied') {
          await this.credit(rec, `skylbot:${rec.id}:refund`, 'skylbot:refund');
          return this.fail(rec, err);
        }
        after = before + amount;
      }
      await this.finish(rec.id, 'COMPLETED', { remoteBalance: after });
      return this.result(rec, 'COMPLETED', await this.walletBalance(userId), after);
    });
  }

  // ---------------------------------------------------------------------------
  // 管理员核对（面板）：结果不确定的兑换
  // ---------------------------------------------------------------------------

  async listPending() {
    await this.ensureTable();
    const rows = await this.db.currencyExchange.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { username: true, globalName: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.user.globalName ?? r.user.username,
      direction: r.direction,
      amount: wire(fromDb(r.amount)),
      error: r.error,
      createdAt: r.createdAt.getTime(),
    }));
  }

  /**
   * applied = Skylbot 那边的钱确实已经动了：
   *   IN  → 补发 Meuw Coin；OUT → 直接完成
   * applied = false（钱没动）：
   *   IN  → 标记失败；OUT → 退回 Meuw Coin
   */
  async resolve(id: string, applied: boolean) {
    const rec = await this.db.currencyExchange.findUnique({ where: { id } });
    if (!rec || rec.status !== 'PENDING') throw new TradeError('error.exchangeNotPending', 409);
    return this.perUser.run(rec.userId, async () => {
      if (applied) {
        if (rec.direction === 'IN') await this.credit(rec, `skylbot:${rec.id}:in`, 'skylbot:in');
        await this.finish(rec.id, 'COMPLETED', { error: 'resolved by admin' });
        return { id, status: 'COMPLETED' as const };
      }
      if (rec.direction === 'OUT') await this.credit(rec, `skylbot:${rec.id}:refund`, 'skylbot:refund');
      await this.finish(rec.id, 'FAILED', { error: 'resolved by admin: not applied' });
      return { id, status: 'FAILED' as const };
    });
  }

  // ---------------------------------------------------------------------------

  private async balanceOrThrow(client: SkylbotClient, userId: string) {
    try {
      return await client.balance(userId);
    } catch {
      throw new TradeError('error.exchangeUnavailable', 503);
    }
  }

  /** Skylbot 调用失败后判断钱到底动没动 */
  private async verify(client: SkylbotClient, rec: CurrencyExchange, err: unknown, before: number, expected: number) {
    if (!(err instanceof SkylbotError)) throw err;
    // 明确的 4xx：Skylbot 在改余额之前就拒绝了
    if (err.kind !== 'unavailable') return 'not_applied' as const;
    const now = await client.balance(rec.userId).catch(() => null);
    if (now === expected) return 'applied' as const;
    if (now === before) return 'not_applied' as const;
    return 'unknown' as const;
  }

  private async pending(rec: CurrencyExchange, err: unknown): Promise<ExchangeResult> {
    const reason = err instanceof Error ? err.message : String(err);
    await this.db.currencyExchange.update({ where: { id: rec.id }, data: { error: `needs review: ${reason}` } });
    this.log.warn({ exchangeId: rec.id, direction: rec.direction, reason }, 'skylbot exchange outcome unknown, needs admin review');
    return this.result(rec, 'PENDING', await this.walletBalance(rec.userId), null);
  }

  private async fail(rec: CurrencyExchange, err: unknown): Promise<never> {
    const insufficient = err instanceof SkylbotError && err.kind === 'insufficient';
    const unavailable = err instanceof SkylbotError && err.kind === 'unavailable';
    await this.finish(rec.id, 'FAILED', { error: err instanceof Error ? err.message : String(err) });
    this.log.warn({ exchangeId: rec.id, direction: rec.direction, reason: (err as Error).message }, 'skylbot exchange failed');
    if (insufficient) throw new TradeError('error.exchangeInsufficient', 409);
    if (unavailable) throw new TradeError('error.exchangeUnavailable', 503);
    throw new TradeError('error.exchangeRejected', 502);
  }

  /** 给 Catpital 钱包记一笔外部入账；幂等键保证同一笔不会入账两次 */
  private async credit(rec: CurrencyExchange, idempotencyKey: string, memo: string): Promise<Decimal> {
    try {
      const wallet = await this.db.$transaction(async (tx) => {
        const w = await lockWallet(tx, rec.userId);
        const life = await getActiveLife(tx, rec.userId);
        return postLedger(tx, w, life.id, [{ type: 'EXTERNAL_DEPOSIT', amount: fromDb(rec.amount), memo, idempotencyKey }], this.clock());
      });
      this.notifier.wallet(rec.userId, wallet);
      return wallet.balance;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return this.walletBalance(rec.userId);
      throw err;
    }
  }

  private async finish(id: string, status: 'COMPLETED' | 'FAILED', data: { remoteBalance?: number; error?: string }) {
    await this.db.currencyExchange.update({
      where: { id },
      data: {
        status,
        completedAt: this.clock(),
        error: data.error ?? null,
        remoteBalance: data.remoteBalance === undefined ? undefined : toDb(D(data.remoteBalance)),
      },
    });
  }

  private async walletBalance(userId: string) {
    const w = await this.db.wallet.findUniqueOrThrow({ where: { userId } });
    return fromDb(w.balance);
  }

  private result(rec: CurrencyExchange, status: ExchangeResult['status'], balance: Decimal, bolivares: number | null): ExchangeResult {
    return { id: rec.id, direction: rec.direction, amount: wire(fromDb(rec.amount)), status, balance: wire(balance), bolivares };
  }
}
