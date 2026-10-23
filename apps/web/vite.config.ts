/// <reference types="vitest" />
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Plugin, defineConfig, loadEnv } from 'vite';
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
/**
 * BGM 曲目清单：扫描 public/bgm/ 下的音频文件，生成虚拟模块 virtual:bgm-tracks。
 * 往目录里放 opus/mp3/ogg/m4a/webm/wav 即可出现在设置的下拉框里（开发时新增文件会自动刷新），不需要手写清单。
 *   - 曲名取文件名：去掉扩展名，- 和 _ 换成空格
 *   - 同名不同格式（song.opus + song.mp3）合并成一首，播放时按 BGM_FORMATS 的顺序挑设备能播的那个
 *     （老 iPhone 不支持 Ogg Opus，可以放一份同名 mp3 兜底）
 */
const BGM_FORMATS: Record<string, string> = {
  opus: 'audio/ogg; codecs=opus',
  webm: 'audio/webm; codecs=opus',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

function bgmTracks(): Plugin {
  const id = 'virtual:bgm-tracks';
  const resolved = '\0' + id;
  const dir = fileURLToPath(new URL('./public/bgm/', import.meta.url));
  const order = Object.keys(BGM_FORMATS);
  const scan = () => {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return [];
    }
    const groups = new Map<string, Array<{ file: string; type: string; ext: string }>>();
    for (const file of files) {
      const m = /^(.+)\.([a-z0-9]+)$/i.exec(file);
      const ext = m?.[2]?.toLowerCase();
      if (!m || !ext || !BGM_FORMATS[ext]) continue;
      const base = m[1]!;
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base)!.push({ file, type: BGM_FORMATS[ext]!, ext });
    }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([base, sources]) => ({
        id: base,
        title: base.replace(/[-_]+/g, ' ').trim(),
        sources: sources.sort((a, b) => order.indexOf(a.ext) - order.indexOf(b.ext)).map(({ file, type }) => ({ file, type })),
      }));
  };
  return {
    name: 'catpital-bgm-tracks',
    resolveId: (source) => (source === id ? resolved : null),
    load: (source) => (source === resolved ? `export default ${JSON.stringify(scan())};` : null),
    configureServer(server) {
      server.watcher.add(dir);
      const reload = (path: string) => {
        if (!path.replace(/\\/g, '/').includes('/public/bgm/')) return;
        const mod = server.moduleGraph.getModuleById(resolved);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', reload);
      server.watcher.on('unlink', reload);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../../', '');
  const apiTarget = `http://localhost:${env.API_PORT ?? '3001'}`;
  const apiBase = env.API_BASE_PATH ?? '/api';
  const wsPath = env.WS_PATH ?? '/ws';
  // 通过 cloudflared 等隧道在 Discord 中调试时，HMR 需要走 443
  const tunneled = env.VITE_TUNNEL === '1';

  return {
    plugins: [react(), bgmTracks()],
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
