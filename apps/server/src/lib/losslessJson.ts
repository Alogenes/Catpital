/**
 * 无损 JSON 解析：把所有数字字面量保留为原始字符串，避免外部行情 API
 * 返回的 `"price": 123.4500001` 在 JSON.parse 时先变成二进制浮点。
 *
 * 依赖 ES2025 "JSON.parse source text access"（Node ≥ 21 / V8 ≥ 11.4）：
 * reviver 的第三个参数 context.source 是该值在原文中的文本。
 */
type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

export function parseLosslessJson<T = unknown>(text: string): T {
  const reviver: Reviver = (_key, value, context) =>
    typeof value === 'number' && context?.source !== undefined ? context.source : value;
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]) as T;
}
