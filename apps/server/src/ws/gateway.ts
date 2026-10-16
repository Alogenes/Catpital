import { type ClientMessage, DANMAKU_MAX_LENGTH, type ServerMessage } from '@catpital/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Core } from '../app.js';
import type { HttpEnv } from '../http/server.js';

const clientMessage = z.discriminatedUnion('op', [
  z.object({ op: z.literal('auth'), token: z.string().min(1) }),
  z.object({ op: z.literal('sub'), ch: z.array(z.string().max(64)).max(32) }),
  z.object({ op: z.literal('unsub'), ch: z.array(z.string().max(64)).max(32) }),
  z.object({ op: z.literal('danmaku'), market: z.string().max(32), text: z.string() }),
  z.object({ op: z.literal('ping'), ts: z.number() }),
]);

const PUBLIC_CHANNEL = /^(tick|danmaku|event):[A-Z0-9_-]{1,32}$|^kline:[A-Z0-9_-]{1,32}:(M1|M5|M15|H1|D1)$|^broadcast$/;
const MAX_SUBS = 64;

interface Conn {
  socket: WebSocket;
  userId: string | null;
  subs: Set<string>;
}

/**
 * WebSocket 网关（挂载于 WS_PATH，前端经 /.proxy/ws 访问）。
 * 订阅总线 `ws` topic，按频道 / 用户扇出；处理弹幕的限流与清洗。
 */
export function registerWsGateway(app: FastifyInstance, core: Core, env: HttpEnv) {
  const conns = new Set<Conn>();
  const byUser = new Map<string, Set<Conn>>();

  const send = (c: Conn, msg: ServerMessage | string) => {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  };

  const unsubscribeBus = core.bus.subscribe('ws', ({ userId, msg }) => {
    const raw = JSON.stringify(msg);
    if (userId) {
      for (const c of byUser.get(userId) ?? []) send(c, raw);
      return;
    }
    const ch = 'ch' in msg ? msg.ch : null;
    if (!ch) return;
    for (const c of conns) if (c.subs.has(ch)) send(c, raw);
  });
  app.addHook('onClose', async () => unsubscribeBus());

  app.register(async (scope) => {
    scope.get(env.WS_PATH, { websocket: true }, (socket) => {
      const conn: Conn = { socket, userId: null, subs: new Set() };
      conns.add(conn);
      send(conn, { op: 'hello', d: { serverTime: Date.now() } });

      socket.on('message', (data) => {
        void handle(conn, String(data)).catch(() => send(conn, { op: 'error', d: { code: 'error.internal' } }));
      });
      socket.on('close', () => {
        conns.delete(conn);
        if (conn.userId) byUser.get(conn.userId)?.delete(conn);
      });
    });
  });

  async function handle(conn: Conn, raw: string) {
    let parsed: ClientMessage;
    try {
      parsed = clientMessage.parse(JSON.parse(raw));
    } catch {
      return send(conn, { op: 'error', d: { code: 'error.badMessage' } });
    }

    switch (parsed.op) {
      case 'ping':
        return send(conn, { op: 'pong', d: { ts: parsed.ts } });

      case 'auth': {
        try {
          const payload = app.jwt.verify<{ sub: string }>(parsed.token);
          if (conn.userId) byUser.get(conn.userId)?.delete(conn);
          conn.userId = payload.sub;
          let set = byUser.get(payload.sub);
          if (!set) byUser.set(payload.sub, (set = new Set()));
          set.add(conn);
          return send(conn, { op: 'authed', d: { userId: payload.sub } });
        } catch {
          return send(conn, { op: 'error', d: { code: 'error.unauthorized' } });
        }
      }

      case 'sub':
        for (const ch of parsed.ch) {
          if (!PUBLIC_CHANNEL.test(ch) || conn.subs.size >= MAX_SUBS) continue;
          conn.subs.add(ch);
          await sendSnapshot(conn, ch);
        }
        return;

      case 'unsub':
        for (const ch of parsed.ch) conn.subs.delete(ch);
        return;

      case 'danmaku':
        return handleDanmaku(conn, parsed.market, parsed.text);
    }
  }

  /** 订阅时补发当前状态：最新价 / 最近弹幕 */
  async function sendSnapshot(conn: Conn, ch: string) {
    const [kind, code] = ch.split(':');
    if (!code) return;
    const market = core.markets.byCode(code);
    if (!market) return;
    if (kind === 'tick') {
      const price = core.markets.price(market.id);
      if (price) send(conn, { ch: `tick:${market.code}`, d: { market: market.code, price: price.toFixed(), volume: '0', ts: Date.now() } });
    } else if (kind === 'danmaku') {
      const recent = await core.bus.range(`danmaku:${market.code}`, 20);
      for (const r of recent.reverse()) send(conn, { ch: `danmaku:${market.code}`, d: JSON.parse(r) });
    }
  }

  async function handleDanmaku(conn: Conn, marketCode: string, text: string) {
    if (!conn.userId) return send(conn, { op: 'error', d: { code: 'error.unauthorized' } });
    const market = core.markets.byCode(marketCode);
    if (!market) return send(conn, { op: 'error', d: { code: 'error.marketNotFound' } });
    // 清洗：去控制字符、折叠空白、限长
    const clean = text.replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if ([...clean].length > DANMAKU_MAX_LENGTH) return send(conn, { op: 'error', d: { code: 'error.danmakuTooLong' } });
    if (!(await core.bus.setNx(`rl:danmaku:${conn.userId}`, env.DANMAKU_COOLDOWN_MS))) {
      return send(conn, { op: 'error', d: { code: 'error.danmakuCooldown' } });
    }
    const user = await core.db.user.findUnique({ where: { id: conn.userId }, select: { username: true, globalName: true, avatarHash: true } });
    if (!user) return;
    core.notifier.danmaku({
      market: market.code,
      userId: conn.userId,
      name: user.globalName ?? user.username,
      avatar: user.avatarHash,
      text: clean,
      ts: Date.now(),
    });
    void core.db.life.updateMany({ where: { userId: conn.userId, status: 'ACTIVE' }, data: { danmakuCount: { increment: 1 } } });
  }
}
