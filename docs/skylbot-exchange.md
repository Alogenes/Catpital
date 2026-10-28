# Skylbot ⇄ Catpital 货币兑换

玩家在 Catpital 里点「可用余额」打开商店，用 Skylbot 的 **Bolívares** 1:1 兑换 **Meuw Coin**，也可以兑回去。
破产冷却期间（24 小时只能破产一次），这也是重新拿到本金的正规途径。

## 配置

Catpital 直接调用 Skylbot `main.py` 里已有的接口，Skylbot 不需要改代码：

| 用途 | Skylbot 接口 |
|---|---|
| 查余额 | `GET /api/balance/<user_id>` |
| 充值（扣 Bolívares） | `POST /api/balance/withdraw` `{"user_id", "amount"}` |
| 兑回（加 Bolívares） | `POST /api/balance/deposit` `{"user_id", "amount"}` |

在 Catpital 的 `.env`（Docker 部署是 `deploy/.env`）里加一行：

```dotenv
SKYLBOT_API_URL=http://127.0.0.1:5000
```

Catpital 用 Docker、Skylbot 直接跑在宿主机上时填 `http://host.docker.internal:5000`（compose 里已经配好）。
不填时商店显示「兑换服务暂未开放」。

## 结果不确定时怎么办

Skylbot 的接口没有请求编号，同一个请求发两次就会扣两次钱，所以 Catpital **从不自动重试**：

| 情况 | 处理 |
|---|---|
| 正常返回 | 两边同时变动 |
| Bolívares 不够 | 下单前先查余额，不够直接拒绝；Skylbot 返回「Saldo insuficiente」也一样 |
| 兑回时 Skylbot 报错 | 把扣掉的 Meuw Coin 退回 |
| 超时 / 断线 | 回读一次 Skylbot 余额：正好变动了这笔金额 → 视为成功；没变 → 视为失败；对不上（玩家同时在 Skylbot 里花钱）→ 标记「待核对」 |

「待核对」的兑换出现在管理面板「兑换」页，管理员到 Skylbot 确认钱动没动以后，点「已到账」或「未到账」，系统自动补发或退回。

## ⚠ 部署前必须处理

`main.py` 的这些接口**没有任何鉴权**，Flask 又监听在 `0.0.0.0:5000`。任何能连上这个端口的人都可以：

- 调 `/api/balance/deposit` 给自己加任意多的 Bolívares，**再到 Catpital 兑成 Meuw Coin**；
- 调 `/api/all_users` 读取所有玩家数据；
- 用 `/api/gacha/pull/<id>` 替任何人抽卡、花光他们的钱。

至少要做一项：

1. Catpital 和 Skylbot 在同一台机器上：把 `app.run(host="0.0.0.0", ...)` 改成 `host="127.0.0.1"`
   （Catpital 用 Docker 时改用防火墙只放行 Docker 网段）；
2. 用防火墙 / 云安全组挡住 5000 端口，只允许 Catpital 所在的机器访问；
3. 给这几个接口加一个共享密钥校验（例如检查请求头里的 token）。
