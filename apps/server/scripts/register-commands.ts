/**
 * 向 Discord 注册斜杠命令：
 *   pnpm --filter @catpital/server discord:register --guild 123456789012345678   # 只注册到一个服务器（立即生效，开发用）
 *   pnpm --filter @catpital/server discord:register --global                     # 全局注册（可能需要几分钟传播）
 * 需要环境变量 DISCORD_CLIENT_ID（Application ID）与 DISCORD_BOT_TOKEN。
 *
 * 注意：开启了 Activities 的应用会有一个由 Discord 管理的"入口命令"（PRIMARY_ENTRY_POINT，type 4）。
 * 全局批量覆盖时必须把它原样带上，否则 Discord 会拒绝（错误码 50240）。
 */
import { REST, Routes } from 'discord.js';
import { loadDotenv } from '../src/config/dotenv.js';
import { commandDefinitions } from '../src/discord/commands.js';

loadDotenv();

const args = process.argv.slice(2);
const guildIdx = args.indexOf('--guild');
const guildId = guildIdx >= 0 ? args[guildIdx + 1] : process.env.DISCORD_GUILD_ID;
const global = args.includes('--global');
const appId = process.env.DISCORD_CLIENT_ID;
const token = process.env.DISCORD_BOT_TOKEN;

if (!appId || !token) {
  console.error('DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN are required');
  process.exit(1);
}
if (!global && !guildId) {
  console.error('usage: discord:register --guild <guildId> | --global');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);
const body: unknown[] = commandDefinitions();

if (global) {
  const existing = (await rest.get(Routes.applicationCommands(appId))) as Array<{ id: string; type: number; name: string }>;
  const entryPoint = existing.find((c) => c.type === 4);
  if (entryPoint) body.push(entryPoint);
  const result = (await rest.put(Routes.applicationCommands(appId), { body })) as unknown[];
  console.log(`✔ registered ${result.length} global commands${entryPoint ? ' (kept the Activity entry point)' : ''}`);
} else {
  const result = (await rest.put(Routes.applicationGuildCommands(appId, guildId!), { body })) as unknown[];
  console.log(`✔ registered ${result.length} commands to guild ${guildId}`);
}
