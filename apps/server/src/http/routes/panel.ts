import { D } from '@catpital/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PanelAccess } from '../../admin/panelAccess.js';
import type { Core } from '../../app.js';
import { fromDb, wire } from '../../lib/dec.js';
import { TradeError } from '../../trading/types.js';

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const positiveDecimal = z.string().regex(/^\d+(\.\d+)?$/);

const eventBody = z
  .object({
    market: z.string().min(1),
    direction: z.enum(['UP', 'DOWN']),
    /** 瞬间跳空幅度，百分数（"30" = 30%）；0 = 不跳空，只改波动 / 趋势 */
    gapPct: positiveDecimal,
    /** 波动放大倍数 */
    volMultiplier: positiveDecimal.refine((v) => D(v).gte(0.1) && D(v).lte(50), 'volMultiplier 0.1–50'),
    /** 趋势强度（年化漂移，方向随 direction） */
    trend: positiveDecimal.refine((v) => D(v).lte(1000), 'trend ≤ 1000').default('0'),
    delaySec: z.number().int().min(0).max(30 * 86400),
    durationSec: z.number().int().min(0).max(7 * 86400),
    /** 留空 = 静默事件：照常跳空，但不出现在快讯 / 频道播报里 */
    headline: z.string().trim().max(200).default(''),
    content: z.string().trim().max(2000).default(''),
  })
  .refine((b) => b.direction === 'UP' || D(b.gapPct).lt(100), { message: 'gapPct must be < 100 when DOWN', path: ['gapPct'] });

const userId = z.string().regex(/^\d{5,25}$/);

/**
 * 临时管理面板（/api/v1/panel）。只有 ADMIN_PANEL_USERS 里 UID + 用户名都匹配的人能访问；
 * 其他人（包括未登录）一律得到与不存在的路由完全相同的 404。
 */
export const panelRoutes =
  (core: Core, access: PanelAccess): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onRequest', async (req, reply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.callNotFound();
      }
      const user = await core.db.user.findUnique({ where: { id: req.user.sub }, select: { id: true, username: true } });
      if (!access.allows(user)) return reply.callNotFound();
    });

    // ---------------------------------------------------------------- 事件
    app.get('/events', async () => {
      const rows = await core.db.scheduledEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { market: { select: { code: true } } },
      });
      return rows.map((e) => ({
        id: e.id,
        market: e.market.code,
        triggerAt: e.triggerAt.getTime(),
        headline: e.headline,
        gapPercent: wire(fromDb(e.gapPercent)),
        driftAdjust: wire(fromDb(e.driftAdjust)),
        volMultiplier: wire(fromDb(e.volMultiplier)),
        durationSec: e.durationSec,
        status: e.status,
        source: e.source,
        priceBefore: e.priceBefore ? wire(fromDb(e.priceBefore)) : null,
        priceAfter: e.priceAfter ? wire(fromDb(e.priceAfter)) : null,
      }));
    });

    app.post('/events', async (req, reply) => {
      const b = eventBody.parse(req.body);
      const market = core.markets.byCode(b.market.toUpperCase());
      if (!market) throw new TradeError('error.marketNotFound', 404);
      const sign = b.direction === 'UP' ? 1 : -1;
      const ev = await core.events.create(
        {
          market: market.code,
          triggerAt: new Date(Date.now() + b.delaySec * 1000),
          headline: b.headline,
          content: b.content,
          i18n: {},
          gapPercent: D(b.gapPct).div(100).mul(sign).toFixed(),
          driftAdjust: D(b.trend).mul(sign).toFixed(),
          volMultiplier: b.volMultiplier,
          durationSec: b.durationSec,
        },
        'DASHBOARD',
        req.user.sub,
      );
      return reply.code(201).send({ id: ev.id, triggerAt: ev.triggerAt.getTime() });
    });

    /** 待触发的事件 → 取消；进行中的事件 → 立即结束（撤掉趋势和波动放大） */
    app.delete<{ Params: { id: string } }>('/events/:id', async (req, reply) => {
      const done = (await core.events.cancel(req.params.id)) || (await core.events.endNow(req.params.id));
      if (!done) throw new TradeError('error.eventNotPending', 409);
      return reply.code(204).send();
    });

    // ---------------------------------------------------------------- 市场定价
    app.get('/markets', async () => core.admin.listMarkets());

    app.post<{ Params: { code: string } }>('/markets/:code/price', async (req) => {
      const b = z
        .object({
          price: positiveDecimal.refine((v) => D(v).gt(0), 'price must be > 0'),
          /** 同时把均值回归锚点改成新价格（仅程序随机市场） */
          anchor: z.boolean().default(true),
        })
        .parse(req.body);
      const result = await core.admin.setMarketPrice(req.params.code.toUpperCase(), D(b.price), b.anchor);
      req.log.info({ admin: req.user.sub, ...result }, 'admin set market price');
      return result;
    });

    app.post<{ Params: { code: string } }>('/markets/:code/clear-history', async (req) => {
      const b = z
        .object({ candles: z.boolean().default(true), news: z.boolean().default(false) })
        .refine((x) => x.candles || x.news, 'nothing to clear')
        .parse(req.body);
      const result = await core.admin.clearMarketHistory(req.params.code.toUpperCase(), b);
      req.log.info({ admin: req.user.sub, ...result }, 'admin cleared market history');
      return result;
    });

    // ---------------------------------------------------------------- Skylbot 兑换核对
    /** 结果不确定（Skylbot 超时且余额对不上）的兑换，等管理员到 Skylbot 核对后处理 */
    app.get('/exchanges/pending', async () => core.exchange.listPending());

    app.post<{ Params: { id: string } }>('/exchanges/:id/resolve', async (req) => {
      const b = z.object({ applied: z.boolean() }).parse(req.body);
      const r = await core.exchange.resolve(req.params.id, b.applied);
      req.log.info({ admin: req.user.sub, ...r, applied: b.applied }, 'admin resolved skylbot exchange');
      return r;
    });

    // ---------------------------------------------------------------- 用户
    app.get('/users', async (req) => {
      const q = z.object({ q: z.string().trim().max(64).default('') }).parse(req.query);
      return core.admin.listUsers(q.q);
    });

    app.get<{ Params: { id: string } }>('/users/:id', async (req) => core.admin.getUser(userId.parse(req.params.id)));

    app.post('/users', async (req, reply) => {
      const b = z
        .object({ id: userId, username: z.string().trim().min(1).max(32), balance: positiveDecimal.optional() })
        .parse(req.body);
      const user = await core.admin.createUser({ id: b.id, username: b.username, balance: b.balance ? D(b.balance) : undefined }, req.user.sub);
      return reply.code(201).send(user);
    });

    app.post<{ Params: { id: string } }>('/users/:id/balance', async (req) => {
      const b = z
        .object({ mode: z.enum(['add', 'set']), amount: decimal, memo: z.string().trim().max(120).optional() })
        .refine((x) => x.mode === 'add' || D(x.amount).gte(0), { message: 'set amount must be ≥ 0', path: ['amount'] })
        .parse(req.body);
      const amount = D(b.amount);
      return core.admin.adjustBalance(userId.parse(req.params.id), b.mode === 'set' ? { setTo: amount } : { delta: amount }, req.user.sub, b.memo);
    });

    app.post<{ Params: { id: string; market: string } }>('/users/:id/positions/:market/close', async (req) => {
      await core.orders.closePosition(userId.parse(req.params.id), req.params.market.toUpperCase());
      return { ok: true };
    });

    app.delete<{ Params: { id: string; orderId: string } }>('/users/:id/orders/:orderId', async (req, reply) => {
      await core.orders.cancelOrder(userId.parse(req.params.id), req.params.orderId);
      return reply.code(204).send();
    });

    app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
      const id = userId.parse(req.params.id);
      if (id === req.user.sub) throw new TradeError('error.forbidden', 403);
      await core.admin.deleteUser(id);
      return reply.code(204).send();
    });
  };
