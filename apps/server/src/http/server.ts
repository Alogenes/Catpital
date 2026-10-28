import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { Prisma } from '@prisma/client';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Core } from '../app.js';
import type { Env } from '../config/env.js';
import { TradeError } from '../trading/types.js';
import { registerWsGateway } from '../ws/gateway.js';
import { isOwner } from '../admin/owner.js';
import { PanelAccess } from '../admin/panelAccess.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { economyRoutes } from './routes/economy.js';
import { exchangeRoutes } from './routes/exchange.js';
import { marketRoutes } from './routes/market.js';
import { meRoutes } from './routes/me.js';
import { panelRoutes } from './routes/panel.js';
import { tradeRoutes } from './routes/trade.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export type HttpEnv = Pick<
  Env,
  'API_BASE_PATH' | 'WS_PATH' | 'JWT_SECRET' | 'DISCORD_CLIENT_ID' | 'DISCORD_CLIENT_SECRET' | 'DEV_LOGIN' | 'NODE_ENV' | 'DANMAKU_COOLDOWN_MS'
> &
  Partial<Pick<Env, 'API_SECRET_KEY' | 'HMAC_MAX_SKEW_SECONDS' | 'ADMIN_PANEL_USERS'>>;

export async function buildServer(core: Core, env: HttpEnv) {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
  });

  // Discord Activity 内为同源（/.proxy 代理），CORS 仅为本地浏览器直连调试放开
  await app.register(cors, { origin: env.NODE_ENV !== 'production' });
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: '7d' } });
  await app.register(websocket, { options: { maxPayload: 8 * 1024 } });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'error.unauthorized' });
    }
  });
  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isOwner(req.user.sub)) return reply.code(403).send({ error: 'error.forbidden' });
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof TradeError) return reply.code(err.status).send({ error: err.code });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'error.validation', issues: err.issues });
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return reply.code(409).send({ error: 'error.conflict' });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'error.internal' });
  });

  const panel = new PanelAccess(env.ADMIN_PANEL_USERS ?? '');

  app.get('/health', async () => ({ ok: true, ...core.risk.stats() }));

  await app.register(
    async (api) => {
      await api.register(authRoutes(core, env), { prefix: '/auth' });
      await api.register(marketRoutes(core), { prefix: '/markets' });
      await api.register(meRoutes(core, panel), { prefix: '/me' });
      await api.register(tradeRoutes(core));
      await api.register(exchangeRoutes(core), { prefix: '/exchange' });
      await api.register(adminRoutes(core), { prefix: '/admin' });
      // 临时管理面板：白名单为空时根本不注册，与不存在的路由无法区分
      if (panel.enabled) await api.register(panelRoutes(core, panel), { prefix: '/panel' });
      // 外部货币接口：HMAC 签名鉴权（未配置 API_SECRET_KEY 时返回 503）
      await api.register(economyRoutes(core, { masterKey: env.API_SECRET_KEY ?? '', maxSkewSeconds: env.HMAC_MAX_SKEW_SECONDS ?? 300 }), {
        prefix: '/economy',
      });
    },
    { prefix: `${env.API_BASE_PATH}/v1` },
  );

  registerWsGateway(app, core, env);
  return app;
}
