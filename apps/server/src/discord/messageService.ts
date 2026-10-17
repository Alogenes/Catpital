import type { BroadcastKind } from '@catpital/shared';
import type { MessageCreateOptions } from 'discord.js';
import type { Core } from '../app.js';
import type { BotEnvelope } from '../infra/bus.js';
import { fromDb, wire } from '../lib/dec.js';
import { type BroadcastExtras, broadcastEmbed } from './embeds.js';
import { type BotLocale, botLocaleOf } from './i18n.js';

/** 发消息的抽象：生产环境由 discord.js Client 实现，测试里注入假的 */
export type ChannelSender = (channelId: string, payload: MessageCreateOptions) => Promise<void>;

type Logger = { warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/**
 * 频道自动播报：订阅总线 `bot` topic（引擎在强平 / 暴富 / 大单 / 破产 / 快讯 / 结算时发布），
 * 为每个配置了播报频道的服务器生成对应语言的 Embed 卡片并发送。
 *   - 频道来源：GuildConfig.broadcastChannelId（/admin_set_channel 设置）+ 环境变量默认频道
 *   - 开关：GuildConfig.broadcastToggles，如 { "WHALE": false } 关闭大单播报
 *   - 发送串行排队；单个频道失败（无权限/被删）只记日志，不影响其它频道
 *   - 卡片里的 @玩家 不会真的 ping 人，只有"本期股神"会提醒获奖者本人
 */
export class BroadcastMessenger {
  private chain: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly core: Core,
    private readonly send: ChannelSender,
    private readonly opts: { defaultChannelId?: string; defaultLocale: BotLocale },
    private readonly log: Logger,
  ) {}

  start() {
    this.unsubscribe = this.core.bus.subscribe('bot', (env) => {
      this.chain = this.chain.then(() => this.handle(env)).catch((err) => this.log.error({ err }, 'broadcast to discord failed'));
    });
  }

  stop() {
    this.unsubscribe?.();
  }

  /** 等待队列清空（测试与停机用） */
  drain() {
    return this.chain;
  }

  async targets(kind: BroadcastKind): Promise<Array<{ channelId: string; locale: BotLocale }>> {
    const guilds = await this.core.db.guildConfig.findMany({ where: { broadcastChannelId: { not: null } } });
    const out = new Map<string, BotLocale>();
    for (const g of guilds) {
      const toggles = (g.broadcastToggles ?? {}) as Partial<Record<BroadcastKind, boolean>>;
      if (toggles[kind] === false) continue;
      out.set(g.broadcastChannelId!, botLocaleOf(g.locale));
    }
    if (this.opts.defaultChannelId && !out.has(this.opts.defaultChannelId)) out.set(this.opts.defaultChannelId, this.opts.defaultLocale);
    return [...out].map(([channelId, locale]) => ({ channelId, locale }));
  }

  async handle({ broadcast, resumeId }: BotEnvelope) {
    const targets = await this.targets(broadcast.kind);
    if (!targets.length) return;
    const extras = await this.extras(broadcast, resumeId);
    for (const { channelId, locale } of targets) {
      const embed = broadcastEmbed(locale, broadcast, this.localizedExtras(extras, locale));
      if (!embed) continue;
      try {
        await this.send(channelId, {
          embeds: [embed],
          allowedMentions: broadcast.kind === 'CHAMPION' && broadcast.userId ? { users: [broadcast.userId] } : { parse: [] },
        });
      } catch (err) {
        this.log.warn({ err, channelId, kind: broadcast.kind }, 'discord send failed');
      }
    }
  }

  /** 讣告需要完整履历；快讯需要事件的多语言文案 */
  private async extras(b: BotEnvelope['broadcast'], resumeId?: string) {
    const out: { obituary?: BroadcastExtras['obituary']; i18n?: Record<string, { headline?: string; content?: string }> } = {};
    if (b.kind === 'BANKRUPTCY' && resumeId) {
      const r = await this.core.db.bankruptcyResume.findUnique({ where: { id: resumeId }, include: { user: true } });
      if (r) {
        out.obituary = {
          name: r.user.globalName ?? r.user.username,
          avatarHash: r.user.avatarHash,
          generation: r.generation,
          startedAt: r.startedAt.getTime(),
          endedAt: r.endedAt.getTime(),
          survivedSeconds: Number(r.survivedSeconds),
          peakNetWorth: wire(fromDb(r.peakNetWorth)),
          worstLiquidationLoss: r.worstLiquidationLoss ? wire(fromDb(r.worstLiquidationLoss)) : null,
          totalFeesPaid: wire(fromDb(r.totalFeesPaid)),
          winRate: wire(fromDb(r.winRate)),
          closedTradeCount: r.closedTradeCount,
          liquidationCount: r.liquidationCount,
          debtWrittenOff: wire(fromDb(r.debtWrittenOff)),
          reliefGranted: wire(fromDb(r.reliefGranted)),
          titles: r.titles,
        };
      }
    }
    if (b.kind === 'MARKET_EVENT' && typeof b.vars.eventId === 'string') {
      const ev = await this.core.db.scheduledEvent.findUnique({ where: { id: b.vars.eventId }, select: { i18n: true } });
      out.i18n = (ev?.i18n ?? {}) as Record<string, { headline?: string; content?: string }>;
    }
    return out;
  }

  private localizedExtras(e: Awaited<ReturnType<BroadcastMessenger['extras']>>, locale: BotLocale): BroadcastExtras {
    const loc = e.i18n?.[locale];
    return {
      obituary: e.obituary,
      news: loc?.headline ? { headline: loc.headline, content: loc.content ?? '' } : undefined,
    };
  }
}
