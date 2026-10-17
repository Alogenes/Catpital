/**
 * 创建外部货币接口的接入方（签到 Bot、打怪 Bot 等）：
 *   pnpm --filter @catpital/server api-client:create "签到Bot" deposit,withdraw
 * 需要环境变量 DATABASE_URL 与 API_SECRET_KEY。密钥明文只在这里打印一次，库里只存加密后的值。
 */
import { PrismaClient } from '@prisma/client';
import { loadDotenv } from '../src/config/dotenv.js';
import { encryptSecret, generateSecret, parseMasterKey } from '../src/economy/hmac.js';

loadDotenv();

const name = process.argv[2];
const scopes = (process.argv[3] ?? 'deposit,withdraw').split(',').map((s) => `transfer:${s.trim()}`);
if (!name) {
  console.error('usage: api-client:create <name> [deposit,withdraw]');
  process.exit(1);
}
const masterRaw = process.env.API_SECRET_KEY;
if (!masterRaw) {
  console.error('API_SECRET_KEY is not set (32 bytes; e.g. `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`)');
  process.exit(1);
}

const db = new PrismaClient();
const secret = generateSecret();
const client = await db.apiClient.create({
  data: { name, scopes, secretEnc: encryptSecret(parseMasterKey(masterRaw), secret) },
});
console.log(JSON.stringify({ clientId: client.id, secret, scopes }, null, 2));
console.log('\n⚠ Store the secret now — it cannot be shown again.');
await db.$disconnect();
