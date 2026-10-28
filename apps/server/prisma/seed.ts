import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { loadDotenv } from '../src/config/dotenv.js';
import { seedMarkets } from '../src/seed/seedMarkets.js';

// 与服务进程一样读取仓库根目录的 .env（DATABASE_URL）
loadDotenv();
const db = new PrismaClient();
const raw = JSON.parse(await readFile(new URL('./seed/markets.json', import.meta.url), 'utf8'));
const n = await seedMarkets(db, raw);
console.log(`seeded ${n} markets`);
await db.$disconnect();
