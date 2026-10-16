import { D, netWorth } from '@catpital/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { avatarUrl } from '../../lib/discord';
import { fmt } from '../../lib/format';
import { type WsStatus, realtime } from '../../lib/ws';
import { useMarkets } from '../../stores/markets';
import { useSession } from '../../stores/session';

export function TopBar({ onSettings }: { onSettings: () => void }) {
  const { t } = useTranslation();
  const user = useSession((s) => s.user);
  const balance = useSession((s) => s.balance);
  const locked = useSession((s) => s.locked);
  const generation = useSession((s) => s.generation);
  const positions = useSession((s) => s.positions);
  const prices = useMarkets((s) => s.prices);
  const [ws, setWs] = useState<WsStatus>('connecting');
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
  const inDebt = D(balance).lt(0);

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-800 bg-ink-900 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <span className="text-xl">🐱</span>
        <span className="font-black tracking-wide">
          Cat<span className="text-gold">pital</span>
        </span>
        <span
          className={`ml-1 h-2 w-2 rounded-full ${ws === 'open' ? 'bg-emerald-400' : ws === 'connecting' ? 'animate-pulse bg-amber-400' : 'animate-pulse bg-blood'}`}
          title={ws === 'open' ? t('app.online') : t('app.offline')}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <Stat label={t('wallet.netWorth')} value={fmt(nw)} className={nw.lte(0) ? 'text-blood' : 'text-ink-100'} testId="net-worth" />
        <Stat label={t('wallet.balance')} value={fmt(balance)} className={inDebt ? 'text-blood' : ''} testId="balance" badge={inDebt ? t('wallet.debt') : undefined} />
        {D(locked).gt(0) && <Stat label={t('wallet.locked')} value={fmt(locked)} />}
        {user && (
          <div className="flex items-center gap-2">
            <img src={avatarUrl(user.id, user.avatarHash, 32)} alt="" className="h-7 w-7 rounded-full" />
            <div className="leading-tight">
              <div className="text-sm font-medium">{user.globalName ?? user.username}</div>
              <div className="text-[11px] text-ink-400">{t('wallet.generation', { n: generation })}</div>
            </div>
          </div>
        )}
        <button onClick={onSettings} className="rounded-md bg-ink-800 px-2.5 py-1.5 text-sm hover:bg-ink-700" aria-label={t('settings.title')} data-testid="open-settings">
          ⚙
        </button>
      </div>
    </header>
  );
}

function Stat({ label, value, className = '', badge, testId }: { label: string; value: string; className?: string; badge?: string; testId?: string }) {
  return (
    <div className="leading-tight">
      <div className="text-[11px] text-ink-400">
        {label}
        {badge && <span className="ml-1 rounded bg-blood px-1 text-[10px] text-white">{badge}</span>}
      </div>
      <div className={`font-mono font-semibold tabular-nums ${className}`} data-testid={testId}>
        {value}
      </div>
    </div>
  );
}
