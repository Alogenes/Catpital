import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/support/globalSetup.ts'],
    // 集成测试共用一个临时数据库，按文件串行执行
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Windows 上停止 embedded-postgres 偶尔超过默认 10 秒，超时会导致临时库残留、下次启动端口冲突
    teardownTimeout: 60_000,
  },
});
