import { D } from '@catpital/shared';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { fmt } from '../../lib/format';
import { sound } from '../../lib/sound';
import { useFeed } from '../../stores/feed';
import { useSession } from '../../stores/session';
import { Modal } from '../common/Modal';
import { Bolivar, MeuwCoin } from './art';

/**
 * 兑换商店：Skylbot 的 Bolívares ⇄ Catpital 的 Meuw Coin，1:1。
 * 一张简单的兑换表单：上面"支付"、下面"获得"，快捷数量 + 一个兑换按钮，结果用 toast 提示。
 * 只用项目已有的 ink / candy 配色和 chip / arcade-btn，没有绝对定位的装饰，窄屏（Discord 活动窗口）也不会叠在一起。
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
/** 与后端 EXCHANGE_MAX_AMOUNT 一致 */
const MAX_AMOUNT = 10_000_000;
const QUICK = [1_000, 5_000, 10_000, 50_000];

const CURRENCY = {
  meuw: { name: 'Meuw Coin', Icon: MeuwCoin, color: 'text-candy-sun' },
  bolivar: { name: 'Bolívares', Icon: Bolivar, color: 'text-candy-mint' },
} as const;
type Currency = (typeof CURRENCY)[keyof typeof CURRENCY];

export default function ExchangeShop({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const user = useSession((s) => s.user);
  const liveMeuw = useSession((s) => s.balance);
  const toast = useFeed((s) => s.toast);
  const [tab, setTab] = useState<Direction>('in');
  const [state, setState] = useState<ExchangeState | null>(null);
  /** 加载失败的错误码：显示在横幅里并可重试 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(
    () =>
      api
        .get<ExchangeState>('/exchange')
        .then((s) => {
          setState(s);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          setState(null);
          setLoadError(err instanceof ApiError ? err.code : 'error.network');
        }),
    [],
  );
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const bolivares = state?.bolivares ?? null;
  const available = Boolean(state?.enabled);
  const bsText = bolivares === null ? '—' : bolivares.toLocaleString('es-ES');
  const from = tab === 'in' ? CURRENCY.bolivar : CURRENCY.meuw;
  const to = tab === 'in' ? CURRENCY.meuw : CURRENCY.bolivar;
  // 最多能兑多少：充值看 bolívares（拿不到就不拦，交给后端判断），兑回看可用 Meuw Coin 的整数部分
  const max = Math.min(MAX_AMOUNT, tab === 'in' ? (bolivares ?? MAX_AMOUNT) : D(liveMeuw).floor().toNumber());
  const n = /^\d{1,8}$/.test(amount) ? Number(amount) : 0;
  const enough = n <= max;
  const canSubmit = available && n > 0 && enough && !busy;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<ExchangeResult>(`/exchange/${tab}`, { amount: String(n) });
      setAmount('');
      if (r.status === 'PENDING') toast('info', t('shop.pendingHint'));
      else toast('success', t('shop.done', { amount: fmt(r.amount, 0), currency: to.name }));
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

  const seg = (active: boolean) =>
    `flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 text-sm font-bold transition-colors ${
      active ? 'bg-candy-grape text-white shadow-[0_2px_0_0_#6b4bc4]' : 'text-ink-400 hover:text-ink-100'
    }`;

  return (
    <Modal open={open} onClose={onClose}>
      <div className="select-none p-5" data-testid="exchange-shop">
        <div className="mb-4 flex items-center gap-2">
          <h2 className="mr-auto text-lg font-black">🛍 {t('shop.title')}</h2>
          <button className="chip" onClick={onClose} aria-label={t('settings.close')} data-testid="shop-close">
            ✕
          </button>
        </div>

        {/* 方向：充值 / 兑回（与排行榜的日 / 周 / 月同款分段） */}
        <div className="mb-4 flex gap-1 rounded-full bg-ink-850 p-1">
          {(['in', 'out'] as const).map((d) => (
            <button
              key={d}
              className={seg(tab === d)}
              onClick={() => {
                sound.play('click');
                setTab(d);
                setAmount('');
              }}
              data-testid={`shop-tab-${d}`}
            >
              {t(d === 'in' ? 'shop.tabIn' : 'shop.tabOut')}
            </button>
          ))}
        </div>

        {loadError && (
          <div className="mb-4 rounded-2xl border-2 border-dashed border-blood/60 bg-blood/10 px-3 py-2 text-center text-sm font-bold text-blood" data-testid="shop-load-error">
            <p>⚠ {t(loadError === 'error.exchangeNotMigrated' ? 'error.exchangeNotMigrated' : 'shop.loadFailed', { code: loadError })}</p>
            <button className="chip mt-2" onClick={() => void load()}>
              ⟳ {t('shop.retry')}
            </button>
          </div>
        )}
        {state && !state.enabled && (
          <p className="mb-4 rounded-2xl border-2 border-dashed border-candy-sun/50 bg-candy-sun/10 px-3 py-2 text-center text-sm font-bold text-candy-sun" data-testid="shop-disabled">
            🔧 {t('shop.disabled')}
          </p>
        )}
        {state?.enabled && bolivares === null && <p className="mb-4 rounded-2xl bg-ink-850 px-3 py-2 text-center text-xs text-ink-300">⚠ {t('shop.skylbotOffline')}</p>}

        {/* 支付 */}
        <Field label={t('shop.pay')} balance={tab === 'in' ? bsText : fmt(liveMeuw)} currency={from}>
          <input
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="0"
            className="w-full bg-transparent font-mono text-xl font-black text-ink-100 caret-candy-mint outline-none placeholder:text-ink-600"
            data-testid="shop-amount"
          />
        </Field>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button key={q} className="chip" onClick={() => setAmount(String(q))} data-testid={`shop-quick-${q}`}>
              {q.toLocaleString('en-US')}
            </button>
          ))}
          <button className="chip" disabled={!available || max <= 0} onClick={() => setAmount(String(max))} data-testid="shop-max">
            {t('shop.max')}
          </button>
        </div>

        <p className="my-2 text-center text-xs font-bold text-ink-400">↓ 1 : 1</p>

        {/* 获得 */}
        <Field label={t('shop.receive')} balance={tab === 'in' ? fmt(liveMeuw) : bsText} currency={to}>
          <span className="font-mono text-xl font-black text-ink-100">{n.toLocaleString('en-US')}</span>
        </Field>

        <button
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="arcade-btn mt-4 w-full border-[#c99a2e] bg-candy-sun py-2.5 text-ink-950"
          data-testid="shop-submit"
        >
          {busy ? '…' : n > 0 && !enough ? t('shop.notEnough') : `⚡ ${t('shop.exchange')}`}
        </button>

        {/* 兑换记录 */}
        <div className="mt-4 flex items-center justify-between gap-2">
          <button className="chip" onClick={() => setShowHistory((v) => !v)} data-testid="shop-history-toggle">
            📜 {t('shop.history')} {showHistory ? '▴' : '▾'}
          </button>
          <span className="font-mono text-[10px] text-ink-500">UID: {user?.id}</span>
        </div>
        {showHistory && (
          <ol className="mt-2 space-y-1.5" data-testid="shop-history">
            {!state || state.history.length === 0 ? (
              <li className="py-3 text-center text-xs text-ink-400">{t('shop.noHistory')}</li>
            ) : (
              state.history.map((h) => (
                <li key={h.id} className="flex items-center gap-2 rounded-2xl bg-ink-850 px-3 py-2 text-sm">
                  <span className="shrink-0 text-xs font-bold text-ink-400">{h.direction === 'IN' ? '→ Meuw' : '→ Bs'}</span>
                  <b className="font-mono">{fmt(h.amount, 0)}</b>
                  <span className="min-w-0 flex-1 truncate text-right text-[11px] text-ink-500">{new Date(h.createdAt).toLocaleString()}</span>
                  <span
                    className={`shrink-0 text-xs font-bold ${h.status === 'COMPLETED' ? 'text-candy-mint' : h.status === 'FAILED' ? 'text-blood' : 'text-candy-sun'}`}
                  >
                    {t(`shop.status.${h.status}`)}
                  </span>
                </li>
              ))
            )}
          </ol>
        )}
        <p className="mt-3 text-center text-[11px] text-ink-500">{t('shop.rateNote')}</p>
      </div>
    </Modal>
  );
}

/** 一行货币框：标题 + 余额，下面是图标、数量、币种名 */
function Field({ label, balance, currency, children }: { label: string; balance: string; currency: Currency; children: ReactNode }) {
  const { t } = useTranslation();
  const { Icon } = currency;
  return (
    <div className="rounded-2xl border-2 border-ink-700 bg-ink-850 px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-ink-400">
        <span className="font-bold">{label}</span>
        <span>
          {t('shop.balance')} <b className={`font-mono ${currency.color}`}>{balance}</b>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Icon size={26} glow={false} />
        <div className="min-w-0 flex-1">{children}</div>
        <span className={`shrink-0 text-sm font-bold ${currency.color}`}>{currency.name}</span>
      </div>
    </div>
  );
}
