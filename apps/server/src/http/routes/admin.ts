import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Core } from '../../app.js';
import { fromDb, wire } from '../../lib/dec.js';
import { scheduledEventInput } from '../../market/events/eventScheduler.js';
import { TradeError } from '../../trading/types.js';

/** 管理员接口（阶段四的 /schedule_event 斜杠命令也调用同一个 EventScheduler.create） */
export const adminRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onRequest', app.authenticate);
    app.addHook('preHandler', app.requireAdmin);

    app.post('/events', async (req, reply) => {
      const input = scheduledEventInput.parse(req.body);
      if (!core.markets.byCode(input.market)) throw new TradeError('error.marketNotFound', 404);
      const ev = await core.events.create(input, 'DASHBOARD', req.user.sub);
      return reply.code(201).send({ id: ev.id, status: ev.status, triggerAt: ev.triggerAt.getTime() });
    });

    app.get('/events', async (req) => {
      const q = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional() }).parse(req.query);
      const rows = await core.db.scheduledEvent.findMany({
        where: q.status ? { status: q.status } : {},
        orderBy: { triggerAt: 'desc' },
        take: 100,
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
      }));
    });

    app.delete<{ Params: { id: string } }>('/events/:id', async (req, reply) => {
      const ok = await core.events.cancel(req.params.id);
      if (!ok) throw new TradeError('error.eventNotPending', 409);
      return reply.code(204).send();
    });
  };
