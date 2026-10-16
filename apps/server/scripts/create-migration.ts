/**
 * 无需本机 Postgres 生成 Prisma 迁移：
 *   pnpm --filter @catpital/server migration:create <name>
 * 启动临时 embedded-postgres → 应用已有迁移 → 根据 schema 差异生成新迁移 → 关闭。
 */
import { execSync } from 'node:child_process';
import { startEmbeddedPg } from '../test/support/embeddedPg.js';

const name = process.argv[2] ?? 'migration';
const pg = await startEmbeddedPg(54330);
try {
  execSync(`npx prisma migrate dev --name ${name} --skip-seed --skip-generate`, {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: pg.url },
  });
} finally {
  await pg.stop();
}
