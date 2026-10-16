/**
 * 前端唯一的网络端点出口。
 * 强约束：禁止在任何地方硬编码外部绝对域名；所有 HTTP / WS 都必须经由这里生成，
 * 以满足 Discord `*.discordsays.com` CSP 沙盒与 URL Mapping 代理规范。
 */
const PROXY_PREFIX = '/.proxy';
const API_VERSION = 'v1';

/** `/.proxy/api/v1/markets` 这样的同源相对路径 */
export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${PROXY_PREFIX}/api/${API_VERSION}${normalized}`;
}

/** WebSocket 必须使用绝对 URL，但 host 取自当前页面（即 <app_id>.discordsays.com），不硬编码 */
export function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${PROXY_PREFIX}/ws`;
}

/** Discord CDN（头像等），经 URL Mapping /discord-cdn 代理 */
export function cdnUrl(path: string): string {
  return `${PROXY_PREFIX}/discord-cdn${path.startsWith('/') ? path : `/${path}`}`;
}
