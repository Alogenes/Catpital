/**
 * 弹幕轨道分配：每条轨道记录"最后一条弹幕完全进入屏幕的时刻"，
 * 新弹幕选最早空出的轨道，避免重叠；全部被占用时返回 null（丢弃，防止刷屏糊脸）。
 */
export class LaneAllocator {
  private freeAt: number[];

  constructor(
    lanes: number,
    /** 允许等待的最长时间（毫秒），超过即丢弃 */
    private readonly maxWaitMs = 1500,
  ) {
    this.freeAt = Array.from({ length: lanes }, () => 0);
  }

  /**
   * @param now 当前时间
   * @param enterMs 这条弹幕从右侧完全进入屏幕需要的时间（文字宽度 / 速度）
   * @returns 轨道号与延迟；null = 丢弃
   */
  allocate(now: number, enterMs: number): { lane: number; delayMs: number } | null {
    let best = -1;
    for (let i = 0; i < this.freeAt.length; i++) {
      if (best < 0 || this.freeAt[i]! < this.freeAt[best]!) best = i;
    }
    if (best < 0) return null;
    const start = Math.max(now, this.freeAt[best]!);
    const delayMs = start - now;
    if (delayMs > this.maxWaitMs) return null;
    this.freeAt[best] = start + enterMs + 120; // 120ms 间隔
    return { lane: best, delayMs };
  }

  resize(lanes: number) {
    this.freeAt = Array.from({ length: lanes }, (_, i) => this.freeAt[i] ?? 0);
  }
}
