/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Discord Activity 代理说明（详见 docs/phase-1-architecture.md §2）：
 *
 * - 前端代码中所有请求统一写成 `/.proxy/api/...` 与 `/.proxy/ws`。
 * - 在 Discord 客户端内：Discord 代理会剥离 `/.proxy` 前缀并按 URL Mapping 转发，
 *   开发期只映射了 `/ -> 隧道域名(本 Vite)`，因此 Vite 实际收到的是 `/api/...`、`/ws`。
 * - 在普通浏览器直接访问 localhost:5173 调试时：Vite 收到的是 `/.proxy/api/...`。
 * 所以两组前缀都需要代理到后端。生产环境由 Discord URL Mapping 直接转发，不经过 Vite。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../../', '');
  const apiTarget = `http://localhost:${env.API_PORT ?? '3001'}`;
  const apiBase = env.API_BASE_PATH ?? '/api';
  const wsPath = env.WS_PATH ?? '/ws';
  // 通过 cloudflared 等隧道在 Discord 中调试时，HMR 需要走 443
  const tunneled = env.VITE_TUNNEL === '1';

  return {
    plugins: [react()],
    test: { environment: 'node', include: ['test/**/*.test.ts'] },
    build: {
      rollupOptions: {
        output: {
          // 大依赖拆成独立 chunk，业务代码更新时用户只需重新下载小包
          manualChunks: {
            react: ['react', 'react-dom'],
            charts: ['lightweight-charts'],
            motion: ['framer-motion'],
            discord: ['@discord/embedded-app-sdk'],
            i18n: ['i18next', 'react-i18next'],
          },
        },
      },
    },
    envDir: '../../',
    server: {
      port: 5173,
      allowedHosts: true,
      hmr: tunneled ? { clientPort: 443 } : undefined,
      proxy: {
        '/.proxy/api': {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/\.proxy\/api/, apiBase),
        },
        '/.proxy/ws': {
          target: apiTarget.replace(/^http/, 'ws'),
          ws: true,
          rewrite: (p) => p.replace(/^\/\.proxy\/ws/, wsPath),
        },
        // 本地浏览器调试时把 Discord CDN 代理过去（Discord 内由 URL Mapping 完成）
        '/.proxy/discord-cdn': {
          target: 'https://cdn.discordapp.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/\.proxy\/discord-cdn/, ''),
        },
        [apiBase]: { target: apiTarget, changeOrigin: true },
        [wsPath]: { target: apiTarget.replace(/^http/, 'ws'), ws: true },
      },
    },
  };
});
