import { D } from '@catpital/shared';
import { readFileSync } from 'node:fs';
import { DecimalRng } from './src/lib/random.js';
import { ProceduralSource } from './src/market/sources/ProceduralSource.js';

const woof = JSON.parse(readFileSync('prisma/seed/markets.json', 'utf8')).find((m: { code: string }) => m.code === 'WOOF');
const STEP_MS = 60_000;
const DAY = 1440;

function run(drift: string, kappa: string, start: string, days: number, paths: number, checkpoints: number[]) {
  const e = woof.engine;
  const out: number[][] = checkpoints.map(() => []);
  for (let p = 0; p < paths; p++) {
    const src = new ProceduralSource(
      { initialPrice: D(woof.initialPrice), lastPrice: D(start), tickSize: D(woof.tickSize), lotSize: D(woof.lotSize), tickIntervalMs: STEP_MS },
      {
        drift: D(drift), volatility: D(e.volatility), meanReversionSpeed: D(kappa), meanReversionTarget: null,
        jumpIntensity: D(e.jumpIntensity), jumpMean: D(e.jumpMean), jumpStdDev: D(e.jumpStdDev),
        baseVolume: D(e.baseVolume), volumeVolCoupling: D(e.volumeVolCoupling), timeScale: D(e.timeScale), priceFloor: D(e.priceFloor),
      },
      new DecimalRng(`sim:${p}`),
    );
    let t = 0;
    const steps = days * DAY;
    for (let i = 1; i <= steps; i++) {
      t += STEP_MS;
      const q = src.sample(new Date(t));
      const k = checkpoints.indexOf(i);
      if (k >= 0) out[k]!.push(q.price.toNumber());
    }
  }
  return out.map((xs) => {
    xs.sort((a, b) => a - b);
    const q = (f: number) => xs[Math.floor(f * (xs.length - 1))]!;
    return `p10 ${q(0.1).toFixed(4)}  median ${q(0.5).toFixed(4)}  p90 ${q(0.9).toFixed(4)}`;
  });
}

const cps = [DAY / 2, DAY, 3 * DAY];
const label = ['12h ', '1 天', '3 天'];
const t0 = Date.now();
const old = run('0', '0', '0.5', 3, 200, cps);
const neu = run(woof.engine.drift, woof.engine.meanReversionSpeed, '0.5', 3, 200, cps);
console.log('起点 0.5（锚点），200 条路径');
for (let i = 0; i < cps.length; i++) console.log(`${label[i]}  旧: ${old[i]}\n      新: ${neu[i]}`);
const rescue = run(woof.engine.drift, woof.engine.meanReversionSpeed, '0.0164', 2, 100, [DAY / 4, DAY / 2, DAY, 2 * DAY]);
console.log('\n新参数，从线上的 0.0164 出发（锚点 0.5），100 条路径');
['6h ', '12h', '1 天', '2 天'].forEach((l, i) => console.log(`${l}  ${rescue[i]}`));
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
