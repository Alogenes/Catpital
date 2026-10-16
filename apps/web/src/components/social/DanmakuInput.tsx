import { DANMAKU_MAX_LENGTH } from '@catpital/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sound } from '../../lib/sound';
import { realtime } from '../../lib/ws';
import { useSettings } from '../../stores/settings';

/** 一键快捷弹幕：emoji 按钮，点击直接发射对应短语（文案在语言包 danmaku.quick.*） */
const QUICK = [
  ['rocket', '🚀'],
  ['diamond', '💎'],
  ['meow', '🐱'],
  ['rekt', '🩸'],
  ['clown', '🤡'],
  ['party', '🎉'],
] as const;

/** 与服务端弹幕冷却一致，客户端先挡住，避免连点刷出错误提示 */
const COOLDOWN_MS = 1500;

export function DanmakuInput({ market }: { market: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [coolUntil, setCoolUntil] = useState(0);
  const [, force] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const enabled = useSettings((s) => s.danmaku);
  const update = useSettings((s) => s.update);
  const cooling = coolUntil > Date.now();

  useEffect(() => () => clearTimeout(timer.current), []);

  const fire = (raw: string): boolean => {
    const v = raw.trim();
    if (!v || cooling) return false;
    realtime.danmaku(market, v);
    sound.play('danmaku');
    setCoolUntil(Date.now() + COOLDOWN_MS);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => force((n) => n + 1), COOLDOWN_MS);
    return true;
  };

  return (
    <form
      className="relative flex flex-wrap items-center gap-1.5 bg-gradient-to-t from-ink-950/60 to-transparent px-3 pb-3 pt-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (fire(text)) setText('');
      }}
    >
      <button
        type="button"
        title={t('settings.danmaku')}
        onClick={() => update({ danmaku: !enabled })}
        className={`h-8 shrink-0 rounded-full px-2.5 text-xs font-black ${enabled ? 'bg-candy-grape/25 text-candy-grape' : 'bg-ink-800 text-ink-500 line-through'}`}
      >
        弹
      </button>
      <div className="flex shrink-0 gap-1" data-testid="danmaku-quick">
        {QUICK.map(([key, emoji]) => (
          <button
            key={key}
            type="button"
            title={t(`danmaku.quick.${key}`)}
            disabled={cooling}
            onClick={() => fire(t(`danmaku.quick.${key}`))}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-800/90 text-base transition-transform hover:-translate-y-0.5 hover:bg-ink-700 active:scale-90 disabled:opacity-40"
          >
            {emoji}
          </button>
        ))}
      </div>
      <input
        value={text}
        maxLength={DANMAKU_MAX_LENGTH}
        onChange={(e) => setText(e.target.value)}
        placeholder={enabled ? t('danmaku.placeholder') : t('danmaku.off')}
        className="h-8 min-w-[120px] flex-1 rounded-full border border-ink-700 bg-ink-850/90 px-3 text-sm outline-none placeholder:text-ink-500 focus:border-candy-grape"
        data-testid="danmaku-input"
      />
      <button
        type="submit"
        className="h-8 shrink-0 rounded-full bg-candy-grape px-3.5 text-sm font-bold text-white shadow-[0_2px_0_0_#6b4bc4] hover:brightness-110 disabled:opacity-40"
        disabled={!text.trim() || cooling}
      >
        {t('danmaku.send')}
      </button>
      {cooling && (
        <span
          key={coolUntil}
          className="absolute bottom-1 left-3 right-3 h-0.5 origin-left rounded bg-candy-grape/70"
          style={{ animation: `cooldown ${COOLDOWN_MS}ms linear forwards` }}
        />
      )}
    </form>
  );
}
