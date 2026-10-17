import { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Core } from '../../app.js';
import { HEADER, NONCE_PATTERN, decryptSecret, parseMasterKey, safeEqualHex, sign } from '../../economy/hmac.js';
import { decimalStr } from '../schemas.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
    apiClientId?: string;
  }
}

const transferBody = z.object({
  /** Discord UID */
  userId: z.string().regex(/^\d{5,20}$/),
  /** 十进制字符串，最多 8 位小数，必须 > 0 */
  amount: decimalStr.refine((d) => d.gt(0), 'amount must be > 0'),
  /** 外部系统流水号，同一接入方内唯一（幂等键） */
  externalRef: z.string().min(1).max(128),
  memo: z.string().max(200).optional(),
});

/**
 * 外部货币接口（服务器之间调用，不经过 Discord /.proxy）：
 *   POST /api/v1/economy/deposit    外部 → Catpital 入金
 *   POST /api/v1/economy/withdraw   Catpital → 外部 出金
 * 鉴权见 src/economy/hmac.ts 顶部的签名规范。
 */
export const economyRoutes =
  (core: Core, opts: { masterKey: string; maxSkewSeconds: number }): FastifyPluginAsync =>
  async (app) => {
    // 签名针对原始请求体：本作用域内的 JSON 解析器同时保留原文
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      req.rawBody = body as string;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch {
        done(Object.assign(new Error('error.badJson'), { statusCode: 400 }), undefined);
      }
    });

    const secrets = new Map<string, string>();
    const master = opts.masterKey ? parseMasterKey(opts.masterKey) : null;

    const deny = (reply: FastifyReply, code: string, status = 401) => reply.code(status).send({ error: code });

    const authenticate = (scope: string) => async (req: FastifyRequest, reply: FastifyReply) => {
      if (!master) return deny(reply, 'error.economyDisabled', 503);
      const clientId = req.headers[HEADER.client];
      const ts = req.headers[HEADER.timestamp];
      const nonce = req.headers[HEADER.nonce];
      const signature = req.headers[HEADER.signature];
      if (typeof clientId !== 'string' || typeof ts !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
        return deny(reply, 'error.missingSignature');
      }
      if (!/^\d{9,11}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > opts.maxSkewSeconds) return deny(reply, 'error.staleTimestamp');
      if (!NONCE_PATTERN.test(nonce)) return deny(reply, 'error.badNonce');

      const client = await core.db.apiClient.findUnique({ where: { id: clientId } });
      if (!client || !client.isActive) return deny(reply, 'error.unknownClient');
      if (!client.scopes.includes(scope)) return deny(reply, 'error.forbidden', 403);

      let secret = secrets.get(client.id);
      if (!secret) {
        secret = decryptSecret(master, client.secretEnc);
        secrets.set(client.id, secret);
      }
      const expected = sign(secret, ts, nonce, req.method, req.url, req.rawBody ?? '');
      if (!safeEqualHex(expected, signature)) return deny(reply, 'error.badSignature');

      // 防重放：nonce 只能用一次（数据库唯一约束，重启后依然有效）
      try {
        await core.db.apiNonce.create({ data: { nonce: `${client.id}:${nonce}`, clientId: client.id } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return deny(reply, 'error.replayedNonce');
        throw err;
      }
      // 顺手清理过期 nonce（时间窗外的 nonce 已无法通过时间戳校验，无需保留）
      if (Math.random() < 0.02) {
        void core.db.apiNonce
          .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - opts.maxSkewSeconds * 2000) } } })
          .catch(() => {});
      }
      req.apiClientId = client.id;
    };

    app.post('/deposit', { preHandler: authenticate('transfer:deposit') }, async (req) => {
      const body = transferBody.parse(req.body);
      return core.bank.deposit({ clientId: req.apiClientId!, ...body });
    });

    app.post('/withdraw', { preHandler: authenticate('transfer:withdraw') }, async (req) => {
      const body = transferBody.parse(req.body);
      return core.bank.withdraw({ clientId: req.apiClientId!, ...body });
    });
  };
