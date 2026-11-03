import { D } from '@catpital/shared';
import { Reorder, useDragControls } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MarketInfo } from '../../lib/api';
import { decimalsOf, fmt, fmtPct } from '../../lib/format';
import { MAX_PICKED_MARKETS, MIN_PICKED_MARKETS, visibleMarkets } from '../../lib/marketPicks';
import { sound } from '../../lib/sound';
import { useMarkets } from '../../stores/markets';
import { useSettings } from '../../stores/settings';
import { Modal } from '../common/Modal';
import { codeLabel, mascotOf } from './MarketTabs';

/**
 * 📊 市场：自选顶部行情栏显示哪些市场、什么顺序。
 * 勾选 1–5 个；按住左边的把手上下拖动排序（只有勾选的会显示，顺序就是行情栏的顺序）。
 * 保存后写进设置（本机 localStorage + 登录后同步到账号）。
 */
export function MarketPickerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const list = useMarkets((s) => s.list);
  const prices = useMarkets((s) => s.prices);
  const selected = useMarkets((s) => s.selected);
  const select = useMarkets((s) => s.select);
  const saved = useSettings((s) => s.markets);
  const update = useSettings((s) => s.update);

  /** 全部市场的排列顺序（勾选的排在前面） */
  const [order, setOrder] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // 每次打开都从当前生效的配置开始
  useEffect(() => {
    if (!open) return;
    const shown = visibleMarkets(list, saved).map((m) => m.code);
    setOrder([...shown, ...list.map((m) => m.code).filter((c) => !shown.includes(c))]);
    setChecked(new Set(shown));
  }, [open, list, saved]);

  const count = checked.size;
  const toggle = (code: string) => {
    const next = new Set(checked);
    if (next.has(code)) {
      if (next.size <= MIN_PICKED_MARKETS) return;
      next.delete(code);
    } else {
      if (next.size >= MAX_PICKED_MARKETS) return;
      next.add(code);
    }
    sound.play('click');
    setChecked(next);
  };

  const save = () => {
    const picked = order.filter((c) => checked.has(c));
    update({ markets: picked });
    // 当前看的市场被隐藏了，就切到行情栏第一个
    if (!selected || !picked.includes(selected)) select(picked[0]!);
    sound.play('win');
    onClose();
  };

  const reset = () => {
    const defaults = list.slice(0, MAX_PICKED_MARKETS).map((m) => m.code);
    setOrder([...defaults, ...list.map((m) => m.code).filter((c) => !defaults.includes(c))]);
    setChecked(new Set(defaults));
    sound.play('click');
  };

  const byCode = new Map(list.map((m) => [m.code, m]));

  return (
    <Modal open={open} onClose={onClose}>
      <div className="select-none p-5" data-testid="market-picker">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="mr-auto text-lg font-black">📊 {t('picker.title')}</h2>
          <span
            className={`rounded-full px-2.5 py-0.5 font-mono text-xs font-black ${count >= MAX_PICKED_MARKETS ? 'bg-candy-sun/20 text-candy-sun' : 'bg-candy-grape/20 text-candy-grape'}`}
            data-testid="picker-count"
          >
            {count} / {MAX_PICKED_MARKETS}
          </span>
          <button className="chip" onClick={onClose} aria-label={t('settings.close')}>
            ✕
          </button>
        </div>
        <p className="mb-4 text-xs text-ink-400">{t('picker.hint', { max: MAX_PICKED_MARKETS, min: MIN_PICKED_MARKETS })}</p>

        <Reorder.Group axis="y" values={order} onReorder={setOrder} className="space-y-2" data-testid="picker-list">
          {order.map((code) => {
            const m = byCode.get(code);
            if (!m) return null;
            return (
              <PickerRow
                key={code}
                market={m}
                name={m.nameI18n[i18n.language] ?? m.name}
                price={prices[code]?.price ?? m.price}
                checked={checked.has(code)}
                locked={checked.has(code) ? count <= MIN_PICKED_MARKETS : count >= MAX_PICKED_MARKETS}
                onToggle={() => toggle(code)}
              />
            );
          })}
        </Reorder.Group>

        {count >= MAX_PICKED_MARKETS && list.length > MAX_PICKED_MARKETS && (
          <p className="mt-3 text-center text-[11px] font-bold text-candy-sun">⚠ {t('picker.full', { max: MAX_PICKED_MARKETS })}</p>
        )}

        <div className="mt-4 grid grid-cols-[auto_1fr] gap-2">
          <button className="arcade-btn border-ink-950/60 bg-ink-800 px-4 py-2.5 text-sm text-ink-300" onClick={reset} data-testid="picker-reset">
            ↺ {t('picker.reset')}
          </button>
          <button className="arcade-btn border-[#6b4bc4] bg-candy-grape py-2.5 text-sm text-white" onClick={save} data-testid="picker-save">
            ✓ {t('picker.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 一行市场：拖动把手 + 吉祥物 / 代码 / 名称 / 现价 + 勾选开关 */
function PickerRow({
  market: m,
  name,
  price,
  checked,
  locked,
  onToggle,
}: {
  market: MarketInfo;
  name: string;
  price: string;
  checked: boolean;
  /** 不能再改：已勾选的是最后一个，或未勾选的但已经选满 */
  locked: boolean;
  onToggle: () => void;
}) {
  const controls = useDragControls();
  const change = D(price).minus(m.initialPrice).div(m.initialPrice);
  return (
    <Reorder.Item
      value={m.code}
      dragListener={false}
      dragControls={controls}
      className={`flex items-center gap-3 rounded-2xl border-2 px-2 py-2 transition-colors ${
        checked ? 'border-candy-grape/70 bg-candy-grape/10 shadow-[0_0_18px_-6px_#a77bff]' : 'border-ink-700/70 bg-ink-850/80'
      }`}
      whileDrag={{ scale: 1.03, boxShadow: '0 10px 24px -8px rgba(167,123,255,0.6)' }}
      data-testid={`picker-row-${m.code}`}
    >
      {/* 拖动把手：按住才拖，手机上不影响列表滚动 */}
      <button
        type="button"
        className="flex h-9 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-lg text-ink-500 hover:bg-ink-800 hover:text-ink-200 active:cursor-grabbing"
        onPointerDown={(e) => controls.start(e)}
        aria-label="drag"
      >
        ⠿
      </button>
      <span className="text-2xl">{mascotOf(m.code, m.kind)}</span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-sm font-extrabold">{codeLabel(m.code, m.kind)}</span>
        <span className="block truncate text-[11px] text-ink-400">{name}</span>
      </span>
      <span className="text-right font-mono text-xs tabular-nums">
        <span className="block text-ink-200">{fmt(price, Math.min(decimalsOf(m.tickSize), 4))}</span>
        <span className={change.gte(0) ? 'text-up' : 'text-down'}>{fmtPct(change, 1)}</span>
      </span>
      {/* 勾选开关 */}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={locked}
        onClick={onToggle}
        className={`relative h-7 w-12 shrink-0 rounded-full border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          checked ? 'border-candy-grape bg-candy-grape/40' : 'border-ink-700 bg-ink-900'
        }`}
        data-testid={`picker-toggle-${m.code}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full transition-all ${checked ? 'left-[22px] bg-white shadow-[0_0_10px_#a77bff]' : 'left-0.5 bg-ink-500'}`}
        />
      </button>
    </Reorder.Item>
  );
}
