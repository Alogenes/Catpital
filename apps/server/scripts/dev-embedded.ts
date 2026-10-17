/**
 * 免 Docker 本地开发：pnpm --filter @catpital/server dev:embedded
 *   - 在 apps/server/.pgdata 启动持久化的 embedded-postgres（端口 54320）
 *   - prisma migrate deploy + 导入种子市场
 *   - 启动 API（REDIS_URL 未设置时使用进程内总线）
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { loadDotenv } from '../src/config/dotenv.js';

loadDotenv();

const dataDir = fileURLToPath(new URL('../.pgdata', import.meta.url));
const port = Number(process.env.EMBEDDED_PG_PORT ?? 54320);
const fresh = !existsSync(dataDir);
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'catpital', password: 'catpital', port, persistent: true, onLog: () => {} });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('catpital');

const url = `postgresql://catpital:catpital@localhost:${port}/catpital`;
process.env.DATABASE_URL = url;
// .env 里的 REDIS_URL 若指向本机但没有 Redis 在跑，就退回进程内事件总线（单实例开发足够）
if (process.env.REDIS_URL) {
  const { hostname, port: redisPort } = new URL(process.env.REDIS_URL);
  const reachable = await new Promise<boolean>((resolve) => {
    const sock = createConnection({ host: hostname, port: Number(redisPort || 6379), timeout: 800 });
    sock.once('connect', () => (sock.destroy(), resolve(true)));
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => (sock.destroy(), resolve(false)));
  });
  if (!reachable) {
    console.log(`[dev] Redis not reachable at ${hostname}:${redisPort || 6379} — using the in-process bus`);
    process.env.REDIS_URL = ''; // 置空而不是删除：main() 会再次读取 .env，删除后会被重新填回
  }
}
process.env.JWT_SECRET ??= 'dev-secret-change-me';
process.env.DEV_LOGIN ??= '1';
const cwd = fileURLToPath(new URL('..', import.meta.url));
execSync('npx prisma migrate deploy', { stdio: 'inherit', cwd, env: process.env });
execSync('npx tsx prisma/seed.ts', { stdio: 'inherit', cwd, env: process.env });

const { main } = await import('../src/main.js');
try {
  await main({ afterShutdown: () => pg.stop() });
} catch (err) {
  console.error(err);
  await pg.stop();
  process.exit(1);
}
