import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/support/globalSetup.ts'],
    // 集成测试共用一个临时数据库，按文件串行执行
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
