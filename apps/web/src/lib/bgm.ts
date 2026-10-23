import tracks from 'virtual:bgm-tracks';
import { sound } from './sound';

/** 'off' = 关闭；'synth' = 内置合成小调（不需要音频文件）；其余为 public/bgm/ 下的文件名 */
export type BgmTrackId = string;
export const BGM_OFF = 'off';
export const BGM_SYNTH = 'synth';

/** public/bgm/ 下的曲目（构建时扫描，见 vite.config.ts 的 bgmTracks 插件） */
export const BGM_TRACKS = tracks;

/**
 * 全局唯一的背景音乐播放器（循环播放）。
 *   - 浏览器自动播放策略：页面没有用户交互前 play() 会被拒绝。被拒绝时不报错，
 *     挂一次性监听，等用户第一次点击 / 按键 / 触摸后再播放。
 *   - 'synth' 交给 SoundEngine 的 WebAudio 合成，文件曲目用 <audio>。
 */
class BgmPlayer {
  private audio: HTMLAudioElement | null = null;
  private track: BgmTrackId = BGM_OFF;
  private volume = 50;
  private waiting = false;

  set(track: BgmTrackId, volume: number) {
    this.volume = Math.max(0, Math.min(100, volume));
    sound.setBgmVolume(this.volume);
    // 兼容旧设置里保存的完整文件名（song.mp3）
    const file = BGM_TRACKS.find((t) => t.id === track || t.sources.some((s) => s.file === track));
    // 清单里已经没有的曲目（文件被删）按关闭处理
    const next = file ? file.id : track === BGM_SYNTH ? track : BGM_OFF;
    if (this.audio) this.audio.volume = this.volume / 100;
    if (next === this.track) return;
    this.track = next;

    sound.setBgm(next === BGM_SYNTH);
    if (!file) {
      this.audio?.pause();
      return;
    }
    const audio = (this.audio ??= this.create());
    audio.src = `${import.meta.env.BASE_URL}bgm/${encodeURIComponent(pickSource(audio, file.sources))}`;
    audio.volume = this.volume / 100;
    this.tryPlay();
  }

  private create() {
    const a = new Audio();
    a.loop = true;
    a.preload = 'auto';
    a.addEventListener('error', () => console.warn('[bgm] failed to load', a.src));
    return a;
  }

  private tryPlay() {
    const audio = this.audio;
    if (!audio || this.track === BGM_OFF || this.track === BGM_SYNTH) return;
    audio.play().catch((err: unknown) => {
      // NotAllowedError = 还没有用户交互；其它错误（文件 404、格式不支持）只记日志
      if ((err as { name?: string })?.name === 'NotAllowedError') this.waitForGesture();
      else console.warn('[bgm] play failed', err);
    });
  }

  private waitForGesture() {
    if (this.waiting) return;
    this.waiting = true;
    const resume = () => {
      this.waiting = false;
      for (const ev of EVENTS) window.removeEventListener(ev, resume, true);
      this.tryPlay();
    };
    for (const ev of EVENTS) window.addEventListener(ev, resume, { capture: true, once: true });
  }
}

const EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;

/**
 * 按优先级挑第一个设备能播的格式（canPlayType 返回 'probably' / 'maybe' 即可）。
 * 例：Chromium 内核的 Discord 选 .opus；不支持 Ogg Opus 的老 iPhone 退到同名 .mp3。
 * 一个都不认时仍然试第一个，交给浏览器自己判断。
 */
export function pickSource(audio: Pick<HTMLAudioElement, 'canPlayType'>, sources: ReadonlyArray<{ file: string; type: string }>): string {
  return (sources.find((s) => audio.canPlayType(s.type) !== '') ?? sources[0]!).file;
}

export const bgm = new BgmPlayer();
