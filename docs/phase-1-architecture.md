# Catpital · 阶段一：架构与数据库设计

> 状态：✅ 已落地为代码并通过校验
> - `apps/server/prisma/schema.prisma` —— `prisma validate` / `prisma generate` 通过
> - `packages/shared/src/math/*` —— 4 组核心公式，`vitest` 16/16 通过，`tsc --noEmit` 无错误

---

## 1. 项目目录结构

pnpm monorepo。`packages/shared` 前后端共用：前端下单面板预估斩杀线，后端撮合结算，用的是同一份公式代码，不会出现两边算法不一致。

```
catpital/
├── package.json                  # 根脚本：dev / build / test / db:*
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docker-compose.yml            # PostgreSQL 16 + Redis 7
├── .env.example                  # 所有环境变量（经济参数以字符串存储 → Decimal）
├── docs/
│   └── phase-1-architecture.md   # 本文档
│
├── packages/
│   └── shared/                   # ★ 前后端共享（纯 TS，无 IO）
│       ├── src/
│       │   ├── decimal.ts        # ✅ Decimal clone、D() 守卫、舍入规则、toWire
│       │   ├── math/
│       │   │   ├── position.ts   # ✅ 合并/反向抵扣、斩杀线、TP/SL、追加保证金
│       │   │   ├── settlement.ts # ✅ 无穿仓保护结算、净值、破产清算
│       │   │   └── returns.ts    # ✅ Modified Dietz 防刷收益率
│       │   ├── protocol/         # [阶段2] WS 消息类型 + zod schema
│       │   ├── i18n-keys.ts      # [阶段3] 错误码/称号 key 常量
│       │   └── index.ts
│       └── test/formulas.test.ts # ✅
│
├── apps/
│   ├── server/                   # Fastify + @fastify/websocket + Prisma + ioredis
│   │   ├── prisma/
│   │   │   ├── schema.prisma     # ✅
│   │   │   └── seed/markets.json # [阶段2] 初始市场 + 定时事件种子
│   │   └── src/
│   │       ├── main.ts                       # [阶段2] 启动入口
│   │       ├── config/env.ts                 # zod 校验 env，经济参数 → Decimal
│   │       ├── http/                         # 路由挂载于 API_BASE_PATH=/api
│   │       │   ├── auth.routes.ts            # Discord OAuth code → token → JWT
│   │       │   ├── market.routes.ts / trade.routes.ts / user.routes.ts
│   │       │   └── external/                 # [阶段4] HMAC 签名的外部货币接口
│   │       ├── ws/                           # 挂载于 WS_PATH=/ws
│   │       │   ├── gateway.ts                # 鉴权、订阅、心跳
│   │       │   └── channels.ts               # tick / kline / danmaku / broadcast / user
│   │       ├── market/
│   │       │   ├── engine.ts                 # 每市场一个 tick 循环（Actor）
│   │       │   ├── sources/
│   │       │   │   ├── PriceSource.ts        # Strategy 接口
│   │       │   │   ├── ProceduralSource.ts   # GBM + 均值回归 + 跳跃扩散
│   │       │   │   └── adapters/             # binance.ts / yahoo.ts / alphavantage.ts
│   │       │   ├── events/scheduler.ts       # 每秒轮询到期事件 → 跳空 + 参数覆盖
│   │       │   └── candles/aggregator.ts     # Tick → 1m/5m/15m/1h/1D
│   │       ├── trading/
│   │       │   ├── order.service.ts          # 下单 → applyFill → 事务落库
│   │       │   ├── risk/
│   │       │   │   ├── liquidationBook.ts    # 按斩杀线排序的内存索引
│   │       │   │   └── riskEngine.ts         # 每 tick：强平 > 止损 > 止盈
│   │       │   ├── wallet.service.ts         # 唯一的余额写入口（FOR UPDATE）
│   │       │   └── bankruptcy/
│   │       │       ├── bankruptcy.service.ts
│   │       │       └── resumeGenerator.ts    # 《股市人生履历》+ 称号评定
│   │       ├── leaderboard/                  # [阶段4] Redis ZSET 实时榜 + 周期结算
│   │       └── broadcast/                    # 统一播报总线 → WS + Bot（Redis Pub/Sub）
│   │
│   ├── web/                      # Vite + React + TS + Tailwind（Discord Activity）
│   │   ├── vite.config.ts        # ✅ /.proxy 双前缀代理
│   │   └── src/
│   │       ├── lib/
│   │       │   ├── endpoints.ts  # ✅ 唯一的 URL 出口：apiUrl() / wsUrl()
│   │       │   ├── discord.ts    # [阶段3] Embedded App SDK 初始化与鉴权
│   │       │   └── ws.ts         # 带重连的 WS 客户端
│   │       ├── stores/           # Zustand：market / position / settings / broadcast
│   │       ├── components/
│   │       │   ├── chart/        # lightweight-charts + 价格线 + 弹幕层
│   │       │   ├── trade/        # 下单面板、持仓卡、TP/SL 编辑
│   │       │   ├── social/       # 全服横幅、弹幕输入
│   │       │   └── fx/           # 庆典 / 斩杀 / 破产 全屏特效
│   │       ├── audio/            # BGM / SFX 管理（静态资源打包进 bundle，不走外链）
│   │       └── i18n/locales/{zh-CN,en-US}/*.json
│   │
│   └── bot/                      # [阶段4] discord.js：斜杠命令 + 频道播报
│       └── src/commands/{wallet,leaderboard,launch,schedule_event}.ts
```

---

## 2. Discord Embedded App `/.proxy` 代理方案

### 2.1 原理

Activity 跑在 `https://<APP_ID>.discordsays.com` 的 iframe 中，CSP 只允许同源请求。Discord 会把 `/.proxy/<prefix>/...` 去掉 `/.proxy`，按 Developer Portal 中配置的 **URL Mapping** 前缀匹配后转发。

### 2.2 生产环境 URL Mapping（Developer Portal → Activities → URL Mappings）

| PREFIX | TARGET | 说明 |
|---|---|---|
| `/api` | `api.catpital.example.com/api` | REST，后端路由仍挂在 `/api/v1/...` |
| `/ws` | `api.catpital.example.com/ws` | WebSocket（Discord 代理支持 WS 升级） |
| `/discord-cdn` | `cdn.discordapp.com` | 用户头像（阶段三新增，前端不出现任何外部域名） |
| `/` | `web.catpital.example.com` | 前端静态资源，**必须放在最后** |

前端请求 `/.proxy/api/v1/markets`，最终到达 `https://api.catpital.example.com/api/v1/markets`。

### 2.3 前端约束（`apps/web/src/lib/endpoints.ts`）

- `apiUrl('/markets')` → `/.proxy/api/v1/markets`（同源相对路径）
- `wsUrl()` → `wss://${location.host}/.proxy/ws`（host 在运行时读取，不硬编码）
- 计划在阶段三加 ESLint `no-restricted-syntax` 规则：禁止在 `endpoints.ts` 以外的地方写 `fetch('http` 或 `new WebSocket(`
- 第三方库如果必须请求外部域名，用 SDK 的 `patchUrlMappings()` 兜底；音效、字体等资源全部打包到 bundle 里

### 2.4 本地开发（`apps/web/vite.config.ts`）

| 场景 | Vite 收到的路径 | 代理规则 |
|---|---|---|
| Discord 客户端内（cloudflared 隧道，只映射 `/` → 隧道） | `/api/...`、`/ws` | `[API_BASE_PATH]`、`[WS_PATH]` 直通 |
| 普通浏览器访问 `localhost:5173` 调试 | `/.proxy/api/...`、`/.proxy/ws` | 重写去掉 `/.proxy` 前缀 |

隧道调试时设置 `VITE_TUNNEL=1`，此时 HMR 走 `clientPort: 443`。

### 2.5 认证流程

```
discordSdk.ready()
  → commands.authorize({ client_id, response_type:'code', scope:['identify','guilds'] })  → code
  → POST /.proxy/api/v1/auth/token { code }
        后端用 CLIENT_SECRET 换 access_token → GET /users/@me → upsert User/Wallet/Life
        → 返回 { access_token, sessionJwt }
  → commands.authenticate({ access_token })   // SDK 侧完成认证
  → 之后 REST 带 Authorization: Bearer <sessionJwt>；WS 首帧 {op:'auth', token}
```

---

## 3. 数据库 Schema 要点

完整定义见 [`apps/server/prisma/schema.prisma`](../apps/server/prisma/schema.prisma)。共 20 个模型，所有金额、价格、费率、收益率字段都是 `@db.Decimal(36, 8)`。

```
User ─1:1─ Wallet
 │
 ├─1:N─ Life（第 N 世）─1:1─ BankruptcyResume
 │        ├─ LedgerEntry（资金流水，只增不改）
 │        ├─ Position ─1:1─ Liquidation
 │        └─ Order
 ├─ ExternalTransfer ─N:1─ ApiClient ─1:N─ WebhookDelivery
 └─ LeaderboardPeriodStat / LeaderboardSnapshot

Market ─1:1─ MarketEngineConfig（GBM 参数 + 事件运行时覆盖）
   ├─ Candle（PK: marketId+interval+openTime）
   └─ ScheduledEvent（索引 status+triggerAt，供每秒轮询）

Broadcast / GuildConfig / ApiNonce
```

| 设计点 | 方案 |
|---|---|
| 每人每市场只有一个净持仓 | `Position.openKey = "<uid>:<marketId>"`（OPEN 时）/ `NULL`（平仓后）+ `@unique`。PG 唯一索引允许多个 NULL，所以历史仓位不冲突，也不用手写 partial index |
| Buy/Sell/Long/Short | 统一成 `OrderSide BUY/SELL` + `leverage` + `reduceOnly`：现货买入 = BUY 1x；现货卖出 = SELL reduceOnly；做多/做空 = BUY/SELL 带杠杆 |
| 余额可为负 | `Wallet.balance` 没有 CHECK 约束；`locked` 恒 ≥ 0 |
| 防双花 | 所有资金变动只走 `wallet.service`，事务内先 `SELECT ... FOR UPDATE` 锁钱包行；`LedgerEntry.idempotencyKey`、`Order(userId, clientOrderId)`、`ExternalTransfer(clientId, externalRef)` 三层幂等 |
| 人生履历 O(1) 生成 | `Life` 上增量维护巅峰净值、胜负次数、最佳 ROE、最惨强平、累计手续费、杠杆加权等；破产时直接拷贝成 `BankruptcyResume`，不用扫全量流水 |
| 收益率外部流 | `LedgerEntry.isExternal` 冗余标记；`LeaderboardPeriodStat` 增量累加 `F` 与 `F_w` |
| Tick 不落库 | Tick 只进 Redis Stream（保留 24h），1m 及以上 K 线写入 `Candle` |

---

## 4. 核心数学公式（decimal.js）

约定：`Q` 数量、`E` 开仓均价、`M` 逐仓保证金、`L` 杠杆、`P` 价格、`s` 方向（多 +1 / 空 −1）、`mmr` 维持保证金率、`fr` 费率。

### 4.0 精度规则（`decimal.ts`）
- 运算精度 40 位有效数字，落库按 8 位小数舍入
- `D(0.1)` 直接抛 `TypeError`，只允许安全整数和字符串，二进制浮点进不了金额计算
- 舍入方向：向玩家收的钱 `ROUND_UP`，付给玩家的钱 `ROUND_DOWN`，带符号的盈亏 `ROUND_FLOOR`
- 线上传输（JSON/WS/Redis）一律用字符串
- 唯一的 number 例外：`lightweight-charts` 的 API 只接受 number，只在图表渲染的最后一步转换，转换结果不参与任何计算

### 4.1 同股市仓位合并（`applyFill`）

**同向加仓**（成交 `q @ P`，下单杠杆 `L`）：
```
Q' = Q + q
E' = (Q·E + q·P) / (Q + q)
M' = M + q·P / L
L* = Q'·E' / M'          → 重算斩杀线
```
**反向成交**：
```
c      = min(q, Q)                    先抵扣平仓
PnL_c  = s·(P − E)·c
M_c    = M·c/Q                         （全平时 = M，避免尾差）
剩余   = (Q−c, E, M−M_c)
q > Q 且非 reduceOnly → 剩余 r = q − Q 以下单杠杆反向开新仓（翻仓）
```
**钱包变动**：`ΔB = (M_c + PnL_c − Fee_close) − (IM_open + Fee_open)`，开仓前要求 `可用余额 ≥ IM_open + Fee_open`。

### 4.2 逐仓强平斩杀线（`liquidationPrice`）
触发条件：`M + s·(P−E)·Q ≤ mmr·P·Q`
```
多仓：P_liq = (E·Q − M) / (Q·(1 − mmr))     向上取整到 tickSize；≤ 0 时记为 0（1x 永不强平）
空仓：P_liq = (E·Q + M) / (Q·(1 + mmr))     向下取整到 tickSize
```
同一 tick 内的触发优先级：强平 > 止损 > 止盈。都按触发时刻的真实最新价成交。

### 4.3 无穿仓保护结算（`settleLiquidation`）
```
P_x   = 触发时刻真实最新价（跳空时可能远远越过 P_liq）
PnL_x = s·(P_x − E)·Q
Fee_x = Q·P_x·(takerFeeRate + liquidationFeeRate)     照收，可以变成负债
S     = M + PnL_x − Fee_x                             结算额，可为负
D     = max(0, −S)                                    穿仓额
B'    = B + S                                         没有下限，可以变成巨额负数
Loss  = M − max(S,0) + D                              本场战役总亏损
```
例：100x 多仓 Q=1, E=100, M=1，事件跳空 −30% 到 70，费率 0.1%，余额 5
→ S = −29.07，D = 29.07，**余额 5 → −24.07**（测试用例已覆盖）。

### 4.4 净值与破产
```
NW = B + B_locked + Σ (M_i + uPnL_i)
```
需求原文写的是"可用余额 + 未实现盈亏"，但开仓时保证金已从余额划出，所以这里把 `M_i` 加回来，否则会低估净值。

破产条件：`无持仓 ∧ 无挂单 ∧ B ≤ dust`（dust 默认 0）。
清算：`W = max(0,−B)` 抹债，发放救济金 `R`，`B' = R`。**`W` 和 `R` 都记为外部资金流**。

### 4.5 防刷收益率（`periodReturn`，Modified Dietz）
```
R   = (V1 − (V0 + F)) / (V0 + F_w) × 100%
F   = Σ f_i                     外部净转入（充值+、提现−、破产抹债+、救济金+、管理员调整±）
F_w = Σ f_i · (T1 − t_i)/(T1 − T0)
资格：V0 ≥ MIN_CAPITAL 且 V0 + F_w ≥ MIN_CAPITAL
```
例：期初 1000 亏光后破产，拿 5000 救济金，期末 5000 → R = **−63.16%**，不会因为救济金变成虚假的 +400%。

---

## 5. Redis 键设计

| Key | 类型 | 用途 |
|---|---|---|
| `mkt:{id}:last` | Hash | 最新价、24h 涨跌、成交量（字符串） |
| `mkt:{id}:ticks` | Stream (MAXLEN ~86400) | Tick 历史，供断线补帧与 K 线重建 |
| `mkt:{id}:kline:{iv}:cur` | Hash | 当前未收盘 K 线 |
| `danmaku:{marketId}` | Pub/Sub + List(最近 100) | 同股市弹幕 |
| `ratelimit:danmaku:{uid}` | String TTL | 弹幕限流 |
| `bus:broadcast` | Pub/Sub | 全服播报 → WS 网关 + Bot |
| `lb:{period}:{key}:networth` / `:return` | ZSET | 实时榜单（score 只用于排序，展示值从 Hash 取字符串） |
| `nonce:{clientId}:{nonce}` | String TTL 300s | HMAC 防重放 |
| `lock:user:{uid}` | String NX PX | 跨实例的用户级串行锁（DB 行锁之外的第二道保险） |

> ZSET 的 score 是 double：只用来排序，精确数值另存在 `lb:...:val` Hash 里（字符串），符合"禁用浮点参与金额计算"的约束。

---

## 6. WebSocket 协议草案（阶段二细化为 zod schema）

```jsonc
// C → S
{ "op": "auth", "token": "<jwt>" }
{ "op": "sub", "ch": ["tick:MEOW", "kline:MEOW:M1", "danmaku:MEOW", "broadcast", "user"] }
{ "op": "danmaku", "market": "MEOW", "text": "冲！" }
// S → C（金额全部为字符串）
{ "ch": "tick:MEOW", "d": { "p": "123.45", "v": "88", "t": 1792137600000 } }
{ "ch": "user", "d": { "type": "liquidated", "deficit": "29.07", "balance": "-24.07" } }
{ "ch": "broadcast", "d": { "kind": "DEFICIT", "i18nKey": "bc.deficit", "vars": { ... } } }
```

---

## 7. 并发模型

1. **每个市场一个 Actor**：tick 生成 → 事件跳空 → K 线聚合 → 风控扫描，在同一循环里串行执行，同一市场内不存在价格竞态。
2. **风控扫描 O(k log n)**：`liquidationBook` 按斩杀线维护多/空两个有序索引，每个 tick 只弹出越线的仓位，不扫全表。
3. **资金写入**：强平/下单/追加保证金/破产都放在 `prisma.$transaction` 里，先锁 `Wallet` 行 → 校验 `Position.version` → 写 Position/Order/Liquidation/LedgerEntry/Life → 提交后再发布 WS/播报（outbox 思路，避免播报了却回滚）。

---

## 8. 需要你确认的设计决策

1. **残余保证金归属**：强平时如果 `S > 0`（价格刚好打在线上），当前设计**退还给玩家**。要不要改成罚没（进"保险基金"，更残酷）？
2. **破产 dust 阈值**：严格按需求是 `B ≤ 0` 才能破产。余额只剩 0.01、什么都开不了的玩家会卡住。要不要把 `BANKRUPTCY_DUST_THRESHOLD` 默认值设成比如 10？
3. **限价单**：为了让 Maker/Taker 费率有意义，Schema 已支持 LIMIT 单（冻结资金放在 `Wallet.locked`）。阶段二要不要一起实现，还是先只做市价单？
4. **负余额玩家的权限**：当前设计是负债时**不能开新仓，但可以平掉现有仓位**（平仓收益先用来抵债）。
5. **ORM**：选了 Prisma 5（生态成熟，原生 Decimal）。如果你更想用 Prisma 6/7 或 Drizzle，现在切换成本最低。
