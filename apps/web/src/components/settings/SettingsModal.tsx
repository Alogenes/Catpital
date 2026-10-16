import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '../../i18n';
import { sound } from '../../lib/sound';
import { type Settings, useSettings } from '../../stores/settings';
import { Modal } from '../common/Modal';

function Toggle({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between py-2.5">
      <span className="text-sm">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        data-testid={testId}
        onClick={() => {
          sound.unlock();
          onChange(!checked);
        }}
        className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-ink-700'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </label>
  );
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const s = useSettings();
  const toggles: Array<[keyof Settings, string]> = [
    ['vfx', 'settings.vfx'],
    ['bgm', 'settings.bgm'],
    ['sfx', 'settings.sfx'],
    ['danmaku', 'settings.danmaku'],
    ['redUp', 'settings.redUp'],
  ];
  return (
    <Modal open={open} onClose={onClose}>
      <div className="p-5" data-testid="settings-modal">
        <h2 className="mb-3 text-lg font-bold">{t('settings.title')}</h2>
        <label className="flex items-center justify-between py-2.5">
          <span className="text-sm">{t('settings.language')}</span>
          <select
            value={s.lang}
            onChange={(e) => s.update({ lang: e.target.value })}
            className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-sm outline-none"
            data-testid="lang-select"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <div className="divide-y divide-ink-800">
          {toggles.map(([key, label]) => (
            <Toggle key={key} label={t(label)} checked={Boolean(s[key])} onChange={(v) => s.update({ [key]: v })} testId={`toggle-${key}`} />
          ))}
        </div>
        <label className="flex items-center justify-between gap-4 py-2.5">
          <span className="text-sm">{t('settings.volume')}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={s.volume}
            onChange={(e) => s.update({ volume: Number(e.target.value) })}
            onMouseUp={() => sound.play('click')}
            className="flex-1 accent-accent"
          />
          <span className="w-8 text-right font-mono text-xs">{s.volume}</span>
        </label>
        <button className="mt-3 w-full rounded-lg bg-accent py-2 text-sm font-semibold text-white" onClick={onClose}>
          {t('settings.close')}
        </button>
        <p className="mt-3 text-center text-[10px] text-ink-500">Charts by TradingView Lightweight Charts™ (Apache-2.0)</p>
      </div>
    </Modal>
  );
}
