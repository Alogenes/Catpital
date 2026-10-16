/**
 * 免 Docker 本地开发：pnpm --filter @catpital/server dev:embedded
 *   - 在 apps/server/.pgdata 启动持久化的 embedded-postgres（端口 54320）
 *   - prisma migrate deploy + 导入种子市场
 *   - 启动 API（REDIS_URL 未设置时使用进程内总线）
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const dataDir = fileURLToPath(new URL('../.pgdata', import.meta.url));
const port = Number(process.env.EMBEDDED_PG_PORT ?? 54320);
const fresh = !existsSync(dataDir);
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'catpital', password: 'catpital', port, persistent: true, onLog: () => {} });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('catpital');

const url = `postgresql://catpital:catpital@localhost:${port}/catpital`;
process.env.DATABASE_URL = url;
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
