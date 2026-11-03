import { D } from '@catpital/shared';
import { Reorder, useDragControls } from 'framer-motion';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MarketInfo } from '../../lib/api';
import { decimalsOf, fmt, fmtPct } from '../../lib/format';
import { MAX_PICKED_MARKETS, MIN_PICKED_MARKETS, visibleMarkets } from '../../lib/marketPicks';
import { sound } from '../../lib/sound';
import { useMarkets } from '../../stores/markets';
import { useSettings } from '../../stores/settings';
import { Modal } from '../common/Modal';
import { codeLabel, mascotOf } from './MarketTabs';

/** 「更多市场」每页几个（以后市场多了靠翻页） */
const PAGE_SIZE = 6;

/**
 * 📊 市场：自选顶部行情栏显示哪些市场、什么顺序。分成两块，顺序只在一个地方体现，不会上下对不上：
 *   - 行情栏（已选 1–5 个）：从上到下就是行情栏从左到右；按住左边 ⠿ 拖动排序，点这一行移出
 *   - 更多市场（没选的）：分页，点一下加到行情栏最后
 * 行的外观沿用行情栏卡片（选中紫框 + 立体投影，未选暗框）；保存后写进设置（本机 + 登录后同步到账号）。
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

  const byCode = new Map(list.map((m) => [m.code, m]));
  const rest = list.filter((m) => !picked.includes(m.code));
  const pages = Math.max(1, Math.ceil(rest.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const pageItems = rest.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const full = picked.length >= MAX_PICKED_MARKETS;

  const remove = (code: string) => {
    if (picked.length <= MIN_PICKED_MARKETS) return void (setWarn('last'), sound.play('error'));
    setPicked(picked.filter((c) => c !== code));
    setWarn(null);
    sound.play('click');
  };
  const add = (code: string) => {
    if (full) return void (setWarn('full'), sound.play('error'));
    setPicked([...picked, code]);
    setWarn(null);
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
    setPage(1);
    setWarn(null);
    sound.play('click');
  };

  const rowProps = (m: MarketInfo) => ({ market: m, name: m.nameI18n[i18n.language] ?? m.name, price: prices[m.code]?.price ?? m.price });

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

        {/* 行情栏：已选，拖动排序 */}
        <p className="mb-1.5 text-[11px] font-bold text-ink-400">{t('picker.order')}</p>
        <Reorder.Group axis="y" values={picked} onReorder={setPicked} className="space-y-2" data-testid="picker-picked">
          {picked.map((code, i) => {
            const m = byCode.get(code);
            return m ? <PickedRow key={code} {...rowProps(m)} order={i} onClick={() => remove(code)} /> : null;
          })}
        </Reorder.Group>

        {warn && (
          <p className="mt-2 text-center text-[11px] font-bold text-candy-sun" data-testid="picker-warn">
            ⚠ {t(warn === 'full' ? 'picker.full' : 'picker.last', { max: MAX_PICKED_MARKETS })}
          </p>
        )}

        {/* 更多市场：没选的，分页，点一下加入 */}
        <p className="mb-1.5 mt-4 text-[11px] font-bold text-ink-400">{t('picker.more')}</p>
        {rest.length === 0 ? (
          <p className="rounded-2xl bg-ink-850/80 px-3 py-3 text-center text-xs text-ink-400">{t('picker.allIn')}</p>
        ) : (
          <ul className="space-y-2" data-testid="picker-list">
            {pageItems.map((m) => (
              <li key={m.code}>
                <RowBody {...rowProps(m)} badge={null} dimmed={full} onClick={() => add(m.code)} />
              </li>
            ))}
          </ul>
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

type RowData = { market: MarketInfo; name: string; price: string };

/** 已选的一行：左边 ⠿ 把手按住拖动（手机上不影响页面滚动），其余部分点一下移出 */
function PickedRow({ order, onClick, ...row }: RowData & { order: number; onClick: () => void }) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={row.market.code}
      dragListener={false}
      dragControls={controls}
      whileDrag={{ scale: 1.03, zIndex: 10 }}
      className="relative"
      data-testid={`picker-picked-${row.market.code}`}
    >
      <RowBody
        {...row}
        badge={order + 1}
        dimmed={false}
        onClick={onClick}
        handle={
          <button
            type="button"
            className="flex h-10 w-6 shrink-0 items-center justify-center rounded-lg text-lg text-ink-400 hover:text-ink-100"
            style={{ touchAction: 'none', cursor: 'grab' }}
            onPointerDown={(e) => controls.start(e)}
            aria-label="drag"
            data-testid={`picker-handle-${row.market.code}`}
          >
            ⠿
          </button>
        }
      />
    </Reorder.Item>
  );
}

/**
 * 一行市场：（把手）序号徽章 / 吉祥物 / 代码 + 名称 / 现价 + 涨跌。
 * 外观与顶部行情栏卡片一致：已选 = 紫框 + 立体投影，未选 = 暗框。窄屏时名称截断，不会把内容挤出框。
 */
function RowBody({
  market: m,
  name,
  price,
  badge,
  dimmed,
  onClick,
  handle,
}: RowData & {
  /** 已选时在行情栏里的序号；null = 没选 */
  badge: number | null;
  /** 已选满，这一行暂时加不进去 */
  dimmed: boolean;
  onClick: () => void;
  handle?: ReactNode;
}) {
  const checked = badge !== null;
  const change = D(price).minus(m.initialPrice).div(m.initialPrice);
  return (
    <div
      className={`flex w-full items-center overflow-hidden rounded-2xl border-2 transition-all ${
        checked
          ? 'border-candy-grape bg-candy-grape/15 shadow-[0_5px_0_0_#6b4bc4]'
          : 'border-ink-700/70 bg-ink-900/85 shadow-[0_4px_0_0_rgba(10,6,22,0.6)] hover:border-ink-500'
      } ${dimmed ? 'opacity-60' : ''} ${handle ? 'pl-1' : ''}`}
    >
      {handle}
      <button
        type="button"
        onClick={onClick}
        aria-pressed={checked}
        className={`flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-2.5 text-left ${handle ? 'pl-1' : 'pl-2.5'}`}
        data-testid={`picker-row-${m.code}`}
      >
        {/* 序号徽章：已选显示它在行情栏排第几，没选是空圈 */}
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 font-mono text-[11px] font-black ${
            checked ? 'border-candy-grape bg-candy-grape text-white' : 'border-ink-700 text-ink-500'
          }`}
        >
          {checked ? badge : '+'}
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
    </div>
  );
}
