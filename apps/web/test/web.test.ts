import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D, applyFill, impactQuote } from '@catpital/shared';
import { LaneAllocator } from '../src/lib/danmakuLanes';
import { budgetForPct, leveragePresets, leverageTier, sizeFromBudget } from '../src/lib/orderSizing';
import { interpolate } from '../src/lib/rolling';
import { fmt, fmtPct, fmtSigned, parseDec, sanitizeDecimalInput } from '../src/lib/format';

describe('format (Decimal only)', () => {
  it('groups thousands without float drift', () => {
    expect(fmt('1234567.005', 2)).toBe('1,234,567.01');
    expect(fmt('-17376.98')).toBe('-17,376.98');
    expect(fmt('0.1')).toBe('0.10');
    expect(fmt('12345678901234567890.123456789', 4)).toBe('12,345,678,901,234,567,890.1235');
    expect(fmt(undefined)).toBe('—');
  });
  it('signs and percents', () => {
    expect(fmtSigned('9.4')).toBe('+9.40');
    expect(fmtSigned('-0.5')).toBe('-0.50');
    expect(fmtPct('-0.693375')).toBe('-69.34%');
    expect(fmtPct('0.3', 0, false)).toBe('30%');
  });
  it('sanitizes decimal input', () => {
    expect(sanitizeDecimalInput('12a.3.4')).toBe('12.34');
    expect(sanitizeDecimalInput('0.123456789', 4)).toBe('0.1234');
    expect(parseDec('1.')).toBeNull();
    expect(parseDec('1.5')?.toFixed()).toBe('1.5');
  });
});

describe('margin-based order sizing', () => {
  const risk = { maintenanceMarginRate: D('0.005'), tickSize: D('0.01') };
  const fill = (q: string, price: string, lev: string, fee: string) =>
    applyFill(null, { orderSide: 'BUY', quantity: D(q), price: D(price), leverage: D(lev), feeRate: D(fee), reduceOnly: false }, risk);

  it('ALL IN with a tiny balance never exceeds what is available', () => {
    const budget = budgetForPct('7.894', 100);
    expect(budget.toFixed()).toBe('7.89');
    const q = sizeFromBudget({ budget, price: D('99.27'), leverage: D(10), feeRate: D('0.0006'), lotSize: D('0.01') });
    expect(q.toFixed()).toBe('0.79');
    expect(fill(q.toFixed(), '99.27', '10', '0.0006').requiredFunds.lte(budget)).toBe(true);
  });

  it('holds for many random budgets, leverages and lot sizes', () => {
    for (let i = 0; i < 300; i++) {
      const budget = D((1 + i * 37.13).toFixed(2));
      const lev = D(1 + (i % 100));
      const price = D((0.1 + i * 3.7).toFixed(4));
      const lot = ['1', '0.01', '0.0001'][i % 3]!;
      const q = sizeFromBudget({ budget, price, leverage: lev, feeRate: D('0.0008'), lotSize: D(lot) });
      if (q.isZero()) continue;
      expect(fill(q.toFixed(), price.toFixed(), lev.toFixed(), '0.0008').requiredFunds.lte(budget)).toBe(true);
    }
  });

  it('with whale impact, ALL IN still fits the budget at the impacted fill price', () => {
    const impact = { liquidity: D(1_000_000), cap: D('0.01') };
    for (const [budget, lev] of [['5000', 50], ['10000', 199], ['87.52', 25], ['100000', 10]] as const) {
      const q = sizeFromBudget({ budget: D(budget), price: D(100), leverage: D(lev), feeRate: D('0.001'), lotSize: D('0.01'), impact });
      const quote = impactQuote(D(100), q.mul(100), 'BUY', impact, D('0.01'));
      expect(fill(q.toFixed(), quote.fillPrice.toFixed(), String(lev), '0.001').requiredFunds.lte(budget)).toBe(true);
    }
  });

  it('market buffer sizes slightly smaller', () => {
    const args = { budget: D(1000), price: D(100), leverage: D(10), feeRate: D('0.001'), lotSize: D('0.01') };
    expect(sizeFromBudget({ ...args, buffer: D('0.003') }).lt(sizeFromBudget(args))).toBe(true);
  });

  it('pct buttons and zero / negative balances', () => {
    expect(budgetForPct('100', 25).toFixed()).toBe('25');
    expect(budgetForPct('-77328.99', 100).toFixed()).toBe('0');
  });

  it('leverage tiers and presets', () => {
    expect([1, 5, 6, 25, 49, 50, 100].map(leverageTier)).toEqual(['safe', 'safe', 'spicy', 'spicy', 'spicy', 'degen', 'degen']);
    expect(leveragePresets(20)).toEqual([1, 5, 10, 20]);
    expect(leveragePresets(100)).toEqual([1, 5, 10, 25, 50, 100]);
  });
});

describe('rolling number interpolation', () => {
  it('starts at from, ends exactly at to, and moves monotonically', () => {
    const from = D('10000');
    const to = D('7577.02');
    expect(interpolate(from, to, 0).toFixed()).toBe('10000');
    expect(interpolate(from, to, 1).toFixed()).toBe('7577.02');
    let prev = from;
    for (let i = 1; i <= 20; i++) {
      const v = interpolate(from, to, i / 20);
      expect(v.lte(prev)).toBe(true);
      prev = v;
    }
    expect(interpolate(from, to, 0.5).decimalPlaces()).toBeLessThanOrEqual(2);
  });
  it('handles crossing zero into debt', () => {
    expect(interpolate(D('5'), D('-77328.99'), 1).toFixed()).toBe('-77328.99');
    expect(interpolate(D('5'), D('-77328.99'), 0.5).lt(0)).toBe(true);
  });
});

describe('LaneAllocator', () => {
  it('spreads across lanes and drops when saturated', () => {
    const lanes = new LaneAllocator(2, 500);
    expect(lanes.allocate(0, 1000)).toEqual({ lane: 0, delayMs: 0 });
    expect(lanes.allocate(0, 1000)).toEqual({ lane: 1, delayMs: 0 });
    expect(lanes.allocate(0, 1000)).toBeNull(); // 需等待 1120ms > 500ms
    expect(lanes.allocate(1200, 1000)).toEqual({ lane: 0, delayMs: 0 });
  });
});

describe('locales', () => {
  const dir = join(__dirname, '../src/i18n/locales');
  const flatten = (o: Record<string, unknown>, p = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
  const packs = Object.fromEntries(
    readdirSync(dir).map((lang) => [lang, new Set(flatten(JSON.parse(readFileSync(join(dir, lang, 'translation.json'), 'utf8'))))]),
  );

  it('every language has exactly the same keys as zh-CN', () => {
    const base = packs['zh-CN']!;
    for (const [lang, keys] of Object.entries(packs)) {
      expect([...base].filter((k) => !keys.has(k)), `${lang} missing`).toEqual([]);
      expect([...keys].filter((k) => !base.has(k)), `${lang} extra`).toEqual([]);
    }
  });

  it('covers every backend error code and title key', () => {
    const server = join(__dirname, '../../server/src');
    const files: string[] = [];
    const walk = (d: string) =>
      readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') && files.push(join(d, e.name))));
    walk(server);
    walk(join(__dirname, '../../../packages/shared/src'));
    const used = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/'((?:error|warn|title|broadcast)\.[a-zA-Z]+)'/g)) used.add(m[1]!);
    }
    const base = packs['zh-CN']!;
    const missing = [...used].filter((k) => !base.has(k) && !base.has(`${k}.name`));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(30);
  });
});
