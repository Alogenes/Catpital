import { D } from '@catpital/shared';
import { motion } from 'framer-motion';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../i18n';
import { ApiError, type ResumeView, api } from '../../lib/api';
import { Avatar } from '../common/Avatar';
import { fmt, fmtDuration, fmtPct } from '../../lib/format';
import { sound } from '../../lib/sound';
import { useFeed } from '../../stores/feed';
import { useSession } from '../../stores/session';
import { Modal } from '../common/Modal';

/** 总资产 <= 0 且无持仓无挂单时出现：申请个人破产 */
export function BankruptcyPrompt() {
  const { t } = useTranslation();
  const available = useSession((s) => s.bankruptcyAvailable);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!available) return null;

  const declare = async () => {
    setBusy(true);
    sound.unlock();
    try {
      const resume = await api.post<ResumeView>('/bankruptcy');
      useSession.getState().setBankruptcyAvailable(false);
      // WS 也会推 resume 事件；这里直接展示，避免依赖网络时序
      useSession.getState().showResume(resume);
    } catch (e) {
      useFeed.getState().toast('error', errorText(e instanceof ApiError ? e.code : 'error.network'));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blood/60 bg-gradient-to-r from-blood/25 via-ink-900 to-ink-900 p-3"
      data-testid="bankruptcy-prompt"
    >
      <div>
        <h3 className="font-bold text-blood">⚰ {t('bankruptcy.available')}</h3>
        <p className="mt-0.5 max-w-xl text-xs text-ink-300">{t('bankruptcy.desc')}</p>
      </div>
      {confirming ? (
        <div className="flex gap-2">
          <button className="rounded-md bg-ink-700 px-3 py-2 text-sm" onClick={() => setConfirming(false)}>
            ✕
          </button>
          <button disabled={busy} className="rounded-md bg-blood px-4 py-2 text-sm font-bold text-white disabled:opacity-50" onClick={() => void declare()} data-testid="bankruptcy-confirm">
            {t('bankruptcy.confirm')}
          </button>
        </div>
      ) : (
        <button className="rounded-md border border-blood px-4 py-2 text-sm font-bold text-blood hover:bg-blood hover:text-white" onClick={() => setConfirming(true)} data-testid="bankruptcy-apply">
          {t('bankruptcy.apply')}
        </button>
      )}
    </motion.section>
  );
}

/** 履历卡片主体（破产弹窗与"历世履历"共用） */
export function ResumeCardBody({ resume, animate = true }: { resume: ResumeView; animate?: boolean }) {
  const { t } = useTranslation();
  const user = useSession((s) => s.user);
  const name = resume.user?.globalName ?? resume.user?.username ?? user?.globalName ?? user?.username ?? '';
  const stats = resumeStats(resume, t);
  return (
    <div className="relative overflow-hidden" data-testid="resume-card">
      <div className="bg-gradient-to-br from-ink-800 via-ink-900 to-ink-950 px-5 pb-4 pt-5">
        <p className="text-xs uppercase tracking-[0.3em] text-ink-400">📜 {t('bankruptcy.resume')}</p>
        <div className="mt-3 flex items-center gap-3">
          <Avatar userId={resume.userId} avatarHash={resume.user?.avatarHash ?? user?.avatarHash} name={name} size={64} className="h-14 w-14 border-2 border-ink-600 grayscale" />
          <div>
            <h2 className="text-xl font-bold">{name}</h2>
            <p className="text-sm text-ink-400">
              {t('bankruptcy.generation', { n: resume.generation })} · {new Date(resume.startedAt).toLocaleDateString()} – {new Date(resume.endedAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {resume.titles.map((k, i) => (
            <motion.span
              key={k}
              initial={animate ? { scale: 0, rotate: -10 } : false}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.2 + i * 0.15, type: 'spring' }}
              className="rounded-full border border-gold/60 bg-gold/10 px-3 py-1 text-sm font-semibold text-gold"
              title={t(`${k}.desc`)}
            >
              {t(`${k}.name`)}
            </motion.span>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-400">{resume.titles.map((k) => t(`${k}.desc`)).join(' · ')}</p>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-ink-800">
        {stats.map(([label, value, cls]) => (
          <div key={label} className="bg-ink-900 px-4 py-2.5">
            <dt className="text-xs text-ink-500">{label}</dt>
            <dd className={`font-mono text-sm font-semibold tabular-nums ${cls ?? 'text-ink-100'}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

type T = (k: string, o?: Record<string, unknown>) => string;

export function resumeStats(resume: ResumeView, t: T): Array<[string, string, string?]> {
  return [
    [t('bankruptcy.survived'), fmtDuration(resume.survivedSeconds, t)],
    [t('bankruptcy.peak'), fmt(resume.peakNetWorth)],
    [t('bankruptcy.bestRoe'), resume.bestTradeRoe ? fmtPct(resume.bestTradeRoe) : '—', 'text-up'],
    [t('bankruptcy.worstLoss'), resume.worstLiquidationLoss ? `-${fmt(resume.worstLiquidationLoss)}` : '—', 'text-blood'],
    [t('bankruptcy.fees'), fmt(resume.totalFeesPaid)],
    [t('bankruptcy.winRate'), fmtPct(resume.winRate, 1, false)],
    [t('bankruptcy.trades'), String(resume.closedTradeCount)],
    [t('bankruptcy.liquidations'), String(resume.liquidationCount)],
    [t('bankruptcy.avgLev'), `${fmt(resume.avgLeverage, 1)}x`],
    [t('bankruptcy.debt'), D(resume.debtWrittenOff).gt(0) ? fmt(resume.debtWrittenOff) : '0', 'text-blood'],
  ];
}

/** 《股市人生履历》破产弹窗：破产特效播完后弹出 */
export function ResumeModal() {
  const { t } = useTranslation();
  const resume = useSession((s) => s.resume);
  const fx = useFeed((s) => s.fx);
  const user = useSession((s) => s.user);
  const [copied, setCopied] = useState(false);
  const close = () => useSession.getState().showResume(null);

  const open = Boolean(resume) && fx?.kind !== 'bankrupt';
  if (!resume) return null;
  const name = resume.user?.globalName ?? resume.user?.username ?? user?.globalName ?? user?.username ?? '';
  const summary = [
    `【${t('bankruptcy.resume')}】${name} · ${t('bankruptcy.generation', { n: resume.generation })}`,
    resume.titles.map((k) => `「${t(`${k}.name`)}」`).join(' '),
    ...resumeStats(resume, t).map(([k, v]) => `${k}：${v}`),
  ].join('\n');

  return (
    <Modal open={open} onClose={close} className="max-w-lg">
      <div data-testid="resume-modal">
        <ResumeCardBody resume={resume} />
        <div className="flex gap-2 p-4">
          <button
            className="arcade-btn flex-1 border-ink-950/60 bg-ink-700 py-2 text-sm hover:bg-ink-600"
            onClick={() => {
              void navigator.clipboard?.writeText(summary).then(() => setCopied(true));
            }}
          >
            {copied ? t('bankruptcy.copied') : t('bankruptcy.copyLink')}
          </button>
          <button className="arcade-btn flex-1 border-[#6b4bc4] bg-accent py-2 text-sm text-white" onClick={close} data-testid="resume-rebirth">
            {t('bankruptcy.rebirth')} · +{fmt(resume.reliefGranted, 0)}
          </button>
        </div>
      </div>
    </Modal>
  );
}
