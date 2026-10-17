import type { BroadcastPayload } from '@catpital/shared';
import { D } from '@catpital/shared';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { BANNER_FILE, launchBanner } from './banner.js';
import { discordTime, duration, money, pct, signed } from './format.js';
import { type BotLocale, badgeName, fill, pack, titleName } from './i18n.js';

/** 卡片配色：与前端"猫咪街机"主题一致 */
export const COLORS = {
  mint: 0x3ddc97, // 暴富 / 大单拉盘
  blood: 0xd7263d, // 斩杀 / 穿仓
  mourning: 0x1e1f22, // 讣告
  warning: 0xffd166, // 金融快讯
  grape: 0xa77bff, // 品牌 / 榜单
  gold: 0xf5c542, // 本期股神
} as const;

export const LAUNCH_BUTTON_ID = 'catpital:launch';

const MEDALS = ['🥇', '🥈', '🥉'];
const mention = (userId?: string) => (userId ? `<@${userId}>` : '?');

/** Discord 官方 CDN 头像（Bot 消息由 Discord 客户端渲染，不受 Activity CSP 限制） */
export function discordAvatar(userId: string, hash: string | null | undefined, size = 128) {
  if (hash) return `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=${size}`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`;
}

// -----------------------------------------------------------------------------
// /launch
// -----------------------------------------------------------------------------

export interface MarketLine {
  code: string;
  name: string;
  price: string;
  /** 较初始价比例，如 -0.1234 */
  change: string;
  open: boolean;
}

const MASCOT: Record<string, string> = { MEOW: '🐱', WOOF: '🐶', FIH: '🐟', BTC: '🪙' };

export function launchCard(locale: BotLocale, markets: MarketLine[]) {
  const t = pack(locale).launch;
  const lines = markets.map((m) => {
    const ch = D(m.change).mul(100);
    return `${MASCOT[m.code] ?? '📈'} **${m.code}** \`${money(m.price, 4).replace(/\.?0+$/, '')}\` ${ch.gte(0) ? '🟢' : '🔴'} ${pct(ch)}${m.open ? '' : ' 💤'}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLORS.grape)
    .setTitle(t.title)
    .setDescription(t.desc)
    .setImage(`attachment://${BANNER_FILE}`)
    .setFooter({ text: t.footer });
  if (lines.length) embed.addFields({ name: t.markets, value: lines.join('\n') });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(LAUNCH_BUTTON_ID).setStyle(ButtonStyle.Primary).setLabel(t.button),
  );
  return { embeds: [embed], components: [row], files: [new AttachmentBuilder(launchBanner(), { name: BANNER_FILE })] };
}

// -----------------------------------------------------------------------------
// /wallet
// -----------------------------------------------------------------------------

export interface WalletCardData {
  userId: string;
  name: string;
  avatarHash: string | null;
  balance: string;
  locked: string;
  netWorth: string;
  generation: number;
  positions: number;
  /** 轮回天赋：榜单限定称号 key（badge.*）+ 历世破产称号 key（title.*），已去重 */
  badges: string[];
  pastTitles: string[];
}

export function walletEmbed(locale: BotLocale, d: WalletCardData) {
  const t = pack(locale).wallet;
  const inDebt = D(d.balance).lt(0);
  const talents = [...d.badges.map((k) => `👑 ${badgeName(locale, k)}`), ...d.pastTitles.map((k) => `🪦 ${titleName(locale, k)}`)];
  const embed = new EmbedBuilder()
    .setColor(inDebt ? COLORS.blood : COLORS.grape)
    .setAuthor({ name: fill(t.title, { name: d.name }), iconURL: discordAvatar(d.userId, d.avatarHash, 64) })
    .addFields(
      { name: t.netWorth, value: `**${money(d.netWorth)}**`, inline: true },
      { name: t.balance, value: `**${money(d.balance)}**`, inline: true },
      { name: t.generation, value: fill(t.generationValue, { n: d.generation }), inline: true },
      { name: t.positions, value: fill(t.positionsValue, { n: d.positions }), inline: true },
    );
  if (D(d.locked).gt(0)) embed.addFields({ name: t.locked, value: money(d.locked), inline: true });
  embed.addFields({ name: t.talents, value: talents.length ? talents.slice(0, 12).join('\n') : t.noTalents });
  if (inDebt) embed.setDescription(t.debt);
  return embed;
}

// -----------------------------------------------------------------------------
// /leaderboard
// -----------------------------------------------------------------------------

export interface BoardData {
  period: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  periodKey: string;
  board: 'RETURN_PCT' | 'NET_WORTH';
  periodEnd: number;
  minCapital: string;
  entries: Array<{ rank: number; userId: string; name: string; generation: number; value: string }>;
  me: { rank: number | null; value: string | null; eligible: boolean } | null;
}

export function leaderboardEmbed(locale: BotLocale, b: BoardData, viewerId?: string) {
  const t = pack(locale).leaderboard;
  const fmtValue = (v: string) => (b.board === 'RETURN_PCT' ? pct(v) : money(v));
  const lines = b.entries.slice(0, 10).map((e) => {
    const rank = MEDALS[e.rank - 1] ?? `\`#${String(e.rank).padStart(2, ' ')}\``;
    const me = e.userId === viewerId ? ' ⬅️' : '';
    return `${rank} ${mention(e.userId)} · **${fmtValue(e.value)}**${me}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLORS.grape)
    .setTitle(fill(t.title, { period: t.period[b.period], board: t.board[b.board] }))
    .setDescription(lines.length ? lines.join('\n') : t.empty)
    .setFooter({ text: fill(t.footer, { key: b.periodKey, end: new Date(b.periodEnd).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }) });
  if (b.me && !b.entries.slice(0, 10).some((e) => e.userId === viewerId)) {
    const value = b.me.rank
      ? `#${b.me.rank} · ${fmtValue(b.me.value!)}`
      : b.board === 'RETURN_PCT' && !b.me.eligible
        ? fill(t.ineligible, { min: money(b.minCapital, 0) })
        : t.unranked;
    embed.addFields({ name: t.me, value });
  }
  return embed;
}

// -----------------------------------------------------------------------------
// 频道播报
// -----------------------------------------------------------------------------

export interface ObituaryData {
  name: string;
  avatarHash: string | null;
  generation: number;
  startedAt: number;
  endedAt: number;
  survivedSeconds: number;
  peakNetWorth: string;
  worstLiquidationLoss: string | null;
  totalFeesPaid: string;
  winRate: string;
  closedTradeCount: number;
  liquidationCount: number;
  debtWrittenOff: string;
  reliefGranted: string;
  titles: string[];
}

export interface BroadcastExtras {
  obituary?: ObituaryData;
  /** 金融快讯的本地化标题/正文（事件 i18n） */
  news?: { headline: string; content: string };
}

const sideName = (locale: BotLocale, side: unknown) => (side === 'SHORT' ? pack(locale).bc.short : pack(locale).bc.long);

/** 把一条全服播报转成频道 Embed；不需要发到频道的类型返回 null */
export function broadcastEmbed(locale: BotLocale, b: BroadcastPayload, extras: BroadcastExtras = {}): EmbedBuilder | null {
  const t = pack(locale).bc;
  const v = b.vars;
  const user = mention(b.userId);
  const at = new Date(b.ts);
  switch (b.kind) {
    case 'BIG_WIN':
      return new EmbedBuilder()
        .setColor(COLORS.mint)
        .setTitle(t.bigWinTitle)
        .setDescription(fill(t.bigWin, { user, market: String(v.market), pnl: signed(String(v.pnl)), roe: pct(String(v.roe ?? '0')) }))
        .setTimestamp(at);
    case 'WHALE': {
      const pump = b.i18nKey.endsWith('Pump');
      const verb = pump ? t.whalePump : t.whaleDump;
      return new EmbedBuilder()
        .setColor(pump ? COLORS.mint : COLORS.blood)
        .setTitle(fill(t.whaleTitle, { dir: verb }))
        .setDescription(fill(t.whale, { user, market: String(v.market), verb, pct: pct(String(v.pct)), before: String(v.priceBefore), after: String(v.priceAfter) }))
        .setTimestamp(at);
    }
    case 'LIQUIDATION':
    case 'DEFICIT': {
      const deficit = b.kind === 'DEFICIT';
      const base = { user, market: String(v.market), lev: money(String(v.leverage ?? '1'), 0), side: sideName(locale, v.side) };
      return new EmbedBuilder()
        .setColor(COLORS.blood)
        .setTitle(deficit ? t.deficitTitle : t.rektTitle)
        .setDescription(
          deficit
            ? fill(t.deficit, { ...base, deficit: money(String(v.deficit)), balance: money(String(v.balanceAfter)) })
            : fill(t.rekt, { ...base, loss: money(String(v.totalLoss)) }),
        )
        .setFooter({ text: fill(t.execAt, { exec: String(v.executionPrice), liq: String(v.liquidationPrice) }) })
        .setTimestamp(at);
    }
    case 'BANKRUPTCY': {
      const o = extras.obituary;
      if (!o) {
        return new EmbedBuilder()
          .setColor(COLORS.mourning)
          .setTitle(fill(t.obitTitle, { name: String(v.user ?? ''), gen: String(v.generation) }))
          .setDescription(`## 「${titleName(locale, String(v.title))}」`)
          .setTimestamp(at);
      }
      const names = o.titles.map((k) => `「${titleName(locale, k)}」`);
      return new EmbedBuilder()
        .setColor(COLORS.mourning)
        .setAuthor({ name: '🕯️ R.I.P.' })
        .setTitle(fill(t.obitTitle, { name: o.name, gen: o.generation }))
        .setThumbnail(b.userId ? discordAvatar(b.userId, o.avatarHash, 128) : null)
        .setDescription(
          [
            fill(t.obitDesc, { born: discordTime(o.startedAt, 'f'), died: discordTime(o.endedAt, 'f'), survived: duration(o.survivedSeconds, locale) }),
            '',
            `*${t.obitTitleLabel}*`,
            `## ${names[0] ?? ''}`,
            names.slice(1).join(' '),
          ].join('\n'),
        )
        .addFields(
          { name: t.peak, value: money(o.peakNetWorth), inline: true },
          { name: t.worst, value: o.worstLiquidationLoss ? `-${money(o.worstLiquidationLoss)}` : '—', inline: true },
          { name: t.fees, value: money(o.totalFeesPaid), inline: true },
          { name: t.winRate, value: pct(D(o.winRate).mul(100), 1).replace('+', ''), inline: true },
          { name: t.trades, value: `${o.closedTradeCount} / ${o.liquidationCount}`, inline: true },
          { name: t.debt, value: money(o.debtWrittenOff), inline: true },
        )
        .setFooter({ text: fill(t.obitFooter, { relief: money(o.reliefGranted, 0), next: o.generation + 1 }) })
        .setTimestamp(at);
    }
    case 'MARKET_EVENT': {
      const headline = extras.news?.headline ?? String(v.headline);
      const content = extras.news?.content ?? String(v.content ?? '');
      return new EmbedBuilder()
        .setColor(COLORS.warning)
        .setAuthor({ name: fill(t.newsTitle, { market: String(v.market) }) })
        .setTitle(headline)
        .setDescription(
          [content, '', fill(t.newsGap, { gap: pct(String(v.gapPct)), before: String(v.priceBefore), after: String(v.priceAfter) })]
            .filter((x, i) => i > 0 || x)
            .join('\n'),
        )
        .setTimestamp(at);
    }
    case 'CHAMPION': {
      const lb = pack(locale).leaderboard;
      const board = String(v.board) as 'RETURN_PCT' | 'NET_WORTH';
      const period = String(v.period) as 'DAILY' | 'WEEKLY' | 'MONTHLY';
      const value = board === 'RETURN_PCT' ? pct(String(v.value)) : money(String(v.value));
      return new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle(fill(t.champTitle, { period: lb.period[period], board: lb.board[board] }))
        .setDescription(
          [
            fill(board === 'RETURN_PCT' ? t.champReturn : t.champWorth, { user, value }),
            fill(t.champReward, { reward: money(String(v.reward)), badge: badgeName(locale, `badge.${period}.${board}`) }),
          ].join('\n'),
        )
        .setFooter({ text: String(v.periodKey) })
        .setTimestamp(at);
    }
    default:
      return null;
  }
}
