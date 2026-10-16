import { D, Decimal, ONE } from '@catpital/shared';

const TWO_POW_32 = D('4294967296');
const TWO_PI = Decimal.acos(-1).mul(2);
const MINUS_TWO = D(-2);

/**
 * 可复现的伪随机数发生器（xoshiro128**），输出全部为 Decimal。
 *
 * 行情生成全程不经过二进制浮点：
 *   - 整数状态机产出 uint32（JS 位运算在 32 位整数上是精确的）
 *   - 均匀分布 U = (k + 1) / (2^32 + 1) ∈ (0, 1)，由 Decimal 精确除法得到
 *   - 正态分布用 Box–Muller，ln / sqrt / cos 均由 decimal.js 计算
 */
export class DecimalRng {
  private s: Uint32Array;
  private spare: Decimal | null = null;

  constructor(seed: number | string) {
    this.s = new Uint32Array(4);
    // splitmix32 扩展种子
    let h = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
    for (let i = 0; i < 4; i++) {
      h = (h + 0x9e3779b9) >>> 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      this.s[i] = (z ^ (z >>> 16)) >>> 0;
    }
    if (this.s.every((v) => v === 0)) this.s[0] = 1;
  }

  nextUint32(): number {
    let [s0, s1, s2, s3] = this.s as unknown as [number, number, number, number];
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    this.s.set([s0, s1, s2, s3]);
    return result;
  }

  /** (0, 1) 开区间均匀分布 */
  uniform(): Decimal {
    return D(this.nextUint32() + 1).div(TWO_POW_32.plus(ONE));
  }

  /** 标准正态 N(0, 1) */
  normal(): Decimal {
    if (this.spare) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    const u1 = this.uniform();
    const u2 = this.uniform();
    const r = u1.ln().mul(MINUS_TWO).sqrt();
    const theta = TWO_PI.mul(u2);
    this.spare = r.mul(theta.sin());
    return r.mul(theta.cos());
  }
}

function rotl(x: number, k: number) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function hashString(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
