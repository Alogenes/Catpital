# Catpital · 阶段三：前端看盘与交互界面

> 状态：✅ 已完成，并在浏览器里跑通了完整流程
> - `tsc --noEmit` 无错误；`vite build` 成功（拆成 7 个 chunk，最大的 charts 162 kB / gzip 52 kB）
> - 前端测试 6 个通过（含"所有语言包 key 一致"和"后端每个错误码都有翻译"两项守卫）
> - 浏览器实测：登录 → 50x 开多 → 设置止盈止损（图上四条线）→ 定时事件 −30% 跳空 → **穿仓特效 + 全服播报 + 余额 −77,328.99** → 申请破产 → 人生履历卡 → 第二世 5,000 → 发弹幕 → 切换英文
> - 页面所有请求都是同源的 `/.proxy/*`，没有外部域名

---

## 1. 启动

```bash
pnpm dev:server    # 终端 1：后端 + embedded Postgres（:3001）
pnpm dev:web       # 终端 2：前端（:5173）
```

浏览器打开 `http://localhost:5173`，会显示**本地调试登录**（URL 里没有 Discord 的 `frame_id`）。在 Discord 内运行时自动走 Embedded App SDK 鉴权。

接入 Discord 需要在 `.env` 里填 `VITE_DISCORD_CLIENT_ID`、`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`，并在 Developer Portal 配好 URL Mapping（见阶段一 §2.2，**本阶段新增了 `/discord-cdn → cdn.discordapp.com`**）。

---

## 2. 目录（`apps/web/src`）

```
lib/
  endpoints.ts      唯一 URL 出口：apiUrl / wsUrl / cdnUrl（全部 /.proxy/*）
  api.ts            fetch 封装 + 响应类型（金额全是 string）
  ws.ts             自动重连 + 重新鉴权 + 恢复订阅 + 心跳
  discord.ts        SDK ready → authorize → /auth/token → authenticate；开发登录
  format.ts         Decimal 格式化（千分位、正负号、百分比、输入清洗）
  sound.ts          WebAudio 实时合成的 9 种音效 + 生成式 Lo-fi BGM（零音频文件）
  danmakuLanes.ts   弹幕轨道分配
realtime/bridge.ts  WS 消息 → stores / 特效 / 音效 / toast；K 线走独立事件总线
stores/             zustand：session · markets · settings · feed
i18n/               import.meta.glob 自动加载 locales/<lang>/*.json
components/
  chart/            PriceChart（K线/分时/面积 + 价格线）· DanmakuLayer · ChartPanel
  trade/            OrderPanel · PositionsPanel · OrdersPanel
  social/           BroadcastBanner · Toasts · NewsFeed · DanmakuInput
  fx/FxLayer.tsx    暴富 / 斩杀 / 穿仓 / 破产 全屏特效
  bankruptcy/       破产申请条 · 人生履历卡
  settings/         语言、VFX、BGM、SFX、弹幕、红涨绿跌、音量
```

---

## 3. 功能对照

| 需求 | 实现 |
|---|---|
| 切换图表类型、周期 | K线 / 分时 / 面积 × 1m/5m/15m/1h/1D；历史数据走 REST，未收盘 K 线由 WS 实时 `update` |
| 均价线、TP/SL、斩杀线 | 四条价格线，斩杀线是 3px 红色实线并带 ☠ 标记。自定义了 `autoscaleInfoProvider`，**斩杀线离现价再远也会留在视野内** |
| 同股市弹幕 | Web Animations API 从右往左飘；按估算文字宽度分配轨道，轨道全满时丢弃；自己发的弹幕带金边。服务端会做清洗和限流 |
| 全服播报 | 顶部胶囊横幅排队轮播，五种样式；穿仓和破产停留 7 秒并闪烁 |
| 高光 / 斩杀 / 破产特效 | 暴富：金币彩带 Canvas + 金色大字；斩杀：白闪 + 刀光 SVG + 屏幕震动 + 血色暗角；穿仓：额外有血幕下坠；破产：黑屏 + 印章。优先级为 破产 > 穿仓 > 斩杀 > 暴富 |
| 音效 / BGM | 全部由 WebAudio 实时合成，没有外部资源，不受 CSP 限制；首次点击后解锁（浏览器自动播放策略） |
| 下单面板 | 现货（买入 / 只减仓的卖出）和杠杆（做多 / 做空）；市价 / 限价；25–100% 快捷数量；杠杆滑块；TP/SL。保证金、手续费、**预估斩杀线**用的是 `@catpital/shared` 里和后端**同一份**公式；资金不足时按钮直接置灰 |
| 持仓卡片 | 实时浮盈和收益率、距斩杀线进度条（小于 3% 时卡片变红）、一键平仓 / 平一半 / 追加保证金 / 修改止盈止损 |
| 国际化 | 新建 `locales/ja-JP/translation.json`（带 `_meta.name`）就会自动出现在语言下拉框里，**不用改代码**。缺失的 key 回退到 zh-CN |
| 偏好持久化 | 本地 localStorage + 云端 `PUT /me/settings`（800ms 防抖），登录时以云端为准 |
| 红涨绿跌 | 中文默认红涨，其他语言默认绿涨；通过 CSS 变量切换，图表同步换色 |

### 精度
前端所有金额计算（净值、浮盈、预估保证金、斩杀线、最大可开数量）都用 Decimal。**唯一**转成 JS number 的地方是 `PriceChart.tsx` 的 `toChartNum()`：lightweight-charts 的 API 只接受 number，转换结果只用来画图。

---

## 4. 实测中发现并已修复的问题

1. **斩杀线看不见**：图表默认只按 K 线自动缩放 → 加了 `autoscaleInfoProvider`，把 TP/SL/斩杀线纳入可视范围。
2. **特效层错位**：屏幕震动给 `#root` 加了 `transform`，导致里面 `position:fixed` 的特效层相对 `#root` 定位 → 改为只震动主布局容器。
3. **负债时下单按钮仍可点**：加上了和后端一致的资金校验，按钮直接显示"可用余额不足"。
4. **展示舍入**：`fmt()` 原本沿用引擎的银行家舍入（1.005 → 1.00）→ 展示层改为四舍五入。
5. **外部域名**：头像改走 `/.proxy/discord-cdn`；图表上的 TradingView 徽标是外链，已关闭，署名改为文字放在设置页（符合 Apache-2.0 NOTICE 要求）。
6. **语言包缺 key**：守卫测试发现 5 个后端错误码没有翻译，已补齐。

## 5. 已知限制

- **还没有在真实 Discord 客户端里跑过**：需要你的 Application ID、Secret 和 URL Mapping。SDK 调用已对照 2.5.0 的类型定义核实。
- 本地调试登录的 token 只存在内存里，刷新页面要重新点"进入"（Discord 内每次启动都会重新鉴权，不受影响）。
- 窄屏（手机端 Discord）下是上下堆叠布局，能用，但没有专门做移动端交互优化。
- 后台任务停止时子进程不会自动退出（Windows 不传信号）；在真实终端里按 Ctrl+C 可以正常清理。
