import { execSync } from 'node:child_process';
import type { GlobalSetupContext } from 'vitest/node';
import { startEmbeddedPg } from './embeddedPg.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** 启动临时 PostgreSQL 并应用全部 Prisma 迁移（与生产 `migrate deploy` 同一路径） */
export default async function setup({ provide }: GlobalSetupContext) {
  const pg = await startEmbeddedPg(54329);
  execSync('npx prisma migrate deploy', { stdio: 'ignore', env: { ...process.env, DATABASE_URL: pg.url } });
  provide('databaseUrl', pg.url);
  return async () => {
    await pg.stop();
  };
}
