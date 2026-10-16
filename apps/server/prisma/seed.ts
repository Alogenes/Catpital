import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { seedMarkets } from '../src/seed/seedMarkets.js';

const db = new PrismaClient();
const raw = JSON.parse(await readFile(new URL('./seed/markets.json', import.meta.url), 'utf8'));
const n = await seedMarkets(db, raw);
console.log(`seeded ${n} markets`);
await db.$disconnect();
