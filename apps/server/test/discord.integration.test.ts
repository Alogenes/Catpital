import { D } from '@catpital/shared';
import type { MessageCreateOptions } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CommandContext, autocompleteMarkets, commandDefinitions, handleCommand } from '../src/discord/commands.js';
import { BroadcastMessenger } from '../src/discord/messageService.js';
import { fromDb } from '../src/lib/dec.js';
import { type Harness, createHarness, flushMicrotasks } from './support/harness.js';

const PLAYER = '800000000000000001';
const ADMIN = '626797305567248398'; // 硬编码的唯一管理员
const GUILD = '900000000000000001';
const CHANNEL = '900000000000000002';
let h: Harness;

function ctx(over: Partial<CommandContext> & { options?: Record<string, string | number | boolean> } = {}): CommandContext {
  const o = over.options ?? {};
  return {
    userId: PLAYER, username: 'player', globalName: 'Player', avatarHash: null, guildId: GUILD, channelId: CHANNEL,
    locale: 'zh-CN', memberCanManage: false, roleIds: [],
    getString: (n) => (typeof o[n] === 'string' ? (o[n] as string) : null),
    getInteger: (n) => (typeof o[n] === 'number' ? (o[n] as number) : null),
    getBoolean: (n) => (typeof o[n] === 'boolean' ? (o[n] as boolean) : null),
    getChannelId: (n) => (typeof o[n] === 'string' ? (o[n] as string) : null),
    ...over,
  };
}
const embedOf = (r: { embeds?: readonly unknown[] }) => (r.embeds![0] as { toJSON(): { title?: string; description?: string; fields?: Array<{ name: string; value: string }> } }).toJSON();

beforeAll(async () => {
  h = await createHarness();
  await h.db.$executeRawUnsafe('TRUNCATE "guild_configs"');
});
afterAll(async () => {
  await h.close();
});

describe('斜杠命令', () => {
  it('registers 5 commands with Chinese / Spanish localizations and admin-only defaults', () => {
    const defs = commandDefinitions();
    expect(defs.map((d) => d.name)).toEqual(['launch', 'wallet', 'leaderboard', 'admin_schedule_event', 'admin_set_channel']);
    const admin = defs.find((d) => d.name === 'admin_schedule_event')!;
    expect(admin.default_member_permissions).toBe('32'); // ManageGuild
    expect(admin.options!.map((o) => o.name)).toEqual(['market', 'time_delay', 'price_jump', 'news_title', 'news_content', 'duration']);
    expect(defs[0]!.description_localizations).toEqual({ 'zh-CN': '打开 Catpital 猫咪资本交易大厅', 'es-ES': 'Abre el parqué de Catpital' });
  });

  it('/wallet before playing, then with real data', async () => {
    expect((await handleCommand(h.core, 'wallet', ctx())).content).toContain('/launch');
    await h.user(PLAYER, 'player');
    await h.core.orders.placeOrder(PLAYER, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(10), leverage: D(10) });
    const r = await handleCommand(h.core, 'wallet', ctx({ options: { public: true } }));
    expect(r.ephemeral).toBe(false);
    const fields = Object.fromEntries(embedOf(r).fields!.map((f) => [f.name, f.value]));
    expect(fields['🪙 可用余额']).toBe('**9,899.00**');
    expect(fields['💰 总净值']).toBe('**9,999.00**');
    expect(fields['📈 持仓']).toBe('1 个');
  });

  it('/leaderboard', async () => {
    h.core.leaderboard.invalidate();
    const r = await handleCommand(h.core, 'leaderboard', ctx({ options: { period: 'WEEKLY', board: 'NET_WORTH' } }));
    const e = embedOf(r);
    expect(e.title).toBe('🏆 周榜 · 富豪榜');
    expect(e.description).toContain(`🥇 <@${PLAYER}> · **9,999.00** ⬅️`);
    expect(r.allowedMentions).toEqual({ parse: [] });
  });

  it('/launch lists markets', async () => {
    const r = await handleCommand(h.core, 'launch', ctx());
    expect(embedOf(r).fields![0]!.value).toContain('**TEST**');
  });

  it('/admin_schedule_event: permission check, validation, then schedules a real event', async () => {
    const opts = { market: 'test', time_delay: '5m', price_jump: '-30%', news_title: 'Test Corp 暴雷', news_content: 'CEO 跑路', duration: 120 };
    expect((await handleCommand(h.core, 'admin_schedule_event', ctx({ options: opts }))).content).toContain('你没有权限触发金融事件');
    // 拥有"管理服务器"权限也不行，只认唯一管理员 UID
    expect((await handleCommand(h.core, 'admin_schedule_event', ctx({ memberCanManage: true, options: opts }))).content).toContain('⛔');
    const admin = ctx({ userId: ADMIN, username: 'admin', memberCanManage: true });
    expect((await handleCommand(h.core, 'admin_schedule_event', { ...admin, getString: (n) => ({ ...opts, price_jump: '-150%' } as Record<string, unknown>)[n] as string })).content).toContain('price_jump');
    expect((await handleCommand(h.core, 'admin_schedule_event', { ...admin, getString: (n) => ({ ...opts, time_delay: 'soon' } as Record<string, unknown>)[n] as string })).content).toContain('time_delay');

    const before = Date.now();
    const r = await handleCommand(h.core, 'admin_schedule_event', ctx({ userId: ADMIN, username: 'admin', memberCanManage: true, options: opts }));
    expect(r.content).toContain('**TEST** 将在');
    expect(r.content).toContain('**-30.00%**');
    const ev = await h.db.scheduledEvent.findFirstOrThrow({ where: { headline: 'Test Corp 暴雷' } });
    expect([fromDb(ev.gapPercent).toFixed(), ev.durationSec, ev.source, ev.createdById, ev.status]).toEqual(['-0.3', 120, 'ADMIN_COMMAND', ADMIN, 'PENDING']);
    expect(ev.triggerAt.getTime() - before).toBeGreaterThanOrEqual(299_000);
  });

  it('market autocomplete', () => {
    expect(autocompleteMarkets(h.core, 'te')).toEqual([{ name: 'TEST', value: 'TEST' }]);
  });
});

describe('频道播报', () => {
  it('routes liquidations, deficits and obituaries to the configured channel as embeds', async () => {
    await handleCommand(h.core, 'admin_set_channel', ctx({ userId: ADMIN, memberCanManage: true }));
    const sent: Array<{ channelId: string; payload: MessageCreateOptions }> = [];
    const log = { warn: () => {}, error: (o: unknown) => console.error(o) };
    const messenger = new BroadcastMessenger(h.core, async (channelId, payload) => void sent.push({ channelId, payload }), { defaultLocale: 'zh-CN' }, log);
    messenger.start();

    // 10x 多单价格正好打到斩杀线 90.46 → 普通斩杀（保证金还剩一点）；再开 100x 跳到 50 → 穿仓 → 破产
    await h.tick('90.46');
    await h.core.orders.placeOrder(PLAYER, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(900), leverage: D(100) });
    await h.tick('50');
    await h.core.bankruptcy.declare(PLAYER);
    await flushMicrotasks();
    await messenger.drain();
    await flushMicrotasks();
    await messenger.drain();
    messenger.stop();

    const titles = sent.map((s) => (s.payload.embeds![0] as { toJSON(): { title?: string } }).toJSON().title);
    expect(sent.every((s) => s.channelId === CHANNEL)).toBe(true);
    expect(titles).toContain('⚡ 惨绝人寰！');
    expect(titles).toContain('🩸 穿仓了！负债了！');
    expect(titles).toHaveLength(3);
    expect(titles.some((t) => t?.startsWith('⚰️ 讣告 · player 的第 1 世'))).toBe(true);
    const obit = sent.find((s) => (s.payload.embeds![0] as { toJSON(): { title?: string } }).toJSON().title?.startsWith('⚰️'))!;
    expect((obit.payload.embeds![0] as { toJSON(): { fields?: unknown[] } }).toJSON().fields).toHaveLength(6);
    expect(sent.every((s) => JSON.stringify(s.payload.allowedMentions) === '{"parse":[]}')).toBe(true);
  });

  it('sends big wins to the channel but keeps whale and champion broadcasts web-only', async () => {
    const WINNER = '800000000000000009';
    await h.user(WINNER, 'winner');
    const sent: string[] = [];
    const messenger = new BroadcastMessenger(
      h.core,
      async (_channelId, payload) => void sent.push((payload.embeds![0] as { toJSON(): { title?: string } }).toJSON().title ?? ''),
      { defaultLocale: 'zh-CN' },
      { warn: () => {}, error: (o: unknown) => console.error(o) },
    );
    messenger.start();
    await h.tick('100');
    await h.core.orders.placeOrder(WINNER, { market: 'TEST', side: 'BUY', type: 'MARKET', quantity: D(50), leverage: D(10) });
    await h.tick('130'); // +30% × 10x → ROE 远超 100%
    await h.core.orders.closePosition(WINNER, 'TEST');
    await h.core.notifier.broadcast('WHALE', 'broadcast.whalePump', { market: 'TEST', pct: '1', priceBefore: '1', priceAfter: '1.01' }, { userId: WINNER, market: 'TEST' });
    await h.core.notifier.broadcast('CHAMPION', 'broadcast.champion', { periodKey: 'x', reward: '1' }, { userId: WINNER });
    await flushMicrotasks();
    await messenger.drain();
    messenger.stop();
    expect(h.botMessages.map((m) => m.broadcast.kind)).toEqual(expect.arrayContaining(['BIG_WIN', 'WHALE', 'CHAMPION']));
    expect(sent).toEqual(['🚀 巨鲸出没！']);
  });

  it('per-guild toggles can mute a kind', async () => {
    await h.db.guildConfig.update({ where: { guildId: GUILD }, data: { broadcastToggles: { DEFICIT: false } } });
    const messenger = new BroadcastMessenger(h.core, async () => {}, { defaultLocale: 'zh-CN' }, { warn: () => {}, error: () => {} });
    expect(await messenger.targets('DEFICIT')).toEqual([]);
    expect(await messenger.targets('BIG_WIN')).toEqual([{ channelId: CHANNEL, locale: 'zh-CN' }]);
  });
});
