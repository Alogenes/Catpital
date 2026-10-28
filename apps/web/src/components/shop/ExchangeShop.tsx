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
 * 兑换商店（致敬抽卡游戏的充值页，深色毛玻璃 + 高对比亮金风格）：Skylbot 的 Bolívares ⇄ Catpital 的 Meuw Coin，1:1。
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

  /** 加载失败的错误码（后端没更新 / 没重启时常见），显示在横幅里并可重试，而不是把整个商店变成禁用状态 */
  const [loadError, setLoadError] = useState<string | null>(null);
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

  /** 兑换服务能不能用：加载中 / 加载失败 / 服务器没接 Skylbot 时卡片照样亮着，只是点不了 */
  const available = Boolean(state?.enabled);

  /** "大招"按钮：高饱和金橙渐变 + 厚底投影，悬停变亮，按下下沉 */
  const ultBtn =
    'rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 font-black text-slate-950 shadow-[0_4px_0_0_#b45309,0_0_18px_-4px_rgba(251,146,60,0.8)] transition-[filter,transform,box-shadow] duration-150 hover:brightness-110 active:translate-y-0.5 active:shadow-[0_2px_0_0_#b45309] disabled:cursor-not-allowed disabled:from-slate-600 disabled:to-slate-700 disabled:text-slate-300 disabled:shadow-none disabled:hover:brightness-100';

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
          {/* ---------- 深色毛玻璃主面板 ---------- */}
          <motion.div
            className="relative flex h-full max-h-[760px] w-full max-w-6xl overflow-hidden rounded-[28px] border border-slate-700/80 bg-slate-950/90 shadow-[0_0_48px_-12px_rgba(234,179,8,0.3),0_24px_64px_rgba(0,0,0,0.7)] backdrop-blur-xl"
            initial={{ scale: 0.96, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.97, y: 10 }}
            style={{
              backgroundImage:
                'radial-gradient(700px 360px at 85% -10%, rgba(234,179,8,0.10), transparent 60%), radial-gradient(800px 420px at 10% 110%, rgba(167,123,255,0.14), transparent 60%)',
            }}
          >
            {/* ---------- 左侧分页：稍亮的底色 + 分割线，与商品区物理隔开 ---------- */}
            <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900/50 md:flex">
              <div className="px-6 pb-6 pt-6">
                <h2 className="text-3xl font-black tracking-wide text-white">
                  🛍{' '}
                  <span className="bg-gradient-to-r from-yellow-300 to-orange-400 bg-clip-text text-transparent [filter:drop-shadow(0_0_10px_rgba(250,204,21,0.35))]">
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
                  className={`my-1 mr-3 flex items-center gap-3 rounded-r-2xl border-l-4 px-5 py-3.5 text-left text-base font-extrabold transition-all duration-200 ${
                    tab === d
                      ? 'border-yellow-400 bg-slate-800 text-white shadow-[0_0_18px_-6px_rgba(250,204,21,0.45)]'
                      : 'border-transparent text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                  }`}
                  data-testid={`shop-tab-${d}`}
                >
                  {d === 'in' ? <MeuwCoin size={30} /> : <Bolivar size={30} />}
                  {t(d === 'in' ? 'shop.tabIn' : 'shop.tabOut')}
                </button>
              ))}
              <p className="mt-auto px-6 pb-5 text-xs leading-relaxed text-slate-400">{t('shop.rateNote')}</p>
            </aside>

            <section className="flex min-w-0 flex-1 flex-col">
              {/* ---------- 顶栏：提示 + 金库显示器 + 关闭 ---------- */}
              <header className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-4 md:gap-3 md:px-8 md:pt-6">
                <p className="mr-auto hidden text-base font-bold text-slate-100 lg:block">{t(tab === 'in' ? 'shop.subtitleIn' : 'shop.subtitleOut')}</p>
                <div className="flex gap-1.5 md:hidden">
                  {(['in', 'out'] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setTab(d)}
                      className={`rounded-full border px-3 py-1 text-xs font-bold ${
                        tab === d ? 'border-yellow-400 bg-slate-800 text-white' : 'border-slate-700 bg-slate-900 text-slate-400'
                      }`}
                    >
                      {t(d === 'in' ? 'shop.tabIn' : 'shop.tabOut')}
                    </button>
                  ))}
                </div>
                <span
                  className="ml-auto flex items-center gap-2 rounded-full border border-yellow-500/30 bg-black/40 py-1 pl-1.5 pr-4 font-mono text-base font-bold text-yellow-400 shadow-[0_0_16px_-6px_rgba(234,179,8,0.8)] md:text-lg"
                  data-testid="shop-meuw"
                >
                  <MeuwCoin size={26} /> {fmt(liveMeuw)}
                </span>
                <span
                  className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-black/40 py-1 pl-1.5 pr-4 font-mono text-base font-bold text-emerald-400 shadow-[0_0_16px_-6px_rgba(16,185,129,0.8)] md:text-lg"
                  data-testid="shop-bolivares"
                >
                  <Bolivar size={26} /> {bolivares === null ? '—' : bolivares.toLocaleString('es-ES')}
                </span>
                <button
                  onClick={onClose}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 bg-slate-800/80 text-lg font-black text-slate-300 transition-colors duration-200 hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-400"
                  aria-label={t('settings.close')}
                  data-testid="shop-close"
                >
                  ✕
                </button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3 md:px-8">
                {/* ---------- 状态横幅：加载失败 / 未开放 / Skylbot 离线 ---------- */}
                {loadError && (
                  <div
                    className="mb-4 flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-300"
                    data-testid="shop-load-error"
                  >
                    ⚠ {t('shop.loadFailed', { code: loadError })}
                    <button onClick={() => void load()} className="rounded-full border border-red-400/50 px-3 py-1 text-xs text-red-200 hover:bg-red-500/20">
                      ⟳ {t('shop.retry')}
                    </button>
                  </div>
                )}
                {state && !state.enabled && (
                  <p className="mb-4 rounded-2xl border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-center text-sm font-bold text-yellow-300" data-testid="shop-disabled">
                    🔧 {t('shop.disabled')}
                  </p>
                )}
                {state?.enabled && bolivares === null && (
                  <p className="mb-4 rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-center text-xs text-slate-300">⚠ {t('shop.skylbotOffline')}</p>
                )}

                {/* ---------- 套餐：游戏道具卡 ---------- */}
                <div className="grid grid-cols-2 gap-3 md:gap-6 lg:grid-cols-3" data-testid="shop-grid">
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
                        className={`group relative overflow-hidden rounded-2xl border border-slate-700 bg-gradient-to-br from-slate-800 to-slate-900 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-all duration-300 ${
                          can
                            ? 'hover:-translate-y-1 hover:scale-[1.03] hover:border-yellow-500/50 hover:shadow-[0_0_20px_rgba(234,179,8,0.2)] active:scale-100'
                            : 'cursor-not-allowed'
                        }`}
                        data-testid={`shop-pack-${n}`}
                      >
                        {/* 道具展示区：中心金色光晕 */}
                        <div className="relative h-32 bg-[radial-gradient(circle_at_50%_72%,rgba(250,204,21,0.28),transparent_62%)] pt-3 md:h-40 md:pt-6">
                          <CoinPile tier={i} kind={tab === 'in' ? 'meuw' : 'bolivar'} />
                          {(enough || !available) && <span className="absolute right-3 top-2 text-sm text-yellow-300/70">✦</span>}
                        </div>
                        {/* 赛博朋克胶囊标签 */}
                        <span className="absolute left-0 top-0 rounded-br-lg rounded-tl-xl bg-pink-500 px-2 py-1 text-xs font-bold text-white shadow-[0_0_8px_#ec4899]">
                          1:1
                        </span>
                        {available && !enough && (
                          <span className="absolute right-2 top-2 rounded-full border border-red-400/40 bg-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-300">
                            {t('shop.notEnough')}
                          </span>
                        )}
                        <p className="px-3 pb-2 pt-1 text-center text-base font-black leading-tight text-white md:text-xl">
                          {n.toLocaleString('en-US')} <span className="text-slate-200">{receiveName}</span>
                        </p>
                        <div
                          className={`flex items-center justify-center gap-1.5 border-t border-slate-700 bg-black/30 py-2 font-mono text-base font-black md:text-lg ${
                            tab === 'in' ? 'text-emerald-400' : 'text-yellow-400'
                          }`}
                        >
                          {tab === 'in' ? <Bolivar size={22} /> : <MeuwCoin size={22} />}
                          {tab === 'in' ? bs(n) : `${n.toLocaleString('en-US')} Meuw`}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* ---------- 自定义数量 ---------- */}
                <div className="mt-5 flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-slate-700 bg-slate-900/60 px-4 py-3">
                  <span className="text-sm font-bold text-slate-200">{t('shop.custom')}</span>
                  <input
                    inputMode="numeric"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    placeholder="2500"
                    className="w-40 rounded-full border border-slate-600 bg-black/30 px-4 py-2 text-center font-mono text-lg text-white caret-emerald-400 outline-none transition-shadow placeholder:text-slate-500 focus:border-transparent focus:ring-2 focus:ring-emerald-400"
                    data-testid="shop-custom"
                  />
                  <button
                    disabled={!customAmount || !available || !affordable(customAmount)}
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
                className="absolute bottom-5 right-6 rounded-full border border-slate-600 bg-slate-800 px-5 py-2 text-sm font-bold text-white shadow-lg transition-colors hover:border-yellow-500/50 hover:shadow-[0_0_16px_rgba(234,179,8,0.25)] md:text-base"
                data-testid="shop-history-toggle"
              >
                📜 {t('shop.history')}
              </button>
              <span className="absolute bottom-1 right-6 font-mono text-[11px] text-slate-500">UID: {user?.id}</span>
              <AnimatePresence>
                {showHistory && state && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute bottom-16 right-6 max-h-72 w-80 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-3 text-sm text-slate-100 shadow-2xl"
                    data-testid="shop-history"
                  >
                    {state.history.length === 0 ? (
                      <p className="py-4 text-center text-xs text-slate-400">{t('shop.noHistory')}</p>
                    ) : (
                      state.history.map((h) => (
                        <div key={h.id} className="flex items-center justify-between border-b border-slate-800 py-1.5 last:border-0">
                          <span className="flex items-center gap-1.5">
                            {h.direction === 'IN' ? <MeuwCoin size={18} glow={false} /> : <Bolivar size={18} glow={false} />}
                            <b className="font-mono">{fmt(h.amount, 0)}</b>
                          </span>
                          <span
                            className={`text-xs font-bold ${h.status === 'COMPLETED' ? 'text-emerald-400' : h.status === 'FAILED' ? 'text-red-400' : 'text-yellow-400'}`}
                          >
                            {t(`shop.status.${h.status}`)}
                          </span>
                          <span className="font-mono text-[10px] text-slate-500">{new Date(h.createdAt).toLocaleString()}</span>
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
                    className="w-[min(92%,440px)] overflow-hidden rounded-3xl border border-slate-700 bg-gradient-to-br from-slate-800 to-slate-900 text-center text-white shadow-[0_0_40px_-8px_rgba(234,179,8,0.35)]"
                    data-testid="shop-confirm"
                  >
                    <div className="border-b border-slate-700 bg-slate-900/80 py-3 text-lg font-black">{t('shop.confirmTitle')}</div>
                    <div className="flex flex-col items-center gap-2 bg-[radial-gradient(circle_at_50%_40%,rgba(250,204,21,0.22),transparent_60%)] px-6 py-6">
                      <Icon size={88} />
                      <p className="mt-1 text-2xl font-black text-white">
                        {confirm.toLocaleString('en-US')} <span className="text-slate-200">{receiveName}</span>
                      </p>
                      <p className="flex items-center gap-1.5 text-sm text-slate-300">
                        {t('shop.cost')}
                        {tab === 'in' ? <Bolivar size={18} /> : <MeuwCoin size={18} />}
                        <b className={`font-mono ${tab === 'in' ? 'text-emerald-400' : 'text-yellow-400'}`}>
                          {tab === 'in' ? bs(confirm) : `${confirm.toLocaleString('en-US')} Meuw Coin`}
                        </b>
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 px-6 pb-6">
                      <button
                        onClick={() => setConfirm(null)}
                        className="rounded-full border border-slate-600 bg-slate-800 py-2.5 font-bold text-slate-200 transition-colors hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-400"
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
                  className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-slate-950/90 backdrop-blur-sm"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setReward(null)}
                  data-testid="shop-reward"
                >
                  <p className="bg-gradient-to-r from-yellow-300 to-orange-400 bg-clip-text text-2xl font-black tracking-widest text-transparent">
                    {t(reward.pending ? 'shop.pendingTitle' : 'shop.rewardTitle')}
                  </p>
                  <motion.div
                    initial={{ scale: 0.4, rotate: -20 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', stiffness: 220, damping: 12 }}
                    className="relative"
                  >
                    <span className="absolute inset-0 -z-10 animate-pulse rounded-full bg-yellow-400/40 blur-2xl" />
                    {reward.direction === 'in' ? <MeuwCoin size={128} /> : <Bolivar size={128} />}
                  </motion.div>
                  <p className="font-mono text-3xl font-black text-white [text-shadow:0_0_14px_rgba(250,204,21,0.7)]">
                    × {fmt(reward.amount, 0)} {reward.direction === 'in' ? 'Meuw Coin' : 'Bolívares'}
                  </p>
                  {reward.pending && <p className="max-w-sm text-center text-sm text-slate-300">{t('shop.pendingHint')}</p>}
                  <p className="text-xs text-slate-500">{t('shop.tapToClose')}</p>
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
