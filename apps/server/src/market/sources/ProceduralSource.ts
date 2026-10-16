import { D, type Decimal, ONE, ZERO, dmax, roundToStep } from '@catpital/shared';
import type { DecimalRng } from '../../lib/random.js';
import type { PriceSource, Quote, SourceOverrides } from './PriceSource.js';

const MS_PER_YEAR = D('31536000000'); // 365 天
const HALF = D('0.5');
const VOLUME_NOISE_SIGMA = D('0.25');
/** 对数正态噪声均值修正 −σ²/2，使 E[exp(σZ − σ²/2)] = 1 */
const VOLUME_NOISE_DRIFT = VOLUME_NOISE_SIGMA.pow(2).div(2).neg();

export interface ProceduralParams {
  /** μ 年化漂移 */
  drift: Decimal;
  /** σ 年化波动率 */
  volatility: Decimal;
  /** κ 均值回归速度（0 = 纯 GBM） */
  meanReversionSpeed: Decimal;
  /** θ 均值回归目标价；null = 初始价 */
  meanReversionTarget: Decimal | null;
  /** λ 年化跳跃强度 */
  jumpIntensity: Decimal;
  /** 跳跃对数幅度 ~ N(jumpMean, jumpStdDev²) */
  jumpMean: Decimal;
  jumpStdDev: Decimal;
  baseVolume: Decimal;
  volumeVolCoupling: Decimal;
  /** 模拟时间 / 真实时间 */
  timeScale: Decimal;
  priceFloor: Decimal;
}

export interface ProceduralSpec {
  initialPrice: Decimal;
  lastPrice: Decimal;
  tickSize: Decimal;
  lotSize: Decimal;
  tickIntervalMs: number;
}

/**
 * 带均值回归与跳跃扩散的对数价格过程（Merton jump-diffusion + OU 均值回归）：
 *
 *   x = ln S
 *   dx = [ μ' − σ'²/2 + κ(ln θ − x) ] dt + σ' √dt · Z + J · 1{U < λ dt}
 *   μ' = μ + driftOverride，σ' = σ · volMultiplier，J ~ N(jumpMean, jumpStdDev²)
 *
 *   κ = 0、λ = 0 时退化为标准几何布朗运动（GBM）。
 *   成交量 = baseVolume · (1 + coupling·|Z|) · LogNormal(均值 1)，与价格波动正相关。
 *
 * 内部保留连续的 x（不受 tickSize 舍入影响），对外输出按 tickSize 取整的价格。
 */
export class ProceduralSource implements PriceSource {
  readonly kind = 'PROCEDURAL' as const;
  private x: Decimal;
  private price: Decimal;
  private overrides: SourceOverrides = { driftOverride: ZERO, volMultiplier: ONE };

  constructor(
    private readonly spec: ProceduralSpec,
    private params: ProceduralParams,
    private readonly rng: DecimalRng,
  ) {
    this.price = spec.lastPrice;
    this.x = spec.lastPrice.ln();
  }

  async start() {}
  async stop() {}

  current() {
    return this.price;
  }

  setParams(params: Partial<ProceduralParams>) {
    this.params = { ...this.params, ...params };
  }

  setOverrides(overrides: SourceOverrides) {
    this.overrides = overrides;
  }

  private floor() {
    return dmax(this.params.priceFloor, this.spec.tickSize);
  }

  private quantize(rawPrice: Decimal) {
    return dmax(this.floor(), roundToStep(rawPrice, this.spec.tickSize, 'nearest'));
  }

  sample(): Quote {
    const p = this.params;
    const dt = D(this.spec.tickIntervalMs).mul(p.timeScale).div(MS_PER_YEAR);
    const sigma = p.volatility.mul(this.overrides.volMultiplier);
    const mu = p.drift.plus(this.overrides.driftOverride);
    const theta = (p.meanReversionTarget ?? this.spec.initialPrice).ln();

    const z = this.rng.normal();
    let dx = mu
      .minus(sigma.pow(2).mul(HALF))
      .plus(p.meanReversionSpeed.mul(theta.minus(this.x)))
      .mul(dt)
      .plus(sigma.mul(dt.sqrt()).mul(z));

    if (p.jumpIntensity.gt(0) && this.rng.uniform().lt(p.jumpIntensity.mul(dt))) {
      dx = dx.plus(p.jumpMean.plus(p.jumpStdDev.mul(this.rng.normal())));
    }

    this.x = this.x.plus(dx);
    const floorLn = this.floor().ln();
    if (this.x.lt(floorLn)) this.x = floorLn;
    this.price = this.quantize(this.x.exp());

    const noise = VOLUME_NOISE_SIGMA.mul(this.rng.normal()).plus(VOLUME_NOISE_DRIFT).exp();
    const rawVolume = p.baseVolume.mul(ONE.plus(p.volumeVolCoupling.mul(z.abs()))).mul(noise);
    const volume = dmax(this.spec.lotSize, roundToStep(rawVolume, this.spec.lotSize, 'down'));
    return { price: this.price, volume };
  }

  applyGap(gapPercent: Decimal): Decimal {
    this.price = this.quantize(this.price.mul(ONE.plus(gapPercent)));
    this.x = this.price.ln();
    return this.price;
  }
}
