import { AnimatePresence, motion } from 'framer-motion';
import { useFeed } from '../../stores/feed';

const TONE = {
  info: 'border-ink-600 bg-ink-800',
  success: 'border-up/50 bg-ink-800',
  error: 'border-amber-500/60 bg-ink-800',
  danger: 'border-blood bg-blood/20',
};

export function Toasts() {
  const toasts = useFeed((s) => s.toasts);
  const dismiss = useFeed((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-20 right-3 z-[120] md:bottom-4 md:right-4 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" data-testid="toasts">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.button
            key={t.id}
            layout
            initial={{ x: 60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 60, opacity: 0 }}
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto rounded-lg border px-3 py-2 text-left text-sm shadow-lg ${TONE[t.tone]}`}
          >
            {t.text}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
