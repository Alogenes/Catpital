# Catpital · 阶段四：Discord Bot、全服播报、榜单结算与外部货币接口

> 状态：✅ 代码完成，测试通过（shared 21 · server 89 · web 14）
> ⚠️ 尚未连接真实 Discord：需要你在开发者后台拿到 **Bot Token** 后按 §1 启动。斜杠命令、Embed、播报路由都已经用离线测试覆盖。

---

## 0. 实现思路

| 模块 | 思路 |
|---|---|
| Bot 进程 | **与 API 同进程**（`DISCORD_BOT_TOKEN` 有值才启动）。直接调用核心服务，不需要再写一层 HTTP；播报走现有的事件总线 `bot` topic。以后要拆成独立进程，把总线换成 RedisBus 即可 |
| 斜杠命令 | 处理函数只接收一个与 discord.js 无关的 `CommandContext`、返回回复内容 → 可以离线测试。Bot 层负责：先 `deferReply`（避免 3 秒超时），再 `editReply` |
| `/launch` | 发送欢迎 Embed + 主题横幅（内置 SVG → resvg 光栅化成 PNG，无外部图片）+「🚀 进入交易大厅」按钮；点击按钮 → `interaction.launchActivity()`，在 Discord 内打开阶段三的前端 |
| 频道播报 | `BroadcastMessenger` 订阅引擎播报 → 按服务器语言生成 Embed → 串行发送到各服务器配置的频道。卡片里 @玩家 **不会真的 ping 人**，只有「本期股神」会提醒获奖者本人 |
| 榜单结算 | `node-cron`（UTC）：日榜每天 00:00:05、周榜每周一 00:00:10、月榜每月 1 日 00:00:15。启动时会补结算错过的上一期；已结算的周期会自动跳过（幂等） |
| 外部货币 | `POST /api/v1/economy/deposit|withdraw`，HMAC-SHA256 签名 + 时间戳 + 一次性 nonce；`(接入方, externalRef)` 唯一 → 重试不会重复入账 |

### 防刷：外部资金如何被剔除
需求里写的是 `Type: EXTERNAL_TRANSFER`。本项目从阶段一起就把外部资金细分为 `EXTERNAL_DEPOSIT` / `EXTERNAL_WITHDRAW`，并在每条流水上标记 `isExternal = true`。**排行榜只看 `isExternal` 标记**，因此效果完全等同。同样标记为外部资金的还有：初始资金、破产抹债和救济金、本阶段新增的**榜单奖金**。

测试实录：期初 1 万的玩家中途充值 100 万 → 收益率榜 **0%**（不是 +10000%），富豪榜第一（富豪榜本来就是比谁钱多）。

---

## 1. 上线步骤

1. **开发者后台**（Application ID `1560322898856640664`）
   - Bot 页：生成 Token，填入 `.env` 的 `DISCORD_BOT_TOKEN`（**不要提交**）
   - OAuth2 → URL Generator：勾选 `bot` + `applications.commands`，Bot 权限至少给 `Send Messages`、`Embed Links`、`Attach Files`，用生成的链接把 Bot 邀请进服务器
   - Activities：启用，并配置 URL Mappings（`/api`、`/ws`、`/discord-cdn`、`/`，见阶段一 §2.2）
2. **注册斜杠命令**
   ```bash
   pnpm --filter @catpital/server discord:register --guild <你的服务器ID>
   ```
   按服务器注册会立即生效；`--global` 全局注册需要几分钟传播，脚本会保留 Discord 自动生成的 Activity 入口命令。
3. **启动**：`pnpm dev:server`（检测到 Token 会自动连上 Discord）
4. 在想接收播报的频道执行 `/admin_set_channel`

---

## 2. 目录补充（`apps/server`）

```
src/discord/
  bot.ts             discord.js Client：命令路由、按钮 → launchActivity、自动补全、错误兜底
  commands.ts        5 个命令的定义（含中文本地化）+ 与 discord.js 无关的处理逻辑
  embeds.ts          所有卡片构建（纯函数）：launch / wallet / leaderboard / 6 种播报
  messageService.ts  BroadcastMessenger：总线 → 各服务器频道
  banner.ts          主题横幅（SVG → PNG，缓存）
  i18n.ts            Bot 文案（中 / 英），含毒舌版破产称号与限定称号名
  format.ts parse.ts 金额格式化（Decimal）/ time_delay、price_jump 解析
src/leaderboard/settlement.ts   周期结算 + 发奖 + 称号 + 冠军播报
src/economy/hmac.ts             签名规范、常量时间比较、密钥 AES-256-GCM 加密
src/economy/economyService.ts   充值 / 提现（幂等、行锁）
src/http/routes/economy.ts      路由 + 鉴权（保留原始请求体用于验签）
scripts/register-commands.ts    注册斜杠命令（按服务器 / 全局）
scripts/create-api-client.ts    创建接入方，打印一次性密钥
scripts/economy-client-example.ts  其它 Bot 的接入示例（可直接复制）
prisma/migrations/*_phase4_rewards_badges   LEADERBOARD_REWARD 流水、users.badges、CHAMPION 播报
```

---

## 3. 斜杠命令

| 命令 | 说明 |
|---|---|
| `/launch` | 欢迎卡片：主题横幅、各市场现价与涨跌、「🚀 进入交易大厅」按钮 |
| `/wallet [public]` | 总净值、可用余额、第 N 世、持仓数、**🧬 轮回天赋**；默认只有自己可见 |
| `/leaderboard [period] [board]` | 日 / 周 / 月 × 收益率榜 / 富豪榜，前 10 名带奖牌；不在前 10 名时额外显示自己的名次 |
| `/admin_schedule_event` | 参数：`market`（带自动补全）、`time_delay`（`30s`/`5m`/`1h30m`）、`price_jump`（`-30%`/`+50%`/`0.25`）、`news_title`、`news_content`，可选 `duration`。写入 `ScheduledEvent`，到点由行情引擎触发 |
| `/admin_set_channel [channel]` | 设置本服务器的播报频道 |

**「轮回天赋」**：原需求里没有定义这个概念。我把它实现为两部分：
- 登上榜首获得的**限定称号**（👑 日榜股神 / 周榜首富 …）；
- **历世破产称号**（🪦 十分钟速通破产 …）。

如果你有别的设定（比如真正影响游戏的天赋加成），告诉我再改。

**管理员判定**，满足任一即可：在服务器拥有「管理服务器」权限 / 数据库里 `isAdmin` / 角色在 `GuildConfig.adminRoleIds` 中。管理员命令默认对普通成员隐藏。

---

## 4. 频道播报卡片

| 事件 | 颜色 | 文案示例 |
|---|---|---|
| 暴富高光 `BIG_WIN` | 薄荷绿 | 🚀 巨鲸出没！@玩家 在 **MEOW** 暴赚 **+50,000.00**！ |
| 大单拉盘 / 砸盘 `WHALE` | 绿 / 红 | 🐋 大单拉盘！@玩家 一单把 **WOOF** 拉盘 **+1.20%** |
| 斩杀 `LIQUIDATION` | 血红 | ⚡ 惨绝人寰！@玩家 的 **MEOW** 50x 做空被无情斩杀，瞬间蒸发 **12,000.00** 本金！ |
| 穿仓 `DEFICIT` | 血红 | 🩸 穿仓了！…还倒欠 **2,783.01**，余额跌到 **-2,764.20**！ |
| 破产讣告 `BANKRUPTCY` | 哀悼黑 | ⚰️ 讣告 · 生卒时间、享年；大字称号「百倍杠杆做慈善」；巅峰资产 / 最惨败局 / 手续费 / 胜率 / 平仓与被斩次数 / 抹平负债；页脚：愿天堂没有强平 🕯️ |
| 金融快讯 `MARKET_EVENT` | 警示黄 | 📰 突发 \| MEOW · 标题 · 正文 · 跳空 **-30.00%**：100 → 70 |
| 本期股神 `CHAMPION` | 金 | 👑 本期股神 · 周榜收益率榜 —— 奖金已到账，获得限定称号「周榜股神」 |

每个服务器可以通过 `GuildConfig.broadcastToggles` 单独关闭某类播报，例如 `{"WHALE": false}`。

---

## 5. 外部货币接口

```bash
# 1) 生成主密钥填入 API_SECRET_KEY；2) 为每个外部 Bot 创建接入方
pnpm --filter @catpital/server api-client:create "签到Bot" deposit,withdraw
```

**签名**：`hex(HMAC-SHA256(secret, timestamp \n nonce \n POST \n /api/v1/economy/deposit \n rawBody))`

| 请求头 | 说明 |
|---|---|
| `X-Catpital-Client` | 接入方 ID |
| `X-Catpital-Timestamp` | Unix 秒，偏差不超过 ±300 秒 |
| `X-Catpital-Nonce` | 16–64 位随机串，只能用一次 |
| `X-Catpital-Signature` | 上面计算出的签名 |

**请求体**：`{ "userId": "<Discord UID>", "amount": "100.5", "externalRef": "你方流水号", "memo": "可选" }`
金额**必须是字符串**，JSON number 一律拒绝。

| 规则 | |
|---|---|
| 充值 | 玩家没玩过会自动建档（占位昵称，首次登录后更新） |
| 提现 | 只能动用可用余额：逐仓保证金和挂单冻结不可提，余额不会被提成负数 |
| 幂等 | 同一 `externalRef` 重试返回首次结果（`duplicate: true`）；拿它去做反方向操作会返回 409 |
| 接入方权限 | 每个接入方单独授权 `deposit` / `withdraw` |

参考实现：`scripts/economy-client-example.ts`，可直接复制到其它 Bot 里使用。

---

## 6. 测试覆盖（本阶段新增 30 个）

| 测试文件 | 用例数 | 内容 |
|---|---|---|
| `economy.integration` | 7 | 6 类鉴权失败、幂等、自动建档、提现不碰保证金、方向冲突、拒绝浮点数 |
| `settlement.integration` | 3 | 防刷排名、发奖与称号、冠军播报、幂等、新一期衔接，以及**奖金不算下一期收益**（这条测试抓到过一个真实 bug，已修复） |
| `discord.units` | 12 | 解析器、全部播报卡片、/launch 横幅与按钮、钱包、榜单 |
| `discord.integration` | 8 | 命令注册定义、/wallet /leaderboard /launch、管理员权限与校验、真实排期、自动补全，以及从真实斩杀 / 穿仓 / 破产到频道消息的完整链路、播报开关 |
