import { D } from '@catpital/shared';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { fmt } from '../../lib/format';
import { sound } from '../../lib/sound';
import { useFeed } from '../../stores/feed';
import { useSession } from '../../stores/session';
import { Modal } from '../common/Modal';
import { Bolivar, CoinPile, MeuwCoin } from './art';

/**
 * 兑换商店：Skylbot 的 Bolívares ⇄ Catpital 的 Meuw Coin，1:1。
 * 画风与排行榜 / 设置等弹窗统一：复用 Modal、分段胶囊、arcade-btn、chip，配色只用项目自己的 ink / candy。
 *   顶部：两种货币余额；分段切换 充值 / 兑回
 *   中间：6 档套餐卡片（余额不够的卡片不置灰，只标"余额不足"）+ 自定义数量
 *   底部：兑换记录（展开）、汇率说明、UID
 */

interface ExchangeState {
  enabled: boolean;
  rate: number;
  meuw: string;
  bolivares: number | null;
  history: Array<{ id: string; direction: 'IN' | 'OUT'; amount: string; status: string; createdAt: number }>;
}

interface ExchangeResult {
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  amount: string;
  balance: string;
  bolivares: number | null;
}

type Direction = 'in' | 'out';
const PACKAGES = [1_000, 5_000, 10_000, 30_000, 50_000, 100_000];
const bs = (n: number | string) => `Bs. ${Number(n).toLocaleString('es-ES')}`;

/** 道具卡展示区的金色光晕（内联样式，不依赖任何 Tailwind 颜色类） */
const CARD_GLOW = { backgroundImage: 'radial-gradient(circle at 50% 72%, rgba(255,209,102,0.22), transparent 62%)' };

export default function ExchangeShop({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const user = useSession((s) => s.user);
  const liveMeuw = useSession((s) => s.balance);
  const toast = useFeed((s) => s.toast);
  const [tab, setTab] = useState<Direction>('in');
  const [state, setState] = useState<ExchangeState | null>(null);
  /** 加载失败的错误码：显示在横幅里并可重试，商店本身照常显示 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [reward, setReward] = useState<{ amount: string; direction: Direction; pending: boolean } | null>(null);
  const [custom, setCustom] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(
    () =>
      api
        .get<ExchangeState>('/exchange')
        .then((s) => {
          setState(s);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          setState(null);
          setLoadError(err instanceof ApiError ? err.code : 'error.network');
        }),
    [],
  );
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const meuw = D(liveMeuw);
  const bolivares = state?.bolivares ?? null;
  const available = Boolean(state?.enabled);
  // 余额够不够：充值看 bolívares（拿不到就不拦，交给后端判断），兑回看可用 Meuw Coin
  const affordable = (n: number) => (tab === 'in' ? bolivares === null || bolivares >= n : meuw.gte(n));

  const submit = async (amount: number) => {
    setBusy(true);
    try {
      const r = await api.post<ExchangeResult>(`/exchange/${tab}`, { amount: String(amount) });
      setConfirm(null);
      setCustom('');
      setReward({ amount: r.amount, direction: tab, pending: r.status === 'PENDING' });
      sound.play(r.status === 'PENDING' ? 'click' : 'win');
      setState((s) => (s ? { ...s, bolivares: r.bolivares ?? s.bolivares } : s));
      void load();
    } catch (err) {
      toast('error', errorText(err instanceof ApiError ? err.code : 'error.network'));
      sound.play('error');
    } finally {
      setBusy(false);
    }
  };

  const customAmount = /^\d{1,8}$/.test(custom) && Number(custom) > 0 ? Number(custom) : null;
  const Icon = tab === 'in' ? MeuwCoin : Bolivar;
  const receiveName = tab === 'in' ? 'Meuw Coin' : 'Bolívares';
  const priceText = (n: number) => (tab === 'in' ? bs(n) : `${n.toLocaleString('en-US')} Meuw`);
  const seg = (active: boolean) =>
    `flex flex-1 items-center justify-center gap-2 rounded-full py-1.5 text-sm font-bold transition-colors ${
      active ? 'bg-candy-grape text-white shadow-[0_2px_0_0_#6b4bc4]' : 'text-ink-400 hover:text-ink-100'
    }`;

  return (
    <>
      <Modal open={open} onClose={onClose} className="!max-w-4xl">
        <div className="select-none p-5" data-testid="exchange-shop">
          {/* ---------- 标题 + 两种货币余额 + 关闭 ---------- */}
          <div className="mb-1 flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <h2 className="mr-auto text-lg font-black">🛍 {t('shop.title')}</h2>
              <span className="flex items-center gap-1.5 rounded-full border border-candy-sun/40 bg-ink-850 py-0.5 pl-1 pr-3 font-mono text-sm font-bold text-candy-sun" data-testid="shop-meuw">
                <MeuwCoin size={22} /> {fmt(liveMeuw)}
              </span>
              <span className="flex items-center gap-1.5 rounded-full border border-candy-mint/40 bg-ink-850 py-0.5 pl-1 pr-3 font-mono text-sm font-bold text-candy-mint" data-testid="shop-bolivares">
                <Bolivar size={22} /> {bolivares === null ? '—' : bolivares.toLocaleString('es-ES')}
              </span>
            </div>
            <button className="chip shrink-0" onClick={onClose} aria-label={t('settings.close')} data-testid="shop-close">
              ✕
            </button>
          </div>
          <p className="mb-4 text-xs text-ink-400">{t(tab === 'in' ? 'shop.subtitleIn' : 'shop.subtitleOut')}</p>

          {/* ---------- 分段：充值 / 兑回（与排行榜的日 / 周 / 月一致） ---------- */}
          <div className="mb-4 flex gap-1 rounded-full bg-ink-850 p-1">
            {(['in', 'out'] as const).map((d) => (
              <button
                key={d}
                className={seg(tab === d)}
                onClick={() => {
                  sound.play('click');
                  setTab(d);
                }}
                data-testid={`shop-tab-${d}`}
              >
                {d === 'in' ? <MeuwCoin size={18} glow={false} /> : <Bolivar size={18} glow={false} />}
                {t(d === 'in' ? 'shop.tabIn' : 'shop.tabOut')}
              </button>
            ))}
          </div>

          {/* ---------- 状态提示 ---------- */}
          {loadError && (
            <div className="mb-4 flex flex-wrap items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-blood/60 bg-blood/10 px-3 py-2 text-sm font-bold text-blood" data-testid="shop-load-error">
              ⚠ {t(loadError === 'error.exchangeNotMigrated' ? 'error.exchangeNotMigrated' : 'shop.loadFailed', { code: loadError })}
              <button className="chip" onClick={() => void load()}>
                ⟳ {t('shop.retry')}
              </button>
            </div>
          )}
          {state && !state.enabled && (
            <p className="mb-4 rounded-2xl border-2 border-dashed border-candy-sun/50 bg-candy-sun/10 px-3 py-2 text-center text-sm font-bold text-candy-sun" data-testid="shop-disabled">
              🔧 {t('shop.disabled')}
            </p>
          )}
          {state?.enabled && bolivares === null && (
            <p className="mb-4 rounded-2xl bg-ink-850 px-3 py-2 text-center text-xs text-ink-300">⚠ {t('shop.skylbotOffline')}</p>
          )}

          {/* ---------- 套餐卡片 ---------- */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="shop-grid">
            {PACKAGES.map((n, i) => {
              const enough = affordable(n);
              const can = available && enough;
              return (
                <button
                  key={n}
                  disabled={!can}
                  onClick={() => {
                    sound.play('click');
                    setConfirm(n);
                  }}
                  className={`group relative overflow-hidden rounded-2xl border-2 bg-ink-850 text-left shadow-[0_4px_0_0_rgba(10,6,22,0.6)] transition-all duration-200 ${
                    can ? 'border-ink-700 hover:-translate-y-0.5 hover:border-candy-sun/70 hover:bg-ink-800' : 'cursor-not-allowed border-ink-800'
                  }`}
                  data-testid={`shop-pack-${n}`}
                >
                  {/* flex 居中：手机上卡片比金币堆窄，两边均匀溢出（卡片 overflow-hidden 裁掉），堆始终在正中 */}
                  <div className="relative flex h-28 justify-center pt-2 md:h-32 md:pt-3" style={CARD_GLOW}>
                    <CoinPile tier={i} kind={tab === 'in' ? 'meuw' : 'bolivar'} />
                  </div>
                  <span className="absolute left-2 top-2 rounded-full bg-candy-pink px-2 py-0.5 text-[10px] font-black text-white shadow-[0_2px_0_0_#b8336e]">1:1</span>
                  {available && !enough && (
                    <span className="absolute right-2 top-2 rounded-full bg-blood/20 px-2 py-0.5 text-[10px] font-bold text-blood">{t('shop.notEnough')}</span>
                  )}
                  <p className="px-3 pt-1 text-center text-sm font-black text-ink-100 md:text-base">
                    {n.toLocaleString('en-US')}{' '}
                    <span className="block text-xs font-bold text-ink-300 md:inline md:text-base">{receiveName}</span>
                  </p>
                  <p
                    className={`flex items-center justify-center gap-1 pb-2.5 pt-1 font-mono text-sm font-black ${tab === 'in' ? 'text-candy-mint' : 'text-candy-sun'}`}
                  >
                    {tab === 'in' ? <Bolivar size={18} glow={false} /> : <MeuwCoin size={18} glow={false} />}
                    {priceText(n)}
                  </p>
                </button>
              );
            })}
          </div>

          {/* ---------- 自定义数量（与排行榜"我的名次"同款虚线框） ---------- */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-candy-sun/50 px-3 py-2.5">
            <span className="text-sm font-bold">🐾 {t('shop.custom')}</span>
            <input
              inputMode="numeric"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="2500"
              className="w-36 rounded-full border-2 border-ink-700 bg-ink-850 px-4 py-1.5 text-center font-mono text-base font-bold text-ink-100 caret-candy-mint outline-none transition-colors placeholder:text-ink-600 focus:border-candy-mint"
              data-testid="shop-custom"
            />
            <button
              disabled={!customAmount || !available || !affordable(customAmount)}
              onClick={() => customAmount && setConfirm(customAmount)}
              className="arcade-btn border-[#c99a2e] bg-candy-sun px-5 py-1.5 text-sm text-ink-950"
              data-testid="shop-custom-buy"
            >
              ⚡ {t('shop.exchange')}
            </button>
          </div>

          {/* ---------- 兑换记录（展开在弹窗内） ---------- */}
          <div className="mt-4 flex items-center justify-between gap-2">
            <button className="chip" onClick={() => setShowHistory((v) => !v)} data-testid="shop-history-toggle">
              📜 {t('shop.history')} {showHistory ? '▴' : '▾'}
            </button>
            <span className="font-mono text-[10px] text-ink-500">UID: {user?.id}</span>
          </div>
          {showHistory && (
            <ol className="mt-2 space-y-1.5" data-testid="shop-history">
              {!state || state.history.length === 0 ? (
                <li className="py-3 text-center text-xs text-ink-400">{t('shop.noHistory')}</li>
              ) : (
                state.history.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 rounded-2xl bg-ink-850 px-3 py-2 text-sm">
                    {h.direction === 'IN' ? <MeuwCoin size={20} glow={false} /> : <Bolivar size={20} glow={false} />}
                    <b className="font-mono">{fmt(h.amount, 0)}</b>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-500">{new Date(h.createdAt).toLocaleString()}</span>
                    <span
                      className={`text-xs font-bold ${h.status === 'COMPLETED' ? 'text-candy-mint' : h.status === 'FAILED' ? 'text-blood' : 'text-candy-sun'}`}
                    >
                      {t(`shop.status.${h.status}`)}
                    </span>
                  </li>
                ))
              )}
            </ol>
          )}
          <p className="mt-3 text-center text-[11px] text-ink-500">{t('shop.rateNote')}</p>
        </div>
      </Modal>

      {/* ---------- 确认兑换（叠在商店上面的第二个弹窗） ---------- */}
      <Modal open={confirm !== null} onClose={() => setConfirm(null)} className="max-w-sm">
        {confirm !== null && (
          <div className="select-none p-5 text-center" data-testid="shop-confirm">
            <h3 className="mb-3 text-lg font-black">{t('shop.confirmTitle')}</h3>
            <div className="flex flex-col items-center gap-2 rounded-2xl bg-ink-850 px-4 py-5" style={CARD_GLOW}>
              <Icon size={80} />
              <p className="text-xl font-black">
                {confirm.toLocaleString('en-US')} <span className="text-ink-300">{receiveName}</span>
              </p>
              <p className="flex items-center gap-1.5 text-sm text-ink-400">
                {t('shop.cost')}
                <b className={`font-mono ${tab === 'in' ? 'text-candy-mint' : 'text-candy-sun'}`}>{priceText(confirm)}</b>
              </p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button className="arcade-btn border-ink-950/60 bg-ink-800 py-2.5 text-sm text-ink-300" onClick={() => setConfirm(null)}>
                ✕ {t('shop.cancel')}
              </button>
              <button
                disabled={busy}
                onClick={() => void submit(confirm)}
                className="arcade-btn border-[#c99a2e] bg-candy-sun py-2.5 text-sm text-ink-950"
                data-testid="shop-confirm-ok"
              >
                {busy ? '…' : `⚡ ${t('shop.confirm')}`}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ---------- 获得物品 ---------- */}
      <Modal open={reward !== null} onClose={() => setReward(null)} className="max-w-sm">
        {reward && (
          <button className="flex w-full select-none flex-col items-center gap-3 p-6 text-center" onClick={() => setReward(null)} data-testid="shop-reward">
            <p className="text-lg font-black text-candy-sun">{t(reward.pending ? 'shop.pendingTitle' : 'shop.rewardTitle')}</p>
            <div className="animate-bob">{reward.direction === 'in' ? <MeuwCoin size={110} /> : <Bolivar size={110} />}</div>
            <p className="font-mono text-2xl font-black text-ink-100">
              × {fmt(reward.amount, 0)} {reward.direction === 'in' ? 'Meuw Coin' : 'Bolívares'}
            </p>
            {reward.pending && <p className="text-xs text-ink-300">{t('shop.pendingHint')}</p>}
            <p className="text-[11px] text-ink-500">{t('shop.tapToClose')}</p>
          </button>
        )}
      </Modal>
    </>
  );
}
