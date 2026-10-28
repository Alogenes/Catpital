import { D } from '@catpital/shared';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { fmt } from '../../lib/format';
import { sound } from '../../lib/sound';
import { useFeed } from '../../stores/feed';
import { useSession } from '../../stores/session';
import { Bolivar, CoinPile, MeuwCoin } from './art';

/**
 * 兑换商店（致敬抽卡游戏的充值页，暗黑霓虹 + 磨砂玻璃风格）：Skylbot 的 Bolívares ⇄ Catpital 的 Meuw Coin，1:1。
 *   左侧：充值 Meuw Coin / 兑回 Bolívares 两个分页
 *   中间：6 档套餐卡片 + 自定义数量；余额不够的卡片置灰
 *   顶部：两种货币余额；右下角兑换记录；底部 UID
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

export default function ExchangeShop({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const user = useSession((s) => s.user);
  const liveMeuw = useSession((s) => s.balance);
  const toast = useFeed((s) => s.toast);
  const [tab, setTab] = useState<Direction>('in');
  const [state, setState] = useState<ExchangeState | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [reward, setReward] = useState<{ amount: string; direction: Direction; pending: boolean } | null>(null);
  const [custom, setCustom] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(() => api.get<ExchangeState>('/exchange').then(setState).catch(() => setState(null)), []);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (confirm !== null ? setConfirm(null) : onClose());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, confirm, onClose]);

  const meuw = D(liveMeuw);
  const bolivares = state?.bolivares ?? null;
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

  /** 霓虹"大招"按钮：高饱和金橙渐变 + 厚底投影，按下时下沉 */
  const ultBtn =
    'rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 font-black text-ink-950 shadow-[0_4px_0_0_#b45309,0_0_18px_-4px_rgba(251,146,60,0.8)] transition-[filter,transform,box-shadow] duration-150 hover:brightness-110 active:translate-y-0.5 active:shadow-[0_2px_0_0_#b45309] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:brightness-100';

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[110] flex select-none items-center justify-center bg-black/70 p-2 pt-[calc(var(--safe-top)+0.5rem)] backdrop-blur-sm md:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          data-testid="exchange-shop"
        >
          {/* ---------- 磨砂玻璃主面板 + 霓虹描边 ---------- */}
          <motion.div
            className="relative flex h-full max-h-[760px] w-full max-w-6xl overflow-hidden rounded-[28px] border border-candy-grape/30 bg-ink-900/80 shadow-[0_0_48px_-10px_rgba(167,123,255,0.55),0_24px_64px_rgba(0,0,0,0.6)] backdrop-blur-md"
            initial={{ scale: 0.96, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.97, y: 10 }}
            style={{
              backgroundImage:
                'radial-gradient(700px 360px at 85% -10%, rgba(255,111,174,0.16), transparent 60%), radial-gradient(800px 420px at 10% 110%, rgba(167,123,255,0.18), transparent 60%)',
            }}
          >
            {/* ---------- 左侧分页 ---------- */}
            <aside className="hidden w-60 shrink-0 flex-col border-r border-candy-grape/15 bg-ink-950/50 md:flex">
              <div className="px-6 pb-6 pt-6">
                <h2 className="text-3xl font-black tracking-wide">
                  🛍{' '}
                  <span className="bg-gradient-to-r from-candy-sun to-candy-pink bg-clip-text text-transparent [filter:drop-shadow(0_0_10px_rgba(255,111,174,0.35))]">
                    {t('shop.title')}
                  </span>
                </h2>
              </div>
              {(['in', 'out'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => {
                    sound.play('click');
                    setTab(d);
                  }}
                  className={`mr-3 my-1 flex items-center gap-3 rounded-r-2xl border-l-4 px-5 py-3.5 text-left text-base font-extrabold transition-all duration-200 ${
                    tab === d
                      ? 'border-yellow-400 bg-gradient-to-r from-purple-600/50 to-transparent text-white shadow-[inset_0_0_24px_rgba(167,123,255,0.18)]'
                      : 'border-transparent text-ink-300 hover:bg-white/5 hover:text-ink-100'
                  }`}
                  data-testid={`shop-tab-${d}`}
                >
                  {d === 'in' ? <MeuwCoin size={30} /> : <Bolivar size={30} />}
                  {t(d === 'in' ? 'shop.tabIn' : 'shop.tabOut')}
                </button>
              ))}
              <p className="mt-auto px-6 pb-5 text-xs leading-relaxed text-ink-400">{t('shop.rateNote')}</p>
            </aside>

            <section className="flex min-w-0 flex-1 flex-col">
              {/* ---------- 顶栏：提示 + 两种货币余额 + 关闭 ---------- */}
              <header className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-4 md:gap-3 md:px-8 md:pt-6">
                <p className="mr-auto hidden text-base font-bold text-ink-200 lg:block">{t(tab === 'in' ? 'shop.subtitleIn' : 'shop.subtitleOut')}</p>
                <div className="flex gap-1.5 md:hidden">
                  {(['in', 'out'] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setTab(d)}
                      className={`rounded-full border px-3 py-1 text-xs font-bold ${
                        tab === d ? 'border-yellow-400/70 bg-purple-600/40 text-white' : 'border-ink-700 bg-ink-950/50 text-ink-300'
                      }`}
                    >
                      {t(d === 'in' ? 'shop.tabIn' : 'shop.tabOut')}
                    </button>
                  ))}
                </div>
                <span
                  className="ml-auto flex items-center gap-2 rounded-full border border-candy-sun/30 bg-ink-950/60 py-1 pl-1.5 pr-4 font-mono text-base font-bold text-candy-sun shadow-[0_0_14px_-6px_rgba(255,209,102,0.8)] md:text-lg"
                  data-testid="shop-meuw"
                >
                  <MeuwCoin size={26} /> {fmt(liveMeuw)}
                </span>
                <span
                  className="flex items-center gap-2 rounded-full border border-candy-mint/30 bg-ink-950/60 py-1 pl-1.5 pr-4 font-mono text-base font-bold text-candy-mint shadow-[0_0_14px_-6px_rgba(61,220,151,0.8)] md:text-lg"
                  data-testid="shop-bolivares"
                >
                  <Bolivar size={26} /> {bolivares === null ? '—' : bolivares.toLocaleString('es-ES')}
                </span>
                <button
                  onClick={onClose}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-ink-600 bg-ink-800/80 text-lg font-black text-ink-300 transition-colors duration-200 hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-400"
                  aria-label={t('settings.close')}
                  data-testid="shop-close"
                >
                  ✕
                </button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3 md:px-8">
                {state && !state.enabled && (
                  <p className="mb-4 rounded-2xl border border-candy-sun/30 bg-candy-sun/10 px-4 py-3 text-center text-sm font-bold text-candy-sun" data-testid="shop-disabled">
                    🔧 {t('shop.disabled')}
                  </p>
                )}
                {state?.enabled && bolivares === null && (
                  <p className="mb-4 rounded-2xl border border-ink-700 bg-ink-950/50 px-4 py-2 text-center text-xs text-ink-300">⚠ {t('shop.skylbotOffline')}</p>
                )}

                {/* ---------- 套餐：游戏道具卡 ---------- */}
                <div className="grid grid-cols-2 gap-3 md:gap-6 lg:grid-cols-3" data-testid="shop-grid">
                  {PACKAGES.map((n, i) => {
                    const can = Boolean(state?.enabled) && affordable(n);
                    return (
                      <button
                        key={n}
                        disabled={!can}
                        onClick={() => {
                          sound.play('click');
                          setConfirm(n);
                        }}
                        className={`group relative overflow-hidden rounded-2xl border bg-ink-800 text-left shadow-inner transition-all duration-300 ${
                          can
                            ? 'border-ink-700 hover:-translate-y-1 hover:scale-105 hover:border-yellow-400/60 hover:shadow-[0_0_15px_rgba(250,204,21,0.4)] active:scale-100'
                            : 'cursor-not-allowed border-ink-800 opacity-40 grayscale'
                        }`}
                        data-testid={`shop-pack-${n}`}
                      >
                        {/* 道具展示区：内凹 + 中心光晕 */}
                        <div className="relative h-32 bg-[radial-gradient(circle_at_50%_70%,rgba(255,209,102,0.22),transparent_62%)] pt-3 shadow-[inset_0_-12px_24px_-12px_rgba(10,6,22,0.9)] md:h-40 md:pt-6">
                          <CoinPile tier={i} kind={tab === 'in' ? 'meuw' : 'bolivar'} />
                          <span className="absolute right-3 top-2 text-sm text-candy-sun/70 transition-opacity group-hover:opacity-100 md:opacity-60">✦</span>
                        </div>
                        {/* 赛博朋克胶囊标签 */}
                        <span className="absolute left-0 top-0 rounded-br-lg rounded-tl-xl bg-pink-500 px-2 py-1 text-xs font-bold text-white shadow-[0_0_8px_#ec4899]">
                          1:1
                        </span>
                        <p className="px-3 pb-2 pt-1 text-center text-base font-black leading-tight text-ink-100 md:text-xl">
                          {n.toLocaleString('en-US')} <span className="text-ink-300">{receiveName}</span>
                        </p>
                        <div className="flex items-center justify-center gap-1.5 border-t border-ink-700/80 bg-ink-950/60 py-2 font-mono text-base font-black text-candy-sun md:text-lg">
                          {tab === 'in' ? <Bolivar size={22} /> : <MeuwCoin size={22} />}
                          {tab === 'in' ? bs(n) : `${n.toLocaleString('en-US')} Meuw`}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* ---------- 自定义数量 ---------- */}
                <div className="mt-5 flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-ink-700/80 bg-ink-950/40 px-4 py-3 shadow-inner">
                  <span className="text-sm font-bold text-ink-300">{t('shop.custom')}</span>
                  <input
                    inputMode="numeric"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    placeholder="2500"
                    className="w-40 rounded-full border border-ink-600 bg-black/30 px-4 py-2 text-center font-mono text-lg text-white caret-candy-mint outline-none transition-shadow placeholder:text-ink-600 focus:border-transparent focus:ring-2 focus:ring-candy-mint"
                    data-testid="shop-custom"
                  />
                  <button
                    disabled={!customAmount || !state?.enabled || !affordable(customAmount)}
                    onClick={() => customAmount && setConfirm(customAmount)}
                    className={`${ultBtn} px-6 py-2 text-base`}
                    data-testid="shop-custom-buy"
                  >
                    ⚡ {t('shop.exchange')}
                  </button>
                </div>
              </div>

              {/* ---------- 右下角：兑换记录 / 底部 UID ---------- */}
              <button
                onClick={() => setShowHistory((v) => !v)}
                className="absolute bottom-5 right-6 rounded-full border border-candy-grape/40 bg-ink-850/90 px-5 py-2 text-sm font-bold text-ink-100 shadow-[0_0_14px_-4px_rgba(167,123,255,0.7)] backdrop-blur transition-colors hover:border-candy-grape hover:bg-ink-800 md:text-base"
                data-testid="shop-history-toggle"
              >
                📜 {t('shop.history')}
              </button>
              <span className="absolute bottom-1 right-6 font-mono text-[11px] text-ink-500">UID: {user?.id}</span>
              <AnimatePresence>
                {showHistory && state && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute bottom-16 right-6 max-h-72 w-80 overflow-y-auto rounded-2xl border border-candy-grape/30 bg-ink-900/95 p-3 text-sm text-ink-200 shadow-[0_0_24px_-6px_rgba(167,123,255,0.6)] backdrop-blur-md"
                    data-testid="shop-history"
                  >
                    {state.history.length === 0 ? (
                      <p className="py-4 text-center text-xs text-ink-400">{t('shop.noHistory')}</p>
                    ) : (
                      state.history.map((h) => (
                        <div key={h.id} className="flex items-center justify-between border-b border-ink-800 py-1.5 last:border-0">
                          <span className="flex items-center gap-1.5">
                            {h.direction === 'IN' ? <MeuwCoin size={18} glow={false} /> : <Bolivar size={18} glow={false} />}
                            <b className="font-mono">{fmt(h.amount, 0)}</b>
                          </span>
                          <span
                            className={`text-xs font-bold ${h.status === 'COMPLETED' ? 'text-candy-mint' : h.status === 'FAILED' ? 'text-blood' : 'text-candy-sun'}`}
                          >
                            {t(`shop.status.${h.status}`)}
                          </span>
                          <span className="font-mono text-[10px] text-ink-500">{new Date(h.createdAt).toLocaleString()}</span>
                        </div>
                      ))
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>

            {/* ---------- 确认兑换 ---------- */}
            <AnimatePresence>
              {confirm !== null && (
                <motion.div
                  className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <motion.div
                    initial={{ scale: 0.92 }}
                    animate={{ scale: 1 }}
                    className="w-[min(92%,440px)] overflow-hidden rounded-3xl border border-candy-grape/40 bg-ink-900/95 text-center text-ink-100 shadow-[0_0_40px_-8px_rgba(167,123,255,0.7)]"
                    data-testid="shop-confirm"
                  >
                    <div className="border-b border-ink-700 bg-gradient-to-r from-purple-600/40 via-ink-850 to-pink-500/20 py-3 text-lg font-black">
                      {t('shop.confirmTitle')}
                    </div>
                    <div className="flex flex-col items-center gap-2 bg-[radial-gradient(circle_at_50%_40%,rgba(255,209,102,0.18),transparent_60%)] px-6 py-6">
                      <Icon size={88} />
                      <p className="mt-1 text-2xl font-black">
                        {confirm.toLocaleString('en-US')} <span className="text-ink-300">{receiveName}</span>
                      </p>
                      <p className="flex items-center gap-1.5 text-sm text-ink-300">
                        {t('shop.cost')}
                        {tab === 'in' ? <Bolivar size={18} /> : <MeuwCoin size={18} />}
                        <b className="font-mono text-candy-sun">{tab === 'in' ? bs(confirm) : `${confirm.toLocaleString('en-US')} Meuw Coin`}</b>
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 px-6 pb-6">
                      <button
                        onClick={() => setConfirm(null)}
                        className="rounded-full border border-ink-600 bg-ink-800 py-2.5 font-bold text-ink-200 transition-colors hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-400"
                      >
                        ✕ {t('shop.cancel')}
                      </button>
                      <button disabled={busy} onClick={() => void submit(confirm)} className={`${ultBtn} py-2.5`} data-testid="shop-confirm-ok">
                        {busy ? '…' : `⚡ ${t('shop.confirm')}`}
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ---------- 获得物品 ---------- */}
            <AnimatePresence>
              {reward && (
                <motion.button
                  className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-ink-950/85 backdrop-blur-sm"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setReward(null)}
                  data-testid="shop-reward"
                >
                  <p className="bg-gradient-to-r from-candy-sun to-candy-pink bg-clip-text text-2xl font-black tracking-widest text-transparent">
                    {t(reward.pending ? 'shop.pendingTitle' : 'shop.rewardTitle')}
                  </p>
                  <motion.div
                    initial={{ scale: 0.4, rotate: -20 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', stiffness: 220, damping: 12 }}
                    className="relative"
                  >
                    <span className="absolute inset-0 -z-10 animate-pulse rounded-full bg-candy-sun/40 blur-2xl" />
                    {reward.direction === 'in' ? <MeuwCoin size={128} /> : <Bolivar size={128} />}
                  </motion.div>
                  <p className="font-mono text-3xl font-black text-white [text-shadow:0_0_14px_rgba(255,209,102,0.7)]">
                    × {fmt(reward.amount, 0)} {reward.direction === 'in' ? 'Meuw Coin' : 'Bolívares'}
                  </p>
                  {reward.pending && <p className="max-w-sm text-center text-sm text-ink-300">{t('shop.pendingHint')}</p>}
                  <p className="text-xs text-ink-500">{t('shop.tapToClose')}</p>
                </motion.button>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
