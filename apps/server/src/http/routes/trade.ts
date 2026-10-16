import type { BankruptcyResume, Order } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Core } from '../../app.js';
import { fromDb, wire, wireOpt } from '../../lib/dec.js';
import { TradeError, toPositionView } from '../../trading/types.js';
import { closeBody, marginBody, placeOrderBody, tpslBody } from '../schemas.js';

function orderView(o: Order) {
  return {
    id: o.id,
    clientOrderId: o.clientOrderId,
    side: o.side,
    type: o.type,
    source: o.source,
    status: o.status,
    reduceOnly: o.reduceOnly,
    quantity: wire(fromDb(o.quantity)),
    leverage: wire(fromDb(o.leverage)),
    limitPrice: o.limitPrice ? wire(fromDb(o.limitPrice)) : null,
    fillPrice: o.fillPrice ? wire(fromDb(o.fillPrice)) : null,
    closedQuantity: wire(fromDb(o.closedQuantity)),
    openedQuantity: wire(fromDb(o.openedQuantity)),
    fee: wire(fromDb(o.fee)),
    realizedPnl: o.realizedPnl ? wire(fromDb(o.realizedPnl)) : null,
    realizedRoe: o.realizedRoe ? wire(fromDb(o.realizedRoe)) : null,
    rejectReason: o.rejectReason,
    createdAt: o.createdAt.getTime(),
    filledAt: o.filledAt?.getTime() ?? null,
  };
}

export function resumeView(r: BankruptcyResume) {
  return {
    id: r.id,
    userId: r.userId,
    generation: r.generation,
    startedAt: r.startedAt.getTime(),
    endedAt: r.endedAt.getTime(),
    survivedSeconds: Number(r.survivedSeconds),
    startingBalance: wire(fromDb(r.startingBalance)),
    peakNetWorth: wire(fromDb(r.peakNetWorth)),
    finalBalance: wire(fromDb(r.finalBalance)),
    debtWrittenOff: wire(fromDb(r.debtWrittenOff)),
    reliefGranted: wire(fromDb(r.reliefGranted)),
    bestTradeRoe: wireOpt(r.bestTradeRoe ? fromDb(r.bestTradeRoe) : null),
    bestTradePnl: wireOpt(r.bestTradePnl ? fromDb(r.bestTradePnl) : null),
    worstLiquidationLoss: wireOpt(r.worstLiquidationLoss ? fromDb(r.worstLiquidationLoss) : null),
    totalFeesPaid: wire(fromDb(r.totalFeesPaid)),
    totalVolume: wire(fromDb(r.totalVolume)),
    winRate: wire(fromDb(r.winRate)),
    closedTradeCount: r.closedTradeCount,
    liquidationCount: r.liquidationCount,
    deficitCount: r.deficitCount,
    avgLeverage: wire(fromDb(r.avgLeverage)),
    maxLeverageUsed: wire(fromDb(r.maxLeverageUsed)),
    titles: r.titles,
    stats: r.stats,
  };
}

export const tradeRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    // 公开：履历卡片可分享
    app.get<{ Params: { id: string } }>('/resumes/:id', async (req) => {
      const r = await core.db.bankruptcyResume.findUnique({ where: { id: req.params.id } });
      if (!r) throw new TradeError('error.notFound', 404);
      const user = await core.db.user.findUnique({ where: { id: r.userId }, select: { username: true, globalName: true, avatarHash: true } });
      return { ...resumeView(r), user };
    });
    app.get<{ Params: { userId: string } }>('/users/:userId/resumes', async (req) => {
      const rows = await core.db.bankruptcyResume.findMany({ where: { userId: req.params.userId }, orderBy: { generation: 'desc' }, take: 50 });
      return rows.map(resumeView);
    });

    await app.register(async (authed) => {
      authed.addHook('onRequest', authed.authenticate);

      authed.post('/orders', async (req, reply) => {
        const body = placeOrderBody.parse(req.body);
        if (body.type === 'LIMIT' && !body.limitPrice) throw new TradeError('error.invalidPrice');
        const result = await core.orders.placeOrder(req.user.sub, body);
        const code = result.kind === 'rejected' ? 422 : result.kind === 'resting' ? 202 : 200;
        return reply.code(code).send({ result: result.kind, reason: 'reason' in result ? result.reason : undefined, order: orderView(result.order) });
      });

      authed.delete<{ Params: { id: string } }>('/orders/:id', async (req) => {
        return orderView(await core.orders.cancelOrder(req.user.sub, req.params.id));
      });

      authed.get('/orders', async (req) => {
        const q = z.object({ status: z.enum(['PENDING', 'FILLED', 'CANCELLED', 'REJECTED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
        const rows = await core.db.order.findMany({
          where: { userId: req.user.sub, ...(q.status ? { status: q.status } : {}) },
          orderBy: { createdAt: 'desc' },
          take: q.limit,
          include: { market: { select: { code: true } } },
        });
        return rows.map((o) => ({ ...orderView(o), market: o.market.code }));
      });

      authed.post<{ Params: { code: string } }>('/positions/:code/close', async (req, reply) => {
        const { quantity } = closeBody.parse(req.body ?? {});
        const result = await core.orders.closePosition(req.user.sub, req.params.code, quantity);
        return reply.code(result.kind === 'rejected' ? 422 : 200).send({ result: result.kind, order: orderView(result.order) });
      });

      authed.patch<{ Params: { code: string } }>('/positions/:code/tpsl', async (req) => {
        const body = tpslBody.parse(req.body);
        const { position, warning } = await core.orders.setTpSl(req.user.sub, req.params.code, body.takeProfitPrice, body.stopLossPrice);
        return { position: toPositionView(position, req.params.code.toUpperCase()), warning };
      });

      authed.post<{ Params: { code: string } }>('/positions/:code/margin', async (req) => {
        const { amount } = marginBody.parse(req.body);
        const position = await core.orders.addMargin(req.user.sub, req.params.code, amount);
        return { position: toPositionView(position, req.params.code.toUpperCase()) };
      });

      authed.get('/positions/history', async (req) => {
        const rows = await core.db.position.findMany({
          where: { userId: req.user.sub, status: { not: 'OPEN' } },
          orderBy: { closedAt: 'desc' },
          take: 50,
          include: { market: { select: { code: true } }, liquidation: true },
        });
        return rows.map((p) => ({
          ...toPositionView(p, p.market.code),
          status: p.status,
          exitPrice: p.exitPrice ? wire(fromDb(p.exitPrice)) : null,
          closedAt: p.closedAt?.getTime() ?? null,
          deficit: p.liquidation ? wire(fromDb(p.liquidation.deficit)) : null,
        }));
      });

      authed.post('/bankruptcy', async (req) => {
        const resume = await core.bankruptcy.declare(req.user.sub);
        return resumeView(resume);
      });
    });
  };
