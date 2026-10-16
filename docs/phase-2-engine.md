# Catpital · 阶段二：后端核心引擎

> 状态：✅ 已完成并验证
> - `tsc --noEmit`：shared / server 均无错误
> - 测试：shared 16 个 + server 45 个，共 **61 个测试全部通过**（server 集成测试跑在真实 PostgreSQL 上）
> - 真实启动：`dev:embedded` 起服后，MEOW/WOOF 每秒跳价，FISH 按上海交易时段正确休市，BTC 经 Binance 适配器拿到实时价

第 8 节的 5 个决策按默认方案落地：强平残余保证金**退还**玩家；dust 阈值默认 `0`；**限价单已实现**；负债玩家**不能开仓、可以平仓**；ORM 用 Prisma 5。

---

## 1. 快速开始（不需要 Docker）

```bash
pnpm install
pnpm dev:server          # 启动 embedded-postgres(54320) → 迁移 → 导入种子 → API :3001
```

开发登录（`DEV_LOGIN` 默认开启，production 下强制关闭）：

```bash
curl -X POST localhost:3001/api/v1/auth/dev -H 'content-type: application/json' -d '{"userId":"123","username":"me"}'
```

其它命令：`pnpm --filter @catpital/server test`，`... migration:create <name>`（同样不需要本机 PG）。

---

## 2. 模块地图（`apps/server/src`）

| 模块 | 职责 |
|---|---|
| `app.ts` | 组合根。`main.ts` 和集成测试共用同一套装配 |
| `market/sources/ProceduralSource.ts` | 对数价格过程：GBM + OU 均值回归 + Merton 跳跃扩散，事件可覆盖漂移和波动率 |
| `lib/random.ts` | xoshiro128** → `Decimal` 均匀分布 → Box–Muller 正态分布，**全程没有二进制浮点** |
| `market/sources/LiveSource.ts` + `adapters/` | 外部行情：Binance（WS 推送）、Yahoo、AlphaVantage（轮询），可通过 `registerFeed()` 扩展 |
| `lib/losslessJson.ts` | 外部 API 返回的 JSON 数字按**原文字符串**解析（ES2025 source text access） |
| `market/candles/aggregator.ts` | Tick → 1m/5m/15m/1h/1D OHLCV；收盘的 K 线立即落库，未收盘的每 10s 落库，重启后恢复 |
| `market/marketEngine.ts` | 单个市场的 Actor：采样 → K 线 → 推送 → 风控，在**该市场的串行队列**里执行 |
| `market/events/eventScheduler.ts` | 每秒轮询定时事件：跳空 → 合成漂移/波动率覆盖 → 快讯；到期后复原 |
| `trading/tradeExecutor.ts` | **唯一**改动持仓和余额的地方。每笔成交/强平是一个数据库事务 |
| `trading/wallet.ts` | `SELECT … FOR UPDATE` 锁钱包行 + 写流水（含 `balanceAfter`） |
| `trading/risk/` | `TriggerBook` 有序索引（O(log n + k)）+ `RiskEngine`：强平 > 止损 > 止盈，然后撮合限价单 |
| `trading/orderService.ts` | 用户入口：市价/限价/撤单/平仓/TP·SL/追加保证金 |
| `bankruptcy/` | 破产清算 + 《人生履历》+ 16 条称号规则 |
| `http/`、`ws/gateway.ts` | REST `/api/v1/*`、WS `/ws`（弹幕清洗 + 限流） |

---

## 3. 关键机制

### 3.1 并发模型（防双花）
1. **按市场串行**：同一市场的 tick、下单、强平、事件跳空都进同一个 `KeyedQueue`。"加保证金"和"被强平"不可能交错执行（有测试覆盖）。
2. **按用户加锁**：跨市场操作同一个钱包时，在 PG 行锁上排队。
3. **乐观版本**：Position 更新都带 `WHERE version = ?`。

测试：同一用户在 3 个市场并发提交 60 笔单，资金只够 33 笔 → **正好 33 笔成交、27 笔拒绝，余额 90.1，Σ 流水 = 余额**。

### 3.2 无穿仓保护强平：流水怎么记
`S = M + PnL − Fee < 0` 时写四条流水，合计正好等于 `S`：

| 类型 | 金额 | 含义 |
|---|---|---|
| `MARGIN_RELEASE` | `+M` | 释放逐仓保证金 |
| `TRADING_FEE` | `−Fee` | 强平手续费照收 |
| `REALIZED_PNL` | `PnL + D` | 保证金能覆盖的亏损 |
| `LIQUIDATION_DEFICIT` | `−D` | **超出保证金、从总本金倒扣的部分** |

事务内有断言 `wallet.balance == settlement.balanceAfter`，不相等就回滚。

**测试实录**：100x 多 900 股 @100，斩杀线 99.50 → 定时事件跳空 −30% 到 70 → 按 70 成交 → 穿仓 26,163 → **余额 8,786.02 → −17,376.98**，同时发出 DEFICIT 全服播报。之后申请破产：抹债 17,376.98，发救济 5,000，进入第 2 世，称号 `[速通, 穿仓之王, 黑天鹅受害者]`。

### 3.3 定时事件
- 抢占式触发：`UPDATE … WHERE status='PENDING'`，多实例也只触发一次
- 超过 1 小时才处理到的事件（比如停机期间到期的）会作废，避免重启后集中跳空
- 程序随机市场：价格直接跳空，`driftAdjust` 叠加到 μ、`volMultiplier` 乘到 σ
- 外部 API 市场：真实价格改不了，所以用**冲击叠加层** `真实价 × f(t)` 实现，`f` 在持续时间内线性衰减回 1
- 公开接口只返回已触发的事件，**未来事件不对外，防剧透**

### 3.4 精度
- 请求体里的金额**只接受字符串**：JSON number 直接返回 400（有测试覆盖）
- 写库前统一 `toDb()`（8 位小数），推送统一 `wire()`
- 唯一用到 JS number 的地方：时间戳、计数器、Box–Muller 之前的 uint32 整数

---

## 4. REST / WS 接口一览（`/.proxy/api/v1` 前缀）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/token` · `/auth/dev` | Discord code 换 JWT · 开发登录 |
| GET | `/markets` · `/markets/:code/candles` · `/events` · `/danmaku` | 行情、K 线（含未收盘的当前 K 线）、快讯、最近弹幕 |
| GET/PUT | `/me` · `/me/settings` · `/me/ledger` | 首屏聚合（含净值、破产资格）· 偏好设置 · 流水 |
| POST/DELETE/GET | `/orders` · `/orders/:id` | 下单（`clientOrderId` 幂等）· 撤单 · 查询 |
| POST/PATCH | `/positions/:code/close` · `/tpsl` · `/margin` | 平仓 · 止盈止损 · 追加保证金 |
| POST | `/bankruptcy` | 申请破产 → 返回履历 |
| GET | `/resumes/:id` · `/users/:id/resumes` | 履历卡片（公开，可分享） |
| * | `/admin/events` | 定时事件增删查（需 `isAdmin`） |

WS 频道：`tick:` `kline:` `danmaku:` `event:` `broadcast` `user`（私有频道，鉴权后自动推送）。协议定义在 `packages/shared/src/protocol.ts`。

---

## 5. 已知限制 / 后续阶段

- **Ctrl+C 清理没有自动化验证**：`dev:embedded` 已改为在退出前等待 embedded-postgres 停止，但 Windows 下没法用脚本发 SIGINT，只验证了正常启动路径。
- 引擎是单实例设计（`ENGINE_ENABLED`），多实例下还没做 leader 选举。
- 排行榜（Redis ZSET + 周期结算）、Discord Bot 消费 `bot` topic、外部货币 HMAC 接口：留到**阶段四**。数据表和 `isExternal` 流水标记已经准备好。
- 种子里的 BTC 市场是 `HALTED`（只看行情、不能交易），因为它依赖外网。
