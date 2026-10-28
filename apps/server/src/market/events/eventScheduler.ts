import { readFile } from 'node:fs/promises';
import { D, type Decimal, ONE, ZERO } from '@catpital/shared';
import type { EventSource, PrismaClient, ScheduledEvent } from '@prisma/client';
import { z } from 'zod';
import type { Notifier } from '../../broadcast/notifier.js';
import { fromDb, toDb, wire } from '../../lib/dec.js';
import type { MarketRegistry } from '../marketRegistry.js';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);

export const scheduledEventInput = z.object({
  market: z.string().min(1),
  triggerAt: z.coerce.date(),
  /** 空标题 = 静默事件：照常跳空，但不发快讯、不进频道播报 */
  headline: z.string().max(200).default(''),
  content: z.string().max(2000).default(''),
  i18n: z.record(z.object({ headline: z.string().optional(), content: z.string().optional() })).default({}),
  /** "-0.30" = −30%；必须 > −1（价格不能归零） */
  gapPercent: decimalString.refine((v) => D(v).gt(-1), 'gapPercent must be > -1'),
  driftAdjust: decimalString.default('0'),
  volMultiplier: decimalString.refine((v) => D(v).gt(0), 'volMultiplier must be > 0').default('1'),
  durationSec: z.number().int().min(0).max(30 * 86400),
});
export type ScheduledEventInput = z.infer<typeof scheduledEventInput>;

/** 超过该时长仍未触发的事件（如服务器停机期间）作废，避免重启后集中跳空 */
const MAX_LATENESS_MS = 60 * 60 * 1000;

type Logger = { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

/**
 * 定时金融事件调度器：每秒轮询一次。
 *   PENDING → (triggerAt 到期) → ACTIVE：瞬间跳空 + 叠加漂移/波动率修正 + 全服快讯
 *   ACTIVE  → (triggeredAt + durationSec 到期) → COMPLETED：重新合成并复原参数
 * 多实例部署时用 UPDATE ... WHERE status = 'PENDING' 抢占，保证每个事件只触发一次。
 */
export class EventScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly registry: MarketRegistry,
    private readonly notifier: Notifier,
    private readonly log: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start(intervalMs = 1000) {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.poll()
        .catch((err) => this.log.error({ err }, 'event poll failed'))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async create(input: ScheduledEventInput, source: EventSource, createdById?: string) {
    const market = this.registry.byCode(input.market);
    if (!market) throw new Error(`unknown market ${input.market}`);
    return this.db.scheduledEvent.create({
      data: {
        marketId: market.id,
        triggerAt: input.triggerAt,
        headline: input.headline,
        content: input.content,
        i18n: input.i18n,
        gapPercent: toDb(D(input.gapPercent)),
        driftAdjust: toDb(D(input.driftAdjust)),
        volMultiplier: toDb(D(input.volMultiplier)),
        durationSec: input.durationSec,
        source,
        createdById: createdById ?? null,
      },
    });
  }

  async cancel(eventId: string) {
    const { count } = await this.db.scheduledEvent.updateMany({
      where: { id: eventId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    return count === 1;
  }

  /** 提前结束进行中的事件：立即撤掉它的趋势 / 波动放大（已经发生的跳空不回滚） */
  async endNow(eventId: string) {
    const ev = await this.db.scheduledEvent.findUnique({ where: { id: eventId }, select: { marketId: true } });
    if (!ev) return false;
    const { count } = await this.db.scheduledEvent.updateMany({
      where: { id: eventId, status: 'ACTIVE' },
      data: { status: 'COMPLETED', completedAt: this.clock() },
    });
    if (count === 1) await this.recomputeOverrides(ev.marketId);
    return count === 1;
  }

  /** 从 JSON 文件导入事件（按 market + triggerAt + headline 去重） */
  async seedFromJson(path: string) {
    const items = z.array(scheduledEventInput).parse(JSON.parse(await readFile(path, 'utf8')));
    let created = 0;
    for (const item of items) {
      const market = this.registry.byCode(item.market);
      if (!market) continue;
      const exists = await this.db.scheduledEvent.findFirst({
        where: { marketId: market.id, triggerAt: item.triggerAt, headline: item.headline },
      });
      if (exists) continue;
      await this.create(item, 'JSON_SEED');
      created++;
    }
    return created;
  }

  /** 启动时根据仍处于 ACTIVE 的事件恢复各市场的参数覆盖 */
  async restoreOverrides() {
    const active = await this.db.scheduledEvent.findMany({ where: { status: 'ACTIVE' }, select: { marketId: true } });
    for (const marketId of new Set(active.map((e) => e.marketId))) await this.recomputeOverrides(marketId);
  }

  async poll() {
    const now = this.clock();
    const due = await this.db.scheduledEvent.findMany({
      // 暂停交易的市场：事件留在 PENDING，恢复后再触发（超过 MAX_LATENESS_MS 仍按过期取消）
      where: { status: 'PENDING', triggerAt: { lte: now }, market: { status: 'ACTIVE' } },
      orderBy: { triggerAt: 'asc' },
      take: 20,
    });
    for (const ev of due) await this.trigger(ev, now);

    const active = await this.db.scheduledEvent.findMany({ where: { status: 'ACTIVE' } });
    for (const ev of active) {
      const end = (ev.triggeredAt ?? ev.triggerAt).getTime() + ev.durationSec * 1000;
      if (end > now.getTime()) continue;
      const { count } = await this.db.scheduledEvent.updateMany({
        where: { id: ev.id, status: 'ACTIVE' },
        data: { status: 'COMPLETED', completedAt: now },
      });
      if (count === 1) await this.recomputeOverrides(ev.marketId);
    }
  }

  private async trigger(ev: ScheduledEvent, now: Date) {
    const late = now.getTime() - ev.triggerAt.getTime() > MAX_LATENESS_MS;
    const engine = this.registry.engine(ev.marketId);
    const market = this.registry.get(ev.marketId);
    if (late || !engine || !market) {
      await this.db.scheduledEvent.updateMany({ where: { id: ev.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      this.log.info({ eventId: ev.id, late }, 'scheduled event cancelled');
      return;
    }
    const { count } = await this.db.scheduledEvent.updateMany({
      where: { id: ev.id, status: 'PENDING' },
      data: { status: 'ACTIVE', triggeredAt: now },
    });
    if (count !== 1) return; // 已被其它实例抢占

    // 先合成参数覆盖（跳空后的走势立即生效），再跳空
    await this.recomputeOverrides(ev.marketId);
    const [before, after] = await engine.applyGap(fromDb(ev.gapPercent), ev.durationSec, ev.id);
    await this.db.scheduledEvent.update({
      where: { id: ev.id },
      data: { priceBefore: toDb(before), priceAfter: toDb(after) },
    });

    this.log.info({ eventId: ev.id, market: market.code, before: before.toFixed(), after: after.toFixed(), silent: !ev.headline.trim() }, 'scheduled event fired');
    if (!ev.headline.trim()) return;

    const i18n = (ev.i18n ?? {}) as Record<string, { headline?: string; content?: string }>;
    this.notifier.marketEvent({
      eventId: ev.id,
      market: market.code,
      headline: ev.headline,
      content: ev.content,
      i18n,
      gapPercent: wire(fromDb(ev.gapPercent)),
      priceBefore: wire(before),
      priceAfter: wire(after),
      durationSec: ev.durationSec,
      ts: now.getTime(),
    });
    await this.notifier.broadcast(
      'MARKET_EVENT',
      'broadcast.marketEvent',
      {
        market: market.code,
        headline: ev.headline,
        content: ev.content,
        eventId: ev.id,
        gapPct: wire(fromDb(ev.gapPercent).mul(100)),
        priceBefore: wire(before),
        priceAfter: wire(after),
      },
      { marketId: market.id, market: market.code },
    );
  }

  /** 合成某市场全部 ACTIVE 事件：漂移相加、波动率乘数相乘 */
  async recomputeOverrides(marketId: string) {
    const active = await this.db.scheduledEvent.findMany({ where: { marketId, status: 'ACTIVE' } });
    let driftOverride: Decimal = ZERO;
    let volMultiplier: Decimal = ONE;
    let until = 0;
    for (const e of active) {
      driftOverride = driftOverride.plus(fromDb(e.driftAdjust));
      volMultiplier = volMultiplier.mul(fromDb(e.volMultiplier));
      until = Math.max(until, (e.triggeredAt ?? e.triggerAt).getTime() + e.durationSec * 1000);
    }
    this.registry.engine(marketId)?.setOverrides({ driftOverride, volMultiplier });
    await this.db.marketEngineConfig.updateMany({
      where: { marketId },
      data: { driftOverride: toDb(driftOverride), volMultiplier: toDb(volMultiplier), overrideUntil: until ? new Date(until) : null },
    });
  }
}
