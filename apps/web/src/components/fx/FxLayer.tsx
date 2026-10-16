import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type FxEvent, useFeed } from '../../stores/feed';

const DURATION: Record<FxEvent['kind'], number> = { bigWin: 3200, liquidated: 2600, deficit: 3400, bankrupt: 3600 };

/** 金币/彩带粒子（Canvas，纯视觉，不涉及金额计算） */
function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const colors = ['#f5c542', '#ffd966', '#fff2b3', '#ff9f1c', '#7c5cff', '#1fbf75'];
    const parts = Array.from({ length: 180 }, () => ({
      x: canvas.width / 2,
      y: canvas.height * 0.45,
      vx: (Math.random() - 0.5) * 18,
      vy: -Math.random() * 18 - 6,
      r: Math.random() * 6 + 3,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[Math.floor(Math.random() * colors.length)]!,
      coin: Math.random() < 0.35,
    }));
    let raf = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.vy += 0.45;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        if (p.coin) {
          ctx.beginPath();
          ctx.ellipse(0, 0, p.r, p.r * Math.abs(Math.cos(p.rot * 3)) + 1, 0, 0, Math.PI * 2);
          ctx.fill();
        } else ctx.fillRect(-p.r, -p.r / 3, p.r * 2, p.r / 1.5);
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="absolute inset-0" />;
}

function BigWin({ detail }: { detail?: string }) {
  const { t } = useTranslation();
  return (
    <>
      <motion.div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(245,197,66,0.35),transparent_60%)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <Confetti />
      <motion.div
        className="absolute inset-0 flex flex-col items-center justify-center"
        initial={{ scale: 0.3, opacity: 0 }}
        animate={{ scale: [0.3, 1.25, 1], opacity: 1 }}
        transition={{ duration: 0.6 }}
      >
        <span className="bg-gradient-to-b from-yellow-200 via-gold to-amber-600 bg-clip-text text-7xl font-black tracking-widest text-transparent drop-shadow-[0_4px_24px_rgba(245,197,66,0.6)] sm:text-8xl">
          {t('fx.bigWin')}
        </span>
        {detail && <span className="mt-3 font-mono text-3xl font-bold text-gold">+{detail}</span>}
      </motion.div>
    </>
  );
}

/** 斩杀 / 穿仓：屏幕震动 + 血红暗角 + 刀光 + 大字 */
function Slash({ deficit, detail }: { deficit: boolean; detail?: string }) {
  const { t } = useTranslation();
  useEffect(() => {
    // 只震动主布局：若给 #root 加 transform，其内部 position:fixed 的特效层会被错误地相对它定位
    const root = document.getElementById('shake-target');
    root?.classList.add('animate-shake');
    const off = setTimeout(() => root?.classList.remove('animate-shake'), 1000);
    return () => {
      clearTimeout(off);
      root?.classList.remove('animate-shake');
    };
  }, []);
  return (
    <>
      <motion.div
        className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_30%,rgba(120,0,15,0.85)_100%)]"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 0.8] }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.4 }}
      />
      <motion.div className="absolute inset-0 bg-white" initial={{ opacity: 0.7 }} animate={{ opacity: 0 }} transition={{ duration: 0.25 }} />
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <motion.line
          x1="-5" y1="15" x2="105" y2="85"
          stroke="#fff" strokeWidth="0.8" strokeLinecap="round"
          initial={{ pathLength: 0, opacity: 1 }} animate={{ pathLength: 1, opacity: [1, 1, 0] }}
          transition={{ duration: 0.35, ease: 'easeIn' }}
        />
        <motion.line
          x1="-5" y1="15" x2="105" y2="85"
          stroke="#d7263d" strokeWidth="2.4" strokeLinecap="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
          transition={{ duration: 0.35, ease: 'easeIn' }}
          style={{ filter: 'blur(1px)' }}
        />
      </svg>
      {deficit && (
        <motion.div
          className="absolute inset-x-0 top-0 h-full bg-gradient-to-b from-blood/80 via-blood/30 to-transparent"
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ duration: 1.6, delay: 0.3, ease: 'easeOut' }}
          style={{ transformOrigin: 'top' }}
        />
      )}
      <motion.div
        className="absolute inset-0 flex flex-col items-center justify-center"
        initial={{ scale: 3, opacity: 0, rotate: -8 }}
        animate={{ scale: 1, opacity: 1, rotate: -4 }}
        transition={{ type: 'spring', stiffness: 500, damping: 18, delay: 0.15 }}
      >
        <span className="text-7xl font-black tracking-[0.2em] text-blood drop-shadow-[0_0_30px_rgba(215,38,61,0.9)] [-webkit-text-stroke:2px_#fff] sm:text-9xl">
          {t(deficit ? 'fx.deficit' : 'fx.liquidated')}
        </span>
        {detail && <span className="mt-4 font-mono text-3xl font-bold text-white">-{detail}</span>}
      </motion.div>
    </>
  );
}

function Bankrupt() {
  const { t } = useTranslation();
  return (
    <>
      <motion.div className="absolute inset-0 bg-black" initial={{ opacity: 0 }} animate={{ opacity: 0.88 }} exit={{ opacity: 0 }} transition={{ duration: 0.8 }} />
      <motion.div
        className="absolute inset-0 flex items-center justify-center"
        initial={{ scale: 4, opacity: 0, rotate: 12 }}
        animate={{ scale: 1, opacity: 1, rotate: -10 }}
        transition={{ delay: 0.7, type: 'spring', stiffness: 260, damping: 14 }}
      >
        <span className="rounded-xl border-[6px] border-blood px-8 py-3 text-7xl font-black tracking-[0.3em] text-blood opacity-90 sm:text-8xl">
          {t('fx.bankrupt')}
        </span>
      </motion.div>
    </>
  );
}

export function FxLayer() {
  const fx = useFeed((s) => s.fx);
  const clear = useFeed((s) => s.clearFx);

  useEffect(() => {
    if (!fx) return;
    const timer = setTimeout(() => clear(fx.id), DURATION[fx.kind]);
    return () => clearTimeout(timer);
  }, [fx, clear]);

  return (
    <AnimatePresence>
      {fx && (
        <motion.div
          key={fx.id}
          className="fixed inset-0 z-[60] overflow-hidden"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.5 } }}
          onClick={() => clear(fx.id)}
          data-testid={`fx-${fx.kind}`}
        >
          {fx.kind === 'bigWin' && <BigWin detail={fx.detail} />}
          {(fx.kind === 'liquidated' || fx.kind === 'deficit') && <Slash deficit={fx.kind === 'deficit'} detail={fx.detail} />}
          {fx.kind === 'bankrupt' && <Bankrupt />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
