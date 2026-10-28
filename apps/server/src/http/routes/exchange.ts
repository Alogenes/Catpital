import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Core } from '../../app.js';
import { fromDb, wire } from '../../lib/dec.js';
import { EXCHANGE_MAX_AMOUNT } from '../../economy/skylbotExchange.js';

/** 兑换数量：整数 bolívares，字符串或整数都接受（金额不允许小数） */
const amountBody = z.object({
  amount: z.union([z.string().regex(/^\d{1,8}$/), z.number().int()]).transform(Number).pipe(z.number().int().min(1).max(EXCHANGE_MAX_AMOUNT)),
});

/**
 * 货币兑换（/api/v1/exchange）：Skylbot 的 bolívares ⇄ Catpital 的 Meuw Coin，1:1。
 *   GET  /      状态、两边余额、最近记录（未配置 Skylbot 时 enabled = false）
 *   POST /in    bolívares → Meuw Coin
 *   POST /out   Meuw Coin → bolívares
 * 结果未知（Skylbot 超时）时返回 202 + status PENDING，后台对账补完后通过钱包推送到账。
 */
export const exchangeRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onRequest', app.authenticate);

    app.get('/', async (req) => {
      const userId = req.user.sub;
      const wallet = await core.db.wallet.findUniqueOrThrow({ where: { userId } });
      if (!core.exchange.enabled) return { enabled: false, rate: 1, meuw: wire(fromDb(wallet.balance)), bolivares: null, history: [] };
      const [bolivares, history] = await Promise.all([core.exchange.bolivares(userId), core.exchange.history(userId)]);
      return { enabled: true, rate: 1, meuw: wire(fromDb(wallet.balance)), bolivares, history };
    });

    app.post('/in', async (req, reply) => {
      const { amount } = amountBody.parse(req.body);
      const r = await core.exchange.exchangeIn(req.user.sub, amount);
      return reply.code(r.status === 'PENDING' ? 202 : 200).send(r);
    });

    app.post('/out', async (req, reply) => {
      const { amount } = amountBody.parse(req.body);
      const r = await core.exchange.exchangeOut(req.user.sub, amount);
      return reply.code(r.status === 'PENDING' ? 202 : 200).send(r);
    });
  };
