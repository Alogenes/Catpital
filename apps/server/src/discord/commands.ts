import { D, type Decimal } from '@catpital/shared';
import {
  ChannelType,
  type InteractionReplyOptions,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { isOwner } from '../admin/owner.js';
import type { Core } from '../app.js';
import { fromDb, wire } from '../lib/dec.js';
import { isMarketOpen } from '../lib/tradingHours.js';
import { computeNetWorth } from '../trading/lifeStats.js';
import { discordTime, pct } from './format.js';
import { launchCard, leaderboardEmbed, walletEmbed } from './embeds.js';
import { type BotLocale, fill, pack } from './i18n.js';
import { parseDelay, parseJump } from './parse.js';

// -----------------------------------------------------------------------------
// 命令定义（注册脚本与 Bot 共用）
// -----------------------------------------------------------------------------

const PERIOD_CHOICES = [
  { name: '日榜 Daily', value: 'DAILY', name_localizations: { 'es-ES': 'Diaria' } },
  { name: '周榜 Weekly', value: 'WEEKLY', name_localizations: { 'es-ES': 'Semanal' } },
  { name: '月榜 Monthly', value: 'MONTHLY', name_localizations: { 'es-ES': 'Mensual' } },
];
const BOARD_CHOICES = [
  { name: '收益率榜 Return %', value: 'RETURN_PCT', name_localizations: { 'es-ES': 'Rentabilidad %' } },
  { name: '富豪榜 Richest', value: 'NET_WORTH', name_localizations: { 'es-ES': 'Los más ricos' } },
];

export function commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder()
      .setName('launch')
      .setDescription('Open the Catpital trading floor')
      .setDescriptionLocalizations({ 'zh-CN': '打开 Catpital 猫咪资本交易大厅', 'es-ES': 'Abre el parqué de Catpital' }),
    new SlashCommandBuilder()
      .setName('wallet')
      .setDescription('Check your balance, net worth and reincarnation talents')
      .setDescriptionLocalizations({ 'zh-CN': '查看余额、总净值、第几世与轮回天赋', 'es-ES': 'Consulta saldo, patrimonio, vida actual y talentos' })
      .addBooleanOption((o) =>
        o.setName('public').setDescription('Show the card to the whole channel').setDescriptionLocalizations({ 'zh-CN': '在频道里公开展示', 'es-ES': 'Mostrar la tarjeta a todo el canal' }),
      ),
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the leaderboard')
      .setDescriptionLocalizations({ 'zh-CN': '查看排行榜', 'es-ES': 'Ver la clasificación' })
      .addStringOption((o) =>
        o.setName('period').setDescription('Period').setDescriptionLocalizations({ 'zh-CN': '周期', 'es-ES': 'Periodo' }).addChoices(...PERIOD_CHOICES),
      )
      .addStringOption((o) =>
        o.setName('board').setDescription('Board').setDescriptionLocalizations({ 'zh-CN': '榜单', 'es-ES': 'Tabla' }).addChoices(...BOARD_CHOICES),
      ),
    new SlashCommandBuilder()
      .setName('admin_schedule_event')
      .setDescription('[Admin] Schedule a black-swan / moonshot market event')
      .setDescriptionLocalizations({ 'zh-CN': '【管理员】制造黑天鹅 / 暴涨事件', 'es-ES': '[Admin] Programar un cisne negro o un subidón' })
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addStringOption((o) =>
        o.setName('market').setDescription('Market code, e.g. MEOW').setDescriptionLocalizations({ 'zh-CN': '股市代码，如 MEOW', 'es-ES': 'Código del mercado, p. ej. MEOW' }).setRequired(true).setAutocomplete(true),
      )
      .addStringOption((o) =>
        o.setName('time_delay').setDescription('Delay: 30s / 5m / 1h30m').setDescriptionLocalizations({ 'zh-CN': '多久后触发：30s / 5m / 1h30m', 'es-ES': 'Retraso: 30s / 5m / 1h30m' }).setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('price_jump').setDescription('Instant gap: -30% / +50%').setDescriptionLocalizations({ 'zh-CN': '瞬间跳空：-30% / +50%', 'es-ES': 'Salto instantáneo: -30% / +50%' }).setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('news_title').setDescription('Headline').setDescriptionLocalizations({ 'zh-CN': '新闻标题', 'es-ES': 'Titular' }).setRequired(true).setMaxLength(200),
      )
      .addStringOption((o) =>
        o.setName('news_content').setDescription('Details').setDescriptionLocalizations({ 'zh-CN': '新闻详情', 'es-ES': 'Detalles de la noticia' }).setRequired(true).setMaxLength(1500),
      )
      .addIntegerOption((o) =>
        o
          .setName('duration')
          .setDescription('Seconds the trend/volatility effect lasts (default 300)')
          .setDescriptionLocalizations({ 'zh-CN': '后续趋势与波动放大持续秒数（默认 300）', 'es-ES': 'Segundos que duran la tendencia y la volatilidad extra (300 por defecto)' })
          .setMinValue(0)
          .setMaxValue(86_400),
      ),
    new SlashCommandBuilder()
      .setName('admin_set_channel')
      .setDescription('[Admin] Set the channel for Catpital broadcasts')
      .setDescriptionLocalizations({ 'zh-CN': '【管理员】设置本服务器的播报频道', 'es-ES': '[Admin] Elegir el canal de avisos de Catpital' })
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Text channel (default: this one)')
          .setDescriptionLocalizations({ 'zh-CN': '文字频道（默认当前频道）', 'es-ES': 'Canal de texto (por defecto, este)' })
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  ].map((c) => c.toJSON());
}

// -----------------------------------------------------------------------------
// 处理逻辑：与 discord.js 解耦，便于测试
// -----------------------------------------------------------------------------

export interface CommandContext {
  userId: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  guildId: string | null;
  channelId: string;
  locale: BotLocale;
  /** 成员在本服务器拥有"管理服务器"或管理员权限 */
  memberCanManage: boolean;
  roleIds: string[];
  getString(name: string): string | null;
  getInteger(name: string): number | null;
  getBoolean(name: string): boolean | null;
  getChannelId(name: string): string | null;
}

export type Reply = InteractionReplyOptions;

export async function handleCommand(core: Core, name: string, ctx: CommandContext): Promise<Reply> {
  switch (name) {
    case 'launch':
      return launch(core, ctx);
    case 'wallet':
      return wallet(core, ctx);
    case 'leaderboard':
      return leaderboard(core, ctx);
    case 'admin_schedule_event':
      return scheduleEvent(core, ctx);
    case 'admin_set_channel':
      return setChannel(core, ctx);
    default:
      return { content: `Unknown command: ${name}`, ephemeral: true };
  }
}

/** 市场代码自动补全 */
export function autocompleteMarkets(core: Core, typed: string) {
  const q = typed.trim().toUpperCase();
  return core.markets
    .list()
    .filter((m) => m.status !== 'DELISTED' && m.code.includes(q))
    .slice(0, 25)
    .map((m) => ({ name: `${m.code}${m.dataSource === 'LIVE_API' ? ' (live)' : ''}`, value: m.code }));
}

async function launch(core: Core, ctx: CommandContext): Promise<Reply> {
  const rows = await core.db.market.findMany({ where: { status: { not: 'DELISTED' } }, orderBy: { sortOrder: 'asc' } });
  const now = new Date();
  const markets = rows.map((m) => {
    const price = core.markets.price(m.id) ?? fromDb(m.lastPrice);
    const initial = fromDb(m.initialPrice);
    return { code: m.code, name: m.name, price: price.toFixed(), change: price.minus(initial).div(initial).toFixed(), open: isMarketOpen(m.tradingHours, now) };
  });
  return launchCard(ctx.locale, markets);
}

async function wallet(core: Core, ctx: CommandContext): Promise<Reply> {
  const t = pack(ctx.locale).wallet;
  const ephemeral = !ctx.getBoolean('public');
  const user = await core.db.user.findUnique({ where: { id: ctx.userId } });
  const w = await core.db.wallet.findUnique({ where: { userId: ctx.userId } });
  if (!user || !w) return { content: t.notFound, ephemeral: true };
  const balance = fromDb(w.balance);
  const locked = fromDb(w.locked);
  const nw = await computeNetWorth(core.db, { userId: ctx.userId, balance, locked }, (id) => core.markets.price(id));
  const [positions, resumes] = await Promise.all([
    core.db.position.count({ where: { userId: ctx.userId, status: 'OPEN' } }),
    core.db.bankruptcyResume.findMany({ where: { userId: ctx.userId }, orderBy: { generation: 'desc' }, select: { titles: true } }),
  ]);
  const badges = [...new Set(((Array.isArray(user.badges) ? user.badges : []) as Array<{ key: string }>).map((b) => b.key))];
  const pastTitles = [...new Set(resumes.flatMap((r) => r.titles.slice(0, 1)))];
  const embed = walletEmbed(ctx.locale, {
    userId: ctx.userId,
    name: user.globalName ?? user.username,
    avatarHash: user.avatarHash ?? ctx.avatarHash,
    balance: wire(balance),
    locked: wire(locked),
    netWorth: wire(nw),
    generation: user.generation,
    positions,
    badges,
    pastTitles,
  });
  return { embeds: [embed], ephemeral };
}

async function leaderboard(core: Core, ctx: CommandContext): Promise<Reply> {
  const period = (ctx.getString('period') ?? 'DAILY') as 'DAILY' | 'WEEKLY' | 'MONTHLY';
  const board = (ctx.getString('board') ?? 'RETURN_PCT') as 'RETURN_PCT' | 'NET_WORTH';
  const data = await core.leaderboard.board(period, board, ctx.userId, 10);
  return { embeds: [leaderboardEmbed(ctx.locale, data, ctx.userId)], allowedMentions: { parse: [] } };
}

/** 管理员判定：只认硬编码的唯一管理员 UID（见 admin/owner.ts） */
function isAdmin(ctx: CommandContext): boolean {
  return isOwner(ctx.userId);
}

async function scheduleEvent(core: Core, ctx: CommandContext): Promise<Reply> {
  const t = pack(ctx.locale).admin;
  if (!isAdmin(ctx)) return { content: t.noPermission, ephemeral: true };

  const code = (ctx.getString('market') ?? '').trim().toUpperCase();
  const market = core.markets.byCode(code);
  if (!market) return { content: fill(t.badMarket, { market: code }), ephemeral: true };
  const delay = parseDelay(ctx.getString('time_delay') ?? '');
  if (delay === null) return { content: t.badDelay, ephemeral: true };
  const jump: Decimal | null = parseJump(ctx.getString('price_jump') ?? '');
  if (!jump) return { content: t.badJump, ephemeral: true };

  // 事件创建者需要在 users 表里（外键）；顺便同步昵称
  await core.users.ensureUser({ id: ctx.userId, username: ctx.username, global_name: ctx.globalName, avatar: ctx.avatarHash });
  const triggerAt = new Date(Date.now() + delay);
  // 跳空之后的趋势顺着跳空方向延续一段时间（年化漂移 ±1），同时波动放大 2 倍
  const drift = jump.gt(0) ? '1' : '-1';
  await core.events.create(
    {
      market: market.code,
      triggerAt,
      headline: ctx.getString('news_title') ?? '',
      content: ctx.getString('news_content') ?? '',
      i18n: {},
      gapPercent: jump.toFixed(),
      driftAdjust: drift,
      volMultiplier: '2',
      durationSec: ctx.getInteger('duration') ?? 300,
    },
    'ADMIN_COMMAND',
    ctx.userId,
  );
  return {
    content: fill(t.scheduled, {
      market: market.code,
      jump: pct(D(jump).mul(100)),
      when: discordTime(triggerAt.getTime(), 'T'),
      rel: discordTime(triggerAt.getTime(), 'R'),
    }),
    ephemeral: true,
  };
}

async function setChannel(core: Core, ctx: CommandContext): Promise<Reply> {
  const t = pack(ctx.locale).admin;
  if (!ctx.guildId || !isAdmin(ctx)) return { content: t.noPermission, ephemeral: true };
  const channelId = ctx.getChannelId('channel') ?? ctx.channelId;
  await core.db.guildConfig.upsert({
    where: { guildId: ctx.guildId },
    create: { guildId: ctx.guildId, broadcastChannelId: channelId, adminRoleIds: [], locale: ctx.locale },
    update: { broadcastChannelId: channelId },
  });
  return { content: fill(t.channelSet, { channel: `<#${channelId}>` }), ephemeral: true };
}
