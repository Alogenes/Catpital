import { DiscordSDK } from '@discord/embedded-app-sdk';
import { api } from './api';
import { cdnUrl } from './endpoints';

export interface AuthResult {
  token: string;
  userId: string;
  /** 在 Discord 客户端内运行 */
  embedded: boolean;
  sdk: DiscordSDK | null;
}

/** Discord 会给 Activity iframe 带上 frame_id 等查询参数；没有则视为普通浏览器调试 */
export const isEmbedded = () => new URLSearchParams(window.location.search).has('frame_id');

let sdk: DiscordSDK | null = null;
export const getSdk = () => sdk;

/**
 * Embedded App 鉴权：
 *   ready → authorize（拿 code）→ 后端 /auth/token（用 secret 换 access_token 并签发会话 JWT）
 *   → authenticate（SDK 侧完成认证，之后可调用需要身份的 SDK 命令）
 */
export async function authenticateWithDiscord(): Promise<AuthResult> {
  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID as string | undefined;
  if (!clientId) throw new Error('VITE_DISCORD_CLIENT_ID is not configured');
  sdk = new DiscordSDK(clientId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });
  const res = await api.post<{ access_token: string; token: string; userId: string }>('/auth/token', { code });
  await sdk.commands.authenticate({ access_token: res.access_token });
  return { token: res.token, userId: res.userId, embedded: true, sdk };
}

/** 本地浏览器调试：后端 DEV_LOGIN=1 时可用 */
export async function devLogin(userId: string, username: string): Promise<AuthResult> {
  const res = await api.post<{ token: string; userId: string }>('/auth/dev', { userId, username });
  return { token: res.token, userId: res.userId, embedded: false, sdk: null };
}

/**
 * 头像同样走 URL Mapping（PREFIX /discord-cdn → TARGET cdn.discordapp.com），
 * 不在前端出现任何外部域名。
 */
export function avatarUrl(userId: string, avatarHash: string | null | undefined, size = 64) {
  if (avatarHash) return cdnUrl(`/avatars/${userId}/${avatarHash}.png?size=${size}`);
  const idx = Number((BigInt(userId) >> 22n) % 6n);
  return cdnUrl(`/embed/avatars/${idx}.png`);
}
