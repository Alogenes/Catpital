import type { BroadcastPayload } from '@catpital/shared';
import { describe, expect, it } from 'vitest';
import { COLORS, LAUNCH_BUTTON_ID, broadcastEmbed, launchCard, leaderboardEmbed, walletEmbed } from '../src/discord/embeds.js';
import { money, pct } from '../src/discord/format.js';
import { parseDelay, parseJump } from '../src/discord/parse.js';

describe('parse', () => {
  it('time_delay', () => {
    expect(parseDelay('30')).toBe(30_000);
    expect(parseDelay('30s')).toBe(30_000);
    expect(parseDelay('5m')).toBe(300_000);
    expect(parseDelay('1h30m')).toBe(5_400_000);
    expect(parseDelay(' 2 d ')).toBe(172_800_000);
    for (const bad of ['', '0', 'abc', '5x', '31d', '-5m']) expect(parseDelay(bad)).toBeNull();
  });
  it('price_jump', () => {
    expect(parseJump('-30%')!.toFixed()).toBe('-0.3');
    expect(parseJump('+50%')!.toFixed()).toBe('0.5');
    expect(parseJump('12.5％')!.toFixed()).toBe('0.125');
    expect(parseJump('-0.3')!.toFixed()).toBe('-0.3');
    expect(parseJump('0.25')!.toFixed()).toBe('0.25');
    for (const bad of ['-100%', '-150%', '30', '0%', 'abc', '+2000%']) expect(parseJump(bad)).toBeNull();
  });
});

describe('format', () => {
  it('money / pct with Decimal rounding', () => {
    expect(money('1234567.005')).toBe('1,234,567.01');
    expect(money('-77328.99')).toBe('-77,328.99');
    expect(pct('9.4')).toBe('+9.40%');
    expect(pct('-63.157894')).toBe('-63.16%');
  });
});

const base = (kind: BroadcastPayload['kind'], i18nKey: string, vars: Record<string, string | number>): BroadcastPayload => ({
  id: 'b1',
  kind,
  i18nKey,
  vars,
  userId: '100000000000000001',
  ts: Date.UTC(2026, 9, 17, 12),
});

describe('broadcast embeds', () => {
  it('whale alert (big win) is mint and mentions the player', () => {
    const e = broadcastEmbed('zh-CN', base('BIG_WIN', 'broadcast.bigWin', { market: 'MEOW', pnl: '50000', roe: '250' }))!.toJSON();
    expect(e.color).toBe(COLORS.mint);
    expect(e.title).toBe('🚀 巨鲸出没！');
    expect(e.description).toBe('<@100000000000000001> 在 **MEOW** 暴赚 **+50,000.00**！收益率 **+250.00%**');
  });

  it('whale pump / dump', () => {
    const pump = broadcastEmbed('zh-CN', base('WHALE', 'broadcast.whalePump', { market: 'WOOF', pct: '1.2', priceBefore: '0.5', priceAfter: '0.506' }))!.toJSON();
    expect([pump.color, pump.title]).toEqual([COLORS.mint, '🐋 大单拉盘！']);
    const dump = broadcastEmbed('en-US', base('WHALE', 'broadcast.whaleDump', { market: 'WOOF', pct: '-1.2', priceBefore: '0.5', priceAfter: '0.494' }))!.toJSON();
    expect([dump.color, dump.title]).toEqual([COLORS.blood, '🐋 Whale dump!']);
  });

  it('rekt and deficit cards are blood red', () => {
    const vars = { market: 'MEOW', side: 'SHORT', leverage: '50', liquidationPrice: '101.5', executionPrice: '130', totalLoss: '12000', deficit: '0', balanceAfter: '500' };
    const rekt = broadcastEmbed('zh-CN', base('LIQUIDATION', 'broadcast.liquidation', vars))!.toJSON();
    expect(rekt.color).toBe(COLORS.blood);
    expect(rekt.description).toBe('<@100000000000000001> 的 **MEOW** 50x 做空被无情斩杀，瞬间蒸发 **12,000.00** 本金！');
    const deficit = broadcastEmbed('zh-CN', base('DEFICIT', 'broadcast.deficit', { ...vars, deficit: '2783.01', balanceAfter: '-2764.2' }))!.toJSON();
    expect(deficit.description).toContain('倒欠 **2,783.01**，余额跌到 **-2,764.20**');
  });

  it('obituary lists the life stats and the snarky title', () => {
    const e = broadcastEmbed('zh-CN', base('BANKRUPTCY', 'broadcast.bankruptcy', { generation: 2, title: 'title.leverageManiac' }), {
      obituary: {
        name: 'tester', avatarHash: null, generation: 2, startedAt: Date.UTC(2026, 9, 16), endedAt: Date.UTC(2026, 9, 17), survivedSeconds: 86_460,
        peakNetWorth: '21302.71', worstLiquidationLoss: '18408', totalFeesPaid: '1128.49', winRate: '0.25', closedTradeCount: 8, liquidationCount: 3,
        debtWrittenOff: '113.94', reliefGranted: '5000', titles: ['title.leverageManiac', 'title.feeDonor'],
      },
    })!.toJSON();
    expect(e.color).toBe(COLORS.mourning);
    expect(e.title).toBe('⚰️ 讣告 · tester 的第 2 世');
    expect(e.description).toContain('## 「百倍杠杆做慈善」');
    expect(e.description).toContain('享年 **1 天 0 小时**');
    expect(e.fields!.map((f) => [f.name, f.value])).toEqual([
      ['🏔 巅峰资产', '21,302.71'],
      ['💀 最惨败局', '-18,408.00'],
      ['🧾 捐给交易所的手续费', '1,128.49'],
      ['🎯 胜率', '25.0%'],
      ['🔁 平仓 / 被斩', '8 / 3'],
      ['🩸 抹平负债', '113.94'],
    ]);
    expect(e.footer!.text).toContain('第 3 世开始');
  });

  it('breaking news is warning yellow and prefers localized copy', () => {
    const vars = { market: 'MEOW', headline: '喵喵科技暴雷', content: '监管介入', gapPct: '-30', priceBefore: '100', priceAfter: '70' };
    const zh = broadcastEmbed('zh-CN', base('MARKET_EVENT', 'broadcast.marketEvent', vars))!.toJSON();
    expect([zh.color, zh.title, zh.author!.name]).toEqual([COLORS.warning, '喵喵科技暴雷', '📰 突发 | MEOW']);
    expect(zh.description).toContain('跳空 **-30.00%**：100 → 70');
    const en = broadcastEmbed('en-US', base('MARKET_EVENT', 'broadcast.marketEvent', vars), { news: { headline: 'Meow Tech blows up', content: 'Regulators step in' } })!.toJSON();
    expect([en.title, en.description!.startsWith('Regulators step in')]).toEqual(['Meow Tech blows up', true]);
  });

  it('champion of the period', () => {
    const e = broadcastEmbed('zh-CN', base('CHAMPION', 'broadcast.champion', { period: 'WEEKLY', periodKey: '2026-W42', board: 'RETURN_PCT', value: '37.5', reward: '5000' }))!.toJSON();
    expect([e.color, e.title]).toEqual([COLORS.gold, '👑 本期股神 · 周榜收益率榜']);
    expect(e.description).toContain('**+37.50%**');
    expect(e.description).toContain('「周榜股神」');
  });
});

describe('command cards', () => {
  it('/launch: banner PNG attachment + launch button', () => {
    const card = launchCard('zh-CN', [{ code: 'MEOW', name: '喵喵科技', price: '31.6', change: '-0.684', open: true }]);
    const embed = card.embeds[0]!.toJSON();
    expect(embed.image!.url).toBe('attachment://catpital-banner.png');
    expect(embed.fields![0]!.value).toContain('🐱 **MEOW** `31.6` 🔴 -68.40%');
    const file = card.files[0]!;
    expect((file.attachment as Buffer).subarray(1, 4).toString()).toBe('PNG');
    const button = card.components[0]!.toJSON().components[0] as { custom_id: string; label: string };
    expect([button.custom_id, button.label]).toEqual([LAUNCH_BUTTON_ID, '🚀 进入交易大厅']);
  });

  it('/wallet shows talents and debt warning', () => {
    const e = walletEmbed('zh-CN', {
      userId: '100000000000000001', name: 'tester', avatarHash: null, balance: '-714.99', locked: '0', netWorth: '-714.99',
      generation: 3, positions: 0, badges: ['badge.DAILY.RETURN_PCT'], pastTitles: ['title.speedrun'],
    }).toJSON();
    expect(e.color).toBe(COLORS.blood);
    expect(e.description).toContain('负债中');
    expect(e.fields!.find((f) => f.name === '🧬 轮回天赋')!.value).toBe('👑 日榜股神\n🪦 十分钟速通破产');
    expect(e.fields!.find((f) => f.name === '🌱 轮回')!.value).toBe('第 3 世');
  });

  it('/leaderboard medals and own rank', () => {
    const e = leaderboardEmbed(
      'en-US',
      {
        period: 'DAILY', periodKey: '2026-10-17', board: 'RETURN_PCT', periodEnd: Date.UTC(2026, 9, 18), minCapital: '1000',
        entries: [
          { rank: 1, userId: '1', name: 'a', generation: 1, value: '12.5' },
          { rank: 2, userId: '2', name: 'b', generation: 1, value: '-3' },
        ],
        me: { rank: null, value: null, eligible: false },
      },
      '9',
    ).toJSON();
    expect(e.title).toBe('🏆 Daily · Return %');
    expect(e.description).toBe('🥇 <@1> · **+12.50%**\n🥈 <@2> · **-3.00%**');
    expect(e.fields![0]!.value).toBe('Start-of-period capital below 1,000; not ranked by return');
  });
});
