import { D } from '@catpital/shared';
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

/** 每页显示几个市场（以后市场多了靠翻页） */
const PAGE_SIZE = 6;

/**
 * 📊 市场：自选顶部行情栏显示哪些市场、什么顺序。
 *   - 点市场那一行本身就是选中 / 取消（1–5 个），选中的行左边显示它在行情栏里的序号
 *   - 上方「行情栏顺序」一排小胶囊，用 ‹ › 左右挪动调整顺序（新选的排在最后）
 *   - 市场列表分页，每页 6 个
 * 样式沿用行情栏卡片的选中 / 未选中外观；保存后写进设置（本机 + 登录后同步到账号）。
 */
export function MarketPickerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const list = useMarkets((s) => s.list);
  const prices = useMarkets((s) => s.prices);
  const selected = useMarkets((s) => s.selected);
  const select = useMarkets((s) => s.select);
  const update = useSettings((s) => s.update);

  /** 已选市场，按行情栏顺序 */
  const [picked, setPicked] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  /** 点了满额 / 最后一个时的提示 */
  const [warn, setWarn] = useState<'full' | 'last' | null>(null);

  // 每次打开都从当前生效的配置开始。只在打开那一刻读取：市场列表在后台刷新（状态 / 开休市变化）时不能把正在改的选择冲掉
  useEffect(() => {
    if (!open) return;
    setPicked(visibleMarkets(useMarkets.getState().list, useSettings.getState().markets).map((m) => m.code));
    setPage(1);
    setWarn(null);
  }, [open]);

  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const pageItems = list.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const byCode = new Map(list.map((m) => [m.code, m]));

  const toggle = (code: string) => {
    if (picked.includes(code)) {
      if (picked.length <= MIN_PICKED_MARKETS) return void (setWarn('last'), sound.play('error'));
      setPicked(picked.filter((c) => c !== code));
    } else {
      if (picked.length >= MAX_PICKED_MARKETS) return void (setWarn('full'), sound.play('error'));
      setPicked([...picked, code]);
    }
    setWarn(null);
    sound.play('click');
  };

  /** 在行情栏顺序里左右挪一格 */
  const move = (code: string, dir: -1 | 1) => {
    const i = picked.indexOf(code);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= picked.length) return;
    const next = [...picked];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setPicked(next);
    sound.play('click');
  };

  const save = () => {
    update({ markets: picked });
    // 当前看的市场被隐藏了，就切到行情栏第一个
    if (!selected || !picked.includes(selected)) select(picked[0]!);
    sound.play('win');
    onClose();
  };

  const reset = () => {
    setPicked(list.slice(0, MAX_PICKED_MARKETS).map((m) => m.code));
    setWarn(null);
    sound.play('click');
  };

  return (
    <Modal open={open} onClose={onClose}>
      <div className="select-none p-4 sm:p-5" data-testid="market-picker">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="mr-auto text-lg font-black">📊 {t('picker.title')}</h2>
          <span className="rounded-full bg-ink-800 px-2.5 py-0.5 font-mono text-xs font-black text-candy-sun" data-testid="picker-count">
            {picked.length} / {MAX_PICKED_MARKETS}
          </span>
          <button className="chip" onClick={onClose} aria-label={t('settings.close')}>
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs text-ink-400">{t('picker.hint', { max: MAX_PICKED_MARKETS, min: MIN_PICKED_MARKETS })}</p>

        {/* 行情栏顺序：已选的小胶囊，‹ › 调整先后 */}
        <p className="mb-1.5 text-[11px] font-bold text-ink-400">{t('picker.order')}</p>
        <div className="mb-3 flex flex-wrap gap-1.5" data-testid="picker-order">
          {picked.map((code, i) => {
            const m = byCode.get(code);
            if (!m) return null;
            return (
              <span
                key={code}
                className="flex items-center gap-0.5 rounded-full border-2 border-candy-grape bg-candy-grape/20 py-0.5 pl-1 pr-1 text-xs font-extrabold text-ink-100"
                data-testid={`picker-chip-${code}`}
              >
                <button
                  type="button"
                  className="rounded-full px-1 text-ink-300 hover:text-ink-100 disabled:opacity-30"
                  disabled={i === 0}
                  onClick={() => move(code, -1)}
                  aria-label={t('picker.left')}
                >
                  ‹
                </button>
                <span className="font-mono text-[10px] text-candy-sun">{i + 1}</span>
                <span>{mascotOf(m.code, m.kind)}</span>
                <span>{codeLabel(m.code, m.kind)}</span>
                <button
                  type="button"
                  className="rounded-full px-1 text-ink-300 hover:text-ink-100 disabled:opacity-30"
                  disabled={i === picked.length - 1}
                  onClick={() => move(code, 1)}
                  aria-label={t('picker.right')}
                >
                  ›
                </button>
              </span>
            );
          })}
        </div>

        {/* 全部市场：点整行选中 / 取消 */}
        <ul className="space-y-2" data-testid="picker-list">
          {pageItems.map((m) => {
            const order = picked.indexOf(m.code);
            return (
              <li key={m.code}>
                <PickerRow
                  market={m}
                  name={m.nameI18n[i18n.language] ?? m.name}
                  price={prices[m.code]?.price ?? m.price}
                  order={order}
                  dimmed={order < 0 && picked.length >= MAX_PICKED_MARKETS}
                  onClick={() => toggle(m.code)}
                />
              </li>
            );
          })}
        </ul>

        {warn && (
          <p className="mt-2 text-center text-[11px] font-bold text-candy-sun" data-testid="picker-warn">
            ⚠ {t(warn === 'full' ? 'picker.full' : 'picker.last', { max: MAX_PICKED_MARKETS })}
          </p>
        )}

        {/* 翻页 */}
        <div className="mt-3 flex items-center justify-between gap-2" data-testid="picker-pager">
          <button className="chip" disabled={current <= 1} onClick={() => setPage(current - 1)} data-testid="picker-prev">
            ‹ {t('leaderboard.prev')}
          </button>
          <span className="text-xs font-bold text-ink-400">{t('picker.page', { page: current, total: pages })}</span>
          <button className="chip" disabled={current >= pages} onClick={() => setPage(current + 1)} data-testid="picker-next">
            {t('leaderboard.next')} ›
          </button>
        </div>

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

/**
 * 一行市场（整行就是按钮）：序号徽章 / 吉祥物 / 代码 + 名称 / 现价 + 涨跌。
 * 外观与顶部行情栏卡片一致：选中 = 紫框 + 立体投影，未选 = 暗框。窄屏时名称截断，不会把内容挤出框。
 */
function PickerRow({
  market: m,
  name,
  price,
  order,
  dimmed,
  onClick,
}: {
  market: MarketInfo;
  name: string;
  price: string;
  /** 在行情栏里的位置（从 0 开始）；-1 = 没选 */
  order: number;
  /** 已选满，这一行暂时选不了 */
  dimmed: boolean;
  onClick: () => void;
}) {
  const checked = order >= 0;
  const change = D(price).minus(m.initialPrice).div(m.initialPrice);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={checked}
      className={`flex w-full items-center gap-2.5 overflow-hidden rounded-2xl border-2 px-2.5 py-2 text-left transition-all ${
        checked
          ? '-translate-y-0.5 border-candy-grape bg-candy-grape/15 shadow-[0_5px_0_0_#6b4bc4]'
          : 'border-ink-700/70 bg-ink-900/85 shadow-[0_4px_0_0_rgba(10,6,22,0.6)] hover:border-ink-500'
      } ${dimmed ? 'opacity-60' : ''}`}
      data-testid={`picker-row-${m.code}`}
    >
      {/* 序号徽章：选中显示它是第几个，没选是空圈 */}
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 font-mono text-[11px] font-black ${
          checked ? 'border-candy-grape bg-candy-grape text-white' : 'border-ink-700 text-ink-500'
        }`}
      >
        {checked ? order + 1 : ''}
      </span>
      <span className="shrink-0 text-2xl">{mascotOf(m.code, m.kind)}</span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-extrabold">{codeLabel(m.code, m.kind)}</span>
        <span className="block truncate text-[11px] text-ink-400">{name}</span>
      </span>
      <span className="shrink-0 text-right font-mono text-xs tabular-nums">
        <span className="block text-ink-200">{fmt(price, Math.min(decimalsOf(m.tickSize), 4))}</span>
        <span className={change.gte(0) ? 'text-up' : 'text-down'}>{fmtPct(change, 1)}</span>
      </span>
    </button>
  );
}
