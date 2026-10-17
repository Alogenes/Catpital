import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 仓库根目录的 .env（已被 .gitignore 忽略） */
export const ROOT_ENV_FILE = fileURLToPath(new URL('../../../../.env', import.meta.url));

/**
 * 读取仓库根目录的 .env（Node 内置 process.loadEnvFile）。
 * 已经存在的环境变量不会被覆盖：命令行 / 部署平台注入的值优先于 .env。
 */
export function loadDotenv(file = ROOT_ENV_FILE) {
  if (existsSync(file)) process.loadEnvFile(file);
}
