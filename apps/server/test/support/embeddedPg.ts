import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * PostgreSQL 18 默认用独立的 io_worker 进程做异步 I/O。embedded-postgres 在 Windows 上用
 * `taskkill /f /t` 强杀数据库，io_worker 会残留下来继续占着端口，导致下一次启动报 "Unknown Error"。
 * 本地开发 / 测试库改用同步 I/O，就不会产生这些子进程。
 */
export const EMBEDDED_PG_FLAGS = ['-c', 'io_method=sync'];

/**
 * 进程内临时 PostgreSQL（npm embedded-postgres），用于集成测试与生成迁移。
 * 无需 Docker / 本机安装 PG。数据目录在系统临时目录，结束即删除。
 */
export async function startEmbeddedPg(port = 54329) {
  const dir = mkdtempSync(join(tmpdir(), 'catpital-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'catpital',
    password: 'catpital',
    port,
    persistent: false,
    onLog: () => {},
    postgresFlags: EMBEDDED_PG_FLAGS,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('catpital');
  await pg.createDatabase('catpital_shadow');
  const url = `postgresql://catpital:catpital@localhost:${port}/catpital`;
  const shadowUrl = `postgresql://catpital:catpital@localhost:${port}/catpital_shadow`;
  return {
    url,
    shadowUrl,
    async stop() {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
