/**
 * 外部 Bot 接入示例（可直接复制到签到 Bot / 打怪 Bot 里）：
 *   CATPITAL_URL=https://api.example.com CATPITAL_CLIENT_ID=... CATPITAL_SECRET=... \
 *   npx tsx scripts/economy-client-example.ts deposit 123456789012345678 100.5
 */
import { createHmac, randomBytes } from 'node:crypto';

export async function catpitalTransfer(opts: {
  baseUrl: string;
  clientId: string;
  secret: string;
  direction: 'deposit' | 'withdraw';
  userId: string;
  /** 十进制字符串，避免浮点 */
  amount: string;
  /** 你方系统的流水号；重试时保持不变即可保证不重复入账 */
  externalRef: string;
  memo?: string;
}) {
  const path = `/api/v1/economy/${opts.direction}`;
  const body = JSON.stringify({ userId: opts.userId, amount: opts.amount, externalRef: opts.externalRef, memo: opts.memo });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', opts.secret).update([timestamp, nonce, 'POST', path, body].join('\n')).digest('hex');
  const res = await fetch(`${opts.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-catpital-client': opts.clientId,
      'x-catpital-timestamp': timestamp,
      'x-catpital-nonce': nonce,
      'x-catpital-signature': signature,
    },
    body,
  });
  return { status: res.status, body: await res.json() };
}

if (process.argv[1]?.endsWith('economy-client-example.ts')) {
  const [direction, userId, amount] = process.argv.slice(2);
  const result = await catpitalTransfer({
    baseUrl: process.env.CATPITAL_URL ?? 'http://localhost:3001',
    clientId: process.env.CATPITAL_CLIENT_ID ?? '',
    secret: process.env.CATPITAL_SECRET ?? '',
    direction: direction as 'deposit' | 'withdraw',
    userId: userId!,
    amount: amount!,
    externalRef: `example-${Date.now()}`,
  });
  console.log(result);
}
