import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createCore } from './app.js';
import { loadDotenv } from './config/dotenv.js';
import { loadEnv } from './config/env.js';
import { buildServer } from './http/server.js';
import { startDiscordBot } from './discord/bot.js';
import { createBus } from './infra/bus.js';

/** afterShutdown：宿主脚本（如 dev:embedded）在进程退出前的清理钩子 */
export async function main(opts: { afterShutdown?: () => Promise<void> } = {}) {
  loadDotenv();
  const env = loadEnv();
  const db = new PrismaClient();
  const bus = createBus(env.REDIS_URL);
  // 核心服务复用 Fastify 的 pino logger；server 建好之前的日志退回 console
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  const log = {
    info: (o: unknown, m?: string) => (app ? app.log.info(o, m) : console.info(m, o)),
    warn: (o: unknown, m?: string) => (app ? app.log.warn(o, m) : console.warn(m, o)),
    error: (o: unknown, m?: string) => (app ? app.log.error(o, m) : console.error(m, o)),
  };
  const core = createCore({ db, bus, economy: env, log });
  app = await buildServer(core, env);

  await core.init();
  const seedEvents = fileURLToPath(new URL('../prisma/seed/events.json', import.meta.url));
  if (existsSync(seedEvents)) {
    const n = await core.events.seedFromJson(seedEvents);
    if (n) app.log.info({ n }, 'seeded scheduled events from JSON');
  }
  if (env.ENGINE_ENABLED === '1') await core.startEngines();
  if (env.LEADERBOARD_SETTLEMENT === '1') core.settlement.start();
  // Discord Bot：配置了 Token 才启动；斜杠命令需先运行 discord:register 注册
  const bot = env.DISCORD_BOT_TOKEN
    ? await startDiscordBot(
        core,
        { token: env.DISCORD_BOT_TOKEN, defaultChannelId: env.DISCORD_BROADCAST_CHANNEL_ID || undefined, defaultLocale: env.DISCORD_LOCALE },
        log,
      ).catch((err) => {
        log.error({ err }, 'discord bot failed to start; API keeps running');
        return null;
      })
    : null;

  await app.listen({ host: '0.0.0.0', port: env.API_PORT });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await bot?.stop();
    await app.close();
    await core.shutdown();
    await bus.close();
    await db.$disconnect();
    await opts.afterShutdown?.();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

// 直接执行（tsx src/main.ts / node dist/main.js）时自动启动；被 import 时由调用方启动
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
