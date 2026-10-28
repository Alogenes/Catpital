import { canDeclareBankruptcy, netWorth } from '@catpital/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { PanelAccess } from '../../admin/panelAccess.js';
import type { Core } from '../../app.js';
import { fromDb, wire } from '../../lib/dec.js';
import { toPositionView } from '../../trading/types.js';
import { userSettingsSchema } from '../../users/userService.js';

export const meRoutes =
  (core: Core, panel?: PanelAccess): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onRequest', app.authenticate);

    /** 首屏聚合：用户、钱包、净值、全部持仓、挂单、破产资格 */
    app.get('/', async (req) => {
      const userId = req.user.sub;
      const [user, wallet, positions, orders, life, cooldown] = await Promise.all([
        core.db.user.findUniqueOrThrow({ where: { id: userId } }),
        core.db.wallet.findUniqueOrThrow({ where: { userId } }),
        core.db.position.findMany({ where: { userId, status: 'OPEN' }, include: { market: { select: { code: true } } } }),
        core.db.order.findMany({ where: { userId, status: 'PENDING' }, include: { market: { select: { code: true } } } }),
        core.db.life.findFirst({ where: { userId, status: 'ACTIVE' } }),
        core.bankruptcy.cooldownUntil(userId),
      ]);
      const balance = fromDb(wallet.balance);
      const locked = fromDb(wallet.locked);
      const nw = netWorth({
        balance,
        locked,
        positions: positions.map((p) => ({
          side: p.side,
          quantity: fromDb(p.quantity),
          entryPrice: fromDb(p.entryPrice),
          margin: fromDb(p.margin),
          markPrice: core.markets.price(p.marketId) ?? fromDb(p.entryPrice),
        })),
      });
      return {
        user: {
          id: user.id,
          username: user.username,
          globalName: user.globalName,
          avatarHash: user.avatarHash,
          locale: user.locale,
          isAdmin: user.isAdmin,
          generation: user.generation,
          settings: user.settings,
          // 只对白名单里的人出现；其他人的响应里没有这个字段
          ...(panel?.allows(user) ? { panel: true } : {}),
        },
        wallet: { balance: wire(balance), locked: wire(locked), netWorth: wire(nw) },
        life: life && {
          generation: life.generation,
          startedAt: life.startedAt.getTime(),
          peakNetWorth: wire(fromDb(life.peakNetWorth)),
        },
        positions: positions.map((p) => toPositionView(p, p.market.code)),
        orders: orders.map((o) => ({
          id: o.id,
          market: o.market.code,
          side: o.side,
          type: o.type,
          quantity: wire(fromDb(o.quantity)),
          limitPrice: o.limitPrice ? wire(fromDb(o.limitPrice)) : null,
          leverage: wire(fromDb(o.leverage)),
          reduceOnly: o.reduceOnly,
          lockedAmount: wire(fromDb(o.lockedAmount)),
          createdAt: o.createdAt.getTime(),
        })),
        bankruptcyAvailable: canDeclareBankruptcy({
          balance,
          openPositionCount: positions.length,
          pendingOrderCount: orders.length,
          dustThreshold: core.economy.BANKRUPTCY_DUST_THRESHOLD,
        }),
        /** 破产冷却到期时间（毫秒时间戳）；不在冷却中为 null */
        bankruptcyCooldownUntil: cooldown?.getTime() ?? null,
      };
    });

    app.put('/settings', async (req) => {
      const user = await core.users.updateSettings(req.user.sub, userSettingsSchema.parse(req.body));
      return { settings: user.settings };
    });

    app.get('/ledger', async (req) => {
      const rows = await core.db.ledgerEntry.findMany({
        where: { userId: req.user.sub },
        orderBy: { id: 'desc' },
        take: 100,
      });
      return rows.map((r) => ({
        id: r.id.toString(),
        type: r.type,
        amount: wire(fromDb(r.amount)),
        balanceAfter: wire(fromDb(r.balanceAfter)),
        marketId: r.marketId,
        memo: r.memo,
        createdAt: r.createdAt.getTime(),
      }));
    });
  };
