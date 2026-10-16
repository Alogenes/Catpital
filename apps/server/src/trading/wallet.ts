import { type Decimal, ZERO } from '@catpital/shared';
import type { LedgerType, Prisma } from '@prisma/client';
import { fromDb, toDb } from '../lib/dec.js';

export type Tx = Prisma.TransactionClient;

/** 计入收益率公式"外部资金流 F"的流水类型 */
export const EXTERNAL_LEDGER_TYPES: ReadonlySet<LedgerType> = new Set<LedgerType>([
  'INITIAL_GRANT',
  'EXTERNAL_DEPOSIT',
  'EXTERNAL_WITHDRAW',
  'BANKRUPTCY_WRITE_OFF',
  'BANKRUPTCY_RELIEF',
  'ADMIN_ADJUST',
]);

/** 在可用余额与冻结余额之间搬运的流水类型（不改变净值） */
const LOCK_TYPES: Partial<Record<LedgerType, 'lock' | 'unlock'>> = {
  ORDER_LOCK: 'lock',
  ORDER_UNLOCK: 'unlock',
};

export interface WalletState {
  userId: string;
  balance: Decimal;
  locked: Decimal;
}

export interface LedgerLine {
  type: LedgerType;
  /** 对可用余额的带符号影响 */
  amount: Decimal;
  marketId?: string;
  positionId?: string;
  orderId?: string;
  memo?: string;
  idempotencyKey?: string;
}

/**
 * 锁定钱包行（SELECT ... FOR UPDATE）。同一用户的所有资金操作都必须先调用它，
 * 这是防止并发双花的唯一闸门 —— 跨市场的操作也会在这里排队。
 */
export async function lockWallet(tx: Tx, userId: string): Promise<WalletState> {
  const rows = await tx.$queryRaw<Array<{ balance: string; locked: string }>>`
    SELECT "balance"::text AS balance, "locked"::text AS locked
    FROM "wallets" WHERE "userId" = ${userId} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new Error(`wallet not found for ${userId}`);
  return { userId, balance: fromDb(row.balance), locked: fromDb(row.locked) };
}

/**
 * 记账：逐条写入流水（含 balanceAfter），最后一次性更新钱包。
 * 金额为 0 的行自动跳过。返回记账后的钱包状态。
 */
export async function postLedger(
  tx: Tx,
  wallet: WalletState,
  lifeId: string,
  lines: LedgerLine[],
): Promise<WalletState> {
  let balance = wallet.balance;
  let locked = wallet.locked;
  const data: Prisma.LedgerEntryCreateManyInput[] = [];
  for (const line of lines) {
    if (line.amount.isZero()) continue;
    balance = balance.plus(line.amount);
    const lockKind = LOCK_TYPES[line.type];
    if (lockKind === 'lock') locked = locked.minus(line.amount); // amount 为负 → locked 增加
    if (lockKind === 'unlock') locked = locked.minus(line.amount); // amount 为正 → locked 减少
    data.push({
      userId: wallet.userId,
      lifeId,
      type: line.type,
      amount: toDb(line.amount),
      balanceAfter: toDb(balance),
      isExternal: EXTERNAL_LEDGER_TYPES.has(line.type),
      marketId: line.marketId ?? null,
      positionId: line.positionId ?? null,
      orderId: line.orderId ?? null,
      memo: line.memo ?? null,
      idempotencyKey: line.idempotencyKey ?? null,
    });
  }
  if (locked.lt(ZERO)) throw new Error('invariant violated: wallet.locked < 0');
  if (data.length > 0) {
    await tx.ledgerEntry.createMany({ data });
    await tx.wallet.update({
      where: { userId: wallet.userId },
      data: { balance: toDb(balance), locked: toDb(locked), version: { increment: 1 } },
    });
  }
  return { userId: wallet.userId, balance, locked };
}
