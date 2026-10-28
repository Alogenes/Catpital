/**
 * 带上仓库根目录的 .env 运行 Prisma CLI：
 *   pnpm --filter @catpital/server prisma:migrate:deploy
 * Prisma 只会读 apps/server 下的 .env，而项目配置放在仓库根目录（服务进程用 loadDotenv 读取），
 * 直接 `prisma migrate deploy` 会报 P1012 Environment variable not found: DATABASE_URL。
 * 已经存在的环境变量（Docker / 部署平台注入的）优先，不会被 .env 覆盖。
 */
import { execSync } from 'node:child_process';
import { loadDotenv } from '../src/config/dotenv.js';

loadDotenv();
try {
  execSync(`npx prisma ${process.argv.slice(2).join(' ')}`, { stdio: 'inherit' });
} catch (err) {
  process.exit((err as { status?: number }).status ?? 1);
}
