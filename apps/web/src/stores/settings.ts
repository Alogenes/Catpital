import { create } from 'zustand';
import { api } from '../lib/api';
import { BGM_OFF, BGM_SYNTH, bgm } from '../lib/bgm';
import { sound } from '../lib/sound';
import i18n, { detectLanguage } from '../i18n';

export type ChartType = 'candle' | 'line' | 'area';
export type Interval = 'M1' | 'M5' | 'M15' | 'H1' | 'D1';

export interface Settings {
  lang: string;
  vfx: boolean;
  /** 背景音乐：'off' / 'synth'（内置合成）/ public/bgm/ 下的文件名；只存本机 localStorage */
  bgmTrack: string;
  /** 背景音乐音量 0–100（与音效的总音量分开） */
  bgmVolume: number;
  sfx: boolean;
  danmaku: boolean;
  /** 红涨绿跌（中文默认开启） */
  redUp: boolean;
  volume: number;
  /** 解除杠杆限制（最高 200x，受各市场安全上限约束；服务端同样校验） */
  degenUnlock: boolean;
  /** 以下仅本地 */
  chartType: ChartType;
  interval: Interval;
}

const STORAGE_KEY = 'catpital.settings.v1';
const CLOUD_KEYS = ['lang', 'vfx', 'sfx', 'danmaku', 'redUp', 'volume', 'degenUnlock'] as const;

function readLocal(): Partial<Settings> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Settings> & { bgm?: boolean };
    // 旧版只有一个 BGM 开关：开着的迁移为内置合成曲
    if (raw.bgmTrack === undefined && raw.bgm !== undefined) raw.bgmTrack = raw.bgm ? BGM_SYNTH : BGM_OFF;
    delete raw.bgm;
    return raw;
  } catch {
    return {};
  }
}

function writeLocal(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式等 */
  }
}

function defaults(): Settings {
  const lang = detectLanguage();
  return { lang, vfx: true, bgmTrack: BGM_OFF, bgmVolume: 50, sfx: true, danmaku: true, redUp: lang.startsWith('zh'), volume: 70, degenUnlock: false, chartType: 'candle', interval: 'M1' };
}

/** 把设置作用到运行时：语言、涨跌色、音频 */
function apply(s: Settings) {
  if (i18n.language !== s.lang) void i18n.changeLanguage(s.lang);
  document.documentElement.lang = s.lang;
  document.documentElement.dataset.redUp = String(s.redUp);
  sound.setVolume(s.volume);
  sound.setSfx(s.sfx);
  bgm.set(s.bgmTrack, s.bgmVolume);
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;

interface SettingsStore extends Settings {
  update(patch: Partial<Settings>): void;
  /** 登录后合并云端设置（云端优先，本地 UI 偏好保留） */
  hydrateFromCloud(cloud: Partial<Settings> | null | undefined): void;
}

export const useSettings = create<SettingsStore>()((set, get) => {
  const initial = { ...defaults(), ...readLocal() };
  apply(initial);
  return {
    ...initial,
    update(patch) {
      const next = { ...get(), ...patch };
      set(patch);
      apply(next);
      writeLocal(next);
      // 云端同步（防抖）：只同步需要跨端的字段
      const cloudPatch = Object.fromEntries(CLOUD_KEYS.filter((k) => k in patch).map((k) => [k, next[k]]));
      if (Object.keys(cloudPatch).length === 0) return;
      if (syncTimer) clearTimeout(syncTimer);
      // 杠杆解锁会被服务端下单校验读取，必须立即同步；其余偏好防抖
      if ('degenUnlock' in patch) {
        void api.put('/me/settings', cloudPatch).catch(() => {});
        return;
      }
      syncTimer = setTimeout(() => void api.put('/me/settings', cloudPatch).catch(() => {}), 800);
    },
    hydrateFromCloud(cloud) {
      if (!cloud) return;
      const picked = Object.fromEntries(CLOUD_KEYS.filter((k) => cloud[k] !== undefined).map((k) => [k, cloud[k]]));
      const next = { ...get(), ...picked };
      set(picked);
      apply(next);
      writeLocal(next);
    },
  };
});
