import type { PrismaClient, User } from '@prisma/client';
import { z } from 'zod';
import type { EconomyConfig } from '../config/env.js';
import { toDb } from '../lib/dec.js';
import { lockWallet, postLedger } from '../trading/wallet.js';

export interface DiscordProfile {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  locale?: string;
}

export const userSettingsSchema = z.object({
  lang: z.string().max(16).optional(),
  vfx: z.boolean().optional(),
  bgm: z.boolean().optional(),
  sfx: z.boolean().optional(),
  danmaku: z.boolean().optional(),
  /** true = 红涨绿跌（中国习惯），false = 绿涨红跌 */
  redUp: z.boolean().optional(),
  volume: z.number().int().min(0).max(100).optional(),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export class UserService {
  constructor(
    private readonly db: PrismaClient,
    private readonly economy: Pick<EconomyConfig, 'INITIAL_GRANT'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * 首次登录建档：User + Wallet(0) + 第一世 Life，再记一笔 INITIAL_GRANT（外部资金流）。
   * 已存在则仅同步昵称头像。
   */
  async ensureUser(profile: DiscordProfile): Promise<User> {
    const now = this.clock();
    const existing = await this.db.user.findUnique({ where: { id: profile.id } });
    const identity = {
      username: profile.username,
      globalName: profile.global_name ?? null,
      avatarHash: profile.avatar ?? null,
      lastSeenAt: now,
    };
    if (existing) return this.db.user.update({ where: { id: profile.id }, data: identity });

    const grant = this.economy.INITIAL_GRANT;
    return this.db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id: profile.id,
          ...identity,
          locale: profile.locale?.startsWith('zh') ? 'zh-CN' : profile.locale ? 'en-US' : 'zh-CN',
          createdAt: now,
          wallet: { create: {} },
        },
      });
      const life = await tx.life.create({
        data: {
          userId: user.id,
          generation: 1,
          startingBalance: toDb(grant),
          peakNetWorth: toDb(grant),
          troughNetWorth: toDb(grant),
          startedAt: now,
          peakNetWorthAt: now,
        },
      });
      const wallet = await lockWallet(tx, user.id);
      await postLedger(tx, wallet, life.id, [{ type: 'INITIAL_GRANT', amount: grant, idempotencyKey: `grant:${user.id}` }], now);
      return user;
    });
  }

  async updateSettings(userId: string, patch: UserSettings) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    const merged = { ...((user.settings as Record<string, unknown>) ?? {}), ...userSettingsSchema.parse(patch) };
    return this.db.user.update({ where: { id: userId }, data: { settings: merged } });
  }
}
