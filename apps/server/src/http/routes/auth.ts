import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Core } from '../../app.js';
import type { HttpEnv } from '../server.js';
import type { DiscordProfile } from '../../users/userService.js';

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Discord Embedded App 认证：
 *   前端 discordSdk.commands.authorize() 拿到 code → POST /auth/token
 *   后端用 client_secret 换 access_token，拉取 /users/@me，建档后签发会话 JWT。
 *   access_token 原样返回给前端，用于 discordSdk.commands.authenticate()。
 */
export const authRoutes =
  (core: Core, env: HttpEnv): FastifyPluginAsync =>
  async (app) => {
    app.post('/token', async (req, reply) => {
      const { code } = z.object({ code: z.string().min(1) }).parse(req.body);
      if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return reply.code(503).send({ error: 'error.oauthNotConfigured' });

      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
        }),
      });
      if (!tokenRes.ok) return reply.code(401).send({ error: 'error.oauthExchangeFailed' });
      const { access_token } = (await tokenRes.json()) as { access_token: string };

      const meRes = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${access_token}` } });
      if (!meRes.ok) return reply.code(401).send({ error: 'error.oauthProfileFailed' });
      const profile = (await meRes.json()) as DiscordProfile;

      const user = await core.users.ensureUser(profile);
      core.notifier.forgetName(user.id);
      const token = await reply.jwtSign({ sub: user.id });
      return { access_token, token, userId: user.id };
    });

    /** 仅开发环境：免 Discord 登录（DEV_LOGIN=1 且非 production） */
    app.post('/dev', async (req, reply) => {
      if (env.DEV_LOGIN !== '1' || env.NODE_ENV === 'production') return reply.code(404).send({ error: 'error.notFound' });
      const body = z.object({ userId: z.string().regex(/^\d{1,20}$/), username: z.string().min(1).max(32) }).parse(req.body);
      const user = await core.users.ensureUser({ id: body.userId, username: body.username });
      const token = await reply.jwtSign({ sub: user.id });
      return { token, userId: user.id };
    });
  };
