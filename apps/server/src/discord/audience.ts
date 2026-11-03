import { PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';

/** 玩家能不能看到这个频道：在频道所属的服务器里，并且有「查看频道」权限 */
export type AudienceCheck = (channelId: string, userId: string) => Promise<boolean>;

/** 查询结果缓存多久：成员进出服务器、权限调整后最多这么久生效 */
export const AUDIENCE_CACHE_MS = 5 * 60_000;

type Logger = { warn: (o: unknown, m?: string) => void };

/** discord.js 里用到的最小接口（测试里可以换成假的） */
interface GuildMemberLike {
  id: string;
}
interface GuildChannelLike {
  isDMBased(): boolean;
  guild?: { members: { fetch(userId: string): Promise<GuildMemberLike> } };
  permissionsFor?(member: GuildMemberLike): { has(perm: bigint): boolean } | null;
}
export interface ChannelSource {
  channels: { fetch(channelId: string): Promise<unknown> };
}

/** 成员不在服务器 / 用户不存在（例如本地测试账号）：确定看不到 */
const NOT_A_MEMBER = new Set<number>([RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser]);

/**
 * 用 Discord API 判断玩家能否看到频道：取单个成员走 REST（GET /guilds/:id/members/:user），不需要 GuildMembers 特权 intent。
 * 结果（能 / 不能）缓存 AUDIENCE_CACHE_MS；接口出错时按「看不到」处理且不缓存，宁可少发一条也不往频道里发不该发的。
 */
export function channelAudience(client: ChannelSource, log: Logger, now: () => number = Date.now): AudienceCheck {
  const cache = new Map<string, { ok: boolean; at: number }>();
  return async (channelId, userId) => {
    const key = `${channelId}:${userId}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < AUDIENCE_CACHE_MS) return hit.ok;
    let ok: boolean;
    try {
      const channel = (await client.channels.fetch(channelId)) as GuildChannelLike | null;
      if (!channel || channel.isDMBased() || !channel.guild || !channel.permissionsFor) {
        ok = false;
      } else {
        const member = await channel.guild.members.fetch(userId).catch((err: { code?: number }) => {
          if (typeof err?.code === 'number' && NOT_A_MEMBER.has(err.code)) return null;
          throw err;
        });
        ok = Boolean(member && channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel));
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, channelId, userId }, 'discord audience check failed; skipping user-related post');
      return false;
    }
    cache.set(key, { ok, at: now() });
    return ok;
  };
}
