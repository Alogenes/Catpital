/**
 * 调用 Skylbot（main.py）已有的余额接口：
 *   GET  /api/balance/<user_id>      → 整数余额
 *   POST /api/balance/withdraw       {"user_id", "amount"} → {"nuevo_balance", "status": "ok"}；余额不足 400 "Saldo insuficiente"
 *   POST /api/balance/deposit        {"user_id", "amount"} → {"nuevo_balance", "status": "ok"}
 * 这些接口没有鉴权、没有幂等号：同一个请求发两次就会扣 / 加两次钱，所以这里绝不自动重试，
 * 结果不确定时由 SkylbotExchange 回读余额判断。
 */
export interface SkylbotConfig {
  url: string;
  timeoutMs?: number;
}

/**
 * kind：
 *   insufficient → bolívares 不够（明确失败，钱没动）
 *   rejected     → 其它 4xx（参数错误等），Skylbot 在改余额之前就拒绝了，钱没动
 *   unavailable  → 超时 / 断线 / 5xx：钱可能动了也可能没动，需要回读余额确认
 */
export class SkylbotError extends Error {
  constructor(
    readonly kind: 'insufficient' | 'rejected' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

const DISCORD_ID = /^\d{5,25}$/;

export class SkylbotClient {
  private readonly base: string;

  constructor(private readonly cfg: SkylbotConfig) {
    this.base = cfg.url.replace(/\/+$/, '');
  }

  async balance(userId: string): Promise<number> {
    const n = await this.request<number>('GET', `/api/balance/${checkId(userId)}`);
    if (!Number.isSafeInteger(n)) throw new SkylbotError('unavailable', `unexpected balance ${String(n)}`);
    return n;
  }

  /** 从玩家的 Skylbot 账户扣 bolívares，返回扣完后的余额 */
  withdraw(userId: string, amount: number) {
    return this.move('withdraw', userId, amount);
  }

  /** 给玩家的 Skylbot 账户加 bolívares，返回加完后的余额 */
  deposit(userId: string, amount: number) {
    return this.move('deposit', userId, amount);
  }

  private async move(direction: 'withdraw' | 'deposit', userId: string, amount: number): Promise<number> {
    // Discord ID 超过 JS 安全整数，直接拼进 JSON 原文，Python 那边按任意精度整数解析
    const body = `{"user_id": ${checkId(userId)}, "amount": ${Math.trunc(amount)}}`;
    const r = await this.request<{ nuevo_balance: number; status: string }>('POST', `/api/balance/${direction}`, body);
    if (r.status !== 'ok' || !Number.isSafeInteger(r.nuevo_balance)) throw new SkylbotError('unavailable', 'unexpected response');
    return r.nuevo_balance;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 8_000),
      });
    } catch (err) {
      throw new SkylbotError('unavailable', err instanceof Error ? err.message : String(err));
    }
    const data = (await res.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
    if (res.ok && data !== undefined) return data;
    if (res.status >= 500 || data === undefined) throw new SkylbotError('unavailable', `skylbot HTTP ${res.status}`);
    if (data.error === 'Saldo insuficiente') throw new SkylbotError('insufficient', 'not enough bolívares');
    throw new SkylbotError('rejected', data.error ?? `skylbot HTTP ${res.status}`);
  }
}

function checkId(userId: string) {
  if (!DISCORD_ID.test(userId)) throw new SkylbotError('rejected', 'bad user id');
  return userId;
}
