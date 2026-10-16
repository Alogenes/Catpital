import { apiUrl } from './endpoints';

/** 后端返回的业务错误：code 为 i18n key（如 error.insufficientFunds） */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

let token: string | null = null;
export const setToken = (t: string | null) => {
  token = t;
};
export const getToken = () => token;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(apiUrl(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  // 422 = 订单被拒（业务上的正常结果），交给调用方判断
  if (!res.ok && res.status !== 422) {
    const code = (data as { error?: string } | null)?.error ?? `error.http${res.status}`;
    throw new ApiError(code, res.status);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// ---- 响应类型（金额一律为字符串） ----

export interface MarketInfo {
  code: string;
  name: string;
  nameI18n: Record<string, string>;
  kind: 'STOCK' | 'CRYPTO';
  dataSource: 'PROCEDURAL' | 'LIVE_API';
  status: 'ACTIVE' | 'HALTED' | 'DELISTED';
  open: boolean;
  price: string;
  initialPrice: string;
  tickSize: string;
  lotSize: string;
  minNotional: string;
  maxLeverage: string;
  maintenanceMarginRate: string;
  makerFeeRate: string;
  takerFeeRate: string;
  liquidationFeeRate: string;
}

export interface OrderView {
  id: string;
  market?: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  source: string;
  status: string;
  quantity: string;
  leverage: string;
  limitPrice: string | null;
  fillPrice?: string | null;
  lockedAmount?: string;
  realizedPnl?: string | null;
  realizedRoe?: string | null;
  rejectReason?: string | null;
  createdAt: number;
}

export interface ResumeView {
  id: string;
  userId: string;
  generation: number;
  startedAt: number;
  endedAt: number;
  survivedSeconds: number;
  startingBalance: string;
  peakNetWorth: string;
  finalBalance: string;
  debtWrittenOff: string;
  reliefGranted: string;
  bestTradeRoe: string | null;
  bestTradePnl: string | null;
  worstLiquidationLoss: string | null;
  totalFeesPaid: string;
  totalVolume: string;
  winRate: string;
  closedTradeCount: number;
  liquidationCount: number;
  deficitCount: number;
  avgLeverage: string;
  maxLeverageUsed: string;
  titles: string[];
  user?: { username: string; globalName: string | null; avatarHash: string | null };
}

export interface LeaderboardResponse {
  period: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  periodKey: string;
  board: 'RETURN_PCT' | 'NET_WORTH';
  periodEnd: number;
  minCapital: string;
  entries: Array<{ rank: number; userId: string; name: string; avatarHash: string | null; generation: number; value: string }>;
  me: { rank: number | null; value: string | null; eligible: boolean } | null;
  updatedAt: number;
}

export interface CandleRow {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
