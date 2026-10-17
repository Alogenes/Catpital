# CatPital · 生产部署（Docker Compose，单端口）

> 适用：已经跑着其它业务、由 1Panel 管理的云服务器。不占用 80/443，不往宿主机装 Node / Postgres / Redis。

## 0. 结构

```
                     宿主机                                   compose 私有网络 catpital_internal
┌───────────────────────────────────────┐        ┌──────────────────────────────────────────────┐
│ 1Panel OpenResty :443 (已有，按域名分流) │──────▶│ web (nginx)  :80 ── 127.0.0.1:${APP_PORT}     │
│   catpital.example.com → 127.0.0.1:38080│        │   /            前端静态文件                    │
└───────────────────────────────────────┘        │   /api/* /ws ─▶ server :3001 (API+WS+引擎+Bot) │
                                                 │                    ├─▶ postgres :5432          │
                                                 │                    └─▶ redis    :6379          │
                                                 └──────────────────────────────────────────────┘
```

| 文件 | 作用 |
|---|---|
| `deploy/Dockerfile` | 多阶段构建：`web`（nginx + 前端产物）、`server`（Node 24 + Prisma） |
| `deploy/nginx/default.conf` | 容器内 nginx：静态文件、`/api` `/ws` 转发、`/.proxy` 前缀兼容、`/discord-cdn` 兜底 |
| `deploy/docker-compose.yml` | 4 个服务；**只有 web 映射一个端口**，默认 `127.0.0.1:38080` |
| `deploy/server-entrypoint.sh` | 启动时 `prisma migrate deploy` → 导入市场（幂等，不重置现价）→ 启动 |
| `deploy/.env.example` | 生产变量模板 |

只映射 `/` 一条 URL Mapping 就能跑通：Discord 把 `/.proxy/api/...` 剥成 `/api/...` 发给你的域名，容器内 nginx 再转给 server。直接用浏览器访问时，`/.proxy/...` 会在 nginx 里被重写掉，所以两种访问方式都能用。

---

## 1. 首次部署

```bash
# 服务器上（把仓库拷过去：git clone，或者用 1Panel 文件管理上传）
cd /opt/catpital/deploy
cp .env.example .env
# 填写：POSTGRES_PASSWORD、JWT_SECRET、API_SECRET_KEY（都用 openssl rand -hex 32），
#       DISCORD_CLIENT_SECRET、DISCORD_BOT_TOKEN
docker compose up -d --build
docker compose logs -f server      # 看到 "discord bot ready" 即可
curl -s http://127.0.0.1:38080/health
```

注册斜杠命令（只需一次；命令有改动时再执行）：

```bash
docker compose exec server node --import tsx scripts/register-commands.ts --guild <服务器ID>
# 或全局：... register-commands.ts --global
```

> ⚠️ **本地开发机上的 Bot 要先停掉**。同一个 Token 同时连两个进程时，两边都会收到交互，抢着应答，会出现 "Unknown interaction" 错误。

更新版本：`git pull && docker compose up -d --build`。数据保存在 `catpital_pgdata` 卷里，重建容器不会丢。

备份数据库：`docker compose exec postgres pg_dump -U catpital catpital | gzip > catpital-$(date +%F).sql.gz`

---

## 2. 宿主机反向代理

Discord 的 URL Mapping 只接受**域名**，代理走 **HTTPS 默认端口 443**，目标里不能写 `:38080`。所以需要一个能在 443 上按域名分流的反代。1Panel 自带的 OpenResty 本来就占着 80/443，多加一个站点不会影响现有业务。

### 2.1 1Panel 操作（推荐）

1. DNS：添加 `catpital.example.com` 的 A 记录，指向服务器 IP。
2. 1Panel → **网站** → **创建网站** → **反向代理**：
   - 主域名：`catpital.example.com`
   - 代理地址：`http://127.0.0.1:38080`。1Panel 的 OpenResty 使用 host 网络，所以能访问到回环地址。
3. 网站 → **HTTPS**：申请 Let's Encrypt 证书，并开启 HTTP → HTTPS 跳转。
4. 网站 → **反向代理** → 编辑源文：确认里面有下面 2.2 中的 WebSocket 三行（新版 1Panel 默认带）。

### 2.2 手写 Nginx / OpenResty 片段

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    http2 on;
    server_name catpital.example.com;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:38080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;          # WebSocket
        proxy_set_header Connection $connection_upgrade; # WebSocket
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;                           # 行情长连接
        proxy_send_timeout 1h;
    }
}
```

### 2.3 Caddy 片段

```caddy
catpital.example.com {
    reverse_proxy 127.0.0.1:38080   # Caddy 自动处理 WebSocket 升级和证书
}
```

### 2.4 不想动 443：Cloudflare Tunnel

前提：域名托管在 Cloudflare。

1. Zero Trust → Networks → Tunnels：新建隧道，Public Hostname 填 `catpital.example.com` → `http://web:80`。
2. 把隧道 Token 填进 `.env` 的 `CLOUDFLARE_TUNNEL_TOKEN`。
3. 执行 `docker compose --profile tunnel up -d`。

这样宿主机一个端口都不用开；`APP_PORT` 仍然绑定在 127.0.0.1，只用于本机调试。

### 2.5 直接用 IP:端口访问

在 `.env` 里设置 `APP_BIND=0.0.0.0`，然后 `docker compose up -d`。

- 只适合浏览器调试，Discord 里打不开（Discord 要求域名 + HTTPS）。
- Docker 会绕过 ufw 直接开放端口，记得在云厂商的安全组里限制来源 IP。

---

## 3. Discord Developer Portal 检查清单

Application ID：`1560322898856640664`

- [ ] **Activities → Settings**：打开 **Enable Activities**。没开时 Bot 按钮会回复「还没有开启 Activities」，日志里是 `EMBEDDED flag` 报错。
- [ ] **Activities → Settings → Supported Platforms**：勾选 Desktop / Web，需要的话再加 iOS / Android。
- [ ] **Activities → URL Mappings**。前缀匹配按从具体到宽泛的顺序，**`/` 必须放最后**；Target 只填域名，**不带 `https://`、不带端口**：

  | PREFIX | TARGET |
  |---|---|
  | `/discord-cdn` | `cdn.discordapp.com` |
  | `/` | `catpital.example.com` |

  `/discord-cdn` 可以不配，容器内 nginx 有兜底，但让 Discord 直连更快。不需要单独映射 `/api`、`/ws`，它们走 `/` 到达同一个容器。
- [ ] **OAuth2 → Redirects**：至少添加一个，比如 `https://127.0.0.1`。Embedded SDK 的 `authorize()` 要求应用有 redirect，但实际不会跳转。
- [ ] **OAuth2 → Client Secret**：与 `.env` 的 `DISCORD_CLIENT_SECRET` 保持一致（重置后要同步更新）。
- [ ] **Bot → Token**：与 `.env` 的 `DISCORD_BOT_TOKEN` 一致。之前的 Token 在聊天里出现过，**建议上线前重置**。
- [ ] **Installation / 邀请链接**：Bot 需要 `View Channel`、`Send Messages`、`Embed Links`、`Attach Files` 权限：
  `https://discord.com/oauth2/authorize?client_id=1560322898856640664&scope=bot+applications.commands&permissions=51200`

配好后不用重启 Bot：Activities 刚打开时，下一次点击按钮会重新读取应用设置。

**验证**：在浏览器打开 `https://catpital.example.com` 应该能看到前端（Discord 外没有登录态属于正常）；`https://catpital.example.com/health` 返回 `{"ok":true,...}`。然后在 Discord 文字频道里执行 `/launch` 并点按钮。
