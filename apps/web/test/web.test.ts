import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LaneAllocator } from '../src/lib/danmakuLanes';
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
