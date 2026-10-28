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
 * 兑换商店（致敬抽卡游戏的充值页）：Skylbot 的 Bolívares ⇄ Catpital 的 Meuw Coin，1:1。
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

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/75 p-2 pt-[calc(var(--safe-top)+0.5rem)] backdrop-blur-sm md:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          data-testid="exchange-shop"
        >
          <motion.div
            className="relative flex h-full max-h-[760px] w-full max-w-6xl overflow-hidden rounded-[28px] border-2 border-[#e9dcc0]/40 bg-[#3b4262] shadow-2xl"
            initial={{ scale: 0.96, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.97, y: 10 }}
            style={{ backgroundImage: 'radial-gradient(900px 500px at 70% 0%, rgba(255,255,255,0.08), transparent 60%), linear-gradient(180deg, #4a5274 0%, #333a58 100%)' }}
          >
            {/* ---------- 左侧分页 ---------- */}
            <aside className="hidden w-60 shrink-0 flex-col bg-[#2a2f47]/90 md:flex">
              <div className="px-6 pb-6 pt-5">
                <h2 className="font-serif text-4xl font-bold tracking-wide text-[#e9dcc0] [text-shadow:0_2px_0_rgba(0,0,0,0.35)]">🛍 {t('shop.title')}</h2>
              </div>
              {(['in', 'out'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => {
                    sound.play('click');
                    setTab(d);
                  }}
                  className={`mx-2 my-1 flex items-center gap-3 rounded-r-full rounded-l-xl px-5 py-4 text-left text-lg font-bold transition-colors ${
                    tab === d ? 'bg-[#ece5d8] text-[#3b4262] shadow-[0_0_0_2px_rgba(255,255,255,0.4)_inset]' : 'text-[#e9dcc0] hover:bg-white/5'
                  }`}
                  data-testid={`shop-tab-${d}`}
                >
                  {d === 'in' ? <MeuwCoin size={30} /> : <Bolivar size={30} />}
                  {t(d === 'in' ? 'shop.tabIn' : 'shop.tabOut')}
                </button>
              ))}
              <p className="mt-auto px-6 pb-5 text-xs leading-relaxed text-[#e9dcc0]/60">{t('shop.rateNote')}</p>
            </aside>

            <section className="flex min-w-0 flex-1 flex-col">
              {/* ---------- 顶栏：提示 + 两种货币余额 + 关闭 ---------- */}
              <header className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-4 md:gap-3 md:px-8 md:pt-6">
                <p className="mr-auto hidden font-serif text-lg font-bold text-[#e9dcc0] [text-shadow:0_2px_0_rgba(0,0,0,0.3)] lg:block">
                  {t(tab === 'in' ? 'shop.subtitleIn' : 'shop.subtitleOut')}
                </p>
                <div className="flex gap-1.5 md:hidden">
                  {(['in', 'out'] as const).map((d) => (
                    <button key={d} onClick={() => setTab(d)} className={`rounded-full px-3 py-1 text-xs font-bold ${tab === d ? 'bg-[#ece5d8] text-[#3b4262]' : 'bg-black/25 text-[#e9dcc0]'}`}>
                      {t(d === 'in' ? 'shop.tabIn' : 'shop.tabOut')}
                    </button>
                  ))}
                </div>
                <span className="ml-auto flex items-center gap-2 rounded-full bg-black/30 py-1 pl-1.5 pr-4 font-mono text-base font-bold text-white md:text-lg" data-testid="shop-meuw">
                  <MeuwCoin size={26} /> {fmt(liveMeuw)}
                </span>
                <span className="flex items-center gap-2 rounded-full bg-black/30 py-1 pl-1.5 pr-4 font-mono text-base font-bold text-white md:text-lg" data-testid="shop-bolivares">
                  <Bolivar size={26} /> {bolivares === null ? '—' : bolivares.toLocaleString('es-ES')}
                </span>
                <button
                  onClick={onClose}
                  className="flex h-11 w-11 items-center justify-center rounded-full border-4 border-[#ece5d8]/80 bg-[#ece5d8]/20 text-2xl font-black text-[#ece5d8] hover:bg-[#ece5d8]/30"
                  aria-label={t('settings.close')}
                  data-testid="shop-close"
                >
                  ✕
                </button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-2 md:px-8">
                {state && !state.enabled && (
                  <p className="mb-4 rounded-2xl bg-black/30 px-4 py-3 text-center text-sm font-bold text-[#e9dcc0]" data-testid="shop-disabled">
                    🔧 {t('shop.disabled')}
                  </p>
                )}
                {state?.enabled && bolivares === null && (
                  <p className="mb-4 rounded-2xl bg-black/30 px-4 py-2 text-center text-xs text-[#e9dcc0]/80">⚠ {t('shop.skylbotOffline')}</p>
                )}

                {/* ---------- 套餐卡片 ---------- */}
                <div className="grid grid-cols-2 gap-3 md:gap-6 lg:grid-cols-3" data-testid="shop-grid">
                  {PACKAGES.map((n, i) => {
                    const can = Boolean(state?.enabled) && affordable(n);
                    return (
                      <motion.button
                        key={n}
                        whileHover={can ? { y: -4 } : undefined}
                        whileTap={can ? { scale: 0.97 } : undefined}
                        disabled={!can}
                        onClick={() => {
                          sound.play('click');
                          setConfirm(n);
                        }}
                        className={`group relative overflow-hidden rounded-xl border-[3px] border-[#ece5d8] bg-[#f5f1e8] text-left shadow-[0_6px_14px_rgba(0,0,0,0.35)] ${can ? '' : 'cursor-not-allowed opacity-50 grayscale'}`}
                        data-testid={`shop-pack-${n}`}
                      >
                        <div className="relative h-32 bg-gradient-to-b from-[#b9d4ee] via-[#dbe9f6] to-[#f5f1e8] pt-3 md:h-40 md:pt-6">
                          <CoinPile tier={i} kind={tab === 'in' ? 'meuw' : 'bolivar'} />
                          <span className="absolute right-3 top-2 text-lg text-white opacity-80">✦</span>
                        </div>
                        {/* "Bonus" 星章 → 1:1 */}
                        <span className="absolute -left-1 -top-1 flex h-16 w-16 rotate-[-8deg] items-center justify-center bg-[#e45b6a] text-center font-black leading-none text-white [clip-path:polygon(50%_0%,61%_12%,77%_7%,80%_23%,95%_29%,88%_44%,98%_58%,84%_67%,85%_83%,69%_84%,60%_98%,47%_88%,32%_96%,26%_81%,10%_79%,13%_63%,2%_50%,13%_37%,9%_21%,25%_19%,33%_4%)] md:h-20 md:w-20">
                          <span className="text-sm md:text-lg">1:1</span>
                        </span>
                        <p className="px-3 pb-2 pt-1 text-center font-serif text-base font-bold leading-tight text-[#4a4f63] md:text-2xl">
                          {n.toLocaleString('en-US')} {receiveName}
                        </p>
                        <div className="flex items-center justify-center gap-1.5 bg-gradient-to-r from-[#f3e2b3] via-[#f7ebc8] to-[#f3e2b3] py-2 font-serif text-lg font-bold text-[#4a4f63] md:text-2xl">
                          {tab === 'in' ? <Bolivar size={22} /> : <MeuwCoin size={22} />}
                          {tab === 'in' ? bs(n) : `${n.toLocaleString('en-US')} Meuw`}
                        </div>
                      </motion.button>
                    );
                  })}
                </div>

                {/* ---------- 自定义数量 ---------- */}
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2 rounded-2xl bg-black/25 px-4 py-3 text-[#e9dcc0]">
                  <span className="text-sm font-bold">{t('shop.custom')}</span>
                  <input
                    inputMode="numeric"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    placeholder="2500"
                    className="w-36 rounded-full border-2 border-[#ece5d8]/50 bg-black/30 px-4 py-1.5 text-center font-mono text-lg text-white outline-none focus:border-[#ece5d8]"
                    data-testid="shop-custom"
                  />
                  <button
                    disabled={!customAmount || !state?.enabled || !affordable(customAmount)}
                    onClick={() => customAmount && setConfirm(customAmount)}
                    className="rounded-full bg-[#ece5d8] px-5 py-1.5 font-bold text-[#3b4262] disabled:opacity-40"
                    data-testid="shop-custom-buy"
                  >
                    {t('shop.exchange')}
                  </button>
                </div>
              </div>

              {/* ---------- 右下角：兑换记录 / 底部 UID ---------- */}
              <button
                onClick={() => setShowHistory((v) => !v)}
                className="absolute bottom-5 right-6 rounded-full bg-[#ece5d8] px-5 py-2 text-sm font-bold text-[#3b4262] shadow-lg md:text-base"
                data-testid="shop-history-toggle"
              >
                {t('shop.history')}
              </button>
              <span className="absolute bottom-1 right-6 font-mono text-[11px] text-white/70">UID: {user?.id}</span>
              <AnimatePresence>
                {showHistory && state && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute bottom-16 right-6 max-h-72 w-80 overflow-y-auto rounded-2xl bg-[#f5f1e8] p-3 text-sm text-[#4a4f63] shadow-2xl"
                    data-testid="shop-history"
                  >
                    {state.history.length === 0 ? (
                      <p className="py-4 text-center text-xs">{t('shop.noHistory')}</p>
                    ) : (
                      state.history.map((h) => (
                        <div key={h.id} className="flex items-center justify-between border-b border-[#e3d9c3] py-1.5 last:border-0">
                          <span className="flex items-center gap-1.5">
                            {h.direction === 'IN' ? <MeuwCoin size={18} /> : <Bolivar size={18} />}
                            <b>{fmt(h.amount, 0)}</b>
                          </span>
                          <span className={`text-xs font-bold ${h.status === 'COMPLETED' ? 'text-[#2f8f5b]' : h.status === 'FAILED' ? 'text-[#c0392b]' : 'text-[#c98a16]'}`}>
                            {t(`shop.status.${h.status}`)}
                          </span>
                          <span className="font-mono text-[10px] text-[#8b8fa3]">{new Date(h.createdAt).toLocaleString()}</span>
                        </div>
                      ))
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>

            {/* ---------- 确认购买 ---------- */}
            <AnimatePresence>
              {confirm !== null && (
                <motion.div className="absolute inset-0 z-10 flex items-center justify-center bg-black/55" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <motion.div
                    initial={{ scale: 0.92 }}
                    animate={{ scale: 1 }}
                    className="w-[min(92%,460px)] overflow-hidden rounded-2xl bg-[#f5f1e8] text-center text-[#4a4f63] shadow-2xl"
                    data-testid="shop-confirm"
                  >
                    <div className="bg-[#e9dcc0] py-3 font-serif text-xl font-bold">{t('shop.confirmTitle')}</div>
                    <div className="flex flex-col items-center gap-2 px-6 py-5">
                      <Icon size={84} />
                      <p className="font-serif text-2xl font-bold">
                        {confirm.toLocaleString('en-US')} {receiveName}
                      </p>
                      <p className="flex items-center gap-1.5 text-sm">
                        {t('shop.cost')}
                        {tab === 'in' ? <Bolivar size={18} /> : <MeuwCoin size={18} />}
                        <b>{tab === 'in' ? bs(confirm) : `${confirm.toLocaleString('en-US')} Meuw Coin`}</b>
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 px-6 pb-5">
                      <button onClick={() => setConfirm(null)} className="flex items-center justify-center gap-2 rounded-full bg-[#4a5274] py-2.5 font-bold text-[#ece5d8]">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#ece5d8] text-sm text-[#4a5274]">✕</span>
                        {t('shop.cancel')}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void submit(confirm)}
                        className="flex items-center justify-center gap-2 rounded-full bg-[#4a5274] py-2.5 font-bold text-[#ece5d8] disabled:opacity-50"
                        data-testid="shop-confirm-ok"
                      >
                        <span className="flex h-6 w-6 items-center justify-center rounded-full border-[3px] border-[#f0b440] bg-transparent" />
                        {busy ? '…' : t('shop.confirm')}
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
                  className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setReward(null)}
                  data-testid="shop-reward"
                >
                  <p className="font-serif text-2xl font-bold tracking-widest text-[#e9dcc0]">{t(reward.pending ? 'shop.pendingTitle' : 'shop.rewardTitle')}</p>
                  <motion.div initial={{ scale: 0.4, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 220, damping: 12 }} className="relative">
                    <span className="absolute inset-0 -z-10 animate-pulse rounded-full bg-[#ffd166]/40 blur-2xl" />
                    {reward.direction === 'in' ? <MeuwCoin size={120} /> : <Bolivar size={120} />}
                  </motion.div>
                  <p className="font-mono text-3xl font-black text-white">
                    × {fmt(reward.amount, 0)} {reward.direction === 'in' ? 'Meuw Coin' : 'Bolívares'}
                  </p>
                  {reward.pending && <p className="max-w-sm text-center text-sm text-[#e9dcc0]/80">{t('shop.pendingHint')}</p>}
                  <p className="text-xs text-white/50">{t('shop.tapToClose')}</p>
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
