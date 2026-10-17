# syntax=docker/dockerfile:1.7
# CatPital 多阶段构建（构建上下文 = 仓库根目录）：
#   target web    → nginx：托管前端静态文件 + 把 /api、/ws 转发到 server 容器（唯一对外端口）
#   target server → Node：API + WebSocket + 行情引擎 + Discord Bot（只在 compose 私有网络里）
ARG NODE_VERSION=24

# ---------- 依赖安装（两个目标共用，利用缓存） ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
# Prisma 引擎需要 openssl；ca-certificates 用于连 Discord
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.22.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- 前端构建 ----------
FROM deps AS build-web
# Vite 在构建时把 VITE_ 变量写进 bundle（Client ID 是公开信息）
ARG VITE_DISCORD_CLIENT_ID
ENV VITE_DISCORD_CLIENT_ID=${VITE_DISCORD_CLIENT_ID}
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @catpital/web build

# ---------- 目标：web（nginx） ----------
FROM nginx:1.27-alpine AS web
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build-web /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80

# ---------- 目标：server（Node） ----------
FROM deps AS server
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @catpital/server exec prisma generate
COPY deploy/server-entrypoint.sh /usr/local/bin/catpital-server
RUN sed -i 's/\r$//' /usr/local/bin/catpital-server && chmod +x /usr/local/bin/catpital-server
ENV NODE_ENV=production \
    API_PORT=3001
WORKDIR /app/apps/server
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["catpital-server"]
