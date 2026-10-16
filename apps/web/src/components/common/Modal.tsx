import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';

export function Modal({ open, onClose, children, className = '' }: { open: boolean; onClose?: () => void; children: ReactNode; className?: string }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            className={`max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl ${className}`}
            initial={{ y: 30, scale: 0.96 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 20, scale: 0.98 }}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
