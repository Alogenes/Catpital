#!/bin/sh
# 启动顺序：数据库迁移 → 导入/更新市场规格（幂等，不会重置现价）→ 启动 API + 引擎 + Bot
set -e
./node_modules/.bin/prisma migrate deploy
node --import tsx prisma/seed.ts
# exec：让 node 成为 PID 1 的直接替身，docker stop 的 SIGTERM 能触发优雅关闭
exec node --import tsx src/main.ts
