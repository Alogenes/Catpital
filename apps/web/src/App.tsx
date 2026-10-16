import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BankruptcyPrompt, ResumeModal } from './components/bankruptcy/Bankruptcy';
import { ChartPanel } from './components/chart/ChartPanel';
import { FxLayer } from './components/fx/FxLayer';
import { LoginScreen } from './components/layout/LoginScreen';
import { MarketTabs } from './components/layout/MarketTabs';
import { TopBar } from './components/layout/TopBar';
import { SettingsModal } from './components/settings/SettingsModal';
import { BroadcastBanner } from './components/social/BroadcastBanner';
import { NewsFeed } from './components/social/NewsFeed';
import { Toasts } from './components/social/Toasts';
import { OrderPanel } from './components/trade/OrderPanel';
import { OrdersPanel, PositionsPanel } from './components/trade/PositionsPanel';
import { ApiError, type MarketInfo, api, setToken } from './lib/api';
import { type AuthResult, authenticateWithDiscord, devLogin, isEmbedded } from './lib/discord';
import { sound } from './lib/sound';
import { startRealtime } from './realtime/bridge';
import { useMarkets, useSelectedMarket } from './stores/markets';
import { type MeResponse, useSession } from './stores/session';
import { type Settings, useSettings } from './stores/settings';

async function finishLogin(auth: AuthResult) {
  setToken(auth.token);
  const [markets, me] = await Promise.all([api.get<MarketInfo[]>('/markets'), api.get<MeResponse>('/me')]);
  useMarkets.getState().setList(markets);
  useSession.getState().hydrate(me, auth.embedded);
  useSettings.getState().hydrateFromCloud(me.user.settings as Partial<Settings>);
  startRealtime(auth.token);
}

type BottomTab = 'positions' | 'orders' | 'news';

export default function App() {
  const { t } = useTranslation();
  const status = useSession((s) => s.status);
  const setStatus = useSession((s) => s.setStatus);
  const market = useSelectedMarket();
  const positionCount = useSession((s) => Object.keys(s.positions).length);
  const orderCount = useSession((s) => s.orders.length);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<BottomTab>('positions');
  const embedded = isEmbedded();

  const login = useCallback(
    async (fn: () => Promise<AuthResult>) => {
      setStatus('authenticating');
      try {
        await finishLogin(await fn());
      } catch (e) {
        setStatus('error', e instanceof ApiError ? e.code : e instanceof Error ? e.message : String(e));
      }
    },
    [setStatus],
  );

  useEffect(() => {
    if (embedded) void login(authenticateWithDiscord);
  }, [embedded, login]);

  // 浏览器自动播放策略：首次交互后解锁音频
  useEffect(() => {
    const unlock = () => sound.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  // 定期刷新市场列表（开/休市状态）
  useEffect(() => {
    if (status !== 'ready') return;
    const timer = setInterval(() => void api.get<MarketInfo[]>('/markets').then((l) => useMarkets.getState().setList(l)), 60_000);
    return () => clearInterval(timer);
  }, [status]);

  if (status !== 'ready') {
    if (!embedded && (status === 'idle' || status === 'error')) {
      return <LoginScreen onLogin={(uid, name) => void login(() => devLogin(uid, name))} />;
    }
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-ink-400">
        <span className="animate-bounce text-4xl">🐱</span>
        <span>{status === 'error' ? t('app.authFailed', { reason: useSession.getState().error }) : t('app.loading')}</span>
      </div>
    );
  }

  const bottomTab = (key: BottomTab, label: string, count?: number) => (
    <button
      key={key}
      onClick={() => setTab(key)}
      className={`border-b-2 px-1 pb-1.5 text-sm ${tab === key ? 'border-accent text-ink-100' : 'border-transparent text-ink-400 hover:text-ink-200'}`}
    >
      {label}
      {count ? <span className="ml-1 rounded-full bg-ink-700 px-1.5 text-[10px]">{count}</span> : null}
    </button>
  );

  return (
    <>
      <BroadcastBanner />
      <FxLayer />
      <Toasts />
      <ResumeModal />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <div id="shake-target" className="mx-auto flex min-h-screen max-w-[1600px] flex-col gap-2 p-2">
        <TopBar onSettings={() => setSettingsOpen(true)} />
        <BankruptcyPrompt />
        <MarketTabs />
        {market && (
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_330px]">
            <div className="flex min-h-[440px] flex-col lg:h-[calc(100vh-260px)] lg:min-h-[480px]">
              <ChartPanel market={market} />
            </div>
            <OrderPanel market={market} />
          </div>
        )}
        <section className="rounded-xl border border-ink-800 bg-ink-900 p-3">
          <div className="mb-3 flex gap-4 border-b border-ink-800">
            {bottomTab('positions', t('position.title'), positionCount)}
            {bottomTab('orders', t('orders.title'), orderCount)}
            {bottomTab('news', t('market.news'))}
          </div>
          {tab === 'positions' && <PositionsPanel />}
          {tab === 'orders' && <OrdersPanel />}
          {tab === 'news' && market && <NewsFeed market={market.code} />}
        </section>
      </div>
    </>
  );
}
