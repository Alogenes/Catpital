import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 外部货币接口签名规范（客户端照此实现即可接入）：
 *
 *   请求头
 *     X-Catpital-Client     接入方 ID（ApiClient.id）
 *     X-Catpital-Timestamp  Unix 秒
 *     X-Catpital-Nonce      一次性随机串（16–64 位，[A-Za-z0-9_-]）
 *     X-Catpital-Signature  hex( HMAC-SHA256( secret, 待签名串 ) )
 *
 *   待签名串（以 \n 连接）
 *     timestamp \n nonce \n METHOD \n path \n rawBody
 *
 *   服务端校验：接入方启用 + 权限范围、时间戳偏差 ≤ HMAC_MAX_SKEW_SECONDS、nonce 未用过（防重放）、
 *   timingSafeEqual 常量时间比较签名。
 */
export const HEADER = {
  client: 'x-catpital-client',
  timestamp: 'x-catpital-timestamp',
  nonce: 'x-catpital-nonce',
  signature: 'x-catpital-signature',
} as const;

export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function canonicalString(timestamp: string, nonce: string, method: string, path: string, rawBody: string) {
  return [timestamp, nonce, method.toUpperCase(), path, rawBody].join('\n');
}

export function sign(secret: string, timestamp: string, nonce: string, method: string, path: string, rawBody: string): string {
  return createHmac('sha256', secret).update(canonicalString(timestamp, nonce, method, path, rawBody)).digest('hex');
}

/** 常量时间比较，长度不同直接返回 false（不抛错、不泄露时序） */
export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// -----------------------------------------------------------------------------
// 接入方密钥落库加密：AES-256-GCM，主密钥来自环境变量 API_SECRET_KEY（32 字节 hex / base64）
// 存储格式：v1:<iv b64>:<tag b64>:<ciphertext b64>
// -----------------------------------------------------------------------------

export function parseMasterKey(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('API_SECRET_KEY must be 32 bytes (64 hex chars or base64)');
  return key;
}

export function encryptSecret(masterKey: Buffer, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(masterKey: Buffer, stored: string): string {
  const [v, iv, tag, ct] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

/** 生成新的接入方密钥（明文只在创建时展示一次） */
export const generateSecret = () => randomBytes(32).toString('base64url');
