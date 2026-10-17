import { D, netWorth } from '@catpital/shared';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { avatarUrl } from '../../lib/discord';
import { useSettledValue } from '../../lib/rolling';
import { sound } from '../../lib/sound';
import { type WsStatus, realtime } from '../../lib/ws';
import { useMarkets } from '../../stores/markets';
import { useSession } from '../../stores/session';
import { ResumeHistoryModal } from '../bankruptcy/ResumeHistoryModal';
import { LeaderboardModal } from '../leaderboard/LeaderboardModal';
import { WalletPill } from './WalletPill';

export function TopBar({ onSettings }: { onSettings: () => void }) {
  const { t } = useTranslation();
  const user = useSession((s) => s.user);
  const balance = useSession((s) => s.balance);
  const locked = useSession((s) => s.locked);
  const generation = useSession((s) => s.generation);
  const positions = useSession((s) => s.positions);
  const prices = useMarkets((s) => s.prices);
  const [ws, setWs] = useState<WsStatus>('connecting');
  const [modal, setModal] = useState<null | 'leaderboard' | 'history'>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  // 点菜单外任意处关闭（header 有 backdrop-filter，内部 fixed 遮罩只能盖住 header，所以用文档级监听）
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!headerRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);
  useEffect(() => realtime.onStatus(setWs), []);

  // 净值实时按最新价计算（同后端公式：B + locked + Σ(M + uPnL)）
  const nw = useMemo(
    () =>
      netWorth({
        balance: D(balance),
        locked: D(locked),
        positions: Object.values(positions).map((p) => ({
          side: p.side,
          quantity: D(p.quantity),
          entryPrice: D(p.entryPrice),
          margin: D(p.margin),
          markPrice: D(prices[p.market]?.price ?? p.entryPrice),
        })),
      }),
    [balance, locked, positions, prices],
  );
  // 去抖后的净值：吸收持仓/钱包事件到达先后造成的瞬时偏差
  const nwSettled = useSettledValue(nw.toDecimalPlaces(2).toFixed());
  const inDebt = D(balance).lt(0);
  const open = (m: 'leaderboard' | 'history') => {
    sound.play('click');
    setModal(m);
  };

  const navBtn =
    'arcade-btn flex items-center gap-1.5 border-ink-950/60 bg-ink-800 px-3.5 py-1.5 text-sm text-ink-100 hover:-translate-y-0.5 hover:bg-ink-700';

  return (
    <header ref={headerRef} className="bento relative flex items-center gap-2 px-2.5 py-1.5 md:flex-wrap md:gap-3 md:px-4 md:py-2">
      <div className="flex shrink-0 items-center gap-2">
        <span className="animate-bob text-xl md:text-2xl">🐱</span>
        <span className="hidden text-lg font-black tracking-wide md:inline">
          Cat<span className="bg-gradient-to-r from-candy-sun to-candy-pink bg-clip-text text-transparent">pital</span>
        </span>
        <span
          className={`h-2 w-2 rounded-full md:ml-1 md:h-2.5 md:w-2.5 ${ws === 'open' ? 'bg-candy-mint' : ws === 'connecting' ? 'animate-pulse bg-candy-sun' : 'animate-pulse bg-blood'}`}
          title={ws === 'open' ? t('app.online') : t('app.offline')}
        />
      </div>

      {/* 中间：排行榜 / 人生履历（手机端收进汉堡菜单） */}
      <nav className="hidden flex-1 items-center justify-center gap-2 md:flex">
        <button className={navBtn} onClick={() => open('leaderboard')} data-testid="open-leaderboard">
          🏆 <span>{t('nav.leaderboard')}</span>
        </button>
        <button className={navBtn} onClick={() => open('history')} data-testid="open-history">
          📜 <span>{t('nav.history')}</span>
        </button>
      </nav>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 md:flex-none md:flex-wrap md:gap-2.5">
        <WalletPill icon="💰" label={t('wallet.netWorth')} value={nwSettled} mode="netWorth" glow="sun" danger={D(nwSettled).lte(0)} testId="net-worth" />
        <WalletPill
          icon="🪙"
          label={t('wallet.balance')}
          value={D(balance).toDecimalPlaces(2).toFixed()}
          mode="balance"
          glow="grape"
          danger={inDebt}
          badge={inDebt ? t('wallet.debt') : undefined}
          testId="balance"
        />
        {D(locked).gt(0) && <span className="chip hidden font-mono md:inline-flex">🔒 {D(locked).toFixed(2)}</span>}
        {user && (
          <div className="hidden items-center gap-2 rounded-full bg-ink-850 py-1 pl-1 pr-3 md:flex">
            <img src={avatarUrl(user.id, user.avatarHash, 32)} alt="" className="h-8 w-8 rounded-full ring-2 ring-candy-grape/60" />
            <div className="leading-tight">
              <div className="max-w-[110px] truncate text-sm font-bold">{user.globalName ?? user.username}</div>
              <div className="text-[10px] font-semibold text-candy-grape">{t('wallet.generation', { n: generation })}</div>
            </div>
          </div>
        )}
        <button
          onClick={onSettings}
          className="arcade-btn hidden border-ink-950/60 bg-ink-800 px-2.5 py-1 text-base hover:bg-ink-700 md:inline-flex"
          aria-label={t('settings.title')}
          data-testid="open-settings"
        >
          ⚙️
        </button>
        {/* 手机端：汉堡菜单 */}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="arcade-btn flex h-9 w-9 shrink-0 items-center justify-center border-ink-950/60 bg-ink-800 text-lg md:hidden"
          aria-label={t('nav.menu')}
          aria-expanded={menuOpen}
          data-testid="open-menu"
        >
          {menuOpen ? '✕' : '☰'}
        </button>
      </div>

      <AnimatePresence>
        {menuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.97 }}
              className="absolute right-2 top-full z-50 mt-2 w-60 overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-[0_6px_0_0_rgba(10,6,22,0.7)] md:hidden"
              data-testid="mobile-menu"
            >
              {user && (
                <div className="flex items-center gap-2.5 border-b border-ink-800 px-3 py-3">
                  <img src={avatarUrl(user.id, user.avatarHash, 32)} alt="" className="h-9 w-9 rounded-full ring-2 ring-candy-grape/60" />
                  <div className="min-w-0 leading-tight">
                    <div className="truncate text-sm font-bold">{user.globalName ?? user.username}</div>
                    <div className="text-[11px] font-semibold text-candy-grape">{t('wallet.generation', { n: generation })}</div>
                  </div>
                </div>
              )}
              {D(locked).gt(0) && (
                <div className="border-b border-ink-800 px-3 py-2 font-mono text-xs text-ink-400">
                  🔒 {t('wallet.locked')} {D(locked).toFixed(2)}
                </div>
              )}
              {[
                ['🏆', t('nav.leaderboard'), () => open('leaderboard')],
                ['📜', t('nav.history'), () => open('history')],
                ['⚙️', t('settings.title'), onSettings],
              ].map(([icon, label, action]) => (
                <button
                  key={label as string}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-bold hover:bg-ink-800"
                  onClick={() => {
                    setMenuOpen(false);
                    (action as () => void)();
                  }}
                >
                  <span className="text-lg">{icon as string}</span>
                  {label as string}
                </button>
              ))}
            </motion.div>
        )}
      </AnimatePresence>

      <LeaderboardModal open={modal === 'leaderboard'} onClose={() => setModal(null)} />
      <ResumeHistoryModal open={modal === 'history'} onClose={() => setModal(null)} />
    </header>
  );
}
