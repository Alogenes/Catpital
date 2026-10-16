/**
 * 按 key 串行执行异步任务（同一市场的 tick / 下单 / 强平 / 事件跳空 不会交错）。
 * 不同 key 之间完全并行。任务抛错不会阻塞后续任务。
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  /** 等待某个 key 当前排队的所有任务完成（测试与优雅停机用） */
  async drain(key?: string): Promise<void> {
    if (key) {
      await this.tails.get(key);
      return;
    }
    await Promise.all([...this.tails.values()]);
  }
}
