import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ResumeView, api } from '../../lib/api';
import { fmt, fmtDuration } from '../../lib/format';
import { useSession } from '../../stores/session';
import { Modal } from '../common/Modal';
import { ResumeCardBody } from './Bankruptcy';

/** 📜 历世履历：自己每一世的破产称号卡片，点击展开完整履历 */
export function ResumeHistoryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const user = useSession((s) => s.user);
  const generation = useSession((s) => s.generation);
  const [list, setList] = useState<ResumeView[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !user) return;
    setList(null);
    void api
      .get<ResumeView[]>(`/users/${user.id}/resumes`)
      .then(setList)
      .catch(() => setList([]));
  }, [open, user, generation]);

  return (
    <Modal open={open} onClose={onClose} className="max-w-xl">
      <div className="p-5" data-testid="history-modal">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-black">📜 {t('history.title')}</h2>
          <button className="chip" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 当前这一世 */}
        <div className="mb-3 flex items-center justify-between rounded-2xl border-2 border-dashed border-candy-mint/50 bg-candy-mint/10 px-4 py-3">
          <span className="font-bold text-candy-mint">🌱 {t('history.current', { n: generation })}</span>
          <span className="text-xs text-ink-300">{t('history.alive')}</span>
        </div>

        {list === null && <p className="py-8 text-center text-sm text-ink-500">…</p>}
        {list?.length === 0 && <p className="py-8 text-center text-sm text-ink-400">{t('history.empty')}</p>}

        <ul className="space-y-2">
          {list?.map((r) => {
            const isOpen = expanded === r.id;
            return (
              <li key={r.id} className="overflow-hidden rounded-2xl border border-ink-700 bg-ink-850">
                <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ink-800" onClick={() => setExpanded(isOpen ? null : r.id)}>
                  <span className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl bg-ink-950 leading-none">
                    <span className="text-[9px] text-ink-500">{t('history.gen')}</span>
                    <span className="font-mono text-lg font-black text-candy-grape">{r.generation}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap gap-1">
                      {r.titles.map((k) => (
                        <span key={k} className="rounded-full bg-gold/10 px-2 py-0.5 text-xs font-bold text-gold">
                          {t(`${k}.name`)}
                        </span>
                      ))}
                    </span>
                    <span className="mt-1 block text-[11px] text-ink-400">
                      ⏱ {fmtDuration(r.survivedSeconds, t)} · 🏔 {fmt(r.peakNetWorth)}
                      {r.worstLiquidationLoss && <span className="text-blood"> · 💀 -{fmt(r.worstLiquidationLoss)}</span>}
                    </span>
                  </span>
                  <span className={`text-ink-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}>▾</span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden border-t border-ink-700">
                      <ResumeCardBody resume={r} animate={false} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
