import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Core } from '../../app.js';

/**
 * 24 小时动态（/api/v1/broadcasts/...）：
 *   GET  /feed?hours=24      最近的全服播报 + 👍 / 👎 汇总（带登录态时附上自己的票）
 *   POST /:id/reaction       { value: 1 | -1 | 0 }，0 = 撤回
 */
export const feedRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    app.get('/feed', async (req) => {
      const { hours } = z.object({ hours: z.coerce.number().int().min(1).max(24).default(24) }).parse(req.query);
      let viewer: string | undefined;
      if (req.headers.authorization) {
        try {
          viewer = (await req.jwtVerify<{ sub: string }>()).sub;
        } catch {
          /* 未登录也能看，只是没有“我投的票” */
        }
      }
      return core.reactions.feed(hours, viewer, (id) => core.markets.get(id)?.code, core.clock());
    });

    await app.register(async (authed) => {
      authed.addHook('onRequest', authed.authenticate);
      authed.post('/:id/reaction', async (req) => {
        const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
        const { value } = z.object({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }).parse(req.body);
        return core.reactions.react(id, req.user.sub, value);
      });
    });
  };
