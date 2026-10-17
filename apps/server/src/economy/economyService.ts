import { type Decimal } from '@catpital/shared';
import { Prisma, type ExternalTransfer, type PrismaClient } from '@prisma/client';
import type { Notifier } from '../broadcast/notifier.js';
import { fromDb, toDb, wire } from '../lib/dec.js';
import { getActiveLife } from '../trading/lifeStats.js';
import { TradeError } from '../trading/types.js';
import { lockWallet, postLedger } from '../trading/wallet.js';
import type { UserService } from '../users/userService.js';

export interface TransferInput {
  clientId: string;
  userId: string;
  amount: Decimal;
  externalRef: string;
  memo?: string;
}

export interface TransferResult {
  transferId: string;
  direction: 'DEPOSIT' | 'WITHDRAW';
  userId: string;
  amount: string;
  balanceAfter: string;
  /** 同一 (clientId, externalRef) 的重复请求：返回首次结果，不重复记账 */
  duplicate: boolean;
}

/**
 * 跨机器人货币划转。
 *   - 每笔都写 ExternalTransfer（(clientId, externalRef) 唯一 → 幂等）+ 资金流水
 *   - 流水类型 EXTERNAL_DEPOSIT / EXTERNAL_WITHDRAW，isExternal = true：
 *     排行榜按 Modified Dietz 把它们当作外部资金流剔除，充值不会刷高收益率
 *   - 提现只能动用"可用余额"：逐仓保证金与挂单冻结不可提，余额不能被提成负数
 */
export class EconomyService {
  constructor(
    private readonly db: PrismaClient,
    private readonly users: UserService,
    private readonly notifier: Notifier,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  deposit(input: TransferInput) {
    return this.transfer('DEPOSIT', input);
  }

  withdraw(input: TransferInput) {
    return this.transfer('WITHDRAW', input);
  }

  private async transfer(direction: 'DEPOSIT' | 'WITHDRAW', input: TransferInput): Promise<TransferResult> {
    const existing = await this.db.externalTransfer.findUnique({
      where: { clientId_externalRef: { clientId: input.clientId, externalRef: input.externalRef } },
    });
    if (existing) return this.replay(existing, direction);

    if (direction === 'DEPOSIT') {
      // 外部 Bot 可能给还没玩过本游戏的人转账：先建档（占位昵称，玩家首次登录时同步真实昵称）
      const user = await this.db.user.findUnique({ where: { id: input.userId }, select: { id: true } });
      if (!user) await this.users.ensureUser({ id: input.userId, username: `player-${input.userId.slice(-4)}` });
    } else {
      const user = await this.db.user.findUnique({ where: { id: input.userId }, select: { id: true } });
      if (!user) throw new TradeError('error.userNotFound', 404);
    }

    const now = this.clock();
    try {
      const result = await this.db.$transaction(async (tx) => {
        let wallet = await lockWallet(tx, input.userId);
        if (direction === 'WITHDRAW' && wallet.balance.lt(input.amount)) throw new TradeError('error.insufficientFunds', 409);
        const life = await getActiveLife(tx, input.userId);
        const transfer = await tx.externalTransfer.create({
          data: {
            clientId: input.clientId,
            userId: input.userId,
            direction,
            amount: toDb(input.amount),
            status: 'COMPLETED',
            externalRef: input.externalRef,
            completedAt: now,
            createdAt: now,
          },
        });
        wallet = await postLedger(
          tx,
          wallet,
          life.id,
          [
            {
              type: direction === 'DEPOSIT' ? 'EXTERNAL_DEPOSIT' : 'EXTERNAL_WITHDRAW',
              amount: direction === 'DEPOSIT' ? input.amount : input.amount.neg(),
              memo: input.memo ?? `external:${input.clientId}`,
              idempotencyKey: `ext:${input.clientId}:${input.externalRef}`,
            },
          ],
          now,
        );
        return { transfer, wallet };
      });
      this.notifier.wallet(input.userId, result.wallet);
      return {
        transferId: result.transfer.id,
        direction,
        userId: input.userId,
        amount: wire(input.amount),
        balanceAfter: wire(result.wallet.balance),
        duplicate: false,
      };
    } catch (err) {
      // 并发重复提交：唯一约束冲突 → 按幂等返回首次结果
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const first = await this.db.externalTransfer.findUniqueOrThrow({
          where: { clientId_externalRef: { clientId: input.clientId, externalRef: input.externalRef } },
        });
        return this.replay(first, direction);
      }
      throw err;
    }
  }

  private async replay(t: ExternalTransfer, direction: 'DEPOSIT' | 'WITHDRAW'): Promise<TransferResult> {
    // 同一个 externalRef 不能被拿来做另一个方向的操作
    if (t.direction !== direction) throw new TradeError('error.externalRefConflict', 409);
    const wallet = await this.db.wallet.findUniqueOrThrow({ where: { userId: t.userId } });
    return {
      transferId: t.id,
      direction,
      userId: t.userId,
      amount: wire(fromDb(t.amount)),
      balanceAfter: wire(fromDb(wallet.balance)),
      duplicate: true,
    };
  }
}
