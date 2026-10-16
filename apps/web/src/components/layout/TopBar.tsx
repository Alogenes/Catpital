import { D, netWorth } from '@catpital/shared';
import { useEffect, useMemo, useState } from 'react';
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
    <header className="bento flex flex-wrap items-center gap-3 px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="animate-bob text-2xl">🐱</span>
        <span className="text-lg font-black tracking-wide">
          Cat<span className="bg-gradient-to-r from-candy-sun to-candy-pink bg-clip-text text-transparent">pital</span>
        </span>
        <span
          className={`ml-1 h-2.5 w-2.5 rounded-full ${ws === 'open' ? 'bg-candy-mint' : ws === 'connecting' ? 'animate-pulse bg-candy-sun' : 'animate-pulse bg-blood'}`}
          title={ws === 'open' ? t('app.online') : t('app.offline')}
        />
      </div>

      {/* 中间：排行榜 / 人生履历 */}
      <nav className="flex flex-1 items-center justify-center gap-2">
        <button className={navBtn} onClick={() => open('leaderboard')} data-testid="open-leaderboard">
          🏆 <span>{t('nav.leaderboard')}</span>
        </button>
        <button className={navBtn} onClick={() => open('history')} data-testid="open-history">
          📜 <span>{t('nav.history')}</span>
        </button>
      </nav>

      <div className="flex flex-wrap items-center gap-2.5">
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
        {D(locked).gt(0) && <span className="chip font-mono">🔒 {D(locked).toFixed(2)}</span>}
        {user && (
          <div className="flex items-center gap-2 rounded-full bg-ink-850 py-1 pl-1 pr-3">
            <img src={avatarUrl(user.id, user.avatarHash, 32)} alt="" className="h-8 w-8 rounded-full ring-2 ring-candy-grape/60" />
            <div className="leading-tight">
              <div className="max-w-[110px] truncate text-sm font-bold">{user.globalName ?? user.username}</div>
              <div className="text-[10px] font-semibold text-candy-grape">{t('wallet.generation', { n: generation })}</div>
            </div>
          </div>
        )}
        <button
          onClick={onSettings}
          className="arcade-btn border-ink-950/60 bg-ink-800 px-2.5 py-1 text-base hover:bg-ink-700"
          aria-label={t('settings.title')}
          data-testid="open-settings"
        >
          ⚙️
        </button>
      </div>

      <LeaderboardModal open={modal === 'leaderboard'} onClose={() => setModal(null)} />
      <ResumeHistoryModal open={modal === 'history'} onClose={() => setModal(null)} />
    </header>
  );
}
