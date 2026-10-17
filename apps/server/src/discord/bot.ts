import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  GuildMemberRoleManager,
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import type { Core } from '../app.js';
import { type CommandContext, autocompleteMarkets, handleCommand } from './commands.js';
import { LAUNCH_BUTTON_ID } from './embeds.js';
import { type BotLocale, pack } from './i18n.js';
import { BroadcastMessenger } from './messageService.js';

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

export interface BotOptions {
  token: string;
  defaultChannelId?: string;
  defaultLocale: BotLocale;
}

const localeOf = (l: string | null | undefined): BotLocale => (l?.startsWith('zh') ? 'zh-CN' : 'en-US');

function toContext(i: ChatInputCommandInteraction): CommandContext {
  const roles = i.member?.roles;
  const roleIds = roles instanceof GuildMemberRoleManager ? [...roles.cache.keys()] : Array.isArray(roles) ? roles : [];
  return {
    userId: i.user.id,
    username: i.user.username,
    globalName: i.user.globalName,
    avatarHash: i.user.avatar,
    guildId: i.guildId,
    channelId: i.channelId,
    locale: localeOf(i.locale),
    memberCanManage: Boolean(i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
    roleIds,
    getString: (n) => i.options.getString(n),
    getInteger: (n) => i.options.getInteger(n),
    getBoolean: (n) => i.options.getBoolean(n),
    getChannelId: (n) => i.options.getChannel(n)?.id ?? null,
  };
}

/** 回复是否仅自己可见：钱包默认私密、管理员命令私密，其余公开 */
function isEphemeral(i: ChatInputCommandInteraction) {
  if (i.commandName === 'wallet') return !i.options.getBoolean('public');
  return i.commandName.startsWith('admin_');
}

/**
 * Discord Bot（与 API 同进程，直接调用核心服务；未配置 DISCORD_BOT_TOKEN 时不启动）。
 *   - 斜杠命令：/launch /wallet /leaderboard /admin_schedule_event /admin_set_channel
 *   - 按钮：/launch 卡片上的"进入交易大厅" → interaction.launchActivity() 在 Discord 内打开前端
 *   - 频道播报：BroadcastMessenger 订阅引擎事件
 * 只需要 Guilds intent（不读消息内容）。
 */
export async function startDiscordBot(core: Core, opts: BotOptions, log: Logger) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  /**
   * 应用是否开启了 Activities（APPLICATION_FLAG EMBEDDED = 1 << 17）。
   * 未开启时 launchActivity 必然失败，而且失败的回调会耗掉交互令牌，之后连解释都回不了；
   * 所以启动时读一次，未开启就直接回复说明。
   */
  let activitiesEnabled = true;

  const messenger = new BroadcastMessenger(
    core,
    async (channelId, payload) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isSendable()) throw new Error(`channel ${channelId} is not sendable`);
      await channel.send(payload);
    },
    { defaultChannelId: opts.defaultChannelId, defaultLocale: opts.defaultLocale },
    log,
  );

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    void (async () => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName === 'admin_schedule_event') {
            await interaction.respond(autocompleteMarkets(core, interaction.options.getFocused()));
          }
          return;
        }
        if (interaction.isButton() && interaction.customId === LAUNCH_BUTTON_ID) {
          const t = pack(localeOf(interaction.locale)).launch;
          // 后台刚开启 Activities 时不必重启：未开启的状态下每次点击都重新读一次应用标志
          if (!activitiesEnabled) activitiesEnabled = await readActivitiesFlag();
          if (!activitiesEnabled) {
            await interaction.reply({ content: t.notEnabled, flags: MessageFlags.Ephemeral });
            return;
          }
          try {
            // LAUNCH_ACTIVITY 回调（type 12）：文字频道、语音频道、私信都能用，不要求用户在语音频道里
            await interaction.launchActivity();
          } catch (err) {
            log.warn({ err }, 'launchActivity failed');
            // 失败的回调可能已经消耗了交互令牌，回复失败也只能放弃
            await interaction.reply({ content: t.failed, flags: MessageFlags.Ephemeral }).catch(() => {});
          }
          return;
        }
        if (interaction.isChatInputCommand()) {
          // 先 defer：榜单计算、读库等可能超过 Discord 的 3 秒应答期限
          await interaction.deferReply(isEphemeral(interaction) ? { flags: MessageFlags.Ephemeral } : {});
          // 交互令牌 3 秒内必须应答；记录延迟，"The application did not respond" 时可据此判断是否网络慢
          log.info({ command: interaction.commandName, guildId: interaction.guildId, ackMs: Date.now() - interaction.createdTimestamp }, 'discord command');
          const reply = await handleCommand(core, interaction.commandName, toContext(interaction));
          const { ephemeral: _e, flags: _f, ...rest } = reply as typeof reply & { flags?: unknown };
          await interaction.editReply(rest);
        }
      } catch (err) {
        log.error({ err }, 'discord interaction failed');
        if (interaction.isRepliable()) {
          const content = '😿 Something went wrong / 出错了';
          if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => {});
          else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    })();
  });

  const readActivitiesFlag = async () => {
    try {
      const app = await client.application!.fetch();
      return Boolean((app.flags?.bitfield ?? 0) & (1 << 17));
    } catch (err) {
      log.warn({ err }, 'could not read application flags');
      return true; // 读不到就照常尝试 launchActivity
    }
  };

  client.once(Events.ClientReady, (c) => {
    void readActivitiesFlag().then((enabled) => {
      activitiesEnabled = enabled;
      log.info({ tag: c.user.tag, guilds: c.guilds.cache.size, activitiesEnabled }, 'discord bot ready');
    });
  });
  messenger.start();
  await client.login(opts.token);

  return {
    client,
    messenger,
    async stop() {
      messenger.stop();
      await client.destroy();
    },
  };
}
