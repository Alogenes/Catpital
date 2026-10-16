import { D, type Decimal } from '@catpital/shared';
import { z } from 'zod';

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string')
  .transform((v) => D(v));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  /** 留空 = 使用进程内事件总线（单实例开发 / 测试） */
  REDIS_URL: z.string().optional(),
  API_PORT: z.coerce.number().int().default(3001),
  API_BASE_PATH: z.string().default('/api'),
  WS_PATH: z.string().default('/ws'),
  JWT_SECRET: z.string().min(8),
  DISCORD_CLIENT_ID: z.string().default(''),
  DISCORD_CLIENT_SECRET: z.string().default(''),
  /** 仅开发：允许 POST /auth/dev 免 Discord 登录 */
  DEV_LOGIN: z.enum(['0', '1']).default('0'),
  /** 多实例部署时只允许一个实例运行行情/风控引擎 */
  ENGINE_ENABLED: z.enum(['0', '1']).default('1'),

  INITIAL_GRANT: decimalString.default('10000'),
  BANKRUPTCY_RELIEF: decimalString.default('5000'),
  BANKRUPTCY_DUST_THRESHOLD: decimalString.default('0'),
  LEADERBOARD_MIN_CAPITAL: decimalString.default('1000'),
  /** 单笔平仓 ROE ≥ 该值（1.0 = 100%）或盈利 ≥ PNL 阈值 → 全服高光播报 */
  BIG_WIN_ROE_THRESHOLD: decimalString.default('1.0'),
  BIG_WIN_PNL_THRESHOLD: decimalString.default('10000'),
  /** 穿仓额 ≥ 该值才全服播报（0 = 全部播报） */
  DEFICIT_BROADCAST_THRESHOLD: decimalString.default('0'),
  DANMAKU_COOLDOWN_MS: z.coerce.number().int().default(1500),
});

export type Env = Omit<
  z.infer<typeof schema>,
  | 'INITIAL_GRANT'
  | 'BANKRUPTCY_RELIEF'
  | 'BANKRUPTCY_DUST_THRESHOLD'
  | 'LEADERBOARD_MIN_CAPITAL'
  | 'BIG_WIN_ROE_THRESHOLD'
  | 'BIG_WIN_PNL_THRESHOLD'
  | 'DEFICIT_BROADCAST_THRESHOLD'
> & {
  INITIAL_GRANT: Decimal;
  BANKRUPTCY_RELIEF: Decimal;
  BANKRUPTCY_DUST_THRESHOLD: Decimal;
  LEADERBOARD_MIN_CAPITAL: Decimal;
  BIG_WIN_ROE_THRESHOLD: Decimal;
  BIG_WIN_PNL_THRESHOLD: Decimal;
  DEFICIT_BROADCAST_THRESHOLD: Decimal;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data as Env;
}

/** 引擎内部需要的经济参数子集（便于测试时直接构造） */
export type EconomyConfig = Pick<
  Env,
  | 'INITIAL_GRANT'
  | 'BANKRUPTCY_RELIEF'
  | 'BANKRUPTCY_DUST_THRESHOLD'
  | 'BIG_WIN_ROE_THRESHOLD'
  | 'BIG_WIN_PNL_THRESHOLD'
  | 'DEFICIT_BROADCAST_THRESHOLD'
>;
