import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Core } from '../../app.js';
import { playerProfile } from '../../users/playerProfile.js';

/** 玩家主页（/api/v1/users/:id/profile）：排行榜里点头像打开，登录后可看任何玩家的五维数据 */
export const profileRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onRequest', app.authenticate);

    app.get('/:id/profile', async (req) => {
      const { id } = z.object({ id: z.string().regex(/^\d{1,32}$/) }).parse(req.params);
      return playerProfile(core.db, id, core.clock());
    });
  };
