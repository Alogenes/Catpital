import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import type { BroadcastPayload, ServerMessage } from '@catpital/shared';

/**
 * 跨进程消息总线。
 *   - topic `ws`   ：要推给前端的消息（WS 网关订阅后按频道/用户分发）
 *   - topic `bot`  ：要交给 Discord Bot 发到文字频道的播报（阶段四消费）
 * 另外提供少量缓存原语（最近弹幕、最新价）供网关断线补帧。
 *
 * 生产用 RedisBus；单实例开发与测试用 MemoryBus。
 */
export interface WsEnvelope {
  /** 指定后仅投递给该用户（私有 user 频道） */
  userId?: string;
  msg: ServerMessage;
}

export interface BotEnvelope {
  broadcast: BroadcastPayload;
  /** 破产履历等附加数据 */
  resumeId?: string;
}

export interface TopicMap {
  ws: WsEnvelope;
  bot: BotEnvelope;
}

export interface Bus {
  publish<T extends keyof TopicMap>(topic: T, payload: TopicMap[T]): void;
  subscribe<T extends keyof TopicMap>(topic: T, handler: (payload: TopicMap[T]) => void): () => void;
  /** 定长列表：左侧推入，保留最新 max 条 */
  pushCapped(key: string, item: string, max: number): Promise<void>;
  range(key: string, count: number): Promise<string[]>;
  setHash(key: string, values: Record<string, string>): Promise<void>;
  getHash(key: string): Promise<Record<string, string>>;
  /** SET NX PX：成功返回 true（限流 / 分布式锁） */
  setNx(key: string, ttlMs: number): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryBus implements Bus {
  private emitter = new EventEmitter().setMaxListeners(0);
  private lists = new Map<string, string[]>();
  private hashes = new Map<string, Record<string, string>>();
  private expiries = new Map<string, number>();

  publish<T extends keyof TopicMap>(topic: T, payload: TopicMap[T]) {
    // 与 Redis 一致：经过一次序列化，避免订阅方拿到可变引用
    const copy = JSON.parse(JSON.stringify(payload)) as TopicMap[T];
    queueMicrotask(() => this.emitter.emit(topic, copy));
  }

  subscribe<T extends keyof TopicMap>(topic: T, handler: (payload: TopicMap[T]) => void) {
    this.emitter.on(topic, handler);
    return () => void this.emitter.off(topic, handler);
  }

  async pushCapped(key: string, item: string, max: number) {
    const list = this.lists.get(key) ?? [];
    list.unshift(item);
    list.length = Math.min(list.length, max);
    this.lists.set(key, list);
  }

  async range(key: string, count: number) {
    return (this.lists.get(key) ?? []).slice(0, count);
  }

  async setHash(key: string, values: Record<string, string>) {
    this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...values });
  }

  async getHash(key: string) {
    return { ...(this.hashes.get(key) ?? {}) };
  }

  async setNx(key: string, ttlMs: number) {
    const now = Date.now();
    const exp = this.expiries.get(key);
    if (exp && exp > now) return false;
    this.expiries.set(key, now + ttlMs);
    return true;
  }

  async close() {
    this.emitter.removeAllListeners();
  }
}

export class RedisBus implements Bus {
  private pub: Redis;
  private sub: Redis;
  private handlers = new Map<string, Set<(p: unknown) => void>>();

  constructor(url: string) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 3 });
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
    this.sub.on('message', (channel: string, raw: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      const payload = JSON.parse(raw) as unknown;
      for (const h of set) h(payload);
    });
  }

  private channel(topic: string) {
    return `catpital:bus:${topic}`;
  }

  publish<T extends keyof TopicMap>(topic: T, payload: TopicMap[T]) {
    void this.pub.publish(this.channel(topic), JSON.stringify(payload));
  }

  subscribe<T extends keyof TopicMap>(topic: T, handler: (payload: TopicMap[T]) => void) {
    const ch = this.channel(topic);
    let set = this.handlers.get(ch);
    if (!set) {
      set = new Set();
      this.handlers.set(ch, set);
      void this.sub.subscribe(ch);
    }
    set.add(handler as (p: unknown) => void);
    return () => {
      set!.delete(handler as (p: unknown) => void);
    };
  }

  async pushCapped(key: string, item: string, max: number) {
    await this.pub.multi().lpush(key, item).ltrim(key, 0, max - 1).exec();
  }

  async range(key: string, count: number) {
    return this.pub.lrange(key, 0, count - 1);
  }

  async setHash(key: string, values: Record<string, string>) {
    await this.pub.hset(key, values);
  }

  async getHash(key: string) {
    return this.pub.hgetall(key);
  }

  async setNx(key: string, ttlMs: number) {
    return (await this.pub.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK';
  }

  async close() {
    await Promise.all([this.pub.quit(), this.sub.quit()]);
  }
}

export const createBus = (redisUrl?: string): Bus => (redisUrl ? new RedisBus(redisUrl) : new MemoryBus());
