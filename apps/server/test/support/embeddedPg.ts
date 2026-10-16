import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

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
