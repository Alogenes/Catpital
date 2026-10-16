import { DANMAKU_MAX_LENGTH } from '@catpital/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sound } from '../../lib/sound';
import { realtime } from '../../lib/ws';
import { useSettings } from '../../stores/settings';

export function DanmakuInput({ market }: { market: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const enabled = useSettings((s) => s.danmaku);
  const update = useSettings((s) => s.update);

  const send = () => {
    const v = text.trim();
    if (!v) return;
    realtime.danmaku(market, v);
    sound.play('danmaku');
    setText('');
  };

  return (
    <form
      className="flex items-center gap-2 border-t border-ink-800 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <button
        type="button"
        title={t('settings.danmaku')}
        onClick={() => update({ danmaku: !enabled })}
        className={`rounded px-1.5 py-1 text-xs font-bold ${enabled ? 'bg-accent/20 text-accent' : 'bg-ink-800 text-ink-500 line-through'}`}
      >
        弹
      </button>
      <input
        value={text}
        maxLength={DANMAKU_MAX_LENGTH}
        onChange={(e) => setText(e.target.value)}
        placeholder={enabled ? t('danmaku.placeholder') : t('danmaku.off')}
        className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-sm outline-none placeholder:text-ink-500 focus:border-accent"
        data-testid="danmaku-input"
      />
      <button type="submit" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/85 disabled:opacity-40" disabled={!text.trim()}>
        {t('danmaku.send')}
      </button>
    </form>
  );
}
