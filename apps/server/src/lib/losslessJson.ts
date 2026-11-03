/**
 * 无损 JSON 解析：把所有数字字面量保留为原始字符串，避免外部行情 API
 * 返回的 `"price": 123.4500001` 在 JSON.parse 时先变成二进制浮点。
 *
 * 依赖 ES2025 "JSON.parse source text access"（Node ≥ 21 / V8 ≥ 11.4）：
 * reviver 的第三个参数 context.source 是该值在原文中的文本。
 * 旧版 Node（如 20）没有 context：退化为 String(value)（最短往返表示，行情价位数下不会失真），
 * 保证数字字段仍是字符串，否则下游 D() 会因非整数 number 直接抛错。
 */
type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

export function parseLosslessJson<T = unknown>(text: string): T {
  const reviver: Reviver = (_key, value, context) =>
    typeof value === 'number' ? (context?.source ?? String(value)) : value;
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]) as T;
}
