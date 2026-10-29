import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../i18n';
import { ApiError, type PlayerProfile, api } from '../../lib/api';
import { Avatar } from '../common/Avatar';
import { Modal } from '../common/Modal';
import { RadarChart } from './RadarChart';

/** 存活时长：不到两天按小时，否则按天 */
const span = (hours: number, t: (k: string, o?: Record<string, unknown>) => string) =>
  hours < 48 ? t('profile.hours', { n: Math.round(hours * 10) / 10 }) : t('profile.days', { n: Math.round((hours / 24) * 10) / 10 });

/** 玩家主页：排行榜里点头像打开，五维雷达图 + 每一维的原始数据 */
export function UserProfileModal({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<PlayerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setData(null);
    setError(null);
    api
      .get<PlayerProfile>(`/users/${userId}/profile`)
      .then((d) => alive && setData(d))
      .catch((err: unknown) => alive && setError(err instanceof ApiError ? err.code : 'error.network'));
    return () => {
      alive = false;
    };
  }, [userId]);

  const rows = data
    ? [
        {
          key: 'profitability',
          icon: '💰',
          score: data.scores.profitability,
          detail:
            data.raw.winRate === null
              ? t('profile.noTrades')
              : t('profile.winRate', { pct: Math.round(data.raw.winRate * 1000) / 10, n: data.raw.closedTrades }),
        },
        {
          key: 'risk',
          icon: '🔥',
          score: data.scores.risk,
          detail: data.raw.avgLeverage === null ? t('profile.noPositions') : t('profile.avgLeverage', { x: data.raw.avgLeverage, n: data.raw.positions }),
        },
        { key: 'activity', icon: '⚡', score: data.scores.activity, detail: t('profile.tradesPerDay', { x: data.raw.tradesPerDay, n: data.raw.trades }) },
        {
          key: 'survival',
          icon: '🛡️',
          score: data.scores.survival,
          detail: t(data.raw.bankruptcies ? 'profile.survival' : 'profile.survivalAlive', { time: span(data.raw.survivalHours, t), n: data.raw.bankruptcies }),
        },
        { key: 'chat', icon: '💬', score: data.scores.chat, detail: t('profile.danmakuPerDay', { x: data.raw.danmakuPerDay, n: data.raw.danmaku }) },
      ]
    : [];

  return (
    <Modal open={userId !== null} onClose={onClose}>
      <div className="select-none p-5" data-testid="profile-modal">
        <div className="mb-3 flex items-center gap-3">
          {data ? (
            <Avatar userId={data.user.id} avatarHash={data.user.avatarHash} name={data.user.name} size={56} className="h-14 w-14 ring-2 ring-candy-grape/60" />
          ) : (
            <span className="h-14 w-14 rounded-full bg-ink-800" />
          )}
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-lg font-black">{data?.user.name ?? '…'}</p>
            {data && (
              <p className="text-xs text-ink-400">
                {t('wallet.generation', { n: data.user.generation })} · {t('profile.joined', { date: new Date(data.user.joinedAt).toLocaleDateString() })}
              </p>
            )}
          </div>
          <button className="chip" onClick={onClose} aria-label={t('settings.close')} data-testid="profile-close">
            ✕
          </button>
        </div>

        {!data && !error && (
          <div className="flex justify-center py-16">
            <span className="h-8 w-8 animate-spin rounded-full border-4 border-ink-700 border-t-candy-grape" />
          </div>
        )}
        {error && <p className="py-12 text-center text-sm font-bold text-blood">⚠ {errorText(error)}</p>}

        {data && (
          <>
            <div className="rounded-2xl bg-ink-850 px-2 py-3">
              <RadarChart axes={rows.map((r) => ({ label: t(`profile.axes.${r.key}`), icon: r.icon, score: r.score }))} />
            </div>
            <ul className="mt-3 space-y-1.5" data-testid="profile-stats">
              {rows.map((r) => (
                <li key={r.key} className="flex items-center gap-3 rounded-2xl bg-ink-850 px-3 py-2">
                  <span className="text-lg">{r.icon}</span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block text-sm font-bold">{t(`profile.axes.${r.key}`)}</span>
                    <span className="block truncate text-[11px] text-ink-400">{r.detail}</span>
                  </span>
                  <span className="font-mono text-lg font-black text-candy-sky">{r.score}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-center text-[11px] text-ink-500">{t('profile.note')}</p>
          </>
        )}
      </div>
    </Modal>
  );
}
