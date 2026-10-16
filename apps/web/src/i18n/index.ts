import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

/**
 * 模块化语言包：自动加载 locales/<lang>/*.json。
 * 新增语言 = 新建一个文件夹并放入 translation.json（含 _meta.name），无需改任何代码。
 * 缺失的 key 自动回退到 zh-CN。
 */
const modules = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*/*.json', { eager: true });

const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, mod] of Object.entries(modules)) {
  const m = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!m) continue;
  const [, lang, ns] = m as unknown as [string, string, string];
  (resources[lang] ??= {})[ns] = mod.default;
}

export const LANGUAGES = Object.entries(resources).map(([code, ns]) => ({
  code,
  name: ((ns.translation?._meta as { name?: string } | undefined)?.name ?? code) as string,
}));

export const DEFAULT_LANG = 'zh-CN';

export function detectLanguage(preferred?: string | null): string {
  const candidates = [preferred, navigator.language, DEFAULT_LANG].filter(Boolean) as string[];
  for (const c of candidates) {
    if (resources[c]) return c;
    const base = c.split('-')[0];
    const hit = Object.keys(resources).find((k) => k.split('-')[0] === base);
    if (hit) return hit;
  }
  return DEFAULT_LANG;
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detectLanguage(),
  fallbackLng: DEFAULT_LANG,
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** 后端错误码 → 文案（未知码兜底） */
export function errorText(code: string): string {
  return i18n.exists(code) ? i18n.t(code) : i18n.t('error.unknown', { code });
}

export default i18n;
