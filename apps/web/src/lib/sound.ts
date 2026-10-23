/**
 * 全部音效与 BGM 由 WebAudio 实时合成：零音频文件、零外部请求，天然满足 Discord CSP。
 * 浏览器自动播放策略要求首次用户交互后才能出声 → unlock() 绑定在首次点击上。
 */
export type Sfx = 'click' | 'fill' | 'win' | 'bigWin' | 'liquidation' | 'bankrupt' | 'event' | 'danmaku' | 'error';

const PENTATONIC = [0, 3, 5, 7, 10, 12, 15];
const CHORDS = [
  [57, 60, 64, 67], // Am7
  [53, 57, 60, 64], // Fmaj7
  [48, 52, 55, 59], // Cmaj7
  [55, 59, 62, 65], // G7
];
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private bgmTimer: ReturnType<typeof setInterval> | null = null;
  private bgmStep = 0;
  private nextBgmTime = 0;
  sfxEnabled = true;
  bgmEnabled = false;

  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.pendingVolume / 100;
    this.master.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.connect(this.master);
    this.bgmGain = this.ctx.createGain();
    this.bgmGain.gain.value = this.bgmLevel();
    this.bgmGain.connect(this.master);
    if (this.bgmEnabled) this.startBgm();
  }

  setVolume(v0to100: number) {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v0to100 / 100));
    this.pendingVolume = v0to100;
  }
  private pendingVolume = 70;

  setSfx(on: boolean) {
    this.sfxEnabled = on;
  }

  /** 内置合成 BGM 的音量（0–100，50 ≈ 原来的固定音量） */
  setBgmVolume(v0to100: number) {
    this.pendingBgmVolume = v0to100;
    if (this.bgmGain) this.bgmGain.gain.value = this.bgmLevel();
  }
  private pendingBgmVolume = 50;
  private bgmLevel() {
    return 0.36 * Math.max(0, Math.min(1, this.pendingBgmVolume / 100));
  }

  setBgm(on: boolean) {
    this.bgmEnabled = on;
    if (on) this.startBgm();
    else this.stopBgm();
  }

  // ---------------------------------------------------------------------------
  // 合成原语
  // ---------------------------------------------------------------------------

  private tone(freq: number, start: number, dur: number, type: OscillatorType, peak: number, out: AudioNode, endFreq?: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.02, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(out);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  private noise(start: number, dur: number, peak: number, out: AudioNode, filterFrom: number, filterTo: number) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(filterFrom, start);
    f.frequency.exponentialRampToValueAtTime(filterTo, start + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(f).connect(g).connect(out);
    src.start(start);
  }

  play(name: Sfx) {
    if (!this.sfxEnabled || !this.ctx || !this.sfxGain) return;
    const t = this.ctx.currentTime + 0.01;
    const out = this.sfxGain;
    switch (name) {
      case 'click':
        this.tone(1200, t, 0.04, 'sine', 0.15, out);
        break;
      case 'danmaku':
        this.tone(1800, t, 0.05, 'sine', 0.05, out);
        break;
      case 'fill':
        this.tone(660, t, 0.08, 'triangle', 0.25, out);
        this.tone(990, t + 0.07, 0.12, 'triangle', 0.25, out);
        break;
      case 'error':
        this.tone(140, t, 0.18, 'square', 0.12, out, 110);
        break;
      case 'event':
        for (let i = 0; i < 3; i++) this.tone(1046, t + i * 0.16, 0.1, 'square', 0.12, out);
        break;
      case 'win':
        [72, 76, 79, 84].forEach((n, i) => this.tone(midi(n), t + i * 0.08, 0.25, 'triangle', 0.25, out));
        break;
      case 'bigWin':
        // 号角和弦 + 金币叮当
        [60, 64, 67, 72].forEach((n) => this.tone(midi(n), t, 1.2, 'sawtooth', 0.08, out));
        [72, 76, 79, 84, 88, 91, 96].forEach((n, i) => this.tone(midi(n), t + 0.1 + i * 0.07, 0.4, 'triangle', 0.2, out));
        for (let i = 0; i < 14; i++) this.tone(2000 + Math.random() * 2500, t + 0.5 + i * 0.06, 0.15, 'sine', 0.08, out);
        break;
      case 'liquidation':
        // 刀光：高频噪声扫过 + 低频下坠 + 重击
        this.noise(t, 0.35, 0.6, out, 8000, 400);
        this.tone(220, t + 0.05, 0.9, 'sawtooth', 0.35, out, 30);
        this.tone(55, t + 0.05, 0.6, 'sine', 0.8, out, 25);
        break;
      case 'bankrupt':
        // 下行小调 + 低沉钟声
        [64, 60, 57, 52].forEach((n, i) => this.tone(midi(n), t + i * 0.35, 0.8, 'triangle', 0.2, out));
        this.tone(41, t + 1.4, 2.2, 'sine', 0.7, out, 30);
        this.noise(t + 1.4, 1.2, 0.15, out, 300, 80);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // 生成式 Lo-fi BGM：和弦铺底 + 五声音阶点缀，100ms 预排程
  // ---------------------------------------------------------------------------

  private startBgm() {
    if (!this.ctx || this.bgmTimer) return;
    this.nextBgmTime = this.ctx.currentTime + 0.1;
    const beat = 0.5;
    this.bgmTimer = setInterval(() => {
      const ctx = this.ctx!;
      while (this.nextBgmTime < ctx.currentTime + 0.3) {
        const step = this.bgmStep++;
        const chord = CHORDS[Math.floor(step / 8) % CHORDS.length]!;
        if (step % 8 === 0) chord.forEach((n) => this.tone(midi(n), this.nextBgmTime, beat * 8, 'sine', 0.05, this.bgmGain!));
        if (step % 2 === 0) this.tone(midi(chord[0]! - 12), this.nextBgmTime, beat * 1.5, 'triangle', 0.08, this.bgmGain!);
        if (Math.random() < 0.35) {
          const n = chord[0]! + 12 + PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)]!;
          this.tone(midi(n), this.nextBgmTime, 0.4, 'sine', 0.04, this.bgmGain!);
        }
        this.nextBgmTime += beat;
      }
    }, 100);
  }

  private stopBgm() {
    if (this.bgmTimer) clearInterval(this.bgmTimer);
    this.bgmTimer = null;
  }

  get volume() {
    return this.pendingVolume;
  }
}

export const sound = new SoundEngine();
